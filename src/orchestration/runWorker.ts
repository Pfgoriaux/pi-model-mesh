import type { Alias, ResolvedBinding, WorkerStatus } from "../types.js";
import type { MeshLogger } from "../stream/logger.js";
import { MESH_LOG_INTERVAL_MS, MESH_LOG_INTERVAL_CHARS } from "../config/env.js";
import { createWorkerStatus, markDone, markError, preview, formatElapsed } from "../render/text.js";
import { ProgressReporter } from "../stream/progress.js";
import { createActivityHandler } from "../stream/activity.js";
import { runModelWithFallback, getWorkerThinkingLevel, normalizeWorkerOutcome, getStreamingRoute } from "../stream/fallback.js";
import { buildProjectContextSnippet } from "../stream/project.js";
import { applyWorkerInstructions } from "../prompts/worker.js";
import { buildParentContextBlock } from "../stream/context.js";
import type { ThrottledUpdater } from "../render/widget.js";

export async function runWorker(
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
  resolved: ResolvedBinding,
  partialFormatter?: (full: string) => string,
  signal?: AbortSignal,
): Promise<[Alias, string]> {
  const status = statuses[alias]!;
  const progress = new ProgressReporter(logger, alias, MESH_LOG_INTERVAL_MS, MESH_LOG_INTERVAL_CHARS);

  let model = ctx.modelRegistry.find(resolved.provider, resolved.modelId);

  if (!model && alias === "glm" && resolved.provider !== "synthetic") {
    model = ctx.modelRegistry.find("synthetic", resolved.modelId);
  }

  if (!model) {
    markError(status, `model not found (${resolved.provider}/${resolved.modelId})`);
    logger.log(alias, "error", status.error!);
    throttledUpdate(doUpdateWidget);
    return [alias, `Error: model not found (${resolved.provider}/${resolved.modelId}). Use /mesh-doctor to diagnose.`];
  }

  status.phase = "starting";
  status.startedAt = Date.now();
  const route = getStreamingRoute(alias, model, ctx, resolved);
  status.streamPath = route.legacy ? "legacy" : "worker";
  logger.log(alias, "starting", `Connecting to ${resolved.provider}/${resolved.modelId} (${route.reason})`);
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
      getWorkerThinkingLevel(alias, model, thinkingLevel), onActivity, status, logger, resolved,
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

    const outcome = normalizeWorkerOutcome(alias, model, txt || "(empty response)", resolved);
    markDone(status, outcome.length, partials, alias, outcome);
    const totalTime = formatElapsed((status.finishedAt ?? Date.now()) - status.startedAt);
    const ttfbText = status.firstTextAt ? ` — ttfb: ${formatElapsed(status.firstTextAt - status.startedAt)}` : "";
    const pathNote = status.streamPath === "legacy" ? " [legacy, no tools]" : "";
    logger.log(alias, "done", `Completed in ${totalTime}${ttfbText} — ${outcome.length} text chars, ${status.thinkingChars} thinking chars, ${status.toolCalls} tool calls${pathNote}`);
    doUpdateWidget();
    return [alias, outcome] as const;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (alias === "glm" && model.provider !== "synthetic" && /invalid api key|401|authentication/i.test(message)) {
      const fallback = ctx.modelRegistry.find("synthetic", resolved.modelId);
      if (fallback) {
        logger.log(alias, "warn", `Auth failed on ${model.provider}, retrying on synthetic...`);
        try {
          status.streamPath = "worker";
          const fallbackWorkerPrompt = applyWorkerInstructions(basePrompt, alias, buildParentContextBlock);
          const onRetryActivity = createActivityHandler({ status, partials, alias, progress, logger, partialFormatter });
          const txt = await runModelWithFallback(alias, fallback, basePrompt, fallbackWorkerPrompt, ctx, history, event.images, getWorkerThinkingLevel(alias, fallback, thinkingLevel), onRetryActivity, status, logger, resolved, undefined, signal);
          const outcome = normalizeWorkerOutcome(alias, fallback, txt || "(empty response)", resolved);
          markDone(status, outcome.length, partials, alias, outcome);
          logger.log(alias, "done", `Completed (synthetic fallback) in ${formatElapsed(status.finishedAt! - status.startedAt)} — ${outcome.length} chars`);
          doUpdateWidget();
          return [alias, outcome] as const;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          markError(status, retryMsg);
          logger.log(alias, "error", `Synthetic fallback also failed: ${retryMsg}`);
          doUpdateWidget();
          return [alias, normalizeWorkerOutcome(alias, fallback, `Error: ${retryMsg}`, resolved)] as const;
        }
      }
    }

    markError(status, message);
    logger.log(alias, "error", message);
    doUpdateWidget();
    return [alias, normalizeWorkerOutcome(alias, model, `Error: ${message}`, resolved)] as const;
  }
}
