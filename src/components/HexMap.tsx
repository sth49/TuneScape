/**
 * Hexagonal Tile Map Visualization
 *
 * - 8,800 trials clustered into ~100 groups
 * - Each hexagon = one cluster
 * - Similar clusters placed nearby (MDS)
 * - Hex color shows tuner distribution
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import * as d3 from "d3";
import textures from "textures";
import type { ProcessedData } from "../types/data";
import {
  processHexMapData,
  getHexPath,
  getDominantTuner,
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

type ColorMode = "dominant" | "territory" | "pixel" | "hatching" | "density";
type LayoutMode = "hex" | "map";

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

interface VoronoiCell {
  cluster: Cluster;
  cx: number;
  cy: number;
  pathD: string;          // compound path of all sub-cell polygons
  polygon: [number, number][];  // all vertices from all sub-cells
  outlineD: string;       // same as pathD
  subCellPaths: string[];  // individual sub-cell polygon paths
}


interface Territory {
  id: number;
  clusters: Cluster[];
  tiles: HexTile[];
  totalTrials: number;
  tunerCounts: Record<TunerType, number>;
  centroidX: number;  // pixel centroid
  centroidY: number;
}

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
function noisyPolygon(vertices: [number, number][], seed: number, depth = 3): string {
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
      let cx = 0, cy = 0, area = 0;
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

  const [colorMode, setColorMode] = useState<ColorMode>("pixel");
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("hex");
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [hoveredTile, setHoveredTile] = useState<HexTile | null>(null);
  const [selectedTile, setSelectedTile] = useState<HexTile | null>(null);

  const [selectedTuners, setSelectedTuners] = useState<Set<TunerType>>(
    new Set(TUNER_NAMES),
  );
  const [numClusters, setNumClusters] = useState<number>(100);

  const svgRef = useRef<SVGSVGElement>(null);


  // Create diverse texture instances - each tuner gets a distinct pattern type
  const textureInstances = useMemo(() => {
    const instances: Record<string, { url(): string; (sel: any): void }> = {};

    // SymTuner: diagonal hatching lines
    instances.SymTuner = textures
      .lines()
      .id("hatch-SymTuner")
      .orientation("diagonal")
      .size(8)
      .strokeWidth(2.5)
      .stroke(TUNER_COLORS.SymTuner);

    // CMA_ES: dot / circle pattern
    instances.CMA_ES = textures
      .circles()
      .id("hatch-CMA_ES")
      .size(10)
      .radius(3)
      .fill(TUNER_COLORS.CMA_ES)
      .complement();

    // Genetic: cross pattern
    instances.Genetic = textures
      .paths()
      .id("hatch-Genetic")
      .d("crosses")
      .size(10)
      .strokeWidth(2)
      .stroke(TUNER_COLORS.Genetic);

    // SuccessiveHalving: wave pattern
    instances.SuccessiveHalving = textures
      .paths()
      .id("hatch-SuccessiveHalving")
      .d("waves")
      .size(10)
      .strokeWidth(2)
      .stroke(TUNER_COLORS.SuccessiveHalving);

    return instances;
  }, []);

  // Apply textures to SVG <defs> imperatively
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);

    // Clean up old texture patterns by ID
    for (const tuner of TUNER_NAMES) {
      const existing = svgRef.current.querySelector(`#hatch-${tuner}`);
      if (existing?.parentElement?.tagName.toLowerCase() === "defs") {
        existing.parentElement.remove();
      }
    }

    // Let textures.js inject <defs><pattern>...</pattern></defs> the standard way
    for (const tuner of TUNER_NAMES) {
      svg.call(textureInstances[tuner] as any);
    }
  }, [textureInstances]);

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

  // ============================================================
  // Connected components of occupied hex tiles → territories
  // ============================================================
  const territories = useMemo((): Territory[] => {
    if (!data || data.hexTiles.length === 0) return [];

    // hex neighbor directions (flat-top)
    const dirs = [
      [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1],
    ];

    // Build set of occupied tiles
    const occupied = new Set<string>();
    const tileMap = new Map<string, HexTile>();
    for (const tile of data.hexTiles) {
      if (!tile.cluster) continue;
      const key = `${tile.q},${tile.r}`;
      occupied.add(key);
      tileMap.set(key, tile);
    }

    // BFS for connected components
    const visited = new Set<string>();
    const components: HexTile[][] = [];

    for (const key of occupied) {
      if (visited.has(key)) continue;
      const queue = [key];
      visited.add(key);
      const component: HexTile[] = [];

      while (queue.length > 0) {
        const curr = queue.shift()!;
        component.push(tileMap.get(curr)!);

        const [cq, cr] = curr.split(",").map(Number);
        for (const [dq, dr] of dirs) {
          const nk = `${cq + dq},${cr + dr}`;
          if (occupied.has(nk) && !visited.has(nk)) {
            visited.add(nk);
            queue.push(nk);
          }
        }
      }

      components.push(component);
    }

    // Convert components to territories
    return components.map((tiles, idx) => {
      const clusters = tiles.map(t => t.cluster!);
      let totalTrials = 0;
      const tunerCounts: Record<TunerType, number> = {
        SymTuner: 0, CMA_ES: 0, Genetic: 0, SuccessiveHalving: 0,
      };
      let cx = 0, cy = 0;

      for (const c of clusters) {
        totalTrials += c.totalTrials;
        for (const t of TUNER_NAMES) tunerCounts[t] += c.tunerCounts[t];
        cx += c.x;
        cy += c.y;
      }

      return {
        id: idx,
        clusters,
        tiles,
        totalTrials,
        tunerCounts,
        centroidX: cx / clusters.length,
        centroidY: cy / clusters.length,
      };
    }).filter(t => t.clusters.length > 0)
      .sort((a, b) => b.totalTrials - a.totalTrials);
  }, [data]);

  // ============================================================
  // Voronoi cell computation (map mode)
  // Two levels: territory Voronoi (big continents) + cluster cells inside
  // ============================================================
  const voronoiMapData = useMemo((): VoronoiMapData | null => {
    if (!data || layoutMode !== "map") return null;

    const clusters = data.clusters;
    if (clusters.length === 0) return { cells: [], clusterBorderPaths: [], territoryBorderPaths: [], cellTerritoryIds: [], neighborEdges: [] };

    const svgW = width - 240;
    const svgH = height - 80;
    const pad = 30;

    // MDS coordinates → pixel
    const mdsXs = clusters.map((c) => c.x);
    const mdsYs = clusters.map((c) => c.y);
    const xScale = d3.scaleLinear()
      .domain(d3.extent(mdsXs) as [number, number])
      .range([pad, svgW - pad]);
    const yScale = d3.scaleLinear()
      .domain(d3.extent(mdsYs) as [number, number])
      .range([pad, svgH - pad]);

    // Cluster positions in pixel space
    const clusterPositions: [number, number][] = clusters.map((c) => [
      xScale(c.x), yScale(c.y),
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
      let hcx = 0, hcy = 0;
      for (const [x, y] of hull) { hcx += x; hcy += y; }
      hcx /= hull.length; hcy /= hull.length;
      const ghostOffset = Math.min(svgW, svgH) * 0.15;
      for (let i = 0; i < hull.length; i++) {
        const [x1, y1] = hull[i];
        const [x2, y2] = hull[(i + 1) % hull.length];
        const dx1 = x1 - hcx, dy1 = y1 - hcy;
        const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1) || 1;
        ghostPts.push([x1 + (dx1 / len1) * ghostOffset, y1 + (dy1 / len1) * ghostOffset]);
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        const dxm = mx - hcx, dym = my - hcy;
        const lenm = Math.sqrt(dxm * dxm + dym * dym) || 1;
        ghostPts.push([mx + (dxm / lenm) * ghostOffset, my + (dym / lenm) * ghostOffset]);
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
      const verts: [number, number][] = cellPoly.slice(0, -1) as [number, number][];
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

    const clusterBorderPaths = clusterBorderSegments.map(seg => segToPath(seg, 2));
    const territoryBorderPaths = territoryBorderSegments.map(seg => segToPath(seg, 2));

    return { cells, clusterBorderPaths, territoryBorderPaths, cellTerritoryIds, neighborEdges };
  }, [data, layoutMode, territories, width, height]);

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
          />
        );
      }
    }

    return lines.length > 0 ? <g pointerEvents="none">{lines}</g> : null;
  }, [voronoiMapData, data, selectedTuners]);

  // Tuner territory sizes: how many clusters each tuner occupies → sorted rank
  const tunerTerritoryRank = useMemo(() => {
    if (!data) return new Map<TunerType, number>();
    const sizes: { tuner: TunerType; count: number }[] = TUNER_NAMES.map(tuner => ({
      tuner,
      count: data.clusters.filter(c => c.tunerCounts[tuner] > 0).length,
    }));
    sizes.sort((a, b) => b.count - a.count); // largest first
    const rankMap = new Map<TunerType, number>();
    sizes.forEach((s, i) => rankMap.set(s.tuner, i));
    return rankMap;
  }, [data]);

  // Density color scale: maps totalTrials → color
  const densityScale = useMemo(() => {
    if (!data) return null;
    const trials = data.clusters.map(c => c.totalTrials);
    const maxTrials = d3.max(trials) ?? 1;
    return d3.scaleSequential(d3.interpolateYlOrRd)
      .domain([0, maxTrials]);
  }, [data]);

  // Get hex fill
  const getHexFill = useCallback(
    (tile: HexTile): string | null => {
      if (!tile.cluster) return "#F1F5F9";

      const { tunerCounts } = tile.cluster;

      switch (colorMode) {
        case "dominant": {
          const dominant = getDominantTuner(tunerCounts);
          return TUNER_COLORS[dominant];
        }

        case "density":
          return densityScale ? densityScale(tile.cluster.totalTrials) : "#F8FAFC";

        case "territory":
          return "#F8FAFC";

        case "pixel":
        case "hatching":
        default:
          return "#F8FAFC";
      }
    },
    [colorMode, densityScale],
  );

  // Seeded random for consistent pixel placement
  const seededRandom = useCallback((seed: number) => {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  }, []);

  // Render Pixel Scatter mode
  const renderPixelScatter = useCallback(
    (tile: HexTile) => {
      if (!tile.cluster) return null;

      const filteredCounts: Record<TunerType, number> = {
        SymTuner: selectedTuners.has("SymTuner") ? tile.cluster.tunerCounts.SymTuner : 0,
        CMA_ES: selectedTuners.has("CMA_ES") ? tile.cluster.tunerCounts.CMA_ES : 0,
        Genetic: selectedTuners.has("Genetic") ? tile.cluster.tunerCounts.Genetic : 0,
        SuccessiveHalving: selectedTuners.has("SuccessiveHalving") ? tile.cluster.tunerCounts.SuccessiveHalving : 0,
      };
      const total = Object.values(filteredCounts).reduce((a, b) => a + b, 0);
      if (total === 0) return null;

      const dots: React.ReactElement[] = [];
      const numDots = 60;
      const radius = HEX_SIZE * 0.75;

      // Create color pool based on ratios
      const colorPool: string[] = [];
      for (const tuner of TUNER_NAMES) {
        const count = Math.round((filteredCounts[tuner] / total) * numDots);
        for (let i = 0; i < count; i++) {
          colorPool.push(TUNER_COLORS[tuner]);
        }
      }

      // Shuffle with seeded random
      const seed = tile.q * 1000 + tile.r;
      for (let i = colorPool.length - 1; i > 0; i--) {
        const j = Math.floor(seededRandom(seed + i) * (i + 1));
        [colorPool[i], colorPool[j]] = [colorPool[j], colorPool[i]];
      }

      // Place dots in hex shape
      for (let i = 0; i < Math.min(colorPool.length, numDots); i++) {
        const angle = seededRandom(seed + i * 100) * Math.PI * 2;
        const r = Math.sqrt(seededRandom(seed + i * 200)) * radius;
        const x = r * Math.cos(angle);
        const y = r * Math.sin(angle);

        // Check if inside hexagon
        const hexRadius = HEX_SIZE * 0.85;
        const ax = Math.abs(x);
        const ay = Math.abs(y);
        if (ax <= hexRadius && ay <= hexRadius * 0.866 && ax + ay * 0.577 <= hexRadius) {
          dots.push(
            <circle
              key={i}
              cx={x}
              cy={y}
              r={3}
              fill={colorPool[i]}
              opacity={0.85}
            />
          );
        }
      }

      return <g>{dots}</g>;
    },
    [selectedTuners, seededRandom],
  );

  // Render Hatching mode (using textures.js patterns)
  const renderHatching = useCallback(
    (tile: HexTile) => {
      if (!tile.cluster) return null;

      const filteredCounts: Record<TunerType, number> = {
        SymTuner: selectedTuners.has("SymTuner") ? tile.cluster.tunerCounts.SymTuner : 0,
        CMA_ES: selectedTuners.has("CMA_ES") ? tile.cluster.tunerCounts.CMA_ES : 0,
        Genetic: selectedTuners.has("Genetic") ? tile.cluster.tunerCounts.Genetic : 0,
        SuccessiveHalving: selectedTuners.has("SuccessiveHalving") ? tile.cluster.tunerCounts.SuccessiveHalving : 0,
      };
      const total = Object.values(filteredCounts).reduce((a, b) => a + b, 0);
      if (total === 0) return null;

      return (
        <g>
          {TUNER_NAMES.filter(t => filteredCounts[t] / total >= 0.05).map(tuner => {
            const ratio = filteredCounts[tuner] / total;
            return (
              <path
                key={tuner}
                d={hexPath}
                fill={textureInstances[tuner].url()}
                opacity={Math.min(1, ratio + 0.3)}
              />
            );
          })}
        </g>
      );
    },
    [selectedTuners, hexPath, textureInstances],
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

  // Territory fills + borders: scaled hex fills, bridge quads between neighbors, boundary lines
  const territoryScaleFactors = useMemo(() => [1.0, 0.82, 0.64, 0.50], []);
  const renderTerritoryFillsAndBorders = useMemo(() => {
    if (!data || colorMode !== "territory") return null;

    const verticesByRank = territoryScaleFactors.map(s => getHexVertices(HEX_SIZE * s));
    const fillElements: React.ReactElement[] = [];
    const borderElements: React.ReactElement[] = [];

    // Sort tuners by rank (largest territory first → drawn at back)
    const sortedTuners = TUNER_NAMES
      .filter(t => selectedTuners.has(t))
      .sort((a, b) => (tunerTerritoryRank.get(a) ?? 0) - (tunerTerritoryRank.get(b) ?? 0));

    for (const tuner of sortedTuners) {
      const rank = tunerTerritoryRank.get(tuner) ?? 0;
      const sv = verticesByRank[rank];

      for (const tile of data.hexTiles) {
        if (!tile.cluster || tile.cluster.tunerCounts[tuner] <= 0) continue;

        // Scaled hex fill
        const hexD = "M" + sv.map(v => `${tile.x + v.x},${tile.y + v.y}`).join("L") + "Z";
        fillElements.push(
          <path
            key={`fill-${tuner}-${tile.q},${tile.r}`}
            d={hexD}
            fill={TUNER_COLORS[tuner]}
            opacity={0.45}
            pointerEvents="none"
          />
        );

        // Check 6 edges for bridges and borders
        for (let edgeIdx = 0; edgeIdx < 6; edgeIdx++) {
          const dir = HEX_DIRECTIONS[edgeIdx];
          const neighborKey = `${tile.q + dir.dq},${tile.r + dir.dr}`;
          const neighbor = hexLookup.get(neighborKey);
          const neighborHasTuner = neighbor?.cluster && neighbor.cluster.tunerCounts[tuner] > 0;

          if (neighborHasTuner) {
            // Bridge quad: connect this tile's scaled edge to neighbor's corresponding scaled edge
            // Only draw once per pair (edgeIdx < 3)
            if (edgeIdx < 3) {
              const vi = sv[edgeIdx];
              const vi1 = sv[(edgeIdx + 1) % 6];
              const bvi3 = sv[(edgeIdx + 3) % 6];
              const bvi4 = sv[(edgeIdx + 4) % 6];

              const quadD = `M${tile.x + vi.x},${tile.y + vi.y}` +
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
                />
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
    colorMode,
    hexLookup,
    selectedTuners,
    tunerTerritoryRank,
    territoryScaleFactors,
    HEX_DIRECTIONS,
    getHexVertices,
  ]);

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
        <svg ref={svgRef} width={width - 220} height={height - 60}>
          {layoutMode === "hex" && (
            /* ===== HEX GRID MODE (unchanged) ===== */
            <g
              transform={`translate(${centerX}, ${centerY}) scale(${scale}) translate(${-dataCenter.x}, ${-dataCenter.y})`}
            >
              {data.hexTiles.map((tile) => {
                if (!tile.cluster) return null;

                const fill = getHexFill(tile);
                const isHovered = hoveredTile === tile;
                const isSelected = selectedTile === tile;
                const tileHexPath = hexPath;

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
                    <path
                      d={tileHexPath}
                      fill={fill || "#F8FAFC"}
                      stroke={
                        isSelected ? "#4F46E5" : isHovered ? "#1E293B" : "#E2E8F0"
                      }
                      strokeWidth={isSelected ? 3 : isHovered ? 2.5 : 0.5}
                    />

                    {colorMode === "pixel" && renderPixelScatter(tile)}
                    {colorMode === "hatching" && renderHatching(tile)}
                  </g>
                );
              })}

              {renderTerritoryFillsAndBorders}
            </g>
          )}

          {layoutMode === "map" && voronoiMapData && (
            /* ===== POLYGON MAP MODE (Standard Voronoi) ===== */
            <g>
              {/* clipPath definitions: each cluster clips to union of its sub-cells */}
              <defs>
                {voronoiMapData.cells.map((cell) => (
                  <clipPath key={`clip-${cell.cluster.id}`} id={`voronoi-clip-${cell.cluster.id}`}>
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
                const isHovered = hoveredTile?.cluster?.id === cell.cluster.id;
                const isSelected = selectedTile?.cluster?.id === cell.cluster.id;

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
                    onClick={() => {
                      if (syntheticTile) handleClick(syntheticTile);
                    }}
                    style={{ cursor: "pointer" }}
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
                    {colorMode === "territory" && (() => {
                      const tc = cell.cluster.tunerCounts;
                      const present = TUNER_NAMES
                        .filter(t => selectedTuners.has(t) && tc[t] > 0)
                        .sort((a, b) => (tunerTerritoryRank.get(a) ?? 0) - (tunerTerritoryRank.get(b) ?? 0));
                      if (present.length === 0) return null;
                      const scaleFactors = [1.0, 0.82, 0.64, 0.50];
                      return present.map(tuner => {
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
                    {isHovered && !isSelected && (
                      <g clipPath={`url(#voronoi-clip-${cell.cluster.id})`} pointerEvents="none">
                        <rect
                          x={Math.min(...xs)} y={Math.min(...ys)}
                          width={bw} height={bh}
                          fill="rgba(0,0,0,0.06)"
                        />
                      </g>
                    )}
                    {isSelected && (
                      <g clipPath={`url(#voronoi-clip-${cell.cluster.id})`} pointerEvents="none">
                        <rect
                          x={Math.min(...xs)} y={Math.min(...ys)}
                          width={bw} height={bh}
                          fill="rgba(79,70,229,0.1)"
                        />
                      </g>
                    )}

                    {/* Overlay modes clipped to cluster shape */}
                    {colorMode === "pixel" && (
                      <g clipPath={`url(#voronoi-clip-${cell.cluster.id})`}>
                        {(() => {
                          const cluster = cell.cluster;
                          const filteredCounts: Record<TunerType, number> = {
                            SymTuner: selectedTuners.has("SymTuner") ? cluster.tunerCounts.SymTuner : 0,
                            CMA_ES: selectedTuners.has("CMA_ES") ? cluster.tunerCounts.CMA_ES : 0,
                            Genetic: selectedTuners.has("Genetic") ? cluster.tunerCounts.Genetic : 0,
                            SuccessiveHalving: selectedTuners.has("SuccessiveHalving") ? cluster.tunerCounts.SuccessiveHalving : 0,
                          };
                          const total = Object.values(filteredCounts).reduce((a, b) => a + b, 0);
                          if (total === 0) return null;

                          // Consistent dot size, number proportional to cell area
                          const cellArea = bw * bh;
                          const dotR = 2.5;
                          const numDots = Math.max(12, Math.round(cellArea / 80));
                          const minX = Math.min(...xs);
                          const minY = Math.min(...ys);

                          // Build color pool
                          const colorPool: string[] = [];
                          for (const tuner of TUNER_NAMES) {
                            const count = Math.round((filteredCounts[tuner] / total) * numDots);
                            for (let j = 0; j < count; j++) {
                              colorPool.push(TUNER_COLORS[tuner]);
                            }
                          }
                          // Pad or trim to numDots
                          while (colorPool.length < numDots) {
                            const dom = getDominantTuner(filteredCounts);
                            colorPool.push(TUNER_COLORS[dom]);
                          }

                          // Shuffle with seeded random
                          const seed = cluster.id * 7919;
                          for (let k = colorPool.length - 1; k > 0; k--) {
                            const j = Math.floor(seededRandom(seed + k) * (k + 1));
                            [colorPool[k], colorPool[j]] = [colorPool[j], colorPool[k]];
                          }

                          // Place dots within bounding box (clipPath handles actual shape)
                          const dots: React.ReactElement[] = [];
                          for (let i = 0; i < numDots; i++) {
                            const dx = seededRandom(seed + i * 100) * bw + minX;
                            const dy = seededRandom(seed + i * 200) * bh + minY;
                            dots.push(
                              <circle
                                key={i}
                                cx={dx}
                                cy={dy}
                                r={dotR}
                                fill={colorPool[i]}
                                opacity={0.85}
                              />
                            );
                          }
                          return <g>{dots}</g>;
                        })()}
                      </g>
                    )}
                    {colorMode === "hatching" && (
                      <g clipPath={`url(#voronoi-clip-${cell.cluster.id})`}>
                        <g transform={`translate(${cell.cx}, ${cell.cy})`}>
                          {(() => {
                            const cellRadius = Math.max(bw, bh) / 2;
                            const scaleFactor = cellRadius / (HEX_SIZE * 0.85);
                            return (
                              <g transform={`scale(${scaleFactor})`}>
                                {renderHatching(syntheticTile)}
                              </g>
                            );
                          })()}
                        </g>
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
              {colorMode !== "territory" && voronoiMapData.territoryBorderPaths.map((d, idx) => (
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
              {colorMode === "territory" && mapTerritoryBorders}
            </g>
          )}

        </svg>

        {/* Side panel */}
        <div style={{ width: 200, fontSize: 12 }}>
          {/* Layout toggle */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 600, marginBottom: 6, color: "#374151" }}>
              Layout
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {([
                { key: "hex" as LayoutMode, label: "Hex" },
                { key: "map" as LayoutMode, label: "Cluster" },
              ]).map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setLayoutMode(key)}
                  style={{
                    flex: 1,
                    padding: "6px 4px",
                    fontSize: 10,
                    fontWeight: 500,
                    border: "1px solid",
                    borderColor: layoutMode === key ? "#4F46E5" : "#E5E7EB",
                    borderRadius: 4,
                    background: layoutMode === key ? "#EEF2FF" : "white",
                    color: layoutMode === key ? "#4F46E5" : "#6B7280",
                    cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

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
                  { mode: "pixel", label: "Pixel Scatter" },
                  { mode: "hatching", label: "Hatching" },
                  { mode: "territory" as ColorMode, label: "Tuner Territory" },
                  { mode: "dominant", label: "Dominant Only" },
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

          {/* Mode-specific legends */}
          {colorMode === "pixel" && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 600, marginBottom: 8, color: "#374151" }}>
                Pixel Scatter
              </div>
              <div style={{ fontSize: 10, color: "#6B7280", lineHeight: 1.6 }}>
                <p style={{ margin: 0 }}>각 점 = 해당 튜너의 trial</p>
                <p style={{ margin: "4px 0 0 0" }}>점 분포 = 튜너 비율을 직관적으로 표현</p>
                <p style={{ margin: "4px 0 0 0" }}>혼합된 색상 = 여러 튜너가 탐색</p>
              </div>
            </div>
          )}

          {colorMode === "hatching" && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 600, marginBottom: 8, color: "#374151" }}>
                Texture Pattern
              </div>
              <div style={{ fontSize: 10, color: "#6B7280", lineHeight: 1.6 }}>
                <p style={{ margin: 0 }}>패턴 모양 = 튜너 종류</p>
                <p style={{ margin: "4px 0 0 0" }}>투명도 = 해당 튜너 비율</p>
                <p style={{ margin: "4px 0 0 0" }}>중첩 패턴 = 여러 튜너 공존</p>
              </div>
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                {([
                  { tuner: "SymTuner" as TunerType, label: "Diagonal Lines" },
                  { tuner: "CMA_ES" as TunerType, label: "Dots" },
                  { tuner: "Genetic" as TunerType, label: "Crosses" },
                  { tuner: "SuccessiveHalving" as TunerType, label: "Waves" },
                ]).map(({ tuner, label }) => (
                  <div key={tuner} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10 }}>
                    <svg width={20} height={14} style={{ border: "1px solid #E5E7EB", borderRadius: 2, flexShrink: 0 }}>
                      <rect width={20} height={14} fill={textureInstances[tuner]?.url() ?? "#ccc"} />
                    </svg>
                    <span style={{ color: "#374151" }}>{TUNER_DISPLAY_NAMES[tuner]}</span>
                    <span style={{ color: "#9CA3AF" }}>({label})</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {colorMode === "density" && densityScale && data && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 600, marginBottom: 8, color: "#374151" }}>
                Trial Density
              </div>
              <div style={{ fontSize: 10, color: "#6B7280", lineHeight: 1.6, marginBottom: 8 }}>
                <p style={{ margin: 0 }}>색상 = 클러스터 내 trial 수</p>
                <p style={{ margin: "4px 0 0 0" }}>진할수록 더 많은 trial이 탐색됨</p>
              </div>
              <svg width={180} height={24}>
                <defs>
                  <linearGradient id="density-gradient" x1="0" x2="1" y1="0" y2="0">
                    {[0, 0.25, 0.5, 0.75, 1].map(t => (
                      <stop key={t} offset={`${t * 100}%`} stopColor={d3.interpolateYlOrRd(t)} />
                    ))}
                  </linearGradient>
                </defs>
                <rect width={180} height={14} rx={2} fill="url(#density-gradient)" />
                <text x={0} y={24} fontSize={9} fill="#9CA3AF">0</text>
                <text x={180} y={24} fontSize={9} fill="#9CA3AF" textAnchor="end">
                  {d3.max(data.clusters.map(c => c.totalTrials))}
                </text>
              </svg>
            </div>
          )}

          {/* Info */}
          <div style={{ fontSize: 10, color: "#9CA3AF", lineHeight: 1.5 }}>
            {layoutMode === "hex" && (
              <>
                <p>Each hexagon = cluster of similar trials</p>
                <p>Nearby hexagons = similar parameter combinations</p>
              </>
            )}
            {layoutMode === "map" && (
              <>
                <p>Cell area ∝ number of trials (density-based Voronoi)</p>
                <p>Thick borders = territory boundaries</p>
                <p>Thin borders = cluster boundaries</p>
              </>
            )}
            <p style={{ marginTop: 4, fontWeight: 500 }}>
              Click a cell for details
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
