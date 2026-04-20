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
}

export function CartPanel({
  cartIds,
  cartData,
  selectedTuners,
  onRemove,
  onClear,
}: CartPanelProps) {
  const empty = cartIds.size === 0;

  const unionCovPct = cartData
    ? (cartData.unionCoverage * 100).toFixed(1)
    : "—";
  const unionBranchCount = cartData?.unionBranches.size ?? 0;

  return (
    <div
      style={{
        background: "white",
        borderRadius: 10,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header — matches TunerSummary / ParameterPanel style */}
      <div
        style={{
          padding: "10px 14px 8px",
          borderBottom: empty ? "none" : "1px solid #F1F5F9",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 15, color: "#1E293B" }}>
          Working Set{!empty && ` (${cartIds.size})`}
        </span>
        {!empty && (
          <button
            onClick={onClear}
            style={{
              fontSize: 10,
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
            fontSize: 11,
            textAlign: "center",
            padding: "16px 14px 12px",
          }}
        >
          Shift+click cells to add.
        </div>
      )}

      {/* Non-empty content */}
      {!empty && (
        <div style={{ padding: "6px 14px 8px" }}>
          {/* Union stats */}
          <div
            style={{
              display: "flex",
              gap: 12,
              marginBottom: 10,
              fontSize: 11,
              color: "#64748B",
            }}
          >
            <span>
              Union <span style={{ fontWeight: 600, color: "#1E293B" }}>{unionCovPct}%</span>
            </span>
            <span>
              Branches <span style={{ fontWeight: 600, color: "#1E293B" }}>{unionBranchCount.toLocaleString()}</span>
            </span>
          </div>

          {/* Cell detail list */}
          <div
            style={{
              maxHeight: 300,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 6,
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

              // Mean coverage
              const filteredTrials = c.trials.filter((t) =>
                selectedTuners.has(t.tuner),
              );
              const meanCov =
                filteredTrials.length > 0
                  ? filteredTrials.reduce((s, t) => s + t.coverage, 0) /
                    filteredTrials.length
                  : 0;
              const meanPct = (meanCov * 100).toFixed(1);

              // Cumulative coverage
              const tub = cartData.totalUniqueBranches || 1;
              const cumPct = (
                (c.coveredBranches.length / tub) *
                100
              ).toFixed(1);

              // Top 3 tuners
              const tunerList = TUNER_NAMES.filter(
                (t) => selectedTuners.has(t) && c.tunerCounts[t] > 0,
              )
                .map((t) => ({ tuner: t, count: c.tunerCounts[t] }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 3);

              return (
                <div
                  key={c.id}
                  style={{
                    background: "#F8FAFC",
                    borderRadius: 6,
                    padding: "6px 8px",
                  }}
                >
                  {/* Line 1: badge + ID + trials + remove */}
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
                        fontSize: 9,
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
                        fontSize: 11,
                        color: "#374151",
                        fontWeight: 600,
                      }}
                    >
                      #{c.id + 1}
                    </span>
                    <span style={{ fontSize: 10, color: "#94A3B8" }}>
                      · {trialCount} trials
                    </span>
                    <span style={{ flex: 1 }} />
                    <button
                      onClick={() => onRemove(c.id)}
                      style={{
                        fontSize: 11,
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

                  {/* Line 2: Coverage */}
                  <div
                    style={{ fontSize: 10, color: "#64748B", marginBottom: 2 }}
                  >
                    Coverage: mean {meanPct}%, cum {cumPct}%
                  </div>

                  {/* Line 3: Top 3 tuners */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 10,
                      color: "#64748B",
                    }}
                  >
                    {tunerList.map(({ tuner, count }) => (
                      <span
                        key={tuner}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 2,
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
                        {TUNER_DISPLAY_NAMES[tuner]} {count}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <div
            style={{
              fontSize: 9,
              color: "#CBD5E1",
              marginTop: 8,
              textAlign: "center",
            }}
          >
            Shift+click cells to add/remove
          </div>
        </div>
      )}
    </div>
  );
}
