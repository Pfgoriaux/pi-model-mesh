import { buildSessionContext, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import type { Alias, MeshRound, ResolvedBinding, LabelMap, WorkerStatus } from "./types.js";

import { SYNTHETIC_GLM_PROVIDER, SYNTHETIC_BASE_URL, SYNTHETIC_API_KEY_ENV, MESH_WIDGET_THROTTLE_MS, MESH_LOG_INTERVAL_MS, MESH_LOG_INTERVAL_CHARS } from "./config/env.js";
import { ORDER } from "./models/aliases.js";
import { resolveAllAliases, buildLabelMap } from "./models/resolve.js";
import { getFallbackBinding } from "./models/aliases.js";
import { labelFor } from "./models/labels.js";
import { REVIEW_ANALYSIS_PROMPT } from "./prompts/review.js";
import { buildDeliberationProposalPrompt } from "./prompts/deliberation.js";

import { parseInput } from "./input/parse.js";
import { invalidateWorkerServices } from "./stream/fallback.js";
import { resetCapturedContext, captureParentContext, getCapturedParentContext } from "./stream/context.js";
import { invalidateProjectContextCache } from "./stream/project.js";
import { MeshLogger } from "./stream/logger.js";
import { sanitizeWorkerHistory } from "./stream/messages.js";
import { createWorkerStatus, preview, formatElapsed } from "./render/text.js";
import { updateLiveWidget, createThrottledUpdater, type ThrottledUpdater } from "./render/widget.js";
import { formatRound } from "./render/output.js";

import { runWorker } from "./orchestration/runWorker.js";
import { runReviewPhase } from "./orchestration/modes/review.js";
import { runDeliberationPhase } from "./orchestration/modes/deliberation.js";
import { runJudgePhase } from "./orchestration/modes/judge.js";

import { registerMeshAbort } from "./commands/meshAbort.js";
import { registerMeshClear } from "./commands/meshClear.js";
import { registerMeshDoctor } from "./commands/meshDoctor.js";
import { registerMeshLogs } from "./commands/meshLogs.js";
import { registerMeshDiff } from "./commands/meshDiff.js";

const CUSTOM_TYPE = "model-mesh";
const ROUND_TYPE = "model-mesh-round";

export default function modelMeshExtension(pi: ExtensionAPI) {
  const rounds: MeshRound[] = [];

  let lastLogger: MeshLogger | undefined;
  let currentRoundAbort: AbortController | null = null;

  const resolvedBindings: Record<Alias, ResolvedBinding> = {} as any;
  let labels: LabelMap = {} as any;

  function resolveModels(ctx: any) {
    const fresh = resolveAllAliases(ctx.modelRegistry);
    Object.assign(resolvedBindings, fresh);
    labels = buildLabelMap(resolvedBindings);
  }

  // Optional: register a dedicated Synthetic bridge
  if (SYNTHETIC_GLM_PROVIDER !== "synthetic") {
    const glmFallback = getFallbackBinding("glm");
    pi.registerProvider(SYNTHETIC_GLM_PROVIDER, {
      baseUrl: SYNTHETIC_BASE_URL,
      apiKey: SYNTHETIC_API_KEY_ENV,
      authHeader: true,
      api: "openai-completions",
      models: [
        {
          id: glmFallback.modelId,
          name: glmFallback.label,
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

  // Message renderer
  pi.registerMessageRenderer(CUSTOM_TYPE, (message, { expanded }, theme) => {
    const detailType = (message.details as any)?.type;
    const contentText = typeof message.content === "string" ? message.content : JSON.stringify(message.content);

    if (detailType === "mesh-doctor" || detailType === "mesh-logs" ||
        detailType === "mesh-logs-file" || detailType === "mesh-diff-result") {
      const header = theme.fg("accent", "[model-mesh]");
      return new Text(`${header} ${contentText}`, 0, 0);
    }

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

    return new Text(theme.fg("muted", contentText), 0, 0);
  });

  // Autocomplete for @-tags
  const MESH_TAG_KEYS = Object.keys(TAG_DESCRIPTIONS);

  pi.on("session_start", async (_event, ctx) => {
    rounds.length = 0;
    invalidateWorkerServices();
    resetCapturedContext();

    resolveModels(ctx);

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "model-mesh-round") continue;
      const data = entry.data as MeshRound | undefined;
      if (!data || !data.id || !Array.isArray(data.targets)) continue;
      rounds.push(data);
    }

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

  pi.on("before_agent_start", async (event) => {
    captureParentContext(event.systemPromptOptions);
  });

  pi.on("session_shutdown", async () => {
    invalidateWorkerServices();
    invalidateProjectContextCache();
    resetCapturedContext();
    currentRoundAbort?.abort();
    lastLogger?.dispose();
  });

  // Commands
  registerMeshAbort(pi, () => currentRoundAbort);
  registerMeshClear(pi, rounds, invalidateWorkerServices, resetCapturedContext);
  registerMeshDoctor(pi, resolvedBindings, labels);
  registerMeshLogs(pi, () => lastLogger);
  registerMeshDiff(pi);

  // Main input handler
  pi.on("input", async (event, ctx) => {
    const parsed = parseInput(event.text);
    if (parsed.targets.length === 0) return { action: "continue" as const };

    if (!parsed.cleanedPrompt && !parsed.deliberation && !parsed.deliberationMode && !parsed.reviewMode) {
      if (ctx.hasUI) ctx.ui.notify("Add text after tags, e.g. @claude @codex propose migration strategy", "warning");
      return { action: "handled" as const };
    }

    resolveModels(ctx);

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

    const abortController = new AbortController();
    currentRoundAbort = abortController;
    const roundSignal = abortController.signal;

    const logger = new MeshLogger(round.id);
    lastLogger = logger;
    logger.log("mesh", "info", `Round started — targets: ${parsed.targets.join(", ")} — prompt: ${preview(parsed.cleanedPrompt, 80)}`);

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
      // Phase 1: Run all models in parallel
      const workers = await Promise.all(
        parsed.targets.map((alias) =>
          runWorker(alias, basePrompt, ctx, event, history, thinkingLevel, logger, statuses, partials, throttledUpdate, doUpdateWidget, resolvedBindings[alias], undefined, roundSignal),
        ),
      );
      for (const [alias, txt] of workers) round.outputs[alias] = txt;

      if (roundSignal.aborted) throw new Error("Aborted");

      // Cross-review phase (@review mode)
      if (parsed.reviewMode) {
        await runReviewPhase(round, ctx, event, history, thinkingLevel, logger, statuses, partials, throttledUpdate, doUpdateWidget, resolvedBindings, labels, roundSignal);
      }

      // Deliberation phase (@deliberate mode)
      if (parsed.deliberationMode) {
        await runDeliberationPhase(round, ctx, event, history, thinkingLevel, logger, statuses, partials, throttledUpdate, doUpdateWidget, resolvedBindings, labels, roundSignal);
      }

      // Judge phase (standard @judge, not review/deliberation)
      if (parsed.judgeMode && !parsed.reviewMode && !parsed.deliberationMode && parsed.chosenJudge) {
        await runJudgePhase(round, ctx, event, history, thinkingLevel, logger, statuses, partials, throttledUpdate, doUpdateWidget, resolvedBindings, labels, parsed.chosenJudge, roundSignal);
      }

      rounds.push(round);
      pi.appendEntry("model-mesh-round", round);

      logger.log("mesh", "info", `Round completed — outputs: ${Object.keys(round.outputs).join(", ")}${round.judged ? " + judge" : ""}`);

      pi.sendMessage({
        customType: CUSTOM_TYPE,
        content: formatRound(round, labels),
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
