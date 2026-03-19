# Qualitative Label Spec — Hex Map Sub-Region Dual Encoding

> Status: **Design Draft v2** (pre-implementation, 2026-03-19 리뷰 반영)
> 목적: 구현 전 설계 확정. 이 문서가 확정되면 `ParameterHexMap.tsx` 및 hex layout worker를 수정한다.

---

## 1. Label Taxonomy

Sub-region(hex node 또는 LoD cluster)에 부여하는 **qualitative label**은 5종으로 제한한다.
parameter label(color)과 별도로, 이 label은 texture로 인코딩된다.

| Label | 한 줄 정의 | 연구자 관점 신호 |
|---|---|---|
| **High Coverage** | 이 parameter regime에서 평균 커버리지가 전체 상위 구간에 속하며 실패율이 낮다 | "여기서는 튜너가 잘 작동한다 — 참조 기준선으로 쓸 수 있다" |
| **High Novelty** | 이 region에서 발생한 marginal coverage 비율이 높다 — 새로운 브랜치를 여전히 발견한다 | "아직 탐색 여지가 있다 — 더 많은 trial을 투입할 가치가 있다" |
| **Saturated** | mean coverage는 높지만 marginal coverage가 낮다 — 이미 좋은 region이지만 새 브랜치를 거의 열지 못한다 | "이미 충분히 탐색됐다 — 다른 region으로 자원을 옮겨라" |
| **Failure-prone** | 실패 trial(totalCovered == 0) 비율이 높다 | "튜너가 이 regime에서 자주 망가진다 — 버그 또는 잘못된 파라미터 조합 가능성" |
| **Volatile** | 커버리지 분산(IQR)이 높다 — trial 간 결과 편차가 크다 | "결과가 불안정하다 — 확률적 요인이 크거나 파라미터 민감도가 높은 regime" |

### 라벨 간 관계 메모

- **Saturated vs High Coverage**: Saturated는 "높지만 이미 다 캔 것", High Coverage는 "높고 아직 유효한 것". 핵심 차이는 `marginal_ratio` — marginal이 낮으면 Saturated, 높으면 High Coverage. Saturated가 우선순위가 높으므로 marginal이 낮으면 High Coverage로 분류되지 않는다.
- **Saturated secondary tag**: `coverage_iqr < p25`이면 secondary tag `[Stable]`을 추가. "안정적 고성능 포화 상태"라는 더 강한 신호.
- **High Novelty vs Volatile**: Novelty는 marginal coverage 기반, Volatile은 분산 기반. 공존 가능하다 → secondary tag로 처리.
- **Failure-prone은 항상 최우선** — 실패가 있으면 다른 의미가 묻힌다.

---

## 2. Metric Spec

각 sub-region(AggNode 기준)에서 계산해야 할 지표 목록.

### 2-1. 기본 집계

| Metric | 계산 방법 | 현재 데이터 소스 | 용도 |
|---|---|---|---|
| `trial_count` | `sum(hexNodes[*].trialCount)` | `AggNode.trialCount` | 신뢰도, opacity 인코딩 |
| `mean_coverage` | 가중 평균 (trial count 기준) | `AggNode.meanCoverage` | High Coverage 판별 |
| `max_coverage` | `max(hexNodes[*].maxCoverage)` | `AggNode.maxCoverage` | High Coverage 보조 |
| `min_coverage` | `min(hexNodes[*].minCoverage)` | `HexNode.minCoverage` (현재 단일 노드만) | Failure-prone 보조 |

### 2-2. 신규 계산 필요

| Metric | 계산 방법 | 비고 |
|---|---|---|
| `mean_marginal_coverage` | `mean(trials[*].marginalCoverage)` | hex layout worker에서 추가 집계 필요 |
| `marginal_ratio` | `mean_marginal_coverage / mean_coverage` | Novelty 판별 핵심 |
| `failure_rate` | `count(totalCovered == 0) / trial_count` | `TrialData.totalCovered` 이미 있음 |
| `coverage_iqr` | IQR of per-trial coverage in this node | Volatile 판별 핵심 |
| `coverage_variance` | `var(coverage)` | IQR 대안 또는 보조 |
| `dominant_tuner_ratio` | `max(tunerCounts) / trial_count` | 1개 튜너가 독점하는지 여부 |
| `tuner_entropy` | Shannon entropy of tuner distribution | 낮으면 독점, 높으면 분산 |

> **구현 메모**: `mean_marginal_coverage`, `failure_rate`, `coverage_iqr`은 현재 `HexNode`에 없다.
> `hexLayoutWorker.ts` 또는 Python 전처리에서 `HexNode` 필드를 확장해야 한다.
> 최소 추가 필드: `meanMarginalCoverage`, `failureRate`, `coverageIqr`.

### 2-3. 전체 분포 기준값 (global percentiles)

라벨 threshold는 절대값이 아니라 **전체 node 분포 내 상대 위치**로 정의한다.
계산 시점: data load 후 `useMemo`로 한 번만.

| 기준값 | 계산 | 용도 |
|---|---|---|
| `p75_coverage` | 전체 node `mean_coverage`의 75th percentile | High Coverage / Saturated 판별 |
| `p75_marginal_ratio` | 전체 node `marginal_ratio`의 75th percentile | High Novelty 판별 |
| `p25_marginal_ratio` | 전체 node `marginal_ratio`의 25th percentile | Saturated 판별 |
| `p75_iqr` | 전체 node `coverage_iqr`의 75th percentile | Volatile 판별 |
| `p25_trial_count` | 전체 node `trial_count`의 25th percentile | low-support 판별 |

모든 percentile은 **프로그램별 독립 계산**. gawk/gcal/grep 등 프로그램마다 coverage 스케일과 분포가 다르므로 통합 기준을 쓰면 왜곡된다.

---

## 3. Label Assignment Rules

### 3-1. Primary Label (1개만 선택)

우선순위 순으로 평가, 첫 번째로 충족되는 라벨을 primary로 선택한다.

```
1. Failure-prone  — if failure_rate > 0.20
2. High Novelty   — if marginal_ratio > p75_marginal_ratio AND failure_rate ≤ 0.20
3. Saturated      — if mean_coverage > p75_coverage AND marginal_ratio < p25_marginal_ratio
4. High Coverage  — if mean_coverage > p75_coverage AND failure_rate ≤ 0.20
5. Volatile       — if coverage_iqr > p75_iqr AND failure_rate ≤ 0.20
```

우선순위 변경 이유: Saturated를 High Coverage 앞에 놓지 않으면 "high coverage + low marginal" 조합이 High Coverage로 흡수되어 Saturated가 사실상 사라진다.

**저지지(low-support) 처리**:
고정 threshold(`trial_count < 3`) 대신 분위수 기반을 사용한다.
```
support_score = trial_count / p25_trial_count  // 전체 node 중 하위 25% 기준 정규화
```
- `support_score < 1.0` (하위 25% 미만): texture를 그리지 않음, opacity = `base_opacity * 0.5`
- `1.0 ≤ support_score < 2.0`: texture opacity = 0.5 (약하게 표시)
- `support_score ≥ 2.0`: texture 정상 표시

이 방식은 클러스터 크기가 프로그램마다 달라도 상대적으로 동작한다.

### 3-2. Secondary Tags (0~2개)

primary label과 다른 조건도 충족하면 secondary tag로 추가.
tooltip과 focus panel에서만 표시, texture는 적용하지 않는다.

예시:
- Primary: Failure-prone, Secondary: `[Volatile]` → "실패가 잦고 불안정하다"
- Primary: High Coverage, Secondary: `[Saturated]` → "성과가 좋으며 이미 포화 상태"

### 3-3. Threshold 초안

| Label | 조건 | Threshold 초안 | 조정 근거 |
|---|---|---|---|
| Failure-prone | `failure_rate` | > 0.20 | 20% 이상 실패는 명확한 문제 신호 |
| High Novelty | `marginal_ratio` | > p75 전체 분포 | 상위 25% 새 브랜치 발견률 |
| Saturated | `mean_coverage > p75` AND `marginal_ratio < p25` | — | 높은 성과이지만 탐색 기여 없는 조합 |
| High Coverage | `mean_coverage` | > p75 전체 분포 | 상위 25% 평균 커버리지 (marginal_ratio는 p25 이상) |
| Volatile | `coverage_iqr` | > p75 전체 분포 | 상위 25% 분산 |

> **주의**: threshold는 첫 실제 데이터를 보기 전까지 가설이다. 데이터 로드 후 분포를 확인하고 조정할 것.

---

## 4. Visual Encoding Spec

### 4-1. 채널 할당 원칙

| Visual Channel | Encodes | 비고 |
|---|---|---|
| **Color (fill)** | Parameter-based contrastive label | 기존 방식 유지 (tuner pie / coverage / density) |
| **Texture (SVG pattern)** | Primary qualitative label | color와 독립적으로 overlay |
| **Opacity** | Confidence (trial_count 기반) | `0.4 + 0.6 * min(trial_count / 30, 1)` |
| **Border (stroke)** | Sub-region 경계 구분 | stroke-width는 LoD에 따라 조정 |

### 4-2. Qualitative Label → Texture

SVG `<pattern>` + `<mask>` 방식. color fill 위에 texture를 얇게 overlay한다.
texture 선 색상은 `rgba(255,255,255,0.35)` 고정 (어두운 배경 기준).

| Label | Texture | SVG Pattern 개요 |
|---|---|---|
| **High Coverage** | Diagonal lines (45°, 좌→우 하강) | `/` 방향 선, 간격 3px, strokeWidth 0.8 |
| **High Novelty** | Cross hatch (45° + 135°) | `/` + `\` 교차, 간격 4px, strokeWidth 0.6 |
| **Saturated** | Sparse dot grid | 원형 점, 반지름 0.5, 간격 5px |
| **Failure-prone** | Dense dots (촘촘) | 원형 점, 반지름 0.8, 간격 3px |
| **Volatile** | Wavy lines | sine 근사 폴리라인, 진폭 1px, 주기 6px |

**Texture 충돌 방지 원칙**:
- diagonal lines(High Coverage)과 cross hatch(High Novelty)는 선 방향이 다르므로 혼동 없음
- dots와 wavy lines는 완전히 다른 geometry
- 전체 5종이 즉시 구별 가능해야 한다 — 사용 전 A4 프린트 테스트 필요

### 4-3. Opacity 인코딩

```
opacity = clamp(0.4 + 0.6 * sqrt(trial_count / REFERENCE_N), 0.4, 1.0)
REFERENCE_N = 30  // 30 trial 이상이면 full opacity
```

단, primary label = "Unknown"이면 opacity = 0.25 고정.

### 4-4. Border

| 상태 | stroke 색상 | stroke-width |
|---|---|---|
| 기본 | `rgba(255,255,255,0.08)` | 0.3 |
| hover | `rgba(255,255,255,0.5)` | 0.6 |
| selected | `rgba(255,215,0,0.8)` (금색) | 0.8 |
| Failure-prone primary | `rgba(255,80,80,0.6)` | 0.5 |

---

## 5. Tooltip / Focus Panel Content Rules

### 5-1. Tooltip (hover, 빠른 스캔용)

표시 순서:
1. **Primary qualitative label** — 강조 (badge 스타일)
2. **Parameter label** (contrastive label, 해당 시) — 서브텍스트
3. **근거 metric 2~3개** — 라벨 종류에 따라 자동 선택 (아래 표 참조)
4. **Rationale 1줄** — 아래 템플릿 참조

| Label | 표시할 metric |
|---|---|
| Failure-prone | failure_rate, trial_count, dominant_tuner_ratio |
| High Novelty | marginal_ratio, mean_marginal_coverage, trial_count |
| High Coverage | mean_coverage, max_coverage, failure_rate |
| Saturated | mean_coverage, marginal_ratio, trial_count |
| Volatile | coverage_iqr, mean_coverage, trial_count |

**Rationale 템플릿**:
- Failure-prone: `"X% of trials failed to execute in this regime."`
- High Novelty: `"Trials here still find new branches (marginal ratio: X%)."`
- High Coverage: `"Consistently high coverage — good reference region."`
- Saturated: `"High coverage but marginal gains are negligible — this region is exhausted."`
- Volatile: `"High variance across trials — this regime is sensitive to randomness."`

### 5-2. Focus Panel (click, 상세 분석용)

현재 `selectedNode` 패널을 확장한다. 추가 섹션:

```
┌─────────────────────────────────────────┐
│ [PRIMARY LABEL BADGE] [secondary tags]  │
│ Parameter label: <contrastive label>    │
├─────────────────────────────────────────┤
│ Qualitative Metrics                     │
│   Coverage mean: XX.X   IQR: ±X.X      │
│   Marginal ratio: X.X%                  │
│   Failure rate: X.X%                    │
│   Trial count: XX                       │
├─────────────────────────────────────────┤
│ Tuner distribution (bar chart)          │
├─────────────────────────────────────────┤
│ Rationale:                              │
│   <1-line text>                         │
├─────────────────────────────────────────┤
│ Parameters (스크롤 가능)                │
└─────────────────────────────────────────┘
```

---

## 6. 구현 전 확인 체크리스트

설계 확정 전 아래 질문에 답해야 한다.

- [x] `marginalCoverage`는 반드시 집계. High Novelty + Saturated 둘 다의 1차 필수 조건 → **확정: 1차 구현 필수**
- [ ] `failure_rate` 계산용 `totalCovered == 0` 조건은 "실행 실패"와 동일한가?
- [ ] SVG texture를 `<defs>`에 패턴으로 정의할 때 LoD hex 크기 변화에 맞게 scale할 것인가, 고정할 것인가?
- [ ] qualitative label color badge를 위한 색상 팔레트가 tuner color와 충돌하지 않는가?
- [x] threshold는 프로그램(gawk, grep 등)별로 별도 계산 → **확정: 프로그램별**

---

## 7. 미결 이슈 (설계 리뷰 필요)

| 이슈 | 결정 | 근거 |
|---|---|---|
| threshold 범위 기준 | **프로그램별 독립 계산** | gawk/gcal/grep 등 프로그램마다 coverage 스케일이 다름 (확정) |
| marginal_ratio 정의 | `sum(marginal) / sum(coverage)` (**trial-weighted**) | 극단값(0 coverage trial) 영향 감소 (확정) |
| low-support 표시 | **분위수 기반 opacity gradient** | 고정 `< 3` threshold는 클러스터 크기 편차에 취약 (확정) |
| texture scale | **hex size에 비례** | LoD 변화 시 texture가 너무 촘촘해지거나 사라지는 문제 방지 |
| Stable secondary tag | `coverage_iqr < p25` → `[Stable]` 태그 추가 | 저분산 특성은 Saturated 강화 신호로 활용 (tooltip/panel에만 표시) |

---

*이 문서는 구현 시작 전에 검토 및 확정되어야 한다.*
