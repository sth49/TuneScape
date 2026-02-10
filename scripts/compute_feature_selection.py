"""
Compute feature importance and selection for spectral hex layout.

For each program:
1. Load 4 tuner datasets (processed JSON)
2. Classify parameters (boolean, categorical, numeric)
3. One-hot encode categorical, train XGBoost on totalCovered
4. Gain-based feature importance → aggregate back to original features
5. Select top features (cumulative 85% or top 10)
6. Compute quantile bin edges for numeric features
7. Output feature_selection.json

Run with: python scripts/compute_feature_selection.py

Requirements: xgboost, numpy, pandas
"""

import json
import os
import numpy as np
import pandas as pd
from xgboost import XGBRegressor

# Configuration
PROGRAMS = ['gawk', 'gcal', 'grep']
TUNERS = ['CMA_ES', 'Genetic', 'SuccessiveHalving', 'SymTuner']
INPUT_DIR = 'public/data'
OUTPUT_DIR = 'public/data'

# Parameter type classification (from compute_umap.py)
CATEGORICAL_PARAMS = [
    'search', 'switch-type', 'smtlib-display-constants',
    'smtlib-abbreviation-mode', 'seed-file'
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
    'suppress-external-warnings', 'cex-cache-superset', 'verify-each'
]


def get_param_type(name: str) -> str:
    if name in BOOLEAN_PARAMS:
        return 'boolean'
    elif name in CATEGORICAL_PARAMS:
        return 'categorical'
    else:
        return 'numeric'


def load_program_data(program: str) -> list[dict]:
    """Load all tuner data for a program, return list of trial dicts."""
    all_trials = []
    for tuner in TUNERS:
        path = os.path.join(INPUT_DIR, f'{program}_{tuner}_processed.json')
        with open(path, 'r') as f:
            data = json.load(f)
        for trial in data['trials']:
            all_trials.append(trial)
    return all_trials


def build_features(trials: list[dict], param_names: list[str]):
    """Build feature matrix with one-hot encoding for categoricals.

    Returns:
        X: DataFrame with encoded features
        original_to_encoded: dict mapping original param name -> list of encoded column names
    """
    records = []
    for trial in trials:
        row = {}
        for p in param_names:
            val = trial['parameters'].get(p)
            row[p] = val
        records.append(row)

    df = pd.DataFrame(records)
    original_to_encoded = {}

    # Process each column by type
    encoded_parts = []
    for col in param_names:
        ptype = get_param_type(col)
        if ptype == 'boolean':
            # Convert to 0/1
            series = df[col].apply(lambda v: 1 if v is True or v == 'true' or v == 1 else 0).astype(float)
            encoded_parts.append(series.to_frame(col))
            original_to_encoded[col] = [col]
        elif ptype == 'categorical':
            # One-hot encode
            dummies = pd.get_dummies(df[col].astype(str), prefix=col)
            encoded_parts.append(dummies)
            original_to_encoded[col] = list(dummies.columns)
        else:
            # Numeric
            series = pd.to_numeric(df[col], errors='coerce').fillna(0).astype(float)
            encoded_parts.append(series.to_frame(col))
            original_to_encoded[col] = [col]

    X = pd.concat(encoded_parts, axis=1)
    return X, original_to_encoded


def compute_feature_importance(X: pd.DataFrame, y: np.ndarray, original_to_encoded: dict):
    """Train XGBoost and compute gain-based importance aggregated to original features."""
    model = XGBRegressor(
        n_estimators=200,
        max_depth=6,
        learning_rate=0.1,
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=42,
        n_jobs=-1,
        verbosity=0,
    )
    model.fit(X, y)

    # Gain-based feature importance from XGBoost
    booster = model.get_booster()
    score = booster.get_score(importance_type='gain')

    # Aggregate back to original features using column name mapping
    importance = {}
    for orig, encoded_cols in original_to_encoded.items():
        total = 0.0
        for ec in encoded_cols:
            total += score.get(ec, 0.0)
        importance[orig] = float(total)

    return importance


def select_features(importance: dict, max_features: int = 10, cumulative_threshold: float = 0.85):
    """Select top features by cumulative importance threshold or max count."""
    sorted_feats = sorted(importance.items(), key=lambda x: x[1], reverse=True)
    total = sum(v for _, v in sorted_feats)
    if total == 0:
        return [f for f, _ in sorted_feats[:max_features]]

    selected = []
    cumsum = 0.0
    for feat, imp in sorted_feats:
        selected.append(feat)
        cumsum += imp / total
        if cumsum >= cumulative_threshold or len(selected) >= max_features:
            break

    return selected


def compute_bin_edges(trials: list[dict], param_name: str, n_bins: int = 5) -> list[float]:
    """Compute quantile bin edges for a numeric parameter."""
    values = []
    for trial in trials:
        val = trial['parameters'].get(param_name)
        if val is not None:
            try:
                values.append(float(val))
            except (ValueError, TypeError):
                pass

    if len(values) < n_bins:
        return []

    quantiles = np.linspace(0, 1, n_bins + 1)[1:-1]  # inner edges only
    edges = np.quantile(values, quantiles).tolist()

    # Deduplicate edges
    unique_edges = []
    for e in edges:
        if not unique_edges or abs(e - unique_edges[-1]) > 1e-10:
            unique_edges.append(round(e, 6))

    return unique_edges


def get_categories(trials: list[dict], param_name: str) -> list[str]:
    """Get unique categories for a categorical parameter."""
    cats = set()
    for trial in trials:
        val = trial['parameters'].get(param_name)
        if val is not None:
            cats.add(str(val))
    return sorted(cats)


def process_program(program: str):
    """Process a single program and output feature_selection.json."""
    print(f'\n=== Processing {program} ===')

    # Load data
    trials = load_program_data(program)
    print(f'  Loaded {len(trials)} trials from {len(TUNERS)} tuners')

    # Get parameter names from first trial
    param_names = list(trials[0]['parameters'].keys())
    print(f'  {len(param_names)} parameters')

    # Build features
    X, original_to_encoded = build_features(trials, param_names)
    y = np.array([t['totalCovered'] for t in trials], dtype=float)
    print(f'  Feature matrix: {X.shape}')

    # Compute feature importance
    print('  Training XGBoost + computing importance...')
    importance = compute_feature_importance(X, y, original_to_encoded)

    # Select features
    selected = select_features(importance)
    print(f'  Selected {len(selected)} features:')
    for f in selected:
        print(f'    {f}: {importance[f]:.4f}')

    # Normalize importance for selected features
    total_imp = sum(importance[f] for f in selected)
    normalized_importance = {}
    for f in selected:
        normalized_importance[f] = round(importance[f] / total_imp, 4) if total_imp > 0 else 0

    # Build output
    param_types = {}
    bin_edges = {}
    categories = {}

    for f in selected:
        ptype = get_param_type(f)
        param_types[f] = ptype
        if ptype == 'numeric':
            edges = compute_bin_edges(trials, f)
            if edges:
                bin_edges[f] = edges
        elif ptype == 'categorical':
            cats = get_categories(trials, f)
            categories[f] = cats

    output = {
        'selectedFeatures': selected,
        'importance': normalized_importance,
        'paramTypes': param_types,
        'binEdges': bin_edges,
        'categories': categories,
    }

    output_path = os.path.join(OUTPUT_DIR, f'{program}_feature_selection.json')
    with open(output_path, 'w') as f:
        json.dump(output, f, indent=2)
    print(f'  Saved to {output_path}')


def main():
    for program in PROGRAMS:
        process_program(program)
    print('\n=== Done ===')


if __name__ == '__main__':
    main()
