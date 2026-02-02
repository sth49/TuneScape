import { useState, useEffect, useMemo, useRef } from "react";
import type { DecisionTreeData, DecisionTreeTunerData } from "../types/data";

const TUNER_COLORS: Record<string, string> = {
  SymTuner: "#4f46e5",
  CMA_ES: "#10b981",
  Genetic: "#f59e0b",
  SuccessiveHalving: "#ef4444",
  TPE: "#8b5cf6",
  BayesianOptimization: "#ec4899",
};

const TUNER_LABELS: Record<string, string> = {
  SymTuner: "SymTuner",
  CMA_ES: "CMA-ES",
  Genetic: "Genetic",
  SuccessiveHalving: "Successive Halving",
  TPE: "TPE",
  BayesianOptimization: "Bayesian Opt.",
};

interface ParamStats {
  name: string;
  isBoolean: boolean;
  importance: number;
  // For boolean params
  trueCount?: number;
  falseCount?: number;
  trueRatio?: number;
  // For numeric params
  min?: number;
  max?: number;
  mean?: number;
  std?: number;
  histogram?: number[];
  histogramBins?: number[];
}

interface TunerParamStats {
  tuner: string;
  color: string;
  params: ParamStats[];
}

export function ParameterSpaceComparison() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1200);

  const [data, setData] = useState<DecisionTreeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedProgram, setSelectedProgram] = useState("gawk");
  const [selectedTuners, setSelectedTuners] = useState<string[]>([
    "SymTuner",
    "CMA_ES",
    "Genetic",
    "SuccessiveHalving",
  ]);
  const [sortBy, setSortBy] = useState<"importance" | "name" | "variance">(
    "importance"
  );

  // Measure container width
  useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.offsetWidth);
      }
    };
    updateWidth();
    window.addEventListener("resize", updateWidth);
    return () => window.removeEventListener("resize", updateWidth);
  }, []);

  // Load data
  useEffect(() => {
    setLoading(true);
    fetch("/data/decision_tree_data.json")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load data");
        return res.json();
      })
      .then((json) => {
        setData(json);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const programs = useMemo(() => {
    if (!data) return [];
    return Object.keys(data);
  }, [data]);

  const availableTuners = useMemo(() => {
    if (!data || !data[selectedProgram]) return [];
    return Object.keys(data[selectedProgram]);
  }, [data, selectedProgram]);

  // Compute stats for each tuner
  const tunerStats = useMemo(() => {
    if (!data || !data[selectedProgram]) return [];

    const stats: TunerParamStats[] = [];

    for (const tuner of selectedTuners) {
      if (!data[selectedProgram][tuner]) continue;

      const tunerData: DecisionTreeTunerData = data[selectedProgram][tuner];
      const paramStats: ParamStats[] = [];

      for (const param of tunerData.param_importance) {
        const values = tunerData.trials.map((t) => t.parameters[param.name]);

        if (param.is_boolean) {
          const trueCount = values.filter((v) => v === true).length;
          const falseCount = values.filter((v) => v === false).length;
          paramStats.push({
            name: param.name,
            isBoolean: true,
            importance: param.importance,
            trueCount,
            falseCount,
            trueRatio: trueCount / (trueCount + falseCount),
          });
        } else {
          const numValues = values.filter(
            (v) => typeof v === "number"
          ) as number[];
          const min = Math.min(...numValues);
          const max = Math.max(...numValues);
          const mean = numValues.reduce((a, b) => a + b, 0) / numValues.length;
          const std = Math.sqrt(
            numValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) /
              numValues.length
          );

          // Create histogram
          const bins = 10;
          const binWidth = (max - min) / bins || 1;
          const histogram = new Array(bins).fill(0);
          const histogramBins: number[] = [];

          for (let i = 0; i <= bins; i++) {
            histogramBins.push(min + i * binWidth);
          }

          numValues.forEach((v) => {
            const binIdx = Math.min(Math.floor((v - min) / binWidth), bins - 1);
            if (binIdx >= 0) histogram[binIdx]++;
          });

          paramStats.push({
            name: param.name,
            isBoolean: false,
            importance: param.importance,
            min,
            max,
            mean,
            std,
            histogram,
            histogramBins,
          });
        }
      }

      stats.push({
        tuner,
        color: TUNER_COLORS[tuner] || "#6b7280",
        params: paramStats,
      });
    }

    return stats;
  }, [data, selectedProgram, selectedTuners]);

  // Get all unique parameters sorted
  const sortedParams = useMemo(() => {
    if (tunerStats.length === 0) return [];

    // Get all unique param names with their max importance
    const paramMap = new Map<
      string,
      { name: string; importance: number; isBoolean: boolean }
    >();

    for (const ts of tunerStats) {
      for (const p of ts.params) {
        const existing = paramMap.get(p.name);
        if (!existing || p.importance > existing.importance) {
          paramMap.set(p.name, {
            name: p.name,
            importance: p.importance,
            isBoolean: p.isBoolean,
          });
        }
      }
    }

    let params = Array.from(paramMap.values());

    if (sortBy === "importance") {
      params.sort((a, b) => b.importance - a.importance);
    } else if (sortBy === "name") {
      params.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortBy === "variance") {
      // Sort by variance across tuners
      params.sort((a, b) => {
        const aVariance = computeVariance(a.name);
        const bVariance = computeVariance(b.name);
        return bVariance - aVariance;
      });
    }

    return params.slice(0, 15); // Top 15 params
  }, [tunerStats, sortBy]);

  function computeVariance(paramName: string): number {
    const values: number[] = [];
    for (const ts of tunerStats) {
      const param = ts.params.find((p) => p.name === paramName);
      if (param) {
        if (param.isBoolean) {
          values.push(param.trueRatio || 0);
        } else {
          values.push(param.mean || 0);
        }
      }
    }
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  }

  const toggleTuner = (tuner: string) => {
    setSelectedTuners((prev) => {
      if (prev.includes(tuner)) {
        return prev.filter((t) => t !== tuner);
      } else {
        return [...prev, tuner];
      }
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-10">
        <span className="loading loading-spinner loading-lg text-primary"></span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="alert alert-error">
        <span>Error: {error || "No data"}</span>
      </div>
    );
  }

  const cellWidth = Math.min(
    180,
    (containerWidth - 200) / selectedTuners.length
  );
  const rowHeight = 50;
  const paramLabelWidth = 140;

  return (
    <div ref={containerRef} className="flex flex-col gap-4 w-full">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4 p-3 bg-base-200 rounded-lg">
        {/* Program selector */}
        <div className="form-control">
          <label className="label py-0">
            <span className="label-text text-xs font-medium">Program</span>
          </label>
          <select
            className="select select-bordered select-sm w-32"
            value={selectedProgram}
            onChange={(e) => setSelectedProgram(e.target.value)}
          >
            {programs.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        {/* Sort by */}
        <div className="form-control">
          <label className="label py-0">
            <span className="label-text text-xs font-medium">Sort by</span>
          </label>
          <select
            className="select select-bordered select-sm w-36"
            value={sortBy}
            onChange={(e) =>
              setSortBy(e.target.value as "importance" | "name" | "variance")
            }
          >
            <option value="importance">Importance</option>
            <option value="variance">Cross-Tuner Variance</option>
            <option value="name">Name</option>
          </select>
        </div>

        {/* Tuner toggles */}
        <div className="form-control">
          <label className="label py-0">
            <span className="label-text text-xs font-medium">Tuners</span>
          </label>
          <div className="flex gap-1">
            {availableTuners.map((tuner) => (
              <button
                key={tuner}
                className={`btn btn-xs ${selectedTuners.includes(tuner) ? "" : "btn-ghost opacity-50"}`}
                style={{
                  backgroundColor: selectedTuners.includes(tuner)
                    ? TUNER_COLORS[tuner]
                    : undefined,
                  color: selectedTuners.includes(tuner) ? "white" : undefined,
                  borderColor: TUNER_COLORS[tuner],
                }}
                onClick={() => toggleTuner(tuner)}
              >
                {TUNER_LABELS[tuner] || tuner}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Matrix */}
      <div className="overflow-x-auto">
        <div className="min-w-fit">
          {/* Header row */}
          <div className="flex items-end border-b border-gray-300 pb-2 mb-2">
            <div style={{ width: paramLabelWidth }} className="flex-shrink-0">
              <span className="text-xs font-semibold text-gray-500">
                Parameter
              </span>
            </div>
            {selectedTuners.map((tuner) => {
              const ts = tunerStats.find((t) => t.tuner === tuner);
              if (!ts) return null;
              return (
                <div
                  key={tuner}
                  style={{ width: cellWidth }}
                  className="flex-shrink-0 text-center"
                >
                  <div
                    className="text-xs font-semibold"
                    style={{ color: ts.color }}
                  >
                    {TUNER_LABELS[tuner] || tuner}
                  </div>
                  <div className="text-[10px] text-gray-400">
                    {data[selectedProgram][tuner]?.trials.length || 0} trials
                  </div>
                </div>
              );
            })}
          </div>

          {/* Parameter rows */}
          {sortedParams.map((param, rowIdx) => (
            <div
              key={param.name}
              className={`flex items-center ${rowIdx % 2 === 0 ? "bg-gray-50" : ""}`}
              style={{ height: rowHeight }}
            >
              {/* Param label */}
              <div
                style={{ width: paramLabelWidth }}
                className="flex-shrink-0 pr-2"
              >
                <div
                  className="text-xs font-medium text-gray-700 truncate"
                  title={param.name}
                >
                  {param.name}
                </div>
                <div className="text-[10px] text-gray-400">
                  {param.isBoolean ? "bool" : "numeric"} · imp:{" "}
                  {param.importance.toFixed(1)}
                </div>
              </div>

              {/* Cells for each tuner */}
              {selectedTuners.map((tuner) => {
                const ts = tunerStats.find((t) => t.tuner === tuner);
                const ps = ts?.params.find((p) => p.name === param.name);

                if (!ps) {
                  return (
                    <div
                      key={tuner}
                      style={{ width: cellWidth }}
                      className="flex-shrink-0 flex items-center justify-center"
                    >
                      <span className="text-xs text-gray-300">-</span>
                    </div>
                  );
                }

                return (
                  <div
                    key={tuner}
                    style={{ width: cellWidth }}
                    className="flex-shrink-0 px-1"
                  >
                    {ps.isBoolean ? (
                      <BooleanCell
                        trueRatio={ps.trueRatio || 0}
                        trueCount={ps.trueCount || 0}
                        falseCount={ps.falseCount || 0}
                        color={ts?.color || "#6b7280"}
                        width={cellWidth - 8}
                      />
                    ) : (
                      <HistogramCell
                        histogram={ps.histogram || []}
                        min={ps.min || 0}
                        max={ps.max || 0}
                        mean={ps.mean || 0}
                        color={ts?.color || "#6b7280"}
                        width={cellWidth - 8}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex gap-6 text-xs text-gray-500 mt-2 px-2">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-gradient-to-r from-gray-200 to-indigo-500 rounded"></div>
          <span>Boolean: True ratio (darker = more true)</span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="24" height="12">
            <rect x="0" y="6" width="6" height="6" fill="#ddd" />
            <rect x="6" y="3" width="6" height="9" fill="#aaa" />
            <rect x="12" y="0" width="6" height="12" fill="#888" />
            <rect x="18" y="4" width="6" height="8" fill="#bbb" />
          </svg>
          <span>Numeric: Distribution histogram</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-1 h-3 bg-red-500 rounded"></div>
          <span>Mean value indicator</span>
        </div>
      </div>
    </div>
  );
}

function BooleanCell({
  trueRatio,
  trueCount,
  falseCount,
  color,
  width,
}: {
  trueRatio: number;
  trueCount: number;
  falseCount: number;
  color: string;
  width: number;
}) {
  const height = 32;

  return (
    <div className="relative" title={`True: ${trueCount}, False: ${falseCount}`}>
      <svg width={width} height={height}>
        {/* Background */}
        <rect width={width} height={height} fill="#f3f4f6" rx={3} />
        {/* True portion */}
        <rect
          width={width * trueRatio}
          height={height}
          fill={color}
          opacity={0.7}
          rx={3}
        />
        {/* Labels */}
        <text
          x={4}
          y={height / 2 + 4}
          fontSize={10}
          fill={trueRatio > 0.3 ? "white" : "#374151"}
          fontWeight={500}
        >
          T:{trueCount}
        </text>
        <text
          x={width - 4}
          y={height / 2 + 4}
          fontSize={10}
          fill={trueRatio < 0.7 ? "#374151" : "white"}
          fontWeight={500}
          textAnchor="end"
        >
          F:{falseCount}
        </text>
      </svg>
    </div>
  );
}

function HistogramCell({
  histogram,
  min,
  max,
  mean,
  color,
  width,
}: {
  histogram: number[];
  min: number;
  max: number;
  mean: number;
  color: string;
  width: number;
}) {
  const height = 32;
  const maxCount = Math.max(...histogram, 1);
  const barWidth = width / histogram.length - 1;

  // Mean position
  const meanX = ((mean - min) / (max - min || 1)) * width;

  return (
    <div className="relative" title={`Range: [${min.toFixed(1)}, ${max.toFixed(1)}], Mean: ${mean.toFixed(1)}`}>
      <svg width={width} height={height}>
        {/* Background */}
        <rect width={width} height={height} fill="#f9fafb" rx={3} />
        {/* Histogram bars */}
        {histogram.map((count, i) => (
          <rect
            key={i}
            x={i * (barWidth + 1)}
            y={height - (count / maxCount) * (height - 4)}
            width={barWidth}
            height={(count / maxCount) * (height - 4)}
            fill={color}
            opacity={0.6}
          />
        ))}
        {/* Mean indicator */}
        <line
          x1={meanX}
          y1={0}
          x2={meanX}
          y2={height}
          stroke="#ef4444"
          strokeWidth={1.5}
        />
      </svg>
    </div>
  );
}
