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
  deserializePrecomputed,
  TUNER_COLORS,
  TUNER_NAMES,
} from "../../utils/hexMapUtils";
import type { HexMapData, HexTile, TunerType, Cluster } from "./types";
import type {
  ColorMode,
  HexMapProps,
} from "./types";
import {
  HEX_SIZE_DEFAULT,
  MIXED_COLOR,
  TUNER_DISPLAY_NAMES,
} from "./types";
import { getParamType } from "./colorUtils";
import { ControlsBar } from "./ControlsBar";
import { HexTooltip } from "./HexTooltip";


// Tableau20 — up to 20 visually distinct colors for categorical params
const CAT_PALETTE = [
  "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F",
  "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC",
  "#AF7AA1", "#86BCB6", "#D37295", "#FABFD2", "#B6992D",
  "#499894", "#E17C05", "#D4A6C8", "#8CD17D", "#F1CE63",
];

// ============================================================
// Component
// ============================================================

export function HexMap({
  program = "gawk",
  selectedParam: selectedParamProp = null,
  onParamSelect,
  selectedTuners: selectedTunersProp,
  onToggleTuner,
  cartIds: cartIdsProp,
  onCartToggle,
  onCartDataUpdate,
  externalHoveredClusterId = null,
  onHoverChange,
}: HexMapProps) {
  // Responsive sizing: measure the container
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({
    width: 0,
    height: 0,
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

  const [colorMode, setColorMode] = useState<ColorMode>("tuner-perf");
  const [previewColorMode] = useState<ColorMode | null>(null);
  const [coverageMetric, setCoverageMetric] = useState<"mean" | "cumulative">("cumulative");
  // hover: drives tooltip
  const [hoveredClusterId, setHoveredClusterId] = useState<number | null>(null);
  // Hovering a label highlights its region without picking a specific cell —
  // separate from cell-hover so the cart button / black stroke don't appear.
  const [hoveredLabelIdx, setHoveredLabelIdx] = useState<number | null>(null);
  // Hovered tuner from ControlsBar — in Overview mode this highlights cells
  // dominated by that tuner with its color and washes the rest with MIXED.
  const [hoveredTuner, setHoveredTuner] = useState<TunerType | null>(null);
  // Pinned tuners (up to 2). First pin = solid color, second = hatch pattern.
  const [pinnedTuners, setPinnedTuners] = useState<TunerType[]>([]);
  const togglePin = useCallback((t: TunerType) => {
    setPinnedTuners((curr) => {
      if (curr.includes(t)) return curr.filter((x) => x !== t);
      if (curr.length >= 2) return [...curr.slice(1), t];
      return [...curr, t];
    });
  }, []);
  // Hover preview takes precedence over pins.
  const activeTuner = hoveredTuner ?? (pinnedTuners.length === 1 ? pinnedTuners[0] : null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const selectedParam = selectedParamProp;
  const setSelectedParam = onParamSelect ?? (() => {});

  const [internalSelectedTuners] = useState<Set<TunerType>>(
    () => new Set(TUNER_NAMES),
  );
  const selectedTuners = selectedTunersProp ?? internalSelectedTuners;
  const emptyCart = useMemo(() => new Set<number>(), []);
  const cartIds = cartIdsProp ?? emptyCart;
  // Detail level (L0..L4); L3 default
  const [detailLevel, setDetailLevel] = useState(3);

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

  // Load parameter importance for auto-select & select box
  const [paramImportanceList, setParamImportanceList] = useState<
    { name: string; importance: number }[]
  >([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/data/param_importance.json")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const list = d?.[program]?.["_combined"] ?? [];
        setParamImportanceList(list);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [program]);

  // Auto-select top param when switching to tuner-param with no param selected
  const onParamSelectRef = useRef(setSelectedParam);
  onParamSelectRef.current = setSelectedParam;

  const wrappedSetColorMode = useCallback(
    (mode: ColorMode) => {
      // Clear param selection when leaving tuner-param so default top-5
      // contrastive regions show again on next entry.
      if (mode !== "tuner-param") {
        onParamSelectRef.current(null);
      }
      setColorMode(mode);
    },
    [],
  );

  // Effective values (preview overrides actual for hover preview)
  const effectiveDetailLevel = detailLevel;
  const effectiveColorMode = previewColorMode ?? colorMode;

  // Active data for current detail level
  const data = allLevels[effectiveDetailLevel] ?? null;
  const HEX_SIZE = data?.hexSize ?? HEX_SIZE_DEFAULT;

  // Compute transform to fit and center the honeycomb
  const { centerX, centerY, scale } = useMemo(() => {
    if (!data || data.hexTiles.length === 0) {
      return {
        centerX: svgWidth / 2,
        centerY: height / 2,
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

    // Roomy padding so callouts have margin to land in. Vertical gets more
    // because top/bottom labels sit between data and SVG edge — without extra
    // vertical headroom they'd glue to the screen edge.
    const PAD_X = 80;
    const PAD_Y = 110;
    const scaleX = (svgWidth - PAD_X * 2) / dataWidth;
    const scaleY = (height - PAD_Y * 2) / dataHeight;
    const fitScale = Math.min(scaleX, scaleY, 1.2);

    return {
      centerX: svgWidth / 2,
      centerY: height / 2,
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

  // Reset hover when detail level changes
  useEffect(() => {
    setHoveredClusterId(null);
  }, [effectiveDetailLevel]);





  // Extract coverage value from cluster based on selected metric
  const getClusterCov = useCallback(
    (c: Cluster): number => {
      // Filter trials by selected tuners
      const trials = c.trials.filter((t) => selectedTuners.has(t.tuner));
      if (trials.length === 0) return 0;

      if (coverageMetric === "mean") return trials.reduce((s, t) => s + t.coverage, 0) / trials.length;
      if (coverageMetric === "cumulative") {
        // Union of branches from selected tuners' trials
        // Per-trial coveredBranches may be stripped in precomputed data; fall back to cluster-level
        const hasTrialBranches = trials.some((t) => t.coveredBranches && t.coveredBranches.length > 0);
        if (hasTrialBranches) {
          const branchSet = new Set<number>();
          for (const t of trials) {
            for (const b of (t.coveredBranches ?? [])) branchSet.add(b);
          }
          return branchSet.size;
        }
        // Fallback: use cluster-level coveredBranches (not filtered by tuner)
        return c.coveredBranches.length;
      }
      return trials.reduce((s, t) => s + t.coverage, 0) / trials.length;
    },
    [coverageMetric, selectedTuners],
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
      const { min: gMin, max: gMax } = globalCovRange;
      const range = gMax - gMin;
      if (range <= 0) return d3.interpolateYlOrBr(0.5);
      const t = Math.max(0, Math.min(1, (coverage - gMin) / range));
      return d3.interpolateYlOrBr(t);
    },
    [globalCovRange],
  );


  // Helper: get the union of branches for selected tuners in a cluster
  const getFilteredBranches = useCallback((cluster: import("../../utils/hexMapUtils").Cluster): Set<number> => {
    const result = new Set<number>();
    if (cluster.tunerCoveredBranches) {
      for (const t of TUNER_NAMES) {
        if (!selectedTuners.has(t)) continue;
        const branches = cluster.tunerCoveredBranches[t];
        if (branches) for (const b of branches) result.add(b);
      }
    } else {
      // Fallback: use full coveredBranches if tunerCoveredBranches not available
      for (const b of cluster.coveredBranches) result.add(b);
    }
    return result;
  }, [selectedTuners]);

  // T3: complementarity scores — cart union if non-empty, else single anchor
  const t3Scores = useMemo(() => {
    if (!data || cartIds.size === 0) return null;

    // Reference branch set = union of cart clusters' branches
    const refSet = new Set<number>();
    const refIds = new Set<number>();
    for (const cid of cartIds) {
      const cluster = data.clusters.find((c) => c.id === cid);
      if (cluster) {
        refIds.add(cid);
        const branches = getFilteredBranches(cluster);
        for (const b of branches) refSet.add(b);
      }
    }

    const scores = new Map<number, number>();
    let maxScore = 0;
    for (const c of data.clusters) {
      if (refIds.has(c.id)) { scores.set(c.id, 0); continue; }
      const cBranches = getFilteredBranches(c);
      let newCount = 0;
      for (const b of cBranches) {
        if (!refSet.has(b)) newCount++;
      }
      scores.set(c.id, newCount);
      if (newCount > maxScore) maxScore = newCount;
    }
    return { scores, maxScore, anchorBranchCount: refSet.size };
  }, [data, cartIds, getFilteredBranches]);

  // T3: top-5 most complementary cluster IDs (for border highlight)
  const t3TopIds = useMemo(() => {
    if (!t3Scores) return new Set<number>();
    const sorted = [...t3Scores.scores.entries()]
      .filter(([id]) => !cartIds.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id]) => id);
    return new Set(sorted);
  }, [t3Scores, cartIds]);

  // Push cart data to parent for CartPanel
  const onCartDataUpdateRef = useRef(onCartDataUpdate);
  onCartDataUpdateRef.current = onCartDataUpdate;

  useEffect(() => {
    if (!data || cartIds.size === 0) {
      onCartDataUpdateRef.current?.(null);
      return;
    }
    // Iterate cartIds in insertion order so the panel mirrors the user's
    // shift-click history, and so per-cell "newly added" counts are meaningful.
    const clusters: import("../../utils/hexMapUtils").Cluster[] = [];
    const addInfo = new Map<number, { order: number; added: number }>();
    const unionBranches = new Set<number>();
    let i = 0;
    for (const cid of cartIds) {
      const c = data.clusters.find((cl) => cl.id === cid);
      if (!c) continue;
      const branches = getFilteredBranches(c);
      let added = 0;
      for (const b of branches) {
        if (!unionBranches.has(b)) {
          unionBranches.add(b);
          added++;
        }
      }
      clusters.push(c);
      addInfo.set(c.id, { order: ++i, added });
    }
    const tub = data.totalUniqueBranches;
    onCartDataUpdateRef.current?.({
      clusters,
      addInfo,
      unionBranches,
      unionCoverage: tub > 0 ? unionBranches.size / tub : 0,
      totalUniqueBranches: tub,
    });
  }, [data, cartIds, getFilteredBranches]);

  // getParamType imported from colorUtils

  // Detect selected parameter type
  const selectedParamType = useMemo(():
    | "boolean"
    | "numeric"
    | "categorical"
    | null => {
    if (!selectedParam) return null;
    return getParamType(selectedParam);
  }, [selectedParam]);

  // ── Compute per-cluster bin assignment for an arbitrary parameter ──
  // Reused by both the live `paramCellBins` (current selectedParam) and the
  // default top-5 region overlay in tuner-param mode.
  const binsForParam = useCallback(
    (
      pname: string,
      ptype: "boolean" | "numeric" | "categorical",
    ): {
      bins: Map<number, string>;
      binNames: string[];
      binColors: Record<string, string>;
    } | null => {
      if (!data) return null;
      // For backwards compatibility with the original code, alias `selectedParam`
      // to the requested param name in this scope.
      const selectedParam = pname;

    const bins = new Map<number, string>();

    // Per-cluster trials restricted to the currently-selected tuners.
    const filteredTrialsByCluster = new Map<number, typeof data.clusters[0]["trials"]>();
    for (const c of data.clusters) {
      filteredTrialsByCluster.set(
        c.id,
        c.trials.filter((t) => selectedTuners.has(t.tuner)),
      );
    }

    if (ptype === "numeric") {
      // Collect all trial-level raw values (across selected tuners) for global range
      const allTrialVals: number[] = [];
      const clusterTrialVals = new Map<number, number[]>();
      for (const c of data.clusters) {
        const vals: number[] = [];
        const trials = filteredTrialsByCluster.get(c.id) ?? [];
        for (const t of trials) {
          const v = t.parameters[selectedParam];
          const n = typeof v === "number" ? v : Number(v) || 0;
          vals.push(n);
          allTrialVals.push(n);
        }
        vals.sort((a, b) => a - b);
        clusterTrialVals.set(c.id, vals);
      }
      allTrialVals.sort((a, b) => a - b);

      const globalMin = allTrialVals[0] ?? 0;
      const globalMax = allTrialVals[allTrialVals.length - 1] ?? 1;
      const globalRange = globalMax - globalMin || 1;
      const gP33 = allTrialVals[Math.floor(allTrialVals.length / 3)] ?? globalMin;
      const gP66 = allTrialVals[Math.floor((allTrialVals.length * 2) / 3)] ?? globalMax;

      const fmt = (v: number) =>
        Math.abs(v) >= 1000 ? v.toFixed(0) : v < 0.01 ? v.toFixed(3) : v < 1 ? v.toFixed(2) : v.toFixed(1);
      const lowLabel = `Low [${fmt(globalMin)}–${fmt(gP33)}]`;
      const midLabel = `Mid (${fmt(gP33)}–${fmt(gP66)}]`;
      const highLabel = `High (${fmt(gP66)}–${fmt(globalMax)}]`;

      for (const c of data.clusters) {
        const vals = clusterTrialVals.get(c.id) ?? [];
        if (vals.length === 0) {
          bins.set(c.id, "Mixed");
          continue;
        }

        if (vals.length >= 4) {
          const q1 = vals[Math.floor(vals.length * 0.25)];
          const q3 = vals[Math.floor(vals.length * 0.75)];
          const iqr = q3 - q1;
          if (iqr / globalRange > 0.5) {
            bins.set(c.id, "Mixed");
            continue;
          }
        }

        const median = vals[Math.floor(vals.length / 2)] ?? 0;
        if (median <= gP33) bins.set(c.id, lowLabel);
        else if (median <= gP66) bins.set(c.id, midLabel);
        else bins.set(c.id, highLabel);
      }
      return {
        bins,
        binNames: [lowLabel, midLabel, highLabel, "Mixed"],
        binColors: {
          [lowLabel]: "#BFDBFE",
          [midLabel]: "#3B82F6",
          [highLabel]: "#1E3A8A",
          Mixed: MIXED_COLOR,
        },
      };
    }

    if (ptype === "boolean") {
      for (const c of data.clusters) {
        const trials = filteredTrialsByCluster.get(c.id) ?? [];
        if (trials.length === 0) { bins.set(c.id, "Mixed"); continue; }
        const trueCount = trials.filter((t) => t.parameters[selectedParam] === true).length;
        const ratio = trueCount / trials.length;
        if (ratio > 0.7) bins.set(c.id, "Mostly True");
        else if (ratio < 0.3) bins.set(c.id, "Mostly False");
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

    // Categorical: take the category inventory from centroid keys, but compute
    // the dominant/second ratios from the filtered trials themselves.
    const prefix = selectedParam + "__";
    const catKeys = Object.keys(data.clusters[0].centroid)
      .filter((k) => k.startsWith(prefix))
      .sort();
    if (catKeys.length === 0) return null;

    const catValues = catKeys.map((k) => k.slice(prefix.length));

    for (const c of data.clusters) {
      const trials = filteredTrialsByCluster.get(c.id) ?? [];
      if (trials.length === 0) { bins.set(c.id, "Mixed"); continue; }

      const counts = new Map<string, number>();
      for (const t of trials) {
        const v = String(t.parameters[selectedParam]);
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      let maxVal = -1, secondMax = -1, dominant = "";
      for (const cat of catValues) {
        const frac = (counts.get(cat) ?? 0) / trials.length;
        if (frac > maxVal) { secondMax = maxVal; maxVal = frac; dominant = cat; }
        else if (frac > secondMax) { secondMax = frac; }
      }
      if (maxVal < 0.45 || maxVal - secondMax < 0.15) bins.set(c.id, "Mixed");
      else bins.set(c.id, dominant);
    }

    const binColors: Record<string, string> = { Mixed: MIXED_COLOR };
    catValues.forEach((v, i) => {
      binColors[v] = CAT_PALETTE[i % CAT_PALETTE.length];
    });
    const binNames = [...catValues, "Mixed"];

    return { bins, binNames, binColors };
    },
    [data, selectedTuners],
  );

  // ── Per-cluster param bin for the currently-selected parameter ──
  const paramCellBins = useMemo(() => {
    if (!selectedParam || !selectedParamType) return null;
    return binsForParam(selectedParam, selectedParamType);
  }, [selectedParam, selectedParamType, binsForParam]);

  // Get hex fill
  const getHexFill = useCallback(
    (tile: HexTile): string | null => {
      if (!tile.cluster) return "#F1F5F9";

      switch (effectiveColorMode) {
        case "tuner-perf": {
          // Overview: color by dominant tuner among selected. Cell colored by
          // a tuner's color when that tuner has ≥50% of the cell's selected
          // trials; otherwise MIXED_COLOR.
          // When a tuner is hovered in the toolbar, ONLY cells dominated by
          // that tuner show its color — everything else falls back to MIXED.
          let total = 0;
          let domCount = 0;
          let domTuner: TunerType = TUNER_NAMES[0];
          for (const t of TUNER_NAMES) {
            if (!selectedTuners.has(t)) continue;
            const c = tile.cluster.tunerCounts[t];
            total += c;
            if (c > domCount) {
              domCount = c;
              domTuner = t;
            }
          }
          if (total === 0) return "#F1F5F9";
          // Hover preview always takes precedence over pins.
          if (hoveredTuner) {
            return tile.cluster.tunerCounts[hoveredTuner] > 0
              ? TUNER_COLORS[hoveredTuner]
              : MIXED_COLOR;
          }
          // Two pins: first = solid, second = hatch (over MIXED bg),
          // overlap (both present) = hatch in second color OVER first color.
          if (pinnedTuners.length === 2) {
            const has0 = tile.cluster.tunerCounts[pinnedTuners[0]] > 0;
            const has1 = tile.cluster.tunerCounts[pinnedTuners[1]] > 0;
            if (has0 && has1) return "url(#hatch-overlap)";
            if (has0) return TUNER_COLORS[pinnedTuners[0]];
            if (has1) return `url(#hatch-${pinnedTuners[1]})`;
            return MIXED_COLOR;
          }
          // Single pin (or none) — activeTuner already covers single pin case.
          if (activeTuner) {
            return tile.cluster.tunerCounts[activeTuner] > 0
              ? TUNER_COLORS[activeTuner]
              : MIXED_COLOR;
          }
          return domCount / total >= 0.5
            ? TUNER_COLORS[domTuner]
            : MIXED_COLOR;
        }

        case "tuner-param": {
          if (!paramCellBins) return "#E2E8F0";
          const bin = paramCellBins.bins.get(tile.cluster.id);
          return bin ? (paramCellBins.binColors[bin] ?? MIXED_COLOR) : "#E2E8F0";
        }

        case "complementary": {
          if (!t3Scores) return "#F1F5F9"; // empty working set
          const score = t3Scores.scores.get(tile.cluster.id) ?? 0;
          const maxS = t3Scores.maxScore || 1;
          const t = Math.max(0, Math.min(1, score / maxS));
          return d3.interpolateRgb("#F1F5F9", "#10B981")(t);
        }

        default:
          return "#F8FAFC";
      }
    },
    [
      effectiveColorMode,
      paramCellBins,
      t3Scores,
      selectedTuners,
      activeTuner,
      hoveredTuner,
      pinnedTuners,
    ],
  );

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


  const renderScale = scale;

  // ── Notable cells: max/min coverage, densest/sparsest, tuner-exclusive, most diverse ──
  // Only counts trials from selected tuners; same set is shown in every mode.
  const highlightLabels = useMemo(() => {
    if (!data) return [];
    type Entry = {
      tile: HexTile;
      cluster: Cluster;
      cov: number;
      tcount: number;
      domTuner: TunerType;
      domShare: number; // [0,1]
    };
    const selectedList = TUNER_NAMES.filter((t) => selectedTuners.has(t));
    const eligible: Entry[] = [];
    for (const tile of data.hexTiles) {
      if (!tile.cluster) continue;
      let tcount = 0;
      for (const t of selectedList) tcount += tile.cluster.tunerCounts[t];
      if (tcount === 0) continue;

      let domTuner: TunerType = selectedList[0];
      let domCount = 0;
      for (const t of selectedList) {
        const ct = tile.cluster.tunerCounts[t];
        if (ct > domCount) {
          domCount = ct;
          domTuner = t;
        }
      }
      eligible.push({
        tile,
        cluster: tile.cluster,
        cov: getClusterCov(tile.cluster),
        tcount,
        domTuner,
        domShare: domCount / tcount,
      });
    }
    if (eligible.length === 0) return [];

    let maxCov = eligible[0];
    let minCov = eligible[0];
    let dense = eligible[0];
    let sparse = eligible[0];
    for (const e of eligible) {
      if (e.cov > maxCov.cov) maxCov = e;
      if (e.cov < minCov.cov) minCov = e;
      if (e.tcount > dense.tcount) dense = e;
      if (e.tcount < sparse.tcount) sparse = e;
    }

    type CellLabel = {
      tile: HexTile;
      clusterId: number;
      text?: { value: string; unit?: string };
      badge?: { tuner: TunerType };
    };
    // Each cell can hold one text label AND one badge — they stack vertically
    // so semantically distinct categories (e.g., Densest + tuner-exclusive)
    // can both be shown without one swallowing the other.
    const byCluster = new Map<number, CellLabel>();
    const ensure = (e: Entry): CellLabel => {
      let l = byCluster.get(e.cluster.id);
      if (!l) {
        l = { tile: e.tile, clusterId: e.cluster.id };
        byCluster.set(e.cluster.id, l);
      }
      return l;
    };
    const pushText = (e: Entry, value: string, unit?: string) => {
      const l = ensure(e);
      if (l.text) return; // first text wins (priority order)
      l.text = { value, unit };
    };
    const fmt = (n: number) => Math.round(n).toLocaleString();
    if (effectiveColorMode === "complementary") {
      // Cart members: show their cluster id (#N) so the working set is
      // identifiable on the map.
      for (const e of eligible) {
        if (cartIds.has(e.cluster.id)) {
          pushText(e, `#${e.cluster.id + 1}`);
        }
      }
      // Rank non-cart cells by how many new branches they'd add. Use a glyph
      // distinct from "#N" for ranks 2 and 3 to avoid confusion with ids.
      if (t3Scores && t3Scores.maxScore > 0) {
        const ranked = eligible
          .map((e) => ({ e, s: t3Scores.scores.get(e.cluster.id) ?? 0 }))
          .filter((x) => x.s > 0 && !cartIds.has(x.e.cluster.id))
          .sort((a, b) => b.s - a.s);
        if (ranked[0]) pushText(ranked[0].e, `+${fmt(ranked[0].s)}`);
        if (ranked[1]) pushText(ranked[1].e, "No. 2");
        if (ranked[2]) pushText(ranked[2].e, "No. 3");
      }
    } else {
      pushText(maxCov, fmt(maxCov.cov));
      pushText(minCov, fmt(minCov.cov));
      pushText(dense, fmt(dense.tcount), "trials");
      pushText(sparse, fmt(sparse.tcount), "trials");
    }
    return Array.from(byCluster.values());
  }, [data, selectedTuners, getClusterCov, effectiveColorMode, t3Scores, cartIds]);

  // Map clusterId → density tier (low/mid/high) by fixed trial-count buckets:
  //   low  : ≤ 100
  //   mid  : 101–1000
  //   high : > 1000
  const cellSizeTier = useMemo(() => {
    const tierMap = new Map<number, "low" | "mid" | "high">();
    const LOW_MAX = 100;
    const MID_MAX = 1000;
    if (!data) return { tierMap, lowMax: LOW_MAX, midMax: MID_MAX };
    for (const c of data.clusters) {
      let total = 0;
      for (const t of TUNER_NAMES) {
        if (selectedTuners.has(t)) total += c.tunerCounts[t];
      }
      if (total === 0) continue;
      if (total <= LOW_MAX) tierMap.set(c.id, "low");
      else if (total <= MID_MAX) tierMap.set(c.id, "mid");
      else tierMap.set(c.id, "high");
    }
    return { tierMap, lowMax: LOW_MAX, midMax: MID_MAX };
  }, [data, selectedTuners]);
  const cellScaleOf = useCallback(
    (clusterId: number | null | undefined) => {
      if (clusterId == null) return 1;
      const t = cellSizeTier.tierMap.get(clusterId);
      return t === "high" ? 1.25 : t === "low" ? 0.7 : 1;
    },
    [cellSizeTier],
  );

  // ── Region labels in tuner-perf and tuner-param modes ──
  // Coverage categories (tuner-perf, most-specific first):
  //   1. Underexplored Promising: cov ≥ p75 AND tcount ≤ p25
  //   2. Overexplored but Low:    cov ≤ p25 AND tcount ≥ p75
  //   3. High-Coverage Zone:      cov ≥ p75
  //   4. Low-Coverage Zone:       cov ≤ p25
  //   5. Coverage Plateau:        cov ∈ [p33, p67]  (size ≥ 3)
  // Parameter mode (tuner-param): one region per non-Mixed bin of the
  // currently-selected parameter (bin name + bin color).
  const coverageRegions = useMemo(() => {
    if (!data) return [];
    type Cell = { tile: HexTile; cov: number; tcount: number };
    const cellByKey = new Map<string, Cell>();
    for (const tile of data.hexTiles) {
      if (!tile.cluster) continue;
      let tcount = 0;
      for (const t of TUNER_NAMES) {
        if (selectedTuners.has(t)) tcount += tile.cluster.tunerCounts[t];
      }
      if (tcount === 0) continue;
      cellByKey.set(`${tile.q},${tile.r}`, {
        tile,
        cov: getClusterCov(tile.cluster),
        tcount,
      });
    }
    if (cellByKey.size === 0) return [];

    const cells = Array.from(cellByKey.values());
    const pct = (vals: number[], p: number) => {
      const sorted = [...vals].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    };
    const covs = cells.map((c) => c.cov);
    const tcs = cells.map((c) => c.tcount);
    const covP25 = pct(covs, 0.25);
    const covP33 = pct(covs, 0.33);
    const covP67 = pct(covs, 0.67);
    const covP75 = pct(covs, 0.75);
    const tcP25 = pct(tcs, 0.25);
    const tcP75 = pct(tcs, 0.75);


    const claimed = new Set<string>();
    type RawRegion = {
      label: string;
      lines: string[];
      color: string;
      borderPath: string;
      clusterIds: Set<number>;
      cellPoints: {
        x: number;
        y: number;
        q: number;
        r: number;
        clusterId: number;
      }[];
      cx: number;
      cy: number;
      outDx: number;
      outDy: number;
      bestX: number;
      bestY: number;
      size: number;
      kind: "category" | "tuner" | "combined";
      // For "combined": tuner badge fields layered onto a category region.
      tunerLabel?: string;
      tunerColor?: string;
    };
    type Region = RawRegion & {
      labelX: number;
      labelY: number;
      // SINGLE leader path. For multi-cell regions: a smooth curve top→label
      // →bottom (two quadratic Bezier segments joined at the label). For
      // single-cell or degenerate regions: just one Q segment vertex→label.
      leaderPath: string;
      // Handle dot positions (1 or 2 endpoints of the leader path).
      handles: { x: number; y: number }[];
    };
    const rawRegions: RawRegion[] = [];

    // Two-line wrap so wide labels don't extend deep into the cells when their
    // slot is near a screen edge and the placement clamps inward.
    const splitLabel = (s: string): string[] => {
      if (s.length <= 14) return [s];
      const i = s.lastIndexOf(" ");
      if (i < 0) return [s];
      return [s.slice(0, i), s.slice(i + 1)];
    };

    // Hex vertices (flat-top, matches HEX_DIRECTIONS edge ordering)
    const verts = Array.from({ length: 6 }, (_, i) => ({
      x: HEX_SIZE * Math.cos((i * Math.PI) / 3),
      y: HEX_SIZE * Math.sin((i * Math.PI) / 3),
    }));

    const buildRegion = (
      compKeys: string[],
      label: string,
      color: string,
      customLines?: string[],
      kind: "category" | "tuner" = "category",
    ): RawRegion => {
      const compSet = new Set(compKeys);
      const clusterIds = new Set<number>();
      const cellPoints: {
        x: number;
        y: number;
        q: number;
        r: number;
        clusterId: number;
      }[] = [];
      let sx = 0;
      let sy = 0;
      for (const k of compKeys) {
        const c = cellByKey.get(k)!;
        sx += c.tile.x;
        sy += c.tile.y;
        cellPoints.push({
          x: c.tile.x,
          y: c.tile.y,
          q: c.tile.q,
          r: c.tile.r,
          clusterId: c.tile.cluster?.id ?? -1,
        });
        if (c.tile.cluster) clusterIds.add(c.tile.cluster.id);
      }
      const cx = sx / compKeys.length;
      const cy = sy / compKeys.length;

      // Outward direction from data center; if region sits exactly at center, fall back to "up".
      let dx = cx - dataCenter.x;
      let dy = cy - dataCenter.y;
      const dlen = Math.hypot(dx, dy);
      if (dlen < 1e-6) {
        dx = 0;
        dy = -1;
      } else {
        dx /= dlen;
        dy /= dlen;
      }

      // Border path + the cell whose center is most outward (leader line anchor).
      let bp = "";
      let bestProj = -Infinity;
      let bestX = cx;
      let bestY = cy;
      for (const k of compKeys) {
        const c = cellByKey.get(k)!;
        const proj = (c.tile.x - dataCenter.x) * dx + (c.tile.y - dataCenter.y) * dy;
        if (proj > bestProj) {
          bestProj = proj;
          bestX = c.tile.x;
          bestY = c.tile.y;
        }
        for (let ei = 0; ei < 6; ei++) {
          const dir = HEX_DIRECTIONS[ei];
          const nk = `${c.tile.q + dir.dq},${c.tile.r + dir.dr}`;
          if (!compSet.has(nk)) {
            const va = verts[ei];
            const vb = verts[(ei + 1) % 6];
            bp += `M${c.tile.x + va.x},${c.tile.y + va.y}L${c.tile.x + vb.x},${c.tile.y + vb.y}`;
          }
        }
      }

      return {
        label,
        lines: customLines ?? splitLabel(label),
        color,
        kind,
        borderPath: bp,
        clusterIds,
        cellPoints,
        cx,
        cy,
        outDx: dx,
        outDy: dy,
        bestX,
        bestY,
        size: compKeys.length,
      };
    };

    // Picks one component per category — the most representative for that label.
    const pickBestComponent = (
      predicate: (c: Cell) => boolean,
      minSize: number,
      score: (cells: Cell[]) => number,
      claimedSet: Set<string> = claimed,
    ): string[] | null => {
      const eligible = new Set<string>();
      for (const [k, c] of cellByKey) {
        if (claimedSet.has(k)) continue;
        if (predicate(c)) eligible.add(k);
      }
      const visited = new Set<string>();
      let best: { keys: string[]; score: number } | null = null;
      for (const start of eligible) {
        if (visited.has(start)) continue;
        const comp: string[] = [];
        const queue = [start];
        while (queue.length) {
          const cur = queue.shift()!;
          if (visited.has(cur)) continue;
          visited.add(cur);
          if (!eligible.has(cur)) continue;
          comp.push(cur);
          const c = cellByKey.get(cur)!;
          for (const dir of HEX_DIRECTIONS) {
            const nk = `${c.tile.q + dir.dq},${c.tile.r + dir.dr}`;
            if (eligible.has(nk) && !visited.has(nk)) queue.push(nk);
          }
        }
        if (comp.length < minSize) continue;
        const compCells = comp.map((k) => cellByKey.get(k)!);
        const s = score(compCells);
        if (!best || s > best.score) best = { keys: comp, score: s };
      }
      return best?.keys ?? null;
    };

    const addOne = (
      label: string,
      color: string,
      predicate: (c: Cell) => boolean,
      minSize: number,
      score: (cells: Cell[]) => number,
    ) => {
      const keys = pickBestComponent(predicate, minSize, score);
      if (!keys) return;
      for (const k of keys) claimed.add(k);
      rawRegions.push(buildRegion(keys, label, color));
    };

    const meanCov = (cs: Cell[]) => cs.reduce((s, c) => s + c.cov, 0) / cs.length;
    const meanTc = (cs: Cell[]) => cs.reduce((s, c) => s + c.tcount, 0) / cs.length;

    if (effectiveColorMode === "tuner-perf") {
      // All coverage-category labels share one neutral color so they read as a
      // distinct group from the tuner regions (which carry semantic tuner colors).
      const COV_NEUTRAL = "#475569";
      addOne(
        "Underexplored Promising",
        COV_NEUTRAL,
        (c) => c.cov >= covP75 && c.tcount <= tcP25,
        2,
        (cs) => meanCov(cs) - meanTc(cs) * 0,
      );
      addOne(
        "Overexplored but Low",
        COV_NEUTRAL,
        (c) => c.cov <= covP25 && c.tcount >= tcP75,
        2,
        (cs) => meanTc(cs),
      );
      addOne(
        "High-Coverage Zone",
        COV_NEUTRAL,
        (c) => c.cov >= covP75,
        2,
        (cs) => Math.max(...cs.map((c) => c.cov)),
      );
      addOne(
        "Low-Coverage Zone",
        COV_NEUTRAL,
        (c) => c.cov <= covP25,
        2,
        (cs) => -Math.min(...cs.map((c) => c.cov)),
      );
      addOne(
        "Coverage Plateau",
        COV_NEUTRAL,
        (c) => c.cov >= covP33 && c.cov <= covP67,
        3,
        (cs) => {
          const m = meanCov(cs);
          const v = cs.reduce((s, c) => s + (c.cov - m) ** 2, 0) / cs.length;
          return cs.length * 100 - Math.sqrt(v);
        },
      );
    } else if (effectiveColorMode === "tuner-param") {
      if (selectedParam && paramCellBins) {
        // Single-param mode: one region per non-Mixed bin.
        for (const binName of paramCellBins.binNames) {
          if (binName === "Mixed") continue;
          const color = paramCellBins.binColors[binName];
          if (!color) continue;
          addOne(
            binName,
            color,
            (c) =>
              c.tile.cluster
                ? paramCellBins.bins.get(c.tile.cluster.id) === binName
                : false,
            2,
            (cs) => cs.length,
          );
        }
      } else {
        // Default tuner-param view (no specific param selected): show the
        // largest contrastive region for each of the top-5 important
        // parameters. Each region is colored from CAT_PALETTE so the params
        // are visually distinguished from each other (not from each bin).
        const TOP_N_PARAMS = 5;
        const topParams = paramImportanceList.slice(0, TOP_N_PARAMS);
        let palettePos = 0;
        for (const { name: pname, importance } of topParams) {
          const ptype = getParamType(pname);
          const binData = binsForParam(pname, ptype);
          if (!binData) continue;
          let bestKeys: string[] | null = null;
          let bestBin = "";
          for (const binName of binData.binNames) {
            if (binName === "Mixed") continue;
            const keys = pickBestComponent(
              (c) =>
                c.tile.cluster
                  ? binData.bins.get(c.tile.cluster.id) === binName
                  : false,
              2,
              (cs) => cs.length,
            );
            if (keys && (!bestKeys || keys.length > bestKeys.length)) {
              bestKeys = keys;
              bestBin = binName;
            }
          }
          if (bestKeys) {
            const color = CAT_PALETTE[palettePos % CAT_PALETTE.length];
            palettePos++;
            for (const k of bestKeys) claimed.add(k);
            const impStr = importance.toFixed(1);
            rawRegions.push(
              buildRegion(
                bestKeys,
                `${pname} (${impStr}): ${bestBin}`,
                color,
                [`${pname} (${impStr})`, bestBin],
              ),
            );
          }
        }
      }
    }

    // ── Label placement: snap to closest SVG side, distribute along it ──
    // Each region picks the SVG side (top/right/bottom/left) closest to it,
    // labels on the same side are spread along that side by perpendicular
    // coordinate (sweep to avoid overlap). Leader is a straight line from the
    // region cell nearest to the label out to the label.
    const sCenterX = svgWidth / 2;
    const sCenterY = height / 2;
    // Min distance from SVG edge to the label box so labels don't visually
    // glue to the SVG border when the data extends close to it.
    const screenMargin = 28;
    const charPx = 7.6; // approx avg sans-serif width at 13px
    const lineHpx = 14;
    const boxPadX = 20;
    const boxPadY = 10;
    const labelGapPx = 10;

    // Extra vertical breathing room between the tuner row and the category
    // rows in a "combined" label.
    const COMBINED_ROW_GAP = 10;
    const boxSize = (lines: string[], kind?: RawRegion["kind"]) => {
      const maxLen = Math.max(...lines.map((l) => l.length));
      return {
        w: maxLen * charPx + boxPadX * 2,
        h:
          lines.length * lineHpx +
          boxPadY * 2 +
          (kind === "combined" ? COMBINED_ROW_GAP : 0),
      };
    };

    // ── Merge fully-overlapping tuner + category regions into one ──
    // When a tuner-dominant region spans exactly the same cells as a category
    // region (same cluster set), collapse them into a single "combined" label
    // so the user doesn't see two stacked labels for the same patch of cells.
    {
      const sameClusterSet = (a: Set<number>, b: Set<number>) => {
        if (a.size !== b.size) return false;
        for (const x of a) if (!b.has(x)) return false;
        return true;
      };
      const mergedOut: RawRegion[] = [];
      const consumed = new Set<number>();
      for (let i = 0; i < rawRegions.length; i++) {
        if (consumed.has(i)) continue;
        const ri = rawRegions[i];
        let pairJ = -1;
        for (let j = i + 1; j < rawRegions.length; j++) {
          if (consumed.has(j)) continue;
          const rj = rawRegions[j];
          // One must be tuner, the other category — same kind would mean two
          // categories or two tuner labels collapsing, which we don't want.
          const oneTuner =
            (ri.kind === "tuner" && rj.kind === "category") ||
            (ri.kind === "category" && rj.kind === "tuner");
          if (oneTuner && sameClusterSet(ri.clusterIds, rj.clusterIds)) {
            pairJ = j;
            break;
          }
        }
        if (pairJ < 0) {
          mergedOut.push(ri);
          continue;
        }
        consumed.add(pairJ);
        const rj = rawRegions[pairJ];
        const tuner = ri.kind === "tuner" ? ri : rj;
        const cat = ri.kind === "tuner" ? rj : ri;
        mergedOut.push({
          ...cat,
          kind: "combined",
          // Two-line label: tuner pill row + category text row
          lines: [`${tuner.label} DOMINANT`, ...cat.lines],
          // Border / leader stay in the category neutral; tuner shows as pill
          color: cat.color,
          tunerLabel: tuner.label,
          tunerColor: tuner.color,
        });
      }
      rawRegions.length = 0;
      rawRegions.push(...mergedOut);
    }

    // ── Greedy nearest-empty placement ──
    // Each label sits just past its region's outward edge. If that spot is
    // blocked by other cells or already-placed labels, we expand outward in a
    // spiral (radial steps + perpendicular slides) and pick the first empty
    // position found. This packs labels close to the region they describe.

    // Pre-compute hex tile screen positions for cell-collision checks.
    // Helpers for bracket-aware placement.
    const wrapAng = (a: number) => {
      let v = a;
      while (v > Math.PI) v -= 2 * Math.PI;
      while (v < -Math.PI) v += 2 * Math.PI;
      return v;
    };
    const distSP = (
      ax: number, ay: number,
      bx: number, by: number,
      px: number, py: number,
    ) => {
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 1e-6) return Math.hypot(px - ax, py - ay);
      let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    };

    const cellTilesScreen = data.hexTiles
      .filter((t) => t.cluster)
      .map((t) => {
        const sFactor = cellScaleOf(t.cluster!.id);
        return {
          cx: (t.x - dataCenter.x) * scale + sCenterX,
          cy: (t.y - dataCenter.y) * scale + sCenterY,
          clusterId: t.cluster!.id,
          // Per-cell radius — high (oversized) cells get a bigger collision
          // circle so labels stay clear of their visual overflow.
          // Generous buffer around each hex so labels don't crowd neighbors.
          r: HEX_SIZE * scale * sFactor + 6,
        };
      });

    // Rectangle-vs-circle overlap (box centered at cx/cy with halfW/halfH).
    const rectCircleOverlap = (
      rcx: number, rcy: number, hw: number, hh: number,
      ccx: number, ccy: number, cr: number,
    ) => {
      const dx = Math.max(Math.abs(ccx - rcx) - hw, 0);
      const dy = Math.max(Math.abs(ccy - rcy) - hh, 0);
      return dx * dx + dy * dy < cr * cr;
    };
    const rectsOverlap = (
      ax: number, ay: number, aw: number, ah: number,
      bx: number, by: number, bw: number, bh: number,
      gap: number,
    ) =>
      Math.abs(ax - bx) * 2 < aw + bw + gap * 2 &&
      Math.abs(ay - by) * 2 < ah + bh + gap * 2;

    type Placed = {
      idx: number;
      sx: number;
      sy: number;
      box: { w: number; h: number };
      // Bracket endpoints in DATA coords (computed during placement so the
      // chosen label position is co-optimised with the bracket geometry).
      // Null only when the spiral fell back to an out-of-bounds slot.
      topV: { x: number; y: number } | null;
      botV: { x: number; y: number } | null;
    };
    const placedList: Placed[] = [];

    const hitsCell = (sx: number, sy: number, hw: number, hh: number, own: Set<number>) => {
      for (const t of cellTilesScreen) {
        if (own.has(t.clusterId)) continue;
        if (rectCircleOverlap(sx, sy, hw, hh, t.cx, t.cy, t.r)) return true;
      }
      return false;
    };
    const hitsLabel = (sx: number, sy: number, hw: number, hh: number) => {
      for (const p of placedList) {
        if (
          rectsOverlap(
            sx, sy, hw * 2, hh * 2,
            p.sx, p.sy, p.box.w, p.box.h,
            labelGapPx,
          )
        )
          return true;
      }
      return false;
    };
    const inSvg = (sx: number, sy: number, hw: number, hh: number) =>
      sx - hw >= screenMargin &&
      sx + hw <= svgWidth - screenMargin &&
      sy - hh >= screenMargin &&
      sy + hh <= height - screenMargin;

    // Spiral search from (cx, cy): radius increases, angles fan from outward.
    // Returns the FIRST collision-free position. Cell-overlap is hard-blocked;
    // SVG-bounds violation is soft-preferred against (out-of-svg only used as
    // last resort if no in-bounds clean spot exists at any reachable radius).

    // Bracket-aware spiral search:
    //   For each candidate label position we compute the BRACKET (top/bot
    //   region vertices that would be connected to it) and score the whole
    //   placement. Pick the candidate that yields the best bracket — short
    //   crossings, wide angular wrap, clean termination.
    const spiralSearch = (
      cx: number, cy: number,
      hw: number, hh: number,
      own: Set<number>,
      outwardAngle: number,
      startR: number,
      regionData: RawRegion,
      otherCellsData: { x: number; y: number; rad: number }[],
    ) => {
      type Vert = { x: number; y: number; rel: number; clean: boolean };
      type Bracket = {
        topV: Vert;
        botV: Vert;
        crossings: number; // count of OTHER region cells along top+bot segments
        span: number; // angular spread between top and bot (rad)
      };

      const evalBracket = (lx: number, ly: number): Bracket => {
        const baseAngle = Math.atan2(regionData.cy - ly, regionData.cx - lx);
        // Per-vertex precomputation: position, rel angle, clean flag
        // (clean = segment vertex→label doesn't pass through other regions)
        const verts: Vert[] = [];
        for (const cell of regionData.cellPoints) {
          for (let v = 0; v < 6; v++) {
            const a = (v * Math.PI) / 3;
            const vx = cell.x + HEX_SIZE * Math.cos(a);
            const vy = cell.y + HEX_SIZE * Math.sin(a);
            const rel = wrapAng(Math.atan2(vy - ly, vx - lx) - baseAngle);
            let clean = true;
            for (const oc of otherCellsData) {
              if (distSP(vx, vy, lx, ly, oc.x, oc.y) < oc.rad) {
                clean = false;
                break;
              }
            }
            verts.push({ x: vx, y: vy, rel, clean });
          }
        }
        // Pick top (max rel) and bot (min rel) — prefer clean candidates.
        const cleanVerts = verts.filter((v) => v.clean);
        const pool = cleanVerts.length > 0 ? cleanVerts : verts;
        let topV = pool[0];
        let botV = pool[0];
        for (const v of pool) {
          if (v.rel > topV.rel) topV = v;
          if (v.rel < botV.rel) botV = v;
        }
        // Count crossings on the actual chosen segments (precise score).
        const segCrossCount = (
          ax: number, ay: number,
          bx: number, by: number,
        ) => {
          let n = 0;
          for (const oc of otherCellsData) {
            if (distSP(ax, ay, bx, by, oc.x, oc.y) < oc.rad) n++;
          }
          return n;
        };
        const crossings =
          segCrossCount(topV.x, topV.y, lx, ly) +
          segCrossCount(botV.x, botV.y, lx, ly);
        const span = topV.rel - botV.rel;
        return { topV, botV, crossings, span };
      };

      const numAngles = 16;
      const angleStep = (2 * Math.PI) / numAngles;
      const dr = 6;
      const maxR = Math.hypot(svgWidth, height);

      let bestPos: {
        sx: number;
        sy: number;
        bracket: Bracket;
      } | null = null;
      let bestScore = Infinity;
      let outOfBounds: { sx: number; sy: number } | null = null;

      for (let r = startR; r < maxR; r += dr) {
        for (let aIdx = 0; aIdx < numAngles; aIdx++) {
          let offset = 0;
          if (aIdx > 0) {
            const mag = Math.ceil(aIdx / 2) * angleStep;
            offset = aIdx % 2 === 1 ? mag : -mag;
          }
          const theta = outwardAngle + offset;
          const sx = cx + r * Math.cos(theta);
          const sy = cy + r * Math.sin(theta);
          if (hitsCell(sx, sy, hw, hh, own)) continue;
          if (hitsLabel(sx, sy, hw, hh)) continue;
          if (!inSvg(sx, sy, hw, hh)) {
            if (!outOfBounds) outOfBounds = { sx, sy };
            continue;
          }
          // Convert to data coords for bracket evaluation.
          const lx = (sx - sCenterX) / (scale || 1) + dataCenter.x;
          const ly = (sy - sCenterY) / (scale || 1) + dataCenter.y;
          const bracket = evalBracket(lx, ly);
          const distFromRegion = Math.hypot(sx - cx, sy - cy);
          // Spacing bonus: prefer slots far from any already-placed label so
          // adjacent regions' labels don't crowd together. Capped at 240 px
          // so a single very-distant label can't dominate the score.
          let nearestLabel = Infinity;
          for (const placedItem of placedList) {
            const d = Math.hypot(sx - placedItem.sx, sy - placedItem.sy);
            if (d < nearestLabel) nearestLabel = d;
          }
          const spacingBonus = Math.min(nearestLabel, 240);
          // Score (lower = better). Crossings dominate; wider bracket span
          // and spacing from other labels both help; closer to region also
          // gets a tiny nudge.
          const score =
            bracket.crossings * 100 -
            bracket.span * 25 -
            spacingBonus * 0.45 +
            distFromRegion * 0.01;
          if (score < bestScore) {
            bestScore = score;
            bestPos = { sx, sy, bracket };
          }
        }
      }
      return (
        bestPos ??
        (outOfBounds
          ? { ...outOfBounds, bracket: null as Bracket | null }
          : null)
      );
    };

    // Process larger regions first so small ones can fit around them.
    const order = rawRegions
      .map((r, idx) => ({ r, idx }))
      .sort((a, b) => b.r.size - a.r.size);

    for (const { r, idx } of order) {
      // Step 1: highlight box size (already known via boxSize)
      const box = boxSize(r.lines, r.kind);
      const halfW = box.w / 2;
      const halfH = box.h / 2;

      // Centroid in screen coords + outward angle from svg center
      const cxS = (r.cx - dataCenter.x) * scale + sCenterX;
      const cyS = (r.cy - dataCenter.y) * scale + sCenterY;
      const outX = cxS - sCenterX;
      const outY = cyS - sCenterY;
      const outLen = Math.hypot(outX, outY);
      const outwardAngle = outLen < 1 ? -Math.PI / 2 : Math.atan2(outY, outX);

      // Region's cells in screen coords — used by spiral search for both
      // radial extent AND for evaluating leader-clear placements.
      const regionCellsScreen = r.cellPoints.map((p) => ({
        x: (p.x - dataCenter.x) * scale + sCenterX,
        y: (p.y - dataCenter.y) * scale + sCenterY,
      }));
      let regionRadius = 0;
      for (const p of regionCellsScreen) {
        const d = Math.hypot(p.x - cxS, p.y - cyS);
        if (d > regionRadius) regionRadius = d;
      }
      // Step 2: spiral search starting just outside the region perimeter.
      // Account for the cell's own visual extent (HEX_SIZE × scale) so the
      // label starts well outside the region's outer cells, not just past
      // their centers.
      const startR =
        regionRadius + HEX_SIZE * scale + Math.max(halfW, halfH) + 14;
      // Build per-region "other region cell" list (data coords + per-cell
      // radius) — fed to spiralSearch so bracket scoring can detect crossings
      // with the correct hex extent for low/mid/high-tier cells.
      const otherCellsData: { x: number; y: number; rad: number }[] = [];
      for (const tt of data.hexTiles) {
        if (!tt.cluster) continue;
        const cid = tt.cluster.id;
        let inOther = false;
        for (let ri = 0; ri < rawRegions.length; ri++) {
          if (ri === idx) continue;
          if (rawRegions[ri].clusterIds.has(cid)) {
            inOther = true;
            break;
          }
        }
        if (!inOther) continue;
        otherCellsData.push({
          x: tt.x,
          y: tt.y,
          rad: HEX_SIZE * cellScaleOf(cid) * 0.92,
        });
      }
      const pos = spiralSearch(
        cxS, cyS, halfW, halfH, r.clusterIds, outwardAngle, startR,
        r, otherCellsData,
      );

      let chosenSx: number;
      let chosenSy: number;
      let topV: { x: number; y: number } | null = null;
      let botV: { x: number; y: number } | null = null;
      if (pos) {
        chosenSx = pos.sx;
        chosenSy = pos.sy;
        if (pos.bracket) {
          topV = { x: pos.bracket.topV.x, y: pos.bracket.topV.y };
          botV = { x: pos.bracket.botV.x, y: pos.bracket.botV.y };
        }
      } else {
        chosenSx = Math.max(
          screenMargin + halfW,
          Math.min(svgWidth - screenMargin - halfW, cxS),
        );
        chosenSy = Math.max(
          screenMargin + halfH,
          Math.min(height - screenMargin - halfH, cyS),
        );
      }

      placedList.push({ idx, sx: chosenSx, sy: chosenSy, box, topV, botV });
    }

    // Map back into the existing data shapes used by Step 3.
    const finalPos = new Map<number, { sx: number; sy: number }>();
    const bracketByIdx = new Map<
      number,
      { topV: { x: number; y: number }; botV: { x: number; y: number } } | null
    >();
    for (const p of placedList) {
      finalPos.set(p.idx, { sx: p.sx, sy: p.sy });
      bracketByIdx.set(p.idx, p.topV && p.botV ? { topV: p.topV, botV: p.botV } : null);
    }
    // Step 3: assemble region edge as Bezier curve. The bracket vertices
    // (topV, botV) were already chosen during placement so the label
    // position and edge geometry are co-optimised.
    const placed: Region[] = [];
    for (let idx = 0; idx < rawRegions.length; idx++) {
      const r = rawRegions[idx];
      const fp = finalPos.get(idx)!;
      const labelX = (fp.sx - sCenterX) / (scale || 1) + dataCenter.x;
      const labelY = (fp.sy - sCenterY) / (scale || 1) + dataCenter.y;

      const bracket = bracketByIdx.get(idx);
      // Fallback: if no bracket (out-of-bounds last-resort), fall back to a
      // single vertex on the closest region cell.
      let topV: { x: number; y: number };
      let botV: { x: number; y: number };
      if (bracket) {
        topV = bracket.topV;
        botV = bracket.botV;
      } else {
        let nearest = r.cellPoints[0];
        let minD2 = Infinity;
        for (const p of r.cellPoints) {
          const d2 = (p.x - labelX) ** 2 + (p.y - labelY) ** 2;
          if (d2 < minD2) {
            minD2 = d2;
            nearest = p;
          }
        }
        // Pick a single vertex closest to label as both endpoints.
        let bestV = { x: nearest.x, y: nearest.y };
        let bestD2 = Infinity;
        for (let v = 0; v < 6; v++) {
          const a = (v * Math.PI) / 3;
          const vx = nearest.x + HEX_SIZE * Math.cos(a);
          const vy = nearest.y + HEX_SIZE * Math.sin(a);
          const d2 = (vx - labelX) ** 2 + (vy - labelY) ** 2;
          if (d2 < bestD2) {
            bestD2 = d2;
            bestV = { x: vx, y: vy };
          }
        }
        topV = bestV;
        botV = bestV;
      }

      // Quadratic-Bezier control between an endpoint and the label, biased
      // perpendicularly AWAY from the region centroid so the curve hugs the
      // region from the label side.
      const buildCtrl = (V: { x: number; y: number }) => {
        const mx = (V.x + labelX) / 2;
        const my = (V.y + labelY) / 2;
        const dxV = labelX - V.x;
        const dyV = labelY - V.y;
        const segLen = Math.hypot(dxV, dyV) || 1;
        let pdx = -dyV / segLen;
        let pdy = dxV / segLen;
        const cdx = mx - r.cx;
        const cdy = my - r.cy;
        if (pdx * cdx + pdy * cdy < 0) {
          pdx = -pdx;
          pdy = -pdy;
        }
        return {
          x: mx + pdx * segLen * 0.16,
          y: my + pdy * segLen * 0.16,
        };
      };

      const sameVertex =
        Math.abs(topV.x - botV.x) < 0.5 && Math.abs(topV.y - botV.y) < 0.5;

      let leaderPath: string;
      let handles: { x: number; y: number }[];
      if (sameVertex) {
        const ctrl = buildCtrl(topV);
        leaderPath = `M${topV.x},${topV.y}Q${ctrl.x},${ctrl.y} ${labelX},${labelY}`;
        handles = [topV];
      } else {
        // ONE continuous SVG path: top → label → bottom via two joined
        // quadratic segments. Renders as a single smooth stroke.
        const cTop = buildCtrl(topV);
        const cBot = buildCtrl(botV);
        leaderPath =
          `M${topV.x},${topV.y}` +
          `Q${cTop.x},${cTop.y} ${labelX},${labelY}` +
          `Q${cBot.x},${cBot.y} ${botV.x},${botV.y}`;
        handles = [topV, botV];
      }

      placed.push({
        ...r,
        labelX,
        labelY,
        leaderPath,
        handles,
      });
    }
    return placed;
  }, [
    data,
    effectiveColorMode,
    selectedTuners,
    getClusterCov,
    paramCellBins,
    selectedParam,
    paramImportanceList,
    binsForParam,
    cellScaleOf,
    HEX_DIRECTIONS,
    HEX_SIZE,
    dataCenter,
    scale,
    svgWidth,
    height,
  ]);

  // Map clusterId → ALL region indices the cell belongs to, sorted by region
  // size ASCENDING (smallest first) so the smaller / more specific region is
  // pickable even if a larger region overlaps the same cell.
  const clusterToRegion = useMemo(() => {
    const m = new Map<number, number[]>();
    coverageRegions.forEach((r, i) => {
      for (const cid of r.clusterIds) {
        const arr = m.get(cid);
        if (arr) arr.push(i);
        else m.set(cid, [i]);
      }
    });
    for (const idxs of m.values()) {
      idxs.sort(
        (a, b) =>
          coverageRegions[a].clusterIds.size - coverageRegions[b].clusterIds.size,
      );
    }
    return m;
  }, [coverageRegions]);

  const hoveredRegionIdx = useMemo(() => {
    if (hoveredLabelIdx !== null) return hoveredLabelIdx;
    if (hoveredClusterId === null) return null;
    // Cell hover targets the smallest region the cell belongs to.
    return clusterToRegion.get(hoveredClusterId)?.[0] ?? null;
  }, [hoveredLabelIdx, hoveredClusterId, clusterToRegion]);

  // Cells claimed by a tuner-region — their in-cell tuner badge is replaced
  // by the region label outside the data, so we strip the badge here.
  const effectiveHighlightLabels = useMemo(() => {
    const tunerClaimed = new Set<number>();
    for (const r of coverageRegions) {
      // Combined regions absorbed a tuner region — strip badge there too.
      if (r.kind === "tuner" || r.kind === "combined") {
        for (const cid of r.clusterIds) tunerClaimed.add(cid);
      }
    }
    if (tunerClaimed.size === 0) return highlightLabels;
    const result: typeof highlightLabels = [];
    for (const lbl of highlightLabels) {
      if (!tunerClaimed.has(lbl.clusterId)) {
        result.push(lbl);
        continue;
      }
      // Strip the badge but keep any text label (e.g., Densest count)
      if (lbl.text) {
        result.push({ ...lbl, badge: undefined });
      }
    }
    return result;
  }, [highlightLabels, coverageRegions]);

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

  // Mouse handlers
  const onHoverChangeRef = useRef(onHoverChange);
  onHoverChangeRef.current = onHoverChange;

  const handleMouseEnter = useCallback(
    (tile: HexTile, e: React.MouseEvent) => {
      if (!tile.cluster) return;
      setHoveredClusterId(tile.cluster.id);
      onHoverChangeRef.current?.(tile.cluster.id);
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect)
        setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    },
    [],
  );

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect)
      setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoveredClusterId(null);
    onHoverChangeRef.current?.(null);
    setTooltipPos(null);
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
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", overflow: "hidden" }}>
      {/* Controls bar */}
      <ControlsBar
        detailLevel={detailLevel}
        setDetailLevel={setDetailLevel}
        allLevels={allLevels}
        colorMode={colorMode}
        setColorMode={wrappedSetColorMode}
        effectiveColorMode={effectiveColorMode}
        coverageMetric={coverageMetric}
        setCoverageMetric={setCoverageMetric}
        selectedParam={selectedParam}
        onParamSelect={setSelectedParam}
        paramList={paramImportanceList}
        t3Scores={t3Scores}
        cartSize={cartIds.size}
        selectedTuners={selectedTuners}
        onToggleTuner={onToggleTuner ?? (() => {})}
        onHoverTuner={setHoveredTuner}
        pinnedTuners={pinnedTuners}
        onPinTuner={togglePin}
      />
      <div
        ref={containerRef}
        style={{ flex: 1, position: "relative", minHeight: 0, overflow: "hidden" }}
      >
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {/* SVG Map */}
        <svg
          ref={svgRef}
          viewBox={`0 0 ${svgWidth} ${height}`}
          style={{ display: "block", width: "100%", height: "100%", flex: 1, minWidth: 0 }}
        >
          {/* Per-region clipPath: union of mid-size (HEX_SIZE) hex shapes per
              cell. Inset shadow uses this clip — using uniform HEX_SIZE
              regardless of low/mid/high tier so the shadow band thickness
              and shape stays consistent across the region. */}
          <defs>
            {/* Hatch pattern for "second-pin" tuner cells in Overview mode. */}
            {TUNER_NAMES.map((t) => (
              <pattern
                key={`hatch-${t}`}
                id={`hatch-${t}`}
                patternUnits="userSpaceOnUse"
                width="8"
                height="8"
                patternTransform="rotate(45)"
              >
                <rect width="8" height="8" fill={MIXED_COLOR} />
                <line
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="8"
                  stroke={TUNER_COLORS[t]}
                  strokeWidth="4"
                />
              </pattern>
            ))}
            {/* Overlap pattern: cells where BOTH pinned tuners have trials.
                Stripes in the second-pin color over a first-pin color bg. */}
            {pinnedTuners.length === 2 && (
              <pattern
                id="hatch-overlap"
                patternUnits="userSpaceOnUse"
                width="8"
                height="8"
                patternTransform="rotate(45)"
              >
                <rect
                  width="8"
                  height="8"
                  fill={TUNER_COLORS[pinnedTuners[0]]}
                />
                <line
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="8"
                  stroke={TUNER_COLORS[pinnedTuners[1]]}
                  strokeWidth="4"
                />
              </pattern>
            )}
            {coverageRegions.map((r, i) => (
              <clipPath
                key={`rclip-${i}`}
                id={`region-clip-${i}`}
                clipPathUnits="userSpaceOnUse"
              >
                {r.cellPoints.map((p, ci) => (
                  <path
                    key={ci}
                    d={hexPath}
                    transform={`translate(${p.x}, ${p.y})`}
                  />
                ))}
              </clipPath>
            ))}
          </defs>
          {/* ===== HEX GRID ===== */}
          <g
            style={{
              transform: `translate(${centerX}px, ${centerY}px) scale(${scale}) translate(${-dataCenter.x}px, ${-dataCenter.y}px)`,
            }}
          >
            {/* ── Hex tiles: hovered one rendered last so its + button isn't occluded by neighbors ── */}
            {[...data.hexTiles]
              .sort((a, b) => {
                // Hovered always last (on top).
                const aHover = a.cluster?.id === hoveredClusterId ? 1 : 0;
                const bHover = b.cluster?.id === hoveredClusterId ? 1 : 0;
                if (aHover !== bHover) return aHover - bHover;
                // Then by size tier so high (oversized) cells render last and
                // visually overflow onto neighbors.
                const aSize = cellScaleOf(a.cluster?.id);
                const bSize = cellScaleOf(b.cluster?.id);
                return aSize - bSize;
              })
              .map((tile) => {
              if (!tile.cluster) return null;

              const hasSelectedTuner = TUNER_NAMES.some(
                (t) =>
                  selectedTuners.has(t) && tile.cluster!.tunerCounts[t] > 0,
              );
              if (!hasSelectedTuner) return null;

              const fill = getHexFill(tile);
              const isHovered = hoveredClusterId === tile.cluster.id;
              const isExternallyHovered =
                externalHoveredClusterId !== null &&
                externalHoveredClusterId === tile.cluster.id;
              const isHighlighted = isHovered || isExternallyHovered;
              const cellRegions = tile.cluster
                ? clusterToRegion.get(tile.cluster.id) ?? null
                : null;
              const inHoveredRegion =
                hoveredRegionIdx !== null &&
                cellRegions !== null &&
                cellRegions.includes(hoveredRegionIdx);
              // When a cell sits inside multiple regions, the smaller one wins
              // by default; on hover, switch to the hovered region's color.
              const tileRegionIdx = inHoveredRegion
                ? hoveredRegionIdx
                : cellRegions !== null
                  ? cellRegions[0]
                  : null;

              const cellScale = cellScaleOf(tile.cluster.id);

              return (
                <g
                  key={`${tile.q},${tile.r}`}
                  transform={`translate(${tile.x}, ${tile.y}) scale(${cellScale})`}
                  onMouseEnter={(e) => handleMouseEnter(tile, e)}
                  onMouseMove={handleMouseMove}
                  onMouseLeave={handleMouseLeave}
                  onClick={(e) => {
                    e.stopPropagation();
                    // Shift+click: toggle cart
                    if (e.shiftKey) {
                      onCartToggle?.(tile.cluster!.id);
                    }
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <path
                    d={hexPath}
                    fill={fill || "#F8FAFC"}
                    stroke={
                      isHighlighted ? "#1E293B"
                        : (effectiveColorMode === "complementary" && tile.cluster && t3TopIds.has(tile.cluster.id))
                          ? "#059669"
                          : (tile.cluster && cartIds.has(tile.cluster.id))
                            ? "#1E293B"
                            : "#E2E8F0"
                    }
                    strokeWidth={
                      isHighlighted ? 2.5
                        : (effectiveColorMode === "complementary" && tile.cluster && t3TopIds.has(tile.cluster.id))
                          ? 2
                          : (tile.cluster && cartIds.has(tile.cluster.id))
                            ? 2
                            : 0.5
                    }
                    filter={isHighlighted ? "brightness(1.15)" : undefined}
                  />
                  {/* Tuner-param: full color wash on cells that belong to a region. */}
                  {tileRegionIdx !== null &&
                    effectiveColorMode === "tuner-param" && (
                      <path
                        d={hexPath}
                        fill={coverageRegions[tileRegionIdx].color}
                        fillOpacity={inHoveredRegion ? 0.5 : 0.28}
                        pointerEvents="none"
                      />
                    )}
                  {/* Inset shadow is drawn as a region-level border stroke
                      clipped to region cells (rendered outside this loop) so
                      only the OUTER perimeter gets the band — interior cells
                      stay clean. */}
                  {/* Cart marker: amber dot (non-hovered carted cells) */}
                  {cartIds.has(tile.cluster!.id) && !isHovered && (
                    <circle
                      cx={HEX_SIZE * 0.55}
                      cy={-HEX_SIZE * 0.55}
                      r={HEX_SIZE * 0.14}
                      fill="#F59E0B"
                      stroke="white"
                      strokeWidth={1.2}
                      pointerEvents="none"
                    />
                  )}
                  {/* Hover cart button: + or − (inside tile group so mouse doesn't leave) */}
                  {isHovered && (
                    <g
                      onClick={(e) => {
                        e.stopPropagation();
                        onCartToggle?.(tile.cluster!.id);
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <circle
                        cx={HEX_SIZE * 0.55}
                        cy={-HEX_SIZE * 0.55}
                        r={HEX_SIZE * 0.22}
                        fill={cartIds.has(tile.cluster!.id) ? "#F59E0B" : "#374151"}
                        stroke="white"
                        strokeWidth={1.5}
                      />
                      <text
                        x={HEX_SIZE * 0.55}
                        y={-HEX_SIZE * 0.55}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={HEX_SIZE * 0.28}
                        fontWeight={700}
                        fill="white"
                        pointerEvents="none"
                      >
                        {cartIds.has(tile.cluster!.id) ? "−" : "+"}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}



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

            {/* ── Notable-cell labels: optional text + optional tuner badge, stacked ── */}
            {effectiveHighlightLabels.map(({ tile, clusterId, text, badge }) => {
              const halo = 3 / renderScale;
              const valueSize = 12 / renderScale;
              const unitSize = 10 / renderScale;
              const lineGap = 4 / renderScale;
              const badgeFont = 11 / renderScale;
              const badgePadX = 6 / renderScale;
              const badgePadY = 3 / renderScale;
              const charW = badgeFont * 0.62;

              // Pre-compute the height of each piece so we can vertically center the stack.
              const textH = text
                ? valueSize + (text.unit ? lineGap + unitSize : 0)
                : 0;
              const badgeH = badge ? badgeFont + badgePadY * 2 : 0;
              const stackGap = text && badge ? 4 / renderScale : 0;
              const totalH = textH + stackGap + badgeH;

              let cursorY = tile.y - totalH / 2;

              return (
                <g key={`label-${clusterId}`} pointerEvents="none">
                  {text && (
                    <>
                      <text
                        x={tile.x}
                        y={cursorY + valueSize / 2}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={valueSize}
                        fontWeight={700}
                        fill="#0F172A"
                        stroke="white"
                        strokeWidth={halo}
                        paintOrder="stroke"
                        style={{ userSelect: "none" }}
                      >
                        {text.value}
                      </text>
                      {text.unit && (
                        <text
                          x={tile.x}
                          y={cursorY + valueSize + lineGap + unitSize / 2}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={unitSize}
                          fontWeight={600}
                          fill="#475569"
                          stroke="white"
                          strokeWidth={halo}
                          paintOrder="stroke"
                          style={{ userSelect: "none" }}
                        >
                          {text.unit}
                        </text>
                      )}
                    </>
                  )}
                  {badge && (() => {
                    cursorY += textH + stackGap;
                    const label = TUNER_DISPLAY_NAMES[badge.tuner];
                    const w = label.length * charW + badgePadX * 2;
                    const h = badgeH;
                    const cy = cursorY + h / 2;
                    return (
                      <g transform={`translate(${tile.x}, ${cy})`}>
                        <rect
                          x={-w / 2}
                          y={-h / 2}
                          width={w}
                          height={h}
                          rx={h / 2}
                          ry={h / 2}
                          fill={TUNER_COLORS[badge.tuner]}
                          stroke="white"
                          strokeWidth={1.5 / renderScale}
                        />
                        <text
                          x={0}
                          y={0}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={badgeFont}
                          fontWeight={700}
                          fill="white"
                          style={{ userSelect: "none" }}
                        >
                          {label}
                        </text>
                      </g>
                    );
                  })()}
                </g>
              );
            })}

            {/* ── Coverage-mode region callouts: border + leader line + label in margin ── */}
            {coverageRegions.map((r, i) => {
              const isHov = hoveredRegionIdx === i;
              const isOtherHov = hoveredRegionIdx !== null && !isHov;
              const fontSize = (isHov ? 14 : 13) / renderScale;
              const borderStrokeOuter = (isHov ? 6.5 : 5.5) / renderScale;
              const borderStrokeInner = (isHov ? 4 : 3) / renderScale;
              const leaderStroke = (isHov ? 1.8 : 1.2) / renderScale;
              const opacity = isOtherHov ? 0.35 : 1;
              // Borders use one neutral dark color so they don't compete with the
              // YlOrBr coverage fill. Categories are still differentiated by the
              // leader line + label color and the per-region hover wash.
              const BORDER_COLOR = "#0F172A";
              return (
                <g key={`region-${i}`} pointerEvents="none" opacity={opacity}>
                  {/* Inset shadow: thick stroke along the region perimeter,
                      clipped to the region cells so only the INNER half of
                      the stroke is visible — produces a band that hugs the
                      perimeter from the inside.
                      Round linecap/linejoin so the per-segment sub-paths
                      visually bridge across shared vertices (otherwise the
                      band looks broken at every cell corner). */}
                  <path
                    d={r.borderPath}
                    fill="none"
                    stroke={r.color}
                    strokeWidth={HEX_SIZE * 0.7}
                    strokeOpacity={isHov ? 0.55 : 0.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    clipPath={`url(#region-clip-${i})`}
                  />
                  {/* White underlay for border */}
                  <path
                    d={r.borderPath}
                    fill="none"
                    stroke="white"
                    strokeWidth={borderStrokeOuter}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={0.9}
                  />
                  {/* Region border (unified contrast color) */}
                  <path
                    d={r.borderPath}
                    fill="none"
                    stroke={BORDER_COLOR}
                    strokeWidth={borderStrokeInner}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={isHov ? 1 : 0.85}
                  />
                  {/* Single leader path — for multi-cell regions this curves
                      top→label→bottom as one continuous edge wrapping the region. */}
                  <path
                    d={r.leaderPath}
                    fill="none"
                    stroke="white"
                    strokeWidth={leaderStroke + 1.5 / renderScale}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={0.85}
                  />
                  <path
                    d={r.leaderPath}
                    fill="none"
                    stroke={r.color}
                    strokeWidth={leaderStroke}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  {/* Circular handle on each anchor vertex (1 or 2). */}
                  {r.handles.map((h, hi) => (
                    <circle
                      key={`h-${hi}`}
                      cx={h.x}
                      cy={h.y}
                      r={3.5 / renderScale}
                      fill={r.color}
                      stroke="white"
                      strokeWidth={1.4 / renderScale}
                    />
                  ))}
                  {/* Interactive label group — hovering it highlights the
                      region the same way as hovering one of its cells. */}
                  <g
                    pointerEvents="all"
                    style={{ cursor: "pointer" }}
                    onMouseEnter={() => setHoveredLabelIdx(i)}
                    onMouseLeave={() => setHoveredLabelIdx(null)}
                  >
                  {/* Backing pill — same shape for every label, white fill +
                      subtle border, sits behind text/badges. */}
                  {(() => {
                    const charPxR = 7.6 / renderScale;
                    const lineHpxR = 14 / renderScale;
                    const boxPadXR = 20 / renderScale;
                    const boxPadYR = 10 / renderScale;
                    const combinedRowGap = 10 / renderScale;
                    const maxLen = Math.max(...r.lines.map((l) => l.length));
                    const boxW = maxLen * charPxR + boxPadXR * 2;
                    const boxH =
                      r.lines.length * lineHpxR +
                      boxPadYR * 2 +
                      (r.kind === "combined" ? combinedRowGap : 0);
                    return (
                      <rect
                        x={r.labelX - boxW / 2}
                        y={r.labelY - boxH / 2}
                        width={boxW}
                        height={boxH}
                        rx={boxH / 2}
                        ry={boxH / 2}
                        fill="white"
                        stroke={r.color}
                        strokeWidth={(isHov ? 2.5 : 1.8) / renderScale}
                      />
                    );
                  })()}
                  {/* Label content:
                       - tuner    → inner pill + DOMINANT inline (single line)
                       - combined → tuner pill+DOMINANT row above category text
                       - category → plain text lines */}
                  {r.kind === "combined" ? (() => {
                    const pillFont = fontSize;
                    const pillPadX = 7 / renderScale;
                    const pillPadY = 3 / renderScale;
                    const charW = pillFont * 0.62;
                    const tunerAbbr = r.tunerLabel ?? "";
                    const pillW = tunerAbbr.length * charW + pillPadX * 2;
                    const pillH = pillFont + pillPadY * 2;
                    const subText = "DOMINANT";
                    const subW = subText.length * charW;
                    const innerGap = 6 / renderScale;
                    const totalW = pillW + innerGap + subW;
                    const lineH = fontSize * 1.05;
                    const interRowGap = 10 / renderScale;
                    // Top row = tuner pill + DOMINANT; below it, category lines
                    // separated by `interRowGap` for visual breathing room.
                    const catLines = r.lines.slice(1);
                    const tunerRowH = pillH;
                    const catBlockH = catLines.length * lineH;
                    const totalContentH = tunerRowH + interRowGap + catBlockH;
                    const startY = r.labelY - totalContentH / 2;
                    const topY = startY + tunerRowH / 2;
                    const catBlockStartY = startY + tunerRowH + interRowGap;
                    const pillCx = r.labelX - totalW / 2 + pillW / 2;
                    const subCx = r.labelX + totalW / 2 - subW / 2;
                    return (
                      <>
                        <rect
                          x={pillCx - pillW / 2}
                          y={topY - pillH / 2}
                          width={pillW}
                          height={pillH}
                          rx={pillH / 2}
                          ry={pillH / 2}
                          fill={r.tunerColor ?? r.color}
                        />
                        <text
                          x={pillCx}
                          y={topY}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={pillFont}
                          fontWeight={700}
                          fill="white"
                          style={{ userSelect: "none" }}
                        >
                          {tunerAbbr}
                        </text>
                        <text
                          x={subCx}
                          y={topY}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={pillFont}
                          fontWeight={700}
                          fill={r.tunerColor ?? r.color}
                          style={{
                            userSelect: "none",
                            letterSpacing: 0.4,
                          }}
                        >
                          {subText}
                        </text>
                        {catLines.map((line, li) => (
                          <text
                            key={li}
                            x={r.labelX}
                            y={catBlockStartY + lineH * (li + 0.5)}
                            textAnchor="middle"
                            dominantBaseline="central"
                            fontSize={fontSize}
                            fontWeight={isHov ? 900 : 800}
                            fill={r.color}
                            style={{
                              userSelect: "none",
                              letterSpacing: 0.2,
                              textTransform: "uppercase",
                            }}
                          >
                            {line}
                          </text>
                        ))}
                      </>
                    );
                  })() : r.kind === "tuner" ? (() => {
                    const pillFont = fontSize;
                    const pillPadX = 7 / renderScale;
                    const pillPadY = 3 / renderScale;
                    const charW = pillFont * 0.62;
                    const tunerAbbr = r.label;
                    const pillW = tunerAbbr.length * charW + pillPadX * 2;
                    const pillH = pillFont + pillPadY * 2;
                    const subText = "DOMINANT";
                    const subW = subText.length * charW;
                    const innerGap = 6 / renderScale;
                    const totalW = pillW + innerGap + subW;
                    const pillCx = r.labelX - totalW / 2 + pillW / 2;
                    const subCx = r.labelX + totalW / 2 - subW / 2;
                    return (
                      <>
                        <rect
                          x={pillCx - pillW / 2}
                          y={r.labelY - pillH / 2}
                          width={pillW}
                          height={pillH}
                          rx={pillH / 2}
                          ry={pillH / 2}
                          fill={r.color}
                        />
                        <text
                          x={pillCx}
                          y={r.labelY}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={pillFont}
                          fontWeight={700}
                          fill="white"
                          style={{ userSelect: "none" }}
                        >
                          {tunerAbbr}
                        </text>
                        <text
                          x={subCx}
                          y={r.labelY}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={pillFont}
                          fontWeight={700}
                          fill={r.color}
                          style={{
                            userSelect: "none",
                            letterSpacing: 0.4,
                          }}
                        >
                          {subText}
                        </text>
                      </>
                    );
                  })() : (
                    r.lines.map((line, li) => {
                      const lineH = fontSize * 1.05;
                      const yOffset = (li - (r.lines.length - 1) / 2) * lineH;
                      return (
                        <text
                          key={li}
                          x={r.labelX}
                          y={r.labelY + yOffset}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={fontSize}
                          fontWeight={isHov ? 900 : 800}
                          fill={r.color}
                          style={{
                            userSelect: "none",
                            letterSpacing: 0.2,
                            textTransform: "uppercase",
                          }}
                        >
                          {line}
                        </text>
                      );
                    })
                  )}
                  </g>
                </g>
              );
            })}

          </g>
        </svg>

        {/* Complementary empty-cart overlay */}
        {effectiveColorMode === "complementary" && cartIds.size === 0 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              zIndex: 5,
            }}
          >
            <div
              style={{
                background: "rgba(255,255,255,0.94)",
                backdropFilter: "blur(4px)",
                borderRadius: 10,
                border: "1px solid #E5E7EB",
                boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
                padding: "12px 20px",
                fontSize: 15,
                fontWeight: 500,
                color: "#475569",
                textAlign: "center",
                maxWidth: 360,
              }}
            >
              Add at least one cell to the working set to see complementary candidates.
              <div style={{ fontSize: 13, color: "#94A3B8", marginTop: 4 }}>
                Shift+click a cell to add it.
              </div>
            </div>
          </div>
        )}

        {/* In-map legend (top-right) */}
        {(effectiveColorMode === "tuner-perf" ||
          (selectedParam && paramCellBins)) && (
          <div
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              left: "auto",
              bottom: "auto",
              zIndex: 10,
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: 6,
              pointerEvents: "none",
            }}
          >
            {/* Overview legend — tuner-dominant colors + Mixed */}
            {effectiveColorMode === "tuner-perf" && (
              <div
                style={{
                  background: "rgba(255,255,255,0.92)",
                  backdropFilter: "blur(4px)",
                  borderRadius: 8,
                  border: "1px solid #E5E7EB",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
                  padding: "6px 10px",
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: "#374151",
                    marginBottom: 6,
                  }}
                >
                  Dominant tuner
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    columnGap: 10,
                    rowGap: 3,
                  }}
                >
                  {TUNER_NAMES.filter((t) => selectedTuners.has(t)).map((t) => (
                    <div
                      key={t}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 11,
                        color: "#374151",
                      }}
                    >
                      <span
                        style={{
                          width: 11,
                          height: 11,
                          borderRadius: 2,
                          background: TUNER_COLORS[t],
                          border: "1px solid rgba(0,0,0,0.05)",
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontWeight: 600 }}>
                        {TUNER_DISPLAY_NAMES[t]}
                      </span>
                    </div>
                  ))}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 11,
                      color: "#374151",
                    }}
                  >
                    <span
                      style={{
                        width: 11,
                        height: 11,
                        borderRadius: 2,
                        background: MIXED_COLOR,
                        border: "1px solid rgba(0,0,0,0.05)",
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ fontWeight: 600 }}>Mixed</span>
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: "#94A3B8",
                    marginTop: 4,
                    fontStyle: "italic",
                  }}
                >
                  ≥ 50% of trials → tuner color
                </div>
              </div>
            )}

            {/* Cell-size legend — fixed trial-count buckets drive the hex scale. */}
            {cellSizeTier.tierMap.size > 0 && (() => {
              const fmt = (v: number) => v.toLocaleString();
              const tiers = [
                {
                  key: "low",
                  scale: 0.7,
                  range: `≤ ${fmt(cellSizeTier.lowMax)}`,
                },
                {
                  key: "mid",
                  scale: 1.0,
                  range: `${fmt(cellSizeTier.lowMax)}–${fmt(cellSizeTier.midMax)}`,
                },
                {
                  key: "high",
                  scale: 1.25,
                  range: `> ${fmt(cellSizeTier.midMax)}`,
                },
              ] as const;
              const hexBoxPx = 26;
              const hexR = 9; // legend hex base radius
              return (
                <div
                  style={{
                    background: "rgba(255,255,255,0.92)",
                    backdropFilter: "blur(4px)",
                    borderRadius: 8,
                    border: "1px solid #E5E7EB",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
                    padding: "6px 10px",
                  }}
                >
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "#374151",
                      marginBottom: 6,
                    }}
                  >
                    Trials per cell
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-end",
                      gap: 12,
                    }}
                  >
                    {tiers.map((t) => (
                      <div
                        key={t.key}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 2,
                        }}
                      >
                        <svg
                          width={hexBoxPx}
                          height={hexBoxPx}
                          viewBox={`-${hexBoxPx / 2} -${hexBoxPx / 2} ${hexBoxPx} ${hexBoxPx}`}
                        >
                          <path
                            d={getHexPath(hexR * t.scale)}
                            fill="#94A3B8"
                            stroke="#475569"
                            strokeWidth={0.8}
                          />
                        </svg>
                        <span
                          style={{
                            fontSize: 11,
                            color: "#6B7280",
                            fontWeight: 600,
                          }}
                        >
                          {t.range}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Parameter bin legend */}
            {selectedParam && paramCellBins && (() => {
              const isNumeric = selectedParamType === "numeric";
              const manyBins = paramCellBins.binNames.length > 3;
              // Numeric labels carry the range string and must stay readable.
              const layoutStyle: React.CSSProperties = isNumeric
                ? {
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                  }
                : manyBins
                  ? {
                      display: "grid",
                      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                      columnGap: 10,
                      rowGap: 2,
                    }
                  : {
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "2px 8px",
                      alignItems: "center",
                    };
              return (
                <div
                  style={{
                    background: "rgba(255,255,255,0.92)",
                    backdropFilter: "blur(4px)",
                    borderRadius: 8,
                    border: "1px solid #E5E7EB",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
                    padding: "6px 10px",
                    maxWidth: isNumeric ? 260 : 240,
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 4 }}>
                    {selectedParam} ({selectedParamType})
                  </div>
                  <div style={layoutStyle}>
                    {paramCellBins.binNames.map((bin) => (
                      <div
                        key={bin}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                          minWidth: 0,
                        }}
                      >
                        <div
                          style={{
                            width: 12,
                            height: 12,
                            borderRadius: 2,
                            backgroundColor: paramCellBins.binColors[bin] ?? MIXED_COLOR,
                            opacity: 0.7,
                            flexShrink: 0,
                          }}
                        />
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: paramCellBins.binColors[bin] ?? MIXED_COLOR,
                            whiteSpace: "nowrap",
                            overflow: isNumeric ? "visible" : "hidden",
                            textOverflow: isNumeric ? "clip" : "ellipsis",
                          }}
                          title={bin}
                        >
                          {bin}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* Hover tooltip */}
        <HexTooltip
          tooltipPos={tooltipPos}
          hoveredClusterId={hoveredClusterId}
          data={data}
          selectedTuners={selectedTuners}
          effectiveColorMode={effectiveColorMode}
          coverageMetric={coverageMetric}
          getClusterCov={getClusterCov}
          containerRef={containerRef}
          selectedParam={selectedParam}
          paramBin={hoveredClusterId !== null && paramCellBins ? (paramCellBins.bins.get(hoveredClusterId) ?? null) : null}
          t3Scores={t3Scores}
          isCartMember={hoveredClusterId !== null && cartIds.has(hoveredClusterId)}
        />
      </div>
      </div>
    </div>
  );
}

export default HexMap;
