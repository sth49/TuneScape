/**
 * Parameter Space Exploration View
 * Shows trials projected to 2D using Gower distance + UMAP
 * Points colored by discovery (marginal coverage > 0)
 * Includes trajectory animation to show trial sequence
 */

import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Group } from '@visx/group';
import { scaleLinear, scaleLog } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { LinePath } from '@visx/shape';
import { useTooltip, TooltipWithBounds } from '@visx/tooltip';
import type { ProcessedData } from '../types/data';

interface UmapPoint {
  trialId: number;
  x: number;
  y: number;
  marginalCoverage: number;
  totalCovered: number;
}

interface UmapData {
  program: string;
  totalTrials: number;
  embedding: UmapPoint[];
}

interface ParameterSpaceViewProps {
  data: ProcessedData;
  width?: number;
  height?: number;
}

interface TooltipData {
  point: UmapPoint;
  rank: number | null;
}

export function ParameterSpaceView({ data, width = 500, height = 400 }: ParameterSpaceViewProps) {
  const margin = { top: 20, right: 20, bottom: 50, left: 50 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const [umapData, setUmapData] = useState<UmapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [hoveredTrialId, setHoveredTrialId] = useState<number | null>(null);
  const [showZeroContribution, setShowZeroContribution] = useState(true);
  const [showFailed, setShowFailed] = useState(false);

  // Trajectory animation state
  const [showTrajectory, setShowTrajectory] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTrialIndex, setCurrentTrialIndex] = useState(0);
  const [animationSpeed, setAnimationSpeed] = useState(50); // ms per frame
  const animationRef = useRef<number | null>(null);

  const { tooltipOpen, tooltipLeft, tooltipTop, tooltipData, showTooltip, hideTooltip } =
    useTooltip<TooltipData>();

  // Load UMAP data
  useEffect(() => {
    setLoading(true);
    fetch(`/data/${data.program}_umap.json`)
      .then((res) => res.json())
      .then((json: UmapData) => {
        setUmapData(json);
        setLoading(false);
        setCurrentTrialIndex(0);
        setIsPlaying(false);
      })
      .catch(() => setLoading(false));
  }, [data.program]);

  // Animation loop
  useEffect(() => {
    if (!isPlaying || !umapData) return;

    const animate = () => {
      setCurrentTrialIndex((prev) => {
        if (prev >= umapData.embedding.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    };

    animationRef.current = window.setInterval(animate, animationSpeed);

    return () => {
      if (animationRef.current) {
        clearInterval(animationRef.current);
      }
    };
  }, [isPlaying, animationSpeed, umapData]);

  const handlePlayPause = useCallback(() => {
    if (!umapData) return;
    if (currentTrialIndex >= umapData.embedding.length - 1) {
      setCurrentTrialIndex(0);
    }
    setIsPlaying((prev) => !prev);
  }, [currentTrialIndex, umapData]);

  const handleReset = useCallback(() => {
    setIsPlaying(false);
    setCurrentTrialIndex(0);
  }, []);

  // Categorize points
  const { discoveryPoints, zeroPoints, failedPoints, topDiscoveries } = useMemo(() => {
    if (!umapData) return { discoveryPoints: [], zeroPoints: [], failedPoints: [], topDiscoveries: [] };

    const discovery: UmapPoint[] = [];
    const zero: UmapPoint[] = [];
    const failed: UmapPoint[] = [];

    for (const p of umapData.embedding) {
      if (p.totalCovered === 0) {
        failed.push(p);
      } else if (p.marginalCoverage === 0) {
        zero.push(p);
      } else {
        discovery.push(p);
      }
    }

    // Top 5 discoveries
    const top = [...discovery]
      .sort((a, b) => b.marginalCoverage - a.marginalCoverage)
      .slice(0, 5);

    return { discoveryPoints: discovery, zeroPoints: zero, failedPoints: failed, topDiscoveries: top };
  }, [umapData]);

  const topDiscoveryIds = useMemo(
    () => new Set(topDiscoveries.map((p) => p.trialId)),
    [topDiscoveries]
  );

  // Scales
  const xScale = useMemo(() => {
    if (!umapData) return scaleLinear({ domain: [0, 1], range: [0, innerWidth] });
    const xs = umapData.embedding.map((p) => p.x);
    const pad = (Math.max(...xs) - Math.min(...xs)) * 0.05;
    return scaleLinear({
      domain: [Math.min(...xs) - pad, Math.max(...xs) + pad],
      range: [0, innerWidth],
    });
  }, [umapData, innerWidth]);

  const yScale = useMemo(() => {
    if (!umapData) return scaleLinear({ domain: [0, 1], range: [innerHeight, 0] });
    const ys = umapData.embedding.map((p) => p.y);
    const pad = (Math.max(...ys) - Math.min(...ys)) * 0.05;
    return scaleLinear({
      domain: [Math.min(...ys) - pad, Math.max(...ys) + pad],
      range: [innerHeight, 0],
    });
  }, [umapData, innerHeight]);

  // Radius scale for discoveries
  const radiusScale = useMemo(() => {
    const maxCov = Math.max(...discoveryPoints.map((p) => p.marginalCoverage), 1);
    return scaleLog({ domain: [1, maxCov], range: [3, 12] });
  }, [discoveryPoints]);

  const getRank = (trialId: number): number | null => {
    const idx = topDiscoveries.findIndex((p) => p.trialId === trialId);
    return idx >= 0 ? idx + 1 : null;
  };

  const handleMouseEnter = (point: UmapPoint, cx: number, cy: number) => {
    setHoveredTrialId(point.trialId);
    showTooltip({
      tooltipLeft: cx + margin.left,
      tooltipTop: cy + margin.top - 10,
      tooltipData: { point, rank: getRank(point.trialId) },
    });
  };

  const handleMouseLeave = () => {
    setHoveredTrialId(null);
    hideTooltip();
  };

  if (loading) {
    return <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>Loading UMAP...</div>;
  }

  if (!umapData) {
    return <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ef4444' }}>UMAP data not available</div>;
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg width={width} height={height}>
        <Group left={margin.left} top={margin.top}>
          {/* Trajectory line (when animation mode is on) */}
          {showTrajectory && umapData && (
            <>
              {/* Trail line showing path up to current point */}
              <LinePath
                data={umapData.embedding.slice(0, currentTrialIndex + 1)}
                x={(p) => xScale(p.x)}
                y={(p) => yScale(p.y)}
                stroke="#4f46e5"
                strokeWidth={1}
                strokeOpacity={0.4}
              />
              {/* Recent trail (last 50 points) with gradient effect */}
              {currentTrialIndex > 0 && umapData.embedding
                .slice(Math.max(0, currentTrialIndex - 50), currentTrialIndex + 1)
                .map((p, i, arr) => {
                  if (i === 0) return null;
                  const prev = arr[i - 1];
                  const opacity = 0.3 + (i / arr.length) * 0.7;
                  return (
                    <line
                      key={`trail-${p.trialId}`}
                      x1={xScale(prev.x)}
                      y1={yScale(prev.y)}
                      x2={xScale(p.x)}
                      y2={yScale(p.y)}
                      stroke="#4f46e5"
                      strokeWidth={2}
                      strokeOpacity={opacity}
                    />
                  );
                })}
            </>
          )}

          {/* Zero-contribution trials (gray, small) */}
          {(!showTrajectory || !isPlaying) && showZeroContribution && zeroPoints.map((p) => (
            <circle
              key={`zero-${p.trialId}`}
              cx={xScale(p.x)}
              cy={yScale(p.y)}
              r={2}
              fill="#d1d5db"
              fillOpacity={hoveredTrialId ? 0.2 : 0.5}
              onMouseEnter={() => handleMouseEnter(p, xScale(p.x), yScale(p.y))}
              onMouseLeave={handleMouseLeave}
              style={{ cursor: 'pointer' }}
            />
          ))}

          {/* Failed trials (red X) */}
          {(!showTrajectory || !isPlaying) && showFailed && failedPoints.map((p) => {
            const cx = xScale(p.x);
            const cy = yScale(p.y);
            return (
              <g key={`failed-${p.trialId}`}>
                <line x1={cx - 2} y1={cy - 2} x2={cx + 2} y2={cy + 2} stroke="#ef4444" strokeWidth={1} strokeOpacity={0.5} />
                <line x1={cx - 2} y1={cy + 2} x2={cx + 2} y2={cy - 2} stroke="#ef4444" strokeWidth={1} strokeOpacity={0.5} />
              </g>
            );
          })}

          {/* Discovery trials (colored circles) */}
          {(!showTrajectory || !isPlaying) && discoveryPoints
            .filter((p) => p.trialId !== hoveredTrialId)
            .map((p) => {
              const isTop = topDiscoveryIds.has(p.trialId);
              const r = radiusScale(p.marginalCoverage);
              return (
                <circle
                  key={`discovery-${p.trialId}`}
                  cx={xScale(p.x)}
                  cy={yScale(p.y)}
                  r={r}
                  fill={isTop ? '#4f46e5' : '#6b7280'}
                  fillOpacity={hoveredTrialId ? 0.4 : 0.7}
                  stroke={isTop ? '#4f46e5' : '#6b7280'}
                  strokeWidth={isTop ? 2 : 1}
                  onMouseEnter={() => handleMouseEnter(p, xScale(p.x), yScale(p.y))}
                  onMouseLeave={handleMouseLeave}
                  style={{ cursor: 'pointer', transition: 'opacity 0.15s ease' }}
                />
              );
            })}

          {/* Hovered point (on top) */}
          {!showTrajectory && hoveredTrialId && (() => {
            const p = umapData.embedding.find((pt) => pt.trialId === hoveredTrialId);
            if (!p) return null;
            const isTop = topDiscoveryIds.has(p.trialId);
            const isFailed = p.totalCovered === 0;
            const isZero = p.marginalCoverage === 0 && !isFailed;
            const r = isFailed || isZero ? 4 : radiusScale(p.marginalCoverage) + 2;
            const color = isFailed ? '#ef4444' : isZero ? '#6b7280' : isTop ? '#4f46e5' : '#6b7280';
            return (
              <circle
                cx={xScale(p.x)}
                cy={yScale(p.y)}
                r={r}
                fill={color}
                fillOpacity={1}
                stroke="#1e1b4b"
                strokeWidth={3}
                onMouseLeave={handleMouseLeave}
                style={{ cursor: 'pointer' }}
              />
            );
          })()}

          {/* Current position marker (animation mode) */}
          {showTrajectory && umapData && (() => {
            const p = umapData.embedding[currentTrialIndex];
            if (!p) return null;
            const isDiscovery = p.marginalCoverage > 0;
            const isFailed = p.totalCovered === 0;
            return (
              <g>
                {/* Pulse effect */}
                <circle
                  cx={xScale(p.x)}
                  cy={yScale(p.y)}
                  r={12}
                  fill="none"
                  stroke={isFailed ? '#ef4444' : isDiscovery ? '#4f46e5' : '#6b7280'}
                  strokeWidth={2}
                  strokeOpacity={0.3}
                />
                {/* Main marker */}
                <circle
                  cx={xScale(p.x)}
                  cy={yScale(p.y)}
                  r={6}
                  fill={isFailed ? '#ef4444' : isDiscovery ? '#4f46e5' : '#6b7280'}
                  stroke="white"
                  strokeWidth={2}
                />
                {/* Discovery indicator */}
                {isDiscovery && (
                  <text
                    x={xScale(p.x)}
                    y={yScale(p.y) - 16}
                    textAnchor="middle"
                    fontSize={10}
                    fontWeight={600}
                    fill="#4f46e5"
                  >
                    +{p.marginalCoverage}
                  </text>
                )}
              </g>
            );
          })()}

          <AxisBottom
            top={innerHeight}
            scale={xScale}
            numTicks={5}
            tickLabelProps={() => ({ fontSize: 10, textAnchor: 'middle', fill: '#9ca3af' })}
          />
          <AxisLeft
            scale={yScale}
            numTicks={5}
            tickLabelProps={() => ({ fontSize: 10, textAnchor: 'end', fill: '#9ca3af', dx: -4 })}
          />
          <text
            x={innerWidth / 2}
            y={innerHeight + 38}
            textAnchor="middle"
            fontSize={11}
            fill="#6b7280"
          >
            UMAP-1
          </text>
          <text
            transform="rotate(-90)"
            x={-innerHeight / 2}
            y={-38}
            textAnchor="middle"
            fontSize={11}
            fill="#6b7280"
          >
            UMAP-2
          </text>
        </Group>
      </svg>

      {tooltipOpen && tooltipData && (
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          <TooltipWithBounds left={tooltipLeft} top={tooltipTop} style={tooltipStyles}>
            <div style={{ marginBottom: 4 }}>
              <strong>Trial {tooltipData.point.trialId}</strong>
              {tooltipData.rank && (
                <span style={{ color: '#4f46e5', fontWeight: 600 }}> #{tooltipData.rank}</span>
              )}
            </div>
            {tooltipData.point.totalCovered === 0 ? (
              <div style={{ color: '#ef4444' }}>Failed execution</div>
            ) : (
              <>
                <div>
                  {tooltipData.point.marginalCoverage > 0
                    ? `+${tooltipData.point.marginalCoverage} new branches`
                    : 'No new branches'}
                </div>
                <div style={{ color: '#9ca3af' }}>
                  Total: {tooltipData.point.totalCovered.toLocaleString()}
                </div>
              </>
            )}
          </TooltipWithBounds>
        </div>
      )}

      {/* Legend and Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4, marginLeft: margin.left, fontSize: 11, flexWrap: 'wrap' }}>
        {!showTrajectory && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <svg width={10} height={10}><circle cx={5} cy={5} r={4} fill="#4f46e5" /></svg>
              <span style={{ color: '#4f46e5' }}>Top 5</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <svg width={10} height={10}><circle cx={5} cy={5} r={3} fill="#6b7280" /></svg>
              <span style={{ color: '#6b7280' }}>Discovery ({discoveryPoints.length})</span>
            </div>
            <button
              onClick={() => setShowZeroContribution(!showZeroContribution)}
              style={{
                padding: '2px 8px',
                fontSize: 11,
                border: '1px solid',
                borderColor: showZeroContribution ? '#d1d5db' : '#e5e7eb',
                borderRadius: 4,
                background: showZeroContribution ? '#f3f4f6' : 'white',
                color: '#6b7280',
                cursor: 'pointer',
              }}
            >
              Zero ({zeroPoints.length})
            </button>
            <button
              onClick={() => setShowFailed(!showFailed)}
              style={{
                padding: '2px 8px',
                fontSize: 11,
                border: '1px solid',
                borderColor: showFailed ? '#fca5a5' : '#e5e7eb',
                borderRadius: 4,
                background: showFailed ? '#fef2f2' : 'white',
                color: showFailed ? '#dc2626' : '#6b7280',
                cursor: 'pointer',
              }}
            >
              Failed ({failedPoints.length})
            </button>
          </>
        )}

        {/* Trajectory Animation Controls */}
        {showTrajectory && umapData && (
          <>
            <button
              onClick={handlePlayPause}
              style={{
                padding: '2px 10px',
                fontSize: 11,
                border: '1px solid #4f46e5',
                borderRadius: 4,
                background: isPlaying ? '#4f46e5' : 'white',
                color: isPlaying ? 'white' : '#4f46e5',
                cursor: 'pointer',
                fontWeight: 500,
              }}
            >
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <button
              onClick={handleReset}
              style={{
                padding: '2px 8px',
                fontSize: 11,
                border: '1px solid #e5e7eb',
                borderRadius: 4,
                background: 'white',
                color: '#6b7280',
                cursor: 'pointer',
              }}
            >
              Reset
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: '#9ca3af' }}>Speed:</span>
              <input
                type="range"
                min={10}
                max={200}
                value={210 - animationSpeed}
                onChange={(e) => setAnimationSpeed(210 - Number(e.target.value))}
                style={{ width: 60, cursor: 'pointer' }}
              />
            </div>
            <span style={{ color: '#6b7280', minWidth: 100 }}>
              Trial {currentTrialIndex + 1} / {umapData.embedding.length}
            </span>
            {umapData.embedding[currentTrialIndex]?.marginalCoverage > 0 && (
              <span style={{ color: '#4f46e5', fontWeight: 600 }}>
                +{umapData.embedding[currentTrialIndex].marginalCoverage} branches
              </span>
            )}
          </>
        )}

        {/* Trajectory Toggle */}
        <button
          onClick={() => {
            setShowTrajectory(!showTrajectory);
            if (!showTrajectory) {
              setCurrentTrialIndex(0);
              setIsPlaying(false);
            }
          }}
          style={{
            padding: '2px 8px',
            fontSize: 11,
            border: '1px solid',
            borderColor: showTrajectory ? '#4f46e5' : '#e5e7eb',
            borderRadius: 4,
            background: showTrajectory ? '#eef2ff' : 'white',
            color: showTrajectory ? '#4f46e5' : '#6b7280',
            cursor: 'pointer',
            marginLeft: showTrajectory ? 0 : 'auto',
          }}
        >
          {showTrajectory ? 'Exit Animation' : 'Trajectory'}
        </button>
      </div>
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
  maxWidth: 160,
};
