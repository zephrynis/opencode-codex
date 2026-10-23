import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import type { ToolRequestUserInputParams } from "./generated/v2/ToolRequestUserInputParams.js";
import type { ToolRequestUserInputResponse } from "./generated/v2/ToolRequestUserInputResponse.js";

export type UserInputHandler = (request: ToolRequestUserInputParams, signal: AbortSignal) => Promise<ToolRequestUserInputResponse>;
type QuestionContext = { directory: string; sessionID: string; agent: string; request: ToolRequestUserInputParams; signal: AbortSignal };
type QuestionBridge = (context: QuestionContext) => Promise<ToolRequestUserInputResponse>;
const bridges = new Map<string, Set<{ ask: QuestionBridge; controller: AbortController }>>();

export function registerQuestionBridge(directory: string, ask: QuestionBridge): () => void {
  const root = resolve(directory);
  const entry = { ask, controller: new AbortController() };
  const entries = bridges.get(root) || new Set();
  entries.add(entry);
  bridges.set(root, entries);
  return () => {
    if (!entries.delete(entry)) return;
    entry.controller.abort();
    if (!entries.size && bridges.get(root) === entries) bridges.delete(root);
  };
}

export function getUserInputHandler(directory: string, sessionID?: string, agent = "build"): UserInputHandler | undefined {
  if (!sessionID) return;
  const path = resolve(directory);
  const root = [...bridges.keys()].filter(root => {
    const child = relative(root, path);
    return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
  }).sort((a, b) => b.length - a.length)[0];
  const bridge = root && [...bridges.get(root)!].at(-1);
  if (!bridge) return;
  return (request, signal) => bridge.ask({ directory: path, sessionID, agent, request, signal: AbortSignal.any([signal, bridge.controller.signal]) });
}

export function nativeQuestionBridge(ctx: Plugin.Context): QuestionBridge {
  return async ({ directory, sessionID, agent, request, signal }) => {
    signal.throwIfAborted();
    const questions = request.questions;
    if (!Array.isArray(questions) || !questions.length || new Set(questions.map(q => q.id)).size !== questions.length) {
      throw new Error("Invalid Codex questionnaire");
    }
    // OpenCode's question tool has no password field. Never present a secret
    // prompt as an ordinary text field or silently discard its secret flag.
    if (questions.some(q => q.isSecret)) throw new Error("Secret questionnaires are not supported");
    const tools = await ctx.tool.list();
    const question = tools.find(tool => tool.id === "question");
    if (!question) throw new Error("OpenCode's question tool is unavailable");
    const id = sessionID as ToolContext["sessionID"];
    const session = await ctx.session.get({ sessionID: id });
    if (resolve(session.location.directory) !== directory) throw new Error("Question workspace does not match the session");
    const history = await ctx.session.context({ sessionID: id });
    const message = [...history].reverse().find(m => m.type === "assistant" && m.time.completed === undefined) || history.at(-1);
    if (!message) throw new Error("No session message to attach the question to");
    signal.throwIfAborted();
    let result;
    try {
      result = await question.execute({ questions: questions.map(q => ({
        header: q.header, question: q.question, options: q.options || [], multiple: false,
      })) }, {
        sessionID: id, agent: agent as ToolContext["agent"], messageID: message.id as ToolContext["messageID"],
        id: `codex-question-${randomUUID()}` as ToolContext["id"], signal, progress: async () => {},
      });
    } catch (error) {
      // A direct tool executor runs outside OpenCode's model-tool runner.
      // Stop the host session too, so a dismissal cannot become a provider retry.
      if (!signal.aborted) await ctx.session.interrupt({ sessionID: id }).catch(() => {});
      throw error;
    }
    signal.throwIfAborted();
    const answers = (result.output as { answers?: unknown } | undefined)?.answers;
    if (!Array.isArray(answers) || answers.length !== questions.length || !answers.every(a => Array.isArray(a) && a.every(v => typeof v === "string"))) {
      throw new Error("Invalid answer from OpenCode's question tool");
    }
    return { answers: Object.fromEntries(questions.map((q, index) => [q.id, { answers: answers[index] }])) };
  };
}
