import type { Model } from "@mariozechner/pi-ai";
import type { Alias, ModelBinding, ResolvedBinding, LabelMap } from "../types.js";
import { ALIAS_FAMILIES, ORDER, getFallbackBinding } from "./aliases.js";
import { readCachedBindings, writeCachedBindings } from "./cache.js";

export function resolveAlias(alias: Alias, modelRegistry: { find: (provider: string, modelId: string) => Model<any> | undefined; getAll: () => Model<any>[]; getAvailable: () => Model<any>[] }): ResolvedBinding {
  const family = ALIAS_FAMILIES[alias];

  // 1. Env override
  const envProvider = process.env[`MESH_PROVIDER_${alias.toUpperCase()}`]?.trim();
  const envModelId = process.env[`MESH_MODEL_${alias.toUpperCase()}`]?.trim();
  if (envProvider && envModelId) {
    const model = modelRegistry.find(envProvider, envModelId);
    if (model) {
      return { provider: envProvider, modelId: envModelId, label: model.name || envModelId, source: "env" };
    }
  }

  // 2. Cached binding (validate still exists)
  const cached = readCachedBindings()[alias];
  if (cached) {
    const model = modelRegistry.find(cached.provider, cached.modelId);
    if (model) {
      return { ...cached, label: model.name || cached.modelId, source: "cache" };
    }
  }

  // 3. Dynamic lookup in model registry
  const available = modelRegistry.getAvailable();
  for (const provider of family.providers) {
    for (const model of available) {
      if (model.provider === provider && family.modelPatterns.some((p) => p.test(model.id))) {
        return { provider: model.provider, modelId: model.id, label: model.name || model.id, source: "registry" };
      }
    }
  }

  // 4. Broader search: any available model matching patterns
  for (const model of available) {
    if (family.modelPatterns.some((p) => p.test(model.id))) {
      return { provider: model.provider, modelId: model.id, label: model.name || model.id, source: "registry" };
    }
  }

  // 5. Fallback hints
  const fb = getFallbackBinding(alias);
  return { ...fb, source: "fallback" };
}

export function resolveAllAliases(modelRegistry: any): Record<Alias, ResolvedBinding> {
  const bindings: Record<Alias, ResolvedBinding> = {} as any;
  for (const alias of ORDER) {
    bindings[alias] = resolveAlias(alias, modelRegistry);
  }

  const shouldCache = Object.values(bindings).some((b) => b.source === "registry" || b.source === "cache");
  if (shouldCache) {
    const toCache: Record<Alias, ModelBinding> = {} as any;
    for (const alias of ORDER) {
      if (bindings[alias].source === "registry" || bindings[alias].source === "cache") {
        toCache[alias] = { provider: bindings[alias].provider, modelId: bindings[alias].modelId, label: bindings[alias].label };
      }
    }
    writeCachedBindings(toCache);
  }

  return bindings;
}

export function buildLabelMap(bindings: Record<Alias, ResolvedBinding>): LabelMap {
  const labels: LabelMap = {} as any;
  for (const alias of ORDER) {
    labels[alias] = bindings[alias].label;
  }
  return labels;
}
