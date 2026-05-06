# Model Mesh — pi extension

> Multi-model orchestration for [pi](https://github.com/mariozechner/pi-coding-agent) with tag-based routing, parallel streaming, cross-review verification, consensus reports, deliberation, and judge synthesis.

Tag multiple AI models in a single chat message. They run in parallel, stream live previews, and can cross-verify each other's outputs for code review workflows.

Workers run as real pi sessions that share the parent's model registry (same providers, same API keys) and discover the same project resources (AGENTS.md, skills, context files). By default they have **full tool access** — identical to a fresh `pi` launch.

For provider-compatibility edge cases, `model-mesh` falls back to the older direct `streamSimple(...)` path for Anthropic OAuth (`/login anthropic`) Claude sessions. That keeps that route working while the richer worker-session path is used everywhere else.

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
| `@glm` | Route to GLM via Synthetic |
| `@all` | Route to every model above |
| `@review` | **Full review mode** = `@all` + each model cross-verifies the others + consensus report |
| `@judge` | After all models respond, one model synthesizes a final decision |
| `@judge:<model>` | Choose which model judges (default: Claude) |
| `@deliberate` / `@debate` | **Full deliberation mode** = `@all` + proposals → cross-critique → convergence → final plan |

---

## Quick examples

```text
# Basic multi-model query
@codex @claude compare approach A vs B for the migration
@all produce a migration plan for the auth module
@glm summarize tradeoffs for this architecture

# Code review with cross-verification
@review this auth module for security issues
@review check the migration plan for edge cases
@review review the error handling in src/api.ts

# Problem solving with deliberation (NEW!)
@deliberate How should we implement the caching layer for the API?
@debate Best approach to migrate from REST to GraphQL
@deliberate There's a race condition in the auth flow — propose fixes
@deliberate We need to add real-time notifications — design the architecture

# Legacy judge mode (still works)
@all @judge pick the best and produce final implementation plan
@claude @codex @judge:glm synthesize into one final decision
```

---

## Default model routing

| Tag | Provider | Model |
|---|---|---|
| `@claude` | `anthropic` | `claude-opus-4-7` |
| `@codex` | `openai-codex` | `gpt-5.3-codex` |
| `@glm` | `synthetic` | `hf:zai-org/GLM-5.1` |

All defaults are overridable via environment variables (see below).

---

## `@review` Mode — Cross-Verification Workflow

The `@review` tag is designed for code review. It runs a **3-phase pipeline**:

### Phase 1: Independent Reviews
All models run in parallel on the same code, each producing an independent review with:
- Issues found (🔴 critical, 🟠 major, 🟡 minor, 🔵 nit)
- Strengths
- Suggestions
- Verdict: APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION + confidence score

### Phase 2: Cross-Verification
Each model then reviews the OTHER models' findings:
- ✅ AGREE or ❌ DISAGREE with each finding
- Identifies missed issues
- Produces consolidated assessment

### Phase 3: Consensus Report
A meta-reviewer synthesizes all cross-verification results into a structured report:
- **✅ Consensus** — Issues where ALL reviewers agree
- **⚠️ Disagreements** — Points needing human attention
- **🔍 Action Items** — Concrete steps before merging
- **📊 Verdict Matrix** — Each model's verdict and confidence
- **🏁 Final Recommendation** — MERGE / FIX_FIRST / MAJOR_REWORK

### Why this matters

Instead of manually switching between 3 terminal tabs and cross-referencing outputs yourself, `@review` automates the entire verification loop:

```
Before @review:                    After @review:
┌─────────┐ ┌─────────┐             ┌──────────────────────┐
│ Claude  │ │ Codex   │             │ ✅ Consensus (3/3)   │
│ tab 1   │ │ tab 2   │             │ ⚠️ Disagreements (1)│
├─────────┤ ├─────────┤      →      │ 🔍 Action items (4) │
│ GLM     │ │ Your    │             │ 📊 Verdict matrix    │
│ tab 3   │ │ brain   │             │ 🏁 MERGE (with fix) │
└─────────┘ └─────────┘             └──────────────────────┘
```

---

## `@deliberate` Mode — Multi-Model Problem Solving

The `@deliberate` tag is for when you need a **decision or solution**, not just a review. Expose a problem, a bug, a feature to implement, or an architecture question — and the models will propose, critique, and converge.

### Phase 1: Independent Proposals
All models propose their solution independently:
- **Approach** — Why this approach?
- **Implementation plan** — Concrete numbered steps
- **Tradeoffs** — Key tradeoffs
- **Risks** — What could go wrong?
- **Alternatives considered** — What else and why not?
- **Confidence** — 0-100 score

### Phase 2: Cross-Critique
Each model critiques the others' proposals:
- What does the other approach do **better**?
- Where is it **weaker** or **riskier**?
- What did they **miss**?
- Would you adopt their approach over yours?
- **Convergence idea** — How to combine the best from each

### Phase 3: Convergence
Each model produces a **refined proposal** that incorporates the best ideas from all models.

### Phase 4: Final Synthesis
All 3 models produce their **own synthesis** in parallel (democratic — no single judge). Then we extract the **converged plan**: what they all agree on, where they disagree, and the final recommendation.

```
## 🏆 CONVERGED PLAN

This plan was synthesized **democratically** — all 3 models produced
independent syntheses, and this output extracts their consensus.
No single model owns the final answer.

📊 Democracy Scorecard
| Model | Confidence | Recommended Approach |
|-------|-----------|----------------------|
| Claude | 85% | ... |
| Codex | 78% | ... |
| GLM | 72% | ... |

📋 Implementation Plan (from consensus)
⚖️ Tradeoffs
⚠️ Risks & Mitigations
🤝 What Each Model Contributed
❌ Remaining Disagreements
🎯 Overall Confidence (average + range)

⚖️ Individual Syntheses (Full — for deep inspection)
```

### Why this matters

```
Before @deliberate:               After @deliberate:
┌─────────┐ ┌─────────┐           ┌──────────────────────────────┐
│ Claude  │ │ Codex   │           │ 🏆 FINAL PLAN                │
│ says A  │ │ says B  │     →     │ Hybrid of A+B (best of both) │
├─────────┤ ├─────────┤           │ ⚖️ Tradeoffs clearly listed  │
│ GLM     │ │ Your    │           │ 📋 Step-by-step plan         │
│ says C  │ │ brain   │           │ 🎯 92% confidence            │
└─────────┘ └─────────┘           └──────────────────────────────┘
```

### Examples

```text
@deliberate How should we implement the caching layer for the API?
@debate Best approach to migrate from REST to GraphQL
@deliberate There's a race condition in the auth flow — propose fixes
@deliberate We need to add real-time notifications — design the architecture
```

## Live widget & logging

When a mesh round is running, a **live widget** appears below the editor showing real-time status for each worker. During cross-review, the widget updates to show which model is cross-verifying which:

```
╔══ Model Mesh ═══════════════════════════════════════════════╗
║ ✅ @claude  — ✅ Cross-review done: AGREE with all 3...    ║
║ 📡 @codex   — 🔄 Cross-review: DISAGREE with GLM on...   ║
║ ⏳ @glm    — 🔄 Cross-reviewing…                          ║
╚════════════════════════════════════════════════════════════╝
```

Each row shows:

| Field | Meaning |
|---|---|
| Icon | ⏳ pending · 🚀 starting · 📡 streaming · ✅ done · ❌ error |
| Elapsed | Wall time since the worker started |
| Chars | Characters received so far |
| ttfb | Time to first byte (how long before the model started emitting) |
| Preview | First 300 chars of the current output (configurable via `MESH_PREVIEW_LENGTH`) |

**Error states** are shown immediately in the widget — you don't have to wait until the end:

```
║ ❌ @claude  — ERROR 0.5s
║   Error: Anthropic authentication failed. Run '/login anthropic'...
```

### Per-round log files

Every mesh round writes a timestamped log file to `~/.pi/agent/logs/model-mesh-<timestamp>.log` with structured entries:

```
[2026-04-22T14:30:01.234Z] [round-1745332201-a3f2k9] [mesh] [info] Round started — targets: claude, codex, glm — prompt: analyze the auth module
[2026-04-22T14:30:01.456Z] [round-1745332201-a3f2k9] [claude] [starting] Connecting to anthropic/claude-opus-4-7 (legacy=false)
[2026-04-22T14:30:01.789Z] [round-1745332201-a3f2k9] [codex] [starting] Connecting to openai-codex/gpt-5.3-codex (legacy=false)
[2026-04-22T14:30:03.210Z] [round-1745332201-a3f2k9] [claude] [streaming] First token received — ttfb: 1.8s
[2026-04-22T14:30:05.678Z] [round-1745332201-a3f2k9] [codex] [error] 401 Invalid API Key
```

Use `/mesh-logs` to view entries from the last round in-session, or `/mesh-logs last` to tail the latest log file on disk.

---

## Prerequisites

- **[pi](https://github.com/mariozechner/pi-coding-agent)** must be installed.
- Each model's provider must be configured in pi with valid credentials. Run `/mesh-doctor` after install to verify.

**Recommended companion providers:**

| Provider | Install | Auth |
|---|---|---|
| Synthetic (for `@glm`) | `pi install npm:@aliou/pi-synthetic` | API key in `~/.pi/agent/auth.json` or `SYNTHETIC_API_KEY` env var |

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
| `/mesh-doctor` | Diagnose provider/model binding, auth, tool mode, services cache, parent context capture, and logging config |
| `/mesh-clear` | Clear in-session model-mesh round history and cached services |
| `/mesh-diff` | Capture git diff and prepare it for `@review` (unstaged + staged by default, or specify a ref like `HEAD~1` or `main..HEAD`) |
| `/mesh-logs` | Show recent in-memory log entries (last 50) from the latest round |
| `/mesh-logs last` | Tail the latest log file from disk |
| `/mesh-logs clear` | Delete all model-mesh log files from the log directory |

---

## Environment variables

All defaults can be overridden without modifying code:

| Variable | Default | Purpose |
|---|---|---|
| `MESH_PROVIDER_CLAUDE` | `anthropic` | Claude provider name |
| `MESH_MODEL_CLAUDE` | `claude-opus-4-7` | Claude model ID |
| `MESH_PROVIDER_CODEX` | `openai-codex` | Codex provider name |
| `MESH_MODEL_CODEX` | `gpt-5.3-codex` | Codex model ID |
| `MESH_SYNTHETIC_PROVIDER` | `synthetic` | GLM provider name (change only for custom proxies) |
| `MESH_MODEL_GLM` | `hf:zai-org/GLM-5.1` | GLM model ID |
| `MESH_SYSTEM_PROMPT` | unset | Optional extra instructions prepended to worker prompts |
| `MESH_TOOL_MODE` | `full` | Worker tool access: `full` (all built-in tools), `read-only`, or `none` |
| `SYNTHETIC_BASE_URL` | `https://api.synthetic.new/v1` | Override Synthetic API URL (only when `MESH_SYNTHETIC_PROVIDER` is changed) |
| `SYNTHETIC_API_KEY_ENV` | `SYNTHETIC_API_KEY` | Env var name for Synthetic API key (only for custom provider bridge) |

| `MESH_LOG_DIR` | `~/.pi/agent/logs` | Directory for per-round log files |
| `MESH_PREVIEW_LENGTH` | `300` | Max characters shown in live widget preview |
| `MESH_WIDGET_THROTTLE_MS` | `150` | Minimum ms between widget updates (prevents TUI flooding) |
| `MESH_LOG_INTERVAL_MS` | `3000` | Minimum ms between progress log entries per worker |
| `MESH_LOG_INTERVAL_CHARS` | `500` | Minimum chars between progress log entries per worker |
| `MESH_MAX_DIFF_CHARS` | `50000` | Maximum git diff size before truncation (for `/mesh-diff`) |
| `MESH_LEGACY_CLAUDE_OAUTH` | `false` | Force legacy streaming for Claude OAuth sessions (auto-detected by default) |
| `MESH_FORCE_WORKER_SESSION` | `false` | Force ALL models through worker-session path, disabling legacy fallback |

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
| `@claude` says `invalid x-api-key` after `/login anthropic` | Update to the latest `model-mesh` build and `/reload` it. Anthropic OAuth Claude sessions now use the legacy direct-stream path instead of the worker-session path that regressed subscription-auth requests. |
| Tags do nothing | Make sure there's text after the tags, e.g. `@claude hello` not just `@claude` |
| Workers can't use bash/edit/write | Check `MESH_TOOL_MODE` — it defaults to `full` but may have been set to `read-only` or `none` |
| Workers lack custom providers | Workers share the parent's `modelRegistry`, so if a custom provider works in the main session it works in workers. Run `/mesh-doctor` to verify. |
| Workers miss extension context | Workers don't load extensions (to prevent recursion), but parent context is injected. Run `/mesh-doctor` and check "parent context captured". |
| Claude or judge shows `(empty response)` | Update to the latest `model-mesh` build and `/reload` it. Recent versions surface upstream provider `errorMessage` instead of hiding provider failures as empty text. |
| A worker answers in another model's voice or parrots prior mesh output | Update to the latest `model-mesh` build and `/reload` it. Worker history now strips `model-mesh` custom transcript messages before seeding new worker sessions. |
| `Error: worker services init failed` | Rare — indicates the shared model registry couldn't be used. Check `/mesh-doctor` for auth issues. |
| Model appears stuck with no output | Check the live widget for phase (⏳🚀📡✅❌) and elapsed time. Run `/mesh-logs last` to see the full timestamped log. |
| Want to see what happened after widget disappears | Run `/mesh-logs` for in-memory entries, or `/mesh-logs last` to tail the latest log file. |

---

## Architecture

### Basic mode (`@claude @codex`)

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
```

### Review mode (`@review`)

```
@review check auth module for security issues
              │
              ▼
     Phase 1: Independent Reviews (parallel)
     ┌─────┐ ┌─────┐ ┌─────┐
     │Claude│ │Codex│ │ GLM │  ← Each reviews code independently
     └──┬──┘ └──┬──┘ └──┬──┘
        └───────┼───────┘
                ▼
     Phase 2: Cross-Verification (parallel)
     ┌─────┐ ┌─────┐ ┌─────┐
     │Claude│ │Codex│ │ GLM │  ← Each verifies the others' findings
     └──┬──┘ └──┬──┘ └──┬──┘
        └───────┼───────┘
                ▼
     Phase 3: Consensus Report
     ┌──────────────┐
     │  Meta-reviewer│  ← ✅ Agreements · ⚠️ Disagreements · 🔍 Actions
     └──────────────┘
```

### Deliberation mode (`@deliberate`)

```
@deliberate How to implement caching for the API?
              │
              ▼
     Phase 1: Proposals (parallel)
     ┌─────┐ ┌─────┐ ┌─────┐
     │Claude│ │Codex│ │ GLM │  ← Each proposes solution independently
     │Plan A│ │Plan B│ │Plan C│     (approach, steps, tradeoffs, confidence)
     └──┬──┘ └──┬──┘ └──┬──┘
        └───────┼───────┘
                ▼
     Phase 2: Cross-Critique (parallel)
     ┌─────┐ ┌─────┐ ┌─────┐
     │Claude│ │Codex│ │ GLM │  ← Each critiques the others' proposals
     │crits │ │crits │ │crits │     (strengths, weaknesses, missed, hybrid idea)
     │B & C │ │A & C │ │A & B │
     └──┬──┘ └──┬──┘ └──┬──┘
        └───────┼───────┘
                ▼
     Phase 3: Convergence (parallel)
     ┌─────┐ ┌─────┐ ┌─────┐
     │Claude│ │Codex│ │ GLM │  ← Each refines their proposal
     │Refined│ │Refined│ │Refined│  incorporating best from others
     │  A'  │ │  B'  │ │  C'  │
     └──┬──┘ └──┬──┘ └──┬──┘
        └───────┼───────┘
                ▼
     Phase 4: Democratic Synthesis (parallel — NO single judge)
     ┌─────┐ ┌─────┐ ┌─────┐
     │Claude│ │Codex│ │ GLM │  ← ALL 3 produce their own synthesis
     │synth │ │synth │ │synth │     (not just Claude — democratic!)
     └──┬──┘ └──┬──┘ └──┬──┘
        └───────┼───────┘
                ▼
     ┌──────────────────┐
     │  Converged Plan   │  ← Extract consensus from all 3 syntheses
     │  (democratic)     │     ✅ Agreements · ❌ Disagreements
     │                   │     🤝 Each model's contribution
     │  No single model  │     🎯 Confidence (avg + range)
     │  owns the answer  │
     └──────────────────┘
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
