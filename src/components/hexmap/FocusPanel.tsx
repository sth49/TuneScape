import React from "react";
import { TUNER_COLORS, TUNER_NAMES, type TunerType } from "../../utils/hexMapUtils";
import type { Cluster, QualRegion } from "./types";
import { TUNER_DISPLAY_NAMES } from "./types";

export interface FocusPanelProps {
  height: number;
  globalCovRange: { min: number; max: number; mean: number };
  selectedTuners: Set<TunerType>;
  inspectedCluster: Cluster | null;
  setInspectedClusterId: (v: number | null) => void;
  setFocusedTerritoryId: (v: number | null) => void;
  clusterToQualRegion: Map<number, QualRegion>;
}

export function FocusPanel({
  height,
  globalCovRange,
  selectedTuners,
  inspectedCluster,
  setInspectedClusterId,
  setFocusedTerritoryId,
  clusterToQualRegion,
}: FocusPanelProps) {
  if (!inspectedCluster) return null;

  const c = inspectedCluster;
  const cumCov = c.coveredBranches.length;
  const minCov = c.trials.length > 0
    ? Math.min(...c.trials.map((t) => t.coverage))
    : 0;
  const maxCov = c.maxBranchCoverage;

  return (
    <div
      style={{
        position: "absolute",
        top: 4,
        right: 12,
        width: 260,
        maxHeight: height - 20,
        overflowY: "auto",
        background: "white",
        borderRadius: 10,
        boxShadow: "0 4px 24px rgba(0,0,0,0.13)",
        border: "1px solid #E5E7EB",
        padding: "12px 14px",
        fontSize: 12,
        zIndex: 10,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 13, color: "#1E293B" }}>
          Cluster #{c.id + 1}
        </span>
        <button
          onClick={() => {
            setFocusedTerritoryId(null);
            setInspectedClusterId(null);
          }}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: 14,
            color: "#94A3B8",
            padding: 0,
          }}
        >
          ×
        </button>
      </div>

      {/* Stats grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 4,
          marginBottom: 10,
        }}
      >
        {[
          { label: "Trials", value: c.totalTrials.toLocaleString() },
          { label: "Avg Cov", value: Math.round(c.meanBranchCoverage).toLocaleString(), color: "#10B981" },
          { label: "Cum Cov", value: Math.round(cumCov).toLocaleString(), color: "#059669" },
          { label: "Min Cov", value: Math.round(minCov).toLocaleString() },
          { label: "Max Cov", value: Math.round(maxCov).toLocaleString() },
          { label: "Marginal", value: c.meanMarginalCoverage.toFixed(2) },
        ].map(({ label, value, color }) => (
          <div
            key={label}
            style={{
              background: "#F8FAFC",
              borderRadius: 4,
              padding: "5px 4px",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 9, color: "#94A3B8", marginBottom: 1 }}>
              {label}
            </div>
            <div style={{ fontSize: 11, fontWeight: 600, color: color ?? "#1E293B" }}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {/* Coverage range bar */}
      {(() => {
        const gMin = globalCovRange.min;
        const gMax = globalCovRange.max;
        const range = gMax - gMin || 1;
        const toPos = (v: number) =>
          Math.max(0, Math.min(100, ((v - gMin) / range) * 100));
        const minPos = toPos(minCov);
        const maxPos = toPos(maxCov);
        const avgPos = toPos(c.meanBranchCoverage);
        return (
          <div style={{ marginBottom: 14 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 8,
                color: "#94A3B8",
                marginBottom: 2,
              }}
            >
              <span>{Math.round(gMin).toLocaleString()}</span>
              <span style={{ fontSize: 8, color: "#64748B" }}>
                Coverage Range
              </span>
              <span>{Math.round(gMax).toLocaleString()}</span>
            </div>
            <div
              style={{
                position: "relative",
                height: 8,
                background: "#E5E7EB",
                borderRadius: 4,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: `${minPos}%`,
                  width: `${Math.max(maxPos - minPos, 1)}%`,
                  height: "100%",
                  background: "#10B981",
                  opacity: 0.3,
                  borderRadius: 4,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: `${avgPos}%`,
                  top: -1,
                  width: 2,
                  height: 10,
                  background: "#10B981",
                  borderRadius: 1,
                  transform: "translateX(-1px)",
                }}
              />
            </div>
          </div>
        );
      })()}

      {/* Tuner distribution */}
      <div>
        <div
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "#374151",
            marginBottom: 6,
          }}
        >
          Tuner Distribution
        </div>
        {TUNER_NAMES.filter((t) => selectedTuners.has(t))
          .map((t) => ({ tuner: t, count: c.tunerCounts[t] }))
          .sort((a, b) => b.count - a.count)
          .map(({ tuner, count }) => {
            const ratio = c.totalTrials > 0 ? count / c.totalTrials : 0;
            return (
              <div key={tuner} style={{ marginBottom: 4 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 9,
                    marginBottom: 2,
                  }}
                >
                  <span style={{ fontWeight: 600, color: TUNER_COLORS[tuner] }}>
                    {TUNER_DISPLAY_NAMES[tuner]}
                  </span>
                  <span style={{ color: "#6B7280" }}>
                    {count} ({(ratio * 100).toFixed(0)}%)
                  </span>
                </div>
                <div
                  style={{
                    height: 4,
                    background: "#E5E7EB",
                    borderRadius: 2,
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${ratio * 100}%`,
                      background: TUNER_COLORS[tuner],
                      borderRadius: 2,
                    }}
                  />
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
