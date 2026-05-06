// ---------------------------------------------------------------------------
// model-mesh — Multi-model orchestration extension for pi
// Entry point: exports the pi extension function
// ---------------------------------------------------------------------------

import { buildSessionContext, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// --- Types ---
import type { Alias, CrossReview, MeshRound, StreamActivity, WorkerStatus } from "./types.js";

// --- Config ---
import {
  MODEL_MAP,
  ORDER,
  WORKER_TOOL_MODE,
  getWorkerToolNames,
  MESH_LOG_DIR,
  MESH_PREVIEW_LENGTH,
  MESH_WIDGET_THROTTLE_MS,
  MESH_LOG_INTERVAL_MS,
  MESH_LOG_INTERVAL_CHARS,
  MESH_FORCE_WORKER_SESSION,
  MESH_LEGACY_CLAUDE_OAUTH,
  SYNTHETIC_GLM_PROVIDER,
  SYNTHETIC_BASE_URL,
  SYNTHETIC_API_KEY_ENV,
} from "./config.js";

// --- Prompts ---
import {
  REVIEW_ANALYSIS_PROMPT,
  buildDeliberationProposalPrompt,
  buildDeliberationCritiquePrompt,
  buildDeliberationConvergencePrompt,
  buildDeliberationSynthesisPrompt,
  buildJudgePrompt,
  buildCrossReviewPrompt,
  buildConsensusPrompt,
  applyWorkerInstructions,
} from "./prompts.js";

// --- Format ---
import {
  formatElapsed,
  preview,
  createWorkerStatus,
  createThrottledUpdater,
  type ThrottledUpdater,
  updateLiveWidget,
  formatRound,
  parseConsensusFromText,
  extractTradeoffs,
  extractRisks,
  buildConvergedPlan,
  markDone,
  markError,
} from "./format.js";

// --- Stream ---
import {
  MeshLogger,
  ProgressReporter,
  getWorkerThinkingLevel,
  normalizeWorkerOutcome,
  getStreamingRoute,
  invalidateWorkerServices,
  invalidateProjectContextCache,
  resetCapturedContext,
  buildParentContextBlock,
  captureParentContext,
  getCapturedParentContext,
  createActivityHandler,
  runModelWithFallback,
  sanitizeWorkerHistory,
  cloneValue,
  buildProjectContextSnippet,
} from "./stream.js";

// ---------------------------------------------------------------------------
// Input parser (stays here — small and tightly coupled with extension)
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

  const reviewMode = found.has("review");
  const deliberationMode = found.has("deliberate") || found.has("debate") || /\bdeliberat(e|ion|ing)\b/i.test(text);
  const hasAll = found.has("all") || reviewMode || deliberationMode;
  const aliases = ORDER.filter((a) => found.has(a));

  const judgeToken = Array.from(found).find((t) => t.startsWith("judge"));
  const judgeMode = Boolean(judgeToken) || reviewMode || deliberationMode;

  let chosenJudge: Alias | null = null;
  const judgeInline = judgeToken?.match(/^judge[:_-](claude|codex|glm)$/i);
  if (judgeInline) {
    chosenJudge = judgeInline[1].toLowerCase() as Alias;
  }

  let targets = hasAll ? [...ORDER] : aliases;
  if (targets.length === 0 && (judgeMode || reviewMode || deliberationMode)) targets = [...ORDER];

  if (!chosenJudge && judgeMode) {
    const explicitJudgeInText = text.match(/\bjudge\s*[=:]\s*(claude|codex|glm)\b/i);
    if (explicitJudgeInText) chosenJudge = explicitJudgeInText[1].toLowerCase() as Alias;
  }

  if (!chosenJudge && judgeMode) chosenJudge = "claude";

  const cleanedPrompt = stripTags(text)
    .replace(/\b(review|deliberat(e|ion|ing)|debate)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return { targets, cleanedPrompt, deliberation: deliberationMode, judgeMode, chosenJudge, reviewMode, deliberationMode };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CUSTOM_TYPE = "model-mesh";
const ROUND_TYPE = "model-mesh-round";
const LOG_PREFIX = "model-mesh-";

// ---------------------------------------------------------------------------
// Helper: run one model worker with status tracking + legacy project context
// ---------------------------------------------------------------------------

async function runWorker(
  alias: Alias,
  basePrompt: string,
  ctx: any,
  event: { images?: any[] },
  history: unknown[],
  thinkingLevel: any,
  logger: MeshLogger,
  statuses: Partial<Record<Alias | "judge", WorkerStatus>>,
  partials: Partial<Record<Alias | "judge", string>>,
  throttledUpdate: ThrottledUpdater,
  doUpdateWidget: () => void,
  partialFormatter?: (full: string) => string,
  signal?: AbortSignal,
): Promise<[Alias, string]> {
  const bind = MODEL_MAP[alias];
  const status = statuses[alias]!;
  const progress = new ProgressReporter(logger, alias, MESH_LOG_INTERVAL_MS, MESH_LOG_INTERVAL_CHARS);

  let model = ctx.modelRegistry.find(bind.provider, bind.modelId);

  // Safety fallback for GLM
  if (!model && alias === "glm" && bind.provider !== "synthetic") {
    model = ctx.modelRegistry.find("synthetic", bind.modelId);
  }

  if (!model) {
    markError(status, `model not found (${bind.provider}/${bind.modelId})`);
    logger.log(alias, "error", status.error!);
    throttledUpdate(doUpdateWidget);
    return [alias, `Error: model not found (${bind.provider}/${bind.modelId}). Update MESH_PROVIDER_* / MESH_MODEL_* env.`];
  }

  // Starting phase
  status.phase = "starting";
  status.startedAt = Date.now();
  const route = getStreamingRoute(alias, model, ctx);
  status.streamPath = route.legacy ? "legacy" : "worker";
  logger.log(alias, "starting", `Connecting to ${bind.provider}/${bind.modelId} (${route.reason})`);
  if (route.legacy) logger.log(alias, "warn", `Using legacy stream fallback — no tool access in this route`);
  throttledUpdate(doUpdateWidget);

  const onActivity = createActivityHandler({
    status,
    partials,
    alias,
    progress,
    logger,
    partialFormatter,
    logFirstText: true,
  });

  try {
    const perAliasWorkerPrompt = applyWorkerInstructions(basePrompt, alias, buildParentContextBlock);
    const legacyPrompt = `${buildProjectContextSnippet(ctx.cwd)}\n\n${basePrompt}`;

    const txt = await runModelWithFallback(
      alias, model, legacyPrompt, perAliasWorkerPrompt, ctx, history, event.images,
      getWorkerThinkingLevel(alias, model, thinkingLevel), onActivity, status, logger,
      (workerMsg) => {
        let hint = "";
        if (/Third-party apps now draw from your extra usage/i.test(workerMsg)) {
          hint = " Go to claude.ai/settings/usage to claim your extra usage credit and enable it.";
        } else if (/invalid x-api-key|authentication_error/i.test(workerMsg)) {
          hint = " Set ANTHROPIC_API_KEY or run '/login anthropic'.";
        }
        if (ctx.hasUI) ctx.ui.notify(`@${alias}: Worker session failed (${preview(workerMsg, 120)}). Falling back to legacy — no tool access.${hint}`, "warning");
      },
      signal,
    );

    const outcome = normalizeWorkerOutcome(alias, model, txt || "(empty response)");
    markDone(status, outcome.length, partials, alias, outcome);
    const totalTime = formatElapsed((status.finishedAt ?? Date.now()) - status.startedAt);
    const ttfbText = status.firstTextAt ? ` — ttfb: ${formatElapsed(status.firstTextAt - status.startedAt)}` : "";
    const pathNote = status.streamPath === "legacy" ? " [legacy, no tools]" : "";
    logger.log(alias, "done", `Completed in ${totalTime}${ttfbText} — ${outcome.length} text chars, ${status.thinkingChars} thinking chars, ${status.toolCalls} tool calls${pathNote}`);
    doUpdateWidget();
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
          const fallbackWorkerPrompt = applyWorkerInstructions(basePrompt, alias, buildParentContextBlock);
          const onRetryActivity = createActivityHandler({ status, partials, alias, progress, logger, partialFormatter });
          const txt = await runModelWithFallback(alias, fallback, basePrompt, fallbackWorkerPrompt, ctx, history, event.images, getWorkerThinkingLevel(alias, fallback, thinkingLevel), onRetryActivity, status, logger, undefined, signal);
          const outcome = normalizeWorkerOutcome(alias, fallback, txt || "(empty response)");
          markDone(status, outcome.length, partials, alias, outcome);
          logger.log(alias, "done", `Completed (synthetic fallback) in ${formatElapsed(status.finishedAt! - status.startedAt)} — ${outcome.length} chars`);
          doUpdateWidget();
          return [alias, outcome] as const;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          markError(status, retryMsg);
          logger.log(alias, "error", `Synthetic fallback also failed: ${retryMsg}`);
          doUpdateWidget();
          return [alias, normalizeWorkerOutcome(alias, fallback, `Error: ${retryMsg}`)] as const;
        }
      }
    }

    markError(status, message);
    logger.log(alias, "error", message);
    doUpdateWidget();
    return [alias, normalizeWorkerOutcome(alias, model, `Error: ${message}`)] as const;
  }
}

// ---------------------------------------------------------------------------
// Helper: run a cross-review / critique / refinement / synthesis phase worker
// ---------------------------------------------------------------------------

async function runPhaseWorker(
  alias: Alias,
  phasePrompt: string,
  phaseEmoji: string,
  ctx: any,
  event: { images?: any[] },
  history: unknown[],
  thinkingLevel: any,
  logger: MeshLogger,
  statuses: Partial<Record<Alias | "judge", WorkerStatus>>,
  partials: Partial<Record<Alias | "judge", string>>,
  throttledUpdate: ThrottledUpdater,
  doUpdateWidget: () => void,
  signal?: AbortSignal,
): Promise<string | null> {
  const bind = MODEL_MAP[alias];
  const model = ctx.modelRegistry.find(bind.provider, bind.modelId);
  if (!model) return null;

  const workerPrompt = applyWorkerInstructions(phasePrompt, alias, buildParentContextBlock);

  const phaseStatus: WorkerStatus = createWorkerStatus(alias);
  phaseStatus.phase = "starting";
  phaseStatus.startedAt = Date.now();
  statuses[alias] = phaseStatus;
  partials[alias] = `${phaseEmoji} Working…`;
  throttledUpdate(doUpdateWidget);

  const phaseProgress = new ProgressReporter(logger, alias, MESH_LOG_INTERVAL_MS, MESH_LOG_INTERVAL_CHARS);

  const onActivity = createActivityHandler({
    status: phaseStatus,
    partials,
    alias,
    progress: phaseProgress,
    logger,
    partialFormatter: (full) => `${phaseEmoji} ${preview(full, 70)}`,
    logFirstText: false,
  });

  try {
    const txt = await runModelWithFallback(
      alias, model, phasePrompt, workerPrompt, ctx, history, event.images,
      getWorkerThinkingLevel(alias, model, thinkingLevel), onActivity, phaseStatus, logger,
      undefined, signal,
    );

    // Handle legacy fallback notification
    if (phaseStatus.streamPath === "legacy" && ctx.hasUI) {
      ctx.ui.notify(`@${alias}: Phase worker using legacy — no tool access.`, "warning");
    }

    phaseStatus.phase = "done";
    phaseStatus.finishedAt = Date.now();
    phaseStatus.charCount = txt.length;
    phaseStatus.isThinking = false;
    phaseStatus.activeToolName = null;
    partials[alias] = `${phaseEmoji} Done: ${preview(txt, 70)}`;
    logger.log(alias, "done", `Phase completed in ${formatElapsed(phaseStatus.finishedAt - phaseStatus.startedAt)} — ${txt.length} chars`);
    doUpdateWidget();
    return txt;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    phaseStatus.phase = "error";
    phaseStatus.error = message;
    phaseStatus.finishedAt = Date.now();
    logger.log(alias, "error", `Phase failed: ${message}`);
    doUpdateWidget();
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: run the consensus/judge synthesis worker
// ---------------------------------------------------------------------------

async function runSynthesisWorker(
  judgeAlias: Alias | "judge",
  actualAlias: Alias,
  synthesisPrompt: string,
  phaseEmoji: string,
  ctx: any,
  event: { images?: any[] },
  history: unknown[],
  thinkingLevel: any,
  logger: MeshLogger,
  statuses: Partial<Record<Alias | "judge", WorkerStatus>>,
  partials: Partial<Record<Alias | "judge", string>>,
  throttledUpdate: ThrottledUpdater,
  doUpdateWidget: () => void,
  signal?: AbortSignal,
): Promise<string | null> {
  const bind = MODEL_MAP[actualAlias];
  const model = ctx.modelRegistry.find(bind.provider, bind.modelId);
  if (!model) return null;

  const workerPrompt = applyWorkerInstructions(synthesisPrompt, actualAlias, buildParentContextBlock);

  const synthStatus: WorkerStatus = createWorkerStatus(actualAlias);
  synthStatus.phase = "starting";
  synthStatus.startedAt = Date.now();
  statuses[judgeAlias] = synthStatus;
  partials[judgeAlias] = `${phaseEmoji} Synthesizing…`;
  doUpdateWidget();

  const synthProgress = new ProgressReporter(logger, "review", MESH_LOG_INTERVAL_MS, MESH_LOG_INTERVAL_CHARS);
  let synthText = "";

  const onActivity = createActivityHandler({
    status: synthStatus,
    partials,
    alias: judgeAlias,
    progress: synthProgress,
    logger,
    partialFormatter: (full) => {
      synthText = full;
      return `${phaseEmoji} ${preview(full, 70)}`;
    },
    logFirstText: false,
  });

  try {
    const fullText = await runModelWithFallback(
      actualAlias, model, synthesisPrompt, workerPrompt, ctx, history, event.images,
      getWorkerThinkingLevel(actualAlias, model, thinkingLevel), onActivity, synthStatus, logger,
      undefined, signal,
    );

    synthStatus.phase = "done";
    synthStatus.finishedAt = Date.now();
    synthStatus.charCount = fullText.length;
    synthStatus.isThinking = false;
    partials[judgeAlias] = fullText;
    logger.log("review", "done", `Synthesis completed in ${formatElapsed(synthStatus.finishedAt - synthStatus.startedAt)} — ${fullText.length} chars`);
    doUpdateWidget();
    return fullText;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    synthStatus.phase = "error";
    synthStatus.error = message;
    synthStatus.finishedAt = Date.now();
    logger.log("review", "error", `Synthesis failed: ${message}`);
    doUpdateWidget();
    return null;
  }
}

// ===========================================================================
// Extension entry point
// ===========================================================================

export default function modelMeshExtension(pi: ExtensionAPI) {
  const rounds: MeshRound[] = [];

  // Optional fallback: register a dedicated Synthetic bridge
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

  // -----------------------------------------------------------------------
  // Tag descriptions (shared by autocomplete + help)
  // -----------------------------------------------------------------------

  const TAG_DESCRIPTIONS: Record<string, string> = {
    claude: "Route to Claude",
    codex: "Route to Codex",
    glm: "Route to GLM via Synthetic",
    all: "Route to every model",
    review: "Full review mode: all models + cross-verification + consensus",
    judge: "After all models respond, one synthesizes a final decision",
    "judge:claude": "Use Claude as the judge",
    "judge:codex": "Use Codex as the judge",
    "judge:glm": "Use GLM as the judge",
    deliberate: "Full deliberation: proposals → cross-critique → convergence → plan",
    debate: "Alias for @deliberate",
  };

  // -----------------------------------------------------------------------
  // Custom message renderer for themed, collapsible output
  // -----------------------------------------------------------------------

  pi.registerMessageRenderer(CUSTOM_TYPE, (message, { expanded }, theme) => {
    const detailType = (message.details as any)?.type;
    const contentText = typeof message.content === "string" ? message.content : JSON.stringify(message.content);

    // Diagnostic outputs (doctor, logs, diff)
    if (detailType === "mesh-doctor" || detailType === "mesh-logs" ||
        detailType === "mesh-logs-file" || detailType === "mesh-diff-result") {
      const header = theme.fg("accent", "[model-mesh]");
      return new Text(`${header} ${contentText}`, 0, 0);
    }

    // Round results
    const round = message.details as MeshRound | undefined;
    if (round?.targets) {
      if (!expanded) {
        const tagList = round.targets.map((t) => theme.fg("accent", `@${t}`)).join(", ");
        const modeTag = round.review
          ? theme.fg("warning", " (review)")
          : round.deliberationReport
            ? theme.fg("accent", " (deliberation)")
            : "";
        const judgeTag = round.judged ? theme.fg("success", " · ✓ judged") : "";
        const outputCount = Object.keys(round.outputs).length;
        const lines = [
          theme.bold(theme.fg("accent", "Model Mesh")) + modeTag,
          `${tagList}${judgeTag}`,
          theme.fg("dim", `${outputCount} model(s) responded · Ctrl+O to expand`),
        ];
        return new Text(lines.join("\n"), 0, 0);
      }

      // Expanded: full output with accent theming on key patterns
      let content = contentText;
      content = content.replace(/^# Model Mesh(.*)$/gm, (_, rest: string) =>
        theme.bold(theme.fg("accent", `# Model Mesh${rest}`)));
      content = content.replace(/@claude/g, theme.fg("accent", "@claude"));
      content = content.replace(/@codex/g, theme.fg("accent", "@codex"));
      content = content.replace(/@glm/g, theme.fg("accent", "@glm"));
      content = content.replace(/\bAPPROVE\b/g, theme.fg("success", "APPROVE"));
      content = content.replace(/\bREQUEST_CHANGES\b/g, theme.fg("warning", "REQUEST_CHANGES"));
      content = content.replace(/\bNEEDS_DISCUSSION\b/g, theme.fg("error", "NEEDS_DISCUSSION"));
      content = content.replace(/\bMERGE\b/g, theme.fg("success", "MERGE"));
      content = content.replace(/\bFIX_FIRST\b/g, theme.fg("warning", "FIX_FIRST"));
      content = content.replace(/\bMAJOR_REWORK\b/g, theme.fg("error", "MAJOR_REWORK"));
      return new Text(content, 0, 0);
    }

    // Fallback
    return new Text(theme.fg("muted", contentText), 0, 0);
  });

  // -----------------------------------------------------------------------
  // Autocomplete for @-tags
  // -----------------------------------------------------------------------

  const MESH_TAG_KEYS = Object.keys(TAG_DESCRIPTIONS);

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

    // Autocomplete for @mesh tags
    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);
        const match = beforeCursor.match(/(?:^|[ \t])@([a-zA-Z:]*)$/);
        if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);
        const prefix = match[1] ?? "";
        const matching = MESH_TAG_KEYS.filter((t) => t.startsWith(prefix.toLowerCase()));
        if (matching.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
        return {
          prefix: `@${prefix}`,
          items: matching.map((t) => ({
            value: `@${t}`,
            label: `@${t}`,
            description: TAG_DESCRIPTIONS[t] || "",
          })),
        };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });

  // Capture parent session context from extensions
  pi.on("before_agent_start", async (event) => {
    captureParentContext(event.systemPromptOptions);
  });

  // -----------------------------------------------------------------------
  // Session shutdown cleanup
  // -----------------------------------------------------------------------

  pi.on("session_shutdown", async () => {
    invalidateWorkerServices();
    invalidateProjectContextCache();
    resetCapturedContext();
    currentRoundAbort?.abort();
    lastLogger?.dispose();
  });

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  pi.registerCommand("mesh-abort", {
    description: "Abort the currently running model-mesh round",
    handler: async (_args, ctx) => {
      if (currentRoundAbort && !currentRoundAbort.signal.aborted) {
        currentRoundAbort.abort();
        ctx.ui.notify("Model Mesh round aborted", "warning");
      } else {
        ctx.ui.notify("No active mesh round to abort", "info");
      }
    },
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

  // /mesh-diff — auto-inject git diff for code review
  pi.registerCommand("mesh-diff", {
    description: "Run @review on git diff (unstaged changes by default, or specify a ref like HEAD~1 or main..HEAD)",
    getArgumentCompletions: (prefix) => {
      const refs = ["HEAD", "HEAD~1", "HEAD~2", "main", "main..HEAD", "master", "develop"];
      const filtered = refs.filter((r) => r.toLowerCase().startsWith(prefix.toLowerCase()));
      return filtered.length > 0 ? filtered.map((r) => ({ value: r, label: r })) : null;
    },
    handler: async (args, ctx) => {
      const diffRef = args.trim() || "";
      let diffCommand: string;
      let diffDescription: string;

      if (diffRef) {
        diffCommand = `git diff ${diffRef}`;
        diffDescription = `git diff ${diffRef}`;
      } else {
        diffCommand = `git diff HEAD`;
        diffDescription = "git diff HEAD (unstaged + staged)";
      }

      let diff: string;
      try {
        diff = execSync(diffCommand, { cwd: ctx.cwd, encoding: "utf-8", timeout: 10_000 }).trim();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to get git diff: ${msg.slice(0, 100)}`, "error");
        return;
      }

      if (!diff) {
        ctx.ui.notify("No diff found — working tree is clean", "info");
        return;
      }

      const maxDiffChars = parseInt(process.env.MESH_MAX_DIFF_CHARS?.trim() || "50000", 10);
      const truncated = diff.length > maxDiffChars;
      const diffContent = truncated ? diff.slice(0, maxDiffChars) + "\n... (truncated, set MESH_MAX_DIFF_CHARS to increase)" : diff;

      let changedFiles = "";
      try {
        changedFiles = execSync(`git diff --stat ${diffRef || "HEAD"}`, { cwd: ctx.cwd, encoding: "utf-8", timeout: 5_000 }).trim();
      } catch { /* best effort */ }

      const reviewPrompt = [
        `Review the following git diff (${diffDescription}):`,
        "",
        changedFiles ? `Changed files:\n\`${changedFiles}\`` : "",
        "",
        "```diff",
        diffContent,
        "```",
      ].filter(Boolean).join("\n");

      const fakeEvent = { text: `@review ${reviewPrompt}`, images: [] };
      const parsed = parseInput(fakeEvent.text);
      if (parsed.targets.length === 0) {
        ctx.ui.notify("@review tag not parsed correctly", "error");
        return;
      }

      ctx.ui.notify(`Use: @review <paste diff or describe what to review>`, "info");
      pi.sendMessage({
        customType: CUSTOM_TYPE,
        content: `Diff captured (${diff.length} chars). Run:\n@review ${diffDescription}\n\nOr copy this prompt:\n\`\`\`\n@review Review the following git diff (${diffDescription}):\n\n${changedFiles ? `Changed files: ${changedFiles}` : ""}\n\n(Diff: ${diff.length} chars)\n\`\`\``,
        display: true,
        details: { type: "mesh-diff-result", diff: diffContent, diffDescription, changedFiles },
      });
    },
  });

  // /mesh-doctor
  pi.registerCommand("mesh-doctor", {
    description: "Diagnose model/auth wiring for @claude/@codex/@glm",
    handler: async (_args, ctx) => {
      const toolNames = getWorkerToolNames(WORKER_TOOL_MODE);
      const lines: string[] = [
        "Model Mesh doctor:",
        `- worker tool mode: ${WORKER_TOOL_MODE} (tools: ${toolNames.join(", ") || "none"})`,
        `- worker services cached: ${getCapturedParentContext() ? "yes" : "no"}`,
        `- worker extensions: disabled (noExtensions: true, prevents recursion)`,
        `- cwd: ${ctx.cwd}`,
        `- log dir: ${MESH_LOG_DIR}`,
        `- preview length: ${MESH_PREVIEW_LENGTH} chars`,
        `- widget throttle: ${MESH_WIDGET_THROTTLE_MS}ms`,
        `- progress log interval: ${MESH_LOG_INTERVAL_MS}ms / ${MESH_LOG_INTERVAL_CHARS} chars`,
        `- legacy claude oauth fallback: ${MESH_LEGACY_CLAUDE_OAUTH ? "on" : "off"}`,
        `- force worker session: ${MESH_FORCE_WORKER_SESSION ? "on" : "off"}`,
      ];

      const cc = getCapturedParentContext();
      if (cc) {
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
        customType: CUSTOM_TYPE,
        content: lines.join("\n"),
        display: true,
        details: { type: "mesh-doctor" },
      });
    },
  });

  // /mesh-logs
  pi.registerCommand("mesh-logs", {
    description: "Show recent model-mesh log entries (last 50) or open the latest log file",
    getArgumentCompletions: (prefix) => {
      const args = ["last", "latest", "file", "clear", "reset"];
      const filtered = args.filter((a) => a.startsWith(prefix.toLowerCase()));
      return filtered.length > 0 ? filtered.map((a) => ({ value: a, label: a })) : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "last" || arg === "latest" || arg === "file") {
        try {
          const files = fs.readdirSync(MESH_LOG_DIR).filter((f) => f.startsWith(LOG_PREFIX)).sort();
          if (files.length === 0) {
            ctx.ui.notify("No model-mesh log files found", "warning");
            return;
          }
          const latest = files[files.length - 1];
          const fullPath = path.join(MESH_LOG_DIR, latest);
          const content = fs.readFileSync(fullPath, "utf-8");
          const tail = content.split("\n").slice(-80).join("\n");
          pi.sendMessage({
            customType: CUSTOM_TYPE,
            content: `Log file: ${fullPath}\n\n${tail}`,
            display: true,
            details: { type: "mesh-logs-file", path: fullPath },
          });
        } catch {
          ctx.ui.notify("Could not read log directory", "error");
        }
        return;
      }

      if (arg === "clear" || arg === "reset") {
        try {
          const files = fs.readdirSync(MESH_LOG_DIR).filter((f) => f.startsWith(LOG_PREFIX));
          for (const f of files) fs.unlinkSync(path.join(MESH_LOG_DIR, f));
          ctx.ui.notify(`Cleared ${files.length} log file(s)`, "info");
        } catch {
          ctx.ui.notify("Could not clear log directory", "error");
        }
        return;
      }

      if (lastLogger) {
        const entries = lastLogger.getEntries();
        const display = entries.slice(-50).map((e) => `[${e.ts}] [${e.alias}] [${e.phase}] ${e.message}`).join("\n");
        pi.sendMessage({
          customType: CUSTOM_TYPE,
          content: display || "(no log entries yet)",
          display: true,
          details: { type: "mesh-logs", logFile: lastLogger.getLogFilePath() },
        });
      } else {
        ctx.ui.notify("No model-mesh rounds have run yet. Use @all or @claude etc. first.", "warning");
      }
    },
  });

  let lastLogger: MeshLogger | undefined;
  let currentRoundAbort: AbortController | null = null;

  // -----------------------------------------------------------------------
  // Main input handler
  // -----------------------------------------------------------------------
  pi.on("input", async (event, ctx) => {
    const parsed = parseInput(event.text);
    if (parsed.targets.length === 0) return { action: "continue" as const };

    if (!parsed.cleanedPrompt && !parsed.deliberation && !parsed.deliberationMode && !parsed.reviewMode) {
      if (ctx.hasUI) ctx.ui.notify("Add text after tags, e.g. @claude @codex propose migration strategy", "warning");
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

    // Build base prompt for the mode
    let basePrompt: string;
    if (parsed.reviewMode) {
      basePrompt = `${REVIEW_ANALYSIS_PROMPT}\n\n# Code to review\n${parsed.cleanedPrompt}`;
    } else if (parsed.deliberationMode) {
      basePrompt = buildDeliberationProposalPrompt(parsed.cleanedPrompt);
    } else {
      basePrompt = parsed.cleanedPrompt;
    }

    const history = sanitizeWorkerHistory(
      buildSessionContext(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getLeafId(),
      ).messages as unknown[],
    );
    const thinkingLevel = pi.getThinkingLevel();

    // --- Set up abort controller for the round ---
    const abortController = new AbortController();
    currentRoundAbort = abortController;
    const roundSignal = abortController.signal;

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

    const throttledUpdate = createThrottledUpdater(MESH_WIDGET_THROTTLE_MS);
    const doUpdateWidget = () => { if (ctx.hasUI) updateLiveWidget(ctx, parsed.targets, statuses, partials); };

    if (ctx.hasUI) ctx.ui.setStatus("model-mesh", `Running ${parsed.targets.map((t) => `@${t}`).join(" ")}`);
    doUpdateWidget();

    try {
      // === Phase 1: Run all models in parallel ===
      const workers = await Promise.all(
        parsed.targets.map((alias) =>
          runWorker(alias, basePrompt, ctx, event, history, thinkingLevel, logger, statuses, partials, throttledUpdate, doUpdateWidget, undefined, roundSignal),
        ),
      );
      for (const [alias, txt] of workers) round.outputs[alias] = txt;

      if (roundSignal.aborted) throw new Error("Aborted");

      // ===============================================================
      // Cross-review phase (@review mode only)
      // ===============================================================
      if (parsed.reviewMode && parsed.targets.length >= 2) {
        logger.log("mesh", "info", `Cross-review phase starting — ${parsed.targets.length} models will verify each other`);
        if (ctx.hasUI) ctx.ui.setStatus("model-mesh", `Cross-review: ${parsed.targets.map((t) => `@${t}`).join(" ↔ ")}`);

        const crossReviewWorkers = await Promise.all(
          parsed.targets.map(async (reviewerAlias) => {
            const otherOutputs: Partial<Record<Alias, string>> = {};
            for (const a of parsed.targets) {
              if (a !== reviewerAlias && round.outputs[a]) {
                otherOutputs[a] = round.outputs[a]!;
              }
            }
            if (Object.keys(otherOutputs).length === 0) return null;

            const crossReviewPrompt = buildCrossReviewPrompt(reviewerAlias, round.outputs, parsed.cleanedPrompt);
            const crossReviewText = await runPhaseWorker(
              reviewerAlias, crossReviewPrompt, "🔄", ctx, event, history, thinkingLevel,
              logger, statuses, partials, throttledUpdate, doUpdateWidget, roundSignal,
            );
            if (!crossReviewText) return null;

            const reviewMap: Partial<Record<Alias, string>> = {};
            for (const otherAlias of parsed.targets) {
              if (otherAlias !== reviewerAlias) reviewMap[otherAlias] = crossReviewText;
            }
            return { reviewer: reviewerAlias, reviews: reviewMap };
          }),
        );

        for (const result of crossReviewWorkers) {
          if (!result) continue;
          round.crossReviews.push(result as CrossReview);
        }

        logger.log("mesh", "info", `Cross-review phase completed — ${round.crossReviews.length} cross-reviews collected`);

        if (roundSignal.aborted) throw new Error("Aborted");

        // --- Consensus synthesis ---
        if (round.crossReviews.length >= 2) {
          logger.log("mesh", "info", `Consensus synthesis phase starting`);
          if (ctx.hasUI) ctx.ui.setStatus("model-mesh", `Consensus synthesis`);

          const consensusJudge = parsed.chosenJudge || "claude";
          const consensusPrompt = buildConsensusPrompt(parsed.cleanedPrompt, round.outputs, round.crossReviews);
          const fullConsensus = await runSynthesisWorker(
            "judge", consensusJudge, consensusPrompt, "🔄", ctx, event, history, thinkingLevel,
            logger, statuses, partials, throttledUpdate, doUpdateWidget, roundSignal,
          );

          if (fullConsensus) {
            round.consensus = parseConsensusFromText(fullConsensus, round.outputs);
            round.judged = fullConsensus;
          }
        }
      }

      // ===============================================================
      // Deliberation phase (@deliberate mode only)
      // Phase 1 (proposals) already done above — outputs in round.outputs
      // ===============================================================
      if (parsed.deliberationMode && parsed.targets.length >= 2) {
        const activeOutputs = ORDER.filter((a) => round.outputs[a]);
        if (activeOutputs.length >= 2) {

          // --- Phase 2: Cross-critique ---
          logger.log("mesh", "info", `Deliberation Phase 2: Cross-critique — ${activeOutputs.length} models critiquing each other`);
          if (ctx.hasUI) ctx.ui.setStatus("model-mesh", `Deliberation Phase 2: Cross-critique ${activeOutputs.map((t) => `@${t}`).join(" ↔ ")}`);

          const critiqueWorkers = await Promise.all(
            parsed.targets.map(async (alias) => {
              if (!round.outputs[alias]) return null;

              const critiquePrompt = buildDeliberationCritiquePrompt(alias, parsed.cleanedPrompt, round.outputs);
              const critiqueText = await runPhaseWorker(
                alias, critiquePrompt, "💬", ctx, event, history, thinkingLevel,
                logger, statuses, partials, throttledUpdate, doUpdateWidget, roundSignal,
              );
              if (!critiqueText) return null;

              const reviewMap: Partial<Record<Alias, string>> = {};
              for (const otherAlias of parsed.targets) {
                if (otherAlias !== alias) reviewMap[otherAlias] = critiqueText;
              }
              return { reviewer: alias, reviews: reviewMap } as CrossReview;
            }),
          );

          const critiques: CrossReview[] = [];
          for (const result of critiqueWorkers) { if (result) critiques.push(result); }
          round.crossReviews = critiques;
          logger.log("mesh", "info", `Deliberation Phase 2 complete — ${critiques.length} critiques collected`);

          if (roundSignal.aborted) throw new Error("Aborted");

          // --- Phase 3: Convergence ---
          if (critiques.length >= 2) {
            logger.log("mesh", "info", `Deliberation Phase 3: Convergence — models refine their proposals`);
            if (ctx.hasUI) ctx.ui.setStatus("model-mesh", `Deliberation Phase 3: Convergence`);

            const refinementWorkers = await Promise.all(
              parsed.targets.map(async (alias) => {
                if (!round.outputs[alias]) return null;

                const convergencePrompt = buildDeliberationConvergencePrompt(alias, parsed.cleanedPrompt, round.outputs, critiques);
                const refinedText = await runPhaseWorker(
                  alias, convergencePrompt, "🎯", ctx, event, history, thinkingLevel,
                  logger, statuses, partials, throttledUpdate, doUpdateWidget, roundSignal,
                );
                return refinedText ? ([alias, refinedText] as const) : null;
              }),
            );

            const refinements: Partial<Record<Alias, string>> = {};
            for (const result of refinementWorkers) {
              if (result) { const [a, t] = result; refinements[a] = t; }
            }

            logger.log("mesh", "info", `Deliberation Phase 3 complete — ${Object.keys(refinements).length} refined proposals collected`);

            if (roundSignal.aborted) throw new Error("Aborted");

            // --- Phase 4: Democratic Synthesis ---
            const synthTargets = ORDER.filter((a) => refinements[a]);
            if (synthTargets.length >= 2) {
              logger.log("mesh", "info", `Deliberation Phase 4: Democratic Synthesis — ${synthTargets.length} models synthesizing in parallel`);
              if (ctx.hasUI) ctx.ui.setStatus("model-mesh", `Phase 4: Democratic Synthesis (${synthTargets.map((t) => `@${t}`).join(", ")})`);

              const synthesisOutputs: Partial<Record<Alias, string>> = {};

              const synthWorkers = await Promise.all(
                synthTargets.map(async (alias) => {
                  const synthPrompt = buildDeliberationSynthesisPrompt(parsed.cleanedPrompt, round.outputs, critiques, refinements);
                  const synthText = await runPhaseWorker(
                    alias, synthPrompt, "⚖️", ctx, event, history, thinkingLevel,
                    logger, statuses, partials, throttledUpdate, doUpdateWidget, roundSignal,
                  );
                  if (synthText) synthesisOutputs[alias] = synthText;
                  return synthText ? [alias, synthText] as const : null;
                }),
              );

              const successfulSynthCount = synthWorkers.filter(Boolean).length;
              logger.log("mesh", "info", `Phase 4 complete — ${successfulSynthCount}/${synthTargets.length} models produced syntheses`);

              if (successfulSynthCount >= 2) {
                const convergedPlan = buildConvergedPlan(synthesisOutputs, parsed.cleanedPrompt);

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

      // ===============================================================
      // Judge phase (standard @judge, not review/deliberation)
      // ===============================================================
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

          const judgePromptText = buildJudgePrompt(parsed.cleanedPrompt, round.outputs, parsed.chosenJudge);
          const judged = await runSynthesisWorker(
            "judge", parsed.chosenJudge, judgePromptText, "⚖️", ctx, event, history, thinkingLevel,
            logger, statuses, partials, throttledUpdate, doUpdateWidget, roundSignal,
          );

          if (judged) {
            round.judged = judged || "(empty judgment)";
            judgeStatus.phase = "done";
            judgeStatus.finishedAt = Date.now();
            judgeStatus.charCount = round.judged.length;
            judgeStatus.isThinking = false;
            judgeStatus.activeToolName = null;
            partials.judge = round.judged;
            const pathNote = judgeStatus.streamPath === "legacy" ? " [legacy, no tools]" : "";
            logger.log("judge", "done", `Judge completed in ${formatElapsed(judgeStatus.finishedAt - judgeStatus.startedAt)} — ${round.judged.length} chars${pathNote}`);
          } else {
            round.judged = "Error: judge failed";
          }
        }
        doUpdateWidget();
      }

      rounds.push(round);
      pi.appendEntry("model-mesh-round", round);

      logger.log("mesh", "info", `Round completed — outputs: ${Object.keys(round.outputs).join(", ")}${round.judged ? " + judge" : ""}`);

      pi.sendMessage({
        customType: CUSTOM_TYPE,
        content: formatRound(round),
        display: true,
        details: round,
      });

      return { action: "handled" as const };
    } finally {
      currentRoundAbort = null;
      if (ctx.hasUI) {
        ctx.ui.setStatus("model-mesh", undefined);
        ctx.ui.setWidget("model-mesh-live", undefined);
      }
      throttledUpdate.flush();
      logger.dispose();
    }
  });
}
