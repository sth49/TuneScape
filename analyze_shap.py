"""
SHAP Value Analysis for Tuner Comparison
"""
import openpyxl
import ast
import json
from pathlib import Path
import numpy as np

DATA_DIR = Path("data_VIS26/data_VIS26")
TUNERS = ["SymTuner", "CMA_ES", "Genetic", "SuccessiveHalving"]
PROGRAMS = ["gawk", "gcal", "grep"]

# These are OUTPUT values, not parameters - must exclude from SHAP analysis
EXCLUDE_FROM_PARAMS = ["Iteration Coverage", "Accumulative Coverage"]


def load_parameters(xlsx_path):
    """Load parameters from xlsx file (rows=params, cols=trials)

    Excludes output values like 'Iteration Coverage' and 'Accumulative Coverage'
    which are results, not input parameters.
    """
    wb = openpyxl.load_workbook(xlsx_path)
    sheet = wb.active

    # Get parameter names (column A, starting from row 3)
    # Also track which rows to include (excluding output values)
    all_param_names = []
    param_row_indices = []  # Original row indices (0-based from row 3)

    for row in range(3, sheet.max_row + 1):
        val = sheet.cell(row, 1).value
        if val:
            if val not in EXCLUDE_FROM_PARAMS:
                all_param_names.append(val)
                param_row_indices.append(row - 3)  # 0-based index

    # Get trial data (columns B onwards, row 2 has trial numbers)
    n_trials = sheet.max_column - 1
    n_params = len(all_param_names)

    # Create data matrix (trials x params)
    data = np.zeros((n_trials, n_params), dtype=np.float32)

    for col in range(2, sheet.max_column + 1):
        trial_idx = col - 2
        for param_idx, orig_row_idx in enumerate(param_row_indices):
            row = 3 + orig_row_idx
            val = sheet.cell(row, col).value
            if val is True:
                data[trial_idx, param_idx] = 1.0
            elif val is False:
                data[trial_idx, param_idx] = 0.0
            elif val is not None:
                try:
                    data[trial_idx, param_idx] = float(val)
                except:
                    data[trial_idx, param_idx] = 0.0

    return all_param_names, data


def load_coverage(coverage_path):
    """Load coverage sets and calculate coverage counts"""
    with open(coverage_path, 'r') as f:
        lines = f.readlines()

    coverages = []
    for line in lines:
        line = line.strip()
        if line:
            # Parse Python set literal
            coverage_set = ast.literal_eval(line)
            coverages.append(len(coverage_set))

    return np.array(coverages)


def analyze_tuner(program, tuner):
    """Load data and calculate SHAP values for a tuner"""
    base_path = DATA_DIR / program / tuner

    if not base_path.exists():
        return None

    xlsx_path = base_path / "parameters.xlsx"
    coverage_path = base_path / "coverage_set"

    if not xlsx_path.exists() or not coverage_path.exists():
        return None

    print(f"Loading {program}/{tuner}...")

    # Load data
    param_names, X = load_parameters(xlsx_path)
    y = load_coverage(coverage_path)

    print(f"  Parameters: {len(param_names)}, Trials: {len(y)}")
    print(f"  Coverage range: {y.min()} - {y.max()}, mean: {y.mean():.1f}")

    return {
        'param_names': param_names,
        'X': X,
        'y': y,
        'program': program,
        'tuner': tuner
    }


def calculate_shap_values(X, y, param_names):
    """Calculate SHAP values using RandomForest"""
    from sklearn.ensemble import RandomForestRegressor
    import shap

    # Train model
    model = RandomForestRegressor(n_estimators=100, max_depth=10, random_state=42, n_jobs=-1)
    model.fit(X, y)

    # Calculate SHAP values
    explainer = shap.TreeExplainer(model)
    shap_values = explainer.shap_values(X)

    # Get mean absolute SHAP values (feature importance)
    mean_shap = np.abs(shap_values).mean(axis=0)

    # Create sorted importance ranking
    importance = list(zip(param_names, mean_shap))
    importance.sort(key=lambda x: x[1], reverse=True)

    return {
        'shap_values': shap_values,
        'mean_shap': mean_shap,
        'importance': importance,
        'model': model
    }


def analyze_all():
    """Analyze all tuners and save results"""
    results = {}

    for program in PROGRAMS:
        results[program] = {}
        print(f"\n{'='*50}")
        print(f"Program: {program}")
        print('='*50)

        for tuner in TUNERS:
            data = analyze_tuner(program, tuner)
            if data is None:
                continue

            print(f"\n  Calculating SHAP values for {tuner}...")
            shap_result = calculate_shap_values(data['X'], data['y'], data['param_names'])

            print(f"  Top 10 influential parameters:")
            for i, (param, importance) in enumerate(shap_result['importance'][:10]):
                print(f"    {i+1}. {param}: {importance:.2f}")

            results[program][tuner] = {
                'data': data,
                'shap': shap_result
            }

    return results


def export_decision_tree_data(results):
    """Export data in format suitable for Decision Tree visualization"""
    output = {}

    for program in PROGRAMS:
        output[program] = {}

        for tuner in TUNERS:
            if tuner not in results[program]:
                continue

            data = results[program][tuner]['data']
            shap_result = results[program][tuner]['shap']

            # Get parameter info with SHAP importance
            param_info = []
            for param, importance in shap_result['importance']:
                param_idx = data['param_names'].index(param)
                values = data['X'][:, param_idx]
                unique_vals = np.unique(values)

                param_info.append({
                    'name': param,
                    'importance': float(importance),
                    'unique_values': unique_vals.tolist(),
                    'is_boolean': len(unique_vals) == 2 and set(unique_vals) == {0.0, 1.0}
                })

            # Prepare trial data with coverage
            trials = []
            for i in range(len(data['y'])):
                trial_params = {}
                for j, param_name in enumerate(data['param_names']):
                    val = data['X'][i, j]
                    trial_params[param_name] = bool(val) if val in [0.0, 1.0] else float(val)

                trials.append({
                    'trial_id': i + 1,
                    'coverage': int(data['y'][i]),
                    'parameters': trial_params
                })

            output[program][tuner] = {
                'param_importance': param_info,
                'trials': trials,
                'stats': {
                    'total_trials': len(data['y']),
                    'min_coverage': int(data['y'].min()),
                    'max_coverage': int(data['y'].max()),
                    'mean_coverage': float(data['y'].mean())
                }
            }

    return output


if __name__ == "__main__":
    results = analyze_all()

    # Save top parameters summary
    print("\n\n" + "="*60)
    print("SUMMARY: Top 5 Parameters by Tuner")
    print("="*60)

    for program in PROGRAMS:
        print(f"\n{program}:")
        for tuner in TUNERS:
            if tuner in results[program]:
                top5 = results[program][tuner]['shap']['importance'][:5]
                top_names = [p[0] for p in top5]
                print(f"  {tuner}: {', '.join(top_names)}")

    # Export for visualization
    print("\n\nExporting data for visualization...")
    export_data = export_decision_tree_data(results)

    # Save to JSON
    output_path = Path("public/data/decision_tree_data.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, 'w') as f:
        json.dump(export_data, f)

    print(f"Saved to {output_path}")
    print(f"File size: {output_path.stat().st_size / 1024 / 1024:.2f} MB")
