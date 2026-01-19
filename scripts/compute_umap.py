"""
Compute Gower distance matrix and UMAP embedding for parameter space visualization.

Gower distance handles mixed-type data (boolean, numeric, categorical).
UMAP reduces the high-dimensional parameter space to 2D for visualization.

Run with: python scripts/compute_umap.py

Requirements:
    pip install gower umap-learn pandas numpy
"""

import json
import os
import numpy as np
import pandas as pd
import gower
import umap

# Configuration
DATASETS = ['grep', 'gcal', 'gawk']
INPUT_DIR = 'public/data'
OUTPUT_DIR = 'public/data'

# Parameter type classification (based on KLEE options)
# seed-file is categorical (file index: seed1.ktest, seed2.ktest, etc.)
CATEGORICAL_PARAMS = ['search', 'switch-type', 'smtlib-display-constants', 'smtlib-abbreviation-mode', 'seed-file']
BOOLEAN_PARAMS = [
    'disable-inlining',  # added - was missing
    'max-memory-inhibit', 'klee-call-optimisation', 'use-construct-hash-stp',
    'use-visitor-hash', 'equality-substitution', 'check-overshift', 'check-div-zero',
    'use-branch-cache', 'use-independent-solver', 'use-call-paths', 'use-cex-cache',
    'use-forked-solver', 'watchdog', 'const-array-opt', 'zero-seed-extension',
    'warnings-only-to-file', 'smtlib-human-readable', 'warn-all-external-symbols',
    'use-iterative-deepening-time-search', 'cex-cache-exp', 'all-external-warnings',
    'readable-posix-inputs', 'return-null-on-zero-malloc', 'emit-all-errors',
    'solver-optimize-divides', 'cex-cache-try-all', 'simplify-sym-indices',
    'named-seed-matching', 'disable-verify', 'track-instruction-time',
    'silent-klee-assume', 'suppress-external-warnings', 'cex-cache-superset', 'verify-each'
]

def load_data(program: str) -> dict:
    """Load processed trial data."""
    filepath = os.path.join(INPUT_DIR, f'{program}_processed_light.json')
    with open(filepath, 'r') as f:
        return json.load(f)

def prepare_dataframe(data: dict) -> pd.DataFrame:
    """Convert trial parameters to DataFrame with proper dtypes for Gower distance."""
    trials = data['trials']

    # Extract parameters for each trial
    param_records = [trial['parameters'] for trial in trials]
    df = pd.DataFrame(param_records)

    # Convert boolean columns to categorical (required for gower)
    for col in df.columns:
        if col in BOOLEAN_PARAMS:
            df[col] = df[col].astype('category')
        elif col in CATEGORICAL_PARAMS:
            df[col] = df[col].astype('category')
        else:
            # Numeric columns - ensure float type
            df[col] = pd.to_numeric(df[col], errors='coerce')

    return df

def compute_gower_distance(df: pd.DataFrame) -> np.ndarray:
    """Compute Gower distance matrix."""
    print(f"  Computing Gower distance for {len(df)} trials with {len(df.columns)} parameters...")

    # Get categorical column mask (boolean array)
    cat_features = np.array([col in BOOLEAN_PARAMS or col in CATEGORICAL_PARAMS
                             for col in df.columns])

    print(f"  Categorical features: {cat_features.sum()} / {len(cat_features)}")

    # Compute distance matrix
    dist_matrix = gower.gower_matrix(df, cat_features=cat_features)

    print(f"  Distance matrix shape: {dist_matrix.shape}")
    print(f"  Distance range: [{dist_matrix.min():.4f}, {dist_matrix.max():.4f}]")

    return dist_matrix

def compute_umap_embedding(dist_matrix: np.ndarray, n_neighbors: int = 15, min_dist: float = 0.1) -> np.ndarray:
    """Apply UMAP with precomputed distance matrix."""
    print(f"  Computing UMAP embedding (n_neighbors={n_neighbors}, min_dist={min_dist})...")

    reducer = umap.UMAP(
        n_neighbors=n_neighbors,
        min_dist=min_dist,
        metric='precomputed',
        n_components=2,
        random_state=42  # for reproducibility
    )

    embedding = reducer.fit_transform(dist_matrix)

    print(f"  Embedding shape: {embedding.shape}")
    print(f"  X range: [{embedding[:, 0].min():.4f}, {embedding[:, 0].max():.4f}]")
    print(f"  Y range: [{embedding[:, 1].min():.4f}, {embedding[:, 1].max():.4f}]")

    return embedding

def save_embedding(data: dict, embedding: np.ndarray, program: str):
    """Save UMAP embedding to JSON."""
    # Create output with trial ID mapping
    umap_data = {
        'program': program,
        'totalTrials': len(embedding),
        'embedding': [
            {
                'trialId': trial['trialId'],
                'x': float(embedding[i, 0]),
                'y': float(embedding[i, 1]),
                'marginalCoverage': trial['marginalCoverage'],
                'totalCovered': trial['totalCovered']
            }
            for i, trial in enumerate(data['trials'])
        ]
    }

    output_path = os.path.join(OUTPUT_DIR, f'{program}_umap.json')
    with open(output_path, 'w') as f:
        json.dump(umap_data, f, indent=2)

    print(f"  Saved UMAP embedding to: {output_path}")

def analyze_parameters(df: pd.DataFrame):
    """Print parameter statistics."""
    print("\n  Parameter analysis:")

    bool_cols = [c for c in df.columns if c in BOOLEAN_PARAMS]
    cat_cols = [c for c in df.columns if c in CATEGORICAL_PARAMS]
    num_cols = [c for c in df.columns if c not in BOOLEAN_PARAMS and c not in CATEGORICAL_PARAMS]

    print(f"    Boolean: {len(bool_cols)}")
    print(f"    Categorical: {len(cat_cols)}")
    print(f"    Numeric: {len(num_cols)}")

    # Show unique values for categorical
    for col in cat_cols:
        unique = df[col].unique()
        print(f"    {col}: {list(unique)}")

def compute_combined_umap():
    """Compute a single UMAP embedding for all programs combined."""
    print("\n=== Computing Combined UMAP ===")

    all_data = {}
    all_dfs = []
    program_labels = []

    # Load all data
    for program in DATASETS:
        data = load_data(program)
        all_data[program] = data
        df = prepare_dataframe(data)
        all_dfs.append(df)
        program_labels.extend([program] * len(df))
        print(f"  {program}: {len(df)} trials")

    # Combine all DataFrames
    combined_df = pd.concat(all_dfs, ignore_index=True)
    print(f"\n  Combined: {len(combined_df)} trials total")

    # Compute Gower distance for combined data
    dist_matrix = compute_gower_distance(combined_df)

    # Compute UMAP embedding
    embedding = compute_umap_embedding(dist_matrix, n_neighbors=30, min_dist=0.1)

    # Split embedding back by program and save
    idx = 0
    combined_output = {
        'programs': DATASETS,
        'totalTrials': len(combined_df),
        'embeddings': {}
    }

    for program in DATASETS:
        data = all_data[program]
        n_trials = len(data['trials'])
        program_embedding = embedding[idx:idx + n_trials]

        combined_output['embeddings'][program] = [
            {
                'trialId': trial['trialId'],
                'x': float(program_embedding[i, 0]),
                'y': float(program_embedding[i, 1]),
                'marginalCoverage': trial['marginalCoverage'],
                'totalCovered': trial['totalCovered']
            }
            for i, trial in enumerate(data['trials'])
        ]
        idx += n_trials

    # Save combined embedding
    output_path = os.path.join(OUTPUT_DIR, 'combined_umap.json')
    with open(output_path, 'w') as f:
        json.dump(combined_output, f, indent=2)
    print(f"\n  Saved combined UMAP to: {output_path}")


def main():
    # Compute individual UMAPs
    for program in DATASETS:
        print(f"\n=== Processing {program} ===")

        # Load data
        data = load_data(program)
        print(f"  Loaded {len(data['trials'])} trials")

        # Prepare DataFrame
        df = prepare_dataframe(data)
        analyze_parameters(df)

        # Compute Gower distance
        dist_matrix = compute_gower_distance(df)

        # Compute UMAP embedding
        embedding = compute_umap_embedding(dist_matrix)

        # Save results
        save_embedding(data, embedding, program)

    # Compute combined UMAP for all programs
    compute_combined_umap()

    print("\n=== Done ===")

if __name__ == '__main__':
    main()
