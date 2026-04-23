import React, { useEffect, useMemo, useState } from "react";
import {
  BOOLEAN_PARAMS_SET,
  CATEGORICAL_PARAMS_SET,
} from "./hexmap/types";
import { TUNER_COLORS } from "../utils/hexMapUtils";

interface ParamImportance {
  name: string;
  importance: number;
}

type ParamType = "boolean" | "categorical" | "numeric";

type ImportanceData = Record<string, Record<string, ParamImportance[]>>;

const TUNER_SHORT: Record<string, string> = {
  _combined: "All",
  SymTuner: "Sym",
  CMA_ES: "CMA",
  Genetic: "Gen",
  SuccessiveHalving: "SH",
  TPE: "TPE",
  BayesianOptimization: "BO",
};

const TUNER_COLUMNS = [
  "_combined",
  "SymTuner",
  "CMA_ES",
  "Genetic",
  "SuccessiveHalving",
  "TPE",
  "BayesianOptimization",
] as const;

type TunerKey = (typeof TUNER_COLUMNS)[number];

function getParamType(name: string): ParamType {
  if (BOOLEAN_PARAMS_SET.has(name)) return "boolean";
  if (CATEGORICAL_PARAMS_SET.has(name)) return "categorical";
  const base = name.split("__")[0];
  if (CATEGORICAL_PARAMS_SET.has(base)) return "categorical";
  return "numeric";
}

/** Row-normalized sequential greys. 0 → white, 1 → dark. */
function greysColor(t: number) {
  const clamped = Math.max(0, Math.min(1, t));
  const v = Math.round(255 - clamped * 195); // 255 → 60
  return `rgb(${v},${v},${v})`;
}

const CELL = 26;
const CELL_GAP = 5;
const ROW_H = 28;
const NAME_MIN = 100;
const NAME_MAX = 160;

const TOP_N = 15;
const DASH_THRESHOLD = 0.01; // value < 1% of globalMax → dash

const ALL_BADGE_COLOR = "#475569"; // slate — neutral for the aggregate column

function badgeColor(tuner: TunerKey): string {
  return tuner === "_combined"
    ? ALL_BADGE_COLOR
    : TUNER_COLORS[tuner as Exclude<TunerKey, "_combined">];
}

interface HeatRow {
  name: string;
  type: ParamType;
  values: Record<TunerKey, number | null>;
  allValue: number;
}

export interface ParameterPanelProps {
  program: string;
  selectedParam: string | null;
  onParamSelect: (param: string | null) => void;
  interactive?: boolean;
  /** Reserved: per-param separability (unused in heatmap view). */
  separability?: Record<string, number>;
}

export function ParameterPanel({
  program,
  selectedParam,
  onParamSelect,
  interactive = true,
}: ParameterPanelProps) {
  const [data, setData] = useState<ImportanceData | null>(null);
  const [sortKey, setSortKey] = useState<TunerKey>("_combined");
  const [showAll, setShowAll] = useState(false);
  const [hover, setHover] = useState<{
    row: string;
    col: TunerKey;
    value: number;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    fetch("/data/param_importance.json")
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
  }, []);

  const rows = useMemo<HeatRow[]>(() => {
    if (!data || !data[program]) return [];
    const blank = (): Record<TunerKey, number | null> => ({
      _combined: null,
      SymTuner: null,
      CMA_ES: null,
      Genetic: null,
      SuccessiveHalving: null,
      TPE: null,
      BayesianOptimization: null,
    });
    const paramMap = new Map<string, Record<TunerKey, number | null>>();
    for (const tuner of TUNER_COLUMNS) {
      const arr = data[program][tuner] ?? [];
      for (const p of arr) {
        if (!paramMap.has(p.name)) paramMap.set(p.name, blank());
        paramMap.get(p.name)![tuner] = p.importance;
      }
    }
    return Array.from(paramMap.entries()).map(([name, values]) => ({
      name,
      type: getParamType(name),
      values,
      allValue: values._combined ?? 0,
    }));
  }, [data, program]);

  // Pre-ranked rows by All importance.
  const rankedRows = useMemo(
    () => [...rows].sort((a, b) => b.allValue - a.allValue),
    [rows],
  );
  const topRows = useMemo(
    () => (showAll ? rankedRows : rankedRows.slice(0, TOP_N)),
    [rankedRows, showAll],
  );

  // Global max across the top-N × 7-tuners cell grid — basis for intensity.
  const globalMax = useMemo(() => {
    let m = 0;
    for (const r of topRows) {
      for (const t of TUNER_COLUMNS) {
        const v = r.values[t] ?? 0;
        if (v > m) m = v;
      }
    }
    return m;
  }, [topRows]);

  // Sort the top-N subset by the active column.
  const sortedRows = useMemo(
    () =>
      [...topRows].sort(
        (a, b) => (b.values[sortKey] ?? 0) - (a.values[sortKey] ?? 0),
      ),
    [topRows, sortKey],
  );

  const hiddenCount = Math.max(0, rankedRows.length - topRows.length);

  if (!data) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400 text-sm">
        Loading...
      </div>
    );
  }

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "white",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "10px 14px 8px",
          borderBottom: "1px solid #F1F5F9",
        }}
      >
        <div
          style={{
            fontWeight: 700,
            fontSize: 17,
            color: "#1E293B",
          }}
        >
          Parameter Importance
        </div>
      </div>

      {/* Heatmap (scroll container) */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          fontSize: 13,
        }}
      >
        {/* Sticky column headers — underline-tab style to distinguish from ControlsBar pills */}
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 2,
            background: "#F8FAFC",
            borderBottom: "1px solid #E5E7EB",
            display: "flex",
            alignItems: "flex-end",
            padding: "8px 12px 6px 8px",
            gap: CELL_GAP,
          }}
        >
          <div
            style={{
              flex: 1,
              minWidth: NAME_MIN,
              maxWidth: NAME_MAX,
              fontSize: 11,
              color: "#94A3B8",
              fontWeight: 600,
              letterSpacing: 0.4,
              textTransform: "uppercase",
            }}
          >
            Parameter
          </div>
          {TUNER_COLUMNS.map((tuner) => {
            const isActive = sortKey === tuner;
            const color = badgeColor(tuner);
            return (
              <div
                key={tuner}
                onClick={() => setSortKey(tuner)}
                title={`Sort by ${TUNER_SHORT[tuner]}`}
                style={{
                  width: CELL,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  gap: 3,
                  cursor: "pointer",
                  userSelect: "none",
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: isActive ? 700 : 500,
                    color: isActive ? color : "#64748B",
                    transition: "color 0.12s ease",
                    lineHeight: 1.2,
                  }}
                >
                  {TUNER_SHORT[tuner]}
                </span>
                <span
                  style={{
                    height: isActive ? 3 : 2,
                    width: "80%",
                    background: color,
                    borderRadius: 1,
                    opacity: isActive ? 1 : 0.35,
                    transition: "opacity 0.12s ease, height 0.12s ease",
                  }}
                />
              </div>
            );
          })}
        </div>

        {/* Data rows */}
        {sortedRows.map((r) => {
          const isSelected = selectedParam === r.name;
          return (
            <div
              key={r.name}
              onClick={() =>
                interactive && onParamSelect(isSelected ? null : r.name)
              }
              onMouseLeave={() => setHover(null)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: CELL_GAP,
                minHeight: ROW_H,
                padding: "6px 12px 6px 5px",
                borderLeft: isSelected
                  ? "3px solid #4F46E5"
                  : "3px solid transparent",
                background: isSelected ? "#EEF2FF" : "transparent",
                cursor: interactive ? "pointer" : "default",
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) => {
                if (!isSelected && interactive)
                  (e.currentTarget as HTMLElement).style.background =
                    "#F8FAFC";
              }}
              onMouseOut={(e) => {
                if (!isSelected && interactive)
                  (e.currentTarget as HTMLElement).style.background =
                    "transparent";
              }}
            >
              <div
                style={{
                  flex: 1,
                  minWidth: NAME_MIN,
                  maxWidth: NAME_MAX,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: isSelected ? "#4F46E5" : "#374151",
                  fontWeight: isSelected ? 600 : 500,
                  fontSize: 13,
                }}
                title={`${r.name} (${r.type})`}
              >
                {r.name}
              </div>
              {TUNER_COLUMNS.map((tuner) => {
                const v = r.values[tuner];
                const isEmpty =
                  v === null ||
                  globalMax <= 0 ||
                  v < DASH_THRESHOLD * globalMax;
                // sqrt compression on globally-normalized value
                const t =
                  globalMax > 0 && v !== null
                    ? Math.sqrt(Math.max(0, v) / globalMax)
                    : 0;
                const bg = isEmpty ? "#F8FAFC" : greysColor(t);
                const isHoverCell =
                  hover &&
                  hover.row === r.name &&
                  hover.col === tuner;
                return (
                  <div
                    key={tuner}
                    onMouseEnter={(e) => {
                      if (v !== null) {
                        setHover({
                          row: r.name,
                          col: tuner,
                          value: v,
                          x: e.clientX,
                          y: e.clientY,
                        });
                      }
                    }}
                    onMouseMove={(e) => {
                      if (v !== null) {
                        setHover({
                          row: r.name,
                          col: tuner,
                          value: v,
                          x: e.clientX,
                          y: e.clientY,
                        });
                      }
                    }}
                    style={{
                      width: CELL,
                      height: CELL,
                      background: bg,
                      borderRadius: 3,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: isEmpty ? "#CBD5E1" : t > 0.55 ? "#fff" : "#475569",
                      fontSize: 11,
                      outline: isHoverCell ? "1.5px solid #1E293B" : "none",
                      outlineOffset: -1,
                      flexShrink: 0,
                      boxSizing: "border-box",
                    }}
                  >
                    {isEmpty ? "─" : ""}
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* Show all / Show top N — subtle text link */}
        {rankedRows.length > TOP_N && (
          <div
            style={{
              padding: "6px 12px 10px",
              textAlign: "center",
            }}
          >
            <button
              onClick={() => setShowAll((v) => !v)}
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: "#94A3B8",
                background: "transparent",
                border: "none",
                padding: 2,
                cursor: "pointer",
                textDecoration: "underline",
                textUnderlineOffset: 2,
                transition: "color 0.12s ease",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.color = "#4F46E5";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.color = "#94A3B8";
              }}
            >
              {showAll
                ? `Show top ${TOP_N} only`
                : `+ ${hiddenCount} more parameters`}
            </button>
          </div>
        )}
      </div>

      {/* Cell hover tooltip (fixed to viewport) */}
      {hover && (
        <div
          style={{
            position: "fixed",
            left: hover.x + 12,
            top: hover.y + 12,
            background: "rgba(15,23,42,0.92)",
            color: "white",
            padding: "4px 8px",
            borderRadius: 4,
            fontSize: 11,
            pointerEvents: "none",
            zIndex: 9999,
            whiteSpace: "nowrap",
            boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
          }}
        >
          <span style={{ fontWeight: 600 }}>{hover.row}</span>
          <span style={{ color: "#CBD5E1" }}> · {TUNER_SHORT[hover.col]}: </span>
          <span style={{ fontFamily: "monospace" }}>
            {hover.value.toFixed(1)}
          </span>
        </div>
      )}
    </div>
  );
}
