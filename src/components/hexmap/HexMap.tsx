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
} from "../../utils/hexMapUtils";
import type { HexMapData, HexTile, TunerType, Cluster } from "./types";
import type {
  ColorMode,
  HexMapProps,
} from "./types";
import {
  HEX_SIZE_DEFAULT,
  MIXED_COLOR,
} from "./types";
import {
  mixHexColors,
  getParamType,
} from "./colorUtils";
import { ControlsBar } from "./ControlsBar";
import { HexTooltip } from "./HexTooltip";


// ============================================================
// Component
// ============================================================

export function HexMap({
  program = "gawk",
  onClusterSelect,
  selectedParam: selectedParamProp = null,
  onParamSelect,
  selectedTuners: selectedTunersProp,
  cartIds: cartIdsProp,
  onCartToggle,
  onCartDataUpdate,
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
  const [coverageMetric, setCoverageMetric] = useState<"mean" | "min" | "max" | "marginal" | "cumulative">("mean");
  // hover: drives tooltip
  const [hoveredClusterId, setHoveredClusterId] = useState<number | null>(null);
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
  // Fixed detail level (L2 = k=50)
  const detailLevel = 2;

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
      if (mode === "tuner-param" && !selectedParam && paramImportanceList.length > 0) {
        onParamSelectRef.current(paramImportanceList[0].name);
      } else if (mode !== "tuner-param") {
        // Clear param selection when leaving tuner-param mode
        onParamSelectRef.current(null);
      }
      setColorMode(mode);
    },
    [selectedParam, paramImportanceList],
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

    const PAD = 16;
    const scaleX = (svgWidth - PAD * 2) / dataWidth;
    const scaleY = (height - PAD * 2) / dataHeight;
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
  const innerHexPath = useMemo(() => getHexPath(HEX_SIZE * 0.45), [HEX_SIZE]);

  // Reset hover when detail level changes
  useEffect(() => {
    setHoveredClusterId(null);
  }, [effectiveDetailLevel]);





  // Extract coverage value from cluster based on selected metric
  const totalUniqueBranches = data?.totalUniqueBranches ?? 0;

  const getClusterCov = useCallback(
    (c: Cluster): number => {
      // Filter trials by selected tuners
      const trials = c.trials.filter((t) => selectedTuners.has(t.tuner));
      if (trials.length === 0) return 0;

      if (coverageMetric === "max") return Math.max(...trials.map((t) => t.coverage));
      if (coverageMetric === "min") return Math.min(...trials.map((t) => t.coverage));
      if (coverageMetric === "mean") return trials.reduce((s, t) => s + t.coverage, 0) / trials.length;
      if (coverageMetric === "marginal") return trials.reduce((s, t) => s + t.marginalCoverage, 0) / trials.length;
      if (coverageMetric === "cumulative") {
        // Union of branches from selected tuners' trials
        // Per-trial coveredBranches may be stripped in precomputed data; fall back to cluster-level
        const hasTrialBranches = trials.some((t) => t.coveredBranches && t.coveredBranches.length > 0);
        if (hasTrialBranches) {
          const branchSet = new Set<number>();
          for (const t of trials) {
            for (const b of (t.coveredBranches ?? [])) branchSet.add(b);
          }
          return totalUniqueBranches > 0 ? branchSet.size / totalUniqueBranches : 0;
        }
        // Fallback: use cluster-level coveredBranches (not filtered by tuner)
        return totalUniqueBranches > 0 ? c.coveredBranches.length / totalUniqueBranches : 0;
      }
      return trials.reduce((s, t) => s + t.coverage, 0) / trials.length;
    },
    [coverageMetric, totalUniqueBranches, selectedTuners],
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
    const clusters = data.clusters.filter((c) => cartIds.has(c.id));
    const unionBranches = new Set<number>();
    for (const c of clusters) {
      const branches = getFilteredBranches(c);
      for (const b of branches) unionBranches.add(b);
    }
    const tub = data.totalUniqueBranches;
    onCartDataUpdateRef.current?.({
      clusters,
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
  }, [selectedParam, getParamType]);

  // ── Per-cluster param bin (boolean / categorical) ──
  // Generic string bin + dynamic color palette
  // MIXED_COLOR imported from types
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
      // Collect all trial-level raw values to get true global range
      const allTrialVals: number[] = [];
      const clusterTrialVals = new Map<number, number[]>();
      for (const c of data.clusters) {
        const vals: number[] = [];
        for (const t of c.trials) {
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
      const gP33 = allTrialVals[Math.floor(allTrialVals.length / 3)];
      const gP66 = allTrialVals[Math.floor((allTrialVals.length * 2) / 3)];

      const fmt = (v: number) =>
        Math.abs(v) >= 1000 ? v.toFixed(0) : v < 0.01 ? v.toFixed(3) : v < 1 ? v.toFixed(2) : v.toFixed(1);
      const lowLabel = `Low [${fmt(globalMin)}–${fmt(gP33)}]`;
      const midLabel = `Mid (${fmt(gP33)}–${fmt(gP66)}]`;
      const highLabel = `High (${fmt(gP66)}–${fmt(globalMax)}]`;

      for (const c of data.clusters) {
        const vals = clusterTrialVals.get(c.id) ?? [];

        // Compute IQR from actual trial values
        if (vals.length >= 4) {
          const q1 = vals[Math.floor(vals.length * 0.25)];
          const q3 = vals[Math.floor(vals.length * 0.75)];
          const iqr = q3 - q1;
          if (iqr / globalRange > 0.5) {
            bins.set(c.id, "Mixed");
            continue;
          }
        }

        // Use median of trial values for binning (more robust than centroid)
        const median = vals[Math.floor(vals.length / 2)] ?? 0;
        if (median <= gP33) bins.set(c.id, lowLabel);
        else if (median <= gP66) bins.set(c.id, midLabel);
        else bins.set(c.id, highLabel);
      }
      return {
        bins,
        binNames: [lowLabel, midLabel, highLabel, "Mixed"],
        binColors: {
          [lowLabel]: "#BFDBFE", // light blue
          [midLabel]: "#3B82F6", // medium blue
          [highLabel]: "#1E3A8A", // dark blue
          Mixed: MIXED_COLOR,
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

      // When a param is selected, tint by bin (except tuner-param mode handles it in inner hex)
      if (paramCellBins && effectiveColorMode !== "tuner-param") {
        const bin = paramCellBins.bins.get(tile.cluster.id);
        if (bin) {
          const binColor = paramCellBins.binColors[bin] ?? MIXED_COLOR;
          return mixHexColors("#F8FAFC", binColor, 0.35);
        }
        return "#F1F5F9";
      }

      switch (effectiveColorMode) {
        case "tuner-perf":
        case "tuner-param": {
          // Outer = muted dominant tuner color (by trial count)
          const filteredCounts = Object.fromEntries(
            TUNER_NAMES.filter((t) => selectedTuners.has(t)).map((t) => [
              t,
              tile.cluster!.tunerCounts[t],
            ]),
          ) as Record<TunerType, number>;
          const dominant = getDominantTuner(filteredCounts);
          return d3.interpolateRgb(TUNER_COLORS[dominant], "#FFFFFF")(0.55);
        }

        case "complementary": {
          if (!t3Scores) return "#F1F5F9"; // empty working set
          if (cartIds.has(tile.cluster.id)) return "#6366F1";
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
      selectedTuners,
      paramCellBins,
      t3Scores,
      cartIds,
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
  const handleMouseEnter = useCallback(
    (tile: HexTile, e: React.MouseEvent) => {
      if (!tile.cluster) return;
      setHoveredClusterId(tile.cluster.id);
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
      />
      <div
        ref={containerRef}
        style={{ flex: 1, position: "relative", minHeight: 0, overflow: "hidden" }}
      >
      <div
        style={{
          position: "relative",
          display: "flex",
          justifyContent: "space-between",
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
          {/* ===== HEX GRID ===== */}
          <g
            style={{
              transform: `translate(${centerX}px, ${centerY}px) scale(${scale}) translate(${-dataCenter.x}px, ${-dataCenter.y}px)`,
            }}
          >
            {/* ── Hex tiles: no hover-sensitive props so hover doesn't re-render all tiles ── */}
            {data.hexTiles.map((tile) => {
              if (!tile.cluster) return null;

              const hasSelectedTuner = TUNER_NAMES.some(
                (t) =>
                  selectedTuners.has(t) && tile.cluster!.tunerCounts[t] > 0,
              );
              if (!hasSelectedTuner) return null;

              const fill = getHexFill(tile);
              const isHovered = hoveredClusterId === tile.cluster.id;

              // T1/T2 modes: inner hex
              let innerTunerColor: string | null = null;
              if (effectiveColorMode === "tuner-perf") {
                innerTunerColor = getCoverageColor(getClusterCov(tile.cluster!));
              } else if (effectiveColorMode === "tuner-param" && paramCellBins) {
                const bin = paramCellBins.bins.get(tile.cluster!.id);
                innerTunerColor = bin ? (paramCellBins.binColors[bin] ?? MIXED_COLOR) : "#E2E8F0";
              }

              return (
                <g
                  key={`${tile.q},${tile.r}`}
                  transform={`translate(${tile.x}, ${tile.y})`}
                  onMouseEnter={(e) => handleMouseEnter(tile, e)}
                  onMouseMove={handleMouseMove}
                  onMouseLeave={handleMouseLeave}
                  onClick={(e) => {
                    e.stopPropagation();
                    // Shift+click: toggle cart
                    if (e.shiftKey) {
                      onCartToggle?.(tile.cluster!.id);
                      return;
                    }
                    // Normal click: notify parent of selected cluster
                    onClusterSelect?.({
                      cluster: tile.cluster!,
                      totalUniqueBranches,
                      selectedTuners,
                    });
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <path
                    d={hexPath}
                    fill={fill || "#F8FAFC"}
                    stroke={
                      isHovered ? "#1E293B"
                        : (effectiveColorMode === "complementary" && tile.cluster && t3TopIds.has(tile.cluster.id))
                          ? "#059669"
                          : "#E2E8F0"
                    }
                    strokeWidth={
                      isHovered ? 2.5
                        : (effectiveColorMode === "complementary" && tile.cluster && t3TopIds.has(tile.cluster.id))
                          ? 2
                          : 0.5
                    }
                    filter={isHovered ? "brightness(1.15)" : undefined}
                  />
                  {innerTunerColor && (
                    <path
                      d={innerHexPath}
                      fill={innerTunerColor}
                      stroke="none"
                      pointerEvents="none"
                    />
                  )}
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
                  {/* Hover cart button: + or − */}
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
                fontSize: 13,
                fontWeight: 500,
                color: "#475569",
                textAlign: "center",
                maxWidth: 360,
              }}
            >
              Add at least one cell to the working set to see complementary candidates.
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>
                Shift+click a cell to add it.
              </div>
            </div>
          </div>
        )}

        {/* In-map legend (top-left) */}
        {(effectiveColorMode === "tuner-perf" ||
          (selectedParam && paramCellBins)) && (
          <div
            style={{
              position: "absolute",
              top: 10,
              left: 10,
              zIndex: 10,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              pointerEvents: "none",
            }}
          >
            {/* Coverage legend */}
            {effectiveColorMode === "tuner-perf" && (() => {
              const barW = 140;
              const gMin = globalCovRange.min;
              const gMax = globalCovRange.max;
              const gMean = globalCovRange.mean;
              const range = gMax - gMin || 1;
              const meanPct = ((gMean - gMin) / range) * 100;
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
                  <div style={{ fontSize: 9, fontWeight: 700, color: "#374151", marginBottom: 4 }}>
                    Coverage ({coverageMetric})
                  </div>
                  <div style={{ position: "relative", width: barW, height: 10, marginBottom: 2 }}>
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
                  <div style={{ position: "relative", width: barW, height: 8 }}>
                    <div
                      style={{
                        width: "100%",
                        height: "100%",
                        borderRadius: 4,
                        background:
                          "linear-gradient(to right, rgb(255,255,229), rgb(254,225,141), rgb(251,153,44), rgb(201,78,5), rgb(102,37,6))",
                        border: "1px solid #E5E7EB",
                      }}
                    />
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
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      width: barW,
                      fontSize: 7,
                      color: "#6B7280",
                      fontWeight: 600,
                      marginTop: 2,
                    }}
                  >
                    <span>{gMin.toFixed(3)}</span>
                    <span>{gMax.toFixed(3)}</span>
                  </div>
                </div>
              );
            })()}

            {/* Parameter bin legend */}
            {selectedParam && paramCellBins && (
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
                <div style={{ fontSize: 9, fontWeight: 700, color: "#374151", marginBottom: 3 }}>
                  {selectedParam} ({selectedParamType})
                </div>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "2px 8px",
                    alignItems: "center",
                  }}
                >
                  {paramCellBins.binNames.map((bin) => (
                    <div
                      key={bin}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <div
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 2,
                          backgroundColor: paramCellBins.binColors[bin] ?? MIXED_COLOR,
                          opacity: 0.7,
                          flexShrink: 0,
                        }}
                      />
                      <span
                        style={{
                          fontSize: 9,
                          fontWeight: 600,
                          color: paramCellBins.binColors[bin] ?? MIXED_COLOR,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {bin}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
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
