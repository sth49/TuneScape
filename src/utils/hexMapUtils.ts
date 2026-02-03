/**
 * Hexagonal Tile Map Utilities
 *
 * 1. Cluster 8,800 trials into ~100 groups
 * 2. Compute group distances (Gower)
 * 3. MDS for 2D layout
 * 4. Assign to hexagonal grid
 */

import type { ProcessedData } from '../types/data';

// ============================================================
// Types
// ============================================================

export type TunerType = 'SymTuner' | 'CMA_ES' | 'Genetic' | 'SuccessiveHalving';

export interface Trial {
  id: number;
  tuner: TunerType;
  parameters: Record<string, string | boolean | number>;
  coverage: number;
  marginalCoverage: number;
}

export interface Cluster {
  id: number;
  trials: Trial[];
  centroid: Record<string, number>;  // normalized parameter values
  tunerCounts: Record<TunerType, number>;
  totalTrials: number;
  avgCoverage: number;
  // Position after MDS
  x: number;
  y: number;
  // Hex grid position
  hexQ: number;
  hexR: number;
}

export interface HexTile {
  q: number;  // hex coordinate
  r: number;  // hex coordinate
  cluster: Cluster | null;
  x: number;  // pixel x
  y: number;  // pixel y
}

export interface HexMapData {
  clusters: Cluster[];
  hexTiles: HexTile[];
  gridRadius: number;
  paramImportance: { name: string; importance: number }[];
}

// ============================================================
// Constants
// ============================================================

export const TUNER_COLORS: Record<TunerType, string> = {
  'SymTuner': '#3B82F6',
  'CMA_ES': '#10B981',
  'Genetic': '#F59E0B',
  'SuccessiveHalving': '#EF4444',
};

export const TUNER_NAMES: TunerType[] = ['SymTuner', 'CMA_ES', 'Genetic', 'SuccessiveHalving'];

// ============================================================
// Parameter Analysis
// ============================================================

interface ParamStats {
  name: string;
  type: 'numeric' | 'categorical' | 'binary';
  min?: number;
  max?: number;
  categories?: (string | boolean)[];
}

function analyzeParams(trials: Trial[]): Map<string, ParamStats> {
  const stats = new Map<string, ParamStats>();
  if (trials.length === 0) return stats;

  const paramNames = Object.keys(trials[0].parameters);

  for (const name of paramNames) {
    const values = trials.map(t => t.parameters[name]);
    const firstVal = values[0];

    if (typeof firstVal === 'boolean') {
      stats.set(name, { name, type: 'binary', categories: [true, false] });
    } else if (typeof firstVal === 'string') {
      const unique = [...new Set(values)] as string[];
      stats.set(name, { name, type: 'categorical', categories: unique });
    } else {
      const nums = values.filter(v => typeof v === 'number') as number[];
      stats.set(name, {
        name,
        type: 'numeric',
        min: Math.min(...nums),
        max: Math.max(...nums),
      });
    }
  }

  return stats;
}

// ============================================================
// Feature Vector & Distance
// ============================================================

function trialToVector(
  trial: Trial,
  paramStats: Map<string, ParamStats>,
  topParams: string[]
): number[] {
  const vec: number[] = [];

  for (const name of topParams) {
    const stat = paramStats.get(name);
    const val = trial.parameters[name];

    if (!stat) {
      vec.push(0);
      continue;
    }

    if (stat.type === 'numeric' && stat.min !== undefined && stat.max !== undefined) {
      const range = stat.max - stat.min || 1;
      vec.push(typeof val === 'number' ? (val - stat.min) / range : 0);
    } else if (stat.type === 'categorical' && stat.categories) {
      // One-hot encoding (simplified: just index / count)
      const idx = stat.categories.indexOf(val as string);
      vec.push(idx >= 0 ? idx / (stat.categories.length - 1 || 1) : 0);
    } else if (stat.type === 'binary') {
      vec.push(val === true ? 1 : 0);
    } else {
      vec.push(0);
    }
  }

  return vec;
}

function vectorDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] - b[i]) ** 2;
  }
  return Math.sqrt(sum);
}

function centroidDistance(
  c1: Record<string, number>,
  c2: Record<string, number>,
  topParams: string[]
): number {
  let sum = 0;
  for (const p of topParams) {
    const diff = (c1[p] || 0) - (c2[p] || 0);
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

// ============================================================
// K-Means Clustering
// ============================================================

function kMeansClustering(
  trials: Trial[],
  k: number,
  paramStats: Map<string, ParamStats>,
  topParams: string[],
  maxIter: number = 20
): Cluster[] {
  const n = trials.length;
  const vectors = trials.map(t => trialToVector(t, paramStats, topParams));

  // Initialize centroids randomly (k-means++)
  const centroidIndices: number[] = [];
  centroidIndices.push(Math.floor(Math.random() * n));

  while (centroidIndices.length < k) {
    // Compute distances to nearest centroid
    const dists = vectors.map((v, i) => {
      let minD = Infinity;
      for (const ci of centroidIndices) {
        minD = Math.min(minD, vectorDistance(v, vectors[ci]));
      }
      return minD * minD;
    });

    // Weighted random selection
    const totalDist = dists.reduce((a, b) => a + b, 0);
    let r = Math.random() * totalDist;
    for (let i = 0; i < n; i++) {
      r -= dists[i];
      if (r <= 0) {
        centroidIndices.push(i);
        break;
      }
    }
  }

  // Initial centroids
  let centroids = centroidIndices.map(i => [...vectors[i]]);
  let assignments = new Array(n).fill(0);

  // Iterate
  for (let iter = 0; iter < maxIter; iter++) {
    // Assign each point to nearest centroid
    let changed = false;
    for (let i = 0; i < n; i++) {
      let minDist = Infinity;
      let minIdx = 0;
      for (let j = 0; j < k; j++) {
        const d = vectorDistance(vectors[i], centroids[j]);
        if (d < minDist) {
          minDist = d;
          minIdx = j;
        }
      }
      if (assignments[i] !== minIdx) {
        assignments[i] = minIdx;
        changed = true;
      }
    }

    if (!changed) break;

    // Update centroids
    const newCentroids = Array.from({ length: k }, () =>
      new Array(topParams.length).fill(0)
    );
    const counts = new Array(k).fill(0);

    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c]++;
      for (let j = 0; j < topParams.length; j++) {
        newCentroids[c][j] += vectors[i][j];
      }
    }

    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        for (let j = 0; j < topParams.length; j++) {
          newCentroids[c][j] /= counts[c];
        }
      }
    }

    centroids = newCentroids;
  }

  // Build clusters
  const clusters: Cluster[] = [];
  for (let c = 0; c < k; c++) {
    const clusterTrials = trials.filter((_, i) => assignments[i] === c);
    if (clusterTrials.length === 0) continue;

    const tunerCounts: Record<TunerType, number> = {
      'SymTuner': 0,
      'CMA_ES': 0,
      'Genetic': 0,
      'SuccessiveHalving': 0,
    };
    let totalMarginal = 0;

    for (const t of clusterTrials) {
      tunerCounts[t.tuner]++;
      totalMarginal += t.marginalCoverage;
    }

    const centroidObj: Record<string, number> = {};
    for (let j = 0; j < topParams.length; j++) {
      centroidObj[topParams[j]] = centroids[c][j];
    }

    clusters.push({
      id: clusters.length,
      trials: clusterTrials,
      centroid: centroidObj,
      tunerCounts,
      totalTrials: clusterTrials.length,
      avgCoverage: totalMarginal / clusterTrials.length,  // Now using marginal coverage
      x: 0,
      y: 0,
      hexQ: 0,
      hexR: 0,
    });
  }

  return clusters;
}

// ============================================================
// MDS for 2D Layout
// ============================================================

function computeClusterDistanceMatrix(
  clusters: Cluster[],
  topParams: string[]
): number[][] {
  const n = clusters.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = centroidDistance(clusters[i].centroid, clusters[j].centroid, topParams);
      matrix[i][j] = d;
      matrix[j][i] = d;
    }
  }

  return matrix;
}

function classicalMDS(distMatrix: number[][]): { x: number; y: number }[] {
  const n = distMatrix.length;
  if (n === 0) return [];

  // Squared distances
  const D2 = distMatrix.map(row => row.map(d => d * d));

  // Double centering
  const rowMeans = D2.map(row => row.reduce((a, b) => a + b, 0) / n);
  const colMeans = Array(n).fill(0);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      colMeans[j] += D2[i][j] / n;
    }
  }
  const grandMean = rowMeans.reduce((a, b) => a + b, 0) / n;

  const B = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      -0.5 * (D2[i][j] - rowMeans[i] - colMeans[j] + grandMean)
    )
  );

  // Power iteration for top 2 eigenvectors
  const eigenvalues: number[] = [];
  const eigenvectors: number[][] = [];
  const A = B.map(row => [...row]);

  for (let eigen = 0; eigen < 2; eigen++) {
    let v = Array.from({ length: n }, () => Math.random() - 0.5);
    let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    v = v.map(x => x / norm);

    let eigenvalue = 0;
    for (let iter = 0; iter < 100; iter++) {
      const Av = A.map(row => row.reduce((s, x, j) => s + x * v[j], 0));
      eigenvalue = Av.reduce((s, x, i) => s + x * v[i], 0);
      norm = Math.sqrt(Av.reduce((s, x) => s + x * x, 0));
      if (norm < 1e-10) break;
      v = Av.map(x => x / norm);
    }

    eigenvalues.push(Math.max(0, eigenvalue));
    eigenvectors.push(v);

    // Deflate
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        A[i][j] -= eigenvalue * v[i] * v[j];
      }
    }
  }

  // Coordinates
  const coords: { x: number; y: number }[] = [];
  const sqrtE0 = Math.sqrt(eigenvalues[0] || 0);
  const sqrtE1 = Math.sqrt(eigenvalues[1] || 0);

  for (let i = 0; i < n; i++) {
    coords.push({
      x: (eigenvectors[0]?.[i] || 0) * sqrtE0,
      y: (eigenvectors[1]?.[i] || 0) * sqrtE1,
    });
  }

  return coords;
}

// ============================================================
// Hexagonal Grid
// ============================================================

function axialToPixel(q: number, r: number, size: number): { x: number; y: number } {
  // Flat-top hexagon layout (traditional honeycomb)
  const x = size * 1.5 * q;
  const y = size * Math.sqrt(3) * (r + q / 2);
  return { x, y };
}

function pixelToAxial(x: number, y: number, size: number): { q: number; r: number } {
  const q = (2 / 3 * x) / size;
  const r = (-1 / 3 * x + Math.sqrt(3) / 3 * y) / size;
  return axialRound(q, r);
}

function axialRound(q: number, r: number): { q: number; r: number } {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  let rs = Math.round(s);

  const qDiff = Math.abs(rq - q);
  const rDiff = Math.abs(rr - r);
  const sDiff = Math.abs(rs - s);

  if (qDiff > rDiff && qDiff > sDiff) {
    rq = -rr - rs;
  } else if (rDiff > sDiff) {
    rr = -rq - rs;
  }

  return { q: rq, r: rr };
}

function generateHexGrid(radius: number): { q: number; r: number }[] {
  const hexes: { q: number; r: number }[] = [];

  for (let q = -radius; q <= radius; q++) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for (let r = r1; r <= r2; r++) {
      hexes.push({ q, r });
    }
  }

  return hexes;
}

/**
 * Generate a compact honeycomb grid with exactly n hexagons
 * Fills from center outward in a spiral pattern
 */
function generateCompactHexGrid(n: number): { q: number; r: number }[] {
  const hexes: { q: number; r: number }[] = [];

  if (n <= 0) return hexes;

  // Start from center
  hexes.push({ q: 0, r: 0 });

  // Directions for hex neighbors (clockwise from right)
  const directions = [
    { q: 1, r: 0 },   // right
    { q: 0, r: 1 },   // bottom-right
    { q: -1, r: 1 },  // bottom-left
    { q: -1, r: 0 },  // left
    { q: 0, r: -1 },  // top-left
    { q: 1, r: -1 },  // top-right
  ];

  let ring = 1;
  while (hexes.length < n) {
    // Start position for this ring
    let q = ring;
    let r = 0;

    // Walk around the ring
    for (let side = 0; side < 6 && hexes.length < n; side++) {
      const dir = directions[(side + 2) % 6]; // Adjusted direction for walking
      for (let step = 0; step < ring && hexes.length < n; step++) {
        hexes.push({ q, r });
        q += dir.q;
        r += dir.r;
      }
    }

    ring++;
  }

  return hexes.slice(0, n);
}

function pixelToAxialFloat(x: number, y: number, size: number): { q: number; r: number } {
  // Flat-top: inverse of axialToPixel
  const q = x / (size * 1.5);
  const r = (y / (size * Math.sqrt(3))) - q / 2;
  return { q, r };
}

function assignClustersToHex(
  clusters: Cluster[],
  hexSize: number
): HexTile[] {
  const n = clusters.length;
  if (n === 0) return [];

  // Get MDS positions
  const xs = clusters.map(c => c.x);
  const ys = clusters.map(c => c.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  // Scale MDS positions to a reasonable pixel range
  const targetSize = Math.sqrt(n) * hexSize * 2;

  const scaledClusters = clusters.map(c => ({
    cluster: c,
    px: ((c.x - minX) / rangeX - 0.5) * targetSize,
    py: ((c.y - minY) / rangeY - 0.5) * targetSize,
  }));

  // Convert each cluster's position to hex coordinates
  // Use greedy assignment to avoid overlaps
  const occupiedHexes = new Set<string>();
  const tiles: HexTile[] = [];

  // Sort by distance from center for better assignment
  const sortedClusters = [...scaledClusters].sort((a, b) => {
    const distA = a.px * a.px + a.py * a.py;
    const distB = b.px * b.px + b.py * b.py;
    return distA - distB;
  });

  for (const { cluster, px, py } of sortedClusters) {
    // Convert to axial coordinates
    const { q: rawQ, r: rawR } = pixelToAxialFloat(px, py, hexSize);
    const rounded = axialRound(rawQ, rawR);

    // Find nearest unoccupied hex using spiral search
    let bestQ = rounded.q;
    let bestR = rounded.r;
    let found = false;

    // Check the rounded position first
    const key = `${rounded.q},${rounded.r}`;
    if (!occupiedHexes.has(key)) {
      found = true;
      bestQ = rounded.q;
      bestR = rounded.r;
    } else {
      // Spiral outward to find empty hex
      const directions = [
        { dq: 1, dr: 0 }, { dq: 0, dr: 1 }, { dq: -1, dr: 1 },
        { dq: -1, dr: 0 }, { dq: 0, dr: -1 }, { dq: 1, dr: -1 },
      ];

      outer:
      for (let ring = 1; ring <= 10; ring++) {
        let q = rounded.q + ring;
        let r = rounded.r;

        for (let side = 0; side < 6; side++) {
          for (let step = 0; step < ring; step++) {
            const checkKey = `${q},${r}`;
            if (!occupiedHexes.has(checkKey)) {
              bestQ = q;
              bestR = r;
              found = true;
              break outer;
            }
            q += directions[(side + 2) % 6].dq;
            r += directions[(side + 2) % 6].dr;
          }
        }
      }
    }

    if (found) {
      occupiedHexes.add(`${bestQ},${bestR}`);
      const pixel = axialToPixel(bestQ, bestR, hexSize);
      cluster.hexQ = bestQ;
      cluster.hexR = bestR;
      tiles.push({
        q: bestQ,
        r: bestR,
        cluster,
        x: pixel.x,
        y: pixel.y,
      });
    }
  }

  return tiles;
}

// ============================================================
// Main Processing Function
// ============================================================

export function processHexMapData(
  tunerData: ProcessedData[],
  shapImportance: { name: string; importance: number }[],
  numClusters: number = 100
): HexMapData {
  // 1. Combine all trials
  const allTrials: Trial[] = [];

  for (const data of tunerData) {
    const tuner = data.tuner as TunerType;
    for (const trial of data.trials) {
      allTrials.push({
        id: trial.trialId,
        tuner,
        parameters: trial.parameters,
        coverage: data.totalUniqueBranches > 0
          ? trial.cumulativeCoverage / data.totalUniqueBranches
          : 0,
        marginalCoverage: trial.marginalCoverage,
      });
    }
  }

  // 2. Get all parameters (use all, not just top SHAP)
  const paramStats = analyzeParams(allTrials);
  const topParams = Array.from(paramStats.keys());  // Use all parameters

  // 3. Analyze parameters (already done above)

  // 4. K-means clustering
  const clusters = kMeansClustering(allTrials, numClusters, paramStats, topParams);

  // 5. Compute cluster distance matrix
  const distMatrix = computeClusterDistanceMatrix(clusters, topParams);

  // 6. MDS for 2D layout
  const coords = classicalMDS(distMatrix);
  for (let i = 0; i < clusters.length; i++) {
    clusters[i].x = coords[i]?.x || 0;
    clusters[i].y = coords[i]?.y || 0;
  }

  // 7. Assign to hex grid (compact honeycomb)
  const hexSize = 32;  // Must match HEX_SIZE in HexMap.tsx
  const hexTiles = assignClustersToHex(clusters, hexSize);

  // Calculate grid radius from actual tiles
  const gridRadius = Math.max(...hexTiles.map(t => Math.max(Math.abs(t.q), Math.abs(t.r))));

  return {
    clusters,
    hexTiles,
    gridRadius,
    paramImportance: shapImportance.slice(0, 10),
  };
}

// ============================================================
// Utility Functions
// ============================================================

export function getHexPath(size: number): string {
  // Flat-top hexagon (traditional honeycomb shape)
  const points: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;  // Start at 0° (flat top)
    const x = size * Math.cos(angle);
    const y = size * Math.sin(angle);
    points.push(`${x},${y}`);
  }
  return `M${points.join('L')}Z`;
}

export function getDominantTuner(tunerCounts: Record<TunerType, number>): TunerType {
  let max = 0;
  let dominant: TunerType = 'SymTuner';
  for (const [tuner, count] of Object.entries(tunerCounts)) {
    if (count > max) {
      max = count;
      dominant = tuner as TunerType;
    }
  }
  return dominant;
}

export function getTunerRatios(tunerCounts: Record<TunerType, number>): Record<TunerType, number> {
  const total = Object.values(tunerCounts).reduce((a, b) => a + b, 0);
  if (total === 0) return { SymTuner: 0, CMA_ES: 0, Genetic: 0, SuccessiveHalving: 0 };

  return {
    SymTuner: tunerCounts.SymTuner / total,
    CMA_ES: tunerCounts.CMA_ES / total,
    Genetic: tunerCounts.Genetic / total,
    SuccessiveHalving: tunerCounts.SuccessiveHalving / total,
  };
}
