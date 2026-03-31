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
  type Territory,
  type SubRegion,
  type Trial,
  type TunerType,
} from "../utils/hexMapUtils";

// ============================================================
// Types
// ============================================================

type ColorMode = "dominant" | "territory" | "pixel" | "density" | "coverage" | "compare";
export interface DrillState {
  detailLevel: number;
  focusedTerritoryId: number | null;
  focusedSubRegionPath: number[]; // stack of sub-region IDs for recursive drill-down
  hoveredTerritoryId: number | null;
  hoveredSubRegionId: number | null;
  hoveredClusterId: number | null;
}

interface HexMapProps {
  program?: string;
  compact?: boolean;
  onDrillStateChange?: (state: DrillState) => void;
  syncDrillState?: DrillState | null;
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
  | "High Coverage"
  | "High Density";

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
  "High Coverage": "#10B981",
  "High Density": "#06B6D4",
};

const QUAL_LABEL_NAMES: QualitativeLabel[] = [
  "Failure-prone",
  "High Novelty",
  "High Coverage",
  "High Density",
];

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

// Neutral territory palette — lighter tones for hex fill, visually distinct
const TERRITORY_PALETTE = [
  "#94A3B8", // slate-400
  "#A8A29E", // stone-400
  "#9CA3AF", // gray-400
  "#A1A1AA", // zinc-400
  "#A3A3A3", // neutral-400
  "#9DAAB8", // blue-gray light
  "#B0A69C", // warm-gray light
  "#92A0B0", // cool-slate light
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
  const lightnessTargets = [0.78, 0.68, 0.58, 0.5];
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
  compact = false,
  onDrillStateChange,
  syncDrillState,
}: HexMapProps) {
  // Responsive sizing: measure the container
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({
    width: 900,
    height: 750,
  });

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

  const svgWidth = containerSize.width;
  const height = containerSize.height;
  // All 5 levels: index 0 = L0, ... 4 = L4
  const [allLevels, setAllLevels] = useState<HexMapData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [colorMode, setColorMode] = useState<ColorMode>("pixel");
  const [previewColorMode, setPreviewColorMode] = useState<ColorMode | null>(
    null,
  );
  const [coverageMetric, setCoverageMetric] = useState<"mean" | "min" | "max">("mean");
  // Compare mode: tuner A vs tuner B coverage difference
  const [compareTunerA, setCompareTunerA] = useState<TunerType>("SymTuner");
  const [compareTunerB, setCompareTunerB] = useState<TunerType>("TPE");
  // hover: drives territory highlight + tooltip
  const [hoveredClusterId, setHoveredClusterId] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  // 1st click: territory focus; 2nd click within territory: cluster inspect
  const [focusedTerritoryId, setFocusedTerritoryId] = useState<number | null>(
    null,
  );
  // Recursive sub-region drill-down path: stack of sub-region IDs
  const [focusedSubRegionPath, setFocusedSubRegionPath] = useState<number[]>(
    [],
  );
  // Derived: leaf sub-region ID (last in path) or null
  const focusedSubRegionId =
    focusedSubRegionPath.length > 0
      ? focusedSubRegionPath[focusedSubRegionPath.length - 1]
      : null;
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
  // Animated view focus — when a territory is clicked, smoothly pan/zoom to it
  const [viewFocus, setViewFocus] = useState<{
    cx: number;
    cy: number;
    zoomScale: number;
  } | null>(null);
  // Control panel tuner hover — highlight tiles containing that tuner
  const [previewTuner, setPreviewTuner] = useState<TunerType | null>(null);

  // Qualitative label toggles
  const [selectedQualLabels, setSelectedQualLabels] = useState<
    Set<QualitativeLabel>
  >(new Set(QUAL_LABEL_NAMES));
  const [selectedParam, setSelectedParam] = useState<string | null>(null);

  const [selectedTuners, setSelectedTuners] = useState<Set<TunerType>>(
    new Set(TUNER_NAMES),
  );
  // Solo tuner: highlight only cells where this tuner has trials
  const [soloTuner, setSoloTuner] = useState<TunerType | null>(null);
  // 4 = finest (current clusters), 3/2/1/0 = progressively coarser merged levels
  const [detailLevel, setDetailLevel] = useState<number>(4);

  // Report drill state changes to parent
  useEffect(() => {
    onDrillStateChange?.({
      detailLevel,
      focusedTerritoryId,
      focusedSubRegionPath,
      hoveredTerritoryId,
      hoveredSubRegionId,
      hoveredClusterId,
    });
  }, [
    detailLevel,
    focusedTerritoryId,
    focusedSubRegionPath,
    hoveredTerritoryId,
    hoveredSubRegionId,
    hoveredClusterId,
    onDrillStateChange,
  ]);

  // Track whether we're applying synced state (to skip detail-level reset)
  const isSyncingRef = useRef(false);

  // Apply synced drill state from sibling view
  useEffect(() => {
    if (!syncDrillState) return;
    isSyncingRef.current = true;
    setDetailLevel(syncDrillState.detailLevel);
    setFocusedTerritoryId(syncDrillState.focusedTerritoryId);
    setFocusedSubRegionPath(syncDrillState.focusedSubRegionPath);
    setHoveredTerritoryId(syncDrillState.hoveredTerritoryId);
    setHoveredSubRegionId(syncDrillState.hoveredSubRegionId);
    setHoveredClusterId(syncDrillState.hoveredClusterId);
    // Reset flag after React processes the batched state updates
    requestAnimationFrame(() => {
      isSyncingRef.current = false;
    });
  }, [syncDrillState]);

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
  const effectiveDetailLevel = detailLevel;
  const effectiveColorMode = previewColorMode ?? colorMode;

  // Active data for current detail level
  const data = allLevels[effectiveDetailLevel] ?? null;
  const HEX_SIZE = data?.hexSize ?? HEX_SIZE_DEFAULT;

  // Compute transform to fit and center the honeycomb
  const CONTROLS_PAD = 150; // px reserved for top overlay controls

  const { centerX, centerY, scale } = useMemo(() => {
    const availH = height - CONTROLS_PAD;

    if (!data || data.hexTiles.length === 0) {
      return {
        centerX: svgWidth / 2,
        centerY: CONTROLS_PAD + availH / 2,
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

    // Calculate scale to fit within the area below controls
    const scaleX = svgWidth / dataWidth;
    const scaleY = availH / dataHeight;
    const fitScale = Math.min(scaleX, scaleY, 1.2); // Cap at 1.2 to avoid too large

    return {
      centerX: svgWidth / 2,
      centerY: CONTROLS_PAD + availH / 2,
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
  const territories = useMemo<Territory[]>(
    () => data?.territories ?? [],
    [data],
  );

  // Reset focus when detail level changes — skip if change came from sync
  useEffect(() => {
    if (isSyncingRef.current) return;
    setFocusedTerritoryId(null);
    setFocusedSubRegionPath([]);
    setInspectedClusterId(null);
    setHoveredClusterId(null);
    setViewFocus(null);
  }, [effectiveDetailLevel]);

  // Animate view to focused region (territory or sub-region)
  useEffect(() => {
    if (focusedTerritoryId === null || !data) {
      setViewFocus(null);
      return;
    }

    // Find the set of cluster IDs to zoom into
    let targetClusterIds: Set<number>;

    if (focusedSubRegionId !== null) {
      // Level 2: zoom to sub-region (must match both territory and sub-region ID)
      targetClusterIds = new Set<number>();
      const focusedTerr = territories.find((t) => t.id === focusedTerritoryId);
      if (focusedTerr) {
        const sr = focusedTerr.subRegions.find(
          (s) => s.id === focusedSubRegionId,
        );
        if (sr) targetClusterIds = new Set(sr.clusters.map((c) => c.id));
      }
    } else {
      // Level 1: zoom to territory
      const terr = territories.find((t) => t.id === focusedTerritoryId);
      if (!terr) {
        setViewFocus(null);
        return;
      }
      targetClusterIds = new Set(terr.clusters.map((c) => c.id));
    }

    const targetTiles = data.hexTiles.filter(
      (t) => t.cluster && targetClusterIds.has(t.cluster.id),
    );
    if (targetTiles.length === 0) {
      setViewFocus(null);
      return;
    }

    const xs = targetTiles.map((t) => t.x);
    const ys = targetTiles.map((t) => t.y);
    const pad = HEX_SIZE * 2;
    const bboxW = Math.max(...xs) - Math.min(...xs) + pad * 2;
    const bboxH = Math.max(...ys) - Math.min(...ys) + pad * 2;
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;

    // Zoom to fill ~70% of the viewport, capped at 5× overview scale
    const availH = height - CONTROLS_PAD;
    const zx = (svgWidth * 0.7) / bboxW;
    const zy = (availH * 0.7) / bboxH;
    const zoomScale = Math.min(zx, zy, scale * 5);

    setViewFocus({ cx, cy, zoomScale });
  }, [
    focusedTerritoryId,
    focusedSubRegionId,
    data,
    territories,
    HEX_SIZE,
    height,
    svgWidth,
    scale,
  ]);

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
      // Only assign distinct palette colors to sub-regions with meaningful labels
      const labeledSubRegions = terr.subRegions.filter(
        (sr) => sr.label.trim().length > 0,
      );
      const sortedLabeled = [...labeledSubRegions].sort(
        (a, b) => b.totalTrials - a.totalTrials,
      );

      sortedLabeled.forEach((sr, index) => {
        const palette = getSubRegionPaletteColor(
          territoryColor,
          index,
          sortedLabeled.length,
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

      // Unlabeled sub-regions get territory base color (no visual distinction)
      for (const sr of terr.subRegions) {
        if (sr.label.trim().length > 0) continue;
        for (const cluster of sr.clusters) {
          if (!map.has(cluster.id)) {
            map.set(cluster.id, {
              territoryId: terr.id,
              subRegionId: sr.id,
              fill: territoryColor,
              stroke: territoryColor,
            });
          }
        }
      }
    }

    return map;
  }, [territories]);

  // Child sub-region visual: fill/stroke for clusters within the focused sub-region's children
  const clusterToChildSubRegionVisual = useMemo(() => {
    const map = new Map<
      number,
      { childId: number; fill: string; stroke: string }
    >();
    if (focusedSubRegionId === null) return map;

    // Resolve the focused sub-region through the path
    const focusedTerr = territories.find((t) => t.id === focusedTerritoryId);
    if (!focusedTerr) return map;

    let current: SubRegion | undefined;
    let regions: SubRegion[] = focusedTerr.subRegions;
    for (const id of focusedSubRegionPath) {
      current = regions.find((s) => s.id === id);
      if (!current) return map;
      regions = current.children;
    }
    if (!current || current.children.length === 0) return map;

    const srColor =
      clusterToSubRegionVisual.get(current.clusters[0]?.id)?.fill ??
      getTerritoryColor(focusedTerr.id);
    const sorted = [...current.children].sort(
      (a, b) => b.totalTrials - a.totalTrials,
    );
    sorted.forEach((child, index) => {
      const palette = getSubRegionPaletteColor(srColor, index, sorted.length);
      for (const c of child.clusters) {
        map.set(c.id, {
          childId: child.id,
          fill: palette.fill,
          stroke: palette.stroke,
        });
      }
    });
    return map;
  }, [
    territories,
    focusedTerritoryId,
    focusedSubRegionPath,
    focusedSubRegionId,
    clusterToSubRegionVisual,
  ]);

  // Active sub-region ID mapping: resolves cluster → sub-region ID at current drill depth.
  // At depth 0 (no path): maps to top-level sub-region IDs
  // At deeper depths: maps to children of the focused sub-region
  const clusterToActiveSubRegionId = useMemo(() => {
    const map = new Map<number, number>();
    if (focusedSubRegionPath.length === 0) {
      // Top-level: same as clusterToSubRegionId
      for (const terr of territories) {
        for (const sr of terr.subRegions) {
          for (const c of sr.clusters) map.set(c.id, sr.id);
        }
      }
    } else {
      // Resolve current focused sub-region and map its children
      const focusedTerr = territories.find((t) => t.id === focusedTerritoryId);
      if (focusedTerr) {
        let current: SubRegion | undefined;
        let regions: SubRegion[] = focusedTerr.subRegions;
        for (const id of focusedSubRegionPath) {
          current = regions.find((s) => s.id === id);
          if (!current) break;
          regions = current.children;
        }
        if (current && current.children.length > 0) {
          // Map clusters to child sub-region IDs
          for (const child of current.children) {
            for (const c of child.clusters) map.set(c.id, child.id);
          }
        } else if (current) {
          // Leaf: all clusters map to this sub-region
          for (const c of current.clusters) map.set(c.id, current.id);
        }
      }
    }
    return map;
  }, [territories, focusedTerritoryId, focusedSubRegionPath]);

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
      return { p80Coverage: 0, p80Marginal: 0, p80TrialCount: 0 };
    return {
      p80Coverage: qualPct(
        supported.map((m) => m.meanCoverage),
        80,
      ),
      p80Marginal: qualPct(
        supported.map((m) => m.meanMarginalCoverage),
        80,
      ),
      p80TrialCount: qualPct(
        supported.map((m) => m.trialCount),
        80,
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
      if (m.failureRate > 0.3) {
        label = "Failure-prone";
      } else if (hasSupport) {
        if (m.meanMarginalCoverage > clusterQualThresholds.p80Marginal) {
          label = "High Novelty";
        } else if (m.meanCoverage > clusterQualThresholds.p80Coverage) {
          label = "High Coverage";
        } else if (m.trialCount > clusterQualThresholds.p80TrialCount) {
          label = "High Density";
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

    // Use cluster-level meanBranchCoverage (same metric as coverage color mode)
    const clusterCovs = terr.clusters.map((c) => c.meanBranchCoverage);
    const terrAvgCov = clusterCovs.length > 0
      ? clusterCovs.reduce((s, v) => s + v, 0) / clusterCovs.length
      : 0;
    const terrMaxCov = clusterCovs.length > 0
      ? Math.max(...clusterCovs)
      : 0;
    const terrMinCov = clusterCovs.length > 0
      ? Math.min(...clusterCovs)
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

    return { terr, terrAvgCov, terrMaxCov, terrMinCov, subMetrics };
  }, [focusedTerritoryId, territories]);

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

  // Extract coverage value from cluster based on selected metric
  const getClusterCov = useCallback(
    (c: { meanBranchCoverage: number; maxBranchCoverage: number; trials: { coverage: number }[] }): number => {
      if (coverageMetric === "max") return c.maxBranchCoverage;
      if (coverageMetric === "min") {
        if (c.trials.length === 0) return 0;
        return Math.min(...c.trials.map((t) => t.coverage));
      }
      return c.meanBranchCoverage;
    },
    [coverageMetric],
  );

  // Global coverage range from clusters (used for all coverage displays)
  const globalCovRange = useMemo(() => {
    if (!data || data.clusters.length === 0) return { min: 0, max: 1, mean: 0.5 };
    const vals = data.clusters.map(getClusterCov);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    return { min: Math.min(...vals), max: Math.max(...vals), mean };
  }, [data, getClusterCov]);

  const getCoverageColor = useCallback(
    (coverage: number): string => {
      const red = "#DC2626";
      const low = "#FFFFFF";
      const high = "#16A34A";

      if (coverage <= 0) return red;
      const gMin = globalCovRange.min;
      const gMax = globalCovRange.max;
      const range = gMax - gMin;
      if (range <= 0) return low;
      const t = Math.max(0, Math.min(1, (coverage - gMin) / range));
      return d3.interpolateRgb(low, high)(t);
    },
    [globalCovRange],
  );

  // Compare mode: per-cluster mean coverage difference (A − B)
  const compareCovDiff = useMemo(() => {
    if (!data) return new Map<number, number>();
    const map = new Map<number, number>();
    for (const c of data.clusters) {
      const trialsA = c.trials.filter((t) => t.tuner === compareTunerA);
      const trialsB = c.trials.filter((t) => t.tuner === compareTunerB);
      const meanA = trialsA.length > 0 ? trialsA.reduce((s, t) => s + t.coverage, 0) / trialsA.length : null;
      const meanB = trialsB.length > 0 ? trialsB.reduce((s, t) => s + t.coverage, 0) / trialsB.length : null;
      if (meanA !== null && meanB !== null) {
        map.set(c.id, meanA - meanB);
      } else if (meanA !== null) {
        map.set(c.id, meanA);   // only A present → full A advantage
      } else if (meanB !== null) {
        map.set(c.id, -meanB);  // only B present → full B advantage
      }
      // neither present → not in map (will be gray)
    }
    return map;
  }, [data, compareTunerA, compareTunerB]);

  const compareDiffMax = useMemo(() => {
    const vals = [...compareCovDiff.values()];
    if (vals.length === 0) return 0.01;
    return Math.max(Math.abs(d3.min(vals) ?? 0), Math.abs(d3.max(vals) ?? 0)) || 0.01;
  }, [compareCovDiff]);

  const getCompareColor = useCallback(
    (diff: number): string => {
      const t = Math.max(-1, Math.min(1, diff / compareDiffMax));
      if (t > 0) {
        // A wins → blue
        return d3.interpolateRgb("#FFFFFF", "#2563EB")(t);
      } else if (t < 0) {
        // B wins → red
        return d3.interpolateRgb("#FFFFFF", "#DC2626")(-t);
      }
      return "#FFFFFF";
    },
    [compareDiffMax],
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

  // ── Canonical parameter type lists (from build_hex_graph.py) ──
  const BOOLEAN_PARAMS_SET = useMemo(
    () =>
      new Set([
        "disable-inlining",
        "max-memory-inhibit",
        "klee-call-optimisation",
        "use-construct-hash-stp",
        "use-visitor-hash",
        "equality-substitution",
        "check-overshift",
        "check-div-zero",
        "use-branch-cache",
        "use-independent-solver",
        "use-call-paths",
        "use-cex-cache",
        "use-forked-solver",
        "watchdog",
        "const-array-opt",
        "zero-seed-extension",
        "warnings-only-to-file",
        "smtlib-human-readable",
        "warn-all-external-symbols",
        "use-iterative-deepening-time-search",
        "cex-cache-exp",
        "all-external-warnings",
        "readable-posix-inputs",
        "return-null-on-zero-malloc",
        "emit-all-errors",
        "solver-optimize-divides",
        "cex-cache-try-all",
        "simplify-sym-indices",
        "named-seed-matching",
        "disable-verify",
        "track-instruction-time",
        "silent-klee-assume",
        "suppress-external-warnings",
        "cex-cache-superset",
        "verify-each",
      ]),
    [],
  );

  const CATEGORICAL_PARAMS_SET = useMemo(
    () =>
      new Set([
        "search",
        "switch-type",
        "smtlib-display-constants",
        "smtlib-abbreviation-mode",
        "seed-file",
      ]),
    [],
  );

  const getParamType = useCallback(
    (name: string): "boolean" | "numeric" | "categorical" => {
      if (BOOLEAN_PARAMS_SET.has(name)) return "boolean";
      if (CATEGORICAL_PARAMS_SET.has(name)) return "categorical";
      // One-hot encoded: "search__bfs", "switch-type__simple" etc.
      const base = name.split("__")[0];
      if (CATEGORICAL_PARAMS_SET.has(base)) return "categorical";
      return "numeric";
    },
    [BOOLEAN_PARAMS_SET, CATEGORICAL_PARAMS_SET],
  );


  // Detect selected parameter type
  const selectedParamType = useMemo(():
    | "boolean"
    | "numeric"
    | "categorical"
    | null => {
    if (!selectedParam) return null;
    return getParamType(selectedParam);
  }, [selectedParam, getParamType]);

  // ── Per-cluster param bin (boolean / categorical) ──
  // Generic string bin + dynamic color palette
  const MIXED_COLOR = "#e2e7ed";
  // Tableau20 — up to 20 visually distinct colors for categorical params
  const CAT_PALETTE = [
    "#4E79A7",
    "#F28E2B",
    "#E15759",
    "#76B7B2",
    "#59A14F",
    "#EDC948",
    "#B07AA1",
    "#FF9DA7",
    "#9C755F",
    "#BAB0AC",
    "#AF7AA1",
    "#86BCB6",
    "#D37295",
    "#FABFD2",
    "#B6992D",
    "#499894",
    "#E17C05",
    "#D4A6C8",
    "#8CD17D",
    "#F1CE63",
  ];

  const paramCellBins = useMemo((): {
    bins: Map<number, string>;
    binNames: string[];
    binColors: Record<string, string>;
  } | null => {
    if (!selectedParam || !data || !selectedParamType) return null;
    const ptype = selectedParamType;

    const bins = new Map<number, string>();

    if (ptype === "numeric") {
      const vals = data.clusters.map((c) => c.centroid[selectedParam] ?? 0);
      const sorted = [...vals].sort((a, b) => a - b);
      const min = sorted[0];
      const max = sorted[sorted.length - 1];
      const p33 = sorted[Math.floor(sorted.length / 3)];
      const p66 = sorted[Math.floor((sorted.length * 2) / 3)];
      const fmt = (v: number) =>
        v < 0.01 ? v.toFixed(3) : v < 1 ? v.toFixed(2) : v.toFixed(1);
      const lowLabel = `Low [${fmt(min)}–${fmt(p33)}]`;
      const midLabel = `Mid (${fmt(p33)}–${fmt(p66)}]`;
      const highLabel = `High (${fmt(p66)}–${fmt(max)}]`;
      for (const c of data.clusters) {
        const v = c.centroid[selectedParam] ?? 0;
        if (v <= p33) bins.set(c.id, lowLabel);
        else if (v <= p66) bins.set(c.id, midLabel);
        else bins.set(c.id, highLabel);
      }
      return {
        bins,
        binNames: [lowLabel, midLabel, highLabel],
        binColors: {
          [lowLabel]: "#BFDBFE", // light blue
          [midLabel]: "#3B82F6", // medium blue
          [highLabel]: "#1E3A8A", // dark blue
        },
      };
    }

    if (ptype === "boolean") {
      for (const c of data.clusters) {
        const v = c.centroid[selectedParam] ?? 0;
        if (v > 0.7) bins.set(c.id, "Mostly True");
        else if (v < 0.3) bins.set(c.id, "Mostly False");
        else bins.set(c.id, "Mixed");
      }
      return {
        bins,
        binNames: ["Mostly True", "Mixed", "Mostly False"],
        binColors: {
          "Mostly True": "#10B981",
          Mixed: MIXED_COLOR,
          "Mostly False": "#F59E0B",
        },
      };
    }

    // Categorical: find all one-hot keys for this param
    const prefix = selectedParam + "__";
    const catKeys = Object.keys(data.clusters[0].centroid)
      .filter((k) => k.startsWith(prefix))
      .sort();
    if (catKeys.length === 0) return null;

    const catValues = catKeys.map((k) => k.slice(prefix.length));

    for (const c of data.clusters) {
      let maxVal = -1;
      let dominant = "";
      let secondMax = -1;
      for (const k of catKeys) {
        const v = c.centroid[k] ?? 0;
        if (v > maxVal) {
          secondMax = maxVal;
          maxVal = v;
          dominant = k.slice(prefix.length);
        } else if (v > secondMax) {
          secondMax = v;
        }
      }
      // "Mixed" if no clear dominant (top < 0.5 or gap < 0.15)
      if (maxVal < 0.45 || maxVal - secondMax < 0.15) {
        bins.set(c.id, "Mixed");
      } else {
        bins.set(c.id, dominant);
      }
    }

    const binColors: Record<string, string> = { Mixed: MIXED_COLOR };
    catValues.forEach((v, i) => {
      binColors[v] = CAT_PALETTE[i % CAT_PALETTE.length];
    });
    const binNames = [...catValues, "Mixed"];

    return { bins, binNames, binColors };
  }, [selectedParam, selectedParamType, data]);

  // Get hex fill
  const getHexFill = useCallback(
    (tile: HexTile): string | null => {
      if (!tile.cluster) return "#F1F5F9";

      // When a boolean/categorical param is selected, tint by bin
      if (paramCellBins) {
        const bin = paramCellBins.bins.get(tile.cluster.id);
        if (bin) {
          const binColor = paramCellBins.binColors[bin] ?? MIXED_COLOR;
          return mixHexColors("#F8FAFC", binColor, 0.35);
        }
        return "#F1F5F9";
      }

      const { tunerCounts } = tile.cluster;

      // Solo tuner: dim cells where the solo'd tuner has no trials
      if (soloTuner && tunerCounts[soloTuner] === 0) {
        return "#F1F5F9";
      }

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
          return getCoverageColor(getClusterCov(tile.cluster));

        case "compare": {
          const diff = compareCovDiff.get(tile.cluster.id);
          if (diff === undefined) return "#F1F5F9";
          return getCompareColor(diff);
        }

        case "territory":
          return "#F8FAFC";

        case "pixel":
        default: {
          const terrId = clusterToTerrId.get(tile.cluster.id);

          // Overview: territory colors
          if (focusedTerritoryId === null) {
            return terrId != null ? getTerritoryColor(terrId) : "#F8FAFC";
          }

          // Territory focused: full color inside, muted outside
          if (terrId === focusedTerritoryId) {
            return terrId != null ? getTerritoryColor(terrId) : "#F8FAFC";
          }
          return terrId != null
            ? mixHexColors(getTerritoryColor(terrId), "#E2E8F0", 0.6)
            : "#F1F5F9";
        }
      }
    },
    [
      effectiveColorMode,
      clusterToSubRegionVisual,
      clusterToChildSubRegionVisual,
      clusterToSubRegionId,
      clusterToTerrId,
      focusedTerritoryId,
      focusedSubRegionId,
      densityScale,
      getCoverageColor,
      getClusterCov,
      getMarginalCoverageColor,
      selectedTuners,
      paramCellBins,
      compareCovDiff,
      getCompareColor,
      soloTuner,
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
  // Compare mode: boundary paths for tuner A and tuner B regions
  const compareBoundaries = useMemo(() => {
    if (!data || effectiveColorMode !== "compare")
      return { a: "", b: "" };

    const verts = Array.from({ length: 6 }, (_, i) => ({
      x: HEX_SIZE * Math.cos((i * Math.PI) / 3),
      y: HEX_SIZE * Math.sin((i * Math.PI) / 3),
    }));

    // Build sets of hex keys where each tuner has trials
    const hexHasA = new Set<string>();
    const hexHasB = new Set<string>();
    for (const tile of data.hexTiles) {
      if (!tile.cluster) continue;
      const k = `${tile.q},${tile.r}`;
      if (tile.cluster.tunerCounts[compareTunerA] > 0) hexHasA.add(k);
      if (tile.cluster.tunerCounts[compareTunerB] > 0) hexHasB.add(k);
    }

    // Build boundary path: edges where a cell in the set neighbors one NOT in the set
    const buildPath = (hexSet: Set<string>) => {
      let d = "";
      for (const tile of data.hexTiles) {
        const k = `${tile.q},${tile.r}`;
        if (!hexSet.has(k)) continue;
        for (let ei = 0; ei < 6; ei++) {
          const dir = HEX_DIRECTIONS[ei];
          const nk = `${tile.q + dir.dq},${tile.r + dir.dr}`;
          if (!hexSet.has(nk)) {
            const va = verts[ei];
            const vb = verts[(ei + 1) % 6];
            d += `M${tile.x + va.x},${tile.y + va.y}L${tile.x + vb.x},${tile.y + vb.y}`;
          }
        }
      }
      return d;
    };

    return { a: buildPath(hexHasA), b: buildPath(hexHasB) };
  }, [data, effectiveColorMode, compareTunerA, compareTunerB, HEX_SIZE, HEX_DIRECTIONS]);

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
        // Only draw sub-region boundaries for labeled sub-regions
        if (!sr.label.trim()) continue;
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
          if (!visibleHex.has(tk)) continue;
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
              macroD += seg;
            } else if (nSub && nSub.srId !== sr.id) {
              subD += seg;
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

  // Outer boundary of the focused sub-region (all edges that touch outside)
  const focusedSubRegionBorder = useMemo(() => {
    if (focusedSubRegionId === null || focusedTerritoryId === null || !data)
      return "";
    const focusedTerr = territories.find((t) => t.id === focusedTerritoryId);
    if (!focusedTerr) return "";
    const focusedSr = focusedTerr.subRegions.find(
      (s) => s.id === focusedSubRegionId,
    );
    if (!focusedSr) return "";
    // Collect all tile keys belonging to focused sub-region
    const srTileKeys = new Set<string>();
    for (const tile of focusedSr.tiles) {
      const k = `${tile.q},${tile.r}`;
      if (
        tile.cluster &&
        TUNER_NAMES.some(
          (t) => selectedTuners.has(t) && tile.cluster!.tunerCounts[t] > 0,
        )
      )
        srTileKeys.add(k);
    }
    const verts = Array.from({ length: 6 }, (_, i) => ({
      x: HEX_SIZE * Math.cos((i * Math.PI) / 3),
      y: HEX_SIZE * Math.sin((i * Math.PI) / 3),
    }));
    let d = "";
    for (const tile of focusedSr.tiles) {
      const tk = `${tile.q},${tile.r}`;
      if (!srTileKeys.has(tk)) continue;
      for (let ei = 0; ei < 6; ei++) {
        const dir = HEX_DIRECTIONS[ei];
        const nk = `${tile.q + dir.dq},${tile.r + dir.dr}`;
        if (!srTileKeys.has(nk)) {
          const va = verts[ei];
          const vb = verts[(ei + 1) % 6];
          d += `M${tile.x + va.x},${tile.y + va.y}L${tile.x + vb.x},${tile.y + vb.y}`;
        }
      }
    }
    return d;
  }, [
    focusedSubRegionId,
    focusedTerritoryId,
    data,
    territories,
    HEX_DIRECTIONS,
    selectedTuners,
    HEX_SIZE,
  ]);

  // Hovered sub-region outer border (works across all color modes)
  const hoveredSubRegionBorder = useMemo(() => {
    if (hoveredSubRegionId === null || focusedTerritoryId === null || !data)
      return "";
    // Don't draw hover border if this is the already-focused sub-region (it has its own border)
    if (hoveredSubRegionId === focusedSubRegionId) return "";
    const terr = territories.find((t) => t.id === focusedTerritoryId);
    if (!terr) return "";
    const sr = terr.subRegions.find((s) => s.id === hoveredSubRegionId);
    if (!sr) return "";
    const srTileKeys = new Set<string>();
    for (const tile of sr.tiles) {
      if (
        tile.cluster &&
        TUNER_NAMES.some(
          (t) => selectedTuners.has(t) && tile.cluster!.tunerCounts[t] > 0,
        )
      )
        srTileKeys.add(`${tile.q},${tile.r}`);
    }
    const verts = Array.from({ length: 6 }, (_, i) => ({
      x: HEX_SIZE * Math.cos((i * Math.PI) / 3),
      y: HEX_SIZE * Math.sin((i * Math.PI) / 3),
    }));
    let d = "";
    for (const tile of sr.tiles) {
      const tk = `${tile.q},${tile.r}`;
      if (!srTileKeys.has(tk)) continue;
      for (let ei = 0; ei < 6; ei++) {
        const dir = HEX_DIRECTIONS[ei];
        const nk = `${tile.q + dir.dq},${tile.r + dir.dr}`;
        if (!srTileKeys.has(nk)) {
          const va = verts[ei];
          const vb = verts[(ei + 1) % 6];
          d += `M${tile.x + va.x},${tile.y + va.y}L${tile.x + vb.x},${tile.y + vb.y}`;
        }
      }
    }
    return d;
  }, [
    hoveredSubRegionId,
    focusedSubRegionId,
    focusedTerritoryId,
    data,
    territories,
    HEX_DIRECTIONS,
    selectedTuners,
    HEX_SIZE,
  ]);

  // ============================================================
  // Label placement helpers
  // ============================================================

  // Active rendering scale — uses zoom level when focused on a territory
  const renderScale = viewFocus ? viewFocus.zoomScale : scale;
  const renderCenter = useMemo(
    () => (viewFocus ? { x: viewFocus.cx, y: viewFocus.cy } : dataCenter),
    [viewFocus, dataCenter],
  );

  /** Visible viewport in data-space coordinates (with margin for labels) */
  const viewBounds = useMemo(() => {
    const margin = 8 / renderScale;
    const halfW = svgWidth / 2 / renderScale;
    const halfH = (height - 80) / 2 / renderScale;
    return {
      minX: renderCenter.x - halfW + margin,
      maxX: renderCenter.x + halfW - margin,
      minY: renderCenter.y - halfH + margin,
      maxY: renderCenter.y + halfH - margin,
    };
  }, [renderCenter, svgWidth, height, renderScale]);

  /** Check if a rectangle overlaps any hex tile */
  const labelOverlapsTiles = useCallback(
    (lx: number, ly: number, lw: number, lh: number): boolean => {
      if (!data) return false;
      const hr = HEX_SIZE * 0.9;
      for (const tile of data.hexTiles) {
        if (!tile.cluster) continue;
        if (
          lx < tile.x + hr &&
          lx + lw > tile.x - hr &&
          ly < tile.y + hr &&
          ly + lh > tile.y - hr
        )
          return true;
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
    if (!data) return [];

    const fs = 10 / renderScale;
    const pad = 4 / renderScale;
    const lineH = fs * 1.3;
    const charW = fs * 0.56;
    const gap = fs * 2;

    type Bbox = { x: number; y: number; w: number; h: number };
    function bbOverlaps(a: Bbox, b: Bbox) {
      return (
        a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
      );
    }
    const placed: Bbox[] = [];
    const results: {
      sr: SubRegion;
      x: number;
      y: number;
      rw: number;
      rh: number;
      lines: string[];
      color: string;
      anchorX: number;
      anchorY: number;
    }[] = [];

    // When focused on a territory, only show that territory's sub-region labels
    const targetTerritories =
      focusedTerritoryId !== null
        ? territories.filter((t) => t.id === focusedTerritoryId)
        : territories;

    for (const terr of targetTerritories) {
      // Skip if territory has only 1 sub-region (nothing to differentiate)
      if (terr.subRegions.length <= 1) continue;

      // Territory-level bounding box — labels go outside ALL tiles
      const allTxs = terr.tiles.map((t) => t.x);
      const allTys = terr.tiles.map((t) => t.y);
      const tMinX = Math.min(...allTxs) - HEX_SIZE;
      const tMaxX = Math.max(...allTxs) + HEX_SIZE;
      const tMinY = Math.min(...allTys) - HEX_SIZE;
      const tMaxY = Math.max(...allTys) + HEX_SIZE;

      // When a parameter is selected, compute per-sub-region param summary
      const srParamLabel = new Map<number, string>();
      if (selectedParam) {
        for (const sr of terr.subRegions) {
          if (sr.clusters.length === 0) continue;
          const vals = sr.clusters.map((c) => c.centroid[selectedParam] ?? 0);
          const isBoolean = vals.every((v) => v < 0.05 || v > 0.95);
          if (isBoolean) {
            const trueCount = vals.filter((v) => v > 0.5).length;
            const pct = Math.round((trueCount / vals.length) * 100);
            srParamLabel.set(
              sr.id,
              pct > 50
                ? `${selectedParam}=T (${pct}%)`
                : `${selectedParam}=F (${100 - pct}%)`,
            );
          } else {
            const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
            const min = Math.min(...vals);
            const max = Math.max(...vals);
            const range = max - min;
            srParamLabel.set(
              sr.id,
              range < 0.01
                ? `${selectedParam} ≈ ${mean.toFixed(2)}`
                : `${selectedParam}: ${mean.toFixed(2)} [${min.toFixed(2)}–${max.toFixed(2)}]`,
            );
          }
        }
      }

      const sorted = [...terr.subRegions]
        .filter((sr) =>
          selectedParam ? srParamLabel.has(sr.id) : sr.label.trim().length > 0,
        )
        .sort((a, b) => b.totalTrials - a.totalTrials);

      for (const sr of sorted) {
        const labelText = selectedParam
          ? (srParamLabel.get(sr.id) ?? "")
          : sr.label;
        const lines = labelText.split(", ");
        const maxLineLen = Math.max(...lines.map((l) => l.length));
        const rw = maxLineLen * charW + pad * 2;
        const rh = lines.length * lineH + pad * 2;
        const anchorX = sr.pixelCentroidX;
        const anchorY = sr.pixelCentroidY;
        const margin = HEX_SIZE * 0.6;

        // Sort edges by distance from sub-region centroid → closest edge first
        const edgeDists: { dir: string; dist: number }[] = [
          { dir: "left", dist: Math.abs(anchorX - tMinX) },
          { dir: "right", dist: Math.abs(anchorX - tMaxX) },
          { dir: "above", dist: Math.abs(anchorY - tMinY) },
          { dir: "below", dist: Math.abs(anchorY - tMaxY) },
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
            x: c.x - rw / 2 - gap,
            y: c.y - rh / 2 - gap,
            w: rw + gap * 2,
            h: rh + gap * 2,
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
              left: { x: tMinX - margin - em - rw / 2, y: anchorY },
              above: { x: anchorX, y: tMinY - margin - em - rh / 2 },
              right: { x: tMaxX + margin + em + rw / 2, y: anchorY },
              below: { x: anchorX, y: tMaxY + margin + em + rh / 2 },
            };
            const fbCandidates = edgeDists.map(({ dir }) => fbEdge[dir]);
            for (const c of fbCandidates) {
              const b: Bbox = {
                x: c.x - rw / 2 - gap,
                y: c.y - rh / 2 - gap,
                w: rw + gap * 2,
                h: rh + gap * 2,
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
          }
        }

        // Last resort: don't show rather than overlap tiles
        if (!chosen) {
          continue;
        }

        results.push({
          sr,
          x: chosen.x,
          y: chosen.y,
          rw,
          rh,
          lines,
          color: getTerritoryColor(terr.id),
          anchorX,
          anchorY,
        });
      }
    }
    return results;
  }, [
    focusedTerritoryId,
    territories,
    renderScale,
    data,
    HEX_SIZE,
    labelInsideView,
    selectedParam,
  ]);

  // ============================================================
  // Child sub-region labels — shown when a sub-region with children is focused
  // ============================================================
  const detailLabelPositions = useMemo(() => {
    if (focusedSubRegionId === null || focusedTerritoryId === null || !data)
      return [];
    const parentTerr =
      territories.find((t) => t.id === focusedTerritoryId) ?? null;
    if (!parentTerr) return [];

    // Resolve focused sub-region through the path
    let targetSr: SubRegion | undefined;
    let regions: SubRegion[] = parentTerr.subRegions;
    for (const id of focusedSubRegionPath) {
      targetSr = regions.find((s) => s.id === id);
      if (!targetSr) return [];
      regions = targetSr.children;
    }
    if (!targetSr || targetSr.children.length <= 1) return [];

    const fs = 9 / renderScale;
    const pad = 3 / renderScale;
    const lineH = fs * 1.3;
    const charW = fs * 0.56;
    const gap = fs * 1.5;

    type Bbox = { x: number; y: number; w: number; h: number };
    function bbOverlaps(a: Bbox, b: Bbox) {
      return (
        a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
      );
    }
    const placed: Bbox[] = [];

    // Sub-region bounding box
    const allTxs = targetSr.tiles.map((t) => t.x);
    const allTys = targetSr.tiles.map((t) => t.y);
    const bMinX = Math.min(...allTxs) - HEX_SIZE;
    const bMaxX = Math.max(...allTxs) + HEX_SIZE;
    const bMinY = Math.min(...allTys) - HEX_SIZE;
    const bMaxY = Math.max(...allTys) + HEX_SIZE;

    const results: {
      dr: SubRegion;
      x: number;
      y: number;
      rw: number;
      rh: number;
      lines: string[];
      color: string;
      anchorX: number;
      anchorY: number;
    }[] = [];

    const sorted = [...targetSr.children]
      .filter((child) => child.label.trim().length > 0)
      .sort((a, b) => b.totalTrials - a.totalTrials);

    for (const child of sorted) {
      const lines = child.label.split(", ");
      const maxLineLen = Math.max(...lines.map((l) => l.length));
      const rw = maxLineLen * charW + pad * 2;
      const rh = lines.length * lineH + pad * 2;
      const anchorX = child.pixelCentroidX;
      const anchorY = child.pixelCentroidY;
      const margin = HEX_SIZE * 0.5;

      const edgeDists: { dir: string; dist: number }[] = [
        { dir: "left", dist: Math.abs(anchorX - bMinX) },
        { dir: "right", dist: Math.abs(anchorX - bMaxX) },
        { dir: "above", dist: Math.abs(anchorY - bMinY) },
        { dir: "below", dist: Math.abs(anchorY - bMaxY) },
      ];
      edgeDists.sort((a, b) => a.dist - b.dist);

      const edgeCandidates: Record<string, { x: number; y: number }[]> = {
        left: [{ x: bMinX - margin - rw / 2, y: anchorY }],
        above: [{ x: anchorX, y: bMinY - margin - rh / 2 }],
        right: [{ x: bMaxX + margin + rw / 2, y: anchorY }],
        below: [{ x: anchorX, y: bMaxY + margin + rh / 2 }],
      };

      const candidates: { x: number; y: number }[] = [];
      for (const { dir } of edgeDists) candidates.push(...edgeCandidates[dir]);

      let chosen: { x: number; y: number } | null = null;
      for (const c of candidates) {
        const b: Bbox = {
          x: c.x - rw / 2 - gap,
          y: c.y - rh / 2 - gap,
          w: rw + gap * 2,
          h: rh + gap * 2,
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
      if (!chosen) continue;

      const childVisual = clusterToChildSubRegionVisual.get(
        child.clusters[0]?.id,
      );
      results.push({
        dr: child,
        x: chosen.x,
        y: chosen.y,
        rw,
        rh,
        lines,
        color: childVisual?.stroke ?? getTerritoryColor(parentTerr.id),
        anchorX,
        anchorY,
      });
    }
    return results;
  }, [
    focusedSubRegionId,
    focusedSubRegionPath,
    territories,
    renderScale,
    data,
    HEX_SIZE,
    labelInsideView,
    clusterToChildSubRegionVisual,
  ]);

  // ============================================================
  // Macro label placement — just outside each territory's own
  // bounding box, close to it, with leader lines to centroid.
  // ============================================================
  const macroLabelPositions = useMemo(() => {
    if (!data) return [];

    const fs = 11 / renderScale;
    const pad = 5 / renderScale;
    const lineH = fs * 1.3;
    const charW = fs * 0.58;
    const gap = fs * 2;

    type Bbox = { x: number; y: number; w: number; h: number };
    type LPos = {
      terr: Territory;
      lines: string[];
      x: number;
      y: number;
      rw: number;
      rh: number;
      anchorX: number;
      anchorY: number;
    };

    function bbOverlaps(a: Bbox, b: Bbox) {
      return (
        a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
      );
    }

    // When a parameter is selected, compute per-territory param summary label
    const terrParamLabel = new Map<number, string>();
    if (selectedParam) {
      for (const t of territories) {
        if (t.clusters.length === 0) continue;
        const vals = t.clusters.map((c) => c.centroid[selectedParam] ?? 0);
        const isBoolean = vals.every((v) => v < 0.05 || v > 0.95);
        if (isBoolean) {
          const trueCount = vals.filter((v) => v > 0.5).length;
          const pct = Math.round((trueCount / vals.length) * 100);
          terrParamLabel.set(
            t.id,
            pct > 50
              ? `${selectedParam}=T (${pct}%)`
              : `${selectedParam}=F (${100 - pct}%)`,
          );
        } else {
          const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
          const min = Math.min(...vals);
          const max = Math.max(...vals);
          const range = max - min;
          terrParamLabel.set(
            t.id,
            range < 0.01
              ? `${selectedParam} ≈ ${mean.toFixed(2)}`
              : `${selectedParam}: ${mean.toFixed(2)} [${min.toFixed(2)}–${max.toFixed(2)}]`,
          );
        }
      }
    }

    const sorted = [...territories]
      .filter(
        (t) =>
          (selectedParam ? terrParamLabel.has(t.id) : t.label) &&
          t.tiles.length > 0,
      )
      .sort((a, b) => b.tiles.length - a.tiles.length);

    const placed: Bbox[] = [];
    const results: LPos[] = [];

    for (const t of sorted) {
      const labelText = selectedParam
        ? (terrParamLabel.get(t.id) ?? "")
        : t.label;
      const lines = labelText.split(", ");
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
        { x: tMinX - margin - rw / 2, y: anchorY }, // left
        { x: anchorX, y: tMinY - margin - rh / 2 }, // above
        { x: tMaxX + margin + rw / 2, y: anchorY }, // right
        { x: anchorX, y: tMaxY + margin + rh / 2 }, // below
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
          x: c.x - rw / 2 - gap / 2,
          y: c.y - rh / 2 - gap / 2,
          w: rw + gap,
          h: rh + gap,
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
          { x: -1, y: 0 },
          { x: 0, y: -1 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
          { x: -0.7, y: -0.7 },
          { x: 0.7, y: -0.7 },
          { x: 0.7, y: 0.7 },
          { x: -0.7, y: 0.7 },
        ];
        for (const mult of [3, 4.5, 6, 8]) {
          if (chosen) break;
          const dist = HEX_SIZE * mult;
          for (const d of dirs) {
            const cx = anchorX + d.x * dist;
            const cy = anchorY + d.y * dist;
            const fb: Bbox = {
              x: cx - rw / 2 - gap / 2,
              y: cy - rh / 2 - gap / 2,
              w: rw + gap,
              h: rh + gap,
            };
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
            const fb: Bbox = {
              x: cx - rw / 2 - gap / 2,
              y: cy - rh / 2 - gap / 2,
              w: rw + gap,
              h: rh + gap,
            };
            if (
              labelInsideView(cx, cy, rw, rh) &&
              !placed.some((p) => bbOverlaps(fb, p))
            ) {
              chosen = { x: cx, y: cy };
              placed.push(fb);
              break;
            }
          }
        }
        if (!chosen) {
          chosen = { x: anchorX, y: anchorY };
          placed.push({
            x: anchorX - rw / 2 - gap / 2,
            y: anchorY - rh / 2 - gap / 2,
            w: rw + gap,
            h: rh + gap,
          });
        }
      }

      results.push({
        terr: t,
        lines,
        x: chosen.x,
        y: chosen.y,
        rw,
        rh,
        anchorX,
        anchorY,
      });
    }

    return results;
  }, [
    data,
    territories,
    renderScale,
    HEX_SIZE,
    labelOverlapsTiles,
    labelInsideView,
    selectedParam,
  ]);

  // ── Per-cell qualitative label positions (outside tiles, with leader lines) ──
  // Runs AFTER macroLabelPositions so it can reserve their bboxes to avoid overlap.
  const qualCellLabelPositions = useMemo(() => {
    if (!data) return [];

    const fs = 9 / renderScale;
    const pad = 4 / renderScale;
    const charW = fs * 0.56;
    const gap = fs * 1.5;

    type Bbox = { x: number; y: number; w: number; h: number };
    function bbOverlaps(a: Bbox, b: Bbox) {
      return (
        a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
      );
    }

    // Pre-populate placed bboxes from macro parameter labels → no overlap
    const placed: Bbox[] = [];
    const macroGap = (11 / renderScale) * 2;
    for (const ml of macroLabelPositions) {
      placed.push({
        x: ml.x - ml.rw / 2 - macroGap / 2,
        y: ml.y - ml.rh / 2 - macroGap / 2,
        w: ml.rw + macroGap,
        h: ml.rh + macroGap,
      });
    }

    // Build cluster → tile lookup
    const cidToTile = new Map<number, HexTile>();
    for (const tile of data.hexTiles) {
      if (tile.cluster) cidToTile.set(tile.cluster.id, tile);
    }

    // Independently pick the single most extreme cluster per category.
    // No waterfall — each category selects its own best representative.
    type Candidate = {
      clusterId: number;
      label: QualitativeLabel;
      color: string;
      anchorX: number;
      anchorY: number;
      trialCount: number;
    };

    // Gather all visible clusters with sufficient support
    type VisibleCluster = {
      cid: number;
      tile: HexTile;
      m: SRMetrics;
    };
    const visible: VisibleCluster[] = [];
    for (const [cid, m] of clusterQualMetrics) {
      if (m.trialCount < 2) continue;
      const tile = cidToTile.get(cid);
      if (!tile?.cluster) continue;
      if (
        !TUNER_NAMES.some(
          (t) => selectedTuners.has(t) && tile.cluster!.tunerCounts[t] > 0,
        )
      )
        continue;
      visible.push({ cid, tile, m });
    }

    const rawPicks: Candidate[] = [];

    // Helper: pick best cluster for a category (same cell can be picked for multiple)
    const pickBest = (
      label: QualitativeLabel,
      filter: (v: VisibleCluster) => boolean,
      rank: (v: VisibleCluster) => number, // higher = more extreme
    ) => {
      if (!selectedQualLabels.has(label)) return;
      let best: VisibleCluster | null = null;
      let bestScore = -Infinity;
      for (const v of visible) {
        if (!filter(v)) continue;
        const score = rank(v);
        if (score > bestScore) {
          bestScore = score;
          best = v;
        }
      }
      if (best) {
        rawPicks.push({
          clusterId: best.cid,
          label,
          color: QUAL_LABEL_COLORS[label],
          anchorX: best.tile.x,
          anchorY: best.tile.y,
          trialCount: best.m.trialCount,
        });
      }
    };

    // No threshold filter — just pick the single most extreme cluster per category.
    pickBest(
      "Failure-prone",
      (v) => v.m.failureRate > 0,
      (v) => v.m.failureRate,
    );
    pickBest(
      "High Novelty",
      () => true,
      (v) => v.m.meanMarginalCoverage,
    );
    pickBest(
      "High Coverage",
      () => true,
      (v) => v.m.meanCoverage,
    );
    pickBest(
      "High Density",
      () => true,
      (v) => v.m.trialCount,
    );

    // Group by clusterId — same cell may qualify for multiple labels
    const grouped = new Map<
      number,
      {
        labels: { label: QualitativeLabel; color: string }[];
        anchorX: number;
        anchorY: number;
      }
    >();
    for (const p of rawPicks) {
      const existing = grouped.get(p.clusterId);
      if (existing) {
        existing.labels.push({ label: p.label, color: p.color });
      } else {
        grouped.set(p.clusterId, {
          labels: [{ label: p.label, color: p.color }],
          anchorX: p.anchorX,
          anchorY: p.anchorY,
        });
      }
    }

    type QualLabelPos = {
      id: number;
      cx: number;
      cy: number;
      anchorX: number;
      anchorY: number;
      lines: { label: QualitativeLabel; color: string }[];
      rw: number;
      rh: number;
    };
    const results: QualLabelPos[] = [];

    const offsets = [
      { x: 0, y: -1 },
      { x: 0, y: 1 },
      { x: -1, y: 0 },
      { x: 1, y: 0 },
      { x: -0.7, y: -0.7 },
      { x: 0.7, y: -0.7 },
      { x: -0.7, y: 0.7 },
      { x: 0.7, y: 0.7 },
    ];

    const lineH = fs * 1.3;
    for (const [clusterId, group] of grouped) {
      const { labels, anchorX, anchorY } = group;
      const maxLabelLen = Math.max(...labels.map((l) => l.label.length));
      const rw = maxLabelLen * charW + pad * 2;
      const rh = labels.length * lineH + pad * 2;

      let chosen: { x: number; y: number } | null = null;
      // Start far from the cell so labels land in empty background space
      for (const mult of [5, 7, 10, 14, 18]) {
        if (chosen) break;
        const dist = HEX_SIZE * mult;
        for (const d of offsets) {
          const px = anchorX + d.x * dist;
          const py = anchorY + d.y * dist;
          const bb: Bbox = {
            x: px - rw / 2 - gap,
            y: py - rh / 2 - gap,
            w: rw + gap * 2,
            h: rh + gap * 2,
          };
          if (
            labelInsideView(px, py, rw, rh) &&
            !placed.some((p) => bbOverlaps(bb, p)) &&
            !labelOverlapsTiles(bb.x, bb.y, bb.w, bb.h)
          ) {
            chosen = { x: px, y: py };
            placed.push(bb);
            break;
          }
        }
      }
      // Fallback: allow tile overlap at far distance
      if (!chosen) {
        for (const mult of [8, 12, 16]) {
          if (chosen) break;
          const dist = HEX_SIZE * mult;
          for (const d of offsets) {
            const px = anchorX + d.x * dist;
            const py = anchorY + d.y * dist;
            const bb: Bbox = {
              x: px - rw / 2 - gap,
              y: py - rh / 2 - gap,
              w: rw + gap * 2,
              h: rh + gap * 2,
            };
            if (
              labelInsideView(px, py, rw, rh) &&
              !placed.some((p) => bbOverlaps(bb, p))
            ) {
              chosen = { x: px, y: py };
              placed.push(bb);
              break;
            }
          }
        }
      }

      if (!chosen) continue;

      results.push({
        id: clusterId,
        cx: chosen.x,
        cy: chosen.y,
        anchorX,
        anchorY,
        lines: labels,
        rw,
        rh,
      });
    }

    return results;
  }, [
    data,
    clusterQualMetrics,
    selectedQualLabels,
    selectedTuners,
    renderScale,
    HEX_SIZE,
    labelInsideView,
    labelOverlapsTiles,
    macroLabelPositions,
  ]);

  // ── Parameter names from cluster centroids ──
  const paramNames = useMemo(() => {
    if (!data || data.clusters.length === 0) return [];
    const rawKeys = Object.keys(data.clusters[0].centroid);
    // Collapse one-hot categorical keys ("search__bfs", "search__dfs") → "search"
    const seen = new Set<string>();
    const names: string[] = [];
    for (const k of rawKeys) {
      const base = k.split("__")[0];
      if (!seen.has(base)) {
        seen.add(base);
        names.push(base);
      }
    }
    return names.sort();
  }, [data]);

  // ── Boundary path between different param bins ──
  const paramBinBoundaryPath = useMemo((): string | null => {
    if (!paramCellBins || !data) return null;
    const tileBin = new Map<string, string>();
    for (const tile of data.hexTiles) {
      if (!tile.cluster) continue;
      const bin = paramCellBins.bins.get(tile.cluster.id);
      if (bin) tileBin.set(`${tile.q},${tile.r}`, bin);
    }
    const verts = Array.from({ length: 6 }, (_, i) => ({
      x: HEX_SIZE * Math.cos((i * Math.PI) / 3),
      y: HEX_SIZE * Math.sin((i * Math.PI) / 3),
    }));
    let d = "";
    for (const tile of data.hexTiles) {
      const tk = `${tile.q},${tile.r}`;
      const myBin = tileBin.get(tk);
      if (!myBin) continue;
      for (let ei = 0; ei < 6; ei++) {
        const dir = HEX_DIRECTIONS[ei];
        const nk = `${tile.q + dir.dq},${tile.r + dir.dr}`;
        const nBin = tileBin.get(nk);
        if (nBin !== undefined && nBin !== myBin) {
          const va = verts[ei];
          const vb = verts[(ei + 1) % 6];
          d += `M${tile.x + va.x},${tile.y + va.y}L${tile.x + vb.x},${tile.y + vb.y}`;
        }
      }
    }
    return d || null;
  }, [paramCellBins, data, HEX_SIZE, HEX_DIRECTIONS]);

  // ── BFS connected regions per bin with centroids for labels ──
  const paramBinRegions = useMemo((): {
    bin: string;
    cx: number;
    cy: number;
    tileCount: number;
  }[] => {
    if (!paramCellBins || !data) return [];
    const tileBin = new Map<string, string>();
    const tilePixel = new Map<string, { x: number; y: number }>();
    for (const tile of data.hexTiles) {
      if (!tile.cluster) continue;
      const bin = paramCellBins.bins.get(tile.cluster.id);
      if (bin) {
        const k = `${tile.q},${tile.r}`;
        tileBin.set(k, bin);
        tilePixel.set(k, { x: tile.x, y: tile.y });
      }
    }
    const visited = new Set<string>();
    const regions: {
      bin: string;
      cx: number;
      cy: number;
      tileCount: number;
    }[] = [];
    for (const [startKey, bin] of tileBin) {
      if (visited.has(startKey)) continue;
      const queue = [startKey];
      visited.add(startKey);
      let sumX = 0,
        sumY = 0,
        count = 0;
      while (queue.length > 0) {
        const key = queue.shift()!;
        const px = tilePixel.get(key)!;
        sumX += px.x;
        sumY += px.y;
        count++;
        const [qStr, rStr] = key.split(",");
        const q = parseInt(qStr, 10);
        const r = parseInt(rStr, 10);
        for (const { dq, dr } of HEX_DIRECTIONS) {
          const nk = `${q + dq},${r + dr}`;
          if (!visited.has(nk) && tileBin.get(nk) === bin) {
            visited.add(nk);
            queue.push(nk);
          }
        }
      }
      regions.push({
        bin,
        cx: sumX / count,
        cy: sumY / count,
        tileCount: count,
      });
    }
    // Keep only the largest CC per bin for labeling
    const bestPerBin = new Map<string, (typeof regions)[0]>();
    for (const r of regions) {
      const existing = bestPerBin.get(r.bin);
      if (!existing || r.tileCount > existing.tileCount)
        bestPerBin.set(r.bin, r);
    }
    return Array.from(bestPerBin.values());
  }, [paramCellBins, data, HEX_DIRECTIONS]);

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
  const handleMouseEnter = useCallback(
    (tile: HexTile, e: React.MouseEvent) => {
      if (!tile.cluster) return;
      setHoveredClusterId(tile.cluster.id);
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect)
        setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      // Highlight territory
      const tId = clusterToTerrId.get(tile.cluster.id) ?? null;
      setHoveredTerritoryId(tId);
    },
    [clusterToTerrId],
  );

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect)
      setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoveredClusterId(null);
    setHoveredSubRegionId(null);
    setHoveredTerritoryId(null);
    setTooltipPos(null);
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
    <div
      ref={containerRef}
      style={{ position: "relative", width: "100%", height: "100%" }}
    >
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
          {/* ===== HEX GRID ===== */}
          <g
            style={{
              transform: viewFocus
                ? `translate(${centerX}px, ${centerY}px) scale(${viewFocus.zoomScale}) translate(${-viewFocus.cx}px, ${-viewFocus.cy}px)`
                : `translate(${centerX}px, ${centerY}px) scale(${scale}) translate(${-dataCenter.x}px, ${-dataCenter.y}px)`,
              transition: "transform 600ms cubic-bezier(0.4, 0, 0.2, 1)",
            }}
          >
            {/* Transparent background — click clears focus */}
            <rect
              x={-50000}
              y={-50000}
              width={100000}
              height={100000}
              fill="transparent"
              onClick={() => {
                if (inspectedClusterId !== null) {
                  setInspectedClusterId(null);
                } else if (focusedSubRegionId !== null) {
                  setFocusedSubRegionPath([]);
                  setInspectedClusterId(null);
                } else {
                  setFocusedTerritoryId(null);
                  setFocusedSubRegionPath([]);
                  setInspectedClusterId(null);
                }
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

              const baseFill = getHexFill(tile);
              const fill =
                previewTuner !== null &&
                (tile.cluster!.tunerCounts[previewTuner] ?? 0) > 0
                  ? TUNER_COLORS[previewTuner]
                  : baseFill;
              const isInspected =
                inspectedClusterId === tile.cluster.id &&
                focusedTerritoryId !== null;
              const tileTerrId = clusterToTerrId.get(tile.cluster.id);
              // In pixel mode at overview level, skip territory muting
              const isOverviewPixel =
                effectiveColorMode === "pixel" && focusedTerritoryId === null;
              const activeTerritoryId = isOverviewPixel
                ? null
                : (focusedTerritoryId ?? hoveredTerritoryId);
              const isMuted =
                activeTerritoryId !== null && tileTerrId !== activeTerritoryId;
              const isTunerMuted =
                previewTuner !== null &&
                (tile.cluster!.tunerCounts[previewTuner] ?? 0) === 0;
              const tileOpacity = isTunerMuted ? 0.1 : isMuted ? 0.12 : 1;

              return (
                <g
                  key={`${tile.q},${tile.r}`}
                  transform={`translate(${tile.x}, ${tile.y})`}
                  onMouseEnter={(e) => handleMouseEnter(tile, e)}
                  onMouseMove={handleMouseMove}
                  onMouseLeave={handleMouseLeave}
                  onClick={(e) => {
                    if (effectiveColorMode === "pixel") {
                      e.stopPropagation();
                      const tId = clusterToTerrId.get(tile.cluster!.id) ?? null;

                      if (
                        focusedTerritoryId === null ||
                        tId !== focusedTerritoryId
                      ) {
                        // Focus territory
                        setFocusedTerritoryId(tId);
                        setFocusedSubRegionPath([]);
                        setInspectedClusterId(null);
                      } else {
                        // Territory focused: inspect cluster directly
                        setInspectedClusterId(tile.cluster!.id);
                      }
                    }
                  }}
                  style={
                    effectiveColorMode === "pixel"
                      ? { cursor: "pointer" }
                      : undefined
                  }
                  opacity={tileOpacity}
                >
                  <path
                    d={hexPath}
                    fill={fill || "#F8FAFC"}
                    stroke={isInspected ? "#4F46E5" : "#E2E8F0"}
                    strokeWidth={isInspected ? 3 : 0.5}
                  />
                </g>
              );
            })}

            {/* ── Hover highlight: dashed outer border of hovered sub-region (disabled) ── */}
            {false && hoveredSubRegionBorder && (
              <>
                <path
                  d={hoveredSubRegionBorder}
                  fill="none"
                  stroke="white"
                  strokeWidth={5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.7}
                  pointerEvents="none"
                />
                <path
                  d={hoveredSubRegionBorder}
                  fill="none"
                  stroke="#1E293B"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  pointerEvents="none"
                />
              </>
            )}
            {/* ── Hover highlight at overview level: single tile ── */}
            {hoveredClusterId !== null &&
              focusedTerritoryId === null &&
              (() => {
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
            {focusedSubRegionId === null &&
              boundaryData.macro.map(({ d, terr }) => {
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
            {focusedSubRegionId === null &&
              boundaryData.macro.map(({ d, terr }) => {
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

            {/* ── Compare mode: tuner A / B territory borders ── */}
            {effectiveColorMode === "compare" && (
              <>
                {/* Tuner A border — blue */}
                {compareBoundaries.a && (
                  <>
                    <path
                      d={compareBoundaries.a}
                      fill="none"
                      stroke="white"
                      strokeWidth={5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={0.7}
                      pointerEvents="none"
                    />
                    <path
                      d={compareBoundaries.a}
                      fill="none"
                      stroke="#2563EB"
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={0.8}
                      pointerEvents="none"
                    />
                  </>
                )}
                {/* Tuner B border — red */}
                {compareBoundaries.b && (
                  <>
                    <path
                      d={compareBoundaries.b}
                      fill="none"
                      stroke="white"
                      strokeWidth={5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={0.7}
                      pointerEvents="none"
                    />
                    <path
                      d={compareBoundaries.b}
                      fill="none"
                      stroke="#DC2626"
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={0.8}
                      pointerEvents="none"
                    />
                  </>
                )}
              </>
            )}

            {/* ���─ Sub-region boundaries (disabled) ─────��── */}
            {false && focusedSubRegionId === null && (
              <>
                {/* white halo (thin) */}
                {boundaryData.sub
                  .filter(
                    ({ terr }) =>
                      focusedTerritoryId === null ||
                      terr.id === focusedTerritoryId,
                  )
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
                  .filter(
                    ({ terr }) =>
                      focusedTerritoryId === null ||
                      terr.id === focusedTerritoryId,
                  )
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

            {/* ── Focused sub-region outer border (disabled) ── */}
            {false && focusedSubRegionId !== null && focusedSubRegionBorder && (
              <>
                <path
                  d={focusedSubRegionBorder}
                  fill="none"
                  stroke="white"
                  strokeWidth={6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.85}
                  pointerEvents="none"
                />
                <path
                  d={focusedSubRegionBorder}
                  fill="none"
                  stroke="#475569"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.8}
                  pointerEvents="none"
                />
              </>
            )}

            {/* ── Sub-region labels (disabled) ── */}
            {false &&
              !selectedParam &&
              focusedSubRegionId === null &&
              subLabelPositions.map(
                ({ sr, x, y, rw, rh: lh, lines, color, anchorX, anchorY }) => {
                  const isLabelHovered = hoveredSubRegionId === sr.id;
                  const fs = 10 / renderScale;
                  const lineH = fs * 1.3;
                  const rx = 4 / renderScale;
                  return (
                    <g
                      key={`sr-label-${sr.territoryId}-${sr.id}`}
                      style={{ cursor: "pointer" }}
                      opacity={
                        hoveredSubRegionId !== null && !isLabelHovered
                          ? 0.25
                          : 1
                      }
                      onMouseEnter={() => setHoveredSubRegionId(sr.id)}
                      onMouseLeave={() => setHoveredSubRegionId(null)}
                      onClick={(e) => {
                        e.stopPropagation();
                        setFocusedSubRegionPath((prev) =>
                          prev[prev.length - 1] === sr.id
                            ? prev.slice(0, -1)
                            : [...prev, sr.id],
                        );
                      }}
                    >
                      <line
                        x1={anchorX}
                        y1={anchorY}
                        x2={x}
                        y2={y}
                        stroke={color}
                        strokeWidth={1 / renderScale}
                        strokeDasharray={`${3 / renderScale},${2 / renderScale}`}
                        opacity={0.5}
                      />
                      <circle
                        cx={anchorX}
                        cy={anchorY}
                        r={2.5 / renderScale}
                        fill={color}
                        opacity={0.7}
                      />
                      <rect
                        x={x - rw / 2}
                        y={y - lh / 2}
                        width={rw}
                        height={lh}
                        rx={rx}
                        fill="white"
                        opacity={0.96}
                      />
                      <rect
                        x={x - rw / 2}
                        y={y - lh / 2}
                        width={rw}
                        height={lh}
                        rx={rx}
                        fill="none"
                        stroke={color}
                        strokeWidth={1.5 / renderScale}
                      />
                      <text
                        x={x}
                        textAnchor="middle"
                        fontSize={fs}
                        fontWeight={600}
                        fill={color}
                      >
                        {lines.map((line, li) => (
                          <tspan
                            key={li}
                            x={x}
                            y={
                              y - ((lines.length - 1) * lineH) / 2 + li * lineH
                            }
                            dominantBaseline="middle"
                          >
                            {line}
                          </tspan>
                        ))}
                      </text>
                    </g>
                  );
                },
              )}

            {/* ── Child sub-region labels (disabled) ── */}
            {false &&
              !selectedParam &&
              detailLabelPositions.map(
                ({ dr, x, y, rw, rh: lh, lines, color, anchorX, anchorY }) => {
                  const fs = 9 / renderScale;
                  const lineH = fs * 1.3;
                  const rx = 3 / renderScale;
                  return (
                    <g key={`dr-label-${dr.id}`} pointerEvents="none">
                      <line
                        x1={anchorX}
                        y1={anchorY}
                        x2={x}
                        y2={y}
                        stroke={color}
                        strokeWidth={0.8 / renderScale}
                        strokeDasharray={`${2 / renderScale},${2 / renderScale}`}
                        opacity={0.4}
                      />
                      <circle
                        cx={anchorX}
                        cy={anchorY}
                        r={2 / renderScale}
                        fill={color}
                        opacity={0.6}
                      />
                      <rect
                        x={x - rw / 2}
                        y={y - lh / 2}
                        width={rw}
                        height={lh}
                        rx={rx}
                        fill="white"
                        opacity={0.94}
                      />
                      <rect
                        x={x - rw / 2}
                        y={y - lh / 2}
                        width={rw}
                        height={lh}
                        rx={rx}
                        fill="none"
                        stroke={color}
                        strokeWidth={1 / renderScale}
                      />
                      <text
                        x={x}
                        textAnchor="middle"
                        fontSize={fs}
                        fontWeight={600}
                        fill={color}
                      >
                        {lines.map((line, li) => (
                          <tspan
                            key={li}
                            x={x}
                            y={
                              y - ((lines.length - 1) * lineH) / 2 + li * lineH
                            }
                            dominantBaseline="middle"
                          >
                            {line}
                          </tspan>
                        ))}
                      </text>
                    </g>
                  );
                },
              )}

            {/* ── Parameter bin boundaries (boolean params) ── */}
            {paramBinBoundaryPath && (
              <>
                <path
                  d={paramBinBoundaryPath}
                  fill="none"
                  stroke="white"
                  strokeWidth={4 / renderScale}
                  strokeLinecap="round"
                  opacity={0.8}
                  pointerEvents="none"
                />
                <path
                  d={paramBinBoundaryPath}
                  fill="none"
                  stroke="#374151"
                  strokeWidth={1.5 / renderScale}
                  strokeLinecap="round"
                  opacity={0.6}
                  pointerEvents="none"
                />
              </>
            )}

            {/* ── Parameter bin region labels ── */}
            {paramBinRegions.length > 0 &&
              paramBinRegions.map((region, i) => {
                const color =
                  paramCellBins?.binColors[region.bin] ?? MIXED_COLOR;
                const fs = 10 / renderScale;
                const labelText = region.bin;
                const textW = labelText.length * fs * 0.55;
                const padX = 5 / renderScale;
                const padY = 3 / renderScale;
                const rw = textW + padX * 2;
                const rh = fs + padY * 2;
                return (
                  <g key={`param-bin-${i}`} pointerEvents="none">
                    <rect
                      x={region.cx - rw / 2}
                      y={region.cy - rh / 2}
                      width={rw}
                      height={rh}
                      rx={4 / renderScale}
                      fill="white"
                      opacity={0.92}
                    />
                    <rect
                      x={region.cx - rw / 2}
                      y={region.cy - rh / 2}
                      width={rw}
                      height={rh}
                      rx={4 / renderScale}
                      fill="none"
                      stroke={color}
                      strokeWidth={1.5 / renderScale}
                    />
                    <text
                      x={region.cx}
                      y={region.cy}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={fs}
                      fontWeight={700}
                      fill={color}
                    >
                      {labelText}
                    </text>
                  </g>
                );
              })}

            {/* ── Per-territory parameter summary labels (disabled) ── */}
            {false &&
              selectedParam &&
              focusedTerritoryId === null &&
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
                  const fs = 11 / renderScale;
                  const lineH = fs * 1.3;
                  const bw = 1.5 / renderScale;
                  const rx = 5 / renderScale;
                  return (
                    <g key={`macro-label-${t.id}`} pointerEvents="none">
                      <line
                        x1={anchorX}
                        y1={anchorY}
                        x2={px}
                        y2={py}
                        stroke={color}
                        strokeWidth={1 / renderScale}
                        strokeDasharray={`${4 / renderScale},${3 / renderScale}`}
                        opacity={0.45}
                      />
                      <circle
                        cx={anchorX}
                        cy={anchorY}
                        r={3 / renderScale}
                        fill={color}
                        opacity={0.8}
                      />
                      <rect
                        x={px - rw / 2 - 1 / renderScale}
                        y={py - rh / 2 - 1 / renderScale}
                        width={rw + 2 / renderScale}
                        height={rh + 2 / renderScale}
                        rx={rx + 1 / renderScale}
                        fill="white"
                      />
                      <rect
                        x={px - rw / 2}
                        y={py - rh / 2}
                        width={rw}
                        height={rh}
                        rx={rx}
                        fill="none"
                        stroke={color}
                        strokeWidth={bw}
                        opacity={0.9}
                      />
                      <text
                        x={px}
                        textAnchor="middle"
                        fontSize={fs}
                        fontWeight={700}
                        fill={color}
                      >
                        {lines.map((line, li) => (
                          <tspan
                            key={li}
                            x={px}
                            y={
                              py - ((lines.length - 1) * lineH) / 2 + li * lineH
                            }
                            dominantBaseline="middle"
                          >
                            {line}
                          </tspan>
                        ))}
                      </text>
                    </g>
                  );
                },
              )}

            {/* ── Per-cell qualitative labels (outside tiles, with leader lines) ── */}
            {qualCellLabelPositions.map(
              ({ id, cx, cy, anchorX, anchorY, lines, rw, rh }) => {
                const rx = 5 / renderScale;
                const bw = 1.2 / renderScale;
                const fs = 9 / renderScale;
                const lineH = fs * 1.3;
                const borderColor =
                  lines.length === 1 ? lines[0].color : "#64748B";
                // Mute labels outside the focused/hovered territory
                const tId = clusterToTerrId.get(id) ?? null;
                const activeTerritoryId =
                  focusedTerritoryId ?? hoveredTerritoryId;
                const isMuted =
                  activeTerritoryId !== null && tId !== activeTerritoryId;
                return (
                  <g
                    key={`qual-${id}`}
                    pointerEvents="none"
                    opacity={isMuted ? 0.08 : 0.92}
                  >
                    {/* Leader line */}
                    <line
                      x1={anchorX}
                      y1={anchorY}
                      x2={cx}
                      y2={cy}
                      stroke={borderColor}
                      strokeWidth={1 / renderScale}
                      strokeDasharray={`${3 / renderScale},${2 / renderScale}`}
                      opacity={0.5}
                    />
                    {/* Anchor dot */}
                    <circle
                      cx={anchorX}
                      cy={anchorY}
                      r={2.5 / renderScale}
                      fill={borderColor}
                      opacity={0.7}
                    />
                    {/* White background */}
                    <rect
                      x={cx - rw / 2 - 1 / renderScale}
                      y={cy - rh / 2 - 1 / renderScale}
                      width={rw + 2 / renderScale}
                      height={rh + 2 / renderScale}
                      rx={rx + 1 / renderScale}
                      fill="white"
                    />
                    {/* Border */}
                    <rect
                      x={cx - rw / 2}
                      y={cy - rh / 2}
                      width={rw}
                      height={rh}
                      rx={rx}
                      fill="white"
                      stroke={borderColor}
                      strokeWidth={bw}
                      opacity={0.95}
                    />
                    {/* Multi-line label text — each line in its own color */}
                    <text
                      x={cx}
                      textAnchor="middle"
                      fontSize={fs}
                      fontWeight={700}
                    >
                      {lines.map((l, li) => (
                        <tspan
                          key={li}
                          x={cx}
                          y={cy - ((lines.length - 1) * lineH) / 2 + li * lineH}
                          dominantBaseline="central"
                          fill={l.color}
                        >
                          {l.label}
                        </tspan>
                      ))}
                    </text>
                  </g>
                );
              },
            )}
          </g>
        </svg>

        {/* Param bin legend — bottom-left inside SVG area */}
        {paramCellBins && (
          <div
            style={{
              position: "absolute",
              bottom: 12,
              left: 12,
              zIndex: 10,
              background: "rgba(255,255,255,0.92)",
              backdropFilter: "blur(4px)",
              borderRadius: 8,
              border: "1px solid #E5E7EB",
              boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
              padding: "6px 10px",
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                fontSize: 9,
                fontWeight: 700,
                color: "#374151",
                marginBottom: 3,
              }}
            >
              {selectedParam} ({selectedParamType})
            </div>
            {paramCellBins.binNames.map((bin) => (
              <div
                key={bin}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  marginBottom: 1,
                }}
              >
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    backgroundColor:
                      paramCellBins.binColors[bin] ?? MIXED_COLOR,
                    opacity: 0.7,
                  }}
                />
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 600,
                    color: paramCellBins.binColors[bin] ?? MIXED_COLOR,
                  }}
                >
                  {bin}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Focus panel — right-side absolute overlay on the map */}
        {focusedTerritoryId !== null && (
          <div
            style={{
              position: "absolute",
              top: CONTROLS_PAD + 4,
              right: 12,
              width: 260,
              maxHeight: height - CONTROLS_PAD - 20,
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
                const { terr, terrAvgCov, terrMaxCov, terrMinCov, subMetrics } =
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
                          {`Territory ${terr.id}`}
                        </span>
                      </div>
                      <button
                        onClick={() => {
                          if (inspectedClusterId !== null) {
                            setInspectedClusterId(null);
                          } else {
                            setFocusedTerritoryId(null);
                            setFocusedSubRegionPath([]);
                            setInspectedClusterId(null);
                          }
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
                        gridTemplateColumns: "1fr 1fr 1fr 1fr",
                        gap: 4,
                        marginBottom: 10,
                      }}
                    >
                      {[
                        {
                          label: "Trials",
                          value: terr.totalTrials.toLocaleString(),
                        },
                        { label: "Min Cov", value: terrMinCov.toFixed(3) },
                        { label: "Avg Cov", value: terrAvgCov.toFixed(3) },
                        { label: "Max Cov", value: terrMaxCov.toFixed(3) },
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

                    {/* Coverage range bar */}
                    {(() => {
                      const gMin = globalCovRange.min;
                      const gMax = globalCovRange.max;
                      const range = gMax - gMin || 1;
                      const toPos = (v: number) =>
                        Math.max(0, Math.min(100, ((v - gMin) / range) * 100));
                      const minPos = toPos(terrMinCov);
                      const maxPos = toPos(terrMaxCov);
                      const avgPos = toPos(terrAvgCov);
                      return (
                        <div style={{ marginBottom: 14 }}>
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              fontSize: 8,
                              color: "#94A3B8",
                              marginBottom: 2,
                            }}
                          >
                            <span>{gMin.toFixed(3)}</span>
                            <span style={{ fontSize: 8, color: "#64748B" }}>
                              Global Branch Coverage Range
                            </span>
                            <span>{gMax.toFixed(3)}</span>
                          </div>
                          <div
                            style={{
                              position: "relative",
                              height: 8,
                              background: "#E5E7EB",
                              borderRadius: 4,
                            }}
                          >
                            {/* Territory range */}
                            <div
                              style={{
                                position: "absolute",
                                left: `${minPos}%`,
                                width: `${Math.max(maxPos - minPos, 1)}%`,
                                height: "100%",
                                background: terrColor,
                                opacity: 0.35,
                                borderRadius: 4,
                              }}
                            />
                            {/* Avg marker */}
                            <div
                              style={{
                                position: "absolute",
                                left: `${avgPos}%`,
                                top: -1,
                                width: 2,
                                height: 10,
                                background: terrColor,
                                borderRadius: 1,
                                transform: "translateX(-1px)",
                              }}
                            />
                          </div>
                        </div>
                      );
                    })()}

                    {/* Tuner distribution */}
                    <div style={{ marginBottom: 14 }}>
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          color: "#374151",
                          marginBottom: 6,
                        }}
                      >
                        Tuner Distribution
                      </div>
                      {TUNER_NAMES.filter((t) => selectedTuners.has(t))
                        .map((t) => ({ tuner: t, count: terr.tunerCounts[t] }))
                        .sort((a, b) => b.count - a.count)
                        .map(({ tuner, count }) => {
                          const pct =
                            terr.totalTrials > 0
                              ? (count / terr.totalTrials) * 100
                              : 0;
                          // Compute avg coverage from clusters where this tuner has trials
                          const tunerClusterCovs = terr.clusters
                            .filter((c) => c.tunerCounts[tuner] > 0)
                            .map((c) => c.meanBranchCoverage);
                          const avgCov =
                            tunerClusterCovs.length > 0
                              ? tunerClusterCovs.reduce((s, v) => s + v, 0) /
                                tunerClusterCovs.length
                              : 0;
                          return (
                            <div key={tuner} style={{ marginBottom: 6 }}>
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  fontSize: 9,
                                  marginBottom: 2,
                                }}
                              >
                                <span
                                  style={{
                                    fontWeight: 600,
                                    color: TUNER_COLORS[tuner],
                                  }}
                                >
                                  {TUNER_DISPLAY_NAMES[tuner]}
                                </span>
                                <span style={{ color: "#6B7280" }}>
                                  {count} ({pct.toFixed(0)}%) · avg{" "}
                                  {avgCov.toFixed(3)}
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
                                    width: `${pct}%`,
                                    background: TUNER_COLORS[tuner],
                                    borderRadius: 2,
                                  }}
                                />
                              </div>
                            </div>
                          );
                        })}
                    </div>

                    {/* Sub-region list (disabled) */}
                    {false && subMetrics.length > 0 && (
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
                                    setFocusedSubRegionPath((prev) =>
                                      prev[prev.length - 1] === sr.id
                                        ? prev.slice(0, -1)
                                        : [...prev, sr.id],
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
                              {inspectedCluster.meanBranchCoverage.toFixed(3)}
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
        {/* Controls overlay — top bar */}
        <div
          style={{
            position: "absolute",
            top: compact ? 4 : 8,
            left: compact ? 6 : 12,
            right: compact ? 6 : 12,
            zIndex: 10,
            display: "flex",
            flexDirection: compact ? "column" : "row",
            alignItems: compact ? "stretch" : "flex-start",
            justifyContent: "space-between",
            gap: compact ? 3 : 0,
            pointerEvents: "none",
          }}
        >
          {/* Left: Detail Level + Color Mode */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: compact ? 4 : 6,
              background: "rgba(255,255,255,0.92)",
              backdropFilter: "blur(4px)",
              borderRadius: compact ? 6 : 8,
              boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
              border: "1px solid #E5E7EB",
              padding: compact ? "3px 6px" : "5px 10px",
              fontSize: compact ? 10 : 11,
              pointerEvents: "auto",
              flexWrap: compact ? ("wrap" as const) : ("nowrap" as const),
            }}
          >
            {/* Detail Level: 🔍 − L4 + */}
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#9CA3AF"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <button
              onClick={() => setDetailLevel(Math.max(0, detailLevel - 1))}
              disabled={detailLevel === 0}
              style={{
                width: 20,
                height: 20,
                display: "flex",
                justifyContent: "center",
                border: "1px solid #E5E7EB",
                borderRadius: 4,
                background: "white",
                color: detailLevel === 0 ? "#D1D5DB" : "#374151",
                cursor: detailLevel === 0 ? "default" : "pointer",
                fontSize: 14,
                lineHeight: 1,
              }}
            >
              −
            </button>
            <span
              title={`${allLevels[detailLevel]?.clusters.length ?? "…"} clusters`}
              style={{
                fontWeight: 700,
                color: "#4F46E5",
                minWidth: 22,
                textAlign: "center",
                fontSize: 11,
              }}
            >
              L{detailLevel}
            </span>
            <button
              onClick={() => setDetailLevel(Math.min(4, detailLevel + 1))}
              disabled={detailLevel === 4}
              style={{
                width: 20,
                height: 20,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: "1px solid #E5E7EB",
                borderRadius: 4,
                background: "white",
                color: detailLevel === 4 ? "#D1D5DB" : "#374151",
                cursor: detailLevel === 4 ? "default" : "pointer",
                fontSize: 14,
                lineHeight: 1,
              }}
            >
              +
            </button>

            {/* Divider */}
            <div
              style={{
                width: 1,
                height: 14,
                background: "#E5E7EB",
                margin: "0 2px",
              }}
            />

            {/* Color mode buttons */}
            {(
              [
                { mode: "pixel", label: "Territory" },
                { mode: "coverage", label: "Coverage" },
                { mode: "dominant", label: "Dominant" },
                { mode: "density", label: "Density" },
                { mode: "compare", label: "Compare" },
              ] as { mode: ColorMode; label: string }[]
            ).map(({ mode, label }) => {
              const isActive = colorMode === mode;
              const isPreviewing = previewColorMode === mode && !isActive;
              return (
                <button
                  key={mode}
                  onClick={() => setColorMode(mode)}
                  onMouseEnter={() => setPreviewColorMode(mode)}
                  onMouseLeave={() => setPreviewColorMode(null)}
                  style={{
                    padding: "3px 7px",
                    fontSize: 10,
                    border: "1px solid",
                    borderColor: isActive
                      ? "#4F46E5"
                      : isPreviewing
                        ? "#818CF8"
                        : "#E5E7EB",
                    borderRadius: 4,
                    background: isActive
                      ? "#EEF2FF"
                      : isPreviewing
                        ? "#F5F3FF"
                        : "white",
                    color: isActive
                      ? "#4F46E5"
                      : isPreviewing
                        ? "#6366F1"
                        : "#6B7280",
                    cursor: "pointer",
                    boxShadow: isPreviewing
                      ? "0 0 0 2px rgba(99,102,241,0.25)"
                      : "none",
                    transition: "all 0.12s ease",
                  }}
                >
                  {label}
                </button>
              );
            })}

            {/* Coverage legend + metric selector (visible in coverage mode) */}
            {effectiveColorMode === "coverage" && (
              <>
                <div
                  style={{
                    width: 1,
                    height: 14,
                    background: "#E5E7EB",
                    margin: "0 2px",
                  }}
                />
                {/* Metric selector: mean / min / max */}
                <div style={{ display: "flex", gap: 2 }}>
                  {(["mean", "min", "max"] as const).map((m) => {
                    const isActive = coverageMetric === m;
                    return (
                      <button
                        key={m}
                        onClick={() => setCoverageMetric(m)}
                        style={{
                          padding: "2px 5px",
                          fontSize: 9,
                          border: "1px solid",
                          borderColor: isActive ? "#4F46E5" : "#E5E7EB",
                          borderRadius: 3,
                          background: isActive ? "#EEF2FF" : "white",
                          color: isActive ? "#4F46E5" : "#6B7280",
                          cursor: "pointer",
                          fontWeight: isActive ? 600 : 400,
                        }}
                      >
                        {m}
                      </button>
                    );
                  })}
                </div>
                {(() => {
                  const barW = 120;
                  const gMin = globalCovRange.min;
                  const gMax = globalCovRange.max;
                  const gMean = globalCovRange.mean;
                  const range = gMax - gMin || 1;
                  const meanPct = ((gMean - gMin) / range) * 100;
                  return (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 2,
                      }}
                    >
                      {/* Mean label above bar */}
                      <div style={{ position: "relative", width: barW, height: 10 }}>
                        <span
                          style={{
                            position: "absolute",
                            left: `${meanPct}%`,
                            transform: "translateX(-50%)",
                            fontSize: 7,
                            fontWeight: 600,
                            color: "#374151",
                            whiteSpace: "nowrap",
                          }}
                        >
                          avg {gMean.toFixed(3)}
                        </span>
                      </div>
                      {/* Gradient bar: min (white) → max (green) */}
                      <div style={{ position: "relative", width: barW, height: 8 }}>
                        <div
                          style={{
                            width: "100%",
                            height: "100%",
                            borderRadius: 4,
                            background:
                              "linear-gradient(to right, #FFFFFF, #16A34A)",
                            border: "1px solid #E5E7EB",
                          }}
                        />
                        {/* Mean marker triangle */}
                        <div
                          style={{
                            position: "absolute",
                            left: `${meanPct}%`,
                            top: -2,
                            width: 0,
                            height: 0,
                            borderLeft: "3px solid transparent",
                            borderRight: "3px solid transparent",
                            borderTop: "4px solid #374151",
                            transform: "translateX(-3px)",
                          }}
                        />
                      </div>
                      {/* Scale endpoints: min / max values */}
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          width: barW,
                          fontSize: 7,
                          color: "#6B7280",
                          fontWeight: 600,
                        }}
                      >
                        <span>{gMin.toFixed(3)}</span>
                        <span>{gMax.toFixed(3)}</span>
                      </div>
                    </div>
                  );
                })()}
              </>
            )}

            {/* Compare mode: tuner A vs B selector + diverging legend */}
            {effectiveColorMode === "compare" && (
              <>
                <div
                  style={{
                    width: 1,
                    height: 14,
                    background: "#E5E7EB",
                    margin: "0 2px",
                  }}
                />
                {/* Tuner A selector */}
                <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                  <select
                    value={compareTunerA}
                    onChange={(e) => setCompareTunerA(e.target.value as TunerType)}
                    style={{
                      fontSize: 9,
                      padding: "2px 4px",
                      borderRadius: 3,
                      border: "1px solid #2563EB",
                      background: "#EFF6FF",
                      color: "#1D4ED8",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {TUNER_NAMES.filter((t) => t !== compareTunerB).map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <span style={{ fontSize: 9, color: "#6B7280", fontWeight: 600 }}>vs</span>
                  {/* Tuner B selector */}
                  <select
                    value={compareTunerB}
                    onChange={(e) => setCompareTunerB(e.target.value as TunerType)}
                    style={{
                      fontSize: 9,
                      padding: "2px 4px",
                      borderRadius: 3,
                      border: "1px solid #DC2626",
                      background: "#FEF2F2",
                      color: "#DC2626",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {TUNER_NAMES.filter((t) => t !== compareTunerA).map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                {/* Diverging legend bar */}
                {(() => {
                  const barW = 140;
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <div
                        style={{
                          width: barW,
                          height: 8,
                          borderRadius: 4,
                          background: "linear-gradient(to right, #DC2626, #FFFFFF 50%, #2563EB)",
                          border: "1px solid #E5E7EB",
                        }}
                      />
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          width: barW,
                          fontSize: 7,
                          color: "#6B7280",
                          fontWeight: 600,
                        }}
                      >
                        <span style={{ color: "#DC2626" }}>{compareTunerB}</span>
                        <span>0</span>
                        <span style={{ color: "#2563EB" }}>{compareTunerA}</span>
                      </div>
                      <div
                        style={{
                          fontSize: 7,
                          color: "#9CA3AF",
                          textAlign: "center",
                          width: barW,
                        }}
                      >
                        Δ ±{compareDiffMax.toFixed(3)}
                      </div>
                    </div>
                  );
                })()}
              </>
            )}

            {/* Parameter selector (only in territory/pixel mode) */}
            {(effectiveColorMode === "pixel" || effectiveColorMode === "territory") && (
              <>
                <div
                  style={{
                    width: 1,
                    height: 14,
                    background: "#E5E7EB",
                    margin: "0 2px",
                  }}
                />
                <select
                  value={selectedParam ?? ""}
                  onChange={(e) => setSelectedParam(e.target.value || null)}
                  style={{
                    padding: "3px 6px",
                    fontSize: 10,
                    border: "1px solid #E5E7EB",
                    borderRadius: 4,
                    background: selectedParam ? "#EEF2FF" : "white",
                    color: selectedParam ? "#4F46E5" : "#6B7280",
                    cursor: "pointer",
                    maxWidth: 140,
                  }}
                >
                  <option value="">All params</option>
                  {paramNames.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </>
            )}

            {/* Debug toggle */}
          </div>

          {/* Right: Tuner toggles + Qual label toggles */}
          <div
            style={{
              display: "flex",
              flexDirection: compact ? "row" : "column",
              gap: compact ? 3 : 4,
              alignItems: compact ? "center" : "flex-end",
              justifyContent: compact ? "space-between" : undefined,
            }}
          >
            {/* Tuner toggles */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: compact ? 2 : 4,
                background: "rgba(255,255,255,0.92)",
                backdropFilter: "blur(4px)",
                borderRadius: compact ? 6 : 8,
                boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
                border: "1px solid #E5E7EB",
                padding: compact ? "3px 6px" : "5px 10px",
                pointerEvents: "auto",
              }}
            >
              {TUNER_NAMES.map((tuner) => {
                const isOn = selectedTuners.has(tuner);
                const isPreviewing = previewTuner === tuner;
                const isSolo = soloTuner === tuner;
                return (
                  <button
                    key={tuner}
                    onClick={(e) => {
                      if (e.shiftKey) {
                        // Shift+click: toggle include/exclude
                        toggleTuner(tuner);
                      } else {
                        // Click: toggle solo highlight
                        setSoloTuner((prev) => (prev === tuner ? null : tuner));
                      }
                    }}
                    onMouseEnter={() => setPreviewTuner(tuner)}
                    onMouseLeave={() => setPreviewTuner(null)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: compact ? 3 : 5,
                      padding: compact ? "2px 5px" : "3px 8px",
                      fontSize: compact ? 9 : 10,
                      border: isSolo ? "2px solid" : "1px solid",
                      borderColor: isSolo
                        ? TUNER_COLORS[tuner]
                        : isPreviewing
                          ? TUNER_COLORS[tuner]
                          : isOn
                            ? TUNER_COLORS[tuner] + "88"
                            : "#F1F5F9",
                      borderRadius: 5,
                      background: isSolo
                        ? TUNER_COLORS[tuner] + "20"
                        : isPreviewing
                          ? TUNER_COLORS[tuner] + "15"
                          : isOn
                            ? "white"
                            : "#FAFAFA",
                      cursor: "pointer",
                      opacity: isOn ? 1 : isPreviewing ? 0.8 : 0.4,
                      boxShadow: isSolo
                        ? `0 0 0 2px ${TUNER_COLORS[tuner]}50`
                        : isPreviewing
                          ? `0 0 0 2px ${TUNER_COLORS[tuner]}40`
                          : "none",
                      transition: "all 0.12s ease",
                    }}
                  >
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        backgroundColor: TUNER_COLORS[tuner],
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ color: "#374151", fontWeight: isSolo ? 700 : 500 }}>
                      {TUNER_DISPLAY_NAMES[tuner]}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Qualitative label toggles */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 0,
                background: "rgba(255,255,255,0.92)",
                backdropFilter: "blur(4px)",
                borderRadius: compact ? 6 : 8,
                boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
                border: "1px solid #E5E7EB",
                padding: compact ? "3px 6px" : "4px 8px",
                pointerEvents: "auto",
              }}
            >
              {(() => {
                const criteria: Record<QualitativeLabel, string> = {
                  "Failure-prone": "Highest failure rate (cov=0)",
                  "High Novelty": "Highest marginal coverage",
                  "High Coverage": "Highest average coverage",
                  "High Density": "Most trials explored",
                };
                return (
                  <>
                    <span
                      style={{ fontSize: 9, color: "#9CA3AF", fontWeight: 600 }}
                    >
                      Labels
                    </span>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: compact ? "row" : "column",
                        flexWrap: compact ? ("wrap" as const) : undefined,
                        gap: compact ? 3 : 1,
                      }}
                    >
                      {QUAL_LABEL_NAMES.map((ql) => {
                        const isOn = selectedQualLabels.has(ql);
                        const color = QUAL_LABEL_COLORS[ql];
                        return (
                          <div
                            key={ql}
                            onClick={() => {
                              setSelectedQualLabels((prev) => {
                                const next = new Set(prev);
                                if (next.has(ql)) next.delete(ql);
                                else next.add(ql);
                                return next;
                              });
                            }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 4,
                              cursor: "pointer",
                              opacity: isOn ? 1 : 0.35,
                              transition: "opacity 0.15s",
                              fontSize: 9,
                              lineHeight: "14px",
                            }}
                          >
                            <div
                              style={{
                                width: 6,
                                height: 6,
                                borderRadius: "50%",
                                backgroundColor: color,
                                flexShrink: 0,
                              }}
                            />
                            <span
                              style={{
                                fontWeight: 600,
                                color,
                                fontSize: compact ? 8 : undefined,
                              }}
                            >
                              {ql}
                            </span>
                            {!compact && (
                              <span style={{ color: "#9CA3AF", fontSize: 8 }}>
                                {criteria[ql]}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        </div>

        {/* ── Hover tooltip ── */}
        {tooltipPos &&
          hoveredClusterId !== null &&
          data &&
          (() => {
            const cluster = data.clusters.find(
              (c) => c.id === hoveredClusterId,
            );
            if (!cluster) return null;
            const dominant = getDominantTuner(
              Object.fromEntries(
                TUNER_NAMES.filter((t) => selectedTuners.has(t)).map((t) => [
                  t,
                  cluster.tunerCounts[t],
                ]),
              ) as Record<TunerType, number>,
            );
            const dominantCount = cluster.tunerCounts[dominant];
            const totalSelected = TUNER_NAMES.filter((t) =>
              selectedTuners.has(t),
            ).reduce((s, t) => s + cluster.tunerCounts[t], 0);
            const dominantPct =
              totalSelected > 0
                ? Math.round((dominantCount / totalSelected) * 100)
                : 0;
            return (
              <div
                style={{
                  position: "absolute",
                  left: tooltipPos.x + 12,
                  top: tooltipPos.y - 10,
                  background: "rgba(15, 23, 42, 0.92)",
                  color: "white",
                  padding: "6px 10px",
                  borderRadius: 6,
                  fontSize: 11,
                  lineHeight: "16px",
                  pointerEvents: "none",
                  zIndex: 50,
                  whiteSpace: "nowrap",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 3 }}>
                  {cluster.totalTrials} trials · avg cov{" "}
                  {cluster.meanBranchCoverage.toFixed(3)}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <div
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: TUNER_COLORS[dominant],
                    }}
                  />
                  <span>
                    {TUNER_DISPLAY_NAMES[dominant]} {dominantPct}%
                  </span>
                  {selectedTuners.size > 1 && (
                    <span style={{ color: "#94A3B8", marginLeft: 4 }}>
                      (
                      {
                        TUNER_NAMES.filter(
                          (t) =>
                            selectedTuners.has(t) && cluster.tunerCounts[t] > 0,
                        ).length
                      }{" "}
                      tuners)
                    </span>
                  )}
                </div>
              </div>
            );
          })()}
      </div>
    </div>
  );
}

export default HexMap;
