import type { Alias, MeshRound, ResolvedBinding, LabelMap, WorkerStatus } from "../../types.js";
import { buildJudgePrompt } from "../../prompts/judge.js";
import { runSynthesisWorker } from "../runPhaseWorker.js";
import { formatElapsed } from "../../render/text.js";

export async function runJudgePhase(
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
  chosenJudge: Alias,
  roundSignal: AbortSignal,
): Promise<void> {
  const resolved = resolvedBindings[chosenJudge];
  const judgeModel = ctx.modelRegistry.find(resolved.provider, resolved.modelId);

  const judgeStatus: WorkerStatus = {
    alias: chosenJudge,
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
    judgeStatus.error = `model not found (${resolved.provider}/${resolved.modelId})`;
    judgeStatus.finishedAt = Date.now();
    logger.log("judge", "error", judgeStatus.error);
    round.judged = `Error: judge model not found (${resolved.provider}/${resolved.modelId})`;
  } else {
    judgeStatus.phase = "starting";
    judgeStatus.startedAt = Date.now();
    logger.log("judge", "starting", `Judge ${resolved.provider}/${resolved.modelId} starting`);
    doUpdateWidget();

    const judgePromptText = buildJudgePrompt(round.prompt, round.outputs, chosenJudge, labels);
    const judged = await runSynthesisWorker(
      "judge", chosenJudge, judgePromptText, "⚖️", ctx, event, history, thinkingLevel,
      logger, statuses, partials, throttledUpdate, doUpdateWidget, resolved, roundSignal,
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
