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
 * Fine-grained unit within a SubRegion, for zoom-in detail view.
 * Label is contrastive vs sibling detail regions (local contrast).
 */
export interface DetailRegion {
  id: number;
  territoryId: number;
  parentSubRegionId: number;
  clusters: Cluster[];
  tiles: HexTile[];
  trials: Trial[];
  totalTrials: number;
  tunerCounts: Record<TunerType, number>;
  pixelCentroidX: number;
  pixelCentroidY: number;
  label: string;
}

/**
 * Connected sub-group within a Territory.
 * Label is contrastive vs parent territory (not global).
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
  label: string; // sub vs macro-rest (local contrast)
  detailRegions: DetailRegion[]; // zoom-in level; populated in processHexMapData
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
  paramImportance: { name: string; importance: number }[];
  paramStats: Map<string, ParamStats>;
  labelParams: string[];
}

// ============================================================
// Constants
// ============================================================

export const TUNER_COLORS: Record<TunerType, string> = {
  SymTuner: "#3B82F6",
  CMA_ES: "#10B981",
  Genetic: "#F59E0B",
  SuccessiveHalving: "#EF4444",
  TPE: "#8B5CF6",
  BayesianOptimization: "#EC4899",
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
      stats.set(name, {
        name,
        type: "numeric",
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

    clusters.push({
      id: clusters.length,
      trials: clusterTrials,
      centroid: centroidObj,
      tunerCounts,
      totalTrials: clusterTrials.length,
      avgCoverage: totalMarginal / clusterTrials.length, // Now using marginal coverage
      meanBranchCoverage: totalBranchCoverage / clusterTrials.length,
      maxBranchCoverage,
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
): Omit<SubRegion, "label" | "detailRegions"> {
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

function makeDetailRegionObj(
  id: number,
  territoryId: number,
  parentSubRegionId: number,
  clusters: Cluster[],
  tiles: HexTile[],
): Omit<DetailRegion, "label"> {
  const tunerCounts: Record<TunerType, number> = {
    SymTuner: 0, CMA_ES: 0, Genetic: 0,
    SuccessiveHalving: 0, TPE: 0, BayesianOptimization: 0,
  };
  let totalTrials = 0, pcx = 0, pcy = 0;
  for (const c of clusters) {
    totalTrials += c.totalTrials;
    for (const t of TUNER_NAMES) tunerCounts[t] += c.tunerCounts[t];
  }
  for (const t of tiles) { pcx += t.x; pcy += t.y; }
  return {
    id, territoryId, parentSubRegionId, clusters, tiles,
    trials: clusters.flatMap((c) => c.trials),
    totalTrials, tunerCounts,
    pixelCentroidX: tiles.length > 0 ? pcx / tiles.length : 0,
    pixelCentroidY: tiles.length > 0 ? pcy / tiles.length : 0,
  };
}

/**
 * Divide a sub-region into detail regions for zoom-in display.
 * Finer than sub-regions but still coarse: small SRs stay as 1,
 * large SRs split into 2–4 spatially-connected detail regions.
 */
function buildDetailRegionsForSubRegion(
  sr: Omit<SubRegion, "label" | "detailRegions">,
  labelParams: string[],
  paramStats: Map<string, ParamStats>,
): Omit<DetailRegion, "label">[] {
  const clusters = sr.clusters;
  const m = clusters.length;

  const srHexMap = new Map<string, Cluster>();
  for (const c of clusters) srHexMap.set(`${c.hexQ},${c.hexR}`, c);

  const tileByKey = new Map<string, HexTile>();
  for (const tile of sr.tiles) tileByKey.set(`${tile.q},${tile.r}`, tile);

  // Small SRs: single detail region (no benefit in splitting further)
  const k = m < 4 ? 1 : m < 12 ? 2 : m < 30 ? 3 : 4;

  if (k === 1) {
    return [makeDetailRegionObj(0, sr.territoryId, sr.id, clusters, sr.tiles)];
  }

  const vecs = clusters.map((c) => {
    const v = clusterCentroidToVec(c.centroid, paramStats, labelParams);
    return v.length > 0 ? v : [c.hexQ, c.hexR];
  });
  const assigns = smallKMeans(vecs, k);

  const groups: Cluster[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < m; i++) groups[assigns[i]].push(clusters[i]);

  const allComps: Cluster[][] = [];
  for (const g of groups) {
    if (g.length === 0) continue;
    allComps.push(...hexConnectedComponentsSubset(g, srHexMap));
  }

  // Merge only isolated singletons (threshold=2), keep meaningful fragments
  let finalComps = mergeSmallComponents(allComps, srHexMap, 2);

  // Spatial fallback if collapsed to 1
  if (finalComps.length === 1 && m >= 4) {
    const spatialVecs = clusters.map((c) => [c.hexQ, c.hexR]);
    const sa = smallKMeans(spatialVecs, 2);
    const g0: Cluster[] = [], g1: Cluster[] = [];
    for (let i = 0; i < m; i++) (sa[i] === 0 ? g0 : g1).push(clusters[i]);
    const sc: Cluster[][] = [];
    if (g0.length > 0) sc.push(...hexConnectedComponentsSubset(g0, srHexMap));
    if (g1.length > 0) sc.push(...hexConnectedComponentsSubset(g1, srHexMap));
    if (sc.length > 1) finalComps = mergeSmallComponents(sc, srHexMap, 2);
  }

  return finalComps.map((drClusters, idx) => {
    const drTiles = drClusters
      .map((c) => tileByKey.get(`${c.hexQ},${c.hexR}`))
      .filter((t): t is HexTile => t !== undefined);
    return makeDetailRegionObj(idx, sr.territoryId, sr.id, drClusters, drTiles);
  });
}

/**
 * Divide a territory into spatially-connected sub-regions.
 * Uses k-means on cluster centroids, then splits disconnected components,
 * then merges any component below MIN_CLUSTER_SIZE.
 */
export function buildSubRegionsForTerritory(
  territory: Omit<Territory, "label" | "subRegions">,
  topParams: string[],
  paramStats: Map<string, ParamStats>,
): Omit<SubRegion, "label" | "detailRegions">[] {
  const clusters = territory.clusters;
  const n = clusters.length;

  const terrHexMap = new Map<string, Cluster>();
  for (const c of clusters) terrHexMap.set(`${c.hexQ},${c.hexR}`, c);

  const tileByKey = new Map<string, HexTile>();
  for (const tile of territory.tiles)
    tileByKey.set(`${tile.q},${tile.r}`, tile);

  // Determine k: balanced — small territories 1~2, medium 2~3, large up to 4
  const k = n < 5 ? 1 : n <= 15 ? 2 : n <= 50 ? 3 : 4;

  if (k === 1) {
    return [makeSubRegionObj(0, territory.id, clusters, territory.tiles)];
  }

  // K-means on cluster centroids using provided (SHAP-filtered) params.
  // If params produce empty vectors (no SHAP data available), fall back to
  // hex grid coordinates so spatial splitting still works.
  const vecs = clusters.map((c) => {
    const v = clusterCentroidToVec(c.centroid, paramStats, topParams);
    return v.length > 0 ? v : [c.hexQ, c.hexR];
  });
  const assigns = smallKMeans(vecs, k);

  // Group by assignment
  const groups: Cluster[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) groups[assigns[i]].push(clusters[i]);

  // Split each group into connected components
  const allComps: Cluster[][] = [];
  for (const g of groups) {
    if (g.length === 0) continue;
    allComps.push(...hexConnectedComponentsSubset(g, terrHexMap));
  }

  // Merge only genuinely tiny fragments: at most 8% of territory, capped at 4 clusters.
  // Keeping the cap low prevents large territories from collapsing to a single component.
  const mergeThreshold = Math.min(4, Math.ceil(n * 0.08));
  let finalComps = mergeSmallComponents(allComps, terrHexMap, mergeThreshold);

  // Safety net: if everything collapsed to 1 component on a large territory,
  // fall back to a pure spatial split (hex coords) with k=2.
  if (finalComps.length === 1 && n >= 8) {
    const spatialVecs = clusters.map((c) => [c.hexQ, c.hexR]);
    const spatialAssigns = smallKMeans(spatialVecs, 2);
    const g0: Cluster[] = [], g1: Cluster[] = [];
    for (let i = 0; i < n; i++) (spatialAssigns[i] === 0 ? g0 : g1).push(clusters[i]);
    const spatialComps: Cluster[][] = [];
    if (g0.length > 0) spatialComps.push(...hexConnectedComponentsSubset(g0, terrHexMap));
    if (g1.length > 0) spatialComps.push(...hexConnectedComponentsSubset(g1, terrHexMap));
    if (spatialComps.length > 1) finalComps = mergeSmallComponents(spatialComps, terrHexMap, 2);
  }

  return finalComps.map((srClusters, idx) => {
    const srTiles = srClusters
      .map((c) => tileByKey.get(`${c.hexQ},${c.hexR}`))
      .filter((t): t is HexTile => t !== undefined);
    return makeSubRegionObj(idx, territory.id, srClusters, srTiles);
  });
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

export function processHexMapData(
  tunerData: ProcessedData[],
  shapImportance: { name: string; importance: number }[],
  numClusters: number = 160,
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
        coverage:
          data.totalUniqueBranches > 0
            ? trial.cumulativeCoverage / data.totalUniqueBranches
            : 0,
        marginalCoverage: trial.marginalCoverage,
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

  // 7. Assign to hex grid (compact honeycomb)
  const hexSize = 32; // Must match HEX_SIZE in HexMap.tsx
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
    const srRaws = buildSubRegionsForTerritory(t, labelParams, paramStats);
    const srLabels = generateSubRegionLabels(
      srRaws,
      t.trials,
      paramStats,
      labelParams,
      importanceMap,
    );
    // 9c. Detail regions: finer split within each sub-region (for future zoom-in)
    const subRegions: SubRegion[] = srRaws.map((sr, j) => {
      const drRaws = buildDetailRegionsForSubRegion(sr, labelParams, paramStats);
      const drLabels = generateSubRegionLabels(drRaws, sr.trials, paramStats, labelParams, importanceMap);
      const detailRegions: DetailRegion[] = drRaws.map((dr, di) => ({
        ...dr,
        label: drLabels[di] ?? "",
      }));
      return { ...sr, label: srLabels[j], detailRegions };
    });
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
    paramImportance: shapImportance.slice(0, 10),
    paramStats,
    labelParams,
  };
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
