/**
 * Web Worker — MDS / Spectral hex layout (optimized)
 *
 * Two paths:
 * A. Spectral path (when features + paramNames provided):
 *    discretize params → KNN graph → spectral layout → hex snap
 * B. MDS path (fallback):
 *    encode params → Hamming MDS → hex snap
 */

// ---- Types ----

export type LayoutMethod = 'spectral' | 'mds' | 'umap' | 'hamming';

interface NodeData {
  id: number;
  tuner: string;
  params: (string | boolean | number)[];
  coverage: number;
  marginalCoverage: number;
}

export interface FeatureConfig {
  name: string;
  type: 'boolean' | 'numeric' | 'categorical';
  importance: number;
  binEdges?: number[];
  categories?: string[];
}

export interface WorkerInput {
  nodes: NodeData[];
  enabledTuners: string[];
  hexSize: number;
  cx: number;
  cy: number;
  generation: number;
  aggDist: number;
  layoutMethod: LayoutMethod;
  features?: FeatureConfig[];
  paramNames?: string[];
}

export interface HexResult {
  id: number;
  q: number;
  r: number;
  px: number;
  py: number;
  tuner: string;
  coverage: number;
  marginalCoverage: number;
  count?: number;
  tunerCounts?: Record<string, number>;
}

export interface WorkerOutput {
  hexes: HexResult[];
  stats: {
    totalNodes: number;
    tunerCounts: Record<string, number>;
  };
  generation: number;
}

// ---- Hex helpers ----

const HEX_DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, -1],
  [-1, 1],
];

function axialToPixel(q: number, r: number, size: number) {
  return {
    x: size * (3 / 2) * q,
    y: size * ((Math.sqrt(3) / 2) * q + Math.sqrt(3) * r),
  };
}

function pixelToAxial(px: number, py: number, hexSize: number) {
  const fq = ((2 / 3) * px) / hexSize;
  const fr = ((-1 / 3) * px + (Math.sqrt(3) / 3) * py) / hexSize;
  const fs = -fq - fr;
  let q = Math.round(fq),
    r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq),
    dr = Math.abs(r - fr),
    ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
}

// Numeric key for hex coords — avoids string allocation in Set
function hexKey(q: number, r: number): number {
  return (q + 16384) * 32769 + (r + 16384);
}

// ---- Min-heap for distance-ordered hex search ----

function heapPush(h: number[][], priority: number, q: number, r: number) {
  h.push([priority, q, r]);
  let i = h.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (h[i][0] >= h[parent][0]) break;
    [h[i], h[parent]] = [h[parent], h[i]];
    i = parent;
  }
}

function heapPop(h: number[][]): number[] | undefined {
  if (h.length === 0) return undefined;
  const top = h[0];
  const last = h.pop()!;
  if (h.length > 0) {
    h[0] = last;
    let i = 0;
    while (true) {
      let s = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < h.length && h[l][0] < h[s][0]) s = l;
      if (r < h.length && h[r][0] < h[s][0]) s = r;
      if (s === i) break;
      [h[i], h[s]] = [h[s], h[i]];
      i = s;
    }
  }
  return top;
}

// ---- Parameter encoding ----
// Encode mixed-type params to flat Uint8Array for cache-friendly comparison

function encodeParams(nodes: NodeData[], P: number): Uint8Array {
  const N = nodes.length;
  const buf = new Uint8Array(N * P);
  const maps: Map<string | boolean | number, number>[] = [];
  for (let p = 0; p < P; p++) maps.push(new Map());

  for (let i = 0; i < N; i++) {
    const params = nodes[i].params;
    const base = i * P;
    for (let p = 0; p < P; p++) {
      const val = params[p];
      const map = maps[p];
      let code = map.get(val);
      if (code === undefined) {
        code = map.size;
        map.set(val, code);
      }
      buf[base + p] = code;
    }
  }
  return buf;
}

// ---- Greedy leader clustering ----

function clusterByDistance(
  encoded: Uint8Array,
  N: number,
  P: number,
  maxDist: number,
): { centerIndices: number[]; assignment: Int32Array } {
  const assignment = new Int32Array(N);
  const centerIndices: number[] = [];

  for (let i = 0; i < N; i++) {
    const ai = i * P;
    let bestCluster = -1;
    let bestDist = maxDist + 1;

    for (let ci = 0; ci < centerIndices.length; ci++) {
      const bi = centerIndices[ci] * P;
      let diff = 0;
      for (let p = 0; p < P; p++) {
        if (encoded[ai + p] !== encoded[bi + p]) diff++;
        if (diff > maxDist) break;
      }
      if (diff <= maxDist && diff < bestDist) {
        bestDist = diff;
        bestCluster = ci;
      }
    }

    if (bestCluster >= 0) {
      assignment[i] = bestCluster;
    } else {
      assignment[i] = centerIndices.length;
      centerIndices.push(i);
    }
  }

  return { centerIndices, assignment };
}

// ============================================================
// Classical MDS via power iteration
// ============================================================

function classicalMDS(
  D: Uint8Array,
  N: number,
): { x: Float64Array; y: Float64Array } {
  const rowMeanD2 = new Float64Array(N);
  let grandMeanD2 = 0;

  for (let i = 0; i < N; i++) {
    let sum = 0;
    const base = i * N;
    for (let j = 0; j < N; j++) {
      const d = D[base + j];
      sum += d * d;
    }
    rowMeanD2[i] = sum / N;
    grandMeanD2 += sum;
  }
  grandMeanD2 /= N * N;

  // Reusable buffer — avoids allocating Float64Array(N) per Bv call
  const bvBuf = new Float64Array(N);

  function Bv(v: Float64Array): Float64Array {
    let sumV = 0;
    for (let j = 0; j < N; j++) sumV += v[j];

    let dotRowMeanV = 0;
    for (let j = 0; j < N; j++) dotRowMeanV += rowMeanD2[j] * v[j];

    const offset = -dotRowMeanV + grandMeanD2 * sumV;

    for (let i = 0; i < N; i++) {
      let sumDv = 0;
      const base = i * N;
      for (let j = 0; j < N; j++) {
        const d = D[base + j];
        sumDv += d * d * v[j];
      }
      bvBuf[i] = -0.5 * (sumDv - rowMeanD2[i] * sumV + offset);
    }
    return bvBuf;
  }

  function powerIter(
    deflateVec?: Float64Array,
  ): { vec: Float64Array; val: number } {
    const v = new Float64Array(N);
    const seed = deflateVec ? 2.3 : 0.7;
    for (let i = 0; i < N; i++) v[i] = Math.sin(i * seed + 1.3);

    let norm = 0;
    for (let i = 0; i < N; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < N; i++) v[i] /= norm;

    let eigenvalue = 0;
    for (let iter = 0; iter < 200; iter++) {
      const Bv_r = Bv(v);

      if (deflateVec) {
        let dot = 0;
        for (let i = 0; i < N; i++) dot += Bv_r[i] * deflateVec[i];
        for (let i = 0; i < N; i++) Bv_r[i] -= dot * deflateVec[i];
      }

      norm = 0;
      for (let i = 0; i < N; i++) norm += Bv_r[i] * Bv_r[i];
      norm = Math.sqrt(norm);
      if (norm < 1e-10) break;

      const prevEigenvalue = eigenvalue;
      eigenvalue = norm;
      for (let i = 0; i < N; i++) v[i] = Bv_r[i] / norm;

      // Early convergence
      if (
        iter > 10 &&
        Math.abs(eigenvalue - prevEigenvalue) < eigenvalue * 1e-8
      )
        break;
    }
    return { vec: v, val: eigenvalue };
  }

  const { vec: v1, val: l1 } = powerIter();
  const { vec: v2, val: l2 } = powerIter(v1);

  const x = new Float64Array(N);
  const y = new Float64Array(N);
  const s1 = Math.sqrt(Math.max(0, l1));
  const s2 = Math.sqrt(Math.max(0, l2));
  for (let i = 0; i < N; i++) {
    x[i] = v1[i] * s1;
    y[i] = v2[i] * s2;
  }
  return { x, y };
}

// ============================================================
// Landmark MDS for large N
// ============================================================

function landmarkMDS(
  encoded: Uint8Array,
  N: number,
  P: number,
  numLandmarks: number,
): { x: Float64Array; y: Float64Array } {
  const k = Math.min(numLandmarks, N);

  const landmarkIdx: number[] = [];
  const step = Math.max(1, Math.floor(N / k));
  for (let i = 0; i < N && landmarkIdx.length < k; i += step) {
    landmarkIdx.push(i);
  }
  const actualK = landmarkIdx.length;

  // k×k landmark distance matrix — inline Hamming on encoded buffer
  const D_LL = new Uint8Array(actualK * actualK);
  for (let a = 0; a < actualK; a++) {
    const ai = landmarkIdx[a] * P;
    for (let b = a + 1; b < actualK; b++) {
      const bi = landmarkIdx[b] * P;
      let diff = 0;
      for (let p = 0; p < P; p++) {
        if (encoded[ai + p] !== encoded[bi + p]) diff++;
      }
      D_LL[a * actualK + b] = diff;
      D_LL[b * actualK + a] = diff;
    }
  }

  const { x: lx, y: ly } = classicalMDS(D_LL, actualK);

  const x = new Float64Array(N);
  const y = new Float64Array(N);
  const isLandmark = new Set(landmarkIdx);
  const NUM_NEAREST = 8;

  for (let li = 0; li < actualK; li++) {
    x[landmarkIdx[li]] = lx[li];
    y[landmarkIdx[li]] = ly[li];
  }

  // Reusable buffers for nearest-k partial selection
  const nearestD = new Float64Array(NUM_NEAREST);
  const nearestLi = new Int32Array(NUM_NEAREST);

  for (let i = 0; i < N; i++) {
    if (isLandmark.has(i)) continue;

    const ai = i * P;
    nearestD.fill(Infinity);

    // Partial insertion sort — O(actualK × NUM_NEAREST) vs O(actualK × log(actualK)) full sort
    for (let li = 0; li < actualK; li++) {
      const bi = landmarkIdx[li] * P;
      let diff = 0;
      for (let p = 0; p < P; p++) {
        if (encoded[ai + p] !== encoded[bi + p]) diff++;
      }

      if (diff < nearestD[NUM_NEAREST - 1]) {
        let pos = NUM_NEAREST - 1;
        while (pos > 0 && diff < nearestD[pos - 1]) pos--;
        for (let s = NUM_NEAREST - 1; s > pos; s--) {
          nearestD[s] = nearestD[s - 1];
          nearestLi[s] = nearestLi[s - 1];
        }
        nearestD[pos] = diff;
        nearestLi[pos] = li;
      }
    }

    let sumW = 0,
      sumX = 0,
      sumY = 0;
    for (let n = 0; n < NUM_NEAREST; n++) {
      if (nearestD[n] === Infinity) break;
      const w = 1 / (nearestD[n] + 0.1);
      sumW += w;
      sumX += w * lx[nearestLi[n]];
      sumY += w * ly[nearestLi[n]];
    }
    x[i] = sumX / sumW;
    y[i] = sumY / sumW;
  }

  return { x, y };
}

// ============================================================
// Scale + hex snap + swap refinement (shared helper)
// ============================================================

function scaleAndSnap(
  posX: Float64Array,
  posY: Float64Array,
  N: number,
  hexSize: number,
  cx: number,
  cy: number,
  targetScale?: number,
): { assignedQ: Int16Array; assignedR: Int16Array; pxArr: Float64Array; pyArr: Float64Array } {
  // Scale MDS output to hex coordinate space
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (let i = 0; i < N; i++) {
    if (posX[i] < minX) minX = posX[i];
    if (posX[i] > maxX) maxX = posX[i];
    if (posY[i] < minY) minY = posY[i];
    if (posY[i] > maxY) maxY = posY[i];
  }

  let scale: number;
  if (targetScale !== undefined) {
    // Calibrated scale: e.g. hamming uses √3 × hexSize so 1 hex step ≈ 1 unit
    scale = targetScale;
  } else {
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const span = Math.sqrt(N) * hexSize * 2;
    scale = span / Math.max(rangeX, rangeY);
  }

  for (let i = 0; i < N; i++) {
    posX[i] = (posX[i] - (minX + maxX) / 2) * scale;
    posY[i] = (posY[i] - (minY + maxY) / 2) * scale;
  }

  // Hex snap — greedy placement with min-heap collision resolution
  const occupied = new Set<number>();
  const assignedQ = new Int16Array(N);
  const assignedR = new Int16Array(N);
  const pxArr = new Float64Array(N);
  const pyArr = new Float64Array(N);
  const heap: number[][] = [];

  for (let i = 0; i < N; i++) {
    const target = pixelToAxial(posX[i], posY[i], hexSize);
    let q = target.q;
    let r = target.r;
    let key = hexKey(q, r);

    if (occupied.has(key)) {
      const ipx = posX[i];
      const ipy = posY[i];
      const visited = new Set<number>([key]);
      heap.length = 0;

      for (const [dq, dr] of HEX_DIRS) {
        const nq = q + dq;
        const nr = r + dr;
        const nk = hexKey(nq, nr);
        if (!visited.has(nk)) {
          visited.add(nk);
          const { x: hx, y: hy } = axialToPixel(nq, nr, hexSize);
          heapPush(heap, (hx - ipx) * (hx - ipx) + (hy - ipy) * (hy - ipy), nq, nr);
        }
      }

      while (heap.length > 0) {
        const top = heapPop(heap)!;
        const bq = top[1], br = top[2];
        const bk = hexKey(bq, br);
        if (!occupied.has(bk)) {
          q = bq;
          r = br;
          key = bk;
          break;
        }
        for (const [dq, dr] of HEX_DIRS) {
          const nq = bq + dq;
          const nr = br + dr;
          const nk = hexKey(nq, nr);
          if (!visited.has(nk)) {
            visited.add(nk);
            const { x: hx, y: hy } = axialToPixel(nq, nr, hexSize);
            heapPush(heap, (hx - ipx) * (hx - ipx) + (hy - ipy) * (hy - ipy), nq, nr);
          }
        }
      }
    }

    occupied.add(key);
    assignedQ[i] = q;
    assignedR[i] = r;
    const { x, y } = axialToPixel(q, r, hexSize);
    pxArr[i] = x + cx;
    pyArr[i] = y + cy;
  }

  // Swap refinement — reduce total displacement
  const posToIdx = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    posToIdx.set(hexKey(assignedQ[i], assignedR[i]), i);
  }

  for (let pass = 0; pass < 4; pass++) {
    let swaps = 0;
    for (let i = 0; i < N; i++) {
      const qi = assignedQ[i], ri = assignedR[i];
      const { x: axi, y: ayi } = axialToPixel(qi, ri, hexSize);
      const costI = (axi - posX[i]) * (axi - posX[i]) + (ayi - posY[i]) * (ayi - posY[i]);

      for (const [dq, dr] of HEX_DIRS) {
        const nq = qi + dq, nr = ri + dr;
        const j = posToIdx.get(hexKey(nq, nr));
        if (j === undefined) continue;

        const { x: axj, y: ayj } = axialToPixel(nq, nr, hexSize);
        const costJ = (axj - posX[j]) * (axj - posX[j]) + (ayj - posY[j]) * (ayj - posY[j]);

        const costI_s = (axj - posX[i]) * (axj - posX[i]) + (ayj - posY[i]) * (ayj - posY[i]);
        const costJ_s = (axi - posX[j]) * (axi - posX[j]) + (ayi - posY[j]) * (ayi - posY[j]);

        if (costI_s + costJ_s < costI + costJ - 1e-6) {
          posToIdx.set(hexKey(qi, ri), j);
          posToIdx.set(hexKey(nq, nr), i);
          assignedQ[i] = nq; assignedR[i] = nr;
          assignedQ[j] = qi; assignedR[j] = ri;
          pxArr[i] = axj + cx; pxArr[j] = axi + cx;
          pyArr[i] = ayj + cy; pyArr[j] = ayi + cy;
          swaps++;
          break;
        }
      }
    }
    if (swaps === 0) break;
  }

  return { assignedQ, assignedR, pxArr, pyArr };
}

// ============================================================
// Spectral layout pipeline (SHAP-based feature selection)
// ============================================================

interface SparseGraph {
  neighbors: Int32Array;  // flat CSR neighbor indices
  offsets: Int32Array;     // row offsets into neighbors (length N+1)
  degree: Int32Array;      // degree of each node
}

/**
 * Discretize selected params into Uint8Array codes.
 * Boolean → 0/1, Categorical → indexOf, Numeric → bin index.
 */
function discretizeParams(
  nodes: NodeData[],
  paramNames: string[],
  features: FeatureConfig[],
): Uint8Array {
  const N = nodes.length;
  const F = features.length;
  const buf = new Uint8Array(N * F);

  // Build param name → index map
  const nameToIdx = new Map<string, number>();
  for (let i = 0; i < paramNames.length; i++) nameToIdx.set(paramNames[i], i);

  for (let fi = 0; fi < F; fi++) {
    const feat = features[fi];
    const pi = nameToIdx.get(feat.name);
    if (pi === undefined) continue;

    if (feat.type === 'boolean') {
      for (let i = 0; i < N; i++) {
        const val = nodes[i].params[pi];
        buf[i * F + fi] = (val === true || val === 1 || val === 'true') ? 1 : 0;
      }
    } else if (feat.type === 'categorical') {
      const cats = feat.categories ?? [];
      for (let i = 0; i < N; i++) {
        const val = String(nodes[i].params[pi]);
        const idx = cats.indexOf(val);
        buf[i * F + fi] = idx >= 0 ? idx : cats.length;
      }
    } else {
      // Numeric — quantile bin
      const edges = feat.binEdges ?? [];
      for (let i = 0; i < N; i++) {
        const val = Number(nodes[i].params[pi]);
        let bin = edges.length; // last bin
        for (let e = 0; e < edges.length; e++) {
          if (val <= edges[e]) { bin = e; break; }
        }
        buf[i * F + fi] = bin;
      }
    }
  }

  return buf;
}

/**
 * Build KNN graph from discretized features using Hamming distance.
 * Returns symmetric CSR sparse graph.
 */
function buildKNNGraph(encoded: Uint8Array, N: number, F: number, k: number = 6): SparseGraph {
  // For each node, find k nearest neighbors by Hamming distance
  const knnLists: number[][] = [];
  for (let i = 0; i < N; i++) knnLists.push([]);

  // Buffers for partial sort
  const bestDist = new Uint8Array(k);
  const bestIdx = new Int32Array(k);

  for (let i = 0; i < N; i++) {
    const ai = i * F;
    bestDist.fill(255);
    bestIdx.fill(-1);

    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const bj = j * F;
      let diff = 0;
      for (let f = 0; f < F; f++) {
        if (encoded[ai + f] !== encoded[bj + f]) diff++;
      }

      // Insert into top-k if better than worst
      if (diff < bestDist[k - 1]) {
        let pos = k - 1;
        while (pos > 0 && diff < bestDist[pos - 1]) pos--;
        for (let s = k - 1; s > pos; s--) {
          bestDist[s] = bestDist[s - 1];
          bestIdx[s] = bestIdx[s - 1];
        }
        bestDist[pos] = diff;
        bestIdx[pos] = j;
      }
    }

    for (let n = 0; n < k; n++) {
      if (bestIdx[n] >= 0) knnLists[i].push(bestIdx[n]);
    }
  }

  // Symmetrize: if i→j then j→i
  const adjSets: Set<number>[] = [];
  for (let i = 0; i < N; i++) adjSets.push(new Set(knnLists[i]));
  for (let i = 0; i < N; i++) {
    for (const j of knnLists[i]) {
      adjSets[j].add(i);
    }
  }

  // Build CSR
  const degree = new Int32Array(N);
  let totalEdges = 0;
  for (let i = 0; i < N; i++) {
    degree[i] = adjSets[i].size;
    totalEdges += degree[i];
  }

  const offsets = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) offsets[i + 1] = offsets[i] + degree[i];

  const neighbors = new Int32Array(totalEdges);
  for (let i = 0; i < N; i++) {
    let idx = offsets[i];
    for (const j of adjSets[i]) {
      neighbors[idx++] = j;
    }
  }

  return { neighbors, offsets, degree };
}

/**
 * Spectral layout via normalized adjacency eigenvectors.
 * M = D^{-1/2} A D^{-1/2}, power iteration for top eigenvectors.
 * Discard trivial 1st eigenvector, use 2nd/3rd as (x, y).
 */
function spectralLayout(graph: SparseGraph, N: number): { x: Float64Array; y: Float64Array } {
  const { neighbors, offsets, degree } = graph;

  // D^{-1/2}
  const dInvSqrt = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    dInvSqrt[i] = degree[i] > 0 ? 1 / Math.sqrt(degree[i]) : 0;
  }

  // Sparse Mv: result[i] = sum_j (dInvSqrt[i] * A[i,j] * dInvSqrt[j] * v[j])
  const mvBuf = new Float64Array(N);
  function Mv(v: Float64Array): Float64Array {
    for (let i = 0; i < N; i++) {
      let sum = 0;
      const di = dInvSqrt[i];
      for (let e = offsets[i]; e < offsets[i + 1]; e++) {
        const j = neighbors[e];
        sum += di * dInvSqrt[j] * v[j];
      }
      mvBuf[i] = sum;
    }
    return mvBuf;
  }

  function powerIter(deflateVecs: Float64Array[]): { vec: Float64Array; val: number } {
    const v = new Float64Array(N);
    const seed = 0.7 + deflateVecs.length * 1.6;
    for (let i = 0; i < N; i++) v[i] = Math.sin(i * seed + 1.3);

    let norm = 0;
    for (let i = 0; i < N; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < N; i++) v[i] /= norm;

    let eigenvalue = 0;
    for (let iter = 0; iter < 300; iter++) {
      const r = Mv(v);

      // Deflate all previous eigenvectors
      for (const dv of deflateVecs) {
        let dot = 0;
        for (let i = 0; i < N; i++) dot += r[i] * dv[i];
        for (let i = 0; i < N; i++) r[i] -= dot * dv[i];
      }

      norm = 0;
      for (let i = 0; i < N; i++) norm += r[i] * r[i];
      norm = Math.sqrt(norm);
      if (norm < 1e-12) break;

      const prevEigenvalue = eigenvalue;
      eigenvalue = norm;
      for (let i = 0; i < N; i++) v[i] = r[i] / norm;

      if (iter > 15 && Math.abs(eigenvalue - prevEigenvalue) < eigenvalue * 1e-9) break;
    }
    return { vec: v, val: eigenvalue };
  }

  // Find top 3 eigenvectors, discard 1st (trivial)
  const { vec: v1 } = powerIter([]);
  const { vec: v2, val: l2 } = powerIter([v1]);
  const { vec: v3, val: l3 } = powerIter([v1, v2]);

  const x = new Float64Array(N);
  const y = new Float64Array(N);
  const s2 = Math.sqrt(Math.max(0, l2));
  const s3 = Math.sqrt(Math.max(0, l3));
  for (let i = 0; i < N; i++) {
    x[i] = v2[i] * s2;
    y[i] = v3[i] * s3;
  }
  return { x, y };
}

// ============================================================
// MDS dispatcher (classical or landmark based on N)
// ============================================================

function computeMDS(
  encoded: Uint8Array,
  N: number,
  P: number,
): { x: Float64Array; y: Float64Array } {
  if (N <= 2000) {
    const D = new Uint8Array(N * N);
    for (let i = 0; i < N; i++) {
      const ai = i * P;
      for (let j = i + 1; j < N; j++) {
        const bi = j * P;
        let diff = 0;
        for (let p = 0; p < P; p++) {
          if (encoded[ai + p] !== encoded[bi + p]) diff++;
        }
        D[i * N + j] = diff;
        D[j * N + i] = diff;
      }
    }
    return classicalMDS(D, N);
  } else {
    return landmarkMDS(encoded, N, P, 500);
  }
}

// ============================================================
// UMAP layout pipeline
// ============================================================

/** xorshift32 PRNG returning [0, 1) */
function pseudoRandom(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Directed KNN (no symmetrization) with distances */
function buildDirectedKNN(
  encoded: Uint8Array,
  N: number,
  F: number,
  k: number = 15,
): { knnIdx: Int32Array; knnDist: Float32Array } {
  const actualK = Math.min(k, N - 1);
  const knnIdx = new Int32Array(N * actualK);
  const knnDist = new Float32Array(N * actualK);

  const bestDist = new Float32Array(actualK);
  const bestIdx = new Int32Array(actualK);

  for (let i = 0; i < N; i++) {
    const ai = i * F;
    bestDist.fill(Infinity);
    bestIdx.fill(-1);

    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const bj = j * F;
      let diff = 0;
      for (let f = 0; f < F; f++) {
        if (encoded[ai + f] !== encoded[bj + f]) diff++;
      }

      if (diff < bestDist[actualK - 1]) {
        let pos = actualK - 1;
        while (pos > 0 && diff < bestDist[pos - 1]) pos--;
        for (let s = actualK - 1; s > pos; s--) {
          bestDist[s] = bestDist[s - 1];
          bestIdx[s] = bestIdx[s - 1];
        }
        bestDist[pos] = diff;
        bestIdx[pos] = j;
      }
    }

    const base = i * actualK;
    for (let n = 0; n < actualK; n++) {
      knnIdx[base + n] = bestIdx[n];
      knnDist[base + n] = bestDist[n];
    }
  }

  return { knnIdx, knnDist };
}

/** Compute fuzzy simplicial set from KNN graph (UMAP-style) */
function computeFuzzySimplicialSet(
  knnIdx: Int32Array,
  knnDist: Float32Array,
  N: number,
  k: number,
): { rows: Int32Array; cols: Int32Array; vals: Float32Array; nEdges: number } {
  const rho = new Float32Array(N);
  const sigma = new Float32Array(N);

  // rho_i = distance to nearest neighbor
  for (let i = 0; i < N; i++) {
    const base = i * k;
    let minD = Infinity;
    for (let n = 0; n < k; n++) {
      const d = knnDist[base + n];
      if (d > 0 && d < minD) minD = d;
    }
    rho[i] = minD === Infinity ? 0 : minD;
  }

  // Binary search for sigma_i such that sum of membership strengths ≈ log2(k)
  const target = Math.log2(k);
  for (let i = 0; i < N; i++) {
    const base = i * k;
    let lo = 1e-5, hi = 100;
    for (let iter = 0; iter < 64; iter++) {
      const mid = (lo + hi) / 2;
      let sum = 0;
      for (let n = 0; n < k; n++) {
        const d = knnDist[base + n];
        const w = d <= rho[i] ? 1 : Math.exp(-(d - rho[i]) / mid);
        sum += w;
      }
      if (sum > target) hi = mid;
      else lo = mid;
      if (hi - lo < 1e-5) break;
    }
    sigma[i] = (lo + hi) / 2;
  }

  // Build directed weighted edges, then symmetrize
  // Use Map for sparse storage: key = i*N+j, val = weight
  const edgeMap = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    const base = i * k;
    for (let n = 0; n < k; n++) {
      const j = knnIdx[base + n];
      if (j < 0) continue;
      const d = knnDist[base + n];
      const w = d <= rho[i] ? 1 : Math.exp(-(d - rho[i]) / sigma[i]);
      const key = i * N + j;
      edgeMap.set(key, Math.max(edgeMap.get(key) ?? 0, w));
    }
  }

  // Symmetrize: w_sym = w_ij + w_ji - w_ij * w_ji
  const symMap = new Map<number, number>();
  for (const [key, wij] of edgeMap) {
    const i = Math.floor(key / N);
    const j = key % N;
    const wji = edgeMap.get(j * N + i) ?? 0;
    const wSym = wij + wji - wij * wji;

    // Store only i < j to avoid double edges, then add both
    const symKey = i < j ? i * N + j : j * N + i;
    symMap.set(symKey, Math.max(symMap.get(symKey) ?? 0, wSym));
  }

  const nEdges = symMap.size;
  const rows = new Int32Array(nEdges * 2);
  const cols = new Int32Array(nEdges * 2);
  const vals = new Float32Array(nEdges * 2);

  let idx = 0;
  for (const [key, w] of symMap) {
    const i = Math.floor(key / N);
    const j = key % N;
    rows[idx] = i; cols[idx] = j; vals[idx] = w; idx++;
    rows[idx] = j; cols[idx] = i; vals[idx] = w; idx++;
  }

  return { rows, cols, vals, nEdges: idx };
}

/** UMAP SGD layout optimization */
function umapSGD(
  rows: Int32Array,
  cols: Int32Array,
  vals: Float32Array,
  nEdges: number,
  N: number,
  nEpochs: number = 200,
): { x: Float64Array; y: Float64Array } {
  const a = 1.929, b = 0.7915; // min_dist ≈ 0.1
  const rng = pseudoRandom(42);

  // Initialize positions randomly
  const x = new Float64Array(N);
  const y = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    x[i] = (rng() - 0.5) * 20;
    y[i] = (rng() - 0.5) * 20;
  }

  // Compute epochs_per_sample based on edge weights
  const maxW = vals.reduce((mx, v) => Math.max(mx, v), 0);
  const epochsPerSample = new Float32Array(nEdges);
  for (let e = 0; e < nEdges; e++) {
    epochsPerSample[e] = vals[e] > 0 ? maxW / vals[e] : nEpochs + 1;
  }
  const epochOfNextSample = new Float32Array(nEdges);
  for (let e = 0; e < nEdges; e++) epochOfNextSample[e] = epochsPerSample[e];

  const nNegSamples = 5;
  const eps = 1e-4;
  const b2 = 2 * b;

  for (let epoch = 0; epoch < nEpochs; epoch++) {
    const alpha = 1.0 - epoch / nEpochs; // linear LR decay

    for (let e = 0; e < nEdges; e++) {
      if (epochOfNextSample[e] > epoch) continue;
      epochOfNextSample[e] += epochsPerSample[e];

      const i = rows[e], j = cols[e];
      let dx = x[i] - x[j];
      let dy = y[i] - y[j];
      const d2 = dx * dx + dy * dy + eps;
      const d2b = Math.pow(d2, b);

      // Attractive force
      const gradCoeff = (-2 * a * b * Math.pow(d2, b - 1)) / (1 + a * d2b);
      const gradX = gradCoeff * dx * alpha;
      const gradY = gradCoeff * dy * alpha;
      x[i] += gradX;
      y[i] += gradY;
      x[j] -= gradX;
      y[j] -= gradY;

      // Repulsive (negative sampling)
      for (let neg = 0; neg < nNegSamples; neg++) {
        const k = Math.floor(rng() * N);
        if (k === i) continue;
        dx = x[i] - x[k];
        dy = y[i] - y[k];
        const nd2 = dx * dx + dy * dy + eps;
        const nd2b = Math.pow(nd2, b);
        const repCoeff = (2 * b) / ((eps + nd2) * (1 + a * nd2b));
        const clipped = Math.min(repCoeff, 4);
        x[i] += clipped * dx * alpha;
        y[i] += clipped * dy * alpha;
      }
    }
  }

  return { x, y };
}

// ============================================================
// Main computation
// ============================================================

self.onmessage = (e: MessageEvent<WorkerInput>) => {
  const { nodes, enabledTuners, hexSize, cx, cy, generation, aggDist, layoutMethod, features, paramNames } = e.data;

  // 1. Filter by enabled tuners
  const enabledSet = new Set(enabledTuners);
  const filtered = nodes.filter((n) => enabledSet.has(n.tuner));

  if (filtered.length === 0) {
    self.postMessage({
      hexes: [],
      stats: { totalNodes: 0, tunerCounts: {} },
      generation,
    } satisfies WorkerOutput);
    return;
  }

  const FN = filtered.length;

  // Global stats
  const tunerCounts: Record<string, number> = {};
  for (const n of filtered)
    tunerCounts[n.tuner] = (tunerCounts[n.tuner] ?? 0) + 1;

  // 2. Encode
  const hasFeatures = features && features.length > 0 && paramNames && paramNames.length > 0;
  let encoded: Uint8Array;
  let F: number;

  if (hasFeatures) {
    F = features!.length;
    encoded = discretizeParams(filtered, paramNames!, features!);
  } else {
    F = filtered[0].params.length;
    encoded = encodeParams(filtered, F);
  }

  // 3. Aggregation (optional)
  let layoutN: number;
  let layoutEncoded: Uint8Array;
  let clusterCounts: Int32Array | null = null;
  let clusterTunerCounts: Record<string, number>[] | null = null;
  let clusterCoverageSum: Float64Array | null = null;

  if (aggDist > 0) {
    const { centerIndices, assignment } = clusterByDistance(encoded, FN, F, aggDist);
    const K = centerIndices.length;

    clusterCounts = new Int32Array(K);
    clusterTunerCounts = [];
    clusterCoverageSum = new Float64Array(K);
    for (let c = 0; c < K; c++) clusterTunerCounts.push({});

    for (let i = 0; i < FN; i++) {
      const c = assignment[i];
      clusterCounts[c]++;
      const tuner = filtered[i].tuner;
      clusterTunerCounts[c][tuner] = (clusterTunerCounts[c][tuner] ?? 0) + 1;
      clusterCoverageSum[c] += filtered[i].coverage;
    }

    // Extract center encoded params
    const centerEncoded = new Uint8Array(K * F);
    for (let c = 0; c < K; c++) {
      const srcOff = centerIndices[c] * F;
      const dstOff = c * F;
      for (let f = 0; f < F; f++) centerEncoded[dstOff + f] = encoded[srcOff + f];
    }

    layoutN = K;
    layoutEncoded = centerEncoded;
  } else {
    layoutN = FN;
    layoutEncoded = encoded;
  }

  // 4. Layout method dispatch
  let posX: Float64Array;
  let posY: Float64Array;

  // Determine effective method: spectral/umap need features; fallback to mds
  // hamming uses encodeParams-based MDS, so no features needed
  const effectiveMethod = (layoutMethod === 'spectral' || layoutMethod === 'umap') && !hasFeatures
    ? 'mds'
    : layoutMethod;

  switch (effectiveMethod) {
    case 'spectral': {
      const graph = buildKNNGraph(layoutEncoded, layoutN, F, Math.min(6, layoutN - 1));
      ({ x: posX, y: posY } = spectralLayout(graph, layoutN));
      break;
    }
    case 'umap': {
      const k = Math.min(15, layoutN - 1);
      const { knnIdx, knnDist } = buildDirectedKNN(layoutEncoded, layoutN, F, k);
      const { rows, cols, vals, nEdges } = computeFuzzySimplicialSet(knnIdx, knnDist, layoutN, k);
      ({ x: posX, y: posY } = umapSGD(rows, cols, vals, nEdges, layoutN));
      break;
    }
    case 'hamming': {
      ({ x: posX, y: posY } = computeMDS(layoutEncoded, layoutN, F));
      break;
    }
    case 'mds':
    default: {
      ({ x: posX, y: posY } = computeMDS(layoutEncoded, layoutN, F));
      break;
    }
  }

  // 5. Scale + hex snap
  // For hamming layout, calibrate so 1 hex step ≈ 1 Hamming distance unit
  const calibratedScale = effectiveMethod === 'hamming'
    ? Math.sqrt(3) * hexSize
    : undefined;
  const { assignedQ, assignedR, pxArr, pyArr } = scaleAndSnap(posX, posY, layoutN, hexSize, cx, cy, calibratedScale);

  // 6. Build hex results
  const hexes: HexResult[] = [];

  if (aggDist > 0 && clusterCounts && clusterTunerCounts && clusterCoverageSum) {
    for (let c = 0; c < layoutN; c++) {
      const tc = clusterTunerCounts[c];
      let dominantTuner = "";
      let maxCount = 0;
      for (const [t, cnt] of Object.entries(tc)) {
        if (cnt > maxCount) { maxCount = cnt; dominantTuner = t; }
      }
      hexes.push({
        id: c, q: assignedQ[c], r: assignedR[c],
        px: pxArr[c], py: pyArr[c], tuner: dominantTuner,
        coverage: clusterCoverageSum[c] / clusterCounts[c],
        marginalCoverage: 0, count: clusterCounts[c], tunerCounts: tc,
      });
    }
  } else {
    for (let i = 0; i < FN; i++) {
      const node = filtered[i];
      hexes.push({
        id: node.id, q: assignedQ[i], r: assignedR[i],
        px: pxArr[i], py: pyArr[i], tuner: node.tuner,
        coverage: node.coverage, marginalCoverage: node.marginalCoverage,
      });
    }
  }

  self.postMessage({ hexes, stats: { totalNodes: FN, tunerCounts }, generation } satisfies WorkerOutput);
};
