import { afterAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { streamCodex } from "../src/agent";
import { getUserInputHandler, nativeQuestionBridge, registerQuestionBridge } from "../src/questions";
import type { ToolRequestUserInputParams } from "../src/generated/v2/ToolRequestUserInputParams";

process.env.OPENCODE_CODEX_BIN = resolve("test/fixtures/fake-codex.mjs");
afterAll(() => { delete process.env.OPENCODE_CODEX_BIN; });
const request: ToolRequestUserInputParams = {
  threadId: "thread-test", turnId: "turn-test", itemId: "question-item", isBlocking: true, autoResolutionMs: null,
  questions: [
    { id: "language", header: "Language", question: "Which language?", isSecret: false, isOther: true, options: [{ label: "TypeScript", description: "Use types" }] },
    { id: "notes", header: "Notes", question: "Anything else?", isSecret: false, isOther: true, options: null },
  ],
};

test("maps native choices and free text back to the original Codex question IDs", async () => {
  let received: any;
  let context: any;
  const ctx = {
    tool: { list: async () => [{ id: "question", execute: async (input: unknown, options: unknown) => {
      received = input; context = options;
      return { output: { answers: [["TypeScript"], ["Keep it simple"]] } };
    } }] },
    session: {
      get: async () => ({ location: { directory: process.cwd() } }),
      context: async () => [{ id: "old", type: "assistant", time: { completed: 1 } }, { id: "user", type: "user" }, { id: "current", type: "assistant", time: {} }],
    },
  } as unknown as Plugin.Context;
  const result = await nativeQuestionBridge(ctx)({ directory: process.cwd(), sessionID: "session", agent: "plan", request, signal: new AbortController().signal });
  expect(received.questions).toEqual([
    { header: "Language", question: "Which language?", options: request.questions[0].options, multiple: false },
    { header: "Notes", question: "Anything else?", options: [], multiple: false },
  ]);
  expect(context).toMatchObject({ sessionID: "session", agent: "plan", messageID: "current" });
  expect(context.id).toStartWith("codex-question-");
  expect(result).toEqual({ answers: { language: { answers: ["TypeScript"] }, notes: { answers: ["Keep it simple"] } } });
});

test("rejects secret prompts, duplicate IDs, wrong sessions, and malformed answers", async () => {
  const ctx = {
    tool: { list: async () => [{ id: "question", execute: async () => ({ output: { answers: "bad" } }) }] },
    session: { get: async () => ({ location: { directory: process.cwd() } }), context: async () => [{ id: "user", type: "user" }] },
  } as unknown as Plugin.Context;
  const ask = nativeQuestionBridge(ctx);
  const options = { directory: process.cwd(), sessionID: "session", agent: "build", signal: new AbortController().signal, request };
  await expect(ask({ ...options, request: { ...request, questions: [{ ...request.questions[0], isSecret: true }] } })).rejects.toThrow("Secret questionnaires");
  await expect(ask({ ...options, request: { ...request, questions: [request.questions[0], request.questions[0]] } })).rejects.toThrow("Invalid Codex questionnaire");
  await expect(ask({ ...options, directory: "/outside" })).rejects.toThrow("workspace");
  await expect(ask(options)).rejects.toThrow("Invalid answer");
});

test("question bridges are workspace-scoped and cleanup cancels pending work", async () => {
  let signal!: AbortSignal;
  const dispose = registerQuestionBridge(process.cwd(), async options => { signal = options.signal; return { answers: {} }; });
  expect(getUserInputHandler("/unrelated", "session")).toBeUndefined();
  expect(getUserInputHandler(process.cwd())).toBeUndefined();
  const handler = getUserInputHandler(resolve("test"), "session")!;
  await handler(request, new AbortController().signal);
  expect(signal.aborted).toBe(false);
  dispose();
  expect(signal.aborted).toBe(true);
  expect(getUserInputHandler(process.cwd(), "session")).toBeUndefined();
  const next = registerQuestionBridge(process.cwd(), async () => ({ answers: {} }));
  dispose(); // Disposing an old registration twice cannot remove a newer one.
  expect(getUserInputHandler(process.cwd(), "session")).toBeDefined();
  next();
});

test("worker waits for answers, deduplicates requests, and resumes the same turn", async () => {
  let calls = 0;
  const previousStall = process.env.OPENCODE_CODEX_STALL_MS;
  process.env.OPENCODE_CODEX_STALL_MS = "150";
  try {
    const events = await Array.fromAsync(streamCodex({ cwd: process.cwd(), model: "fake-model", prompt: "ASK_QUESTION DUPLICATE", onUserInput: async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 400));
      return { answers: { language: { answers: ["TypeScript"] }, notes: { answers: ["Custom answer"] } } };
    } }));
    expect(calls).toBe(1);
    expect(events.some(e => e.kind === "activity" && e.text.includes("Waiting for your answer"))).toBe(true);
    expect(events.some(e => e.kind === "error")).toBe(false);
    expect(events.filter(e => e.kind === "text").map(e => e.text).join("")).toContain('"notes":{"answers":["Custom answer"]}');
    expect(events.at(-1)?.kind).toBe("finish");
  } finally { if (previousStall === undefined) delete process.env.OPENCODE_CODEX_STALL_MS; else process.env.OPENCODE_CODEX_STALL_MS = previousStall; }
});

test("stopping a turn cancels the question handler", async () => {
  const controller = new AbortController();
  let cancelled = false;
  await Array.fromAsync(streamCodex({ cwd: process.cwd(), model: "fake-model", prompt: "ASK_QUESTION", signal: controller.signal,
    onUserInput: async (_request, signal) => {
      setTimeout(() => controller.abort(), 30);
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { cancelled = true; reject(new Error("aborted")); }, { once: true }));
    },
  }));
  expect(cancelled).toBe(true);
});

test("Codex resolving a request cancels its form without submitting a late answer", async () => {
  let cancelled = false;
  const events = await Array.fromAsync(streamCodex({ cwd: process.cwd(), model: "fake-model", prompt: "ASK_QUESTION RESOLVED",
    onUserInput: async (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { cancelled = true; reject(new Error("resolved")); }, { once: true })),
  }));
  expect(cancelled).toBe(true);
  expect(events.at(-1)?.kind).toBe("finish");
  expect(events.some(e => e.kind === "text" || e.kind === "error")).toBe(false);
});

test("dismissing a question interrupts the turn instead of inventing an answer", async () => {
  const events = await Array.fromAsync(streamCodex({ cwd: process.cwd(), model: "fake-model", prompt: "ASK_QUESTION", onUserInput: async () => { throw new Error("dismissed"); } }));
  expect(events.some(e => e.kind === "error" && e.text.includes("question was dismissed"))).toBe(true);
  expect(events.some(e => e.kind === "text" && e.text.includes("Answered:"))).toBe(false);
});

test("clients without a bridge still decline interactive requests", async () => {
  const events = await Array.fromAsync(streamCodex({ cwd: process.cwd(), model: "fake-model", prompt: "FORCE_QUESTION" }));
  expect(events.some(e => e.kind === "activity" && e.text.includes("unsupported interaction"))).toBe(true);
  expect(events.some(e => e.kind === "text")).toBe(false);
});

test("enabling questions does not approve Codex command requests", async () => {
  let questions = 0;
  const events = await Array.fromAsync(streamCodex({ cwd: process.cwd(), model: "fake-model", prompt: "FORCE_APPROVAL", onUserInput: async () => { questions++; return { answers: {} }; } }));
  expect(questions).toBe(0);
  expect(events.filter(e => e.kind === "text").map(e => e.text).join("")).toBe("Approval decision: decline");
});
