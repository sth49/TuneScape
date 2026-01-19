/**
 * Rank Chart Over Time
 * Shows how each tuner's rank (1st, 2nd, 3rd...) changes over trials
 * Useful for seeing which tuner "wins" at different points in time
 */

import { useMemo, useState } from 'react';
import { Group } from '@visx/group';
import { scaleLinear, scaleOrdinal, scalePoint } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows } from '@visx/grid';
import { LinePath } from '@visx/shape';
import { curveMonotoneX } from '@visx/curve';
import { useTooltip, TooltipWithBounds } from '@visx/tooltip';
import { localPoint } from '@visx/event';
import { Bar } from '@visx/shape';

interface TrialData {
  trialId: number;
  cumulativeCoverage: number;
}

interface DatasetStats {
  id: string;
  label: string;
  color: string;
  trials: TrialData[];
  totalTrials: number;
  totalUniqueBranches: number;
}

interface RankChartOverTimeProps {
  datasets: DatasetStats[];
  width?: number;
  height?: number;
}

interface RankPoint {
  trial: number;
  rank: number;
  coverage: number;
  coveragePercent: number;
}

interface TooltipData {
  trial: number;
  rankings: { id: string; label: string; color: string; rank: number; coverage: number; coveragePercent: number }[];
}

export function RankChartOverTime({
  datasets,
  width = 1000,
  height = 300,
}: RankChartOverTimeProps) {
  const margin = { top: 20, right: 120, bottom: 50, left: 60 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const [hoveredTrial, setHoveredTrial] = useState<number | null>(null);

  const { tooltipOpen, tooltipLeft, tooltipTop, tooltipData, showTooltip, hideTooltip } =
    useTooltip<TooltipData>();

  // Sample trials to avoid too many points
  const sampleRate = useMemo(() => {
    const maxTrials = Math.max(...datasets.map((d) => d.totalTrials));
    return Math.max(1, Math.floor(maxTrials / 100));
  }, [datasets]);

  // Compute ranks at each trial point
  const rankData = useMemo(() => {
    if (datasets.length === 0) return { ranks: {}, trials: [] };

    const maxTrials = Math.max(...datasets.map((d) => d.totalTrials));
    const sampledTrials: number[] = [];

    // Sample trials
    for (let t = 1; t <= maxTrials; t += sampleRate) {
      sampledTrials.push(t);
    }
    // Always include the last trial
    if (!sampledTrials.includes(maxTrials)) {
      sampledTrials.push(maxTrials);
    }

    // Initialize rank data for each dataset
    const ranks: Record<string, RankPoint[]> = {};
    for (const ds of datasets) {
      ranks[ds.id] = [];
    }

    // Calculate ranks at each sampled trial
    for (const trialNum of sampledTrials) {
      // Get coverage for each dataset at this trial
      const coverages = datasets.map((ds) => {
        const trial = ds.trials.find((t) => t.trialId === trialNum);
        const coverage = trial?.cumulativeCoverage ?? ds.trials[ds.trials.length - 1]?.cumulativeCoverage ?? 0;
        return {
          id: ds.id,
          coverage,
          coveragePercent: (coverage / ds.totalUniqueBranches) * 100,
        };
      });

      // Sort by coverage descending to assign ranks
      const sorted = [...coverages].sort((a, b) => b.coverage - a.coverage);

      // Assign ranks (handle ties by giving same rank)
      let currentRank = 1;
      let prevCoverage = -1;
      const rankAssignments = new Map<string, number>();

      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].coverage !== prevCoverage) {
          currentRank = i + 1;
        }
        rankAssignments.set(sorted[i].id, currentRank);
        prevCoverage = sorted[i].coverage;
      }

      // Store rank data
      for (const cov of coverages) {
        ranks[cov.id].push({
          trial: trialNum,
          rank: rankAssignments.get(cov.id) ?? datasets.length,
          coverage: cov.coverage,
          coveragePercent: cov.coveragePercent,
        });
      }
    }

    return { ranks, trials: sampledTrials };
  }, [datasets, sampleRate]);

  const xScale = scaleLinear({
    domain: [1, Math.max(...datasets.map((d) => d.totalTrials))],
    range: [0, innerWidth],
  });

  const yScale = scaleLinear({
    domain: [datasets.length + 0.5, 0.5],
    range: [innerHeight, 0],
  });

  // Count how many trials each tuner spent in each rank
  const rankStats = useMemo(() => {
    const stats: Record<string, { firstPlaceTrials: number; avgRank: number }> = {};

    for (const ds of datasets) {
      const dsRanks = rankData.ranks[ds.id] || [];
      const firstPlaceTrials = dsRanks.filter((r) => r.rank === 1).length;
      const avgRank = dsRanks.length > 0
        ? dsRanks.reduce((sum, r) => sum + r.rank, 0) / dsRanks.length
        : datasets.length;

      stats[ds.id] = { firstPlaceTrials, avgRank };
    }

    return stats;
  }, [datasets, rankData]);

  const handleMouseMove = (event: React.MouseEvent<SVGRectElement>) => {
    const point = localPoint(event);
    if (!point) return;

    const x = point.x - margin.left;
    const trial = Math.round(xScale.invert(x));

    if (trial < 1 || trial > Math.max(...datasets.map((d) => d.totalTrials))) {
      hideTooltip();
      return;
    }

    setHoveredTrial(trial);

    // Find closest sampled trial
    const closestTrial = rankData.trials.reduce((closest, t) =>
      Math.abs(t - trial) < Math.abs(closest - trial) ? t : closest
    , rankData.trials[0]);

    const rankings = datasets.map((ds) => {
      const rankPoint = rankData.ranks[ds.id]?.find((r) => r.trial === closestTrial);
      return {
        id: ds.id,
        label: ds.label,
        color: ds.color,
        rank: rankPoint?.rank ?? datasets.length,
        coverage: rankPoint?.coverage ?? 0,
        coveragePercent: rankPoint?.coveragePercent ?? 0,
      };
    }).sort((a, b) => a.rank - b.rank);

    showTooltip({
      tooltipLeft: xScale(trial) + margin.left + 10,
      tooltipTop: point.y,
      tooltipData: { trial: closestTrial, rankings },
    });
  };

  const handleMouseLeave = () => {
    setHoveredTrial(null);
    hideTooltip();
  };

  if (datasets.length === 0) {
    return (
      <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
        No data available
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', height }}>
      <svg width={width} height={height}>
        <Group left={margin.left} top={margin.top}>
          {/* Grid rows for each rank */}
          {Array.from({ length: datasets.length }, (_, i) => i + 1).map((rank) => (
            <line
              key={rank}
              x1={0}
              y1={yScale(rank)}
              x2={innerWidth}
              y2={yScale(rank)}
              stroke="#e5e7eb"
              strokeWidth={1}
              strokeDasharray="4,4"
            />
          ))}

          {/* Rank lines for each dataset */}
          {datasets.map((ds) => {
            const points = rankData.ranks[ds.id] || [];
            return (
              <LinePath
                key={ds.id}
                data={points}
                x={(d) => xScale(d.trial)}
                y={(d) => yScale(d.rank)}
                stroke={ds.color}
                strokeWidth={2.5}
                strokeOpacity={0.9}
                curve={curveMonotoneX}
              />
            );
          })}

          {/* Data points */}
          {datasets.map((ds) => {
            const points = rankData.ranks[ds.id] || [];
            return points.map((p, i) => (
              <circle
                key={`${ds.id}-${i}`}
                cx={xScale(p.trial)}
                cy={yScale(p.rank)}
                r={3}
                fill={ds.color}
                stroke="white"
                strokeWidth={1}
              />
            ));
          })}

          {/* Hover line */}
          {hoveredTrial !== null && (
            <line
              x1={xScale(hoveredTrial)}
              y1={0}
              x2={xScale(hoveredTrial)}
              y2={innerHeight}
              stroke="#6b7280"
              strokeWidth={1}
              strokeDasharray="3,2"
            />
          )}

          {/* Axes */}
          <AxisBottom
            top={innerHeight}
            scale={xScale}
            numTicks={10}
            tickLabelProps={() => ({ fontSize: 10, textAnchor: 'middle', fill: '#6b7280' })}
          />
          <AxisLeft
            scale={yScale}
            numTicks={datasets.length}
            tickValues={Array.from({ length: datasets.length }, (_, i) => i + 1)}
            tickFormat={(v) => {
              const rank = Number(v);
              if (rank === 1) return '1st';
              if (rank === 2) return '2nd';
              if (rank === 3) return '3rd';
              return `${rank}th`;
            }}
            tickLabelProps={() => ({ fontSize: 10, textAnchor: 'end', fill: '#6b7280', dx: -4 })}
          />

          {/* Axis labels */}
          <text
            x={innerWidth / 2}
            y={innerHeight + 40}
            textAnchor="middle"
            fontSize={12}
            fill="#374151"
          >
            Trial
          </text>
          <text
            transform="rotate(-90)"
            x={-innerHeight / 2}
            y={-45}
            textAnchor="middle"
            fontSize={12}
            fill="#374151"
          >
            Rank
          </text>

          {/* Invisible overlay for mouse tracking */}
          <Bar
            x={0}
            y={0}
            width={innerWidth}
            height={innerHeight}
            fill="transparent"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          />
        </Group>

        {/* Legend with rank stats */}
        <Group left={width - margin.right + 15} top={margin.top}>
          <text fontSize={11} fontWeight={600} fill="#374151">Tuners</text>
          {datasets.map((ds, i) => {
            const stats = rankStats[ds.id];
            return (
              <g key={ds.id} transform={`translate(0, ${20 + i * 45})`}>
                <line x1={0} y1={6} x2={20} y2={6} stroke={ds.color} strokeWidth={2.5} />
                <text x={26} y={10} fontSize={11} fill="#374151">
                  {ds.label}
                </text>
                <text x={0} y={24} fontSize={9} fill="#6b7280">
                  Avg rank: {stats?.avgRank.toFixed(2)}
                </text>
                <text x={0} y={36} fontSize={9} fill="#6b7280">
                  1st place: {((stats?.firstPlaceTrials / rankData.trials.length) * 100).toFixed(0)}%
                </text>
              </g>
            );
          })}
        </Group>
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
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              Trial {tooltipData.trial}
            </div>
            {tooltipData.rankings.map((r) => (
              <div
                key={r.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 4,
                }}
              >
                <div
                  style={{
                    width: 8,
                    height: 8,
                    backgroundColor: r.color,
                    borderRadius: 2,
                  }}
                />
                <span style={{ fontWeight: 500 }}>
                  #{r.rank}
                </span>
                <span style={{ fontSize: 10 }}>{r.label}</span>
                <span style={{ fontSize: 10, color: '#6b7280' }}>
                  ({r.coveragePercent.toFixed(1)}%)
                </span>
              </div>
            ))}
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
  padding: '8px 12px',
  fontSize: 11,
  lineHeight: 1.4,
  boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  pointerEvents: 'none',
  maxWidth: 200,
};
