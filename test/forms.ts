import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("native OpenCode forms carry Codex answers and cancel with their turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-codex-forms-"));
  const log = join(cwd, "rpc.jsonl");
  const config = join(cwd, "opencode.json");
  await writeFile(config, JSON.stringify({ plugins: [resolve(process.env.OPENCODE_CODEX_TEST_PLUGIN || ".")], model: "codex/fake-model" }));
  const server = Bun.spawn(["opencode", "serve", "--stdio", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd, env: {
      ...process.env, PWD: cwd, OPENCODE_CONFIG: config,
      XDG_CONFIG_HOME: join(cwd, "config"), XDG_DATA_HOME: join(cwd, "data"), XDG_CACHE_HOME: join(cwd, "cache"), XDG_STATE_HOME: join(cwd, "state"),
      OPENCODE_SERVER_PASSWORD: "codex-forms-test", OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_CODEX_BIN: resolve("test/fixtures/fake-codex.mjs"), OPENCODE_CODEX_DATA_DIR: join(cwd, "sessions"),
      OPENCODE_CODEX_METADATA: "off", OPENCODE_CODEX_TEST_RPC_LOG: log,
    }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const deadline = setTimeout(() => server.kill(), 45000);
  const errors = new Response(server.stderr).text();
  try {
    const reader = server.stdout.getReader();
    let buffer = "";
    while (!buffer.includes("\n")) {
      const part = await reader.read();
      if (part.done) throw new Error("OpenCode exited before readiness: " + await errors);
      buffer += new TextDecoder().decode(part.value);
    }
    const { url } = JSON.parse(buffer.split("\n")[0]);
    async function api(path: string, method = "GET", data?: unknown): Promise<any> {
      const response = await fetch(url + path, {
        method, headers: { authorization: "Basic " + btoa("opencode:codex-forms-test"), "content-type": "application/json" },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(15000),
      });
      const body = await response.text();
      expect(response.ok, method + " " + path + ": " + body).toBe(true);
      return body ? JSON.parse(body).data : undefined;
    }
    async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
      const end = Date.now() + 10000;
      let value: T;
      do {
        value = await read();
        if (done(value)) return value;
        await new Promise(resolve => setTimeout(resolve, 40));
      } while (Date.now() < end);
      throw new Error("Timed out waiting for question state: " + JSON.stringify(value));
    }
    async function ask(sessionID?: string) {
      const session = sessionID ? { id: sessionID } : await api("/api/session", "POST", { location: { directory: cwd }, model: { providerID: "codex", id: "fake-model" } });
      await api(`/api/session/${session.id}/prompt`, "POST", { text: "ASK_QUESTION" });
      const forms = await poll<any[]>(() => api(`/api/session/${session.id}/form`), forms => forms.length > 0);
      expect(forms).toHaveLength(1);
      expect(forms[0].metadata.kind).toBe("question");
      expect(forms[0].fields.map((f: any) => f.description)).toEqual(["Which language?", "Anything else?"]);
      return { sessionID: session.id, form: forms[0] };
    }
    const first = await ask();
    await api(`/api/session/${first.sessionID}/form/${first.form.id}/reply`, "POST", { answer: { q0: "TypeScript", q1: "Custom answer from OpenChamber" } });
    await poll(() => api(`/api/session/${first.sessionID}`), session => session.outcome === "succeeded");
    expect(await api(`/api/session/${first.sessionID}/form`)).toEqual([]);
    const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const answer = requests.find(r => r.id === "question-1" && r.result);
    expect(answer.result).toEqual({ answers: { language: { answers: ["TypeScript"] }, notes: { answers: ["Custom answer from OpenChamber"] } } });
    const history = await api(`/api/session/${first.sessionID}/context`);
    expect(JSON.stringify(history)).toContain("Custom answer from OpenChamber");

    const dismissed = await ask(first.sessionID);
    await api(`/api/session/${dismissed.sessionID}/form/${dismissed.form.id}`, "DELETE");
    await poll(() => api(`/api/session/${dismissed.sessionID}`), session => session.outcome === "interrupted");
    const afterDismiss = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(afterDismiss.filter(r => r.id === "question-1" && r.result)).toHaveLength(1);
    expect(await api(`/api/session/${dismissed.sessionID}/form`)).toEqual([]);

    const stopped = await ask(first.sessionID);
    await api(`/api/session/${stopped.sessionID}/interrupt`, "POST", { continue: false });
    await poll<any[]>(() => api(`/api/session/${stopped.sessionID}/form`), forms => forms.length === 0);
    const state = await api(`/api/session/${stopped.sessionID}/form/${stopped.form.id}`);
    expect(state.state.status).toBe("cancelled");
    const finalRequests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const resumed = finalRequests.filter(r => r.method === "thread/resume");
    expect(resumed).toHaveLength(2);
    expect(resumed.every(r => r.params.config?.["features.default_mode_request_user_input"] === true)).toBe(true);
    expect(finalRequests.some(r => r.method === "initialize" && r.params.capabilities?.experimentalApi === true)).toBe(true);
  } finally {
    server.kill();
    await server.exited;
    clearTimeout(deadline);
    await rm(cwd, { recursive: true, force: true });
  }
}, 60000);
