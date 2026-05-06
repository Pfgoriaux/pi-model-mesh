import * as path from "node:path";
import * as fs from "node:fs";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

const AGENT_DIR = getAgentDir();

export function getLogsDir(): string {
  return process.env.MESH_LOG_DIR?.trim() || path.join(AGENT_DIR, "logs");
}

export function getModelCacheDir(): string {
  return path.join(AGENT_DIR, "model-mesh");
}

export function getModelCachePath(): string {
  return path.join(getModelCacheDir(), "resolved-models.json");
}

export function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
