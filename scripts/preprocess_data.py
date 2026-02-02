"""
Preprocess raw data from data_VIS26 into JSON format for visualization.

Converts:
- parameters.xlsx (rows=params, cols=trials)
- coverage_set (each line: Python set of branch indices)

Into:
- {program}_{tuner}_processed.json

Run with: python scripts/preprocess_data.py
"""

import ast
import json
import os
from pathlib import Path

import openpyxl

# Configuration
DATA_DIR = Path("data_VIS26/data_VIS26")
OUTPUT_DIR = Path("public/data")
PROGRAMS = ["gawk", "gcal", "grep"]
TUNERS = ["CMA_ES", "Genetic", "SuccessiveHalving", "SymTuner"]

# Output values to exclude from parameters
EXCLUDE_FROM_PARAMS = ["Iteration Coverage", "Accumulative Coverage"]


def load_parameters(xlsx_path: Path) -> tuple[list[str], list[dict]]:
    """
    Load parameters from xlsx file.

    Format: rows=parameters (starting row 3), cols=trials (starting col B)

    Returns:
        param_names: list of parameter names
        trials_params: list of dicts, one per trial
    """
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    sheet = wb.active

    # Read all data into a list first
    all_rows = list(sheet.iter_rows(values_only=True))

    if len(all_rows) < 3:
        wb.close()
        return [], []

    # Get parameter names from column A (starting row 3, index 2)
    param_names = []
    param_indices = []

    for i, row in enumerate(all_rows[2:], start=2):  # Skip first 2 rows
        if row and row[0] and row[0] not in EXCLUDE_FROM_PARAMS:
            param_names.append(row[0])
            param_indices.append(i)

    # Get number of trials (columns B onwards)
    n_trials = len(all_rows[0]) - 1 if all_rows[0] else 0

    # Build trial params
    trials_params = []

    for col_idx in range(1, n_trials + 1):
        params = {}
        for param_name, row_idx in zip(param_names, param_indices):
            if row_idx < len(all_rows) and col_idx < len(all_rows[row_idx]):
                val = all_rows[row_idx][col_idx]
            else:
                val = None

            # Special handling for sym-files: split into sym-files-num and sym-files-size
            if param_name == 'sym-files' and val is not None:
                val_str = str(val).strip()
                parts = val_str.split(' ')
                if len(parts) >= 2:
                    try:
                        params['sym-files-num'] = int(parts[0])
                        params['sym-files-size'] = int(parts[1])
                    except ValueError:
                        params['sym-files-num'] = 0
                        params['sym-files-size'] = 0
                else:
                    params['sym-files-num'] = 0
                    params['sym-files-size'] = 0
                continue

            # Convert to appropriate type
            if val is True or val is False:
                params[param_name] = val
            elif val is None:
                params[param_name] = None
            else:
                # Try numeric conversion
                try:
                    if isinstance(val, str):
                        if val.lower() == 'true':
                            params[param_name] = True
                        elif val.lower() == 'false':
                            params[param_name] = False
                        elif '.' in val:
                            params[param_name] = float(val)
                        else:
                            params[param_name] = int(val)
                    else:
                        params[param_name] = val
                except (ValueError, TypeError):
                    params[param_name] = str(val) if val else None

        trials_params.append(params)

    wb.close()
    return param_names, trials_params


def load_coverage_sets(coverage_path: Path) -> list[set]:
    """
    Load coverage sets from file.
    Each line is a Python set literal: {1, 2, 3, ...}

    Returns:
        List of sets, one per trial
    """
    coverage_sets = []

    with open(coverage_path, 'r') as f:
        for line in f:
            line = line.strip()
            if line:
                coverage_set = ast.literal_eval(line)
                coverage_sets.append(set(coverage_set))

    return coverage_sets


def calculate_coverage_metrics(coverage_sets: list[set]) -> tuple[list[int], list[int], list[int]]:
    """
    Calculate coverage metrics for each trial.

    Returns:
        marginal_coverage: new branches covered by this trial (not seen before)
        cumulative_coverage: total unique branches seen up to this trial
        total_covered: total branches covered by this trial
    """
    marginal_coverage = []
    cumulative_coverage = []
    total_covered = []

    seen_branches = set()

    for coverage_set in coverage_sets:
        # Marginal: branches in this trial not seen before
        new_branches = coverage_set - seen_branches
        marginal_coverage.append(len(new_branches))

        # Update seen branches
        seen_branches.update(coverage_set)

        # Cumulative: total unique branches seen so far
        cumulative_coverage.append(len(seen_branches))

        # Total: branches covered by this trial
        total_covered.append(len(coverage_set))

    return marginal_coverage, cumulative_coverage, total_covered


def count_total_unique_branches(coverage_sets: list[set]) -> int:
    """Count total unique branches across all trials."""
    all_branches = set()
    for cs in coverage_sets:
        all_branches.update(cs)
    return len(all_branches)


def process_tuner(program: str, tuner: str) -> dict | None:
    """Process a single program-tuner combination."""
    base_path = DATA_DIR / program / tuner
    xlsx_path = base_path / "parameters.xlsx"
    coverage_path = base_path / "coverage_set"

    if not xlsx_path.exists() or not coverage_path.exists():
        print(f"  Skipping {program}/{tuner}: missing files")
        return None

    print(f"  Processing {program}/{tuner}...")

    # Load data
    param_names, trials_params = load_parameters(xlsx_path)
    coverage_sets = load_coverage_sets(coverage_path)

    # Validate data
    if len(trials_params) != len(coverage_sets):
        print(f"    Warning: params ({len(trials_params)}) != coverage ({len(coverage_sets)})")
        min_len = min(len(trials_params), len(coverage_sets))
        trials_params = trials_params[:min_len]
        coverage_sets = coverage_sets[:min_len]

    # Calculate metrics
    marginal, cumulative, total = calculate_coverage_metrics(coverage_sets)
    total_unique = count_total_unique_branches(coverage_sets)

    # Build output structure
    trials = []
    for i, (params, m, c, t) in enumerate(zip(trials_params, marginal, cumulative, total)):
        trials.append({
            "trialId": i + 1,
            "marginalCoverage": m,
            "cumulativeCoverage": c,
            "totalCovered": t,
            "parameters": params
        })

    result = {
        "program": program,
        "tuner": tuner,
        "totalTrials": len(trials),
        "totalUniqueBranches": total_unique,
        "trials": trials
    }

    print(f"    Trials: {len(trials)}, Unique branches: {total_unique}")
    print(f"    Coverage range: {min(total)} - {max(total)}")

    return result


def create_light_version(data: dict) -> dict:
    """Create a lighter version without full coverage sets."""
    return data  # Already light, no coverage sets included


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    all_data = {}

    for program in PROGRAMS:
        print(f"\n{'='*50}")
        print(f"Program: {program}")
        print('='*50)

        all_data[program] = {}

        for tuner in TUNERS:
            result = process_tuner(program, tuner)
            if result:
                all_data[program][tuner] = result

                # Save individual file
                output_path = OUTPUT_DIR / f"{program}_{tuner}_processed.json"
                with open(output_path, 'w') as f:
                    json.dump(result, f, indent=2)
                print(f"    Saved: {output_path}")

    # Save combined file for all programs and tuners
    combined_path = OUTPUT_DIR / "all_tuners_processed.json"
    with open(combined_path, 'w') as f:
        json.dump(all_data, f, indent=2)
    print(f"\nSaved combined data: {combined_path}")

    # Summary
    print("\n" + "="*50)
    print("SUMMARY")
    print("="*50)
    for program in PROGRAMS:
        print(f"\n{program}:")
        for tuner in TUNERS:
            if tuner in all_data[program]:
                data = all_data[program][tuner]
                print(f"  {tuner}: {data['totalTrials']} trials, {data['totalUniqueBranches']} branches")


if __name__ == "__main__":
    main()
