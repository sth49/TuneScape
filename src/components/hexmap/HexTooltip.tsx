import React from "react";
import { createPortal } from "react-dom";
import { TUNER_NAMES, type TunerType } from "../../utils/hexMapUtils";
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
  coverageMetric: "mean" | "min" | "max" | "marginal" | "cumulative";
  getClusterCov: (c: Cluster) => number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  selectedParam?: string | null;
  paramBin?: string | null;
  t3Scores?: T3ScoresData | null;
  isCartMember?: boolean;
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
}: HexTooltipProps) {
  if (!tooltipPos || hoveredClusterId === null || !data) return null;

  const cluster = data.clusters.find((c) => c.id === hoveredClusterId);
  if (!cluster) return null;

  // Total trials from selected tuners
  const totalSelected = TUNER_NAMES.filter((t) =>
    selectedTuners.has(t),
  ).reduce((s, t) => s + cluster.tunerCounts[t], 0);

  // Mean coverage %
  const filteredTrials = cluster.trials.filter((t) => selectedTuners.has(t.tuner));
  const meanCov = filteredTrials.length > 0
    ? filteredTrials.reduce((s, t) => s + t.coverage, 0) / filteredTrials.length
    : 0;
  const meanPct = (meanCov * 100).toFixed(1);

  // Cumulative coverage %
  const tub = data.totalUniqueBranches || 1;
  const cumPct = ((cluster.coveredBranches.length / tub) * 100).toFixed(1);

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
        fontSize: 11,
        lineHeight: "16px",
        pointerEvents: "none",
        zIndex: 9999,
        whiteSpace: "nowrap",
        boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
      }}
    >
      {/* Line 1: Cluster ID + trial count */}
      <div style={{ fontWeight: 600, marginBottom: 2 }}>
        Cluster #{cluster.id + 1} · {totalSelected} trials
      </div>
      {/* Line 2: Coverage */}
      <div style={{ color: "#CBD5E1", marginBottom: 2 }}>
        Coverage: mean {meanPct}%, cum {cumPct}%
      </div>
      {/* Line 3: Top tuner */}
      <div style={{ color: "#CBD5E1", marginBottom: 0 }}>
        Top tuner: {TUNER_DISPLAY_NAMES[topTuner]} ({topCount} trials)
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
          +{t3Scores.scores.get(hoveredClusterId!) ?? 0} new branches
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
