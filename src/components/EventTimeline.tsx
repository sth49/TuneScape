/**
 * Event Timeline with Size Encoding
 * Shows discovery events as circles on a timeline
 * Circle size encodes marginal coverage
 * Enhanced tooltip shows ranking and milestone information
 */

import { useMemo, useState } from 'react';
import { Group } from '@visx/group';
import { scaleLog } from '@visx/scale';
import { AxisBottom } from '@visx/axis';
import { useTooltip, TooltipWithBounds } from '@visx/tooltip';
import type { ProcessedData, TrialData } from '../types/data';

interface CirclePosition {
  trial: TrialData;
  x: number;
  y: number;
  r: number;
}

interface EventTimelineProps {
  data: ProcessedData;
  width?: number;
  height?: number;
  topN?: number;
  color?: string;
  compact?: boolean;
}

interface TooltipData {
  trial: TrialData;
  rank: number | null;
  isSaturationPoint: boolean;
  isLastSignificant: boolean;
  percentOfTotal: number;
}

export function EventTimeline({ data, width = 1000, height = 200, topN = 5, color = '#4f46e5', compact = false }: EventTimelineProps) {
  const margin = compact
    ? { top: 15, right: 20, bottom: 25, left: 50 }
    : { top: 40, right: 30, bottom: 50, left: 70 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const [hoveredTrialId, setHoveredTrialId] = useState<number | null>(null);
  const [showFailedTrials, setShowFailedTrials] = useState(false);

  const { tooltipOpen, tooltipLeft, tooltipTop, tooltipData, showTooltip, hideTooltip } =
    useTooltip<TooltipData>();

  // First trial as baseline (excluded from timeline)
  const baselineTrial = data.trials[0];

  // Filter non-zero trials, excluding the first trial (baseline)
  const nonZeroTrials = useMemo(
    () => data.trials.filter((t) => t.trialId > 1 && t.marginalCoverage > 0),
    [data.trials]
  );

  // Failed trials (zero total coverage = execution failed), excluding first trial
  const failedTrials = useMemo(
    () => data.trials.filter((t) => t.trialId > 1 && t.totalCovered === 0),
    [data.trials]
  );

  // Compute top discoveries ranking
  const topDiscoveries = useMemo(() => {
    return [...nonZeroTrials]
      .sort((a, b) => b.marginalCoverage - a.marginalCoverage)
      .slice(0, topN);
  }, [nonZeroTrials, topN]);

  const topDiscoveryIds = useMemo(
    () => new Set(topDiscoveries.map((t) => t.trialId)),
    [topDiscoveries]
  );

  // Find 95% saturation point
  const saturationTrialId = useMemo(() => {
    const threshold = data.totalUniqueBranches * 0.95;
    const satPoint = data.trials.find((t) => t.cumulativeCoverage >= threshold);
    return satPoint?.trialId ?? null;
  }, [data.trials, data.totalUniqueBranches]);

  // Find last significant discovery (>= 10 branches)
  const lastSignificantId = useMemo(() => {
    for (let i = data.trials.length - 1; i >= 0; i--) {
      if (data.trials[i].marginalCoverage >= 10) {
        return data.trials[i].trialId;
      }
    }
    return null;
  }, [data.trials]);

  // Log scale for X - spreads out early trials where discoveries are dense
  const xScale = useMemo(
    () => scaleLog({ domain: [1, data.totalTrials], range: [0, innerWidth] }),
    [data.totalTrials, innerWidth]
  );

  // Log scale for radius - reduces extreme size differences
  const radiusScale = useMemo(
    () =>
      scaleLog({
        domain: [1, Math.max(...nonZeroTrials.map((t) => t.marginalCoverage))],
        range: [3, 14],
      }),
    [nonZeroTrials]
  );

  const centerY = innerHeight / 2;

  // Beeswarm layout: compute positions to avoid overlap
  const circlePositions = useMemo(() => {
    const positions: CirclePosition[] = [];
    const padding = 3; // padding between circles

    // Sort by x position (trial ID) for left-to-right placement
    const sortedTrials = [...nonZeroTrials].sort((a, b) => a.trialId - b.trialId);

    for (const trial of sortedTrials) {
      const x = xScale(trial.trialId);
      const r = radiusScale(trial.marginalCoverage);

      // Find y position that doesn't overlap with existing circles
      let bestY = centerY;
      let placed = false;
      const maxOffset = innerHeight / 2 - r - 5;

      // Alternate starting direction based on trial ID for better distribution
      const startAbove = trial.trialId % 2 === 0;

      // Try positions from center outward
      for (let offset = 0; offset <= maxOffset && !placed; offset += 1) {
        // Alternate above/below based on trial ID
        let candidates: number[];
        if (offset === 0) {
          candidates = [centerY];
        } else if (startAbove) {
          candidates = [centerY - offset, centerY + offset];
        } else {
          candidates = [centerY + offset, centerY - offset];
        }

        for (const tryY of candidates) {
          // Check collision with nearby circles only (optimization)
          let hasCollision = false;

          for (const pos of positions) {
            // Only check circles that could possibly collide (within x range)
            if (Math.abs(x - pos.x) > r + pos.r + padding) continue;

            const dx = x - pos.x;
            const dy = tryY - pos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const minDist = r + pos.r + padding;

            if (dist < minDist) {
              hasCollision = true;
              break;
            }
          }

          if (!hasCollision) {
            bestY = tryY;
            placed = true;
            break;
          }
        }
      }

      positions.push({ trial, x, y: bestY, r });
    }

    return positions;
  }, [nonZeroTrials, xScale, radiusScale, centerY, innerHeight]);

  const getRank = (trialId: number): number | null => {
    const idx = topDiscoveries.findIndex((t) => t.trialId === trialId);
    return idx >= 0 ? idx + 1 : null;
  };

  const handleMouseEnter = (pos: CirclePosition) => {
    setHoveredTrialId(pos.trial.trialId);
    const rank = getRank(pos.trial.trialId);

    showTooltip({
      tooltipLeft: pos.x + margin.left,
      tooltipTop: pos.y + margin.top - pos.r - 10,
      tooltipData: {
        trial: pos.trial,
        rank,
        isSaturationPoint: pos.trial.trialId === saturationTrialId,
        isLastSignificant: pos.trial.trialId === lastSignificantId,
        percentOfTotal: (pos.trial.marginalCoverage / data.totalUniqueBranches) * 100,
      },
    });
  };

  const handleMouseLeave = () => {
    setHoveredTrialId(null);
    hideTooltip();
  };

  // Get circle color based on special status
  const getCircleColor = (trial: TrialData) => {
    if (topDiscoveryIds.has(trial.trialId)) return color; // primary color for top
    if (trial.trialId === saturationTrialId) return '#f59e0b'; // amber for saturation
    return '#9ca3af'; // lighter gray for others
  };

  return (
    <div style={{ position: 'relative', height: compact ? height : height + 40 }}>
      <svg width={width} height={height} style={{ overflow: 'visible' }}>
        <Group left={margin.left} top={margin.top}>
          {/* Timeline base line */}
          <line x1={0} y1={centerY} x2={innerWidth} y2={centerY} stroke="#d1d5db" strokeWidth={2} />

          {/* 95% saturation marker */}
          {saturationTrialId && (
            <line
              x1={xScale(saturationTrialId)}
              y1={0}
              x2={xScale(saturationTrialId)}
              y2={innerHeight}
              stroke="#f59e0b"
              strokeWidth={1}
              strokeDasharray="4,2"
              opacity={0.6}
            />
          )}

          {/* Failed trials (zero coverage) */}
          {showFailedTrials && failedTrials.map((trial) => (
            <line
              key={`failed-${trial.trialId}`}
              x1={xScale(trial.trialId)}
              y1={centerY - 3}
              x2={xScale(trial.trialId)}
              y2={centerY + 3}
              stroke="#ef4444"
              strokeWidth={1}
              strokeOpacity={hoveredTrialId ? 0.2 : 0.4}
            />
          ))}

          {/* Event circles with beeswarm layout */}
          {circlePositions
            .filter((pos) => pos.trial.trialId !== hoveredTrialId)
            .map((pos) => (
              <circle
                key={pos.trial.trialId}
                cx={pos.x}
                cy={pos.y}
                r={pos.r}
                fill={getCircleColor(pos.trial)}
                fillOpacity={hoveredTrialId ? 0.4 : 0.7}
                stroke={getCircleColor(pos.trial)}
                strokeWidth={topDiscoveryIds.has(pos.trial.trialId) ? 2 : 1}
                onMouseEnter={() => handleMouseEnter(pos)}
                onMouseLeave={handleMouseLeave}
                style={{ cursor: 'pointer', transition: 'opacity 0.15s ease' }}
              />
            ))}

          {/* Hovered circle rendered last (on top) */}
          {hoveredTrialId && (() => {
            const pos = circlePositions.find(p => p.trial.trialId === hoveredTrialId);
            if (!pos) return null;
            return (
              <circle
                cx={pos.x}
                cy={pos.y}
                r={pos.r + 2}
                fill={getCircleColor(pos.trial)}
                fillOpacity={1}
                stroke="#1e1b4b"
                strokeWidth={3}
                onMouseLeave={handleMouseLeave}
                style={{ cursor: 'pointer' }}
              />
            );
          })()}

          <AxisBottom
            top={innerHeight}
            scale={xScale}
            tickValues={compact ? [1, 10, 100, 1000] : [1, 5, 10, 50, 100, 500, 1000, 2000]}
            tickLabelProps={() => ({ fontSize: compact ? 10 : 11, textAnchor: 'middle', fill: '#6b7280', dy: 4 })}
          />
          {!compact && (
            <text
              x={innerWidth / 2}
              y={innerHeight + 40}
              textAnchor="middle"
              fontSize={12}
              fill="#374151"
            >
              Trial (log scale)
            </text>
          )}
        </Group>
      </svg>

      {tooltipOpen && tooltipData && (
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          <TooltipWithBounds left={tooltipLeft} top={tooltipTop} style={tooltipStyles}>
            <div style={{ marginBottom: 4 }}>
              <strong>Trial {tooltipData.trial.trialId}</strong>
              {tooltipData.rank && (
                <span style={{ color: color, fontWeight: 600 }}> #{tooltipData.rank}</span>
              )}
            </div>
            <div>+{tooltipData.trial.marginalCoverage} <span style={{ color: '#9ca3af' }}>({tooltipData.percentOfTotal.toFixed(1)}%)</span></div>
            <div style={{ color: '#6b7280' }}>Cum: {tooltipData.trial.cumulativeCoverage.toLocaleString()} ({((tooltipData.trial.cumulativeCoverage / data.totalUniqueBranches) * 100).toFixed(1)}%)</div>
            {tooltipData.isSaturationPoint && <div style={{ color: '#f59e0b', marginTop: 4 }}>95% saturation</div>}
            {tooltipData.isLastSignificant && <div style={{ color: '#6b7280', marginTop: 4 }}>Last significant</div>}
          </TooltipWithBounds>
        </div>
      )}

      {/* Legend and summary */}
      {!compact && (
        <div style={{ position: 'absolute', bottom: 0, left: margin.left, right: margin.right, display: 'flex', alignItems: 'center', gap: 16, fontSize: 11 }}>
          <div style={{ padding: '4px 8px', backgroundColor: '#f3f4f6', borderRadius: 4 }}>
            <span style={{ color: '#6b7280' }}>Baseline (Trial 1): </span>
            <strong>{baselineTrial.marginalCoverage.toLocaleString()}</strong>
            <span style={{ color: '#9ca3af' }}> ({((baselineTrial.marginalCoverage / data.totalUniqueBranches) * 100).toFixed(1)}%)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <svg width={10} height={10}><circle cx={5} cy={5} r={4} fill={color} /></svg>
            <span style={{ color }}>Top {topN}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <svg width={16} height={10}><line x1={0} y1={5} x2={16} y2={5} stroke="#f59e0b" strokeDasharray="3,2" /></svg>
            <span style={{ color: '#f59e0b' }}>95%</span>
          </div>
          <button
            onClick={() => setShowFailedTrials(!showFailedTrials)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '3px 8px',
              fontSize: 11,
              border: '1px solid',
              borderColor: showFailedTrials ? '#fca5a5' : '#e5e7eb',
              borderRadius: 4,
              background: showFailedTrials ? '#fef2f2' : 'white',
              color: showFailedTrials ? '#dc2626' : '#6b7280',
              cursor: 'pointer',
            }}
          >
            <svg width={10} height={10}><line x1={5} y1={2} x2={5} y2={8} stroke="currentColor" strokeWidth={2} /></svg>
            Failed ({failedTrials.length})
          </button>
          <div style={{ color: '#9ca3af', marginLeft: 'auto' }}>
            {nonZeroTrials.length} discoveries / {data.totalTrials - 1} trials
          </div>
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
  maxWidth: 160,
};
