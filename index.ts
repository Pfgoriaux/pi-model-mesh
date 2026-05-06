import { streamSimple, type ImageContent, type Message, type Model } from "@mariozechner/pi-ai";
import {
  buildSessionContext,
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  type AgentSessionServices,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Alias = "claude" | "codex" | "glm";

type ModelBinding = {
  provider: string;
  modelId: string;
  label: string;
};

type WorkerToolMode = "none" | "read-only" | "full";

type WorkerPhase = "pending" | "starting" | "thinking" | "toolcalling" | "streaming" | "done" | "error";

/** Activity event emitted by both streaming paths */
type StreamActivity =
  | { kind: "text"; delta: string; full: string }
  | { kind: "thinking_start" }
  | { kind: "thinking_delta"; chars: number; totalThinkingChars: number }
  | { kind: "thinking_end" }
  | { kind: "toolcall_start"; toolName: string }
  | { kind: "toolcall_end"; toolName: string };

interface WorkerStatus {
  alias: Alias;
  phase: WorkerPhase;
  startedAt: number;
  firstActivityAt: number | null;   // first *any* activity from the model
  firstTextAt: number | null;       // first text token
  finishedAt: number | null;
  charCount: number;
  thinkingChars: number;
  isThinking: boolean;
  toolCalls: number;
  activeToolName: string | null;
  error: string | null;
  streamPath: "worker" | "legacy" | null;  // which path is active
}

interface CrossReview {
  reviewer: Alias;
  reviews: Partial<Record<Alias, string>>;
}

interface ConsensusReport {
  agreements: string[];
  disagreements: string[];
  actionItems: string[];
  verdicts: Partial<Record<Alias, { approved: boolean; confidence: number; notes: string }>>;
}

interface DeliberationReport {
  proposals: Partial<Record<Alias, string>>;        // Phase 1: each model's independent proposal
  critiques: CrossReview[];                         // Phase 2: each model critiques the others
  refinements: Partial<Record<Alias, string>>;      // Phase 3: each model's refined proposal after seeing critiques
  syntheses: Partial<Record<Alias, string>>;         // Phase 4: each model's independent synthesis
  winner: Alias | null;                             // null = democratic (no single winner); set only if 1/3 models succeeded
  finalPlan: string | null;                         // Converged final solution (democratic consensus)
  tradeoffs: string[];                              // Key tradeoffs identified
  risks: string[];                                  // Risks flagged by any model
}

interface MeshRound {
  id: string;
  createdAt: number;
  prompt: string;
  targets: Alias[];
  deliberation: boolean;
  judge: Alias | null;
  outputs: Partial<Record<Alias, string>>;
  judged: string | null;
  // --- Review mode additions ---
  review: boolean;
  crossReviews: CrossReview[];
  consensus: ConsensusReport | null;
  // --- Deliberation mode additions ---
  deliberationReport: DeliberationReport | null;
}

interface LogEntry {
  ts: string;
  roundId: string;
  alias: Alias | "judge" | "mesh" | "review";
  phase: WorkerPhase | "info" | "warn";
  message: string;
}

// ---------------------------------------------------------------------------
// Constants & config
// ---------------------------------------------------------------------------

const SYNTHETIC_GLM_PROVIDER = process.env.MESH_SYNTHETIC_PROVIDER?.trim() || "synthetic";
const SYNTHETIC_BASE_URL = process.env.SYNTHETIC_BASE_URL?.trim() || "https://api.synthetic.new/v1";
const SYNTHETIC_API_KEY_ENV = process.env.SYNTHETIC_API_KEY_ENV?.trim() || "SYNTHETIC_API_KEY";
const LEGACY_WORKER_INSTRUCTIONS = process.env.MESH_SYSTEM_PROMPT?.trim();
const LEGACY_SYSTEM_PROMPT = "You are a helpful coding assistant.";

const MESH_LOG_DIR = process.env.MESH_LOG_DIR?.trim() || path.join(os.homedir(), ".pi", "agent", "logs");
const MESH_PREVIEW_LENGTH = parseInt(process.env.MESH_PREVIEW_LENGTH?.trim() || "300", 10);
const MESH_WIDGET_THROTTLE_MS = parseInt(process.env.MESH_WIDGET_THROTTLE_MS?.trim() || "150", 10);
const MESH_LOG_INTERVAL_MS = parseInt(process.env.MESH_LOG_INTERVAL_MS?.trim() || "3000", 10);
const MESH_LOG_INTERVAL_CHARS = parseInt(process.env.MESH_LOG_INTERVAL_CHARS?.trim() || "500", 10);

function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return defaultValue;
}

// Legacy paths are compatibility fallbacks. They do NOT provide tool access.
// Historically, Claude OAuth (/login anthropic) regressed in the worker-session
// path with "invalid x-api-key". PI's main session uses the same
// createAgentSessionFromServices factory + modelRegistry.getApiKeyAndHeaders
// that runWorkerSession uses, and works with OAuth, so we now try worker-session
// first and rely on LEGACY_FALLBACK_PATTERNS (which matches /invalid x-api-key/)
// to drop back to legacy automatically if OAuth headers really don't propagate.
// Set MESH_LEGACY_CLAUDE_OAUTH=1 to restore the old "always go straight to
// legacy when OAuth is detected" behavior.
const MESH_LEGACY_CLAUDE_OAUTH = envBool("MESH_LEGACY_CLAUDE_OAUTH", false);
// Nuclear option: force ALL models through worker session, no legacy fallback.
const MESH_FORCE_WORKER_SESSION = envBool("MESH_FORCE_WORKER_SESSION", false);

const MODEL_MAP: Record<Alias, ModelBinding> = {
  claude: {
    provider: process.env.MESH_PROVIDER_CLAUDE?.trim() || "anthropic",
    modelId: process.env.MESH_MODEL_CLAUDE?.trim() || "claude-opus-4-7",
    label: "Claude Code",
  },
  codex: {
    provider: process.env.MESH_PROVIDER_CODEX?.trim() || "openai-codex",
    modelId: process.env.MESH_MODEL_CODEX?.trim() || "gpt-5.3-codex",
    label: "Codex",
  },
  glm: {
    provider: SYNTHETIC_GLM_PROVIDER,
    modelId: process.env.MESH_MODEL_GLM?.trim() || "hf:zai-org/GLM-5.1",
    label: "GLM 5.1 (Synthetic)",
  },
};

const ORDER: Alias[] = ["claude", "codex", "glm"];
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

// ---------------------------------------------------------------------------
// Model-specific system prompts
// ---------------------------------------------------------------------------

/** System prompt for Claude models. */
const CLAUDE_SYSTEM_PROMPT = `You are Pi, an expert coding assistant.

- Be concise and direct.
- Prefer native tools over bash for file work. Never use bash to read files.
- Read relevant files before editing or claiming behavior.
- For implementation requests, act once enough context is read.
- Make small focused changes. Match existing patterns.
- Preserve the original code structure and logic. Only change what is strictly necessary.
- Do not rename variables, add helper functions, or introduce new abstractions unless explicitly required.
- Do not add unrelated cleanup, abstractions, or files.
- Verify relevant checks before claiming completion.`;

/** System prompt for Codex models. */
const CODEX_SYSTEM_PROMPT = `You are Pi, an expert coding assistant.

- Be concise.
- Follow explicit constraints exactly.
- Prefer native tools over bash for file work. Never use bash to read files.
- Read relevant code before editing.
- Use a clear loop: inspect, edit, verify.
- Start implementing once enough context is read. Do not churn on planning.
- Preserve the original code and logic of the original code as much as possible. Only change what is strictly necessary.
- Make small focused diffs. Reuse existing patterns. No unrelated changes.
- Do not rename variables, add helper functions, or introduce new abstractions unless explicitly required.
- Do not add error handling, fallbacks, or validation for scenarios that can't happen.
- Do not add docstrings, comments, or type annotations to code you didn't change.
- Run relevant checks before claiming completion.`;

/** System prompt for GLM models (GLM-5, GLM-5.1, GLM-4.7). */
const GLM_SYSTEM_PROMPT = `You are Pi, an expert coding assistant.

- Be concise. Skip filler.
- Prefer native tools over bash for file work. Never use bash to read files.
- Read relevant code before editing or proposing changes.
- Plan briefly, then act. For straightforward tasks, do not spend multiple turns planning.
- If the user asked to implement and enough context is read, start changing code.
- Follow user corrections exactly across turns: names, paths, config keys, commands, scope.
- Before renames, moves, deletions, or path changes, trace imports, config, build, registrations, and runtime usage.
- Treat deletion as high risk. Prove unused first.
- Make small focused diffs. Match existing conventions.
- Preserve the original code structure and logic. Only change what is strictly necessary.
- Do not rename variables, add helper functions, or introduce new abstractions unless explicitly required.
- Prefer to work autonomously; maintain goal alignment across extended sessions.
- Verify after changes, but do not repeat unchanged checks.`;

const ALIAS_SYSTEM_PROMPTS: Record<Alias, string> = {
  claude: CLAUDE_SYSTEM_PROMPT,
  codex: CODEX_SYSTEM_PROMPT,
  glm: GLM_SYSTEM_PROMPT,
};

function getSystemPromptForAlias(alias: Alias): string {
  return ALIAS_SYSTEM_PROMPTS[alias];
}

// ---------------------------------------------------------------------------
// Review-specific system prompts (used in @review and cross-verification)
// ---------------------------------------------------------------------------

const REVIEW_ANALYSIS_PROMPT = `You are a senior code reviewer. Analyze the code/change described below and provide a structured review.

Your review MUST have these sections:
1. **Summary**: What does this code/change do?
2. **Issues found**: List bugs, logic errors, security issues, edge cases. Use severity: 🔴 critical, 🟠 major, 🟡 minor, 🔵 nit.
3. **Strengths**: What's good about this implementation?
4. **Suggestions**: Concrete improvements (not vague advice).
5. **Verdict**: One of: APPROVE, REQUEST_CHANGES, or NEEDS_DISCUSSION. With a confidence score 0-100.

Be specific. Reference line numbers, variable names, or code patterns. Don't repeat what the code already says.`;

const REVIEW_CROSSCHECK_PROMPT = `You are a senior code reviewer performing cross-verification. You have already reviewed the code yourself. Now you are given reviews from OTHER models.

Your job:
1. For each other review, state whether you AGREE or DISAGREE with each finding.
2. If you disagree, explain WHY with evidence.
3. Identify anything the other reviewer MISSED that you found.
4. Produce a final consolidated assessment.

Format:
- For each other reviewer's finding: ✅ AGREE or ❌ DISAGREE with reason
- **Consolidated issues**: The issues that survive cross-verification
- **Final verdict**: APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION with confidence 0-100`;

const REVIEW_CONSENSUS_PROMPT = `You are a meta-reviewer synthesizing cross-verification results from multiple AI code reviewers.

You receive:
- The original code review prompt
- Each model's independent review
- Each model's cross-verification of the other reviews

Produce a final consensus report:

## ✅ Consensus (all agree)
List issues/observations where ALL reviewers agree.

## ⚠️ Disagreements (needs human attention)
List points where reviewers disagree, with each side's argument.

## 🔍 Action items
Concrete steps the developer should take before merging.

## 📊 Verdict matrix
| Model | Verdict | Confidence | Key concern |

## 🏁 Final recommendation
One clear recommendation: MERGE, FIX_FIRST, or MAJOR_REWORK.`;

const PHASE_ICON: Record<WorkerPhase, string> = {
  pending: "⏳",
  starting: "🚀",
  thinking: "🧠",
  toolcalling: "🔧",
  streaming: "📡",
  done: "✅",
  error: "❌",
};

// ---------------------------------------------------------------------------
// Logging system
// ---------------------------------------------------------------------------

class MeshLogger {
  private entries: LogEntry[] = [];
  private stream: fs.WriteStream | null = null;
  private logFilePath: string;
  private roundId: string;

  constructor(roundId: string) {
    this.roundId = roundId;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    this.logFilePath = path.join(MESH_LOG_DIR, `model-mesh-${ts}.log`);
    try {
      fs.mkdirSync(MESH_LOG_DIR, { recursive: true });
      this.stream = fs.createWriteStream(this.logFilePath, { flags: "a" });
    } catch {
      // Best effort — if we can't write logs, at least keep them in memory
    }
  }

  log(alias: Alias | "judge" | "mesh" | "review", phase: WorkerPhase | "info" | "warn", message: string): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      roundId: this.roundId,
      alias,
      phase,
      message,
    };
    this.entries.push(entry);
    const line = `[${entry.ts}] [${entry.roundId}] [${entry.alias}] [${entry.phase}] ${entry.message}\n`;
    if (this.stream) {
      this.stream.write(line);
    }
  }

  getEntries(): LogEntry[] {
    return [...this.entries];
  }

  getLogFilePath(): string {
    return this.logFilePath;
  }

  getEntryCount(): number {
    return this.entries.length;
  }

  dispose(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Periodic progress logger
// ---------------------------------------------------------------------------

/** Emits a log line every N ms or N chars, whichever comes first. Avoids flooding. */
class ProgressReporter {
  private lastLogAt = 0;
  private lastCharCount = 0;

  constructor(
    private logger: MeshLogger,
    private alias: Alias | "judge" | "review",
    private intervalMs: number,
    private intervalChars: number,
  ) {}

  maybeLog(charCount: number, thinkingChars: number, toolCalls: number, phase: WorkerPhase): void {
    const now = Date.now();
    const charDelta = Math.abs(charCount - this.lastCharCount);
    const timeDelta = now - this.lastLogAt;

    if (timeDelta >= this.intervalMs || charDelta >= this.intervalChars) {
      const parts: string[] = [];
      if (phase === "thinking") parts.push(`thinking ${thinkingChars} chars`);
      if (phase === "toolcalling") parts.push(`tool call #${toolCalls}`);
      if (phase === "streaming") parts.push(`${charCount} text chars`);
      if (parts.length === 0) parts.push(`${charCount} chars`);

      this.logger.log(this.alias, phase, `Progress: ${parts.join(", ")}`);
      this.lastLogAt = now;
      this.lastCharCount = charCount;
    }
  }
}

// ---------------------------------------------------------------------------
// Worker status tracker
// ---------------------------------------------------------------------------

function createWorkerStatus(alias: Alias): WorkerStatus {
  return {
    alias,
    phase: "pending",
    startedAt: 0,
    firstActivityAt: null,
    firstTextAt: null,
    finishedAt: null,
    charCount: 0,
    thinkingChars: 0,
    isThinking: false,
    toolCalls: 0,
    activeToolName: null,
    error: null,
    streamPath: null,
  };
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

// ---------------------------------------------------------------------------
// Widget throttle
// ---------------------------------------------------------------------------

function createThrottledUpdater(intervalMs: number): (fn: () => void) => void {
  let lastRun = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  return (fn: () => void) => {
    const now = Date.now();
    const elapsed = now - lastRun;

    if (elapsed >= intervalMs) {
      lastRun = now;
      fn();
    } else if (!pendingTimer) {
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        lastRun = Date.now();
        fn();
      }, intervalMs - elapsed);
    }
  };
}

// ---------------------------------------------------------------------------
// Tool mode helpers
// ---------------------------------------------------------------------------

function parseWorkerToolMode(value: string | undefined): WorkerToolMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "none") return "none";
  if (normalized === "full") return "full";
  if (normalized === "readonly" || normalized === "read-only" || normalized === "read_only") return "read-only";
  return "full";
}

const WORKER_TOOL_MODE = parseWorkerToolMode(process.env.MESH_TOOL_MODE);

function getWorkerToolNames(mode: WorkerToolMode): string[] {
  if (mode === "none") return [];
  if (mode === "full") return ["read", "bash", "edit", "write", "grep", "find", "ls"];
  return [...READ_ONLY_TOOLS];
}

// ---------------------------------------------------------------------------
// Worker services cache
// ---------------------------------------------------------------------------

let workerServices: AgentSessionServices | undefined;

async function getWorkerServices(
  cwd: string,
  modelRegistry: ExtensionAPI extends (api: infer A) => void
    ? A
    : unknown,
): Promise<AgentSessionServices> {
  if (workerServices) return workerServices;

  const services = await createAgentSessionServices({
    cwd,
    modelRegistry: modelRegistry as any,
    resourceLoaderOptions: {
      noExtensions: true,
    },
  });

  workerServices = services;
  return services;
}

function invalidateWorkerServices(): void {
  workerServices = undefined;
}

// ---------------------------------------------------------------------------
// Parent context capture
// ---------------------------------------------------------------------------

let capturedParentContext: {
  contextFilePaths: string[];
  skillNames: string[];
  selectedTools: string[];
  promptGuidelines: string[];
} | undefined;

function resetCapturedContext(): void {
  capturedParentContext = undefined;
}

function buildParentContextBlock(): string {
  if (!capturedParentContext) return "";
  const parts: string[] = ["## Parent session context (from extensions)"];
  if (capturedParentContext.contextFilePaths.length > 0) {
    parts.push("Context files: " + capturedParentContext.contextFilePaths.join(", "));
  }
  if (capturedParentContext.skillNames.length > 0) {
    parts.push("Skills: " + capturedParentContext.skillNames.join(", "));
  }
  if (capturedParentContext.selectedTools.length > 0) {
    parts.push("Tools: " + capturedParentContext.selectedTools.join(", "));
  }
  if (capturedParentContext.promptGuidelines.length > 0) {
    parts.push("Guidelines:\n" + capturedParentContext.promptGuidelines.map((g) => `- ${g}`).join("\n"));
  }
  return parts.length > 1 ? parts.join("\n") : "";
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

function stripTags(text: string): string {
  return text.replace(/(^|\s)@[a-zA-Z0-9:_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function parseInput(text: string): {
  targets: Alias[];
  cleanedPrompt: string;
  deliberation: boolean;
  judgeMode: boolean;
  chosenJudge: Alias | null;
  reviewMode: boolean;
  deliberationMode: boolean;
} {
  const tokenRegex = /(^|\s)@([a-zA-Z0-9:_-]+)/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(text)) !== null) found.add(m[2].toLowerCase());

  // @review = @all + cross-review + consensus (shorthand for the full review workflow)
  const reviewMode = found.has("review");

  // @deliberate / @debate = @all + multi-phase deliberation pipeline
  const deliberationMode = found.has("deliberate") || found.has("debate") || /\bdeliberat(e|ion|ing)\b/i.test(text);

  const hasAll = found.has("all") || reviewMode || deliberationMode; // @review and @deliberate imply @all
  const aliases = ORDER.filter((a) => found.has(a));

  const judgeToken = Array.from(found).find((t) => t.startsWith("judge"));
  // @review and @deliberate imply @judge (auto-judge using Claude by default)
  const judgeMode = Boolean(judgeToken) || reviewMode || deliberationMode;

  let chosenJudge: Alias | null = null;
  const judgeInline = judgeToken?.match(/^judge[:_-](claude|codex)$/i);
  if (judgeInline) {
    chosenJudge = judgeInline[1].toLowerCase() as Alias;
  }

  let targets = hasAll ? [...ORDER] : aliases;
  if (targets.length === 0 && (judgeMode || reviewMode || deliberationMode)) targets = [...ORDER];

  if (!chosenJudge && judgeMode) {
    const explicitJudgeInText = text.match(/\bjudge\s*[=:]\s*(claude|codex)\b/i);
    if (explicitJudgeInText) chosenJudge = explicitJudgeInText[1].toLowerCase() as Alias;
  }

  if (!chosenJudge && judgeMode) chosenJudge = "claude";

  // Strip @review and @deliberate/@debate from the prompt too
  const cleanedPrompt = stripTags(text)
    .replace(/\b(review|deliberat(e|ion|ing)|debate)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    targets,
    cleanedPrompt,
    deliberation: deliberationMode, // keep legacy field for compat
    judgeMode,
    chosenJudge,
    reviewMode,
    deliberationMode,
  };
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

function textFromMessage(msg: { content?: Array<{ type: string; text?: string }> } | null | undefined): string {
  if (!msg?.content) return "";
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function errorFromAssistantMessage(
  msg:
    | {
        stopReason?: string;
        errorMessage?: string;
      }
    | null
    | undefined,
): string {
  if (!msg) return "";
  if ((msg.stopReason === "error" || msg.stopReason === "aborted") && msg.errorMessage) {
    return `Error: ${msg.errorMessage}`;
  }
  return "";
}

function textOrErrorFromAssistantMessage(
  msg:
    | {
        content?: Array<{ type: string; text?: string }>;
        stopReason?: string;
        errorMessage?: string;
      }
    | null
    | undefined,
): string {
  return textFromMessage(msg) || errorFromAssistantMessage(msg);
}

function cloneValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function sanitizeWorkerHistory(history: unknown[]): unknown[] {
  return history.filter((message) => {
    if (!message || typeof message !== "object") return false;
    const msg = message as { role?: string; customType?: string };
    return !(msg.role === "custom" && msg.customType?.startsWith("model-mesh"));
  });
}

// ---------------------------------------------------------------------------
// Model-specific helpers
// ---------------------------------------------------------------------------

function getWorkerThinkingLevel(
  alias: Alias,
  model: Model<any>,
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>,
): ReturnType<ExtensionAPI["getThinkingLevel"]> {
  return thinkingLevel;
}

function normalizeWorkerOutcome(alias: Alias, model: Model<any>, outcome: string): string {
  if (
    alias === "claude" &&
    model.provider === MODEL_MAP.claude.provider &&
    /invalid x-api-key|authentication_error/i.test(outcome)
  ) {
    return [
      `Error: Anthropic authentication failed.`,
      `@claude defaults to ${MODEL_MAP.claude.provider}/${MODEL_MAP.claude.modelId}.`,
      `Set ANTHROPIC_API_KEY or run '/login anthropic' to authenticate.`,
      ``,
      `Raw upstream error: ${outcome.replace(/^Error:\s*/i, "")}`,
    ].join("\n");
  }
  return outcome;
}

/**
 * Decide the initial streaming route. Default is always worker-session (with
 * tools). Only force legacy when the user explicitly opts in via env vars, or
 * when MESH_FORCE_WORKER_SESSION is off.
 *
 * Even when starting with worker-session, we catch provider-incompat errors
 * and fall back to legacy automatically (see LEGACY_FALLBACK_PATTERNS).
 */
function getStreamingRoute(
  alias: Alias,
  model: Model<any>,
  ctx: any,
): { legacy: boolean; reason: string } {
  // User can force ALL models to use worker-session (with tools), even
  // those that previously regressed. This is the "just try it" knob.
  if (MESH_FORCE_WORKER_SESSION) {
    return { legacy: false, reason: "forced-worker-session" };
  }

  // Claude with OAuth previously regressed in the worker-session path.
  // Default: try worker-session first (user can set MESH_LEGACY_CLAUDE_OAUTH=1
  // to skip the attempt and go straight to legacy).
  const isUsingOAuth =
    (ctx.modelRegistry as { isUsingOAuth?: (m: Model<any>) => boolean }).isUsingOAuth?.(model) ?? false;
  if (alias === "claude" && model.provider === MODEL_MAP.claude.provider && isUsingOAuth && MESH_LEGACY_CLAUDE_OAUTH) {
    return { legacy: true, reason: "claude-oauth-compat-legacy" };
  }

  return { legacy: false, reason: "worker-session" };
}

function shouldUseLegacyStreaming(alias: Alias, model: Model<any>, ctx: any): boolean {
  return getStreamingRoute(alias, model, ctx).legacy;
}

/**
 * Error patterns from the worker-session path that indicate we should
 * automatically fall back to the legacy streamSimple path (no tools, but at
 * least the model can respond). These are the regressions that originally
 * forced certain models to use legacy.
 */
const LEGACY_FALLBACK_PATTERNS = [
  /prompt_cache_key.*Extra inputs are not permitted/i,   // Some providers reject OpenAI cache fields
  /reasoning_effort.*Extra inputs are not permitted/i,  // Some providers reject reasoning controls
  /invalid x-api-key/i,                                  // Claude OAuth regression
  /authentication_error/i,                              // Claude OAuth regression
  /subscription.*not.*support/i,                         // Claude subscription auth
  /extra usage.*not.*(your )?plan/i,                    // Claude OAuth extra usage routing
  /out of extra usage/i,                                // Claude OAuth extra usage depleted
  /Third-party apps now draw from your extra usage/i,   // Claude OAuth third-party billing policy
  /Third-party.*not.*plan/i,                             // Claude OAuth third-party plan limit restriction
];

function shouldFallBackToLegacy(error: string): boolean {
  return LEGACY_FALLBACK_PATTERNS.some((p) => p.test(error));
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Deliberation prompt builders (for @deliberate mode)
// ---------------------------------------------------------------------------

/** Phase 1: Independent proposal. Each model proposes its solution from scratch. */
const DELIBERATION_PROPOSAL_PROMPT = `You are part of a multi-model deliberation. You will propose a solution independently, then later see and critique other models' proposals.

Your job NOW: propose your best solution to the problem below.

Required structure:
1. **Approach**: Briefly describe your approach and why you chose it.
2. **Implementation plan**: Concrete steps (numbered, specific).
3. **Tradeoffs**: What are the key tradeoffs of your approach?
4. **Risks**: What could go wrong? What edge cases exist?
5. **Alternatives considered**: What other approaches did you consider and why reject them?
6. **Confidence**: Rate your confidence 0-100 in this being the best approach.

Be specific. Vague advice is useless. Show code patterns, file names, data structures.
If you're unsure about something, say so explicitly — that's better than guessing.`;

/** Phase 2: Critique. Each model reviews the OTHERS' proposals. */
const DELIBERATION_CRITIQUE_PROMPT = `You are in a multi-model deliberation. You have already proposed your own solution. Now you will see the other models' proposals.

Your job: critically evaluate each proposal.

For each other proposal:
1. **Strengths**: What does this approach do BETTER than yours? Be honest.
2. **Weaknesses**: Where is this approach weaker or riskier than yours?
3. **Missing pieces**: What did they miss that you covered?
4. **Verdict**: Would you adopt this approach over yours? YES/NO with reason.

Then:
5. **Convergence idea**: Based on all proposals, describe the HYBRID approach that takes the best from each. This is the most important part — don't just pick one, BUILD the best combination.`;

/** Phase 3: Convergence. Each model produces a refined final proposal. */
const DELIBERATION_CONVERGENCE_PROMPT = `You are in the final phase of a multi-model deliberation. You have seen the other models' proposals and critiques.

Your job: produce ONE final refined proposal that incorporates the best ideas from all models.

Requirements:
1. **Final approach**: State the approach clearly. If it's a hybrid, explain what you took from each model.
2. **Implementation plan**: Concrete, numbered steps. Someone should be able to execute this without asking questions.
3. **What changed from your initial proposal**: What did you adopt from the other models?
4. **Remaining disagreements**: Are there points where you still disagree with the others? State them.
5. **Confidence**: Rate your confidence 0-100 in this final proposal.

This is the final output. Make it count.`;

/** Synthesizer: takes all refined proposals and produces THE final plan. */
const DELIBERATION_SYNTHESIS_PROMPT = `You are synthesizing a multi-model deliberation. You have seen three independent proposals, their cross-critiques, and their refined final proposals.

IMPORTANT: You are NOT the sole judge. ALL three models are producing their own synthesis in parallel. Your synthesis will be cross-referenced with the others to find consensus. You must be fair and honest — do not favor your own earlier proposal.

Your job: produce ONE definitive solution plan.

Required structure:

## 🏆 Recommended Approach
The best approach (or hybrid). Explain why this wins. Be honest about what you adopted from others.

## 📋 Implementation Plan
Concrete steps that can be executed immediately. No vagueness.

## ⚖️ Tradeoffs
Key tradeoffs of the recommended approach.

## ⚠️ Risks & Mitigations
Risks and how to handle them.

## 🤝 What Each Model Contributed
| Model | Key contribution |
|-------|-----------------|

## ❌ Remaining Disagreements
Points where models still disagree (if any). State each model's position.

## 🎯 Confidence Score
Overall confidence 0-100 that this plan will work.

Be decisive but fair. You are one voice in a democratic process.`;

function buildDeliberationProposalPrompt(userPrompt: string): string {
  return [
    DELIBERATION_PROPOSAL_PROMPT,
    "",
    "# Problem to solve",
    userPrompt,
  ].join("\n");
}

function buildDeliberationCritiquePrompt(
  reviewerAlias: Alias,
  userPrompt: string,
  allOutputs: Partial<Record<Alias, string>>,
): string {
  const others = ORDER.filter((a) => a !== reviewerAlias && allOutputs[a]);
  const otherProposals = others
    .map((a) => `## ${MODEL_MAP[a].label}'s Proposal\n${allOutputs[a]}`)
    .join("\n\n");

  return [
    DELIBERATION_CRITIQUE_PROMPT,
    "",
    "# Original problem",
    userPrompt,
    "",
    "# Your proposal (for reference)",
    allOutputs[reviewerAlias] || "(not available)",
    "",
    "# Other models' proposals",
    otherProposals || "(none)",
  ].join("\n");
}

function buildDeliberationConvergencePrompt(
  alias: Alias,
  userPrompt: string,
  allOutputs: Partial<Record<Alias, string>>,
  allCritiques: CrossReview[],
): string {
  // Find this model's critique of others
  const myCritique = allCritiques.find((cr) => cr.reviewer === alias);
  const critiqueText = myCritique
    ? Object.entries(myCritique.reviews)
        .filter(([target]) => target !== alias)
        .map(([target, text]) => `### Your critique of ${MODEL_MAP[target as Alias]?.label || target}\n${text}`)
        .join("\n\n")
    : "(no critique)";

  // Find other models' critiques of THIS model
  const critiquesOfMe = allCritiques
    .filter((cr) => cr.reviewer !== alias && cr.reviews[alias])
    .map((cr) => `### ${MODEL_MAP[cr.reviewer].label}'s critique of your proposal\n${cr.reviews[alias]}`)
    .join("\n\n");

  return [
    DELIBERATION_CONVERGENCE_PROMPT,
    "",
    "# Original problem",
    userPrompt,
    "",
    "# Your initial proposal",
    allOutputs[alias] || "(not available)",
    "",
    "# Your critiques of others",
    critiqueText,
    "",
    "# Others' critiques of your proposal",
    critiquesOfMe || "(no critiques received)",
  ].join("\n");
}

function buildDeliberationSynthesisPrompt(
  userPrompt: string,
  allOutputs: Partial<Record<Alias, string>>,
  allCritiques: CrossReview[],
  refinements: Partial<Record<Alias, string>>,
): string {
  const proposalsSection = ORDER
    .filter((a) => allOutputs[a])
    .map((a) => `## ${MODEL_MAP[a].label} — Initial Proposal\n${allOutputs[a]}`)
    .join("\n\n");

  const critiquesSection = allCritiques
    .map((cr) => {
      const lines = [`### ${MODEL_MAP[cr.reviewer].label}'s Critique`];
      for (const [target, text] of Object.entries(cr.reviews)) {
        lines.push(`**${MODEL_MAP[target as Alias]?.label || target}**: ${preview(text, 300)}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");

  const refinementsSection = ORDER
    .filter((a) => refinements[a])
    .map((a) => `## ${MODEL_MAP[a].label} — Refined Proposal\n${refinements[a]}`)
    .join("\n\n");

  return [
    DELIBERATION_SYNTHESIS_PROMPT,
    "",
    "# Original problem",
    userPrompt,
    "",
    "# Phase 1: Independent Proposals",
    proposalsSection || "(none)",
    "",
    "# Phase 2: Cross-Critiques",
    critiquesSection || "(none)",
    "",
    "# Phase 3: Refined Proposals",
    refinementsSection || "(none)",
  ].join("\n");
}

function buildJudgePrompt(userPrompt: string, outputs: Partial<Record<Alias, string>>, judge: Alias): string {
  const options = ORDER
    .filter((a) => outputs[a] && a !== judge)
    .map((a) => `## Candidate: ${MODEL_MAP[a].label}\n${outputs[a]}`)
    .join("\n\n");

  return [
    "You are the final judge model in a multi-model orchestration.",
    "Analyze all candidate responses and produce a final decision.",
    "Required structure:",
    "1) Winner",
    "2) Why it wins",
    "3) Risks/Tradeoffs",
    "4) Final recommended plan (concrete steps)",
    "",
    "# Original user request",
    userPrompt,
    "",
    "# Candidate responses",
    options || "(no candidates)",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Cross-review prompt builders (for @review mode)
// ---------------------------------------------------------------------------

function buildCrossReviewPrompt(
  reviewerAlias: Alias,
  allOutputs: Partial<Record<Alias, string>>,
  userPrompt: string,
): string {
  // Each model reviews the OTHER models' outputs
  const others = ORDER.filter((a) => a !== reviewerAlias && allOutputs[a]);
  if (others.length === 0) return "No other outputs to review.";

  const otherReviews = others
    .map((a) => `## Review by ${MODEL_MAP[a].label}\n${allOutputs[a]}`)
    .join("\n\n");

  return [
    REVIEW_CROSSCHECK_PROMPT,
    "",
    "# Original code review request",
    userPrompt,
    "",
    "# Your own review (for reference)",
    allOutputs[reviewerAlias] || "(not available)",
    "",
    "# Other models' reviews (verify these)",
    otherReviews,
  ].join("\n");
}

function buildConsensusPrompt(
  userPrompt: string,
  outputs: Partial<Record<Alias, string>>,
  crossReviews: CrossReview[],
): string {
  const reviewsSection = ORDER
    .filter((a) => outputs[a])
    .map((a) => `## ${MODEL_MAP[a].label} — Independent Review\n${outputs[a]}`)
    .join("\n\n");

  const crossSection = crossReviews
    .map((cr) => {
      const lines = [`### ${MODEL_MAP[cr.reviewer].label} cross-verified:`];
      for (const [targetAlias, review] of Object.entries(cr.reviews)) {
        if (targetAlias !== cr.reviewer) {
          lines.push(`- ${MODEL_MAP[targetAlias as Alias]?.label || targetAlias}: ${preview(review, 200)}`);
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");

  return [
    REVIEW_CONSENSUS_PROMPT,
    "",
    "# Original code review request",
    userPrompt,
    "",
    "# Independent Reviews",
    reviewsSection || "(none)",
    "",
    "# Cross-Verification Results",
    crossSection || "(none)",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Consensus parsing — extract structured report from model text
// ---------------------------------------------------------------------------

function parseConsensusFromText(
  text: string,
  outputs: Partial<Record<Alias, string>>,
): ConsensusReport {
  const agreements: string[] = [];
  const disagreements: string[] = [];
  const actionItems: string[] = [];
  const verdicts: ConsensusReport["verdicts"] = {};

  // Extract agreements (lines under ✅ or Consensus section)
  const agreementMatch = text.match(/##?\s*Consensus[^\n]*\n([\s\S]*?)(?=##?\s|$)/i);
  if (agreementMatch) {
    for (const line of agreementMatch[1].split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim())) {
      if (line) agreements.push(line);
    }
  }

  // Extract disagreements
  const disagreementMatch = text.match(/##?\s*Disagreements?[^\n]*\n([\s\S]*?)(?=##?\s|$)/i);
  if (disagreementMatch) {
    for (const line of disagreementMatch[1].split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim())) {
      if (line) disagreements.push(line);
    }
  }

  // Extract action items
  const actionMatch = text.match(/##?\s*Action\s*items?[^\n]*\n([\s\S]*?)(?=##?\s|$)/i);
  if (actionMatch) {
    for (const line of actionMatch[1].split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim())) {
      if (line) actionItems.push(line);
    }
  }

  // Extract verdicts from each model's review (look for APPROVE/REQUEST_CHANGES/NEEDS_DISCUSSION + confidence)
  for (const alias of ORDER) {
    if (!outputs[alias]) continue;
    const review = outputs[alias]!;
    const verdictMatch = review.match(/\b(APPROVE|REQUEST_CHANGES|NEEDS_DISCUSSION)\b/i);
    const confidenceMatch = review.match(/confidence[:\s]*(\d{1,3})/i);

    if (verdictMatch) {
      verdicts[alias] = {
        approved: /APPROVE/i.test(verdictMatch[1]),
        confidence: confidenceMatch ? parseInt(confidenceMatch[1], 10) : 50,
        notes: preview(review, 80),
      };
    }
  }

  // If we couldn't parse structured data, fall back to putting the whole text as one agreement
  if (agreements.length === 0 && disagreements.length === 0 && actionItems.length === 0) {
    agreements.push("See full consensus text for details");
  }

  return { agreements, disagreements, actionItems, verdicts };
}

const CWD_GUARD_WORKER_PROMPT =
  "Scope: you have full tool access (Read, Grep, Glob, Bash, Edit, etc.) within the current working directory and its subdirectories — use them freely to answer the user. " +
  "The only restriction is that you must not read, write, or navigate to paths OUTSIDE the cwd (no `cd ..`, no absolute paths pointing to parent directories, no `~` unless it resolves inside cwd). " +
  "If — and only if — the user explicitly asks for something outside the cwd, say you can't reach it. Otherwise, proceed with tools as normal.";

// ---------------------------------------------------------------------------
// Deliberation text extraction helpers
// ---------------------------------------------------------------------------

function extractTradeoffs(text: string): string[] {
  const results: string[] = [];
  const match = text.match(/##?\s*Tradeoffs?[^\n]*\n([\s\S]*?)(?=##?\s|$)/i);
  if (match) {
    for (const line of match[1].split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim())) {
      if (line) results.push(line);
    }
  }
  return results;
}

function extractRisks(text: string): string[] {
  const results: string[] = [];
  const match = text.match(/##?\s*Risks?[^\n]*\n([\s\S]*?)(?=##?\s|$)/i);
  if (match) {
    for (const line of match[1].split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim())) {
      if (line) results.push(line);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Democratic plan convergence — extract consensus from ALL model syntheses
// No single model is "the judge". We find what they all agree on.
// ---------------------------------------------------------------------------

function buildConvergedPlan(
  syntheses: Partial<Record<Alias, string>>,
  userPrompt: string,
): string {
  const activeSynths = ORDER.filter((a) => syntheses[a]);
  const parts: string[] = [];

  // ── Header ──
  parts.push("# 🏆 CONVERGED PLAN\n");
  parts.push("This plan was synthesized **democratically** — all 3 models produced independent syntheses of the deliberation, and this output extracts their consensus. No single model owns the final answer.\n");
//   parts.push(`**Original problem:** ${userPrompt}\n`);

  // ── Extract confidence scores from each synthesis ──
  const confidences: Partial<Record<Alias, number>> = {};
  const recommendations: Partial<Record<Alias, string>> = {};

  for (const alias of activeSynths) {
    const text = syntheses[alias]!;
    const confMatch = text.match(/confidence[:\s]*(\d{1,3})/i);
    confidences[alias] = confMatch ? parseInt(confMatch[1], 10) : undefined;

    // Extract the recommended approach line
    const approachMatch = text.match(/##?\s*Recommended\s+Approach[^\n]*\n([\s\S]*?)(?=##?\s|$)/i);
    recommendations[alias] = approachMatch ? approachMatch[1].trim() : preview(text, 200);
  }

  // ── Democracy scorecard ──
  parts.push("## 📊 Democracy Scorecard\n");
  parts.push("| Model | Confidence | Recommended Approach |");
  parts.push("|-------|-----------|----------------------|");
  for (const alias of activeSynths) {
    const conf = confidences[alias];
    const rec = recommendations[alias] ? preview(recommendations[alias]!, 80) : "(see full synthesis)";
    parts.push(`| ${MODEL_MAP[alias].label} | ${conf != null ? conf : "?"}% | ${rec} |`);
  }
  parts.push("");

  // ── Find the best synthesis ──
  // Strategy: pick the one with highest confidence as the "base",
  // but flag where others agree/disagree
  // This is NOT "the winner" — it's just the longest starting point
  // that we augment with cross-references to the others.
  const sortedByConfidence = [...activeSynths].sort((a, b) => (confidences[b] ?? 0) - (confidences[a] ?? 0));
  const baseAlias = sortedByConfidence[0];
  const baseText = syntheses[baseAlias]!;

  // ── Extract implementation plan from the base ──
  const implPlanMatch = baseText.match(/##?\s*Implementation\s+Plan[^\n]*\n([\s\S]*?)(?=##?\s|$)/i);

  parts.push("## 📋 Implementation Plan\n");
  if (implPlanMatch) {
    parts.push(implPlanMatch[1].trim());
  } else {
    // Fall back: use the full base synthesis
    parts.push(baseText);
  }
  parts.push("");

  // ── Cross-reference: what ALL models agree on ──
  parts.push("## ✅ Points of Consensus (all models agree)\n");
  // Extract action items / implementation steps from each synthesis
  // and find overlapping concepts
  const allActionItems: Map<string, Alias[]> = new Map();
  for (const alias of activeSynths) {
    const text = syntheses[alias]!;
    // Extract bullet points from the synthesis
    const bulletRegex = /^[-*]\s+(.+)$/gm;
    let match: RegExpExecArray | null;
    while ((match = bulletRegex.exec(text)) !== null) {
      const item = match[1].trim();
      if (item.length < 10) continue; // Skip tiny items
      // Simple overlap detection: check if other syntheses contain key words from this item
      const keyWords = item.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
      const supporting: Alias[] = [alias];
      for (const otherAlias of activeSynths) {
        if (otherAlias === alias) continue;
        const otherText = (syntheses[otherAlias] || "").toLowerCase();
        // If >40% of key words appear in the other synthesis, it's supported
        const matchCount = keyWords.filter((w) => otherText.includes(w)).length;
        if (keyWords.length > 0 && matchCount / keyWords.length >= 0.4) {
          supporting.push(otherAlias);
        }
      }
      if (supporting.length >= 2) {
        const key = item.slice(0, 80);
        if (!allActionItems.has(key)) {
          allActionItems.set(key, supporting);
        }
      }
    }
  }

  if (allActionItems.size > 0) {
    for (const [item, supporters] of allActionItems) {
      const supporterLabels = supporters.map((a) => MODEL_MAP[a].label).join(", ");
      parts.push(`- ${item} _(${supporterLabels})_`);
    }
  } else {
    parts.push("All models produced independent syntheses — see individual outputs for details.");
  }
  parts.push("");

  // ── Tradeoffs (from base, augmented) ──
  const tradeoffs = extractTradeoffs(baseText);
  if (tradeoffs.length > 0) {
    parts.push("## ⚖️ Tradeoffs\n");
    for (const t of tradeoffs) parts.push(`- ${t}`);
    parts.push("");
  }

  // ── Risks (from base, augmented) ──
  const risks = extractRisks(baseText);
  if (risks.length > 0) {
    parts.push("## ⚠️ Risks & Mitigations\n");
    for (const r of risks) parts.push(`- ${r}`);
    parts.push("");
  }

  // ── What each model contributed ──
  parts.push("## 🤝 What Each Model Contributed\n");
  parts.push("| Model | Key contribution | Confidence |");
  parts.push("|-------|-------------------|------------|");
  for (const alias of activeSynths) {
    const text = syntheses[alias]!;
    const contribRegex = new RegExp(`\\|\\s*${MODEL_MAP[alias].label}\\s*\\|([^|]+)\\|`);
    const contribMatch = text.match(contribRegex);
    const contrib = contribMatch ? contribMatch[1].trim() : preview(text, 60);
    parts.push(`| ${MODEL_MAP[alias].label} | ${contrib} | ${confidences[alias] ?? "?"}% |`);
  }
  parts.push("");

  // ── Remaining disagreements (if any) ──
  parts.push("## ❌ Remaining Disagreements\n");
  const disagreementMatch = baseText.match(/##?\s*Remaining\s+Disagreements?[^\n]*\n([\s\S]*?)(?=##?\s|$)/i);
  if (disagreementMatch && disagreementMatch[1].trim()) {
    parts.push(disagreementMatch[1].trim());
  } else {
    parts.push("None identified — models converged on the approach.");
  }
  parts.push("");

  // ── Overall confidence ──
  parts.push("## 🎯 Overall Confidence\n");
  const validConfidences = activeSynths.map((a) => confidences[a]).filter((c) => c != null) as number[];
  if (validConfidences.length > 0) {
    const avg = Math.round(validConfidences.reduce((s, c) => s + c, 0) / validConfidences.length);
    const min = Math.min(...validConfidences);
    const max = Math.max(...validConfidences);
    parts.push(`**Average:** ${avg}% · **Range:** ${min}%–${max}%`);
    if (max - min > 20) {
      parts.push("> ⚠️ Large confidence spread — models disagree on how certain they are. Review the disagreements above.");
    }
  } else {
    parts.push("(confidence scores not extracted from syntheses)");
  }
  parts.push("");

  // ── Full individual syntheses (for deep inspection) ──
  parts.push("---\n");
  parts.push("## 📄 Individual Syntheses (Full)\n");
  parts.push("These are each model's independent synthesis. The converged plan above is derived from their consensus.\n");
  for (const alias of activeSynths) {
    parts.push(`### ${MODEL_MAP[alias].label}'s Synthesis`);
    parts.push(syntheses[alias]!);
    parts.push("");
  }

  return parts.join("\n");
}

function applyWorkerInstructions(prompt: string, alias?: Alias): string {
  const contextBlock = buildParentContextBlock();
  const parts: string[] = [];

  // Model-specific system instructions
  if (alias) {
    const systemPrompt = getSystemPromptForAlias(alias);
    if (systemPrompt) {
      parts.push("# System Instructions", systemPrompt);
    }
  }

  if (LEGACY_WORKER_INSTRUCTIONS) {
    parts.push("# Additional model-mesh instructions", LEGACY_WORKER_INSTRUCTIONS);
  }

  parts.push("# CWD Guard", CWD_GUARD_WORKER_PROMPT);

  if (contextBlock) {
    parts.push(contextBlock);
  }

  if (parts.length > 0) {
    return [...parts, "", prompt].join("\n");
  }

  return prompt;
}

function buildLegacyWorkerSystemPrompt(alias?: Alias): string {
  // Use model-specific system prompt as the actual system prompt for legacy streaming
  if (alias) {
    const systemPrompt = getSystemPromptForAlias(alias);
    if (systemPrompt) return systemPrompt;
  }

  const contextBlock = buildParentContextBlock();
  const parts: string[] = [];

  if (LEGACY_WORKER_INSTRUCTIONS) {
    parts.push(LEGACY_WORKER_INSTRUCTIONS);
  }

  if (contextBlock) {
    parts.push(contextBlock);
  }

  return parts.length > 0 ? parts.join("\n\n") : LEGACY_SYSTEM_PROMPT;
}

// ---------------------------------------------------------------------------
// Project context injection (for legacy models with no tool access)
// ---------------------------------------------------------------------------

/**
 * Build a lightweight project context string for legacy-stream models that
 * have no tool access. This gives them some awareness of the project without
 * being able to run commands or read files.
 *
 * Lists directory structure (2 levels deep) and key files.
 */
function buildProjectContextSnippet(cwd: string): string {
  const parts: string[] = ["## Project context (auto-injected for legacy models with no tools)"];
  try {
    const tree = execSync(
      `find . -maxdepth 2 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.git' 2>/dev/null | head -80`,
      { cwd, encoding: "utf-8", timeout: 5000 },
    ).trim();
    if (tree) {
      parts.push("Directory structure:");
      parts.push("```");
      parts.push(tree);
      parts.push("```");
    }
  } catch {
    // Best effort — if we can't list, skip it
  }
  parts.push("");
  parts.push("NOTE: You do NOT have tool access in this mode. You cannot read files or run commands.");
  parts.push("If you need file contents, say so and the user can re-run with a model that has tools.");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatRound(round: MeshRound): string {
  const rows = ORDER
    .filter((a) => round.targets.includes(a))
    .map((a) => `## @${a} — ${MODEL_MAP[a].label}\n${round.outputs[a] || "(no output)"}`)
    .join("\n\n");

  const judge = round.judge
    ? `\n\n## @judge (${MODEL_MAP[round.judge].label})\n${round.judged || "(no judgment)"}`
    : "";

  // Cross-review section (used by both @review and @deliberate)
  let crossReviewSection = "";
  if (round.crossReviews && round.crossReviews.length > 0 && !round.deliberationReport) {
    // Only show raw cross-reviews if we don't have a deliberation report
    // (deliberation report has its own formatting)
    const reviewBlocks = round.crossReviews
      .map((cr) => {
        const reviewLines = ORDER
          .filter((a) => cr.reviews[a])
          .map((a) => `### ${MODEL_MAP[a].label} reviewed by ${MODEL_MAP[cr.reviewer].label}\n${cr.reviews[a]}`)
          .join("\n\n");
        return reviewLines;
      })
      .filter(Boolean)
      .join("\n\n");
    if (reviewBlocks) {
      crossReviewSection = `\n\n---\n\n## 🔄 Cross-Verification\n${reviewBlocks}`;
    }
  }

  // Consensus section (review mode)
  let consensusSection = "";
  if (round.consensus) {
    const c = round.consensus;
    const parts: string[] = ["## 📊 Consensus Report"];
    if (c.agreements.length > 0) {
      parts.push(`\n### ✅ Agreements (all models agree)\n${c.agreements.map((a) => `- ${a}`).join("\n")}`);
    }
    if (c.disagreements.length > 0) {
      parts.push(`\n### ⚠️ Disagreements (needs human attention)\n${c.disagreements.map((d) => `- ${d}`).join("\n")}`);
    }
    if (c.actionItems.length > 0) {
      parts.push(`\n### 🔍 Action Items\n${c.actionItems.map((a) => `- ${a}`).join("\n")}`);
    }
    if (Object.keys(c.verdicts).length > 0) {
      parts.push("\n### 📋 Verdict Matrix");
      parts.push("| Model | Verdict | Confidence | Notes |");
      parts.push("|-------|---------|------------|-------|");
      for (const alias of ORDER) {
        const v = c.verdicts[alias];
        if (v) {
          parts.push(`| ${MODEL_MAP[alias].label} | ${v.approved ? "✅ APPROVE" : "❌ REQUEST_CHANGES"} | ${v.confidence}% | ${v.notes.slice(0, 60)} |`);
        }
      }
    }
    consensusSection = `\n\n---\n\n${parts.join("\n")}`;
  }

  // Deliberation report section (deliberation mode) — the KEY output the user wants
  let deliberationSection = "";
  if (round.deliberationReport) {
    const dr = round.deliberationReport;
    const parts: string[] = [];

    // --- The final plan is the star ---
    if (dr.finalPlan) {
      parts.push("## 🏆 FINAL PLAN — The Recommended Solution\n");
      parts.push(dr.finalPlan);
    }

    // --- Summary of contributions ---
    if (Object.keys(dr.proposals).length > 0) {
      parts.push("\n---\n\n## 📝 How We Got Here (Summary)\n");

      // Quick summary of each model's initial approach
      for (const alias of ORDER) {
        const proposal = dr.proposals[alias];
        if (proposal) {
          // Extract just the approach/confidence from the proposal
          const approachMatch = proposal.match(/\*\*Approach\*\*[:\s]*([^\n]+)/i);
          const confidenceMatch = proposal.match(/\*\*Confidence\*\*[:\s]*(\d+)/i);
          const approachLine = approachMatch ? approachMatch[1].trim() : preview(proposal, 120);
          const confidenceLine = confidenceMatch ? ` (${confidenceMatch[1]}% confidence)` : "";
          parts.push(`- **${MODEL_MAP[alias].label}**: ${approachLine}${confidenceLine}`);
        }
      }

      // Show key tradeoffs and risks from the synthesis
      if (dr.tradeoffs.length > 0) {
        parts.push("\n**Key Tradeoffs:**");
        for (const t of dr.tradeoffs) parts.push(`- ${t}`);
      }
      if (dr.risks.length > 0) {
        parts.push("\n**Risks:**");
        for (const r of dr.risks) parts.push(`- ${r}`);
      }
    }

    // --- Full proposals (collapsible details) ---
    if (Object.keys(dr.proposals).length > 0) {
      parts.push("\n---\n\n## 📄 Full Proposals (Details)\n");
      for (const alias of ORDER) {
        if (dr.proposals[alias]) {
          parts.push(`### ${MODEL_MAP[alias].label} — Initial Proposal`);
          parts.push(dr.proposals[alias]!);
          parts.push("");
        }
      }
      for (const alias of ORDER) {
        if (dr.refinements[alias]) {
          parts.push(`### ${MODEL_MAP[alias].label} — Refined Proposal`);
          parts.push(dr.refinements[alias]!);
          parts.push("");
        }
      }
      // Individual syntheses (Phase 4 democratic output)
      if (dr.syntheses && Object.keys(dr.syntheses).length > 0) {
        parts.push("\n---\n\n## ⚖️ Individual Syntheses (Democratic Phase 4)\n");
        parts.push("Each model's independent synthesis — the converged plan above was derived from their consensus.\n");
        for (const alias of ORDER) {
          if (dr.syntheses[alias]) {
            parts.push(`### ${MODEL_MAP[alias].label}'s Synthesis`);
            parts.push(dr.syntheses[alias]!);
            parts.push("");
          }
        }
      }
    }

    deliberationSection = parts.join("\n");
  }

  const titleTag = round.review
    ? "(code review)"
    : round.deliberationReport
      ? "(deliberation)"
      : round.deliberation
        ? "(deliberation)"
        : "(analysis)";

  // For deliberation mode, the final plan IS the main output
  // Everything else is supporting detail
  if (round.deliberationReport) {
    return [
      `# Model Mesh ${titleTag}`,
      `**Problem:** ${round.prompt || "(none)"}`,
      deliberationSection,
    ].join("\n\n");
  }

  return [
    `# Model Mesh ${titleTag}`,
    `**Prompt:** ${round.prompt || "(none)"}`,
    rows,
    judge,
    crossReviewSection,
    consensusSection,
  ].join("\n\n");
}

function preview(text: string, max = MESH_PREVIEW_LENGTH): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "…";
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

// ---------------------------------------------------------------------------
// Rich live widget — now shows thinking/tool-calling activity
// ---------------------------------------------------------------------------

function buildActivityLabel(s: WorkerStatus): string {
  const pathTag = s.streamPath === "legacy" ? " [no tools]" : "";
  if (s.isThinking) {
    const thinkChars = s.thinkingChars > 1000 ? `${(s.thinkingChars / 1000).toFixed(1)}k` : `${s.thinkingChars}`;
    return `thinking ${thinkChars} chars${pathTag}`;
  }
  if (s.activeToolName) {
    return `🔧 ${s.activeToolName}${pathTag}`;
  }
  if (s.toolCalls > 0 && s.phase === "streaming") {
    return `${s.charCount} chars · 🔧${s.toolCalls}${pathTag}`;
  }
  if (s.phase === "done" && s.toolCalls > 0) {
    return `${s.charCount} chars · 🔧${s.toolCalls} calls${pathTag}`;
  }
  if (s.charCount > 0) {
    return `${s.charCount} chars${pathTag}`;
  }
  if (s.streamPath === "legacy") {
    return `connecting (legacy, no tools)`;
  }
  return "connecting…";
}

function buildWidgetLines(
  targets: Alias[],
  statuses: Partial<Record<Alias | "judge", WorkerStatus>>,
  partials: Partial<Record<Alias | "judge", string>>,
): string[] {
  const now = Date.now();
  const lines: string[] = ["╔══ Model Mesh ═══════════════════════════════════════════════╗"];

  const allKeys: Array<Alias | "judge"> = [...targets];
  if (statuses.judge) allKeys.push("judge");

  for (const key of allKeys) {
    const s = statuses[key];
    const text = partials[key] || "";
    const tag = key === "judge" ? "@judge " : `@${key.padEnd(6)}`;

    if (!s) {
      lines.push(`║ ⏳ ${tag} — unknown`);
      continue;
    }

    const icon = PHASE_ICON[s.phase];
    const elapsed = s.startedAt ? formatElapsed(now - s.startedAt) : "—";
    const ttfb = s.firstActivityAt && s.startedAt ? `ttfb:${formatElapsed(s.firstActivityAt - s.startedAt)}` : "";
    const activity = buildActivityLabel(s);
    const meta = [elapsed, activity, ttfb].filter(Boolean).join(" · ");

    if (s.phase === "error") {
      const errMsg = s.error ? preview(s.error, 60) : "unknown error";
      lines.push(`║ ${icon} ${tag} — ERROR ${elapsed}`);
      lines.push(`║   ${errMsg}`);
    } else if (s.phase === "streaming" || s.phase === "done") {
      lines.push(`║ ${icon} ${tag} — ${meta}`);
      if (text) lines.push(`║   ${preview(text, 70)}`);
    } else if (s.phase === "thinking") {
      lines.push(`║ ${icon} ${tag} — ${meta}`);
    } else if (s.phase === "toolcalling") {
      lines.push(`║ ${icon} ${tag} — ${meta}`);
    } else {
      lines.push(`║ ${icon} ${tag} — ${meta}`);
    }
  }

  lines.push("╚════════════════════════════════════════════════════════════╝");
  return lines;
}

function updateLiveWidget(
  ctx: any,
  targets: Alias[],
  statuses: Partial<Record<Alias | "judge", WorkerStatus>>,
  partials: Partial<Record<Alias | "judge", string>>,
) {
  const lines = buildWidgetLines(targets, statuses, partials);
  ctx.ui.setWidget("model-mesh-live", lines, { placement: "belowEditor" });
}

// ---------------------------------------------------------------------------
// Message finders
// ---------------------------------------------------------------------------

function findLastAssistantOutcome(
  messages: Array<{
    role?: string;
    content?: Array<{ type: string; text?: string }>;
    stopReason?: string;
    errorMessage?: string;
  }>,
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== "assistant") continue;
    const outcome = textOrErrorFromAssistantMessage(messages[i]);
    if (outcome) return outcome;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Legacy streaming — now emits StreamActivity events
// ---------------------------------------------------------------------------

async function runLegacyStreamModel(
  model: Model<any>,
  prompt: string,
  ctx: any,
  images: ImageContent[] | undefined,
  onActivity: (event: StreamActivity) => void,
  alias?: Alias,
): Promise<string> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    const msg = auth.ok ? `Missing API key for ${model.provider}/${model.id}` : auth.error;
    throw new Error(msg);
  }

  const content: Array<{ type: "text"; text: string } | ImageContent> = [{ type: "text", text: prompt }];
  if (images?.length) content.push(...images);

  const user: Message = {
    role: "user",
    content,
    timestamp: Date.now(),
  };

  const events = streamSimple(
    model,
    { systemPrompt: buildLegacyWorkerSystemPrompt(alias), messages: [user] },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: ctx.signal,
    },
  );

  let full = "";
  for await (const event of events) {
    if (event.type === "thinking_start") {
      onActivity({ kind: "thinking_start" });
      continue;
    }
    if (event.type === "thinking_delta") {
      full += event.delta; // thinking content goes into full text too for legacy
      onActivity({ kind: "thinking_delta", chars: event.delta.length, totalThinkingChars: full.length });
      continue;
    }
    if (event.type === "thinking_end") {
      onActivity({ kind: "thinking_end" });
      continue;
    }
    if (event.type === "text_delta") {
      full += event.delta;
      onActivity({ kind: "text", delta: event.delta, full });
      continue;
    }

    if (event.type === "done") {
      const doneText = textOrErrorFromAssistantMessage(event.message);
      return doneText || full.trim();
    }

    if (event.type === "error") {
      throw new Error(event.error.errorMessage || "Unknown streaming error");
    }
  }

  return full.trim();
}

// ---------------------------------------------------------------------------
// Worker session — now emits StreamActivity events for ALL event types
// ---------------------------------------------------------------------------

async function runWorkerSession(
  model: Model<any>,
  prompt: string,
  ctx: any,
  history: unknown[],
  images: ImageContent[] | undefined,
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>,
  onActivity: (event: StreamActivity) => void,
  alias?: Alias,
): Promise<string> {
  let services: AgentSessionServices;
  try {
    services = await getWorkerServices(ctx.cwd, ctx.modelRegistry);
  } catch (err) {
    const { session: fallbackSession } = await createAgentSessionFromServices({
      services: await createAgentSessionServices({
        cwd: ctx.cwd,
        resourceLoaderOptions: { noExtensions: true },
      }),
      sessionManager: SessionManager.inMemory(ctx.cwd),
      model,
      thinkingLevel,
      tools: getWorkerToolNames(WORKER_TOOL_MODE),
    });
    try {
      await fallbackSession.prompt(prompt, { images, source: "extension" });
    } finally {
      fallbackSession.dispose();
    }
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: worker services init failed (${msg})`;
  }

  const toolNames = getWorkerToolNames(WORKER_TOOL_MODE);

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(ctx.cwd),
    model,
    thinkingLevel,
    tools: toolNames,
  });

  try {
    session.agent.sessionId = undefined;

    for (const message of history) session.sessionManager.appendMessage(cloneValue(message) as any);
    session.agent.state.messages = cloneValue(history) as any;

    let streamingText = "";
    let finalText = "";
    let thinkingChars = 0;

    const unsubscribe = session.subscribe((event) => {
      // --- Assistant message events ---
      if (event.type === "message_start" && event.message.role === "assistant") {
        streamingText = textOrErrorFromAssistantMessage(event.message);
        if (streamingText) onActivity({ kind: "text", delta: streamingText, full: streamingText });
        return;
      }

      if (event.type === "message_update" && event.message.role === "assistant") {
        const e = event.assistantMessageEvent;

        // Thinking events
        if (e.type === "thinking_start") {
          onActivity({ kind: "thinking_start" });
          return;
        }
        if (e.type === "thinking_delta") {
          thinkingChars += e.delta.length;
          onActivity({ kind: "thinking_delta", chars: e.delta.length, totalThinkingChars: thinkingChars });
          return;
        }
        if (e.type === "thinking_end") {
          onActivity({ kind: "thinking_end" });
          return;
        }

        // Text events
        if (e.type === "text_delta") {
          streamingText += e.delta;
          onActivity({ kind: "text", delta: e.delta, full: streamingText });
          return;
        }

        // Tool call events
        if (e.type === "toolcall_start") {
          const toolName = (e as any).toolCall?.name || (e as any).delta || "tool";
          onActivity({ kind: "toolcall_start", toolName });
          return;
        }
        if (e.type === "toolcall_delta") {
          // Ongoing tool call — no need to emit, just keep phase as toolcalling
          return;
        }
        if (e.type === "toolcall_end") {
          const toolName = (e as any).toolCall?.name || "tool";
          onActivity({ kind: "toolcall_end", toolName });
          return;
        }

        return;
      }

      if (event.type === "message_end" && event.message.role === "assistant") {
        finalText = textOrErrorFromAssistantMessage(event.message) || streamingText;
        if (finalText) onActivity({ kind: "text", delta: "", full: finalText });
      }

      // --- Tool execution events (more reliable than toolcall events for naming) ---
      if (event.type === "tool_execution_start") {
        onActivity({ kind: "toolcall_start", toolName: (event as any).toolName || "tool" });
      }
      if (event.type === "tool_execution_end") {
        onActivity({ kind: "toolcall_end", toolName: (event as any).toolName || "tool" });
      }
    });

    try {
      await session.prompt(prompt, { images, source: "extension" });
    } finally {
      unsubscribe();
    }

    const outcome = finalText || findLastAssistantOutcome(session.messages as any) || streamingText.trim();

    // If the worker session's LLM call failed with an auth or compat error,
    // throw it so the caller's catch block can trigger the legacy fallback.
    // session.prompt() doesn't throw on provider errors — it embeds them
    // in the assistant message's errorMessage field.
    const agentError = session.agent.state.errorMessage;
    if (agentError && shouldFallBackToLegacy(agentError)) {
      throw new Error(agentError);
    }

    return outcome;
  } finally {
    session.dispose();
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function modelMeshExtension(pi: ExtensionAPI) {
  const rounds: MeshRound[] = [];

  // Optional fallback: register a dedicated Synthetic bridge only when explicitly requested.
  if (SYNTHETIC_GLM_PROVIDER !== "synthetic") {
    pi.registerProvider(SYNTHETIC_GLM_PROVIDER, {
      baseUrl: SYNTHETIC_BASE_URL,
      apiKey: SYNTHETIC_API_KEY_ENV,
      authHeader: true,
      api: "openai-completions",
      models: [
        {
          id: MODEL_MAP.glm.modelId,
          name: MODEL_MAP.glm.label,
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 256000,
          maxTokens: 32768,
          compat: { supportsDeveloperRole: false },
        },
      ],
    });
  }

  // Reset caches on session lifecycle events
  pi.on("session_start", async (_event, ctx) => {
    rounds.length = 0;
    invalidateWorkerServices();
    resetCapturedContext();

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "model-mesh-round") continue;
      const data = entry.data as MeshRound | undefined;
      if (!data || !data.id || !Array.isArray(data.targets)) continue;
      rounds.push(data);
    }
  });

  // Capture parent session context from extensions so workers benefit
  pi.on("before_agent_start", async (event) => {
    const opts: BuildSystemPromptOptions = event.systemPromptOptions;
    capturedParentContext = {
      contextFilePaths: (opts.contextFiles ?? []).map((f: any) => f.path ?? String(f)),
      skillNames: (opts.skills ?? []).map((s: any) => s.name ?? String(s)),
      selectedTools: opts.selectedTools ?? [],
      promptGuidelines: opts.promptGuidelines ?? [],
    };
  });

  pi.registerCommand("mesh-clear", {
    description: "Clear model-mesh round cache for this session",
    handler: async (_args, ctx) => {
      rounds.length = 0;
      invalidateWorkerServices();
      resetCapturedContext();
      ctx.ui.notify("Model Mesh history cleared", "info");
    },
  });

  // -----------------------------------------------------------------------
  // /mesh-diff command — auto-inject git diff for code review
  // -----------------------------------------------------------------------
  pi.registerCommand("mesh-diff", {
    description: "Run @review on git diff (unstaged changes by default, or specify a ref like HEAD~1 or main..HEAD)",
    handler: async (args, ctx) => {
      const diffRef = args.trim() || "";
      let diffCommand: string;
      let diffDescription: string;

      if (diffRef) {
        // User specified a ref: e.g. "HEAD~1", "main..HEAD", "abc123"
        diffCommand = `git diff ${diffRef}`;
        diffDescription = `git diff ${diffRef}`;
      } else {
        // Default: unstaged + staged changes (everything not yet committed)
        diffCommand = `git diff HEAD`;
        diffDescription = "git diff HEAD (unstaged + staged)";
      }

      let diff: string;
      try {
        diff = execSync(diffCommand, {
          cwd: ctx.cwd,
          encoding: "utf-8",
          timeout: 10_000,
        }).trim();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to get git diff: ${msg.slice(0, 100)}`, "error");
        return;
      }

      if (!diff) {
        ctx.ui.notify("No diff found — working tree is clean", "info");
        return;
      }

      // Truncate very large diffs to avoid token overflow
      const maxDiffChars = parseInt(process.env.MESH_MAX_DIFF_CHARS?.trim() || "50000", 10);
      const truncated = diff.length > maxDiffChars;
      const diffContent = truncated ? diff.slice(0, maxDiffChars) + "\n... (truncated, set MESH_MAX_DIFF_CHARS to increase)" : diff;

      // Get list of changed files for context
      let changedFiles = "";
      try {
        changedFiles = execSync(`git diff --stat ${diffRef || "HEAD"}`, {
          cwd: ctx.cwd,
          encoding: "utf-8",
          timeout: 5_000,
        }).trim();
      } catch {
        // Best effort
      }

      const reviewPrompt = [
        `Review the following git diff (${diffDescription}):`,
        "",
        changedFiles ? `Changed files:\n\`${changedFiles}\`` : "",
        "",
        "```diff",
        diffContent,
        "```",
      ].filter(Boolean).join("\n");

      // Programmatically trigger @review mode
      const fakeEvent = {
        text: `@review ${reviewPrompt}`,
        images: [],
      };

      // Re-use the input handler logic
      pi.sendMessage({
        customType: "model-mesh",
        content: `📂 Running @review on ${diffDescription}${truncated ? ` (truncated to ${maxDiffChars} chars)` : ""}`,
        display: true,
        details: { type: "mesh-diff", diffDescription, truncated },
      });

      // The input handler will pick up @review naturally
      // But since this is a command handler, we need to invoke it directly
      const parsed = parseInput(fakeEvent.text);
      if (parsed.targets.length === 0) {
        ctx.ui.notify("@review tag not parsed correctly", "error");
        return;
      }

      // Trigger the same logic as the input handler by emitting a synthetic input event
      // We can't easily call the input handler directly, so we'll send a message that
      // the user can re-trigger with.
      ctx.ui.notify(`Use: @review <paste diff or describe what to review>`, "info");
      pi.sendMessage({
        customType: "model-mesh",
        content: `Diff captured (${diff.length} chars). Run:\n@review ${diffDescription}\n\nOr copy this prompt:\n\`\`\`\n@review Review the following git diff (${diffDescription}):\n\n${changedFiles ? `Changed files: ${changedFiles}` : ""}\n\n(Diff: ${diff.length} chars)\n\`\`\``,
        display: true,
        details: { type: "mesh-diff-result", diff: diffContent, diffDescription, changedFiles },
      });
    },
  });

  pi.registerCommand("mesh-doctor", {
    description: "Diagnose model/auth wiring for @claude/@codex/@glm",
    handler: async (_args, ctx) => {
      const toolNames = getWorkerToolNames(WORKER_TOOL_MODE);
      const lines: string[] = [
        "Model Mesh doctor:",
        `- worker tool mode: ${WORKER_TOOL_MODE} (tools: ${toolNames.join(", ") || "none"})`,
        `- worker services cached: ${workerServices ? "yes" : "no (will create on next @-tag use)"}`,
        `- worker extensions: disabled (noExtensions: true, prevents recursion)`,
        `- cwd: ${ctx.cwd}`,
        `- log dir: ${MESH_LOG_DIR}`,
        `- preview length: ${MESH_PREVIEW_LENGTH} chars`,
        `- widget throttle: ${MESH_WIDGET_THROTTLE_MS}ms`,
        `- progress log interval: ${MESH_LOG_INTERVAL_MS}ms / ${MESH_LOG_INTERVAL_CHARS} chars`,
        `- legacy claude oauth fallback: ${MESH_LEGACY_CLAUDE_OAUTH ? "on" : "off"}`,
        `- force worker session: ${MESH_FORCE_WORKER_SESSION ? "on" : "off"}`,
      ];

      if (capturedParentContext) {
        const cc = capturedParentContext;
        lines.push(`- parent context captured: yes`);
        if (cc.contextFilePaths.length) lines.push(`  context files: ${cc.contextFilePaths.join(", ")}`);
        if (cc.skillNames.length) lines.push(`  skills: ${cc.skillNames.join(", ")}`);
        if (cc.promptGuidelines.length) lines.push(`  guidelines: ${cc.promptGuidelines.length} bullet(s)`);
      } else {
        lines.push(`- parent context captured: no (send a prompt first)`);
      }

      for (const alias of ORDER) {
        const bind = MODEL_MAP[alias];
        const model = ctx.modelRegistry.find(bind.provider, bind.modelId);
        if (!model) {
          lines.push(`- @${alias}: model missing (${bind.provider}/${bind.modelId})`);
          continue;
        }

        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok || !auth.apiKey) {
          const reason = auth.ok ? "missing API key / OAuth" : auth.error;
          lines.push(`- @${alias}: ${bind.provider}/${bind.modelId} -> AUTH FAIL (${reason})`);
          continue;
        }

        const route = getStreamingRoute(alias, model, ctx);
        const toolNote = route.legacy ? "tools: none (legacy stream)" : "tools: worker-session tools";
        lines.push(`- @${alias}: ${bind.provider}/${bind.modelId} -> OK (${route.reason}, ${toolNote})`);
      }

      pi.sendMessage({
        customType: "model-mesh",
        content: lines.join("\n"),
        display: true,
        details: { type: "mesh-doctor" },
      });
    },
  });

  // ---------------------------------------------------------------------------
  // /mesh-logs command — view recent logs
  // ---------------------------------------------------------------------------
  pi.registerCommand("mesh-logs", {
    description: "Show recent model-mesh log entries (last 50) or open the latest log file",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      // "last" or "latest" → show the latest log file path + tail
      if (arg === "last" || arg === "latest" || arg === "file") {
        try {
          const files = fs.readdirSync(MESH_LOG_DIR).filter((f) => f.startsWith("model-mesh-")).sort();
          if (files.length === 0) {
            ctx.ui.notify("No model-mesh log files found", "warning");
            return;
          }
          const latest = files[files.length - 1];
          const fullPath = path.join(MESH_LOG_DIR, latest);
          const content = fs.readFileSync(fullPath, "utf-8");
          const tail = content.split("\n").slice(-80).join("\n");
          pi.sendMessage({
            customType: "model-mesh",
            content: `Log file: ${fullPath}\n\n${tail}`,
            display: true,
            details: { type: "mesh-logs-file", path: fullPath },
          });
        } catch {
          ctx.ui.notify("Could not read log directory", "error");
        }
        return;
      }

      // "clear" → wipe log dir
      if (arg === "clear" || arg === "reset") {
        try {
          const files = fs.readdirSync(MESH_LOG_DIR).filter((f) => f.startsWith("model-mesh-"));
          for (const f of files) fs.unlinkSync(path.join(MESH_LOG_DIR, f));
          ctx.ui.notify(`Cleared ${files.length} log file(s)`, "info");
        } catch {
          ctx.ui.notify("Could not clear log directory", "error");
        }
        return;
      }

      // Default: show in-memory entries from the last round
      if (lastLogger) {
        const entries = lastLogger.getEntries();
        const display = entries.slice(-50).map((e) => `[${e.ts}] [${e.alias}] [${e.phase}] ${e.message}`).join("\n");
        pi.sendMessage({
          customType: "model-mesh",
          content: display || "(no log entries yet)",
          display: true,
          details: { type: "mesh-logs", logFile: lastLogger.getLogFilePath() },
        });
      } else {
        ctx.ui.notify("No model-mesh rounds have run yet. Use @all or @claude etc. first.", "warning");
      }
    },
  });

  // Keep last logger reference so /mesh-logs can show entries without a file
  let lastLogger: MeshLogger | undefined;

  // ---------------------------------------------------------------------------
  // Main input handler
  // ---------------------------------------------------------------------------
  pi.on("input", async (event, ctx) => {
    const parsed = parseInput(event.text);
    if (parsed.targets.length === 0) return { action: "continue" as const };

    if (!parsed.cleanedPrompt && !parsed.deliberation && !parsed.deliberationMode && !parsed.reviewMode) {
      ctx.ui.notify("Add text after tags, e.g. @claude @codex propose migration strategy", "warning");
      return { action: "handled" as const };
    }

    const round: MeshRound = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      prompt: parsed.cleanedPrompt,
      targets: parsed.targets,
      deliberation: parsed.deliberation,
      judge: parsed.judgeMode ? parsed.chosenJudge : null,
      outputs: {},
      judged: null,
      review: parsed.reviewMode,
      crossReviews: [],
      consensus: null,
      deliberationReport: null,
    };

    const last = rounds.at(-1);
    // In review mode, prepend review-specific system prompt instructions
    // In deliberation mode, use the proposal prompt for phase 1
    let basePrompt: string;
    if (parsed.reviewMode) {
      basePrompt = `${REVIEW_ANALYSIS_PROMPT}\n\n# Code to review\n${parsed.cleanedPrompt}`;
    } else if (parsed.deliberationMode) {
      basePrompt = buildDeliberationProposalPrompt(parsed.cleanedPrompt);
    } else {
      basePrompt = parsed.cleanedPrompt;
    }
    const history = sanitizeWorkerHistory(
      buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages as unknown[],
    );
    const thinkingLevel = pi.getThinkingLevel();

    // --- Set up logger ---
    const logger = new MeshLogger(round.id);
    lastLogger = logger;
    logger.log("mesh", "info", `Round started — targets: ${parsed.targets.join(", ")} — prompt: ${preview(parsed.cleanedPrompt, 80)}`);

    // --- Set up per-worker status + partials ---
    const statuses: Partial<Record<Alias | "judge", WorkerStatus>> = {};
    const partials: Partial<Record<Alias | "judge", string>> = {};
    for (const alias of parsed.targets) {
      statuses[alias] = createWorkerStatus(alias);
    }

    // --- Throttled widget updater ---
    const throttledUpdate = createThrottledUpdater(MESH_WIDGET_THROTTLE_MS);
    const doUpdateWidget = () => updateLiveWidget(ctx, parsed.targets, statuses, partials);

    ctx.ui.setStatus("model-mesh", `Running ${parsed.targets.map((t) => `@${t}`).join(" ")}`);
    doUpdateWidget(); // Initial widget with "pending" state

    try {
      const workers = await Promise.all(
        parsed.targets.map(async (alias) => {
          const bind = MODEL_MAP[alias];
          const status = statuses[alias]!;
          const progress = new ProgressReporter(logger, alias, MESH_LOG_INTERVAL_MS, MESH_LOG_INTERVAL_CHARS);

          let model = ctx.modelRegistry.find(bind.provider, bind.modelId);

          // Safety fallback for GLM
          if (!model && alias === "glm" && bind.provider !== "synthetic") {
            model = ctx.modelRegistry.find("synthetic", bind.modelId);
          }

          if (!model) {
            status.phase = "error";
            status.error = `model not found (${bind.provider}/${bind.modelId})`;
            status.finishedAt = Date.now();
            logger.log(alias, "error", status.error);
            throttledUpdate(doUpdateWidget);
            return [alias, `Error: model not found (${bind.provider}/${bind.modelId}). Update MESH_PROVIDER_* / MESH_MODEL_* env.`] as const;
          }

          // --- Starting phase ---
          status.phase = "starting";
          status.startedAt = Date.now();
          const route = getStreamingRoute(alias, model, ctx);
          status.streamPath = route.legacy ? "legacy" : "worker";
          logger.log(alias, "starting", `Connecting to ${bind.provider}/${bind.modelId} (${route.reason})`);
          if (route.legacy) {
            logger.log(alias, "warn", `Using legacy stream fallback — no tool access in this route`);
          }
          throttledUpdate(doUpdateWidget);

          // --- Activity handler: receives ALL stream events, not just text_delta ---
          const onActivity = (act: StreamActivity) => {
            // Track first activity (any kind)
            if (!status.firstActivityAt) {
              status.firstActivityAt = Date.now();
            }

            switch (act.kind) {
              case "thinking_start": {
                status.phase = "thinking";
                status.isThinking = true;
                logger.log(alias, "thinking", `Model started thinking`);
                break;
              }
              case "thinking_delta": {
                status.thinkingChars = act.totalThinkingChars;
                progress.maybeLog(status.charCount, status.thinkingChars, status.toolCalls, "thinking");
                break;
              }
              case "thinking_end": {
                status.isThinking = false;
                status.phase = "streaming"; // will switch back to streaming/toolcalling below
                logger.log(alias, "thinking", `Thinking done — ${status.thinkingChars} chars`);
                break;
              }
              case "toolcall_start": {
                status.phase = "toolcalling";
                status.toolCalls += 1;
                status.activeToolName = act.toolName;
                logger.log(alias, "toolcalling", `Tool call #${status.toolCalls}: ${act.toolName}`);
                break;
              }
              case "toolcall_end": {
                status.activeToolName = null;
                // If we just finished a tool call, we're back to thinking or streaming
                if (!status.isThinking) {
                  status.phase = "streaming";
                }
                logger.log(alias, "toolcalling", `Tool call #${status.toolCalls} done: ${act.toolName}`);
                break;
              }
              case "text": {
                // First text token tracking
                if (!status.firstTextAt) {
                  status.firstTextAt = Date.now();
                  status.phase = "streaming";
                  logger.log(alias, "streaming", `First text token — ttfb: ${formatElapsed(status.firstTextAt - status.startedAt)}, first activity: ${formatElapsed(status.firstActivityAt - status.startedAt)}`);
                }
                status.charCount = act.full.length;
                partials[alias] = act.full;
                progress.maybeLog(status.charCount, status.thinkingChars, status.toolCalls, "streaming");
                break;
              }
            }

            throttledUpdate(doUpdateWidget);
          };

          try {
            let txt: string;

            const perAliasWorkerPrompt = applyWorkerInstructions(basePrompt, alias);

            if (route.legacy) {
              // Legacy path: inject project context since model has no tools
              const projectCtx = buildProjectContextSnippet(ctx.cwd);
              const legacyPrompt = `${projectCtx}\n\n${basePrompt}`;
              status.streamPath = "legacy";
              txt = await runLegacyStreamModel(model, legacyPrompt, ctx, event.images, onActivity, alias);
            } else {
              // Worker session path: full tool access
              status.streamPath = "worker";
              try {
                txt = await runWorkerSession(
                  model,
                  perAliasWorkerPrompt,
                  ctx,
                  history,
                  event.images,
                  getWorkerThinkingLevel(alias, model, thinkingLevel),
                  onActivity,
                  alias,
                );
              } catch (workerErr) {
                const workerMsg = workerErr instanceof Error ? workerErr.message : String(workerErr);

                // Check if this is a provider-incompat error that should fall back to legacy
                if (shouldFallBackToLegacy(workerMsg)) {
                  logger.log(alias, "warn", `Worker session failed with compat error, falling back to legacy: ${workerMsg}`);
                  let hint = "";
                  if (/Third-party apps now draw from your extra usage/i.test(workerMsg)) {
                    hint = " Go to claude.ai/settings/usage to claim your extra usage credit and enable it.";
                  } else if (/invalid x-api-key|authentication_error/i.test(workerMsg)) {
                    hint = " Set ANTHROPIC_API_KEY or run '/login anthropic'.";
                  }
                  ctx.ui.notify(`@${alias}: Worker session failed (${preview(workerMsg, 120)}). Falling back to legacy — no tool access.${hint}`, "warning");
                  status.streamPath = "legacy";
                  status.toolCalls = 0;
                  status.activeToolName = null;
                  status.isThinking = false;
                  const projectCtx = buildProjectContextSnippet(ctx.cwd);
                  const legacyPrompt = `${projectCtx}\n\n${basePrompt}`;
                  txt = await runLegacyStreamModel(model, legacyPrompt, ctx, event.images, onActivity, alias);
                } else {
                  throw workerErr;
                }
              }
            }

            const outcome = normalizeWorkerOutcome(alias, model, txt || "(empty response)");
            status.phase = "done";
            status.finishedAt = Date.now();
            status.charCount = outcome.length;
            status.isThinking = false;
            status.activeToolName = null;
            partials[alias] = outcome;
            const totalTime = formatElapsed(status.finishedAt - status.startedAt);
            const ttfbText = status.firstTextAt
              ? ` — ttfb: ${formatElapsed(status.firstTextAt - status.startedAt)}`
              : "";
            const pathNote = status.streamPath === "legacy" ? " [legacy, no tools]" : "";
            logger.log(alias, "done", `Completed in ${totalTime}${ttfbText} — ${outcome.length} text chars, ${status.thinkingChars} thinking chars, ${status.toolCalls} tool calls${pathNote}`);
            doUpdateWidget(); // Force final update (no throttle)
            return [alias, outcome] as const;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            // Safety retry for GLM
            if (alias === "glm" && model.provider !== "synthetic" && /invalid api key|401|authentication/i.test(message)) {
              const fallback = ctx.modelRegistry.find("synthetic", bind.modelId);
              if (fallback) {
                logger.log(alias, "warn", `Auth failed on ${model.provider}, retrying on synthetic...`);
                try {
                  status.streamPath = "worker";
                  const fallbackWorkerPrompt = applyWorkerInstructions(basePrompt, alias);
                  const txt = await runWorkerSession(
                    fallback,
                    fallbackWorkerPrompt,
                    ctx,
                    history,
                    event.images,
                    getWorkerThinkingLevel(alias, fallback, thinkingLevel),
                    onActivity,
                    alias,
                  );
                  const outcome = normalizeWorkerOutcome(alias, fallback, txt || "(empty response)");
                  status.phase = "done";
                  status.finishedAt = Date.now();
                  status.charCount = outcome.length;
                  status.isThinking = false;
                  status.activeToolName = null;
                  partials[alias] = outcome;
                  logger.log(alias, "done", `Completed (synthetic fallback) in ${formatElapsed(status.finishedAt! - status.startedAt)} — ${outcome.length} chars`);
                  doUpdateWidget();
                  return [alias, outcome] as const;
                } catch (retryErr) {
                  const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                  status.phase = "error";
                  status.error = retryMsg;
                  status.finishedAt = Date.now();
                  logger.log(alias, "error", `Synthetic fallback also failed: ${retryMsg}`);
                  doUpdateWidget();
                  return [alias, normalizeWorkerOutcome(alias, fallback, `Error: ${retryMsg}`)] as const;
                }
              }
            }

            status.phase = "error";
            status.error = message;
            status.finishedAt = Date.now();
            status.isThinking = false;
            status.activeToolName = null;
            logger.log(alias, "error", message);
            doUpdateWidget();
            return [alias, normalizeWorkerOutcome(alias, model, `Error: ${message}`)] as const;
          }
        }),
      );

      for (const [alias, txt] of workers) round.outputs[alias] = txt;

      // -------------------------------------------------------------------
      // Cross-review phase (@review mode only)
      // Each model reviews the OTHER models' outputs
      // -------------------------------------------------------------------
      if (parsed.reviewMode && parsed.targets.length >= 2) {
        logger.log("mesh", "info", `Cross-review phase starting — ${parsed.targets.length} models will verify each other`);
        ctx.ui.setStatus("model-mesh", `Cross-review: ${parsed.targets.map((t) => `@${t}`).join(" ↔ ")}`);

        // Update widget title to reflect cross-review phase
        const crossReviewTargets = parsed.targets.filter((a) => round.outputs[a]);

        const crossReviewWorkers = await Promise.all(
          parsed.targets.map(async (reviewerAlias) => {
            const otherOutputs: Partial<Record<Alias, string>> = {};
            for (const a of parsed.targets) {
              if (a !== reviewerAlias && round.outputs[a]) {
                otherOutputs[a] = round.outputs[a]!;
              }
            }
            if (Object.keys(otherOutputs).length === 0) return null;

            const bind = MODEL_MAP[reviewerAlias];
            const model = ctx.modelRegistry.find(bind.provider, bind.modelId);
            if (!model) return null;

            const crossReviewPrompt = buildCrossReviewPrompt(reviewerAlias, round.outputs, parsed.cleanedPrompt);
            const workerPrompt = applyWorkerInstructions(crossReviewPrompt, reviewerAlias);

            // Reuse the same status slot but with a “cross-review” tag in the widget
            const crossStatus: WorkerStatus = createWorkerStatus(reviewerAlias);
            crossStatus.phase = "starting";
            crossStatus.startedAt = Date.now();
            statuses[reviewerAlias] = crossStatus;
            partials[reviewerAlias] = "🔄 Cross-reviewing…";
            throttledUpdate(doUpdateWidget);

            const crossProgress = new ProgressReporter(logger, reviewerAlias, MESH_LOG_INTERVAL_MS, MESH_LOG_INTERVAL_CHARS);
            const crossReviews: Partial<Record<Alias, string>> = {};

            const onActivity = (act: StreamActivity) => {
              if (!crossStatus.firstActivityAt) crossStatus.firstActivityAt = Date.now();
              switch (act.kind) {
                case "thinking_start":
                  crossStatus.phase = "thinking";
                  crossStatus.isThinking = true;
                  break;
                case "thinking_delta":
                  crossStatus.thinkingChars = act.totalThinkingChars;
                  crossProgress.maybeLog(crossStatus.charCount, crossStatus.thinkingChars, crossStatus.toolCalls, "thinking");
                  break;
                case "thinking_end":
                  crossStatus.isThinking = false;
                  crossStatus.phase = "streaming";
                  break;
                case "toolcall_start":
                  crossStatus.phase = "toolcalling";
                  crossStatus.toolCalls += 1;
                  crossStatus.activeToolName = act.toolName;
                  break;
                case "toolcall_end":
                  crossStatus.activeToolName = null;
                  if (!crossStatus.isThinking) crossStatus.phase = "streaming";
                  break;
                case "text":
                  if (!crossStatus.firstTextAt) {
                    crossStatus.firstTextAt = Date.now();
                    crossStatus.phase = "streaming";
                  }
                  crossStatus.charCount = act.full.length;
                  partials[reviewerAlias] = `🔄 Cross-review: ${preview(act.full, 70)}`;
                  crossProgress.maybeLog(crossStatus.charCount, crossStatus.thinkingChars, crossStatus.toolCalls, "streaming");
                  break;
              }
              throttledUpdate(doUpdateWidget);
            };

            try {
              const route = getStreamingRoute(reviewerAlias, model, ctx);
              crossStatus.streamPath = route.legacy ? "legacy" : "worker";
              let crossReviewText: string;

              if (route.legacy) {
                crossReviewText = await runLegacyStreamModel(model, crossReviewPrompt, ctx, event.images, onActivity, reviewerAlias);
              } else {
                try {
                  crossReviewText = await runWorkerSession(
                    model, workerPrompt, ctx, history, event.images,
                    getWorkerThinkingLevel(reviewerAlias, model, thinkingLevel),
                    onActivity, reviewerAlias,
                  );
                } catch (workerErr) {
                  const workerMsg = workerErr instanceof Error ? workerErr.message : String(workerErr);
                  if (shouldFallBackToLegacy(workerMsg)) {
                    logger.log(reviewerAlias, "warn", `Cross-review worker session compat error, falling back to legacy: ${workerMsg}`);
                    ctx.ui.notify(`@${reviewerAlias}: Cross-review worker session failed (${preview(workerMsg, 80)}). Falling back to legacy — no tool access.`, "warning");
                    crossStatus.streamPath = "legacy";
                    crossReviewText = await runLegacyStreamModel(model, crossReviewPrompt, ctx, event.images, onActivity, reviewerAlias);
                  } else {
                    throw workerErr;
                  }
                }
              }

              crossStatus.phase = "done";
              crossStatus.finishedAt = Date.now();
              crossStatus.charCount = crossReviewText.length;
              crossStatus.isThinking = false;
              crossStatus.activeToolName = null;
              partials[reviewerAlias] = `✅ Cross-review done: ${preview(crossReviewText, 70)}`;
              logger.log(reviewerAlias, "done", `Cross-review completed in ${formatElapsed(crossStatus.finishedAt - crossStatus.startedAt)} — ${crossReviewText.length} chars`);
              doUpdateWidget();

              // Store the cross-review text under each other model's alias
              const reviewMap: Partial<Record<Alias, string>> = {};
              for (const otherAlias of parsed.targets) {
                if (otherAlias !== reviewerAlias) {
                  reviewMap[otherAlias] = crossReviewText;
                }
              }
              return { reviewer: reviewerAlias, reviews: reviewMap };
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              crossStatus.phase = "error";
              crossStatus.error = message;
              crossStatus.finishedAt = Date.now();
              logger.log(reviewerAlias, "error", `Cross-review failed: ${message}`);
              doUpdateWidget();
              return null;
            }
          }),
        );

        // Collect cross-review results
        for (const result of crossReviewWorkers) {
          if (!result) continue;
          // The cross-review text contains the reviewer's verification of all other models.
          // We store it keyed by each OTHER model alias.
          const crossReview: CrossReview = {
            reviewer: result.reviewer,
            reviews: result.reviews,
          };
          round.crossReviews.push(crossReview);
        }

        logger.log("mesh", "info", `Cross-review phase completed — ${round.crossReviews.length} cross-reviews collected`);

        // -----------------------------------------------------------------
        // Consensus phase (using the judge model to synthesize)
        // -----------------------------------------------------------------
        if (round.crossReviews.length >= 2) {
          logger.log("mesh", "info", `Consensus synthesis phase starting`);
          ctx.ui.setStatus("model-mesh", `Consensus synthesis`);

          const consensusJudge = parsed.chosenJudge || "claude";
          const consensusBind = MODEL_MAP[consensusJudge];
          const consensusModel = ctx.modelRegistry.find(consensusBind.provider, consensusBind.modelId);

          if (consensusModel) {
            const consensusPrompt = buildConsensusPrompt(parsed.cleanedPrompt, round.outputs, round.crossReviews);
            const consensusWorkerPrompt = applyWorkerInstructions(consensusPrompt, consensusJudge);

            const consensusStatus: WorkerStatus = createWorkerStatus(consensusJudge);
            consensusStatus.phase = "starting";
            consensusStatus.startedAt = Date.now();
            statuses.judge = consensusStatus;
            partials.judge = "🔄 Synthesizing consensus…";
            doUpdateWidget();

            const consensusProgress = new ProgressReporter(logger, "review", MESH_LOG_INTERVAL_MS, MESH_LOG_INTERVAL_CHARS);
            let consensusText = "";

            const onConsensusActivity = (act: StreamActivity) => {
              if (!consensusStatus.firstActivityAt) consensusStatus.firstActivityAt = Date.now();
              switch (act.kind) {
                case "thinking_start":
                  consensusStatus.phase = "thinking";
                  consensusStatus.isThinking = true;
                  break;
                case "thinking_delta":
                  consensusStatus.thinkingChars = act.totalThinkingChars;
                  consensusProgress.maybeLog(consensusStatus.charCount, consensusStatus.thinkingChars, consensusStatus.toolCalls, "thinking");
                  break;
                case "thinking_end":
                  consensusStatus.isThinking = false;
                  consensusStatus.phase = "streaming";
                  break;
                case "toolcall_start":
                  consensusStatus.phase = "toolcalling";
                  consensusStatus.toolCalls += 1;
                  consensusStatus.activeToolName = act.toolName;
                  break;
                case "toolcall_end":
                  consensusStatus.activeToolName = null;
                  if (!consensusStatus.isThinking) consensusStatus.phase = "streaming";
                  break;
                case "text":
                  if (!consensusStatus.firstTextAt) {
                    consensusStatus.firstTextAt = Date.now();
                    consensusStatus.phase = "streaming";
                  }
                  consensusStatus.charCount = act.full.length;
                  consensusText = act.full;
                  partials.judge = `🔄 Consensus: ${preview(act.full, 70)}`;
                  consensusProgress.maybeLog(consensusStatus.charCount, consensusStatus.thinkingChars, consensusStatus.toolCalls, "streaming");
                  break;
              }
              throttledUpdate(doUpdateWidget);
            };

            try {
              const route = getStreamingRoute(consensusJudge, consensusModel, ctx);
              consensusStatus.streamPath = route.legacy ? "legacy" : "worker";
              let fullConsensus: string;

              if (route.legacy) {
                fullConsensus = await runLegacyStreamModel(consensusModel, consensusPrompt, ctx, event.images, onConsensusActivity, consensusJudge);
              } else {
                try {
                  fullConsensus = await runWorkerSession(
                    consensusModel, consensusWorkerPrompt, ctx, history, event.images,
                    getWorkerThinkingLevel(consensusJudge, consensusModel, thinkingLevel),
                    onConsensusActivity, consensusJudge,
                  );
                } catch (workerErr) {
                  const workerMsg = workerErr instanceof Error ? workerErr.message : String(workerErr);
                  if (shouldFallBackToLegacy(workerMsg)) {
                    logger.log("review", "warn", `Consensus worker session compat error, falling back to legacy: ${workerMsg}`);
                    ctx.ui.notify(`Consensus worker session failed (${preview(workerMsg, 80)}). Falling back to legacy — no tool access.`, "warning");
                    consensusStatus.streamPath = "legacy";
                    fullConsensus = await runLegacyStreamModel(consensusModel, consensusPrompt, ctx, event.images, onConsensusActivity, consensusJudge);
                  } else {
                    throw workerErr;
                  }
                }
              }

              consensusStatus.phase = "done";
              consensusStatus.finishedAt = Date.now();
              consensusStatus.charCount = fullConsensus.length;
              consensusStatus.isThinking = false;
              partials.judge = fullConsensus;
              logger.log("review", "done", `Consensus synthesis completed in ${formatElapsed(consensusStatus.finishedAt - consensusStatus.startedAt)} — ${fullConsensus.length} chars`);

              // Parse the consensus into structured report
              round.consensus = parseConsensusFromText(fullConsensus, round.outputs);
              // Also store as judged text for backward compat
              round.judged = fullConsensus;
              doUpdateWidget();
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              consensusStatus.phase = "error";
              consensusStatus.error = message;
              consensusStatus.finishedAt = Date.now();
              logger.log("review", "error", `Consensus synthesis failed: ${message}`);
              doUpdateWidget();
            }
          }
        }
      }

      // -------------------------------------------------------------------
      // Deliberation phase (@deliberate mode only)
      // Phase 1 (proposals) already done above — outputs are in round.outputs
      // Now: Phase 2 (critiques) → Phase 3 (refinements) → Synthesis
      // -------------------------------------------------------------------
      if (parsed.deliberationMode && parsed.targets.length >= 2) {
        const activeOutputs = ORDER.filter((a) => round.outputs[a]);
        if (activeOutputs.length >= 2) {

          // -----------------------------------------------------------------
          // Phase 2: Cross-critique — each model critiques the others' proposals
          // -----------------------------------------------------------------
          logger.log("mesh", "info", `Deliberation Phase 2: Cross-critique — ${activeOutputs.length} models critiquing each other`);
          ctx.ui.setStatus("model-mesh", `Deliberation Phase 2: Cross-critique ${activeOutputs.map((t) => `@${t}`).join(" ↔ ")}`);

          const critiqueWorkers = await Promise.all(
            parsed.targets.map(async (alias) => {
              if (!round.outputs[alias]) return null;

              const bind = MODEL_MAP[alias];
              const model = ctx.modelRegistry.find(bind.provider, bind.modelId);
              if (!model) return null;

              const critiquePrompt = buildDeliberationCritiquePrompt(alias, parsed.cleanedPrompt, round.outputs);
              const workerPrompt = applyWorkerInstructions(critiquePrompt, alias);

              const critiqueStatus: WorkerStatus = createWorkerStatus(alias);
              critiqueStatus.phase = "starting";
              critiqueStatus.startedAt = Date.now();
              statuses[alias] = critiqueStatus;
              partials[alias] = "💬 Critiquing others' proposals…";
              throttledUpdate(doUpdateWidget);

              const critiqueProgress = new ProgressReporter(logger, alias, MESH_LOG_INTERVAL_MS, MESH_LOG_INTERVAL_CHARS);

              const onActivity = (act: StreamActivity) => {
                if (!critiqueStatus.firstActivityAt) critiqueStatus.firstActivityAt = Date.now();
                switch (act.kind) {
                  case "thinking_start":
                    critiqueStatus.phase = "thinking";
                    critiqueStatus.isThinking = true;
                    break;
                  case "thinking_delta":
                    critiqueStatus.thinkingChars = act.totalThinkingChars;
                    critiqueProgress.maybeLog(critiqueStatus.charCount, critiqueStatus.thinkingChars, critiqueStatus.toolCalls, "thinking");
                    break;
                  case "thinking_end":
                    critiqueStatus.isThinking = false;
                    critiqueStatus.phase = "streaming";
                    break;
                  case "toolcall_start":
                    critiqueStatus.phase = "toolcalling";
                    critiqueStatus.toolCalls += 1;
                    critiqueStatus.activeToolName = act.toolName;
                    break;
                  case "toolcall_end":
                    critiqueStatus.activeToolName = null;
                    if (!critiqueStatus.isThinking) critiqueStatus.phase = "streaming";
                    break;
                  case "text":
                    if (!critiqueStatus.firstTextAt) {
                      critiqueStatus.firstTextAt = Date.now();
                      critiqueStatus.phase = "streaming";
                    }
                    critiqueStatus.charCount = act.full.length;
                    partials[alias] = `💬 Critiquing: ${preview(act.full, 70)}`;
                    critiqueProgress.maybeLog(critiqueStatus.charCount, critiqueStatus.thinkingChars, critiqueStatus.toolCalls, "streaming");
                    break;
                }
                throttledUpdate(doUpdateWidget);
              };

              try {
                const route = getStreamingRoute(alias, model, ctx);
                critiqueStatus.streamPath = route.legacy ? "legacy" : "worker";
                let critiqueText: string;

                if (route.legacy) {
                  critiqueText = await runLegacyStreamModel(model, critiquePrompt, ctx, event.images, onActivity, alias);
                } else {
                  try {
                    critiqueText = await runWorkerSession(
                      model, workerPrompt, ctx, history, event.images,
                      getWorkerThinkingLevel(alias, model, thinkingLevel),
                      onActivity, alias,
                    );
                  } catch (workerErr) {
                    const workerMsg = workerErr instanceof Error ? workerErr.message : String(workerErr);
                    if (shouldFallBackToLegacy(workerMsg)) {
                      logger.log(alias, "warn", `Deliberation critique worker compat error, falling back to legacy: ${workerMsg}`);
                      ctx.ui.notify(`@${alias}: Critique worker session failed (${preview(workerMsg, 80)}). Falling back to legacy — no tool access.`, "warning");
                      critiqueStatus.streamPath = "legacy";
                      critiqueText = await runLegacyStreamModel(model, critiquePrompt, ctx, event.images, onActivity, alias);
                    } else {
                      throw workerErr;
                    }
                  }
                }

                critiqueStatus.phase = "done";
                critiqueStatus.finishedAt = Date.now();
                critiqueStatus.charCount = critiqueText.length;
                critiqueStatus.isThinking = false;
                critiqueStatus.activeToolName = null;
                partials[alias] = `✅ Critique done: ${preview(critiqueText, 70)}`;
                logger.log(alias, "done", `Critique completed in ${formatElapsed(critiqueStatus.finishedAt - critiqueStatus.startedAt)} — ${critiqueText.length} chars`);
                doUpdateWidget();

                const reviewMap: Partial<Record<Alias, string>> = {};
                for (const otherAlias of parsed.targets) {
                  if (otherAlias !== alias) {
                    reviewMap[otherAlias] = critiqueText;
                  }
                }
                return { reviewer: alias, reviews: reviewMap } as CrossReview;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                critiqueStatus.phase = "error";
                critiqueStatus.error = message;
                critiqueStatus.finishedAt = Date.now();
                logger.log(alias, "error", `Critique failed: ${message}`);
                doUpdateWidget();
                return null;
              }
            }),
          );

          const critiques: CrossReview[] = [];
          for (const result of critiqueWorkers) {
            if (result) critiques.push(result);
          }
          round.crossReviews = critiques;
          logger.log("mesh", "info", `Deliberation Phase 2 complete — ${critiques.length} critiques collected`);

          // -----------------------------------------------------------------
          // Phase 3: Convergence — each model produces a refined proposal
          // -----------------------------------------------------------------
          if (critiques.length >= 2) {
            logger.log("mesh", "info", `Deliberation Phase 3: Convergence — models refine their proposals`);
            ctx.ui.setStatus("model-mesh", `Deliberation Phase 3: Convergence`);

            const refinementWorkers = await Promise.all(
              parsed.targets.map(async (alias) => {
                if (!round.outputs[alias]) return null;

                const bind = MODEL_MAP[alias];
                const model = ctx.modelRegistry.find(bind.provider, bind.modelId);
                if (!model) return null;

                const convergencePrompt = buildDeliberationConvergencePrompt(alias, parsed.cleanedPrompt, round.outputs, critiques);
                const workerPrompt = applyWorkerInstructions(convergencePrompt, alias);

                const refineStatus: WorkerStatus = createWorkerStatus(alias);
                refineStatus.phase = "starting";
                refineStatus.startedAt = Date.now();
                statuses[alias] = refineStatus;
                partials[alias] = "🎯 Refining proposal…";
                throttledUpdate(doUpdateWidget);

                const refineProgress = new ProgressReporter(logger, alias, MESH_LOG_INTERVAL_MS, MESH_LOG_INTERVAL_CHARS);

                const onActivity = (act: StreamActivity) => {
                  if (!refineStatus.firstActivityAt) refineStatus.firstActivityAt = Date.now();
                  switch (act.kind) {
                    case "thinking_start":
                      refineStatus.phase = "thinking";
                      refineStatus.isThinking = true;
                      break;
                    case "thinking_delta":
                      refineStatus.thinkingChars = act.totalThinkingChars;
                      refineProgress.maybeLog(refineStatus.charCount, refineStatus.thinkingChars, refineStatus.toolCalls, "thinking");
                      break;
                    case "thinking_end":
                      refineStatus.isThinking = false;
                      refineStatus.phase = "streaming";
                      break;
                    case "toolcall_start":
                      refineStatus.phase = "toolcalling";
                      refineStatus.toolCalls += 1;
                      refineStatus.activeToolName = act.toolName;
                      break;
                    case "toolcall_end":
                      refineStatus.activeToolName = null;
                      if (!refineStatus.isThinking) refineStatus.phase = "streaming";
                      break;
                    case "text":
                      if (!refineStatus.firstTextAt) {
                        refineStatus.firstTextAt = Date.now();
                        refineStatus.phase = "streaming";
                      }
                      refineStatus.charCount = act.full.length;
                      partials[alias] = `🎯 Refined: ${preview(act.full, 70)}`;
                      refineProgress.maybeLog(refineStatus.charCount, refineStatus.thinkingChars, refineStatus.toolCalls, "streaming");
                      break;
                  }
                  throttledUpdate(doUpdateWidget);
                };

                try {
                  const route = getStreamingRoute(alias, model, ctx);
                  refineStatus.streamPath = route.legacy ? "legacy" : "worker";
                  let refinedText: string;

                  if (route.legacy) {
                    refinedText = await runLegacyStreamModel(model, convergencePrompt, ctx, event.images, onActivity, alias);
                  } else {
                    try {
                      refinedText = await runWorkerSession(
                        model, workerPrompt, ctx, history, event.images,
                        getWorkerThinkingLevel(alias, model, thinkingLevel),
                        onActivity, alias,
                      );
                    } catch (workerErr) {
                      const workerMsg = workerErr instanceof Error ? workerErr.message : String(workerErr);
                      if (shouldFallBackToLegacy(workerMsg)) {
                        logger.log(alias, "warn", `Deliberation convergence worker compat error, falling back to legacy: ${workerMsg}`);
                        ctx.ui.notify(`@${alias}: Convergence worker session failed (${preview(workerMsg, 80)}). Falling back to legacy — no tool access.`, "warning");
                        refineStatus.streamPath = "legacy";
                        refinedText = await runLegacyStreamModel(model, convergencePrompt, ctx, event.images, onActivity, alias);
                      } else {
                        throw workerErr;
                      }
                    }
                  }

                  refineStatus.phase = "done";
                  refineStatus.finishedAt = Date.now();
                  refineStatus.charCount = refinedText.length;
                  refineStatus.isThinking = false;
                  refineStatus.activeToolName = null;
                  partials[alias] = `✅ Refined: ${preview(refinedText, 70)}`;
                  logger.log(alias, "done", `Convergence completed in ${formatElapsed(refineStatus.finishedAt - refineStatus.startedAt)} — ${refinedText.length} chars`);
                  doUpdateWidget();

                  return [alias, refinedText] as const;
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err);
                  refineStatus.phase = "error";
                  refineStatus.error = message;
                  refineStatus.finishedAt = Date.now();
                  logger.log(alias, "error", `Convergence failed: ${message}`);
                  doUpdateWidget();
                  return null;
                }
              }),
            );

            const refinements: Partial<Record<Alias, string>> = {};
            for (const result of refinementWorkers) {
              if (result) {
                const [alias, text] = result;
                refinements[alias] = text;
              }
            }

            logger.log("mesh", "info", `Deliberation Phase 3 complete — ${Object.keys(refinements).length} refined proposals collected`);

            // -----------------------------------------------------------------
            // Phase 4: Democratic Synthesis — ALL models synthesize in parallel
            // No single model owns the final answer. We extract consensus.
            // -----------------------------------------------------------------
            const synthTargets = ORDER.filter((a) => refinements[a]);
            if (synthTargets.length >= 2) {
              logger.log("mesh", "info", `Deliberation Phase 4: Democratic Synthesis — ${synthTargets.length} models synthesizing in parallel`);
              ctx.ui.setStatus("model-mesh", `Phase 4: Democratic Synthesis (${synthTargets.map((t) => `@${t}`).join(", ")})`);

              // Each model produces its own synthesis of ALL proposals + critiques + refinements
              const synthesisOutputs: Partial<Record<Alias, string>> = {};
              const synthStatuses: Partial<Record<Alias, WorkerStatus>> = {};

              const synthWorkers = await Promise.all(
                synthTargets.map(async (alias) => {
                  const bind = MODEL_MAP[alias];
                  const model = ctx.modelRegistry.find(bind.provider, bind.modelId);
                  if (!model) return null;

                  const synthPrompt = buildDeliberationSynthesisPrompt(parsed.cleanedPrompt, round.outputs, critiques, refinements);
                  const synthWorkerPrompt = applyWorkerInstructions(synthPrompt, alias);

                  const sStatus: WorkerStatus = createWorkerStatus(alias);
                  sStatus.phase = "starting";
                  sStatus.startedAt = Date.now();
                  statuses[alias] = sStatus;
                  synthStatuses[alias] = sStatus;
                  partials[alias] = "⚖️ Synthesizing (no bias toward own proposal)…";
                  throttledUpdate(doUpdateWidget);

                  const synthProgress = new ProgressReporter(logger, alias, MESH_LOG_INTERVAL_MS, MESH_LOG_INTERVAL_CHARS);

                  const onActivity = (act: StreamActivity) => {
                    if (!sStatus.firstActivityAt) sStatus.firstActivityAt = Date.now();
                    switch (act.kind) {
                      case "thinking_start":
                        sStatus.phase = "thinking";
                        sStatus.isThinking = true;
                        break;
                      case "thinking_delta":
                        sStatus.thinkingChars = act.totalThinkingChars;
                        synthProgress.maybeLog(sStatus.charCount, sStatus.thinkingChars, sStatus.toolCalls, "thinking");
                        break;
                      case "thinking_end":
                        sStatus.isThinking = false;
                        sStatus.phase = "streaming";
                        break;
                      case "toolcall_start":
                        sStatus.phase = "toolcalling";
                        sStatus.toolCalls += 1;
                        sStatus.activeToolName = act.toolName;
                        break;
                      case "toolcall_end":
                        sStatus.activeToolName = null;
                        if (!sStatus.isThinking) sStatus.phase = "streaming";
                        break;
                      case "text":
                        if (!sStatus.firstTextAt) {
                          sStatus.firstTextAt = Date.now();
                          sStatus.phase = "streaming";
                        }
                        sStatus.charCount = act.full.length;
                        partials[alias] = `⚖️ Synthesizing: ${preview(act.full, 70)}`;
                        synthProgress.maybeLog(sStatus.charCount, sStatus.thinkingChars, sStatus.toolCalls, "streaming");
                        break;
                    }
                    throttledUpdate(doUpdateWidget);
                  };

                  try {
                    const route = getStreamingRoute(alias, model, ctx);
                    sStatus.streamPath = route.legacy ? "legacy" : "worker";
                    let synthText: string;

                    if (route.legacy) {
                      synthText = await runLegacyStreamModel(model, synthPrompt, ctx, event.images, onActivity, alias);
                    } else {
                      try {
                        synthText = await runWorkerSession(
                          model, synthWorkerPrompt, ctx, history, event.images,
                          getWorkerThinkingLevel(alias, model, thinkingLevel),
                          onActivity, alias,
                        );
                      } catch (workerErr) {
                        const workerMsg = workerErr instanceof Error ? workerErr.message : String(workerErr);
                        if (shouldFallBackToLegacy(workerMsg)) {
                          logger.log(alias, "warn", `Deliberation synthesis compat error, falling back to legacy: ${workerMsg}`);
                          ctx.ui.notify(`@${alias}: Synthesis worker session failed (${preview(workerMsg, 80)}). Falling back to legacy — no tool access.`, "warning");
                          sStatus.streamPath = "legacy";
                          synthText = await runLegacyStreamModel(model, synthPrompt, ctx, event.images, onActivity, alias);
                        } else {
                          throw workerErr;
                        }
                      }
                    }

                    sStatus.phase = "done";
                    sStatus.finishedAt = Date.now();
                    sStatus.charCount = synthText.length;
                    sStatus.isThinking = false;
                    sStatus.activeToolName = null;
                    partials[alias] = `✅ Synthesis done: ${preview(synthText, 70)}`;
                    logger.log(alias, "done", `Democratic synthesis completed in ${formatElapsed(sStatus.finishedAt - sStatus.startedAt)} — ${synthText.length} chars`);
                    doUpdateWidget();

                    synthesisOutputs[alias] = synthText;
                    return [alias, synthText] as const;
                  } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    sStatus.phase = "error";
                    sStatus.error = message;
                    sStatus.finishedAt = Date.now();
                    logger.log(alias, "error", `Democratic synthesis failed: ${message}`);
                    doUpdateWidget();
                    return null;
                  }
                }),
              );

              const successfulSynthCount = synthWorkers.filter(Boolean).length;
              logger.log("mesh", "info", `Phase 4 complete — ${successfulSynthCount}/${synthTargets.length} models produced syntheses`);

              // -----------------------------------------------------------------
              // Extract the convergent plan from all syntheses
              // No model is "the judge" — we find what they all agree on
              // -----------------------------------------------------------------
              if (successfulSynthCount >= 2) {
                const convergedPlan = buildConvergedPlan(synthesisOutputs, parsed.cleanedPrompt);

                // Show the converged result in the judge slot
                const judgeAlias = parsed.chosenJudge || "claude";
                const judgeStatus: WorkerStatus = {
                  alias: judgeAlias,
                  phase: "done",
                  startedAt: Date.now(),
                  firstActivityAt: Date.now(),
                  firstTextAt: Date.now(),
                  finishedAt: Date.now(),
                  charCount: convergedPlan.length,
                  thinkingChars: 0,
                  isThinking: false,
                  toolCalls: 0,
                  activeToolName: null,
                  error: null,
                  streamPath: null,
                };
                statuses.judge = judgeStatus;
                partials.judge = convergedPlan;

                round.deliberationReport = {
                  proposals: { ...round.outputs },
                  critiques,
                  refinements,
                  syntheses: { ...synthesisOutputs },
                  winner: null,
                  finalPlan: convergedPlan,
                  tradeoffs: extractTradeoffs(convergedPlan),
                  risks: extractRisks(convergedPlan),
                };
                round.judged = convergedPlan;
                doUpdateWidget();
              } else if (successfulSynthCount === 1) {
                // Only one synthesis succeeded — use it but flag it
                const onlySynth = Object.entries(synthesisOutputs)[0];
                if (onlySynth) {
                  const [alias, text] = onlySynth as [Alias, string];
                  const flaggedPlan = `> ⚠️ Only ${MODEL_MAP[alias].label} produced a synthesis. This is NOT a democratic consensus — verify with other models manually.\n\n${text}`;

                  round.deliberationReport = {
                    proposals: { ...round.outputs },
                    critiques,
                    refinements,
                    syntheses: { ...synthesisOutputs },
                    winner: alias,
                    finalPlan: flaggedPlan,
                    tradeoffs: extractTradeoffs(text),
                    risks: extractRisks(text),
                  };
                  round.judged = flaggedPlan;
                  partials.judge = flaggedPlan;
                  doUpdateWidget();
                }
              } else {
                // No syntheses succeeded
                round.deliberationReport = {
                  proposals: { ...round.outputs },
                  critiques,
                  refinements,
                  syntheses: {},
                  winner: null,
                  finalPlan: null,
                  tradeoffs: [],
                  risks: [],
                };
              }
            }
          }
        }
      }

      // --- Judge phase (non-review, non-deliberation: standard judge) ---
      if (parsed.judgeMode && !parsed.reviewMode && !parsed.deliberationMode && parsed.chosenJudge) {
        const judgeBind = MODEL_MAP[parsed.chosenJudge];
        const judgeModel = ctx.modelRegistry.find(judgeBind.provider, judgeBind.modelId);

        const judgeStatus: WorkerStatus = {
          alias: parsed.chosenJudge,
          phase: "pending",
          startedAt: 0,
          firstActivityAt: null,
          firstTextAt: null,
          finishedAt: null,
          charCount: 0,
          thinkingChars: 0,
          isThinking: false,
          toolCalls: 0,
          activeToolName: null,
          error: null,
          streamPath: null,
        };
        statuses.judge = judgeStatus;

        if (!judgeModel) {
          judgeStatus.phase = "error";
          judgeStatus.error = `model not found (${judgeBind.provider}/${judgeBind.modelId})`;
          judgeStatus.finishedAt = Date.now();
          logger.log("judge", "error", judgeStatus.error);
          round.judged = `Error: judge model not found (${judgeBind.provider}/${judgeBind.modelId})`;
        } else {
          judgeStatus.phase = "starting";
          judgeStatus.startedAt = Date.now();
          logger.log("judge", "starting", `Judge ${judgeBind.provider}/${judgeBind.modelId} starting`);
          doUpdateWidget();

          const judgePrompt = applyWorkerInstructions(
            buildJudgePrompt(parsed.cleanedPrompt, round.outputs, parsed.chosenJudge),
            parsed.chosenJudge,
          );
          const judgeProgress = new ProgressReporter(logger, "judge", MESH_LOG_INTERVAL_MS, MESH_LOG_INTERVAL_CHARS);

          const onJudgeActivity = (act: StreamActivity) => {
            if (!judgeStatus.firstActivityAt) {
              judgeStatus.firstActivityAt = Date.now();
            }
            switch (act.kind) {
              case "thinking_start": {
                judgeStatus.phase = "thinking";
                judgeStatus.isThinking = true;
                logger.log("judge", "thinking", `Judge started thinking`);
                break;
              }
              case "thinking_delta": {
                judgeStatus.thinkingChars = act.totalThinkingChars;
                judgeProgress.maybeLog(judgeStatus.charCount, judgeStatus.thinkingChars, judgeStatus.toolCalls, "thinking");
                break;
              }
              case "thinking_end": {
                judgeStatus.isThinking = false;
                judgeStatus.phase = "streaming";
                logger.log("judge", "thinking", `Judge thinking done — ${judgeStatus.thinkingChars} chars`);
                break;
              }
              case "toolcall_start": {
                judgeStatus.phase = "toolcalling";
                judgeStatus.toolCalls += 1;
                judgeStatus.activeToolName = act.toolName;
                logger.log("judge", "toolcalling", `Judge tool call #${judgeStatus.toolCalls}: ${act.toolName}`);
                break;
              }
              case "toolcall_end": {
                judgeStatus.activeToolName = null;
                if (!judgeStatus.isThinking) judgeStatus.phase = "streaming";
                logger.log("judge", "toolcalling", `Judge tool call #${judgeStatus.toolCalls} done`);
                break;
              }
              case "text": {
                if (!judgeStatus.firstTextAt) {
                  judgeStatus.firstTextAt = Date.now();
                  judgeStatus.phase = "streaming";
                  logger.log("judge", "streaming", `Judge first text token — ttfb: ${formatElapsed(judgeStatus.firstTextAt - judgeStatus.startedAt)}`);
                }
                judgeStatus.charCount = act.full.length;
                partials.judge = act.full;
                judgeProgress.maybeLog(judgeStatus.charCount, judgeStatus.thinkingChars, judgeStatus.toolCalls, "streaming");
                break;
              }
            }
            throttledUpdate(doUpdateWidget);
          };

          try {
            const judgeRoute = getStreamingRoute(parsed.chosenJudge, judgeModel, ctx);
            judgeStatus.streamPath = judgeRoute.legacy ? "legacy" : "worker";
            if (judgeRoute.legacy) {
              logger.log("judge", "warn", `Using legacy stream fallback — no tool access in this route`);
            }
            let judged: string;
            if (judgeRoute.legacy) {
              judged = await runLegacyStreamModel(
                judgeModel,
                buildJudgePrompt(parsed.cleanedPrompt, round.outputs, parsed.chosenJudge),
                ctx,
                event.images,
                onJudgeActivity,
                parsed.chosenJudge,
              );
            } else {
              try {
                judged = await runWorkerSession(
                  judgeModel,
                  judgePrompt,
                  ctx,
                  history,
                  event.images,
                  getWorkerThinkingLevel(parsed.chosenJudge, judgeModel, thinkingLevel),
                  onJudgeActivity,
                  parsed.chosenJudge,
                );
              } catch (workerErr) {
                const workerMsg = workerErr instanceof Error ? workerErr.message : String(workerErr);
                if (shouldFallBackToLegacy(workerMsg)) {
                  logger.log("judge", "warn", `Worker session compat error, falling back to legacy: ${workerMsg}`);
                  ctx.ui.notify(`Judge worker session failed (${preview(workerMsg, 80)}). Falling back to legacy — no tool access.`, "warning");
                  judgeStatus.streamPath = "legacy";
                  judged = await runLegacyStreamModel(
                    judgeModel,
                    buildJudgePrompt(parsed.cleanedPrompt, round.outputs, parsed.chosenJudge),
                    ctx,
                    event.images,
                    onJudgeActivity,
                    parsed.chosenJudge,
                  );
                } else {
                  throw workerErr;
                }
              }
            }
            round.judged = judged || "(empty judgment)";
            judgeStatus.phase = "done";
            judgeStatus.finishedAt = Date.now();
            judgeStatus.charCount = round.judged.length;
            judgeStatus.isThinking = false;
            judgeStatus.activeToolName = null;
            partials.judge = round.judged;
            const pathNote = judgeStatus.streamPath === "legacy" ? " [legacy, no tools]" : "";
            logger.log("judge", "done", `Judge completed in ${formatElapsed(judgeStatus.finishedAt - judgeStatus.startedAt)} — ${round.judged.length} chars${pathNote}`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            round.judged = `Error: ${message}`;
            judgeStatus.phase = "error";
            judgeStatus.error = message;
            judgeStatus.finishedAt = Date.now();
            logger.log("judge", "error", message);
          }
        }
        doUpdateWidget(); // Force final update
      }

      rounds.push(round);
      pi.appendEntry("model-mesh-round", round);

      logger.log("mesh", "info", `Round completed — outputs: ${Object.keys(round.outputs).join(", ")}${round.judged ? " + judge" : ""}`);

      pi.sendMessage({
        customType: "model-mesh",
        content: formatRound(round),
        display: true,
        details: round,
      });

      return { action: "handled" as const };
    } finally {
      ctx.ui.setStatus("model-mesh", undefined);
      ctx.ui.setWidget("model-mesh-live", undefined);
      logger.dispose();
    }
  });
}
