import type { Alias, CrossReview, MeshRound, ResolvedBinding, LabelMap, WorkerStatus } from "../../types.js";
import { ORDER } from "../../models/aliases.js";
import { buildDeliberationCritiquePrompt, buildDeliberationConvergencePrompt, buildDeliberationSynthesisPrompt } from "../../prompts/deliberation.js";
import { runPhaseWorker } from "../runPhaseWorker.js";
import { parseConsensusFromText, extractTradeoffs, extractRisks, buildConvergedPlan } from "../../render/output.js";

export async function runDeliberationPhase(
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
  const activeOutputs = ORDER.filter((a) => round.outputs[a]);
  if (activeOutputs.length < 2) return;

  // Phase 2: Cross-critique
  logger.log("mesh", "info", `Deliberation Phase 2: Cross-critique — ${activeOutputs.length} models critiquing each other`);
  if (ctx.hasUI) ctx.ui.setStatus("model-mesh", `Deliberation Phase 2: Cross-critique ${activeOutputs.map((t) => `@${t}`).join(" ↔ ")}`);

  const critiqueWorkers = await Promise.all(
    round.targets.map(async (alias) => {
      if (!round.outputs[alias]) return null;

      const critiquePrompt = buildDeliberationCritiquePrompt(alias, round.prompt, round.outputs, labels);
      const critiqueText = await runPhaseWorker(
        alias, critiquePrompt, "💬", ctx, event, history, thinkingLevel,
        logger, statuses, partials, throttledUpdate, doUpdateWidget, resolvedBindings[alias], roundSignal,
      );
      if (!critiqueText) return null;

      const reviewMap: Partial<Record<Alias, string>> = {};
      for (const otherAlias of round.targets) {
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

  // Phase 3: Convergence
  if (critiques.length >= 2) {
    logger.log("mesh", "info", `Deliberation Phase 3: Convergence — models refine their proposals`);
    if (ctx.hasUI) ctx.ui.setStatus("model-mesh", `Deliberation Phase 3: Convergence`);

    const refinementWorkers = await Promise.all(
      round.targets.map(async (alias) => {
        if (!round.outputs[alias]) return null;

        const convergencePrompt = buildDeliberationConvergencePrompt(alias, round.prompt, round.outputs, critiques, labels);
        const refinedText = await runPhaseWorker(
          alias, convergencePrompt, "🎯", ctx, event, history, thinkingLevel,
          logger, statuses, partials, throttledUpdate, doUpdateWidget, resolvedBindings[alias], roundSignal,
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

    // Phase 4: Democratic Synthesis
    const synthTargets = ORDER.filter((a) => refinements[a]);
    if (synthTargets.length >= 2) {
      logger.log("mesh", "info", `Deliberation Phase 4: Democratic Synthesis — ${synthTargets.length} models synthesizing in parallel`);
      if (ctx.hasUI) ctx.ui.setStatus("model-mesh", `Phase 4: Democratic Synthesis (${synthTargets.map((t) => `@${t}`).join(", ")})`);

      const synthesisOutputs: Partial<Record<Alias, string>> = {};

      const synthWorkers = await Promise.all(
        synthTargets.map(async (alias) => {
          const synthPrompt = buildDeliberationSynthesisPrompt(round.prompt, round.outputs, critiques, refinements, labels);
          const synthText = await runPhaseWorker(
            alias, synthPrompt, "⚖️", ctx, event, history, thinkingLevel,
            logger, statuses, partials, throttledUpdate, doUpdateWidget, resolvedBindings[alias], roundSignal,
          );
          if (synthText) synthesisOutputs[alias] = synthText;
          return synthText ? [alias, synthText] as const : null;
        }),
      );

      const successfulSynthCount = synthWorkers.filter(Boolean).length;
      logger.log("mesh", "info", `Phase 4 complete — ${successfulSynthCount}/${synthTargets.length} models produced syntheses`);

      if (successfulSynthCount >= 2) {
        const convergedPlan = buildConvergedPlan(synthesisOutputs, round.prompt, labels);

        const judgeAlias = round.judge || "claude";
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
          const flaggedPlan = `> ⚠️ Only ${labels[alias]} produced a synthesis. This is NOT a democratic consensus — verify with other models manually.\n\n${text}`;
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
