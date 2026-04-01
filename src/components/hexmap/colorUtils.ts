import * as d3 from "d3";
import { TERRITORY_PALETTE, BOOLEAN_PARAMS_SET, CATEGORICAL_PARAMS_SET } from "./types";
import type { Trial, SRMetrics } from "./types";

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function mixHexColors(colorA: string, colorB: string, t: number): string {
  const a = d3.color(colorA);
  const b = d3.color(colorB);
  if (!a || !b) return colorA;

  const ratio = clamp01(t);
  const ra = d3.rgb(a);
  const rb = d3.rgb(b);
  return d3
    .rgb(
      ra.r + (rb.r - ra.r) * ratio,
      ra.g + (rb.g - ra.g) * ratio,
      ra.b + (rb.b - ra.b) * ratio,
    )
    .formatHex();
}

export function getTerritoryColor(territoryId: number): string {
  return TERRITORY_PALETTE[territoryId % TERRITORY_PALETTE.length];
}

// ── Qualitative label helpers ────────────────────────────────
export function qualPct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function computeSRMetrics(trials: Trial[]): SRMetrics {
  const n = trials.length;
  if (n === 0)
    return {
      trialCount: 0,
      meanCoverage: 0,
      meanMarginalCoverage: 0,
      failureRate: 0,
      coverageIqr: 0,
    };
  const coverages = trials.map((t) => t.coverage);
  const marginals = trials.map((t) => t.marginalCoverage);
  const meanCoverage = coverages.reduce((a, b) => a + b, 0) / n;
  const meanMarginalCoverage = marginals.reduce((a, b) => a + b, 0) / n;
  const failureRate = coverages.filter((c) => c === 0).length / n;
  const coverageIqr =
    n >= 2 ? qualPct(coverages, 75) - qualPct(coverages, 25) : 0;
  return {
    trialCount: n,
    meanCoverage,
    meanMarginalCoverage,
    failureRate,
    coverageIqr,
  };
}

// ── Parameter type detection ────────────────────────────────
export function getParamType(name: string): "boolean" | "numeric" | "categorical" {
  if (BOOLEAN_PARAMS_SET.has(name)) return "boolean";
  if (CATEGORICAL_PARAMS_SET.has(name)) return "categorical";
  const base = name.split("__")[0];
  if (CATEGORICAL_PARAMS_SET.has(base)) return "categorical";
  return "numeric";
}
