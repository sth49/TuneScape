/**
 * Hexagonal Tile Map Visualization
 *
 * - 8,800 trials clustered into ~100 groups
 * - Each hexagon = one cluster
 * - Similar clusters placed nearby (MDS)
 * - Hex color shows tuner distribution
 */

import React, { useState, useEffect, useMemo, useCallback } from "react";
import type { ProcessedData } from "../types/data";
import {
  processHexMapData,
  getHexPath,
  getDominantTuner,
  getTunerRatios,
  TUNER_COLORS,
  TUNER_NAMES,
  type HexMapData,
  type HexTile,
  type Cluster,
  type TunerType,
} from "../utils/hexMapUtils";

// ============================================================
// Types
// ============================================================

type ColorMode = "dominant" | "pie" | "coverage" | "density" | "territory";

interface HexMapProps {
  width?: number;
  height?: number;
  program?: string;
}

interface TooltipData {
  tile: HexTile;
  x: number;
  y: number;
}

// ============================================================
// Constants
// ============================================================

const TUNER_DISPLAY_NAMES: Record<TunerType, string> = {
  SymTuner: "SymTuner",
  CMA_ES: "CMA-ES",
  Genetic: "Genetic",
  SuccessiveHalving: "Succ. Halving",
};

const HEX_SIZE = 32;

// ============================================================
// Component
// ============================================================

export function HexMap({
  width = 900,
  height = 750,
  program = "gawk",
}: HexMapProps) {
  const [data, setData] = useState<HexMapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [colorMode, setColorMode] = useState<ColorMode>("pie");
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [hoveredTile, setHoveredTile] = useState<HexTile | null>(null);
  const [selectedTile, setSelectedTile] = useState<HexTile | null>(null);
  const [selectedTuners, setSelectedTuners] = useState<Set<TunerType>>(
    new Set(TUNER_NAMES),
  );
  const [numClusters, setNumClusters] = useState<number>(100);

  // Load data
  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        // Load all tuner files
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

        const tunerData: ProcessedData[] = responses;

        // Load SHAP importance
        const decisionTreeData = await fetch(
          "/data/decision_tree_data.json",
        ).then((r) => r.json());
        const shapImportance =
          decisionTreeData[program]?.SymTuner?.param_importance || [];

        if (cancelled) return;

        // Process data
        const mapData = processHexMapData(
          tunerData,
          shapImportance,
          numClusters,
        );

        setData(mapData);
        setLoading(false);
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
  }, [program, numClusters]);

  // Compute transform to fit and center the honeycomb
  const { centerX, centerY, scale } = useMemo(() => {
    if (!data || data.hexTiles.length === 0) {
      return {
        centerX: (width - 220) / 2,
        centerY: (height - 60) / 2,
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
    const dataCenterX = (minX + maxX) / 2;
    const dataCenterY = (minY + maxY) / 2;

    const svgWidth = width - 240;
    const svgHeight = height - 80;

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

  // Get hex fill
  const getHexFill = useCallback(
    (tile: HexTile): string | null => {
      if (!tile.cluster) return "#F1F5F9";

      const { tunerCounts, totalTrials, avgCoverage } = tile.cluster;

      switch (colorMode) {
        case "dominant": {
          const dominant = getDominantTuner(tunerCounts);
          return TUNER_COLORS[dominant];
        }

        case "coverage": {
          // Green gradient based on coverage
          const intensity = Math.min(1, avgCoverage);
          const r = Math.round(220 - intensity * 180);
          const g = Math.round(220 + intensity * 35);
          const b = Math.round(220 - intensity * 140);
          return `rgb(${r}, ${g}, ${b})`;
        }

        case "density": {
          // Size-based (darker = more trials)
          const maxTrials = data
            ? Math.max(...data.clusters.map((c) => c.totalTrials))
            : 1;
          const intensity = totalTrials / maxTrials;
          const gray = Math.round(240 - intensity * 180);
          return `rgb(${gray}, ${gray}, ${gray})`;
        }

        case "territory": {
          // Neutral light fill - boundaries show the tuner colors
          return "#F8FAFC";
        }

        case "pie":
        default:
          return null; // Will draw pie
      }
    },
    [colorMode, data],
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

  // Get dominant tuner for a tile
  const getTileDominantTuner = useCallback(
    (tile: HexTile | undefined): TunerType | null => {
      if (!tile?.cluster) return null;
      return getDominantTuner(tile.cluster.tunerCounts);
    },
    [],
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

  // Get tuners present in a tile
  const getTileTuners = useCallback(
    (tile: HexTile | undefined): Set<TunerType> => {
      const tuners = new Set<TunerType>();
      if (!tile?.cluster) return tuners;
      for (const t of TUNER_NAMES) {
        if (tile.cluster.tunerCounts[t] > 0) {
          tuners.add(t);
        }
      }
      return tuners;
    },
    [],
  );

  // Render territory boundaries for all tiles
  const renderTerritoryBoundaries = useMemo(() => {
    if (!data || colorMode !== "territory") return null;

    const vertices = getHexVertices(HEX_SIZE);
    const boundaryEdges: React.ReactElement[] = [];

    for (const tile of data.hexTiles) {
      if (!tile.cluster) continue;

      const tileTuners = getTileTuners(tile);

      // Check each of 6 edges
      for (let edgeIdx = 0; edgeIdx < 6; edgeIdx++) {
        const dir = HEX_DIRECTIONS[edgeIdx];
        const neighborKey = `${tile.q + dir.dq},${tile.r + dir.dr}`;
        const neighbor = hexLookup.get(neighborKey);
        const neighborTuners = getTileTuners(neighbor);

        // Find tuners that are in this tile but NOT in neighbor
        const boundaryTuners: TunerType[] = [];
        for (const tuner of TUNER_NAMES) {
          if (
            tileTuners.has(tuner) &&
            !neighborTuners.has(tuner) &&
            selectedTuners.has(tuner)
          ) {
            boundaryTuners.push(tuner);
          }
        }

        if (boundaryTuners.length === 0) continue;

        const v1 = vertices[edgeIdx];
        const v2 = vertices[(edgeIdx + 1) % 6];

        // Calculate edge direction for offset
        const dx = v2.x - v1.x;
        const dy = v2.y - v1.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        // Normal vector pointing inward
        const nx = -dy / len;
        const ny = dx / len;

        // Draw multiple parallel lines for each tuner
        const lineWidth = 3;
        const totalWidth = boundaryTuners.length * lineWidth;
        const startOffset = -(totalWidth - lineWidth) / 2;

        boundaryTuners.forEach((tuner, idx) => {
          const offset = startOffset + idx * lineWidth;
          boundaryEdges.push(
            <line
              key={`${tile.q},${tile.r}-edge${edgeIdx}-${tuner}`}
              x1={tile.x + v1.x + nx * offset}
              y1={tile.y + v1.y + ny * offset}
              x2={tile.x + v2.x + nx * offset}
              y2={tile.y + v2.y + ny * offset}
              stroke={TUNER_COLORS[tuner]}
              strokeWidth={lineWidth}
              strokeLinecap="round"
            />,
          );
        });
      }
    }

    return <g>{boundaryEdges}</g>;
  }, [
    data,
    colorMode,
    hexLookup,
    getTileTuners,
    selectedTuners,
    HEX_DIRECTIONS,
    getHexVertices,
  ]);

  // Draw donut chart in hex (prettier pie chart)
  const renderPieHex = useCallback(
    (tile: HexTile) => {
      if (!tile.cluster) return null;

      const ratios = getTunerRatios(tile.cluster.tunerCounts);
      const tuners = TUNER_NAMES.filter(
        (t) => selectedTuners.has(t) && ratios[t] > 0,
      );

      if (tuners.length === 0) return null;

      // Recalculate ratios for selected tuners only
      const selectedTotal = tuners.reduce(
        (sum, t) => sum + tile.cluster!.tunerCounts[t],
        0,
      );
      if (selectedTotal === 0) return null;

      const paths: React.ReactElement[] = [];
      const outerR = HEX_SIZE * 0.82;
      const innerR = HEX_SIZE * 0.35; // Donut hole
      const gapAngle = tuners.length > 1 ? 0.04 : 0; // Small gap between slices

      let startAngle = -Math.PI / 2;

      for (const tuner of tuners) {
        const ratio = tile.cluster!.tunerCounts[tuner] / selectedTotal;
        if (ratio <= 0) continue;

        const sliceAngle = ratio * 2 * Math.PI;
        const adjustedStart = startAngle + gapAngle / 2;
        const adjustedEnd = startAngle + sliceAngle - gapAngle / 2;
        const largeArc = sliceAngle > Math.PI ? 1 : 0;

        if (tuners.length === 1 || ratio > 0.99) {
          // Full donut ring
          paths.push(
            <g key={tuner}>
              <circle r={outerR} fill={TUNER_COLORS[tuner]} />
              <circle r={innerR} fill="#F8FAFC" />
            </g>,
          );
        } else {
          // Outer arc points
          const ox1 = outerR * Math.cos(adjustedStart);
          const oy1 = outerR * Math.sin(adjustedStart);
          const ox2 = outerR * Math.cos(adjustedEnd);
          const oy2 = outerR * Math.sin(adjustedEnd);

          // Inner arc points
          const ix1 = innerR * Math.cos(adjustedStart);
          const iy1 = innerR * Math.sin(adjustedStart);
          const ix2 = innerR * Math.cos(adjustedEnd);
          const iy2 = innerR * Math.sin(adjustedEnd);

          // Donut slice path: outer arc -> line to inner -> inner arc (reverse) -> line to start
          const d = [
            `M${ox1},${oy1}`,
            `A${outerR},${outerR} 0 ${largeArc},1 ${ox2},${oy2}`,
            `L${ix2},${iy2}`,
            `A${innerR},${innerR} 0 ${largeArc},0 ${ix1},${iy1}`,
            "Z",
          ].join(" ");

          paths.push(
            <path
              key={tuner}
              d={d}
              fill={TUNER_COLORS[tuner]}
              stroke="white"
              strokeWidth={0.5}
            />,
          );
        }

        startAngle += sliceAngle;
      }

      // Encode trial count as center circle color
      const maxTrials = 200; // Normalize against this
      const intensity = Math.min(1, tile.cluster.totalTrials / maxTrials);

      // Light purple to dark purple gradient
      const r = Math.round(248 - intensity * 120);
      const g = Math.round(250 - intensity * 150);
      const b = Math.round(252 - intensity * 80);
      const centerColor = `rgb(${r}, ${g}, ${b})`;

      return (
        <g>
          {paths}
          <circle r={innerR - 1} fill={centerColor} />
        </g>
      );
    },
    [selectedTuners],
  );

  // Mouse handlers
  const handleMouseEnter = useCallback((tile: HexTile, e: React.MouseEvent) => {
    if (!tile.cluster) return;
    setHoveredTile(tile);
    setTooltip({
      tile,
      x: e.clientX,
      y: e.clientY,
    });
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (tooltip) {
        setTooltip((prev) =>
          prev ? { ...prev, x: e.clientX, y: e.clientY } : null,
        );
      }
    },
    [tooltip],
  );

  const handleMouseLeave = useCallback(() => {
    setHoveredTile(null);
    setTooltip(null);
  }, []);

  const handleClick = useCallback((tile: HexTile) => {
    if (!tile.cluster) return;
    setSelectedTile((prev) => (prev === tile ? null : tile));
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
    <div style={{ position: "relative" }}>
      {/* Title */}
      <div
        style={{
          marginBottom: 12,
          display: "flex",
          alignItems: "center",
          gap: 16,
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

      <div style={{ display: "flex", gap: 20 }}>
        {/* SVG Map */}
        <svg width={width - 220} height={height - 60}>
          <g
            transform={`translate(${centerX}, ${centerY}) scale(${scale}) translate(${-dataCenter.x}, ${-dataCenter.y})`}
          >
            {data.hexTiles.map((tile) => {
              if (!tile.cluster) return null; // Skip empty tiles

              const fill = getHexFill(tile);
              const isHovered = hoveredTile === tile;

              const isSelected = selectedTile === tile;

              return (
                <g
                  key={`${tile.q},${tile.r}`}
                  transform={`translate(${tile.x}, ${tile.y})`}
                  onMouseEnter={(e) => handleMouseEnter(tile, e)}
                  onMouseMove={handleMouseMove}
                  onMouseLeave={handleMouseLeave}
                  onClick={() => handleClick(tile)}
                  style={{ cursor: "pointer" }}
                >
                  {/* Hex background */}
                  <path
                    d={hexPath}
                    fill={fill || "#F8FAFC"}
                    stroke={
                      isSelected ? "#4F46E5" : isHovered ? "#1E293B" : "#E2E8F0"
                    }
                    strokeWidth={isSelected ? 3 : isHovered ? 2.5 : 0.5}
                  />

                  {/* Pie chart if mode is pie */}
                  {colorMode === "pie" && renderPieHex(tile)}
                </g>
              );
            })}

            {/* Territory boundaries (drawn on top) */}
            {renderTerritoryBoundaries}
          </g>
        </svg>

        {/* Side panel */}
        <div style={{ width: 200, fontSize: 12 }}>
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
                  { mode: "pie", label: "Tuner Ratio (Pie)" },
                  { mode: "territory", label: "Tuner Territory" },
                  { mode: "dominant", label: "Dominant Tuner" },
                  { mode: "coverage", label: "Avg Coverage" },
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

          {/* Legend */}
          {colorMode === "coverage" && (
            <div style={{ marginBottom: 20 }}>
              <div
                style={{ fontWeight: 600, marginBottom: 8, color: "#374151" }}
              >
                Coverage
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: 10, color: "#9CA3AF" }}>0%</span>
                <div
                  style={{
                    flex: 1,
                    height: 12,
                    borderRadius: 2,
                    background: "linear-gradient(to right, #dcdcdc, #40E0D0)",
                  }}
                />
                <span style={{ fontSize: 10, color: "#9CA3AF" }}>100%</span>
              </div>
            </div>
          )}

          {colorMode === "density" && (
            <div style={{ marginBottom: 20 }}>
              <div
                style={{ fontWeight: 600, marginBottom: 8, color: "#374151" }}
              >
                Density
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: 10, color: "#9CA3AF" }}>Few</span>
                <div
                  style={{
                    flex: 1,
                    height: 12,
                    borderRadius: 2,
                    background: "linear-gradient(to right, #f0f0f0, #3c3c3c)",
                  }}
                />
                <span style={{ fontSize: 10, color: "#9CA3AF" }}>Many</span>
              </div>
            </div>
          )}

          {/* {colorMode === "territory" && (
            <div style={{ marginBottom: 20 }}>
              <div
                style={{ fontWeight: 600, marginBottom: 8, color: "#374151" }}
              >
                Territory Legend
              </div>
              <div style={{ fontSize: 10, color: "#6B7280", lineHeight: 1.6 }}>
                {/* <p>경계선 = 해당 튜너가 탐색한 영역의 끝</p>
                <p style={{ marginTop: 4 }}>여러 색상 = 여러 튜너가 같이 탐색한 영역</p>
                <p style={{ marginTop: 4 }}>경계선 없음 = 인접한 곳도 같은 튜너가 탐색</p> 
              </div>
            </div>
          )} */}

          {/* Density legend for pie mode */}
          {colorMode === "pie" && (
            <div style={{ marginBottom: 20 }}>
              <div
                style={{ fontWeight: 600, marginBottom: 8, color: "#374151" }}
              >
                Center = Density
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: 10, color: "#9CA3AF" }}>Few</span>
                <div
                  style={{
                    flex: 1,
                    height: 12,
                    borderRadius: 2,
                    background: "linear-gradient(to right, #f8fafc, #806496)",
                  }}
                />
                <span style={{ fontSize: 10, color: "#9CA3AF" }}>Many</span>
              </div>
            </div>
          )}

          {/* Info */}
          <div style={{ fontSize: 10, color: "#9CA3AF", lineHeight: 1.5 }}>
            <p>Each hexagon = cluster of similar trials</p>
            <p>Nearby hexagons = similar parameter combinations</p>
            <p style={{ marginTop: 4, fontWeight: 500 }}>
              Click a hexagon for details
            </p>
          </div>

          {/* Selected cluster detail panel */}
          {selectedTile?.cluster && (
            <div
              style={{
                marginTop: 20,
                padding: 12,
                background: "#F8FAFC",
                borderRadius: 8,
                border: "1px solid #E2E8F0",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 12,
                }}
              >
                <div style={{ fontWeight: 600, color: "#1E293B" }}>
                  Cluster #{selectedTile.cluster.id + 1}
                </div>
                <button
                  onClick={() => setSelectedTile(null)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    fontSize: 16,
                    color: "#94A3B8",
                  }}
                >
                  ×
                </button>
              </div>

              {/* Basic stats */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                  marginBottom: 12,
                }}
              >
                <div
                  style={{ background: "white", padding: 8, borderRadius: 4 }}
                >
                  <div style={{ fontSize: 10, color: "#6B7280" }}>Trials</div>
                  <div
                    style={{ fontSize: 16, fontWeight: 600, color: "#1E293B" }}
                  >
                    {selectedTile.cluster.totalTrials}
                  </div>
                </div>
                <div
                  style={{ background: "white", padding: 8, borderRadius: 4 }}
                >
                  <div style={{ fontSize: 10, color: "#6B7280" }}>
                    Avg Marginal
                  </div>
                  <div
                    style={{ fontSize: 16, fontWeight: 600, color: "#10B981" }}
                  >
                    {selectedTile.cluster.avgCoverage.toFixed(1)}
                  </div>
                </div>
              </div>

              {/* Tuner distribution */}
              <div style={{ marginBottom: 12 }}>
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
                {TUNER_NAMES.map((tuner) => {
                  const count = selectedTile.cluster!.tunerCounts[tuner];
                  const ratio = count / selectedTile.cluster!.totalTrials;
                  return (
                    <div key={tuner} style={{ marginBottom: 4 }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: 10,
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
                          height: 6,
                          background: "#E5E7EB",
                          borderRadius: 3,
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            width: `${ratio * 100}%`,
                            background: TUNER_COLORS[tuner],
                            borderRadius: 3,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Key parameters (centroid) */}
              <div>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: "#374151",
                    marginBottom: 6,
                  }}
                >
                  Key Parameters (Centroid)
                </div>
                <div
                  style={{ fontSize: 10, color: "#6B7280", lineHeight: 1.6 }}
                >
                  {Object.entries(selectedTile.cluster.centroid)
                    .slice(0, 6)
                    .map(([param, value]) => (
                      <div
                        key={param}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                        }}
                      >
                        <span style={{ color: "#374151" }}>{param}</span>
                        <span style={{ fontFamily: "monospace" }}>
                          {typeof value === "number"
                            ? value.toFixed(2)
                            : String(value)}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && tooltip.tile.cluster && (
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
            Cluster #{tooltip.tile.cluster.id + 1}
          </div>
          <div style={{ marginBottom: 8 }}>
            <span style={{ color: "#6B7280" }}>Trials: </span>
            <span style={{ fontWeight: 500 }}>
              {tooltip.tile.cluster.totalTrials}
            </span>
            <span style={{ color: "#6B7280", marginLeft: 12 }}>
              Avg Marginal:{" "}
            </span>
            <span style={{ fontWeight: 500, color: "#10B981" }}>
              {tooltip.tile.cluster.avgCoverage.toFixed(1)}
            </span>
          </div>
          <div style={{ borderTop: "1px solid #E5E7EB", paddingTop: 8 }}>
            <div style={{ fontWeight: 500, marginBottom: 4, color: "#374151" }}>
              Tuner Distribution
            </div>
            {TUNER_NAMES.map((tuner) => {
              const count = tooltip.tile.cluster!.tunerCounts[tuner];
              const ratio = count / tooltip.tile.cluster!.totalTrials;
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
