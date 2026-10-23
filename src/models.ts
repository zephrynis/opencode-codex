import { loadCodexContextMetadata, loadMetadata, modelDisplayName, modelMetadata, type CodexContextMetadata, type ModelMetadata } from "./metadata.js";
import type { ModelListResponse } from "./generated/v2/ModelListResponse.js";
import { CodexRpc } from "./rpc.js";
export type CodexModel = { id: string; name: string; efforts: string[]; isDefault: boolean; description: string; nativeInputModalities: string[] } & ModelMetadata;
let catalog: CodexModel[] = [];
let loading: Promise<CodexModel[]> | undefined;
export function getCodexModels() { return catalog; }
export async function refreshModels(cwd: string) {
  if (catalog.length) return catalog;
  if (loading) return loading;
  loading = (async () => {
    const rpc = new CodexRpc(cwd);
    try {
      const metadata = loadMetadata();
      await rpc.initialize();
      const config = await rpc.request("config/read", { includeLayers: false }).catch(() => undefined);
      let cursor: string | undefined;
      let nativeMetadata: Promise<CodexContextMetadata> | undefined;
      do {
        const result: ModelListResponse = await rpc.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
        // Let model/list refresh Codex's catalog before reading its raw limits.
        nativeMetadata ||= loadCodexContextMetadata(cwd, config?.config);
        const [enrichment, nativeContext] = await Promise.all([metadata, nativeMetadata]);
        catalog.push(...result.data.map((m) => {
          const id = m.model || m.id;
          const meta = modelMetadata(id, enrichment, nativeContext);
          const label = modelDisplayName(id, m.displayName, enrichment);
          return { ...meta, id, name: label.name, sources: { ...meta.sources, name: label.source }, description: m.description || "", nativeInputModalities: m.inputModalities || ["text"], efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort), isDefault: m.isDefault };
        }));
        cursor = result.nextCursor || undefined;
      } while (cursor);
      if (!catalog.length) throw new Error("Codex returned no available models");
      return catalog;
    } catch (e) { catalog = []; throw e; } finally { rpc.close(); loading = undefined; }
  })();
  return loading;
}
export function resolveCodexModel(id?: string) {
  const model = id ? catalog.find(m => m.id === id) : catalog.find(m => m.isDefault) || catalog[0];
  if (!model) throw new Error(`Unknown Codex model: ${id || "(default)"}`);
  return model.id;
}
