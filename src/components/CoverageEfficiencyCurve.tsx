/**
 * Coverage Efficiency Curve
 * Shows how efficiently each tuner uses trials to achieve coverage
 * X: % of trials used, Y: % of coverage achieved
 * Includes Oracle (optimal ordering) comparison
 */

import { useMemo, useState } from 'react';
import { Group } from '@visx/group';
import { scaleLinear } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows, GridColumns } from '@visx/grid';
import { LinePath, AreaClosed } from '@visx/shape';
import { curveMonotoneX } from '@visx/curve';
import { useTooltip, TooltipWithBounds } from '@visx/tooltip';
import { localPoint } from '@visx/event';
import { Bar } from '@visx/shape';

interface TrialData {
  trialId: number;
  marginalCoverage: number;
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

interface CoverageEfficiencyCurveProps {
  datasets: DatasetStats[];
  width?: number;
  height?: number;
}

interface EfficiencyPoint {
  trialPercent: number;
  coveragePercent: number;
}

interface TooltipData {
  trialPercent: number;
  values: { id: string; label: string; color: string; coverage: number; isOracle?: boolean }[];
}

export function CoverageEfficiencyCurve({
  datasets,
  width = 1000,
  height = 350,
}: CoverageEfficiencyCurveProps) {
  const margin = { top: 20, right: 150, bottom: 50, left: 60 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const [showOracle, setShowOracle] = useState(true);
  const [hoveredPercent, setHoveredPercent] = useState<number | null>(null);

  const { tooltipOpen, tooltipLeft, tooltipTop, tooltipData, showTooltip, hideTooltip } =
    useTooltip<TooltipData>();

  // Compute efficiency curves for each dataset
  const efficiencyCurves = useMemo(() => {
    return datasets.map((ds) => {
      // Actual order (as executed)
      const actualCurve: EfficiencyPoint[] = [];
      for (let i = 0; i < ds.trials.length; i++) {
        const trial = ds.trials[i];
        actualCurve.push({
          trialPercent: ((i + 1) / ds.totalTrials) * 100,
          coveragePercent: (trial.cumulativeCoverage / ds.totalUniqueBranches) * 100,
        });
      }

      // Oracle order (sorted by marginal coverage, highest first)
      const sortedTrials = [...ds.trials].sort((a, b) => b.marginalCoverage - a.marginalCoverage);
      const oracleCurve: EfficiencyPoint[] = [];
      let oracleCumulative = 0;
      for (let i = 0; i < sortedTrials.length; i++) {
        oracleCumulative += sortedTrials[i].marginalCoverage;
        oracleCurve.push({
          trialPercent: ((i + 1) / ds.totalTrials) * 100,
          coveragePercent: (oracleCumulative / ds.totalUniqueBranches) * 100,
        });
      }

      // Calculate AUC for both curves (normalized 0-1)
      const actualAuc = actualCurve.reduce((sum, p, i) => {
        const prev = i > 0 ? actualCurve[i - 1].coveragePercent : 0;
        return sum + (p.coveragePercent + prev) / 2 / 100;
      }, 0) / actualCurve.length;

      const oracleAuc = oracleCurve.reduce((sum, p, i) => {
        const prev = i > 0 ? oracleCurve[i - 1].coveragePercent : 0;
        return sum + (p.coveragePercent + prev) / 2 / 100;
      }, 0) / oracleCurve.length;

      // Efficiency ratio
      const efficiencyRatio = actualAuc / oracleAuc;

      return {
        id: ds.id,
        label: ds.label,
        color: ds.color,
        actualCurve,
        oracleCurve,
        actualAuc,
        oracleAuc,
        efficiencyRatio,
      };
    });
  }, [datasets]);

  const xScale = scaleLinear({
    domain: [0, 100],
    range: [0, innerWidth],
  });

  const yScale = scaleLinear({
    domain: [0, 100],
    range: [innerHeight, 0],
  });

  const handleMouseMove = (event: React.MouseEvent<SVGRectElement>) => {
    const point = localPoint(event);
    if (!point) return;

    const x = point.x - margin.left;
    const trialPercent = xScale.invert(x);

    if (trialPercent < 0 || trialPercent > 100) {
      hideTooltip();
      return;
    }

    setHoveredPercent(trialPercent);

    const values = efficiencyCurves.flatMap((curve) => {
      const results = [];

      // Find actual coverage at this percent
      const actualIdx = Math.min(
        Math.floor((trialPercent / 100) * curve.actualCurve.length),
        curve.actualCurve.length - 1
      );
      const actualCoverage = curve.actualCurve[actualIdx]?.coveragePercent ?? 0;
      results.push({
        id: curve.id,
        label: curve.label,
        color: curve.color,
        coverage: actualCoverage,
      });

      // Find oracle coverage at this percent
      if (showOracle) {
        const oracleIdx = Math.min(
          Math.floor((trialPercent / 100) * curve.oracleCurve.length),
          curve.oracleCurve.length - 1
        );
        const oracleCoverage = curve.oracleCurve[oracleIdx]?.coveragePercent ?? 0;
        results.push({
          id: `${curve.id}-oracle`,
          label: `${curve.label} (Oracle)`,
          color: curve.color,
          coverage: oracleCoverage,
          isOracle: true,
        });
      }

      return results;
    });

    showTooltip({
      tooltipLeft: xScale(trialPercent) + margin.left + 10,
      tooltipTop: point.y,
      tooltipData: { trialPercent, values },
    });
  };

  const handleMouseLeave = () => {
    setHoveredPercent(null);
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
      {/* Controls */}
      <div style={{ position: 'absolute', top: 0, right: margin.right + 10, zIndex: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#6b7280', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showOracle}
            onChange={(e) => setShowOracle(e.target.checked)}
          />
          Show Oracle (optimal)
        </label>
      </div>

      <svg width={width} height={height}>
        <Group left={margin.left} top={margin.top}>
          <GridRows scale={yScale} width={innerWidth} stroke="#e5e7eb" strokeOpacity={0.5} />
          <GridColumns scale={xScale} height={innerHeight} stroke="#e5e7eb" strokeOpacity={0.5} />

          {/* Diagonal reference line (random baseline) */}
          <line
            x1={0}
            y1={innerHeight}
            x2={innerWidth}
            y2={0}
            stroke="#d1d5db"
            strokeWidth={1}
            strokeDasharray="4,4"
          />

          {/* Oracle curves (dashed, behind actual) */}
          {showOracle && efficiencyCurves.map((curve) => (
            <LinePath
              key={`oracle-${curve.id}`}
              data={curve.oracleCurve}
              x={(d) => xScale(d.trialPercent)}
              y={(d) => yScale(d.coveragePercent)}
              stroke={curve.color}
              strokeWidth={1.5}
              strokeOpacity={0.4}
              strokeDasharray="6,3"
              curve={curveMonotoneX}
            />
          ))}

          {/* Actual curves */}
          {efficiencyCurves.map((curve) => (
            <LinePath
              key={`actual-${curve.id}`}
              data={curve.actualCurve}
              x={(d) => xScale(d.trialPercent)}
              y={(d) => yScale(d.coveragePercent)}
              stroke={curve.color}
              strokeWidth={2.5}
              strokeOpacity={0.9}
              curve={curveMonotoneX}
            />
          ))}

          {/* Hover line */}
          {hoveredPercent !== null && (
            <line
              x1={xScale(hoveredPercent)}
              y1={0}
              x2={xScale(hoveredPercent)}
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
            tickFormat={(v) => `${v}%`}
            tickLabelProps={() => ({ fontSize: 10, textAnchor: 'middle', fill: '#6b7280' })}
          />
          <AxisLeft
            scale={yScale}
            numTicks={10}
            tickFormat={(v) => `${v}%`}
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
            Trials Used (%)
          </text>
          <text
            transform="rotate(-90)"
            x={-innerHeight / 2}
            y={-45}
            textAnchor="middle"
            fontSize={12}
            fill="#374151"
          >
            Coverage Achieved (%)
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

        {/* Legend with efficiency ratios */}
        <Group left={width - margin.right + 15} top={margin.top + 20}>
          <text fontSize={11} fontWeight={600} fill="#374151">Efficiency</text>
          {efficiencyCurves.map((curve, i) => (
            <g key={curve.id} transform={`translate(0, ${20 + i * 40})`}>
              <line x1={0} y1={6} x2={20} y2={6} stroke={curve.color} strokeWidth={2.5} />
              <text x={26} y={10} fontSize={11} fill="#374151">
                {curve.label}
              </text>
              <text x={0} y={26} fontSize={10} fill="#6b7280">
                {(curve.efficiencyRatio * 100).toFixed(1)}% of optimal
              </text>
            </g>
          ))}

          {showOracle && (
            <g transform={`translate(0, ${20 + efficiencyCurves.length * 40 + 10})`}>
              <line x1={0} y1={6} x2={20} y2={6} stroke="#9ca3af" strokeWidth={1.5} strokeDasharray="6,3" />
              <text x={26} y={10} fontSize={10} fill="#9ca3af">
                Oracle (optimal)
              </text>
            </g>
          )}
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
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {tooltipData.trialPercent.toFixed(0)}% of trials
            </div>
            {tooltipData.values.map((v) => (
              <div
                key={v.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  marginBottom: 2,
                  opacity: v.isOracle ? 0.6 : 1,
                }}
              >
                <div
                  style={{
                    width: 8,
                    height: v.isOracle ? 2 : 8,
                    backgroundColor: v.color,
                    borderRadius: v.isOracle ? 0 : 2,
                  }}
                />
                <span style={{ fontSize: 10 }}>{v.label}:</span>
                <span style={{ fontWeight: 500 }}>{v.coverage.toFixed(1)}%</span>
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
  fontSize: 11,
  lineHeight: 1.4,
  boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  pointerEvents: 'none',
  maxWidth: 200,
};
