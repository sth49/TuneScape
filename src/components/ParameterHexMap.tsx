/**
 * Parameter Hex Map — QAP-optimized hex grid layout
 *
 * Each hex = one unique parameter combination (all 61 params, discretized)
 * Position encodes parameter similarity (Hamming distance → hex distance)
 * Color encodes tuner distribution
 * LoD slider merges nearby hexes by Hamming distance threshold
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  TUNER_COLORS,
  TUNER_NAMES,
  type TunerType,
} from "../utils/hexMapUtils";

// ─── Types ───────────────────────────────────────────────────────────────────

interface HexNode {
  idx: number;
  q: number;
  r: number;
  discrete: (string | number)[];
  trialCount: number;
  tunerCounts: Record<string, number>;
  meanCoverage: number;
  maxCoverage: number;
  minCoverage: number;
  trialIndices: number[];
}

interface ParamMeta {
  type: "boolean" | "categorical" | "numeric";
  binEdges?: number[];
  binLabels?: string[];
  categories?: string[];
}

interface LodLevel {
  nClusters: number;
  assignments: number[];
  positions: [number, number][];
}

interface HexLayoutData {
  program: string;
  tuners: string[];
  totalTrials: number;
  allParams: string[];
  paramMeta: Record<string, ParamMeta>;
  gridRadius: number;
  nodes: HexNode[];
  lodLevels?: LodLevel[];
}

// LoD aggregated node
interface AggNode {
  id: number;
  hexNodes: HexNode[];        // constituent hex nodes
  q: number;                  // centroid q
  r: number;                  // centroid r
  trialCount: number;
  tunerCounts: Record<string, number>;
  meanCoverage: number;
  maxCoverage: number;
}

interface TooltipData {
  node: AggNode;
  x: number;
  y: number;
}

type ColorMode = "tuner" | "coverage" | "trialCount";

interface ParameterHexMapProps {
  width?: number;
  height?: number;
  program?: string;
}

// ─── Hex geometry helpers ────────────────────────────────────────────────────

const HEX_SIZE = 4; // base hex size in pixels (small for 5000+ nodes)

function hexToPixel(q: number, r: number, size: number): [number, number] {
  // Flat-top hex: x = size * 3/2 * q, y = size * sqrt(3) * (r + q/2)
  const x = size * 1.5 * q;
  const y = size * Math.sqrt(3) * (r + q / 2);
  return [x, y];
}

function getHexPath(size: number): string {
  const points: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    const x = size * Math.cos(angle);
    const y = size * Math.sin(angle);
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return `M${points.join("L")}Z`;
}

function hexDistance(q1: number, r1: number, q2: number, r2: number): number {
  return (Math.abs(q1 - q2) + Math.abs(q1 + r1 - q2 - r2) + Math.abs(r1 - r2)) / 2;
}

// ─── LoD Aggregation (precomputed levels) ────────────────────────────────────

function aggregateByLevel(
  nodes: HexNode[],
  lodLevels: LodLevel[] | undefined,
  lodLevel: number
): AggNode[] {
  if (lodLevel === 0 || !lodLevels || lodLevel > lodLevels.length) {
    // No aggregation: each hex node is its own agg node
    return nodes.map((n, i) => ({
      id: i,
      hexNodes: [n],
      q: n.q,
      r: n.r,
      trialCount: n.trialCount,
      tunerCounts: { ...n.tunerCounts },
      meanCoverage: n.meanCoverage,
      maxCoverage: n.maxCoverage,
    }));
  }

  const level = lodLevels[lodLevel - 1];
  const { assignments, positions, nClusters } = level;

  // Group nodes by cluster assignment
  const groups: HexNode[][] = Array.from({ length: nClusters }, () => []);
  for (let i = 0; i < nodes.length; i++) {
    const clusterId = assignments[i];
    if (clusterId !== undefined && clusterId < nClusters) {
      groups[clusterId].push(nodes[i]);
    }
  }

  // Build AggNode per non-empty cluster
  const clusters: AggNode[] = [];
  for (let c = 0; c < nClusters; c++) {
    const members = groups[c];
    if (members.length === 0) continue;

    const totalTrials = members.reduce((s, m) => s + m.trialCount, 0);
    const tunerCounts: Record<string, number> = {};
    for (const m of members) {
      for (const [t, cnt] of Object.entries(m.tunerCounts)) {
        tunerCounts[t] = (tunerCounts[t] || 0) + cnt;
      }
    }

    const [q, r] = positions[c];

    clusters.push({
      id: clusters.length,
      hexNodes: members,
      q,
      r,
      trialCount: totalTrials,
      tunerCounts,
      meanCoverage:
        members.reduce((s, m) => s + m.meanCoverage * m.trialCount, 0) / totalTrials,
      maxCoverage: Math.max(...members.map((m) => m.maxCoverage)),
    });
  }

  return clusters;
}

// ─── Pie chart path for mixed tuner hexes ────────────────────────────────────

function piePaths(
  tunerCounts: Record<string, number>,
  size: number
): { tuner: string; path: string; color: string }[] {
  const entries = TUNER_NAMES
    .filter((t) => (tunerCounts[t] || 0) > 0)
    .map((t) => ({ tuner: t, count: tunerCounts[t] || 0 }));

  if (entries.length === 0) return [];
  if (entries.length === 1) {
    return [
      {
        tuner: entries[0].tuner,
        path: getHexPath(size),
        color: TUNER_COLORS[entries[0].tuner as TunerType],
      },
    ];
  }

  const TWO_PI = 2 * Math.PI;
  const SECTOR = Math.PI / 3;
  const apothem = size * Math.cos(Math.PI / 6); // size * √3/2

  // Precompute hex vertex positions and angles (flat-top)
  const vertexAngles: number[] = [];
  const hexVertices: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const a = SECTOR * i;
    vertexAngles.push(a);
    hexVertices.push([size * Math.cos(a), size * Math.sin(a)]);
  }

  // Point on hex boundary at a given angle from center
  function hexBoundaryPt(angle: number): [number, number] {
    const a = ((angle % TWO_PI) + TWO_PI) % TWO_PI;
    const k = Math.floor(a / SECTOR) % 6;
    const delta = a - (k + 0.5) * SECTOR;
    const r = apothem / Math.cos(delta);
    return [r * Math.cos(a), r * Math.sin(a)];
  }

  const total = entries.reduce((s, e) => s + e.count, 0);
  const paths: { tuner: string; path: string; color: string }[] = [];
  let startAngle = -Math.PI / 2;

  for (const entry of entries) {
    const sweep = (entry.count / total) * TWO_PI;
    const endAngle = startAngle + sweep;

    const [x1, y1] = hexBoundaryPt(startAngle);
    const [x2, y2] = hexBoundaryPt(endAngle);

    let d = `M0,0 L${x1.toFixed(2)},${y1.toFixed(2)}`;

    // Add hex vertices that fall between startAngle and endAngle
    const normStart = ((startAngle % TWO_PI) + TWO_PI) % TWO_PI;
    const normEnd = normStart + sweep;

    const vInSector: { angle: number; idx: number }[] = [];
    for (let i = 0; i < 6; i++) {
      for (const va of [vertexAngles[i], vertexAngles[i] + TWO_PI]) {
        if (va > normStart + 1e-9 && va < normEnd - 1e-9) {
          vInSector.push({ angle: va, idx: i });
          break;
        }
      }
    }
    vInSector.sort((a, b) => a.angle - b.angle);

    for (const v of vInSector) {
      d += ` L${hexVertices[v.idx][0].toFixed(2)},${hexVertices[v.idx][1].toFixed(2)}`;
    }

    d += ` L${x2.toFixed(2)},${y2.toFixed(2)} Z`;

    paths.push({
      tuner: entry.tuner,
      path: d,
      color: TUNER_COLORS[entry.tuner as TunerType],
    });

    startAngle = endAngle;
  }

  return paths;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ParameterHexMap({
  width = 1200,
  height = 800,
  program = "gawk",
}: ParameterHexMapProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [data, setData] = useState<HexLayoutData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [lodLevel, setLodLevel] = useState(0);
  const [colorMode, setColorMode] = useState<ColorMode>("tuner");
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [selectedNode, setSelectedNode] = useState<AggNode | null>(null);
  const [enabledTuners, setEnabledTuners] = useState<Set<string>>(
    new Set(TUNER_NAMES)
  );

  // Zoom/pan state
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });

  // ─── Load Data ─────────────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/data/${program}_hex_layout.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load hex layout for ${program}`);
        return res.json();
      })
      .then((d: HexLayoutData) => {
        setData(d);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [program]);

  // ─── Auto-fit transform when data loads ────────────────────────────────────
  useEffect(() => {
    if (!data) return;
    const nodes = data.nodes;
    const positions = nodes.map((n) => hexToPixel(n.q, n.r, HEX_SIZE));
    const xs = positions.map((p) => p[0]);
    const ys = positions.map((p) => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const dataW = maxX - minX + HEX_SIZE * 4;
    const dataH = maxY - minY + HEX_SIZE * 4;

    const margin = 60;
    const availW = width - margin * 2;
    const availH = height - margin * 2 - 80; // leave room for controls
    const scale = Math.min(availW / dataW, availH / dataH, 3);

    setTransform({
      k: scale,
      x: margin + availW / 2 - ((minX + maxX) / 2) * scale,
      y: margin + 40 + availH / 2 - ((minY + maxY) / 2) * scale,
    });
  }, [data, width, height]);

  // ─── LoD Aggregation ───────────────────────────────────────────────────────
  const aggNodes = useMemo(() => {
    if (!data) return [];
    return aggregateByLevel(data.nodes, data.lodLevels, lodLevel);
  }, [data, lodLevel]);

  // ─── Coverage scale ────────────────────────────────────────────────────────
  const coverageExtent = useMemo(() => {
    if (!aggNodes.length) return [0, 1];
    const vals = aggNodes.map((n) => n.meanCoverage);
    return [Math.min(...vals), Math.max(...vals)];
  }, [aggNodes]);

  // ─── Mouse handlers ───────────────────────────────────────────────────────
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      setTransform((t) => {
        const newK = Math.max(0.1, Math.min(20, t.k * factor));
        return {
          k: newK,
          x: mx - (mx - t.x) * (newK / t.k),
          y: my - (my - t.y) * (newK / t.k),
        };
      });
    },
    []
  );

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    isPanning.current = true;
    panStart.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning.current) return;
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      panStart.current = { x: e.clientX, y: e.clientY };
      setTransform((t) => ({ ...t, x: t.x + dx, y: t.y + dy }));
    },
    []
  );

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  // ─── Hex size based on LoD ────────────────────────────────────────────────
  const hexSize = useMemo(() => {
    if (lodLevel === 0) return HEX_SIZE;
    // Grow hex size proportional to average cluster size
    const avgMembers = aggNodes.length > 0
      ? aggNodes.reduce((s, n) => s + n.hexNodes.length, 0) / aggNodes.length
      : 1;
    return HEX_SIZE * Math.min(Math.sqrt(avgMembers), 4);
  }, [lodLevel, aggNodes]);

  const hexPath = useMemo(() => getHexPath(hexSize), [hexSize]);

  // ─── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center h-full text-error">
        {error || "No data available"}
      </div>
    );
  }

  // Filter by enabled tuners
  const filteredNodes = aggNodes.filter((n) => {
    const tuners = Object.keys(n.tunerCounts);
    return tuners.some((t) => enabledTuners.has(t) && n.tunerCounts[t] > 0);
  });

  // Max trial count for size scaling
  const maxTrialCount = Math.max(...filteredNodes.map((n) => n.trialCount), 1);

  return (
    <div className="flex flex-col h-full gap-2">
      {/* ── Controls ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-6 flex-wrap">
        {/* LoD Slider */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-500">LoD</span>
          <input
            type="range"
            min={0}
            max={data.lodLevels ? data.lodLevels.length : 0}
            step={1}
            value={lodLevel}
            onChange={(e) => setLodLevel(Number(e.target.value))}
            className="range range-xs range-primary w-28"
          />
          <span className="text-xs text-gray-500 w-20">
            {filteredNodes.length} clusters
          </span>
        </div>

        {/* Color Mode */}
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium text-gray-500">Color:</span>
          {(["tuner", "coverage", "trialCount"] as ColorMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => setColorMode(mode)}
              className={`px-2 py-0.5 text-xs rounded ${
                colorMode === mode
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {mode === "trialCount" ? "density" : mode}
            </button>
          ))}
        </div>

        {/* Tuner Legend / Toggle */}
        <div className="flex items-center gap-2">
          {TUNER_NAMES.map((tuner) => {
            const enabled = enabledTuners.has(tuner);
            return (
              <button
                key={tuner}
                onClick={() => {
                  setEnabledTuners((prev) => {
                    const next = new Set(prev);
                    if (next.has(tuner)) next.delete(tuner);
                    else next.add(tuner);
                    return next;
                  });
                }}
                className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded transition-opacity ${
                  enabled ? "opacity-100" : "opacity-30"
                }`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full inline-block"
                  style={{ backgroundColor: TUNER_COLORS[tuner] }}
                />
                {tuner}
              </button>
            );
          })}
        </div>

        {/* Stats */}
        <div className="text-xs text-gray-400 ml-auto">
          {data.totalTrials} trials | {data.nodes.length} unique combos |{" "}
          {filteredNodes.length} visible
        </div>
      </div>

      {/* ── SVG ──────────────────────────────────────────────────────────── */}
      <svg
        ref={svgRef}
        width={width}
        height={height - 80}
        className="bg-gray-950 rounded-lg cursor-grab active:cursor-grabbing"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          handleMouseUp();
          setTooltip(null);
        }}
      >
        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
          {filteredNodes.map((node) => {
            const [px, py] = hexToPixel(node.q, node.r, hexSize);

            // Size scaling based on trial count
            const sizeScale =
              colorMode === "trialCount"
                ? 0.5 + 0.5 * Math.sqrt(node.trialCount / maxTrialCount)
                : 1;
            const displaySize = hexSize * sizeScale;

            if (colorMode === "tuner") {
              // Pie chart for mixed tuner hexes
              const filteredCounts: Record<string, number> = {};
              for (const t of TUNER_NAMES) {
                if (enabledTuners.has(t) && node.tunerCounts[t]) {
                  filteredCounts[t] = node.tunerCounts[t];
                }
              }
              const pies = piePaths(filteredCounts, displaySize);

              return (
                <g
                  key={node.id}
                  transform={`translate(${px},${py})`}
                  onMouseEnter={(e) => {
                    const rect = svgRef.current?.getBoundingClientRect();
                    if (rect) {
                      setTooltip({
                        node,
                        x: e.clientX - rect.left,
                        y: e.clientY - rect.top,
                      });
                    }
                  }}
                  onMouseLeave={() => setTooltip(null)}
                  onClick={() => setSelectedNode(node)}
                  className="cursor-pointer"
                >
                  {pies.map((p, i) => (
                    <path
                      key={i}
                      d={p.path}
                      fill={p.color}
                      stroke="rgba(255,255,255,0.1)"
                      strokeWidth={0.3}
                    />
                  ))}
                </g>
              );
            }

            // Coverage or density color
            let fill: string;
            if (colorMode === "coverage") {
              const t =
                (node.meanCoverage - coverageExtent[0]) /
                (coverageExtent[1] - coverageExtent[0] + 1e-6);
              // Viridis-like: dark blue → green → yellow
              const r = Math.round(68 + 187 * t);
              const g = Math.round(1 + 180 * Math.sqrt(t));
              const b = Math.round(84 + 100 * (1 - t));
              fill = `rgb(${r},${g},${b})`;
            } else {
              // trialCount → density heatmap
              const t = Math.sqrt(node.trialCount / maxTrialCount);
              const r = Math.round(255 * t);
              const g = Math.round(80 * t);
              const b = Math.round(60 + 100 * (1 - t));
              fill = `rgb(${r},${g},${b})`;
            }

            return (
              <path
                key={node.id}
                d={getHexPath(displaySize)}
                transform={`translate(${px},${py})`}
                fill={fill}
                stroke="rgba(255,255,255,0.08)"
                strokeWidth={0.3}
                onMouseEnter={(e) => {
                  const rect = svgRef.current?.getBoundingClientRect();
                  if (rect) {
                    setTooltip({
                      node,
                      x: e.clientX - rect.left,
                      y: e.clientY - rect.top,
                    });
                  }
                }}
                onMouseLeave={() => setTooltip(null)}
                onClick={() => setSelectedNode(node)}
                className="cursor-pointer"
              />
            );
          })}
        </g>

        {/* ── Tooltip ────────────────────────────────────────────────────── */}
        {tooltip && (
          <foreignObject
            x={Math.min(tooltip.x + 12, width - 300)}
            y={Math.min(tooltip.y + 12, height - 360)}
            width={280}
            height={340}
            style={{ pointerEvents: "none" }}
          >
            <div className="bg-gray-900 text-gray-100 rounded-lg shadow-lg p-3 text-xs border border-gray-700">
              <div className="font-semibold mb-1.5">
                {tooltip.node.hexNodes.length === 1
                  ? `Hex Node #${tooltip.node.hexNodes[0].idx}`
                  : `Cluster (${tooltip.node.hexNodes.length} combos)`}
              </div>

              <div className="text-gray-400 mb-2">
                Trials: <span className="text-white">{tooltip.node.trialCount}</span>
                {" | "}
                Coverage: <span className="text-white">{tooltip.node.meanCoverage.toFixed(0)}</span>
                {tooltip.node.maxCoverage !== tooltip.node.meanCoverage && (
                  <span className="text-gray-500">
                    {" "}(max {tooltip.node.maxCoverage})
                  </span>
                )}
              </div>

              {/* Tuner breakdown */}
              <div className="space-y-1 mb-2">
                {TUNER_NAMES.filter(
                  (t) => (tooltip.node.tunerCounts[t] || 0) > 0
                ).map((t) => {
                  const count = tooltip.node.tunerCounts[t] || 0;
                  const pct = ((count / tooltip.node.trialCount) * 100).toFixed(0);
                  return (
                    <div key={t} className="flex items-center gap-1.5">
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: TUNER_COLORS[t as TunerType] }}
                      />
                      <span className="text-gray-300">{t}</span>
                      <span className="ml-auto text-gray-400">
                        {count} ({pct}%)
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Parameter values (only for single hex nodes) */}
              {tooltip.node.hexNodes.length === 1 && data && (
                <div className="border-t border-gray-700 pt-1.5 space-y-0.5 max-h-48 overflow-y-auto">
                  {data.allParams.map((p, i) => {
                    const val = tooltip.node.hexNodes[0].discrete[i];
                    const meta = data.paramMeta[p];
                    let display: string;
                    if (meta?.type === "boolean") {
                      display = val === 1 ? "true" : "false";
                    } else if (meta?.type === "numeric") {
                      display = meta.binLabels?.[val as number] ?? String(val);
                    } else {
                      display = String(val);
                    }
                    return (
                      <div key={p} className="flex justify-between gap-2">
                        <span className="text-gray-400 truncate">{p}</span>
                        <span className="text-gray-200 font-mono whitespace-nowrap">{display}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </foreignObject>
        )}
      </svg>

      {/* ── Selected Node Detail Panel ───────────────────────────────────── */}
      {selectedNode && data && (
        <div className="absolute bottom-4 right-4 bg-gray-900 text-gray-100 rounded-lg shadow-xl p-4 text-xs border border-gray-700 w-80 max-h-[28rem] overflow-auto">
          <div className="flex justify-between items-center mb-2">
            <span className="font-semibold">
              {selectedNode.hexNodes.length === 1
                ? `Node #${selectedNode.hexNodes[0].idx}`
                : `Cluster (${selectedNode.hexNodes.length} combos)`}
            </span>
            <button
              onClick={() => setSelectedNode(null)}
              className="text-gray-400 hover:text-white"
            >
              ✕
            </button>
          </div>
          <div className="text-gray-400 mb-2">
            {selectedNode.trialCount} trials | coverage{" "}
            {selectedNode.meanCoverage.toFixed(0)}
          </div>

          {/* Tuner bar */}
          <div className="flex h-3 rounded overflow-hidden mb-2">
            {TUNER_NAMES.filter((t) => (selectedNode.tunerCounts[t] || 0) > 0).map(
              (t) => {
                const pct =
                  ((selectedNode.tunerCounts[t] || 0) / selectedNode.trialCount) * 100;
                return (
                  <div
                    key={t}
                    style={{
                      width: `${pct}%`,
                      backgroundColor: TUNER_COLORS[t as TunerType],
                    }}
                    title={`${t}: ${selectedNode.tunerCounts[t]}`}
                  />
                );
              }
            )}
          </div>

          {/* Parameters for single node */}
          {selectedNode.hexNodes.length === 1 && (
            <div className="space-y-1 border-t border-gray-700 pt-2">
              {data.allParams.map((p, i) => {
                const val = selectedNode.hexNodes[0].discrete[i];
                const meta = data.paramMeta[p];
                let display: string;
                if (meta?.type === "boolean") {
                  display = val === 1 ? "true" : "false";
                } else if (meta?.type === "numeric") {
                  display = meta.binLabels?.[val as number] ?? String(val);
                } else {
                  display = String(val);
                }
                return (
                  <div key={p} className="flex justify-between gap-2">
                    <span className="text-gray-400 truncate">{p}</span>
                    <span className="text-gray-200 font-mono whitespace-nowrap">{display}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
