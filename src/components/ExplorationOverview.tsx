import { useState, useEffect, useMemo } from "react";
import type { DecisionTreeData, DecisionTreeTunerData } from "../types/data";

const TUNER_COLORS: Record<string, string> = {
  SymTuner: "#4f46e5",
  CMA_ES: "#10b981",
  Genetic: "#f59e0b",
  SuccessiveHalving: "#ef4444",
};

const TUNER_LABELS: Record<string, string> = {
  SymTuner: "SymTuner",
  CMA_ES: "CMA-ES",
  Genetic: "Genetic",
  SuccessiveHalving: "Successive Halving",
};

interface ParamExploration {
  paramName: string;
  type: "boolean" | "numeric" | "categorical";
  globalMin: number;
  globalMax: number;
  importance: number;
  // For categorical
  categories?: (string | number)[];
  tuners: {
    name: string;
    color: string;
    // For numeric
    min?: number;
    max?: number;
    mean?: number;
    coverage?: number; // 0-1, what % of range explored
    // For boolean
    trueRatio?: number;
    falseRatio?: number;
    // For categorical
    categoryCounts?: Map<string | number, number>;
  }[];
}

// Parameters that should be treated as categorical even if numeric
const CATEGORICAL_PARAMS = new Set(["seed-file", "seed_file", "seedfile"]);
const CATEGORICAL_THRESHOLD = 10; // If unique values <= this, treat as categorical

export function ExplorationOverview() {
  const [data, setData] = useState<DecisionTreeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProgram, setSelectedProgram] = useState("gawk");
  const [showTop, setShowTop] = useState(15);

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

  const programs = useMemo(() => (data ? Object.keys(data) : []), [data]);
  const tuners = useMemo(() => {
    if (!data || !data[selectedProgram]) return [];
    return Object.keys(data[selectedProgram]);
  }, [data, selectedProgram]);

  // Compute exploration data for each parameter
  const explorationData = useMemo((): ParamExploration[] => {
    if (!data || !data[selectedProgram]) return [];

    const programData = data[selectedProgram];
    const firstTuner = Object.values(programData)[0] as DecisionTreeTunerData;
    if (!firstTuner) return [];

    const results: ParamExploration[] = [];

    // Get all parameters from first tuner's importance list
    for (const param of firstTuner.param_importance.slice(0, showTop)) {
      const tunerExplorations: ParamExploration["tuners"] = [];

      // Use is_categorical from data if available, otherwise detect
      const paramUniqueValues = param.unique_values || [];
      const isCategorical = !param.is_boolean && (
        param.is_categorical === true ||
        CATEGORICAL_PARAMS.has(param.name.toLowerCase()) ||
        paramUniqueValues.length <= CATEGORICAL_THRESHOLD
      );

      // First pass: compute global min/max across ALL tuners
      let globalMin = Infinity;
      let globalMax = -Infinity;
      const allUniqueValues = new Set<string | number>();
      const isStringCategorical = param.is_string === true;

      for (const tunerName of tuners) {
        const tunerData = programData[tunerName] as DecisionTreeTunerData;
        if (!tunerData) continue;

        // Also check this tuner's param_importance for unique_values
        const tunerParam = tunerData.param_importance.find(p => p.name === param.name);
        if (tunerParam?.unique_values) {
          tunerParam.unique_values.forEach(v => allUniqueValues.add(v));
        }

        // Also check actual trial data
        if (!param.is_boolean) {
          tunerData.trials.forEach((t) => {
            const v = t.parameters[param.name];
            if (v !== null && v !== undefined && typeof v !== "boolean") {
              allUniqueValues.add(v as string | number);
              if (typeof v === "number") {
                globalMin = Math.min(globalMin, v);
                globalMax = Math.max(globalMax, v);
              }
            }
          });
        }
      }

      if (globalMin === Infinity) globalMin = 0;
      if (globalMax === -Infinity) globalMax = 1;

      const categories = isCategorical
        ? Array.from(allUniqueValues).sort((a, b) => {
            // Sort: numbers first (by value), then strings (alphabetically)
            if (typeof a === "number" && typeof b === "number") return a - b;
            if (typeof a === "number") return -1;
            if (typeof b === "number") return 1;
            return String(a).localeCompare(String(b));
          })
        : undefined;

      // Second pass: compute each tuner's exploration
      for (const tunerName of tuners) {
        const tunerData = programData[tunerName] as DecisionTreeTunerData;
        if (!tunerData) continue;

        if (param.is_boolean) {
          const trueCount = tunerData.trials.filter(
            (t) => t.parameters[param.name] === true
          ).length;
          const falseCount = tunerData.trials.filter(
            (t) => t.parameters[param.name] === false
          ).length;
          const total = trueCount + falseCount;

          tunerExplorations.push({
            name: tunerName,
            color: TUNER_COLORS[tunerName] || "#888",
            trueRatio: total > 0 ? trueCount / total : 0,
            falseRatio: total > 0 ? falseCount / total : 0,
          });
        } else if (isCategorical) {
          // Categorical: count occurrences of each category
          const categoryCounts = new Map<string | number, number>();
          categories!.forEach((c) => categoryCounts.set(c, 0));

          tunerData.trials.forEach((t) => {
            const val = t.parameters[param.name];
            // Handle both string and number categorical values
            if (val !== null && val !== undefined && typeof val !== "boolean" && categoryCounts.has(val as string | number)) {
              categoryCounts.set(val as string | number, (categoryCounts.get(val as string | number) || 0) + 1);
            }
          });

          const totalTrials = tunerData.trials.length;
          const exploredCategories = Array.from(categoryCounts.values()).filter((c) => c > 0).length;

          tunerExplorations.push({
            name: tunerName,
            color: TUNER_COLORS[tunerName] || "#888",
            categoryCounts,
            coverage: exploredCategories / (categories!.length || 1),
          });
        } else {
          // Numeric continuous
          const values = tunerData.trials
            .map((t) => t.parameters[param.name])
            .filter((v) => typeof v === "number") as number[];

          if (values.length > 0) {
            const min = Math.min(...values);
            const max = Math.max(...values);
            const mean = values.reduce((a, b) => a + b, 0) / values.length;
            const globalRange = globalMax - globalMin || 1;
            const coverage = (max - min) / globalRange;

            tunerExplorations.push({
              name: tunerName,
              color: TUNER_COLORS[tunerName] || "#888",
              min,
              max,
              mean,
              coverage,
            });
          }
        }
      }

      results.push({
        paramName: param.name,
        type: param.is_boolean ? "boolean" : (isCategorical ? "categorical" : "numeric"),
        globalMin,
        globalMax,
        importance: param.importance,
        categories,
        tuners: tunerExplorations,
      });
    }

    return results;
  }, [data, selectedProgram, tuners, showTop]);

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

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Controls */}
      <div className="flex items-center gap-4 p-3 bg-base-200 rounded-lg">
        <div className="form-control">
          <label className="label py-0">
            <span className="label-text text-xs font-medium">Program</span>
          </label>
          <select
            className="select select-bordered select-sm w-28"
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

        <div className="form-control">
          <label className="label py-0">
            <span className="label-text text-xs font-medium">Show top</span>
          </label>
          <select
            className="select select-bordered select-sm w-20"
            value={showTop}
            onChange={(e) => setShowTop(parseInt(e.target.value))}
          >
            {[10, 15, 20, 30].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>

        {/* Tuner legend */}
        <div className="flex items-center gap-3 ml-4">
          {tuners.map((tuner) => (
            <div key={tuner} className="flex items-center gap-1">
              <div
                className="w-3 h-3 rounded-sm"
                style={{ backgroundColor: TUNER_COLORS[tuner] || "#888" }}
              />
              <span className="text-xs">{TUNER_LABELS[tuner] || tuner}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Parameter exploration chart */}
      <div className="flex-1 overflow-auto">
        <div className="space-y-2 pr-2">
          {explorationData.map((param) => (
            <div
              key={param.paramName}
              className="flex items-center gap-3 p-2 bg-base-100 rounded border border-base-200 hover:border-base-300"
            >
              {/* Parameter name */}
              <div className="w-40 flex-shrink-0">
                <div
                  className="text-sm font-medium truncate"
                  title={param.paramName}
                >
                  {param.paramName}
                </div>
                <div className="text-[10px] text-gray-400">
                  {param.type === "boolean" && "boolean"}
                  {param.type === "categorical" && `categorical (${param.categories?.length} vals)`}
                  {param.type === "numeric" && `${param.globalMin.toFixed(0)} - ${param.globalMax.toFixed(0)}`}
                  {" · "}imp: {param.importance.toFixed(1)}
                </div>
              </div>

              {/* Visualization */}
              <div className="flex-1 h-12 relative">
                {param.type === "boolean" ? (
                  // Boolean: stacked bars showing true/false ratio
                  <div className="flex h-full gap-1">
                    {param.tuners.map((tuner, idx) => (
                      <div
                        key={tuner.name}
                        className="flex-1 flex flex-col justify-center"
                      >
                        <div className="h-6 flex rounded overflow-hidden">
                          <div
                            className="h-full"
                            style={{
                              width: `${(tuner.trueRatio || 0) * 100}%`,
                              backgroundColor: tuner.color,
                              opacity: 0.8,
                            }}
                          />
                          <div
                            className="h-full bg-gray-200"
                            style={{
                              width: `${(tuner.falseRatio || 0) * 100}%`,
                            }}
                          />
                        </div>
                        <div className="text-[9px] text-center text-gray-500 mt-0.5">
                          T:{((tuner.trueRatio || 0) * 100).toFixed(0)}%
                        </div>
                      </div>
                    ))}
                  </div>
                ) : param.type === "categorical" ? (
                  // Categorical: heatmap-style grid
                  <div className="flex flex-col h-full justify-center gap-0.5">
                    {param.tuners.map((tuner) => {
                      const maxCount = Math.max(
                        ...Array.from(tuner.categoryCounts?.values() || []),
                        1
                      );
                      return (
                        <div key={tuner.name} className="flex items-center gap-0.5">
                          <div
                            className="w-2 h-2 rounded-sm flex-shrink-0"
                            style={{ backgroundColor: tuner.color }}
                          />
                          <div className="flex gap-px flex-1">
                            {param.categories?.map((cat) => {
                              const count = tuner.categoryCounts?.get(cat) || 0;
                              const intensity = count / maxCount;
                              return (
                                <div
                                  key={String(cat)}
                                  className="flex-1 h-2.5 rounded-sm"
                                  style={{
                                    backgroundColor: count > 0 ? tuner.color : "#e5e7eb",
                                    opacity: count > 0 ? 0.3 + intensity * 0.7 : 1,
                                  }}
                                  title={`${cat}: ${count}`}
                                />
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    {/* Category labels */}
                    <div className="flex gap-px mt-0.5 ml-2.5">
                      {param.categories?.map((cat) => (
                        <div
                          key={String(cat)}
                          className="flex-1 text-[7px] text-gray-400 text-center truncate"
                        >
                          {String(cat)}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  // Numeric: overlapping range bars
                  <div className="relative h-full">
                    {/* Background track */}
                    <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 bg-gray-100 rounded" />

                    {/* Range bars for each tuner */}
                    {param.tuners.map((tuner, idx) => {
                      const range = param.globalMax - param.globalMin || 1;
                      const left = ((tuner.min! - param.globalMin) / range) * 100;
                      const width = ((tuner.max! - tuner.min!) / range) * 100;

                      // Offset each tuner vertically slightly
                      const yOffset = (idx - (param.tuners.length - 1) / 2) * 8;

                      return (
                        <div
                          key={tuner.name}
                          className="absolute"
                          style={{
                            left: `${left}%`,
                            width: `${Math.max(width, 0.5)}%`,
                            top: `calc(50% + ${yOffset}px)`,
                            transform: "translateY(-50%)",
                          }}
                        >
                          {/* Range bar */}
                          <div
                            className="h-2 rounded-full"
                            style={{
                              backgroundColor: tuner.color,
                              opacity: 0.6,
                            }}
                          />
                          {/* Mean indicator */}
                          <div
                            className="absolute w-1 h-4 rounded -top-1"
                            style={{
                              left: `${((tuner.mean! - tuner.min!) / (tuner.max! - tuner.min! || 1)) * 100}%`,
                              backgroundColor: tuner.color,
                              transform: "translateX(-50%)",
                            }}
                          />
                        </div>
                      );
                    })}

                    {/* Scale labels */}
                    <div className="absolute -bottom-1 left-0 text-[8px] text-gray-400">
                      {param.globalMin.toFixed(0)}
                    </div>
                    <div className="absolute -bottom-1 right-0 text-[8px] text-gray-400">
                      {param.globalMax.toFixed(0)}
                    </div>
                  </div>
                )}
              </div>

              {/* Coverage indicator */}
              <div className="w-20 flex-shrink-0">
                {param.type !== "boolean" && (
                  <div className="text-[10px] space-y-0.5">
                    {param.tuners.map((tuner) => (
                      <div
                        key={tuner.name}
                        className="flex items-center gap-1"
                      >
                        <div
                          className="w-2 h-2 rounded-sm"
                          style={{ backgroundColor: tuner.color }}
                        />
                        <span className="text-gray-500">
                          {((tuner.coverage || 0) * 100).toFixed(0)}%
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-gray-500 px-2 border-t pt-2">
        <div className="flex items-center gap-1">
          <div className="w-8 h-2 bg-indigo-500 rounded-full opacity-60" />
          <span>Explored range</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-1 h-3 bg-indigo-500 rounded" />
          <span>Mean value</span>
        </div>
        <div className="flex items-center gap-1">
          <span>Coverage % = explored range / total range</span>
        </div>
      </div>
    </div>
  );
}
