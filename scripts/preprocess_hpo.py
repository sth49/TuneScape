"""
Convert HPO trial logs → fuzzing-compatible visualization schema.

Mapping (one task at a time, e.g. adult):
  data_hpo/raw/{task}_{tuner}.json  →  public/data/{task}_{tuner}_processed.json

Score semantics (validation accuracy in [0, 1]) reframed as "branch coverage":
  totalCovered        = round(score * 1000)
  coveredBranches     = [0, 1, …, int(score * 1000)]   (so |union| = best score)
  cumulativeCoverage  = best_so_far_score * 1000      (auto from set union)
  marginalCoverage    = improvement_over_prev_best * 1000

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

TUNERS = ["Random", "Grid", "Genetic", "BOHB"]
SCORE_SCALE = 1000  # round(score * SCORE_SCALE) → integer "branch ids"


def convert_trial(trial: dict, prev_best_int: int) -> tuple[dict, int]:
    """Convert one HPO trial into the fuzzing-style trial dict."""
    score = float(trial["score"])
    score_int = int(round(score * SCORE_SCALE))
    score_int = max(0, min(SCORE_SCALE, score_int))
    new_best = max(prev_best_int, score_int)
    marginal = max(0, new_best - prev_best_int)
    out = {
        "trialId": int(trial["trialId"]),
        "marginalCoverage": marginal,
        "cumulativeCoverage": new_best,
        "totalCovered": score_int,
        # Set semantics: trial "covers" all integer levels up to its score.
        # Union of trials' coveredBranches = best_so_far. Trial-internal length
        # = score_int + 1.
        "coveredBranches": list(range(0, score_int + 1)),
        "parameters": dict(trial["parameters"]),
        # Extra HPO context kept for reference (not consumed by viz directly).
        "score": score,
        "elapsed": float(trial.get("elapsed", 0.0)),
    }
    return out, new_best


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
    trials_out: list[dict] = []
    best = 0
    for t in raw_trials:
        out, best = convert_trial(t, best)
        trials_out.append(out)
    payload = {
        "program": task,
        "tuner": tuner,
        "totalTrials": len(trials_out),
        # Across-program union = best score reached + 1 levels (0..best inclusive).
        "totalUniqueBranches": best + 1,
        "trials": trials_out,
    }
    return payload


def compute_program_total_unique(per_tuner: dict[str, dict]) -> int:
    best = 0
    for payload in per_tuner.values():
        for t in payload["trials"]:
            best = max(best, int(t["totalCovered"]))
    return best + 1


def write_per_tuner(task: str, per_tuner: dict[str, dict]):
    program_total = compute_program_total_unique(per_tuner)
    print(f"  Program-level best score: {program_total - 1} / {SCORE_SCALE}")
    for tuner, payload in per_tuner.items():
        payload["totalUniqueBranches"] = program_total
        out_path = OUT_DIR / f"{task}_{tuner}_processed.json"
        with open(out_path, "w") as f:
            json.dump(payload, f)
        print(f"    → {out_path}  (n={payload['totalTrials']})")


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
