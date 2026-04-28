"""
Hex Map Pipeline: Discretize → Aggregate → MDS Component Layout

All 61 parameters: 35 boolean, 5 categorical, 21 numeric (quantile-binned).
Supports gawk, gcal, grep via CLI argument.
"""

import argparse
import json
import math
import random
import numpy as np
from collections import Counter, defaultdict
from pathlib import Path
import time
from sklearn.manifold import MDS
from scipy.spatial.distance import squareform
from scipy.cluster.hierarchy import linkage, fcluster

# ─── Config ───────────────────────────────────────────────────────────────────
# Default fuzzing tuner set; HPO tasks override via --tuners or auto-detect.
DEFAULT_FUZZING_TUNERS = [
    "SymTuner", "CMA_ES", "Genetic", "SuccessiveHalving", "TPE", "BayesianOptimization",
]
HPO_TUNERS = ["Random", "Grid", "Genetic", "BOHB"]
DATA_DIR = Path(__file__).parent.parent / "public" / "data"
OUTPUT_DIR = Path(__file__).parent.parent / "public" / "data"

CATEGORICAL_PARAMS = [
    'search', 'switch-type', 'smtlib-display-constants',
    'smtlib-abbreviation-mode', 'seed-file',
]

BOOLEAN_PARAMS = [
    'disable-inlining', 'max-memory-inhibit', 'klee-call-optimisation',
    'use-construct-hash-stp', 'use-visitor-hash', 'equality-substitution',
    'check-overshift', 'check-div-zero', 'use-branch-cache',
    'use-independent-solver', 'use-call-paths', 'use-cex-cache',
    'use-forked-solver', 'watchdog', 'const-array-opt',
    'zero-seed-extension', 'warnings-only-to-file', 'smtlib-human-readable',
    'warn-all-external-symbols', 'use-iterative-deepening-time-search',
    'cex-cache-exp', 'all-external-warnings', 'readable-posix-inputs',
    'return-null-on-zero-malloc', 'emit-all-errors', 'solver-optimize-divides',
    'cex-cache-try-all', 'simplify-sym-indices', 'named-seed-matching',
    'disable-verify', 'track-instruction-time', 'silent-klee-assume',
    'suppress-external-warnings', 'cex-cache-superset', 'verify-each',
]

BOOLEAN_SET = set(BOOLEAN_PARAMS)
CATEGORICAL_SET = set(CATEGORICAL_PARAMS)

# Filled in lazily for HPO tasks based on a sample value's runtime type.
AUTO_PARAM_TYPES: dict[str, str] = {}

N_BINS = 5  # quantile bins for numeric parameters

# Module-level state, set by main() before pipeline runs.
TUNERS = DEFAULT_FUZZING_TUNERS


def get_param_type(name):
    if name in BOOLEAN_SET:
        return "boolean"
    if name in CATEGORICAL_SET:
        return "categorical"
    if name in AUTO_PARAM_TYPES:
        return AUTO_PARAM_TYPES[name]
    return "numeric"


def auto_detect_param_types(trials):
    """For HPO tasks: classify each parameter by the Python type of its first
    non-None value across trials. bool→boolean, str→categorical, else numeric.
    """
    AUTO_PARAM_TYPES.clear()
    if not trials:
        return
    seen: set[str] = set()
    for t in trials:
        for k, v in t.get("parameters", {}).items():
            if k in seen or v is None:
                continue
            if isinstance(v, bool):
                AUTO_PARAM_TYPES[k] = "boolean"
            elif isinstance(v, str):
                AUTO_PARAM_TYPES[k] = "categorical"
            else:
                AUTO_PARAM_TYPES[k] = "numeric"
            seen.add(k)


# ─── Step 1: Load Data ───────────────────────────────────────────────────────
def load_trials(program):
    """Load all trials for a given program from 4 tuners."""
    all_trials = []
    for tuner in TUNERS:
        fpath = DATA_DIR / f"{program}_{tuner}_processed.json"
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


# ─── Discover all parameter names ────────────────────────────────────────────
def discover_params(trials):
    """Get sorted list of all parameter names from first trial."""
    return sorted(trials[0]["parameters"].keys())


# ─── Generic numeric binning ────────────────────────────────────────────────
def compute_numeric_bins(trials, param_name, n_bins=N_BINS):
    """Compute quantile-based bin edges for a numeric parameter."""
    values = [t["parameters"][param_name] for t in trials]
    quantiles = np.linspace(0, 1, n_bins + 1)
    edges = np.quantile(values, quantiles)
    edges = np.unique(edges)
    return edges


def discretize_numeric(value, bin_edges):
    """Return bin index (0 to len(bin_edges)-2) for a numeric value."""
    idx = int(np.searchsorted(bin_edges[1:], value, side='right'))
    return min(idx, len(bin_edges) - 2)


def make_bin_labels(bin_edges):
    """Generate human-readable labels like '0.0-113.0'."""
    labels = []
    for i in range(len(bin_edges) - 1):
        lo = bin_edges[i]
        hi = bin_edges[i + 1]
        # Format nicely: use int if values are whole numbers
        if lo == int(lo) and hi == int(hi):
            labels.append(f"{int(lo)}-{int(hi)}")
        else:
            labels.append(f"{lo:.1f}-{hi:.1f}")
    return labels


# ─── Discretize All Trials ───────────────────────────────────────────────────
def discretize_trials(trials, all_params, numeric_bin_edges):
    """Convert each trial's parameters into a discrete tuple."""
    discretized = []
    for t in trials:
        params = t["parameters"]
        disc = []
        for p in all_params:
            val = params[p]
            ptype = get_param_type(p)
            if ptype == "boolean":
                disc.append(int(val))
            elif ptype == "categorical":
                disc.append(val)
            else:  # numeric
                disc.append(discretize_numeric(val, numeric_bin_edges[p]))
        discretized.append(tuple(disc))
    return discretized


# ─── Aggregate into unique combinations ──────────────────────────────────────
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
        marginals = [trials[i]["marginalCoverage"] for i in trial_indices]
        failure_count = sum(1 for c in coverages if c == 0)
        n = len(trial_indices)
        iqr = (float(np.percentile(coverages, 75) - np.percentile(coverages, 25))
               if n >= 2 else 0.0)
        unique_nodes.append({
            "discrete": combo,
            "trialCount": n,
            "trialIndices": trial_indices,
            "tunerCounts": dict(tuner_counts),
            "meanCoverage": float(np.mean(coverages)),
            "maxCoverage": max(coverages),
            "minCoverage": min(coverages),
            "meanMarginalCoverage": float(np.mean(marginals)),
            "failureRate": round(failure_count / n, 4),
            "coverageIqr": round(iqr, 2),
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


# ─── Hamming Distance ─────────────────────────────────────────────────────────
def hamming_distance(a, b):
    """Count number of differing parameters between two discrete tuples."""
    return sum(1 for x, y in zip(a, b) if x != y)


def compute_hamming_matrix(unique_nodes):
    """Vectorized n×n Hamming distance matrix + d=1 adjacency list."""
    n = len(unique_nodes)
    combos = [node["discrete"] for node in unique_nodes]
    n_params = len(combos[0])

    # Encode mixed-type tuples to int16 numpy array
    col_maps = []
    for col in range(n_params):
        vals = sorted(set(combos[i][col] for i in range(n)), key=str)
        val_to_int = {v: idx for idx, v in enumerate(vals)}
        col_maps.append(val_to_int)

    encoded = np.empty((n, n_params), dtype=np.int16)
    for i, combo in enumerate(combos):
        for col in range(n_params):
            encoded[i, col] = col_maps[col][combo[col]]

    print(f"\n=== Computing Hamming Distance Matrix (n={n}) ===")
    start = time.time()

    # Chunked broadcast: avoid allocating (n, n, n_params) all at once
    dist_matrix = np.zeros((n, n), dtype=np.int16)
    chunk_size = 500
    for i_start in range(0, n, chunk_size):
        i_end = min(i_start + chunk_size, n)
        diff = encoded[i_start:i_end, np.newaxis, :] != encoded[np.newaxis, :, :]
        dist_matrix[i_start:i_end, :] = diff.sum(axis=2).astype(np.int16)
        if i_start > 0 and i_start % 2000 == 0:
            elapsed = time.time() - start
            print(f"  Processed {i_start}/{n} rows ({elapsed:.1f}s)")

    elapsed = time.time() - start
    print(f"  Hamming matrix computed in {elapsed:.1f}s")

    # Extract d=1 adjacency list
    adj_d1 = defaultdict(list)
    rows, cols = np.where(dist_matrix == 1)
    mask = rows < cols
    for i, j in zip(rows[mask], cols[mask]):
        adj_d1[int(i)].append((int(j), 1))
        adj_d1[int(j)].append((int(i), 1))

    n_d1_edges = int(mask.sum())
    print(f"  d=1 edges: {n_d1_edges}")

    return dist_matrix, adj_d1


# ─── Component Extraction ────────────────────────────────────────────────────
def find_d1_components(adj_d1, n):
    """Extract connected components from d=1 graph."""
    d1_nb = defaultdict(list)
    for i in range(n):
        for j, d in adj_d1.get(i, []):
            d1_nb[i].append(j)

    d1_degree = [len(d1_nb[i]) for i in range(n)]

    visited = [False] * n
    components = []
    singletons = []

    for start in range(n):
        if visited[start]:
            continue
        if d1_degree[start] == 0:
            singletons.append(start)
            visited[start] = True
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

    print(f"\n=== d=1 Connected Components ===")
    print(f"  Multi-node components: {len(components)}")
    if components:
        sizes = [len(c) for c in components]
        print(f"  Largest: {sizes[0]}, sizes: {sizes[:10]}{'...' if len(sizes) > 10 else ''}")
    print(f"  Singletons (no d=1 edges): {len(singletons)}")

    return components, singletons, d1_nb, d1_degree


# ─── BFS Layout for a Single Component ───────────────────────────────────────
def bfs_component_layout(component, d1_nb, d1_degree):
    """BFS-place a single multi-node component as a compact hex cluster.
    Returns offsets relative to (0,0) and seed index."""
    seed = max(component, key=lambda i: d1_degree[i])
    comp_set = set(component)

    offsets = {}
    local_occupied = {}

    offsets[seed] = (0, 0)
    local_occupied[(0, 0)] = seed

    bfs_q = [seed]
    bfs_visited = {seed}

    while bfs_q:
        current = bfs_q.pop(0)
        cq, cr = offsets[current]

        unplaced = [nb for nb in d1_nb[current] if nb in comp_set and nb not in bfs_visited]
        unplaced.sort(key=lambda x: d1_degree[x], reverse=True)

        for nb in unplaced:
            if nb in offsets:
                bfs_visited.add(nb)
                continue

            adj_hexes = hex_neighbors(cq, cr)
            random.shuffle(adj_hexes)
            placed = False
            for aq, ar in adj_hexes:
                if (aq, ar) not in local_occupied:
                    offsets[nb] = (aq, ar)
                    local_occupied[(aq, ar)] = nb
                    placed = True
                    break

            if not placed:
                for rad in range(1, 50):
                    ring = hex_ring(cq, cr, rad)
                    random.shuffle(ring)
                    for hq, hr in ring:
                        if (hq, hr) not in local_occupied:
                            offsets[nb] = (hq, hr)
                            local_occupied[(hq, hr)] = nb
                            placed = True
                            break
                    if placed:
                        break

            bfs_visited.add(nb)
            bfs_q.append(nb)

    return offsets, seed


# ─── Hex Grid Geometry ───────────────────────────────────────────────────────

def hex_distance(q1, r1, q2, r2):
    """Axial hex distance."""
    return (abs(q1 - q2) + abs(q1 + r1 - q2 - r2) + abs(r1 - r2)) // 2


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
    cq, cr = q + radius, r - radius  # start corner
    dirs = [(-1, 1), (-1, 0), (0, -1), (1, -1), (1, 0), (0, 1)]
    for dq, dr in dirs:
        for _ in range(radius):
            results.append((cq, cr))
            cq += dq
            cr += dr
    return results


# ─── Connectivity Check ──────────────────────────────────────────────────────
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
    print(f"  Components >=10 nodes: {sum(1 for s in sizes if s >= 10)}")
    print(f"  Largest component: {sizes[0]} nodes ({sizes[0]/n*100:.1f}% of unique combos)")

    return components


# ─── Quality Reporter ─────────────────────────────────────────────────────────

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
    print(f"  d1@hex<=2: {at_2} ({at_2/total*100:.1f}%)")
    print(f"  d1@hex<=3: {at_3} ({at_3/total*100:.1f}%)")
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


# ─── Find Nearest Free Hex ───────────────────────────────────────────────────

def find_nearest_free(tq, tr, occupied, max_search=250):
    """Find the nearest unoccupied hex position to (tq, tr)."""
    if (tq, tr) not in occupied:
        return (tq, tr)
    for rad in range(1, max_search):
        ring = hex_ring(tq, tr, rad)
        random.shuffle(ring)
        for hq, hr in ring:
            if (hq, hr) not in occupied:
                return (hq, hr)
    return None


# ─── MDS-Based Hex Placement ─────────────────────────────────────────────────

def mds_placement(unique_nodes, n):
    """
    Component-based MDS hex placement:
    1. Vectorized Hamming matrix + d=1 adjacency
    2. Extract d=1 connected components
    3. BFS each component → compact hex cluster
    4. MDS on inter-component distances → 2D centers
    5. Place components at MDS centers, singletons at MDS positions
    """
    print("\n=== MDS-Based Hex Placement ===")

    # Step 1: Hamming matrix
    dist_matrix, adj_d1 = compute_hamming_matrix(unique_nodes)

    # Step 2: Find components
    components, singletons, d1_nb, d1_degree = find_d1_components(adj_d1, n)

    # Step 3: BFS layouts for multi-node components
    start = time.time()
    comp_layouts = []
    for comp in components:
        offsets, seed = bfs_component_layout(comp, d1_nb, d1_degree)
        comp_layouts.append((comp, offsets, seed))
    elapsed = time.time() - start
    print(f"\n  BFS layouts for {len(components)} components in {elapsed:.2f}s")

    # Step 4: Component distance matrix
    n_comp = len(components)
    n_sing = len(singletons)
    m = n_comp + n_sing
    print(f"\n=== Component Distance Matrix ({m} entries: {n_comp} multi-node + {n_sing} singletons) ===")

    start = time.time()
    comp_dist = np.zeros((m, m), dtype=np.float64)

    # Singleton-to-singleton block: direct submatrix extraction
    if singletons:
        sing_arr = np.array(singletons)
        comp_dist[n_comp:, n_comp:] = dist_matrix[np.ix_(sing_arr, sing_arr)]

    # Multi-node component rows/columns
    for i in range(n_comp):
        members_i = np.array(components[i])
        # Min distance from component i to every individual node
        row_mins = dist_matrix[members_i, :].min(axis=0)  # (n,)

        # To other multi-node components (only upper triangle)
        for j in range(i + 1, n_comp):
            members_j = np.array(components[j])
            d = float(row_mins[members_j].min())
            comp_dist[i, j] = d
            comp_dist[j, i] = d

        # To singletons
        if singletons:
            comp_dist[i, n_comp:] = row_mins[sing_arr].astype(np.float64)
            comp_dist[n_comp:, i] = comp_dist[i, n_comp:]

    elapsed = time.time() - start
    print(f"  Component distance matrix computed in {elapsed:.1f}s")

    # Step 5: MDS
    print(f"\n=== MDS (SMACOF, {m} components) ===")
    start = time.time()
    mds = MDS(n_components=2, metric=True, dissimilarity='precomputed',
              max_iter=100, n_init=1, random_state=42)
    coords_2d = mds.fit_transform(comp_dist)
    elapsed = time.time() - start
    print(f"  MDS completed in {elapsed:.1f}s (stress={mds.stress_:.2f})")

    # Step 6: Scale to hex grid
    target_radius = int(math.sqrt(n) * 1.2)
    max_abs = max(np.abs(coords_2d).max(), 1e-10)
    scaled = coords_2d / max_abs * target_radius
    hex_centers = [(int(round(x)), int(round(y))) for x, y in scaled]

    print(f"  Target radius: {target_radius}")
    print(f"  MDS coord range: [{coords_2d.min():.1f}, {coords_2d.max():.1f}]")

    # Step 7 & 8: Place on hex grid
    positions = [None] * n
    occupied = {}

    def place(node, q, r):
        positions[node] = (q, r)
        occupied[(q, r)] = node

    # Place multi-node components first (largest first, already sorted)
    start = time.time()
    for comp_idx, (comp, offsets, seed) in enumerate(comp_layouts):
        center_q, center_r = hex_centers[comp_idx]

        # Place nodes sorted by offset distance from component origin (seed first)
        nodes_by_offset = sorted(offsets.items(),
                                 key=lambda x: abs(x[1][0]) + abs(x[1][1]))
        for node, (dq, dr) in nodes_by_offset:
            target_q = center_q + dq
            target_r = center_r + dr
            fq, fr = find_nearest_free(target_q, target_r, occupied)
            place(node, fq, fr)

    multi_placed = sum(1 for p in positions if p is not None)
    print(f"\n  Placed {multi_placed} multi-node component nodes")

    # Place singletons at their MDS-derived positions (center-outward order)
    singleton_entries = []
    for s_idx, singleton in enumerate(singletons):
        comp_mds_idx = n_comp + s_idx
        cq, cr = hex_centers[comp_mds_idx]
        dist_from_center = abs(cq) + abs(cr)
        singleton_entries.append((singleton, cq, cr, dist_from_center))

    singleton_entries.sort(key=lambda x: x[3])

    for node, cq, cr, _ in singleton_entries:
        fq, fr = find_nearest_free(cq, cr, occupied)
        place(node, fq, fr)

    elapsed = time.time() - start
    placed_count = sum(1 for p in positions if p is not None)
    print(f"  Total placed: {placed_count}/{n} in {elapsed:.1f}s")

    qs = [p[0] for p in positions if p is not None]
    rs = [p[1] for p in positions if p is not None]
    print(f"  Grid bounds: q=[{min(qs)}, {max(qs)}], r=[{min(rs)}, {max(rs)}]")
    print(f"  Span: {max(qs)-min(qs)} x {max(rs)-min(rs)}")

    return positions, occupied, adj_d1, dist_matrix


# ─── Precomputed LoD Levels ───────────────────────────────────────────────────

def compute_lod_levels(unique_nodes, positions, dist_matrix, n, n_levels=10):
    """
    Precompute hierarchical LoD levels using agglomerative clustering.
    Returns list of dicts: {nClusters, assignments, positions}.
    """
    print(f"\n=== Computing LoD Levels ({n_levels} levels) ===")
    start = time.time()

    # Convert to condensed distance matrix for scipy
    condensed = squareform(dist_matrix.astype(np.float64))
    t_sq = time.time() - start
    print(f"  squareform: {t_sq:.2f}s (condensed length={len(condensed)})")

    # Agglomerative clustering
    t0 = time.time()
    Z = linkage(condensed, method='average')
    t_link = time.time() - t0
    print(f"  linkage(average): {t_link:.2f}s")

    # Trial counts for weighted centroids
    trial_counts = np.array([node["trialCount"] for node in unique_nodes], dtype=np.float64)

    lod_levels = []
    for level in range(1, n_levels + 1):
        n_clusters = max(30, int(n * (0.55 ** level)))
        n_clusters = min(n_clusters, n)  # can't have more clusters than nodes

        labels = fcluster(Z, t=n_clusters, criterion='maxclust')
        # fcluster labels start at 1; shift to 0-based
        labels = labels - 1
        actual_k = int(labels.max()) + 1

        # Compute weighted centroid positions per cluster
        cluster_positions = []
        cluster_occupied = {}

        # Sort clusters by total trial count descending (larger clusters placed first)
        cluster_sizes = []
        for c in range(actual_k):
            mask = (labels == c)
            total_trials = float(trial_counts[mask].sum())
            cluster_sizes.append((c, total_trials))
        cluster_sizes.sort(key=lambda x: x[1], reverse=True)

        # First pass: compute ideal centroid positions (float, original scale)
        raw_centroids = {}
        for c in range(actual_k):
            mask = (labels == c)
            weights = trial_counts[mask]
            q_vals = np.array([positions[i][0] for i in range(n) if mask[i]], dtype=np.float64)
            r_vals = np.array([positions[i][1] for i in range(n) if mask[i]], dtype=np.float64)
            raw_centroids[c] = (
                float(np.average(q_vals, weights=weights)),
                float(np.average(r_vals, weights=weights)),
            )

        # Rescale to compact grid: target radius ~ sqrt(actual_k) * 1.2
        target_radius = max(3, int(math.sqrt(actual_k) * 1.2))
        all_q = np.array([raw_centroids[c][0] for c in range(actual_k)])
        all_r = np.array([raw_centroids[c][1] for c in range(actual_k)])
        max_abs = max(np.abs(all_q).max(), np.abs(all_r).max(), 1e-10)
        scale = target_radius / max_abs

        ideal_positions = {}
        for c in range(actual_k):
            cq = int(round(raw_centroids[c][0] * scale))
            cr = int(round(raw_centroids[c][1] * scale))
            ideal_positions[c] = (cq, cr)

        # Second pass: place with collision handling (largest clusters first)
        final_cluster_pos = [None] * actual_k
        for c, _ in cluster_sizes:
            tq, tr = ideal_positions[c]
            fq, fr = find_nearest_free(tq, tr, cluster_occupied)
            if fq is not None:
                final_cluster_pos[c] = (fq, fr)
                cluster_occupied[(fq, fr)] = c
            else:
                # Fallback: use ideal position
                final_cluster_pos[c] = (tq, tr)

        lod_levels.append({
            "nClusters": actual_k,
            "assignments": labels.tolist(),
            "positions": [list(p) for p in final_cluster_pos],
        })

        print(f"  Level {level}: n_clusters={actual_k}, target={n_clusters}")

    elapsed = time.time() - start
    print(f"  Total LoD computation: {elapsed:.2f}s")

    return lod_levels


# ─── Main Pipeline ────────────────────────────────────────────────────────────
def run_pipeline(program):
    print("=" * 70)
    print(f"Hex Map Pipeline: {program} (4 tuners x 2200 trials)")
    print("=" * 70)

    # Step 1: Load
    trials = load_trials(program)
    print(f"\nLoaded {len(trials)} trials")
    tuner_counts = Counter(t["tuner"] for t in trials)
    for tuner, count in sorted(tuner_counts.items()):
        print(f"  {tuner}: {count}")

    # Discover all parameters
    all_params = discover_params(trials)
    n_params = len(all_params)
    n_bool = sum(1 for p in all_params if get_param_type(p) == "boolean")
    n_cat = sum(1 for p in all_params if get_param_type(p) == "categorical")
    n_num = sum(1 for p in all_params if get_param_type(p) == "numeric")
    print(f"\n=== Parameters ({n_params} total) ===")
    print(f"  Boolean: {n_bool}, Categorical: {n_cat}, Numeric: {n_num}")

    # Compute numeric bin edges
    numeric_bin_edges = {}
    param_meta = {}
    for p in all_params:
        ptype = get_param_type(p)
        if ptype == "boolean":
            param_meta[p] = {"type": "boolean"}
        elif ptype == "categorical":
            cats = sorted(set(str(t["parameters"][p]) for t in trials))
            param_meta[p] = {"type": "categorical", "categories": cats}
        else:
            edges = compute_numeric_bins(trials, p, N_BINS)
            numeric_bin_edges[p] = edges
            labels = make_bin_labels(edges)
            param_meta[p] = {
                "type": "numeric",
                "binEdges": edges.tolist(),
                "binLabels": labels,
            }
            print(f"  {p}: {len(labels)} bins -> {labels}")

    # Discretize
    discretized = discretize_trials(trials, all_params, numeric_bin_edges)
    print(f"\nDiscretized {len(discretized)} trials into {n_params}-dim tuples")

    # Aggregate into unique combinations
    unique_nodes = aggregate_unique(trials, discretized)
    n_unique = len(unique_nodes)

    # MDS-based hex grid placement
    print("\n" + "-" * 70)
    print("Step: MDS-based Hex Grid Placement")
    final_positions, occupied, adj_d1, dist_matrix = mds_placement(unique_nodes, n_unique)

    # Diagnostics
    check_connectivity(adj_d1, n_unique, unique_nodes)
    report_d1_quality(final_positions, adj_d1, n_unique, label="[MDS placement]")

    # Precompute LoD levels
    lod_levels = compute_lod_levels(unique_nodes, final_positions, dist_matrix, n_unique)

    # ─── Save Output ──────────────────────────────────────────────────────────
    output = {
        "program": program,
        "tuners": TUNERS,
        "totalTrials": len(trials),
        "allParams": all_params,
        "paramMeta": param_meta,
        "gridRadius": 0,
        "nodes": [],
        "lodLevels": lod_levels,
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
            "meanMarginalCoverage": round(node["meanMarginalCoverage"], 2),
            "failureRate": node["failureRate"],
            "coverageIqr": node["coverageIqr"],
            "trialIndices": node["trialIndices"],
        })

    out_path = OUTPUT_DIR / f"{program}_hex_layout.json"
    with open(out_path, "w") as f:
        json.dump(output, f)
    print(f"\nSaved hex layout to {out_path}")
    print(f"  File size: {out_path.stat().st_size / 1024:.0f} KB")
    print(f"  {len(output['nodes'])} hex nodes")

    # Summary stats
    qs = [p[0] for p in final_positions]
    rs = [p[1] for p in final_positions]
    print(f"  Grid bounds: q=[{min(qs)}, {max(qs)}], r=[{min(rs)}, {max(rs)}]")


HPO_TASKS = {"adult", "phoneme", "covertype"}


def configure_for(program: str):
    """Switch TUNERS list + reset auto param types based on program.
    Fuzzing programs use the 6-tuner default with hardcoded param sets.
    HPO tasks (adult/phoneme/covertype) use 4 HPO tuners and auto-detected types.
    """
    global TUNERS
    if program in HPO_TASKS:
        TUNERS = list(HPO_TUNERS)
        AUTO_PARAM_TYPES.clear()
        # Peek at one tuner file to seed AUTO_PARAM_TYPES from real values.
        for tuner in TUNERS:
            fp = DATA_DIR / f"{program}_{tuner}_processed.json"
            if fp.exists():
                with open(fp) as f:
                    sample = json.load(f)
                auto_detect_param_types(sample.get("trials", [])[:5])
                break
    else:
        TUNERS = list(DEFAULT_FUZZING_TUNERS)
        AUTO_PARAM_TYPES.clear()


def main():
    parser = argparse.ArgumentParser(description="Build hex layout for parameter visualization")
    parser.add_argument("--program", type=str, default=None,
                        help="Program/task to process. Fuzzing: gawk/gcal/grep. "
                             "HPO: adult/phoneme/covertype. Omit = all fuzzing programs.")
    args = parser.parse_args()

    if args.program:
        configure_for(args.program)
        run_pipeline(args.program)
    else:
        for prog in ["gawk", "gcal", "grep"]:
            configure_for(prog)
            run_pipeline(prog)
            print("\n\n")


if __name__ == "__main__":
    main()
