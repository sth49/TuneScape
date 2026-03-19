# Metric Data Flow — Qualitative Label 구현을 위한 설계

> Status: **설계 확정 전 검토용** (2026-03-19)
> 목적: 구현 전에 각 metric의 source-of-truth, 계산 위치, 변환 경로를 코드 레벨로 확정한다.

---

## 1. 전체 파이프라인 구조

```
[raw data]
  data_VIS26/{program}/{tuner}/
    parameters.xlsx
    coverage_set            ← 한 줄 = 한 trial의 branch index set
        │
        ▼
[preprocess_data.py]
  → public/data/{program}_{tuner}_processed.json
    per-trial: marginalCoverage, cumulativeCoverage, totalCovered, parameters
        │
        ▼
[build_hex_graph.py]
  → public/data/{program}_hex_layout.json
    per-hex-node: meanCoverage, maxCoverage, minCoverage, tunerCounts,
                  trialCount, trialIndices, discrete, q, r
        │
        ▼ (HTTP fetch)
[ParameterHexMap.tsx]
  HexNode[] → aggregateByLevel() → AggNode[]
  useMemo: percentile thresholds (프로그램별)
  useMemo: qualitative label 부여
```

파이프라인에 관여하는 파일은 딱 3계층이다.
`hexLayoutWorker.ts`는 **HexMap.tsx용 다른 컴포넌트**에서 사용하는 별도 worker이며, ParameterHexMap과는 무관하다.

---

## 2. 구현 직전 최종 정의 (4줄 고정)

| Metric | 정확한 정의 |
|---|---|
| `meanCoverage` | sub-region 내 trial들의 `totalCovered` 평균 |
| `meanMarginalCoverage` | sub-region 내 trial들의 `marginalCoverage` 평균 |
| `coverageIqr` | sub-region 내 trial들의 **`totalCovered` IQR** (cumulativeCoverage 아님) |
| `failureRate` | `totalCovered == 0`인 trial 비율 |
| percentile threshold 모집단 | **현재 program × 현재 aggregation level**에서 화면에 보이는 모든 sub-region |

`coverageIqr`의 입력을 `totalCovered`로 고정하는 이유: Volatile은 "같은 parameter 조합을 실행했을 때 실행 결과(branch coverage)의 편차가 크다"를 의미해야 한다. `cumulativeCoverage`는 순서 의존적이므로 편차 측정에 부적합하다.

percentile 모집단을 "현재 aggregation level"로 고정하는 이유: LoD가 바뀌면 AggNode의 수가 달라진다. LoD=0의 5000개 node 기준과 LoD=3의 200개 cluster 기준이 같은 threshold를 공유하면 의미가 왜곡된다. **매 aggregation level 변경 시 percentile을 재계산**한다.

---

## 3. Metric별 Source-of-Truth 및 계산 위치

### 2-1. 현황 — 이미 있는 것

| Metric | Source-of-Truth | 현재 계산 위치 | 현재 출력 위치 |
|---|---|---|---|
| `totalCovered` (per trial) | `coverage_set` 크기 | `preprocess_data.py:calculate_coverage_metrics()` | `_processed.json` → `hex_layout.json` 로드 |
| `marginalCoverage` (per trial) | `coverage_set - seen_branches` | `preprocess_data.py:calculate_coverage_metrics()` | `_processed.json` → `hex_layout.json` 로드 |
| `meanCoverage` (per node) | `totalCovered` 집계 | `build_hex_graph.py:aggregate_unique()` L148-156 | `hex_layout.json` nodes |
| `maxCoverage`, `minCoverage` | 같은 위치 | 같은 위치 | 같은 위치 |
| `trialCount` | — | `aggregate_unique()` | `hex_layout.json` nodes |
| `tunerCounts` | — | `aggregate_unique()` | `hex_layout.json` nodes |
| `trialIndices` | — | `aggregate_unique()` | `hex_layout.json` nodes |

### 2-2. 신규 필요 — 계산 위치 결정 필요

| Metric | 정의 | Source | **계산 위치 결정** | 비고 |
|---|---|---|---|---|
| `meanMarginalCoverage` | `sum(marginalCoverage) / trialCount` | `trial["marginalCoverage"]` | **build_hex_graph.py** | `aggregate_unique()`에서 trial 목록이 있는 시점에 계산 |
| `failureRate` | `count(totalCovered==0) / trialCount` | `trial["totalCovered"]` | **build_hex_graph.py** | 같은 위치 |
| `coverageIqr` | `p75(totalCovered) - p25(totalCovered)` in node | `trial["totalCovered"]` | **build_hex_graph.py** | trialCount < 2이면 0으로 설정 |
| `marginalRatio` | `sum(marginalCoverage) / sum(totalCovered)` | 위 두 값 | **ParameterHexMap.tsx** | node 로드 후 파생 계산 |
| `dominantTunerRatio` | `max(tunerCounts) / trialCount` | `tunerCounts` | **ParameterHexMap.tsx** | tunerCounts 이미 존재 |
| `tunerEntropy` | Shannon entropy of tunerCounts | `tunerCounts` | **ParameterHexMap.tsx** | tunerCounts 이미 존재 |
| percentile thresholds | p25/p75 of node-level metrics | 위 모든 값 | **ParameterHexMap.tsx useMemo** | 프로그램별 독립 계산 |
| `qualitative_label` | label assignment rules | 위 모든 값 | **ParameterHexMap.tsx useMemo** | AggNode 기준 |

---

## 4. 계층별 계산 명세

### 3-1. build_hex_graph.py — aggregate_unique() 수정

**수정 대상**: `aggregate_unique()` 함수 (L136-180)

현재 코드:
```python
coverages = [trials[i]["totalCovered"] for i in trial_indices]
unique_nodes.append({
    "discrete": combo,
    "trialCount": len(trial_indices),
    "trialIndices": trial_indices,
    "tunerCounts": dict(tuner_counts),
    "meanCoverage": np.mean(coverages),
    "maxCoverage": max(coverages),
    "minCoverage": min(coverages),
})
```

추가할 계산:
```python
marginals = [trials[i]["marginalCoverage"] for i in trial_indices]
failures = sum(1 for i in trial_indices if trials[i]["totalCovered"] == 0)
iqr = (np.percentile(coverages, 75) - np.percentile(coverages, 25)
       if len(coverages) >= 2 else 0)

# 추가 필드:
"meanMarginalCoverage": float(np.mean(marginals)),
"failureRate": failures / len(trial_indices),
"coverageIqr": float(iqr),
```

**JSON output 크기 영향**: node당 3개 float 추가. 약 5,000 노드 기준 ~15KB 증가 (무시 가능).

### 3-2. HexNode 타입 (ParameterHexMap.tsx) 확장

```typescript
interface HexNode {
  idx: number;
  q: number;
  r: number;
  discrete: (string | number)[];
  trialCount: number;
  tunerCounts: Record<string, number>;
  meanCoverage: number;
  maxCoverage: number;
  minCoverage: number;
  trialIndices: number[];
  // 신규
  meanMarginalCoverage: number;
  failureRate: number;
  coverageIqr: number;
}
```

### 3-3. AggNode 타입 확장

LoD aggregation 시 새 필드를 어떻게 합칠 것인가:

| 필드 | 합산 방식 |
|---|---|
| `meanMarginalCoverage` | trial-count 가중 평균 |
| `failureRate` | 전체 failure 수 / 전체 trial 수 (단순 평균 금지) |
| `coverageIqr` | 전체 구성 trial의 IQR (members 전체 재계산) |

```typescript
interface AggNode {
  ...기존 필드...
  meanMarginalCoverage: number;
  failureRate: number;
  coverageIqr: number;
}
```

`aggregateByLevel()` 내 합산 코드 스케치:
```typescript
const totalMarginal = members.reduce((s, m) =>
  s + m.meanMarginalCoverage * m.trialCount, 0);
const totalFailures = members.reduce((s, m) =>
  s + m.failureRate * m.trialCount, 0);
// coverageIqr은 ideally member trial들 전체 재계산이지만,
// AggNode에 개별 trial 정보가 없으므로 trial-count 가중 평균으로 근사
const weightedIqr = members.reduce((s, m) =>
  s + m.coverageIqr * m.trialCount, 0);

node.meanMarginalCoverage = totalMarginal / totalTrials;
node.failureRate = totalFailures / totalTrials;
node.coverageIqr = weightedIqr / totalTrials;  // 근사치
```

> **주의**: `coverageIqr`의 LoD aggregation은 근사치다. AggNode는 raw trial들에 접근할 수 없으므로 가중 평균으로 대신한다. 이는 LoD level이 높을수록 오차가 커지지만, qualitative label이 이미 "방향성" 판단이므로 허용 가능하다.

### 3-4. ParameterHexMap.tsx — 파생 metric 계산

```typescript
// marginalRatio: 노드 단위 파생값
const marginalRatio = node.meanMarginalCoverage / (node.meanCoverage + 1e-6);

// dominantTunerRatio
const dominantTunerRatio = Math.max(...Object.values(node.tunerCounts)) / node.trialCount;

// tunerEntropy (optional, tooltip용)
const tunerEntropy = Object.values(node.tunerCounts).reduce((e, c) => {
  const p = c / node.trialCount;
  return p > 0 ? e - p * Math.log2(p) : e;
}, 0);
```

### 4-5. ParameterHexMap.tsx — Percentile Threshold useMemo

계산 시점: `aggNodes` 변경 시마다 — 즉 **data 로드 시** 및 **LoD level 변경 시** 매번 재계산.
입력: `aggNodes` (AggNode[]) — 현재 aggregation level의 visible nodes

> LoD level이 변경될 때마다 percentile을 재계산해야 한다. `data.nodes` 기준으로 1회만 계산하면 LoD=3 화면에서 LoD=0 기준 threshold가 적용되어 의미가 왜곡된다.

```typescript
// aggNodes에 의존 → LoD 변경 시 자동 재계산
const thresholds = useMemo(() => {
  if (!aggNodes.length) return null;
  const nodes = aggNodes;  // 현재 aggregation level 기준

  const sortedCoverage = [...nodes.map(n => n.meanCoverage)].sort((a, b) => a - b);
  const marginalRatios = nodes.map(n =>
    n.meanMarginalCoverage / (n.meanCoverage + 1e-6));
  const sortedMargRatio = [...marginalRatios].sort((a, b) => a - b);
  const sortedIqr = [...nodes.map(n => n.coverageIqr)].sort((a, b) => a - b);
  const sortedTrialCount = [...nodes.map(n => n.trialCount)].sort((a, b) => a - b);

  const p = (arr: number[], pct: number) =>
    arr[Math.floor(arr.length * pct / 100)];

  return {
    p75_coverage: p(sortedCoverage, 75),
    p75_marginal_ratio: p(sortedMargRatio, 75),
    p25_marginal_ratio: p(sortedMargRatio, 25),
    p75_iqr: p(sortedIqr, 75),
    p25_trial_count: p(sortedTrialCount, 25),
  };
}, [data]);
```

### 3-6. ParameterHexMap.tsx — Label Assignment useMemo

입력: `aggNodes`, `thresholds`

```typescript
const qualitativeLabels = useMemo(() => {
  if (!thresholds) return new Map<number, QualitativeLabel>();

  const labels = new Map<number, QualitativeLabel>();
  for (const node of aggNodes) {
    const margRatio = node.meanMarginalCoverage / (node.meanCoverage + 1e-6);
    const supportScore = node.trialCount / (thresholds.p25_trial_count + 1e-6);

    let primary: PrimaryLabel = "Unknown";
    const secondary: SecondaryTag[] = [];

    if (supportScore >= 1.0) {  // sufficient support
      if (node.failureRate > 0.20) {
        primary = "Failure-prone";
      } else if (margRatio > thresholds.p75_marginal_ratio) {
        primary = "High Novelty";
      } else if (node.meanCoverage > thresholds.p75_coverage &&
                 margRatio < thresholds.p25_marginal_ratio) {
        primary = "Saturated";
        if (node.coverageIqr < /* p25_iqr from thresholds */ 0) {
          secondary.push("Stable");
        }
      } else if (node.meanCoverage > thresholds.p75_coverage) {
        primary = "High Coverage";
      } else if (node.coverageIqr > thresholds.p75_iqr) {
        primary = "Volatile";
      }
    }

    labels.set(node.id, { primary, secondary, supportScore });
  }
  return labels;
}, [aggNodes, thresholds]);
```

---

## 5. 핵심 주의사항 (구현 전 결론)

### 4-1. marginalCoverage의 tuner-relative 문제

`preprocess_data.py`의 `marginalCoverage`는 **각 tuner 내 순서** 기준으로 계산된다.
즉 SymTuner의 trial #500은 SymTuner가 이미 500번 실행한 후의 marginal이므로, 늦게 실행된 trial일수록 marginal이 낮다.

이 값을 여러 tuner 합산으로 쓸 때 생기는 오차:
- 같은 hex node에 SymTuner trial #100(marginal 높음)과 #400(낮음)이 섞이면 노드 평균은 중간값이 됨
- 다른 tuner끼리 비교 시 tuner A가 이 region을 early에 탐색, tuner B가 late에 탐색하면 왜곡

**결론**: 현재 `marginalCoverage`는 절대 novelty 지표가 아닌 **상대 novelty 추정치**로 사용한다.
threshold를 percentile 기반으로 쓰는 이유도 이 때문이다 — 절대값이 아니라 전체 분포 내 상대 위치만 비교하면 편향이 상쇄된다.

### 4-2. failureRate 정의 확인

`totalCovered == 0` = "이 trial에서 커버된 branch가 0개" = 실행 자체가 실패했거나 KLEE가 아무것도 탐색하지 못한 상태.

**전제**: `totalCovered == 0`과 "실행 실패"는 동일하다. 이 전제가 맞는지 데이터를 보고 확인 필요.
반례가 있다면 (실행은 됐지만 branch가 0인 경우) failureRate 기준을 수정해야 한다.

### 4-3. coverageIqr와 trialCount 제약

trialCount = 1인 노드(singleton)에서 IQR = 0이다. 이는 Volatile 판별 불가를 의미하지, Volatile이 아님을 의미하지 않는다. support_score < 1.0이면 label을 부여하지 않으므로 자동으로 필터된다.

### 4-4. LoD level에서의 AggNode 집계

LoD level이 올라가면 `AggNode.hexNodes`에 여러 hex node가 들어간다.
`coverageIqr`은 이 시점에 이미 집계된 node 단위 IQR의 가중 평균이므로, individual trial들의 IQR과는 다르다.

**선택**: 이 근사를 수용한다. LoD는 큰 단위의 탐색 패턴을 보는 용도이므로, 세밀한 IQR 정확도보다 일관성이 더 중요하다.

---

## 6. 변경 파일 목록 (구현 시)

| 파일 | 변경 내용 | 우선순위 |
|---|---|---|
| `scripts/build_hex_graph.py` | `aggregate_unique()`에 3개 metric 추가 | **1st** |
| `src/components/ParameterHexMap.tsx` | `HexNode`, `AggNode` 타입 확장, `aggregateByLevel()` 수정 | **2nd** |
| `src/components/ParameterHexMap.tsx` | percentile threshold useMemo 추가 | **2nd** |
| `src/components/ParameterHexMap.tsx` | qualitative label assignment useMemo 추가 | **3rd** |
| `src/components/ParameterHexMap.tsx` | texture rendering + tooltip 확장 | **4th** |

**Python 스크립트 변경 후 반드시 재실행 필요**:
```
python scripts/build_hex_graph.py --program gawk
python scripts/build_hex_graph.py --program gcal
python scripts/build_hex_graph.py --program grep
```

---

## 7. 불필요한 변경 — 건드리지 않을 것

| 파일 | 이유 |
|---|---|
| `scripts/preprocess_data.py` | `marginalCoverage`, `totalCovered` 이미 올바르게 생성됨 |
| `src/workers/hexLayoutWorker.ts` | ParameterHexMap과 무관한 별도 컴포넌트용 worker |
| `src/utils/hexMapUtils.ts` | ParameterHexMap은 이 파일의 타입만 import (TUNER_COLORS 등) |

---

*이 문서의 결론이 확정되면 구현 순서대로 진행한다: Python 먼저 → 타입 → useMemo → 렌더링.*
