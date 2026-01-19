/**
 * Combined Parameter Space View
 * Shows all programs/tuners together in the same UMAP embedding
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { Group } from '@visx/group';
import { scaleLinear } from '@visx/scale';
import { useTooltip, TooltipWithBounds } from '@visx/tooltip';
import { localPoint } from '@visx/event';
import { voronoi } from '@visx/voronoi';
import { contourDensity } from 'd3-contour';
import { geoPath } from 'd3-geo';
import { useSelection } from '../context/SelectionContext';

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

interface CombinedParameterSpaceViewProps {
  width?: number;
  height?: number;
  colors: Record<string, string>;
}

interface TooltipData {
  program: string;
  point: EmbeddingPoint;
}

export function CombinedParameterSpaceView({
  width = 1000,
  height = 500,
  colors,
}: CombinedParameterSpaceViewProps) {
  const margin = { top: 20, right: 120, bottom: 40, left: 50 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const [data, setData] = useState<CombinedUmapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [visiblePrograms, setVisiblePrograms] = useState<Set<string>>(new Set());
  const [showOnlyDiscoveries, setShowOnlyDiscoveries] = useState(false);
  const [showContours, setShowContours] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  const { tooltipOpen, tooltipLeft, tooltipTop, tooltipData, showTooltip, hideTooltip } =
    useTooltip<TooltipData>();

  const { selection } = useSelection();

  // Load combined UMAP data
  useEffect(() => {
    fetch('/data/combined_umap.json')
      .then((res) => res.json())
      .then((json: CombinedUmapData) => {
        setData(json);
        setVisiblePrograms(new Set(json.programs));
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load combined UMAP:', err);
        setLoading(false);
      });
  }, []);

  // Compute scales
  const { xScale, yScale } = useMemo(() => {
    if (!data) return { xScale: null, yScale: null };

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

    return {
      xScale: scaleLinear({
        domain: [minX - padX, maxX + padX],
        range: [0, innerWidth],
      }),
      yScale: scaleLinear({
        domain: [minY - padY, maxY + padY],
        range: [innerHeight, 0],
      }),
    };
  }, [data, innerWidth, innerHeight]);

  // Flatten all points for voronoi
  const allPoints = useMemo(() => {
    if (!data || !xScale || !yScale) return [];

    const points: { program: string; point: EmbeddingPoint; x: number; y: number }[] = [];

    for (const program of data.programs) {
      if (!visiblePrograms.has(program)) continue;
      for (const point of data.embeddings[program]) {
        if (showOnlyDiscoveries && point.marginalCoverage === 0) continue;
        points.push({
          program,
          point,
          x: xScale(point.x),
          y: yScale(point.y),
        });
      }
    }

    return points;
  }, [data, xScale, yScale, visiblePrograms, showOnlyDiscoveries]);

  // Create voronoi for hover detection
  const voronoiLayout = useMemo(() => {
    if (allPoints.length === 0) return null;

    return voronoi<typeof allPoints[0]>({
      x: (d) => d.x,
      y: (d) => d.y,
      width: innerWidth,
      height: innerHeight,
    })(allPoints);
  }, [allPoints, innerWidth, innerHeight]);

  // Compute density contours for each program
  const contours = useMemo(() => {
    if (!data || !xScale || !yScale || !showContours) return {};

    const result: Record<string, ReturnType<ReturnType<typeof contourDensity>>> = {};

    for (const program of data.programs) {
      if (!visiblePrograms.has(program)) continue;

      const points = data.embeddings[program]
        .filter((p) => !showOnlyDiscoveries || p.marginalCoverage > 0)
        .map((p) => [xScale(p.x), yScale(p.y)] as [number, number]);

      if (points.length < 3) continue;

      const density = contourDensity<[number, number]>()
        .x((d) => d[0])
        .y((d) => d[1])
        .size([innerWidth, innerHeight])
        .bandwidth(20)
        .thresholds(5);

      result[program] = density(points);
    }

    return result;
  }, [data, xScale, yScale, visiblePrograms, showOnlyDiscoveries, showContours, innerWidth, innerHeight]);

  const pathGenerator = geoPath();

  const handleMouseMove = (event: React.MouseEvent<SVGRectElement>) => {
    if (!voronoiLayout || !svgRef.current) return;

    const point = localPoint(svgRef.current, event);
    if (!point) return;

    const x = point.x - margin.left;
    const y = point.y - margin.top;

    const closest = voronoiLayout.find(x, y, 30);
    if (closest) {
      showTooltip({
        tooltipLeft: closest.data.x + margin.left + 10,
        tooltipTop: closest.data.y + margin.top - 10,
        tooltipData: {
          program: closest.data.program,
          point: closest.data.point,
        },
      });
    } else {
      hideTooltip();
    }
  };

  const toggleProgram = (program: string) => {
    setVisiblePrograms((prev) => {
      const next = new Set(prev);
      if (next.has(program)) {
        next.delete(program);
      } else {
        next.add(program);
      }
      return next;
    });
  };

  if (loading) {
    return (
      <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
        Loading combined parameter space...
      </div>
    );
  }

  if (!data || !xScale || !yScale) {
    return (
      <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
        No data available
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', height }}>
      <svg ref={svgRef} width={width} height={height}>
        <Group left={margin.left} top={margin.top}>
          {/* Background */}
          <rect width={innerWidth} height={innerHeight} fill="#fafafa" rx={4} />

          {/* Density contours */}
          {showContours && data?.programs.map((program) => {
            if (!visiblePrograms.has(program)) return null;
            const programContours = contours[program];
            if (!programContours) return null;
            const color = colors[program] || '#6b7280';

            return (
              <g key={`contour-${program}`}>
                {programContours.map((contour, i) => (
                  <path
                    key={i}
                    d={pathGenerator(contour) || ''}
                    fill={color}
                    fillOpacity={0.05 + i * 0.03}
                    stroke={color}
                    strokeOpacity={0.3}
                    strokeWidth={1}
                  />
                ))}
              </g>
            );
          })}

          {/* Points for each program */}
          {data.programs.map((program) => {
            if (!visiblePrograms.has(program)) return null;
            const points = data.embeddings[program];
            const color = colors[program] || '#6b7280';
            const hasSelection = selection !== null;
            const isSelectedProgram = selection?.program === program;

            return (
              <g key={program}>
                {points.map((point) => {
                  const isHighCoverage = point.marginalCoverage > 0;
                  if (showOnlyDiscoveries && !isHighCoverage) return null;

                  const isSelected = isSelectedProgram && selection.trialIds.has(point.trialId);
                  const isDimmed = hasSelection && !isSelected;

                  return (
                    <circle
                      key={`${program}-${point.trialId}`}
                      cx={xScale(point.x)}
                      cy={yScale(point.y)}
                      r={isSelected ? 6 : (isHighCoverage ? 4 : 2.5)}
                      fill={color}
                      fillOpacity={isDimmed ? 0.1 : (isHighCoverage ? 0.7 : 0.3)}
                      stroke={isSelected ? '#1e1b4b' : (isHighCoverage ? color : 'none')}
                      strokeWidth={isSelected ? 2 : 1}
                    />
                  );
                })}
              </g>
            );
          })}

          {/* Hover detection overlay */}
          <rect
            width={innerWidth}
            height={innerHeight}
            fill="transparent"
            onMouseMove={handleMouseMove}
            onMouseLeave={hideTooltip}
          />
        </Group>

        {/* Legend */}
        <Group left={width - margin.right + 15} top={margin.top}>
          <text fontSize={11} fontWeight={600} fill="#374151">Programs</text>
          {data.programs.map((program, i) => {
            const color = colors[program] || '#6b7280';
            const isVisible = visiblePrograms.has(program);
            return (
              <g
                key={program}
                transform={`translate(0, ${20 + i * 24})`}
                style={{ cursor: 'pointer' }}
                onClick={() => toggleProgram(program)}
              >
                <rect
                  x={-4}
                  y={-4}
                  width={90}
                  height={20}
                  fill={isVisible ? `${color}10` : 'transparent'}
                  rx={4}
                />
                <circle
                  cx={8}
                  cy={6}
                  r={6}
                  fill={isVisible ? color : '#e5e7eb'}
                  stroke={color}
                  strokeWidth={2}
                />
                <text
                  x={20}
                  y={10}
                  fontSize={11}
                  fill={isVisible ? '#374151' : '#9ca3af'}
                >
                  {program}
                </text>
              </g>
            );
          })}

          {/* Stats */}
          <g transform={`translate(0, ${20 + data.programs.length * 24 + 20})`}>
            <text fontSize={10} fill="#9ca3af">
              {allPoints.length.toLocaleString()} trials
            </text>
          </g>
        </Group>

        {/* Filter toggle buttons */}
        <foreignObject
          x={margin.left}
          y={height - 35}
          width={320}
          height={30}
        >
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setShowOnlyDiscoveries(!showOnlyDiscoveries)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                fontSize: 11,
                border: '1px solid',
                borderColor: showOnlyDiscoveries ? '#4f46e5' : '#e5e7eb',
                borderRadius: 4,
                background: showOnlyDiscoveries ? '#eef2ff' : 'white',
                color: showOnlyDiscoveries ? '#4f46e5' : '#6b7280',
                cursor: 'pointer',
              }}
            >
              <svg width={12} height={12} viewBox="0 0 12 12">
                <circle cx={6} cy={6} r={4} fill={showOnlyDiscoveries ? '#4f46e5' : '#d1d5db'} />
              </svg>
              Discoveries only
            </button>
            <button
              onClick={() => setShowContours(!showContours)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                fontSize: 11,
                border: '1px solid',
                borderColor: showContours ? '#10b981' : '#e5e7eb',
                borderRadius: 4,
                background: showContours ? '#ecfdf5' : 'white',
                color: showContours ? '#10b981' : '#6b7280',
                cursor: 'pointer',
              }}
            >
              <svg width={12} height={12} viewBox="0 0 12 12">
                <ellipse cx={6} cy={6} rx={5} ry={3} fill="none" stroke={showContours ? '#10b981' : '#d1d5db'} strokeWidth={1.5} />
              </svg>
              Density contours
            </button>
          </div>
        </foreignObject>
      </svg>

      {/* Tooltip */}
      {tooltipOpen && tooltipData && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            overflow: 'hidden',
          }}
        >
          <TooltipWithBounds left={tooltipLeft} top={tooltipTop} style={tooltipStyles}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <div
                style={{
                  width: 10,
                  height: 10,
                  backgroundColor: colors[tooltipData.program] || '#6b7280',
                  borderRadius: 2,
                }}
              />
              <strong>{tooltipData.program}</strong>
              <span style={{ color: '#9ca3af' }}>#{tooltipData.point.trialId}</span>
            </div>
            <div>
              Marginal: <strong>+{tooltipData.point.marginalCoverage}</strong>
            </div>
            <div style={{ color: '#6b7280' }}>
              Total covered: {tooltipData.point.totalCovered.toLocaleString()}
            </div>
          </TooltipWithBounds>
        </div>
      )}
    </div>
  );
}

const tooltipStyles: React.CSSProperties = {
  backgroundColor: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: 4,
  padding: '6px 10px',
  fontSize: 11,
  lineHeight: 1.4,
  boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  pointerEvents: 'none',
  maxWidth: 180,
};
