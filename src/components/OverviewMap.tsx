/**
 * Overview Map Visualization (Fast Version)
 *
 * Displays 8,800 trials in a 2D space-filling grid.
 * Uses parameter-based sorting for fast rendering.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { interpolateRdYlGn } from 'd3';
import type { ProcessedData } from '../types/data';
import {
  processOverviewMapData,
  getTopParams,
  TUNER_COLORS,
  TUNER_NAMES,
  type OverviewMapData,
  type OverviewTrial,
  type TunerType,
  type TunerBoundaryEdge,
} from '../utils/overviewMapUtils';

// ============================================================
// Types
// ============================================================

type ColorMode = 'tuner' | 'coverage' | 'marginal' | 'overlap';

interface OverviewMapProps {
  width?: number;
  height?: number;
  program?: string;
}

interface TooltipData {
  trial: OverviewTrial;
  x: number;
  y: number;
}

// ============================================================
// Constants
// ============================================================

const OVERLAP_COLORS = {
  two: '#8B5CF6',
  three: '#F97316',
};

// Slightly darker colors for boundaries
const TUNER_BORDER_COLORS: Record<TunerType, string> = {
  'SymTuner': '#1D4ED8',
  'CMA_ES': '#047857',
  'Genetic': '#B45309',
  'SuccessiveHalving': '#B91C1C',
};

const TUNER_DISPLAY_NAMES: Record<TunerType, string> = {
  'SymTuner': 'SymTuner',
  'CMA_ES': 'CMA-ES',
  'Genetic': 'Genetic',
  'SuccessiveHalving': 'Succ. Halving',
};

// ============================================================
// Component
// ============================================================

export function OverviewMap({ width = 900, height = 750, program = 'gawk' }: OverviewMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<OverviewMapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [colorMode, setColorMode] = useState<ColorMode>('tuner');
  const [showBoundaries, setShowBoundaries] = useState(true);
  const [selectedTuners, setSelectedTuners] = useState<Set<TunerType>>(new Set(TUNER_NAMES));
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [hoveredCell, setHoveredCell] = useState<{ row: number; col: number } | null>(null);

  // Calculate cell size
  const cellSize = useMemo(() => {
    if (!data) return 7;
    const maxDim = Math.min(width - 240, height - 80);
    return Math.max(4, Math.floor(maxDim / data.gridSize));
  }, [data, width, height]);

  const canvasWidth = useMemo(() => data ? data.gridSize * cellSize : 600, [data, cellSize]);
  const canvasHeight = useMemo(() => data ? data.gridSize * cellSize : 600, [data, cellSize]);

  // Load data
  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        // Load all 4 tuner files
        const tunerFiles = TUNER_NAMES.map(
          tuner => `/data/${program}_${tuner}_processed.json`
        );

        const responses = await Promise.all(
          tunerFiles.map(url => fetch(url).then(r => {
            if (!r.ok) throw new Error(`Failed to load ${url}`);
            return r.json();
          }))
        );

        if (cancelled) return;

        const tunerData: ProcessedData[] = responses;

        // Load SHAP importance
        const decisionTreeData = await fetch('/data/decision_tree_data.json').then(r => r.json());
        const shapImportance = decisionTreeData[program]?.SymTuner?.param_importance || [];

        if (cancelled) return;

        // Process data (now synchronous and fast)
        const mapData = processOverviewMapData(tunerData, shapImportance);

        setData(mapData);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load data');
          setLoading(false);
        }
      }
    }

    loadData();

    return () => { cancelled = true; };
  }, [program]);

  // Get cell color
  const getCellColor = useCallback(
    (trial: OverviewTrial): string => {
      if (!selectedTuners.has(trial.tuner)) {
        return '#F1F5F9';
      }

      switch (colorMode) {
        case 'tuner':
          return TUNER_COLORS[trial.tuner];

        case 'coverage':
          return interpolateRdYlGn(trial.coverage);

        case 'marginal':
          if (trial.marginalCoverage > 0) {
            const maxM = data ? Math.max(...data.trials.map(t => t.marginalCoverage), 1) : 1;
            const intensity = Math.min(1, trial.marginalCoverage / maxM);
            return `rgb(${Math.round(59 + 196 * (1 - intensity))}, ${Math.round(130 + 125 * (1 - intensity))}, 246)`;
          }
          return '#E2E8F0';

        case 'overlap':
          if (trial.overlapWith.length >= 2) return OVERLAP_COLORS.three;
          if (trial.overlapWith.length === 1) return OVERLAP_COLORS.two;
          return TUNER_COLORS[trial.tuner];

        default:
          return TUNER_COLORS[trial.tuner];
      }
    },
    [colorMode, selectedTuners, data]
  );

  // Draw canvas
  useEffect(() => {
    if (!data || !canvasRef.current) return;

    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#F8FAFC';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const { grid, trials, gridSize, tunerBoundaries } = data;

    // Build trial map for fast lookup
    const trialMap = new Map<number, OverviewTrial>();
    for (const t of trials) trialMap.set(t.globalId, t);

    // Draw cells
    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        const idx = grid[r][c];
        if (idx === null) continue;

        const trial = trialMap.get(idx);
        if (!trial) continue;

        const x = c * cellSize;
        const y = r * cellSize;

        ctx.fillStyle = getCellColor(trial);
        ctx.globalAlpha = selectedTuners.has(trial.tuner) ? 1 : 0.15;
        ctx.fillRect(x, y, cellSize - 0.5, cellSize - 0.5);
      }
    }

    ctx.globalAlpha = 1;

    // Draw tuner boundaries
    if (showBoundaries) {
      for (const tuner of TUNER_NAMES) {
        if (!selectedTuners.has(tuner)) continue;

        const edges = tunerBoundaries[tuner];
        if (!edges || edges.length === 0) continue;

        ctx.strokeStyle = TUNER_BORDER_COLORS[tuner];
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.8;

        ctx.beginPath();
        for (const edge of edges) {
          const x = edge.col * cellSize;
          const y = edge.row * cellSize;

          switch (edge.side) {
            case 'top':
              ctx.moveTo(x, y);
              ctx.lineTo(x + cellSize, y);
              break;
            case 'right':
              ctx.moveTo(x + cellSize, y);
              ctx.lineTo(x + cellSize, y + cellSize);
              break;
            case 'bottom':
              ctx.moveTo(x, y + cellSize);
              ctx.lineTo(x + cellSize, y + cellSize);
              break;
            case 'left':
              ctx.moveTo(x, y);
              ctx.lineTo(x, y + cellSize);
              break;
          }
        }
        ctx.stroke();
      }
    }

    ctx.globalAlpha = 1;

    // Hover highlight
    if (hoveredCell) {
      const idx = grid[hoveredCell.row]?.[hoveredCell.col];
      if (idx !== null && idx !== undefined) {
        const x = hoveredCell.col * cellSize;
        const y = hoveredCell.row * cellSize;
        ctx.strokeStyle = '#1E293B';
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 1, y - 1, cellSize + 2, cellSize + 2);
      }
    }
  }, [data, colorMode, selectedTuners, showBoundaries, cellSize, canvasWidth, canvasHeight, getCellColor, hoveredCell]);

  // Mouse handlers
  const trialMapRef = useRef<Map<number, OverviewTrial>>(new Map());

  useEffect(() => {
    if (data) {
      const map = new Map<number, OverviewTrial>();
      for (const t of data.trials) map.set(t.globalId, t);
      trialMapRef.current = map;
    }
  }, [data]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!data || !canvasRef.current) return;

      const rect = canvasRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const col = Math.floor(x / cellSize);
      const row = Math.floor(y / cellSize);

      if (row >= 0 && row < data.gridSize && col >= 0 && col < data.gridSize) {
        const idx = data.grid[row][col];
        if (idx !== null) {
          const trial = trialMapRef.current.get(idx);
          if (trial) {
            setHoveredCell({ row, col });
            setTooltip({ trial, x: e.clientX, y: e.clientY });
            return;
          }
        }
      }

      setHoveredCell(null);
      setTooltip(null);
    },
    [data, cellSize]
  );

  const handleMouseLeave = useCallback(() => {
    setHoveredCell(null);
    setTooltip(null);
  }, []);

  const toggleTuner = useCallback((tuner: TunerType) => {
    setSelectedTuners(prev => {
      const next = new Set(prev);
      if (next.has(tuner)) {
        if (next.size > 1) next.delete(tuner);
      } else {
        next.add(tuner);
      }
      return next;
    });
  }, []);

  // Stats
  const stats = useMemo(() => {
    if (!data) return new Map();
    const map = new Map<TunerType, number>();
    for (const t of data.trials) map.set(t.tuner, (map.get(t.tuner) || 0) + 1);
    return map;
  }, [data]);

  // Loading
  if (loading) {
    return (
      <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="loading loading-spinner loading-lg text-primary"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#EF4444' }}>
        Error: {error}
      </div>
    );
  }

  if (!data) return null;

  return (
    <div style={{ position: 'relative' }}>
      {/* Title */}
      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 16 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          Hyperparameter Space Map
        </h3>
        <span style={{ fontSize: 12, color: '#6B7280' }}>
          {data.trials.length.toLocaleString()} trials • {program} • sorted by top-5 params
        </span>
      </div>

      <div style={{ display: 'flex', gap: 20 }}>
        {/* Canvas */}
        <canvas
          ref={canvasRef}
          width={canvasWidth}
          height={canvasHeight}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          style={{ cursor: 'crosshair', border: '1px solid #E5E7EB', borderRadius: 4 }}
        />

        {/* Side panel */}
        <div style={{ width: 200, fontSize: 12 }}>
          {/* Color mode */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, color: '#374151' }}>Color Mode</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {(['tuner', 'coverage', 'marginal', 'overlap'] as ColorMode[]).map(mode => (
                <button
                  key={mode}
                  onClick={() => setColorMode(mode)}
                  style={{
                    padding: '6px 12px',
                    fontSize: 11,
                    border: '1px solid',
                    borderColor: colorMode === mode ? '#4F46E5' : '#E5E7EB',
                    borderRadius: 4,
                    background: colorMode === mode ? '#EEF2FF' : 'white',
                    color: colorMode === mode ? '#4F46E5' : '#6B7280',
                    cursor: 'pointer',
                    textAlign: 'left',
                    textTransform: 'capitalize',
                  }}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {/* Boundary toggle */}
          <div style={{ marginBottom: 16 }}>
            <button
              onClick={() => setShowBoundaries(!showBoundaries)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '8px 12px',
                fontSize: 11,
                border: '1px solid',
                borderColor: showBoundaries ? '#4F46E5' : '#E5E7EB',
                borderRadius: 4,
                background: showBoundaries ? '#EEF2FF' : 'white',
                color: showBoundaries ? '#4F46E5' : '#6B7280',
                cursor: 'pointer',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <rect x="2" y="2" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"/>
              </svg>
              <span>Tuner Boundaries</span>
              <span style={{ marginLeft: 'auto', fontSize: 10 }}>{showBoundaries ? 'ON' : 'OFF'}</span>
            </button>
          </div>

          {/* Tuners */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, color: '#374151' }}>Tuners</div>
            {TUNER_NAMES.map(tuner => (
              <button
                key={tuner}
                onClick={() => toggleTuner(tuner)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '6px 10px',
                  marginBottom: 4,
                  fontSize: 11,
                  border: '1px solid',
                  borderColor: selectedTuners.has(tuner) ? TUNER_COLORS[tuner] : '#E5E7EB',
                  borderRadius: 4,
                  background: selectedTuners.has(tuner) ? 'white' : '#F9FAFB',
                  cursor: 'pointer',
                  opacity: selectedTuners.has(tuner) ? 1 : 0.5,
                }}
              >
                <div style={{ width: 14, height: 14, borderRadius: 2, backgroundColor: TUNER_COLORS[tuner] }} />
                <span style={{ flex: 1, textAlign: 'left', color: '#374151' }}>
                  {TUNER_DISPLAY_NAMES[tuner]}
                </span>
                <span style={{ color: '#9CA3AF' }}>{stats.get(tuner)?.toLocaleString()}</span>
              </button>
            ))}
          </div>

          {/* Sort params info */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, color: '#374151' }}>Sort Order</div>
            <div style={{ fontSize: 10, color: '#6B7280' }}>
              {data.paramImportance.slice(0, 5).map((p, i) => (
                <div key={p.name} style={{ marginBottom: 2 }}>
                  {i + 1}. {p.name}
                </div>
              ))}
            </div>
          </div>

          {/* Overlap */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, color: '#374151' }}>Overlap</div>
            <div style={{ fontSize: 10, color: '#6B7280' }}>
              {Object.entries(data.overlapMatrix).map(([pair, ratio]) => {
                const [t1, t2] = pair.split('-') as [TunerType, TunerType];
                return (
                  <div key={pair} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span>
                      <span style={{ color: TUNER_COLORS[t1] }}>●</span>
                      {' ↔ '}
                      <span style={{ color: TUNER_COLORS[t2] }}>●</span>
                    </span>
                    <span style={{ fontWeight: 500 }}>{Math.round(ratio * 100)}%</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Legends */}
          {colorMode === 'coverage' && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 8, color: '#374151' }}>Coverage</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 10, color: '#9CA3AF' }}>0%</span>
                <div style={{
                  flex: 1, height: 12, borderRadius: 2,
                  background: 'linear-gradient(to right, #d73027, #fdae61, #d9ef8b, #1a9850)',
                }} />
                <span style={{ fontSize: 10, color: '#9CA3AF' }}>100%</span>
              </div>
            </div>
          )}

          {colorMode === 'overlap' && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 8, color: '#374151' }}>Overlap Legend</div>
              <div style={{ fontSize: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                  <div style={{ width: 12, height: 12, borderRadius: 2, backgroundColor: OVERLAP_COLORS.two }} />
                  <span style={{ color: '#6B7280' }}>2 tuners nearby</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div style={{ width: 12, height: 12, borderRadius: 2, backgroundColor: OVERLAP_COLORS.three }} />
                  <span style={{ color: '#6B7280' }}>3+ tuners nearby</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          style={{
            position: 'fixed',
            left: tooltip.x + 15,
            top: tooltip.y + 15,
            backgroundColor: 'white',
            border: '1px solid #E5E7EB',
            borderRadius: 6,
            padding: '10px 14px',
            fontSize: 11,
            lineHeight: 1.5,
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            pointerEvents: 'none',
            zIndex: 1000,
            maxWidth: 300,
          }}
        >
          <div style={{ marginBottom: 6 }}>
            <strong style={{ color: TUNER_COLORS[tooltip.trial.tuner] }}>
              {TUNER_DISPLAY_NAMES[tooltip.trial.tuner]}
            </strong>
            <span style={{ marginLeft: 8, color: '#9CA3AF' }}>
              Trial #{tooltip.trial.id}
            </span>
          </div>
          <div style={{ marginBottom: 6, color: '#4B5563' }}>
            {getTopParams(tooltip.trial.parameters, data.paramImportance, 4).map((p, i) => (
              <div key={i}>{p}</div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 12, borderTop: '1px solid #E5E7EB', paddingTop: 6 }}>
            <span style={{ color: '#10B981' }}>
              Cov: {(tooltip.trial.coverage * 100).toFixed(1)}%
            </span>
            <span style={{ color: tooltip.trial.marginalCoverage > 0 ? '#4F46E5' : '#9CA3AF' }}>
              +{tooltip.trial.marginalCoverage}
            </span>
          </div>
          {tooltip.trial.overlapWith.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 10, color: '#8B5CF6' }}>
              Near: {tooltip.trial.overlapWith.map(t => TUNER_DISPLAY_NAMES[t]).join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default OverviewMap;
