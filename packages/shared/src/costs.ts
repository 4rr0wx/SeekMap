import type { RepeatCostRule } from "./types.js";

export function calculateQuestionCost(
  baseCost: number,
  usageNumber: number,
  rule: RepeatCostRule,
): number {
  const repeats = Math.max(0, usageNumber - 1);
  if (rule.type === "LINEAR") return baseCost + repeats * (rule.increment ?? baseCost);
  if (rule.type === "MULTIPLIER") return baseCost * Math.pow(rule.multiplier ?? 2, repeats);
  return baseCost;
}
