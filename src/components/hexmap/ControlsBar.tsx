import React from "react";
import type { ColorMode } from "./types";
import { TUNER_DISPLAY_NAMES } from "./types";
import {
  TUNER_COLORS,
  TUNER_NAMES,
  type TunerType,
} from "../../utils/hexMapUtils";

// ============================================================
// Mode tabs — paper-aligned: T1 + T2 + T3
// ============================================================

const MODE_TABS: { mode: ColorMode; label: string }[] = [
  { mode: "tuner-perf", label: "Tuner" },
  { mode: "tuner-param", label: "Parameter" },
  { mode: "complementary", label: "Complementary" },
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
  effectiveColorMode: ColorMode;

  coverageMetric: "mean" | "cumulative";
  setCoverageMetric: (v: "mean" | "cumulative") => void;

  selectedParam: string | null;
  onParamSelect: (param: string | null) => void;
  paramList: { name: string; importance: number }[];

  t3Scores: {
    scores: Map<number, number>;
    maxScore: number;
    anchorBranchCount: number;
  } | null;
  cartSize: number;

  selectedTuners: Set<TunerType>;
  onToggleTuner: (tuner: TunerType) => void;
  /** Hovered tuner — used in Tuner mode to highlight that tuner's cells. */
  onHoverTuner?: (tuner: TunerType | null) => void;
  /** Pinned tuners (up to 2). Second pin renders cells as hatch pattern. */
  pinnedTuners?: TunerType[];
  /** Toggle pin: caller manages add/remove + max-2 cap. */
  onPinTuner?: (tuner: TunerType) => void;
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
  selectedParam,
  onParamSelect,
  paramList,
  t3Scores,
  cartSize,
  selectedTuners,
  onToggleTuner,
  onHoverTuner,
  pinnedTuners,
  onPinTuner,
}: ControlsBarProps) {
  const [hoverEntered, setHoverEntered] = React.useState<TunerType | null>(null);
  const pinnedSet = new Set(pinnedTuners ?? []);
  const pinnedList = pinnedTuners ?? [];
  return (
    <div
      style={{
        borderBottom: "1px solid #E5E7EB",
        background: "#FAFBFC",
        fontSize: 13,
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
            alignItems: "center",
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

        {/* Tuner toggles */}
        <div style={{ display: "flex", gap: 3 }}>
          {TUNER_NAMES.map((t) => {
            const isOn = selectedTuners.has(t);
            const isLast = isOn && selectedTuners.size === 1;
            const color = TUNER_COLORS[t];
            const isPinned = pinnedSet.has(t);
            const pinIndex = pinnedList.indexOf(t); // 0 = solid, 1 = hatch
            const showPopup = hoverEntered === t || isPinned;
            return (
              <div
                key={t}
                style={{ position: "relative" }}
                onMouseEnter={() => {
                  setHoverEntered(t);
                  onHoverTuner?.(t);
                }}
                onMouseLeave={() => {
                  setHoverEntered(null);
                  onHoverTuner?.(null);
                }}
              >
                <button
                  onClick={() => {
                    if (isLast) return;
                    onToggleTuner(t);
                  }}
                  title={isLast ? `${t} (at least one must stay on)` : t}
                  style={{
                    padding: "3px 7px",
                    fontSize: 13,
                    fontWeight: 700,
                    lineHeight: 1.4,
                    color: isOn ? "#fff" : "#9CA3AF",
                    background: isOn ? color : "#F1F5F9",
                    border: `1px solid ${isOn ? color : "#E5E7EB"}`,
                    borderRadius: 4,
                    cursor: isLast ? "not-allowed" : "pointer",
                    opacity: isLast ? 0.85 : 1,
                    transition: "all 0.12s ease",
                    position: "relative",
                  }}
                >
                  {TUNER_DISPLAY_NAMES[t]}
                  {isPinned && (
                    <span
                      style={{
                        marginLeft: 4,
                        fontSize: 10,
                        verticalAlign: "middle",
                      }}
                    >
                      {pinIndex === 1 ? "▦" : "📌"}
                    </span>
                  )}
                </button>
                {showPopup && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onPinTuner?.(t);
                    }}
                    style={{
                      position: "absolute",
                      // Overlap the tuner button slightly so the mouse can
                      // travel from button to popup without crossing a gap
                      // that would fire onMouseLeave on the wrapper.
                      top: "calc(100% - 2px)",
                      left: "50%",
                      transform: "translateX(-50%)",
                      paddingTop: 6,
                      paddingBottom: 4,
                      paddingLeft: 8,
                      paddingRight: 8,
                      fontSize: 11,
                      fontWeight: 600,
                      color: isPinned ? "#fff" : color,
                      background: isPinned ? color : "white",
                      border: `1px solid ${color}`,
                      borderRadius: 4,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      boxShadow: "0 2px 6px rgba(0,0,0,0.12)",
                      zIndex: 50,
                    }}
                  >
                    {isPinned ? "Unpin" : "Pin"}
                  </button>
                )}
              </div>
            );
          })}
        </div>

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
                fontSize: 13,
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
            {(["mean", "cumulative"] as const).map(
              (m) => {
                const isActive = coverageMetric === m;
                return (
                  <button
                    key={m}
                    onClick={() => setCoverageMetric(m)}
                    style={{
                      padding: "3px 6px",
                      fontSize: 13,
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
                  fontSize: 13,
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
                <option value="">All (top 5)</option>
                {paramList.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name} ({p.importance.toFixed(1)})
                  </option>
                ))}
              </select>
            ) : (
              <span style={{ fontSize: 10, color: "#F59E0B", fontWeight: 600 }}>
                ← Select a parameter
              </span>
            )}
          </>
        )}

        {/* Complement hint / summary */}
        {effectiveColorMode === "complementary" && (
          <>
            {cartSize === 0 ? (
              <span style={{ fontSize: 13, color: "#64748B", fontWeight: 500 }}>
                Shift+click cells to build the working set
              </span>
            ) : t3Scores ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                }}
              >
                <span style={{ color: "#4F46E5", fontWeight: 600 }}>
                  Working set: {t3Scores.anchorBranchCount.toLocaleString()} branches
                </span>
                <span style={{ color: "#64748B" }}>·</span>
                <span style={{ color: "#10B981", fontWeight: 500 }}>
                  Best +{t3Scores.maxScore.toLocaleString()} new
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
