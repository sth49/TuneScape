import { useState, useEffect, useMemo, useRef } from "react";
import { ParameterDecisionTree } from "./ParameterDecisionTree";
import type { DecisionTreeData } from "../types/data";

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

type CompareMode = "tuner" | "time";

export function DecisionTreeComparison() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1200);

  const [data, setData] = useState<DecisionTreeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedProgram, setSelectedProgram] = useState("gawk");
  const [compareMode, setCompareMode] = useState<CompareMode>("tuner");

  // Tuner comparison mode
  const [leftTuner, setLeftTuner] = useState("SymTuner");
  const [rightTuner, setRightTuner] = useState("CMA_ES");

  // Time comparison mode
  const [timeTuner, setTimeTuner] = useState("SymTuner");
  const [timeRanges] = useState<[number, number][]>([
    [1, 550],
    [551, 1100],
    [1101, 1650],
    [1651, 2200],
  ]);

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

  const availableTuners = useMemo(() => {
    if (!data || !data[selectedProgram]) return [];
    return Object.keys(data[selectedProgram]);
  }, [data, selectedProgram]);

  const programs = useMemo(() => {
    if (!data) return [];
    return Object.keys(data);
  }, [data]);

  // Update tuner selections when program changes
  useEffect(() => {
    if (availableTuners.length > 0) {
      if (!availableTuners.includes(leftTuner)) {
        setLeftTuner(availableTuners[0]);
      }
      if (!availableTuners.includes(rightTuner)) {
        setRightTuner(availableTuners[1] || availableTuners[0]);
      }
      if (!availableTuners.includes(timeTuner)) {
        setTimeTuner(availableTuners[0]);
      }
    }
  }, [availableTuners, leftTuner, rightTuner, timeTuner]);

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

  const treeWidth =
    compareMode === "tuner"
      ? (containerWidth - 60) / 2
      : (containerWidth - 80) / timeRanges.length;
  const treeHeight = 500;

  return (
    <div ref={containerRef} className="flex flex-col gap-4 w-full h-full">
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

        {/* Compare mode */}
        <div className="form-control">
          <label className="label py-0">
            <span className="label-text text-xs font-medium">Compare</span>
          </label>
          <div className="join">
            <button
              className={`join-item btn btn-sm ${compareMode === "tuner" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setCompareMode("tuner")}
            >
              Tuners
            </button>
            <button
              className={`join-item btn btn-sm ${compareMode === "time" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setCompareMode("time")}
            >
              Time Segments
            </button>
          </div>
        </div>

        {/* Tuner selectors */}
        {compareMode === "tuner" && (
          <>
            <div className="form-control">
              <label className="label py-0">
                <span className="label-text text-xs font-medium">Left</span>
              </label>
              <select
                className="select select-bordered select-sm w-40"
                value={leftTuner}
                onChange={(e) => setLeftTuner(e.target.value)}
              >
                {availableTuners.map((t) => (
                  <option key={t} value={t}>
                    {TUNER_LABELS[t] || t}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-control">
              <label className="label py-0">
                <span className="label-text text-xs font-medium">Right</span>
              </label>
              <select
                className="select select-bordered select-sm w-40"
                value={rightTuner}
                onChange={(e) => setRightTuner(e.target.value)}
              >
                {availableTuners.map((t) => (
                  <option key={t} value={t}>
                    {TUNER_LABELS[t] || t}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {/* Time mode tuner selector */}
        {compareMode === "time" && (
          <div className="form-control">
            <label className="label py-0">
              <span className="label-text text-xs font-medium">Tuner</span>
            </label>
            <select
              className="select select-bordered select-sm w-40"
              value={timeTuner}
              onChange={(e) => setTimeTuner(e.target.value)}
            >
              {availableTuners.map((t) => (
                <option key={t} value={t}>
                  {TUNER_LABELS[t] || t}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Trees */}
      <div className="flex flex-1 gap-2">
        {compareMode === "tuner" && (
          <>
            <div className="flex-1 min-w-0 bg-base-100 rounded-lg p-2">
              <ParameterDecisionTree
                data={data[selectedProgram][leftTuner]}
                width={treeWidth}
                height={treeHeight}
                tunerName={TUNER_LABELS[leftTuner] || leftTuner}
                color={TUNER_COLORS[leftTuner] || "#6b7280"}
              />
            </div>
            <div className="divider divider-horizontal m-0"></div>
            <div className="flex-1 min-w-0 bg-base-100 rounded-lg p-2">
              <ParameterDecisionTree
                data={data[selectedProgram][rightTuner]}
                width={treeWidth}
                height={treeHeight}
                tunerName={TUNER_LABELS[rightTuner] || rightTuner}
                color={TUNER_COLORS[rightTuner] || "#6b7280"}
              />
            </div>
          </>
        )}

        {compareMode === "time" &&
          timeRanges.map((range, i) => (
            <div key={i} className="flex-1 min-w-0 bg-base-100 rounded-lg p-2">
              <ParameterDecisionTree
                data={data[selectedProgram][timeTuner]}
                width={treeWidth}
                height={treeHeight}
                tunerName={TUNER_LABELS[timeTuner] || timeTuner}
                color={TUNER_COLORS[timeTuner] || "#6b7280"}
                trialRange={range}
              />
            </div>
          ))}
      </div>
    </div>
  );
}
