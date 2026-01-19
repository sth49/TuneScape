/**
 * Cumulative Coverage Comparison Chart
 * Shows cumulative coverage curves for multiple programs/tuners
 * Designed for easy transition from program comparison to tuner comparison
 */

import { useMemo, useState } from 'react';
import { Group } from '@visx/group';
import { scaleLinear } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows } from '@visx/grid';
import { LinePath } from '@visx/shape';
import { curveMonotoneX } from '@visx/curve';
import { useTooltip, TooltipWithBounds } from '@visx/tooltip';
import { localPoint } from '@visx/event';
import { bisector } from 'd3-array';
import { Bar } from '@visx/shape';

interface ComparisonDataset {
  id: string;
  label: string;
  color: string;
  trials: { trialId: number; cumulativeCoverage: number; marginalCoverage: number }[];
  totalTrials: number;
  totalUniqueBranches: number;
}

interface CumulativeComparisonChartProps {
  datasets: ComparisonDataset[];
  width?: number;
  height?: number;
  normalize?: boolean; // Show as percentage of max coverage
}

interface TooltipData {
  trialId: number;
  values: { id: string; label: string; color: string; coverage: number; percent: number }[];
}

const bisectTrial = bisector<{ trialId: number; cumulativeCoverage: number }, number>(
  (d) => d.trialId
).left;

export function CumulativeComparisonChart({
  datasets,
  width = 1000,
  height = 300,
  normalize = false,
}: CumulativeComparisonChartProps) {
  const margin = { top: 20, right: 120, bottom: 50, left: 70 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const [hoveredTrial, setHoveredTrial] = useState<number | null>(null);

  const { tooltipOpen, tooltipLeft, tooltipTop, tooltipData, showTooltip, hideTooltip } =
    useTooltip<TooltipData>();

  // Find max values for scales
  const { maxTrials, maxCoverage } = useMemo(() => {
    let maxT = 0;
    let maxC = 0;
    for (const ds of datasets) {
      maxT = Math.max(maxT, ds.totalTrials);
      maxC = Math.max(maxC, ds.totalUniqueBranches);
    }
    return { maxTrials: maxT, maxCoverage: maxC };
  }, [datasets]);

  const xScale = useMemo(
    () => scaleLinear({ domain: [1, maxTrials], range: [0, innerWidth] }),
    [maxTrials, innerWidth]
  );

  const yScale = useMemo(
    () =>
      scaleLinear({
        domain: [0, normalize ? 100 : maxCoverage],
        range: [innerHeight, 0],
        nice: true,
      }),
    [maxCoverage, innerHeight, normalize]
  );

  const handleMouseMove = (event: React.MouseEvent<SVGRectElement>) => {
    const point = localPoint(event);
    if (!point || datasets.length === 0) return;

    const x0 = xScale.invert(point.x - margin.left);
    const trialId = Math.round(x0);

    if (trialId < 1 || trialId > maxTrials) {
      hideTooltip();
      return;
    }

    setHoveredTrial(trialId);

    const values = datasets.map((ds) => {
      const idx = Math.min(trialId - 1, ds.trials.length - 1);
      const trial = ds.trials[idx];
      const coverage = trial?.cumulativeCoverage ?? 0;
      const percent = ds.totalUniqueBranches > 0
        ? (coverage / ds.totalUniqueBranches) * 100
        : 0;
      return {
        id: ds.id,
        label: ds.label,
        color: ds.color,
        coverage,
        percent,
      };
    });

    // Find the y position of the middle dataset's point for tooltip
    const midIdx = Math.floor(datasets.length / 2);
    const midDs = datasets[midIdx];
    const midTrialIdx = Math.min(trialId - 1, midDs.trials.length - 1);
    const midTrial = midDs.trials[midTrialIdx];
    const midY = midTrial
      ? yScale(normalize ? (midTrial.cumulativeCoverage / midDs.totalUniqueBranches) * 100 : midTrial.cumulativeCoverage)
      : innerHeight / 2;

    showTooltip({
      tooltipLeft: xScale(trialId) + margin.left + 15,
      tooltipTop: midY + margin.top,
      tooltipData: { trialId, values },
    });
  };

  const handleMouseLeave = () => {
    setHoveredTrial(null);
    hideTooltip();
  };

  if (datasets.length === 0) {
    return (
      <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
        No data to compare
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', height }}>
      <svg width={width} height={height}>
        <Group left={margin.left} top={margin.top}>
          <GridRows scale={yScale} width={innerWidth} stroke="#e5e7eb" strokeOpacity={0.5} />

          {/* Coverage lines for each dataset */}
          {datasets.map((ds) => (
            <LinePath
              key={ds.id}
              data={ds.trials}
              x={(d) => xScale(d.trialId)}
              y={(d) =>
                yScale(
                  normalize
                    ? (d.cumulativeCoverage / ds.totalUniqueBranches) * 100
                    : d.cumulativeCoverage
                )
              }
              stroke={ds.color}
              strokeWidth={2}
              strokeOpacity={0.8}
              curve={curveMonotoneX}
            />
          ))}

          {/* Hover indicator line */}
          {hoveredTrial && (
            <line
              x1={xScale(hoveredTrial)}
              y1={0}
              x2={xScale(hoveredTrial)}
              y2={innerHeight}
              stroke="#6b7280"
              strokeWidth={1}
              strokeDasharray="4,2"
            />
          )}

          {/* Hover points on each line */}
          {hoveredTrial &&
            datasets.map((ds) => {
              const idx = Math.min(hoveredTrial - 1, ds.trials.length - 1);
              const trial = ds.trials[idx];
              if (!trial) return null;
              const yVal = normalize
                ? (trial.cumulativeCoverage / ds.totalUniqueBranches) * 100
                : trial.cumulativeCoverage;
              return (
                <circle
                  key={`hover-${ds.id}`}
                  cx={xScale(hoveredTrial)}
                  cy={yScale(yVal)}
                  r={5}
                  fill={ds.color}
                  stroke="white"
                  strokeWidth={2}
                />
              );
            })}

          <AxisBottom
            top={innerHeight}
            scale={xScale}
            numTicks={10}
            tickLabelProps={() => ({ fontSize: 10, textAnchor: 'middle', fill: '#6b7280' })}
          />
          <AxisLeft
            scale={yScale}
            numTicks={6}
            tickLabelProps={() => ({ fontSize: 10, textAnchor: 'end', fill: '#6b7280', dx: -4 })}
            tickFormat={(v) => (normalize ? `${v}%` : v.toLocaleString())}
          />

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
            y={-55}
            textAnchor="middle"
            fontSize={12}
            fill="#374151"
          >
            {normalize ? 'Coverage (%)' : 'Cumulative Branches'}
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

        {/* Legend */}
        <Group left={width - margin.right + 20} top={margin.top}>
          {datasets.map((ds, i) => (
            <g key={ds.id} transform={`translate(0, ${i * 24})`}>
              <line x1={0} y1={6} x2={20} y2={6} stroke={ds.color} strokeWidth={3} />
              <text x={26} y={10} fontSize={11} fill="#374151">
                {ds.label}
              </text>
            </g>
          ))}
        </Group>
      </svg>

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
            <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 11 }}>Trial {tooltipData.trialId}</div>
            {tooltipData.values.map((v) => (
              <div
                key={v.id}
                style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2, fontSize: 10 }}
              >
                <div
                  style={{
                    width: 8,
                    height: 8,
                    backgroundColor: v.color,
                    borderRadius: 2,
                    flexShrink: 0,
                  }}
                />
                <span style={{ color: '#374151' }}>{v.label}</span>
                <span style={{ fontWeight: 500 }}>{v.coverage.toLocaleString()}</span>
                <span style={{ color: '#9ca3af' }}>({v.percent.toFixed(1)}%)</span>
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
  padding: '6px 10px',
  fontSize: 10,
  lineHeight: 1.4,
  boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  pointerEvents: 'none',
  maxWidth: 180,
};
