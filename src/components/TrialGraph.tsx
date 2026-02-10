/**
 * Trial Graph — Force-directed Hex Grid Layout (Web Worker)
 *
 * - Each hexagon = one trial (~8,800 total)
 * - Heavy computation (edges, force sim, hex snap) offloaded to Web Worker
 * - Canvas rendering for performance
 */

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import * as d3 from "d3";
import {
  TUNER_COLORS,
  TUNER_NAMES,
  type TunerType,
} from "../utils/hexMapUtils";
import type { ProcessedData } from "../types/data";
import type {
  WorkerInput,
  WorkerOutput,
  HexResult,
  FeatureConfig,
  LayoutMethod,
} from "../workers/hexLayoutWorker";

// ============================================================
// Types
// ============================================================

interface TrialNode {
  id: number;
  tuner: TunerType;
  params: (string | boolean | number)[];
  coverage: number;
  marginalCoverage: number;
}

interface HexPos {
  q: number;
  r: number;
  px: number;
  py: number;
  tuner: TunerType;
  id: number;
  coverage: number;
  marginalCoverage: number;
  count?: number;
  tunerCounts?: Record<string, number>;
}

interface TrialGraphProps {
  width?: number;
  height?: number;
  program?: string;
}

interface TooltipInfo {
  hex: HexPos;
  x: number;
  y: number;
}

interface LayoutStats {
  totalNodes: number;
  tunerCounts: Record<string, number>;
}

const EMPTY_STATS: LayoutStats = {
  totalNodes: 0,
  tunerCounts: {},
};

// ============================================================
// Component
// ============================================================

export const TrialGraph: React.FC<TrialGraphProps> = ({
  width = 1100,
  height = 700,
  program = "gawk",
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading…");

  const [allNodes, setAllNodes] = useState<TrialNode[]>([]);
  const [paramNames, setParamNames] = useState<string[]>([]);

  const [sampleSize, setSampleSize] = useState(8800);
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);
  const [enabledTuners, setEnabledTuners] = useState<Set<TunerType>>(
    new Set(TUNER_NAMES),
  );
  const [aggDist, setAggDist] = useState(0);
  const [featureConfig, setFeatureConfig] = useState<FeatureConfig[] | null>(null);
  const [layoutMethod, setLayoutMethod] = useState<LayoutMethod>('spectral');
  const [selectedHexIdx, setSelectedHexIdx] = useState<number | null>(null);

  // Layout results from worker
  const [hexLayout, setHexLayout] = useState<HexPos[]>([]);
  const [stats, setStats] = useState<LayoutStats>(EMPTY_STATS);
  const [completedHash, setCompletedHash] = useState("");

  const transformRef = useRef(d3.zoomIdentity);
  const hexLayoutRef = useRef<HexPos[]>([]);
  const hexSizeRef = useRef(4);
  const distanceMapRef = useRef<number[] | null>(null);
  const selectedHexIdxRef = useRef<number | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const generationRef = useRef(0);
  const hashForGenRef = useRef<Map<number, string>>(new Map());

  const canvasW = width - 280;
  const canvasH = height;

  // ----------------------------------------------------------
  // Create / destroy worker
  // ----------------------------------------------------------
  useEffect(() => {
    const worker = new Worker(
      new URL("../workers/hexLayoutWorker.ts", import.meta.url),
      { type: "module" },
    );

    worker.onmessage = (e: MessageEvent<WorkerOutput>) => {
      const data = e.data;
      if (data.generation !== generationRef.current) return; // stale

      const layout: HexPos[] = data.hexes.map((h: HexResult) => ({
        q: h.q,
        r: h.r,
        px: h.px,
        py: h.py,
        tuner: h.tuner as TunerType,
        id: h.id,
        coverage: h.coverage,
        marginalCoverage: h.marginalCoverage,
        count: h.count,
        tunerCounts: h.tunerCounts,
      }));

      setHexLayout(layout);
      setStats(data.stats as LayoutStats);
      const hash = hashForGenRef.current.get(data.generation) ?? "";
      setCompletedHash(hash);
      hashForGenRef.current.delete(data.generation);
    };

    worker.onerror = (err) => {
      console.error("[TrialGraph Worker]", err);
    };

    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  // ----------------------------------------------------------
  // Load data
  // ----------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setStatus("Loading trial data…");
      try {
        const urls = TUNER_NAMES.map(
          (t) => `/data/${program}_${t}_processed.json`,
        );
        const responses: ProcessedData[] = await Promise.all(
          urls.map((u) =>
            fetch(u).then((r) => {
              if (!r.ok) throw new Error(`Failed: ${u}`);
              return r.json();
            }),
          ),
        );
        if (cancelled) return;

        const pNames =
          responses[0].parameters ||
          Object.keys(responses[0].trials[0]?.parameters ?? {});

        const trials: TrialNode[] = [];
        let id = 0;
        for (let ti = 0; ti < responses.length; ti++) {
          const tuner = TUNER_NAMES[ti];
          for (const t of responses[ti].trials) {
            trials.push({
              id: id++,
              tuner,
              params: pNames.map((p) => t.parameters[p]),
              coverage: t.cumulativeCoverage,
              marginalCoverage: t.marginalCoverage,
            });
          }
        }
        if (cancelled) return;
        setParamNames(pNames);
        setAllNodes(trials);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Load failed");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [program]);

  // ----------------------------------------------------------
  // Load feature selection config (SHAP-based)
  // ----------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    fetch(`/data/${program}_feature_selection.json`)
      .then((r) => {
        if (!r.ok) throw new Error("not found");
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        const configs: FeatureConfig[] = (data.selectedFeatures as string[]).map(
          (name: string) => ({
            name,
            type: data.paramTypes[name] as FeatureConfig["type"],
            importance: data.importance[name] ?? 0,
            binEdges: data.binEdges?.[name],
            categories: data.categories?.[name],
          }),
        );
        setFeatureConfig(configs);
      })
      .catch(() => {
        if (!cancelled) setFeatureConfig(null); // MDS fallback
      });
    return () => {
      cancelled = true;
    };
  }, [program]);

  // ----------------------------------------------------------
  // Sampling (stratified by tuner) — fast, stays on main thread
  // ----------------------------------------------------------
  const sampled = useMemo(() => {
    if (allNodes.length === 0) return [];
    if (sampleSize >= allNodes.length)
      return allNodes.map((n, i) => ({ ...n, id: i }));

    const byTuner = new Map<TunerType, TrialNode[]>();
    for (const n of allNodes) {
      const arr = byTuner.get(n.tuner) ?? [];
      arr.push(n);
      byTuner.set(n.tuner, arr);
    }
    const ratio = sampleSize / allNodes.length;
    const out: TrialNode[] = [];

    for (const [, arr] of byTuner) {
      const k = Math.max(1, Math.round(arr.length * ratio));
      const step = arr.length / k;
      for (let i = 0; i < k; i++) {
        const idx = Math.floor(i * step);
        out.push(arr[idx]);
      }
    }
    return out.map((n, i) => ({ ...n, id: i }));
  }, [allNodes, sampleSize]);

  // ----------------------------------------------------------
  // Hex size — derived from sampled count + canvas dims
  // ----------------------------------------------------------
  const layoutHexSize = useMemo(() => {
    if (sampled.length === 0) return 4;
    const effectiveCount = aggDist > 0
      ? sampled.length / Math.max(1, aggDist * 2 + 1)
      : sampled.length;
    const approxR = Math.ceil(Math.sqrt(effectiveCount / 3) * 1.1);
    const maxSpan = Math.min(canvasW, canvasH);
    return Math.max(2, maxSpan / (approxR * 2 * Math.sqrt(3)));
  }, [sampled, canvasW, canvasH, aggDist]);

  // ----------------------------------------------------------
  // Distance map: Hamming distance from selected hex to all others
  // ----------------------------------------------------------
  const distanceMap = useMemo(() => {
    if (selectedHexIdx === null || aggDist > 0) return null;
    const layout = hexLayout;
    const ref = layout[selectedHexIdx];
    if (!ref) return null;
    const refNode = sampled[ref.id];
    if (!refNode) return null;

    return layout.map((h) => {
      if (h === ref) return 0;
      const node = sampled[h.id];
      if (!node) return 0;
      let diff = 0;
      for (let p = 0; p < refNode.params.length; p++) {
        if (refNode.params[p] !== node.params[p]) diff++;
      }
      return diff;
    });
  }, [selectedHexIdx, hexLayout, sampled, aggDist]);

  const maxDist = useMemo(() => {
    if (!distanceMap) return 0;
    let mx = 0;
    for (const d of distanceMap) if (d > mx) mx = d;
    return mx;
  }, [distanceMap]);

  // ----------------------------------------------------------
  // Derive computing state from input hash vs completed hash
  // ----------------------------------------------------------
  const inputHash = useMemo(
    () =>
      `${program}|${sampled.length}|${[...enabledTuners].sort()}|${canvasW}|${canvasH}|${aggDist}|${layoutMethod}|${featureConfig ? featureConfig.map((f) => f.name).join(",") : "mds"}`,
    [program, sampled, enabledTuners, canvasW, canvasH, aggDist, layoutMethod, featureConfig],
  );
  const computing = sampled.length > 0 && inputHash !== completedHash;

  // ----------------------------------------------------------
  // Dispatch to worker when inputs change (no setState here)
  // ----------------------------------------------------------
  useEffect(() => {
    if (sampled.length === 0 || !workerRef.current) return;
    const gen = ++generationRef.current;
    hashForGenRef.current.set(gen, inputHash);

    const msg: WorkerInput = {
      nodes: sampled.map((n) => ({
        id: n.id,
        tuner: n.tuner,
        params: n.params,
        coverage: n.coverage,
        marginalCoverage: n.marginalCoverage,
      })),
      enabledTuners: [...enabledTuners],
      hexSize: layoutHexSize,
      cx: canvasW / 2,
      cy: canvasH / 2,
      generation: gen,
      aggDist,
      layoutMethod,
      features: featureConfig ?? undefined,
      paramNames: featureConfig ? paramNames : undefined,
    };
    workerRef.current.postMessage(msg);
  }, [
    inputHash,
    sampled,
    enabledTuners,
    layoutHexSize,
    canvasW,
    canvasH,
    layoutMethod,
    featureConfig,
    paramNames,
  ]);

  // ----------------------------------------------------------
  // Sync refs when layout changes (for draw/hover callbacks)
  // ----------------------------------------------------------
  useEffect(() => {
    hexLayoutRef.current = hexLayout;
  }, [hexLayout]);
  useEffect(() => {
    hexSizeRef.current = layoutHexSize;
  }, [layoutHexSize]);
  // Clear selection when layout recomputes
  useEffect(() => {
    setSelectedHexIdx(null);
  }, [hexLayout]);

  // ----------------------------------------------------------
  // Auto-fit: compute initial zoom transform
  // ----------------------------------------------------------
  const initialTransform = useMemo(() => {
    if (hexLayout.length === 0) return d3.zoomIdentity;
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const h of hexLayout) {
      if (h.px < minX) minX = h.px;
      if (h.px > maxX) maxX = h.px;
      if (h.py < minY) minY = h.py;
      if (h.py > maxY) maxY = h.py;
    }
    const pad = layoutHexSize * 3;
    const bw = maxX - minX + pad * 2;
    const bh = maxY - minY + pad * 2;
    const scale = Math.min(canvasW / bw, canvasH / bh, 3);
    const tx = canvasW / 2 - ((minX + maxX) / 2) * scale;
    const ty = canvasH / 2 - ((minY + maxY) / 2) * scale;
    return d3.zoomIdentity.translate(tx, ty).scale(scale);
  }, [hexLayout, layoutHexSize, canvasW, canvasH]);

  // ----------------------------------------------------------
  // Draw
  // ----------------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const t = transformRef.current;
    const hs = hexSizeRef.current;
    const layout = hexLayoutRef.current;
    const distMap = distanceMapRef.current;
    const selIdx = selectedHexIdxRef.current;

    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    // Helper: draw a single hex path
    const hexPath = (h: HexPos) => {
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i;
        const px = h.px + hs * Math.cos(angle);
        const py = h.py + hs * Math.sin(angle);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    };

    if (distMap && selIdx !== null) {
      // === Distance coloring mode ===
      let mx = 0;
      for (const d of distMap) if (d > mx) mx = d;
      if (mx === 0) mx = 1;
      const colorScale = d3.scaleSequential(d3.interpolateYlOrRd).domain([0, mx]);

      // Batch by integer distance for fewer fillStyle switches
      const byDist = new Map<number, number[]>();
      for (let i = 0; i < layout.length; i++) {
        const d = distMap[i];
        const arr = byDist.get(d) ?? [];
        arr.push(i);
        byDist.set(d, arr);
      }

      for (const [dist, indices] of byDist) {
        ctx.fillStyle = dist === 0 ? "#ffffff" : colorScale(dist);
        ctx.beginPath();
        for (const i of indices) hexPath(layout[i]);
        ctx.fill();
      }

      // Selected hex white ring
      const sel = layout[selIdx];
      if (sel) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2.5 / t.k;
        ctx.beginPath();
        hexPath(sel);
        ctx.stroke();
      }

      // Light borders
      ctx.strokeStyle = "rgba(0,0,0,0.15)";
      ctx.lineWidth = 0.3;
      ctx.beginPath();
      for (const h of layout) hexPath(h);
      ctx.stroke();
    } else {
      // === Normal tuner coloring mode ===
      const buckets = new Map<TunerType, HexPos[]>();
      for (const h of layout) {
        const arr = buckets.get(h.tuner) ?? [];
        arr.push(h);
        buckets.set(h.tuner, arr);
      }

      for (const [tuner, hexes] of buckets) {
        ctx.fillStyle = TUNER_COLORS[tuner];
        ctx.beginPath();
        for (const h of hexes) hexPath(h);
        ctx.fill();
      }

      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 0.3;
      ctx.beginPath();
      for (const h of layout) hexPath(h);
      ctx.stroke();
    }

    ctx.restore();
  }, [canvasW, canvasH]);

  // Sync distance refs + redraw when selection changes
  useEffect(() => {
    distanceMapRef.current = distanceMap;
    selectedHexIdxRef.current = selectedHexIdx;
    draw();
  }, [distanceMap, selectedHexIdx, draw]);

  // Redraw when layout changes
  useEffect(() => {
    transformRef.current = initialTransform;
    draw();
  }, [hexLayout, initialTransform, draw]);

  // ----------------------------------------------------------
  // Zoom & pan
  // ----------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const zoom = d3
      .zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.1, 20])
      .on("zoom", (event) => {
        transformRef.current = event.transform;
        draw();
      });
    const sel = d3.select(canvas);
    sel.call(zoom);
    if (hexLayout.length > 0) {
      sel.call(zoom.transform, initialTransform);
    }
    return () => {
      sel.on(".zoom", null);
    };
  }, [hexLayout, initialTransform, draw]);

  // ----------------------------------------------------------
  // Hover detection
  // ----------------------------------------------------------
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const t = transformRef.current;
      const mx = (e.clientX - rect.left - t.x) / t.k;
      const my = (e.clientY - rect.top - t.y) / t.k;
      const hs = hexSizeRef.current;

      let closest: HexPos | null = null;
      let minD = hs * 1.2;
      for (const h of hexLayoutRef.current) {
        const dx = h.px - mx;
        const dy = h.py - my;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < minD) {
          minD = d;
          closest = h;
        }
      }

      if (closest) {
        setTooltip({
          hex: closest,
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        });
      } else {
        setTooltip(null);
      }
    },
    [],
  );

  // ----------------------------------------------------------
  // Click: select reference hex for distance overlay
  // ----------------------------------------------------------
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (aggDist > 0) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const t = transformRef.current;
      const mx = (e.clientX - rect.left - t.x) / t.k;
      const my = (e.clientY - rect.top - t.y) / t.k;
      const hs = hexSizeRef.current;
      const layout = hexLayoutRef.current;

      let closestIdx: number | null = null;
      let minD = hs * 1.2;
      for (let i = 0; i < layout.length; i++) {
        const dx = layout[i].px - mx;
        const dy = layout[i].py - my;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < minD) { minD = d; closestIdx = i; }
      }

      if (closestIdx === null || closestIdx === selectedHexIdxRef.current) {
        setSelectedHexIdx(null);
      } else {
        setSelectedHexIdx(closestIdx);
      }
    },
    [aggDist],
  );

  // ----------------------------------------------------------
  // Tuner toggle
  // ----------------------------------------------------------
  const toggleTuner = useCallback((tuner: TunerType) => {
    setEnabledTuners((prev) => {
      const next = new Set(prev);
      if (next.has(tuner)) {
        if (next.size > 1) next.delete(tuner);
      } else {
        next.add(tuner);
      }
      return next;
    });
  }, []);

  // ----------------------------------------------------------
  // Render
  // ----------------------------------------------------------
  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-500">
        Error: {error}
      </div>
    );
  }

  const showOverlay = loading || computing;

  return (
    <div className="flex h-full gap-4">
      {/* Canvas */}
      <div className="flex-1 relative border border-base-300 rounded-lg overflow-hidden bg-gray-950">
        {showOverlay && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-950/80 z-10">
            <span className="loading loading-spinner loading-lg text-primary" />
            <p className="ml-3 text-sm text-gray-400">
              {loading ? status : "Computing layout…"}
            </p>
          </div>
        )}

        <canvas
          ref={canvasRef}
          width={canvasW}
          height={canvasH}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setTooltip(null)}
          onClick={handleClick}
          style={{ cursor: "crosshair" }}
        />

        {tooltip && (
          <div
            className="absolute pointer-events-none bg-gray-900 text-white text-xs rounded-lg px-3 py-2 shadow-lg border border-gray-700 z-20"
            style={{
              left: tooltip.x + 14,
              top: tooltip.y - 8,
              maxWidth: 280,
            }}
          >
            {tooltip.hex.count != null ? (
              <>
                <div className="font-bold mb-1">
                  Cluster #{tooltip.hex.id} ({tooltip.hex.count} trials)
                </div>
                <div>Avg Coverage: {(tooltip.hex.coverage * 100).toFixed(1)}%</div>
                {tooltip.hex.tunerCounts && (
                  <div className="mt-1 space-y-0.5">
                    {Object.entries(tooltip.hex.tunerCounts)
                      .sort((a, b) => b[1] - a[1])
                      .map(([tuner, cnt]) => (
                        <div key={tuner} className="flex items-center gap-1">
                          <span
                            className="inline-block w-2 h-2 rounded-full"
                            style={{ backgroundColor: TUNER_COLORS[tuner as TunerType] }}
                          />
                          <span>{tuner}</span>
                          <span className="text-gray-400 ml-auto">
                            {cnt} ({((cnt / tooltip.hex.count!) * 100).toFixed(0)}%)
                          </span>
                        </div>
                      ))}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="font-bold mb-1">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full mr-1.5"
                    style={{
                      backgroundColor: TUNER_COLORS[tooltip.hex.tuner],
                    }}
                  />
                  {tooltip.hex.tuner} — Trial #{tooltip.hex.id}
                </div>
                <div>Coverage: {(tooltip.hex.coverage * 100).toFixed(1)}%</div>
                <div>
                  Marginal: {(tooltip.hex.marginalCoverage * 100).toFixed(2)}%
                </div>
                {distanceMap && (() => {
                  const idx = hexLayout.indexOf(tooltip.hex);
                  const dist = idx >= 0 ? distanceMap[idx] : null;
                  return dist != null ? (
                    <div className="mt-1 pt-1 border-t border-gray-600">
                      Param diff: <span className="font-bold">{dist}</span> / {sampled[0]?.params.length ?? 0}
                    </div>
                  ) : null;
                })()}
              </>
            )}
          </div>
        )}

        {!showOverlay && (
          <div className="absolute top-3 left-3 bg-gray-900/80 text-gray-300 text-xs rounded px-2 py-1">
            {hexLayout.length.toLocaleString()} hexes
            {aggDist > 0 && ` (${stats.totalNodes.toLocaleString()} trials)`}
          </div>
        )}

        {/* Distance legend */}
        {distanceMap && selectedHexIdx !== null && (
          <div className="absolute bottom-3 left-3 bg-gray-900/90 text-white text-xs rounded-lg px-3 py-2 border border-gray-700 z-20">
            <div className="font-semibold mb-1.5">
              Parameter Differences from Trial #{hexLayout[selectedHexIdx]?.id}
            </div>
            <div className="flex items-center gap-1.5">
              <span>0</span>
              <div
                className="h-3 flex-1 rounded"
                style={{
                  background: `linear-gradient(to right, ${
                    Array.from({ length: 10 }, (_, i) => {
                      const t = i / 9;
                      return d3.interpolateYlOrRd(t);
                    }).join(", ")
                  })`,
                  minWidth: 120,
                }}
              />
              <span>{maxDist}</span>
            </div>
            <div className="text-gray-400 mt-1">
              {sampled[0]?.params.length ?? 0} params total — click hex or empty space to clear
            </div>
          </div>
        )}
      </div>

      {/* Side panel */}
      <div className="w-[260px] flex flex-col gap-3 overflow-y-auto text-sm">
        {/* Sample size */}
        <div className="bg-base-200 rounded-lg p-3">
          <div className="font-semibold mb-2">Sample Size</div>
          <input
            type="range"
            min={200}
            max={allNodes.length || 8800}
            step={200}
            value={sampleSize}
            onChange={(e) => setSampleSize(Number(e.target.value))}
            className="range range-xs range-primary w-full"
          />
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>200</span>
            <span className="font-medium text-gray-300">
              {sampleSize.toLocaleString()}
            </span>
            <span>{(allNodes.length || 8800).toLocaleString()}</span>
          </div>
        </div>

        {/* Aggregation Distance */}
        <div className="bg-base-200 rounded-lg p-3">
          <div className="font-semibold mb-2">Aggregation Distance</div>
          <input
            type="range"
            min={0}
            max={featureConfig ? featureConfig.length : 30}
            step={1}
            value={aggDist}
            onChange={(e) => setAggDist(Number(e.target.value))}
            className="range range-xs range-secondary w-full"
          />
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>0 (off)</span>
            <span className="font-medium text-gray-300">
              {aggDist === 0 ? "Individual" : aggDist}
            </span>
            <span>{featureConfig ? featureConfig.length : 30}</span>
          </div>
        </div>

        {/* Layout Method */}
        <div className="bg-base-200 rounded-lg p-3">
          <div className="font-semibold mb-2">Layout Method</div>
          <div className="flex gap-1">
            {(
              [
                { key: 'spectral', label: 'Spectral' },
                { key: 'mds', label: 'MDS' },
                { key: 'umap', label: 'UMAP' },
                { key: 'hamming', label: 'Hamming' },
              ] as const
            ).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setLayoutMethod(key)}
                className={`flex-1 px-2 py-1.5 rounded text-xs font-medium transition-all ${
                  layoutMethod === key
                    ? "bg-primary text-primary-content"
                    : "bg-base-100 text-gray-400 hover:text-gray-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="text-xs text-gray-500 mt-1.5">
            {layoutMethod === 'spectral' && "Graph Laplacian eigenvectors — preserves cluster structure"}
            {layoutMethod === 'mds' && "Multidimensional scaling — preserves pairwise distances"}
            {layoutMethod === 'umap' && "Uniform manifold approximation — preserves local neighborhoods"}
            {layoutMethod === 'hamming' && "Calibrated MDS — 1 hex step ≈ 1 parameter difference"}
          </div>
        </div>

        {/* Tuners */}
        <div className="bg-base-200 rounded-lg p-3">
          <div className="font-semibold mb-2">Tuners</div>
          <div className="flex flex-col gap-1.5">
            {TUNER_NAMES.map((tuner) => (
              <button
                key={tuner}
                onClick={() => toggleTuner(tuner)}
                className={`flex items-center gap-2 px-2 py-1 rounded text-xs transition-all ${
                  enabledTuners.has(tuner) ? "bg-base-100" : "opacity-40"
                }`}
              >
                <span
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: TUNER_COLORS[tuner] }}
                />
                <span className="flex-1 text-left">{tuner}</span>
                <span className="text-gray-500">
                  {stats.tunerCounts[tuner] ?? 0}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Stats */}
        <div className="bg-base-200 rounded-lg p-3">
          <div className="font-semibold mb-2">Statistics</div>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-gray-500">Nodes</span>
              <span>{stats.totalNodes.toLocaleString()}</span>
            </div>
          </div>
        </div>

        {/* Selected Features / Parameters */}
        <div className="bg-base-200 rounded-lg p-3">
          {featureConfig ? (
            <>
              <div className="font-semibold mb-2">
                Selected Features ({featureConfig.length})
              </div>
              <div className="space-y-1.5 text-xs">
                {featureConfig.map((f) => (
                  <div key={f.name}>
                    <div className="flex justify-between text-gray-400 mb-0.5">
                      <span className="truncate">{f.name}</span>
                      <span className="text-gray-500 ml-1 flex-shrink-0">
                        {(f.importance * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div className="w-full bg-gray-700 rounded-full h-1.5">
                      <div
                        className="bg-indigo-500 h-1.5 rounded-full"
                        style={{ width: `${Math.max(2, f.importance * 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="font-semibold mb-2">
                Parameters ({paramNames.length})
              </div>
              <div className="max-h-40 overflow-y-auto text-xs text-gray-500 space-y-0.5">
                {paramNames.map((p) => (
                  <div key={p} className="truncate">
                    {p}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
