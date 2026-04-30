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
  getTunersForProgram,
  cellSizeThresholdsFor,
  isHPOProgram,
  metricLabelFor,
  formatMetricValue,
} from "../../utils/hexMapUtils";
import type { HexMapData, HexTile, TunerType, Cluster } from "./types";
import type { ColorMode, HexMapProps } from "./types";
import { HEX_SIZE_DEFAULT, MIXED_COLOR, TUNER_DISPLAY_NAMES } from "./types";
import { getParamType } from "./colorUtils";
import { ControlsBar } from "./ControlsBar";
import { HexTooltip } from "./HexTooltip";

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

// ============================================================
// Component
// ============================================================

export function HexMap({
  program = "gawk",
  selectedParam: selectedParamProp = null,
  onParamSelect,
  selectedTuners: selectedTunersProp,
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
  // Per-program tuner subset (SE → 6, HPO → 4). Drives ControlsBar buttons,
  // legends, dominance computations everywhere a tuner roster is needed.
  const programTuners = useMemo(() => getTunersForProgram(program), [program]);
  // Cached HPO/SE flags. Used wherever we need to pick a label
  // ("coverage" vs "accuracy"). Note: fmtMetric is defined further below
  // because it depends on `data` (which itself depends on allLevels).
  const isHPO = useMemo(() => isHPOProgram(program), [program]);
  const metricLabel = useMemo(() => metricLabelFor(program), [program]);
  // All 5 levels: index 0 = L0, ... 4 = L4
  const [allLevels, setAllLevels] = useState<HexMapData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [colorMode, setColorMode] = useState<ColorMode>("tuner-perf");
  const [previewColorMode] = useState<ColorMode | null>(null);
  // Figure-capture legend toggle (Tuner mode only). Default hidden so the
  // map stays uncluttered until the user clicks the corner button.
  const [figureLegendVisible, setFigureLegendVisible] = useState(false);
  // Master toggle for ALL legend cards — used when capturing teaser figures
  // where the legends would clutter the screenshot.
  const [legendsVisible, setLegendsVisible] = useState(true);
  const [coverageMetric, setCoverageMetric] = useState<"mean" | "cumulative">(
    "cumulative",
  );
  // Coverage overlay: paint a teal sequential wash on every cell so the
  // tuner-identity fill stays visible underneath while the user can scan for
  // high/low-coverage cells via teal darkness.
  const [coverageOverlay, setCoverageOverlay] = useState(false);
  // Coverage preview: hovering the Coverage checkbox swaps the cell fill to
  // the teal coverage scale and strips all tuner colors so the user can see
  // what the overlay represents before toggling it on.
  const [coverageHovered, setCoverageHovered] = useState(false);
  // hover: drives tooltip
  const [hoveredClusterId, setHoveredClusterId] = useState<number | null>(null);
  // Hovering a label highlights its region without picking a specific cell —
  // separate from cell-hover so the cart button / black stroke don't appear.
  const [hoveredLabelIdx, setHoveredLabelIdx] = useState<number | null>(null);
  // Hovered tuner from ControlsBar — in Tuner mode this highlights cells
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
  const activeTuner =
    hoveredTuner ?? (pinnedTuners.length === 1 ? pinnedTuners[0] : null);
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
    return () => {
      cancelled = true;
    };
  }, [program]);

  // Shift + number keyboard preview:
  //   Shift + 1..6  → preview the matching tuner (same as hovering its
  //                   checkbox in ControlsBar).
  //   Shift + 7     → preview the coverage overlay (same as hovering the
  //                   Coverage checkbox).
  // Uses e.code ("Digit1"..) so it works regardless of the shifted character
  // (!, @, #, $, %, ^, & on US/KR layouts). Released Shift or number key
  // clears the preview. Skipped when focus is in a form element so typing
  // isn't intercepted.
  useEffect(() => {
    const isFormFocus = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const t = el.tagName;
      return t === "INPUT" || t === "SELECT" || t === "TEXTAREA";
    };
    const clearPreview = () => {
      setHoveredTuner(null);
      setCoverageHovered(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isFormFocus(e.target)) return;
      if (!e.shiftKey) return;
      const m = e.code.match(/^Digit([1-7])$/);
      if (!m) return;
      e.preventDefault();
      const num = parseInt(m[1], 10);
      if (num <= 6) {
        setHoveredTuner(programTuners[num - 1] ?? null);
        setCoverageHovered(false);
      } else {
        setCoverageHovered(true);
        setHoveredTuner(null);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift" || /^Digit[1-7]$/.test(e.code)) {
        clearPreview();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [programTuners]);

  // Auto-select top param when switching to tuner-param with no param selected
  const onParamSelectRef = useRef(setSelectedParam);
  onParamSelectRef.current = setSelectedParam;

  const wrappedSetColorMode = useCallback((mode: ColorMode) => {
    // Clear param selection when leaving tuner-param so default top-5
    // contrastive regions show again on next entry.
    if (mode !== "tuner-param") {
      onParamSelectRef.current(null);
    }
    setColorMode(mode);
  }, []);

  // Effective values (preview overrides actual for hover preview).
  // The Complementary mode tab was removed; instead, cart membership drives
  // the switch automatically — any cell in the working set forces the
  // complementary view, and clearing it falls back to the user's last
  // explicitly chosen mode.
  const effectiveDetailLevel = detailLevel;
  const effectiveColorMode: ColorMode =
    cartIds.size > 0 ? "complementary" : (previewColorMode ?? colorMode);

  // Active data for current detail level
  const data = allLevels[effectiveDetailLevel] ?? null;
  const HEX_SIZE = data?.hexSize ?? HEX_SIZE_DEFAULT;

  // Format a metric value: HPO → fraction of validation samples (0-1);
  // SE → integer branch count. Needs data.totalUniqueBranches to scale HPO.
  const fmtMetric = useCallback(
    (v: number) => formatMetricValue(v, program, data?.totalUniqueBranches),
    [program, data?.totalUniqueBranches],
  );

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

    // Asymmetric horizontal padding — the legend column lives in the
    // top-right, so we reserve more room there and tighten the left side.
    // Vertical stays generous so top/bottom labels don't glue to the edge.
    const PAD_LEFT = 40;
    const PAD_RIGHT = 200;
    const PAD_Y = 110;
    const usableW = svgWidth - PAD_LEFT - PAD_RIGHT;
    const scaleX = usableW / dataWidth;
    const scaleY = (height - PAD_Y * 2) / dataHeight;
    const fitScale = Math.min(scaleX, scaleY, 1.2);

    return {
      // Centered within the asymmetric usable region — shifts the whole
      // map slightly left of geometric center so legends don't overlap.
      centerX: PAD_LEFT + usableW / 2,
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

      if (coverageMetric === "mean")
        return trials.reduce((s, t) => s + t.coverage, 0) / trials.length;
      if (coverageMetric === "cumulative") {
        // Union of branches from selected tuners' trials
        // Per-trial coveredBranches may be stripped in precomputed data; fall back to cluster-level
        const hasTrialBranches = trials.some(
          (t) => t.coveredBranches && t.coveredBranches.length > 0,
        );
        if (hasTrialBranches) {
          const branchSet = new Set<number>();
          for (const t of trials) {
            for (const b of t.coveredBranches ?? []) branchSet.add(b);
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
    if (!data || data.clusters.length === 0)
      return { min: 0, max: 1, mean: 0.5 };
    const vals = data.clusters.map(getClusterCov);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    return { min: Math.min(...vals), max: Math.max(...vals), mean };
  }, [data, getClusterCov]);

  // d3-scale-chromatic Greens (single-hue ColorBrewer sequential).
  // Sub-range [0.1, 0.9] keeps low coverage cells from washing out to near
  // white and the high end from going so dark that text reads poorly.
  const getCoverageColor = useCallback(
    (coverage: number): string => {
      const { min: gMin, max: gMax } = globalCovRange;
      const range = gMax - gMin;
      const t =
        range > 0 ? Math.max(0, Math.min(1, (coverage - gMin) / range)) : 0.5;
      return d3.interpolateGreens(0.1 + t * 0.8);
    },
    [globalCovRange],
  );

  // Helper: get the union of branches for selected tuners in a cluster
  const getFilteredBranches = useCallback(
    (cluster: import("../../utils/hexMapUtils").Cluster): Set<number> => {
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
    },
    [selectedTuners],
  );

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
      if (refIds.has(c.id)) {
        scores.set(c.id, 0);
        continue;
      }
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
      const filteredTrialsByCluster = new Map<
        number,
        (typeof data.clusters)[0]["trials"]
      >();
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
        const gP33 =
          allTrialVals[Math.floor(allTrialVals.length / 3)] ?? globalMin;
        const gP66 =
          allTrialVals[Math.floor((allTrialVals.length * 2) / 3)] ?? globalMax;

        const fmt = (v: number) =>
          Math.abs(v) >= 1000
            ? v.toFixed(0)
            : v < 0.01
              ? v.toFixed(3)
              : v < 1
                ? v.toFixed(2)
                : v.toFixed(1);
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
          // Source colors span a wide lightness range so the wash overlays
          // produce three clearly distinct tints — light sky-blue, vivid
          // blue, and near-black indigo — instead of looking like one
          // uniform pastel band.
          binColors: {
            [lowLabel]: "#93C5FD",
            [midLabel]: "#1D4ED8",
            [highLabel]: "#172554",
            Mixed: MIXED_COLOR,
          },
        };
      }

      if (ptype === "boolean") {
        for (const c of data.clusters) {
          const trials = filteredTrialsByCluster.get(c.id) ?? [];
          if (trials.length === 0) {
            bins.set(c.id, "Mixed");
            continue;
          }
          const trueCount = trials.filter(
            (t) => t.parameters[selectedParam] === true,
          ).length;
          const ratio = trueCount / trials.length;
          if (ratio > 0.7) bins.set(c.id, "Mostly True");
          else if (ratio < 0.3) bins.set(c.id, "Mostly False");
          else bins.set(c.id, "Mixed");
        }
        return {
          bins,
          binNames: ["Mostly True", "Mostly False", "Mixed"],
          // Cyan vs orange — opposite ends of the wheel, no green, render
          // as soft pastel after the 28% wash.
          binColors: {
            "Mostly True": "#06B6D4",
            Mixed: MIXED_COLOR,
            "Mostly False": "#F97316",
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
        if (trials.length === 0) {
          bins.set(c.id, "Mixed");
          continue;
        }

        const counts = new Map<string, number>();
        for (const t of trials) {
          const v = String(t.parameters[selectedParam]);
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        let maxVal = -1,
          secondMax = -1,
          dominant = "";
        for (const cat of catValues) {
          const frac = (counts.get(cat) ?? 0) / trials.length;
          if (frac > maxVal) {
            secondMax = maxVal;
            maxVal = frac;
            dominant = cat;
          } else if (frac > secondMax) {
            secondMax = frac;
          }
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
          // Tuner mode: color by dominant tuner among selected. Cell colored by
          // a tuner's color when that tuner has ≥50% of the cell's selected
          // trials; otherwise MIXED_COLOR.
          // When a tuner is hovered in the toolbar, ONLY cells dominated by
          // that tuner show its color — everything else falls back to MIXED.
          let total = 0;
          let domCount = 0;
          let domTuner: TunerType = programTuners[0];
          for (const t of programTuners) {
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
          // Two pins:
          //   - only pin[0] → solid pin[0] color
          //   - only pin[1] → solid pin[1] color
          //   - both present → per-cell hatch with stripe width proportional
          //     to the pin[1]/(pin[0]+pin[1]) ratio
          if (pinnedTuners.length === 2) {
            const has0 = tile.cluster.tunerCounts[pinnedTuners[0]] > 0;
            const has1 = tile.cluster.tunerCounts[pinnedTuners[1]] > 0;
            if (has0 && has1) return `url(#hatch-overlap-${tile.cluster.id})`;
            if (has0) return TUNER_COLORS[pinnedTuners[0]];
            if (has1) return TUNER_COLORS[pinnedTuners[1]];
            return MIXED_COLOR;
          }
          // Single pin (or none) — activeTuner already covers single pin case.
          if (activeTuner) {
            return tile.cluster.tunerCounts[activeTuner] > 0
              ? TUNER_COLORS[activeTuner]
              : MIXED_COLOR;
          }
          return domCount / total >= 0.5 ? TUNER_COLORS[domTuner] : MIXED_COLOR;
        }

        case "tuner-param": {
          // When a tuner is pinned/hovered, mirror the tuner-perf comparison
          // fill so the comparison context carries over into param mode.
          // Region overlays drop their inner wash + use grey shadows below.
          if (hoveredTuner) {
            return tile.cluster.tunerCounts[hoveredTuner] > 0
              ? TUNER_COLORS[hoveredTuner]
              : MIXED_COLOR;
          }
          if (pinnedTuners.length === 2) {
            const has0 = tile.cluster.tunerCounts[pinnedTuners[0]] > 0;
            const has1 = tile.cluster.tunerCounts[pinnedTuners[1]] > 0;
            if (has0 && has1) return `url(#hatch-overlap-${tile.cluster.id})`;
            if (has0) return TUNER_COLORS[pinnedTuners[0]];
            if (has1) return TUNER_COLORS[pinnedTuners[1]];
            return MIXED_COLOR;
          }
          if (activeTuner) {
            return tile.cluster.tunerCounts[activeTuner] > 0
              ? TUNER_COLORS[activeTuner]
              : MIXED_COLOR;
          }
          // Both All and single-param views use the same grey base — the
          // bin/region color is layered on top via a 28% wash so the visual
          // tone stays consistent (pastel) across both. Mixed cells get no
          // wash, so they read as plain grey and stand apart from the
          // tinted bin cells.
          return "#E2E8F0";
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
      programTuners,
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
      text?: { value: string; unit?: string; italic?: boolean };
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
    const pushText = (
      e: Entry,
      value: string,
      unit?: string,
      italic?: boolean,
    ) => {
      const l = ensure(e);
      if (l.text) return; // first text wins (priority order)
      l.text = { value, unit, italic };
    };
    // Coverage values use program-specific formatting (HPO → "0.872",
    // fuzzing → "1,500"). Trial counts always render as integers.
    const fmt = (n: number) => fmtMetric(n);
    const fmtCount = (n: number) => Math.round(n).toLocaleString();
    if (effectiveColorMode === "complementary") {
      // Cart members: show their cluster id (#N) so the working set is
      // identifiable on the map.
      for (const e of eligible) {
        if (cartIds.has(e.cluster.id)) {
          pushText(e, `#${e.cluster.id + 1}`);
        }
      }
      // Rank non-cart cells by how many new branches they'd add. All three
      // ranks share the "No. N" prefix (matching the tooltip / cart panel
      // ordinal style) and put the gain value in the unit slot so layout
      // is consistent across positions.
      if (t3Scores && t3Scores.maxScore > 0) {
        const ranked = eligible
          .map((e) => ({ e, s: t3Scores.scores.get(e.cluster.id) ?? 0 }))
          .filter((x) => x.s > 0 && !cartIds.has(x.e.cluster.id))
          .sort((a, b) => b.s - a.s);
        if (ranked[0])
          pushText(ranked[0].e, "No. 1", `+${fmt(ranked[0].s)}`, true);
        if (ranked[1])
          pushText(ranked[1].e, "No. 2", `+${fmt(ranked[1].s)}`, true);
        if (ranked[2])
          pushText(ranked[2].e, "No. 3", `+${fmt(ranked[2].s)}`, true);
      }
    } else {
      pushText(maxCov, fmt(maxCov.cov), undefined, true);
      pushText(minCov, fmt(minCov.cov), undefined, true);
      pushText(dense, fmtCount(dense.tcount), "trials");
      pushText(sparse, fmtCount(sparse.tcount), "trials");
    }
    return Array.from(byCluster.values());
  }, [
    data,
    selectedTuners,
    getClusterCov,
    effectiveColorMode,
    t3Scores,
    cartIds,
    fmtMetric,
  ]);

  // Map clusterId → density tier (low/mid/high) by fixed trial-count buckets:
  //   low  : ≤ 100
  //   mid  : 101–1000
  //   high : > 1000
  const cellSizeTier = useMemo(() => {
    const tierMap = new Map<number, "low" | "mid" | "high">();
    // SE programs see hundreds of trials per cell; HPO programs only have
    // 4 tuner × 200 trials total = much smaller per-cell counts.
    const { lowMax: LOW_MAX, midMax: MID_MAX } = cellSizeThresholdsFor(program);
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
  }, [data, selectedTuners, program]);
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
        const proj =
          (c.tile.x - dataCenter.x) * dx + (c.tile.y - dataCenter.y) * dy;
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

    const meanCov = (cs: Cell[]) =>
      cs.reduce((s, c) => s + c.cov, 0) / cs.length;
    const meanTc = (cs: Cell[]) =>
      cs.reduce((s, c) => s + c.tcount, 0) / cs.length;

    // Five coverage qualitative regions shared across modes that want a
    // coverage-context overlay (tuner-perf and single-param). Single neutral
    // color so they form a distinct group from any palette-colored regions.
    const addCoverageQualitativeRegions = () => {
      const COV_NEUTRAL = "#475569";
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
    };

    if (effectiveColorMode === "tuner-perf") {
      addCoverageQualitativeRegions();
    } else if (effectiveColorMode === "tuner-param") {
      if (selectedParam && paramCellBins) {
        // Single-param mode: no per-bin region overlays (bin colors come
        // from the wash directly), but the same five coverage qualitative
        // regions appear so users still see Failure-prone / High-Cov etc.
        // landmarks for orientation.
        addCoverageQualitativeRegions();
      } else {
        // Default tuner-param view (no specific param selected): show the
        // largest contrastive region for each of the top-5 important
        // parameters. Each region is colored from CAT_PALETTE so the params
        // are visually distinguished from each other (not from each bin).
        const TOP_N_PARAMS = 5;
        const topParams = paramImportanceList.slice(0, TOP_N_PARAMS);
        let palettePos = 0;
        for (const { name: pname } of topParams) {
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
            rawRegions.push(
              buildRegion(bestKeys, `${pname}: ${bestBin}`, color, [
                pname,
                bestBin,
              ]),
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
    // Must mirror the render center (which is offset to leave room for the
    // legend column on the right) so label placement projects data coords
    // through the same transform as the SVG group.
    const sCenterX = centerX;
    const sCenterY = centerY;
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
      ax: number,
      ay: number,
      bx: number,
      by: number,
      px: number,
      py: number,
    ) => {
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 1e-6) return Math.hypot(px - ax, py - ay);
      let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    };
    // Segment-segment intersection (proper crossings, no shared-endpoint hits).
    const segSegInter = (
      ax: number,
      ay: number,
      bx: number,
      by: number,
      cx: number,
      cy: number,
      dx: number,
      dy: number,
    ) => {
      const ccw = (
        px: number,
        py: number,
        qx: number,
        qy: number,
        rx: number,
        ry: number,
      ) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
      const d1 = ccw(cx, cy, dx, dy, ax, ay);
      const d2 = ccw(cx, cy, dx, dy, bx, by);
      const d3 = ccw(ax, ay, bx, by, cx, cy);
      const d4 = ccw(ax, ay, bx, by, dx, dy);
      return (
        ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
      );
    };
    // Segment vs axis-aligned rect: intersects if either endpoint is inside,
    // or the segment crosses any of the 4 rect sides.
    const segRectInter = (
      ax: number,
      ay: number,
      bx: number,
      by: number,
      rx1: number,
      ry1: number,
      rx2: number,
      ry2: number,
    ) => {
      const inA = ax >= rx1 && ax <= rx2 && ay >= ry1 && ay <= ry2;
      const inB = bx >= rx1 && bx <= rx2 && by >= ry1 && by <= ry2;
      if (inA || inB) return true;
      return (
        segSegInter(ax, ay, bx, by, rx1, ry1, rx2, ry1) ||
        segSegInter(ax, ay, bx, by, rx2, ry1, rx2, ry2) ||
        segSegInter(ax, ay, bx, by, rx2, ry2, rx1, ry2) ||
        segSegInter(ax, ay, bx, by, rx1, ry2, rx1, ry1)
      );
    };
    // Build cubic Bezier controls for a single V→label leader curve. Used by
    // both the Step 3 renderer and the spiralSearch crossing check so they
    // see the same shape.
    //   c1: 40% along V→label with a small INWARD perpendicular bow (toward
    //       region centroid). Reverses the previous outward bow so the
    //       overall shape is funnel-like, not balloon-like.
    //   c2: shared with the sibling curve — sits on the midV→label axis, ~18%
    //       back from label. Both top and bot curves end with the same
    //       tangent direction so they visually merge into a single thin line
    //       at the badge connection.
    const bezCtrls = (
      vx: number,
      vy: number, // V (topV or botV)
      lx: number,
      ly: number, // label endpoint
      midX: number,
      midY: number, // midpoint of topV-botV (== V for sameV)
      rcx: number,
      rcy: number, // region centroid (defines INWARD)
    ) => {
      const dxV = lx - vx;
      const dyV = ly - vy;
      const segLen = Math.hypot(dxV, dyV) || 1;
      // Perpendicular to V→label, then flip to point TOWARD region centroid.
      let pdx = -dyV / segLen;
      let pdy = dxV / segLen;
      const mx = (vx + lx) / 2;
      const my = (vy + ly) / 2;
      if (pdx * (mx - rcx) + pdy * (my - rcy) > 0) {
        pdx = -pdx;
        pdy = -pdy;
      }
      const c1x = vx + dxV * 0.4 + pdx * segLen * 0.12;
      const c1y = vy + dyV * 0.4 + pdy * segLen * 0.12;
      const c2x = lx + (midX - lx) * 0.32;
      const c2y = ly + (midY - ly) * 0.32;
      return { c1x, c1y, c2x, c2y };
    };
    // Sample a cubic Bezier into N+1 points (polyline approximation).
    const bezSampleCubic = (
      p0x: number,
      p0y: number,
      p1x: number,
      p1y: number,
      p2x: number,
      p2y: number,
      p3x: number,
      p3y: number,
      N: number,
    ) => {
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const u = 1 - t;
        const u2 = u * u,
          u3 = u2 * u;
        const t2 = t * t,
          t3 = t2 * t;
        pts.push({
          x: u3 * p0x + 3 * u2 * t * p1x + 3 * u * t2 * p2x + t3 * p3x,
          y: u3 * p0y + 3 * u2 * t * p1y + 3 * u * t2 * p2y + t3 * p3y,
        });
      }
      return pts;
    };
    const BEZ_N = 6; // sub-segments per leader curve for crossing checks

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
      rcx: number,
      rcy: number,
      hw: number,
      hh: number,
      ccx: number,
      ccy: number,
      cr: number,
    ) => {
      const dx = Math.max(Math.abs(ccx - rcx) - hw, 0);
      const dy = Math.max(Math.abs(ccy - rcy) - hh, 0);
      return dx * dx + dy * dy < cr * cr;
    };
    const rectsOverlap = (
      ax: number,
      ay: number,
      aw: number,
      ah: number,
      bx: number,
      by: number,
      bw: number,
      bh: number,
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

    const hitsCell = (
      sx: number,
      sy: number,
      hw: number,
      hh: number,
      own: Set<number>,
    ) => {
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
            sx,
            sy,
            hw * 2,
            hh * 2,
            p.sx,
            p.sy,
            p.box.w,
            p.box.h,
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
      cx: number,
      cy: number,
      hw: number,
      hh: number,
      own: Set<number>,
      outwardAngle: number,
      startR: number,
      regionData: RawRegion,
      otherCellsData: { x: number; y: number; rad: number }[],
      adjacentPlaced: Placed[],
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
          ax: number,
          ay: number,
          bx: number,
          by: number,
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

      // Two-pass: 0-crossings is a HARD priority. We track the best 0-cross
      // candidate AND the best fallback-with-crossings separately. If any
      // 0-cross slot exists in the entire search, it wins regardless of how
      // good a crossing slot scores on the other terms.
      let bestZeroPos: {
        sx: number;
        sy: number;
        bracket: Bracket;
      } | null = null;
      let bestZeroScore = Infinity;
      let bestAnyPos: {
        sx: number;
        sy: number;
        bracket: Bracket;
      } | null = null;
      let bestAnyScore = Infinity;
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
          const sameV =
            Math.abs(bracket.topV.x - bracket.botV.x) < 0.5 &&
            Math.abs(bracket.topV.y - bracket.botV.y) < 0.5;
          // Build the actual rendered cubic Bezier as a polyline (data coords)
          // for crossing checks. midV is the midpoint of the topV-botV pair
          // (== topV when sameV) — fed to bezCtrls so both top and bot curves
          // share their c2 endpoint axis (funnel convergence at label).
          const midX = sameV
            ? bracket.topV.x
            : (bracket.topV.x + bracket.botV.x) / 2;
          const midY = sameV
            ? bracket.topV.y
            : (bracket.topV.y + bracket.botV.y) / 2;
          const cTop = bezCtrls(
            bracket.topV.x,
            bracket.topV.y,
            lx,
            ly,
            midX,
            midY,
            regionData.cx,
            regionData.cy,
          );
          const topPoly = bezSampleCubic(
            bracket.topV.x,
            bracket.topV.y,
            cTop.c1x,
            cTop.c1y,
            cTop.c2x,
            cTop.c2y,
            lx,
            ly,
            BEZ_N,
          );
          let botPoly: { x: number; y: number }[] | null = null;
          if (!sameV) {
            const cBot = bezCtrls(
              bracket.botV.x,
              bracket.botV.y,
              lx,
              ly,
              midX,
              midY,
              regionData.cx,
              regionData.cy,
            );
            botPoly = bezSampleCubic(
              bracket.botV.x,
              bracket.botV.y,
              cBot.c1x,
              cBot.c1y,
              cBot.c2x,
              cBot.c2y,
              lx,
              ly,
              BEZ_N,
            );
          }
          // Region cell crossings via polyline (count each crossed cell once).
          let regionCrossings = 0;
          for (const oc of otherCellsData) {
            let hit = false;
            for (let i = 0; i < topPoly.length - 1; i++) {
              if (
                distSP(
                  topPoly[i].x,
                  topPoly[i].y,
                  topPoly[i + 1].x,
                  topPoly[i + 1].y,
                  oc.x,
                  oc.y,
                ) < oc.rad
              ) {
                hit = true;
                break;
              }
            }
            if (!hit && botPoly) {
              for (let i = 0; i < botPoly.length - 1; i++) {
                if (
                  distSP(
                    botPoly[i].x,
                    botPoly[i].y,
                    botPoly[i + 1].x,
                    botPoly[i + 1].y,
                    oc.x,
                    oc.y,
                  ) < oc.rad
                ) {
                  hit = true;
                  break;
                }
              }
            }
            if (hit) regionCrossings++;
          }
          // Project polylines to screen coords once for label-rect / placed-
          // leader-segment checks (which are tracked in screen space).
          const toScreen = (p: { x: number; y: number }) => ({
            x: (p.x - dataCenter.x) * scale + sCenterX,
            y: (p.y - dataCenter.y) * scale + sCenterY,
          });
          const topPolyS = topPoly.map(toScreen);
          const botPolyS = botPoly ? botPoly.map(toScreen) : null;
          let labelCrossings = 0;
          let leaderCrossings = 0;
          for (const ap of placedList) {
            const rx1 = ap.sx - ap.box.w / 2 + 1;
            const ry1 = ap.sy - ap.box.h / 2 + 1;
            const rx2 = ap.sx + ap.box.w / 2 - 1;
            const ry2 = ap.sy + ap.box.h / 2 - 1;
            // Polyline vs placed label rect.
            let labHit = false;
            for (let i = 0; i < topPolyS.length - 1; i++) {
              if (
                segRectInter(
                  topPolyS[i].x,
                  topPolyS[i].y,
                  topPolyS[i + 1].x,
                  topPolyS[i + 1].y,
                  rx1,
                  ry1,
                  rx2,
                  ry2,
                )
              ) {
                labHit = true;
                break;
              }
            }
            if (!labHit && botPolyS) {
              for (let i = 0; i < botPolyS.length - 1; i++) {
                if (
                  segRectInter(
                    botPolyS[i].x,
                    botPolyS[i].y,
                    botPolyS[i + 1].x,
                    botPolyS[i + 1].y,
                    rx1,
                    ry1,
                    rx2,
                    ry2,
                  )
                ) {
                  labHit = true;
                  break;
                }
              }
            }
            if (labHit) labelCrossings++;
            // Polyline vs placed leader (straight-line approximation of theirs).
            if (ap.topV && ap.botV) {
              const apTvSx = (ap.topV.x - dataCenter.x) * scale + sCenterX;
              const apTvSy = (ap.topV.y - dataCenter.y) * scale + sCenterY;
              const apBvSx = (ap.botV.x - dataCenter.x) * scale + sCenterX;
              const apBvSy = (ap.botV.y - dataCenter.y) * scale + sCenterY;
              const apSameV =
                Math.abs(ap.topV.x - ap.botV.x) < 0.5 &&
                Math.abs(ap.topV.y - ap.botV.y) < 0.5;
              const theirSegs: [number, number, number, number][] = [
                [apTvSx, apTvSy, ap.sx, ap.sy],
              ];
              if (!apSameV) theirSegs.push([apBvSx, apBvSy, ap.sx, ap.sy]);
              let leadHit = false;
              for (const [ax, ay, bx, by] of theirSegs) {
                for (let i = 0; i < topPolyS.length - 1; i++) {
                  if (
                    segSegInter(
                      topPolyS[i].x,
                      topPolyS[i].y,
                      topPolyS[i + 1].x,
                      topPolyS[i + 1].y,
                      ax,
                      ay,
                      bx,
                      by,
                    )
                  ) {
                    leadHit = true;
                    break;
                  }
                }
                if (leadHit) break;
                if (botPolyS) {
                  for (let i = 0; i < botPolyS.length - 1; i++) {
                    if (
                      segSegInter(
                        botPolyS[i].x,
                        botPolyS[i].y,
                        botPolyS[i + 1].x,
                        botPolyS[i + 1].y,
                        ax,
                        ay,
                        bx,
                        by,
                      )
                    ) {
                      leadHit = true;
                      break;
                    }
                  }
                  if (leadHit) break;
                }
              }
              if (leadHit) leaderCrossings++;
            }
          }
          const totalCrossings =
            regionCrossings + labelCrossings + leaderCrossings;
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
          // Adjacency angle penalty: among regions whose cells touch this
          // one's, prefer candidates that sit on a different angular sector
          // (relative to SVG center) from already-placed adjacent labels.
          // Stops adjacent regions from clumping into the same margin slot.
          // Saturates at ~60° separation (Math.PI/3).
          let angleSepPenalty = 0;
          if (adjacentPlaced.length > 0) {
            const candAng = Math.atan2(sy - sCenterY, sx - sCenterX);
            let minDiff = Math.PI;
            for (const ap of adjacentPlaced) {
              const placedAng = Math.atan2(ap.sy - sCenterY, ap.sx - sCenterX);
              const diff = Math.abs(wrapAng(candAng - placedAng));
              if (diff < minDiff) minDiff = diff;
            }
            const norm = Math.min(minDiff / (Math.PI / 3), 1);
            angleSepPenalty = (1 - norm) * 80;
          }
          // Soft-score (lower = better) excluding crossings. Crossings are
          // handled by the two-pass split above.
          const softScore =
            -bracket.span * 25 -
            spacingBonus * 0.45 +
            distFromRegion * 0.01 +
            angleSepPenalty;
          if (totalCrossings === 0) {
            if (softScore < bestZeroScore) {
              bestZeroScore = softScore;
              bestZeroPos = { sx, sy, bracket };
            }
          }
          const anyScore = softScore + totalCrossings * 100;
          if (anyScore < bestAnyScore) {
            bestAnyScore = anyScore;
            bestAnyPos = { sx, sy, bracket };
          }
        }
      }
      // Prefer 0-crossings if any exists; otherwise least-bad fallback.
      const bestPos = bestZeroPos ?? bestAnyPos;
      return (
        bestPos ??
        (outOfBounds
          ? { ...outOfBounds, bracket: null as Bracket | null }
          : null)
      );
    };

    // ── Per-region precomputation ──
    // We need geometry (box, centroid, startR, otherCellsData) for every
    // region BEFORE deciding placement order, because the order itself depends
    // on each region's "freedom" (how many starting slots are valid).
    type RegionPrep = {
      idx: number;
      box: { w: number; h: number };
      cxS: number;
      cyS: number;
      outwardAngle: number;
      startR: number;
      otherCellsData: { x: number; y: number; rad: number }[];
      freedom: number;
      size: number;
    };
    const regionPreps: RegionPrep[] = [];
    for (let idx = 0; idx < rawRegions.length; idx++) {
      const r = rawRegions[idx];
      const box = boxSize(r.lines, r.kind);
      const halfW = box.w / 2;
      const halfH = box.h / 2;
      const cxS = (r.cx - dataCenter.x) * scale + sCenterX;
      const cyS = (r.cy - dataCenter.y) * scale + sCenterY;
      const outX = cxS - sCenterX;
      const outY = cyS - sCenterY;
      const outLen = Math.hypot(outX, outY);
      const outwardAngle = outLen < 1 ? -Math.PI / 2 : Math.atan2(outY, outX);
      const regionCellsScreen = r.cellPoints.map((p) => ({
        x: (p.x - dataCenter.x) * scale + sCenterX,
        y: (p.y - dataCenter.y) * scale + sCenterY,
      }));
      let regionRadius = 0;
      for (const p of regionCellsScreen) {
        const d = Math.hypot(p.x - cxS, p.y - cyS);
        if (d > regionRadius) regionRadius = d;
      }
      const startR =
        regionRadius + HEX_SIZE * scale + Math.max(halfW, halfH) + 14;
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
          // Full circumscribed circle so any leader tangent to the hex outline
          // counts as a crossing, plus a small buffer to absorb the Bezier
          // deflection of the rendered leader curve.
          rad: HEX_SIZE * cellScaleOf(cid) * 1.0,
        });
      }

      // Freedom: # of evenly-spaced angles at startR that yield a slot which
      // doesn't collide with any data cell and is inside the SVG. Lower =
      // more constrained → must be placed first while options remain.
      let freedom = 0;
      const numAng = 16;
      for (let aIdx = 0; aIdx < numAng; aIdx++) {
        const theta = (aIdx * 2 * Math.PI) / numAng;
        const sx = cxS + startR * Math.cos(theta);
        const sy = cyS + startR * Math.sin(theta);
        if (hitsCell(sx, sy, halfW, halfH, r.clusterIds)) continue;
        if (!inSvg(sx, sy, halfW, halfH)) continue;
        freedom++;
      }

      regionPreps.push({
        idx,
        box,
        cxS,
        cyS,
        outwardAngle,
        startR,
        otherCellsData,
        freedom,
        size: r.size,
      });
    }

    // Adjacency: two regions are adjacent if their nearest cell-to-cell
    // distance is ≤ ~1 hex away. Used to penalize candidates that share a
    // similar angular direction with an already-placed adjacent region.
    const adjacent: boolean[][] = Array.from(
      { length: rawRegions.length },
      () => new Array(rawRegions.length).fill(false),
    );
    const ADJ_THRESHOLD = HEX_SIZE * 1.8;
    for (let a = 0; a < rawRegions.length; a++) {
      for (let b = a + 1; b < rawRegions.length; b++) {
        const ca = rawRegions[a].cellPoints;
        const cb = rawRegions[b].cellPoints;
        let touch = false;
        for (const pa of ca) {
          for (const pb of cb) {
            if (Math.hypot(pa.x - pb.x, pa.y - pb.y) <= ADJ_THRESHOLD) {
              touch = true;
              break;
            }
          }
          if (touch) break;
        }
        if (touch) {
          adjacent[a][b] = true;
          adjacent[b][a] = true;
        }
      }
    }

    // Most-constrained first; ties broken by size desc so that among equally
    // free regions, the bigger one (which has a larger label box) still gets
    // first dibs on a clean slot.
    const order = regionPreps.slice().sort((a, b) => {
      if (a.freedom !== b.freedom) return a.freedom - b.freedom;
      return b.size - a.size;
    });

    for (const prep of order) {
      const { idx, box, cxS, cyS, outwardAngle, startR, otherCellsData } = prep;
      const r = rawRegions[idx];
      const halfW = box.w / 2;
      const halfH = box.h / 2;

      // Already-placed adjacent regions feed into the angle-separation
      // penalty inside spiralSearch.
      const adjacentPlaced: Placed[] = [];
      for (const p of placedList) {
        if (adjacent[idx][p.idx]) adjacentPlaced.push(p);
      }

      const pos = spiralSearch(
        cxS,
        cyS,
        halfW,
        halfH,
        r.clusterIds,
        outwardAngle,
        startR,
        r,
        otherCellsData,
        adjacentPlaced,
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
      bracketByIdx.set(
        p.idx,
        p.topV && p.botV ? { topV: p.topV, botV: p.botV } : null,
      );
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

      const sameVertex =
        Math.abs(topV.x - botV.x) < 0.5 && Math.abs(topV.y - botV.y) < 0.5;
      const midX = sameVertex ? topV.x : (topV.x + botV.x) / 2;
      const midY = sameVertex ? topV.y : (topV.y + botV.y) / 2;

      let leaderPath: string;
      let handles: { x: number; y: number }[];
      if (sameVertex) {
        const c = bezCtrls(
          topV.x,
          topV.y,
          labelX,
          labelY,
          midX,
          midY,
          r.cx,
          r.cy,
        );
        leaderPath =
          `M${topV.x},${topV.y}` +
          `C${c.c1x},${c.c1y} ${c.c2x},${c.c2y} ${labelX},${labelY}`;
        handles = [topV];
      } else {
        // ONE continuous cubic SVG path: topV → label → botV. Both curves
        // share the c2 axis (midV→label) so they end with matching tangents
        // at label, producing a funnel-tip rather than two diverging arcs.
        const cTop = bezCtrls(
          topV.x,
          topV.y,
          labelX,
          labelY,
          midX,
          midY,
          r.cx,
          r.cy,
        );
        const cBot = bezCtrls(
          botV.x,
          botV.y,
          labelX,
          labelY,
          midX,
          midY,
          r.cx,
          r.cy,
        );
        leaderPath =
          `M${topV.x},${topV.y}` +
          `C${cTop.c1x},${cTop.c1y} ${cTop.c2x},${cTop.c2y} ${labelX},${labelY}` +
          `C${cBot.c2x},${cBot.c2y} ${cBot.c1x},${cBot.c1y} ${botV.x},${botV.y}`;
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
    centerX,
    centerY,
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
          coverageRegions[a].clusterIds.size -
          coverageRegions[b].clusterIds.size,
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

  // Mouse handlers
  const onHoverChangeRef = useRef(onHoverChange);
  onHoverChangeRef.current = onHoverChange;

  const handleMouseEnter = useCallback((tile: HexTile, e: React.MouseEvent) => {
    if (!tile.cluster) return;
    setHoveredClusterId(tile.cluster.id);
    onHoverChangeRef.current?.(tile.cluster.id);
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect)
      setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, []);

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
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Controls bar */}
      <ControlsBar
        detailLevel={detailLevel}
        setDetailLevel={setDetailLevel}
        allLevels={allLevels}
        colorMode={colorMode}
        setColorMode={wrappedSetColorMode}
        effectiveColorMode={effectiveColorMode}
        tunerNames={programTuners}
        metricLabel={metricLabel}
        coverageMetric={coverageMetric}
        setCoverageMetric={setCoverageMetric}
        selectedParam={selectedParam}
        onParamSelect={setSelectedParam}
        paramList={paramImportanceList}
        onHoverTuner={setHoveredTuner}
        pinnedTuners={pinnedTuners}
        onPinTuner={togglePin}
        coverageOverlay={coverageOverlay}
        setCoverageOverlay={setCoverageOverlay}
        onHoverCoverage={setCoverageHovered}
      />
      <div
        ref={containerRef}
        style={{
          flex: 1,
          position: "relative",
          minHeight: 0,
          overflow: "hidden",
        }}
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
            style={{
              display: "block",
              width: "100%",
              height: "100%",
              flex: 1,
              minWidth: 0,
            }}
          >
            {/* Per-region clipPath: union of mid-size (HEX_SIZE) hex shapes per
              cell. Inset shadow uses this clip — using uniform HEX_SIZE
              regardless of low/mid/high tier so the shadow band thickness
              and shape stays consistent across the region. */}
            <defs>
              {/* Per-cell overlap hatch: cells where BOTH pinned tuners have
                trials. Stripe width is proportional to the pin[1] share so
                the visual mix reflects how dominant each tuner is in that
                cell. Clamped to [1, 7] in an 8-px pattern so neither color
                disappears at extreme ratios. */}
              {pinnedTuners.length === 2 &&
                data &&
                data.hexTiles.map((tile) => {
                  const c = tile.cluster;
                  if (!c) return null;
                  const c0 = c.tunerCounts[pinnedTuners[0]];
                  const c1 = c.tunerCounts[pinnedTuners[1]];
                  if (c0 === 0 || c1 === 0) return null;
                  const r1 = c1 / (c0 + c1);
                  const stripeW = Math.max(1, Math.min(7, 8 * r1));
                  return (
                    <pattern
                      key={`hatch-overlap-${c.id}`}
                      id={`hatch-overlap-${c.id}`}
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
                        strokeWidth={stripeW}
                      />
                    </pattern>
                  );
                })}
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
              {/* Gaussian blur for the inset shadow — gives the band a smooth
                gradient falloff from the perimeter inward (instead of the
                stepped contour-line look from stacked strokes). The clipPath
                still cuts the outer half at the perimeter, so the visible
                result is one half of a Gaussian. */}
              <filter
                id="inset-shadow-soft"
                x="-50%"
                y="-50%"
                width="200%"
                height="200%"
              >
                <feGaussianBlur stdDeviation="4" />
              </filter>
              {/* Inverse of region-clip: white everywhere EXCEPT the region's
                cells. Used to limit the border's white halo to the outside
                of the region only. */}
              {coverageRegions.map((r, i) => (
                <mask
                  key={`rmask-${i}`}
                  id={`region-outside-mask-${i}`}
                  maskUnits="userSpaceOnUse"
                  x={-100000}
                  y={-100000}
                  width={200000}
                  height={200000}
                >
                  <rect
                    x={-100000}
                    y={-100000}
                    width={200000}
                    height={200000}
                    fill="white"
                  />
                  {r.cellPoints.map((p, ci) => (
                    <path
                      key={ci}
                      d={hexPath}
                      transform={`translate(${p.x}, ${p.y})`}
                      fill="black"
                    />
                  ))}
                </mask>
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

                  // Coverage active = either hovering or pinned via the
                  // checkbox. Both states swap the cell fill to the teal
                  // coverage scale and drop tuner colors entirely.
                  const coverageActive = coverageHovered || coverageOverlay;
                  const fill = coverageActive
                    ? getCoverageColor(getClusterCov(tile.cluster))
                    : getHexFill(tile);
                  const isHovered = hoveredClusterId === tile.cluster.id;
                  const isExternallyHovered =
                    externalHoveredClusterId !== null &&
                    externalHoveredClusterId === tile.cluster.id;
                  const isHighlighted = isHovered || isExternallyHovered;
                  const cellRegions = tile.cluster
                    ? (clusterToRegion.get(tile.cluster.id) ?? null)
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
                          effectiveColorMode === "complementary" &&
                          tile.cluster &&
                          t3TopIds.has(tile.cluster.id)
                            ? "#059669"
                            : tile.cluster && cartIds.has(tile.cluster.id)
                              ? "#1E293B"
                              : "#E2E8F0"
                        }
                        strokeWidth={
                          effectiveColorMode === "complementary" &&
                          tile.cluster &&
                          t3TopIds.has(tile.cluster.id)
                            ? 2
                            : tile.cluster && cartIds.has(tile.cluster.id)
                              ? 2
                              : 0.5
                        }
                        filter={isHighlighted ? "brightness(1.15)" : undefined}
                      />
                      {/* Tuner-param: full color wash on cells that belong to a region.
                      Skipped when a tuner is pinned/hovered (param-comparison
                      mode) so the underlying tuner color stays visible.
                      Also skipped while the Coverage overlay/preview is
                      active so the teal coverage fill isn't repainted. */}
                      {tileRegionIdx !== null &&
                        effectiveColorMode === "tuner-param" &&
                        pinnedTuners.length === 0 &&
                        !hoveredTuner &&
                        !coverageActive && (
                          <path
                            d={hexPath}
                            fill={coverageRegions[tileRegionIdx].color}
                            fillOpacity={inHoveredRegion ? 0.5 : 0.28}
                            pointerEvents="none"
                          />
                        )}
                      {/* Single-param wash: 28% opacity over grey base for
                        boolean / categorical (matches the All-mode pastel
                        feel), bumped to 0.42 for numeric so the three
                        single-hue tints stay clearly distinguishable.
                        Skipped for Mixed cells so they stay plain grey and
                        visibly differ from any tinted bin. */}
                      {effectiveColorMode === "tuner-param" &&
                        selectedParam &&
                        paramCellBins &&
                        pinnedTuners.length === 0 &&
                        !hoveredTuner &&
                        !coverageActive &&
                        (() => {
                          const bin = paramCellBins.bins.get(tile.cluster!.id);
                          if (!bin || bin === "Mixed") return null;
                          const c = paramCellBins.binColors[bin];
                          if (!c) return null;
                          const op =
                            selectedParamType === "numeric" ? 0.42 : 0.28;
                          return (
                            <path
                              d={hexPath}
                              fill={c}
                              fillOpacity={op}
                              pointerEvents="none"
                            />
                          );
                        })()}
                      {/* Inset shadow is drawn as a region-level border stroke
                      clipped to region cells (rendered outside this loop) so
                      only the OUTER perimeter gets the band — interior cells
                      stay clean. */}
                      {/* Cart amber dot is rendered AFTER all region/label
                      passes so it's never occluded by inset shadows, borders,
                      or leader paths. See the dedicated pass after tiles. */}
                      {/* +/− button for hovered cell is rendered in a top
                        pass below so it's never occluded by region borders
                        or other layers. */}
                    </g>
                  );
                })}

              {/* ── Notable-cell labels: optional text + optional tuner badge, stacked ── */}
              {effectiveHighlightLabels.map(
                ({ tile, clusterId, text, badge }) => {
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
                            fontStyle={text.italic ? "italic" : undefined}
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
                              fontStyle={text.italic ? "italic" : undefined}
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
                      {badge &&
                        (() => {
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
                },
              )}

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
                // Inset shadow is always the same dark neutral as the region
                // border so the perimeter band reads consistently across all
                // modes (tuner-perf / tuner-param / coverage active).
                const insetShadowColor = BORDER_COLOR;
                return (
                  <g key={`region-${i}`} pointerEvents="none" opacity={opacity}>
                    {/* Inset shadow: a single stroke centered on the perimeter
                      with Gaussian blur applied, then clipped to the region.
                      Half of the blurred Gaussian sits outside (clipped away)
                      and the inside half shows a continuous falloff — peak
                      alpha at the perimeter, smoothly fading to 0 inward. */}
                    <path
                      d={r.borderPath}
                      fill="none"
                      stroke={insetShadowColor}
                      strokeWidth={HEX_SIZE * 0.45}
                      strokeOpacity={isHov ? 0.55 : 0.4}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      filter="url(#inset-shadow-soft)"
                      clipPath={`url(#region-clip-${i})`}
                    />
                    {/* White underlay for border — masked to the OUTSIDE of
                      the region so the inner half of the stroke is hidden;
                      this lets the inset colored band meet the dark border
                      directly with no white sliver between them. */}
                    <path
                      d={r.borderPath}
                      fill="none"
                      stroke="white"
                      strokeWidth={borderStrokeOuter}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={0.9}
                      mask={`url(#region-outside-mask-${i})`}
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
                    {/* Handles are rendered in a separate top-pass below so
                      they sit above every region's borders, not just this
                      region's own border. */}
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
                        const maxLen = Math.max(
                          ...r.lines.map((l) => l.length),
                        );
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
                      {r.kind === "combined"
                        ? (() => {
                            const pillFont = fontSize;
                            const pillPadX = 7 / renderScale;
                            const pillPadY = 3 / renderScale;
                            const charW = pillFont * 0.62;
                            const tunerAbbr = r.tunerLabel ?? "";
                            const pillW =
                              tunerAbbr.length * charW + pillPadX * 2;
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
                            const totalContentH =
                              tunerRowH + interRowGap + catBlockH;
                            const startY = r.labelY - totalContentH / 2;
                            const topY = startY + tunerRowH / 2;
                            const catBlockStartY =
                              startY + tunerRowH + interRowGap;
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
                          })()
                        : r.kind === "tuner"
                          ? (() => {
                              const pillFont = fontSize;
                              const pillPadX = 7 / renderScale;
                              const pillPadY = 3 / renderScale;
                              const charW = pillFont * 0.62;
                              const tunerAbbr = r.label;
                              const pillW =
                                tunerAbbr.length * charW + pillPadX * 2;
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
                            })()
                          : r.lines.map((line, li) => {
                              const lineH = fontSize * 1.05;
                              const yOffset =
                                (li - (r.lines.length - 1) / 2) * lineH;
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
                            })}
                    </g>
                  </g>
                );
              })}

              {/* ── Region handle pass ──
                Re-rendered after every region's borders so each handle sits
                on top of any neighboring region's border, not just its own. */}
              {coverageRegions.map((r, i) =>
                r.handles.map((h, hi) => (
                  <circle
                    key={`handle-${i}-${hi}`}
                    cx={h.x}
                    cy={h.y}
                    r={3.5 / renderScale}
                    fill={r.color}
                    stroke="white"
                    strokeWidth={1.4 / renderScale}
                    pointerEvents="none"
                  />
                )),
              )}

              {/* ── Hover highlight stroke ──
                Drawn last so the dark outline of the currently hovered cell
                is visible even when the cell sits at a region perimeter. */}
              {(() => {
                const targetId =
                  hoveredClusterId ?? externalHoveredClusterId ?? null;
                if (targetId === null) return null;
                const tile = data.hexTiles.find(
                  (t) => t.cluster?.id === targetId,
                );
                if (!tile || !tile.cluster) return null;
                const cellScale = cellScaleOf(tile.cluster.id);
                return (
                  <g
                    transform={`translate(${tile.x}, ${tile.y}) scale(${cellScale})`}
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

              {/* ── Cart amber-dot layer ──
                Drawn AFTER tiles + regions so the dot is always on top of any
                inset shadow / border / leader. Hovered cells use the in-tile
                +/− button instead, so we skip them here. */}
              {data.hexTiles
                .filter(
                  (t) =>
                    t.cluster &&
                    cartIds.has(t.cluster.id) &&
                    hoveredClusterId !== t.cluster.id,
                )
                .map((t) => {
                  // Anchored at the hex's upper-right vertex (300°).
                  // Position scales with cellScale so the badge stays on the
                  // actual vertex; the dot itself is a fixed size.
                  const cellScale = cellScaleOf(t.cluster!.id);
                  const VX = 0.5; // cos(300°)
                  const VY = -Math.sqrt(3) / 2; // sin(300°), SVG y-down
                  return (
                    <circle
                      key={`cart-dot-${t.cluster!.id}`}
                      cx={t.x + HEX_SIZE * VX * cellScale}
                      cy={t.y + HEX_SIZE * VY * cellScale}
                      r={HEX_SIZE * 0.2}
                      fill="#F59E0B"
                      stroke="white"
                      strokeWidth={1.5}
                      pointerEvents="none"
                    />
                  );
                })}

              {/* ── Hover cart button (+/−) ──
                Top of every other layer so the click target and the icon
                are never partially hidden by region borders or labels. */}
              {hoveredClusterId !== null &&
                (() => {
                  const tile = data.hexTiles.find(
                    (t) => t.cluster?.id === hoveredClusterId,
                  );
                  if (!tile || !tile.cluster) return null;
                  // Anchored at the hex's upper-right vertex (300°). Position
                  // scales with cellScale so the badge sits on the actual
                  // vertex; circle/font are fixed sizes.
                  const cellScale = cellScaleOf(tile.cluster.id);
                  const VX = 0.5; // cos(300°)
                  const VY = -Math.sqrt(3) / 2; // sin(300°), SVG y-down
                  const cx = tile.x + HEX_SIZE * VX * cellScale;
                  const cy = tile.y + HEX_SIZE * VY * cellScale;
                  const r = HEX_SIZE * 0.28;
                  const inCart = cartIds.has(tile.cluster.id);
                  return (
                    <g
                      onClick={(e) => {
                        e.stopPropagation();
                        onCartToggle?.(tile.cluster!.id);
                      }}
                      // Re-assert hover when the cursor enters the button
                      // itself; without this the cell's mouseLeave (fired
                      // when the cursor crosses from the cell <path> onto
                      // the button) clears hoveredClusterId and removes
                      // the button before the click can land. React batches
                      // both updates so the final state stays = target id.
                      onMouseEnter={() => setHoveredClusterId(tile.cluster!.id)}
                      onMouseLeave={() => setHoveredClusterId(null)}
                      style={{ cursor: "pointer" }}
                    >
                      <circle
                        cx={cx}
                        cy={cy}
                        r={r}
                        fill={inCart ? "#F59E0B" : "#374151"}
                        stroke="white"
                        strokeWidth={1.8}
                      />
                      <text
                        x={cx}
                        y={cy}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={HEX_SIZE * 0.36}
                        fontWeight={700}
                        fill="white"
                        pointerEvents="none"
                      >
                        {inCart ? "−" : "+"}
                      </text>
                    </g>
                  );
                })()}
            </g>
          </svg>

          {/* In-map legend (top-right). Always rendered — child blocks decide
            their own visibility based on mode. */}
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
            {/* Toolbar row — master legend toggle + figure-capture legend
                toggle (Tuner mode only). */}
            <div
              style={{
                display: "flex",
                gap: 6,
                pointerEvents: "auto",
              }}
            >
              <button
                onClick={() => setLegendsVisible((v) => !v)}
                title={legendsVisible ? "Hide legends" : "Show legends"}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: legendsVisible
                    ? "rgba(255,255,255,0.92)"
                    : "rgba(15,23,42,0.85)",
                  color: legendsVisible ? "#374151" : "white",
                  border: "1px solid #E5E7EB",
                  borderRadius: 8,
                  boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
                  padding: "5px 9px",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {legendsVisible ? "Hide legends" : "Show legends"}
              </button>
              {effectiveColorMode === "tuner-perf" && legendsVisible && (
                <button
                  onClick={() => setFigureLegendVisible((v) => !v)}
                  title={
                    figureLegendVisible
                      ? "Back to standard legends"
                      : "Show figure-capture legend"
                  }
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    background: figureLegendVisible
                      ? "rgba(15,23,42,0.85)"
                      : "rgba(255,255,255,0.92)",
                    color: figureLegendVisible ? "white" : "#374151",
                    border: "1px solid #E5E7EB",
                    borderRadius: 8,
                    boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
                    padding: "5px 9px",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  <svg width={12} height={12} viewBox="-6 -6 12 12">
                    <path
                      d={getHexPath(4.5)}
                      fill="none"
                      stroke={figureLegendVisible ? "white" : "#475569"}
                      strokeWidth={1.4}
                    />
                  </svg>
                  Figure legend
                </button>
              )}
            </div>

            {legendsVisible && (
              <>
                {/* Complementary-mode legend — consolidated, matches the
                tuner-perf / tuner-param layout. Sections: Score → Size →
                Markers. Auto-shown whenever the working set is non-empty
                (which is exactly when complementary mode is active). */}
                {effectiveColorMode === "complementary" && t3Scores && (
                  <div
                    style={{
                      background: "rgba(255,255,255,0.92)",
                      backdropFilter: "blur(4px)",
                      borderRadius: 10,
                      border: "1px solid #E5E7EB",
                      boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
                      padding: "12px 16px",
                      maxWidth: 320,
                    }}
                  >
                    {/* — Section 1: Score — */}
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 700,
                        color: "#374151",
                        marginBottom: 6,
                      }}
                    >
                      Score{" "}
                      <span style={{ fontWeight: 500, color: "#6B7280" }}>
                        (+ {metricLabel})
                      </span>
                    </div>
                    <svg width={200} height={30}>
                      <defs>
                        <linearGradient
                          id="comp-legend-grad"
                          x1="0"
                          y1="0"
                          x2="1"
                          y2="0"
                        >
                          <stop offset="0%" stopColor="#F1F5F9" />
                          <stop offset="100%" stopColor="#10B981" />
                        </linearGradient>
                      </defs>
                      <rect
                        width={200}
                        height={12}
                        fill="url(#comp-legend-grad)"
                        stroke="#E5E7EB"
                        strokeWidth={0.5}
                        rx={2}
                      />
                      <text
                        x={0}
                        y={26}
                        fontSize={11}
                        fill="#6B7280"
                        textAnchor="start"
                      >
                        0
                      </text>
                      <text
                        x={200}
                        y={26}
                        fontSize={11}
                        fill="#6B7280"
                        fontStyle="italic"
                        textAnchor="end"
                      >
                        +{fmtMetric(t3Scores.maxScore)}
                      </text>
                    </svg>
                    <div
                      style={{
                        fontSize: 11,
                        color: "#94A3B8",
                        marginTop: 4,
                        fontStyle: "italic",
                      }}
                    >
                      Anchor: {fmtMetric(t3Scores.anchorBranchCount)}{" "}
                      {metricLabel}
                    </div>

                    {/* — Section 2: Size — */}
                    {cellSizeTier.tierMap.size > 0 &&
                      (() => {
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
                        const hexR = 9;
                        return (
                          <>
                            <div
                              style={{
                                fontSize: 14,
                                fontWeight: 700,
                                color: "#374151",
                                marginTop: 14,
                                marginBottom: 6,
                              }}
                            >
                              Size
                            </div>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "flex-end",
                                gap: 14,
                              }}
                            >
                              {tiers.map((t) => (
                                <div
                                  key={t.key}
                                  style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    alignItems: "center",
                                    gap: 3,
                                  }}
                                >
                                  <svg
                                    width={hexBoxPx}
                                    height={hexBoxPx}
                                    viewBox={`-${hexBoxPx / 2} -${hexBoxPx / 2} ${hexBoxPx} ${hexBoxPx}`}
                                  >
                                    <path
                                      d={getHexPath(hexR * t.scale)}
                                      fill={MIXED_COLOR}
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
                          </>
                        );
                      })()}

                    {/* — Section 3: Markers — example cells matching the on-map
                    rendering for complementary candidates / working set. */}
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 700,
                        color: "#374151",
                        marginTop: 14,
                        marginBottom: 6,
                      }}
                    >
                      Markers
                    </div>
                    {(() => {
                      const sampleR = 16;
                      const sampleBoxW = 50;
                      const sampleBoxH = 40;
                      const SampleHex = ({
                        children,
                        stroke,
                      }: {
                        children: React.ReactNode;
                        stroke?: string;
                      }) => (
                        <svg
                          width={sampleBoxW}
                          height={sampleBoxH}
                          viewBox={`-${sampleBoxW / 2} -${sampleBoxH / 2} ${sampleBoxW} ${sampleBoxH}`}
                        >
                          <path d={getHexPath(sampleR)} fill={MIXED_COLOR} />
                          {stroke && (
                            <path
                              d={getHexPath(sampleR)}
                              fill="none"
                              stroke={stroke}
                              strokeWidth={2}
                            />
                          )}
                          {children}
                        </svg>
                      );
                      const Row = ({
                        visual,
                        label,
                      }: {
                        visual: React.ReactNode;
                        label: string;
                      }) => (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            fontSize: 12,
                            color: "#374151",
                          }}
                        >
                          {visual}
                          <span>{label}</span>
                        </div>
                      );
                      return (
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 6,
                          }}
                        >
                          <Row
                            visual={
                              <SampleHex stroke="#059669">
                                <text
                                  x={0}
                                  y={-5}
                                  textAnchor="middle"
                                  dominantBaseline="central"
                                  fontSize={13}
                                  fontWeight={700}
                                  fill="#0F172A"
                                  stroke="white"
                                  strokeWidth={3}
                                  paintOrder="stroke"
                                >
                                  No. 1
                                </text>
                                <text
                                  x={0}
                                  y={11}
                                  textAnchor="middle"
                                  dominantBaseline="central"
                                  fontSize={11}
                                  fontWeight={600}
                                  fontStyle="italic"
                                  fill="#10B981"
                                  stroke="white"
                                  strokeWidth={3}
                                  paintOrder="stroke"
                                >
                                  +X
                                </text>
                              </SampleHex>
                            }
                            label="Top complement candidates"
                          />
                          <Row
                            visual={
                              <SampleHex stroke="#1E293B">
                                <text
                                  x={0}
                                  y={0}
                                  textAnchor="middle"
                                  dominantBaseline="central"
                                  fontSize={14}
                                  fontWeight={700}
                                  fill="#0F172A"
                                  stroke="white"
                                  strokeWidth={3}
                                  paintOrder="stroke"
                                >
                                  #N
                                </text>
                              </SampleHex>
                            }
                            label={`Working set member`}
                          />
                        </div>
                      );
                    })()}
                  </div>
                )}
                {/* Coverage legend — shown only while the Coverage checkbox is
              hovered or pinned. Mirrors the d3.interpolateGreens scale used
              for the cell fill, with min/max labels from globalCovRange. */}
                {(coverageHovered || coverageOverlay) &&
                  (() => {
                    const fmt = (v: number) => fmtMetric(v);
                    const stops = [0, 0.25, 0.5, 0.75, 1];
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
                          {isHPO ? "Accuracy" : "Coverage"}{" "}
                          <span style={{ fontWeight: 500, color: "#6B7280" }}>
                            ({coverageMetric})
                          </span>
                        </div>
                        <svg width={200} height={30}>
                          <defs>
                            <linearGradient
                              id="cov-legend-grad"
                              x1="0"
                              y1="0"
                              x2="1"
                              y2="0"
                            >
                              {stops.map((t) => (
                                <stop
                                  key={t}
                                  offset={`${t * 100}%`}
                                  stopColor={d3.interpolateGreens(
                                    0.1 + t * 0.8,
                                  )}
                                />
                              ))}
                            </linearGradient>
                          </defs>
                          <rect
                            width={200}
                            height={12}
                            fill="url(#cov-legend-grad)"
                            stroke="#E5E7EB"
                            strokeWidth={0.5}
                            rx={2}
                          />
                          <text
                            x={0}
                            y={26}
                            fontSize={11}
                            fill="#6B7280"
                            fontStyle="italic"
                            textAnchor="start"
                          >
                            {fmt(globalCovRange.min)}
                          </text>
                          <text
                            x={200}
                            y={26}
                            fontSize={11}
                            fill="#6B7280"
                            fontStyle="italic"
                            textAnchor="end"
                          >
                            {fmt(globalCovRange.max)}
                          </text>
                        </svg>
                      </div>
                    );
                  })()}
                {/* Tuner-mode legend — single consolidated card covering:
                  1) Trials-per-cell size tiers (shown first)
                  2) Cell markers — example hex per marker, no descriptive
                     prefix (the meaning is enough)
                  3) Coverage zone definitions on two lines (label + desc)
                Hidden when the big figure-capture legend is active. */}
                {effectiveColorMode === "tuner-perf" &&
                  !figureLegendVisible && (
                    <div
                      style={{
                        background: "rgba(255,255,255,0.92)",
                        backdropFilter: "blur(4px)",
                        borderRadius: 10,
                        border: "1px solid #E5E7EB",
                        boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
                        padding: "12px 16px",
                        maxWidth: 300,
                      }}
                    >
                      {/* — Section 1: Trials per cell — */}
                      {cellSizeTier.tierMap.size > 0 &&
                        (() => {
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
                          const hexR = 9;
                          return (
                            <>
                              <div
                                style={{
                                  fontSize: 14,
                                  fontWeight: 700,
                                  color: "#374151",
                                  marginBottom: 6,
                                }}
                              >
                                Cluster Size
                              </div>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "flex-end",
                                  gap: 14,
                                }}
                              >
                                {tiers.map((t) => (
                                  <div
                                    key={t.key}
                                    style={{
                                      display: "flex",
                                      flexDirection: "column",
                                      alignItems: "center",
                                      gap: 3,
                                    }}
                                  >
                                    <svg
                                      width={hexBoxPx}
                                      height={hexBoxPx}
                                      viewBox={`-${hexBoxPx / 2} -${hexBoxPx / 2} ${hexBoxPx} ${hexBoxPx}`}
                                    >
                                      <path
                                        d={getHexPath(hexR * t.scale)}
                                        fill={MIXED_COLOR}
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
                            </>
                          );
                        })()}

                      {/* — Section 2: Cell markers — example cells (mixed-color
                    background) with the marker rendered in context. */}
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 700,
                          color: "#374151",
                          marginTop: 14,
                          marginBottom: 6,
                        }}
                      >
                        Markers
                      </div>
                      {(() => {
                        const sampleR = 16;
                        const sampleBoxW = 50;
                        const sampleBoxH = 40;
                        const areaClipId = "tp-legend-area-clip";
                        const areaBlurId = "tp-legend-area-blur";
                        const areaOutsideMaskId = "tp-legend-area-outside";
                        const SampleHex = ({
                          children,
                        }: {
                          children: React.ReactNode;
                        }) => (
                          <svg
                            width={sampleBoxW}
                            height={sampleBoxH}
                            viewBox={`-${sampleBoxW / 2} -${sampleBoxH / 2} ${sampleBoxW} ${sampleBoxH}`}
                          >
                            <path d={getHexPath(sampleR)} fill={MIXED_COLOR} />
                            {children}
                          </svg>
                        );
                        const Row = ({
                          visual,
                          label,
                        }: {
                          visual: React.ReactNode;
                          label: string;
                        }) => (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              fontSize: 12,
                              color: "#374151",
                            }}
                          >
                            {visual}
                            <span>{label}</span>
                          </div>
                        );
                        return (
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: 6,
                            }}
                          >
                            <Row
                              visual={
                                <SampleHex>
                                  <text
                                    x={0}
                                    y={0}
                                    textAnchor="middle"
                                    dominantBaseline="central"
                                    fontSize={14}
                                    fontWeight={700}
                                    fontStyle="italic"
                                    fill="#0F172A"
                                    stroke="white"
                                    strokeWidth={3}
                                    paintOrder="stroke"
                                  >
                                    82.6
                                  </text>
                                </SampleHex>
                              }
                              label={`Min / Max ${metricLabel} cell`}
                            />
                            <Row
                              visual={
                                <SampleHex>
                                  <text
                                    x={0}
                                    y={-5}
                                    textAnchor="middle"
                                    dominantBaseline="central"
                                    fontSize={14}
                                    fontWeight={700}
                                    fill="#0F172A"
                                    stroke="white"
                                    strokeWidth={3}
                                    paintOrder="stroke"
                                  >
                                    1,500
                                  </text>
                                  <text
                                    x={0}
                                    y={11}
                                    textAnchor="middle"
                                    dominantBaseline="central"
                                    fontSize={11}
                                    fontWeight={600}
                                    fill="#475569"
                                    stroke="white"
                                    strokeWidth={3}
                                    paintOrder="stroke"
                                  >
                                    trials
                                  </text>
                                </SampleHex>
                              }
                              label="Densest / Sparsest cell"
                            />
                            <Row
                              visual={
                                <SampleHex>
                                  {/* Mirrors the on-map region rendering: blurred
                              + clipped inset shadow, white outer underlay,
                              then the dark border line on top. */}
                                  <defs>
                                    <clipPath id={areaClipId}>
                                      <path d={getHexPath(sampleR)} />
                                    </clipPath>
                                    <filter
                                      id={areaBlurId}
                                      x="-50%"
                                      y="-50%"
                                      width="200%"
                                      height="200%"
                                    >
                                      <feGaussianBlur stdDeviation={2} />
                                    </filter>
                                    {/* Mask = everywhere EXCEPT the hex interior,
                                so the white underlay only shows outside the
                                cell (matches the on-map rendering). */}
                                    <mask
                                      id={areaOutsideMaskId}
                                      maskUnits="userSpaceOnUse"
                                      x={-sampleBoxW / 2}
                                      y={-sampleBoxH / 2}
                                      width={sampleBoxW}
                                      height={sampleBoxH}
                                    >
                                      <rect
                                        x={-sampleBoxW / 2}
                                        y={-sampleBoxH / 2}
                                        width={sampleBoxW}
                                        height={sampleBoxH}
                                        fill="white"
                                      />
                                      <path
                                        d={getHexPath(sampleR)}
                                        fill="black"
                                      />
                                    </mask>
                                  </defs>
                                  <path
                                    d={getHexPath(sampleR)}
                                    fill="none"
                                    stroke="#0F172A"
                                    strokeWidth={sampleR * 0.45}
                                    strokeOpacity={0.4}
                                    strokeLinejoin="round"
                                    filter={`url(#${areaBlurId})`}
                                    clipPath={`url(#${areaClipId})`}
                                  />
                                  <path
                                    d={getHexPath(sampleR)}
                                    fill="none"
                                    stroke="white"
                                    strokeWidth={3}
                                    strokeOpacity={0.9}
                                    strokeLinejoin="round"
                                    mask={`url(#${areaOutsideMaskId})`}
                                  />
                                  <path
                                    d={getHexPath(sampleR)}
                                    fill="none"
                                    stroke="#0F172A"
                                    strokeWidth={1.5}
                                    strokeOpacity={0.85}
                                    strokeLinejoin="round"
                                  />
                                </SampleHex>
                              }
                              label="Area highlight"
                            />
                          </div>
                        );
                      })()}

                      {/* — Section 3: Labels — name + meaning on separate lines
                    so each label reads as a paragraph. */}
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 700,
                          color: "#374151",
                          marginTop: 14,
                          marginBottom: 6,
                        }}
                      >
                        Labels
                      </div>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 10,
                        }}
                      >
                        {[
                          {
                            name: "Overexplored but Low",
                            desc: "cov ≤ p25 ∧ trials ≥ p75",
                          },
                          { name: "High-Coverage Zone", desc: "cov ≥ p75" },
                          { name: "Low-Coverage Zone", desc: "cov ≤ p25" },
                          {
                            name: "Coverage Plateau",
                            desc: "cov ∈ [p33, p67]",
                          },
                        ].map((z) => (
                          <div
                            key={z.name}
                            style={{
                              fontSize: 12,
                              color: "#374151",
                              lineHeight: 1.45,
                            }}
                          >
                            <div style={{ fontWeight: 600 }}>{z.name}</div>
                            <div style={{ color: "#94A3B8" }}>{z.desc}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                {/* Parameter-mode legend — consolidated. Layout:
                  Bins (single-param only, surfaces first since it's what
                       the user is actively inspecting) →
                  Size → Markers → Labels.
                In "All" view (no specific param), Bins is skipped. */}
                {effectiveColorMode === "tuner-param" && (
                  <div
                    style={{
                      background: "rgba(255,255,255,0.92)",
                      backdropFilter: "blur(4px)",
                      borderRadius: 10,
                      border: "1px solid #E5E7EB",
                      boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
                      padding: "12px 16px",
                      maxWidth: 320,
                    }}
                  >
                    {/* — Section 1: Bins (only when a specific param is selected) — */}
                    {selectedParam && paramCellBins && (
                      <>
                        <div
                          style={{
                            fontSize: 14,
                            fontWeight: 700,
                            color: "#374151",
                            marginBottom: 6,
                          }}
                        >
                          {selectedParam}{" "}
                          <span style={{ fontWeight: 500, color: "#6B7280" }}>
                            ({selectedParamType})
                          </span>
                        </div>
                        <div
                          style={(() => {
                            // Layout choice:
                            //  - numeric: vertical column (range strings are wide)
                            //  - boolean (3 bins): single horizontal row (no wrap)
                            //  - categorical: 2-col grid if many, else flex row
                            if (selectedParamType === "numeric") {
                              return {
                                display: "flex",
                                flexDirection: "column",
                                gap: 2,
                              } as React.CSSProperties;
                            }
                            if (selectedParamType === "boolean") {
                              return {
                                display: "flex",
                                flexWrap: "nowrap",
                                gap: 12,
                                alignItems: "center",
                              } as React.CSSProperties;
                            }
                            return {
                              display: "grid",
                              gridTemplateColumns:
                                paramCellBins.binNames.length > 3
                                  ? "repeat(2, minmax(0, 1fr))"
                                  : "repeat(auto-fit, minmax(80px, 1fr))",
                              columnGap: 10,
                              rowGap: 2,
                            } as React.CSSProperties;
                          })()}
                        >
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
                                  backgroundColor:
                                    paramCellBins.binColors[bin] ?? MIXED_COLOR,
                                  opacity: 0.7,
                                  flexShrink: 0,
                                }}
                              />
                              <span
                                style={{
                                  fontSize: 12,
                                  fontWeight: 600,
                                  color:
                                    paramCellBins.binColors[bin] ?? MIXED_COLOR,
                                  whiteSpace: "nowrap",
                                  overflow:
                                    selectedParamType === "numeric"
                                      ? "visible"
                                      : "hidden",
                                  textOverflow:
                                    selectedParamType === "numeric"
                                      ? "clip"
                                      : "ellipsis",
                                }}
                                title={bin}
                              >
                                {bin}
                              </span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    {/* — Section 2: Size — */}
                    {cellSizeTier.tierMap.size > 0 &&
                      (() => {
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
                        const hexR = 9;
                        return (
                          <>
                            <div
                              style={{
                                fontSize: 14,
                                fontWeight: 700,
                                color: "#374151",
                                marginTop: selectedParam ? 14 : 0,
                                marginBottom: 6,
                              }}
                            >
                              Size
                            </div>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "flex-end",
                                gap: 14,
                              }}
                            >
                              {tiers.map((t) => (
                                <div
                                  key={t.key}
                                  style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    alignItems: "center",
                                    gap: 3,
                                  }}
                                >
                                  <svg
                                    width={hexBoxPx}
                                    height={hexBoxPx}
                                    viewBox={`-${hexBoxPx / 2} -${hexBoxPx / 2} ${hexBoxPx} ${hexBoxPx}`}
                                  >
                                    <path
                                      d={getHexPath(hexR * t.scale)}
                                      fill={MIXED_COLOR}
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
                          </>
                        );
                      })()}

                    {/* — Section 3: Markers — */}
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 700,
                        color: "#374151",
                        marginTop: 14,
                        marginBottom: 6,
                      }}
                    >
                      Markers
                    </div>
                    {(() => {
                      const sampleR = 16;
                      const sampleBoxW = 50;
                      const sampleBoxH = 40;
                      const areaClipId = "pp-legend-area-clip";
                      const areaBlurId = "pp-legend-area-blur";
                      const areaOutsideMaskId = "pp-legend-area-outside";
                      const SampleHex = ({
                        children,
                      }: {
                        children: React.ReactNode;
                      }) => (
                        <svg
                          width={sampleBoxW}
                          height={sampleBoxH}
                          viewBox={`-${sampleBoxW / 2} -${sampleBoxH / 2} ${sampleBoxW} ${sampleBoxH}`}
                        >
                          <path d={getHexPath(sampleR)} fill={MIXED_COLOR} />
                          {children}
                        </svg>
                      );
                      const Row = ({
                        visual,
                        label,
                      }: {
                        visual: React.ReactNode;
                        label: string;
                      }) => (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            fontSize: 12,
                            color: "#374151",
                          }}
                        >
                          {visual}
                          <span>{label}</span>
                        </div>
                      );
                      return (
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 6,
                          }}
                        >
                          <Row
                            visual={
                              <SampleHex>
                                <text
                                  x={0}
                                  y={0}
                                  textAnchor="middle"
                                  dominantBaseline="central"
                                  fontSize={14}
                                  fontWeight={700}
                                  fontStyle="italic"
                                  fill="#0F172A"
                                  stroke="white"
                                  strokeWidth={3}
                                  paintOrder="stroke"
                                >
                                  82.6
                                </text>
                              </SampleHex>
                            }
                            label={`Min / Max ${metricLabel} cell`}
                          />
                          <Row
                            visual={
                              <SampleHex>
                                <text
                                  x={0}
                                  y={-5}
                                  textAnchor="middle"
                                  dominantBaseline="central"
                                  fontSize={14}
                                  fontWeight={700}
                                  fill="#0F172A"
                                  stroke="white"
                                  strokeWidth={3}
                                  paintOrder="stroke"
                                >
                                  1,500
                                </text>
                                <text
                                  x={0}
                                  y={11}
                                  textAnchor="middle"
                                  dominantBaseline="central"
                                  fontSize={11}
                                  fontWeight={600}
                                  fill="#475569"
                                  stroke="white"
                                  strokeWidth={3}
                                  paintOrder="stroke"
                                >
                                  trials
                                </text>
                              </SampleHex>
                            }
                            label="Densest / Sparsest cell"
                          />
                          <Row
                            visual={
                              <SampleHex>
                                {/* Mirrors the on-map region rendering: blurred
                              + clipped inset shadow, white outer underlay,
                              then the dark border line on top. */}
                                <defs>
                                  <clipPath id={areaClipId}>
                                    <path d={getHexPath(sampleR)} />
                                  </clipPath>
                                  <filter
                                    id={areaBlurId}
                                    x="-50%"
                                    y="-50%"
                                    width="200%"
                                    height="200%"
                                  >
                                    <feGaussianBlur stdDeviation={2} />
                                  </filter>
                                  {/* Mask = everywhere EXCEPT the hex interior,
                                so the white underlay only shows outside the
                                cell (matches the on-map rendering). */}
                                  <mask
                                    id={areaOutsideMaskId}
                                    maskUnits="userSpaceOnUse"
                                    x={-sampleBoxW / 2}
                                    y={-sampleBoxH / 2}
                                    width={sampleBoxW}
                                    height={sampleBoxH}
                                  >
                                    <rect
                                      x={-sampleBoxW / 2}
                                      y={-sampleBoxH / 2}
                                      width={sampleBoxW}
                                      height={sampleBoxH}
                                      fill="white"
                                    />
                                    <path
                                      d={getHexPath(sampleR)}
                                      fill="black"
                                    />
                                  </mask>
                                </defs>
                                <path
                                  d={getHexPath(sampleR)}
                                  fill="none"
                                  stroke="#0F172A"
                                  strokeWidth={sampleR * 0.45}
                                  strokeOpacity={0.4}
                                  strokeLinejoin="round"
                                  filter={`url(#${areaBlurId})`}
                                  clipPath={`url(#${areaClipId})`}
                                />
                                <path
                                  d={getHexPath(sampleR)}
                                  fill="none"
                                  stroke="white"
                                  strokeWidth={3}
                                  strokeOpacity={0.9}
                                  strokeLinejoin="round"
                                  mask={`url(#${areaOutsideMaskId})`}
                                />
                                <path
                                  d={getHexPath(sampleR)}
                                  fill="none"
                                  stroke="#0F172A"
                                  strokeWidth={1.5}
                                  strokeOpacity={0.85}
                                  strokeLinejoin="round"
                                />
                              </SampleHex>
                            }
                            label="Area highlight"
                          />
                        </div>
                      );
                    })()}

                    {/* — Section 4: Labels — content depends on All vs single-param. */}
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 700,
                        color: "#374151",
                        marginTop: 14,
                        marginBottom: 6,
                      }}
                    >
                      Labels
                    </div>
                    {selectedParam ? (
                      // Single-param view → coverage qualitative regions (same
                      // five as tuner mode).
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 10,
                        }}
                      >
                        {[
                          {
                            name: "Underexplored Promising",
                            desc: "cov ≥ p75 ∧ trials ≤ p25",
                          },
                          {
                            name: "Overexplored but Low",
                            desc: "cov ≤ p25 ∧ trials ≥ p75",
                          },
                          { name: "High-Coverage Zone", desc: "cov ≥ p75" },
                          { name: "Low-Coverage Zone", desc: "cov ≤ p25" },
                          {
                            name: "Coverage Plateau",
                            desc: "cov ∈ [p33, p67]",
                          },
                        ].map((z) => (
                          <div
                            key={z.name}
                            style={{
                              fontSize: 12,
                              color: "#374151",
                              lineHeight: 1.45,
                            }}
                          >
                            <div style={{ fontWeight: 600 }}>{z.name}</div>
                            <div style={{ color: "#94A3B8" }}>{z.desc}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      // All view → color legend listing each top-5 parameter
                      // with its assigned CAT_PALETTE color and dominant bin.
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            color: "#94A3B8",
                            lineHeight: 1.4,
                            marginBottom: 2,
                          }}
                        >
                          Top 5 most-important parameters; each region shows the
                          parameter's dominant bin.
                        </div>
                        {coverageRegions.length === 0 ? (
                          <div style={{ fontSize: 12, color: "#94A3B8" }}>
                            No regions surfaced.
                          </div>
                        ) : (
                          coverageRegions.map((r, i) => {
                            const pname = r.lines[0] ?? r.label.split(":")[0];
                            return (
                              <div
                                key={i}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 8,
                                  fontSize: 12,
                                  color: "#374151",
                                }}
                              >
                                {/* Swatch mirrors map cell rendering: grey base
                                    (#E2E8F0) with the region color washed at 0.28
                                    opacity on top, so the legend reads the same
                                    tone as the on-map region wash. */}
                                <div
                                  style={{
                                    position: "relative",
                                    width: 14,
                                    height: 14,
                                    borderRadius: 3,
                                    background: "#E2E8F0",
                                    flexShrink: 0,
                                    border: "1px solid rgba(0,0,0,0.08)",
                                    overflow: "hidden",
                                  }}
                                >
                                  <div
                                    style={{
                                      position: "absolute",
                                      inset: 0,
                                      background: r.color,
                                      opacity: 0.28,
                                    }}
                                  />
                                </div>
                                <span style={{ fontWeight: 600 }}>{pname}</span>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Tuner-mode big legend — figure-style consolidated CELL + REGION
                key. Replaces all other legend cards while in this mode. */}
                {effectiveColorMode === "tuner-perf" &&
                  figureLegendVisible &&
                  (() => {
                    const fmt = (v: number) => v.toLocaleString();
                    const subHeader = (title: string) => (
                      <div
                        style={{
                          fontSize: 16,
                          fontWeight: 700,
                          color: "#374151",
                          marginBottom: 4,
                        }}
                      >
                        {title}
                      </div>
                    );
                    const tiers = [
                      { scale: 0.7, range: `≤ ${fmt(cellSizeTier.lowMax)}` },
                      {
                        scale: 1.0,
                        range: `${fmt(cellSizeTier.lowMax)}–${fmt(cellSizeTier.midMax)}`,
                      },
                      { scale: 1.25, range: `> ${fmt(cellSizeTier.midMax)}` },
                    ];
                    // Match the apparent hex radius on the map: HEX_SIZE × scale
                    // (the same product that produces an on-map cell's visible
                    // size). Multiplied by per-tier cellScale (0.7 / 1.0 / 1.25).
                    const baseHexR = HEX_SIZE * scale;
                    const maxTierR = baseHexR * 1.25;
                    const sampleBox = Math.max(
                      Math.ceil(maxTierR * 2 + 10),
                      36,
                    );
                    // Default-tier hex used in annotation rows.
                    const sampleHexR = baseHexR;
                    // Same font sizes the on-map highlight labels use (12px value,
                    // 10px unit) so the legend's sample hexes match what the user
                    // sees in the data view.
                    const VALUE_SIZE = 12;
                    const UNIT_SIZE = 10;
                    const LINE_GAP = 4;
                    // Match map's halo (white stroke + paintOrder=stroke) so the
                    // sample text reads exactly the same as on-map highlight text.
                    const HALO_W = 3;
                    const sampleHex = (
                      opts: {
                        text?: string;
                        sub?: string;
                        dot?: boolean;
                        italic?: boolean;
                      } = {},
                    ) => {
                      const totalH = opts.text
                        ? opts.sub
                          ? VALUE_SIZE + LINE_GAP + UNIT_SIZE
                          : VALUE_SIZE
                        : 0;
                      const topY = -totalH / 2;
                      const valueY = opts.sub ? topY + VALUE_SIZE / 2 : 0;
                      const unitY =
                        topY + VALUE_SIZE + LINE_GAP + UNIT_SIZE / 2;
                      return (
                        <svg
                          width={sampleBox}
                          height={sampleBox}
                          viewBox={`-${sampleBox / 2} -${sampleBox / 2} ${sampleBox} ${sampleBox}`}
                        >
                          {/* Cell hex — no visible border, matching the map where
                        the default cell stroke is barely-perceptible (0.5px
                        SVG × scale ≈ sub-pixel). */}
                          <path
                            d={getHexPath(sampleHexR)}
                            fill={MIXED_COLOR}
                            stroke="none"
                          />
                          {opts.text && (
                            <text
                              x={0}
                              y={valueY}
                              textAnchor="middle"
                              dominantBaseline="central"
                              fontSize={VALUE_SIZE}
                              fontWeight={700}
                              fontStyle={opts.italic ? "italic" : undefined}
                              fill="#0F172A"
                              stroke="white"
                              strokeWidth={HALO_W}
                              paintOrder="stroke"
                            >
                              {opts.text}
                            </text>
                          )}
                          {opts.sub && (
                            <text
                              x={0}
                              y={unitY}
                              textAnchor="middle"
                              dominantBaseline="central"
                              fontSize={UNIT_SIZE}
                              fontWeight={600}
                              fill="#475569"
                              stroke="white"
                              strokeWidth={HALO_W}
                              paintOrder="stroke"
                            >
                              {opts.sub}
                            </text>
                          )}
                          {/* Amber dot — proportions match the on-map cart marker
                        (r = HEX × 0.14, offset = HEX × 0.55) so the legend
                        glyph and the actual map glyph are pixel-equivalent. */}
                          {opts.dot && (
                            <circle
                              cx={sampleHexR * 0.55}
                              cy={-sampleHexR * 0.55}
                              r={sampleHexR * 0.14}
                              fill="#F59E0B"
                              stroke="white"
                              strokeWidth={1.2 * scale}
                            />
                          )}
                        </svg>
                      );
                    };
                    // Annotation row template
                    const annoRow = (
                      visual: React.ReactNode,
                      label: string,
                      key: string,
                    ) => (
                      <div
                        key={key}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                        }}
                      >
                        <div
                          style={{
                            width: sampleBox,
                            flexShrink: 0,
                            display: "flex",
                            justifyContent: "center",
                          }}
                        >
                          {visual}
                        </div>
                        <span style={{ fontSize: 16, color: "#475569" }}>
                          {label}
                        </span>
                      </div>
                    );
                    // Width scales loosely with hex size so larger viewports get
                    // a roomier legend (still capped to keep portrait layouts sane).
                    const legendWidth = Math.min(
                      Math.max(340, sampleBox * 6 + 40),
                      420,
                    );
                    return (
                      <div
                        style={{
                          pointerEvents: "auto",
                          position: "relative",
                          background: "rgba(255,255,255)",
                          backdropFilter: "blur(4px)",
                          borderRadius: 12,
                          // border: "1px solid #E5E7EB",
                          // boxShadow: "0 6px 22px rgba(0,0,0,0.12)",
                          padding: "14px 18px 16px",
                          width: legendWidth,
                          color: "#374151",
                        }}
                      >
                        <button
                          onClick={() => setFigureLegendVisible(false)}
                          title="Hide legend"
                          style={{
                            position: "absolute",
                            top: 6,
                            right: 8,
                            width: 22,
                            height: 22,
                            border: "none",
                            borderRadius: 6,
                            background: "transparent",
                            color: "#94A3B8",
                            fontSize: 16,
                            lineHeight: 1,
                            cursor: "pointer",
                            pointerEvents: "auto",
                          }}
                        >
                          ×
                        </button>
                        {/* Mirrors the on-map standard legend layout:
                            Colors → Size → Markers. Bigger fonts since
                            this view is meant for screenshots / figures. */}
                        {/* — Colors — */}
                        {subHeader("Colors")}
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(3, 1fr)",
                            columnGap: 12,
                            rowGap: 6,
                            marginBottom: 16,
                          }}
                        >
                          {TUNER_NAMES.filter((t) => selectedTuners.has(t)).map(
                            (t) => (
                              <div
                                key={t}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 8,
                                  fontSize: 14,
                                }}
                              >
                                <span
                                  style={{
                                    width: 14,
                                    height: 14,
                                    borderRadius: 3,
                                    background: TUNER_COLORS[t],
                                    flexShrink: 0,
                                  }}
                                />
                                <span style={{ fontWeight: 600 }}>
                                  {TUNER_DISPLAY_NAMES[t]}
                                </span>
                              </div>
                            ),
                          )}
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              fontSize: 14,
                            }}
                          >
                            <span
                              style={{
                                width: 14,
                                height: 14,
                                borderRadius: 3,
                                background: MIXED_COLOR,
                                flexShrink: 0,
                              }}
                            />
                            <span style={{ fontWeight: 600 }}>Mixed</span>
                          </div>
                        </div>

                        {/* — Size — */}
                        {subHeader("Cluster Size")}
                        <div
                          style={{
                            display: "flex",
                            alignItems: "flex-end",
                            gap: 18,
                            marginBottom: 16,
                          }}
                        >
                          {tiers.map((t) => (
                            <div
                              key={t.range}
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: 4,
                              }}
                            >
                              <svg
                                width={sampleBox}
                                height={sampleBox}
                                viewBox={`-${sampleBox / 2} -${sampleBox / 2} ${sampleBox} ${sampleBox}`}
                              >
                                <path
                                  d={getHexPath(sampleHexR * t.scale)}
                                  fill={MIXED_COLOR}
                                  stroke="none"
                                />
                              </svg>
                              <span
                                style={{
                                  fontSize: 13,
                                  color: "#6B7280",
                                  fontWeight: 600,
                                }}
                              >
                                {t.range}
                              </span>
                            </div>
                          ))}
                        </div>

                        {/* — Markers — */}
                        {subHeader("Markers")}
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 6,
                            marginBottom: 16,
                          }}
                        >
                          {annoRow(
                            sampleHex({
                              text: isHPO ? "0.876" : "82.6",
                              italic: true,
                            }),
                            `Min / Max ${metricLabel} cell`,
                            "fmark-cov",
                          )}
                          {annoRow(
                            sampleHex({ text: "1,500", sub: "trials" }),
                            "Number of trials",
                            "fmark-dens",
                          )}
                          {annoRow(
                            <svg
                              width={sampleBox}
                              height={sampleBox}
                              viewBox={`-${sampleBox / 2} -${sampleBox / 2} ${sampleBox} ${sampleBox}`}
                            >
                              <defs>
                                <clipPath id="legend-fig-area-clip">
                                  <path d={getHexPath(sampleHexR)} />
                                </clipPath>
                                <filter
                                  id="legend-fig-area-blur"
                                  x="-50%"
                                  y="-50%"
                                  width="200%"
                                  height="200%"
                                >
                                  <feGaussianBlur stdDeviation={2.5} />
                                </filter>
                                <mask
                                  id="legend-fig-area-outside"
                                  maskUnits="userSpaceOnUse"
                                  x={-sampleBox / 2}
                                  y={-sampleBox / 2}
                                  width={sampleBox}
                                  height={sampleBox}
                                >
                                  <rect
                                    x={-sampleBox / 2}
                                    y={-sampleBox / 2}
                                    width={sampleBox}
                                    height={sampleBox}
                                    fill="white"
                                  />
                                  <path
                                    d={getHexPath(sampleHexR)}
                                    fill="black"
                                  />
                                </mask>
                              </defs>
                              <path
                                d={getHexPath(sampleHexR)}
                                fill={MIXED_COLOR}
                              />
                              <path
                                d={getHexPath(sampleHexR)}
                                fill="none"
                                stroke="#0F172A"
                                strokeWidth={sampleHexR * 0.45}
                                strokeOpacity={0.4}
                                strokeLinejoin="round"
                                filter="url(#legend-fig-area-blur)"
                                clipPath="url(#legend-fig-area-clip)"
                              />
                              <path
                                d={getHexPath(sampleHexR)}
                                fill="none"
                                stroke="white"
                                strokeWidth={4}
                                strokeOpacity={0.9}
                                strokeLinejoin="round"
                                mask="url(#legend-fig-area-outside)"
                              />
                              <path
                                d={getHexPath(sampleHexR)}
                                fill="none"
                                stroke="#0F172A"
                                strokeWidth={1.8}
                                strokeOpacity={0.85}
                                strokeLinejoin="round"
                              />
                            </svg>,
                            "Area highlight",
                            "fmark-area",
                          )}
                          {/* Region annotation — bordered "Annotation" pill +
                              cubic Bezier leader curve + circular handle. */}
                          {(() => {
                            const annoSvgW = 152;
                            const annoSvgH = 44;
                            const cy = annoSvgH / 2;
                            const labelW = 92;
                            const labelH = 24;
                            const labelX1 = 4;
                            const labelX2 = labelX1 + labelW;
                            const handleX = annoSvgW - 8;
                            const curveD = `M ${labelX2},${cy} C ${labelX2 + 15},${cy - 8} ${handleX - 15},${cy + 8} ${handleX},${cy}`;
                            return (
                              <div
                                key="fmark-region-anno"
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 12,
                                  marginTop: 4,
                                }}
                              >
                                <div
                                  style={{
                                    width: annoSvgW,
                                    flexShrink: 0,
                                    display: "flex",
                                    justifyContent: "center",
                                    overflow: "visible",
                                  }}
                                >
                                  <svg
                                    width={annoSvgW}
                                    height={annoSvgH}
                                    style={{ overflow: "visible" }}
                                  >
                                    <path
                                      d={curveD}
                                      fill="none"
                                      stroke="white"
                                      strokeWidth={2.7}
                                      strokeLinecap="round"
                                      opacity={0.85}
                                    />
                                    <path
                                      d={curveD}
                                      fill="none"
                                      stroke="#0F172A"
                                      strokeWidth={1.2}
                                      strokeLinecap="round"
                                    />
                                    <rect
                                      x={labelX1}
                                      y={cy - labelH / 2}
                                      width={labelW}
                                      height={labelH}
                                      rx={labelH / 2}
                                      ry={labelH / 2}
                                      fill="white"
                                      stroke="#0F172A"
                                      strokeWidth={1.8}
                                    />
                                    <text
                                      x={labelX1 + labelW / 2}
                                      y={cy + 0.5}
                                      textAnchor="middle"
                                      dominantBaseline="central"
                                      fontSize={12}
                                      fontWeight={700}
                                      fill="#0F172A"
                                    >
                                      Annotation
                                    </text>
                                    <circle
                                      cx={handleX}
                                      cy={cy}
                                      r={3.5}
                                      fill="#475569"
                                      stroke="white"
                                      strokeWidth={1.4}
                                    />
                                  </svg>
                                </div>
                                <span
                                  style={{ fontSize: 16, color: "#475569" }}
                                >
                                  Region annotation
                                </span>
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    );
                  })()}

                {/* Cell-size legend — fixed trial-count buckets drive the hex scale.
                Hidden in figure-capture mode (covered by the big legend) and
                in all consolidated-legend modes (tuner-perf / tuner-param /
                complementary fold this into their card). */}
                {effectiveColorMode !== "tuner-perf" &&
                  effectiveColorMode !== "tuner-param" &&
                  effectiveColorMode !== "complementary" &&
                  cellSizeTier.tierMap.size > 0 &&
                  (() => {
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

                {/* Parameter bin legend + Annotations legend (param-mode) folded
                into the consolidated tuner-param legend block above. */}

                {/* Complementary Annotations card folded into the consolidated
                complementary legend above. */}
              </>
            )}
          </div>

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
            paramBin={
              hoveredClusterId !== null && paramCellBins
                ? (paramCellBins.bins.get(hoveredClusterId) ?? null)
                : null
            }
            t3Scores={t3Scores}
            isCartMember={
              hoveredClusterId !== null && cartIds.has(hoveredClusterId)
            }
            metricLabel={metricLabel}
            formatMetric={fmtMetric}
          />
        </div>
      </div>
    </div>
  );
}

export default HexMap;
