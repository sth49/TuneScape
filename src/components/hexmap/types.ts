import type { TunerType, Trial } from "../../utils/hexMapUtils";

// Re-export for convenience
export type { HexMapData, HexTile, Territory, Trial, TunerType, Cluster } from "../../utils/hexMapUtils";

// ============================================================
// Types
// ============================================================

export type ColorMode = "dominant" | "density" | "coverage" | "compare" | "tuner-perf" | "tuner-param" | "complementary";

export interface SelectedClusterInfo {
  cluster: import("../../utils/hexMapUtils").Cluster;
  totalUniqueBranches: number;
  selectedTuners: Set<import("../../utils/hexMapUtils").TunerType>;
}

export interface HexMapProps {
  program?: string;
  onClusterSelect?: (info: SelectedClusterInfo | null) => void;
  selectedParam?: string | null;
  onParamSelect?: (param: string | null) => void;
  selectedTuners?: Set<import("../../utils/hexMapUtils").TunerType>;
  onToggleTuner?: (tuner: import("../../utils/hexMapUtils").TunerType) => void;
  selectedQualLabels?: Set<QualitativeLabel>;
  onToggleQualLabel?: (label: QualitativeLabel) => void;
}

export type QualitativeLabel =
  | "Failure-prone"
  | "High Novelty"
  | "High Avg Cov"
  | "High Cum Cov"
  | "High Density"
  | "Low Density";

export interface SRMetrics {
  trialCount: number;
  meanCoverage: number;
  meanMarginalCoverage: number;
  failureRate: number;
  coverageIqr: number;
}

/** Spatially connected group of clusters sharing the same qualitative class */
export interface QualRegion {
  id: number;
  label: QualitativeLabel;
  clusterIds: Set<number>;
}

// ============================================================
// Constants
// ============================================================

export const TUNER_DISPLAY_NAMES: Record<TunerType, string> = {
  SymTuner: "Sym",
  CMA_ES: "CMA",
  Genetic: "Gen",
  SuccessiveHalving: "SH",
  TPE: "TPE",
  BayesianOptimization: "BO",
};

export const HEX_SIZE_DEFAULT = 32;

export const QUAL_LABEL_COLORS: Record<QualitativeLabel, string> = {
  "Failure-prone": "#EF4444",
  "High Novelty": "#8B5CF6",
  "High Avg Cov": "#10B981",
  "High Cum Cov": "#059669",
  "High Density": "#06B6D4",
  "Low Density": "#F97316",
};

export const QUAL_LABEL_NAMES: QualitativeLabel[] = [
  "Failure-prone",
  "High Novelty",
  "High Avg Cov",
  "High Cum Cov",
  "High Density",
  "Low Density",
];

export const TERRITORY_PALETTE = [
  "#94A3B8", // slate-400
  "#A8A29E", // stone-400
  "#9CA3AF", // gray-400
  "#A1A1AA", // zinc-400
  "#A3A3A3", // neutral-400
  "#9DAAB8", // blue-gray light
  "#B0A69C", // warm-gray light
  "#92A0B0", // cool-slate light
];

export const MIXED_COLOR = "#e2e7ed";

export const BOOLEAN_PARAMS_SET = new Set([
  "disable-inlining",
  "max-memory-inhibit",
  "klee-call-optimisation",
  "use-construct-hash-stp",
  "use-visitor-hash",
  "equality-substitution",
  "check-overshift",
  "check-div-zero",
  "use-branch-cache",
  "use-independent-solver",
  "use-call-paths",
  "use-cex-cache",
  "use-forked-solver",
  "watchdog",
  "const-array-opt",
  "zero-seed-extension",
  "warnings-only-to-file",
  "smtlib-human-readable",
  "warn-all-external-symbols",
  "use-iterative-deepening-time-search",
  "cex-cache-exp",
  "all-external-warnings",
  "readable-posix-inputs",
  "return-null-on-zero-malloc",
  "emit-all-errors",
  "solver-optimize-divides",
  "cex-cache-try-all",
  "simplify-sym-indices",
  "named-seed-matching",
  "disable-verify",
  "track-instruction-time",
  "silent-klee-assume",
  "suppress-external-warnings",
  "cex-cache-superset",
  "verify-each",
]);

export const CATEGORICAL_PARAMS_SET = new Set([
  "search",
  "switch-type",
  "smtlib-display-constants",
  "smtlib-abbreviation-mode",
  "seed-file",
]);
