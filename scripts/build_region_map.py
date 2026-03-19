#!/usr/bin/env python3
"""
Build region maps for the Search Space Occupancy visualization.

Generates {program}_region_map.json for gawk, gcal, grep.

Two-layer architecture:
  semantic region  – parameter similarity cluster (30 from LOD / 30 from K-means)
  spatial island   – connected hex component within a region (many, globally numbered)

Each node carries both regionId and islandId (per method) so the frontend can render:
  · solid border  = different region
  · dashed border = same region, different island

Each region/island carries sharedScore + interpretationTag so the frontend can
highlight common exploration areas without re-clustering.
"""

import json
import math
import numpy as np
from pathlib import Path
from sklearn.cluster import KMeans

DATA_DIR = Path("public/data")
PROGRAMS = ["gawk", "gcal", "grep"]
TUNER_NAMES = ["SymTuner", "CMA_ES", "Genetic", "SuccessiveHalving", "TPE", "BayesianOptimization"]
TUNER_SHORT = {"SymTuner": "Sym", "CMA_ES": "CMA", "Genetic": "Gen", "SuccessiveHalving": "SH", "TPE": "TPE", "BayesianOptimization": "BO"}

LOD_LEVEL_INDEX = 8
N_REGIONS_B = 30
MAX_LABEL_PARTS = 2
MAX_ISLANDS_STORED = 5   # top islands stored per region
HEX_DIRS = [(1, 0), (0, 1), (-1, 1), (-1, 0), (0, -1), (1, -1)]


# ─────────────────────────────────────────────────────────────
# Utility
# ─────────────────────────────────────────────────────────────

def shannon_entropy(counts: dict) -> float:
    total = sum(counts.values())
    if total == 0:
        return 0.0
    probs = [v / total for v in counts.values() if v > 0]
    h = -sum(p * math.log2(p) for p in probs)
    return h / math.log2(len(TUNER_NAMES))


def get_dominant_tuner(counts: dict) -> str | None:
    if not counts or all(v == 0 for v in counts.values()):
        return None
    return max(counts, key=counts.get)


def compute_shared_score(tuner_counts: dict, total_trials: int) -> float:
    """
    0 = one tuner monopolises; 1 = all tuners equally present.
    Formula: 0.5 * entropy  +  0.5 * (1 - dominance_ratio)
    """
    diversity = shannon_entropy(tuner_counts)
    dom = get_dominant_tuner(tuner_counts)
    dom_ratio = tuner_counts.get(dom, 0) / max(total_trials, 1) if dom else 1.0
    return round(0.5 * diversity + 0.5 * (1.0 - dom_ratio), 4)


def compute_interpretation_tag(
    tuner_counts: dict,
    total_trials: int,
    mean_cov: float,
    global_mean_cov: float,
    shared_score: float,
) -> str:
    dom = get_dominant_tuner(tuner_counts)
    dom_ratio = tuner_counts.get(dom, 0) / max(total_trials, 1) if dom else 0.0
    sorted_t = sorted(tuner_counts.items(), key=lambda x: -x[1])

    if shared_score >= 0.55:
        top2 = [TUNER_SHORT.get(t[0], t[0][:3]) for t in sorted_t[:2] if t[1] > 0]
        return "Shared · " + "/".join(top2)
    if mean_cov >= global_mean_cov * 1.25:
        return "High cov"
    if mean_cov <= global_mean_cov * 0.65:
        return "Low cov"
    if dom_ratio >= 0.85:
        return f"{TUNER_SHORT.get(dom, dom[:3])}-only"
    top2 = [TUNER_SHORT.get(t[0], t[0][:3]) for t in sorted_t[:2] if t[1] > 0]
    return "/".join(top2) + "-led"


# ─────────────────────────────────────────────────────────────
# Gower-like feature matrix
# ─────────────────────────────────────────────────────────────

def build_gower_features(
    active_nodes: list[dict],
    all_params: list[str],
    param_meta: dict,
    include_coverage: bool = False,
) -> np.ndarray:
    cat_enc: dict[str, dict[str, int]] = {}
    cat_k: dict[str, int] = {}
    for p in all_params:
        m = param_meta.get(p, {})
        if m.get("type") == "categorical":
            cats = m.get("categories", [])
            cat_enc[p] = {str(c): j for j, c in enumerate(cats)}
            cat_k[p] = len(cats)

    rows = []
    for node in active_nodes:
        raw = node["discrete"]
        row: list[float] = []
        for i, p in enumerate(all_params):
            v = raw[i] if i < len(raw) else 0
            m = param_meta.get(p, {})
            ptype = m.get("type", "numeric")
            if ptype == "boolean":
                row.append(float(int(v)))
            elif ptype == "numeric":
                n_bins = max(len(m.get("binEdges", [0, 1])) - 1, 1)
                row.append(float(v) / n_bins)
            else:
                k = cat_k.get(p, 1)
                idx = cat_enc.get(p, {}).get(str(v), 0)
                scale = 1.0 / math.sqrt(max(k, 1))
                onehot = [0.0] * k
                onehot[idx] = scale
                row.extend(onehot)
        rows.append(row)

    feat = np.array(rows, dtype=float)
    if include_coverage:
        cov = np.array([n["meanCoverage"] for n in active_nodes], dtype=float)
        r = cov.max() - cov.min()
        cov_norm = ((cov - cov.min()) / r if r > 0 else np.zeros_like(cov)).reshape(-1, 1)
        feat = np.column_stack([feat * 0.8, cov_norm * 0.2])
    return feat


# ─────────────────────────────────────────────────────────────
# Global value distributions
# ─────────────────────────────────────────────────────────────

def _value_label(v, ptype: str, cats: list, enc: dict) -> str:
    if ptype == "boolean":
        return "T" if int(v) else "F"
    elif ptype == "categorical":
        idx = enc.get(str(v), 0)
        return cats[idx] if idx < len(cats) else str(idx)
    return str(int(v))


def compute_global_dists(
    active_nodes: list[dict],
    all_params: list[str],
    param_meta: dict,
) -> dict[str, dict[str, float]]:
    cat_enc: dict[str, dict[str, int]] = {}
    for p in all_params:
        m = param_meta.get(p, {})
        if m.get("type") == "categorical":
            cat_enc[p] = {str(c): j for j, c in enumerate(m.get("categories", []))}

    dists: dict[str, dict[str, float]] = {}
    for i, p in enumerate(all_params):
        m = param_meta.get(p, {})
        ptype = m.get("type", "numeric")
        cats = m.get("categories", []) if ptype == "categorical" else []
        enc = cat_enc.get(p, {})
        wt: dict[str, float] = {}
        for node in active_nodes:
            v = node["discrete"][i] if i < len(node["discrete"]) else 0
            lbl = _value_label(v, ptype, cats, enc)
            wt[lbl] = wt.get(lbl, 0.0) + node["trialCount"]
        total = sum(wt.values())
        dists[p] = {k: v / total for k, v in wt.items()} if total else {}
    return dists


# ─────────────────────────────────────────────────────────────
# Label from weighted mode (contrastive)
# ─────────────────────────────────────────────────────────────

def generate_label(
    region_nodes: list[dict],
    all_params: list[str],
    param_meta: dict,
    global_dists: dict[str, dict[str, float]],
    importance: dict[str, float],
) -> tuple[str, dict]:
    total_trials = sum(n["trialCount"] for n in region_nodes)
    if total_trials == 0:
        return "Typical region", {}

    cat_enc: dict[str, dict[str, int]] = {}
    for p in all_params:
        m = param_meta.get(p, {})
        if m.get("type") == "categorical":
            cat_enc[p] = {str(c): j for j, c in enumerate(m.get("categories", []))}

    scored: list[tuple[float, str, str, str]] = []
    for i, p in enumerate(all_params):
        m = param_meta.get(p, {})
        ptype = m.get("type", "numeric")
        cats = m.get("categories", []) if ptype == "categorical" else []
        enc = cat_enc.get(p, {})
        imp = importance.get(p, 1e-4)

        wt: dict = {}
        for node in region_nodes:
            v = node["discrete"][i] if i < len(node["discrete"]) else 0
            lbl = _value_label(v, ptype, cats, enc)
            wt[lbl] = wt.get(lbl, 0.0) + node["trialCount"]
        if not wt:
            continue

        mode_lbl = max(wt, key=wt.get)
        mode_freq = wt[mode_lbl] / total_trials
        global_freq = global_dists.get(p, {}).get(mode_lbl, 0.0)
        contrastive = (mode_freq - global_freq) * imp
        if mode_freq > 0.5 and contrastive > 0:
            scored.append((contrastive, p, mode_lbl, ptype))

    if not scored:
        return "Typical region", {}
    scored.sort(reverse=True)

    parts: list[str] = []
    signature: dict = {}
    for _, p, mode_lbl, ptype in scored[:MAX_LABEL_PARTS]:
        m = param_meta.get(p, {})
        if ptype == "boolean":
            parts.append(f"{p}={mode_lbl}")
            signature[p] = mode_lbl == "T"
        elif ptype == "numeric":
            n_bins = max(len(m.get("binEdges", [0, 1])) - 1, 1)
            pos = int(mode_lbl) / n_bins
            level = "Low" if pos < 0.33 else ("High" if pos > 0.67 else "Mid")
            parts.append(f"{level} {p}")
            signature[p] = level.lower()
        else:
            parts.append(f"{p}={mode_lbl}")
            signature[p] = mode_lbl
    return ", ".join(parts), signature


# ─────────────────────────────────────────────────────────────
# Island computation (connected components with full stats)
# ─────────────────────────────────────────────────────────────

def compute_islands(
    labels: list[int],
    active_nodes: list[dict],
    global_mean_cov: float,
) -> tuple[list[int], dict[int, list[dict]]]:
    """
    Returns:
      island_ids   – per-node global island ID (0-based, unique within this label set)
      by_region    – { region_id: [island_dict, ...] } sorted largest-first
    """
    coord_map: dict[tuple[int, int], int] = {
        (n["q"], n["r"]): i for i, n in enumerate(active_nodes)
    }

    # Group nodes by region
    by_region: dict[int, dict[tuple[int, int], int]] = {}
    for pos, lbl in enumerate(labels):
        by_region.setdefault(lbl, {})
        by_region[lbl][(active_nodes[pos]["q"], active_nodes[pos]["r"])] = pos

    island_ids = [-1] * len(active_nodes)
    result: dict[int, list[dict]] = {}
    global_id = 0

    for rid, coord_pos in by_region.items():
        visited: set[tuple[int, int]] = set()
        islands: list[dict] = []

        for start in coord_pos:
            if start in visited:
                continue
            queue = [start]
            visited.add(start)
            comp: list[int] = []

            while queue:
                cq, cr = queue.pop(0)
                comp.append(coord_pos[(cq, cr)])
                for dq, dr in HEX_DIRS:
                    nb = (cq + dq, cr + dr)
                    if nb in coord_pos and nb not in visited:
                        visited.add(nb)
                        queue.append(nb)

            # Assign global island id
            for pos in comp:
                island_ids[pos] = global_id

            # Island stats
            island_nodes = [active_nodes[p] for p in comp]
            total_t = sum(n["trialCount"] for n in island_nodes)
            tc = {t: 0 for t in TUNER_NAMES}
            for n in island_nodes:
                for t, c in n["tunerCounts"].items():
                    if t in tc:
                        tc[t] += c
            # trial-count-weighted coverage
            wt_sum = sum(n["trialCount"] for n in island_nodes if n["trialCount"] > 0)
            mean_cov = (
                sum(n["meanCoverage"] * n["trialCount"] for n in island_nodes if n["trialCount"] > 0)
                / wt_sum if wt_sum > 0 else 0.0
            )
            max_cov = max((n["maxCoverage"] for n in island_nodes if n["trialCount"] > 0), default=0.0)
            dom = get_dominant_tuner(tc)
            ss = compute_shared_score(tc, total_t)
            tag = compute_interpretation_tag(tc, total_t, mean_cov, global_mean_cov, ss)

            avg_q = sum(active_nodes[p]["q"] for p in comp) / len(comp)
            avg_r = sum(active_nodes[p]["r"] for p in comp) / len(comp)

            islands.append({
                "id": global_id,
                "regionId": rid,
                "nodeCount": len(comp),
                "trialCount": int(total_t),
                "tunerCounts": {k: int(v) for k, v in tc.items()},
                "dominantTuner": dom,
                "tunerDiversity": round(shannon_entropy(tc), 4),
                "sharedScore": ss,
                "interpretationTag": tag,
                "meanCoverage": round(float(mean_cov), 1),
                "maxCoverage": float(max_cov),
                "qCentroid": round(avg_q, 2),
                "rCentroid": round(avg_r, 2),
            })
            global_id += 1

        islands.sort(key=lambda x: -x["nodeCount"])
        result[rid] = islands

    return island_ids, result


# ─────────────────────────────────────────────────────────────
# Region statistics
# ─────────────────────────────────────────────────────────────

def compute_region_stats(
    region_id: int,
    node_indices: list[int],
    active_nodes: list[dict],
    all_params: list[str],
    param_meta: dict,
    global_dists: dict,
    global_mean_cov: float,
    importance: dict,
    method: str,
    islands: list[dict],   # pre-computed islands for this region
) -> dict:
    region_nodes = [active_nodes[i] for i in node_indices]
    total_trials = sum(n["trialCount"] for n in region_nodes)

    tc = {t: 0 for t in TUNER_NAMES}
    for node in region_nodes:
        for t, cnt in node["tunerCounts"].items():
            if t in tc:
                tc[t] += cnt

    wt_sum = sum(n["trialCount"] for n in region_nodes if n["trialCount"] > 0)
    mean_cov = (
        sum(n["meanCoverage"] * n["trialCount"] for n in region_nodes if n["trialCount"] > 0)
        / wt_sum if wt_sum > 0 else 0.0
    )
    max_cov = max((n["maxCoverage"] for n in region_nodes if n["trialCount"] > 0), default=0.0)

    dom = get_dominant_tuner(tc)
    dom_ratio = tc.get(dom, 0) / max(total_trials, 1) if dom else 0.0
    ss = compute_shared_score(tc, total_trials)
    tag = compute_interpretation_tag(tc, total_trials, mean_cov, global_mean_cov, ss)
    label, signature = generate_label(region_nodes, all_params, param_meta, global_dists, importance)

    # Keep top-N islands (strip trialIndices; already done)
    top_islands = [
        {k: v for k, v in isl.items() if k != "regionId"}
        for isl in islands[:MAX_ISLANDS_STORED]
    ]

    return {
        "id": int(region_id),
        "method": method,
        "nodeIds": [active_nodes[i]["idx"] for i in node_indices],
        "label": label,
        "signature": signature,
        "sharedScore": ss,
        "interpretationTag": tag,
        "trialCount": int(total_trials),
        "tunerCounts": {k: int(v) for k, v in tc.items()},
        "dominantTuner": dom,
        "dominanceRatio": round(float(dom_ratio), 4),
        "tunerDiversity": round(shannon_entropy(tc), 4),
        "meanCoverage": round(float(mean_cov), 1),
        "maxCoverage": float(max_cov),
        "islands": top_islands,
    }


# ─────────────────────────────────────────────────────────────
# Per-program processing
# ─────────────────────────────────────────────────────────────

def group_by_label(labels: list[int]) -> dict[int, list[int]]:
    g: dict[int, list[int]] = {}
    for pos, lbl in enumerate(labels):
        g.setdefault(lbl, []).append(pos)
    return g


def process_program(program: str) -> dict | None:
    layout_path = DATA_DIR / f"{program}_hex_layout.json"
    feat_path = DATA_DIR / f"{program}_feature_selection.json"

    print(f"  Loading {layout_path}...")
    with open(layout_path) as f:
        layout = json.load(f)

    importance: dict[str, float] = {}
    if feat_path.exists():
        with open(feat_path) as f:
            importance = json.load(f).get("importance", {})

    all_params: list[str] = layout["allParams"]
    param_meta: dict = layout["paramMeta"]
    nodes: list[dict] = layout["nodes"]
    for p in all_params:
        importance.setdefault(p, 1e-4)

    active_nodes = [n for n in nodes if n["trialCount"] > 0]
    print(f"  {program}: {len(active_nodes)} active nodes")
    if not active_nodes:
        return None

    total_trials = sum(n["trialCount"] for n in active_nodes)
    global_mean_cov = (
        sum(n["meanCoverage"] * n["trialCount"] for n in active_nodes) / total_trials
    )
    global_dists = compute_global_dists(active_nodes, all_params, param_meta)

    # ── Method A: LOD semantic regions ──────────────────────
    lod = layout["lodLevels"][LOD_LEVEL_INDEX]
    idx_to_lod = {nodes[i]["idx"]: lod["assignments"][i] for i in range(len(nodes))}
    raw_a = [idx_to_lod[n["idx"]] for n in active_nodes]
    remap = {old: new for new, old in enumerate(sorted(set(raw_a)))}
    labels_a = [remap[l] for l in raw_a]

    island_ids_a, islands_by_region_a = compute_islands(labels_a, active_nodes, global_mean_cov)
    n_islands_a = max(island_ids_a) + 1
    print(f"  Method A: {len(set(labels_a))} regions, {n_islands_a} islands")

    # ── Method B: K-means Gower + coverage ─────────────────
    feat_b = build_gower_features(active_nodes, all_params, param_meta, include_coverage=True)
    n_b = min(N_REGIONS_B, len(active_nodes) // 10)
    kmeans = KMeans(n_clusters=n_b, random_state=42, n_init=10, max_iter=300)
    labels_b = kmeans.fit_predict(feat_b).tolist()

    island_ids_b, islands_by_region_b = compute_islands(labels_b, active_nodes, global_mean_cov)
    n_islands_b = max(island_ids_b) + 1
    print(f"  Method B: {len(set(labels_b))} regions, {n_islands_b} islands")

    # ── Region stats ─────────────────────────────────────────
    def build_regions(labels, method, islands_by_region):
        groups = group_by_label(labels)
        stats = [
            compute_region_stats(
                rid, idxs, active_nodes, all_params, param_meta,
                global_dists, global_mean_cov, importance, method,
                islands_by_region.get(rid, []),
            )
            for rid, idxs in groups.items()
        ]
        stats.sort(key=lambda r: -r["trialCount"])
        return stats

    regions_a = build_regions(labels_a, "param", islands_by_region_a)
    regions_b = build_regions(labels_b, "param_cov", islands_by_region_b)

    # ── Diagnostic: sharedScore distribution ────────────────
    for method_name, regions in [("param", regions_a), ("param_cov", regions_b)]:
        high = sum(1 for r in regions if r["sharedScore"] >= 0.4)
        print(f"  {method_name}: sharedScore≥0.4: {high}/{len(regions)} regions")

    # ── Output nodes ─────────────────────────────────────────
    output_nodes = [
        {
            "idx": n["idx"],
            "q": n["q"],
            "r": n["r"],
            "trialCount": n["trialCount"],
            "tunerCounts": n["tunerCounts"],
            "meanCoverage": round(n["meanCoverage"], 1),
            "maxCoverage": n["maxCoverage"],
            "dominantTuner": get_dominant_tuner(n["tunerCounts"]),
            "regionId_param": labels_a[i],
            "islandId_param": island_ids_a[i],
            "regionId_param_cov": labels_b[i],
            "islandId_param_cov": island_ids_b[i],
        }
        for i, n in enumerate(active_nodes)
    ]

    return {
        "program": program,
        "totalTrials": int(total_trials),
        "nParams": len(all_params),
        "globalMeanCoverage": round(global_mean_cov, 1),
        "nodes": output_nodes,
        "regions_param": regions_a,
        "regions_param_cov": regions_b,
    }


# ─────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────

def main():
    for program in PROGRAMS:
        print(f"\n{'='*50}")
        print(f"Processing {program}...")
        result = process_program(program)
        if result:
            out_path = DATA_DIR / f"{program}_region_map.json"
            with open(out_path, "w") as f:
                json.dump(result, f, separators=(",", ":"))
            kb = out_path.stat().st_size / 1024
            print(f"  → {kb:.0f} KB")


if __name__ == "__main__":
    main()
