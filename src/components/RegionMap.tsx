/**
 * RegionMap – Search Space Occupancy Map
 *
 * Two-layer architecture:
 *   semantic region  (30) – parameter-similarity cluster, sidebar item
 *   spatial island   (many) – connected hex component within a region
 *
 * Border types:
 *   solid  = different region
 *   dashed = same region, different island  (shows fragmentation)
 *
 * Color modes:
 *   Tuner      – dominant-tuner hue, saturation ∝ dominance
 *   Sharedness – heat: red (single-tuner) → teal (shared exploration)
 */

import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
} from "react";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

type ClusterMethod = "param" | "param_cov";
type ColorMode = "tuner" | "sharedness";
type SortKey = "trials" | "sharedness" | "diversity";
type Program = "gawk" | "gcal" | "grep";

interface RegionNode {
  idx: number;
  q: number;
  r: number;
  trialCount: number;
  tunerCounts: Record<string, number>;
  meanCoverage: number;
  maxCoverage: number;
  dominantTuner: string | null;
  regionId_param: number;
  islandId_param: number;
  regionId_param_cov: number;
  islandId_param_cov: number;
}

interface RegionIsland {
  id: number;
  nodeCount: number;
  trialCount: number;
  tunerCounts: Record<string, number>;
  dominantTuner: string | null;
  tunerDiversity: number;
  sharedScore: number;
  interpretationTag: string;
  meanCoverage: number;
  maxCoverage: number;
  qCentroid: number;
  rCentroid: number;
}

interface Region {
  id: number;
  method: string;
  nodeIds: number[];
  label: string;
  signature: Record<string, string | boolean>;
  sharedScore: number;
  interpretationTag: string;
  trialCount: number;
  tunerCounts: Record<string, number>;
  dominantTuner: string | null;
  dominanceRatio: number;
  tunerDiversity: number;
  meanCoverage: number;
  maxCoverage: number;
  islands: RegionIsland[];
}

interface RegionMapData {
  program: string;
  totalTrials: number;
  nParams: number;
  globalMeanCoverage: number;
  nodes: RegionNode[];
  regions_param: Region[];
  regions_param_cov: Region[];
}

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const TUNER_COLORS: Record<string, string> = {
  SymTuner: "#4f46e5",
  CMA_ES: "#10b981",
  Genetic: "#f59e0b",
  SuccessiveHalving: "#ef4444",
};

const TUNER_LABELS: Record<string, string> = {
  SymTuner: "SymTuner",
  CMA_ES: "CMA-ES",
  Genetic: "Genetic",
  SuccessiveHalving: "Succ. Halving",
};

const HEX_SIZE = 10;

const HEX_DIRS: [number, number][] = [
  [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1],
];

// ─────────────────────────────────────────────────────────────
// Color helpers
// ─────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0"))
      .join("")
  );
}

function mixColors(hex1: string, hex2: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(hex1);
  const [r2, g2, b2] = hexToRgb(hex2);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

/** Dominant-tuner color mixed with grey based on diversity */
function tunerColor(hex: string, diversity: number): string {
  return mixColors(hex, "#a0a8b8", Math.min(1, diversity * 0.65));
}

/** Sharedness heat: 0 → warm red, 0.5 → yellow, 1 → teal */
function sharedColor(score: number): string {
  if (score < 0.25) return mixColors("#e53e3e", "#dd6b20", score / 0.25);
  if (score < 0.5) return mixColors("#dd6b20", "#d69e2e", (score - 0.25) / 0.25);
  return mixColors("#d69e2e", "#0d9488", (score - 0.5) / 0.5);
}

// ─────────────────────────────────────────────────────────────
// Hex geometry
// ─────────────────────────────────────────────────────────────

function hexToPixel(q: number, r: number, size: number): [number, number] {
  return [size * 1.5 * q, size * (Math.sqrt(3) / 2) * q + size * Math.sqrt(3) * r];
}

function hexVertex(size: number, i: number): [number, number] {
  const a = (Math.PI / 3) * i;
  return [size * Math.cos(a), size * Math.sin(a)];
}

function buildHexPath(size: number): string {
  return Array.from({ length: 6 }, (_, i) => {
    const [x, y] = hexVertex(size, i);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  })
    .map((p, i) => (i === 0 ? `M${p}` : `L${p}`))
    .join("") + "Z";
}

// ─────────────────────────────────────────────────────────────
// Interpretation tag badge
// ─────────────────────────────────────────────────────────────

const TAG_PALETTE: Record<string, [string, string]> = {
  Shared:      ["#0891b2", "#e0f2fe"],   // cyan [text, bg]
  "High cov":  ["#15803d", "#dcfce7"],
  "Low cov":   ["#b91c1c", "#fee2e2"],
};

function tagStyle(tag: string): [string, string] {
  for (const [key, colors] of Object.entries(TAG_PALETTE)) {
    if (tag.startsWith(key)) return colors;
  }
  // Tuner-based tag → use dominant tuner color lightened
  for (const [tuner, color] of Object.entries(TUNER_COLORS)) {
    const short = tuner.slice(0, 3);
    if (tag.includes(short)) return [color, color + "22"];
  }
  return ["#475569", "#f1f5f9"];
}

// ─────────────────────────────────────────────────────────────
// Tooltip
// ─────────────────────────────────────────────────────────────

interface TooltipProps {
  x: number;
  y: number;
  node: RegionNode;
  region: Region;
  island: RegionIsland | undefined;
  globalMeanCoverage: number;
}

const Tooltip: React.FC<TooltipProps> = ({ x, y, node, region, island, globalMeanCoverage }) => {
  const covDelta = node.meanCoverage - globalMeanCoverage;
  const covColor = covDelta > 50 ? "#15803d" : covDelta < -50 ? "#b91c1c" : "#64748b";
  const [tagText, tagBg] = tagStyle(region.interpretationTag);

  return (
    <div
      className="pointer-events-none absolute z-30 bg-white border border-gray-200 rounded-xl shadow-xl p-3 text-xs w-60"
      style={{ left: x + 12, top: y - 10 }}
    >
      {/* Region header */}
      <div className="flex items-start gap-1.5 mb-1.5">
        {region.dominantTuner && (
          <div
            className="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-0.5"
            style={{ background: TUNER_COLORS[region.dominantTuner] }}
          />
        )}
        <div>
          <div className="font-semibold text-gray-800 leading-tight">{region.label}</div>
          <span
            className="text-[9px] font-medium px-1.5 py-0.5 rounded-full mt-0.5 inline-block"
            style={{ color: tagText, background: tagBg }}
          >
            {region.interpretationTag}
          </span>
        </div>
      </div>

      {/* Node coverage */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-gray-600 mb-2">
        <span>Node trials:</span>
        <span className="text-gray-900 font-medium">{node.trialCount.toLocaleString()}</span>
        <span>Node coverage:</span>
        <span style={{ color: covColor }} className="font-medium">{node.meanCoverage.toFixed(0)}</span>
      </div>

      {/* Island info */}
      {island && (
        <div className="border-t border-gray-100 pt-1.5 mb-1.5">
          <div className="text-[9px] text-gray-400 uppercase font-semibold mb-1">
            Island ({island.nodeCount} nodes · {island.trialCount.toLocaleString()} trials)
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-gray-600">
            <span>Shared score:</span>
            <span className="font-medium" style={{ color: island.sharedScore > 0.4 ? "#0891b2" : "#94a3b8" }}>
              {(island.sharedScore * 100).toFixed(0)}%
            </span>
            <span>Mean cov:</span>
            <span className="text-gray-900">{island.meanCoverage.toFixed(0)}</span>
          </div>
        </div>
      )}

      {/* Region tuner breakdown */}
      <div className="border-t border-gray-100 pt-1.5">
        <div className="text-[9px] text-gray-400 uppercase font-semibold mb-1">Region</div>
        <div className="space-y-0.5">
          {Object.entries(region.tunerCounts)
            .filter(([, c]) => c > 0)
            .sort(([, a], [, b]) => b - a)
            .map(([tuner, cnt]) => {
              const pct = region.trialCount > 0 ? (cnt / region.trialCount) * 100 : 0;
              return (
                <div key={tuner} className="flex items-center gap-1.5">
                  <div
                    className="w-2 h-2 rounded-sm flex-shrink-0"
                    style={{ background: TUNER_COLORS[tuner] || "#94a3b8" }}
                  />
                  <span className="flex-1 text-gray-600">{TUNER_LABELS[tuner] ?? tuner}</span>
                  <span className="tabular-nums text-gray-900">{pct.toFixed(0)}%</span>
                </div>
              );
            })}
        </div>
        <div className="flex items-center justify-between mt-1 text-gray-500">
          <span>Shared score:</span>
          <span
            className="font-medium"
            style={{ color: region.sharedScore > 0.4 ? "#0891b2" : "#94a3b8" }}
          >
            {(region.sharedScore * 100).toFixed(0)}%
          </span>
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────

interface RegionMapProps {
  width?: number;
  height?: number;
  program?: Program;
}

export function RegionMap({ width = 1200, height = 780, program = "gawk" }: RegionMapProps) {
  const [data, setData] = useState<RegionMapData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<ClusterMethod>("param");
  const [colorMode, setColorMode] = useState<ColorMode>("tuner");
  const [sortKey, setSortKey] = useState<SortKey>("trials");
  const [hoveredRegionId, setHoveredRegionId] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{
    x: number; y: number; node: RegionNode; region: Region; island: RegionIsland | undefined;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load data
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    fetch(`/data/${program}_region_map.json`)
      .then((r) => { if (!r.ok) throw new Error(`Cannot load ${program}_region_map.json`); return r.json(); })
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [program]);

  const regions = useMemo(
    () => (data ? (method === "param" ? data.regions_param : data.regions_param_cov) : []),
    [data, method]
  );

  const regionById = useMemo(() => {
    const m = new Map<number, Region>();
    regions.forEach((r) => m.set(r.id, r));
    return m;
  }, [regions]);

  // Island lookup: for current method, node.idx → island object from region.islands
  const islandByNodeIdx = useMemo(() => {
    if (!data) return new Map<number, RegionIsland>();
    const m = new Map<number, RegionIsland>();
    const regionList = method === "param" ? data.regions_param : data.regions_param_cov;
    // island.id is global – build island lookup from region data
    const islandMap = new Map<number, RegionIsland>();
    for (const region of regionList) {
      for (const isl of region.islands) islandMap.set(isl.id, isl);
    }
    // Map node → island via islandId
    for (const node of data.nodes) {
      const islandId = method === "param" ? node.islandId_param : node.islandId_param_cov;
      const isl = islandMap.get(islandId);
      if (isl) m.set(node.idx, isl);
    }
    return m;
  }, [data, method]);

  const nodeRegion = useCallback(
    (n: RegionNode) => (method === "param" ? n.regionId_param : n.regionId_param_cov),
    [method]
  );

  const nodeIsland = useCallback(
    (n: RegionNode) => (method === "param" ? n.islandId_param : n.islandId_param_cov),
    [method]
  );

  const hexLookup = useMemo(() => {
    if (!data) return new Map<string, RegionNode>();
    const m = new Map<string, RegionNode>();
    data.nodes.forEach((n) => m.set(`${n.q},${n.r}`, n));
    return m;
  }, [data]);

  const svgWidth = width - 272;
  const svgHeight = height - 8;

  const { offsetX, offsetY, viewScale } = useMemo(() => {
    if (!data?.nodes.length) return { offsetX: 0, offsetY: 0, viewScale: 1 };
    const pixels = data.nodes.map((n) => hexToPixel(n.q, n.r, HEX_SIZE));
    const xs = pixels.map((p) => p[0]);
    const ys = pixels.map((p) => p[1]);
    const pad = HEX_SIZE * 3;
    const [minX, maxX] = [Math.min(...xs) - pad, Math.max(...xs) + pad];
    const [minY, maxY] = [Math.min(...ys) - pad, Math.max(...ys) + pad];
    const s = Math.min(svgWidth / (maxX - minX), svgHeight / (maxY - minY), 2.0);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return { offsetX: svgWidth / 2 - cx * s, offsetY: svgHeight / 2 - cy * s, viewScale: s };
  }, [data, svgWidth, svgHeight]);

  const scaledSize = HEX_SIZE * viewScale;
  const hexPathStr = useMemo(() => buildHexPath(scaledSize * 0.93), [scaledSize]);

  // Node fill color
  const getNodeColor = useCallback(
    (node: RegionNode, region: Region): string => {
      if (colorMode === "sharedness") {
        return sharedColor(region.sharedScore);
      }
      // Tuner mode: dominant tuner color, desaturated by diversity
      const base = node.dominantTuner
        ? TUNER_COLORS[node.dominantTuner] ?? "#94a3b8"
        : "#94a3b8";
      return tunerColor(base, region.tunerDiversity);
    },
    [colorMode]
  );

  // Label positions: use island[0] centroid of each region (largest connected component)
  const regionLabelPositions = useMemo(() => {
    const pos = new Map<number, [number, number]>();
    for (const region of regions) {
      const largestIsland = region.islands[0];
      if (!largestIsland) continue;
      const [px, py] = hexToPixel(largestIsland.qCentroid, largestIsland.rCentroid, HEX_SIZE * viewScale);
      pos.set(region.id, [offsetX + px, offsetY + py]);
    }
    return pos;
  }, [regions, offsetX, offsetY, viewScale]);

  // Per-island label positions for secondary labels (tag only)
  const secondaryIslandPositions = useMemo(() => {
    const list: { region: Region; island: RegionIsland; px: number; py: number }[] = [];
    for (const region of regions) {
      // Secondary islands: index 1-4 that are big enough
      for (let i = 1; i < Math.min(region.islands.length, 4); i++) {
        const isl = region.islands[i];
        if (isl.nodeCount < 5) continue;
        const [px, py] = hexToPixel(isl.qCentroid, isl.rCentroid, HEX_SIZE * viewScale);
        list.push({ region, island: isl, px: offsetX + px, py: offsetY + py });
      }
    }
    return list;
  }, [regions, offsetX, offsetY, viewScale]);

  const labelMinNodes = useMemo(() => {
    if (!data || !regions.length) return 999;
    return Math.max(4, (data.nodes.length / regions.length) * 0.3);
  }, [data, regions]);

  // Sorted regions for sidebar
  const sortedRegions = useMemo(() => {
    return [...regions].sort((a, b) => {
      if (sortKey === "trials") return b.trialCount - a.trialCount;
      if (sortKey === "sharedness") return b.sharedScore - a.sharedScore;
      return b.tunerDiversity - a.tunerDiversity;
    });
  }, [regions, sortKey]);

  // ── Event handlers ─────────────────────────────────────────

  const handleTileEnter = useCallback(
    (e: React.MouseEvent, node: RegionNode) => {
      const rid = nodeRegion(node);
      setHoveredRegionId(rid);
      const region = regionById.get(rid);
      if (!region) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const island = islandByNodeIdx.get(node.idx);
      setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, node, region, island });
    },
    [nodeRegion, regionById, islandByNodeIdx]
  );

  const handleTileLeave = useCallback(() => {
    setHoveredRegionId(null);
    setTooltip(null);
  }, []);

  // ── Render ─────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        <div className="text-center">
          <div className="loading loading-spinner loading-md mb-2" />
          <div>Loading {program} region map…</div>
        </div>
      </div>
    );
  }
  if (error) return <div className="flex items-center justify-center h-full text-red-500 text-sm">{error}</div>;
  if (!data) return null;

  const hoveredRegion = hoveredRegionId !== null ? regionById.get(hoveredRegionId) : null;

  return (
    <div ref={containerRef} className="flex h-full relative overflow-hidden">
      {/* ── SVG ── */}
      <div className="flex-1 relative bg-gray-50 rounded-lg overflow-hidden">

        {/* Controls */}
        <div className="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-2">
          {/* Clustering method */}
          <div className="flex items-center gap-1.5 bg-white/90 backdrop-blur rounded-lg shadow border border-gray-100 px-2.5 py-1.5">
            <span className="text-[10px] font-medium text-gray-500">Clustering:</span>
            {(["param", "param_cov"] as ClusterMethod[]).map((m) => (
              <button
                key={m}
                className={`text-[10px] px-2 py-0.5 rounded-md transition-colors ${
                  method === m ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
                onClick={() => setMethod(m)}
              >
                {m === "param" ? "Param only" : "Param + Cov"}
              </button>
            ))}
          </div>

          {/* Color mode */}
          <div className="flex items-center gap-1.5 bg-white/90 backdrop-blur rounded-lg shadow border border-gray-100 px-2.5 py-1.5">
            <span className="text-[10px] font-medium text-gray-500">Color:</span>
            {(["tuner", "sharedness"] as ColorMode[]).map((m) => (
              <button
                key={m}
                className={`text-[10px] px-2 py-0.5 rounded-md transition-colors ${
                  colorMode === m ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
                onClick={() => setColorMode(m)}
              >
                {m === "tuner" ? "Tuner" : "Sharedness"}
              </button>
            ))}
          </div>

          <span className="text-[10px] text-gray-400 bg-white/70 rounded px-2 py-1">
            {regions.length} regions · {data.nodes.length.toLocaleString()} nodes
          </span>
        </div>

        {/* Legend */}
        <div className="absolute top-3 right-3 z-10 bg-white/90 backdrop-blur rounded-lg shadow border border-gray-100 px-3 py-2">
          {colorMode === "tuner" ? (
            <>
              <div className="text-[10px] font-semibold text-gray-500 uppercase mb-1.5">Dominant Tuner</div>
              {Object.entries(TUNER_COLORS).map(([t, c]) => (
                <div key={t} className="flex items-center gap-1.5 mb-1">
                  <div className="w-3 h-3 rounded-sm" style={{ background: c }} />
                  <span className="text-[10px] text-gray-600">{TUNER_LABELS[t]}</span>
                </div>
              ))}
              <div className="text-[9px] text-gray-400 mt-1">Saturation = dominance</div>
            </>
          ) : (
            <>
              <div className="text-[10px] font-semibold text-gray-500 uppercase mb-1.5">Sharedness</div>
              {[
                ["#e53e3e", "Single-tuner"],
                ["#dd6b20", "Mostly single"],
                ["#d69e2e", "Partial overlap"],
                ["#0d9488", "Shared zone"],
              ].map(([c, lbl]) => (
                <div key={lbl} className="flex items-center gap-1.5 mb-1">
                  <div className="w-3 h-3 rounded-sm" style={{ background: c }} />
                  <span className="text-[10px] text-gray-600">{lbl}</span>
                </div>
              ))}
              <div className="text-[9px] text-gray-400 mt-1">Most regions = single-tuner</div>
            </>
          )}

          {/* Border legend */}
          <div className="mt-1.5 pt-1.5 border-t border-gray-100">
            <div className="flex items-center gap-1.5 mb-0.5">
              <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" stroke="#333" strokeWidth="1.2"/></svg>
              <span className="text-[9px] text-gray-500">Region border</span>
            </div>
            <div className="flex items-center gap-1.5">
              <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" stroke="#999" strokeWidth="0.8" strokeDasharray="2,2"/></svg>
              <span className="text-[9px] text-gray-500">Island border (same region)</span>
            </div>
          </div>
        </div>

        <svg width={svgWidth} height={svgHeight} className="block">
          {/* Hex tiles */}
          <g>
            {data.nodes.map((node) => {
              const rid = nodeRegion(node);
              const region = regionById.get(rid);
              if (!region) return null;
              const [px, py] = hexToPixel(node.q, node.r, HEX_SIZE * viewScale);
              const x = offsetX + px;
              const y = offsetY + py;
              const color = getNodeColor(node, region);
              const isHovered = hoveredRegionId === rid;

              return (
                <path
                  key={node.idx}
                  d={hexPathStr}
                  fill={color}
                  fillOpacity={isHovered ? 1.0 : 0.82}
                  stroke="rgba(255,255,255,0.12)"
                  strokeWidth={0.2}
                  transform={`translate(${x.toFixed(1)},${y.toFixed(1)})`}
                  onMouseEnter={(e) => handleTileEnter(e, node)}
                  onMouseLeave={handleTileLeave}
                  style={{ cursor: "pointer" }}
                />
              );
            })}
          </g>

          {/* Borders: two passes – island first (dashed), region second (solid) */}
          <g style={{ pointerEvents: "none" }}>
            {data.nodes.map((node) => {
              const rid = nodeRegion(node);
              const isId = nodeIsland(node);
              const [px, py] = hexToPixel(node.q, node.r, HEX_SIZE * viewScale);
              const x = offsetX + px;
              const y = offsetY + py;

              const regionBorders: string[] = [];
              const islandBorders: string[] = [];

              for (let i = 0; i < 6; i++) {
                const [dq, dr] = HEX_DIRS[i];
                const nb = hexLookup.get(`${node.q + dq},${node.r + dr}`);
                const nbRid = nb ? nodeRegion(nb) : null;
                const nbIsId = nb ? nodeIsland(nb) : null;
                const [v1x, v1y] = hexVertex(scaledSize * 0.93, i);
                const [v2x, v2y] = hexVertex(scaledSize * 0.93, (i + 1) % 6);
                const seg = `M${(v1x + x).toFixed(1)},${(v1y + y).toFixed(1)}L${(v2x + x).toFixed(1)},${(v2y + y).toFixed(1)}`;

                if (nbRid === null || nbRid !== rid) {
                  regionBorders.push(seg);
                } else if (nbIsId !== null && nbIsId !== isId) {
                  islandBorders.push(seg);
                }
              }

              const isHovered = hoveredRegionId === rid;
              return (
                <g key={`b${node.idx}`}>
                  {islandBorders.length > 0 && (
                    <path
                      d={islandBorders.join("")}
                      fill="none"
                      stroke={isHovered ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.15)"}
                      strokeWidth={0.6}
                      strokeDasharray="2,2"
                    />
                  )}
                  {regionBorders.length > 0 && (
                    <path
                      d={regionBorders.join("")}
                      fill="none"
                      stroke={isHovered ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0.28)"}
                      strokeWidth={isHovered ? 1.2 : 0.8}
                    />
                  )}
                </g>
              );
            })}
          </g>

          {/* Labels: primary (semantic + tag) at largest island */}
          <g style={{ pointerEvents: "none" }}>
            {regions.map((region) => {
              const largestIsland = region.islands[0];
              if (!largestIsland || largestIsland.nodeCount < labelMinNodes) return null;
              const pos = regionLabelPositions.get(region.id);
              if (!pos) return null;
              const [cx, cy] = pos;
              const isHovered = hoveredRegionId === region.id;
              const label = region.label.length > 22 ? region.label.slice(0, 20) + "…" : region.label;
              const labelW = Math.min(label.length * 5.2 + 10, 130);
              const [tagText, tagBg] = tagStyle(region.interpretationTag);

              return (
                <g key={`lbl${region.id}`} transform={`translate(${cx.toFixed(1)},${cy.toFixed(1)})`}>
                  {/* Semantic label */}
                  <rect
                    x={-labelW / 2} y={-16} width={labelW} height={13} rx={3}
                    fill={isHovered ? "rgba(30,27,75,0.92)" : "rgba(255,255,255,0.9)"}
                    stroke={isHovered ? "rgba(79,70,229,0.5)" : "rgba(0,0,0,0.1)"}
                    strokeWidth={0.7}
                  />
                  <text
                    textAnchor="middle" dominantBaseline="middle" y={-9.5}
                    fontSize={7} fill={isHovered ? "white" : "#1e293b"}
                    fontFamily="system-ui, sans-serif" fontWeight="500"
                  >
                    {label}
                  </text>
                  {/* Interpretation tag badge */}
                  <rect
                    x={-labelW / 2} y={-3} width={labelW} height={10} rx={3}
                    fill={tagBg} stroke="rgba(0,0,0,0.06)" strokeWidth={0.5}
                  />
                  <text
                    textAnchor="middle" dominantBaseline="middle" y={2}
                    fontSize={6} fill={tagText}
                    fontFamily="system-ui, sans-serif" fontWeight="600"
                  >
                    {region.interpretationTag}
                  </text>
                </g>
              );
            })}
          </g>

          {/* Secondary island tag labels (tag badge only) */}
          <g style={{ pointerEvents: "none" }}>
            {secondaryIslandPositions.map(({ region, island, px, py }) => {
              const isHovered = hoveredRegionId === region.id;
              const [tagText, tagBg] = tagStyle(island.interpretationTag);
              const tagW = island.interpretationTag.length * 4.8 + 8;
              return (
                <g
                  key={`slbl${island.id}`}
                  transform={`translate(${px.toFixed(1)},${py.toFixed(1)})`}
                >
                  <rect
                    x={-tagW / 2} y={-5} width={tagW} height={10} rx={3}
                    fill={tagBg}
                    fillOpacity={isHovered ? 0.95 : 0.75}
                    stroke="rgba(0,0,0,0.06)" strokeWidth={0.5}
                  />
                  <text
                    textAnchor="middle" dominantBaseline="middle"
                    fontSize={5.5} fill={tagText}
                    fontFamily="system-ui, sans-serif" fontWeight="600"
                  >
                    {island.interpretationTag}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        {/* Tooltip */}
        {tooltip && data && (
          <Tooltip
            x={tooltip.x} y={tooltip.y}
            node={tooltip.node} region={tooltip.region} island={tooltip.island}
            globalMeanCoverage={data.globalMeanCoverage}
          />
        )}
      </div>

      {/* ── Sidebar ── */}
      <div className="w-64 flex flex-col border-l border-gray-200 bg-white overflow-hidden">

        {/* Header + sort */}
        <div className="px-3 py-2 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-semibold text-gray-700">
              Regions <span className="text-xs font-normal text-gray-400">({regions.length})</span>
            </span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-gray-400 mr-0.5">Sort:</span>
            {(["trials", "sharedness", "diversity"] as SortKey[]).map((k) => (
              <button
                key={k}
                className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                  sortKey === k ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                }`}
                onClick={() => setSortKey(k)}
              >
                {k === "trials" ? "Trials" : k === "sharedness" ? "Shared" : "Diversity"}
              </button>
            ))}
          </div>
        </div>

        {/* Region list */}
        <div className="overflow-y-auto flex-1">
          {sortedRegions.map((region) => {
            const isHovered = hoveredRegionId === region.id;
            const barColor = region.dominantTuner
              ? TUNER_COLORS[region.dominantTuner]
              : "#94a3b8";
            const maxVal =
              sortKey === "trials"
                ? sortedRegions[0]?.trialCount ?? 1
                : 1.0;
            const barPct =
              sortKey === "trials"
                ? (region.trialCount / maxVal) * 100
                : sortKey === "sharedness"
                ? region.sharedScore * 100
                : region.tunerDiversity * 100;

            const [tagText, tagBg] = tagStyle(region.interpretationTag);

            return (
              <div
                key={region.id}
                className={`px-3 py-1.5 border-b border-gray-50 cursor-pointer transition-colors ${
                  isHovered ? "bg-indigo-50" : "hover:bg-gray-50"
                }`}
                onMouseEnter={() => setHoveredRegionId(region.id)}
                onMouseLeave={() => setHoveredRegionId(null)}
              >
                {/* Label + tag */}
                <div className="flex items-start gap-1.5 mb-0.5">
                  {region.dominantTuner && (
                    <div
                      className="w-2 h-2 rounded-full flex-shrink-0 mt-0.5"
                      style={{ background: TUNER_COLORS[region.dominantTuner] }}
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <span
                      className={`text-[11px] leading-tight font-medium block truncate ${
                        isHovered ? "text-indigo-700" : "text-gray-700"
                      }`}
                    >
                      {region.label}
                    </span>
                    <span
                      className="text-[9px] px-1 py-0.5 rounded-full font-medium inline-block mt-0.5"
                      style={{ color: tagText, background: tagBg }}
                    >
                      {region.interpretationTag}
                    </span>
                  </div>
                </div>

                {/* Bar */}
                <div className="relative h-1 bg-gray-100 rounded-full mb-0.5">
                  <div
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{
                      width: `${barPct}%`,
                      background:
                        sortKey === "sharedness"
                          ? sharedColor(region.sharedScore)
                          : barColor,
                      opacity: 0.7,
                    }}
                  />
                </div>

                {/* Stats */}
                <div className="flex items-center justify-between text-[10px] text-gray-400">
                  <span>{region.trialCount.toLocaleString()} trials</span>
                  <span>
                    <span style={{ color: region.sharedScore > 0.4 ? "#0891b2" : undefined }}>
                      sh {(region.sharedScore * 100).toFixed(0)}%
                    </span>
                  </span>
                  <span>div {(region.tunerDiversity * 100).toFixed(0)}%</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-3 py-2 border-t border-gray-100 bg-gray-50 flex-shrink-0 text-[10px] text-gray-500">
          <div className="flex justify-between mb-0.5">
            <span>Total trials:</span>
            <span className="font-medium text-gray-700">{data.totalTrials.toLocaleString()}</span>
          </div>
          <div className="flex justify-between mb-0.5">
            <span>Global mean cov:</span>
            <span className="font-medium text-gray-700">{data.globalMeanCoverage.toFixed(0)}</span>
          </div>
          {hoveredRegion && (
            <div className="mt-1 pt-1 border-t border-gray-200">
              <div className="font-medium text-[11px] text-indigo-600 truncate">{hoveredRegion.label}</div>
              <div className="flex justify-between">
                <span>Islands:</span>
                <span className="text-gray-700">{hoveredRegion.islands.length}</span>
              </div>
              <div className="flex justify-between">
                <span>Shared score:</span>
                <span
                  style={{ color: hoveredRegion.sharedScore > 0.4 ? "#0891b2" : "#94a3b8" }}
                  className="font-medium"
                >
                  {(hoveredRegion.sharedScore * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
