import React from "react";
import { TUNER_COLORS, TUNER_NAMES } from "../../utils/hexMapUtils";
import { TUNER_DISPLAY_NAMES, type SelectedClusterInfo } from "./types";

export interface ClusterDetailProps {
  info: SelectedClusterInfo | null;
}

export function ClusterDetail({ info }: ClusterDetailProps) {
  if (!info) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400 text-sm">
        Click a cluster to inspect
      </div>
    );
  }

  const { cluster: c, totalUniqueBranches, selectedTuners } = info;

  // Filter trials by selected tuners
  const trials = c.trials.filter((t) => selectedTuners.has(t.tuner));
  const trialCount = trials.length;

  if (trialCount === 0) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400 text-sm">
        No trials from selected tuners
      </div>
    );
  }

  const avgCov = trials.reduce((s, t) => s + t.coverage, 0) / trialCount;
  const minCov = Math.min(...trials.map((t) => t.coverage));
  const maxCov = Math.max(...trials.map((t) => t.coverage));
  const avgMarginal = trials.reduce((s, t) => s + t.marginalCoverage, 0) / trialCount;

  // Cumulative: union of branches from selected tuners' trials
  const hasTrialBranches = trials.some((t) => t.coveredBranches && t.coveredBranches.length > 0);
  let cumCov = 0;
  if (totalUniqueBranches > 0) {
    if (hasTrialBranches) {
      const branchSet = new Set<number>();
      for (const t of trials) {
        for (const b of (t.coveredBranches ?? [])) branchSet.add(b);
      }
      cumCov = branchSet.size / totalUniqueBranches;
    } else {
      // Fallback: cluster-level coveredBranches (not filtered by tuner)
      cumCov = c.coveredBranches.length / totalUniqueBranches;
    }
  }

  // Tuner counts from filtered trials
  const tunerCounts: Partial<Record<TunerType, number>> = {};
  for (const t of trials) {
    tunerCounts[t.tuner] = (tunerCounts[t.tuner] ?? 0) + 1;
  }

  return (
    <div
      style={{
        background: "white",
        borderRadius: 10,
        boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
        border: "1px solid #E5E7EB",
        padding: "14px 16px",
        fontSize: 12,
      }}
    >
      {/* Header */}
      <div
        style={{
          fontWeight: 700,
          fontSize: 14,
          color: "#1E293B",
          marginBottom: 12,
          borderBottom: "1px solid #F1F5F9",
          paddingBottom: 8,
        }}
      >
        Cluster #{c.id + 1}
      </div>

      {/* Stats grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 6,
          marginBottom: 14,
        }}
      >
        {[
          { label: "Trials", value: trialCount.toLocaleString() },
          { label: "Avg Cov", value: avgCov.toFixed(3), color: "#10B981" },
          { label: "Cum Cov", value: cumCov.toFixed(3), color: "#059669" },
          { label: "Min Cov", value: minCov.toFixed(3) },
          { label: "Max Cov", value: maxCov.toFixed(3) },
          { label: "Marginal", value: avgMarginal.toFixed(4) },
        ].map(({ label, value, color }) => (
          <div
            key={label}
            style={{
              background: "#F8FAFC",
              borderRadius: 6,
              padding: "6px 8px",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 9, color: "#94A3B8", marginBottom: 2 }}>
              {label}
            </div>
            <div
              style={{ fontSize: 12, fontWeight: 600, color: color ?? "#1E293B" }}
            >
              {value}
            </div>
          </div>
        ))}
      </div>

      {/* Tuner distribution */}
      <div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "#374151",
            marginBottom: 8,
          }}
        >
          Tuner Distribution
        </div>
        {TUNER_NAMES.filter((t) => selectedTuners.has(t) && (tunerCounts[t] ?? 0) > 0)
          .map((t) => ({ tuner: t, count: tunerCounts[t] ?? 0 }))
          .sort((a, b) => b.count - a.count)
          .map(({ tuner, count }) => {
            const ratio = trialCount > 0 ? count / trialCount : 0;
            return (
              <div key={tuner} style={{ marginBottom: 5 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 10,
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
                    height: 5,
                    background: "#E5E7EB",
                    borderRadius: 3,
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${ratio * 100}%`,
                      background: TUNER_COLORS[tuner],
                      borderRadius: 3,
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
