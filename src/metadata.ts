import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

export const FALLBACK_CONTEXT_WINDOW = 272_000;
export type CodexContextMetadata = { catalog?: unknown; configuredWindow?: unknown; catalogSource?: string };
const execute = promisify(execFile);
export type ModelMetadata = {
  contextWindow: number;
  maxOutput: number;
  family?: string;
  releaseDate?: string;
  lastUpdated?: string;
  sources: { context: string; output: string; catalog: string; name?: string; descriptive?: string };
};
type JsonRecord = Record<string, any>;
function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}
// Exact OpenAI IDs only: never borrow another provider's serving limits.
export function findMetadata(payload: unknown, id: string): JsonRecord | undefined {
  const data = record(payload);
  const bare = id.replace(/^openai\//, "");
  return record(data?.["openai/" + bare])
    || record(data?.openai?.models?.[bare])
    || (record(data?.[bare])?.id === bare ? record(data?.[bare]) : undefined);
}
// Codex sometimes returns the slug, including an uppercased slug, as displayName.
// Only an exact OpenAI record may replace that placeholder with a catalog label.
export function modelDisplayName(id: string, displayName: string | undefined, payload: unknown): { name: string; source: string } {
  const label = displayName?.trim();
  const bare = id.replace(/^openai\//, "");
  const isId = label && [id, bare].some(value => value.toLowerCase() === label.toLowerCase());
  if (label && !isId) return { name: label, source: "codex-app-server:model/list" };
  const metadataName = findMetadata(payload, id)?.name;
  if (typeof metadataName === "string" && metadataName.trim()) {
    return { name: metadataName.trim(), source: "models.dev:exact-openai-id" };
  }
  return { name: label || id, source: label ? "codex-app-server:model/list" : "model-id" };
}
function tokenLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function modelMetadata(id: string, payload: unknown, codex: CodexContextMetadata = {}): ModelMetadata {
  const m = findMetadata(payload, id);
  const models = record(codex.catalog)?.models;
  const native = Array.isArray(models) ? models.find(model => record(model)?.slug === id.replace(/^openai\//, "")) : undefined;
  const configuredWindow = tokenLimit(codex.configuredWindow);
  // Codex's working window can be smaller than the catalog's maximum or the
  // model's generic API window. OpenCode should describe the Codex runtime.
  const nativeWindow = tokenLimit(record(native)?.context_window);
  const contextWindow = configuredWindow ?? nativeWindow ?? FALLBACK_CONTEXT_WINDOW;
  const output = tokenLimit(m?.limit?.output);
  return {
    contextWindow,
    maxOutput: Math.min(output ?? 32_768, contextWindow),
    ...(typeof m?.family === "string" ? { family: m.family } : {}),
    ...(typeof m?.release_date === "string" ? { releaseDate: m.release_date } : {}),
    ...(typeof m?.last_updated === "string" ? { lastUpdated: m.last_updated } : {}),
    sources: {
      context: configuredWindow ? "codex-app-server:config/read:model_context_window"
        : nativeWindow ? `${codex.catalogSource || "codex-catalog"}:context_window` : "adapter-fallback:272000",
      output: output ? "models.dev:exact-openai-id" : "adapter-fallback:32768",
      catalog: "codex-app-server:model/list",
      ...(m ? { descriptive: "models.dev:exact-openai-id" } : {}),
    },
  };
}

export async function loadCodexContextMetadata(cwd: string, config?: unknown): Promise<CodexContextMetadata> {
  const settings = record(config);
  const configuredWindow = settings?.model_context_window;
  if (tokenLimit(configuredWindow)) return { configuredWindow };
  try {
    // model/list only exposes picker metadata. This read-only command uses
    // Codex's configured catalog and cache, including CODEX_HOME overrides.
    const { stdout } = await execute(process.env.OPENCODE_CODEX_BIN || "codex", ["debug", "models"], {
      cwd, timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
    });
    return { configuredWindow, catalog: JSON.parse(stdout), catalogSource: "codex-cli:debug-models" };
  } catch {
    // Older CLIs may lack debug models. model/list has already refreshed the
    // cache; an explicitly configured catalog takes precedence over that cache.
    const custom = settings?.model_catalog_json;
    const path = typeof custom === "string" && custom
      ? resolve(cwd, custom) : join(process.env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json");
    try {
      return {
        configuredWindow, catalog: JSON.parse(await readFile(path, "utf8")),
        catalogSource: typeof custom === "string" && custom ? "codex-config:model_catalog_json" : "codex-cache:models_cache.json",
      };
    } catch {
      // Missing optional metadata must not prevent the provider from loading.
      return { configuredWindow };
    }
  }
}

export async function loadMetadata(): Promise<unknown> {
  if (process.env.OPENCODE_CODEX_METADATA === "off") return {};
  try {
    const response = await fetch("https://models.dev/models.json", { signal: AbortSignal.timeout(5000) });
    return response.ok ? await response.json() : {};
  } catch { return {}; }
}
