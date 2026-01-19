/**
 * Tuner Radar Chart
 * Multi-dimensional comparison of tuners across various metrics
 */

import { useMemo } from 'react';
import { Group } from '@visx/group';
import { scaleLinear } from '@visx/scale';
import { Text } from '@visx/text';

interface TrialData {
  trialId: number;
  marginalCoverage: number;
  cumulativeCoverage: number;
  totalCovered: number;
}

interface DatasetStats {
  id: string;
  label: string;
  color: string;
  trials: TrialData[];
  totalTrials: number;
  totalUniqueBranches: number;
}

interface TunerRadarChartProps {
  datasets: DatasetStats[];
  width?: number;
  height?: number;
}

interface MetricData {
  metric: string;
  fullName: string;
  values: { id: string; value: number; normalized: number }[];
}

const METRICS = [
  { key: 'coverage', label: 'Cov', fullName: 'Final Coverage' },
  { key: 'speed', label: 'Spd', fullName: 'Convergence Speed' },
  { key: 'efficiency', label: 'Eff', fullName: 'Discovery Rate' },
  { key: 'reliability', label: 'Rel', fullName: 'Reliability' },
  { key: 'consistency', label: 'Con', fullName: 'Consistency' },
];

export function TunerRadarChart({
  datasets,
  width = 400,
  height = 200,
}: TunerRadarChartProps) {
  // More compact layout
  const chartSize = Math.min(width * 0.55, height - 20);
  const centerX = chartSize / 2 + 10;
  const centerY = height / 2;
  const radius = chartSize / 2 - 30;

  // Compute metrics for each dataset
  const metricsData = useMemo(() => {
    const metrics: MetricData[] = [];
    const rawValues: Record<string, { id: string; label: string; color: string; value: number }[]> = {};

    for (const metric of METRICS) {
      rawValues[metric.key] = datasets.map((ds) => {
        let value = 0;

        switch (metric.key) {
          case 'coverage': {
            const lastTrial = ds.trials[ds.trials.length - 1];
            value = lastTrial ? (lastTrial.cumulativeCoverage / ds.totalUniqueBranches) * 100 : 0;
            break;
          }
          case 'speed': {
            const threshold = ds.totalUniqueBranches * 0.9;
            const trialTo90 = ds.trials.find((t) => t.cumulativeCoverage >= threshold)?.trialId;
            value = trialTo90 ? (1 - trialTo90 / ds.totalTrials) * 100 : 0;
            break;
          }
          case 'efficiency': {
            const discoveries = ds.trials.filter((t) => t.marginalCoverage > 0).length;
            value = (discoveries / ds.totalTrials) * 100;
            break;
          }
          case 'reliability': {
            const failures = ds.trials.filter((t) => t.trialId > 1 && t.totalCovered === 0).length;
            const failureRate = failures / (ds.totalTrials - 1);
            value = (1 - failureRate) * 100;
            break;
          }
          case 'consistency': {
            let auc = 0;
            for (const trial of ds.trials) {
              auc += trial.cumulativeCoverage / ds.totalUniqueBranches;
            }
            value = (auc / ds.totalTrials) * 100;
            break;
          }
        }

        return { id: ds.id, label: ds.label, color: ds.color, value };
      });
    }

    for (const metric of METRICS) {
      const values = rawValues[metric.key];
      const maxValue = Math.max(...values.map((v) => v.value), 1);

      metrics.push({
        metric: metric.label,
        fullName: metric.fullName,
        values: values.map((v) => ({
          id: v.id,
          value: v.value,
          normalized: v.value / maxValue,
        })),
      });
    }

    return metrics;
  }, [datasets]);

  const angleSlice = (Math.PI * 2) / METRICS.length;

  const radiusScale = scaleLinear({
    domain: [0, 1],
    range: [0, radius],
  });

  const radarData = useMemo(() => {
    return datasets.map((ds) => {
      const points: { x: number; y: number; value: number; metric: string }[] = [];

      metricsData.forEach((metric, i) => {
        const dataPoint = metric.values.find((v) => v.id === ds.id);
        const normalizedValue = dataPoint?.normalized ?? 0;
        const angle = i * angleSlice - Math.PI / 2;
        const r = radiusScale(normalizedValue);

        points.push({
          x: r * Math.cos(angle),
          y: r * Math.sin(angle),
          value: dataPoint?.value ?? 0,
          metric: metric.metric,
        });
      });

      return {
        id: ds.id,
        label: ds.label,
        color: ds.color,
        points,
      };
    });
  }, [datasets, metricsData, angleSlice, radiusScale]);

  const levels = [0.25, 0.5, 0.75, 1.0];

  if (datasets.length === 0) {
    return (
      <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
        No data available
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', height }}>
      <svg width={chartSize + 20} height={height}>
        <Group left={centerX} top={centerY}>
          {/* Grid circles */}
          {levels.map((level, i) => (
            <circle
              key={i}
              cx={0}
              cy={0}
              r={radiusScale(level)}
              fill="none"
              stroke="#e5e7eb"
              strokeWidth={1}
              strokeDasharray={i === levels.length - 1 ? 'none' : '2,2'}
            />
          ))}

          {/* Axis lines and labels */}
          {METRICS.map((metric, i) => {
            const angle = i * angleSlice - Math.PI / 2;
            const x = radius * Math.cos(angle);
            const y = radius * Math.sin(angle);
            const labelX = (radius + 14) * Math.cos(angle);
            const labelY = (radius + 14) * Math.sin(angle);

            return (
              <g key={metric.key}>
                <line
                  x1={0}
                  y1={0}
                  x2={x}
                  y2={y}
                  stroke="#d1d5db"
                  strokeWidth={1}
                />
                <Text
                  x={labelX}
                  y={labelY}
                  textAnchor="middle"
                  verticalAnchor="middle"
                  fontSize={9}
                  fontWeight={500}
                  fill="#6b7280"
                >
                  {metric.label}
                </Text>
              </g>
            );
          })}

          {/* Data polygons */}
          {radarData.map((data) => {
            const pathData = data.points
              .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`)
              .join(' ') + ' Z';

            return (
              <g key={data.id}>
                <path
                  d={pathData}
                  fill={data.color}
                  fillOpacity={0.15}
                  stroke={data.color}
                  strokeWidth={1.5}
                  strokeOpacity={0.8}
                />
                {data.points.map((p, i) => (
                  <circle
                    key={i}
                    cx={p.x}
                    cy={p.y}
                    r={3}
                    fill={data.color}
                    stroke="white"
                    strokeWidth={1}
                  />
                ))}
              </g>
            );
          })}
        </Group>
      </svg>

      {/* Compact table legend */}
      <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid #e5e7eb', color: '#6b7280', fontWeight: 500 }}>
                Metric
              </th>
              {radarData.map((data) => (
                <th key={data.id} style={{ textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid #e5e7eb', minWidth: 50 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        backgroundColor: data.color,
                        borderRadius: 2,
                      }}
                    />
                    <span style={{ fontWeight: 600, color: '#374151' }}>{data.label}</span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {METRICS.map((m, i) => (
              <tr key={m.key}>
                <td style={{ padding: '3px 8px', color: '#6b7280', borderBottom: '1px solid #f3f4f6' }}>
                  {m.fullName}
                </td>
                {radarData.map((data) => (
                  <td
                    key={data.id}
                    style={{
                      textAlign: 'right',
                      padding: '3px 8px',
                      fontWeight: 500,
                      color: data.color,
                      fontFamily: 'monospace',
                      borderBottom: '1px solid #f3f4f6',
                    }}
                  >
                    {data.points[i].value.toFixed(1)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
