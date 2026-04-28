import React from "react";
import { createPortal } from "react-dom";
import { TUNER_COLORS, TUNER_NAMES, type TunerType } from "../../utils/hexMapUtils";
import { TUNER_DISPLAY_NAMES } from "./types";
import type { HexMapData, ColorMode } from "./types";
import type { Cluster } from "../../utils/hexMapUtils";

export interface T3ScoresData {
  scores: Map<number, number>;
  maxScore: number;
  anchorBranchCount: number;
}

export interface HexTooltipProps {
  tooltipPos: { x: number; y: number } | null;
  hoveredClusterId: number | null;
  data: HexMapData | null;
  selectedTuners: Set<TunerType>;
  effectiveColorMode: ColorMode;
  coverageMetric: "mean" | "cumulative";
  getClusterCov: (c: Cluster) => number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  selectedParam?: string | null;
  paramBin?: string | null;
  t3Scores?: T3ScoresData | null;
  isCartMember?: boolean;
  /** "coverage" or "accuracy" — driven by program type. */
  metricLabel?: string;
  /** Format helper that maps stored metric int → display string. */
  formatMetric?: (v: number) => string;
}

export function HexTooltip({
  tooltipPos,
  hoveredClusterId,
  data,
  selectedTuners,
  effectiveColorMode,
  containerRef,
  selectedParam,
  paramBin,
  t3Scores,
  metricLabel = "coverage",
  formatMetric,
}: HexTooltipProps) {
  if (!tooltipPos || hoveredClusterId === null || !data) return null;

  const cluster = data.clusters.find((c) => c.id === hoveredClusterId);
  if (!cluster) return null;

  // Total trials from selected tuners
  const totalSelected = TUNER_NAMES.filter((t) =>
    selectedTuners.has(t),
  ).reduce((s, t) => s + cluster.tunerCounts[t], 0);

  const fmt = formatMetric ?? ((v: number) => Math.round(v).toLocaleString());

  // Mean per trial (raw integer; HPO scale = score×1000, fuzzing = branch count)
  const filteredTrials = cluster.trials.filter((t) => selectedTuners.has(t.tuner));
  const meanCov = filteredTrials.length > 0
    ? filteredTrials.reduce((s, t) => s + t.coverage, 0) / filteredTrials.length
    : 0;
  const meanLabel = fmt(meanCov);

  // Cumulative = size of branch union. HPO encodes branches as score levels
  // 0..best_score*1000 so the union size ≈ best score scaled; fuzzing is the
  // raw # of unique branches.
  const cumLabel = fmt(cluster.coveredBranches.length);

  // Top tuner (by trial count among selected)
  let topTuner: TunerType = TUNER_NAMES[0];
  let topCount = 0;
  for (const t of TUNER_NAMES) {
    if (!selectedTuners.has(t)) continue;
    if (cluster.tunerCounts[t] > topCount) {
      topCount = cluster.tunerCounts[t];
      topTuner = t;
    }
  }

  // Fixed position from container
  const rect = containerRef.current?.getBoundingClientRect();
  const fixedLeft = (rect?.left ?? 0) + tooltipPos.x + 12;
  const fixedTop = (rect?.top ?? 0) + tooltipPos.y - 10;

  return createPortal(
    <div
      style={{
        position: "fixed",
        left: fixedLeft,
        top: fixedTop,
        background: "rgba(15, 23, 42, 0.92)",
        color: "white",
        padding: "6px 10px",
        borderRadius: 6,
        fontSize: 13,
        lineHeight: "16px",
        pointerEvents: "none",
        zIndex: 9999,
        whiteSpace: "nowrap",
        boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
      }}
    >
      {/* Line 1: Cluster ID + trial count */}
      <div style={{ fontWeight: 600, marginBottom: 2 }}>
        Cluster #{cluster.id + 1} · {totalSelected.toLocaleString()} trials
      </div>
      {/* Line 2: Top tuner */}
      <div
        style={{
          color: "#CBD5E1",
          marginBottom: 2,
          display: "flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        Top tuner:
        <span
          style={{
            background: TUNER_COLORS[topTuner],
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            borderRadius: 3,
            padding: "1px 5px",
            lineHeight: 1.4,
            whiteSpace: "nowrap",
          }}
        >
          {TUNER_DISPLAY_NAMES[topTuner]}
        </span>
        <span>({topCount.toLocaleString()} trials)</span>
      </div>
      {/* Line 3: Coverage / Accuracy */}
      <div style={{ color: "#CBD5E1", marginBottom: 0 }}>
        {metricLabel.charAt(0).toUpperCase() + metricLabel.slice(1)}: mean{" "}
        {meanLabel}, cum {cumLabel}
      </div>
      {/* Mode-specific line: Parameter */}
      {effectiveColorMode === "tuner-param" && selectedParam && paramBin && (
        <div style={{ color: "#FDE68A", marginTop: 3, fontWeight: 600 }}>
          {selectedParam}: {paramBin}
        </div>
      )}
      {/* Mode-specific line: Complementary */}
      {effectiveColorMode === "complementary" && t3Scores && (
        <div style={{ color: "#6EE7B7", marginTop: 3, fontWeight: 600 }}>
          <i>+{fmt(t3Scores.scores.get(hoveredClusterId!) ?? 0)}</i> {metricLabel}
          {t3Scores.anchorBranchCount > 0 && (
            <span style={{ fontWeight: 400, color: "#94A3B8", marginLeft: 4 }}>
              (gain {((t3Scores.scores.get(hoveredClusterId!) ?? 0) / t3Scores.anchorBranchCount * 100).toFixed(1)}%)
            </span>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
