import React from "react";
import { createPortal } from "react-dom";
import { TUNER_COLORS, TUNER_NAMES, type TunerType } from "../../utils/hexMapUtils";
import { TUNER_DISPLAY_NAMES } from "./types";
import type { HexMapData, ColorMode } from "./types";
import type { Cluster } from "../../utils/hexMapUtils";

type CoverageMetric = "mean" | "min" | "max" | "marginal" | "cumulative";

const METRIC_LABELS: Record<CoverageMetric, string> = {
  mean: "mean cov",
  min: "min cov",
  max: "max cov",
  marginal: "marginal cov",
  cumulative: "cumulative cov",
};

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
  coverageMetric: CoverageMetric;
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
  coverageMetric,
  getClusterCov,
  containerRef,
  selectedParam,
  paramBin,
  t3Scores,
  isCartMember,
}: HexTooltipProps) {
  if (!tooltipPos || hoveredClusterId === null || !data) return null;

  const cluster = data.clusters.find((c) => c.id === hoveredClusterId);
  if (!cluster) return null;

  const totalSelected = TUNER_NAMES.filter((t) =>
    selectedTuners.has(t),
  ).reduce((s, t) => s + cluster.tunerCounts[t], 0);

  const covValue = getClusterCov(cluster);
  const covLabel = effectiveColorMode === "tuner-perf"
    ? METRIC_LABELS[coverageMetric]
    : "avg cov";
  const covDisplay = effectiveColorMode === "tuner-perf"
    ? covValue
    : cluster.meanBranchCoverage;

  // Per-tuner breakdown: trial count + avg coverage
  const tunerBreakdown = TUNER_NAMES
    .filter((t) => selectedTuners.has(t) && cluster.tunerCounts[t] > 0)
    .map((t) => {
      const trials = cluster.trials.filter((tr) => tr.tuner === t);
      const avgCov = trials.length > 0
        ? trials.reduce((s, tr) => s + tr.coverage, 0) / trials.length
        : 0;
      return { tuner: t, count: cluster.tunerCounts[t], avgCov };
    })
    .sort((a, b) => b.avgCov - a.avgCov);

  // Compute fixed position from container-relative tooltip position
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
      <div style={{ fontWeight: 600, marginBottom: 3 }}>
        {totalSelected} trials · {covLabel}{" "}
        {covDisplay.toFixed(3)}
      </div>
      {selectedParam && paramBin && (
        <div style={{ marginBottom: 3, color: "#FDE68A", fontSize: 10 }}>
          {selectedParam}: <span style={{ fontWeight: 600 }}>{paramBin}</span>
        </div>
      )}
      {/* T3: Complementarity info */}
      {effectiveColorMode === "complementary" && t3Scores && (
        <div style={{ marginBottom: 3, color: "#6EE7B7", fontSize: 10 }}>
          {isCartMember ? (
            <span>In working set</span>
          ) : (
            <>
              <span style={{ fontWeight: 600 }}>+{t3Scores.scores.get(hoveredClusterId!) ?? 0}</span> new branches
              {t3Scores.anchorBranchCount > 0 && (
                <span style={{ color: "#94A3B8", marginLeft: 4 }}>
                  ({((t3Scores.scores.get(hoveredClusterId!) ?? 0) / t3Scores.anchorBranchCount * 100).toFixed(1)}% gain)
                </span>
              )}
            </>
          )}
        </div>
      )}
      {/* Per-tuner breakdown */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {tunerBreakdown.map(({ tuner, count, avgCov }) => {
          const pct = totalSelected > 0 ? Math.round((count / totalSelected) * 100) : 0;
          return (
            <div
              key={tuner}
              style={{ display: "flex", alignItems: "center", gap: 5 }}
            >
              <div
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: TUNER_COLORS[tuner],
                  flexShrink: 0,
                }}
              />
              <span style={{ width: 24 }}>{TUNER_DISPLAY_NAMES[tuner]}</span>
              <span style={{ color: "#CBD5E1" }}>
                {count} ({pct}%)
              </span>
              <span style={{ color: "#94A3B8", marginLeft: 4 }}>
                cov {avgCov.toFixed(3)}
              </span>
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
