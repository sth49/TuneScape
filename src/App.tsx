import { useState, useEffect, useMemo } from 'react';
import { EventTimeline } from './components/EventTimeline';
import { CumulativeComparisonChart } from './components/CumulativeComparisonChart';
import { CombinedParameterSpaceView } from './components/CombinedParameterSpaceView';
import { SummaryStatistics } from './components/SummaryStatistics';
import { TunerRadarChart } from './components/TunerRadarChart';
import { TemporalExplorationHeatmap } from './components/TemporalExplorationHeatmap';
import { SelectionProvider } from './context/SelectionContext';
import { useContainerSize } from './hooks/useContainerSize';
import { getProgramTotalBranches } from './config/programs';
import type { ProcessedData } from './types/data';
import './App.css';

// Colors for each program/tuner
const DATASET_COLORS: Record<string, string> = {
  grep: '#4f46e5', // indigo
  gcal: '#10b981', // emerald
  gawk: '#f59e0b', // amber
};

const AVAILABLE_DATASETS = [
  { id: 'grep', label: 'grep', file: '/data/grep_processed_light.json', color: DATASET_COLORS.grep },
  { id: 'gcal', label: 'gcal', file: '/data/gcal_processed_light.json', color: DATASET_COLORS.gcal },
  { id: 'gawk', label: 'gawk', file: '/data/gawk_processed_light.json', color: DATASET_COLORS.gawk },
];

function App() {
  const [allData, setAllData] = useState<Record<string, ProcessedData>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [normalize, setNormalize] = useState(false);

  // Container refs for responsive sizing
  const [coverageRef, coverageSize] = useContainerSize();
  const [radarRef, radarSize] = useContainerSize();
  const [temporalRef, temporalSize] = useContainerSize();
  const [timelineRef, timelineSize] = useContainerSize();
  const [paramSpaceRef, paramSpaceSize] = useContainerSize();

  // Load all datasets
  useEffect(() => {
    setLoading(true);
    setError(null);

    Promise.all(
      AVAILABLE_DATASETS.map((ds) =>
        fetch(ds.file)
          .then((res) => {
            if (!res.ok) throw new Error(`Failed to load ${ds.id}`);
            return res.json();
          })
          .then((json) => ({ id: ds.id, data: json as ProcessedData }))
      )
    )
      .then((results) => {
        const dataMap: Record<string, ProcessedData> = {};
        for (const { id, data } of results) {
          dataMap[id] = data;
        }
        setAllData(dataMap);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  // Prepare comparison datasets
  const comparisonDatasets = useMemo(() => {
    return AVAILABLE_DATASETS.map((ds) => {
      const data = allData[ds.id];
      if (!data) return null;
      return {
        id: ds.id,
        label: ds.label,
        color: ds.color,
        trials: data.trials.map((t) => ({
          trialId: t.trialId,
          cumulativeCoverage: t.cumulativeCoverage,
          marginalCoverage: t.marginalCoverage,
          totalCovered: t.totalCovered,
        })),
        totalTrials: data.totalTrials,
        totalUniqueBranches: data.totalUniqueBranches,
      };
    }).filter((d) => d !== null);
  }, [allData]);

  if (loading) {
    return <div className="loading">Loading data...</div>;
  }

  if (error) {
    return <div className="error">Error: {error}</div>;
  }

  return (
    <SelectionProvider>
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="logo">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="8" fill="#4f46e5"/>
              <path d="M8 22V10h4v12H8zm6-8v8h4v-8h-4zm6-4v12h4V10h-4z" fill="white"/>
            </svg>
          </div>
          <div className="header-title">
            <h1>TunerVis</h1>
            <span className="header-subtitle">Symbolic Execution Tuner Analysis</span>
          </div>
        </div>
        <div className="header-stats">
          {AVAILABLE_DATASETS.map((ds) => {
            const data = allData[ds.id];
            if (!data) return null;
            return (
              <div key={ds.id} className="stat-badge">
                <span className="stat-label" style={{ color: ds.color }}>{ds.label}</span>
                <span className="stat-value">{data.totalUniqueBranches.toLocaleString()}</span>
                <span className="stat-sublabel">/ {getProgramTotalBranches(ds.id).toLocaleString()}</span>
              </div>
            );
          })}
        </div>
      </header>

      <main>
        {/* Row 1: Cumulative Coverage + Summary Statistics */}
        <section className="view-container">
          <div className="view-header">
            <h2>Cumulative Coverage</h2>
            <label className="compact-checkbox" style={{ marginLeft: 'auto' }}>
              <input
                type="checkbox"
                checked={normalize}
                onChange={(e) => setNormalize(e.target.checked)}
              />
              Normalize
            </label>
          </div>
          <div ref={coverageRef} className="chart-wrapper">
            {coverageSize.width > 0 && (
              <CumulativeComparisonChart
                datasets={comparisonDatasets}
                width={coverageSize.width}
                height={180}
                normalize={normalize}
              />
            )}
          </div>
        </section>

        <section className="view-container">
          <div className="view-header">
            <h2>Summary Statistics</h2>
          </div>
          <SummaryStatistics datasets={comparisonDatasets} compact />
        </section>

        {/* Row 2: Radar Chart + Temporal Heatmap */}
        <section className="view-container">
          <div className="view-header">
            <h2>Performance Radar</h2>
          </div>
          <div ref={radarRef} className="chart-wrapper">
            {radarSize.width > 0 && (
              <TunerRadarChart
                datasets={comparisonDatasets}
                width={radarSize.width}
                height={160}
              />
            )}
          </div>
        </section>

        <section className="view-container">
          <div className="view-header">
            <h2>Temporal Exploration</h2>
            <p className="view-description">Parameter space over time</p>
          </div>
          <div ref={temporalRef} className="chart-wrapper">
            {temporalSize.width > 0 && (
              <TemporalExplorationHeatmap
                width={temporalSize.width}
                height={220}
                colors={DATASET_COLORS}
                numWindows={4}
              />
            )}
          </div>
        </section>

        {/* Row 3: Timeline + Parameter Space */}
        <section className="view-container">
          <div className="view-header">
            <h2>Branch Discovery Timeline</h2>
            <p className="view-description">Circle size = new branches</p>
          </div>
          <div ref={timelineRef} className="chart-wrapper">
            {timelineSize.width > 0 && AVAILABLE_DATASETS.map((ds) => {
              const data = allData[ds.id];
              if (!data) return null;
              return (
                <div key={ds.id} style={{ position: 'relative' }}>
                  <div
                    style={{
                      position: 'absolute',
                      left: 4,
                      top: 4,
                      padding: '1px 6px',
                      fontSize: 9,
                      fontWeight: 600,
                      backgroundColor: ds.color,
                      color: 'white',
                      borderRadius: 3,
                      zIndex: 10,
                    }}
                  >
                    {ds.label}
                  </div>
                  <EventTimeline
                    data={data}
                    width={timelineSize.width}
                    height={75}
                    color={ds.color}
                    compact
                    programId={ds.id}
                  />
                </div>
              );
            })}
          </div>
        </section>

        <section className="view-container">
          <div className="view-header">
            <h2>Parameter Space (UMAP)</h2>
            <p className="view-description">61D → 2D</p>
          </div>
          <div ref={paramSpaceRef} className="chart-wrapper">
            {paramSpaceSize.width > 0 && (
              <CombinedParameterSpaceView
                width={paramSpaceSize.width}
                height={280}
                colors={DATASET_COLORS}
              />
            )}
          </div>
        </section>
      </main>
    </div>
    </SelectionProvider>
  );
}

export default App;
