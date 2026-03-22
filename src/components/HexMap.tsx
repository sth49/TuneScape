/**
 * Hexagonal Tile Map Visualization
 *
 * - 8,800 trials clustered into ~100 groups
 * - Each hexagon = one cluster
 * - Similar clusters placed nearby (MDS)
 * - Hex color shows tuner distribution
 */

import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
} from "react";
import * as d3 from "d3";
import type { ProcessedData } from "../types/data";
import {
  getHexPath,
  getDominantTuner,
  TUNER_COLORS,
  TUNER_NAMES,
  buildCoarseLevels,
  buildSubRegionsForTerritory,
  generateSubRegionLabels,
  type HexMapData,
  type HexTile,
  type Cluster,
  type Territory,
  type SubRegion,
  type CoarseLevel,
  type Trial,
  type TunerType,
} from "../utils/hexMapUtils";

// ============================================================
// Types
// ============================================================

type ColorMode =
  | "dominant"
  | "territory"
  | "pixel"
  | "density"
  | "coverage"
  | "marginal";
type LayoutMode = "hex" | "map";

interface HexMapProps {
  width?: number;
  height?: number;
  program?: string;
}

interface TooltipData {
  cluster: Cluster;
  x: number;
  y: number;
}

interface VoronoiCell {
  cluster: Cluster;
  cx: number;
  cy: number;
  pathD: string; // compound path of all sub-cell polygons
  polygon: [number, number][]; // all vertices from all sub-cells
  outlineD: string; // same as pathD
  subCellPaths: string[]; // individual sub-cell polygon paths
}

// Territory is imported from hexMapUtils

interface NeighborEdge {
  clusterIdA: number;
  clusterIdB: number;
  sharedPoints: [number, number][];
}

interface VoronoiMapData {
  cells: VoronoiCell[];
  clusterBorderPaths: string[];
  territoryBorderPaths: string[];
  cellTerritoryIds: number[];
  neighborEdges: NeighborEdge[];
}

interface SubRegionVisual {
  territoryId: number;
  subRegionId: number;
  fill: string;
  stroke: string;
}

// ── Qualitative label types ──────────────────────────────────
type QualitativeLabel =
  | "Failure-prone"
  | "High Novelty"
  | "Saturated"
  | "High Coverage"
  | "Volatile";

interface QualLabelResult {
  primary: QualitativeLabel | null;
  hasSupport: boolean;
}

interface SRMetrics {
  trialCount: number;
  meanCoverage: number;
  meanMarginalCoverage: number;
  failureRate: number;
  coverageIqr: number;
}

/** Spatially connected group of clusters sharing the same qualitative class */
interface QualRegion {
  id: number;
  label: QualitativeLabel;
  clusterIds: Set<number>;
}

// ============================================================
// Noisy Edge Utilities (Amit Patel style)
// ============================================================

/** Simple seeded RNG for reproducible noise */
function seededRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** Midpoint-displacement subdivision between two points */
function noisyEdge(
  p1: [number, number],
  p2: [number, number],
  depth: number,
  rng: () => number,
  amplitude?: number,
): [number, number][] {
  if (depth <= 0) return [p1, p2];

  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  const amp = amplitude ?? len * 0.15;

  // midpoint + perpendicular displacement
  const mx = (p1[0] + p2[0]) / 2 + (-dy / len) * (rng() - 0.5) * amp;
  const my = (p1[1] + p2[1]) / 2 + (dx / len) * (rng() - 0.5) * amp;
  const mid: [number, number] = [mx, my];

  const left = noisyEdge(p1, mid, depth - 1, rng, amp * 0.5);
  const right = noisyEdge(mid, p2, depth - 1, rng, amp * 0.5);

  // left includes p1…mid, right includes mid…p2 → skip duplicate mid
  return [...left, ...right.slice(1)];
}

/** Apply noisy edges to every side of a polygon → SVG path string */
function noisyPolygon(
  vertices: [number, number][],
  seed: number,
  depth = 3,
): string {
  const rng = seededRng(seed);
  const pts: [number, number][] = [];

  for (let i = 0; i < vertices.length; i++) {
    const p1 = vertices[i];
    const p2 = vertices[(i + 1) % vertices.length];
    const edge = noisyEdge(p1, p2, depth, rng);
    // skip last point of each edge (it's the first of the next)
    pts.push(...edge.slice(0, -1));
  }

  return "M" + pts.map(([x, y]) => `${x},${y}`).join("L") + "Z";
}

// ============================================================
// Lloyd Relaxation
// ============================================================

function lloydRelax(
  points: [number, number][],
  bounds: [number, number, number, number],
  iterations = 3,
): [number, number][] {
  let pts = points.map(([x, y]) => [x, y] as [number, number]);

  for (let iter = 0; iter < iterations; iter++) {
    const delaunay = d3.Delaunay.from(pts);
    const voronoi = delaunay.voronoi(bounds);

    const next: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const cell = voronoi.cellPolygon(i);
      if (!cell || cell.length < 3) {
        next.push(pts[i]);
        continue;
      }
      // centroid of the cell polygon
      let cx = 0,
        cy = 0,
        area = 0;
      for (let j = 0; j < cell.length - 1; j++) {
        const [x0, y0] = cell[j];
        const [x1, y1] = cell[j + 1];
        const cross = x0 * y1 - x1 * y0;
        area += cross;
        cx += (x0 + x1) * cross;
        cy += (y0 + y1) * cross;
      }
      area /= 2;
      if (Math.abs(area) < 1e-10) {
        next.push(pts[i]);
      } else {
        cx /= 6 * area;
        cy /= 6 * area;
        next.push([cx, cy]);
      }
    }
    pts = next;
  }

  return pts;
}

// ============================================================
// Constants
// ============================================================

const TUNER_DISPLAY_NAMES: Record<TunerType, string> = {
  SymTuner: "SymTuner",
  CMA_ES: "CMA-ES",
  Genetic: "Genetic",
  SuccessiveHalving: "Succ. Halving",
  TPE: "TPE",
  BayesianOptimization: "Bayesian Opt.",
};

const HEX_SIZE = 32;

const QUAL_LABEL_COLORS: Record<QualitativeLabel, string> = {
  "Failure-prone": "#EF4444",
  "High Novelty": "#8B5CF6",
  Saturated: "#F59E0B",
  "High Coverage": "#10B981",
  Volatile: "#3B82F6",
};

const QUAL_LABEL_RATIONALE: Record<QualitativeLabel, string> = {
  "Failure-prone": "High zero-coverage rate (>20%)",
  "High Novelty": "High marginal coverage gain",
  Saturated: "High total coverage, low marginal gain",
  "High Coverage": "High total branch coverage",
  Volatile: "High coverage variance across trials",
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function mixHexColors(colorA: string, colorB: string, t: number): string {
  const a = d3.color(colorA);
  const b = d3.color(colorB);
  if (!a || !b) return colorA;

  const ratio = clamp01(t);
  const ra = d3.rgb(a);
  const rb = d3.rgb(b);
  return d3
    .rgb(
      ra.r + (rb.r - ra.r) * ratio,
      ra.g + (rb.g - ra.g) * ratio,
      ra.b + (rb.b - ra.b) * ratio,
    )
    .formatHex();
}

function getSubRegionPaletteColor(
  territoryColor: string,
  index: number,
  count: number,
): { fill: string; stroke: string } {
  const base = d3.hsl(territoryColor);
  const safeCount = Math.max(count, 1);
  const ratio = safeCount === 1 ? 0.5 : index / (safeCount - 1);
  const hueShift = (ratio - 0.5) * 28;
  const lightnessTargets = [0.84, 0.72, 0.6, 0.5];
  const saturationTargets = [0.52, 0.62, 0.7, 0.78];
  const targetIdx = Math.min(index, lightnessTargets.length - 1);

  const fill = d3
    .hsl(
      (base.h + hueShift + 360) % 360,
      Math.max(base.s * 0.7, saturationTargets[targetIdx]),
      lightnessTargets[targetIdx],
    )
    .formatHex();

  return {
    fill,
    stroke: mixHexColors(fill, territoryColor, 0.45),
  };
}

// ── Qualitative label helpers ────────────────────────────────
function qualPct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computeSRMetrics(trials: Trial[]): SRMetrics {
  const n = trials.length;
  if (n === 0)
    return {
      trialCount: 0,
      meanCoverage: 0,
      meanMarginalCoverage: 0,
      failureRate: 0,
      coverageIqr: 0,
    };
  const coverages = trials.map((t) => t.coverage);
  const marginals = trials.map((t) => t.marginalCoverage);
  const meanCoverage = coverages.reduce((a, b) => a + b, 0) / n;
  const meanMarginalCoverage = marginals.reduce((a, b) => a + b, 0) / n;
  const failureRate = coverages.filter((c) => c === 0).length / n;
  const coverageIqr =
    n >= 2 ? qualPct(coverages, 75) - qualPct(coverages, 25) : 0;
  return {
    trialCount: n,
    meanCoverage,
    meanMarginalCoverage,
    failureRate,
    coverageIqr,
  };
}

// ============================================================
// Component
// ============================================================

export function HexMap({
  width = 900,
  height = 750,
  program = "gawk",
}: HexMapProps) {
  const [data, setData] = useState<HexMapData | null>(null);
  const [rawTunerData, setRawTunerData] = useState<ProcessedData[] | null>(
    null,
  );
  const [shapImportance, setShapImportance] = useState<
    { name: string; importance: number }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [colorMode, setColorMode] = useState<ColorMode>("pixel");
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("hex");
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  // hover: tooltip only — never drives focus or selection
  const [hoveredClusterId, setHoveredClusterId] = useState<number | null>(null);
  // 1st click: territory focus; 2nd click within territory: cluster inspect
  const [focusedTerritoryId, setFocusedTerritoryId] = useState<number | null>(
    null,
  );
  // null = territory overview; number = highlighted sub-region within focused territory
  const [focusedSubRegionId, setFocusedSubRegionId] = useState<number | null>(
    null,
  );
  // sub-region label hover — temporarily highlights without changing click state
  const [hoveredSubRegionId, setHoveredSubRegionId] = useState<number | null>(
    null,
  );
  // cluster detail panel — only set from within a focused territory
  const [inspectedClusterId, setInspectedClusterId] = useState<number | null>(
    null,
  );

  const [selectedTuners, setSelectedTuners] = useState<Set<TunerType>>(
    new Set(TUNER_NAMES),
  );
  const [numClusters, setNumClusters] = useState<number>(200);
  // 4 = finest (current clusters), 3/2/1/0 = progressively coarser merged levels
  const [detailLevel, setDetailLevel] = useState<number>(4);

  const svgRef = useRef<SVGSVGElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const computationIdRef = useRef(0);

  // Initialize Web Worker once
  useEffect(() => {
    const worker = new Worker(
      new URL("../workers/hexMapWorker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;
    return () => {
      worker.terminate();
    };
  }, []);

  // Effect 1: Fetch raw data when program changes
  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      setLoading(true);
      setError(null);
      setRawTunerData(null);

      try {
        const tunerFiles = TUNER_NAMES.map(
          (tuner) => `/data/${program}_${tuner}_processed.json`,
        );
        const responses = await Promise.all(
          tunerFiles.map((url) =>
            fetch(url).then((r) => {
              if (!r.ok) throw new Error(`Failed to load ${url}`);
              return r.json();
            }),
          ),
        );
        if (cancelled) return;

        const decisionTreeData = await fetch(
          "/data/decision_tree_data.json",
        ).then((r) => r.json());
        if (cancelled) return;

        setRawTunerData(responses);
        setShapImportance(
          decisionTreeData[program]?.SymTuner?.param_importance || [],
        );
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load data");
          setLoading(false);
        }
      }
    }

    loadData();
    return () => {
      cancelled = true;
    };
  }, [program]);

  // Effect 2: Re-process via Web Worker when raw data or numClusters changes (NOT selectedTuners)
  useEffect(() => {
    if (!rawTunerData || !workerRef.current) return;
    setLoading(true);
    const id = ++computationIdRef.current;
    workerRef.current.postMessage({
      id,
      tunerData: rawTunerData,
      shapImportance,
      numClusters,
    });
    workerRef.current.onmessage = (e: MessageEvent) => {
      if (e.data.id !== computationIdRef.current) return; // stale result, discard
      if (e.data.error) {
        setError(e.data.error);
      } else {
        setData(e.data.result);
      }
      setLoading(false);
    };
  }, [rawTunerData, numClusters, shapImportance]);

  // Compute transform to fit and center the honeycomb
  const { centerX, centerY, scale } = useMemo(() => {
    const svgWidth = width - 200; // always: focusPanel(260) + controls(200)
    const svgHeight = height - 80;

    if (!data || data.hexTiles.length === 0) {
      return {
        centerX: svgWidth / 2,
        centerY: svgHeight / 2,
        scale: 1,
      };
    }

    const xs = data.hexTiles.map((t) => t.x);
    const ys = data.hexTiles.map((t) => t.y);
    const minX = Math.min(...xs) - HEX_SIZE;
    const maxX = Math.max(...xs) + HEX_SIZE;
    const minY = Math.min(...ys) - HEX_SIZE;
    const maxY = Math.max(...ys) + HEX_SIZE;

    const dataWidth = maxX - minX;
    const dataHeight = maxY - minY;

    // Calculate scale to fit
    const scaleX = svgWidth / dataWidth;
    const scaleY = svgHeight / dataHeight;
    const fitScale = Math.min(scaleX, scaleY, 1.2); // Cap at 1.2 to avoid too large

    return {
      centerX: svgWidth / 2,
      centerY: svgHeight / 2,
      scale: fitScale,
    };
  }, [data, width, height]);

  // Compute data center for transform
  const dataCenter = useMemo(() => {
    if (!data || data.hexTiles.length === 0) return { x: 0, y: 0 };

    const xs = data.hexTiles.map((t) => t.x);
    const ys = data.hexTiles.map((t) => t.y);
    return {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
  }, [data]);

  // Hex path
  const hexPath = useMemo(() => getHexPath(HEX_SIZE), []);

  // Territories are pre-computed in processHexMapData (hexMapUtils.ts)
  // Wrapped in useMemo so the array reference is stable across renders.
  const territories = useMemo<Territory[]>(() => data?.territories ?? [], [data]);

  // ── Coarse levels: 4 levels built by merging clusters spatially ─
  // coarseLevels[0] = level3 (≈50% of clusters), ..., [3] = level0 (≈6%)
  const coarseLevels = useMemo<CoarseLevel[]>(() => {
    if (!data) return [];
    return buildCoarseLevels(data);
  }, [data]);

  // Active coarse level data when detailLevel < 4
  const activeCoarseLevel = useMemo<CoarseLevel | null>(() => {
    if (detailLevel === 4) return null;
    return coarseLevels[3 - detailLevel] ?? null; // level3→idx0, ..., level0→idx3
  }, [detailLevel, coarseLevels]);

  // Each coarse cluster → one hex at its centroid, snapped to a coarser hex grid.
  // hexSize scales up so the cluster count × hex area ≈ the fine level's total area.
  const coarseHexLayout = useMemo<{
    coarseId: number; q: number; r: number; x: number; y: number;
    hexSize: number; color: string; tuner: TunerType; label: string;
  }[]>(() => {
    if (!activeCoarseLevel || !data) return [];

    const { clusters: coarseClusters } = activeCoarseLevel;
    const k = coarseClusters.length;
    const n = data.clusters.length;
    // Hex size grows so that k coarse hexes fill the same visual area as n fine hexes
    const hexSize = HEX_SIZE * Math.sqrt(n / Math.max(k, 1));

    // flat-top axial ↔ pixel helpers
    const pixelToAxial = (px: number, py: number, s: number) => ({
      fq: (2 / 3) * px / s,
      fr: (-1 / 3) * px / s + (Math.sqrt(3) / 3) * py / s,
    });
    const hexRound = (fq: number, fr: number) => {
      const fs = -fq - fr;
      let rq = Math.round(fq), rr = Math.round(fr);
      const rs = Math.round(fs);
      const dq = Math.abs(rq - fq), dr = Math.abs(rr - fr), ds = Math.abs(rs - fs);
      if (dq > dr && dq > ds) rq = -rr - rs;
      else if (dr > ds) rr = -rq - rs;
      return { q: rq, r: rr };
    };
    const axialToPixel = (q: number, r: number, s: number) => ({
      x: s * 1.5 * q,
      y: s * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r),
    });

    const HEX_DIRS = [
      { dq: 1, dr: 0 }, { dq: 0, dr: 1 }, { dq: -1, dr: 1 },
      { dq: -1, dr: 0 }, { dq: 0, dr: -1 }, { dq: 1, dr: -1 },
    ];

    // Largest clusters get first pick of hex positions
    const sorted = [...coarseClusters].sort((a, b) => b.totalTrials - a.totalTrials);
    const usedPositions = new Map<string, true>();
    const result: {
      coarseId: number; q: number; r: number; x: number; y: number;
      hexSize: number; color: string; tuner: TunerType; label: string;
    }[] = [];

    for (const cc of sorted) {
      const tuner = getDominantTuner(cc.tunerCounts);
      const color = TUNER_COLORS[tuner];
      const { fq, fr } = pixelToAxial(cc.pixelCentroidX, cc.pixelCentroidY, hexSize);
      let { q, r } = hexRound(fq, fr);

      // Spiral outward until an empty hex position is found
      if (usedPositions.has(`${q},${r}`)) {
        const tried = new Set([`${q},${r}`]);
        const queue = [{ q, r }];
        let placed = false;
        outer: while (queue.length > 0) {
          const cur = queue.shift()!;
          for (const { dq, dr } of HEX_DIRS) {
            const nq = cur.q + dq, nr = cur.r + dr;
            const nk = `${nq},${nr}`;
            if (tried.has(nk)) continue;
            tried.add(nk);
            if (!usedPositions.has(nk)) {
              q = nq; r = nr; placed = true; break outer;
            }
            queue.push({ q: nq, r: nr });
          }
        }
        if (!placed) continue;
      }

      usedPositions.set(`${q},${r}`, true);
      const { x, y } = axialToPixel(q, r, hexSize);
      result.push({ coarseId: cc.id, q, r, x, y, hexSize, color, tuner, label: cc.label });
    }

    return result;
  }, [activeCoarseLevel, data]);

  // Territory/sub-region structure for coarse levels (L0–L3)
  // - Territory = BFS connected component of same-tuner coarse hexes
  // - Sub-region border = internal edge between two adjacent coarse hexes of the same territory
  // - Territory border = external edge toward a different tuner or empty
  const coarseTerritoryData = useMemo(() => {
    if (detailLevel === 4 || coarseHexLayout.length === 0) return null;

    const hexSize = coarseHexLayout[0].hexSize;
    const DIRS = [
      { dq: 1, dr: 0 }, { dq: 0, dr: 1 }, { dq: -1, dr: 1 },
      { dq: -1, dr: 0 }, { dq: 0, dr: -1 }, { dq: 1, dr: -1 },
    ];
    const verts = Array.from({ length: 6 }, (_, i) => ({
      x: hexSize * Math.cos((i * Math.PI) / 3),
      y: hexSize * Math.sin((i * Math.PI) / 3),
    }));

    type CoarseHex = typeof coarseHexLayout[0];
    const hexMap = new Map<string, CoarseHex>();
    for (const h of coarseHexLayout) hexMap.set(`${h.q},${h.r}`, h);

    // BFS: find connected occupied components, matching L4 territory logic.
    type Component = {
      tuner: TunerType;
      hexes: CoarseHex[];
      cx: number;
      cy: number;
    };
    const visited = new Set<string>();
    const components: Component[] = [];

    for (const h of coarseHexLayout) {
      const k = `${h.q},${h.r}`;
      if (visited.has(k)) continue;
      const group: CoarseHex[] = [];
      const queue: CoarseHex[] = [h];
      visited.add(k);
      while (queue.length > 0) {
        const cur = queue.shift()!;
        group.push(cur);
        for (const { dq, dr } of DIRS) {
          const nk = `${cur.q + dq},${cur.r + dr}`;
          if (visited.has(nk)) continue;
          const nb = hexMap.get(nk);
          if (!nb) continue;
          visited.add(nk);
          queue.push(nb);
        }
      }
      const tunerCounts = {
        SymTuner: 0,
        CMA_ES: 0,
        Genetic: 0,
        SuccessiveHalving: 0,
        TPE: 0,
        BayesianOptimization: 0,
      } as Record<TunerType, number>;
      for (const member of group) {
        tunerCounts[member.tuner] += 1;
      }
      const tuner = getDominantTuner(tunerCounts);
      components.push({
        tuner,
        hexes: group,
        cx: group.reduce((s, x) => s + x.x, 0) / group.length,
        cy: group.reduce((s, x) => s + x.y, 0) / group.length,
      });
    }

    // Map each hex to its component index
    const hexToComp = new Map<string, number>();
    components.forEach((comp, idx) => {
      for (const h of comp.hexes) hexToComp.set(`${h.q},${h.r}`, idx);
    });

    // Build border paths
    let terrBorderD = '';
    let subBorderD = '';

    for (const h of coarseHexLayout) {
      const myComp = hexToComp.get(`${h.q},${h.r}`)!;
      for (let ei = 0; ei < 6; ei++) {
        const { dq, dr } = DIRS[ei];
        const nk = `${h.q + dq},${h.r + dr}`;
        const nb = hexMap.get(nk);
        const va = verts[ei], vb = verts[(ei + 1) % 6];
        const seg = `M${h.x + va.x},${h.y + va.y}L${h.x + vb.x},${h.y + vb.y}`;
        if (!nb || hexToComp.get(nk) !== myComp) {
          terrBorderD += seg;
        } else if (nb.tuner !== h.tuner) {
          subBorderD += seg;
        }
      }
    }

    const terrLabels: {
      tuner: TunerType;
      x: number;
      y: number;
      color: string;
      text: string;
      weight: number;
    }[] = [];

    // Sub-region labels: same approach as L4 — buildSubRegionsForTerritory per component,
    // then generateSubRegionLabels for contrastive parameter labels.
    const srLabels: { x: number; y: number; text: string; weight: number }[] =
      [];
    if (data && activeCoarseLevel) {
      const clusterById = new Map<number, Cluster>();
      for (const c of data.clusters) clusterById.set(c.id, c);
      const tileByClusterId = new Map<number, HexTile>();
      for (const tile of data.hexTiles) {
        if (tile.cluster) tileByClusterId.set(tile.cluster.id, tile);
      }
      const coarseClusterById = new Map<number, typeof activeCoarseLevel.clusters[0]>();
      for (const cc of activeCoarseLevel.clusters) coarseClusterById.set(cc.id, cc);
      const importanceMap = new Map(data.paramImportance.map(p => [p.name, p.importance]));

      const allTrials = data.clusters.flatMap((c) => c.trials);

      // orig cluster id → coarse hex position (for label placement at coarse level coords)
      const origClusterToCoarsePos = new Map<number, { x: number; y: number }>();
      for (const h of coarseHexLayout) {
        const cc = coarseClusterById.get(h.coarseId);
        if (!cc) continue;
        for (const cid of cc.memberClusterIds) origClusterToCoarsePos.set(cid, { x: h.x, y: h.y });
      }

      const componentRegions = components.map((comp) => {
        const origClusters: Cluster[] = [];
        const origTiles: HexTile[] = [];
        for (const h of comp.hexes) {
          const cc = coarseClusterById.get(h.coarseId);
          if (!cc) continue;
          for (const cid of cc.memberClusterIds) {
            const c = clusterById.get(cid);
            if (c) origClusters.push(c);
            const tile = tileByClusterId.get(cid);
            if (tile) origTiles.push(tile);
          }
        }

        const compTrials = origClusters.flatMap((c) => c.trials);
        const tunerCounts = {
          SymTuner: 0,
          CMA_ES: 0,
          Genetic: 0,
          SuccessiveHalving: 0,
          TPE: 0,
          BayesianOptimization: 0,
        } as Record<TunerType, number>;
        for (const c of origClusters) {
          for (const t of TUNER_NAMES) tunerCounts[t] += c.tunerCounts[t];
        }

        return {
          comp,
          origClusters,
          origTiles,
          compTrials,
          tunerCounts,
        };
      });

      const terrLabelTexts = generateSubRegionLabels(
        componentRegions.map((region) => ({ trials: region.compTrials })),
        allTrials,
        data.paramStats,
        data.labelParams,
        importanceMap,
      );

      componentRegions.forEach(
        ({ comp, origClusters, origTiles, compTrials, tunerCounts }, compIdx) => {
          const terrText = terrLabelTexts[compIdx];
          if (terrText) {
            terrLabels.push({
              tuner: comp.tuner,
              x: comp.cx,
              y: comp.cy,
              color: TUNER_COLORS[comp.tuner],
              text: terrText,
              weight: comp.hexes.length,
            });
          }

          if (origClusters.length === 0) return;

          const pseudoTerritory: Omit<Territory, "label" | "subRegions"> = {
            id: compIdx,
            clusters: origClusters,
            tiles: origTiles,
            trials: compTrials,
            totalTrials: compTrials.length,
            tunerCounts,
            centroidX: comp.cx,
            centroidY: comp.cy,
            pixelCentroidX: comp.cx,
            pixelCentroidY: comp.cy,
          };

          const srRaws = buildSubRegionsForTerritory(
            pseudoTerritory,
            data.labelParams,
            data.paramStats,
          );
          const srLabelTexts = generateSubRegionLabels(
            srRaws,
            compTrials,
            data.paramStats,
            data.labelParams,
            importanceMap,
          );

          for (let i = 0; i < srRaws.length; i++) {
            const text = srLabelTexts[i];
            if (!text) continue;
            // Recompute centroid using coarse hex positions (not fine-level tile positions)
            const srClusters = srRaws[i].clusters;
            let cx = 0,
              cy = 0,
              n = 0;
            for (const c of srClusters) {
              const pos = origClusterToCoarsePos.get(c.id);
              if (pos) {
                cx += pos.x;
                cy += pos.y;
                n++;
              }
            }
            if (n === 0) continue;
            srLabels.push({
              x: cx / n,
              y: cy / n,
              text,
              weight: srClusters.length,
            });
          }
        },
      );
    }

    return { terrBorderD, subBorderD, terrLabels, srLabels, hexSize };
  }, [coarseHexLayout, detailLevel, data, activeCoarseLevel]);

  const coarseMacroLabelPositions = useMemo(() => {
    if (detailLevel === 4 || !coarseTerritoryData) return [];

    const fs = 11 / scale;
    const pad = 5 / scale;
    const charW = fs * 0.58;
    const rh = fs + pad * 2;
    const gap = rh * 0.45;

    type Bbox = { x: number; y: number; w: number; h: number };
    const placed: Bbox[] = [];
    const results: {
      tuner: TunerType;
      x: number;
      y: number;
      rw: number;
      rh: number;
      color: string;
      label: string;
    }[] = [];

    const sorted = [...coarseTerritoryData.terrLabels]
      .filter((terr) => terr.text.trim().length > 0)
      .sort((a, b) => b.weight - a.weight);

    for (const terr of sorted) {
      const label = terr.text;
      const rw = label.length * charW + pad * 2;
      const candidates = [
        { x: terr.x, y: terr.y },
        { x: terr.x, y: terr.y - rh * 1.3 },
        { x: terr.x, y: terr.y + rh * 1.3 },
      ];

      let chosen: { x: number; y: number } | null = null;
      for (const c of candidates) {
        const bb: Bbox = {
          x: c.x - rw / 2 - gap / 2,
          y: c.y - rh / 2 - gap / 2,
          w: rw + gap,
          h: rh + gap,
        };
        const overlaps = placed.some(
          (p) =>
            bb.x < p.x + p.w &&
            bb.x + bb.w > p.x &&
            bb.y < p.y + p.h &&
            bb.y + bb.h > p.y,
        );
        if (!overlaps) {
          chosen = c;
          placed.push(bb);
          break;
        }
      }

      if (chosen) {
        results.push({
          tuner: terr.tuner,
          x: chosen.x,
          y: chosen.y,
          rw,
          rh,
          color: terr.color,
          label,
        });
      }
    }

    return results;
  }, [coarseTerritoryData, detailLevel, scale]);

  const coarseHexVisuals = useMemo(() => {
    const map = new Map<number, { fill: string; stroke: string }>();
    if (
      detailLevel === 4 ||
      coarseHexLayout.length === 0 ||
      !data ||
      !activeCoarseLevel
    ) {
      return map;
    }

    type CoarseHex = (typeof coarseHexLayout)[number];
    const dirs = [
      { dq: 1, dr: 0 },
      { dq: 0, dr: 1 },
      { dq: -1, dr: 1 },
      { dq: -1, dr: 0 },
      { dq: 0, dr: -1 },
      { dq: 1, dr: -1 },
    ];

    const hexMap = new Map<string, CoarseHex>();
    for (const h of coarseHexLayout) hexMap.set(`${h.q},${h.r}`, h);

    const visited = new Set<string>();
    const components: CoarseHex[][] = [];
    for (const h of coarseHexLayout) {
      const startKey = `${h.q},${h.r}`;
      if (visited.has(startKey)) continue;
      const group: CoarseHex[] = [];
      const queue: CoarseHex[] = [h];
      visited.add(startKey);
      while (queue.length > 0) {
        const cur = queue.shift()!;
        group.push(cur);
        for (const { dq, dr } of dirs) {
          const nk = `${cur.q + dq},${cur.r + dr}`;
          if (visited.has(nk)) continue;
          const nb = hexMap.get(nk);
          if (!nb) continue;
          visited.add(nk);
          queue.push(nb);
        }
      }
      components.push(group);
    }

    const clusterById = new Map<number, Cluster>();
    for (const c of data.clusters) clusterById.set(c.id, c);

    const tileByClusterId = new Map<number, HexTile>();
    for (const tile of data.hexTiles) {
      if (tile.cluster) tileByClusterId.set(tile.cluster.id, tile);
    }

    const coarseClusterById = new Map<
      number,
      (typeof activeCoarseLevel.clusters)[number]
    >();
    for (const cc of activeCoarseLevel.clusters) coarseClusterById.set(cc.id, cc);

    for (const component of components) {
      const tunerCounts = {
        SymTuner: 0,
        CMA_ES: 0,
        Genetic: 0,
        SuccessiveHalving: 0,
        TPE: 0,
        BayesianOptimization: 0,
      } as Record<TunerType, number>;
      for (const coarseHex of component) {
        tunerCounts[coarseHex.tuner] += 1;
      }
      const territoryColor = TUNER_COLORS[getDominantTuner(tunerCounts)];

      const origClusters: Cluster[] = [];
      const origTiles: HexTile[] = [];
      for (const coarseHex of component) {
        const cc = coarseClusterById.get(coarseHex.coarseId);
        if (!cc) continue;
        for (const cid of cc.memberClusterIds) {
          const cluster = clusterById.get(cid);
          if (cluster) origClusters.push(cluster);
          const tile = tileByClusterId.get(cid);
          if (tile) origTiles.push(tile);
        }
      }

      const compTrials = origClusters.flatMap((cluster) => cluster.trials);
      if (origClusters.length === 0) continue;

      const pseudoTerritory: Omit<Territory, "label" | "subRegions"> = {
        id: component[0].coarseId,
        clusters: origClusters,
        tiles: origTiles,
        trials: compTrials,
        totalTrials: compTrials.length,
        tunerCounts: origClusters.reduce(
          (acc, cluster) => {
            for (const tuner of TUNER_NAMES) acc[tuner] += cluster.tunerCounts[tuner];
            return acc;
          },
          {
            SymTuner: 0,
            CMA_ES: 0,
            Genetic: 0,
            SuccessiveHalving: 0,
            TPE: 0,
            BayesianOptimization: 0,
          } as Record<TunerType, number>,
        ),
        centroidX: component.reduce((sum, h) => sum + h.x, 0) / component.length,
        centroidY: component.reduce((sum, h) => sum + h.y, 0) / component.length,
        pixelCentroidX:
          component.reduce((sum, h) => sum + h.x, 0) / component.length,
        pixelCentroidY:
          component.reduce((sum, h) => sum + h.y, 0) / component.length,
      };

      const sortedSubRegions = [...buildSubRegionsForTerritory(
        pseudoTerritory,
        data.labelParams,
        data.paramStats,
      )].sort((a, b) => b.totalTrials - a.totalTrials);

      if (sortedSubRegions.length === 0) {
        for (const coarseHex of component) {
          map.set(coarseHex.coarseId, {
            fill: mixHexColors(territoryColor, "#FFFFFF", 0.65),
            stroke: mixHexColors(territoryColor, "#475569", 0.2),
          });
        }
        continue;
      }

      const coarseVotes = new Map<number, Map<number, number>>();
      sortedSubRegions.forEach((sr, srIndex) => {
        for (const cluster of sr.clusters) {
          const coarseId = activeCoarseLevel.clusterIdToCoarseId.get(cluster.id);
          if (coarseId === undefined) continue;
          let votes = coarseVotes.get(coarseId);
          if (!votes) {
            votes = new Map<number, number>();
            coarseVotes.set(coarseId, votes);
          }
          votes.set(srIndex, (votes.get(srIndex) ?? 0) + 1);
        }
      });

      for (const coarseHex of component) {
        const votes = coarseVotes.get(coarseHex.coarseId);
        let chosenIndex = 0;
        if (votes && votes.size > 0) {
          chosenIndex = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
        const palette = getSubRegionPaletteColor(
          territoryColor,
          chosenIndex,
          sortedSubRegions.length,
        );
        map.set(coarseHex.coarseId, palette);
      }
    }

    return map;
  }, [activeCoarseLevel, coarseHexLayout, data, detailLevel]);

  // cluster.id → territory.id (used for focus-mode opacity and click routing)
  const clusterToTerrId = useMemo(() => {
    const map = new Map<number, number>();
    for (const terr of territories) {
      for (const c of terr.clusters) map.set(c.id, terr.id);
    }
    return map;
  }, [territories]);

  // Inspected cluster object (for detail panel)
  const inspectedCluster = useMemo(() => {
    if (inspectedClusterId === null || !data) return null;
    return data.clusters.find((c) => c.id === inspectedClusterId) ?? null;
  }, [data, inspectedClusterId]);

  // cluster.id → subRegion.id (within whichever territory is focused)
  const clusterToSubRegionId = useMemo(() => {
    const map = new Map<number, number>();
    if (focusedTerritoryId === null) return map;
    const terr = territories.find((t) => t.id === focusedTerritoryId);
    if (!terr) return map;
    for (const sr of terr.subRegions) {
      for (const c of sr.clusters) map.set(c.id, sr.id);
    }
    return map;
  }, [territories, focusedTerritoryId]);

  const clusterToSubRegionVisual = useMemo(() => {
    const map = new Map<number, SubRegionVisual>();

    for (const terr of territories) {
      const territoryColor = TUNER_COLORS[getDominantTuner(terr.tunerCounts)];
      const sortedSubRegions = [...terr.subRegions].sort(
        (a, b) => b.totalTrials - a.totalTrials,
      );

      sortedSubRegions.forEach((sr, index) => {
        const palette = getSubRegionPaletteColor(
          territoryColor,
          index,
          sortedSubRegions.length,
        );

        for (const cluster of sr.clusters) {
          map.set(cluster.id, {
            territoryId: terr.id,
            subRegionId: sr.id,
            fill: palette.fill,
            stroke: palette.stroke,
          });
        }
      });
    }

    return map;
  }, [territories]);

  // ── Qualitative: per-cluster metrics & class (independent of parameter sub-regions) ──
  // Step 1: per-cluster metrics from cluster.trials directly
  const clusterQualMetrics = useMemo((): Map<number, SRMetrics> => {
    if (!data) return new Map();
    const map = new Map<number, SRMetrics>();
    for (const cluster of data.clusters) {
      map.set(cluster.id, computeSRMetrics(cluster.trials));
    }
    return map;
  }, [data]);

  // Step 2: thresholds from all clusters with trialCount >= 2 (program-wide)
  const clusterQualThresholds = useMemo(() => {
    const supported = [...clusterQualMetrics.values()].filter(
      (m) => m.trialCount >= 2,
    );
    if (supported.length === 0)
      return { p75Coverage: 0, p75Marginal: 0, p25Marginal: 0, p75Iqr: 0 };
    return {
      p75Coverage: qualPct(
        supported.map((m) => m.meanCoverage),
        75,
      ),
      p75Marginal: qualPct(
        supported.map((m) => m.meanMarginalCoverage),
        75,
      ),
      p25Marginal: qualPct(
        supported.map((m) => m.meanMarginalCoverage),
        25,
      ),
      p75Iqr: qualPct(
        supported.map((m) => m.coverageIqr),
        75,
      ),
    };
  }, [clusterQualMetrics]);

  // Step 3: per-cluster qualitative class (null = no label / low support)
  const clusterQualClass = useMemo((): Map<number, QualitativeLabel | null> => {
    const map = new Map<number, QualitativeLabel | null>();
    for (const [cid, m] of clusterQualMetrics) {
      if (m.trialCount === 0) {
        map.set(cid, null);
        continue;
      }
      const hasSupport = m.trialCount >= 2;
      let label: QualitativeLabel | null = null;
      if (m.failureRate > 0.2) {
        label = "Failure-prone";
      } else if (hasSupport) {
        if (m.meanMarginalCoverage > clusterQualThresholds.p75Marginal) {
          label = "High Novelty";
        } else if (
          m.meanCoverage > clusterQualThresholds.p75Coverage &&
          m.meanMarginalCoverage < clusterQualThresholds.p25Marginal
        ) {
          label = "Saturated";
        } else if (m.meanCoverage > clusterQualThresholds.p75Coverage) {
          label = "High Coverage";
        } else if (m.coverageIqr > clusterQualThresholds.p75Iqr) {
          label = "Volatile";
        }
      }
      map.set(cid, label);
    }
    return map;
  }, [clusterQualMetrics, clusterQualThresholds]);

  // Metrics for the focused territory + its sub-regions
  const focusedTerritoryMetrics = useMemo(() => {
    if (focusedTerritoryId === null) return null;
    const terr = territories.find((t) => t.id === focusedTerritoryId);
    if (!terr) return null;

    const terrAvgCov =
      terr.trials.length > 0
        ? terr.trials.reduce((s, t) => s + t.coverage, 0) / terr.trials.length
        : 0;
    const terrMaxCov =
      terr.trials.length > 0
        ? Math.max(...terr.trials.map((t) => t.coverage))
        : 0;

    const subMetrics = [...terr.subRegions]
      .sort((a, b) => b.totalTrials - a.totalTrials)
      .map((sr) => {
        const avgCov =
          sr.trials.length > 0
            ? sr.trials.reduce((s, t) => s + t.coverage, 0) / sr.trials.length
            : 0;
        const maxCov =
          sr.trials.length > 0
            ? Math.max(...sr.trials.map((t) => t.coverage))
            : 0;
        const dominant = getDominantTuner(sr.tunerCounts);
        const dominantPct =
          sr.totalTrials > 0
            ? Math.round((sr.tunerCounts[dominant] / sr.totalTrials) * 100)
            : 0;
        return { sr, avgCov, maxCov, dominant, dominantPct };
      });

    return { terr, terrAvgCov, terrMaxCov, subMetrics };
  }, [focusedTerritoryId, territories]);

  // ============================================================
  // Voronoi cell computation (map mode)
  // Two levels: territory Voronoi (big continents) + cluster cells inside
  // ============================================================
  const voronoiMapData = useMemo((): VoronoiMapData | null => {
    if (!data || layoutMode !== "map") return null;

    const clusters = data.clusters;
    if (clusters.length === 0)
      return {
        cells: [],
        clusterBorderPaths: [],
        territoryBorderPaths: [],
        cellTerritoryIds: [],
        neighborEdges: [],
      };

    const svgW = width - 240;
    const svgH = height - 80;
    const pad = 30;

    // MDS coordinates → pixel
    const mdsXs = clusters.map((c) => c.x);
    const mdsYs = clusters.map((c) => c.y);
    const xScale = d3
      .scaleLinear()
      .domain(d3.extent(mdsXs) as [number, number])
      .range([pad, svgW - pad]);
    const yScale = d3
      .scaleLinear()
      .domain(d3.extent(mdsYs) as [number, number])
      .range([pad, svgH - pad]);

    // Cluster positions in pixel space
    const clusterPositions: [number, number][] = clusters.map((c) => [
      xScale(c.x),
      yScale(c.y),
    ]);

    // Map each cluster → its territory
    const clusterToTerritory = new Map<number, number>();
    for (const terr of territories) {
      for (const c of terr.clusters) {
        clusterToTerritory.set(c.id, terr.id);
      }
    }

    // --- Standard Voronoi: 1 seed per cluster at MDS position ---
    let sites: [number, number][] = clusterPositions.map(([x, y]) => [
      Math.max(pad * 0.5, Math.min(svgW - pad * 0.5, x)),
      Math.max(pad * 0.5, Math.min(svgH - pad * 0.5, y)),
    ]);

    const bounds: [number, number, number, number] = [0, 0, svgW, svgH];

    // Lloyd relaxation (3 iterations) for smoother, more uniform cells
    sites = lloydRelax(sites, bounds, 3);

    // Ghost boundary points around convex hull to constrain edge cells
    const hull = d3.polygonHull(sites);
    const ghostPts: [number, number][] = [];
    if (hull && hull.length >= 3) {
      let hcx = 0,
        hcy = 0;
      for (const [x, y] of hull) {
        hcx += x;
        hcy += y;
      }
      hcx /= hull.length;
      hcy /= hull.length;
      const ghostOffset = Math.min(svgW, svgH) * 0.15;
      for (let i = 0; i < hull.length; i++) {
        const [x1, y1] = hull[i];
        const [x2, y2] = hull[(i + 1) % hull.length];
        const dx1 = x1 - hcx,
          dy1 = y1 - hcy;
        const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1) || 1;
        ghostPts.push([
          x1 + (dx1 / len1) * ghostOffset,
          y1 + (dy1 / len1) * ghostOffset,
        ]);
        const mx = (x1 + x2) / 2,
          my = (y1 + y2) / 2;
        const dxm = mx - hcx,
          dym = my - hcy;
        const lenm = Math.sqrt(dxm * dxm + dym * dym) || 1;
        ghostPts.push([
          mx + (dxm / lenm) * ghostOffset,
          my + (dym / lenm) * ghostOffset,
        ]);
      }
    }

    const realCount = sites.length; // = clusters.length
    const allSites = [...sites, ...ghostPts];
    const delaunay = d3.Delaunay.from(allSites);
    const voronoi = delaunay.voronoi(bounds);

    // Build one VoronoiCell per cluster
    const cells: VoronoiCell[] = [];
    const cellTerritoryIds: number[] = [];

    for (let i = 0; i < realCount; i++) {
      const cellPoly = voronoi.cellPolygon(i);
      if (!cellPoly) continue;
      const verts: [number, number][] = cellPoly.slice(0, -1) as [
        number,
        number,
      ][];
      const pathD = "M" + verts.map(([x, y]) => `${x},${y}`).join("L") + "Z";

      cells.push({
        cluster: clusters[i],
        cx: sites[i][0],
        cy: sites[i][1],
        pathD,
        polygon: verts,
        outlineD: pathD,
        subCellPaths: [pathD],
      });
      cellTerritoryIds.push(clusterToTerritory.get(clusters[i].id) ?? -1);
    }

    // --- Extract cluster borders, territory borders, and neighbor edges from Delaunay neighbors ---
    const clusterBorderSegments: [number, number][][] = [];
    const territoryBorderSegments: [number, number][][] = [];
    const neighborEdges: NeighborEdge[] = [];

    for (let i = 0; i < realCount; i++) {
      const terrI = clusterToTerritory.get(clusters[i].id);
      const polyI = voronoi.cellPolygon(i);
      if (!polyI) continue;
      const vertsI = polyI.slice(0, -1);

      for (const j of delaunay.neighbors(i)) {
        if (j >= realCount) continue; // ghost
        if (j <= i) continue; // avoid duplicates

        // Find shared edge vertices
        const polyJ = voronoi.cellPolygon(j);
        if (!polyJ) continue;
        const vertsJ = polyJ.slice(0, -1);
        const shared: [number, number][] = [];
        for (const [ax, ay] of vertsI) {
          for (const [bx, by] of vertsJ) {
            if (Math.abs(ax - bx) < 0.5 && Math.abs(ay - by) < 0.5) {
              shared.push([ax, ay]);
              break;
            }
          }
        }
        if (shared.length < 2) continue;

        // Every neighbor pair is a cluster border (1 seed per cluster)
        clusterBorderSegments.push(shared);
        neighborEdges.push({
          clusterIdA: clusters[i].id,
          clusterIdB: clusters[j].id,
          sharedPoints: shared,
        });

        // Territory border (only if different territories)
        const terrJ = clusterToTerritory.get(clusters[j].id);
        if (terrI !== terrJ) {
          territoryBorderSegments.push(shared);
        }
      }
    }

    // Convert border segments to SVG paths with noisy edges for organic look
    const segToPath = (seg: [number, number][], depth: number): string => {
      if (seg.length === 2) {
        const rng = seededRng(Math.round(seg[0][0] * 7 + seg[1][1] * 13));
        const noisy = noisyEdge(seg[0], seg[1], depth, rng);
        return "M" + noisy.map(([x, y]) => `${x},${y}`).join("L");
      }
      return "M" + seg.map(([x, y]) => `${x},${y}`).join("L");
    };

    const clusterBorderPaths = clusterBorderSegments.map((seg) =>
      segToPath(seg, 2),
    );
    const territoryBorderPaths = territoryBorderSegments.map((seg) =>
      segToPath(seg, 2),
    );

    return {
      cells,
      clusterBorderPaths,
      territoryBorderPaths,
      cellTerritoryIds,
      neighborEdges,
    };
  }, [data, territories, layoutMode, width, height]);

  // Synthetic HexTile lookup for map mode (for reusing tooltip / click handlers)
  const voronoiTileMap = useMemo(() => {
    if (!voronoiMapData) return new Map<number, HexTile>();
    const map = new Map<number, HexTile>();
    for (const cell of voronoiMapData.cells) {
      const tile: HexTile = {
        q: cell.cluster.id,
        r: 0,
        cluster: cell.cluster,
        x: cell.cx,
        y: cell.cy,
      };
      map.set(cell.cluster.id, tile);
    }
    return map;
  }, [voronoiMapData]);

  // Territory boundary lines for map mode (per-tuner colored edges between Voronoi cells)
  const mapTerritoryBorders = useMemo(() => {
    if (!voronoiMapData || !data) return null;

    // Build cluster lookup by id
    const clusterById = new Map<number, Cluster>();
    for (const c of data.clusters) {
      clusterById.set(c.id, c);
    }

    const lines: React.ReactElement[] = [];
    let lineIdx = 0;

    for (const edge of voronoiMapData.neighborEdges) {
      const clusterA = clusterById.get(edge.clusterIdA);
      const clusterB = clusterById.get(edge.clusterIdB);
      if (!clusterA || !clusterB) continue;

      // Find tuners present in A but not B, and vice versa
      const boundaryTuners: TunerType[] = [];
      for (const tuner of TUNER_NAMES) {
        if (!selectedTuners.has(tuner)) continue;
        const inA = clusterA.tunerCounts[tuner] > 0;
        const inB = clusterB.tunerCounts[tuner] > 0;
        if (inA !== inB) {
          boundaryTuners.push(tuner);
        }
      }
      if (boundaryTuners.length === 0) continue;

      // Shared edge: 2 points
      const [p1, p2] = edge.sharedPoints;
      if (!p1 || !p2) continue;

      // Edge direction and normal for parallel offset lines
      const dx = p2[0] - p1[0];
      const dy = p2[1] - p1[1];
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;

      const lineWidth = 3;
      const totalWidth = boundaryTuners.length * lineWidth;
      const startOffset = -(totalWidth - lineWidth) / 2;

      for (let ti = 0; ti < boundaryTuners.length; ti++) {
        const offset = startOffset + ti * lineWidth;
        lines.push(
          <line
            key={`map-terr-${lineIdx++}`}
            x1={p1[0] + nx * offset}
            y1={p1[1] + ny * offset}
            x2={p2[0] + nx * offset}
            y2={p2[1] + ny * offset}
            stroke={TUNER_COLORS[boundaryTuners[ti]]}
            strokeWidth={lineWidth}
            strokeLinecap="round"
          />,
        );
      }
    }

    return lines.length > 0 ? <g pointerEvents="none">{lines}</g> : null;
  }, [voronoiMapData, data, selectedTuners]);

  // Tuner territory sizes: how many clusters each tuner occupies → sorted rank
  const tunerTerritoryRank = useMemo(() => {
    if (!data) return new Map<TunerType, number>();
    const sizes: { tuner: TunerType; count: number }[] = TUNER_NAMES.map(
      (tuner) => ({
        tuner,
        count: data.clusters.filter((c) => c.tunerCounts[tuner] > 0).length,
      }),
    );
    sizes.sort((a, b) => b.count - a.count); // largest first
    const rankMap = new Map<TunerType, number>();
    sizes.forEach((s, i) => rankMap.set(s.tuner, i));
    return rankMap;
  }, [data]);

  // Density color scale: maps selected-tuner trial count → color
  const densityScale = useMemo(() => {
    if (!data) return null;
    const trials = data.clusters.map((c) =>
      TUNER_NAMES.filter((t) => selectedTuners.has(t)).reduce(
        (sum, t) => sum + c.tunerCounts[t],
        0,
      ),
    );
    const maxTrials = d3.max(trials) ?? 1;
    return d3.scaleSequential(d3.interpolateYlOrRd).domain([0, maxTrials]);
  }, [data, selectedTuners]);

  const maxBranchCoverage = useMemo(() => {
    if (!data) return 1;
    const maxCoverage =
      d3.max(data.clusters.map((c) => c.meanBranchCoverage)) ?? 1;
    return Math.max(maxCoverage, 1);
  }, [data]);

  const positiveBranchCoverages = useMemo(() => {
    if (!data) return [];
    return data.clusters
      .map((c) => c.meanBranchCoverage)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
  }, [data]);

  const getCoverageColor = useCallback(
    (coverage: number): string => {
      const red = "#DC2626";
      const white = "#FFFFFF";
      const green = "#16A34A";

      if (coverage <= 0) {
        return red;
      }

      if (positiveBranchCoverages.length === 0) {
        return white;
      }

      const idx = d3.bisectRight(positiveBranchCoverages, coverage);
      const t = Math.max(0, Math.min(1, idx / positiveBranchCoverages.length));
      return d3.interpolateRgb(white, green)(t);
    },
    [positiveBranchCoverages],
  );

  const maxMarginalCoverage = useMemo(() => {
    if (!data) return 1;
    const maxCoverage = d3.max(data.clusters.map((c) => c.avgCoverage)) ?? 1;
    return Math.max(maxCoverage, 1);
  }, [data]);

  const positiveMarginalCoverages = useMemo(() => {
    if (!data) return [];
    return data.clusters
      .map((c) => c.avgCoverage)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
  }, [data]);

  const getMarginalCoverageColor = useCallback(
    (coverage: number): string => {
      const red = "#DC2626";
      const white = "#FFFFFF";
      const green = "#16A34A";

      if (coverage <= 0) {
        return red;
      }

      if (positiveMarginalCoverages.length === 0) {
        return white;
      }

      const idx = d3.bisectRight(positiveMarginalCoverages, coverage);
      const t = Math.max(
        0,
        Math.min(1, idx / positiveMarginalCoverages.length),
      );
      return d3.interpolateRgb(white, green)(t);
    },
    [positiveMarginalCoverages],
  );

  // Get hex fill
  const getHexFill = useCallback(
    (tile: HexTile): string | null => {
      if (!tile.cluster) return "#F1F5F9";

      const { tunerCounts } = tile.cluster;
      const subRegionVisual = clusterToSubRegionVisual.get(tile.cluster.id);

      switch (colorMode) {
        case "dominant": {
          const filteredCounts = Object.fromEntries(
            TUNER_NAMES.filter((t) => selectedTuners.has(t)).map((t) => [
              t,
              tunerCounts[t],
            ]),
          ) as Record<TunerType, number>;
          const dominant = getDominantTuner(filteredCounts);
          return TUNER_COLORS[dominant];
        }

        case "density": {
          const selectedTotal = TUNER_NAMES.filter((t) =>
            selectedTuners.has(t),
          ).reduce((sum, t) => sum + tunerCounts[t], 0);
          return densityScale ? densityScale(selectedTotal) : "#F8FAFC";
        }

        case "coverage":
          return getCoverageColor(tile.cluster.meanBranchCoverage);

        case "marginal":
          return getMarginalCoverageColor(tile.cluster.avgCoverage);

        case "territory":
          return "#F8FAFC";

        case "pixel":
        default:
          return subRegionVisual?.fill ?? "#F8FAFC";
      }
    },
    [
      colorMode,
      clusterToSubRegionVisual,
      densityScale,
      getCoverageColor,
      getMarginalCoverageColor,
      selectedTuners,
    ],
  );

  // Build a map from hex coordinates to tile for neighbor lookup
  const hexLookup = useMemo(() => {
    if (!data) return new Map<string, HexTile>();
    const map = new Map<string, HexTile>();
    for (const tile of data.hexTiles) {
      map.set(`${tile.q},${tile.r}`, tile);
    }
    return map;
  }, [data]);

  // Flat-top hex neighbor directions (matches edge index)
  const HEX_DIRECTIONS = useMemo(
    () => [
      { dq: 1, dr: 0 }, // 0: East (right edge)
      { dq: 0, dr: 1 }, // 1: Southeast (bottom-right edge)
      { dq: -1, dr: 1 }, // 2: Southwest (bottom-left edge)
      { dq: -1, dr: 0 }, // 3: West (left edge)
      { dq: 0, dr: -1 }, // 4: Northwest (top-left edge)
      { dq: 1, dr: -1 }, // 5: Northeast (top-right edge)
    ],
    [],
  );

  // Get hex vertices for flat-top hexagon
  const getHexVertices = useCallback((size: number) => {
    const vertices: { x: number; y: number }[] = [];
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i;
      vertices.push({
        x: size * Math.cos(angle),
        y: size * Math.sin(angle),
      });
    }
    return vertices;
  }, []);

  // ── Qualitative: Step 4 — BFS spatial segmentation ──────────
  // Adjacent clusters sharing the same qualitative class form a QualRegion.
  // This is independent of parameter sub-regions: one param sub-region can
  // contain multiple qual regions, and one qual region can span sub-regions.
  const qualRegions = useMemo((): QualRegion[] => {
    if (!data) return [];
    const visited = new Set<number>(); // cluster ids
    const regions: QualRegion[] = [];
    let regionId = 0;

    for (const tile of data.hexTiles) {
      if (!tile.cluster) continue;
      const cid = tile.cluster.id;
      if (visited.has(cid)) continue;
      const label = clusterQualClass.get(cid);
      if (!label) {
        visited.add(cid);
        continue;
      }

      // BFS: grow region from this seed
      const region: QualRegion = {
        id: regionId++,
        label,
        clusterIds: new Set(),
      };
      const queue: HexTile[] = [tile];
      visited.add(cid);
      region.clusterIds.add(cid);

      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const { dq, dr } of HEX_DIRECTIONS) {
          const neighbor = hexLookup.get(`${cur.q + dq},${cur.r + dr}`);
          if (!neighbor?.cluster) continue;
          const nid = neighbor.cluster.id;
          if (visited.has(nid)) continue;
          if (clusterQualClass.get(nid) !== label) continue;
          visited.add(nid);
          region.clusterIds.add(nid);
          queue.push(neighbor);
        }
      }

      regions.push(region);
    }

    return regions;
  }, [data, clusterQualClass, hexLookup, HEX_DIRECTIONS]);

  const clusterToQualRegion = useMemo((): Map<number, QualRegion> => {
    const map = new Map<number, QualRegion>();
    for (const region of qualRegions) {
      for (const cid of region.clusterIds) {
        map.set(cid, region);
      }
    }
    return map;
  }, [qualRegions]);

  // ============================================================
  // 2-level boundary data: macro (territory outer edge) + sub (sub-region inner edge)
  // Computed in one pass over the hex grid.
  // ============================================================
  const boundaryData = useMemo(() => {
    if (!data || territories.length === 0) {
      return {
        macro: [] as { d: string; terr: Territory }[],
        sub: [] as { d: string; sr: SubRegion; terr: Territory }[],
      };
    }

    // Build lookups: hex key → territoryId, sub-region key, visibility
    const hexToTerr = new Map<string, number>();
    const hexToSub = new Map<string, { tId: number; srId: number }>();
    const visibleHex = new Set<string>();
    for (const terr of territories) {
      for (const tile of terr.tiles) {
        const k = `${tile.q},${tile.r}`;
        hexToTerr.set(k, terr.id);
        if (
          tile.cluster &&
          TUNER_NAMES.some(
            (t) => selectedTuners.has(t) && tile.cluster!.tunerCounts[t] > 0,
          )
        )
          visibleHex.add(k);
      }
      for (const sr of terr.subRegions) {
        for (const tile of sr.tiles)
          hexToSub.set(`${tile.q},${tile.r}`, { tId: terr.id, srId: sr.id });
      }
    }

    // flat-top hex vertex offsets; edge edgeIdx = vertex[edgeIdx] → vertex[(edgeIdx+1)%6]
    const verts = Array.from({ length: 6 }, (_, i) => ({
      x: HEX_SIZE * Math.cos((i * Math.PI) / 3),
      y: HEX_SIZE * Math.sin((i * Math.PI) / 3),
    }));

    const macroPathMap = new Map<number, string>();
    const subPathMap = new Map<string, string>();

    for (const terr of territories) {
      let macroD = "";
      for (const sr of terr.subRegions) {
        let subD = "";
        for (const tile of sr.tiles) {
          const tk = `${tile.q},${tile.r}`;
          if (!visibleHex.has(tk)) continue; // skip hidden tiles entirely
          for (let ei = 0; ei < 6; ei++) {
            const dir = HEX_DIRECTIONS[ei];
            const nk = `${tile.q + dir.dq},${tile.r + dir.dr}`;
            const nTerr = hexToTerr.get(nk);
            const nSub = hexToSub.get(nk);
            const neighborVisible = visibleHex.has(nk);
            const va = verts[ei];
            const vb = verts[(ei + 1) % 6];
            const seg = `M${tile.x + va.x},${tile.y + va.y}L${tile.x + vb.x},${tile.y + vb.y}`;

            if (!neighborVisible || nTerr !== terr.id) {
              macroD += seg; // outer territory edge (or edge of hidden neighbor)
            } else if (nSub && nSub.srId !== sr.id) {
              subD += seg; // inner sub-region edge
            }
          }
        }
        subPathMap.set(`${terr.id}-${sr.id}`, subD);
      }
      macroPathMap.set(terr.id, macroD);
    }

    return {
      macro: territories.map((t) => ({
        d: macroPathMap.get(t.id) ?? "",
        terr: t,
      })),
      sub: territories.flatMap((t) =>
        t.subRegions.map((sr) => ({
          d: subPathMap.get(`${t.id}-${sr.id}`) ?? "",
          sr,
          terr: t,
        })),
      ),
    };
  }, [data, territories, HEX_DIRECTIONS, selectedTuners]);

  // ============================================================
  // Greedy label placement for sub-region labels (focus mode only)
  // Sorts sub-regions by size, places largest first.
  // If a label bbox overlaps an already-placed one, try offset
  // candidates. If all collide, skip the label.
  // ============================================================
  const subLabelPositions = useMemo(() => {
    if (focusedTerritoryId === null) return [];
    const terr = territories.find((t) => t.id === focusedTerritoryId);
    if (!terr) return [];

    const fs = 10 / scale;
    const pad = 5 / scale;
    const rh = fs + pad * 2;
    const charW = fs * 0.56;
    const gap = rh * 0.3;

    type Bbox = { x: number; y: number; w: number; h: number };
    const placed: Bbox[] = [];
    const results: {
      sr: SubRegion;
      x: number;
      y: number;
      rw: number;
      rh: number;
      color: string;
    }[] = [];

    const sorted = [...terr.subRegions]
      .filter((sr) => sr.label.trim().length > 0)
      .sort((a, b) => b.totalTrials - a.totalTrials);

    for (const sr of sorted) {
      const rw = sr.label.length * charW + pad * 2;
      const cx = sr.pixelCentroidX;
      const cy = sr.pixelCentroidY;
      const step = rh + gap;

      const candidates = [
        { x: cx, y: cy },
        { x: cx, y: cy - step },
        { x: cx, y: cy + step },
        { x: cx - rw * 0.6, y: cy },
        { x: cx + rw * 0.6, y: cy },
        { x: cx, y: cy - step * 2 },
        { x: cx, y: cy + step * 2 },
      ];

      let chosen: { x: number; y: number } | null = null;
      for (const c of candidates) {
        const b: Bbox = {
          x: c.x - rw / 2 - gap,
          y: c.y - rh / 2 - gap,
          w: rw + gap * 2,
          h: rh + gap * 2,
        };
        const overlaps = placed.some(
          (p) =>
            b.x < p.x + p.w &&
            b.x + b.w > p.x &&
            b.y < p.y + p.h &&
            b.y + b.h > p.y,
        );
        if (!overlaps) {
          chosen = c;
          placed.push({ x: c.x - rw / 2, y: c.y - rh / 2, w: rw, h: rh });
          break;
        }
      }

      if (chosen) {
        results.push({
          sr,
          x: chosen.x,
          y: chosen.y,
          rw,
          rh,
          color: TUNER_COLORS[getDominantTuner(sr.tunerCounts)],
        });
      }
    }
    return results;
  }, [focusedTerritoryId, territories, scale]);

  // ============================================================
  // Macro label placement — greedy, largest territory first.
  // Primary candidates: inside territory (centroid-based).
  // Fallback: external positions with leader line.
  // Style: white bg + colored border + colored text.
  // Anchor dot always at territory centroid.
  // ============================================================
  const macroLabelPositions = useMemo(() => {
    if (!data) return [];

    const fs = 11 / scale;
    const pad = 5 / scale;
    const charW = fs * 0.58;
    const rh = fs + pad * 2;
    const gap = rh * 0.55;

    type Bbox = { x: number; y: number; w: number; h: number };
    type LPos = {
      terr: Territory;
      label: string;
      x: number;
      y: number;
      rw: number;
      anchorX: number;
      anchorY: number; // territory centroid — anchor dot position
      hasLeader: boolean; // label displaced from centroid
    };

    function bbOverlaps(a: Bbox, b: Bbox) {
      return (
        a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
      );
    }

    // Largest territories get priority placement
    const sorted = [...territories]
      .filter((t) => t.label && t.tiles.length > 0)
      .sort((a, b) => b.tiles.length - a.tiles.length);

    const placed: Bbox[] = [];
    const results: LPos[] = [];

    for (const t of sorted) {
      const fullLabel = t.label;
      const shortLabel =
        fullLabel.length > 6 ? fullLabel.slice(0, 5) + "…" : fullLabel;

      // Anchor dot is always at the territory pixel centroid
      const anchorX = t.pixelCentroidX;
      const anchorY = t.pixelCentroidY;

      const maxY = Math.max(...t.tiles.map((tile) => tile.y));
      const minY = Math.min(...t.tiles.map((tile) => tile.y));
      const step = rh + gap;

      let chosen: { x: number; y: number; label: string; rw: number } | null =
        null;

      for (const lbl of [fullLabel, shortLabel]) {
        if (chosen) break;
        const rw = lbl.length * charW + pad * 2;

        // Inside-territory candidates first, external fallback last
        const candidates = [
          // --- inside territory ---
          { x: anchorX, y: anchorY }, // centroid
          { x: anchorX, y: anchorY - step }, // up
          { x: anchorX, y: anchorY + step }, // down
          { x: anchorX - rw * 0.8, y: anchorY }, // left
          { x: anchorX + rw * 0.8, y: anchorY }, // right
          { x: anchorX - rw * 0.8, y: anchorY - step },
          { x: anchorX + rw * 0.8, y: anchorY - step },
          { x: anchorX - rw * 0.8, y: anchorY + step },
          { x: anchorX + rw * 0.8, y: anchorY + step },
          // --- external fallback (below / above territory) ---
          { x: anchorX, y: maxY + HEX_SIZE * 1.6 },
          { x: anchorX - rw * 0.8, y: maxY + HEX_SIZE * 1.6 },
          { x: anchorX + rw * 0.8, y: maxY + HEX_SIZE * 1.6 },
          { x: anchorX, y: maxY + HEX_SIZE * 1.6 + step },
          { x: anchorX, y: minY - HEX_SIZE * 1.6 },
          { x: anchorX - rw * 0.8, y: minY - HEX_SIZE * 1.6 },
          { x: anchorX + rw * 0.8, y: minY - HEX_SIZE * 1.6 },
        ];

        for (const c of candidates) {
          const bb: Bbox = {
            x: c.x - rw / 2 - gap / 2,
            y: c.y - rh / 2 - gap / 2,
            w: rw + gap,
            h: rh + gap,
          };
          if (!placed.some((p) => bbOverlaps(bb, p))) {
            chosen = { x: c.x, y: c.y, label: lbl, rw };
            placed.push(bb);
            break;
          }
        }
      }

      if (!chosen) continue; // no room — hide

      const dist = Math.sqrt(
        (chosen.x - anchorX) ** 2 + (chosen.y - anchorY) ** 2,
      );
      results.push({
        terr: t,
        label: chosen.label,
        x: chosen.x,
        y: chosen.y,
        rw: chosen.rw,
        anchorX,
        anchorY,
        hasLeader: dist > rh,
      });
    }

    return results;
  }, [data, territories, scale]);

  // Territory fills + borders: scaled hex fills, bridge quads between neighbors, boundary lines
  const territoryScaleFactors = useMemo(
    () => [1.0, 0.82, 0.64, 0.5, 0.38, 0.28],
    [],
  );
  const renderTerritoryFillsAndBorders = useMemo(() => {
    if (!data || colorMode !== "territory") return null;

    const verticesByRank = territoryScaleFactors.map((s) =>
      getHexVertices(HEX_SIZE * s),
    );
    const fillElements: React.ReactElement[] = [];
    const borderElements: React.ReactElement[] = [];

    // Sort tuners by rank (largest territory first → drawn at back)
    const sortedTuners = TUNER_NAMES.filter((t) => selectedTuners.has(t)).sort(
      (a, b) =>
        (tunerTerritoryRank.get(a) ?? 0) - (tunerTerritoryRank.get(b) ?? 0),
    );

    for (const tuner of sortedTuners) {
      const rank = tunerTerritoryRank.get(tuner) ?? 0;
      const sv = verticesByRank[rank];

      for (const tile of data.hexTiles) {
        if (!tile.cluster || tile.cluster.tunerCounts[tuner] <= 0) continue;

        // Scaled hex fill
        const hexD =
          "M" +
          sv.map((v) => `${tile.x + v.x},${tile.y + v.y}`).join("L") +
          "Z";
        fillElements.push(
          <path
            key={`fill-${tuner}-${tile.q},${tile.r}`}
            d={hexD}
            fill={TUNER_COLORS[tuner]}
            opacity={0.45}
            pointerEvents="none"
          />,
        );

        // Check 6 edges for bridges and borders
        for (let edgeIdx = 0; edgeIdx < 6; edgeIdx++) {
          const dir = HEX_DIRECTIONS[edgeIdx];
          const neighborKey = `${tile.q + dir.dq},${tile.r + dir.dr}`;
          const neighbor = hexLookup.get(neighborKey);
          const neighborHasTuner =
            neighbor?.cluster && neighbor.cluster.tunerCounts[tuner] > 0;

          if (neighborHasTuner) {
            // Bridge quad: connect this tile's scaled edge to neighbor's corresponding scaled edge
            // Only draw once per pair (edgeIdx < 3)
            if (edgeIdx < 3) {
              const vi = sv[edgeIdx];
              const vi1 = sv[(edgeIdx + 1) % 6];
              const bvi3 = sv[(edgeIdx + 3) % 6];
              const bvi4 = sv[(edgeIdx + 4) % 6];

              const quadD =
                `M${tile.x + vi.x},${tile.y + vi.y}` +
                `L${tile.x + vi1.x},${tile.y + vi1.y}` +
                `L${neighbor!.x + bvi3.x},${neighbor!.y + bvi3.y}` +
                `L${neighbor!.x + bvi4.x},${neighbor!.y + bvi4.y}Z`;

              fillElements.push(
                <path
                  key={`bridge-${tuner}-${tile.q},${tile.r}-${edgeIdx}`}
                  d={quadD}
                  fill={TUNER_COLORS[tuner]}
                  opacity={0.45}
                  pointerEvents="none"
                />,
              );
            }
          } else {
            // Border line: this tuner's territory ends here
            const v1 = sv[edgeIdx];
            const v2 = sv[(edgeIdx + 1) % 6];
            borderElements.push(
              <line
                key={`border-${tuner}-${tile.q},${tile.r}-${edgeIdx}`}
                x1={tile.x + v1.x}
                y1={tile.y + v1.y}
                x2={tile.x + v2.x}
                y2={tile.y + v2.y}
                stroke={TUNER_COLORS[tuner]}
                strokeWidth={2.5}
                strokeLinecap="round"
                pointerEvents="none"
              />,
            );
          }
        }
      }
    }

    return (
      <g>
        {fillElements}
        {borderElements}
      </g>
    );
  }, [
    data,
    colorMode,
    hexLookup,
    selectedTuners,
    tunerTerritoryRank,
    territoryScaleFactors,
    HEX_DIRECTIONS,
    getHexVertices,
  ]);

  // Mouse handlers
  const handleMouseEnter = useCallback((tile: HexTile, e: React.MouseEvent) => {
    if (!tile.cluster) return;
    setHoveredClusterId(tile.cluster.id);
    setTooltip({ cluster: tile.cluster, x: e.clientX, y: e.clientY });
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (tooltip)
        setTooltip((prev) =>
          prev ? { ...prev, x: e.clientX, y: e.clientY } : null,
        );
    },
    [tooltip],
  );

  const handleMouseLeave = useCallback(() => {
    setHoveredClusterId(null);
    setTooltip(null);
  }, []);

  const handleClick = useCallback(
    (tile: HexTile) => {
      if (!tile.cluster) return;
      const terrId = clusterToTerrId.get(tile.cluster.id) ?? null;
      const srId = clusterToSubRegionId.get(tile.cluster.id) ?? null;

      setFocusedTerritoryId((prev) => {
        if (prev === terrId) {
          // 2nd level: focus sub-region + set cluster for inspect panel
          setFocusedSubRegionId((prevSr) => (prevSr === srId ? null : srId));
          setInspectedClusterId((prev) =>
            prev === tile.cluster!.id ? null : tile.cluster!.id,
          );
          return prev;
        }
        // 1st level: focus territory, clear deeper state
        setFocusedSubRegionId(null);
        setInspectedClusterId(null);
        return terrId;
      });
    },
    [clusterToTerrId, clusterToSubRegionId],
  );

  const toggleTuner = useCallback((tuner: TunerType) => {
    setSelectedTuners((prev) => {
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
    if (!data)
      return {
        totalTrials: 0,
        totalClusters: 0,
        tunerTotals: {} as Record<TunerType, number>,
      };

    const tunerTotals: Record<TunerType, number> = {
      SymTuner: 0,
      CMA_ES: 0,
      Genetic: 0,
      SuccessiveHalving: 0,
      TPE: 0,
      BayesianOptimization: 0,
    };

    let totalTrials = 0;
    for (const c of data.clusters) {
      totalTrials += c.totalTrials;
      for (const t of TUNER_NAMES) {
        tunerTotals[t] += c.tunerCounts[t];
      }
    }

    return { totalTrials, totalClusters: data.clusters.length, tunerTotals };
  }, [data]);

  // Loading
  if (loading) {
    return (
      <div
        style={{
          width,
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div className="loading loading-spinner loading-lg text-primary"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          width,
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#EF4444",
        }}
      >
        Error: {error}
      </div>
    );
  }

  if (!data) return null;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* Title */}
      <div
        style={{
          marginBottom: 12,
          display: "flex",
          alignItems: "center",
          gap: 16,
          width: "100%",
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          Parameter Space Map
        </h3>
        <span style={{ fontSize: 12, color: "#6B7280" }}>
          {stats.totalTrials.toLocaleString()} trials in{" "}
          {data?.hexTiles.length || 0} clusters • {program}
        </span>
      </div>

      <div
        style={{
          position: "relative",
          display: "flex",
          justifyContent: "space-between",
          width: "100%",
          height: "calc(100% - 60px)",
          overflow: "hidden",
        }}
      >
        {/* SVG Map — always full width minus controls */}
        <svg
          ref={svgRef}
          width={width - 200}
          height={height}
          style={{ flexShrink: 0 }}
        >
          {layoutMode === "hex" && (
            /* ===== HEX GRID MODE ===== */
            <g
              transform={`translate(${centerX}, ${centerY}) scale(${scale}) translate(${-dataCenter.x}, ${-dataCenter.y})`}
            >
              {/* Transparent background — click clears focus */}
              <rect
                x={-50000}
                y={-50000}
                width={100000}
                height={100000}
                fill="transparent"
                onClick={() => {
                  setFocusedTerritoryId(null);
                  setFocusedSubRegionId(null);
                  setInspectedClusterId(null);
                }}
                style={{ cursor: "default" }}
              />

              {/* ── Coarse level: one hex per super-cluster ──────────────── */}
              {detailLevel < 4 && coarseHexLayout.map(({ coarseId, x, y, hexSize }) => {
                const cPath = getHexPath(hexSize);
                const visual = coarseHexVisuals.get(coarseId);
                return (
                  <g key={`coarse-${coarseId}`} transform={`translate(${x}, ${y})`}>
                    <path
                      d={cPath}
                      fill={visual?.fill ?? "#CBD5E1"}
                      stroke={visual?.stroke ?? "white"}
                      strokeWidth={3}
                      strokeLinejoin="round"
                    />
                  </g>
                );
              })}

              {/* ── Coarse borders (L0–L3): sub-region style between hexes ──── */}
              {detailLevel < 4 && coarseTerritoryData && (() => {
                const { subBorderD, terrBorderD } = coarseTerritoryData;
                return <>
                  {subBorderD && <>
                    <path d={subBorderD} fill="none" stroke="white"
                      strokeWidth={3} strokeLinecap="round" opacity={0.55} pointerEvents="none" />
                    <path d={subBorderD} fill="none" stroke="#64748B"
                      strokeWidth={1.5} strokeDasharray={`${5},${4}`}
                      strokeLinecap="round" opacity={0.7} pointerEvents="none" />
                  </>}
                  {terrBorderD && <>
                    <path d={terrBorderD} fill="none" stroke="white"
                      strokeWidth={7} strokeLinecap="round" strokeLinejoin="round"
                      opacity={0.8} pointerEvents="none" />
                    <path d={terrBorderD} fill="none" stroke="#475569"
                      strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round"
                      pointerEvents="none" />
                  </>}
                </>;
              })()}

              {/* ── Coarse macro labels (L0–L3): one label per dominant territory ── */}
              {detailLevel < 4 && focusedTerritoryId === null &&
                coarseMacroLabelPositions.map(
                  ({ tuner, x, y, rw, rh, color, label }) => (
                    <g key={`cmacro-${tuner}-${label}-${Math.round(x)}-${Math.round(y)}`} pointerEvents="none">
                      <rect
                        x={x - rw / 2}
                        y={y - rh / 2}
                        width={rw}
                        height={rh}
                        rx={rh / 2}
                        fill="white"
                        opacity={0.96}
                      />
                      <rect
                        x={x - rw / 2}
                        y={y - rh / 2}
                        width={rw}
                        height={rh}
                        rx={rh / 2}
                        fill="none"
                        stroke={color}
                        strokeWidth={1.75 / scale}
                      />
                      <text
                        x={x}
                        y={y}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={11 / scale}
                        fontWeight={700}
                        fill={color}
                      >
                        {label}
                      </text>
                    </g>
                  ),
                )}

              {/* ── Hex tiles (level 4 only): no hover-sensitive props so hover doesn't re-render all tiles ── */}
              {detailLevel === 4 && data.hexTiles.map((tile) => {
                if (!tile.cluster) return null;

                const hasSelectedTuner = TUNER_NAMES.some(
                  (t) =>
                    selectedTuners.has(t) && tile.cluster!.tunerCounts[t] > 0,
                );
                if (!hasSelectedTuner) return null;

                const fill = getHexFill(tile);
                const isInspected =
                  inspectedClusterId === tile.cluster.id &&
                  focusedTerritoryId !== null;
                const isMuted =
                  focusedTerritoryId !== null &&
                  clusterToTerrId.get(tile.cluster.id) !== focusedTerritoryId;
                const activeSubRegionId =
                  hoveredSubRegionId ?? focusedSubRegionId;
                const isSubMuted =
                  !isMuted &&
                  activeSubRegionId !== null &&
                  clusterToSubRegionId.get(tile.cluster.id) !==
                    activeSubRegionId;
                const tileOpacity = isMuted ? 0.12 : isSubMuted ? 0.22 : 1;

                return (
                  <g
                    key={`${tile.q},${tile.r}`}
                    transform={`translate(${tile.x}, ${tile.y})`}
                    onMouseEnter={(e) => handleMouseEnter(tile, e)}
                    onMouseMove={handleMouseMove}
                    onMouseLeave={handleMouseLeave}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleClick(tile);
                    }}
                    style={{ cursor: "pointer" }}
                    opacity={tileOpacity}
                  >
                    <path
                      d={hexPath}
                      fill={fill || "#F8FAFC"}
                      stroke={
                        isInspected
                          ? "#4F46E5"
                          : (clusterToSubRegionVisual.get(tile.cluster.id)
                              ?.stroke ?? "#E2E8F0")
                      }
                      strokeWidth={isInspected ? 3 : 0.5}
                    />
                  </g>
                );
              })}

              {/* ── Hover + inspect highlight: separate overlay so hover doesn't re-render tiles ── */}
              {hoveredClusterId !== null && (() => {
                const tile = data.hexTiles.find(
                  (t) => t.cluster?.id === hoveredClusterId,
                );
                if (!tile) return null;
                return (
                  <g
                    transform={`translate(${tile.x}, ${tile.y})`}
                    pointerEvents="none"
                  >
                    <path
                      d={hexPath}
                      fill="none"
                      stroke="#1E293B"
                      strokeWidth={2.5}
                    />
                  </g>
                );
              })()}

              {detailLevel === 4 && renderTerritoryFillsAndBorders}

              {/* ── Macro boundaries: white halo pass (drawn first, behind) ── */}
              {detailLevel === 4 && boundaryData.macro.map(({ d, terr }) => {
                if (!d) return null;
                const isFocused = terr.id === focusedTerritoryId;
                const isMuted = focusedTerritoryId !== null && !isFocused;
                if (isMuted) return null; // hide non-focused halos in focus mode
                return (
                  <path
                    key={`macro-halo-${terr.id}`}
                    d={d}
                    fill="none"
                    stroke="white"
                    strokeWidth={isFocused ? 9 : 7}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={0.8}
                    pointerEvents="none"
                  />
                );
              })}

              {/* ── Macro boundaries: colored line pass ─────────────────── */}
              {detailLevel === 4 && boundaryData.macro.map(({ d, terr }) => {
                if (!d) return null;
                const isFocused = terr.id === focusedTerritoryId;
                const isMuted = focusedTerritoryId !== null && !isFocused;
                return (
                  <path
                    key={`macro-line-${terr.id}`}
                    d={d}
                    fill="none"
                    stroke={TUNER_COLORS[getDominantTuner(terr.tunerCounts)]}
                    strokeWidth={isFocused ? 5 : 3.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={isMuted ? 0.12 : 1}
                    pointerEvents="none"
                  />
                );
              })}

              {/* ── Sub-region boundaries: neutral, focus mode only ──────── */}
              {detailLevel === 4 && focusedTerritoryId !== null && (
                <>
                  {/* white halo (thin) */}
                  {boundaryData.sub
                    .filter(({ terr }) => terr.id === focusedTerritoryId)
                    .map(({ d, sr, terr }) =>
                      d ? (
                        <path
                          key={`sub-halo-${terr.id}-${sr.id}`}
                          d={d}
                          fill="none"
                          stroke="white"
                          strokeWidth={3}
                          strokeLinecap="round"
                          opacity={0.55}
                          pointerEvents="none"
                        />
                      ) : null,
                    )}
                  {/* slate dashed line — neutral, reads as "internal division" not a new territory */}
                  {boundaryData.sub
                    .filter(({ terr }) => terr.id === focusedTerritoryId)
                    .map(({ d, sr, terr }) =>
                      d ? (
                        <path
                          key={`sub-line-${terr.id}-${sr.id}`}
                          d={d}
                          fill="none"
                          stroke="#64748B"
                          strokeWidth={1.5}
                          strokeDasharray={`${5},${4}`}
                          strokeLinecap="round"
                          opacity={0.7}
                          pointerEvents="none"
                        />
                      ) : null,
                    )}
                </>
              )}

              {/* ── Sub-region labels: white bg + colored border + colored text ── */}
              {detailLevel === 4 && subLabelPositions.map(({ sr, x, y, rw, rh: lh, color }) => {
                const isLabelHovered = hoveredSubRegionId === sr.id;
                return (
                  <g
                    key={`sr-label-${sr.territoryId}-${sr.id}`}
                    style={{ cursor: "pointer" }}
                    opacity={
                      hoveredSubRegionId !== null && !isLabelHovered ? 0.25 : 1
                    }
                    onMouseEnter={() => setHoveredSubRegionId(sr.id)}
                    onMouseLeave={() => setHoveredSubRegionId(null)}
                    onClick={(e) => {
                      e.stopPropagation();
                      setFocusedSubRegionId((prev) =>
                        prev === sr.id ? null : sr.id,
                      );
                    }}
                  >
                    {/* white fill */}
                    <rect
                      x={x - rw / 2}
                      y={y - lh / 2}
                      width={rw}
                      height={lh}
                      rx={lh / 2}
                      fill="white"
                      opacity={0.96}
                    />
                    {/* colored border */}
                    <rect
                      x={x - rw / 2}
                      y={y - lh / 2}
                      width={rw}
                      height={lh}
                      rx={lh / 2}
                      fill="none"
                      stroke={color}
                      strokeWidth={1.5 / scale}
                      opacity={1}
                    />
                    <text
                      x={x}
                      y={y}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fontSize={10 / scale}
                      fontWeight={700}
                      fill={color}
                    >
                      {sr.label}
                    </text>
                  </g>
                );
              })}

              {/* ── Macro territory labels: overview only ── */}
              {detailLevel === 4 && focusedTerritoryId === null &&
                macroLabelPositions.map(
                  ({
                    terr: t,
                    label,
                    x: px,
                    y: py,
                    rw,
                    anchorX,
                    anchorY,
                    hasLeader,
                  }) => {
                    const color = TUNER_COLORS[getDominantTuner(t.tunerCounts)];
                    const fs = 11 / scale;
                    const pad = 5 / scale;
                    const rh = fs + pad * 2;
                    const bw = 2 / scale; // border width
                    return (
                      <g key={`macro-label-${t.id}`} pointerEvents="none">
                        {/* Anchor dot: always at territory centroid */}
                        <circle
                          cx={anchorX}
                          cy={anchorY}
                          r={3 / scale}
                          fill={color}
                          opacity={0.85}
                        />
                        {/* Leader line: only when label is displaced from centroid */}
                        {hasLeader && (
                          <line
                            x1={anchorX}
                            y1={anchorY}
                            x2={px}
                            y2={py}
                            stroke={color}
                            strokeWidth={1 / scale}
                            strokeDasharray={`${4 / scale},${3 / scale}`}
                            opacity={0.5}
                          />
                        )}
                        {/* White shadow for readability */}
                        <rect
                          x={px - rw / 2 - bw - 1 / scale}
                          y={py - rh / 2 - bw - 1 / scale}
                          width={rw + bw * 2 + 2 / scale}
                          height={rh + bw * 2 + 2 / scale}
                          rx={rh / 2 + bw + 1 / scale}
                          fill="white"
                          opacity={0.9}
                        />
                        {/* White bg pill */}
                        <rect
                          x={px - rw / 2}
                          y={py - rh / 2}
                          width={rw}
                          height={rh}
                          rx={rh / 2}
                          fill="white"
                        />
                        {/* Colored border — connects label to territory */}
                        <rect
                          x={px - rw / 2}
                          y={py - rh / 2}
                          width={rw}
                          height={rh}
                          rx={rh / 2}
                          fill="none"
                          stroke={color}
                          strokeWidth={bw}
                          opacity={0.95}
                        />
                        <text
                          x={px}
                          y={py}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fontSize={fs}
                          fontWeight={700}
                          fill={color}
                        >
                          {label}
                        </text>
                      </g>
                    );
                  },
                )}
            </g>
          )}

          {layoutMode === "map" && voronoiMapData && (
            /* ===== POLYGON MAP MODE (Standard Voronoi) ===== */
            <g>
              {/* clipPath definitions: each cluster clips to union of its sub-cells */}
              <defs>
                {voronoiMapData.cells.map((cell) => (
                  <clipPath
                    key={`clip-${cell.cluster.id}`}
                    id={`voronoi-clip-${cell.cluster.id}`}
                  >
                    {cell.subCellPaths.map((d, i) => (
                      <path key={i} d={d} />
                    ))}
                  </clipPath>
                ))}
              </defs>

              {/* Per-cluster rendering */}
              {voronoiMapData.cells.map((cell) => {
                const syntheticTile = voronoiTileMap.get(cell.cluster.id);
                if (!syntheticTile) return null;

                const fill = getHexFill(syntheticTile);
                const isHovered = hoveredClusterId === cell.cluster.id;
                const isInspected =
                  inspectedClusterId === cell.cluster.id &&
                  focusedTerritoryId !== null;

                // Bounding box of the cluster region
                const xs = cell.polygon.map(([x]) => x);
                const ys = cell.polygon.map(([, y]) => y);
                const bw = Math.max(...xs) - Math.min(...xs);
                const bh = Math.max(...ys) - Math.min(...ys);

                return (
                  <g
                    key={`voronoi-${cell.cluster.id}`}
                    onMouseEnter={(e) => {
                      if (syntheticTile) handleMouseEnter(syntheticTile, e);
                    }}
                    onMouseMove={handleMouseMove}
                    onMouseLeave={handleMouseLeave}
                    onClick={() => {
                      if (syntheticTile) handleClick(syntheticTile);
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    {/* Cell fill */}
                    {cell.subCellPaths.map((d, i) => (
                      <path
                        key={`sub-${i}`}
                        d={d}
                        fill={fill || "#F8FAFC"}
                        stroke="none"
                      />
                    ))}

                    {/* Territory fill: layered sizes by territory rank */}
                    {colorMode === "territory" &&
                      (() => {
                        const tc = cell.cluster.tunerCounts;
                        const present = TUNER_NAMES.filter(
                          (t) => selectedTuners.has(t) && tc[t] > 0,
                        ).sort(
                          (a, b) =>
                            (tunerTerritoryRank.get(a) ?? 0) -
                            (tunerTerritoryRank.get(b) ?? 0),
                        );
                        if (present.length === 0) return null;
                        const scaleFactors = [1.0, 0.82, 0.64, 0.5];
                        return present.map((tuner) => {
                          const rank = tunerTerritoryRank.get(tuner) ?? 0;
                          const s = scaleFactors[rank];
                          return (
                            <path
                              key={`terr-fill-${tuner}`}
                              d={cell.pathD}
                              fill={TUNER_COLORS[tuner]}
                              opacity={0.45}
                              pointerEvents="none"
                              transform={`translate(${cell.cx * (1 - s)}, ${cell.cy * (1 - s)}) scale(${s})`}
                            />
                          );
                        });
                      })()}

                    {/* Hover/select highlight — fill only, no stroke (compound path would reveal sub-cells) */}
                    {isHovered && !isInspected && (
                      <g
                        clipPath={`url(#voronoi-clip-${cell.cluster.id})`}
                        pointerEvents="none"
                      >
                        <rect
                          x={Math.min(...xs)}
                          y={Math.min(...ys)}
                          width={bw}
                          height={bh}
                          fill="rgba(0,0,0,0.06)"
                        />
                      </g>
                    )}
                    {isInspected && (
                      <g
                        clipPath={`url(#voronoi-clip-${cell.cluster.id})`}
                        pointerEvents="none"
                      >
                        <rect
                          x={Math.min(...xs)}
                          y={Math.min(...ys)}
                          width={bw}
                          height={bh}
                          fill="rgba(79,70,229,0.1)"
                        />
                      </g>
                    )}
                  </g>
                );
              })}

              {/* Cluster borders (thin, organic edges between different clusters) */}
              {voronoiMapData.clusterBorderPaths.map((d, idx) => (
                <path
                  key={`cluster-border-${idx}`}
                  d={d}
                  fill="none"
                  stroke="#CBD5E1"
                  strokeWidth={0.8}
                  strokeLinecap="round"
                  pointerEvents="none"
                />
              ))}

              {/* Territory borders (thick, on top) — hidden in territory color mode */}
              {colorMode !== "territory" &&
                voronoiMapData.territoryBorderPaths.map((d, idx) => (
                  <path
                    key={`terr-border-${idx}`}
                    d={d}
                    fill="none"
                    stroke="#475569"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    pointerEvents="none"
                  />
                ))}

              {/* Tuner territory borders (per-tuner colored edges) */}
              {colorMode === "territory" && mapTerritoryBorders}
            </g>
          )}
        </svg>
        {/* Focus panel — centered absolute overlay on the map */}
        {focusedTerritoryId !== null && (
          <div
            style={{
              position: "absolute",
              top: 12,
              left: "60%",
              transform: "translateX(-50%)",
              width: 260,
              maxHeight: height - 84,
              overflowY: "auto",
              background: "white",
              borderRadius: 10,
              boxShadow: "0 4px 24px rgba(0,0,0,0.13)",
              border: "1px solid #E5E7EB",
              padding: "12px 14px",
              fontSize: 12,
              zIndex: 10,
            }}
          >
            {focusedTerritoryMetrics &&
              (() => {
                const { terr, terrAvgCov, terrMaxCov, subMetrics } =
                  focusedTerritoryMetrics;
                const terrColor =
                  TUNER_COLORS[getDominantTuner(terr.tunerCounts)];
                return (
                  <>
                    {/* Territory header */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: 10,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <div
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: terrColor,
                            flexShrink: 0,
                          }}
                        />
                        <span
                          style={{
                            fontWeight: 700,
                            fontSize: 13,
                            color: "#1E293B",
                          }}
                        >
                          {terr.label || `Territory ${terr.id}`}
                        </span>
                      </div>
                      <button
                        onClick={() => {
                          setFocusedTerritoryId(null);
                          setFocusedSubRegionId(null);
                          setInspectedClusterId(null);
                        }}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          fontSize: 14,
                          color: "#94A3B8",
                          padding: 0,
                        }}
                      >
                        ×
                      </button>
                    </div>

                    {/* Territory stats */}
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr 1fr",
                        gap: 4,
                        marginBottom: 14,
                      }}
                    >
                      {[
                        {
                          label: "Trials",
                          value: terr.totalTrials.toLocaleString(),
                        },
                        { label: "Avg Cov", value: terrAvgCov.toFixed(1) },
                        { label: "Max Cov", value: terrMaxCov.toFixed(1) },
                      ].map(({ label, value }) => (
                        <div
                          key={label}
                          style={{
                            background: "#F8FAFC",
                            borderRadius: 4,
                            padding: "5px 4px",
                            textAlign: "center",
                          }}
                        >
                          <div
                            style={{
                              fontSize: 9,
                              color: "#94A3B8",
                              marginBottom: 1,
                            }}
                          >
                            {label}
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 600,
                              color: "#1E293B",
                            }}
                          >
                            {value}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Sub-region list */}
                    {subMetrics.length > 0 && (
                      <>
                        <div
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: "#374151",
                            marginBottom: 6,
                          }}
                        >
                          Sub-regions ({subMetrics.length})
                        </div>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                          }}
                        >
                          {subMetrics.map(
                            ({ sr, avgCov, maxCov, dominant, dominantPct }) => {
                              const srColor = TUNER_COLORS[dominant];
                              const isActive =
                                focusedSubRegionId === sr.id ||
                                hoveredSubRegionId === sr.id;
                              return (
                                <div
                                  key={sr.id}
                                  onClick={() =>
                                    setFocusedSubRegionId((prev) =>
                                      prev === sr.id ? null : sr.id,
                                    )
                                  }
                                  onMouseEnter={() =>
                                    setHoveredSubRegionId(sr.id)
                                  }
                                  onMouseLeave={() =>
                                    setHoveredSubRegionId(null)
                                  }
                                  style={{
                                    padding: "7px 8px",
                                    borderRadius: 6,
                                    cursor: "pointer",
                                    border: `1px solid ${isActive ? srColor : "#E5E7EB"}`,
                                    background: isActive ? "#F8FAFC" : "white",
                                  }}
                                >
                                  <div
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "space-between",
                                      marginBottom: 4,
                                    }}
                                  >
                                    <div
                                      style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 4,
                                      }}
                                    >
                                      <div
                                        style={{
                                          width: 6,
                                          height: 6,
                                          borderRadius: "50%",
                                          background: srColor,
                                          flexShrink: 0,
                                        }}
                                      />
                                      <span
                                        style={{
                                          fontWeight: 600,
                                          fontSize: 10,
                                          color: "#1E293B",
                                        }}
                                      >
                                        {sr.label || `Sub ${sr.id}`}
                                      </span>
                                      {(() => {
                                        // dominant qualitative class among clusters in this sub-region
                                        const counts = new Map<
                                          QualitativeLabel,
                                          number
                                        >();
                                        for (const c of sr.clusters) {
                                          const qr = clusterToQualRegion.get(
                                            c.id,
                                          );
                                          if (!qr) continue;
                                          counts.set(
                                            qr.label,
                                            (counts.get(qr.label) ?? 0) + 1,
                                          );
                                        }
                                        if (counts.size === 0) return null;
                                        const dominant = [
                                          ...counts.entries(),
                                        ].sort((a, b) => b[1] - a[1])[0][0];
                                        return (
                                          <span
                                            style={{
                                              display: "inline-block",
                                              padding: "0px 4px",
                                              borderRadius: 3,
                                              fontSize: 8,
                                              fontWeight: 600,
                                              background:
                                                QUAL_LABEL_COLORS[dominant] +
                                                "22",
                                              color:
                                                QUAL_LABEL_COLORS[dominant],
                                              marginLeft: 4,
                                            }}
                                          >
                                            {dominant}
                                          </span>
                                        );
                                      })()}
                                    </div>
                                    <span
                                      style={{ fontSize: 9, color: "#94A3B8" }}
                                    >
                                      {sr.totalTrials.toLocaleString()}
                                    </span>
                                  </div>
                                  <div
                                    style={{
                                      display: "flex",
                                      gap: 6,
                                      fontSize: 9,
                                      color: "#6B7280",
                                    }}
                                  >
                                    <span>
                                      avg{" "}
                                      <b style={{ color: "#10B981" }}>
                                        {avgCov.toFixed(1)}
                                      </b>
                                    </span>
                                    <span>
                                      max{" "}
                                      <b style={{ color: "#0EA5E9" }}>
                                        {maxCov.toFixed(1)}
                                      </b>
                                    </span>
                                  </div>
                                  <div style={{ marginTop: 5 }}>
                                    <div
                                      style={{
                                        display: "flex",
                                        justifyContent: "space-between",
                                        fontSize: 9,
                                        marginBottom: 2,
                                      }}
                                    >
                                      <span style={{ color: srColor }}>
                                        {TUNER_DISPLAY_NAMES[dominant]}
                                      </span>
                                      <span style={{ color: "#94A3B8" }}>
                                        {dominantPct}%
                                      </span>
                                    </div>
                                    <div
                                      style={{
                                        height: 3,
                                        background: "#E5E7EB",
                                        borderRadius: 2,
                                      }}
                                    >
                                      <div
                                        style={{
                                          height: "100%",
                                          width: `${dominantPct}%`,
                                          background: srColor,
                                          borderRadius: 2,
                                        }}
                                      />
                                    </div>
                                  </div>
                                </div>
                              );
                            },
                          )}
                        </div>
                      </>
                    )}

                    {/* Cluster detail (when inspected) */}
                    {inspectedCluster && (
                      <div
                        style={{
                          marginTop: 14,
                          paddingTop: 14,
                          borderTop: "1px solid #E5E7EB",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: 10,
                          }}
                        >
                          <span
                            style={{
                              fontWeight: 600,
                              fontSize: 11,
                              color: "#1E293B",
                            }}
                          >
                            Cluster #{inspectedCluster.id + 1}
                          </span>
                          <button
                            onClick={() => setInspectedClusterId(null)}
                            style={{
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              fontSize: 14,
                              color: "#94A3B8",
                              padding: 0,
                            }}
                          >
                            ×
                          </button>
                        </div>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "1fr 1fr",
                            gap: 4,
                            marginBottom: 10,
                          }}
                        >
                          <div
                            style={{
                              background: "#F8FAFC",
                              padding: 6,
                              borderRadius: 4,
                            }}
                          >
                            <div style={{ fontSize: 9, color: "#94A3B8" }}>
                              Trials
                            </div>
                            <div style={{ fontSize: 13, fontWeight: 600 }}>
                              {inspectedCluster.totalTrials}
                            </div>
                          </div>
                          <div
                            style={{
                              background: "#F8FAFC",
                              padding: 6,
                              borderRadius: 4,
                            }}
                          >
                            <div style={{ fontSize: 9, color: "#94A3B8" }}>
                              Avg Cov
                            </div>
                            <div
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: "#10B981",
                              }}
                            >
                              {inspectedCluster.avgCoverage.toFixed(1)}
                            </div>
                          </div>
                        </div>
                        {TUNER_NAMES.map((tuner) => {
                          const count = inspectedCluster.tunerCounts[tuner];
                          const ratio = count / inspectedCluster.totalTrials;
                          return (
                            <div key={tuner} style={{ marginBottom: 4 }}>
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  fontSize: 9,
                                  marginBottom: 2,
                                }}
                              >
                                <span style={{ color: "#374151" }}>
                                  {TUNER_DISPLAY_NAMES[tuner]}
                                </span>
                                <span style={{ color: "#6B7280" }}>
                                  {count} ({(ratio * 100).toFixed(0)}%)
                                </span>
                              </div>
                              <div
                                style={{
                                  height: 4,
                                  background: "#E5E7EB",
                                  borderRadius: 2,
                                }}
                              >
                                <div
                                  style={{
                                    height: "100%",
                                    width: `${ratio * 100}%`,
                                    background: TUNER_COLORS[tuner],
                                    borderRadius: 2,
                                  }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                );
              })()}
          </div>
        )}
        {/* Controls panel — always 200px on the right */}
        <div
          style={{
            width: 200,
            fontSize: 12,
            height: height - 60,
            overflowY: "auto",
            flexShrink: 0,
            borderLeft: "1px solid #E5E7EB",
            paddingLeft: 12,
          }}
        >
          {/* Layout toggle */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 600, marginBottom: 6, color: "#374151" }}>
              Layout
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {[
                { key: "hex" as LayoutMode, label: "Hex" },
                { key: "map" as LayoutMode, label: "Cluster" },
              ].map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setLayoutMode(key)}
                  style={{
                    flex: 1,
                    padding: "6px 4px",
                    fontSize: 10,
                    fontWeight: 500,
                    border: "1px solid",
                    borderColor: layoutMode === key ? "#4F46E5" : "#E5E7EB",
                    borderRadius: 4,
                    background: layoutMode === key ? "#EEF2FF" : "white",
                    color: layoutMode === key ? "#4F46E5" : "#6B7280",
                    cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Detail Level */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 600, marginBottom: 6, color: "#374151" }}>
              Detail Level
            </div>
            <div style={{ display: "flex", gap: 3 }}>
              {([0, 1, 2, 3, 4] as const).map((lv) => {
                const coarseIdx = 3 - lv; // lv3→idx0, lv0→idx3
                const count =
                  lv === 4
                    ? data.clusters.length
                    : (coarseLevels[coarseIdx]?.k ?? "…");
                return (
                  <button
                    key={lv}
                    onClick={() => setDetailLevel(lv)}
                    title={`Level ${lv}: ${count} clusters`}
                    style={{
                      flex: 1,
                      padding: "5px 2px",
                      fontSize: 10,
                      fontWeight: 600,
                      border: "1px solid",
                      borderColor: detailLevel === lv ? "#4F46E5" : "#E5E7EB",
                      borderRadius: 4,
                      background: detailLevel === lv ? "#EEF2FF" : "white",
                      color: detailLevel === lv ? "#4F46E5" : "#6B7280",
                      cursor: "pointer",
                      lineHeight: 1.2,
                      textAlign: "center",
                    }}
                  >
                    L{lv}
                    <br />
                    <span style={{ fontSize: 9, fontWeight: 400 }}>{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Cluster count slider */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, color: "#374151" }}>
              Clusters: {data.hexTiles.length}개
            </div>
            <input
              type="range"
              min={30}
              max={200}
              value={numClusters}
              onChange={(e) => setNumClusters(Number(e.target.value))}
              style={{ width: "100%", cursor: "pointer" }}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 10,
                color: "#9CA3AF",
              }}
            >
              <span>30</span>
              <span>Target: {numClusters}</span>
              <span>200</span>
            </div>
          </div>

          {/* Color mode */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, color: "#374151" }}>
              Display Mode
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {(
                [
                  { mode: "pixel", label: "Sub-region" },
                  { mode: "coverage", label: "Branch Coverage" },
                  { mode: "marginal", label: "Marginal Coverage" },
                  { mode: "territory" as ColorMode, label: "Tuner Territory" },
                  { mode: "dominant", label: "Dominant Only" },
                  { mode: "density", label: "Trial Density" },
                ] as { mode: ColorMode; label: string }[]
              ).map(({ mode, label }) => (
                <button
                  key={mode}
                  onClick={() => setColorMode(mode)}
                  style={{
                    padding: "6px 12px",
                    fontSize: 11,
                    border: "1px solid",
                    borderColor: colorMode === mode ? "#4F46E5" : "#E5E7EB",
                    borderRadius: 4,
                    background: colorMode === mode ? "#EEF2FF" : "white",
                    color: colorMode === mode ? "#4F46E5" : "#6B7280",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Tuner filter */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, color: "#374151" }}>
              Tuners
            </div>
            {TUNER_NAMES.map((tuner) => (
              <button
                key={tuner}
                onClick={() => toggleTuner(tuner)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "6px 10px",
                  marginBottom: 4,
                  fontSize: 11,
                  border: "1px solid",
                  borderColor: selectedTuners.has(tuner)
                    ? TUNER_COLORS[tuner]
                    : "#E5E7EB",
                  borderRadius: 4,
                  background: selectedTuners.has(tuner) ? "white" : "#F9FAFB",
                  cursor: "pointer",
                  opacity: selectedTuners.has(tuner) ? 1 : 0.5,
                }}
              >
                <div
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 2,
                    backgroundColor: TUNER_COLORS[tuner],
                  }}
                />
                <span style={{ flex: 1, textAlign: "left", color: "#374151" }}>
                  {TUNER_DISPLAY_NAMES[tuner]}
                </span>
                <span style={{ color: "#9CA3AF" }}>
                  {stats.tunerTotals[tuner]?.toLocaleString()}
                </span>
              </button>
            ))}
          </div>

          {/* Mode-specific legends */}
          {colorMode === "pixel" && (
            <div style={{ marginBottom: 20 }}>
              <div
                style={{ fontWeight: 600, marginBottom: 8, color: "#374151" }}
              >
                Sub-region Overview
              </div>
              <div style={{ fontSize: 10, color: "#6B7280", lineHeight: 1.6 }}>
                <p style={{ margin: 0 }}>색상 = territory 내부의 sub-region</p>
                <p style={{ margin: "4px 0 0 0" }}>
                  같은 territory는 같은 계열 색을 공유
                </p>
                <p style={{ margin: "4px 0 0 0" }}>
                  더 진한 경계색으로 sub-region 분할을 읽기 쉽게 표시
                </p>
              </div>
            </div>
          )}

          {colorMode === "coverage" && data && (
            <div style={{ marginBottom: 20 }}>
              <div
                style={{ fontWeight: 600, marginBottom: 8, color: "#374151" }}
              >
                Branch Coverage
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: "#6B7280",
                  lineHeight: 1.6,
                  marginBottom: 8,
                }}
              >
                <p style={{ margin: 0 }}>
                  색상 = 클러스터의 평균 branch coverage
                </p>
                <p style={{ margin: "4px 0 0 0" }}>
                  0은 빨강, 양수 값은 분위수 기준으로 흰색에서 초록색으로 확장
                </p>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                }}
              >
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 4 }}
                >
                  <div
                    style={{
                      width: 18,
                      height: 14,
                      borderRadius: 2,
                      background: "#DC2626",
                      border: "1px solid #E5E7EB",
                    }}
                  />
                  <div
                    style={{
                      fontSize: 9,
                      color: "#9CA3AF",
                      textAlign: "center",
                    }}
                  >
                    0
                  </div>
                </div>
                <svg width={150} height={24}>
                  <defs>
                    <linearGradient
                      id="coverage-gradient"
                      x1="0"
                      x2="1"
                      y1="0"
                      y2="0"
                    >
                      <stop offset="0%" stopColor="#FFFFFF" />
                      <stop offset="100%" stopColor="#16A34A" />
                    </linearGradient>
                  </defs>
                  <rect
                    width={150}
                    height={14}
                    rx={2}
                    fill="url(#coverage-gradient)"
                    stroke="#E5E7EB"
                  />
                  <text x={0} y={24} fontSize={9} fill="#9CA3AF">
                    &gt;0
                  </text>
                  <text
                    x={150}
                    y={24}
                    fontSize={9}
                    fill="#9CA3AF"
                    textAnchor="end"
                  >
                    {maxBranchCoverage.toFixed(2)}
                  </text>
                </svg>
              </div>
            </div>
          )}

          {colorMode === "marginal" && data && (
            <div style={{ marginBottom: 20 }}>
              <div
                style={{ fontWeight: 600, marginBottom: 8, color: "#374151" }}
              >
                Marginal Coverage
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: "#6B7280",
                  lineHeight: 1.6,
                  marginBottom: 8,
                }}
              >
                <p style={{ margin: 0 }}>
                  색상 = 클러스터의 평균 marginal coverage
                </p>
                <p style={{ margin: "4px 0 0 0" }}>
                  0은 빨강, 양수 값은 분위수 기준으로 흰색에서 초록색으로 확장
                </p>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                }}
              >
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 4 }}
                >
                  <div
                    style={{
                      width: 18,
                      height: 14,
                      borderRadius: 2,
                      background: "#DC2626",
                      border: "1px solid #E5E7EB",
                    }}
                  />
                  <div
                    style={{
                      fontSize: 9,
                      color: "#9CA3AF",
                      textAlign: "center",
                    }}
                  >
                    0
                  </div>
                </div>
                <svg width={150} height={24}>
                  <defs>
                    <linearGradient
                      id="marginal-coverage-gradient"
                      x1="0"
                      x2="1"
                      y1="0"
                      y2="0"
                    >
                      <stop offset="0%" stopColor="#FFFFFF" />
                      <stop offset="100%" stopColor="#16A34A" />
                    </linearGradient>
                  </defs>
                  <rect
                    width={150}
                    height={14}
                    rx={2}
                    fill="url(#marginal-coverage-gradient)"
                    stroke="#E5E7EB"
                  />
                  <text x={0} y={24} fontSize={9} fill="#9CA3AF">
                    &gt;0
                  </text>
                  <text
                    x={150}
                    y={24}
                    fontSize={9}
                    fill="#9CA3AF"
                    textAnchor="end"
                  >
                    {maxMarginalCoverage.toFixed(1)}
                  </text>
                </svg>
              </div>
            </div>
          )}

          {colorMode === "density" && densityScale && data && (
            <div style={{ marginBottom: 20 }}>
              <div
                style={{ fontWeight: 600, marginBottom: 8, color: "#374151" }}
              >
                Trial Density
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: "#6B7280",
                  lineHeight: 1.6,
                  marginBottom: 8,
                }}
              >
                <p style={{ margin: 0 }}>색상 = 클러스터 내 trial 수</p>
                <p style={{ margin: "4px 0 0 0" }}>
                  진할수록 더 많은 trial이 탐색됨
                </p>
              </div>
              <svg width={180} height={24}>
                <defs>
                  <linearGradient
                    id="density-gradient"
                    x1="0"
                    x2="1"
                    y1="0"
                    y2="0"
                  >
                    {[0, 0.25, 0.5, 0.75, 1].map((t) => (
                      <stop
                        key={t}
                        offset={`${t * 100}%`}
                        stopColor={d3.interpolateYlOrRd(t)}
                      />
                    ))}
                  </linearGradient>
                </defs>
                <rect
                  width={180}
                  height={14}
                  rx={2}
                  fill="url(#density-gradient)"
                />
                <text x={0} y={24} fontSize={9} fill="#9CA3AF">
                  0
                </text>
                <text
                  x={180}
                  y={24}
                  fontSize={9}
                  fill="#9CA3AF"
                  textAnchor="end"
                >
                  {d3.max(data.clusters.map((c) => c.totalTrials))}
                </text>
              </svg>
            </div>
          )}

          {/* Qualitative label legend — always visible */}
          <div style={{ marginBottom: 20 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <div style={{ fontWeight: 600, color: "#374151" }}>
                Region Legend
              </div>
              <div
                style={{
                  fontSize: 9,
                  color: "#9CA3AF",
                  background: "#F3F4F6",
                  padding: "1px 5px",
                  borderRadius: 3,
                }}
              >
                qual. region
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {[
                {
                  label: "Failure-prone" as QualitativeLabel,
                  desc: "Zero-coverage rate >20%",
                },
                {
                  label: "High Novelty" as QualitativeLabel,
                  desc: "High marginal gain",
                },
                {
                  label: "Saturated" as QualitativeLabel,
                  desc: "High cov, low marginal",
                },
                {
                  label: "High Coverage" as QualitativeLabel,
                  desc: "High total branch coverage",
                },
                {
                  label: "Volatile" as QualitativeLabel,
                  desc: "High coverage variance",
                },
              ].map(({ label, desc }) => (
                <div
                  key={label}
                  style={{ display: "flex", alignItems: "center", gap: 7 }}
                >
                  <div
                    style={{
                      width: 22,
                      height: 14,
                      borderRadius: 2,
                      background: QUAL_LABEL_COLORS[label],
                      flexShrink: 0,
                    }}
                  />
                  <div>
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        color: QUAL_LABEL_COLORS[label],
                        lineHeight: 1.2,
                      }}
                    >
                      {label}
                    </div>
                    <div
                      style={{ fontSize: 9, color: "#9CA3AF", lineHeight: 1.2 }}
                    >
                      {desc}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div
              style={{
                marginTop: 8,
                paddingTop: 8,
                borderTop: "1px solid #F3F4F6",
                fontSize: 9,
                color: "#9CA3AF",
                lineHeight: 1.5,
              }}
            >
              <p style={{ margin: 0 }}>
                Color = qualitative region (independent of tuner color)
              </p>
              <p style={{ margin: "2px 0 0 0" }}>
                Adjacent same-class clusters form one region
              </p>
            </div>
          </div>

          {/* Info — only in overview */}
          {focusedTerritoryId === null && (
            <div style={{ fontSize: 10, color: "#9CA3AF", lineHeight: 1.5 }}>
              {layoutMode === "hex" && (
                <>
                  <p>Each hexagon = cluster of similar trials</p>
                  <p>Nearby hexagons = similar parameter combinations</p>
                </>
              )}
              {layoutMode === "map" && (
                <>
                  <p>Cell area ∝ number of trials (density-based Voronoi)</p>
                  <p>Thick borders = territory boundaries</p>
                  <p>Thin borders = cluster boundaries</p>
                </>
              )}
              <p style={{ marginTop: 4, fontWeight: 500 }}>
                Click a cell for details
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          style={{
            position: "fixed",
            left: tooltip.x + 15,
            top: tooltip.y + 15,
            backgroundColor: "white",
            border: "1px solid #E5E7EB",
            borderRadius: 6,
            padding: "10px 14px",
            fontSize: 11,
            lineHeight: 1.5,
            boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
            pointerEvents: "none",
            zIndex: 1000,
            maxWidth: 280,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Cluster #{tooltip.cluster.id + 1}
          </div>
          <div style={{ marginBottom: 8 }}>
            <span style={{ color: "#6B7280" }}>Trials: </span>
            <span style={{ fontWeight: 500 }}>
              {tooltip.cluster.totalTrials}
            </span>
            <span style={{ color: "#6B7280", marginLeft: 12 }}>
              Avg Marginal:{" "}
            </span>
            <span style={{ fontWeight: 500, color: "#10B981" }}>
              {tooltip.cluster.avgCoverage.toFixed(1)}
            </span>
          </div>
          {(() => {
            const qr = clusterToQualRegion.get(tooltip.cluster.id);
            if (!qr) return null;
            return (
              <div style={{ marginBottom: 8 }}>
                <span
                  style={{
                    display: "inline-block",
                    padding: "1px 6px",
                    borderRadius: 4,
                    fontSize: 10,
                    fontWeight: 600,
                    background: QUAL_LABEL_COLORS[qr.label] + "22",
                    color: QUAL_LABEL_COLORS[qr.label],
                    border: `1px solid ${QUAL_LABEL_COLORS[qr.label]}55`,
                  }}
                >
                  {qr.label}
                </span>
                <span style={{ fontSize: 9, color: "#94A3B8", marginLeft: 6 }}>
                  {QUAL_LABEL_RATIONALE[qr.label]}
                </span>
              </div>
            );
          })()}
          <div style={{ borderTop: "1px solid #E5E7EB", paddingTop: 8 }}>
            <div style={{ fontWeight: 500, marginBottom: 4, color: "#374151" }}>
              Tuner Distribution
            </div>
            {TUNER_NAMES.map((tuner) => {
              const count = tooltip.cluster.tunerCounts[tuner];
              const ratio = count / tooltip.cluster.totalTrials;
              return (
                <div
                  key={tuner}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: 2,
                  }}
                >
                  <div
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 2,
                      backgroundColor: TUNER_COLORS[tuner],
                    }}
                  />
                  <span style={{ flex: 1 }}>{TUNER_DISPLAY_NAMES[tuner]}</span>
                  <span style={{ color: "#6B7280" }}>{count}</span>
                  <span
                    style={{ color: "#9CA3AF", width: 40, textAlign: "right" }}
                  >
                    {(ratio * 100).toFixed(0)}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default HexMap;
