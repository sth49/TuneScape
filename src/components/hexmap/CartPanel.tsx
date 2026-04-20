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
  if (cartIds.size === 0) return null;

  const unionCovPct = cartData
    ? (cartData.unionCoverage * 100).toFixed(1)
    : "—";
  const unionBranchCount = cartData?.unionBranches.size ?? 0;

  return (
    <div
      style={{
        background: "white",
        borderRadius: 10,
        boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
        border: "1px solid #F59E0B",
        padding: "10px 14px",
        fontSize: 12,
        marginBottom: 8,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
          borderBottom: "1px solid #FEF3C7",
          paddingBottom: 6,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 13, color: "#92400E" }}>
          Working Set ({cartIds.size})
        </span>
        <button
          onClick={onClear}
          style={{
            fontSize: 10,
            color: "#DC2626",
            background: "#FEF2F2",
            border: "1px solid #FECACA",
            borderRadius: 4,
            padding: "2px 8px",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          Clear
        </button>
      </div>

      {/* Union stats */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 4,
          marginBottom: 8,
        }}
      >
        <div
          style={{
            background: "#FFFBEB",
            borderRadius: 6,
            padding: "5px 8px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 8, color: "#92400E", marginBottom: 1 }}>
            Union Coverage
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#B45309" }}>
            {unionCovPct}%
          </div>
        </div>
        <div
          style={{
            background: "#FFFBEB",
            borderRadius: 6,
            padding: "5px 8px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 8, color: "#92400E", marginBottom: 1 }}>
            Branches
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#B45309" }}>
            {unionBranchCount.toLocaleString()}
          </div>
        </div>
      </div>

      {/* Cell list */}
      <div style={{ maxHeight: 180, overflowY: "auto" }}>
        {cartData?.clusters.map((c) => {
          const filteredCounts = Object.fromEntries(
            TUNER_NAMES.filter((t) => selectedTuners.has(t)).map((t) => [
              t,
              c.tunerCounts[t],
            ]),
          ) as Record<TunerType, number>;
          const dominant = getDominantTuner(filteredCounts);
          const trialCount = TUNER_NAMES.filter((t) => selectedTuners.has(t))
            .reduce((s, t) => s + c.tunerCounts[t], 0);

          return (
            <div
              key={c.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 0",
                borderBottom: "1px solid #F5F5F4",
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
              <span style={{ fontSize: 10, color: "#374151", fontWeight: 500 }}>
                #{c.id + 1}
              </span>
              <span style={{ fontSize: 9, color: "#9CA3AF" }}>
                {trialCount}t
              </span>
              <span style={{ flex: 1 }} />
              <button
                onClick={() => onRemove(c.id)}
                style={{
                  fontSize: 10,
                  color: "#9CA3AF",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "0 2px",
                  lineHeight: 1,
                }}
                title="Remove from cart"
              >
                x
              </button>
            </div>
          );
        })}
      </div>

      <div
        style={{
          fontSize: 9,
          color: "#9CA3AF",
          marginTop: 6,
          textAlign: "center",
        }}
      >
        Shift+click cells to add/remove
      </div>
    </div>
  );
}
