import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { refreshModels } from "../src/models";
test("OpenCode loads plugin, edits through Codex and resumes across processes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-codex-e2e-"));
  const catalog = await refreshModels(cwd);
  const model = process.env.OPENCODE_CODEX_TEST_MODEL || catalog.find(m => m.isDefault)!.id;
  const config = join(cwd, "opencode.json");
  await writeFile(config, JSON.stringify({ plugins: [resolve(process.env.OPENCODE_CODEX_TEST_PLUGIN || ".")], model: "codex/" + model }));
  const env = { ...process.env, PWD: cwd, XDG_CONFIG_HOME: join(cwd, "config"), XDG_DATA_HOME: join(cwd, "data"), XDG_CACHE_HOME: join(cwd, "cache"), XDG_STATE_HOME: join(cwd, "state"), OPENCODE_CONFIG: config, OPENCODE_CODEX_DATA_DIR: join(cwd, "sessions") };
  async function run(prompt: string, session?: string) {
    const p = Bun.spawn(["opencode", "run", "--standalone", "--model", "codex/" + model, "--format", "json", "--thinking", ...(session ? ["--session", session] : []), prompt], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => p.kill(), 180000);
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timeout);
    expect(code, stderr + stdout).toBe(0);
    const events = stdout.split("\n").filter(l => l.startsWith("{")).map(l => JSON.parse(l));
    expect(events.some(e => e.type === "error"), stdout + stderr).toBe(false);
    return { events, stdout };
  }
  try {
    const listing = Bun.spawn(["opencode", "models", "--standalone"], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [listed, listingErrors, listingCode] = await Promise.all([new Response(listing.stdout).text(), new Response(listing.stderr).text(), listing.exited]);
    expect(listingCode, listingErrors).toBe(0);
    expect(listed).toContain("codex/" + model);
    const first = await run("Create e2e-proof.txt containing exactly opencode-codex-e2e-ok. Read it using a shell command to verify. Remember the secret word juniper for my next message. Reply DONE.");
    expect(await readFile(join(cwd, "e2e-proof.txt"), "utf8")).toContain("opencode-codex-e2e-ok");
    expect(first.events.some(e => e.type === "reasoning"), first.stdout).toBe(true);
    expect(first.events.some(e => e.type === "tool_use"), first.stdout).toBe(false);
    const reasoning = first.events.filter(e => e.type === "reasoning").map(e => e.part.text).join("\n");
    expect(reasoning).toMatch(/(?:Shell |Read |Edit ).*e2e-proof/);
    expect(reasoning).not.toMatch(/\[Codex tool:|commandExecution|\[completed\]/);
    const toolBlocks = first.events.filter(e => e.type === "reasoning" && e.part.text.startsWith("[Codex Tool:"));
    expect(toolBlocks.length).toBeGreaterThan(0);
    for (const block of toolBlocks) expect(block.part.text.match(/\[Codex Tool:/g)).toHaveLength(1);
    const session = first.events.find(e => e.sessionID)?.sessionID;
    expect(session).toBeTruthy();
    const second = await run("What secret word did I ask you to remember? Reply only with the word.", session);
    expect(second.stdout.toLowerCase()).toContain("juniper");
    console.log("OpenCode E2E passed:", model, session);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}, 420000);
