import { useState, useEffect, useMemo, useRef } from 'react';
import { ParameterDecisionTree } from './ParameterDecisionTree';
import type { DecisionTreeData } from '../types/data';

const TUNER_COLORS: Record<string, string> = {
  SymTuner: '#4f46e5',
  CMA_ES: '#10b981',
  Genetic: '#f59e0b',
  SuccessiveHalving: '#ef4444',
  TPE: '#8b5cf6',
  BayesianOptimization: '#ec4899',
};

const TUNER_LABELS: Record<string, string> = {
  SymTuner: 'SymTuner',
  CMA_ES: 'CMA-ES',
  Genetic: 'Genetic',
  SuccessiveHalving: 'Successive Halving',
  TPE: 'TPE',
  BayesianOptimization: 'Bayesian Opt.',
};

type CompareMode = 'tuner' | 'time';

export function DecisionTreeComparison() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1200);

  const [data, setData] = useState<DecisionTreeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedProgram, setSelectedProgram] = useState('gawk');
  const [compareMode, setCompareMode] = useState<CompareMode>('tuner');

  // Tuner comparison mode
  const [leftTuner, setLeftTuner] = useState('SymTuner');
  const [rightTuner, setRightTuner] = useState('CMA_ES');

  // Time comparison mode
  const [timeTuner, setTimeTuner] = useState('SymTuner');
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
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  // Load data
  useEffect(() => {
    setLoading(true);
    fetch('/data/decision_tree_data.json')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load data');
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
      <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>
        Loading decision tree data...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#ef4444' }}>
        Error: {error || 'No data'}
      </div>
    );
  }

  const treeWidth = compareMode === 'tuner'
    ? (containerWidth - 60) / 2
    : (containerWidth - 80) / timeRanges.length;
  const treeHeight = 500;

  return (
    <div ref={containerRef} className="decision-tree-container">
      {/* Controls */}
      <div className="controls">
        {/* Program selector */}
        <div className="control-group">
          <label>Program:</label>
          <select
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
        <div className="control-group">
          <label>Compare:</label>
          <div className="button-group">
            <button
              className={compareMode === 'tuner' ? 'active' : ''}
              onClick={() => setCompareMode('tuner')}
            >
              Tuners
            </button>
            <button
              className={compareMode === 'time' ? 'active' : ''}
              onClick={() => setCompareMode('time')}
            >
              Time Segments
            </button>
          </div>
        </div>

        {/* Tuner selectors */}
        {compareMode === 'tuner' && (
          <>
            <div className="control-group">
              <label>Left:</label>
              <select
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
            <div className="control-group">
              <label>Right:</label>
              <select
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
        {compareMode === 'time' && (
          <div className="control-group">
            <label>Tuner:</label>
            <select
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
      <div className="trees-container">
        {compareMode === 'tuner' && (
          <>
            <div className="tree-panel">
              <ParameterDecisionTree
                data={data[selectedProgram][leftTuner]}
                width={treeWidth}
                height={treeHeight}
                tunerName={TUNER_LABELS[leftTuner] || leftTuner}
                color={TUNER_COLORS[leftTuner] || '#6b7280'}
              />
            </div>
            <div className="tree-divider" />
            <div className="tree-panel">
              <ParameterDecisionTree
                data={data[selectedProgram][rightTuner]}
                width={treeWidth}
                height={treeHeight}
                tunerName={TUNER_LABELS[rightTuner] || rightTuner}
                color={TUNER_COLORS[rightTuner] || '#6b7280'}
              />
            </div>
          </>
        )}

        {compareMode === 'time' && (
          <>
            {timeRanges.map((range, i) => (
              <div key={i} className="tree-panel">
                <ParameterDecisionTree
                  data={data[selectedProgram][timeTuner]}
                  width={treeWidth}
                  height={treeHeight}
                  tunerName={TUNER_LABELS[timeTuner] || timeTuner}
                  color={TUNER_COLORS[timeTuner] || '#6b7280'}
                  trialRange={range}
                />
              </div>
            ))}
          </>
        )}
      </div>

      {/* Legend */}
      <div className="legend">
        <strong>How it works:</strong> Click nodes to expand. Tree splits by SHAP importance
        (parameters that most affect coverage). Each node shows trial count and average
        coverage. Hover for distribution histogram.
      </div>
    </div>
  );
}
