import React, { useEffect, useState, useMemo } from "react";
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

const TUNER_DISPLAY: Record<string, string> = {
  SymTuner: "Sym",
  CMA_ES: "CMA",
  Genetic: "Gen",
  SuccessiveHalving: "SH",
  TPE: "TPE",
  BayesianOptimization: "BO",
  _combined: "All",
};

const TUNER_KEYS = [
  "_combined",
  "SymTuner",
  "CMA_ES",
  "Genetic",
  "SuccessiveHalving",
  "TPE",
  "BayesianOptimization",
] as const;

function getParamType(name: string): ParamType {
  if (BOOLEAN_PARAMS_SET.has(name)) return "boolean";
  if (CATEGORICAL_PARAMS_SET.has(name)) return "categorical";
  const base = name.split("__")[0];
  if (CATEGORICAL_PARAMS_SET.has(base)) return "categorical";
  return "numeric";
}

const TYPE_BADGE: Record<ParamType, { label: string; color: string; bg: string }> = {
  boolean: { label: "BIN", color: "#059669", bg: "#ECFDF5" },
  categorical: { label: "CAT", color: "#7C3AED", bg: "#F5F3FF" },
  numeric: { label: "NUM", color: "#2563EB", bg: "#EFF6FF" },
};

export interface ParameterPanelProps {
  program: string;
  selectedParam: string | null;
  onParamSelect: (param: string | null) => void;
  interactive?: boolean;
  separability?: Record<string, number>;
}

export function ParameterPanel({
  program,
  selectedParam,
  onParamSelect,
  interactive = true,
  separability = {},
}: ParameterPanelProps) {
  const [data, setData] = useState<ImportanceData | null>(null);
  const [selectedTuner, setSelectedTuner] = useState<string>("_combined");

  useEffect(() => {
    fetch("/data/param_importance.json")
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
  }, []);

  const params = useMemo(() => {
    if (!data || !data[program] || !data[program][selectedTuner]) return [];
    return data[program][selectedTuner];
  }, [data, program, selectedTuner]);

  const maxImportance = useMemo(
    () => (params.length > 0 ? params[0].importance : 1),
    [params],
  );

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
            fontSize: 15,
            color: "#1E293B",
            marginBottom: 8,
          }}
        >
          Parameter Importance
        </div>
        {/* Tuner selector */}
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
          {TUNER_KEYS.map((key) => {
            const isActive = selectedTuner === key;
            const tunerColor = key === "_combined" ? null : TUNER_COLORS[key as keyof typeof TUNER_COLORS];
            return (
              <button
                key={key}
                onClick={() => setSelectedTuner(key)}
                style={{
                  padding: "2px 7px",
                  fontSize: 11,
                  border: isActive ? "2px solid #374151" : "1px solid transparent",
                  borderRadius: 4,
                  background: tunerColor ?? "#F1F5F9",
                  color: tunerColor ? "#fff" : "#1E293B",
                  cursor: "pointer",
                  fontWeight: 700,
                  opacity: isActive ? 1 : 0.55,
                  transition: "opacity 0.12s ease",
                }}
              >
                {TUNER_DISPLAY[key] ?? key}
              </button>
            );
          })}
        </div>
      </div>

      {/* Parameter list */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "6px 10px 10px",
        }}
      >
        {params.map((p, i) => {
          const barWidth =
            maxImportance > 0 ? (p.importance / maxImportance) * 100 : 0;
          const ptype = getParamType(p.name);
          const badge = TYPE_BADGE[ptype];
          const isSelected = selectedParam === p.name;

          return (
            <div
              key={p.name}
              onClick={() => interactive && onParamSelect(isSelected ? null : p.name)}
              style={{
                marginBottom: 3,
                padding: "4px 6px",
                borderRadius: 6,
                cursor: interactive ? "pointer" : "default",
                background: isSelected ? "#EEF2FF" : "transparent",
                border: isSelected
                  ? "1px solid #4F46E5"
                  : "1px solid transparent",
                opacity: interactive ? 1 : 0.6,
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) => {
                if (!isSelected && interactive)
                  (e.currentTarget as HTMLElement).style.background = "#F8FAFC";
              }}
              onMouseLeave={(e) => {
                if (!isSelected && interactive)
                  (e.currentTarget as HTMLElement).style.background =
                    "transparent";
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 12,
                  marginBottom: 2,
                }}
              >
                {/* Type badge */}
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    color: badge.color,
                    background: badge.bg,
                    padding: "1px 4px",
                    borderRadius: 3,
                    flexShrink: 0,
                    letterSpacing: 0.3,
                  }}
                >
                  {badge.label}
                </span>
                {/* Name */}
                <span
                  style={{
                    color: isSelected ? "#4F46E5" : "#374151",
                    fontWeight: i < 10 ? 600 : 400,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                    minWidth: 0,
                  }}
                  title={p.name}
                >
                  {p.name}
                </span>
                {/* SHAP value + separability dot */}
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{
                      color: "#94A3B8",
                      fontSize: 11,
                      fontFamily: "monospace",
                    }}
                  >
                    {p.importance.toFixed(1)}
                  </span>
                  {separability[p.name] !== undefined && (
                    <span
                      title={`${Math.round(separability[p.name] * 100)}% non-mixed`}
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: separability[p.name] >= 0.5
                          ? "#10B981"
                          : separability[p.name] >= 0.3
                            ? "#F59E0B"
                            : "#E2E8F0",
                        display: "inline-block",
                        flexShrink: 0,
                      }}
                    />
                  )}
                </span>
              </div>
              <div
                style={{
                  height: 3,
                  background: "#F1F5F9",
                  borderRadius: 2,
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${barWidth}%`,
                    background: isSelected
                      ? "#4F46E5"
                      : i < 5
                        ? "#4F46E5"
                        : i < 10
                          ? "#818CF8"
                          : "#C7D2FE",
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
