import { BsPinAngleFill } from "react-icons/bs";
import type { ColorMode } from "./types";
import { TUNER_DISPLAY_NAMES } from "./types";
import {
  TUNER_COLORS,
  type TunerType,
} from "../../utils/hexMapUtils";

// ============================================================
// Mode tabs — paper-aligned: T1 + T2 + T3
// ============================================================

// Complementary is no longer user-selectable — it activates automatically
// whenever the working set has at least one cell. Only the two base modes
// stay in the tab strip.
const MODE_TABS: { mode: ColorMode; label: string }[] = [
  { mode: "tuner-perf", label: "Tuner" },
  { mode: "tuner-param", label: "Parameter" },
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

  /** Tuner subset to render — depends on program (SE 6 vs HPO 4). */
  tunerNames: TunerType[];
  /** Display label for the score metric ("coverage" / "accuracy"). */
  metricLabel: string;
  /** Hovered tuner — used in Tuner mode to highlight that tuner's cells. */
  onHoverTuner?: (tuner: TunerType | null) => void;
  /** Pinned tuners (up to 2). Second pin renders cells as hatch pattern. */
  pinnedTuners?: TunerType[];
  /** Toggle pin: caller manages add/remove + max-2 cap. */
  onPinTuner?: (tuner: TunerType) => void;
  /** Coverage overlay toggle — layers a teal sequential wash on top of cells. */
  coverageOverlay: boolean;
  setCoverageOverlay: (v: boolean) => void;
  /** Hovered preview — fires true on mouseenter, false on mouseleave so the
    map can swap to a teal-only fill while the user is over the checkbox. */
  onHoverCoverage?: (hovered: boolean) => void;
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
  tunerNames,
  metricLabel,
  onHoverTuner,
  pinnedTuners,
  onPinTuner,
  coverageOverlay,
  setCoverageOverlay,
  onHoverCoverage,
}: ControlsBarProps) {
  const pinnedSet = new Set(pinnedTuners ?? []);
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

        {/* Tuner pin selectors — checkbox prefix toggles the pin (max 2,
          enforced by onPinTuner upstream). The colored label is informative
          only; clicking the checkbox is the only interaction. */}
        <div style={{ display: "flex", gap: 6 }}>
          {tunerNames.map((t, idx) => {
            const color = TUNER_COLORS[t];
            const isPinned = pinnedSet.has(t);
            const shortcutNum = idx + 1;
            return (
              <button
                key={t}
                type="button"
                onClick={() => onPinTuner?.(t)}
                onMouseEnter={() => onHoverTuner?.(t)}
                onMouseLeave={() => onHoverTuner?.(null)}
                title={`Shift+${shortcutNum}: preview ${t}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "3px 7px",
                  fontSize: 13,
                  fontWeight: 700,
                  lineHeight: 1.4,
                  color: "#fff",
                  background: color,
                  border: `1px solid ${color}`,
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    background: "rgba(255,255,255,0.25)",
                    padding: "0 4px",
                    borderRadius: 2,
                    lineHeight: 1.6,
                  }}
                >
                  {shortcutNum}
                </span>
                {TUNER_DISPLAY_NAMES[t]}
                {isPinned && (
                  <BsPinAngleFill
                    size={11}
                    style={{ marginLeft: 1 }}
                    aria-label="Pinned"
                  />
                )}
              </button>
            );
          })}
        </div>

        <Divider />

        {/* Coverage group: overlay toggle + metric selector. Sits in its own
          divided section so it reads as "tuners | coverage" rather than
          mixing with the tuner pins. */}
        <button
          type="button"
          onClick={() => setCoverageOverlay(!coverageOverlay)}
          onMouseEnter={() => onHoverCoverage?.(true)}
          onMouseLeave={() => onHoverCoverage?.(false)}
          title={`Shift+7: preview ${metricLabel}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 7px",
            fontSize: 13,
            fontWeight: 600,
            lineHeight: 1.4,
            color: coverageOverlay ? "#fff" : "#15803D",
            background: coverageOverlay ? "#15803D" : "#F0FDF4",
            border: `1px solid ${coverageOverlay ? "#15803D" : "#BBF7D0"}`,
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              background: coverageOverlay
                ? "rgba(255,255,255,0.25)"
                : "rgba(21,128,61,0.12)",
              padding: "0 4px",
              borderRadius: 2,
              lineHeight: 1.6,
            }}
          >
            7
          </span>
          {metricLabel.charAt(0).toUpperCase() + metricLabel.slice(1)}
          {coverageOverlay && (
            <BsPinAngleFill
              size={11}
              style={{ marginLeft: 1 }}
              aria-label="Pinned"
            />
          )}
        </button>

        {/* Coverage metric selector — always shown in tuner mode (the
          baseline coverage view), and also surfaced in parameter / other
          modes once the Coverage overlay is pinned, since the overlay's
          fill depends on this metric. */}
        {(effectiveColorMode === "tuner-perf" || coverageOverlay) && (
          <div style={{ display: "flex", gap: 2 }}>
            {(["cumulative", "mean"] as const).map(
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

        <Divider />

        {/* === Other contextual options per mode === */}

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
