import { Model, Plugin, Provider } from "@opencode/plugin";
import { CodexPlugin as legacyPlugin } from "./legacy.js";
import { refreshModels, type CodexModel } from "./models.js";
import { getProxyBaseUrl, startProxy, stopProxy } from "./proxy.js";
import { DIRECTORY_HEADER, EFFORT_HEADER, LOCAL_API_KEY, MODEL_HEADER, PROVIDER_ID, REQUEST_KIND_HEADER, SESSION_HEADER } from "./constants.js";

export { configModel } from "./legacy.js";

const providerID = Provider.ID.make(PROVIDER_ID);

export function providerModel(model: CodexModel): Model.Info {
  const released = Date.parse(model.releaseDate || "");
  return {
    ...Model.Info.default(providerID, Model.ID.make(model.id)),
    name: model.name,
    ...(model.family ? { family: Model.Family.make(model.family) } : {}),
    capabilities: {
      tools: false,
      input: ["text", ...(model.nativeInputModalities.some(m => m.toLowerCase() === "image") ? ["image"] : [])],
      output: ["text"],
    },
    limit: { context: model.contextWindow, output: model.maxOutput },
    time: { released: Number.isFinite(released) ? released : 0 },
    // Send effort to Codex without enabling Anthropic-specific thinking options.
    variants: [...new Set(model.efforts)].map(effort => ({
      id: Model.VariantID.make(effort), headers: { [EFFORT_HEADER]: effort },
    })),
  };
}

export const CodexPlugin = {
  ...Plugin.define({
    id: "opencode-codex",
    async setup(ctx) {
      const directory = ctx.location.directory;
      try {
        await startProxy(directory);
        const models = (await refreshModels(directory)).map(providerModel);
        await ctx.provider.transform(editor => {
          editor.add({
            info: {
              ...Provider.Info.empty(providerID),
              name: "Codex",
              activation: "enabled",
              package: "@opencode/ai/providers/anthropic-compatible",
              settings: { baseURL: getProxyBaseUrl(), apiKey: LOCAL_API_KEY },
            },
            models,
          });
        });

        await ctx.session.hook("model.request", async event => {
          const session = await ctx.session.get({ sessionID: event.sessionID });
          event.headers[MODEL_HEADER] = event.model.id;
          event.headers[DIRECTORY_HEADER] = session.location.directory;
          event.headers[SESSION_HEADER] = event.sessionID;
          if (event.model.variant && event.model.variant !== "default") event.headers[EFFORT_HEADER] = event.model.variant;
          if (event.agent === "plan") event.headers["x-opencode-codex-mode"] = "plan";
          // V2 has no message ID on request hooks. The proxy hashes the input
          // transcript to identify retries when this header is absent.
          if (event.kind !== "primary") {
            event.headers[REQUEST_KIND_HEADER] = event.kind === "title" ? "title" : "summary";
          }
        }, { providerID: PROVIDER_ID });

        return () => stopProxy(directory);
      } catch (error) {
        await stopProxy(directory);
        throw error;
      }
    },
  }),
  // OpenCode 1.18.29+ supports object entrypoints with a server function.
  server: legacyPlugin,
};

export default CodexPlugin;
