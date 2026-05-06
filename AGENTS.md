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

## Behavior contract

- Parse tags from user input in `input` hook.
- Run selected models in parallel.
- Track per-worker lifecycle phases: `pending` → `starting` → `thinking` → `toolcalling` → `streaming` → `done` | `error`.
- Show a rich live widget with phase icons (⏳🚀🧠🔧📡✅❌), elapsed time, char count, ttfb, and 300-char preview per model.
- Throttle widget updates (default 150ms) to avoid TUI flooding; **flush on completion** so widget never shows stale state.
- Write structured timestamped logs to `~/.pi/agent/logs/model-mesh-<timestamp>.log` per round.
- Persist round outputs in custom session entries (`model-mesh-round`).
- **Custom message renderer** — themed, collapsible output via `registerMessageRenderer`. Compact summary by default; Ctrl+O to expand with accent-colored model tags and verdicts.
- **`@` tag autocomplete** — `addAutocompleteProvider` offers `@claude`, `@codex`, `@glm`, `@all`, `@review`, `@judge`, `@deliberate` with descriptions.
- **Round abort** — `/mesh-abort` command + `AbortController` with signal propagated to all worker sessions and legacy streams. Signal checked between phases.
- **`ctx.hasUI` guards** — widget/status/notify calls skip when `!ctx.hasUI` (print/JSON/RPC modes).
- **Session shutdown cleanup** — invalidates services, context cache, aborts running rounds, disposes logger.
- **Command completions** — `/mesh-logs` and `/mesh-diff` auto-complete arguments.
- **Project context caching** — `buildProjectContextSnippet` result cached per CWD; invalidated on `invalidateWorkerServices`.
- **Review mode** (`@review`): 3-phase pipeline —
  1. All models independently review the code with structured findings (severities, verdicts, confidence)
  2. Each model cross-verifies the OTHER models' reviews (agree/disagree/missed)
  3. Consensus synthesis producing agreements, disagreements, action items, verdict matrix, and final recommendation
- **Deliberation mode** (`@deliberate` / `@debate`): 4-phase pipeline —
  1. All models independently propose solutions (approach, implementation plan, tradeoffs, risks, confidence)
  2. Each model cross-critiques the others' proposals (strengths, weaknesses, missed, hybrid idea)
  3. Each model refines their proposal incorporating the best from all models
  4. **Democratic synthesis** — ALL models produce their own synthesis in parallel (no single judge). A converged plan is extracted from their consensus, with agreements, disagreements, each model's contribution, and overall confidence score. No model owns the final answer alone.
- Support judge mode to synthesize final decision (standalone, not in review/deliberation modes).
- Provide `/mesh-logs`, `/mesh-logs last`, `/mesh-logs clear` commands for log inspection.
- Provide `/mesh-diff` command for git diff injection into review mode.

## Worker session architecture

Workers are created via `createAgentSessionFromServices` with cached `AgentSessionServices`:

- **Shared modelRegistry** — workers use the parent's `ctx.modelRegistry` so they have the exact same providers, models, and API keys.
- **noExtensions: true** — extensions are NOT loaded in workers to prevent model-mesh from recursively loading inside a worker session.
- **Full tools by default** — `MESH_TOOL_MODE` defaults to `full`, which explicitly passes all 7 built-in tool names (`read, bash, edit, write, grep, find, ls`) to `createAgentSessionFromServices`. This gives workers more capability than a default `pi` launch (which only enables `read, bash, edit, write`).
- **Resource discovery** — the resource loader still discovers AGENTS.md, skills, prompt templates, and themes.
- **Parent context injection** — a `before_agent_start` handler captures the parent's extension context (context files, skills, guidelines) and injects it into worker prompts so workers benefit from extension-added context even though they don't run extensions.
- **Services caching** — `AgentSessionServices` is created once per session and reused across all parallel workers.
- **Cache invalidation** — services cache is cleared on `session_start` and `/mesh-clear`.
- **Legacy fallback** — when a worker session fails with a provider-incompat error (auth failure, API rejection, etc.), model-mesh automatically falls back to the legacy `streamSimple` path which has NO tool access. When this happens, the user sees a warning notification. Use `/mesh-logs last` or `/mesh-doctor` to diagnose why the worker session failed.

## Provider defaults

- Claude: `anthropic/claude-opus-4-7`
- Codex: `openai-codex/gpt-5.3-codex`
- GLM via Synthetic: `synthetic/hf:zai-org/GLM-5.1`

Everything must stay overridable via env vars.

## Safety and OSS rules

- Never commit secrets.
- Keep error messages actionable.
- Keep defaults aligned with public pi provider docs.
- If a provider/model default breaks, update README + code in the same change.

## Environment variables (beyond the README table)

These internal tuning knobs are documented here for contributors:

| Variable | Default | Purpose |
|---|---|---|
| `MESH_LEGACY_CLAUDE_OAUTH` | `false` | Force legacy streaming for Claude OAuth sessions (auto-detected by default) |
| `MESH_FORCE_WORKER_SESSION` | `false` | Force ALL models through worker-session path, disabling legacy fallback |
| `MESH_LOG_INTERVAL_MS` | `3000` | Minimum ms between progress log entries per worker |
| `MESH_LOG_INTERVAL_CHARS` | `500` | Minimum chars between progress log entries per worker |
