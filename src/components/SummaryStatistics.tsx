/**
 * Summary Statistics Panel
 * Shows key metrics for comparing programs/tuners
 */

import { useMemo } from 'react';

interface TrialData {
  trialId: number;
  cumulativeCoverage: number;
  marginalCoverage: number;
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

interface SummaryStatisticsProps {
  datasets: DatasetStats[];
  compact?: boolean;
}

interface ComputedStats {
  id: string;
  label: string;
  color: string;
  trialTo90: number | null;
  trialTo95: number | null;
  discoveryRate: number;
  failureRate: number;
  auc: number;
  avgMarginal: number;
  maxMarginal: number;
}

export function SummaryStatistics({ datasets, compact = false }: SummaryStatisticsProps) {
  const stats = useMemo(() => {
    return datasets.map((ds): ComputedStats => {
      const threshold90 = ds.totalUniqueBranches * 0.9;
      const threshold95 = ds.totalUniqueBranches * 0.95;

      // Find trial to reach 90% and 95%
      let trialTo90: number | null = null;
      let trialTo95: number | null = null;

      for (const trial of ds.trials) {
        if (trialTo90 === null && trial.cumulativeCoverage >= threshold90) {
          trialTo90 = trial.trialId;
        }
        if (trialTo95 === null && trial.cumulativeCoverage >= threshold95) {
          trialTo95 = trial.trialId;
        }
        if (trialTo90 !== null && trialTo95 !== null) break;
      }

      // Discovery rate (trials with marginal > 0)
      const discoveries = ds.trials.filter((t) => t.marginalCoverage > 0).length;
      const discoveryRate = discoveries / ds.totalTrials;

      // Failure rate (trials with totalCovered = 0, excluding first trial)
      const failures = ds.trials.filter((t) => t.trialId > 1 && t.totalCovered === 0).length;
      const failureRate = failures / (ds.totalTrials - 1);

      // AUC (normalized area under cumulative curve)
      let auc = 0;
      for (const trial of ds.trials) {
        auc += trial.cumulativeCoverage / ds.totalUniqueBranches;
      }
      auc = auc / ds.totalTrials; // Normalize to 0-1

      // Average and max marginal coverage (excluding zeros)
      const nonZeroMarginals = ds.trials
        .filter((t) => t.marginalCoverage > 0)
        .map((t) => t.marginalCoverage);
      const avgMarginal = nonZeroMarginals.length > 0
        ? nonZeroMarginals.reduce((a, b) => a + b, 0) / nonZeroMarginals.length
        : 0;
      const maxMarginal = nonZeroMarginals.length > 0
        ? Math.max(...nonZeroMarginals)
        : 0;

      return {
        id: ds.id,
        label: ds.label,
        color: ds.color,
        trialTo90,
        trialTo95,
        discoveryRate,
        failureRate,
        auc,
        avgMarginal,
        maxMarginal,
      };
    });
  }, [datasets]);

  if (datasets.length === 0) {
    return null;
  }

  const containerStyle: React.CSSProperties = {
    padding: compact ? '8px' : '12px 16px',
    backgroundColor: '#f9fafb',
    borderRadius: compact ? 4 : 8,
    fontSize: compact ? 10 : 12,
  };

  const thStyle: React.CSSProperties = {
    textAlign: 'left',
    padding: compact ? '4px 6px' : '8px 12px',
    borderBottom: '1px solid #e5e7eb',
    color: '#6b7280',
    fontWeight: 500,
    fontSize: compact ? 9 : 11,
  };

  const tdStyle: React.CSSProperties = {
    padding: compact ? '4px 6px' : '8px 12px',
    borderBottom: '1px solid #f3f4f6',
  };

  const tdNumStyle: React.CSSProperties = {
    ...tdStyle,
    textAlign: 'right',
    fontFamily: 'monospace',
  };

  return (
    <div style={containerStyle}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Tuner</th>
            <th style={thStyle}>@90%</th>
            <th style={thStyle}>@95%</th>
            <th style={thStyle}>Disc.</th>
            <th style={thStyle}>Fail</th>
            <th style={thStyle}>AUC</th>
            {!compact && <th style={thStyle}>Avg</th>}
            {!compact && <th style={thStyle}>Max</th>}
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.id}>
              <td style={tdStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div
                    style={{
                      width: compact ? 8 : 10,
                      height: compact ? 8 : 10,
                      backgroundColor: s.color,
                      borderRadius: 2,
                    }}
                  />
                  <span style={{ fontWeight: 500 }}>{s.label}</span>
                </div>
              </td>
              <td style={tdNumStyle}>
                {s.trialTo90 !== null ? (
                  <span>{s.trialTo90.toLocaleString()}</span>
                ) : (
                  <span style={{ color: '#9ca3af' }}>-</span>
                )}
              </td>
              <td style={tdNumStyle}>
                {s.trialTo95 !== null ? (
                  <span>{s.trialTo95.toLocaleString()}</span>
                ) : (
                  <span style={{ color: '#9ca3af' }}>-</span>
                )}
              </td>
              <td style={tdNumStyle}>
                <span style={{ color: s.discoveryRate > 0.1 ? '#10b981' : '#6b7280' }}>
                  {(s.discoveryRate * 100).toFixed(1)}%
                </span>
              </td>
              <td style={tdNumStyle}>
                <span style={{ color: s.failureRate > 0.1 ? '#ef4444' : '#6b7280' }}>
                  {(s.failureRate * 100).toFixed(1)}%
                </span>
              </td>
              <td style={tdNumStyle}>
                <span style={{ fontWeight: 500 }}>{s.auc.toFixed(3)}</span>
              </td>
              {!compact && <td style={tdNumStyle}>{s.avgMarginal.toFixed(1)}</td>}
              {!compact && <td style={tdNumStyle}>{s.maxMarginal.toLocaleString()}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {!compact && (
        <div style={legendStyle}>
          <span><strong>@90/95%</strong>: Trial to reach threshold</span>
          <span><strong>Disc.</strong>: Discovery rate</span>
          <span><strong>Fail</strong>: Failure rate</span>
          <span><strong>AUC</strong>: Area under curve</span>
        </div>
      )}
    </div>
  );
}

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
};

const legendStyle: React.CSSProperties = {
  marginTop: 12,
  paddingTop: 12,
  borderTop: '1px solid #e5e7eb',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px 24px',
  fontSize: 10,
  color: '#9ca3af',
};
