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
import {
  getHexPath,
  getDominantTuner,
  deserializePrecomputed,
  TUNER_COLORS,
  TUNER_NAMES,
  type HexMapData,
  type HexTile,
  type Cluster,
  type Territory,
  type SubRegion,
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
  program?: string;
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

const HEX_SIZE_DEFAULT = 32;

const QUAL_LABEL_COLORS: Record<QualitativeLabel, string> = {
  "Failure-prone": "#EF4444",
  "High Novelty": "#8B5CF6",
  Saturated: "#F59E0B",
  "High Coverage": "#10B981",
  Volatile: "#3B82F6",
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

// Neutral territory palette — visually distinct without semantic meaning
const TERRITORY_PALETTE = [
  "#64748B", // slate-500
  "#78716C", // stone-500
  "#6B7280", // gray-500
  "#71717A", // zinc-500
  "#737373", // neutral-500
  "#7C8594", // blue-gray
  "#8B7E74", // warm-gray
  "#6E7B8B", // cool-slate
];

function getTerritoryColor(territoryId: number): string {
  return TERRITORY_PALETTE[territoryId % TERRITORY_PALETTE.length];
}

function getSubRegionPaletteColor(
  territoryColor: string,
  index: number,
  count: number,
): { fill: string; stroke: string } {
  const base = d3.hsl(territoryColor);
  const safeCount = Math.max(count, 1);
  const ratio = safeCount === 1 ? 0.5 : index / (safeCount - 1);
  const hueShift = (ratio - 0.5) * 12;
  const lightnessTargets = [0.78, 0.68, 0.58, 0.50];
  const targetIdx = Math.min(index, lightnessTargets.length - 1);

  const fill = d3
    .hsl(
      (base.h + hueShift + 360) % 360,
      Math.min(base.s, 0.15),
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
  program = "gawk",
}: HexMapProps) {
  // Responsive sizing: measure the container
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 900, height: 750 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width: w, height: h } = entries[0].contentRect;
      if (w > 0 && h > 0) setContainerSize({ width: w, height: h });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const MAP_RATIO = 0.7; // 7:3 split
  const svgWidth = Math.floor(containerSize.width * MAP_RATIO);
  const panelWidth = containerSize.width - svgWidth;
  const height = containerSize.height;
  // All 5 levels: index 0 = L0, ... 4 = L4
  const [allLevels, setAllLevels] = useState<HexMapData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [colorMode, setColorMode] = useState<ColorMode>("pixel");
  const [previewColorMode, setPreviewColorMode] = useState<ColorMode | null>(null);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("hex");
  // hover: drives sub-region / territory highlight
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
  // territory hover — highlights the hovered territory's sub-region on tile hover
  const [hoveredTerritoryId, setHoveredTerritoryId] = useState<number | null>(
    null,
  );
  // cluster detail panel — only set from within a focused territory
  const [inspectedClusterId, setInspectedClusterId] = useState<number | null>(
    null,
  );
  // Control panel tuner hover — highlight tiles containing that tuner
  const [previewTuner, setPreviewTuner] = useState<TunerType | null>(null);

  const [selectedTuners, setSelectedTuners] = useState<Set<TunerType>>(
    new Set(TUNER_NAMES),
  );
  // 4 = finest (current clusters), 3/2/1/0 = progressively coarser merged levels
  const [detailLevel, setDetailLevel] = useState<number>(4);
  const [previewDetailLevel, setPreviewDetailLevel] = useState<number | null>(null);

  const svgRef = useRef<SVGSVGElement>(null);

  // Load pre-computed multi-level HexMap data
  useEffect(() => {
    let cancelled = false;

    async function loadPrecomputed() {
      setLoading(true);
      setError(null);
      setAllLevels([]);

      try {
        const url = `/data/${program}_hexmap_precomputed.json`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Failed to load ${url}`);
        const json = await resp.json();
        if (cancelled) return;

        const levels = deserializePrecomputed(json);
        setAllLevels(levels);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load data");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadPrecomputed();
    return () => {
      cancelled = true;
    };
  }, [program]);

  // Effective values (preview overrides actual for hover preview)
  const effectiveDetailLevel = previewDetailLevel ?? detailLevel;
  const effectiveColorMode = previewColorMode ?? colorMode;

  // Active data for current detail level
  const data = allLevels[effectiveDetailLevel] ?? null;
  const HEX_SIZE = data?.hexSize ?? HEX_SIZE_DEFAULT;

  // Compute transform to fit and center the honeycomb
  const { centerX, centerY, scale } = useMemo(() => {
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
  }, [data, svgWidth, height, HEX_SIZE]);

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
  const hexPath = useMemo(() => getHexPath(HEX_SIZE), [HEX_SIZE]);

  // Territories are pre-computed in processHexMapData (hexMapUtils.ts)
  // Wrapped in useMemo so the array reference is stable across renders.
  const territories = useMemo<Territory[]>(() => data?.territories ?? [], [data]);

  // Reset focus when detail level changes (including preview)
  useEffect(() => {
    setFocusedTerritoryId(null);
    setFocusedSubRegionId(null);
    setInspectedClusterId(null);
    setHoveredClusterId(null);
  }, [effectiveDetailLevel]);



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

  // cluster.id → subRegion.id (all territories, so hover works in any view)
  const clusterToSubRegionId = useMemo(() => {
    const map = new Map<number, number>();
    for (const terr of territories) {
      for (const sr of terr.subRegions) {
        for (const c of sr.clusters) map.set(c.id, sr.id);
      }
    }
    return map;
  }, [territories]);

  const clusterToSubRegionVisual = useMemo(() => {
    const map = new Map<number, SubRegionVisual>();

    for (const terr of territories) {
      const territoryColor = getTerritoryColor(terr.id);
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

    const svgW = svgWidth;
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
  }, [data, territories, layoutMode, svgWidth, height]);

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

      switch (effectiveColorMode) {
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
      effectiveColorMode,
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
  // Label placement helpers
  // ============================================================

  /** Visible viewport in data-space coordinates (with margin for labels) */
  const viewBounds = useMemo(() => {
    const margin = 8 / scale; // small inset so labels don't touch SVG edge
    const halfW = (svgWidth / 2) / scale;
    const halfH = ((height - 80) / 2) / scale;
    return {
      minX: dataCenter.x - halfW + margin,
      maxX: dataCenter.x + halfW - margin,
      minY: dataCenter.y - halfH + margin,
      maxY: dataCenter.y + halfH - margin,
    };
  }, [dataCenter, svgWidth, height, scale]);

  /** Check if a rectangle overlaps any hex tile */
  const labelOverlapsTiles = useCallback(
    (lx: number, ly: number, lw: number, lh: number): boolean => {
      if (!data) return false;
      const hr = HEX_SIZE * 0.9;
      for (const tile of data.hexTiles) {
        if (!tile.cluster) continue;
        if (
          lx < tile.x + hr && lx + lw > tile.x - hr &&
          ly < tile.y + hr && ly + lh > tile.y - hr
        ) return true;
      }
      return false;
    },
    [data, HEX_SIZE],
  );

  /** Check if a label rect is fully inside the visible viewport */
  const labelInsideView = useCallback(
    (cx: number, cy: number, w: number, h: number): boolean => {
      return (
        cx - w / 2 >= viewBounds.minX &&
        cx + w / 2 <= viewBounds.maxX &&
        cy - h / 2 >= viewBounds.minY &&
        cy + h / 2 <= viewBounds.maxY
      );
    },
    [viewBounds],
  );

  // ============================================================
  // Sub-region labels — multi-line, just outside their own tiles,
  // with leader lines back to the centroid.
  // ============================================================
  const subLabelPositions = useMemo(() => {
    const activeTerrId = focusedTerritoryId ?? hoveredTerritoryId;
    if (activeTerrId === null || !data) return [];
    const terr = territories.find((t) => t.id === activeTerrId);
    if (!terr) return [];
    // Skip if territory has only 1 sub-region (nothing to differentiate)
    if (terr.subRegions.length <= 1) return [];

    const fs = 10 / scale;
    const pad = 4 / scale;
    const lineH = fs * 1.3;
    const charW = fs * 0.56;
    const gap = fs * 2;

    type Bbox = { x: number; y: number; w: number; h: number };
    function bbOverlaps(a: Bbox, b: Bbox) {
      return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    }
    const placed: Bbox[] = [];
    const results: {
      sr: SubRegion; x: number; y: number;
      rw: number; rh: number; lines: string[]; color: string;
      anchorX: number; anchorY: number;
    }[] = [];

    // Territory-level bounding box — labels go outside ALL tiles
    const allTxs = terr.tiles.map((t) => t.x);
    const allTys = terr.tiles.map((t) => t.y);
    const tMinX = Math.min(...allTxs) - HEX_SIZE;
    const tMaxX = Math.max(...allTxs) + HEX_SIZE;
    const tMinY = Math.min(...allTys) - HEX_SIZE;
    const tMaxY = Math.max(...allTys) + HEX_SIZE;

    const sorted = [...terr.subRegions]
      .filter((sr) => sr.label.trim().length > 0)
      .sort((a, b) => b.totalTrials - a.totalTrials);

    for (const sr of sorted) {
      const lines = sr.label.split(", ");
      const maxLineLen = Math.max(...lines.map((l) => l.length));
      const rw = maxLineLen * charW + pad * 2;
      const rh = lines.length * lineH + pad * 2;
      const anchorX = sr.pixelCentroidX;
      const anchorY = sr.pixelCentroidY;
      const margin = HEX_SIZE * 0.6;

      // Sort edges by distance from sub-region centroid → closest edge first
      const edgeDists: { dir: string; dist: number }[] = [
        { dir: "left",   dist: Math.abs(anchorX - tMinX) },
        { dir: "right",  dist: Math.abs(anchorX - tMaxX) },
        { dir: "above",  dist: Math.abs(anchorY - tMinY) },
        { dir: "below",  dist: Math.abs(anchorY - tMaxY) },
      ];
      edgeDists.sort((a, b) => a.dist - b.dist);

      const edgeCandidates: Record<string, { x: number; y: number }[]> = {
        left: [
          { x: tMinX - margin - rw / 2, y: anchorY },
          { x: tMinX - margin - rw / 2, y: anchorY - rh },
          { x: tMinX - margin - rw / 2, y: anchorY + rh },
        ],
        above: [
          { x: anchorX, y: tMinY - margin - rh / 2 },
          { x: anchorX - rw * 0.5, y: tMinY - margin - rh / 2 },
          { x: anchorX + rw * 0.5, y: tMinY - margin - rh / 2 },
        ],
        right: [
          { x: tMaxX + margin + rw / 2, y: anchorY },
          { x: tMaxX + margin + rw / 2, y: anchorY - rh },
          { x: tMaxX + margin + rw / 2, y: anchorY + rh },
        ],
        below: [
          { x: anchorX, y: tMaxY + margin + rh / 2 },
          { x: anchorX - rw * 0.5, y: tMaxY + margin + rh / 2 },
          { x: anchorX + rw * 0.5, y: tMaxY + margin + rh / 2 },
        ],
      };

      // Build candidates in closest-edge-first order
      const candidates: { x: number; y: number }[] = [];
      for (const { dir } of edgeDists) {
        candidates.push(...edgeCandidates[dir]);
      }

      // Candidates are already outside territory bbox — only check viewport & label overlap
      let chosen: { x: number; y: number } | null = null;
      for (const c of candidates) {
        const b: Bbox = {
          x: c.x - rw / 2 - gap, y: c.y - rh / 2 - gap,
          w: rw + gap * 2, h: rh + gap * 2,
        };
        if (
          labelInsideView(c.x, c.y, rw, rh) &&
          !placed.some((p) => bbOverlaps(b, p))
        ) {
          chosen = c;
          placed.push(b);
          break;
        }
      }

      // Fallback: try further out from territory edges, closest-edge-first
      if (!chosen) {
        for (const extraMult of [1.5, 2.5, 4]) {
          if (chosen) break;
          const em = HEX_SIZE * extraMult;
          const fbEdge: Record<string, { x: number; y: number }> = {
            left:  { x: tMinX - margin - em - rw / 2, y: anchorY },
            above: { x: anchorX, y: tMinY - margin - em - rh / 2 },
            right: { x: tMaxX + margin + em + rw / 2, y: anchorY },
            below: { x: anchorX, y: tMaxY + margin + em + rh / 2 },
          };
          const fbCandidates = edgeDists.map(({ dir }) => fbEdge[dir]);
          for (const c of fbCandidates) {
            const b: Bbox = { x: c.x - rw / 2 - gap, y: c.y - rh / 2 - gap, w: rw + gap * 2, h: rh + gap * 2 };
            if (
              labelInsideView(c.x, c.y, rw, rh) &&
              !placed.some((p) => bbOverlaps(b, p))
            ) {
              chosen = c;
              placed.push(b);
              break;
            }
          }
        }
      }

      // Last resort: don't show rather than overlap tiles
      if (!chosen) {
        continue;
      }

      results.push({
        sr, x: chosen.x, y: chosen.y, rw, rh, lines,
        color: getTerritoryColor(terr.id), anchorX, anchorY,
      });
    }
    return results;
  }, [focusedTerritoryId, hoveredTerritoryId, territories, scale, data, HEX_SIZE, labelInsideView]);

  // ============================================================
  // Macro label placement — just outside each territory's own
  // bounding box, close to it, with leader lines to centroid.
  // ============================================================
  const macroLabelPositions = useMemo(() => {
    if (!data) return [];

    const fs = 11 / scale;
    const pad = 5 / scale;
    const lineH = fs * 1.3;
    const charW = fs * 0.58;
    const gap = fs * 2;

    type Bbox = { x: number; y: number; w: number; h: number };
    type LPos = {
      terr: Territory; lines: string[];
      x: number; y: number; rw: number; rh: number;
      anchorX: number; anchorY: number;
    };

    function bbOverlaps(a: Bbox, b: Bbox) {
      return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    }

    const sorted = [...territories]
      .filter((t) => t.label && t.tiles.length > 0)
      .sort((a, b) => b.tiles.length - a.tiles.length);

    const placed: Bbox[] = [];
    const results: LPos[] = [];

    for (const t of sorted) {
      const lines = t.label.split(", ");
      const maxLineLen = Math.max(...lines.map((l) => l.length));
      const rw = maxLineLen * charW + pad * 2;
      const rh = lines.length * lineH + pad * 2;

      const anchorX = t.pixelCentroidX;
      const anchorY = t.pixelCentroidY;

      // Per-territory bounding box
      const txs = t.tiles.map((tile) => tile.x);
      const tys = t.tiles.map((tile) => tile.y);
      const tMinX = Math.min(...txs) - HEX_SIZE;
      const tMaxX = Math.max(...txs) + HEX_SIZE;
      const tMinY = Math.min(...tys) - HEX_SIZE;
      const tMaxY = Math.max(...tys) + HEX_SIZE;

      const margin = HEX_SIZE * 0.6;

      // Candidates close to THIS territory's edges
      const candidates = [
        // center of each edge: left → above → right → below
        { x: tMinX - margin - rw / 2, y: anchorY },                // left
        { x: anchorX, y: tMinY - margin - rh / 2 },                // above
        { x: tMaxX + margin + rw / 2, y: anchorY },                // right
        { x: anchorX, y: tMaxY + margin + rh / 2 },                // below
        // shifted along each edge
        { x: tMinX - margin - rw / 2, y: anchorY - rh },
        { x: anchorX - rw * 0.5, y: tMinY - margin - rh / 2 },
        { x: tMaxX + margin + rw / 2, y: anchorY - rh },
        { x: anchorX - rw * 0.5, y: tMaxY + margin + rh / 2 },
        { x: tMinX - margin - rw / 2, y: anchorY + rh },
        { x: anchorX + rw * 0.5, y: tMinY - margin - rh / 2 },
        { x: tMaxX + margin + rw / 2, y: anchorY + rh },
        { x: anchorX + rw * 0.5, y: tMaxY + margin + rh / 2 },
        // corners
        { x: tMinX - margin - rw / 2, y: tMinY - margin - rh / 2 },
        { x: tMaxX + margin + rw / 2, y: tMinY - margin - rh / 2 },
        { x: tMaxX + margin + rw / 2, y: tMaxY + margin + rh / 2 },
        { x: tMinX - margin - rw / 2, y: tMaxY + margin + rh / 2 },
      ];

      let chosen: { x: number; y: number } | null = null;
      for (const c of candidates) {
        const bb: Bbox = {
          x: c.x - rw / 2 - gap / 2, y: c.y - rh / 2 - gap / 2,
          w: rw + gap, h: rh + gap,
        };
        if (
          labelInsideView(c.x, c.y, rw, rh) &&
          !placed.some((p) => bbOverlaps(bb, p)) &&
          !labelOverlapsTiles(bb.x, bb.y, bb.w, bb.h)
        ) {
          chosen = c;
          placed.push(bb);
          break;
        }
      }

      // Fallback: try increasingly distant offsets, still avoiding tiles
      if (!chosen) {
        const dirs = [
          { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 },
          { x: -0.7, y: -0.7 }, { x: 0.7, y: -0.7 }, { x: 0.7, y: 0.7 }, { x: -0.7, y: 0.7 },
        ];
        for (const mult of [3, 4.5, 6, 8]) {
          if (chosen) break;
          const dist = HEX_SIZE * mult;
          for (const d of dirs) {
            const cx = anchorX + d.x * dist;
            const cy = anchorY + d.y * dist;
            const fb: Bbox = { x: cx - rw / 2 - gap / 2, y: cy - rh / 2 - gap / 2, w: rw + gap, h: rh + gap };
            if (
              labelInsideView(cx, cy, rw, rh) &&
              !placed.some((p) => bbOverlaps(fb, p)) &&
              !labelOverlapsTiles(fb.x, fb.y, fb.w, fb.h)
            ) {
              chosen = { x: cx, y: cy };
              placed.push(fb);
              break;
            }
          }
        }
        // Last resort: nearest non-overlapping direction (allow tile overlap)
        if (!chosen) {
          for (const d of dirs) {
            const cx = anchorX + d.x * HEX_SIZE * 4;
            const cy = anchorY + d.y * HEX_SIZE * 4;
            const fb: Bbox = { x: cx - rw / 2 - gap / 2, y: cy - rh / 2 - gap / 2, w: rw + gap, h: rh + gap };
            if (labelInsideView(cx, cy, rw, rh) && !placed.some((p) => bbOverlaps(fb, p))) {
              chosen = { x: cx, y: cy };
              placed.push(fb);
              break;
            }
          }
        }
        if (!chosen) {
          chosen = { x: anchorX, y: anchorY };
          placed.push({ x: anchorX - rw / 2 - gap / 2, y: anchorY - rh / 2 - gap / 2, w: rw + gap, h: rh + gap });
        }
      }

      results.push({
        terr: t, lines,
        x: chosen.x, y: chosen.y, rw, rh,
        anchorX, anchorY,
      });
    }

    return results;
  }, [data, territories, scale, HEX_SIZE, labelOverlapsTiles, labelInsideView]);

  // Territory fills + borders: scaled hex fills, bridge quads between neighbors, boundary lines
  const territoryScaleFactors = useMemo(
    () => [1.0, 0.82, 0.64, 0.5, 0.38, 0.28],
    [],
  );
  const renderTerritoryFillsAndBorders = useMemo(() => {
    if (!data || effectiveColorMode !== "territory") return null;

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
    effectiveColorMode,
    hexLookup,
    selectedTuners,
    tunerTerritoryRank,
    territoryScaleFactors,
    HEX_DIRECTIONS,
    getHexVertices,
  ]);

  // Mouse handlers
  const handleMouseEnter = useCallback((tile: HexTile, _e: React.MouseEvent) => {
    if (!tile.cluster) return;
    setHoveredClusterId(tile.cluster.id);
    // Highlight the sub-region & territory this tile belongs to
    const srId = clusterToSubRegionId.get(tile.cluster.id) ?? null;
    setHoveredSubRegionId(srId);
    const tId = clusterToTerrId.get(tile.cluster.id) ?? null;
    setHoveredTerritoryId(tId);
  }, [clusterToSubRegionId, clusterToTerrId]);

  const handleMouseMove = useCallback((_e: React.MouseEvent) => {}, []);

  const handleMouseLeave = useCallback(() => {
    setHoveredClusterId(null);
    setHoveredSubRegionId(null);
    setHoveredTerritoryId(null);
  }, []);


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
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
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
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
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
    <div ref={containerRef} style={{ position: "relative", width: "100%", height: "100%" }}>
      <div
        style={{
          position: "relative",
          display: "flex",
          justifyContent: "space-between",
          width: "100%",
          height: "100%",
          overflow: "hidden",
        }}
      >
        {/* SVG Map — 70% width */}
        <svg
          ref={svgRef}
          width={svgWidth}
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

              {/* ── Hex tiles: no hover-sensitive props so hover doesn't re-render all tiles ── */}
              {data.hexTiles.map((tile) => {
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
                const tileTerrId = clusterToTerrId.get(tile.cluster.id);
                const activeTerritoryId = focusedTerritoryId ?? hoveredTerritoryId;
                const isMuted =
                  activeTerritoryId !== null &&
                  tileTerrId !== activeTerritoryId;
                const activeSubRegionId =
                  hoveredSubRegionId ?? focusedSubRegionId;
                const isSubMuted =
                  !isMuted &&
                  activeSubRegionId !== null &&
                  clusterToSubRegionId.get(tile.cluster.id) !==
                    activeSubRegionId;
                const isTunerMuted =
                  previewTuner !== null &&
                  (tile.cluster!.tunerCounts[previewTuner] ?? 0) === 0;
                const tileOpacity = isTunerMuted ? 0.1 : isMuted ? 0.12 : isSubMuted ? 0.22 : 1;

                return (
                  <g
                    key={`${tile.q},${tile.r}`}
                    transform={`translate(${tile.x}, ${tile.y})`}
                    onMouseEnter={(e) => handleMouseEnter(tile, e)}
                    onMouseMove={handleMouseMove}
                    onMouseLeave={handleMouseLeave}
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

              {renderTerritoryFillsAndBorders}

              {/* ── Macro boundaries: white halo pass (drawn first, behind) ── */}
              {boundaryData.macro.map(({ d, terr }) => {
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
              {boundaryData.macro.map(({ d, terr }) => {
                if (!d) return null;
                const isFocused = terr.id === focusedTerritoryId;
                const isMuted = focusedTerritoryId !== null && !isFocused;
                return (
                  <path
                    key={`macro-line-${terr.id}`}
                    d={d}
                    fill="none"
                    stroke={getTerritoryColor(terr.id)}
                    strokeWidth={isFocused ? 5 : 3.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={isMuted ? 0.12 : 0.7}
                    pointerEvents="none"
                  />
                );
              })}

              {/* ── Sub-region boundaries: neutral, focus mode only ──────── */}
              {(focusedTerritoryId ?? hoveredTerritoryId) !== null &&
               (() => {
                 const at = territories.find((t) => t.id === (focusedTerritoryId ?? hoveredTerritoryId));
                 return at && at.subRegions.length > 1;
               })() && (
                <>
                  {/* white halo (thin) */}
                  {boundaryData.sub
                    .filter(({ terr }) => terr.id === (focusedTerritoryId ?? hoveredTerritoryId))
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
                    .filter(({ terr }) => terr.id === (focusedTerritoryId ?? hoveredTerritoryId))
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

              {/* ── Sub-region labels: multi-line, outside tiles, with leader lines ── */}
              {subLabelPositions.map(({ sr, x, y, rw, rh: lh, lines, color, anchorX, anchorY }) => {
                const isLabelHovered = hoveredSubRegionId === sr.id;
                const fs = 10 / scale;
                const lineH = fs * 1.3;
                const rx = 4 / scale;
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
                    <line
                      x1={anchorX} y1={anchorY} x2={x} y2={y}
                      stroke={color} strokeWidth={1 / scale}
                      strokeDasharray={`${3 / scale},${2 / scale}`} opacity={0.5}
                    />
                    <circle cx={anchorX} cy={anchorY} r={2.5 / scale}
                      fill={color} opacity={0.7} />
                    <rect x={x - rw / 2} y={y - lh / 2} width={rw} height={lh}
                      rx={rx} fill="white" opacity={0.96} />
                    <rect x={x - rw / 2} y={y - lh / 2} width={rw} height={lh}
                      rx={rx} fill="none" stroke={color}
                      strokeWidth={1.5 / scale} />
                    <text x={x} textAnchor="middle" fontSize={fs}
                      fontWeight={600} fill={color}>
                      {lines.map((line, li) => (
                        <tspan key={li} x={x}
                          y={y - (lines.length - 1) * lineH / 2 + li * lineH}
                          dominantBaseline="middle"
                        >{line}</tspan>
                      ))}
                    </text>
                  </g>
                );
              })}

              {/* ── Macro territory labels: multi-line, outside tiles, with leader lines ── */}
              {focusedTerritoryId === null && hoveredTerritoryId === null &&
                macroLabelPositions.map(
                  ({
                    terr: t,
                    lines,
                    x: px,
                    y: py,
                    rw,
                    rh,
                    anchorX,
                    anchorY,
                  }) => {
                    const color = getTerritoryColor(t.id);
                    const fs = 11 / scale;
                    const lineH = fs * 1.3;
                    const bw = 1.5 / scale;
                    const rx = 5 / scale;
                    return (
                      <g key={`macro-label-${t.id}`} pointerEvents="none">
                        <line
                          x1={anchorX} y1={anchorY} x2={px} y2={py}
                          stroke={color} strokeWidth={1 / scale}
                          strokeDasharray={`${4 / scale},${3 / scale}`} opacity={0.45}
                        />
                        <circle cx={anchorX} cy={anchorY} r={3 / scale}
                          fill={color} opacity={0.8} />
                        <rect
                          x={px - rw / 2 - 1 / scale} y={py - rh / 2 - 1 / scale}
                          width={rw + 2 / scale} height={rh + 2 / scale}
                          rx={rx + 1 / scale} fill="white"
                        />
                        <rect
                          x={px - rw / 2} y={py - rh / 2}
                          width={rw} height={rh} rx={rx}
                          fill="none" stroke={color} strokeWidth={bw} opacity={0.9}
                        />
                        <text x={px} textAnchor="middle" fontSize={fs}
                          fontWeight={700} fill={color}>
                          {lines.map((line, li) => (
                            <tspan key={li} x={px}
                              y={py - (lines.length - 1) * lineH / 2 + li * lineH}
                              dominantBaseline="middle"
                            >{line}</tspan>
                          ))}
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
                    {effectiveColorMode === "territory" &&
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
              {effectiveColorMode !== "territory" &&
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
              {effectiveColorMode === "territory" && mapTerritoryBorders}
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
                const terrColor = getTerritoryColor(terr.id);
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
                              const srColor = "#64748B"; // neutral slate
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
        {/* Controls panel — 30% width */}
        <div
          style={{
            width: panelWidth,
            fontSize: 12,
            height: "100%",
            overflowY: "auto",
            flexShrink: 0,
            borderLeft: "1px solid #E5E7EB",
            paddingLeft: 16,
            paddingRight: 8,
          }}
        >
          {/* Summary */}
          <div style={{
            marginBottom: 14,
            padding: "8px 10px",
            background: "#F8FAFC",
            borderRadius: 6,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 11,
            color: "#64748B",
          }}>
            <span><b style={{ color: "#1E293B" }}>{stats.totalTrials.toLocaleString()}</b> trials</span>
            <span><b style={{ color: "#1E293B" }}>{data?.clusters.length || 0}</b> clusters</span>
          </div>

          {/* Detail Level */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600, fontSize: 11, color: "#374151" }}>Detail</span>
              <div style={{ display: "flex", gap: 2 }}>
                {([0, 1, 2, 3, 4] as const).map((lv) => {
                  const count = allLevels[lv]?.clusters.length ?? "…";
                  const isActive = detailLevel === lv;
                  return (
                    <button
                      key={lv}
                      onClick={() => setDetailLevel(lv)}
                      onMouseEnter={() => setPreviewDetailLevel(lv)}
                      onMouseLeave={() => setPreviewDetailLevel(null)}
                      title={`Level ${lv}: ${count} clusters`}
                      style={{
                        padding: "3px 0",
                        width: 36,
                        fontSize: 10,
                        fontWeight: isActive ? 600 : 400,
                        border: "1px solid",
                        borderColor: isActive ? "#4F46E5" : "#E5E7EB",
                        borderRadius: 4,
                        background: isActive ? "#EEF2FF" : "white",
                        color: isActive ? "#4F46E5" : "#9CA3AF",
                        cursor: "pointer",
                        textAlign: "center",
                        lineHeight: 1.2,
                      }}
                    >
                      L{lv}
                      <br />
                      <span style={{ fontSize: 8 }}>{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div style={{ borderTop: "1px solid #F1F5F9", margin: "0 0 14px" }} />

          {/* Color mode */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 600, fontSize: 11, marginBottom: 6, color: "#374151" }}>
              Color
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
              {(
                [
                  { mode: "pixel", label: "Sub-region" },
                  { mode: "coverage", label: "Coverage" },
                  { mode: "marginal", label: "Marginal" },
                  { mode: "dominant", label: "Dominant" },
                  { mode: "density", label: "Density" },
                ] as { mode: ColorMode; label: string }[]
              ).map(({ mode, label }) => {
                const isActive = colorMode === mode;
                return (
                  <button
                    key={mode}
                    onClick={() => setColorMode(mode)}
                    onMouseEnter={() => setPreviewColorMode(mode)}
                    onMouseLeave={() => setPreviewColorMode(null)}
                    style={{
                      padding: "4px 8px",
                      fontSize: 10,
                      border: "1px solid",
                      borderColor: isActive ? "#4F46E5" : "#E5E7EB",
                      borderRadius: 4,
                      background: isActive ? "#EEF2FF" : "white",
                      color: isActive ? "#4F46E5" : "#6B7280",
                      cursor: "pointer",
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ borderTop: "1px solid #F1F5F9", margin: "0 0 14px" }} />

          {/* Tuner filter */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 600, fontSize: 11, marginBottom: 6, color: "#374151" }}>
              Tuners
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {TUNER_NAMES.map((tuner) => {
                const isOn = selectedTuners.has(tuner);
                return (
                  <button
                    key={tuner}
                    onClick={() => toggleTuner(tuner)}
                    onMouseEnter={() => setPreviewTuner(tuner)}
                    onMouseLeave={() => setPreviewTuner(null)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      width: "100%",
                      padding: "5px 8px",
                      fontSize: 10,
                      border: "1px solid",
                      borderColor: isOn ? TUNER_COLORS[tuner] + "88" : "#F1F5F9",
                      borderRadius: 5,
                      background: isOn ? "white" : "#FAFAFA",
                      cursor: "pointer",
                      opacity: isOn ? 1 : 0.45,
                      transition: "opacity 0.15s",
                    }}
                  >
                    <div
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 2,
                        backgroundColor: TUNER_COLORS[tuner],
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ flex: 1, textAlign: "left", color: "#374151", fontWeight: 500 }}>
                      {TUNER_DISPLAY_NAMES[tuner]}
                    </span>
                    <span style={{ color: "#B0B8C4", fontSize: 9 }}>
                      {stats.tunerTotals[tuner]?.toLocaleString()}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Tip */}
          {focusedTerritoryId === null && (
            <div style={{ fontSize: 10, color: "#B0B8C4", lineHeight: 1.5 }}>
              Click a cell for details
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

export default HexMap;
