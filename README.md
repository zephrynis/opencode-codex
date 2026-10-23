# opencode-codex

Use Codex inside OpenCode while Codex runs its own coding loop, commands, file edits, MCP tools, and context compaction.

```text
OpenCode → local Anthropic Messages proxy → JSON-RPC over stdio → codex app-server
```

Codex tool activity appears as ordered reasoning/status blocks. OpenCode does not execute those tools. Assistant commentary and final answers appear as ordinary text.

## Install

Requires Bun, OpenCode 2.x (2.0.26 or newer), and an installed, authenticated Codex CLI. Compatibility checks pass on OpenCode 2.0.26 and 2.1.4 with Bun 1.4.4 using a fake Codex backend. The legacy OpenCode 1.18.29 entrypoint is also retained and smoke-tested. The Codex protocol targets CLI 0.153.4.

Authenticate Codex once with `codex login`, then add the npm package to your OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@rasyid_rafi/opencode-codex"]
}
```

OpenCode installs the plugin automatically. The npm package includes compiled JavaScript; users do not need to clone this repository or build it.

For development from a checkout:

```sh
npm install
npm run build
```

This checkout's `opencode.json` loads the local plugin directory (`"plugins": ["."]`) after building. Other projects can reference the absolute path to this directory. OpenCode v2 configured local plugins must be directories; a path to `opencode-codex.js` is skipped.

OpenCode v1.18.29 users should keep the singular `"plugin"` configuration key and can continue using the `opencode-codex.js` entrypoint. Both versions share the Codex proxy and session storage.

Restart OpenCode, select the **Codex** provider, and choose a model. The plugin reads the model list and supported reasoning efforts from your installed Codex app-server. To inspect the available IDs:

```sh
opencode models
opencode run --model codex/YOUR_MODEL_ID --thinking "Explain this repository"
opencode run --model codex/YOUR_MODEL_ID#high "Use high reasoning effort"
```

Codex reads its existing configuration and credentials. The v2 provider is enabled automatically with a fixed, non-secret local API marker; no OpenCode credential setup is needed. The legacy entrypoint stores that marker in OpenCode. The plugin does not copy OAuth tokens or call the model API directly.

## Behavior

- Each active turn runs an isolated app-server process. Codex keeps running its tools until the turn finishes. The process closes afterward; the Codex thread persists.
- Workspace and OpenCode session ID identify the saved Codex thread. Later turns resume that thread, including after OpenCode restarts.
- Completed provider retries replay the cached response. Interrupted or uncertain requests cannot automatically run again. Send a new message to continue. Response caches are limited to 2 MB; larger responses also require a new message instead of automatic replay.
- Turns in a conversation run sequentially. A file lock prevents another OpenCode process from editing through the same thread concurrently.
- Stop/disconnect sends `turn/interrupt`, then closes the worker.
- On OpenCode v2, Codex `request_user_input` calls appear as native question forms, including OpenChamber's question cards. Multiple questions, choices, and free-text answers return to the same running Codex turn. Waiting for an answer pauses the adapter's stall timer. Dismissing a question or stopping the session interrupts the turn and clears pending forms. The native `question` tool must be enabled; its permission checks apply to these questions.
- Title and summary requests use separate ephemeral, read-only threads.
- In v2, title, compaction, and transient generation requests are routed to ephemeral, read-only threads using the request kind. Normal requests retain the session's Codex thread. V2 retries use the persisted user-message ID read from session context, with a transcript-hash fallback when no message ID is available.
- OpenCode's plan agent uses Codex's read-only sandbox. Normal coding uses `danger-full-access` by default.
- Codex retains its native instructions and project configuration. OpenCode's provider tool instructions are not forwarded. Custom OpenCode system prompts are not currently translated; put persistent coding instructions in Codex's configuration or project instructions.
- Provider usage is zero so OpenCode does not use Codex's token usage to trigger its own compaction. Real token counts are never returned through the proxy, and there is no usage endpoint. The Anthropic protocol carries only required zero-valued usage fields, including its final streaming event. Context windows in OpenCode reflect Codex's configuration and per-model working windows.
- Tool calls show useful arguments, such as `[Codex Tool: Read src/agent.ts, lines 1–180]`, `[Codex Tool: Search "delta" in src/]`, or `[Codex Tool: Shell npm run check]`. Each call gets its own thinking block, separate from other calls and actual reasoning. Call IDs deduplicate lifecycle updates; successful completion messages and tool output are omitted. Failures get a short notice. Long arguments are truncated, and structured file bodies and credential fields are omitted.
- Assistant text is forwarded as Codex emits deltas, without waiting for turn completion. Some Codex responses arrive from app-server as a burst of deltas at message completion; the wrapper cannot display that text before it arrives.

The adapter accepts text input and forwards image attachments to Codex models that advertise image input. Text files, audio, and document attachments are still rejected. Reference workspace files by path when possible. OpenCode conversation forks import visible conversation history into a fresh Codex thread; they do not clone hidden Codex history or undo file changes.

## Model metadata

Metadata precedence is field-specific:

1. The resolved Codex `model_context_window` setting, read through app-server `config/read`, takes priority. Otherwise, the exact model's `context_window` from `codex debug models` supplies the working window. Older CLIs without that command use the configured `model_catalog_json` file or Codex's `models_cache.json` under `CODEX_HOME` (default `~/.codex`). The catalog's `max_context_window` and generic API windows do not replace the configured working window. These are display values; the plugin does not change Codex's configuration.
2. Live Codex `model/list` owns available model IDs, descriptions, default selection, native input modalities, and supported reasoning efforts. Meaningful Codex display names take priority. When the name is missing or repeats the model ID, ignoring case, the exact OpenAI record from Models.dev supplies the display label. Without that metadata, the Codex label or model ID is preserved.
3. Exact OpenAI model records from Models.dev supply family, release date, update date, and output limit where available. The displayed output limit is bounded by the configured context window. These are generic model metadata, not evidence of a different Codex context window.
4. When no valid Codex context value is available, the display uses a 272,000-token fallback labelled `adapter-fallback:272000`. Missing output metadata uses a conservative 32,768-token display fallback, bounded by context. Missing descriptive fields stay absent. Metadata failures do not block Codex.

The local models endpoint includes per-field source labels. The provider advertises text and supported image input, with no host tool calling. V2 exposes only the reasoning efforts reported by Codex; its `default` variant leaves effort selection to Codex. Set `OPENCODE_CODEX_METADATA=off` to disable the optional Models.dev fetch; Codex context discovery remains enabled. Restart OpenCode's service after changing Codex context configuration so the model catalog is rebuilt.

## Permissions

The adapter sets Codex's approval policy to `never`. Codex executes operations allowed by the selected sandbox and refuses operations requiring approval. Unexpected command/file approval requests are declined; permission-extension requests receive no added permissions. The v2 question bridge only handles questionnaires. It enables Codex's `default_mode_request_user_input` feature for that worker, without changing the user's config file. Secret/password questionnaires are rejected because OpenCode's question tool has no secret-input field. Auxiliary requests and the legacy v1 entrypoint use ordinary chat questions instead.

Question forms remain available while the OpenCode backend is running, including when an OpenChamber browser reconnects. Backend shutdown/reload cancels pending questions; they are not restored across server restarts.

This version does not bridge OpenCode permission dialogs to Codex. OpenCode tool permissions do not govern Codex's internal tools.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENCODE_CODEX_BIN` | `codex` | Codex executable path |
| `OPENCODE_CODEX_SANDBOX` | `danger-full-access` | `read-only`, `workspace-write`, or `danger-full-access` |
| `OPENCODE_CODEX_DATA_DIR` | `~/.local/share/opencode-codex` | Thread mappings, retry caches, and locks |
| `OPENCODE_CODEX_PROXY_PORT` | random available port | Local proxy port |
| `OPENCODE_CODEX_MAX_REQUEST_BYTES` | 8388608 | Request size limit |
| `OPENCODE_CODEX_STALL_MS` | 600000 | Time without Codex events before interruption |
| `OPENCODE_CODEX_DEBUG` | unset | Set to `1` for adapter startup logging |

The proxy binds to `127.0.0.1`. Its protected endpoints require `x-api-key: opencode-codex-local`: `GET /v1/models` and `POST /v1/messages`. `GET /health` is public. The marker distinguishes adapter requests; it is not a secret protecting against other local processes.

Session caches contain assistant output and tool activity. They use owner-only file permissions. Codex maintains its own thread storage separately.

## Development and verification

```sh
npm run check
npm run test:cli
npm run test:forms
npm run test:live
npm run test:e2e
npm run test:package
```

The deterministic tests use a fake JSON-RPC process and cover v2 provider registration, metadata, request routing, default variants, question answers, cancellation, and cleanup. `test:cli` runs the installed OpenCode v2 CLI against that fake backend, checking streamed text/activity, plan mode, reasoning effort, and session resume across processes without model usage. `test:forms` starts an isolated real OpenCode server and uses its forms API to answer, dismiss, and stop Codex questions, including questions on resumed threads. The live test uses the installed Codex to edit and read a temporary file, then resumes the thread to verify memory. The E2E test loads this plugin through the installed OpenCode v2 CLI, verifies file creation, reasoning blocks and absence of host tool calls, then starts another OpenCode process to resume the same conversation. Zero provider usage is verified by the deterministic proxy tests. Live tests use the catalog default model unless `OPENCODE_CODEX_TEST_MODEL` is set.

Live tests use your existing Codex authentication and consume model usage. They remove their temporary workspaces and adapter mappings afterward; Codex and OpenCode retain their normal conversation records.

Request/model types under `src/generated` were generated by Codex CLI 0.153.4 using `codex app-server generate-ts`; the `ToolRequestUserInput*` types were generated by CLI 0.159.2. App-server remains experimental. Test a new Codex version before adopting it.

## References

- [Codex app-server](https://developers.openai.com/codex/app-server)
- [Codex SDK](https://developers.openai.com/codex/sdk)
- [Codex noninteractive mode](https://developers.openai.com/codex/noninteractive)

The HTTP/SSE adapter was adapted from the sibling opencode-commandcode-cli project. The session/protocol design also follows the sibling opencode-agy wrapper.

The package test installs an npm tarball in a clean temporary directory and runs the deterministic OpenCode v2 CLI and forms tests against that installed copy. These tests use isolated OpenCode servers, configuration, and data directories.

The v2 port follows the [OpenCode plugin migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1/), using `@opencode/plugin`, provider transforms, scoped request hooks, and setup cleanup.
