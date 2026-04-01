"""
Compute SHAP importance from *_processed.json files (all 6 tuners).
Outputs public/data/param_importance.json
"""
import json
from pathlib import Path
import numpy as np

DATA_DIR = Path("public/data")
PROGRAMS = ["gawk", "gcal", "grep"]
TUNERS = ["SymTuner", "CMA_ES", "Genetic", "SuccessiveHalving", "TPE", "BayesianOptimization"]

CATEGORICAL_PARAMS = {"search", "switch-type", "smtlib-display-constants", "smtlib-abbreviation-mode", "seed-file"}
BOOLEAN_PARAMS = {
    "disable-inlining", "max-memory-inhibit", "klee-call-optimisation",
    "use-construct-hash-stp", "use-visitor-hash", "equality-substitution",
    "check-overshift", "check-div-zero", "use-branch-cache",
    "use-independent-solver", "use-call-paths", "use-cex-cache",
    "use-forked-solver", "watchdog", "const-array-opt",
    "zero-seed-extension", "warnings-only-to-file", "smtlib-human-readable",
    "warn-all-external-symbols", "use-iterative-deepening-time-search",
    "cex-cache-exp", "all-external-warnings", "readable-posix-inputs",
    "return-null-on-zero-malloc", "emit-all-errors", "solver-optimize-divides",
    "cex-cache-try-all", "simplify-sym-indices", "named-seed-matching",
    "disable-verify", "track-instruction-time", "silent-klee-assume",
    "suppress-external-warnings", "cex-cache-superset", "verify-each",
}


def compute_shap(program: str, tuner: str):
    path = DATA_DIR / f"{program}_{tuner}_processed.json"
    if not path.exists():
        print(f"  Skipping {program}/{tuner}: file not found")
        return None

    with open(path) as f:
        data = json.load(f)

    trials = data["trials"]
    if len(trials) < 10:
        print(f"  Skipping {program}/{tuner}: only {len(trials)} trials")
        return None

    # Collect all param names
    all_params = sorted(trials[0]["parameters"].keys())

    # Detect categorical values per param
    cat_values: dict[str, list] = {}
    for p in all_params:
        if p in CATEGORICAL_PARAMS:
            vals = sorted(set(str(t["parameters"].get(p, "")) for t in trials))
            cat_values[p] = vals

    # Build feature matrix with one-hot encoding for categoricals
    encoded_names: list[str] = []
    param_mapping: dict[str, list[str]] = {}

    for p in all_params:
        if p in cat_values:
            for v in cat_values[p]:
                enc = f"{p}={v}"
                encoded_names.append(enc)
                param_mapping.setdefault(p, []).append(enc)
        else:
            encoded_names.append(p)
            param_mapping[p] = [p]

    n_trials = len(trials)
    n_features = len(encoded_names)
    X = np.zeros((n_trials, n_features), dtype=np.float32)
    y = np.zeros(n_trials, dtype=np.float32)

    enc_idx = {name: i for i, name in enumerate(encoded_names)}

    for i, trial in enumerate(trials):
        y[i] = trial["totalCovered"]
        params = trial["parameters"]
        for p in all_params:
            val = params.get(p)
            if p in cat_values:
                enc = f"{p}={val}"
                if enc in enc_idx:
                    X[i, enc_idx[enc]] = 1.0
            elif val is True or val == 1:
                X[i, enc_idx[p]] = 1.0
            elif val is False or val == 0:
                X[i, enc_idx[p]] = 0.0
            elif val is not None:
                try:
                    X[i, enc_idx[p]] = float(val)
                except (ValueError, TypeError):
                    pass

    # Train model + SHAP
    from sklearn.ensemble import RandomForestRegressor
    import shap

    model = RandomForestRegressor(n_estimators=100, max_depth=10, random_state=42, n_jobs=-1)
    model.fit(X, y)

    explainer = shap.TreeExplainer(model)
    shap_values = explainer.shap_values(X)
    encoded_mean_shap = np.abs(shap_values).mean(axis=0)

    # Aggregate back to original params
    importance = []
    for p in all_params:
        total = sum(encoded_mean_shap[enc_idx[enc]] for enc in param_mapping[p] if enc in enc_idx)
        importance.append({"name": p, "importance": round(float(total), 2)})

    importance.sort(key=lambda x: x["importance"], reverse=True)
    return importance


def main():
    result: dict = {}

    for program in PROGRAMS:
        result[program] = {}
        print(f"\n{'='*50}")
        print(f"Program: {program}")
        print(f"{'='*50}")

        all_params: dict[str, float] = {}
        tuner_count = 0

        for tuner in TUNERS:
            print(f"\n  Computing SHAP for {tuner}...")
            imp = compute_shap(program, tuner)
            if imp is None:
                continue

            result[program][tuner] = imp
            tuner_count += 1

            for p in imp:
                all_params[p["name"]] = all_params.get(p["name"], 0) + p["importance"]

            print(f"  Top 5: {', '.join(p['name'] for p in imp[:5])}")

        # Combined average
        if tuner_count > 0:
            combined = [
                {"name": name, "importance": round(total / tuner_count, 2)}
                for name, total in all_params.items()
            ]
            combined.sort(key=lambda x: x["importance"], reverse=True)
            result[program]["_combined"] = combined

    out_path = DATA_DIR / "param_importance.json"
    with open(out_path, "w") as f:
        json.dump(result, f)

    print(f"\n\nSaved to {out_path}")


if __name__ == "__main__":
    main()
