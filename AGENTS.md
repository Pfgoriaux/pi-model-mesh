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
