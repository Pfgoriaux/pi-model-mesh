import type { Alias, CrossReview, MeshRound, ResolvedBinding, LabelMap, WorkerStatus } from "../../types.js";
import { ORDER } from "../../models/aliases.js";
import { REVIEW_ANALYSIS_PROMPT } from "../../prompts/review.js";
import { buildCrossReviewPrompt, buildConsensusPrompt } from "../../prompts/judge.js";
import { runPhaseWorker, runSynthesisWorker } from "../runPhaseWorker.js";
import { parseConsensusFromText } from "../../render/output.js";

export async function runReviewPhase(
  round: MeshRound,
  ctx: any,
  event: { images?: any[] },
  history: unknown[],
  thinkingLevel: any,
  logger: any,
  statuses: Partial<Record<Alias | "judge", WorkerStatus>>,
  partials: Partial<Record<Alias | "judge", string>>,
  throttledUpdate: any,
  doUpdateWidget: () => void,
  resolvedBindings: Record<Alias, ResolvedBinding>,
  labels: LabelMap,
  roundSignal: AbortSignal,
): Promise<void> {
  if (round.targets.length < 2) return;

  logger.log("mesh", "info", `Cross-review phase starting — ${round.targets.length} models will verify each other`);
  if (ctx.hasUI) ctx.ui.setStatus("model-mesh", `Cross-review: ${round.targets.map((t) => `@${t}`).join(" ↔ ")}`);

  const crossReviewWorkers = await Promise.all(
    round.targets.map(async (reviewerAlias) => {
      const otherOutputs: Partial<Record<Alias, string>> = {};
      for (const a of round.targets) {
        if (a !== reviewerAlias && round.outputs[a]) {
          otherOutputs[a] = round.outputs[a]!;
        }
      }
      if (Object.keys(otherOutputs).length === 0) return null;

      const crossReviewPrompt = buildCrossReviewPrompt(reviewerAlias, round.outputs, round.prompt, labels);
      const crossReviewText = await runPhaseWorker(
        reviewerAlias, crossReviewPrompt, "🔄", ctx, event, history, thinkingLevel,
        logger, statuses, partials, throttledUpdate, doUpdateWidget, resolvedBindings[reviewerAlias], roundSignal,
      );
      if (!crossReviewText) return null;

      const reviewMap: Partial<Record<Alias, string>> = {};
      for (const otherAlias of round.targets) {
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

  if (round.crossReviews.length >= 2) {
    logger.log("mesh", "info", `Consensus synthesis phase starting`);
    if (ctx.hasUI) ctx.ui.setStatus("model-mesh", `Consensus synthesis`);

    const consensusJudgeAlias = round.judge || "claude";
    const consensusPrompt = buildConsensusPrompt(round.prompt, round.outputs, round.crossReviews, labels);
    const fullConsensus = await runSynthesisWorker(
      "judge", consensusJudgeAlias, consensusPrompt, "🔄", ctx, event, history, thinkingLevel,
      logger, statuses, partials, throttledUpdate, doUpdateWidget, resolvedBindings[consensusJudgeAlias], roundSignal,
    );

    if (fullConsensus) {
      round.consensus = parseConsensusFromText(fullConsensus, round.outputs);
      round.judged = fullConsensus;
    }
  }
}
