import React from "react";
import {
  TUNER_NAMES,
  type TunerType,
} from "../../utils/hexMapUtils";
import {
  TUNER_DISPLAY_NAMES,
  type ColorMode,
} from "./types";

// ============================================================
// Mode tabs — flat list
// ============================================================

const MODE_TABS: { mode: ColorMode; label: string }[] = [
  { mode: "tuner-perf", label: "Tuner × Coverage" },
  { mode: "tuner-param", label: "Tuner × Parameter" },
  // { mode: "coverage", label: "Coverage" },
  // { mode: "density", label: "Density" },
  // { mode: "compare", label: "Compare" },
  { mode: "complementary", label: "Complement" },
];

// ============================================================
// Props
// ============================================================

interface LevelInfo {
  clusters: unknown[];
}

export interface ControlsBarProps {
  detailLevel: number;
  setDetailLevel: (v: number) => void;
  allLevels: LevelInfo[];

  colorMode: ColorMode;
  setColorMode: (v: ColorMode) => void;
  previewColorMode: ColorMode | null;
  setPreviewColorMode: (v: ColorMode | null) => void;
  effectiveColorMode: ColorMode;

  coverageMetric: "mean" | "min" | "max" | "marginal" | "cumulative";
  setCoverageMetric: (
    v: "mean" | "min" | "max" | "marginal" | "cumulative",
  ) => void;
  globalCovRange: { min: number; max: number; mean: number };

  compareTunerA: TunerType;
  setCompareTunerA: (v: TunerType) => void;
  compareTunerB: TunerType;
  setCompareTunerB: (v: TunerType) => void;
  compareDiffMax: number;

  densityMax: number;

  selectedParam: string | null;
  onParamSelect: (param: string | null) => void;
  paramList: { name: string; importance: number }[];

  t1ShowDensity: boolean;
  setT1ShowDensity: React.Dispatch<React.SetStateAction<boolean>>;
  t1DominantBasis: "density" | "coverage";
  setT1DominantBasis: React.Dispatch<
    React.SetStateAction<"density" | "coverage">
  >;

  t3Scores: {
    scores: Map<number, number>;
    maxScore: number;
    anchorBranchCount: number;
  } | null;
  t3AnchorId: number | null;
}

// ============================================================
// Component
// ============================================================

export function ControlsBar({
  detailLevel,
  setDetailLevel,
  allLevels,
  colorMode,
  setColorMode,
  effectiveColorMode,
  coverageMetric,
  setCoverageMetric,
  globalCovRange,
  compareTunerA,
  setCompareTunerA,
  compareTunerB,
  setCompareTunerB,
  compareDiffMax,
  densityMax,
  selectedParam,
  onParamSelect,
  paramList,
  t1ShowDensity,
  setT1ShowDensity,
  t1DominantBasis,
  setT1DominantBasis,
  t3Scores,
  t3AnchorId,
}: ControlsBarProps) {
  return (
    <div
      style={{
        borderBottom: "1px solid #E5E7EB",
        background: "#FAFBFC",
        fontSize: 11,
      }}
    >
      {/* Single row: Detail level | Mode tabs | Contextual options */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 40,
          borderBottom: "1px solid #E5E7EB",
        }}
      >
        {/* Detail Level: 🔍 − L# + */}
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#9CA3AF"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <button
          onClick={() => setDetailLevel(Math.max(0, detailLevel - 1))}
          disabled={detailLevel === 0}
          style={{
            width: 20,
            height: 20,
            display: "flex",
            justifyContent: "center",
            border: "1px solid #E5E7EB",
            borderRadius: 4,
            background: "white",
            color: detailLevel === 0 ? "#D1D5DB" : "#374151",
            cursor: detailLevel === 0 ? "default" : "pointer",
            fontSize: 14,
            lineHeight: 1,
          }}
        >
          −
        </button>
        <span
          title={`${allLevels[detailLevel]?.clusters.length ?? "…"} clusters`}
          style={{
            fontWeight: 700,
            color: "#4F46E5",
            minWidth: 22,
            textAlign: "center",
            fontSize: 11,
          }}
        >
          L{detailLevel}
        </span>
        <button
          onClick={() => setDetailLevel(Math.min(4, detailLevel + 1))}
          disabled={detailLevel === 4}
          style={{
            width: 20,
            height: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid #E5E7EB",
            borderRadius: 4,
            background: "white",
            color: detailLevel === 4 ? "#D1D5DB" : "#374151",
            cursor: detailLevel === 4 ? "default" : "pointer",
            fontSize: 14,
            lineHeight: 1,
          }}
        >
          +
        </button>

        <Divider />

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

        {/* Tuner modes shared: dominant basis dropdown + density checkbox */}
        {(effectiveColorMode === "tuner-perf" || effectiveColorMode === "tuner-param") && (
          <>
            <span style={{ fontSize: 11, color: "#9CA3AF", fontWeight: 600 }}>
              Outer:
            </span>
            <select
              value={t1DominantBasis}
              onChange={(e) => setT1DominantBasis(e.target.value as "density" | "coverage")}
              style={{
                fontSize: 11,
                padding: "3px 6px",
                borderRadius: 4,
                border: "1px solid #4F46E5",
                background: "#EEF2FF",
                color: "#4F46E5",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              <option value="density">Who explored more (trials)</option>
              <option value="coverage">Who covered more (cum.cov)</option>
            </select>
            <Divider />
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                color: t1ShowDensity ? "#4F46E5" : "#6B7280",
                cursor: "pointer",
                fontWeight: 600,
                userSelect: "none",
              }}
            >
              <input
                type="checkbox"
                checked={t1ShowDensity}
                onChange={() => setT1ShowDensity((v) => !v)}
                style={{ width: 12, height: 12, accentColor: "#4F46E5" }}
              />
              Density
            </label>
          </>
        )}

        {/* Tuner×Coverage: coverage metric selector */}
        {effectiveColorMode === "tuner-perf" && (
          <>
            <Divider />
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
          </>
        )}

        {/* Tuner×Parameter: param select */}
        {effectiveColorMode === "tuner-param" && (
          <>
            <Divider />
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

        {/* Coverage: metric selector + legend */}
        {effectiveColorMode === "coverage" && (
          <>
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
            {/* Coverage legend moved to SVG overlay */}
          </>
        )}

        {/* Density legend */}
        {effectiveColorMode === "density" && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ position: "relative", width: 120, height: 8 }}>
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    borderRadius: 4,
                    background:
                      "linear-gradient(to right, #FFFFCC, #FEB24C, #F03B20, #BD0026)",
                    border: "1px solid #E5E7EB",
                  }}
                />
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  width: 120,
                  fontSize: 7,
                  color: "#6B7280",
                  fontWeight: 600,
                }}
              >
                <span>0</span>
                <span>{densityMax.toLocaleString()} trials</span>
              </div>
            </div>
          </>
        )}

        {/* Compare: tuner A vs B selector + diverging legend */}
        {effectiveColorMode === "compare" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <select
                value={compareTunerA}
                onChange={(e) =>
                  setCompareTunerA(e.target.value as TunerType)
                }
                style={{
                  fontSize: 9,
                  padding: "2px 4px",
                  borderRadius: 3,
                  border: "1px solid #2563EB",
                  background: "#EFF6FF",
                  color: "#1D4ED8",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {TUNER_NAMES.filter((t) => t !== compareTunerB).map((t) => (
                  <option key={t} value={t}>
                    {TUNER_DISPLAY_NAMES[t]}
                  </option>
                ))}
              </select>
              <span
                style={{ fontSize: 9, color: "#6B7280", fontWeight: 600 }}
              >
                vs
              </span>
              <select
                value={compareTunerB}
                onChange={(e) =>
                  setCompareTunerB(e.target.value as TunerType)
                }
                style={{
                  fontSize: 9,
                  padding: "2px 4px",
                  borderRadius: 3,
                  border: "1px solid #DC2626",
                  background: "#FEF2F2",
                  color: "#DC2626",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {TUNER_NAMES.filter((t) => t !== compareTunerA).map((t) => (
                  <option key={t} value={t}>
                    {TUNER_DISPLAY_NAMES[t]}
                  </option>
                ))}
              </select>
            </div>
            {(() => {
              const barW = 140;
              return (
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 2 }}
                >
                  <div
                    style={{
                      width: barW,
                      height: 8,
                      borderRadius: 4,
                      background:
                        "linear-gradient(to right, #DC2626, #FFFFFF 50%, #2563EB)",
                      border: "1px solid #E5E7EB",
                    }}
                  />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      width: barW,
                      fontSize: 7,
                      color: "#6B7280",
                      fontWeight: 600,
                    }}
                  >
                    <span style={{ color: "#DC2626" }}>
                      {TUNER_DISPLAY_NAMES[compareTunerB]}
                    </span>
                    <span>0</span>
                    <span style={{ color: "#2563EB" }}>
                      {TUNER_DISPLAY_NAMES[compareTunerA]}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 7,
                      color: "#9CA3AF",
                      textAlign: "center",
                      width: barW,
                    }}
                  >
                    {"\u0394"} {"\u00B1"}
                    {compareDiffMax.toFixed(3)}
                  </div>
                </div>
              );
            })()}
          </>
        )}

        {/* Complement hint / summary */}
        {effectiveColorMode === "complementary" && (
          <>
            {t3AnchorId === null ? (
              <span style={{ fontSize: 8, color: "#64748B", fontWeight: 500 }}>
                Click a cell to find complementary regions
              </span>
            ) : t3Scores ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 8,
                }}
              >
                <span style={{ color: "#4F46E5", fontWeight: 600 }}>
                  Anchor: {t3Scores.anchorBranchCount} branches
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

// ============================================================
// Sub-components
// ============================================================

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
