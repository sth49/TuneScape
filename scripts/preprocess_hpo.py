"""
Convert HPO trial logs → fuzzing-compatible visualization schema.

Mapping (one task at a time, e.g. adult):
  data_hpo/raw/{task}_{tuner}.json  →  public/data/{task}_{tuner}_processed.json

Per-instance correctness semantics ("branch" = validation sample index):
  coveredBranches     = correctIndices from raw trial
                        (= validation sample indices the trial classifies correctly)
  totalCovered        = |coveredBranches|  (= correctly classified count)
  cumulativeCoverage  = |running union of coveredBranches across this tuner's
                         trials so far|
  marginalCoverage    = |this trial's coveredBranches \\ running union|
                        (i.e. NEW samples first covered by this trial)
  totalUniqueBranches = nValSamples (= |Xva|)

Run:  python scripts/preprocess_hpo.py [--task adult]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

RAW_DIR = Path("data_hpo/raw")
OUT_DIR = Path("public/data")
OUT_DIR.mkdir(parents=True, exist_ok=True)

TUNERS = ["Random", "Genetic", "CMA_ES", "SuccessiveHalving"]


def convert_trial(trial: dict, prev_union: set[int]) -> tuple[dict, set[int]]:
    """Convert one HPO trial into the fuzzing-style trial dict.

    prev_union: running union of correctIndices across this tuner's prior trials.
    Returns (trial_out, updated_union).
    """
    score = float(trial["score"])
    correct = trial.get("correctIndices")
    if correct is None:
        raise ValueError(
            f"trial {trial.get('trialId')} missing 'correctIndices' — "
            "raw HPO logs must be regenerated with run_hpo.py."
        )
    correct_set = {int(i) for i in correct}
    new_only = correct_set - prev_union
    new_union = prev_union | correct_set
    out = {
        "trialId": int(trial["trialId"]),
        "marginalCoverage": len(new_only),
        "cumulativeCoverage": len(new_union),
        "totalCovered": len(correct_set),
        "coveredBranches": sorted(correct_set),
        "parameters": dict(trial["parameters"]),
        # Extra HPO context kept for reference (not consumed by viz directly).
        "score": score,
        "elapsed": float(trial.get("elapsed", 0.0)),
    }
    return out, new_union


def convert_tuner_file(task: str, tuner: str) -> dict | None:
    src = RAW_DIR / f"{task}_{tuner}.json"
    if not src.exists():
        print(f"  ✗ missing {src}")
        return None
    with open(src) as f:
        raw = json.load(f)
    raw_trials = raw.get("trials", [])
    if not raw_trials:
        print(f"  ✗ {tuner}: no trials")
        return None
    n_val = int(raw.get("nValSamples", 0))
    trials_out: list[dict] = []
    union: set[int] = set()
    for t in raw_trials:
        out, union = convert_trial(t, union)
        trials_out.append(out)
    payload = {
        "program": task,
        "tuner": tuner,
        "totalTrials": len(trials_out),
        # Universe = total validation samples (= max possible coverage).
        "totalUniqueBranches": n_val,
        "nValSamples": n_val,
        "trials": trials_out,
    }
    return payload


def compute_program_total_unique(per_tuner: dict[str, dict]) -> int:
    """All tuners share the same Xva, so any tuner's nValSamples is authoritative."""
    for payload in per_tuner.values():
        n = int(payload.get("nValSamples", 0))
        if n > 0:
            return n
    return 0


def write_per_tuner(task: str, per_tuner: dict[str, dict]):
    program_total = compute_program_total_unique(per_tuner)
    print(f"  Validation universe: {program_total} samples")
    for tuner, payload in per_tuner.items():
        payload["totalUniqueBranches"] = program_total
        out_path = OUT_DIR / f"{task}_{tuner}_processed.json"
        with open(out_path, "w") as f:
            json.dump(payload, f)
        best = max(t["totalCovered"] for t in payload["trials"])
        print(f"    → {out_path}  (n={payload['totalTrials']}, best={best}/{program_total})")


# ─── Param importance — XGBoost-feature-based weight + variance fallback ──
def compute_param_importance(per_tuner: dict[str, dict]) -> list[dict]:
    """Combined importance across all tuners' trials.

    Uses correlation of each parameter with score (Pearson for numeric, ANOVA-F
    for categorical). Numeric/boolean → Pearson on values. Categorical → group
    variance ratio.
    """
    # Aggregate all trials
    all_trials: list[dict] = []
    for payload in per_tuner.values():
        all_trials.extend(payload["trials"])

    if not all_trials:
        return []

    param_names = sorted(all_trials[0]["parameters"].keys())
    scores = np.array([t["score"] for t in all_trials], dtype=float)

    importances: list[tuple[str, float]] = []
    for p in param_names:
        vals = [t["parameters"][p] for t in all_trials]
        # Categorical / boolean: ANOVA-style — between-group variance ratio
        if isinstance(vals[0], bool) or isinstance(vals[0], str):
            groups: dict = {}
            for v, s in zip(vals, scores):
                groups.setdefault(v, []).append(s)
            if len(groups) < 2:
                importances.append((p, 0.0))
                continue
            grand = float(np.mean(scores))
            ss_between = sum(len(g) * (np.mean(g) - grand) ** 2 for g in groups.values())
            ss_total = float(np.sum((scores - grand) ** 2)) + 1e-12
            importances.append((p, float(ss_between / ss_total) * 100))
        else:
            # Numeric: |Pearson| × 100
            arr = np.asarray(vals, dtype=float)
            if np.std(arr) < 1e-12:
                importances.append((p, 0.0))
                continue
            corr = float(np.corrcoef(arr, scores)[0, 1])
            importances.append((p, abs(corr) * 100))

    importances.sort(key=lambda kv: kv[1], reverse=True)
    return [{"name": n, "importance": round(v, 2)} for n, v in importances]


def write_param_importance(task: str, per_tuner: dict[str, dict]):
    target_path = OUT_DIR / "param_importance.json"
    if target_path.exists():
        with open(target_path) as f:
            doc = json.load(f)
    else:
        doc = {}
    doc.setdefault(task, {})
    combined = compute_param_importance(per_tuner)
    doc[task]["_combined"] = combined
    # Also fill per-tuner key for completeness (same value here; can be per-tuner-specific later)
    for tuner, payload in per_tuner.items():
        doc[task][tuner] = compute_param_importance({tuner: payload})
    with open(target_path, "w") as f:
        json.dump(doc, f, indent=2)
    print(f"\n  → param_importance.json updated for task='{task}'")
    print(f"     Top 5 (combined): "
          + ", ".join(f"{e['name']}:{e['importance']}" for e in combined[:5]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", default="adult")
    ap.add_argument("--tuners", nargs="+", default=TUNERS)
    args = ap.parse_args()

    print(f"\n=== Converting task='{args.task}' ===")
    per_tuner: dict[str, dict] = {}
    for tuner in args.tuners:
        print(f"  • {tuner}")
        payload = convert_tuner_file(args.task, tuner)
        if payload:
            per_tuner[tuner] = payload

    if not per_tuner:
        print("  No tuners converted; aborting.")
        return

    write_per_tuner(args.task, per_tuner)
    write_param_importance(args.task, per_tuner)
    print("\n  ✓ Done. Next: run scripts/build_hex_graph.py to compute hex layout.")


if __name__ == "__main__":
    main()
