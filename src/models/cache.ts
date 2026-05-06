import * as fs from "node:fs";
import type { Alias, ModelBinding } from "../types.js";
import { getModelCachePath, ensureDir } from "../config/paths.js";

interface CachedModels {
  version: number;
  aliases: Partial<Record<Alias, { provider: string; modelId: string; updatedAt: number }>>;
}

const CACHE_VERSION = 1;

export function readCachedBindings(): Partial<Record<Alias, ModelBinding>> {
  const cachePath = getModelCachePath();
  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    const data: CachedModels = JSON.parse(raw);
    if (data.version !== CACHE_VERSION) return {};
    const result: Partial<Record<Alias, ModelBinding>> = {};
    for (const [alias, entry] of Object.entries(data.aliases)) {
      if (!entry) continue;
      (result as any)[alias] = {
        provider: entry.provider,
        modelId: entry.modelId,
        label: entry.modelId,
      };
    }
    return result;
  } catch {
    return {};
  }
}

export function writeCachedBindings(bindings: Record<Alias, ModelBinding>): void {
  const cachePath = getModelCachePath();
  ensureDir(cachePath);
  const data: CachedModels = {
    version: CACHE_VERSION,
    aliases: {},
  };
  for (const [alias, binding] of Object.entries(bindings)) {
    if (!binding) continue;
    (data.aliases as any)[alias] = {
      provider: binding.provider,
      modelId: binding.modelId,
      updatedAt: Date.now(),
    };
  }
  try {
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // Best effort
  }
}
