import * as fs from "node:fs";
import * as path from "node:path";
import { getLogsDir } from "../config/paths.js";

const CUSTOM_TYPE = "model-mesh";
const LOG_PREFIX = "model-mesh-";

export function registerMeshLogs(pi: any, getLastLogger: () => any) {
  pi.registerCommand("mesh-logs", {
    description: "Show recent model-mesh log entries (last 50) or open the latest log file",
    getArgumentCompletions: (prefix: string) => {
      const args = ["last", "latest", "file", "clear", "reset"];
      const filtered = args.filter((a) => a.startsWith(prefix.toLowerCase()));
      return filtered.length > 0 ? filtered.map((a) => ({ value: a, label: a })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const arg = args.trim().toLowerCase();
      const logDir = getLogsDir();

      if (arg === "last" || arg === "latest" || arg === "file") {
        try {
          const files = fs.readdirSync(logDir).filter((f) => f.startsWith(LOG_PREFIX)).sort();
          if (files.length === 0) {
            ctx.ui.notify("No model-mesh log files found", "warning");
            return;
          }
          const latest = files[files.length - 1];
          const fullPath = path.join(logDir, latest);
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
          const files = fs.readdirSync(logDir).filter((f) => f.startsWith(LOG_PREFIX));
          for (const f of files) fs.unlinkSync(path.join(logDir, f));
          ctx.ui.notify(`Cleared ${files.length} log file(s)`, "info");
        } catch {
          ctx.ui.notify("Could not clear log directory", "error");
        }
        return;
      }

      const lastLogger = getLastLogger();
      if (lastLogger) {
        const entries = lastLogger.getEntries();
        const display = entries.slice(-50).map((e: any) => `[${e.ts}] [${e.alias}] [${e.phase}] ${e.message}`).join("\n");
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
}
