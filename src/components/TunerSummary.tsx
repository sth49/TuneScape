import React, { useEffect, useState, useMemo } from "react";
import {
  TUNER_COLORS,
  TUNER_NAMES,
  type TunerType,
} from "../utils/hexMapUtils";
import { IoEye, IoEyeOff } from "react-icons/io5";

interface RawTrial {
  tuner: TunerType;
  coverage: number;
}

interface RawCluster {
  tunerCoveredBranches: Partial<Record<TunerType, number[]>>;
  coveredBranches: number[];
}

interface TunerStats {
  tuner: TunerType | null;
  label: string;
  color: string | null;
  trialCount: number;
  meanBranches: number;
  minBranches: number;
  maxBranches: number;
  cumulativeBranches: number;
  failCount: number;
  bestPartner: TunerType | null;
  bestPartnerGainBranches: number;
}

const SHORT_NAMES: Record<TunerType, string> = {
  SymTuner: "Sym",
  CMA_ES: "CMA",
  Genetic: "Gen",
  SuccessiveHalving: "SH",
  TPE: "TPE",
  BayesianOptimization: "BO",
};

export interface TunerSummaryProps {
  program: string;
  selectedTuners: Set<TunerType>;
  onToggleTuner: (tuner: TunerType) => void;
  onSetAllTuners?: (tuners: Set<TunerType>) => void;
}

export function TunerSummary({
  program,
  selectedTuners,
  onToggleTuner,
  onSetAllTuners,
}: TunerSummaryProps) {
  const [trials, setTrials] = useState<RawTrial[]>([]);
  const [clusters, setClusters] = useState<RawCluster[]>([]);
  const [totalUniqueBranches, setTotalUniqueBranches] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/data/${program}_hexmap_precomputed.json`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        setTrials(json.trials);
        const finest = json.levels?.[json.levels.length - 1];
        setClusters(finest?.clusters ?? []);
        setTotalUniqueBranches(finest?.totalUniqueBranches ?? 0);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [program]);

  const stats = useMemo<TunerStats[]>(() => {
    if (!trials.length || totalUniqueBranches === 0) return [];

    const byTuner = new Map<TunerType, RawTrial[]>();
    for (const t of TUNER_NAMES) byTuner.set(t, []);
    for (const t of trials) {
      const arr = byTuner.get(t.tuner);
      if (arr) arr.push(t);
    }

    const branchSets = new Map<TunerType, Set<number>>();
    for (const t of TUNER_NAMES) branchSets.set(t, new Set());
    for (const c of clusters) {
      if (c.tunerCoveredBranches) {
        for (const [tuner, branches] of Object.entries(
          c.tunerCoveredBranches,
        )) {
          const s = branchSets.get(tuner as TunerType);
          if (s && branches) {
            for (const b of branches) s.add(b);
          }
        }
      }
    }

    const toBranches = (cov: number) => Math.round(cov * totalUniqueBranches);

    // "All" row
    const allCoverages = trials.map((t) => t.coverage);
    const allMean =
      allCoverages.reduce((a, b) => a + b, 0) / allCoverages.length;
    const allMin = Math.min(...allCoverages);
    const allMax = Math.max(...allCoverages);
    const allBranchSet = new Set<number>();
    for (const c of clusters) {
      if (c.coveredBranches) {
        for (const b of c.coveredBranches) allBranchSet.add(b);
      }
    }
    const allFail = allCoverages.filter((c) => c === 0).length;

    const result: TunerStats[] = [
      {
        tuner: null,
        label: "All",
        color: null,
        trialCount: trials.length,
        meanBranches: toBranches(allMean),
        minBranches: toBranches(allMin),
        maxBranches: toBranches(allMax),
        cumulativeBranches: allBranchSet.size,
        failCount: allFail,
        bestPartner: null,
        bestPartnerGainBranches: 0,
      },
    ];

    for (const tuner of TUNER_NAMES) {
      const tTrials = byTuner.get(tuner)!;
      if (tTrials.length === 0) continue;

      const coverages = tTrials.map((t) => t.coverage);
      const meanCov = coverages.reduce((a, b) => a + b, 0) / coverages.length;
      const minCov = Math.min(...coverages);
      const maxCov = Math.max(...coverages);
      const myBranches = branchSets.get(tuner)!;
      const failCount = coverages.filter((c) => c === 0).length;

      let bestPartner: TunerType | null = null;
      let bestPartnerGainBranches = 0;
      for (const other of TUNER_NAMES) {
        if (other === tuner) continue;
        const otherBranches = branchSets.get(other)!;
        let newCount = 0;
        for (const b of otherBranches) {
          if (!myBranches.has(b)) newCount++;
        }
        if (newCount > bestPartnerGainBranches) {
          bestPartnerGainBranches = newCount;
          bestPartner = other;
        }
      }

      result.push({
        tuner,
        label: SHORT_NAMES[tuner],
        color: TUNER_COLORS[tuner],
        trialCount: tTrials.length,
        meanBranches: toBranches(meanCov),
        minBranches: toBranches(minCov),
        maxBranches: toBranches(maxCov),
        cumulativeBranches: myBranches.size,
        failCount,
        bestPartner,
        bestPartnerGainBranches,
      });
    }

    return result;
  }, [trials, clusters, totalUniqueBranches]);

  if (loading) {
    return (
      <div style={{ background: "white", borderRadius: 10, padding: 12 }}>
        <div style={{ color: "#9CA3AF", fontSize: 12 }}>Loading...</div>
      </div>
    );
  }

  if (!stats.length) return null;

  const cellStyle: React.CSSProperties = {
    padding: "5px 6px",
    textAlign: "right",
    fontFamily: "monospace",
    // color: "#374151",
  };

  return (
    <div
      style={{
        background: "white",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "10px 14px 8px",
          borderBottom: "1px solid #F1F5F9",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 15, color: "#1E293B" }}>
          Tuner Summary
        </span>
        <span
          style={{ fontSize: 11, color: "#94A3B8", fontFamily: "monospace" }}
        >
          {totalUniqueBranches.toLocaleString()} branches
        </span>
      </div>

      {/* Table */}
      <div style={{ padding: 3 }}>
        <table
          style={{
            width: "100%",
            fontSize: 11,
            borderCollapse: "collapse",
          }}
        >
          <thead>
            <tr
              style={{
                color: "#1E293B",
                fontWeight: 700,
                fontSize: 13,
                alignItems: "center",
                borderBottom: "1.5px solid #E5E7EB",
              }}
            >
              <th style={{ textAlign: "center", padding: "5px 6px" }}>Tuner</th>
              <th style={{ textAlign: "center", padding: "5px 6px" }}>Mean</th>
              <th style={{ textAlign: "center", padding: "5px 6px" }}>Min</th>
              <th style={{ textAlign: "center", padding: "5px 6px" }}>Max</th>
              <th style={{ textAlign: "center", padding: "5px 6px" }}>Cum.</th>
              <th style={{ textAlign: "center", padding: "5px 6px" }}>Fail</th>
              <th style={{ textAlign: "center", padding: "5px 6px" }}>
                Partner
              </th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s, i) => {
              const isAll = s.tuner === null;
              const allVisible = selectedTuners.size === TUNER_NAMES.length;
              const isVisible = isAll
                ? allVisible
                : selectedTuners.has(s.tuner!);
              const failRatio =
                s.trialCount > 0 ? s.failCount / s.trialCount : 0;
              return (
                <tr
                  key={s.label}
                  style={{
                    borderBottom: "1px solid #E5E7EB",
                  }}
                >
                  {/* Eye icon + Tuner name */}
                  <td style={{ padding: "5px 6px", fontWeight: 600 }}>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 4 }}
                    >
                      <span
                        onClick={() => {
                          if (isAll && onSetAllTuners) {
                            onSetAllTuners(
                              allVisible
                                ? new Set([TUNER_NAMES[0]])
                                : new Set(TUNER_NAMES),
                            );
                          } else if (!isAll) {
                            onToggleTuner(s.tuner!);
                          }
                        }}
                        style={{
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 25,
                          height: 25,
                          color: "#a0a5ac",
                          fontSize: 12,
                          flexShrink: 0,
                        }}
                      >
                        {isVisible ? <IoEye /> : <IoEyeOff />}
                      </span>
                      <span
                        style={{
                          padding: "1px 6px",
                          borderRadius: 4,
                          fontSize: 11,
                          background: s.color ?? "#F1F5F9",
                          color: s.color ? "#fff" : "#1E293B",
                          fontWeight: 700,
                          lineHeight: 1.4,
                        }}
                      >
                        {s.label}
                      </span>
                    </div>
                  </td>

                  <td style={cellStyle}>{s.meanBranches.toLocaleString()}</td>
                  <td style={cellStyle}>{s.minBranches.toLocaleString()}</td>
                  <td style={cellStyle}>{s.maxBranches.toLocaleString()}</td>
                  <td style={cellStyle}>
                    {s.cumulativeBranches.toLocaleString()}
                  </td>

                  <td
                    style={{
                      ...cellStyle,
                      color:
                        failRatio > 0.3
                          ? "#EF4444"
                          : failRatio > 0.1
                            ? "#F59E0B"
                            : "#6B7280",
                      fontWeight: failRatio > 0.1 ? 600 : 400,
                    }}
                  >
                    {s.failCount.toLocaleString()}
                  </td>

                  <td style={{ padding: "5px 6px" }}>
                    {s.bestPartner && (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 3,
                        }}
                      >
                        <span
                          style={{
                            padding: "1px 5px",
                            borderRadius: 4,
                            fontSize: 10,
                            background: TUNER_COLORS[s.bestPartner],
                            color: "#fff",
                            fontWeight: 700,
                            lineHeight: 1.4,
                          }}
                        >
                          {SHORT_NAMES[s.bestPartner]}
                        </span>
                        <span
                          style={{
                            color: "#10B981",
                            fontSize: 11,
                            fontFamily: "monospace",
                            fontWeight: 600,
                          }}
                        >
                          +{s.bestPartnerGainBranches.toLocaleString()}
                        </span>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
