import React from "react";
import type { ColorMode } from "./types";

// ============================================================
// Mode tabs — paper-aligned: T1 + T2 + T3
// ============================================================

const MODE_TABS: { mode: ColorMode; label: string }[] = [
  { mode: "tuner-perf", label: "Tuner × Coverage" },
  { mode: "tuner-param", label: "Tuner × Parameter" },
  { mode: "complementary", label: "Complement" },
];

// ============================================================
// Props
// ============================================================

export interface ControlsBarProps {
  colorMode: ColorMode;
  setColorMode: (v: ColorMode) => void;
  effectiveColorMode: ColorMode;

  coverageMetric: "mean" | "min" | "max" | "marginal" | "cumulative";
  setCoverageMetric: (
    v: "mean" | "min" | "max" | "marginal" | "cumulative",
  ) => void;

  selectedParam: string | null;
  onParamSelect: (param: string | null) => void;
  paramList: { name: string; importance: number }[];

  t3Scores: {
    scores: Map<number, number>;
    maxScore: number;
    anchorBranchCount: number;
  } | null;
  cartSize: number;
}

// ============================================================
// Component
// ============================================================

export function ControlsBar({
  colorMode,
  setColorMode,
  effectiveColorMode,
  coverageMetric,
  setCoverageMetric,
  selectedParam,
  onParamSelect,
  paramList,
  t3Scores,
  cartSize,
}: ControlsBarProps) {
  return (
    <div
      style={{
        borderBottom: "1px solid #E5E7EB",
        background: "#FAFBFC",
        fontSize: 11,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 40,
          borderBottom: "1px solid #E5E7EB",
          paddingLeft: 8,
        }}
      >
        {/* Mode tabs */}
        {MODE_TABS.map(({ mode, label }) => {
          const isActive = colorMode === mode;
          return (
            <button
              key={mode}
              onClick={() => setColorMode(mode)}
              style={{
                padding: "6px 8px",
                fontSize: 11,
                fontWeight: isActive ? 700 : 500,
                color: isActive ? "#4F46E5" : "#6B7280",
                background: "transparent",
                border: "none",
                borderBottom: isActive
                  ? "2px solid #4F46E5"
                  : "2px solid transparent",
                cursor: "pointer",
                transition: "all 0.12s ease",
                whiteSpace: "nowrap",
              }}
            >
              {label}
            </button>
          );
        })}

        <Divider />

        {/* === Contextual options per mode === */}

        {/* Tuner×Coverage: coverage metric selector */}
        {effectiveColorMode === "tuner-perf" && (
          <div style={{ display: "flex", gap: 2 }}>
            {(["mean", "min", "max", "marginal", "cumulative"] as const).map(
              (m) => {
                const isActive = coverageMetric === m;
                return (
                  <button
                    key={m}
                    onClick={() => setCoverageMetric(m)}
                    style={{
                      padding: "3px 6px",
                      fontSize: 11,
                      border: "1px solid",
                      borderColor: isActive ? "#4F46E5" : "#E5E7EB",
                      borderRadius: 3,
                      background: isActive ? "#EEF2FF" : "white",
                      color: isActive ? "#4F46E5" : "#6B7280",
                      cursor: "pointer",
                      fontWeight: isActive ? 600 : 400,
                    }}
                  >
                    {m}
                  </button>
                );
              },
            )}
          </div>
        )}

        {/* Tuner×Parameter: param select */}
        {effectiveColorMode === "tuner-param" && (
          <>
            {paramList.length > 0 ? (
              <select
                value={selectedParam ?? ""}
                onChange={(e) => onParamSelect(e.target.value || null)}
                style={{
                  fontSize: 11,
                  padding: "3px 6px",
                  borderRadius: 4,
                  border: "1px solid #4F46E5",
                  background: "#EEF2FF",
                  color: "#4F46E5",
                  fontWeight: 600,
                  cursor: "pointer",
                  maxWidth: 220,
                }}
              >
                {paramList.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name} ({p.importance.toFixed(1)})
                  </option>
                ))}
              </select>
            ) : (
              <span style={{ fontSize: 8, color: "#F59E0B", fontWeight: 600 }}>
                ← Select a parameter
              </span>
            )}
          </>
        )}

        {/* Complement hint / summary */}
        {effectiveColorMode === "complementary" && (
          <>
            {cartSize === 0 ? (
              <span style={{ fontSize: 11, color: "#64748B", fontWeight: 500 }}>
                Shift+click cells to build the working set
              </span>
            ) : t3Scores ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 11,
                }}
              >
                <span style={{ color: "#4F46E5", fontWeight: 600 }}>
                  Working set: {t3Scores.anchorBranchCount} branches
                </span>
                <span style={{ color: "#64748B" }}>·</span>
                <span style={{ color: "#10B981", fontWeight: 500 }}>
                  Best +{t3Scores.maxScore} new
                </span>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** Thin vertical divider */
function Divider() {
  return (
    <div
      style={{
        width: 1,
        height: 14,
        background: "#E5E7EB",
        margin: "0 2px",
        flexShrink: 0,
      }}
    />
  );
}
