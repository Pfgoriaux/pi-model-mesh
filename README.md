# Model Mesh — pi extension

> Multi-model orchestration for [pi](https://github.com/mariozechner/pi-coding-agent) with tag-based routing, parallel streaming, deliberation, and judge synthesis.

Tag multiple AI models in a single chat message. They run in parallel, stream live previews, and can deliberate or judge each other's outputs.

Workers run as real pi sessions that share the parent's model registry (same providers, same API keys) and discover the same project resources (AGENTS.md, skills, context files). By default they have **full tool access** — identical to a fresh `pi` launch.

For provider-compatibility edge cases, `model-mesh` falls back to the older direct `streamSimple(...)` path for Kimi and for Anthropic OAuth (`/login anthropic`) Claude sessions. That keeps those routes working while the richer worker-session path is used everywhere else.

---

## How worker sessions work

Each `@model` tag spawns an in-process `AgentSession` via `createAgentSessionFromServices`. Workers:

- **Share the parent's `modelRegistry`** — same providers, same API keys, same custom models.
- **Discover project resources** — AGENTS.md, skills, prompt templates, and themes are found by the resource loader, just like a fresh `pi` launch.
- **Get all built-in tools by default** — `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` (configurable via `MESH_TOOL_MODE`).
- **Do NOT load extensions** — extensions are disabled in workers (`noExtensions: true`) to prevent model-mesh from recursively loading inside a worker.
- **Receive parent context** — a `before_agent_start` handler captures the parent's extension context (context files, skills, guidelines) and injects it into worker prompts, so workers still benefit from extension-added context even though they don't run extensions themselves.
- **Share cached services** — the resource loader, auth storage, and settings are created once and reused across all parallel workers in a session.

---

## Tags

| Tag | Effect |
|---|---|
| `@claude` | Route to Claude |
| `@codex` | Route to Codex |
| `@kimi` | Route to Kimi (plan) |
| `@glm` | Route to GLM via Synthetic |
| `@all` | Route to every model above |
| `@judge` | After all models respond, one model synthesizes a final decision |
| `@judge:<model>` | Choose which model judges (default: Claude) |
| `@deliberate` / `@debate` | Feeds previous round findings into the next, so models critique and refine |

---

## Quick examples

```text
@codex @claude compare approach A vs B for the migration
@all produce a migration plan for the auth module
@glm summarize tradeoffs for this architecture
@all @deliberate challenge previous answers and converge on one plan
@all @judge pick the best and produce final implementation plan
@claude @codex @judge:kimi synthesize into one final decision
```

---

## Default model routing

| Tag | Provider | Model |
|---|---|---|
| `@claude` | `anthropic` | `claude-sonnet-4-5` |
| `@codex` | `openai-codex` | `gpt-5.3-codex` |
| `@kimi` | `kimi-coding` | `kimi-for-coding` |
| `@glm` | `synthetic` | `hf:zai-org/GLM-5.1` |

All defaults are overridable via environment variables (see below).

---

## Prerequisites

- **[pi](https://github.com/mariozechner/pi-coding-agent)** must be installed.
- Each model's provider must be configured in pi with valid credentials. Run `/mesh-doctor` after install to verify.

**Recommended companion providers:**

| Provider | Install | Auth |
|---|---|---|
| Synthetic (for `@glm`) | `pi install npm:@aliou/pi-synthetic` | API key in `~/.pi/agent/auth.json` or `SYNTHETIC_API_KEY` env var |
| Kimi plan (for `@kimi`) | `pi install npm:pi-provider-kimi-code` | `/login kimi-coding` |

Claude and Codex are built into pi and only need their standard API keys.

---

## Install

### Option A — as a pi package (recommended)

From a published npm package or directly from GitHub:

```bash
pi install npm:pi-model-mesh
# or from git:
pi install git:github.com/Pfgoriaux/pi-model-mesh
```

Then in pi:

```text
/reload
```

### Option B — copy the file

```bash
cp ./index.ts ~/.pi/agent/extensions/model-mesh.ts
```

Then in pi:

```text
/reload
```

---

## Commands

| Command | Description |
|---|---|
| `/mesh-doctor` | Diagnose provider/model binding, auth, tool mode, services cache, and parent context capture |
| `/mesh-clear` | Clear in-session model-mesh round history and cached services |

---

## Environment variables

All defaults can be overridden without modifying code:

| Variable | Default | Purpose |
|---|---|---|
| `MESH_PROVIDER_CLAUDE` | `anthropic` | Claude provider name |
| `MESH_MODEL_CLAUDE` | `claude-sonnet-4-5` | Claude model ID |
| `MESH_PROVIDER_CODEX` | `openai-codex` | Codex provider name |
| `MESH_MODEL_CODEX` | `gpt-5.3-codex` | Codex model ID |
| `MESH_PROVIDER_KIMI` | `kimi-coding` | Kimi provider name |
| `MESH_MODEL_KIMI` | `kimi-for-coding` | Kimi model ID |
| `MESH_SYNTHETIC_PROVIDER` | `synthetic` | GLM provider name (change only for custom proxies) |
| `MESH_MODEL_GLM` | `hf:zai-org/GLM-5.1` | GLM model ID |
| `MESH_SYSTEM_PROMPT` | unset | Optional extra instructions prepended to worker prompts |
| `MESH_TOOL_MODE` | `full` | Worker tool access: `full` (all built-in tools), `read-only`, or `none` |
| `SYNTHETIC_BASE_URL` | `https://api.synthetic.new/v1` | Override Synthetic API URL (only when `MESH_SYNTHETIC_PROVIDER` is changed) |
| `SYNTHETIC_API_KEY_ENV` | `SYNTHETIC_API_KEY` | Env var name for Synthetic API key (only for custom provider bridge) |

### Tool modes explained

| Mode | Tools available | Use case |
|---|---|---|
| `full` (default) | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` | Workers have the same tool access as the main pi session — they can inspect and modify the workspace |
| `read-only` | `read`, `grep`, `find`, `ls` | Workers can inspect but not modify — safer for untrusted models or review-only workflows |
| `none` | (none) | Workers are pure text generators with no tool access — useful for deliberation/judge rounds |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Error: model not found (...)` | Run `/model` to check exact provider/model IDs, then set `MESH_PROVIDER_*` / `MESH_MODEL_*` env vars |
| `401 Invalid API Key` on `@glm` | Ensure `synthetic` credentials exist in `~/.pi/agent/auth.json` or `SYNTHETIC_API_KEY` is set |
| Codex says model unsupported | Switch to a model your plan supports, e.g. `MESH_MODEL_CODEX=gpt-5.3-codex` |
| Kimi auth fails intermittently | Use `/login kimi-coding`; don't rely on a stale `KIMI_API_KEY` |
| Kimi says `prompt_cache_key: Extra inputs are not permitted` | Update to the latest `model-mesh` build and `/reload` it. Worker sessions now disable OpenAI-style prompt-cache/session-affinity fields that Kimi rejects. |
| Kimi says `reasoning_effort: Extra inputs are not permitted` | Update to the latest `model-mesh` build and `/reload` it. Kimi now uses the legacy direct-stream path instead of the worker-session path that was forwarding incompatible reasoning controls. |
| `@claude` says `invalid x-api-key` after `/login anthropic` | Update to the latest `model-mesh` build and `/reload` it. Anthropic OAuth Claude sessions now use the legacy direct-stream path instead of the worker-session path that regressed subscription-auth requests. |
| Tags do nothing | Make sure there's text after the tags, e.g. `@claude hello` not just `@claude` |
| Workers can't use bash/edit/write | Check `MESH_TOOL_MODE` — it defaults to `full` but may have been set to `read-only` or `none` |
| Workers lack custom providers | Workers share the parent's `modelRegistry`, so if a custom provider works in the main session it works in workers. Run `/mesh-doctor` to verify. |
| Workers miss extension context | Workers don't load extensions (to prevent recursion), but parent context is injected. Run `/mesh-doctor` and check "parent context captured". |
| Claude or judge shows `(empty response)` | Update to the latest `model-mesh` build and `/reload` it. Recent versions surface upstream provider `errorMessage` instead of hiding provider failures as empty text. |
| A worker answers in another model's voice or parrots prior mesh output | Update to the latest `model-mesh` build and `/reload` it. Worker history now strips `model-mesh` custom transcript messages before seeding new worker sessions. |
| `Error: worker services init failed` | Rare — indicates the shared model registry couldn't be used. Check `/mesh-doctor` for auth issues. |

---

## Architecture

```
User types: @claude @codex analyze the auth module
                    │
                    ▼
          ┌─── input handler ───┐
          │  parse @-tags       │
          │  strip tags from    │
          │  cleaned prompt     │
          └────────┬────────────┘
                   │
          ┌────────▼────────────┐
          │ getWorkerServices() │  ← cached per session
          │  • modelRegistry    │  ← shared from parent (same providers + API keys)
          │  • resourceLoader   │  ← noExtensions: true, but discovers AGENTS.md, skills, etc.
          │  • authStorage       │
          │  • settingsManager  │
          └────────┬────────────┘
                   │
     ┌─────────────┼─────────────┐
     ▼             ▼             ▼
 createAgent     createAgent     (more if @all)
 FromServices   FromServices
 ┌────────┐     ┌────────┐
 │ @claude│     │ @codex │     ← each gets full tools + parent history
 │ full   │     │ full   │        by default
 │ tools  │     │ tools  │
 └───┬────┘     └───┬────┘
     │              │
     ▼              ▼
  streaming      streaming
  partials       partials
     │              │
     └──────┬───────┘
            ▼
     collect outputs → format round → append to session
            │
            ▼ (if @judge)
     judge session → synthesize final decision
```

---

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes — keep defaults overridable via env vars, don't commit secrets
4. Run `npm run check` to validate TypeScript
5. Push and open a PR

---

## License

[MIT](./LICENSE) © 2026 PF Goriaux
