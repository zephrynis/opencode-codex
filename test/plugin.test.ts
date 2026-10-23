import { afterAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Plugin } from "@opencode/plugin";
import type { ProviderEditor } from "@opencode/plugin/promise/provider";
import type { SessionHooks } from "@opencode/plugin/promise/session";
import plugin, { providerModel } from "../src/index";
import { DIRECTORY_HEADER, EFFORT_HEADER, MODEL_HEADER, REQUEST_KIND_HEADER, SESSION_HEADER } from "../src/constants";
import { getProxyPort, stopProxy } from "../src/proxy";
import { modelMetadata } from "../src/metadata";

process.env.OPENCODE_CODEX_METADATA = "off";
process.env.OPENCODE_CODEX_BIN = resolve("test/fixtures/fake-codex.mjs");
afterAll(async () => { await stopProxy(); delete process.env.OPENCODE_CODEX_BIN; });

test("v2 models expose native capabilities and only supported effort variants", () => {
  const model = providerModel({ ...modelMetadata("fake", undefined, { configuredWindow: 750000 }), id: "fake", name: "Fake", description: "", efforts: ["low", "high"], nativeInputModalities: ["text", "image"], isDefault: true });
  expect(model.capabilities).toEqual({ tools: false, input: ["text", "image"], output: ["text"] });
  expect(model.limit.context).toBe(750000);
  expect(model.variants).toEqual([
    { id: "low", headers: { [EFFORT_HEADER]: "low" } },
    { id: "high", headers: { [EFFORT_HEADER]: "high" } },
  ]);
  expect(model.cost).toEqual([]);
});

test("v2 registers a replayable provider and routes primary and auxiliary requests", async () => {
  let transform!: (editor: ProviderEditor) => void;
  let request!: (event: SessionHooks["model.request"]) => Promise<void>;
  const context = {
    location: { directory: process.cwd() },
    provider: { transform: async (callback: typeof transform) => { transform = callback; } },
    session: {
      get: async () => ({ location: { directory: resolve("test") } }),
      hook: async (name: string, callback: typeof request, options: unknown) => {
        expect(name).toBe("model.request");
        expect(options).toEqual({ providerID: "codex" });
        request = callback;
      },
    },
  } as unknown as Plugin.Context;
  expect(plugin.id).toBe("opencode-codex");
  expect(typeof plugin.server).toBe("function");
  const cleanup = await plugin.setup(context);
  try {
    const providers: Parameters<ProviderEditor["add"]>[0][] = [];
    const editor = { add: (provider: typeof providers[number]) => providers.push(provider) } as ProviderEditor;
    transform(editor);
    transform(editor);
    expect(providers[0]).toEqual(providers[1]);
    expect(providers[0].info).toMatchObject({ id: "codex", activation: "enabled", package: "@opencode/ai/providers/anthropic-compatible" });
    expect(providers[0].info.settings?.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(providers[0].models[0].id).toBe("fake-model");
    expect(providers[0].models[0].limit.context).toBe(400000);

    for (const kind of ["primary", "title", "compaction", "generate"] as const) {
      const event = { sessionID: "session", model: { providerID: "codex", id: "fake-model", variant: "low" }, agent: "plan", kind, headers: {} } as unknown as SessionHooks["model.request"];
      await request(event);
      expect(event.headers).toMatchObject({ [MODEL_HEADER]: "fake-model", [SESSION_HEADER]: "session", [DIRECTORY_HEADER]: resolve("test"), [EFFORT_HEADER]: "low", "x-opencode-codex-mode": "plan" });
      expect(event.headers[REQUEST_KIND_HEADER]).toBe(kind === "primary" ? undefined : kind === "title" ? "title" : "summary");
    }
    for (const variant of [undefined, "default"]) {
      const event = { sessionID: "session", model: { providerID: "codex", id: "fake-model", variant }, agent: "build", kind: "primary", headers: {} } as unknown as SessionHooks["model.request"];
      await request(event);
      expect(event.headers[EFFORT_HEADER]).toBeUndefined();
      expect(event.headers["x-opencode-codex-mode"]).toBeUndefined();
      expect(event.headers["x-opencode-codex-message"]).toBeUndefined();
    }
  } finally { await cleanup?.(); }
  expect(getProxyPort()).toBeNull();
});

test("v2 closes the proxy when registration fails", async () => {
  const context = { location: { directory: process.cwd() }, provider: { transform: async () => { throw new Error("registration failed"); } } } as unknown as Plugin.Context;
  await expect(plugin.setup(context)).rejects.toThrow("registration failed");
  expect(getProxyPort()).toBeNull();
});
