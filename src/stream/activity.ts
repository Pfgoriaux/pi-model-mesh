import type { Alias, StreamActivity, WorkerStatus } from "../types.js";
import { MeshLogger } from "./logger.js";
import { ProgressReporter } from "./progress.js";
import { formatElapsed } from "../render/text.js";

export interface ActivityHandlerOptions {
  status: WorkerStatus;
  partials: Partial<Record<Alias | "judge", string>>;
  alias: Alias | "judge";
  progress: ProgressReporter;
  logger: MeshLogger;
  partialFormatter?: (full: string) => string;
  logFirstText?: boolean;
}

export function createActivityHandler(opts: ActivityHandlerOptions): (act: StreamActivity) => void {
  const { status, partials, alias, progress, logger, partialFormatter, logFirstText = true } = opts;

  return (act: StreamActivity) => {
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
        status.phase = "streaming";
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
        if (!status.isThinking) status.phase = "streaming";
        logger.log(alias, "toolcalling", `Tool call #${status.toolCalls} done: ${act.toolName}`);
        break;
      }
      case "text": {
        if (!status.firstTextAt) {
          status.firstTextAt = Date.now();
          status.phase = "streaming";
          if (logFirstText) {
            logger.log(alias, "streaming", `First text token — ttfb: ${formatElapsed(status.firstTextAt - status.startedAt)}, first activity: ${formatElapsed(status.firstActivityAt - status.startedAt)}`);
          }
        }
        status.charCount = act.full.length;
        partials[alias] = partialFormatter ? partialFormatter(act.full) : act.full;
        progress.maybeLog(status.charCount, status.thinkingChars, status.toolCalls, "streaming");
        break;
      }
    }
  };
}
