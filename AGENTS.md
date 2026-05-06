# AGENTS.md (model-mesh)

## Purpose

`model-mesh` is a pi extension for multi-model orchestration via message tags:

- `@claude`
- `@codex`
- `@glm`
- `@all`
- `@review` — full cross-verification review mode (all models + cross-check + consensus)
- `@judge` / `@judge:<model>` — now supports `@judge:glm`
- `@deliberate` / `@debate`

## Architecture

All source lives under `src/`:

```
src/
  index.ts           — extension registration (thin entrypoint)
  types.ts           — shared types, ResolvedBinding, LabelMap
  input/parse.ts     — tag parsing and input normalization
  commands/           — /mesh-abort, /mesh-clear, /mesh-doctor, /mesh-logs, /mesh-diff
  orchestration/      — runWorker, runPhaseWorker, modes/review, modes/deliberation, modes/judge
  models/aliases.ts   — alias-to-family mapping, ORDER, fallback hints
  models/resolve.ts   — dynamic resolution from ctx.modelRegistry
  models/cache.ts     — read/write cached provider+model in agent dir
  models/labels.ts    — display labels derived from resolved model
  config/env.ts       — env parsing only
  config/paths.ts     — SDK-based paths (getAgentDir)
  render/widget.ts    — live widget
  render/output.ts    — final message formatting
  render/text.ts      — formatElapsed, preview, createWorkerStatus, markDone, markError
  prompts/             — system, review, deliberation, judge, worker
  stream/              — logger, progress, activity, fallback, context, messages, project
```

## Behavior contract

- Parse tags from user input in `input` hook.
- Run selected models in parallel.
- Track per-worker lifecycle phases: `pending` → `starting` → `thinking` → `toolcalling` → `streaming` → `done` | `error`.
- Show a compact live widget with phase icons, elapsed time, and activity per model.
- Throttle widget updates (default 150ms); flush on completion.
- Write structured timestamped logs to `<agentDir>/logs/model-mesh-<timestamp>.log` per round.
- Persist round outputs in custom session entries (`model-mesh-round`).
- Custom message renderer — themed, collapsible output. Compact summary by default; Ctrl+O to expand.
- `@` tag autocomplete for all supported tags.
- Round abort via `/mesh-abort` + `AbortController`.
- `ctx.hasUI` guards on all widget/status/notify calls.
- Session shutdown cleanup — invalidates services, context cache, aborts running rounds, disposes logger.
- Project context caching — `buildProjectContextSnippet` cached per CWD; uses Node fs traversal (no child_process).
- Review mode (`@review`): 3-phase pipeline — independent review → cross-verification → consensus synthesis.
- Deliberation mode (`@deliberate` / `@debate`): 4-phase pipeline — proposals → cross-critique → convergence → democratic synthesis.
- Judge mode for standalone final decision synthesis.
- `/mesh-logs`, `/mesh-logs last`, `/mesh-logs clear` for log inspection.
- `/mesh-diff` for git diff injection into review mode (only remaining child_process use, for git CLI).

## Dynamic model resolution

Models are **not** hardcoded. On each round, `resolveAllAliases` resolves each alias through:

1. **Env override** — `MESH_PROVIDER_<ALIAS>` / `MESH_MODEL_<ALIAS>` if set
2. **Cached binding** — from `<agentDir>/model-mesh/resolved-models.json` (validated against registry)
3. **Registry lookup** — search `ctx.modelRegistry.getAvailable()` by family patterns
4. **Fallback hints** — legacy defaults as last resort

Resolved bindings are threaded through workers, prompts, doctor, and rendering. Labels come from the resolved model's `name` field, not static constants.

## Worker session architecture

Workers are created via `createAgentSessionFromServices` with cached `AgentSessionServices`:

- **Shared modelRegistry** — workers use the parent's `ctx.modelRegistry`.
- **noExtensions: true** — prevents recursive loading.
- **Full tools by default** — `MESH_TOOL_MODE` defaults to `full` (all 7 built-in tools).
- **Parent context injection** — `before_agent_start` captures context and injects into worker prompts.
- **Services caching** — created once per session, reused across workers.
- **Legacy fallback** — auto-falls back to `streamSimple` (no tools) on compat errors.

## Paths

All filesystem paths use Pi SDK helpers (`getAgentDir` from `@mariozechner/pi-coding-agent`):

- Logs: `<agentDir>/logs/`
- Model cache: `<agentDir>/model-mesh/resolved-models.json`

No direct `os.homedir()` or hardcoded `~/.pi/agent` paths.

## Fallback hints (legacy compatibility)

These are only used when dynamic resolution finds nothing in the registry:

- Claude: `anthropic/claude-opus-4-7`
- Codex: `openai-codex/gpt-5.3-codex`
- GLM via Synthetic: `synthetic/hf:zai-org/GLM-5.1`

Everything stays overridable via env vars.

## Safety and OSS rules

- Never commit secrets.
- Keep error messages actionable.
- Keep defaults aligned with public pi provider docs.
- If a provider/model default breaks, update README + code in the same change.

## Environment variables (beyond the README table)

| Variable | Default | Purpose |
|---|---|---|
| `MESH_LEGACY_CLAUDE_OAUTH` | `false` | Force legacy streaming for Claude OAuth sessions |
| `MESH_FORCE_WORKER_SESSION` | `false` | Force ALL models through worker-session path |
| `MESH_LOG_INTERVAL_MS` | `3000` | Minimum ms between progress log entries per worker |
| `MESH_LOG_INTERVAL_CHARS` | `500` | Minimum chars between progress log entries per worker |
| `MESH_PROVIDER_CLAUDE` | — | Override provider for @claude |
| `MESH_MODEL_CLAUDE` | — | Override model id for @claude |
| `MESH_PROVIDER_CODEX` | — | Override provider for @codex |
| `MESH_MODEL_CODEX` | — | Override model id for @codex |
| `MESH_PROVIDER_GLM` | — | Override provider for @glm |
| `MESH_MODEL_GLM` | — | Override model id for @glm |
