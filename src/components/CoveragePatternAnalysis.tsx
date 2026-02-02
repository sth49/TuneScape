import { useState, useEffect, useMemo } from "react";

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

interface ParamImportance {
  name: string;
  importance: number;
}

interface ComponentData {
  component_idx: number;
  explained_variance: number;
  cumulative_variance: number;
  param_importance: ParamImportance[];
  top_branches: { branch_id: number; loading: number }[];
  component_values: number[];
}

interface TunerPatternData {
  n_trials: number;
  n_branches: number;
  n_components: number;
  total_variance_explained: number;
  component_coverage_correlation: number[];
  components: ComponentData[];
  coverage_stats: {
    min: number;
    max: number;
    mean: number;
  };
}

interface PatternData {
  [program: string]: {
    [tuner: string]: TunerPatternData;
  };
}

export function CoveragePatternAnalysis() {
  const [data, setData] = useState<PatternData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProgram, setSelectedProgram] = useState("gawk");
  const [selectedComponent, setSelectedComponent] = useState(0);
  const [showTopN, setShowTopN] = useState(10);

  useEffect(() => {
    setLoading(true);
    fetch("/data/coverage_pattern_data.json")
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

  // Get max component count across all tuners
  const maxComponents = useMemo(() => {
    if (!data || !data[selectedProgram]) return 0;
    return Math.max(
      ...Object.values(data[selectedProgram]).map((t) => t.n_components)
    );
  }, [data, selectedProgram]);

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
      <div className="flex flex-wrap items-center gap-4 p-3 bg-base-200 rounded-lg">
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
            <span className="label-text text-xs font-medium">Component</span>
          </label>
          <div className="join">
            {Array.from({ length: Math.min(maxComponents, 5) }, (_, i) => (
              <button
                key={i}
                className={`join-item btn btn-sm ${
                  selectedComponent === i ? "btn-primary" : "btn-ghost"
                }`}
                onClick={() => setSelectedComponent(i)}
              >
                PC{i + 1}
              </button>
            ))}
          </div>
        </div>

        <div className="form-control">
          <label className="label py-0">
            <span className="label-text text-xs font-medium">Top params</span>
          </label>
          <select
            className="select select-bordered select-sm w-20"
            value={showTopN}
            onChange={(e) => setShowTopN(parseInt(e.target.value))}
          >
            {[5, 10, 15, 20].map((n) => (
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

      {/* Info banner */}
      <div className="text-xs text-gray-500 px-2 flex items-center gap-2 bg-base-200 p-2 rounded">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>
          <strong>Coverage Pattern Analysis</strong>: PCA on coverage vectors (which branches are covered).
          PC1 correlates with total coverage. Other components reveal different coverage patterns.
          Parameters with high importance for low-correlation PCs affect <em>which</em> branches get covered, not just <em>how many</em>.
        </span>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-auto">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {tuners.map((tuner) => {
            const tunerData = data[selectedProgram][tuner];
            if (!tunerData || selectedComponent >= tunerData.n_components) return null;

            const component = tunerData.components[selectedComponent];
            const correlation = tunerData.component_coverage_correlation[selectedComponent];
            const maxImportance = Math.max(
              ...component.param_importance.slice(0, showTopN).map((p) => p.importance)
            );

            return (
              <div
                key={tuner}
                className="bg-base-100 rounded-lg border border-base-300 p-4"
              >
                {/* Header */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-3 h-3 rounded-sm"
                      style={{ backgroundColor: TUNER_COLORS[tuner] || "#888" }}
                    />
                    <span className="font-semibold">
                      {TUNER_LABELS[tuner] || tuner}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500">
                    {tunerData.n_branches} branches · {tunerData.n_trials} trials
                  </div>
                </div>

                {/* Component stats */}
                <div className="flex gap-4 mb-3 text-sm">
                  <div className="stat p-2 bg-base-200 rounded flex-1">
                    <div className="stat-title text-xs">Variance Explained</div>
                    <div className="stat-value text-lg">
                      {(component.explained_variance * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div className="stat p-2 bg-base-200 rounded flex-1">
                    <div className="stat-title text-xs">Coverage Correlation</div>
                    <div
                      className={`stat-value text-lg ${
                        Math.abs(correlation) > 0.5
                          ? "text-success"
                          : Math.abs(correlation) > 0.2
                          ? "text-warning"
                          : "text-info"
                      }`}
                    >
                      {correlation.toFixed(2)}
                    </div>
                  </div>
                  <div className="stat p-2 bg-base-200 rounded flex-1">
                    <div className="stat-title text-xs">Cumulative Var.</div>
                    <div className="stat-value text-lg">
                      {(component.cumulative_variance * 100).toFixed(1)}%
                    </div>
                  </div>
                </div>

                {/* Interpretation */}
                <div className="text-xs mb-3 p-2 bg-base-200 rounded">
                  {Math.abs(correlation) > 0.8 ? (
                    <span className="text-success">
                      High correlation with total coverage - these parameters affect how many branches are covered.
                    </span>
                  ) : Math.abs(correlation) > 0.3 ? (
                    <span className="text-warning">
                      Moderate correlation - these parameters affect both coverage amount and pattern.
                    </span>
                  ) : (
                    <span className="text-info">
                      Low correlation with total coverage - these parameters affect which specific branches are covered, revealing different exploration strategies.
                    </span>
                  )}
                </div>

                {/* Parameter importance bars */}
                <div className="space-y-1">
                  {component.param_importance.slice(0, showTopN).map((param, idx) => (
                    <div key={param.name} className="flex items-center gap-2">
                      <div className="w-32 text-xs truncate" title={param.name}>
                        {param.name}
                      </div>
                      <div className="flex-1 h-4 bg-base-200 rounded overflow-hidden">
                        <div
                          className="h-full rounded transition-all"
                          style={{
                            width: `${(param.importance / maxImportance) * 100}%`,
                            backgroundColor: TUNER_COLORS[tuner] || "#888",
                            opacity: 0.7 + (0.3 * (showTopN - idx)) / showTopN,
                          }}
                        />
                      </div>
                      <div className="w-12 text-xs text-right text-gray-500">
                        {param.importance.toFixed(1)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Variance explained comparison */}
      <div className="p-3 bg-base-200 rounded-lg">
        <div className="text-sm font-medium mb-2">Variance Explained by Component</div>
        <div className="flex gap-1 h-8">
          {tuners.map((tuner) => {
            const tunerData = data[selectedProgram][tuner];
            if (!tunerData) return null;

            return (
              <div key={tuner} className="flex-1 flex flex-col gap-0.5">
                <div className="text-[10px] text-center truncate">
                  {TUNER_LABELS[tuner] || tuner}
                </div>
                <div className="flex-1 flex rounded overflow-hidden">
                  {tunerData.components.slice(0, 5).map((comp, idx) => (
                    <div
                      key={idx}
                      className={`h-full ${
                        idx === selectedComponent ? "ring-2 ring-primary" : ""
                      }`}
                      style={{
                        width: `${comp.explained_variance * 100}%`,
                        backgroundColor: TUNER_COLORS[tuner] || "#888",
                        opacity: 0.3 + (0.7 * (5 - idx)) / 5,
                      }}
                      title={`PC${idx + 1}: ${(comp.explained_variance * 100).toFixed(1)}%`}
                    />
                  ))}
                  <div
                    className="h-full bg-gray-200"
                    style={{
                      flex: 1,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex justify-between text-[10px] text-gray-400 mt-1">
          <span>0%</span>
          <span>100% variance explained</span>
        </div>
      </div>
    </div>
  );
}
