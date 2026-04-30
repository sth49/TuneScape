"""
Analyze HPO precomputed hex map data for T1/T2/T3 findings + ensemble implications.

Loads {task}_hexmap_precomputed.json and reports:
  - Validation universe size + per-trial accuracy histogram
  - T1: tuner footprint distribution (cells dominated by each tuner)
  - T2: parameter contrast — for each top SHAP/importance param, which bin
        separates BOHB-dominant cells from Random/Grid/Genetic
  - T3: anchor + greedy complement walk (1→2→3 cells), report union accuracy

Usage:  python scripts/analyze_hpo_findings.py --task adult [--level 4]
"""
import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path


DATA_DIR = Path("public/data")


def dominant_tuner(tuner_counts: dict) -> tuple[str, int, int]:
    items = [(t, c) for t, c in tuner_counts.items() if c > 0]
    if not items:
        return ("none", 0, 0)
    items.sort(key=lambda x: -x[1])
    total = sum(c for _, c in items)
    return (items[0][0], items[0][1], total)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", default="adult")
    ap.add_argument("--level", type=int, default=4, help="LoD level (0..4); 4 = finest k=200")
    args = ap.parse_args()

    path = DATA_DIR / f"{args.task}_hexmap_precomputed.json"
    with open(path) as f:
        d = json.load(f)
    levels = d["levels"]
    L = levels[args.level]
    n_clusters = len(L["clusters"])
    print(f"=== {args.task} L{args.level} (k={n_clusters}) ===")

    # Validation universe — read from a processed file
    n_val = None
    for tuner in ["Random", "Grid", "Genetic", "BOHB"]:
        ppath = DATA_DIR / f"{args.task}_{tuner}_processed.json"
        if ppath.exists():
            with open(ppath) as f:
                p = json.load(f)
            n_val = int(p.get("nValSamples") or p.get("totalUniqueBranches", 0))
            break
    print(f"  Validation universe: {n_val} samples")

    # ── T1: tuner footprint ──
    dom_count: Counter = Counter()
    tuner_total_trials: Counter = Counter()
    for c in L["clusters"]:
        dom_t, _, _ = dominant_tuner(c["tunerCounts"])
        dom_count[dom_t] += 1
        for t, n in c["tunerCounts"].items():
            tuner_total_trials[t] += n
    print(f"\n[T1] Dominated cells per tuner: {dict(dom_count)}")
    print(f"[T1] Total trials per tuner: {dict(tuner_total_trials)}")

    # ── Top cells by max validation coverage ──
    top10 = sorted(L["clusters"], key=lambda c: -c["maxBranchCoverage"])[:10]
    print(f"\n[T1] Top-10 cells by maxBranchCoverage:")
    for c in top10:
        nz = {k: v for k, v in c["tunerCounts"].items() if v > 0}
        print(f"  cid={c['id']:3d}  max={c['maxBranchCoverage']}  mean={c['meanBranchCoverage']:.1f}  "
              f"|B|={len(c['coveredBranches'])}  counts={nz}")

    # ── T2: parameter contrast ──
    # For each numeric parameter: compute global p33/p66 across all trials,
    # then for each cell compute median value's bin (Low/Mid/High). Cross-tab
    # against dominant tuner per cell.
    print(f"\n[T2] Parameter contrast (numeric params, top-5 by importance):")

    # Load param importance
    pi_path = DATA_DIR / "param_importance.json"
    if pi_path.exists():
        with open(pi_path) as f:
            pi_doc = json.load(f)
        importance = pi_doc.get(args.task, {}).get("_combined", [])
    else:
        importance = []

    # Build map: cluster id → list of trials' params (from `trials` field)
    trials_db = d["trials"]  # deduped list at file root
    cluster_trials: dict[int, list] = defaultdict(list)
    for c in L["clusters"]:
        for ti in c["trialIndices"]:
            cluster_trials[c["id"]].append(trials_db[ti])

    # Determine numeric vs categorical from a sample trial
    sample = trials_db[0]["parameters"]
    numeric_params = [k for k, v in sample.items() if isinstance(v, (int, float)) and not isinstance(v, bool)]

    # For each top-importance numeric param, compute Low/Mid/High split
    top_numeric = [e["name"] for e in importance if e["name"] in numeric_params][:8]
    for pname in top_numeric:
        all_vals = []
        for t in trials_db:
            v = t["parameters"].get(pname)
            if v is not None:
                all_vals.append(float(v))
        all_vals.sort()
        if len(all_vals) < 3:
            continue
        gP33 = all_vals[len(all_vals) // 3]
        gP66 = all_vals[2 * len(all_vals) // 3]

        # Per-cell bin = bin of cell's trial median
        # Cross-tab: bin × dominant tuner
        crosstab: dict[tuple[str, str], int] = defaultdict(int)
        for c in L["clusters"]:
            cell_trials = cluster_trials[c["id"]]
            if not cell_trials:
                continue
            vals = sorted(float(t["parameters"][pname]) for t in cell_trials)
            median = vals[len(vals) // 2]
            if median <= gP33:
                bin_label = "Low"
            elif median <= gP66:
                bin_label = "Mid"
            else:
                bin_label = "High"
            dom = dominant_tuner(c["tunerCounts"])[0]
            crosstab[(bin_label, dom)] += 1

        # Print cross-tab
        bins = ["Low", "Mid", "High"]
        tuners = ["Random", "Grid", "Genetic", "BOHB"]
        # Compute discriminative power: max( |% of tuner T cells in bin B - % of others in bin B| ) over (T, B)
        tuner_totals = {t: sum(crosstab.get((b, t), 0) for b in bins) for t in tuners}
        max_contrast = 0
        max_label = ""
        for t in tuners:
            for b in bins:
                share_t = crosstab.get((b, t), 0) / max(tuner_totals[t], 1)
                others = sum(crosstab.get((b, ot), 0) for ot in tuners if ot != t)
                others_total = sum(tuner_totals[ot] for ot in tuners if ot != t)
                share_other = others / max(others_total, 1)
                contrast = share_t - share_other
                if abs(contrast) > abs(max_contrast):
                    max_contrast = contrast
                    max_label = f"{t}∈{b}: {share_t*100:.0f}% vs others {share_other*100:.0f}% (Δ{contrast*100:+.0f}pp)"
        print(f"  {pname:<22s}  range [{gP33:.3f}, {gP66:.3f}]  best contrast: {max_label}")
        # Detailed table
        for b in bins:
            row = "    " + b.ljust(6) + "  "
            for t in tuners:
                row += f"{t}={crosstab.get((b, t), 0):3d}  "
            print(row)

    # ── T3: anchor + greedy complement ──
    print(f"\n[T3] Greedy complement walk:")
    # Anchor = cell with the largest |B| (= largest correct-set in any cell)
    clusters_by_B = sorted(L["clusters"], key=lambda c: -len(c["coveredBranches"]))
    anchor = clusters_by_B[0]
    anchor_B = set(anchor["coveredBranches"])
    anchor_dom = dominant_tuner(anchor["tunerCounts"])[0]
    print(f"  Anchor: cid={anchor['id']}  dom={anchor_dom}  |B|={len(anchor_B)}  "
          f"({len(anchor_B)/n_val*100:.2f}% of {n_val})  counts={ {k:v for k,v in anchor['tunerCounts'].items() if v>0} }")

    union = set(anchor_B)
    chosen = [anchor["id"]]
    chosen_dom = [anchor_dom]
    print(f"  step 1: union |B|={len(union)}  ({len(union)/n_val*100:.2f}%)")

    # Greedily pick the cell with the largest marginal gain over current union
    for step in range(2, 6):
        best = None
        best_gain = 0
        for c in L["clusters"]:
            if c["id"] in chosen:
                continue
            cb = set(c["coveredBranches"])
            gain = len(cb - union)
            if gain > best_gain:
                best = c
                best_gain = gain
        if not best:
            break
        cb = set(best["coveredBranches"])
        union |= cb
        chosen.append(best["id"])
        dom = dominant_tuner(best["tunerCounts"])[0]
        chosen_dom.append(dom)
        nz = {k: v for k, v in best["tunerCounts"].items() if v > 0}
        print(f"  step {step}: + cid={best['id']} dom={dom} +N={best_gain} "
              f"counts={nz}  →  union |B|={len(union)} ({len(union)/n_val*100:.2f}%)")

    # ── Ensemble baseline reference ──
    # Single best tuner's overall best trial accuracy
    print(f"\n[ref] Single best trial across all tuners: ", end="")
    best_single = 0
    best_tuner = ""
    for tuner in ["Random", "Grid", "Genetic", "BOHB"]:
        ppath = DATA_DIR / f"{args.task}_{tuner}_processed.json"
        if not ppath.exists():
            continue
        with open(ppath) as f:
            p = json.load(f)
        best = max(t["totalCovered"] for t in p["trials"])
        if best > best_single:
            best_single = best
            best_tuner = tuner
    print(f"{best_tuner} with {best_single}/{n_val} = {best_single/n_val*100:.2f}%")


if __name__ == "__main__":
    main()
