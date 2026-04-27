/**
 * Hexagonal Tile Map Utilities
 *
 * 1. Cluster 8,800 trials into ~100 groups
 * 2. Compute group distances (Gower)
 * 3. MDS for 2D layout
 * 4. Assign to hexagonal grid
 */

import type { ProcessedData } from "../types/data";

// ============================================================
// Seeded PRNG (mulberry32) — deterministic, no Math.random()
// ============================================================
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

// ============================================================
// Types
// ============================================================

export type TunerType = "SymTuner" | "CMA_ES" | "Genetic" | "SuccessiveHalving" | "TPE" | "BayesianOptimization";

export interface Trial {
  id: number;
  tuner: TunerType;
  parameters: Record<string, string | boolean | number>;
  coverage: number;
  marginalCoverage: number;
  coveredBranches: number[];
}

export interface Cluster {
  id: number;
  trials: Trial[];
  centroid: Record<string, number>; // normalized parameter values
  tunerCounts: Record<TunerType, number>;
  totalTrials: number;
  avgCoverage: number;
  meanBranchCoverage: number;
  maxBranchCoverage: number;
  meanMarginalCoverage: number;
  coveredBranches: number[]; // sorted union of all trial coverage vectors
  tunerCoveredBranches: Partial<Record<TunerType, number[]>>; // per-tuner branch unions
  // Position after MDS
  x: number;
  y: number;
  // Hex grid position
  hexQ: number;
  hexR: number;
}

export interface HexTile {
  q: number; // hex coordinate
  r: number; // hex coordinate
  cluster: Cluster | null;
  x: number; // pixel x
  y: number; // pixel y
}

/**
 * Connected sub-group within a Territory.
 * Label is contrastive vs parent (territory or parent sub-region).
 * Recursively splittable: children are binary splits gated by label meaningfulness.
 */
export interface SubRegion {
  id: number;
  territoryId: number;
  clusters: Cluster[];
  tiles: HexTile[];
  trials: Trial[];
  totalTrials: number;
  tunerCounts: Record<TunerType, number>;
  pixelCentroidX: number;
  pixelCentroidY: number;
  label: string;
  children: SubRegion[];  // recursive binary splits (empty = leaf)
  splittable: boolean;     // true if children exist with meaningful labels
  depth: number;           // 0 = first split of territory
}

/** Spatially connected group of hex clusters (BFS on hex grid). */
export interface Territory {
  id: number;
  clusters: Cluster[];
  tiles: HexTile[];
  trials: Trial[]; // flat list of all trials in this territory
  totalTrials: number;
  tunerCounts: Record<TunerType, number>;
  centroidX: number; // MDS centroid (kept for voronoi compat)
  centroidY: number;
  pixelCentroidX: number; // tile pixel centroid (for label placement)
  pixelCentroidY: number;
  label: string; // macro label: territory vs global
  subRegions: SubRegion[]; // internal sub-regions with local-contrast labels
}

export interface HexMapData {
  clusters: Cluster[];
  hexTiles: HexTile[];
  territories: Territory[];
  gridRadius: number;
  hexSize: number;
  totalUniqueBranches: number;
  paramImportance: { name: string; importance: number }[];
  paramStats: Map<string, ParamStats>;
  labelParams: string[];
}

// ============================================================
// Constants
// ============================================================

// schemeCategory10 excluding orange (#ff7f0e) and red (#d62728)
export const TUNER_COLORS: Record<TunerType, string> = {
  SymTuner: "#1f77b4",           // blue
  CMA_ES: "#2ca02c",             // green
  Genetic: "#9467bd",            // purple
  SuccessiveHalving: "#8c564b",  // brown
  TPE: "#b85e93",                // muted pink
  BayesianOptimization: "#17becf", // cyan
};

export const TUNER_NAMES: TunerType[] = [
  "SymTuner",
  "CMA_ES",
  "Genetic",
  "SuccessiveHalving",
  "TPE",
  "BayesianOptimization",
];

// ============================================================
// Parameter Analysis
// ============================================================

export interface ParamStats {
  name: string;
  type: "numeric" | "categorical" | "binary";
  min?: number;
  max?: number;
  categories?: (string | boolean)[];
}

function analyzeParams(trials: Trial[]): Map<string, ParamStats> {
  const stats = new Map<string, ParamStats>();
  if (trials.length === 0) return stats;

  const paramNames = Object.keys(trials[0].parameters);

  for (const name of paramNames) {
    const values = trials.map((t) => t.parameters[name]);
    const firstVal = values[0];

    if (typeof firstVal === "boolean") {
      stats.set(name, { name, type: "binary", categories: [true, false] });
    } else if (typeof firstVal === "string") {
      const unique = [...new Set(values)] as string[];
      stats.set(name, { name, type: "categorical", categories: unique });
    } else {
      const nums = values.filter((v) => typeof v === "number") as number[];
      // Detect integer-valued params with few unique values as categorical
      const unique = [...new Set(nums)];
      const allInt = nums.every((v) => Number.isInteger(v));
      if (allInt && unique.length <= 20) {
        const cats = unique.sort((a, b) => a - b).map(String);
        stats.set(name, { name, type: "categorical", categories: cats });
      } else {
        stats.set(name, {
          name,
          type: "numeric",
          min: Math.min(...nums),
          max: Math.max(...nums),
        });
      }
    }
  }

  return stats;
}

// ============================================================
// Feature Vector & Distance
// ============================================================

/**
 * Trial → flat feature vector.
 * - numeric  : min-max normalized scalar
 * - binary   : 0 / 1
 * - categorical : one-hot (one bit per category)
 *
 * The vector length is sum(1 for numeric/bool, n_cats for categorical).
 */
function trialToVector(
  trial: Trial,
  paramStats: Map<string, ParamStats>,
  topParams: string[],
): number[] {
  const vec: number[] = [];
  for (const name of topParams) {
    const stat = paramStats.get(name);
    const val = trial.parameters[name];
    if (!stat) { vec.push(0); continue; }
    if (stat.type === "numeric" && stat.min !== undefined && stat.max !== undefined) {
      const range = stat.max - stat.min || 1;
      vec.push(typeof val === "number" ? (val - stat.min) / range : 0);
    } else if (stat.type === "binary") {
      vec.push(val === true ? 1 : 0);
    } else if (stat.type === "categorical" && stat.categories) {
      for (const cat of stat.categories) {
        vec.push(String(val) === String(cat) ? 1 : 0);
      }
    } else {
      vec.push(0);
    }
  }
  return vec;
}

function vectorDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

/**
 * Cluster centroid stored as Record<string, number>:
 * - numeric / binary : "paramName" → normalized mean / proportion-of-true
 * - categorical      : "paramName__catValue" → proportion in cluster
 */
function computeClusterCentroid(
  trials: Trial[],
  paramStats: Map<string, ParamStats>,
  topParams: string[],
): Record<string, number> {
  const n = trials.length;
  const centroid: Record<string, number> = {};
  if (n === 0) return centroid;
  for (const name of topParams) {
    const stat = paramStats.get(name);
    if (!stat) continue;
    if (stat.type === "numeric" && stat.min !== undefined && stat.max !== undefined) {
      const range = stat.max - stat.min || 1;
      let sum = 0;
      for (const t of trials) {
        const v = t.parameters[name];
        sum += typeof v === "number" ? (v - stat.min) / range : 0;
      }
      centroid[name] = sum / n;
    } else if (stat.type === "binary") {
      centroid[name] = trials.filter(t => t.parameters[name] === true).length / n;
    } else if (stat.type === "categorical" && stat.categories) {
      for (const cat of stat.categories) {
        const key = `${name}__${String(cat)}`;
        centroid[key] = trials.filter(t => String(t.parameters[name]) === String(cat)).length / n;
      }
    }
  }
  return centroid;
}

/**
 * Flatten centroid record → same one-hot layout as trialToVector.
 * Used for sub-region k-means on cluster centroids.
 */
function clusterCentroidToVec(
  centroid: Record<string, number>,
  paramStats: Map<string, ParamStats>,
  topParams: string[],
): number[] {
  const vec: number[] = [];
  for (const name of topParams) {
    const stat = paramStats.get(name);
    if (!stat) { vec.push(0); continue; }
    if (stat.type === "numeric" || stat.type === "binary") {
      vec.push(centroid[name] ?? 0);
    } else if (stat.type === "categorical" && stat.categories) {
      for (const cat of stat.categories) {
        vec.push(centroid[`${name}__${String(cat)}`] ?? 0);
      }
    }
  }
  return vec;
}

/**
 * Per-param equal-weight distance between two cluster centroids.
 *
 * Each parameter contributes exactly one unit (d_i ∈ [0,1]):
 *   numeric / binary  : d_i = |c1[p] - c2[p]|
 *   categorical       : d_i = 0.5 * Σ_c |c1[p__c] - c2[p__c]|
 *                       (total variation distance between two distributions → [0,1])
 *
 * Result = sqrt(Σ d_i² / nParams) so categorical params with 11 categories
 * do not dominate over boolean params with 1 dimension.
 */
function centroidDistance(
  c1: Record<string, number>,
  c2: Record<string, number>,
  paramStats: Map<string, ParamStats>,
  topParams: string[],
): number {
  let sumSq = 0;
  let nParams = 0;
  for (const name of topParams) {
    const stat = paramStats.get(name);
    if (!stat) continue;
    let d: number;
    if (stat.type === "numeric" || stat.type === "binary") {
      d = Math.abs((c1[name] ?? 0) - (c2[name] ?? 0));
    } else if (stat.type === "categorical" && stat.categories) {
      let l1 = 0;
      for (const cat of stat.categories) {
        const key = `${name}__${String(cat)}`;
        l1 += Math.abs((c1[key] ?? 0) - (c2[key] ?? 0));
      }
      d = l1 / 2; // total variation: always in [0, 1] for probability distributions
    } else {
      d = 0;
    }
    sumSq += d * d;
    nParams++;
  }
  return nParams > 0 ? Math.sqrt(sumSq / nParams) : 0;
}

// ============================================================
// K-Means Clustering
// ============================================================

function kMeansClustering(
  trials: Trial[],
  k: number,
  paramStats: Map<string, ParamStats>,
  topParams: string[],
  maxIter: number = 20,
): Cluster[] {
  const n = trials.length;
  const vectors = trials.map((t) => trialToVector(t, paramStats, topParams));

  // Initialize centroids (k-means++ with fixed seed)
  const rng = seededRng(0x1a2b3c4d ^ (k * 6271) ^ (n * 9973 + 1));
  const centroidIndices: number[] = [];
  centroidIndices.push(Math.floor(rng() * n));

  while (centroidIndices.length < k) {
    // Compute distances to nearest centroid
    const dists = vectors.map((v) => {
      let minD = Infinity;
      for (const ci of centroidIndices) {
        minD = Math.min(minD, vectorDistance(v, vectors[ci]));
      }
      return minD * minD;
    });

    // Weighted random selection
    const totalDist = dists.reduce((a, b) => a + b, 0);
    let r = rng() * totalDist;
    for (let i = 0; i < n; i++) {
      r -= dists[i];
      if (r <= 0) {
        centroidIndices.push(i);
        break;
      }
    }
  }

  // Initial centroids
  let centroids = centroidIndices.map((i) => [...vectors[i]]);
  const assignments = new Array(n).fill(0);

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

    // Update centroids (use actual vector length, not topParams.length)
    const vecLen = vectors[0]?.length ?? 0;
    const newCentroids = Array.from({ length: k }, () => new Array(vecLen).fill(0));
    const counts = new Array(k).fill(0);

    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c]++;
      for (let j = 0; j < vecLen; j++) newCentroids[c][j] += vectors[i][j];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        for (let j = 0; j < vecLen; j++) newCentroids[c][j] /= counts[c];
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
      SymTuner: 0, CMA_ES: 0, Genetic: 0, SuccessiveHalving: 0, TPE: 0, BayesianOptimization: 0,
    };
    let totalMarginal = 0;
    let totalBranchCoverage = 0;
    let maxBranchCoverage = 0;
    for (const t of clusterTrials) {
      tunerCounts[t.tuner]++;
      totalMarginal += t.marginalCoverage;
      totalBranchCoverage += t.coverage;
      maxBranchCoverage = Math.max(maxBranchCoverage, t.coverage);
    }

    // Centroid: per-param proportions computed from actual trials
    const centroidObj = computeClusterCentroid(clusterTrials, paramStats, topParams);

    // Compute union of covered branches across all trials in this cluster
    const branchUnion = new Set<number>();
    const tunerBranchSets: Partial<Record<TunerType, Set<number>>> = {};
    for (const t of clusterTrials) {
      for (const b of t.coveredBranches) branchUnion.add(b);
      if (!tunerBranchSets[t.tuner]) tunerBranchSets[t.tuner] = new Set();
      for (const b of t.coveredBranches) tunerBranchSets[t.tuner]!.add(b);
    }
    const tunerCoveredBranches: Partial<Record<TunerType, number[]>> = {};
    for (const [tuner, brSet] of Object.entries(tunerBranchSets)) {
      tunerCoveredBranches[tuner as TunerType] = Array.from(brSet).sort((a, b) => a - b);
    }

    clusters.push({
      id: clusters.length,
      trials: clusterTrials,
      centroid: centroidObj,
      tunerCounts,
      totalTrials: clusterTrials.length,
      avgCoverage: totalMarginal / clusterTrials.length,
      meanBranchCoverage: totalBranchCoverage / clusterTrials.length,
      maxBranchCoverage,
      meanMarginalCoverage: totalMarginal / clusterTrials.length,
      coveredBranches: Array.from(branchUnion).sort((a, b) => a - b),
      tunerCoveredBranches,
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
  paramStats: Map<string, ParamStats>,
  topParams: string[],
): number[][] {
  const n = clusters.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = centroidDistance(
        clusters[i].centroid,
        clusters[j].centroid,
        paramStats,
        topParams,
      );
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
  const D2 = distMatrix.map((row) => row.map((d) => d * d));

  // Double centering
  const rowMeans = D2.map((row) => row.reduce((a, b) => a + b, 0) / n);
  const colMeans = Array(n).fill(0);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      colMeans[j] += D2[i][j] / n;
    }
  }
  const grandMean = rowMeans.reduce((a, b) => a + b, 0) / n;

  const B = Array.from({ length: n }, (_, i) =>
    Array.from(
      { length: n },
      (_, j) => -0.5 * (D2[i][j] - rowMeans[i] - colMeans[j] + grandMean),
    ),
  );

  // Power iteration for top 2 eigenvectors
  const eigenvalues: number[] = [];
  const eigenvectors: number[][] = [];
  const A = B.map((row) => [...row]);

  for (let eigen = 0; eigen < 2; eigen++) {
    const eigRng = seededRng(0xdeadbeef ^ (eigen * 2654435761));
    let v = Array.from({ length: n }, () => eigRng() - 0.5);
    let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    v = v.map((x) => x / norm);

    let eigenvalue = 0;
    for (let iter = 0; iter < 100; iter++) {
      const Av = A.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
      eigenvalue = Av.reduce((s, x, i) => s + x * v[i], 0);
      norm = Math.sqrt(Av.reduce((s, x) => s + x * x, 0));
      if (norm < 1e-10) break;
      v = Av.map((x) => x / norm);
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

function axialToPixel(
  q: number,
  r: number,
  size: number,
): { x: number; y: number } {
  // Flat-top hexagon layout (traditional honeycomb)
  const x = size * 1.5 * q;
  const y = size * Math.sqrt(3) * (r + q / 2);
  return { x, y };
}

function axialRound(q: number, r: number): { q: number; r: number } {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);

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

function pixelToAxialFloat(
  x: number,
  y: number,
  size: number,
): { q: number; r: number } {
  // Flat-top: inverse of axialToPixel
  const q = x / (size * 1.5);
  const r = y / (size * Math.sqrt(3)) - q / 2;
  return { q, r };
}

function assignClustersToHex(clusters: Cluster[], hexSize: number): HexTile[] {
  const n = clusters.length;
  if (n === 0) return [];

  // Get MDS positions
  const xs = clusters.map((c) => c.x);
  const ys = clusters.map((c) => c.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  // Scale MDS positions to a reasonable pixel range
  const targetSize = Math.sqrt(n) * hexSize * 2;

  const scaledClusters = clusters.map((c) => ({
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
        { dq: 1, dr: 0 },
        { dq: 0, dr: 1 },
        { dq: -1, dr: 1 },
        { dq: -1, dr: 0 },
        { dq: 0, dr: -1 },
        { dq: 1, dr: -1 },
      ];

      outer: for (let ring = 1; ring <= 10; ring++) {
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
// Territory Computation (BFS on hex grid)
// ============================================================

const HEX_DIRS = [
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
  [1, -1],
] as const;

function computeTerritories(
  hexTiles: HexTile[],
): Omit<Territory, "label" | "subRegions">[] {
  const occupied = new Set<string>();
  const tileMap = new Map<string, HexTile>();

  for (const tile of hexTiles) {
    if (!tile.cluster) continue;
    const key = `${tile.q},${tile.r}`;
    occupied.add(key);
    tileMap.set(key, tile);
  }

  const visited = new Set<string>();
  const components: HexTile[][] = [];

  for (const key of occupied) {
    if (visited.has(key)) continue;
    const queue = [key];
    visited.add(key);
    const component: HexTile[] = [];

    while (queue.length > 0) {
      const curr = queue.shift()!;
      component.push(tileMap.get(curr)!);
      const [cq, cr] = curr.split(",").map(Number);
      for (const [dq, dr] of HEX_DIRS) {
        const nk = `${cq + dq},${cr + dr}`;
        if (occupied.has(nk) && !visited.has(nk)) {
          visited.add(nk);
          queue.push(nk);
        }
      }
    }

    components.push(component);
  }

  return components
    .map((tiles, idx) => {
      const clusters = tiles.map((t) => t.cluster!);
      const trials: Trial[] = clusters.flatMap((c) => c.trials);
      const tunerCounts: Record<TunerType, number> = {
        SymTuner: 0,
        CMA_ES: 0,
        Genetic: 0,
        SuccessiveHalving: 0,
        TPE: 0,
        BayesianOptimization: 0,
      };
      let totalTrials = 0;
      let cx = 0,
        cy = 0,
        pcx = 0,
        pcy = 0;

      for (const c of clusters) {
        totalTrials += c.totalTrials;
        for (const tuner of TUNER_NAMES)
          tunerCounts[tuner] += c.tunerCounts[tuner];
        cx += c.x;
        cy += c.y;
      }
      for (const t of tiles) {
        pcx += t.x;
        pcy += t.y;
      }

      return {
        id: idx,
        clusters,
        tiles,
        trials,
        totalTrials,
        tunerCounts,
        centroidX: cx / clusters.length,
        centroidY: cy / clusters.length,
        pixelCentroidX: pcx / tiles.length,
        pixelCentroidY: pcy / tiles.length,
      };
    })
    .filter((t) => t.clusters.length > 0)
    .sort((a, b) => b.totalTrials - a.totalTrials);
}

// ============================================================
// Sub-Region Building (adjacency-constrained within each Territory)
// ============================================================

/**
 * Minimal k-means on a small set of feature vectors.
 * Uses farthest-point initialization (deterministic, spread-out).
 */
function smallKMeans(vecs: number[][], k: number, maxIter = 15): number[] {
  const n = vecs.length;
  if (n === 0) return [];
  k = Math.min(k, n);
  const dim = vecs[0].length;

  // Farthest-point init
  const centIdx: number[] = [0];
  while (centIdx.length < k) {
    let best = 0,
      bestD = -1;
    for (let i = 0; i < n; i++) {
      const d = Math.min(
        ...centIdx.map((ci) =>
          vecs[i].reduce((s, v, j) => s + (v - vecs[ci][j]) ** 2, 0),
        ),
      );
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    centIdx.push(best);
  }

  const cents = centIdx.map((ci) => [...vecs[ci]]);
  const assign = new Array<number>(n).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0,
        bestD = Infinity;
      for (let j = 0; j < k; j++) {
        const d = vecs[i].reduce((s, v, di) => s + (v - cents[j][di]) ** 2, 0);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        changed = true;
      }
    }
    if (!changed) break;

    const newCents = Array.from({ length: k }, () =>
      new Array<number>(dim).fill(0),
    );
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) {
      counts[assign[i]]++;
      for (let di = 0; di < dim; di++) newCents[assign[i]][di] += vecs[i][di];
    }
    for (let j = 0; j < k; j++) {
      if (counts[j] > 0) cents[j] = newCents[j].map((v) => v / counts[j]);
    }
  }
  return assign;
}

/** BFS connected components restricted to `subset`, using `terrHexMap` for lookup. */
function hexConnectedComponentsSubset(
  subset: Cluster[],
  terrHexMap: Map<string, Cluster>,
): Cluster[][] {
  const subsetKeys = new Set(subset.map((c) => `${c.hexQ},${c.hexR}`));
  const visited = new Set<string>();
  const components: Cluster[][] = [];

  for (const start of subset) {
    const sk = `${start.hexQ},${start.hexR}`;
    if (visited.has(sk)) continue;
    const comp: Cluster[] = [];
    const queue = [sk];
    visited.add(sk);

    while (queue.length > 0) {
      const curr = queue.shift()!;
      comp.push(terrHexMap.get(curr)!);
      const [cq, cr] = curr.split(",").map(Number);
      for (const [dq, dr] of HEX_DIRS) {
        const nk = `${cq + dq},${cr + dr}`;
        if (subsetKeys.has(nk) && !visited.has(nk)) {
          visited.add(nk);
          queue.push(nk);
        }
      }
    }
    components.push(comp);
  }
  return components;
}

/**
 * Merge sub-region components smaller than `minSize` into their
 * largest hex-adjacent neighbor component.
 */
function mergeSmallComponents(
  components: Cluster[][],
  terrHexMap: Map<string, Cluster>,
  minSize: number,
): Cluster[][] {
  const keyToComp = new Map<string, number>();
  const setKey = (c: Cluster, idx: number) =>
    keyToComp.set(`${c.hexQ},${c.hexR}`, idx);
  for (let ci = 0; ci < components.length; ci++) {
    for (const c of components[ci]) setKey(c, ci);
  }

  let changed = true;
  while (changed) {
    changed = false;
    let smallIdx = -1,
      smallSize = Infinity;
    for (let ci = 0; ci < components.length; ci++) {
      if (
        components[ci].length > 0 &&
        components[ci].length < minSize &&
        components[ci].length < smallSize
      ) {
        smallSize = components[ci].length;
        smallIdx = ci;
      }
    }
    if (smallIdx === -1) break;

    const adj = new Set<number>();
    for (const c of components[smallIdx]) {
      for (const [dq, dr] of HEX_DIRS) {
        const nk = `${c.hexQ + dq},${c.hexR + dr}`;
        if (terrHexMap.has(nk)) {
          const ni = keyToComp.get(nk);
          if (ni !== undefined && ni !== smallIdx) adj.add(ni);
        }
      }
    }
    if (adj.size === 0) break; // isolated, keep

    const targetIdx = [...adj].reduce((b, ci) =>
      components[ci].length > components[b].length ? ci : b,
    );
    for (const c of components[smallIdx]) {
      keyToComp.set(`${c.hexQ},${c.hexR}`, targetIdx);
      components[targetIdx].push(c);
    }
    components[smallIdx] = [];
    changed = true;
  }
  return components.filter((c) => c.length > 0);
}

function makeSubRegionObj(
  id: number,
  territoryId: number,
  clusters: Cluster[],
  tiles: HexTile[],
): Omit<SubRegion, "label" | "children" | "splittable" | "depth"> {
  const tunerCounts: Record<TunerType, number> = {
    SymTuner: 0,
    CMA_ES: 0,
    Genetic: 0,
    SuccessiveHalving: 0,
    TPE: 0,
    BayesianOptimization: 0,
  };
  let totalTrials = 0,
    pcx = 0,
    pcy = 0;
  for (const c of clusters) {
    totalTrials += c.totalTrials;
    for (const t of TUNER_NAMES) tunerCounts[t] += c.tunerCounts[t];
  }
  for (const t of tiles) {
    pcx += t.x;
    pcy += t.y;
  }
  return {
    id,
    territoryId,
    clusters,
    tiles,
    trials: clusters.flatMap((c) => c.trials),
    totalTrials,
    tunerCounts,
    pixelCentroidX: tiles.length > 0 ? pcx / tiles.length : 0,
    pixelCentroidY: tiles.length > 0 ? pcy / tiles.length : 0,
  };
}

/**
 * Multi-way split: K-means with moderate k, then keep only groups that
 * produce a meaningful contrastive label. Unlabeled groups are merged
 * into a single unlabeled sub-region. Each labeled sub-region can be
 * recursively split further (children).
 */
function multiWaySplit(
  region: { clusters: Cluster[]; tiles: HexTile[]; trials: Trial[]; territoryId: number },
  parentTrials: Trial[],
  labelParams: string[],
  paramStats: Map<string, ParamStats>,
  importanceMap: Map<string, number>,
  depth: number,
  maxDepth: number,
  nextId: { value: number },
): SubRegion[] {
  const clusters = region.clusters;
  const n = clusters.length;

  const tileByKey = new Map<string, HexTile>();
  for (const tile of region.tiles) tileByKey.set(`${tile.q},${tile.r}`, tile);

  // Too small or too deep → single leaf
  if (n < 4 || depth >= maxDepth) {
    const raw = makeSubRegionObj(nextId.value++, region.territoryId, clusters, region.tiles);
    return [{ ...raw, label: "", children: [], splittable: false, depth }];
  }

  // Choose k: sqrt(n) clamped to [3, 8]
  const k = Math.max(3, Math.min(8, Math.ceil(Math.sqrt(n))));

  const vecs = clusters.map((c) =>
    clusterCentroidToVec(c.centroid, paramStats, labelParams)
  );
  if (vecs[0].length === 0) {
    const raw = makeSubRegionObj(nextId.value++, region.territoryId, clusters, region.tiles);
    return [{ ...raw, label: "", children: [], splittable: false, depth }];
  }

  const assigns = smallKMeans(vecs, k);

  // Group clusters by assignment
  const groups = new Map<number, Cluster[]>();
  for (let i = 0; i < n; i++) {
    const g = assigns[i];
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(clusters[i]);
  }

  // Build candidate sub-region objects for each group
  const candidates: { raw: ReturnType<typeof makeSubRegionObj>; groupClusters: Cluster[]; tiles: HexTile[] }[] = [];
  for (const [, groupClusters] of groups) {
    if (groupClusters.length === 0) continue;
    const groupTiles = groupClusters
      .map((c) => tileByKey.get(`${c.hexQ},${c.hexR}`))
      .filter((t): t is HexTile => !!t);
    const raw = makeSubRegionObj(nextId.value++, region.territoryId, groupClusters, groupTiles);
    candidates.push({ raw, groupClusters, tiles: groupTiles });
  }

  // Generate contrastive labels for all groups vs parent
  const labels = generateSubRegionLabels(
    candidates.map((c) => c.raw),
    parentTrials,
    paramStats,
    labelParams,
    importanceMap,
  );

  // Separate labeled vs unlabeled groups
  const labeled: { raw: typeof candidates[0]["raw"]; label: string; groupClusters: Cluster[]; tiles: HexTile[] }[] = [];
  const unlabeledClusters: Cluster[] = [];
  const unlabeledTiles: HexTile[] = [];

  for (let i = 0; i < candidates.length; i++) {
    if (labels[i]) {
      labeled.push({ ...candidates[i], label: labels[i] });
    } else {
      // Reclaim the ID used for this unlabeled group
      unlabeledClusters.push(...candidates[i].groupClusters);
      unlabeledTiles.push(...candidates[i].tiles);
    }
  }

  // If no groups got a label, return single unlabeled leaf
  if (labeled.length === 0) {
    // Reclaim all candidate IDs
    nextId.value -= candidates.length;
    const raw = makeSubRegionObj(nextId.value++, region.territoryId, clusters, region.tiles);
    return [{ ...raw, label: "", children: [], splittable: false, depth }];
  }

  const results: SubRegion[] = [];

  // Labeled sub-regions: recursively try to split further
  for (const item of labeled) {
    const children = multiWaySplit(
      { clusters: item.groupClusters, tiles: item.tiles, trials: item.raw.trials, territoryId: region.territoryId },
      item.raw.trials, labelParams, paramStats, importanceMap, depth + 1, maxDepth, nextId,
    );
    const splittable = children.length > 1 || (children.length === 1 && children[0].splittable);
    results.push({ ...item.raw, label: item.label, children, splittable, depth });
  }

  // Merge all unlabeled clusters into one unlabeled sub-region (if any)
  if (unlabeledClusters.length > 0) {
    const raw = makeSubRegionObj(nextId.value++, region.territoryId, unlabeledClusters, unlabeledTiles);
    results.push({ ...raw, label: "", children: [], splittable: false, depth });
  }

  return results;
}

/**
 * Divide a territory into sub-regions using multi-way meaningful splits.
 * K-means with moderate k, keep groups with contrastive labels, merge the rest.
 */
export function buildSubRegionsForTerritory(
  territory: Omit<Territory, "label" | "subRegions">,
  topParams: string[],
  paramStats: Map<string, ParamStats>,
  importanceMap: Map<string, number>,
  maxDepth: number = 3,
): SubRegion[] {
  const nextId = { value: 0 };
  const results = multiWaySplit(
    { clusters: territory.clusters, tiles: territory.tiles, trials: territory.trials, territoryId: territory.id },
    territory.trials, topParams, paramStats, importanceMap, 0, maxDepth, nextId,
  );

  return results;
}

// ============================================================
// Contrastive Predicate Label Generation
// ============================================================

/** Atomic condition that can be true/false for a given trial */
interface Predicate {
  param: string;
  kind: "bool_true" | "bool_false" | "cat" | "num_low" | "num_mid" | "num_high";
  value?: string; // for 'cat' kind
  label: string; // human-readable: "watchdog=T", "search=random-path", "High seed-time"
}

interface ScoredPred {
  pred: Predicate;
  supportIn: number;
  supportOut: number;
  score: number;
}

/**
 * Enumerate atomic predicates restricted to params in shapImportance.
 * boolean → {param}=T / {param}=F
 * categorical → {param}={each value}
 * numeric → Low/Mid/High {param} (thirds of normalized range)
 *
 * Params NOT in shapImportance are silently skipped so unimportant
 * settings cannot appear in labels.
 */
function buildPredicates(
  paramStats: Map<string, ParamStats>,
  labelParams: string[], // pre-filtered to shapImportance params
): Predicate[] {
  const preds: Predicate[] = [];
  for (const name of labelParams) {
    const stat = paramStats.get(name);
    if (!stat) continue;
    if (stat.type === "binary") {
      preds.push({ param: name, kind: "bool_true", label: `${name}=T` });
      preds.push({ param: name, kind: "bool_false", label: `${name}=F` });
    } else if (stat.type === "categorical" && stat.categories) {
      for (const cat of stat.categories) {
        preds.push({
          param: name,
          kind: "cat",
          value: String(cat),
          label: `${name}=${cat}`,
        });
      }
    } else if (stat.type === "numeric") {
      preds.push({ param: name, kind: "num_low", label: `Low ${name}` });
      preds.push({ param: name, kind: "num_mid", label: `Mid ${name}` });
      preds.push({ param: name, kind: "num_high", label: `High ${name}` });
    }
  }
  return preds;
}

function satisfiesPredicate(
  trial: Trial,
  pred: Predicate,
  paramStats: Map<string, ParamStats>,
): boolean {
  const val = trial.parameters[pred.param];
  switch (pred.kind) {
    case "bool_true":
      return val === true;
    case "bool_false":
      return val === false;
    case "cat":
      return String(val) === pred.value;
    case "num_low":
    case "num_mid":
    case "num_high": {
      const stat = paramStats.get(pred.param);
      if (
        !stat ||
        stat.type !== "numeric" ||
        stat.min === undefined ||
        stat.max === undefined
      )
        return false;
      const range = stat.max - stat.min || 1;
      const norm = typeof val === "number" ? (val - stat.min) / range : 0;
      if (pred.kind === "num_low") return norm < 1 / 3;
      if (pred.kind === "num_mid") return norm >= 1 / 3 && norm < 2 / 3;
      /* num_high */ return norm >= 2 / 3;
    }
    default:
      return false;
  }
}

/**
 * Compute contrastive predicate labels for every territory.
 *
 * Score = support_in × log((support_in + ε) / (support_out + ε)) × importance_weight
 *
 * Filters:
 *   support_in ≥ 0.55           (common inside the territory)
 *   support_in − support_out ≥ 0.20  (notably more frequent than outside)
 *
 * Selection: greedy top-2 from distinct parameters.
 *
 * Fix — trial identity:
 *   Uses Map<Trial, number> (object reference) as index key, so trials from
 *   different tuners with the same numeric id cannot collide.
 */
function generateTerritoryLabels(
  territories: Omit<Territory, "label" | "subRegions">[],
  allTrials: Trial[],
  paramStats: Map<string, ParamStats>,
  labelParams: string[],
  importanceMap: Map<string, number>,
): string[] {
  const predicates = buildPredicates(paramStats, labelParams);
  if (predicates.length === 0) return territories.map(() => "");

  const n = allTrials.length;
  const nPred = predicates.length;

  // FIX 1: object-reference key — avoids id collisions across tuners
  const trialIdx = new Map<Trial, number>();
  for (let i = 0; i < n; i++) trialIdx.set(allTrials[i], i);

  // Precompute satisfaction matrix [predIdx × trialIdx] with global counts
  const satisfies: Uint8Array[] = new Array(nPred);
  const globalCount: number[] = new Array(nPred);
  for (let pi = 0; pi < nPred; pi++) {
    const row = new Uint8Array(n);
    let cnt = 0;
    for (let ti = 0; ti < n; ti++) {
      if (satisfiesPredicate(allTrials[ti], predicates[pi], paramStats)) {
        row[ti] = 1;
        cnt++;
      }
    }
    satisfies[pi] = row;
    globalCount[pi] = cnt;
  }

  const EPS = 1e-6;

  return territories.map((territory) => {
    const terrTrials = territory.trials;
    const nIn = terrTrials.length;
    if (nIn === 0) return "";
    const nOut = n - nIn;

    // Resolve object-reference indices for this territory's trials
    const idxs: number[] = [];
    for (const t of terrTrials) {
      const idx = trialIdx.get(t);
      if (idx !== undefined) idxs.push(idx);
    }

    const scored: ScoredPred[] = [];
    for (let pi = 0; pi < nPred; pi++) {
      const row = satisfies[pi];
      let inCnt = 0;
      for (const idx of idxs) inCnt += row[idx];

      const supportIn = inCnt / nIn;
      if (supportIn < 0.45) continue;

      const outCnt = globalCount[pi] - inCnt;
      const supportOut = nOut > 0 ? outCnt / nOut : 0;
      if (supportIn - supportOut < 0.13) continue;

      const importance = importanceMap.get(predicates[pi].param) ?? 0;
      const score =
        supportIn *
        Math.log((supportIn + EPS) / (supportOut + EPS)) *
        importance;
      scored.push({ pred: predicates[pi], supportIn, supportOut, score });
    }

    scored.sort((a, b) => b.score - a.score);
    if (scored.length === 0) return "";

    const first = scored[0];
    const parts = [first.pred.label];
    const second = scored.find((s) => s.pred.param !== first.pred.param);
    if (second) parts.push(second.pred.label);
    return parts.join(", ");
  });
}

/**
 * Score sub-region predicates vs macro-region-rest (local contrast).
 * macroTrials = all trials in the parent territory.
 * This gives much finer labels than global contrast inside large territories.
 */
export function generateSubRegionLabels(
  subRegions: Array<{ trials: Trial[] }>,
  macroTrials: Trial[],
  paramStats: Map<string, ParamStats>,
  labelParams: string[],
  importanceMap: Map<string, number>,
): string[] {
  // Single sub-region still gets a label (territory summary vs global)
  if (subRegions.length === 0) return [];

  const predicates = buildPredicates(paramStats, labelParams);
  if (predicates.length === 0) return subRegions.map(() => "");

  const macroN = macroTrials.length;
  const nPred = predicates.length;

  // Object-reference index within macroTrials
  const macroIdx = new Map<Trial, number>();
  for (let i = 0; i < macroN; i++) macroIdx.set(macroTrials[i], i);

  const satisfies: Uint8Array[] = new Array(nPred);
  const macroCounts: number[] = new Array(nPred);
  for (let pi = 0; pi < nPred; pi++) {
    const row = new Uint8Array(macroN);
    let cnt = 0;
    for (let ti = 0; ti < macroN; ti++) {
      if (satisfiesPredicate(macroTrials[ti], predicates[pi], paramStats)) {
        row[ti] = 1;
        cnt++;
      }
    }
    satisfies[pi] = row;
    macroCounts[pi] = cnt;
  }

  const EPS = 1e-6;

  return subRegions.map((sub) => {
    const nIn = sub.trials.length;
    if (nIn === 0) return "";
    const nOut = macroN - nIn;

    const idxs: number[] = [];
    for (const t of sub.trials) {
      const idx = macroIdx.get(t);
      if (idx !== undefined) idxs.push(idx);
    }

    const scored: ScoredPred[] = [];
    for (let pi = 0; pi < nPred; pi++) {
      const row = satisfies[pi];
      let inCnt = 0;
      for (const idx of idxs) inCnt += row[idx];

      const supportIn = inCnt / nIn;
      if (supportIn < 0.45) continue;

      const outCnt = macroCounts[pi] - inCnt;
      const supportOut = nOut > 0 ? outCnt / nOut : 0;
      if (supportIn - supportOut < 0.13) continue;

      const importance = importanceMap.get(predicates[pi].param) ?? 0;
      const score =
        supportIn *
        Math.log((supportIn + EPS) / (supportOut + EPS)) *
        importance;
      scored.push({ pred: predicates[pi], supportIn, supportOut, score });
    }

    scored.sort((a, b) => b.score - a.score);
    if (scored.length === 0) return "";

    const first = scored[0];
    const parts = [first.pred.label];
    const second = scored.find((s) => s.pred.param !== first.pred.param);
    if (second) parts.push(second.pred.label);
    return parts.join(", ");
  });
}

// ============================================================
// Main Processing Function
// ============================================================
// Local Detail Re-Clustering
// ============================================================

/**
 * Re-cluster the trials of a single subRegion into finer local clusters.
 * Runs k-means on the raw trials using SHAP-filtered params (or all params
 * if shapImportance is empty). Returns clusters only — no MDS/hex layout yet.
 *
 * Target k = clamp(ceil(sqrt(trials.length) * 0.6), 8, 60)
 * so small SRs get fewer clusters and large SRs get proportionally more.
 */
export interface LocalDetailData {
  clusters: Cluster[];
  clusterCount: number;
  totalTrials: number;
  paramStats: Map<string, ParamStats>;
  topParams: string[];
}

export function buildLocalDetailClusters(
  trials: Trial[],
  shapImportance: { name: string; importance: number }[] = [],
): LocalDetailData | null {
  if (trials.length === 0) return null;

  const paramStats = analyzeParams(trials);
  const allParams = Array.from(paramStats.keys());

  // Use SHAP-filtered params when available, fall back to all params
  const importanceMap = new Map(shapImportance.map((s) => [s.name, s.importance]));
  const topParams = importanceMap.size > 0
    ? allParams.filter((p) => importanceMap.has(p))
    : allParams;
  const useParams = topParams.length > 0 ? topParams : allParams;

  // Target k: proportional to sqrt(n), conservative bounds
  const k = Math.min(60, Math.max(8, Math.ceil(Math.sqrt(trials.length) * 0.6)));

  const clusters = kMeansClustering(trials, k, paramStats, useParams);

  return {
    clusters,
    clusterCount: clusters.length,
    totalTrials: trials.length,
    paramStats,
    topParams: useParams,
  };
}

// ============================================================
// Coarse Level Building
// Produces progressively fewer, spatially-merged "super-clusters"
// by running k-means on cluster pixel-centroid positions.
// Level 4 = current (finest), levels 3-0 = progressively coarser.
// ============================================================

export interface CoarseCluster {
  id: number;
  memberClusterIds: number[];      // original cluster.id values
  tunerCounts: Record<TunerType, number>;
  totalTrials: number;
  pixelCentroidX: number;          // average of member tile pixel positions
  pixelCentroidY: number;
  label: string;                   // dominant tuner name
}

export interface CoarseLevel {
  level: number;                   // 3, 2, 1, or 0
  k: number;                       // number of coarse clusters
  clusters: CoarseCluster[];
  clusterIdToCoarseId: Map<number, number>; // original cluster.id → coarse id
}

/** Simple k-means on 2-D points. Returns point.id → centroid index. */
function kMeansPositions(
  points: { id: number; x: number; y: number }[],
  k: number,
  maxIter = 40,
): Map<number, number> {
  const safeK = Math.min(k, points.length);
  if (safeK === 0) return new Map();

  // Init: pick evenly spaced points as seeds
  const step = Math.floor(points.length / safeK);
  let centroids = Array.from({ length: safeK }, (_, i) => ({
    x: points[(i * step) % points.length].x,
    y: points[(i * step) % points.length].y,
  }));

  let assignments = new Map<number, number>();

  for (let iter = 0; iter < maxIter; iter++) {
    const next = new Map<number, number>();
    for (const pt of points) {
      let best = 0, bestDist = Infinity;
      for (let ci = 0; ci < safeK; ci++) {
        const dx = pt.x - centroids[ci].x;
        const dy = pt.y - centroids[ci].y;
        const d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; best = ci; }
      }
      next.set(pt.id, best);
    }

    let changed = false;
    for (const pt of points) {
      if (next.get(pt.id) !== assignments.get(pt.id)) { changed = true; break; }
    }
    assignments = next;
    if (!changed && iter > 0) break;

    // Recompute centroids
    const sums = Array.from({ length: safeK }, () => ({ x: 0, y: 0, n: 0 }));
    for (const pt of points) {
      const ci = assignments.get(pt.id)!;
      sums[ci].x += pt.x; sums[ci].y += pt.y; sums[ci].n++;
    }
    centroids = sums.map((s, i) =>
      s.n > 0 ? { x: s.x / s.n, y: s.y / s.n } : centroids[i],
    );
  }
  return assignments;
}

/**
 * Build 4 progressively coarser cluster levels from the finest (level 4) data.
 * Level 3 ≈ 50% of level-4 clusters, level 2 ≈ 25%, level 1 ≈ 12%, level 0 ≈ 6%.
 * Merging is purely spatial (k-means on pixel centroids), so positions are preserved.
 */
export function buildCoarseLevels(data: HexMapData): CoarseLevel[] {
  const { clusters, hexTiles } = data;
  const n = clusters.length;
  if (n === 0) return [];

  // Build pixel centroid for each cluster from its hex tiles
  const tilePixels = new Map<number, { sumX: number; sumY: number; count: number }>();
  for (const tile of hexTiles) {
    if (!tile.cluster) continue;
    const cid = tile.cluster.id;
    if (!tilePixels.has(cid)) tilePixels.set(cid, { sumX: 0, sumY: 0, count: 0 });
    const e = tilePixels.get(cid)!;
    e.sumX += tile.x; e.sumY += tile.y; e.count++;
  }

  const clusterPoints = clusters.map((c) => {
    const px = tilePixels.get(c.id);
    return {
      id: c.id,
      x: px ? px.sumX / px.count : c.x,
      y: px ? px.sumY / px.count : c.y,
    };
  });

  const ratios = [0.5, 0.25, 0.12, 0.06];
  const levels: CoarseLevel[] = [];

  for (let li = 0; li < ratios.length; li++) {
    const targetK = Math.max(2, Math.round(n * ratios[li]));
    const assignments = kMeansPositions(clusterPoints, targetK);

    // Remap centroid indices to compact 0..actualK-1 ids
    const centroidSet = new Set(assignments.values());
    const centroidRemap = new Map<number, number>();
    let cid = 0;
    for (const ci of centroidSet) centroidRemap.set(ci, cid++);

    const coarseMap = new Map<number, {
      memberClusterIds: number[];
      tunerCounts: Record<TunerType, number>;
      totalTrials: number;
      pixelXs: number[]; pixelYs: number[];
    }>();

    for (const cluster of clusters) {
      const rawCi = assignments.get(cluster.id) ?? 0;
      const ci = centroidRemap.get(rawCi) ?? 0;
      if (!coarseMap.has(ci)) {
        coarseMap.set(ci, {
          memberClusterIds: [],
          tunerCounts: { SymTuner: 0, CMA_ES: 0, Genetic: 0, SuccessiveHalving: 0, TPE: 0, BayesianOptimization: 0 },
          totalTrials: 0,
          pixelXs: [], pixelYs: [],
        });
      }
      const cc = coarseMap.get(ci)!;
      cc.memberClusterIds.push(cluster.id);
      for (const t of TUNER_NAMES) cc.tunerCounts[t] += cluster.tunerCounts[t];
      cc.totalTrials += cluster.totalTrials;
      const px = tilePixels.get(cluster.id);
      if (px) { cc.pixelXs.push(px.sumX / px.count); cc.pixelYs.push(px.sumY / px.count); }
    }

    const coarseClusters: CoarseCluster[] = [];
    const clusterIdToCoarseId = new Map<number, number>();

    // Build cluster → trials lookup
    const clusterTrials = new Map<number, Trial[]>();
    for (const c of clusters) clusterTrials.set(c.id, c.trials);

    for (const [ci, cc] of coarseMap) {
      coarseClusters.push({
        id: ci,
        memberClusterIds: cc.memberClusterIds,
        tunerCounts: cc.tunerCounts,
        totalTrials: cc.totalTrials,
        pixelCentroidX: cc.pixelXs.length > 0 ? cc.pixelXs.reduce((a, b) => a + b, 0) / cc.pixelXs.length : 0,
        pixelCentroidY: cc.pixelYs.length > 0 ? cc.pixelYs.reduce((a, b) => a + b, 0) / cc.pixelYs.length : 0,
        label: '', // filled below after contrastive labeling
      });
      for (const origId of cc.memberClusterIds) clusterIdToCoarseId.set(origId, ci);
    }

    // Compute contrastive parameter labels (each coarse cluster vs all trials)
    const allTrials = clusters.flatMap(c => c.trials);
    const importanceMap = new Map(data.paramImportance.map(p => [p.name, p.importance]));
    const coarseAsSubRegions = coarseClusters.map(cc => ({
      trials: cc.memberClusterIds.flatMap(cid => clusterTrials.get(cid) ?? []),
    }));
    const coarseLabels = generateSubRegionLabels(
      coarseAsSubRegions, allTrials, data.paramStats, data.labelParams, importanceMap,
    );
    for (let i = 0; i < coarseClusters.length; i++) {
      coarseClusters[i].label = coarseLabels[i] || getDominantTuner(coarseClusters[i].tunerCounts);
    }

    levels.push({ level: 3 - li, k: coarseClusters.length, clusters: coarseClusters, clusterIdToCoarseId });
  }

  return levels; // [level3, level2, level1, level0]
}

// ============================================================

/**
 * 2D Procrustes alignment: transform `source` points to best match `target` points.
 * Finds optimal rotation, uniform scaling, reflection, and translation.
 * Returns the aligned coordinates (same length as source).
 */
function procrustesAlign(
  source: { x: number; y: number }[],
  target: { x: number; y: number }[],
): { x: number; y: number }[] {
  const n = Math.min(source.length, target.length);
  if (n < 2) return source;

  // Center both
  let smx = 0, smy = 0, tmx = 0, tmy = 0;
  for (let i = 0; i < n; i++) {
    smx += source[i].x; smy += source[i].y;
    tmx += target[i].x; tmy += target[i].y;
  }
  smx /= n; smy /= n; tmx /= n; tmy /= n;

  const sc = source.map(p => ({ x: p.x - smx, y: p.y - smy }));
  const tc = target.map(p => ({ x: p.x - tmx, y: p.y - tmy }));

  // Compute optimal rotation+reflection using SVD of cross-covariance
  // For 2D: M = Σ tc[i] * sc[i]^T  → [[a, b], [c, d]]
  let a = 0, b = 0, c = 0, d = 0;
  for (let i = 0; i < n; i++) {
    a += tc[i].x * sc[i].x;
    b += tc[i].x * sc[i].y;
    c += tc[i].y * sc[i].x;
    d += tc[i].y * sc[i].y;
  }

  // SVD of 2x2: find rotation that maximizes trace(R * M)
  // Optimal R: try both rotation and reflection, pick the one with lower error
  const angle = Math.atan2(c - b, a + d);
  const cosA = Math.cos(angle), sinA = Math.sin(angle);

  // Scale: ||target|| / ||source||
  let ssNorm = 0, stNorm = 0;
  for (let i = 0; i < n; i++) {
    ssNorm += sc[i].x * sc[i].x + sc[i].y * sc[i].y;
    stNorm += tc[i].x * tc[i].x + tc[i].y * tc[i].y;
  }
  const scale = ssNorm > 0 ? Math.sqrt(stNorm / ssNorm) : 1;

  // Try rotation only
  const applyTransform = (pts: typeof sc, cos: number, sin: number, s: number, reflectY: boolean) =>
    pts.map(p => ({
      x: s * (cos * p.x - sin * (reflectY ? -p.y : p.y)) + tmx,
      y: s * (sin * p.x + cos * (reflectY ? -p.y : p.y)) + tmy,
    }));

  const r1 = applyTransform(sc, cosA, sinA, scale, false);
  const r2 = applyTransform(sc, cosA, sinA, scale, true);

  // Also try with reflection + different angle
  const angle2 = Math.atan2(c + b, a - d);
  const cosB = Math.cos(angle2), sinB = Math.sin(angle2);
  const r3 = applyTransform(sc, cosB, sinB, scale, true);

  // Pick the one with minimum total squared error
  const err = (r: typeof r1) => {
    let e = 0;
    for (let i = 0; i < n; i++) {
      e += (r[i].x - target[i].x) ** 2 + (r[i].y - target[i].y) ** 2;
    }
    return e;
  };

  const candidates = [r1, r2, r3];
  let best = r1, bestErr = err(r1);
  for (const cand of candidates) {
    const ce = err(cand);
    if (ce < bestErr) { best = cand; bestErr = ce; }
  }

  // Apply same transform to ALL source points (not just first n)
  // Re-derive the winning transform params
  // For simplicity, just return the aligned first n + unaligned rest
  if (source.length === n) return best;

  // Need to apply to all source points: find which candidate won and re-apply
  const bestIdx = candidates.indexOf(best);
  const allSc = source.map(p => ({ x: p.x - smx, y: p.y - smy }));
  if (bestIdx === 0) return applyTransform(allSc, cosA, sinA, scale, false);
  if (bestIdx === 1) return applyTransform(allSc, cosA, sinA, scale, true);
  return applyTransform(allSc, cosB, sinB, scale, true);
}

// ============================================================
// Hierarchical Merge: build coarser level by merging parent clusters
// ============================================================

/**
 * Build a coarser HexMapData by spatially merging clusters from the parent level.
 *
 * Instead of running independent k-means on raw trials, this groups parent-level
 * clusters using spatial k-means on their pixel positions, then merges each group
 * into a single new Cluster. The merged cluster's position is the centroid of its
 * member clusters' pixel positions, preserving spatial continuity across levels.
 *
 * Pipeline: spatial k-means → merge clusters → assign hex grid → territories →
 *           sub-regions → detail regions → labels
 */
export function buildMergedLevel(
  parent: HexMapData,
  targetK: number,
  shapImportance: { name: string; importance: number }[],
): HexMapData {
  const parentClusters = parent.clusters;
  const n = parentClusters.length;
  if (n === 0) return { ...parent, clusters: [], hexTiles: [], territories: [] };

  // 1. Build pixel positions for each parent cluster from hex tiles
  const tilePixels = new Map<number, { sumX: number; sumY: number; count: number }>();
  for (const tile of parent.hexTiles) {
    if (!tile.cluster) continue;
    const cid = tile.cluster.id;
    if (!tilePixels.has(cid)) tilePixels.set(cid, { sumX: 0, sumY: 0, count: 0 });
    const e = tilePixels.get(cid)!;
    e.sumX += tile.x; e.sumY += tile.y; e.count++;
  }

  const clusterPoints = parentClusters.map((c) => {
    const px = tilePixels.get(c.id);
    return {
      id: c.id,
      x: px ? px.sumX / px.count : c.x,
      y: px ? px.sumY / px.count : c.y,
    };
  });

  // 2. Spatial k-means to group parent clusters
  const assignments = kMeansPositions(clusterPoints, targetK);

  // Remap centroid indices to compact 0..actualK-1
  const centroidSet = new Set(assignments.values());
  const centroidRemap = new Map<number, number>();
  let remapId = 0;
  for (const ci of centroidSet) centroidRemap.set(ci, remapId++);

  // 3. Group parent clusters by assignment
  const groups = new Map<number, Cluster[]>();
  for (const cluster of parentClusters) {
    const rawCi = assignments.get(cluster.id) ?? 0;
    const ci = centroidRemap.get(rawCi) ?? 0;
    if (!groups.has(ci)) groups.set(ci, []);
    groups.get(ci)!.push(cluster);
  }

  // 4. Create merged Cluster objects
  const paramStats = parent.paramStats;
  const topParams = Array.from(paramStats.keys());
  const mergedClusters: Cluster[] = [];

  for (const [groupId, memberClusters] of groups) {
    const allTrials = memberClusters.flatMap((c) => c.trials);
    const tunerCounts: Record<TunerType, number> = {
      SymTuner: 0, CMA_ES: 0, Genetic: 0,
      SuccessiveHalving: 0, TPE: 0, BayesianOptimization: 0,
    };
    let sumCov = 0, sumBranch = 0, maxBranch = 0, sumMarginal = 0;
    for (const mc of memberClusters) {
      for (const t of TUNER_NAMES) tunerCounts[t] += mc.tunerCounts[t];
      sumCov += mc.avgCoverage * mc.totalTrials;
      sumBranch += mc.meanBranchCoverage * mc.totalTrials;
      maxBranch = Math.max(maxBranch, mc.maxBranchCoverage);
      sumMarginal += mc.meanMarginalCoverage * mc.totalTrials;
    }
    const totalTrials = allTrials.length;

    // Position = centroid of member cluster pixel positions
    let cx = 0, cy = 0;
    for (const mc of memberClusters) {
      const px = tilePixels.get(mc.id);
      cx += px ? px.sumX / px.count : mc.x;
      cy += px ? px.sumY / px.count : mc.y;
    }
    cx /= memberClusters.length;
    cy /= memberClusters.length;

    const centroid = computeClusterCentroid(allTrials, paramStats, topParams);

    // Merge covered branches from member clusters
    const branchUnion = new Set<number>();
    const tunerBranchSets: Partial<Record<TunerType, Set<number>>> = {};
    for (const mc of memberClusters) {
      for (const b of mc.coveredBranches) branchUnion.add(b);
      if (mc.tunerCoveredBranches) {
        for (const [tuner, branches] of Object.entries(mc.tunerCoveredBranches)) {
          if (!tunerBranchSets[tuner as TunerType]) tunerBranchSets[tuner as TunerType] = new Set();
          for (const b of branches!) tunerBranchSets[tuner as TunerType]!.add(b);
        }
      }
    }
    const tunerCoveredBranches: Partial<Record<TunerType, number[]>> = {};
    for (const [tuner, brSet] of Object.entries(tunerBranchSets)) {
      tunerCoveredBranches[tuner as TunerType] = Array.from(brSet).sort((a, b) => a - b);
    }

    mergedClusters.push({
      id: groupId,
      trials: allTrials,
      centroid,
      tunerCounts,
      totalTrials,
      avgCoverage: totalTrials > 0 ? sumCov / totalTrials : 0,
      meanBranchCoverage: totalTrials > 0 ? sumBranch / totalTrials : 0,
      maxBranchCoverage: maxBranch,
      meanMarginalCoverage: totalTrials > 0 ? sumMarginal / totalTrials : 0,
      coveredBranches: Array.from(branchUnion).sort((a, b) => a - b),
      tunerCoveredBranches,
      x: cx,
      y: cy,
      hexQ: 0, // will be set by assignClustersToHex
      hexR: 0,
    });
  }

  // 5. Assign merged clusters to hex grid with scaled hex size
  const BASE_HEX = 32;
  const REF_CLUSTERS = 200;
  const hexSize = BASE_HEX * Math.sqrt(REF_CLUSTERS / Math.max(mergedClusters.length, 1));
  const hexTiles = assignClustersToHex(mergedClusters, hexSize);

  // 6. Build territories
  const preLabelTerritories = computeTerritories(hexTiles);

  // 7. Labels
  const importanceMap = new Map(
    shapImportance.map((s) => [s.name, s.importance]),
  );
  const labelParams = topParams.filter((p) => importanceMap.has(p));
  const allTrials = mergedClusters.flatMap((c) => c.trials);

  const macroLabels = generateTerritoryLabels(
    preLabelTerritories,
    allTrials,
    paramStats,
    labelParams,
    importanceMap,
  );

  const territories: Territory[] = preLabelTerritories.map((t, i) => {
    const subRegions = buildSubRegionsForTerritory(t, labelParams, paramStats, importanceMap);
    return { ...t, label: macroLabels[i], subRegions };
  });

  const gridRadius = hexTiles.length > 0
    ? Math.max(...hexTiles.map((t) => Math.max(Math.abs(t.q), Math.abs(t.r))))
    : 0;

  return {
    clusters: mergedClusters,
    hexTiles,
    territories,
    gridRadius,
    hexSize,
    totalUniqueBranches: parent.totalUniqueBranches,
    paramImportance: shapImportance.slice(0, 10),
    paramStats,
    labelParams,
  };
}

export function processHexMapData(
  tunerData: ProcessedData[],
  shapImportance: { name: string; importance: number }[],
  numClusters: number = 160,
  /** Optional: reference trial positions from L4 for Procrustes alignment */
  refTrialPositions?: Map<string, { x: number; y: number }>,
): HexMapData {
  // 1. Combine all trials
  const totalUniqueBranches = tunerData.length > 0 ? tunerData[0].totalUniqueBranches : 0;
  const allTrials: Trial[] = [];

  for (const data of tunerData) {
    const tuner = data.tuner as TunerType;
    for (const trial of data.trials) {
      allTrials.push({
        id: trial.trialId,
        tuner,
        parameters: trial.parameters as Record<string, string | boolean | number>,
        // Per-trial branch count (size of this trial's coveredBranches set).
        // NOT cumulativeCoverage — that's the running optimization-run total.
        coverage: trial.coveredBranches?.length ?? 0,
        marginalCoverage: trial.marginalCoverage,
        coveredBranches: trial.coveredBranches ?? [],
      });
    }
  }

  // 2. Get all parameters (use all, not just top SHAP)
  const paramStats = analyzeParams(allTrials);
  const topParams = Array.from(paramStats.keys()); // Use all parameters

  // 3. Analyze parameters (already done above)

  // 4. K-means clustering
  const clusters = kMeansClustering(
    allTrials,
    numClusters,
    paramStats,
    topParams,
  );

  // 5. Compute cluster distance matrix
  const distMatrix = computeClusterDistanceMatrix(clusters, paramStats, topParams);

  // 6. MDS for 2D layout
  const coords = classicalMDS(distMatrix);
  for (let i = 0; i < clusters.length; i++) {
    clusters[i].x = coords[i]?.x || 0;
    clusters[i].y = coords[i]?.y || 0;
  }

  // 6b. Procrustes alignment to reference (L4) positions
  if (refTrialPositions && refTrialPositions.size > 0) {
    // Compute expected position for each cluster as the centroid of its trials' reference positions
    const targetPositions: { x: number; y: number }[] = [];
    const sourcePositions: { x: number; y: number }[] = [];
    for (const cluster of clusters) {
      let sx = 0, sy = 0, count = 0;
      for (const trial of cluster.trials) {
        const key = `${trial.tuner}:${trial.id}`;
        const ref = refTrialPositions.get(key);
        if (ref) { sx += ref.x; sy += ref.y; count++; }
      }
      if (count > 0) {
        targetPositions.push({ x: sx / count, y: sy / count });
        sourcePositions.push({ x: cluster.x, y: cluster.y });
      }
    }
    if (sourcePositions.length >= 2) {
      const allSource = clusters.map(c => ({ x: c.x, y: c.y }));
      const aligned = procrustesAlign(allSource, targetPositions);
      for (let i = 0; i < clusters.length; i++) {
        clusters[i].x = aligned[i].x;
        clusters[i].y = aligned[i].y;
      }
    }
  }

  // 7. Assign to hex grid (compact honeycomb)
  // Scale hex size so total visual area is similar across levels
  // Reference: 200 clusters → hexSize 32
  const BASE_HEX = 32;
  const REF_CLUSTERS = 200;
  const hexSize = BASE_HEX * Math.sqrt(REF_CLUSTERS / Math.max(numClusters, 1));
  const hexTiles = assignClustersToHex(clusters, hexSize);

  // 8. Build territories (BFS connected components on hex grid) = macro-regions
  const preLabelTerritories = computeTerritories(hexTiles);

  // 9. 2-level label hierarchy — SHAP-filtered params only
  const importanceMap = new Map(
    shapImportance.map((s) => [s.name, s.importance]),
  );
  const labelParams = topParams.filter((p) => importanceMap.has(p));

  // 9a. Macro labels: territory vs global (1 predicate only — brief)
  const macroLabels = generateTerritoryLabels(
    preLabelTerritories,
    allTrials,
    paramStats,
    labelParams,
    importanceMap,
  );

  // 9b. Sub-regions: adjacency-constrained k-means within each territory
  //     Sub labels: sub vs macro-rest (local contrast — finer-grained)
  const territories: Territory[] = preLabelTerritories.map((t, i) => {
    const subRegions = buildSubRegionsForTerritory(t, labelParams, paramStats, importanceMap);
    return { ...t, label: macroLabels[i], subRegions };
  });

  // Calculate grid radius from actual tiles
  const gridRadius = Math.max(
    ...hexTiles.map((t) => Math.max(Math.abs(t.q), Math.abs(t.r))),
  );

  return {
    clusters,
    hexTiles,
    territories,
    gridRadius,
    hexSize,
    totalUniqueBranches,
    paramImportance: shapImportance.slice(0, 10),
    paramStats,
    labelParams,
  };
}

// ============================================================
// Pre-computed JSON deserialization
// ============================================================

/**
 * Deserialize a pre-computed multi-level HexMap JSON.
 * Returns an array of 5 HexMapData (index 0 = L0, ... 4 = L4).
 * Trials are shared across all levels to save memory.
 */
export function deserializePrecomputed(json: any): HexMapData[] {
  // Precomputed JSON stores coverage as absolute branch counts (per-trial / cluster aggregates).
  const allTrials: Trial[] = json.trials;

  function deserializeLevel(levelJson: any): HexMapData {
    // Rebuild clusters
    const clusterMap = new Map<number, Cluster>();
    const clusters: Cluster[] = levelJson.clusters.map((sc: any) => {
      const trials = sc.trialIndices.map((i: number) => allTrials[i]);
      const cluster: Cluster = {
        id: sc.id,
        trials,
        centroid: sc.centroid,
        tunerCounts: sc.tunerCounts,
        totalTrials: sc.totalTrials,
        avgCoverage: sc.avgCoverage,
        meanBranchCoverage: sc.meanBranchCoverage,
        maxBranchCoverage: sc.maxBranchCoverage,
        meanMarginalCoverage: sc.meanMarginalCoverage ?? 0,
        coveredBranches: sc.coveredBranches ?? [],
        tunerCoveredBranches: sc.tunerCoveredBranches ?? {},
        x: sc.x,
        y: sc.y,
        hexQ: sc.hexQ,
        hexR: sc.hexR,
      };
      clusterMap.set(cluster.id, cluster);
      return cluster;
    });

    // Rebuild hexTiles
    const tileMap = new Map<string, HexTile>();
    const hexTiles: HexTile[] = levelJson.hexTiles.map((st: any) => {
      const tile: HexTile = {
        q: st.q,
        r: st.r,
        cluster: st.clusterId != null ? clusterMap.get(st.clusterId)! : null,
        x: st.x,
        y: st.y,
      };
      tileMap.set(`${st.q},${st.r}`, tile);
      return tile;
    });

    const resolveTiles = (keys: string[]): HexTile[] =>
      keys.map((k) => tileMap.get(k)!).filter(Boolean);
    const resolveClusters = (ids: number[]): Cluster[] =>
      ids.map((id) => clusterMap.get(id)!).filter(Boolean);
    const resolveTrials = (indices: number[]): Trial[] =>
      indices.map((i) => allTrials[i]);

    // Rebuild territories → subRegions (recursive children)
    function deserializeSubRegion(ssr: any): SubRegion {
      const children: SubRegion[] = (ssr.children || []).map((c: any) => deserializeSubRegion(c));
      return {
        id: ssr.id,
        territoryId: ssr.territoryId,
        clusters: resolveClusters(ssr.clusterIds),
        tiles: resolveTiles(ssr.tileKeys),
        trials: resolveTrials(ssr.trialIndices),
        totalTrials: ssr.totalTrials,
        tunerCounts: ssr.tunerCounts,
        pixelCentroidX: ssr.pixelCentroidX,
        pixelCentroidY: ssr.pixelCentroidY,
        label: ssr.label,
        children,
        splittable: ssr.splittable ?? false,
        depth: ssr.depth ?? 0,
      };
    }

    const territories: Territory[] = levelJson.territories.map((st: any) => {
      const subRegions: SubRegion[] = (st.subRegions || []).map((ssr: any) => deserializeSubRegion(ssr));

      return {
        id: st.id,
        clusters: resolveClusters(st.clusterIds),
        tiles: resolveTiles(st.tileKeys),
        trials: resolveTrials(st.trialIndices),
        totalTrials: st.totalTrials,
        tunerCounts: st.tunerCounts,
        centroidX: st.centroidX,
        centroidY: st.centroidY,
        pixelCentroidX: st.pixelCentroidX,
        pixelCentroidY: st.pixelCentroidY,
        label: st.label,
        subRegions,
      } as Territory;
    });

    // Rebuild paramStats as Map
    const paramStats = new Map<string, ParamStats>();
    for (const [k, v] of Object.entries(levelJson.paramStats)) {
      paramStats.set(k, v as ParamStats);
    }

    return {
      clusters,
      hexTiles,
      territories,
      gridRadius: levelJson.gridRadius,
      hexSize: levelJson.hexSize ?? 32,
      totalUniqueBranches: levelJson.totalUniqueBranches ?? 0,
      paramImportance: levelJson.paramImportance,
      paramStats,
      labelParams: levelJson.labelParams,
    };
  }

  return json.levels.map((lvl: any) => deserializeLevel(lvl));
}

// ============================================================
// Utility Functions
// ============================================================

export function getHexPath(size: number): string {
  // Flat-top hexagon (traditional honeycomb shape)
  const points: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i; // Start at 0° (flat top)
    const x = size * Math.cos(angle);
    const y = size * Math.sin(angle);
    points.push(`${x},${y}`);
  }
  return `M${points.join("L")}Z`;
}

export function getDominantTuner(
  tunerCounts: Record<TunerType, number>,
): TunerType {
  let max = 0;
  let dominant: TunerType = "SymTuner";
  for (const [tuner, count] of Object.entries(tunerCounts)) {
    if (count > max) {
      max = count;
      dominant = tuner as TunerType;
    }
  }
  return dominant;
}

export function getTunerRatios(
  tunerCounts: Record<TunerType, number>,
): Record<TunerType, number> {
  const total = Object.values(tunerCounts).reduce((a, b) => a + b, 0);
  if (total === 0)
    return { SymTuner: 0, CMA_ES: 0, Genetic: 0, SuccessiveHalving: 0, TPE: 0, BayesianOptimization: 0 };

  return {
    SymTuner: tunerCounts.SymTuner / total,
    CMA_ES: tunerCounts.CMA_ES / total,
    Genetic: tunerCounts.Genetic / total,
    SuccessiveHalving: tunerCounts.SuccessiveHalving / total,
    TPE: tunerCounts.TPE / total,
    BayesianOptimization: tunerCounts.BayesianOptimization / total,
  };
}
