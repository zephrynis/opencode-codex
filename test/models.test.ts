import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FALLBACK_CONTEXT_WINDOW, loadCodexContextMetadata, modelDisplayName, modelMetadata } from "../src/metadata";
import { configModel } from "../src/index";

const id = "gpt-5.6-terra";
const payload = { [`openai/${id}`]: { name: "GPT-5.6 Terra" } };

test("ID-shaped Codex labels use the exact OpenAI catalog name in OpenCode", () => {
  for (const raw of [id, id.toUpperCase(), "", undefined]) {
    const label = modelDisplayName(id, raw, payload);
    expect(label).toEqual({ name: "GPT-5.6 Terra", source: "models.dev:exact-openai-id" });
    expect(configModel({ ...modelMetadata(id, payload), id, name: label.name, description: "", efforts: [], nativeInputModalities: ["text"], isDefault: true }).name).toBe("GPT-5.6 Terra");
  }
});

test("meaningful official labels take priority over generic metadata", () => {
  expect(modelDisplayName(id, "GPT-5.6 Terra Preview", payload)).toEqual({ name: "GPT-5.6 Terra Preview", source: "codex-app-server:model/list" });
});

test("missing metadata preserves IDs and never borrows names from other variants or providers", () => {
  for (const metadata of [{}, { [`other/${id}`]: { name: "Wrong provider" } }, { "openai/gpt-5.6": { name: "Wrong variant" } }, { [`openai/${id}`]: { name: "   " } }, { [`openai/${id}`]: { name: 42 } }]) {
    expect(modelDisplayName(id, id, metadata).name).toBe(id);
    expect(modelDisplayName(id, undefined, metadata)).toEqual({ name: id, source: "model-id" });
  }
});

test("nested catalogs and OpenAI-prefixed IDs use exact metadata", () => {
  expect(modelDisplayName(`openai/${id}`, id, { openai: { models: { [id]: { name: "GPT-5.6 Terra" } } } }).name).toBe("GPT-5.6 Terra");
});

test("each model uses its Codex working window instead of its published maximum", () => {
  const catalog = { models: [
    { slug: "small", context_window: 128000, max_context_window: 400000 },
    { slug: "large", context_window: 1000000, max_context_window: 2000000 },
  ] };
  for (const [id, context] of [["small", 128000], ["large", 1000000]] as const) {
    const api = { ["openai/" + id]: { limit: { context: 2000000, output: 100000 } } };
    const result = modelMetadata(id, api, { catalog });
    expect(result.contextWindow).toBe(context);
    expect(result.sources.context).toBe("codex-catalog:context_window");
  }
  expect(modelMetadata("openai/large", {}, { catalog }).contextWindow).toBe(1000000);
});

test("Codex configuration overrides the catalog and bounds displayed output", () => {
  const result = modelMetadata(id, { ["openai/" + id]: { limit: { context: 1050000, output: 128000 } } }, {
    configuredWindow: 64000,
    catalog: { models: [{ slug: id, context_window: 400000 }] },
  });
  expect(result.contextWindow).toBe(64000);
  expect(result.maxOutput).toBe(64000);
  expect(result.sources.context).toBe("codex-app-server:config/read:model_context_window");
  expect(modelMetadata(id, { ["openai/" + id]: { limit: { output: 512000 } } }, { configuredWindow: 1000000 }).maxOutput).toBe(512000);
});

test("unknown or invalid Codex limits use a labelled fallback, never another model or generic API limit", () => {
  const api = { ["openai/" + id]: { limit: { context: 1050000 } } };
  for (const context of [undefined, null, 0, -1, 1.5, "400000", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const result = modelMetadata(id, api, { configuredWindow: context, catalog: { models: [{ slug: id, context_window: context }] } });
    expect(result.contextWindow).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(result.sources.context).toBe("adapter-fallback:272000");
  }
  expect(modelMetadata(id, api, { catalog: { models: [{ slug: id + "-other", context_window: 999999 }] } }).contextWindow).toBe(FALLBACK_CONTEXT_WINDOW);
  expect(modelMetadata(id, api, { configuredWindow: 0, catalog: { models: [{ slug: id, context_window: 600000 }] } }).contextWindow).toBe(600000);
});

test("native catalog discovery and older-CLI fallbacks preserve configured windows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-context-test-"));
  const previousBin = process.env.OPENCODE_CODEX_BIN;
  const previousHome = process.env.CODEX_HOME;
  try {
    process.env.OPENCODE_CODEX_BIN = resolve("test/fixtures/fake-codex.mjs");
    const native = await loadCodexContextMetadata(dir, { model_context_window: 700000 });
    expect(modelMetadata("fake-model", {}, native).contextWindow).toBe(700000);
    expect(modelMetadata("fake-model", {}, await loadCodexContextMetadata(dir)).contextWindow).toBe(400000);

    process.env.OPENCODE_CODEX_BIN = "/missing-codex-for-context-test";
    process.env.CODEX_HOME = dir;
    await writeFile(join(dir, "models_cache.json"), JSON.stringify({ models: [{ slug: id, context_window: 500000 }] }));
    const cached = modelMetadata(id, {}, await loadCodexContextMetadata(dir));
    expect(cached.contextWindow).toBe(500000);
    expect(cached.sources.context).toBe("codex-cache:models_cache.json:context_window");

    await writeFile(join(dir, "custom.json"), JSON.stringify({ models: [{ slug: id, context_window: 800000 }] }));
    const custom = await loadCodexContextMetadata(dir, { model_catalog_json: "custom.json" });
    expect(modelMetadata(id, {}, custom).contextWindow).toBe(800000);
    expect(modelMetadata(id, {}, custom).sources.context).toBe("codex-config:model_catalog_json:context_window");

    const missing = await loadCodexContextMetadata(dir, { model_catalog_json: "missing.json", model_context_window: 900000 });
    expect(modelMetadata(id, {}, missing).contextWindow).toBe(900000);
    await writeFile(join(dir, "invalid.json"), "invalid JSON");
    const invalid = await loadCodexContextMetadata(dir, { model_catalog_json: "invalid.json" });
    expect(modelMetadata(id, {}, invalid).sources.context).toBe("adapter-fallback:272000");
  } finally {
    if (previousBin === undefined) delete process.env.OPENCODE_CODEX_BIN; else process.env.OPENCODE_CODEX_BIN = previousBin;
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("model discovery carries app-server configuration and raw model limits into the provider catalog", () => {
  const script = `import { refreshModels } from ${JSON.stringify(resolve("src/models.ts"))};
    const model = (await refreshModels(process.cwd()))[0];
    console.log(JSON.stringify({context: model.contextWindow, source: model.sources.context}));`;
  for (const configured of ["650000", ""]) {
    const output = execFileSync(process.execPath, ["-e", script], {
      env: { ...process.env, OPENCODE_CODEX_BIN: resolve("test/fixtures/fake-codex.mjs"), OPENCODE_CODEX_METADATA: "off", OPENCODE_CODEX_TEST_CONTEXT_WINDOW: configured },
      encoding: "utf8", timeout: 10000,
    });
    expect(JSON.parse(output)).toEqual({
      context: configured ? 650000 : 400000,
      source: configured ? "codex-app-server:config/read:model_context_window" : "codex-cli:debug-models:context_window",
    });
  }
});
