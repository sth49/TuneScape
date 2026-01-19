/**
 * Temporal Exploration Heatmap
 * Shows how parameter space exploration changes over time (trial sequence)
 */

import { useState, useEffect, useMemo } from 'react';
import { Group } from '@visx/group';
import { scaleLinear } from '@visx/scale';
import { contourDensity } from 'd3-contour';
import { geoPath } from 'd3-geo';

interface EmbeddingPoint {
  trialId: number;
  x: number;
  y: number;
  marginalCoverage: number;
  totalCovered: number;
}

interface CombinedUmapData {
  programs: string[];
  totalTrials: number;
  embeddings: Record<string, EmbeddingPoint[]>;
}

interface TemporalExplorationHeatmapProps {
  width?: number;
  height?: number;
  colors: Record<string, string>;
  numWindows?: number;
}

interface TimeWindow {
  label: string;
  startTrial: number;
  endTrial: number;
}

export function TemporalExplorationHeatmap({
  width = 1000,
  height = 300,
  colors,
  numWindows = 4,
}: TemporalExplorationHeatmapProps) {
  const [data, setData] = useState<CombinedUmapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedProgram, setSelectedProgram] = useState<string | null>(null);

  // Load combined UMAP data
  useEffect(() => {
    fetch('/data/combined_umap.json')
      .then((res) => res.json())
      .then((json: CombinedUmapData) => {
        setData(json);
        setSelectedProgram(json.programs[0]);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load combined UMAP:', err);
        setLoading(false);
      });
  }, []);

  // Calculate layout
  const gap = 16;
  const margin = { top: 30, right: 20, bottom: 40, left: 20 };
  const cellWidth = (width - margin.left - margin.right - gap * (numWindows - 1)) / numWindows;
  const cellHeight = height - margin.top - margin.bottom;

  // Compute global scales (same for all windows)
  const { xScale, yScale, xDomain, yDomain } = useMemo(() => {
    if (!data) return { xScale: null, yScale: null, xDomain: [0, 1], yDomain: [0, 1] };

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (const program of data.programs) {
      for (const point of data.embeddings[program]) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
      }
    }

    const padX = (maxX - minX) * 0.05;
    const padY = (maxY - minY) * 0.05;

    const xDom: [number, number] = [minX - padX, maxX + padX];
    const yDom: [number, number] = [minY - padY, maxY + padY];

    return {
      xScale: scaleLinear({ domain: xDom, range: [0, cellWidth] }),
      yScale: scaleLinear({ domain: yDom, range: [cellHeight, 0] }),
      xDomain: xDom,
      yDomain: yDom,
    };
  }, [data, cellWidth, cellHeight]);

  // Create time windows
  const timeWindows = useMemo((): TimeWindow[] => {
    if (!data || !selectedProgram) return [];

    const totalTrials = data.embeddings[selectedProgram]?.length || 0;
    const windowSize = Math.ceil(totalTrials / numWindows);

    return Array.from({ length: numWindows }, (_, i) => ({
      label: `${i * windowSize + 1}-${Math.min((i + 1) * windowSize, totalTrials)}`,
      startTrial: i * windowSize + 1,
      endTrial: Math.min((i + 1) * windowSize, totalTrials),
    }));
  }, [data, selectedProgram, numWindows]);

  // Compute contours for each time window
  const windowContours = useMemo(() => {
    if (!data || !selectedProgram || !xScale || !yScale) return [];

    const allPoints = data.embeddings[selectedProgram];
    const pathGenerator = geoPath();

    return timeWindows.map((window) => {
      const windowPoints = allPoints
        .filter((p) => p.trialId >= window.startTrial && p.trialId <= window.endTrial)
        .map((p) => [xScale(p.x), yScale(p.y)] as [number, number]);

      if (windowPoints.length < 3) {
        return { window, contours: [], points: windowPoints };
      }

      const density = contourDensity<[number, number]>()
        .x((d) => d[0])
        .y((d) => d[1])
        .size([cellWidth, cellHeight])
        .bandwidth(15)
        .thresholds(6);

      const contours = density(windowPoints);

      return {
        window,
        contours,
        points: windowPoints,
        paths: contours.map((c) => pathGenerator(c) || ''),
      };
    });
  }, [data, selectedProgram, xScale, yScale, timeWindows, cellWidth, cellHeight]);

  // Count discoveries per window
  const windowStats = useMemo(() => {
    if (!data || !selectedProgram) return [];

    const allPoints = data.embeddings[selectedProgram];

    return timeWindows.map((window) => {
      const windowPoints = allPoints.filter(
        (p) => p.trialId >= window.startTrial && p.trialId <= window.endTrial
      );
      const discoveries = windowPoints.filter((p) => p.marginalCoverage > 0).length;
      return {
        total: windowPoints.length,
        discoveries,
        rate: windowPoints.length > 0 ? discoveries / windowPoints.length : 0,
      };
    });
  }, [data, selectedProgram, timeWindows]);

  if (loading) {
    return (
      <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
        Loading...
      </div>
    );
  }

  if (!data || !selectedProgram || !xScale || !yScale) {
    return (
      <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
        No data available
      </div>
    );
  }

  const programColor = colors[selectedProgram] || '#4f46e5';

  return (
    <div>
      {/* Program selector */}
      <div style={{ marginBottom: 12, display: 'flex', gap: 8 }}>
        {data.programs.map((program) => (
          <button
            key={program}
            onClick={() => setSelectedProgram(program)}
            style={{
              padding: '4px 12px',
              fontSize: 12,
              border: '1px solid',
              borderColor: selectedProgram === program ? colors[program] : '#e5e7eb',
              borderRadius: 4,
              background: selectedProgram === program ? `${colors[program]}15` : 'white',
              color: selectedProgram === program ? colors[program] : '#6b7280',
              cursor: 'pointer',
              fontWeight: selectedProgram === program ? 600 : 400,
            }}
          >
            {program}
          </button>
        ))}
      </div>

      <svg width={width} height={height}>
        {windowContours.map((wc, i) => {
          const xOffset = margin.left + i * (cellWidth + gap);
          const stats = windowStats[i];

          return (
            <Group key={i} left={xOffset} top={margin.top}>
              {/* Background */}
              <rect
                width={cellWidth}
                height={cellHeight}
                fill="#fafafa"
                stroke="#e5e7eb"
                strokeWidth={1}
                rx={4}
              />

              {/* Density contours */}
              {wc.paths?.map((path, j) => (
                <path
                  key={j}
                  d={path}
                  fill={programColor}
                  fillOpacity={0.08 + j * 0.06}
                  stroke={programColor}
                  strokeOpacity={0.3}
                  strokeWidth={0.5}
                />
              ))}

              {/* Individual points (small) */}
              {wc.points.map((pt, j) => {
                const originalPoint = data.embeddings[selectedProgram].find(
                  (p) => Math.abs(xScale(p.x) - pt[0]) < 0.1 && Math.abs(yScale(p.y) - pt[1]) < 0.1
                );
                const isDiscovery = originalPoint?.marginalCoverage && originalPoint.marginalCoverage > 0;

                return (
                  <circle
                    key={j}
                    cx={pt[0]}
                    cy={pt[1]}
                    r={isDiscovery ? 2.5 : 1.5}
                    fill={programColor}
                    fillOpacity={isDiscovery ? 0.8 : 0.3}
                  />
                );
              })}

              {/* Window label */}
              <text
                x={cellWidth / 2}
                y={-10}
                textAnchor="middle"
                fontSize={11}
                fontWeight={600}
                fill="#374151"
              >
                Trial {wc.window.label}
              </text>

              {/* Stats */}
              <text
                x={cellWidth / 2}
                y={cellHeight + 18}
                textAnchor="middle"
                fontSize={10}
                fill="#6b7280"
              >
                {stats?.discoveries} discoveries ({(stats?.rate * 100).toFixed(1)}%)
              </text>

              {/* Time indicator arrow */}
              {i < numWindows - 1 && (
                <g transform={`translate(${cellWidth + gap / 2 - 4}, ${cellHeight / 2})`}>
                  <path
                    d="M0 -4 L6 0 L0 4"
                    fill="none"
                    stroke="#d1d5db"
                    strokeWidth={2}
                  />
                </g>
              )}
            </Group>
          );
        })}

        {/* Overall time arrow */}
        <text
          x={width / 2}
          y={height - 5}
          textAnchor="middle"
          fontSize={11}
          fill="#9ca3af"
        >
          Time →
        </text>
      </svg>
    </div>
  );
}
