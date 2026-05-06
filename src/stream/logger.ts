import * as fs from "node:fs";
import type { Alias, LogEntry } from "../types.js";
import { getLogsDir, ensureDir } from "../config/paths.js";

const LOG_PREFIX = "model-mesh-";

export class MeshLogger {
  private entries: LogEntry[] = [];
  private logFilePath: string;
  private writeStream: fs.WriteStream | null = null;

  constructor(roundId: string) {
    const logDir = getLogsDir();
    this.logFilePath = `${logDir}/${LOG_PREFIX}${roundId}.log`;
    try {
      ensureDir(this.logFilePath);
      this.writeStream = fs.createWriteStream(this.logFilePath, { flags: "w" });
    } catch {
      // Best effort
    }
  }

  log(alias: Alias | "judge" | "mesh" | "review", phase: import("../types.js").WorkerPhase | "info" | "warn", message: string) {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      roundId: "",
      alias,
      phase,
      message,
    };
    this.entries.push(entry);
    try {
      this.writeStream?.write(`[${entry.ts}] [${alias}] [${phase}] ${message}\n`);
    } catch {
      // Best effort
    }
  }

  getEntries() { return this.entries; }
  getLogFilePath() { return this.logFilePath; }

  dispose() {
    try { this.writeStream?.end(); } catch { /* noop */ }
  }
}
