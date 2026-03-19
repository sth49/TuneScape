/**
 * Overview Map Utilities (Fast Version)
 * - Uses parameter-based sorting instead of distance matrix
 * - Groups similar configurations together without heavy computation
 */

import type { ProcessedData } from '../types/data';

// ============================================================
// Types
// ============================================================

export type TunerType = 'SymTuner' | 'CMA_ES' | 'Genetic' | 'SuccessiveHalving' | 'TPE' | 'BayesianOptimization';

export interface OverviewTrial {
  id: number;
  globalId: number;
  tuner: TunerType;
  parameters: Record<string, string | boolean | number>;
  coverage: number;
  marginalCoverage: number;
  totalCovered: number;
  gridRow: number;
  gridCol: number;
  overlapWith: TunerType[];
  sortKey: string;
}

export interface TunerBoundaryEdge {
  row: number;
  col: number;
  side: 'top' | 'right' | 'bottom' | 'left';
}

export interface OverviewMapData {
  trials: OverviewTrial[];
  grid: (number | null)[][];
  gridSize: number;
  overlapMatrix: Record<string, number>;
  paramImportance: { name: string; importance: number }[];
  tunerBoundaries: Record<TunerType, TunerBoundaryEdge[]>;
}

// ============================================================
// Constants
// ============================================================

export const TUNER_COLORS: Record<TunerType, string> = {
  'SymTuner': '#3B82F6',
  'CMA_ES': '#10B981',
  'Genetic': '#F59E0B',
  'SuccessiveHalving': '#EF4444',
  'TPE': '#8B5CF6',
  'BayesianOptimization': '#EC4899',
};

export const TUNER_NAMES: TunerType[] = ['SymTuner', 'CMA_ES', 'Genetic', 'SuccessiveHalving', 'TPE', 'BayesianOptimization'];

// ============================================================
// Fast Processing (No Distance Matrix)
// ============================================================

/**
 * Create a sort key from top parameters
 * Similar configurations will have similar sort keys
 */
function createSortKey(
  params: Record<string, string | boolean | number>,
  topParams: string[],
  paramRanges: Map<string, { min: number; max: number; isNumeric: boolean }>
): string {
  const parts: string[] = [];

  for (const paramName of topParams) {
    const val = params[paramName];
    const range = paramRanges.get(paramName);

    if (val === undefined) {
      parts.push('_');
      continue;
    }

    if (typeof val === 'boolean') {
      parts.push(val ? '1' : '0');
    } else if (typeof val === 'string') {
      // For categorical, use first 2 chars
      parts.push(val.slice(0, 2).padEnd(2, '_'));
    } else if (typeof val === 'number' && range?.isNumeric) {
      // Bucket numeric values into 10 bins
      const normalized = (val - range.min) / (range.max - range.min || 1);
      const bucket = Math.min(9, Math.floor(normalized * 10));
      parts.push(bucket.toString());
    } else {
      parts.push(String(val).slice(0, 2));
    }
  }

  return parts.join('|');
}

/**
 * Compute parameter ranges for normalization
 */
function computeParamRanges(
  trials: { parameters: Record<string, string | boolean | number> }[]
): Map<string, { min: number; max: number; isNumeric: boolean }> {
  const ranges = new Map<string, { min: number; max: number; isNumeric: boolean }>();

  if (trials.length === 0) return ranges;

  const paramNames = Object.keys(trials[0].parameters);

  for (const name of paramNames) {
    const values = trials.map(t => t.parameters[name]);
    const numericValues = values.filter(v => typeof v === 'number') as number[];

    if (numericValues.length === values.length) {
      ranges.set(name, {
        min: Math.min(...numericValues),
        max: Math.max(...numericValues),
        isNumeric: true,
      });
    } else {
      ranges.set(name, { min: 0, max: 1, isNumeric: false });
    }
  }

  return ranges;
}

/**
 * Assign trials to grid using Hilbert curve-like pattern
 * This ensures spatial locality is preserved
 */
function assignToGridWithHilbert(
  sortedTrials: OverviewTrial[],
  gridSize: number
): { grid: (number | null)[][]; } {
  const grid: (number | null)[][] = Array.from({ length: gridSize }, () =>
    Array(gridSize).fill(null)
  );

  const n = sortedTrials.length;
  let trialIdx = 0;

  // Serpentine (boustrophedon) pattern for better locality
  for (let row = 0; row < gridSize && trialIdx < n; row++) {
    const isReverse = row % 2 === 1;

    for (let i = 0; i < gridSize && trialIdx < n; i++) {
      const col = isReverse ? (gridSize - 1 - i) : i;
      grid[row][col] = sortedTrials[trialIdx].globalId;
      sortedTrials[trialIdx].gridRow = row;
      sortedTrials[trialIdx].gridCol = col;
      trialIdx++;
    }
  }

  return { grid };
}

/**
 * Compute overlap based on grid proximity
 */
function computeOverlap(
  grid: (number | null)[][],
  trials: OverviewTrial[],
  trialMap: Map<number, OverviewTrial>,
  radius: number = 2
): void {
  const gridSize = grid.length;

  for (const trial of trials) {
    const { gridRow: r, gridCol: c } = trial;
    const nearbyTuners = new Set<TunerType>();

    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const nr = r + dr;
        const nc = c + dc;

        if (nr >= 0 && nr < gridSize && nc >= 0 && nc < gridSize) {
          const neighborId = grid[nr][nc];
          if (neighborId !== null) {
            const neighbor = trialMap.get(neighborId);
            if (neighbor) {
              nearbyTuners.add(neighbor.tuner);
            }
          }
        }
      }
    }

    nearbyTuners.delete(trial.tuner);
    trial.overlapWith = [...nearbyTuners];
  }
}

/**
 * Compute tuner region boundaries
 */
function computeTunerBoundaries(
  grid: (number | null)[][],
  trialMap: Map<number, OverviewTrial>
): Record<TunerType, TunerBoundaryEdge[]> {
  const gridSize = grid.length;
  const boundaries: Record<TunerType, TunerBoundaryEdge[]> = {
    'SymTuner': [],
    'CMA_ES': [],
    'Genetic': [],
    'SuccessiveHalving': [],
  };

  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      const idx = grid[r][c];
      if (idx === null) continue;

      const trial = trialMap.get(idx);
      if (!trial) continue;

      const tuner = trial.tuner;

      // Check each direction for boundary
      const checks: [number, number, 'top' | 'right' | 'bottom' | 'left'][] = [
        [-1, 0, 'top'],
        [0, 1, 'right'],
        [1, 0, 'bottom'],
        [0, -1, 'left'],
      ];

      for (const [dr, dc, side] of checks) {
        const nr = r + dr;
        const nc = c + dc;

        // Is this edge a boundary?
        let isBoundary = false;
        if (nr < 0 || nr >= gridSize || nc < 0 || nc >= gridSize) {
          isBoundary = true;
        } else {
          const neighborIdx = grid[nr][nc];
          if (neighborIdx === null) {
            isBoundary = true;
          } else {
            const neighbor = trialMap.get(neighborIdx);
            if (!neighbor || neighbor.tuner !== tuner) {
              isBoundary = true;
            }
          }
        }

        if (isBoundary) {
          boundaries[tuner].push({ row: r, col: c, side });
        }
      }
    }
  }

  return boundaries;
}

/**
 * Compute pairwise overlap matrix
 */
function computeOverlapMatrix(trials: OverviewTrial[]): Record<string, number> {
  const matrix: Record<string, number> = {};
  const tunerTrials = new Map<TunerType, OverviewTrial[]>();

  for (const t of TUNER_NAMES) {
    tunerTrials.set(t, trials.filter(trial => trial.tuner === t));
  }

  for (let i = 0; i < TUNER_NAMES.length; i++) {
    for (let j = i + 1; j < TUNER_NAMES.length; j++) {
      const t1 = TUNER_NAMES[i];
      const t2 = TUNER_NAMES[j];

      const trials1 = tunerTrials.get(t1)!;
      const overlapCount = trials1.filter(t => t.overlapWith.includes(t2)).length;
      const ratio = trials1.length > 0 ? overlapCount / trials1.length : 0;

      matrix[`${t1}-${t2}`] = Math.round(ratio * 100) / 100;
    }
  }

  return matrix;
}

// ============================================================
// Main Processing Function
// ============================================================

export function processOverviewMapData(
  tunerData: ProcessedData[],
  shapImportance: { name: string; importance: number }[]
): OverviewMapData {
  // 1. Combine all trials
  const allTrials: OverviewTrial[] = [];
  let globalId = 0;

  for (const data of tunerData) {
    const tuner = data.tuner as TunerType;

    for (const trial of data.trials) {
      allTrials.push({
        id: trial.trialId,
        globalId,
        tuner,
        parameters: trial.parameters,
        coverage: data.totalUniqueBranches > 0
          ? trial.cumulativeCoverage / data.totalUniqueBranches
          : 0,
        marginalCoverage: trial.marginalCoverage,
        totalCovered: trial.totalCovered,
        gridRow: 0,
        gridCol: 0,
        overlapWith: [],
        sortKey: '',
      });
      globalId++;
    }
  }

  // 2. Get top parameters for sorting
  const topParams = shapImportance
    .slice(0, 5)
    .map(p => p.name);

  // 3. Compute parameter ranges
  const paramRanges = computeParamRanges(allTrials);

  // 4. Create sort keys
  for (const trial of allTrials) {
    trial.sortKey = createSortKey(trial.parameters, topParams, paramRanges);
  }

  // 5. Sort trials by sort key (groups similar configs together)
  allTrials.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  // 6. Assign to grid
  const gridSize = Math.ceil(Math.sqrt(allTrials.length)) + 2;
  const { grid } = assignToGridWithHilbert(allTrials, gridSize);

  // 7. Create lookup map
  const trialMap = new Map<number, OverviewTrial>();
  for (const t of allTrials) {
    trialMap.set(t.globalId, t);
  }

  // 8. Compute overlaps
  computeOverlap(grid, allTrials, trialMap, 2);
  const overlapMatrix = computeOverlapMatrix(allTrials);

  // 9. Compute tuner boundaries
  const tunerBoundaries = computeTunerBoundaries(grid, trialMap);

  return {
    trials: allTrials,
    grid,
    gridSize,
    overlapMatrix,
    paramImportance: shapImportance.slice(0, 10),
    tunerBoundaries,
  };
}

// ============================================================
// Utility Functions
// ============================================================

export function getTopParams(
  parameters: Record<string, string | boolean | number>,
  importance: { name: string; importance: number }[],
  count: number = 3
): string[] {
  const top = importance.slice(0, count);
  return top.map(({ name }) => {
    const val = parameters[name];
    if (val === undefined) return `${name}=?`;
    if (typeof val === 'boolean') {
      return `${name}=${val ? 'T' : 'F'}`;
    }
    if (typeof val === 'number') {
      return `${name}=${Math.round(val * 100) / 100}`;
    }
    return `${name}=${val}`;
  });
}
