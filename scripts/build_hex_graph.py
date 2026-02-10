"""
Hex Map Pipeline Steps 3-7: Discretize → Aggregate → Graph → Connectivity → QAP Layout

Target: gawk program, 4 tuners × 2200 trials = 8800 trials
Decision: unique combinations only → each hex = one parameter combination
"""

import json
import math
import random
import numpy as np
from collections import Counter, defaultdict
from pathlib import Path
import time

# ─── Config ───────────────────────────────────────────────────────────────────
PROGRAM = "gawk"
TUNERS = ["SymTuner", "CMA_ES", "Genetic", "SuccessiveHalving"]
DATA_DIR = Path(__file__).parent.parent / "public" / "data"
OUTPUT_DIR = Path(__file__).parent.parent / "public" / "data"

# Top-10 SHAP parameters (ordered by importance)
SHAP_PARAMS = [
    "seed-file",              # categorical, 10 levels (1-10)
    "search",                 # categorical, 11 levels
    "readable-posix-inputs",  # boolean
    "switch-type",            # categorical, 3 levels
    "sym-arg",                # continuous → 6 levels (299 separate)
    "warnings-only-to-file",  # boolean
    "verify-each",            # boolean
    "watchdog",               # boolean
    "disable-verify",         # boolean
    "use-cex-cache",          # boolean
]


# ─── Step 1: Load Data ───────────────────────────────────────────────────────
def load_trials():
    """Load all gawk trials from 4 tuners."""
    all_trials = []
    for tuner in TUNERS:
        fpath = DATA_DIR / f"{PROGRAM}_{tuner}_processed.json"
        with open(fpath) as f:
            data = json.load(f)
        for trial in data["trials"]:
            all_trials.append({
                "tuner": tuner,
                "trialId": trial["trialId"],
                "marginalCoverage": trial["marginalCoverage"],
                "cumulativeCoverage": trial["cumulativeCoverage"],
                "totalCovered": trial["totalCovered"],
                "parameters": trial["parameters"],
            })
    return all_trials


# ─── Step 3: sym-arg 6-level binning (299 as separate level) ─────────────────
def discretize_sym_arg(value, bin_edges_below_299):
    """
    6 levels:
      Bin 0-3: values < 299, quantile 4-split
      Bin 4:   exactly 299
      Bin 5:   values > 299
    """
    if value == 299:
        return 4
    elif value > 299:
        return 5
    else:
        idx = np.searchsorted(bin_edges_below_299[1:], value, side='right')
        return int(min(idx, 3))


def compute_sym_arg_bins(trials):
    """Compute bin edges for sym-arg < 299 (quantile 4-split)."""
    all_values = [t["parameters"]["sym-arg"] for t in trials]
    below_299 = [v for v in all_values if v < 299]

    quantiles = np.linspace(0, 1, 5)  # 4 bins for below-299
    bin_edges = np.quantile(below_299, quantiles)
    bin_edges = np.unique(bin_edges)

    print(f"\n=== sym-arg 6-level Binning ===")
    print(f"  Total values: {len(all_values)}")
    print(f"  Below 299: {len(below_299)}, Exactly 299: {sum(1 for v in all_values if v == 299)}, "
          f"Above 299: {sum(1 for v in all_values if v > 299)}")
    print(f"  Below-299 quantile edges: {bin_edges.tolist()}")

    # Show distribution across 6 levels
    bin_indices = [discretize_sym_arg(v, bin_edges) for v in all_values]
    bin_counts = Counter(bin_indices)
    labels = ["<299 Q1", "<299 Q2", "<299 Q3", "<299 Q4", "=299", ">299"]
    for b in range(6):
        print(f"  Bin {b} ({labels[b]}): {bin_counts.get(b, 0)} trials")

    return bin_edges


# ─── Step 4: Discretize All Trials ───────────────────────────────────────────
def discretize_trials(trials, sym_arg_bin_edges):
    """Convert each trial's top-10 parameters into a discrete tuple."""
    discretized = []
    for t in trials:
        params = t["parameters"]
        disc = []
        for p in SHAP_PARAMS:
            val = params[p]
            if p == "sym-arg":
                disc.append(discretize_sym_arg(val, sym_arg_bin_edges))
            elif isinstance(val, bool):
                disc.append(int(val))
            else:
                disc.append(val)
        discretized.append(tuple(disc))
    return discretized


# ─── Step 4b: Aggregate into unique combinations ─────────────────────────────
def aggregate_unique(trials, discretized):
    """
    Group trials by their discrete parameter combination.
    Each unique combination becomes one hex node.
    """
    combo_map = defaultdict(list)  # discrete_tuple -> [trial_indices]
    for i, combo in enumerate(discretized):
        combo_map[combo].append(i)

    unique_nodes = []
    for combo, trial_indices in combo_map.items():
        tuner_counts = Counter(trials[i]["tuner"] for i in trial_indices)
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

    # Sort by trial count descending for visibility
    unique_nodes.sort(key=lambda x: x["trialCount"], reverse=True)

    print(f"\n=== Unique Combination Aggregation ===")
    print(f"  Total trials: {len(trials)}")
    print(f"  Unique combinations: {len(unique_nodes)}")
    print(f"  Top 5 by trial count:")
    for i, node in enumerate(unique_nodes[:5]):
        tuner_str = ", ".join(f"{t}:{c}" for t, c in sorted(node["tunerCounts"].items()))
        print(f"    #{i}: {node['trialCount']} trials [{tuner_str}] "
              f"coverage={node['meanCoverage']:.0f}")

    # Distribution of trial counts
    counts = [n["trialCount"] for n in unique_nodes]
    print(f"\n  Trial count distribution:")
    print(f"    Singletons (1 trial): {sum(1 for c in counts if c == 1)}")
    print(f"    2-5 trials: {sum(1 for c in counts if 2 <= c <= 5)}")
    print(f"    6-20 trials: {sum(1 for c in counts if 6 <= c <= 20)}")
    print(f"    21-100 trials: {sum(1 for c in counts if 21 <= c <= 100)}")
    print(f"    >100 trials: {sum(1 for c in counts if c > 100)}")

    return unique_nodes


# ─── Step 5: Build Graph on Unique Nodes ──────────────────────────────────────
def hamming_distance(a, b):
    """Count number of differing parameters between two discrete tuples."""
    return sum(1 for x, y in zip(a, b) if x != y)


def build_graph(unique_nodes, max_dist=2):
    """Build adjacency list on unique combinations (not individual trials)."""
    n = len(unique_nodes)
    combos = [node["discrete"] for node in unique_nodes]

    print(f"\n=== Graph Construction (n={n} unique nodes, max_dist={max_dist}) ===")

    adjacency = defaultdict(list)
    edge_count = {d: 0 for d in range(1, max_dist + 1)}

    start = time.time()
    for i in range(n):
        if i % 500 == 0 and i > 0:
            elapsed = time.time() - start
            rate = i / elapsed
            eta = (n - i) / rate
            print(f"  Processing node {i}/{n} ({elapsed:.1f}s elapsed, ~{eta:.0f}s remaining)")
        for j in range(i + 1, n):
            d = hamming_distance(combos[i], combos[j])
            if 1 <= d <= max_dist:
                adjacency[i].append((j, d))
                adjacency[j].append((i, d))
                edge_count[d] += 1

    elapsed = time.time() - start
    print(f"  Completed in {elapsed:.1f}s")

    total_edges = sum(edge_count.values())
    print(f"\n  Edge statistics:")
    for d in range(1, max_dist + 1):
        print(f"    Hamming distance = {d}: {edge_count[d]:,} edges")
    print(f"    Total edges: {total_edges:,}")

    degrees = [len(adjacency[i]) for i in range(n)]
    isolated = sum(1 for d in degrees if d == 0)
    print(f"\n  Degree statistics:")
    print(f"    Isolated nodes (degree 0): {isolated}")
    print(f"    Min degree: {min(degrees)}, Max degree: {max(degrees)}")
    print(f"    Mean degree: {np.mean(degrees):.1f}, Median degree: {np.median(degrees):.0f}")

    return adjacency, edge_count


# ─── Step 6: Connectivity Check ──────────────────────────────────────────────
def find_connected_components(adjacency, n):
    """BFS-based connected components."""
    visited = [False] * n
    components = []
    for start_node in range(n):
        if visited[start_node]:
            continue
        component = []
        queue = [start_node]
        visited[start_node] = True
        while queue:
            node = queue.pop(0)
            component.append(node)
            for neighbor, _ in adjacency.get(node, []):
                if not visited[neighbor]:
                    visited[neighbor] = True
                    queue.append(neighbor)
        components.append(component)
    return components


def check_connectivity(adjacency, n, unique_nodes):
    """Analyze connected components."""
    components = find_connected_components(adjacency, n)
    components.sort(key=len, reverse=True)

    total_trials = sum(node["trialCount"] for node in unique_nodes)

    print(f"\n=== Connectivity Analysis ===")
    print(f"  Total connected components: {len(components)}")

    for i, comp in enumerate(components[:10]):
        comp_trials = sum(unique_nodes[idx]["trialCount"] for idx in comp)
        print(f"  Component {i}: {len(comp)} nodes, {comp_trials} trials "
              f"({comp_trials/total_trials*100:.1f}%)")

    if len(components) > 10:
        remaining_nodes = sum(len(c) for c in components[10:])
        remaining_trials = sum(
            unique_nodes[idx]["trialCount"]
            for c in components[10:] for idx in c
        )
        print(f"  ... and {len(components) - 10} more ({remaining_nodes} nodes, "
              f"{remaining_trials} trials)")

    sizes = [len(c) for c in components]
    print(f"\n  Singletons: {sum(1 for s in sizes if s == 1)}")
    print(f"  Components ≥10 nodes: {sum(1 for s in sizes if s >= 10)}")
    print(f"  Largest component: {sizes[0]} nodes ({sizes[0]/n*100:.1f}% of unique combos)")

    return components


# ─── Step 7: QAP Hex Grid Placement ──────────────────────────────────────────

def hex_distance(q1, r1, q2, r2):
    """Axial hex distance."""
    return (abs(q1 - q2) + abs(q1 + r1 - q2 - r2) + abs(r1 - r2)) // 2


EDGE_WEIGHTS = {1: 1.0}  # d=1 only

# 6 axial hex neighbor directions
HEX_DIRS = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, -1), (-1, 1)]


def hex_neighbors(q, r):
    """Return the 6 adjacent hex positions."""
    return [(q + dq, r + dr) for dq, dr in HEX_DIRS]


def hex_ring(q, r, radius):
    """Return all hex positions at exactly `radius` distance from (q, r)."""
    if radius == 0:
        return [(q, r)]
    results = []
    # Start at one corner and walk the ring
    cq, cr = q + radius, r - radius  # start corner
    dirs = [(-1, 1), (-1, 0), (0, -1), (1, -1), (1, 0), (0, 1)]
    for dq, dr in dirs:
        for _ in range(radius):
            results.append((cq, cr))
            cq += dq
            cr += dr
    return results


# ─── BFS Initial Placement ───────────────────────────────────────────────────

def bfs_placement(adj_d1, adj_d2, n):
    """
    3-step placement:
      Step 1: d=1-only BFS (largest component first, then smaller ones)
      Step 2: Place isolated nodes near d=2 neighbors
      Step 3: Fill remaining near center
    """
    import heapq
    print("\n=== BFS Initial Placement (d=1 first) ===")

    # Build d=1 and d=2 neighbor lists
    d1_nb = defaultdict(list)
    d2_nb = defaultdict(list)
    for i in range(n):
        for j, d in adj_d1.get(i, []):
            if d == 1:
                d1_nb[i].append(j)
        for j, d in adj_d2.get(i, []):
            if d == 2:
                d2_nb[i].append(j)

    d1_degree = [len(d1_nb[i]) for i in range(n)]

    positions = [None] * n
    occupied = {}

    def place(node, q, r):
        positions[node] = (q, r)
        occupied[(q, r)] = node

    def find_nearest_free(tq, tr, max_search=150):
        if (tq, tr) not in occupied:
            return (tq, tr)
        for rad in range(1, max_search):
            ring = hex_ring(tq, tr, rad)
            random.shuffle(ring)
            for hq, hr in ring:
                if (hq, hr) not in occupied:
                    return (hq, hr)
        return None

    # ── Step 1: Find d=1 connected components ──
    visited = [False] * n
    components = []
    for start in range(n):
        if visited[start] or d1_degree[start] == 0:
            continue
        comp = []
        queue = [start]
        visited[start] = True
        while queue:
            node = queue.pop(0)
            comp.append(node)
            for nb in d1_nb[node]:
                if not visited[nb]:
                    visited[nb] = True
                    queue.append(nb)
        components.append(comp)

    components.sort(key=len, reverse=True)
    isolated = [i for i in range(n) if d1_degree[i] == 0]

    print(f"  d=1 components: {len(components)} (largest: {len(components[0]) if components else 0})")
    print(f"  Isolated nodes (no d=1 edges): {len(isolated)}")

    # ── Step 1a: Place each d=1 component via BFS ──
    comp_origins = []  # track where each component starts

    for comp_idx, comp in enumerate(components):
        # Pick seed: highest d=1 degree in this component
        seed = max(comp, key=lambda i: d1_degree[i])

        if comp_idx == 0:
            # First (largest) component at origin
            origin_q, origin_r = 0, 0
        else:
            # Find nearest free hex to the existing cluster (spiral out from center)
            origin_q, origin_r = find_nearest_free(0, 0)

        place(seed, origin_q, origin_r)
        comp_origins.append((origin_q, origin_r))

        # BFS within this component using d=1 edges ONLY
        bfs_q = [seed]
        bfs_visited = {seed}

        while bfs_q:
            current = bfs_q.pop(0)
            cq, cr = positions[current]

            # Sort d=1 neighbors by degree (high degree first → they need more space)
            unplaced_nbs = [nb for nb in d1_nb[current] if nb not in bfs_visited]
            unplaced_nbs.sort(key=lambda x: d1_degree[x], reverse=True)

            for nb in unplaced_nbs:
                if positions[nb] is not None:
                    bfs_visited.add(nb)
                    continue

                # Try to place adjacent to current node
                adj_hexes = hex_neighbors(cq, cr)
                random.shuffle(adj_hexes)
                placed_here = False
                for aq, ar in adj_hexes:
                    if (aq, ar) not in occupied:
                        place(nb, aq, ar)
                        placed_here = True
                        break

                if not placed_here:
                    # All 6 neighbors occupied → find nearest free
                    best = find_nearest_free(cq, cr)
                    place(nb, best[0], best[1])

                bfs_visited.add(nb)
                bfs_q.append(nb)

        if comp_idx < 5 or comp_idx == len(components) - 1:
            print(f"  Component {comp_idx}: {len(comp)} nodes placed (seed d1_deg={d1_degree[seed]})")

    placed_d1 = sum(1 for p in positions if p is not None)
    print(f"\n  After d=1 BFS: {placed_d1}/{n} nodes placed")

    # ── Step 2: Place isolated nodes near their d=2 neighbors ──
    placed_isolated = 0
    for node in isolated:
        # Find best anchor: a d=2 neighbor that's already placed
        anchor = None
        for nb in d2_nb[node]:
            if positions[nb] is not None:
                anchor = nb
                break

        if anchor is not None:
            aq, ar = positions[anchor]
            # Try ring at distance 2 (ideal for d=2 neighbor)
            candidates = hex_ring(aq, ar, 2)
            random.shuffle(candidates)
            placed_here = False
            for cq, cr in candidates:
                if (cq, cr) not in occupied:
                    place(node, cq, cr)
                    placed_here = True
                    break
            if not placed_here:
                best = find_nearest_free(aq, ar)
                place(node, best[0], best[1])
        else:
            # No d=2 neighbor placed either → place near center
            best = find_nearest_free(0, 0)
            place(node, best[0], best[1])

        placed_isolated += 1

    print(f"  After isolated placement: {sum(1 for p in positions if p is not None)}/{n}")

    # Stats
    qs = [p[0] for p in positions]
    rs = [p[1] for p in positions]
    span_q = max(qs) - min(qs)
    span_r = max(rs) - min(rs)
    print(f"  Grid bounds: q=[{min(qs)}, {max(qs)}], r=[{min(rs)}, {max(rs)}]")
    print(f"  Span: {span_q} x {span_r}")

    return positions, occupied


# ─── Loss computation ─────────────────────────────────────────────────────────

def compute_layout_loss(positions, adjacency, n):
    """Weighted stress: Σ w(d) × (hex_dist - d)² over all edges."""
    total_loss = 0.0
    edge_count = 0
    d1_loss = 0.0
    d2_loss = 0.0
    d1_count = 0
    d2_count = 0
    for i in range(n):
        qi, ri = positions[i]
        for j, gd in adjacency.get(i, []):
            if j > i:
                hd = hex_distance(qi, ri, *positions[j])
                w = EDGE_WEIGHTS.get(gd, 1.0)
                cost = w * (hd - gd) ** 2
                total_loss += cost
                edge_count += 1
                if gd == 1:
                    d1_loss += (hd - 1) ** 2
                    d1_count += 1
                else:
                    d2_loss += (hd - 2) ** 2
                    d2_count += 1
    return total_loss, edge_count, d1_loss, d1_count, d2_loss, d2_count


# ─── SA with relocate + swap ─────────────────────────────────────────────────

def report_d1_quality(positions, adjacency, n, label=""):
    """Report d=1 edge placement quality."""
    neighbors_d1 = defaultdict(list)
    for i in range(n):
        for j, d in adjacency.get(i, []):
            if d == 1:
                neighbors_d1[i].append(j)

    d1_hex = []
    for i in range(n):
        qi, ri = positions[i]
        for j in neighbors_d1[i]:
            if j > i:
                d1_hex.append(hex_distance(qi, ri, *positions[j]))

    if not d1_hex:
        print(f"  {label}: no d=1 edges")
        return

    c = Counter(d1_hex)
    total = len(d1_hex)
    at_1 = c.get(1, 0)
    at_2 = sum(c.get(d, 0) for d in [1, 2])
    at_3 = sum(c.get(d, 0) for d in [1, 2, 3])

    print(f"\n  === d=1 Edge Quality {label} ===")
    print(f"  Total d=1 edges: {total}")
    print(f"  d1@hex=1: {at_1} ({at_1/total*100:.1f}%)")
    print(f"  d1@hex≤2: {at_2} ({at_2/total*100:.1f}%)")
    print(f"  d1@hex≤3: {at_3} ({at_3/total*100:.1f}%)")
    print(f"  Mean hex dist: {np.mean(d1_hex):.2f}")
    print(f"  Median hex dist: {np.median(d1_hex):.0f}")

    print(f"  Histogram:")
    for hd in sorted(c.keys())[:20]:
        pct = c[hd] / total * 100
        bar = '#' * int(pct)
        print(f"    hex_dist={hd:2d}: {c[hd]:5d} ({pct:5.1f}%) {bar}")
    if max(c.keys()) > 20:
        tail = sum(c[k] for k in c if k > 20)
        print(f"    hex_dist>20: {tail:5d} ({tail/total*100:.1f}%)")


def simulated_annealing_d1(positions, occupied, adj_d1, n,
                           n_iterations=3_000_000, initial_temp=2.0, cooling=0.999998):
    """
    SA using ONLY d=1 edges. Relocate-only moves.
    Loss = Σ (hex_dist(i,j) - 1)² for d=1 edges only.
    Grid boundary enforced to prevent drift.
    """
    print(f"\n=== SA d=1-only, relocate-only ({n_iterations:,} iterations) ===")

    pos = list(positions)
    occ = dict(occupied)

    # Compute grid boundary from initial placement (with small margin)
    qs = [p[0] for p in pos]
    rs = [p[1] for p in pos]
    q_min, q_max = min(qs) - 5, max(qs) + 5
    r_min, r_max = min(rs) - 5, max(rs) + 5
    print(f"  Grid boundary: q=[{q_min}, {q_max}], r=[{r_min}, {r_max}]")

    # d=1 neighbor lists only
    neighbors = defaultdict(list)
    for i in range(n):
        for j, d in adj_d1.get(i, []):
            if d == 1:
                neighbors[i].append(j)

    # Nodes with d=1 edges (only these participate in SA)
    active_nodes = [i for i in range(n) if neighbors[i]]
    n_active = len(active_nodes)
    print(f"  Active nodes (with d=1 edges): {n_active}/{n}")

    def node_cost(idx):
        qi, ri = pos[idx]
        cost = 0.0
        for j in neighbors[idx]:
            qj, rj = pos[j]
            hd = hex_distance(qi, ri, qj, rj)
            cost += (hd - 1) ** 2
        return cost

    # Initial d=1-only loss
    total_loss = 0.0
    edge_count = 0
    for i in range(n):
        qi, ri = pos[i]
        for j in neighbors[i]:
            if j > i:
                hd = hex_distance(qi, ri, *pos[j])
                total_loss += (hd - 1) ** 2
                edge_count += 1

    current_loss = total_loss
    best_loss = current_loss
    best_pos = list(pos)

    print(f"  Initial d=1 loss: {current_loss:.0f} ({edge_count} edges, "
          f"mean: {current_loss/max(edge_count,1):.2f})")

    temp = initial_temp
    accepted = 0
    improved = 0
    start = time.time()

    for iteration in range(n_iterations):
        temp *= cooling

        # Pick a random ACTIVE node (has d=1 edges)
        i = active_nodes[random.randint(0, n_active - 1)]

        old_q, old_r = pos[i]
        old_cost = node_cost(i)

        # Search radius: mostly 1, sometimes 2
        search_radius = 1 if random.random() < 0.8 else 2
        candidates = hex_ring(old_q, old_r, search_radius)
        # Filter: free AND within boundary
        free = [(cq, cr) for cq, cr in candidates
                if (cq, cr) not in occ
                and q_min <= cq <= q_max and r_min <= cr <= r_max]
        if not free:
            continue
        new_q, new_r = random.choice(free)

        # Apply
        pos[i] = (new_q, new_r)
        del occ[(old_q, old_r)]
        occ[(new_q, new_r)] = i

        new_cost = node_cost(i)
        delta = new_cost - old_cost

        if delta < 0 or random.random() < math.exp(-delta / max(temp, 1e-10)):
            current_loss += delta
            accepted += 1
            if current_loss < best_loss:
                best_loss = current_loss
                best_pos = list(pos)
                improved += 1
        else:
            pos[i] = (old_q, old_r)
            del occ[(new_q, new_r)]
            occ[(old_q, old_r)] = i

        if (iteration + 1) % 500_000 == 0:
            elapsed = time.time() - start
            d1_at_1 = 0
            d1_at_2 = 0
            d1_total = 0
            for ii in active_nodes:
                qi, ri = pos[ii]
                for jj in neighbors[ii]:
                    if jj > ii:
                        hd = hex_distance(qi, ri, *pos[jj])
                        d1_total += 1
                        if hd == 1: d1_at_1 += 1
                        if hd <= 2: d1_at_2 += 1
            print(f"  Iter {iteration+1:,}: loss={current_loss:.0f} "
                  f"best={best_loss:.0f} temp={temp:.4f} "
                  f"d1@1={d1_at_1/max(d1_total,1)*100:.1f}% "
                  f"d1@≤2={d1_at_2/max(d1_total,1)*100:.1f}% "
                  f"acc={accepted} imp={improved} t={elapsed:.1f}s")

    elapsed = time.time() - start
    print(f"\n  Final best loss: {best_loss:.0f} "
          f"(mean/edge: {best_loss/max(edge_count,1):.2f})")
    print(f"  Total time: {elapsed:.1f}s, accepted: {accepted:,}, improved: {improved:,}")

    return best_pos


# ─── Main Pipeline ────────────────────────────────────────────────────────────
def main():
    print("=" * 70)
    print(f"Hex Map Pipeline: {PROGRAM} (4 tuners × 2200 trials)")
    print("=" * 70)

    # Step 1: Load
    trials = load_trials()
    print(f"\nLoaded {len(trials)} trials")
    tuner_counts = Counter(t["tuner"] for t in trials)
    for tuner, count in sorted(tuner_counts.items()):
        print(f"  {tuner}: {count}")

    # Step 3: sym-arg binning (6 levels, 299 separate)
    sym_arg_bin_edges = compute_sym_arg_bins(trials)

    # Step 4: Discretize
    discretized = discretize_trials(trials, sym_arg_bin_edges)
    print(f"\nDiscretized {len(discretized)} trials into {len(SHAP_PARAMS)}-dim tuples")

    # Step 4b: Aggregate into unique combinations
    unique_nodes = aggregate_unique(trials, discretized)
    n_unique = len(unique_nodes)

    # Step 5: Build graph on unique nodes
    print("\n" + "─" * 70)
    adj_d1, _ = build_graph(unique_nodes, max_dist=1)
    comp_d1 = check_connectivity(adj_d1, n_unique, unique_nodes)

    print("\n" + "─" * 70)
    adj_d2, _ = build_graph(unique_nodes, max_dist=2)
    comp_d2 = check_connectivity(adj_d2, n_unique, unique_nodes)

    # Step 7: QAP Hex Grid Placement (weighted: d=1 strong, d=2 soft)
    print("\n" + "─" * 70)
    print("Step 7: Hex Grid Placement (BFS init + d=1-only SA)")

    # BFS-based initial placement: d=1 first, then isolated via d=2
    initial_positions, initial_occupied = bfs_placement(adj_d1, adj_d2, n_unique)

    # Report BFS-only quality
    report_d1_quality(initial_positions, adj_d2, n_unique, label="[BFS only]")

    # Use BFS result directly (SA skipped — BFS already optimizes d=1 adjacency)
    final_positions = initial_positions

    # ─── Save Output ──────────────────────────────────────────────────────────
    output = {
        "program": PROGRAM,
        "tuners": TUNERS,
        "totalTrials": len(trials),
        "shapParams": SHAP_PARAMS,
        "symArgBinEdges": sym_arg_bin_edges.tolist(),
        "symArgLabels": ["<299 Q1", "<299 Q2", "<299 Q3", "<299 Q4", "=299", ">299"],
        "gridRadius": 0,  # computed from node positions
        "nodes": [],
    }

    for i, node in enumerate(unique_nodes):
        q, r = final_positions[i]
        output["nodes"].append({
            "idx": i,
            "q": q,
            "r": r,
            "discrete": list(node["discrete"]),
            "trialCount": node["trialCount"],
            "tunerCounts": node["tunerCounts"],
            "meanCoverage": round(node["meanCoverage"], 1),
            "maxCoverage": node["maxCoverage"],
            "minCoverage": node["minCoverage"],
            "trialIndices": node["trialIndices"],
        })

    out_path = OUTPUT_DIR / f"{PROGRAM}_hex_layout.json"
    with open(out_path, "w") as f:
        json.dump(output, f)
    print(f"\nSaved hex layout to {out_path}")
    print(f"  File size: {out_path.stat().st_size / 1024:.0f} KB")
    print(f"  {len(output['nodes'])} hex nodes")

    # Summary stats
    qs = [p[0] for p in final_positions]
    rs = [p[1] for p in final_positions]
    print(f"  Grid bounds: q=[{min(qs)}, {max(qs)}], r=[{min(rs)}, {max(rs)}]")


if __name__ == "__main__":
    main()
