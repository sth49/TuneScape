import { useState, useEffect, useMemo, useRef } from "react";
import { EnhancedDecisionTree } from "./EnhancedDecisionTree";
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

interface TimeSegment {
  label: string;
  range: [number, number];
}

export function TreeComparison() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1200);

  const [data, setData] = useState<DecisionTreeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedProgram, setSelectedProgram] = useState("gawk");
  const [compareMode, setCompareMode] = useState<CompareMode>("tuner");

  // Tuner comparison
  const [selectedTuners, setSelectedTuners] = useState<string[]>([
    "SymTuner",
    "CMA_ES",
  ]);

  // Time comparison
  const [timeTuner, setTimeTuner] = useState("SymTuner");
  const [numSegments, setNumSegments] = useState(2);

  // Measure container
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

  // Calculate time segments based on trial count
  const timeSegments = useMemo((): TimeSegment[] => {
    if (!data || !data[selectedProgram] || !data[selectedProgram][timeTuner]) {
      return [];
    }

    const trials = data[selectedProgram][timeTuner].trials;
    const totalTrials = trials.length;
    const segmentSize = Math.ceil(totalTrials / numSegments);

    const segments: TimeSegment[] = [];
    for (let i = 0; i < numSegments; i++) {
      const start = i * segmentSize + 1;
      const end = Math.min((i + 1) * segmentSize, totalTrials);
      segments.push({
        label: `Trial ${start}-${end}`,
        range: [start, end],
      });
    }

    return segments;
  }, [data, selectedProgram, timeTuner, numSegments]);

  // Update selections when program changes
  useEffect(() => {
    if (availableTuners.length > 0) {
      setSelectedTuners((prev) => {
        const valid = prev.filter((t) => availableTuners.includes(t));
        if (valid.length === 0) {
          return availableTuners.slice(0, 2);
        }
        return valid;
      });

      if (!availableTuners.includes(timeTuner)) {
        setTimeTuner(availableTuners[0]);
      }
    }
  }, [availableTuners]);

  const toggleTuner = (tuner: string) => {
    setSelectedTuners((prev) => {
      if (prev.includes(tuner)) {
        if (prev.length > 1) {
          return prev.filter((t) => t !== tuner);
        }
        return prev;
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

  const numPanels =
    compareMode === "tuner" ? selectedTuners.length : numSegments;
  const panelWidth = (containerWidth - 40 - (numPanels - 1) * 16) / numPanels;
  const treeHeight = 600;

  return (
    <div ref={containerRef} className="flex flex-col gap-4 w-full h-full">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4 p-3 bg-base-200 rounded-lg">
        {/* Program */}
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

        {/* Compare mode */}
        <div className="form-control">
          <label className="label py-0">
            <span className="label-text text-xs font-medium">Compare by</span>
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
              Time
            </button>
          </div>
        </div>

        {/* Tuner selection for tuner mode */}
        {compareMode === "tuner" && (
          <div className="form-control">
            <label className="label py-0">
              <span className="label-text text-xs font-medium">Tuners</span>
            </label>
            <div className="flex gap-1">
              {availableTuners.map((tuner) => (
                <button
                  key={tuner}
                  className={`btn btn-xs ${
                    selectedTuners.includes(tuner)
                      ? ""
                      : "btn-ghost opacity-50"
                  }`}
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
        )}

        {/* Time mode settings */}
        {compareMode === "time" && (
          <>
            <div className="form-control">
              <label className="label py-0">
                <span className="label-text text-xs font-medium">Tuner</span>
              </label>
              <select
                className="select select-bordered select-sm w-36"
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

            <div className="form-control">
              <label className="label py-0">
                <span className="label-text text-xs font-medium">Segments</span>
              </label>
              <div className="join">
                {[2, 3, 4].map((n) => (
                  <button
                    key={n}
                    className={`join-item btn btn-sm ${numSegments === n ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setNumSegments(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Info banner */}
      <div className="text-xs text-gray-500 px-2 flex items-center gap-2">
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span>
          Click <strong>+</strong> to expand nodes. Trees split by parameter
          importance (SHAP). Compare how different{" "}
          {compareMode === "tuner" ? "tuners" : "time periods"} explore the
          parameter space.
        </span>
      </div>

      {/* Tree panels */}
      <div className="flex gap-4 flex-1 overflow-hidden">
        {compareMode === "tuner" &&
          selectedTuners.map((tuner) => (
            <div
              key={tuner}
              className="flex-1 min-w-0 bg-base-100 rounded-lg border border-base-300 p-3 overflow-hidden"
              style={{ maxWidth: panelWidth + 16 }}
            >
              <EnhancedDecisionTree
                data={data[selectedProgram][tuner]}
                width={panelWidth}
                height={treeHeight}
                tunerName={TUNER_LABELS[tuner] || tuner}
                color={TUNER_COLORS[tuner] || "#6b7280"}
              />
            </div>
          ))}

        {compareMode === "time" &&
          timeSegments.map((segment, i) => (
            <div
              key={i}
              className="flex-1 min-w-0 bg-base-100 rounded-lg border border-base-300 p-3 overflow-hidden"
              style={{ maxWidth: panelWidth + 16 }}
            >
              <EnhancedDecisionTree
                data={data[selectedProgram][timeTuner]}
                width={panelWidth}
                height={treeHeight}
                tunerName={TUNER_LABELS[timeTuner] || timeTuner}
                color={TUNER_COLORS[timeTuner] || "#6b7280"}
                trialRange={segment.range}
              />
            </div>
          ))}
      </div>
    </div>
  );
}
