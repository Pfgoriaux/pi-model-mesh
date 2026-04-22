# AGENTS.md (model-mesh)

## Purpose

`model-mesh` is a pi extension for multi-model orchestration via message tags:

- `@claude`
- `@codex`
- `@kimi`
- `@glm`
- `@all`
- `@judge` / `@judge:<model>`

## Behavior contract

- Parse tags from user input in `input` hook.
- Run selected models in parallel.
- Show streaming partials in a widget while running.
- Persist round outputs in custom session entries (`model-mesh-round`).
- Support deliberation (`@deliberate` / `@debate`) using last round context.
- Support judge mode to synthesize final decision.

## Worker session architecture

Workers are created via `createAgentSessionFromServices` with cached `AgentSessionServices`:

- **Shared modelRegistry** — workers use the parent's `ctx.modelRegistry` so they have the exact same providers, models, and API keys.
- **noExtensions: true** — extensions are NOT loaded in workers to prevent model-mesh from recursively loading inside a worker session.
- **Full tools by default** — `MESH_TOOL_MODE` defaults to `full`, which passes `undefined` as the tools allowlist, giving workers all 7 built-in tools (read, bash, edit, write, grep, find, ls) — identical to a fresh `pi` launch.
- **Resource discovery** — the resource loader still discovers AGENTS.md, skills, prompt templates, and themes.
- **Parent context injection** — a `before_agent_start` handler captures the parent's extension context (context files, skills, guidelines) and injects it into worker prompts so workers benefit from extension-added context even though they don't run extensions.
- **Services caching** — `AgentSessionServices` is created once per session and reused across all parallel workers.
- **Cache invalidation** — services cache is cleared on `session_start` and `/mesh-clear`.

## Provider defaults

- Claude: `anthropic/claude-sonnet-4-5`
- Codex: `openai-codex/gpt-5.3-codex`
- Kimi plan: `kimi-coding/kimi-for-coding`
- GLM via Synthetic: `synthetic/hf:zai-org/GLM-5.1`

Everything must stay overridable via env vars.

## Safety and OSS rules

- Never commit secrets.
- Keep error messages actionable.
- Keep defaults aligned with public pi provider docs.
- If a provider/model default breaks, update README + code in the same change.
