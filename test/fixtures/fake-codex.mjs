#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
if (process.argv[2] === "debug" && process.argv[3] === "models") {
  if (process.env.OPENCODE_CODEX_TEST_NO_CONTEXT_METADATA) process.exit(1);
  process.stdout.write(JSON.stringify({ models: [{ slug: "fake-model", context_window: 400000, max_context_window: 1050000 }] }));
  process.exit(0);
}
const send = x => process.stdout.write(JSON.stringify(x) + "\n");
const notify = (method, params) => send({ method, params: { threadId: "thread-test", ...params } });
let interactive = false;
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (process.env.OPENCODE_CODEX_TEST_RPC_LOG) appendFileSync(process.env.OPENCODE_CODEX_TEST_RPC_LOG, JSON.stringify({ cwd: process.cwd(), ...m }) + "\n");
  if (m.id === undefined) return;
  if (m.id === "approval-request" && !m.method) {
    notify("item/agentMessage/delta", { itemId: "approval", delta: "Approval decision: " + m.result.decision });
    notify("turn/completed", { turn: { status: "completed" } });
    return;
  }
  if (m.id === "question-1" && !m.method) {
    if (m.error) { notify("turn/completed", { turn: { status: "failed", error: { message: "Question was not answered" } } }); return; }
    notify("item/agentMessage/delta", { itemId: "answer", delta: "Answered: " + JSON.stringify(m.result.answers) });
    notify("turn/completed", { turn: { status: "completed" } });
    return;
  }
  let result = {};
  if (m.method === "config/read") result = { config: { model_context_window: process.env.OPENCODE_CODEX_TEST_CONTEXT_WINDOW ? Number(process.env.OPENCODE_CODEX_TEST_CONTEXT_WINDOW) : null } };
  if (m.method === "model/list") result = { data: [{ id: "fake-model", model: "fake-model", displayName: "Fake", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }] }], nextCursor: null };
  if (m.method === "thread/start" || m.method === "thread/resume") {
    interactive = m.params.config?.["features.default_mode_request_user_input"] === true;
    result = { thread: { id: "thread-test" } };
  }
  if (m.method === "turn/start") {
    result = { turn: { id: "turn-test" } };
    send({ id: m.id, result });
    notify("turn/started", { turn: { id: "turn-test" } });
    const prompt = m.params.input[0]?.text || "";
    if (prompt.includes("FORCE_APPROVAL")) {
      send({ id: "approval-request", method: "item/commandExecution/requestApproval", params: { threadId: "thread-test", turnId: "turn-test", itemId: "approval-item" } });
      return;
    }
    if ((interactive && prompt.includes("ASK_QUESTION")) || prompt.includes("FORCE_QUESTION")) {
      const question = { id: "question-1", method: "item/tool/requestUserInput", params: {
        threadId: "thread-test", turnId: "turn-test", itemId: "question-item", isBlocking: true, autoResolutionMs: null,
        questions: [
          { id: "language", header: "Language", question: "Which language?", isOther: true, isSecret: false,
            options: [{ label: "TypeScript", description: "Use TypeScript" }, { label: "JavaScript", description: "Use JavaScript" }] },
          { id: "notes", header: "Notes", question: "Anything else?", isOther: true, isSecret: false, options: null },
        ],
      } };
      send(question);
      if (prompt.includes("DUPLICATE")) send(question);
      if (prompt.includes("RESOLVED")) setTimeout(() => {
        notify("serverRequest/resolved", { requestId: "question-1" });
        notify("turn/completed", { turn: { status: "completed" } });
      }, 100);
      return;
    }
    if (m.params.input.some(item => item.type === "image" && item.url === "data:image/png;base64,AAAA")) {
      notify("item/agentMessage/delta", { itemId: "message", delta: "Image received." });
      notify("item/completed", { item: { id: "message", type: "agentMessage", text: "Image received." } });
      notify("turn/completed", { turn: { status: "completed" } });
      return;
    }
    if (m.params.input[0].text.includes("WAIT_FOREVER")) return;
    if (m.params.input[0].text.includes("FAIL_TURN")) {
      notify("turn/completed", { turn: { status: "failed", error: { message: "fixture failure" } } }); return;
    }
    if (m.params.input[0].text.includes("DELAYED_STREAM")) {
      notify("item/agentMessage/delta", { itemId: "message", delta: "First fragment." });
      setTimeout(() => {
        notify("item/agentMessage/delta", { itemId: "message", delta: " Second fragment." });
        notify("item/completed", { item: { id: "message", type: "agentMessage", text: "First fragment. Second fragment." } });
        for (const [id, path] of [["read1", "a.ts"], ["read2", "b.ts"]]) {
          const item = { id, type: "commandExecution", commandActions: [{ type: "read", path }] };
          notify("item/started", { item });
          notify("item/completed", { item: { ...item, status: "completed" } });
        }
        notify("turn/completed", { turn: { status: "completed" } });
      }, 800);
      return;
    }
    notify("item/agentMessage/delta", { itemId: "message", delta: "Working." });
    notify("item/completed", { item: { id: "message", type: "agentMessage", text: "Working." } });
    notify("item/reasoning/summaryTextDelta", { itemId: "reason", delta: "Checking the file." });
    notify("item/started", { item: { id: "cmd", type: "commandExecution", command: "cat proof.txt" } });
    notify("item/started", { item: { id: "cmd", type: "commandExecution", command: "cat proof.txt" } });
    notify("item/commandExecution/outputDelta", { itemId: "cmd", delta: "RAW_TOOL_OUTPUT\n" });
    notify("item/completed", { item: { id: "cmd", type: "commandExecution", command: "cat proof.txt", status: "completed", exitCode: 0 } });
    notify("item/completed", { item: { id: "final", type: "agentMessage", text: "Done." } });
    notify("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 } } });
    notify("turn/completed", { turn: { status: "completed" } });
    return;
  }
  if (m.method === "turn/interrupt") notify("turn/completed", { turn: { status: "interrupted" } });
  send({ id: m.id, result });
});
