import type { Alias, ResolvedBinding, WorkerStatus } from "../types.js";
import type { MeshLogger } from "../stream/logger.js";
import { MESH_LOG_INTERVAL_MS, MESH_LOG_INTERVAL_CHARS } from "../config/env.js";
import { createWorkerStatus, formatElapsed, preview } from "../render/text.js";
import { ProgressReporter } from "../stream/progress.js";
import { createActivityHandler } from "../stream/activity.js";
import { runModelWithFallback, getWorkerThinkingLevel } from "../stream/fallback.js";
import { applyWorkerInstructions } from "../prompts/worker.js";
import { buildParentContextBlock } from "../stream/context.js";
import type { ThrottledUpdater } from "../render/widget.js";

export async function runPhaseWorker(
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
  resolved: ResolvedBinding,
  signal?: AbortSignal,
): Promise<string | null> {
  const model = ctx.modelRegistry.find(resolved.provider, resolved.modelId);
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
      getWorkerThinkingLevel(alias, model, thinkingLevel), onActivity, phaseStatus, logger, resolved,
      undefined, signal,
    );

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

export async function runSynthesisWorker(
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
  resolved: ResolvedBinding,
  signal?: AbortSignal,
): Promise<string | null> {
  const model = ctx.modelRegistry.find(resolved.provider, resolved.modelId);
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
      getWorkerThinkingLevel(actualAlias, model, thinkingLevel), onActivity, synthStatus, logger, resolved,
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
