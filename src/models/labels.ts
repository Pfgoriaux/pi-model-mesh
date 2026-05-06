import type { Alias, LabelMap } from "../types.js";
import { ALIAS_FAMILIES, getFallbackBinding } from "./aliases.js";

export function labelFor(alias: Alias, labelMap?: LabelMap): string {
  if (labelMap && labelMap[alias]) return labelMap[alias];
  return getFallbackBinding(alias).label;
}
