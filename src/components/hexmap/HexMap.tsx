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
import type { HexMapData, HexTile, Territory, TunerType, Cluster } from "./types";
import type {
  ColorMode,
  HexMapProps,
  QualitativeLabel,
  SRMetrics,
  QualRegion,
} from "./types";
import {
  HEX_SIZE_DEFAULT,
  QUAL_LABEL_COLORS,
  QUAL_LABEL_NAMES,
  MIXED_COLOR,
} from "./types";
import {
  mixHexColors,
  getTerritoryColor,
  qualPct,
  computeSRMetrics,
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
  selectedQualLabels: selectedQualLabelsProp,
  onToggleQualLabel,
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

  const [colorMode, setColorMode] = useState<ColorMode>("coverage");
  const [previewColorMode, setPreviewColorMode] = useState<ColorMode | null>(
    null,
  );
  const [coverageMetric, setCoverageMetric] = useState<"mean" | "min" | "max" | "marginal" | "cumulative">("mean");
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
  // territory hover
  const [hoveredTerritoryId, setHoveredTerritoryId] = useState<number | null>(
    null,
  );
  // cluster detail panel — only set from within a focused territory
  const [inspectedClusterId, setInspectedClusterId] = useState<number | null>(
    null,
  );
  // Qualitative label toggles
  const [internalQualLabels, setInternalQualLabels] = useState<
    Set<QualitativeLabel>
  >(new Set(QUAL_LABEL_NAMES));
  const selectedQualLabels = selectedQualLabelsProp ?? internalQualLabels;
  const setSelectedQualLabels = selectedQualLabelsProp
    ? (updater: Set<QualitativeLabel> | ((prev: Set<QualitativeLabel>) => Set<QualitativeLabel>)) => {
        // When controlled externally, use onToggleQualLabel for individual toggles
        // This setter is passed to ControlsBar but won't be used when labels are in sidebar
        void updater;
      }
    : setInternalQualLabels;
  const selectedParam = selectedParamProp;
  const setSelectedParam = onParamSelect ?? (() => {});

  const [internalSelectedTuners] = useState<Set<TunerType>>(
    () => new Set(TUNER_NAMES),
  );
  const selectedTuners = selectedTunersProp ?? internalSelectedTuners;
  // T1 mode: overlay density as opacity on the outer hex
  const [t1ShowDensity, setT1ShowDensity] = useState(false);
  // T1 mode: dominant basis — "density" (trial count) or "coverage" (avg cov)
  const [t1DominantBasis, setT1DominantBasis] = useState<"density" | "coverage">("density");
  // T3 mode: anchor cluster for complementarity
  const [t3AnchorId, setT3AnchorId] = useState<number | null>(null);
  // 4 = finest (current clusters), 3/2/1/0 = progressively coarser merged levels
  const [detailLevel, setDetailLevel] = useState<number>(2);

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

  // Reset T3 anchor when leaving complementary mode
  useEffect(() => {
    if (effectiveColorMode !== "complementary") setT3AnchorId(null);
  }, [effectiveColorMode]);

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

  // Territories are pre-computed in processHexMapData (hexMapUtils.ts)
  // Wrapped in useMemo so the array reference is stable across renders.
  const territories = useMemo<Territory[]>(
    () => data?.territories ?? [],
    [data],
  );

  // Reset focus when detail level changes
  useEffect(() => {
    setFocusedTerritoryId(null);
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

  // ── Qualitative: per-cluster metrics & class (independent of parameter sub-regions) ──
  // Step 1: per-cluster metrics from cluster.trials directly
  const clusterQualMetrics = useMemo((): Map<number, SRMetrics> => {
    if (!data) return new Map();
    const map = new Map<number, SRMetrics>();
    for (const cluster of data.clusters) {
      const filtered = cluster.trials.filter((t) => selectedTuners.has(t.tuner));
      map.set(cluster.id, computeSRMetrics(filtered));
    }
    return map;
  }, [data, selectedTuners]);

  // Step 2: thresholds from all clusters with trialCount >= 2 (program-wide)
  const clusterQualThresholds = useMemo(() => {
    if (!data) return { p80Coverage: 0, p80Marginal: 0, p80TrialCount: 0, p20TrialCount: 0, p80CumCov: 0 };
    const supported = [...clusterQualMetrics.values()].filter(
      (m) => m.trialCount >= 2,
    );
    if (supported.length === 0)
      return { p80Coverage: 0, p80Marginal: 0, p80TrialCount: 0, p20TrialCount: 0, p80CumCov: 0 };
    // Cumulative coverage per cluster: union of selected tuners' trial branches / totalUniqueBranches
    const tub = data.totalUniqueBranches;
    const cumCovs = data.clusters
      .filter((c) => c.trials.some((t) => selectedTuners.has(t.tuner)))
      .map((c) => {
        if (tub <= 0) return 0;
        const filtered = c.trials.filter((t) => selectedTuners.has(t.tuner));
        const hasTrialBranches = filtered.some((t) => t.coveredBranches && t.coveredBranches.length > 0);
        if (hasTrialBranches) {
          const branchSet = new Set<number>();
          for (const t of filtered) {
            for (const b of (t.coveredBranches ?? [])) branchSet.add(b);
          }
          return branchSet.size / tub;
        }
        return c.coveredBranches.length / tub;
      });
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
      p20TrialCount: qualPct(
        supported.map((m) => m.trialCount),
        20,
      ),
      p80CumCov: qualPct(cumCovs, 80),
    };
  }, [clusterQualMetrics, data, selectedTuners]);

  // Step 3: per-cluster qualitative class (null = no label / low support)
  const clusterQualClass = useMemo((): Map<number, QualitativeLabel | null> => {
    const map = new Map<number, QualitativeLabel | null>();
    const tub = data?.totalUniqueBranches ?? 0;
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
        const cluster = data?.clusters.find((c) => c.id === cid);
        let cumCov = 0;
        if (cluster && tub > 0) {
          const filtered = cluster.trials.filter((t) => selectedTuners.has(t.tuner));
          const hasTrialBranches = filtered.some((t) => t.coveredBranches && t.coveredBranches.length > 0);
          if (hasTrialBranches) {
            const branchSet = new Set<number>();
            for (const t of filtered) {
              for (const b of (t.coveredBranches ?? [])) branchSet.add(b);
            }
            cumCov = branchSet.size / tub;
          } else {
            cumCov = cluster.coveredBranches.length / tub;
          }
        }
        if (m.meanMarginalCoverage > clusterQualThresholds.p80Marginal) {
          label = "High Novelty";
        } else if (m.meanCoverage > clusterQualThresholds.p80Coverage) {
          label = "High Avg Cov";
        } else if (cumCov > clusterQualThresholds.p80CumCov) {
          label = "High Cum Cov";
        } else if (m.trialCount > clusterQualThresholds.p80TrialCount) {
          label = "High Density";
        } else if (m.trialCount <= clusterQualThresholds.p20TrialCount) {
          label = "Low Density";
        }
      }
      map.set(cid, label);
    }
    return map;
  }, [clusterQualMetrics, clusterQualThresholds, data, selectedTuners]);

  // Metrics for the focused territory + its sub-regions
  // Density color scale: maps selected-tuner trial count → color
  const { densityScale, densityMax } = useMemo(() => {
    if (!data) return { densityScale: null, densityMax: 0 };
    const trials = data.clusters.map((c) =>
      TUNER_NAMES.filter((t) => selectedTuners.has(t)).reduce(
        (sum, t) => sum + c.tunerCounts[t],
        0,
      ),
    );
    const maxTrials = d3.max(trials) ?? 1;
    return {
      densityScale: d3.scaleSequential(d3.interpolateYlOrRd).domain([0, maxTrials]),
      densityMax: maxTrials,
    };
  }, [data, selectedTuners]);

  // Extract coverage value from cluster based on selected metric
  const totalUniqueBranches = data?.totalUniqueBranches ?? 0;

  // Notify parent when selected cluster changes
  useEffect(() => {
    onClusterSelect?.(
      inspectedCluster
        ? { cluster: inspectedCluster, totalUniqueBranches, selectedTuners }
        : null,
    );
  }, [inspectedCluster, totalUniqueBranches, selectedTuners, onClusterSelect]);

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

  // T1 mode: max trial count for selected tuners (for density opacity)
  const t1DensityMax = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, d3.max(data.clusters.map((c) =>
      TUNER_NAMES.filter((t) => selectedTuners.has(t))
        .reduce((sum, t) => sum + c.tunerCounts[t], 0),
    )) ?? 1);
  }, [data, selectedTuners]);

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

  // T3: complementarity scores — how many new branches each cluster adds on top of anchor
  const t3Scores = useMemo(() => {
    if (!data || t3AnchorId === null) return null;
    const anchor = data.clusters.find((c) => c.id === t3AnchorId);
    if (!anchor) return null;
    const anchorSet = getFilteredBranches(anchor);
    const scores = new Map<number, number>();
    let maxScore = 0;
    for (const c of data.clusters) {
      if (c.id === t3AnchorId) { scores.set(c.id, 0); continue; }
      const cBranches = getFilteredBranches(c);
      let newCount = 0;
      for (const b of cBranches) {
        if (!anchorSet.has(b)) newCount++;
      }
      scores.set(c.id, newCount);
      if (newCount > maxScore) maxScore = newCount;
    }
    return { scores, maxScore, anchorBranchCount: anchorSet.size };
  }, [data, t3AnchorId, getFilteredBranches]);

  // T3: top-5 most complementary cluster IDs (for border highlight)
  const t3TopIds = useMemo(() => {
    if (!t3Scores) return new Set<number>();
    const sorted = [...t3Scores.scores.entries()]
      .filter(([id]) => id !== t3AnchorId)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id]) => id);
    return new Set(sorted);
  }, [t3Scores, t3AnchorId]);

  const positiveMarginalCoverages = useMemo(() => {
    if (!data) return [];
    return data.clusters
      .map((c) => c.avgCoverage)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
  }, [data]);


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

      const { tunerCounts } = tile.cluster;

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

        case "tuner-perf":
        case "tuner-param": {
          // Outer = muted dominant tuner color (by density or coverage)
          let dominant: TunerType;
          if (t1DominantBasis === "coverage") {
            let bestTuner: TunerType | null = null;
            let bestCov = -1;
            const tub = totalUniqueBranches;
            for (const t of TUNER_NAMES) {
              if (!selectedTuners.has(t)) continue;
              const trials = tile.cluster.trials.filter((tr) => tr.tuner === t);
              if (trials.length === 0) continue;
              const hasBranches = trials.some((tr) => tr.coveredBranches && tr.coveredBranches.length > 0);
              let cumCov: number;
              if (hasBranches && tub > 0) {
                const branchSet = new Set<number>();
                for (const tr of trials) for (const b of (tr.coveredBranches ?? [])) branchSet.add(b);
                cumCov = branchSet.size / tub;
              } else {
                cumCov = trials.reduce((s, tr) => s + tr.coverage, 0) / trials.length;
              }
              if (cumCov > bestCov) { bestCov = cumCov; bestTuner = t; }
            }
            dominant = bestTuner ?? TUNER_NAMES[0];
          } else {
            const filteredCounts = Object.fromEntries(
              TUNER_NAMES.filter((t) => selectedTuners.has(t)).map((t) => [
                t,
                tile.cluster.tunerCounts[t],
              ]),
            ) as Record<TunerType, number>;
            dominant = getDominantTuner(filteredCounts);
          }
          return d3.interpolateRgb(TUNER_COLORS[dominant], "#FFFFFF")(0.55);
        }

        case "complementary": {
          if (!t3Scores) return "#F1F5F9"; // no anchor selected yet
          if (tile.cluster.id === t3AnchorId) return "#4F46E5"; // anchor = indigo
          const score = t3Scores.scores.get(tile.cluster.id) ?? 0;
          const maxS = t3Scores.maxScore || 1;
          const t = Math.max(0, Math.min(1, score / maxS));
          // low complement = light grey, high complement = vivid green
          return d3.interpolateRgb("#F1F5F9", "#10B981")(t);
        }

        default:
          return "#F8FAFC";
      }
    },
    [
      effectiveColorMode,
      densityScale,
      getCoverageColor,
      getClusterCov,
      selectedTuners,
      paramCellBins,
      compareCovDiff,
      getCompareColor,
      t1DominantBasis,
      totalUniqueBranches,
      t3Scores,
      t3AnchorId,
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

  // Territory boundary data: outer edge of each territory
  const boundaryData = useMemo(() => {
    if (!data || territories.length === 0) {
      return { macro: [] as { d: string; terr: Territory }[] };
    }

    const hexToTerr = new Map<string, number>();
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
    }

    const verts = Array.from({ length: 6 }, (_, i) => ({
      x: HEX_SIZE * Math.cos((i * Math.PI) / 3),
      y: HEX_SIZE * Math.sin((i * Math.PI) / 3),
    }));

    const macroPathMap = new Map<number, string>();
    for (const terr of territories) {
      let macroD = "";
      for (const tile of terr.tiles) {
        const tk = `${tile.q},${tile.r}`;
        if (!visibleHex.has(tk)) continue;
        for (let ei = 0; ei < 6; ei++) {
          const dir = HEX_DIRECTIONS[ei];
          const nk = `${tile.q + dir.dq},${tile.r + dir.dr}`;
          const nTerr = hexToTerr.get(nk);
          const neighborVisible = visibleHex.has(nk);
          if (!neighborVisible || nTerr !== terr.id) {
            const va = verts[ei];
            const vb = verts[(ei + 1) % 6];
            macroD += `M${tile.x + va.x},${tile.y + va.y}L${tile.x + vb.x},${tile.y + vb.y}`;
          }
        }
      }
      macroPathMap.set(terr.id, macroD);
    }

    return {
      macro: territories.map((t) => ({
        d: macroPathMap.get(t.id) ?? "",
        terr: t,
      })),
    };
  }, [data, territories, HEX_DIRECTIONS, selectedTuners]);

  // ============================================================
  // Label placement helpers
  // ============================================================

  const renderScale = scale;
  const renderCenter = dataCenter;

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
    const tub = data?.totalUniqueBranches ?? 0;
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
      "High Avg Cov",
      () => true,
      (v) => v.m.meanCoverage,
    );
    pickBest(
      "High Cum Cov",
      () => true,
      (v) => {
        const cluster = data?.clusters.find((c) => c.id === v.cid);
        return cluster && tub > 0 ? cluster.coveredBranches.length / tub : 0;
      },
    );
    pickBest(
      "High Density",
      () => true,
      (v) => v.m.trialCount,
    );
    pickBest(
      "Low Density",
      (v) => v.m.trialCount >= 2,
      (v) => -v.m.trialCount,
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
    setHoveredTerritoryId(null);
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
        previewColorMode={previewColorMode}
        setPreviewColorMode={setPreviewColorMode}
        effectiveColorMode={effectiveColorMode}
        coverageMetric={coverageMetric}
        setCoverageMetric={setCoverageMetric}
        globalCovRange={globalCovRange}
        compareTunerA={compareTunerA}
        setCompareTunerA={setCompareTunerA}
        compareTunerB={compareTunerB}
        setCompareTunerB={setCompareTunerB}
        compareDiffMax={compareDiffMax}
        densityMax={densityMax}
        selectedParam={selectedParam}
        onParamSelect={setSelectedParam}
        paramList={paramImportanceList}
        t1ShowDensity={t1ShowDensity}
        setT1ShowDensity={setT1ShowDensity}
        t1DominantBasis={t1DominantBasis}
        setT1DominantBasis={setT1DominantBasis}
        t3Scores={t3Scores}
        t3AnchorId={t3AnchorId}
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
                } else {
                  setFocusedTerritoryId(null);
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

              const fill = getHexFill(tile);
              const isInspected = inspectedClusterId === tile.cluster.id;
              const isHovered = hoveredClusterId === tile.cluster.id;

              // T1/T2 modes: inner hex + optional density opacity
              let innerTunerColor: string | null = null;
              let t1Opacity: number | null = null;
              if (effectiveColorMode === "tuner-perf") {
                innerTunerColor = getCoverageColor(getClusterCov(tile.cluster!));
                if (t1ShowDensity) {
                  const count = TUNER_NAMES.filter((t) => selectedTuners.has(t))
                    .reduce((sum, t) => sum + (tile.cluster!.tunerCounts[t] ?? 0), 0);
                  t1Opacity = count > 0 ? 0.2 + 0.8 * (count / t1DensityMax) : 0.08;
                }
              } else if (effectiveColorMode === "tuner-param" && paramCellBins) {
                const bin = paramCellBins.bins.get(tile.cluster!.id);
                innerTunerColor = bin ? (paramCellBins.binColors[bin] ?? MIXED_COLOR) : "#E2E8F0";
                if (t1ShowDensity) {
                  const count = TUNER_NAMES.filter((t) => selectedTuners.has(t))
                    .reduce((sum, t) => sum + (tile.cluster!.tunerCounts[t] ?? 0), 0);
                  t1Opacity = count > 0 ? 0.2 + 0.8 * (count / t1DensityMax) : 0.08;
                }
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
                    if (effectiveColorMode === "complementary") {
                      setT3AnchorId((prev) => prev === tile.cluster!.id ? null : tile.cluster!.id);
                    }
                    const tId = clusterToTerrId.get(tile.cluster!.id) ?? null;
                    setFocusedTerritoryId(tId);
                    setInspectedClusterId(tile.cluster!.id);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <path
                    d={hexPath}
                    fill={fill || "#F8FAFC"}
                    stroke={
                      isInspected ? "#4F46E5"
                        : isHovered ? "#1E293B"
                        : (effectiveColorMode === "complementary" && tile.cluster && t3TopIds.has(tile.cluster.id))
                          ? "#059669"
                          : "#E2E8F0"
                    }
                    strokeWidth={
                      isInspected ? 3
                        : isHovered ? 2.5
                        : (effectiveColorMode === "complementary" && tile.cluster && t3TopIds.has(tile.cluster.id))
                          ? 2
                          : 0.5
                    }
                    filter={isHovered && !isInspected ? "brightness(1.15)" : undefined}
                    opacity={t1Opacity !== null ? t1Opacity : undefined}
                  />
                  {innerTunerColor && (
                    <path
                      d={innerHexPath}
                      fill={innerTunerColor}
                      stroke="none"
                      pointerEvents="none"
                    />
                  )}
                </g>
              );
            })}



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

        {/* In-map legend (top-left) */}
        {(effectiveColorMode === "tuner-perf" || effectiveColorMode === "coverage" ||
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
            {(effectiveColorMode === "tuner-perf" || effectiveColorMode === "coverage") && (() => {
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
          t3AnchorId={t3AnchorId}
        />
      </div>
      </div>
    </div>
  );
}

export default HexMap;
