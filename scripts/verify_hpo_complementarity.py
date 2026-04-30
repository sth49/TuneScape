"""
Quick sanity check: are the per-trial coveredBranches sets actually disjoint
in interesting ways across tuners?

For each task, picks the BEST trial per tuner and computes pairwise
union/intersection/sym-diff. If the new run preserved the per-instance
correctness vectors, we should see NON-ZERO complementarity (sym-diff > 0)
between different tuners' best models.
"""
import json
import sys
from pathlib import Path

DATA_DIR = Path("public/data")
TUNERS = ["Random", "Grid", "Genetic", "BOHB"]


def main(task: str):
    print(f"=== {task} ===")
    per_tuner_best = {}
    n_val = None
    for tuner in TUNERS:
        path = DATA_DIR / f"{task}_{tuner}_processed.json"
        if not path.exists():
            print(f"  ✗ missing {path}")
            continue
        with open(path) as f:
            d = json.load(f)
        n_val = int(d.get("nValSamples") or d.get("totalUniqueBranches", 0))
        # Best trial = highest totalCovered
        trials = d["trials"]
        best = max(trials, key=lambda t: t["totalCovered"])
        cov = set(best["coveredBranches"])
        per_tuner_best[tuner] = (best["totalCovered"], cov, best.get("score", 0.0))
        print(f"  {tuner}: best trial cov={best['totalCovered']}/{n_val} "
              f"({best['totalCovered']/n_val*100:.2f}%)  trialId={best['trialId']}")

    print(f"\n  Validation universe: {n_val}")
    print(f"\n  Pairwise complementarity (best trial of each tuner):")
    backsl = "\\"
    print(f"    {'pair':<25s}  {'union':>6s}  {'inter':>6s}  {'A'+backsl+'B':>6s}  {'B'+backsl+'A':>6s}")
    keys = list(per_tuner_best.keys())
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            ca, cb = per_tuner_best[a][1], per_tuner_best[b][1]
            u = len(ca | cb)
            inter = len(ca & cb)
            a_only = len(ca - cb)
            b_only = len(cb - ca)
            label = f"{a}–{b}"
            print(f"    {label:<25s}  {u:>6d}  {inter:>6d}  {a_only:>6d}  {b_only:>6d}")

    # 4-way union
    if len(per_tuner_best) >= 2:
        all_union = set()
        for _, cov, _ in per_tuner_best.values():
            all_union |= cov
        best_single = max(t[0] for t in per_tuner_best.values())
        print(f"\n  4-way union |B|: {len(all_union)} ({len(all_union)/n_val*100:.2f}%)")
        print(f"  Single best:     {best_single}    ({best_single/n_val*100:.2f}%)")
        print(f"  Ensemble gain:   +{len(all_union) - best_single} samples "
              f"(+{(len(all_union) - best_single)/n_val*100:.2f} pp)")


if __name__ == "__main__":
    tasks = sys.argv[1:] or ["adult", "phoneme"]
    for t in tasks:
        main(t)
        print()
