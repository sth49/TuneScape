import React from "react";
import {
  getDominantTuner,
  TUNER_COLORS,
  TUNER_NAMES,
  type TunerType,
} from "../../utils/hexMapUtils";
import { TUNER_DISPLAY_NAMES, type CartData } from "./types";

export interface CartPanelProps {
  cartIds: Set<number>;
  cartData: CartData | null;
  selectedTuners: Set<TunerType>;
  onRemove: (clusterId: number) => void;
  onClear: () => void;
  /** Shared hover id (same state HexMap writes to). Used to highlight the matching card. */
  hoveredClusterId?: number | null;
  onHoverChange?: (clusterId: number | null) => void;
}

/** Stacked bar: tuner proportions within a trial set (counts).
 *  - Tuners sorted by count desc for readability.
 *  - 1px white gaps between segments.
 *  - Minimum 3px segment width so small proportions stay visible.
 */
function StackedTunerBar({
  counts,
  selectedTuners,
  height = 8,
}: {
  counts: Record<TunerType, number> | Partial<Record<TunerType, number>>;
  selectedTuners: Set<TunerType>;
  height?: number;
}) {
  const entries = TUNER_NAMES.filter(
    (t) => selectedTuners.has(t) && (counts[t] ?? 0) > 0,
  )
    .map((t) => ({ tuner: t, count: counts[t] ?? 0 }))
    .sort((a, b) => b.count - a.count);
  const total = entries.reduce((s, e) => s + e.count, 0);
  if (total === 0) {
    return <div style={{ height, background: "#F1F5F9", borderRadius: 2 }} />;
  }
  return (
    <div
      style={{
        display: "flex",
        height,
        width: "100%",
        borderRadius: 2,
        overflow: "hidden",
        background: "#CBD5E1",
        gap: 1.5,
        border: "1px solid #CBD5E1",
        boxSizing: "border-box",
      }}
    >
      {entries.map(({ tuner, count }) => (
        <div
          key={tuner}
          style={{
            flex: `${count} ${count} 0`,
            minWidth: 4,
            background: TUNER_COLORS[tuner],
          }}
          title={`${tuner}: ${count} (${((count / total) * 100).toFixed(1)}%)`}
        />
      ))}
    </div>
  );
}

/** SVG donut: arc length = ratio, center label = branch count. */
function CoverageDonut({
  ratio,
  label,
  size = 64,
  stroke = 10,
}: {
  ratio: number;
  label: string;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = c * Math.min(1, Math.max(0, ratio));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#E5E7EB"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#4F46E5"
        strokeWidth={stroke}
        strokeDasharray={`${dash} ${c - dash}`}
        strokeDashoffset={c / 4}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dasharray 0.3s" }}
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={size * 0.2}
        fontWeight={700}
        fill="#1E293B"
      >
        {label}
      </text>
    </svg>
  );
}

export function CartPanel({
  cartIds,
  cartData,
  selectedTuners,
  onRemove,
  onClear,
  hoveredClusterId = null,
  onHoverChange,
}: CartPanelProps) {
  const empty = cartIds.size === 0;

  const unionCovRatio = cartData?.unionCoverage ?? 0;
  const unionBranchCount = cartData?.unionBranches.size ?? 0;
  const totalUniqueBranches = cartData?.totalUniqueBranches ?? 0;

  // Aggregate tuner counts across the working set
  const unionTunerCounts: Record<TunerType, number> = React.useMemo(() => {
    const init = Object.fromEntries(
      TUNER_NAMES.map((t) => [t, 0]),
    ) as Record<TunerType, number>;
    if (!cartData) return init;
    for (const c of cartData.clusters) {
      for (const t of TUNER_NAMES) {
        init[t] += c.tunerCounts[t] ?? 0;
      }
    }
    return init;
  }, [cartData]);

  const unionTotalTrials = TUNER_NAMES.filter((t) => selectedTuners.has(t))
    .reduce((s, t) => s + unionTunerCounts[t], 0);

  // Top tuners (filtered) sorted by count for the union legend
  const unionTopTuners = TUNER_NAMES.filter(
    (t) => selectedTuners.has(t) && unionTunerCounts[t] > 0,
  )
    .map((t) => ({
      tuner: t,
      count: unionTunerCounts[t],
      pct: unionTotalTrials > 0 ? (unionTunerCounts[t] / unionTotalTrials) * 100 : 0,
    }))
    .sort((a, b) => b.count - a.count);

  return (
    <div
      style={{
        background: "white",
        borderRadius: 10,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "10px 14px 8px",
          borderBottom: empty ? "none" : "1px solid #F1F5F9",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 17, color: "#1E293B" }}>
          Working Set{!empty && ` (${cartIds.size})`}
        </span>
        {!empty && (
          <button
            onClick={onClear}
            style={{
              fontSize: 12,
              color: "#94A3B8",
              background: "none",
              border: "none",
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Empty state */}
      {empty && (
        <div
          style={{
            color: "#9CA3AF",
            fontSize: 13,
            textAlign: "center",
            padding: "16px 14px 12px",
          }}
        >
          Shift+click cells to add.
        </div>
      )}

      {/* Non-empty content */}
      {!empty && (
        <div
          style={{
            padding: "6px 14px 10px",
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* ── Union card ──────────────────────────── */}
          <div
            style={{
              background: "#F8FAFC",
              border: "1px solid #E2E8F0",
              borderRadius: 8,
              padding: "10px 10px 8px",
              marginBottom: 10,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "#64748B",
                letterSpacing: 0.2,
                marginBottom: 6,
              }}
            >
              Union Coverage
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <CoverageDonut
                ratio={unionCovRatio}
                label={`${(unionCovRatio * 100).toFixed(1)}%`}
                size={62}
                stroke={9}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: "#1E293B", fontWeight: 600 }}>
                  {unionBranchCount.toLocaleString()}
                  <span style={{ color: "#94A3B8", fontWeight: 500 }}>
                    {" "}of {totalUniqueBranches.toLocaleString()}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "#64748B", marginTop: 1 }}>
                  branches covered
                </div>
                <div style={{ fontSize: 12, color: "#64748B", marginTop: 3 }}>
                  {unionTotalTrials.toLocaleString()} trials from {cartIds.size}{" "}
                  {cartIds.size === 1 ? "cell" : "cells"}
                </div>
              </div>
            </div>

            {/* Tuner composition of whole working set */}
            <div style={{ marginTop: 8 }}>
              <StackedTunerBar
                counts={unionTunerCounts}
                selectedTuners={selectedTuners}
                height={8}
              />
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "2px 8px",
                  marginTop: 5,
                  fontSize: 12,
                  color: "#475569",
                }}
              >
                {unionTopTuners
                  .filter(({ pct }) => pct >= 1)
                  .map(({ tuner, pct }) => (
                    <span
                      key={tuner}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                      }}
                    >
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 2,
                          background: TUNER_COLORS[tuner],
                          display: "inline-block",
                        }}
                      />
                      {TUNER_DISPLAY_NAMES[tuner]} {pct.toFixed(0)}%
                    </span>
                  ))}
              </div>
            </div>
          </div>

          {/* ── Individual cell list ────────────────── */}
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 5,
            }}
          >
            {cartData?.clusters.map((c) => {
              const filteredCounts = Object.fromEntries(
                TUNER_NAMES.filter((t) => selectedTuners.has(t)).map((t) => [
                  t,
                  c.tunerCounts[t],
                ]),
              ) as Record<TunerType, number>;
              const dominant = getDominantTuner(filteredCounts);
              const trialCount = TUNER_NAMES.filter((t) =>
                selectedTuners.has(t),
              ).reduce((s, t) => s + c.tunerCounts[t], 0);

              // Mean branches per trial (ratio → count)
              const filteredTrials = c.trials.filter((t) =>
                selectedTuners.has(t.tuner),
              );
              const meanCov =
                filteredTrials.length > 0
                  ? filteredTrials.reduce((s, t) => s + t.coverage, 0) /
                    filteredTrials.length
                  : 0;
              const meanBranches = Math.round(meanCov * totalUniqueBranches);

              // Cumulative branch count (union across trials in this cell)
              const cumBranches = c.coveredBranches.length;

              // Top 3 tuners (with percentages within this cell)
              const topTuners = TUNER_NAMES.filter(
                (t) => selectedTuners.has(t) && c.tunerCounts[t] > 0,
              )
                .map((t) => ({
                  tuner: t,
                  count: c.tunerCounts[t],
                  pct: trialCount > 0 ? (c.tunerCounts[t] / trialCount) * 100 : 0,
                }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 3);

              const isHovered = hoveredClusterId === c.id;
              return (
                <div
                  key={c.id}
                  onMouseEnter={() => onHoverChange?.(c.id)}
                  onMouseLeave={() => onHoverChange?.(null)}
                  style={{
                    background: isHovered ? "#EEF2FF" : "#FFFFFF",
                    border: isHovered ? "1px solid #4F46E5" : "1px solid #E2E8F0",
                    borderRadius: 6,
                    padding: "6px 8px",
                    boxShadow: isHovered ? "0 0 0 2px rgba(79,70,229,0.12)" : "none",
                    transition: "background 0.1s, border-color 0.1s, box-shadow 0.1s",
                  }}
                >
                  {/* Header: dominant badge + ID + trials + remove */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      marginBottom: 3,
                    }}
                  >
                    <span
                      style={{
                        background: TUNER_COLORS[dominant],
                        color: "#fff",
                        fontSize: 11,
                        fontWeight: 700,
                        borderRadius: 3,
                        padding: "1px 5px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {TUNER_DISPLAY_NAMES[dominant]}
                    </span>
                    <span
                      style={{
                        fontSize: 13,
                        color: "#374151",
                        fontWeight: 600,
                      }}
                    >
                      #{c.id + 1}
                    </span>
                    <span style={{ fontSize: 12, color: "#94A3B8" }}>
                      · {trialCount.toLocaleString()} trials
                    </span>
                    <span style={{ flex: 1 }} />
                    <button
                      onClick={() => onRemove(c.id)}
                      style={{
                        fontSize: 13,
                        color: "#94A3B8",
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: "0 4px",
                        lineHeight: 1,
                      }}
                      title="Remove from working set"
                    >
                      ×
                    </button>
                  </div>

                  {/* Coverage (branches) */}
                  <div
                    style={{ fontSize: 12, color: "#64748B", marginBottom: 4 }}
                  >
                    mean {meanBranches.toLocaleString()} · cum{" "}
                    {cumBranches.toLocaleString()} branches
                  </div>

                  {/* Stacked tuner bar */}
                  <StackedTunerBar
                    counts={c.tunerCounts}
                    selectedTuners={selectedTuners}
                    height={6}
                  />

                  {/* Top 3 tuners with pct */}
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "2px 6px",
                      marginTop: 4,
                      fontSize: 12,
                      color: "#64748B",
                    }}
                  >
                    {topTuners.map(({ tuner, pct }) => (
                      <span
                        key={tuner}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 3,
                        }}
                      >
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            background: TUNER_COLORS[tuner],
                            display: "inline-block",
                            flexShrink: 0,
                          }}
                        />
                        {TUNER_DISPLAY_NAMES[tuner]} {pct.toFixed(1)}%
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <div
            style={{
              fontSize: 11,
              color: "#CBD5E1",
              marginTop: 8,
              textAlign: "center",
              flexShrink: 0,
            }}
          >
            Shift+click cells to add/remove
          </div>
        </div>
      )}
    </div>
  );
}
