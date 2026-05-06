import type { Alias } from "../types.js";
import { MeshLogger } from "./logger.js";

export class ProgressReporter {
  private lastLogAt = 0;
  private lastLogChars = 0;

  constructor(
    private logger: MeshLogger,
    private alias: Alias | "judge" | "review",
    private intervalMs: number,
    private intervalChars: number,
  ) {}

  maybeLog(charCount: number, thinkingChars: number, toolCalls: number, phase: string) {
    const now = Date.now();
    const timeOk = now - this.lastLogAt >= this.intervalMs;
    const charsOk = charCount - this.lastLogChars >= this.intervalChars;
    if (timeOk || charsOk) {
      this.lastLogAt = now;
      this.lastLogChars = charCount;
      this.logger.log(this.alias, "info", `[progress] ${phase}: ${charCount} text chars, ${thinkingChars} thinking chars, ${toolCalls} tool calls`);
    }
  }
}
