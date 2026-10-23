import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("OpenCode v2 loads the plugin, streams activity and resumes across processes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-codex-cli-"));
  const rpcLog = join(cwd, "rpc.jsonl");
  const config = join(cwd, "opencode.json");
  const env = {
    ...process.env,
    PWD: cwd,
    XDG_CONFIG_HOME: join(cwd, "config"), XDG_DATA_HOME: join(cwd, "data"),
    XDG_CACHE_HOME: join(cwd, "cache"), XDG_STATE_HOME: join(cwd, "state"),
    OPENCODE_CONFIG: config, OPENCODE_CODEX_METADATA: "off",
    OPENCODE_CODEX_BIN: resolve("test/fixtures/fake-codex.mjs"),
    OPENCODE_CODEX_DATA_DIR: join(cwd, "sessions"), OPENCODE_CODEX_TEST_RPC_LOG: rpcLog,
  };
  async function run(prompt: string, session?: string, variant?: string, agent = "build") {
    const child = Bun.spawn(["opencode", "run", "--standalone", "--format", "json", "--thinking", "--agent", agent,
      "--model", "codex/fake-model" + (variant ? "#" + variant : ""), ...(session ? ["--session", session] : []), prompt],
    { cwd, env, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 30000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, stderr + stdout).toBe(0);
      const events = stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
      expect(events.some(e => e.type === "error"), stderr + stdout).toBe(false);
      expect(events.some(e => e.type === "tool_use"), stdout).toBe(false);
      expect(events.some(e => e.type === "reasoning" && e.part.text === "[Codex Tool: Shell cat proof.txt]\n"), stdout).toBe(true);
      // V2 can replay earlier conversation events when attaching to a session.
      const text = events.filter(e => e.type === "text");
      const messageID = text.at(-1)?.part.messageID;
      expect(text.filter(e => e.part.messageID === messageID).map(e => e.part.text).join("")).toBe("Working.Done.");
      return events.find(e => e.sessionID).sessionID as string;
    } finally { clearTimeout(timeout); }
  }
  try {
    await writeFile(config, JSON.stringify({ plugins: [resolve(process.env.OPENCODE_CODEX_TEST_PLUGIN || ".")], model: "codex/fake-model" }));
    const session = await run("hello");
    expect(await run("follow up", session, "low")).toBe(session);
    const beforePlan = (await readFile(rpcLog, "utf8")).trim().split("\n").length;
    await run("inspect only", undefined, undefined, "plan");
    const requests = (await readFile(rpcLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.some(r => r.method === "thread/resume")).toBe(true);
    expect(requests.filter(r => r.method === "turn/start").some(r => r.params.effort === "low")).toBe(true);
    expect(requests.filter(r => r.method === "turn/start").every(r => r.params.effort !== "default")).toBe(true);
    const planThreads = requests.slice(beforePlan).filter(r => r.method === "thread/start" && !r.params.ephemeral);
    expect(planThreads).toHaveLength(1);
    expect(planThreads[0].params.sandbox).toBe("read-only");
    expect(requests.every(r => r.cwd === cwd)).toBe(true);
    expect(requests.filter(r => r.method === "thread/start").every(r => r.params.cwd === cwd)).toBe(true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}, 120000);
