"""
Run 4 HPO tuners on tabular tasks with XGBoost, save trial logs.

Tuners (all via Optuna for unified API; chosen to span orthogonal search
dynamics — i.i.d. / evolutionary / adaptive-distribution / multi-fidelity):
  - Random            : RandomSampler                                (i.i.d. baseline)
  - Genetic           : NSGAIISampler                                (operator-based EA)
  - CMA_ES            : CmaEsSampler                                 (distribution-based EA)
  - SuccessiveHalving : RandomSampler + SuccessiveHalvingPruner      (multi-fidelity)

Output:
  data_hpo/raw/{task}_{tuner}.json  →  {task, tuner, trials: [{trialId,
                                          parameters, score, elapsed}, ...]}

Run:  python scripts/run_hpo.py [--tasks adult] [--trials 200]
"""

from __future__ import annotations

import argparse
import json
import logging
import time
from pathlib import Path
from typing import Any

import numpy as np
import openml
import optuna
import xgboost as xgb
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder

# Quiet down libraries
optuna.logging.set_verbosity(optuna.logging.WARNING)
logging.getLogger("openml").setLevel(logging.WARNING)


OUT_DIR = Path("data_hpo/raw")
OUT_DIR.mkdir(parents=True, exist_ok=True)


# ============================================================
# Tasks (OpenML dataset IDs) — varied size & difficulty
# ============================================================
TASKS: dict[str, int] = {
    "adult": 1590,        # ~48k rows, 14 features, binary
    "phoneme": 1489,      # ~5.4k rows, 5 features, binary  (small + sensitive)
}


# ============================================================
# Full HP space — 9 numeric HPs (no categoricals so CMA-ES / GP-BO have a
# clean continuous space; otherwise both fall back to Random for categoricals).
# ============================================================
N_ESTIMATORS_MAX = 300  # cap to keep wall-clock reasonable


def suggest_full(trial: optuna.Trial) -> dict[str, Any]:
    return {
        "learning_rate": trial.suggest_float("learning_rate", 1e-3, 0.3, log=True),
        "max_depth": trial.suggest_int("max_depth", 3, 12),
        "n_estimators": trial.suggest_int("n_estimators", 50, N_ESTIMATORS_MAX),
        "min_child_weight": trial.suggest_float("min_child_weight", 1.0, 10.0),
        "subsample": trial.suggest_float("subsample", 0.5, 1.0),
        "colsample_bytree": trial.suggest_float("colsample_bytree", 0.5, 1.0),
        "gamma": trial.suggest_float("gamma", 0.0, 5.0),
        "reg_lambda": trial.suggest_float("reg_lambda", 1e-3, 10.0, log=True),
        "reg_alpha": trial.suggest_float("reg_alpha", 1e-3, 10.0, log=True),
    }


# ============================================================
# Data loading
# ============================================================
TRAIN_CAP = 12_000  # subsample large train sets so HPO trials stay quick


def load_task(name: str, cache: dict | None = None):
    if cache is not None and name in cache:
        return cache[name]
    print(f"  Loading dataset '{name}'...")
    ds_id = TASKS[name]
    ds = openml.datasets.get_dataset(
        ds_id,
        download_data=True,
        download_qualities=False,
        download_features_meta_data=False,
    )
    X, y, _, _ = ds.get_data(target=ds.default_target_attribute)
    # Encode categorical features
    for col in X.columns:
        if X[col].dtype.name in ("category", "object"):
            X[col] = LabelEncoder().fit_transform(X[col].astype(str))
        elif X[col].isnull().any():
            X[col] = X[col].fillna(X[col].median())
    # Encode target
    if y.dtype.name in ("category", "object"):
        y = LabelEncoder().fit_transform(y.astype(str))
    X_arr = X.values.astype(np.float32)
    y_arr = np.asarray(y).astype(np.int32)
    Xtr, Xva, ytr, yva = train_test_split(
        X_arr, y_arr, test_size=0.25, random_state=42,
        stratify=y_arr if len(np.unique(y_arr)) > 1 else None,
    )
    # Cap training set so a single trial fits in a few seconds. Validation
    # stays full so the score is stable.
    if Xtr.shape[0] > TRAIN_CAP:
        rng = np.random.default_rng(42)
        idx = rng.choice(Xtr.shape[0], TRAIN_CAP, replace=False)
        Xtr = Xtr[idx]
        ytr = ytr[idx]
    n_classes = int(np.max(y_arr) + 1)
    print(
        f"    train={Xtr.shape}, val={Xva.shape}, classes={n_classes}"
    )
    out = (Xtr, ytr, Xva, yva, n_classes)
    if cache is not None:
        cache[name] = out
    return out


# ============================================================
# Model evaluation
# ============================================================
def make_model(params: dict[str, Any], n_classes: int, n_estimators: int | None = None):
    n_est = int(n_estimators if n_estimators is not None else params["n_estimators"])
    common = dict(
        learning_rate=float(params["learning_rate"]),
        max_depth=int(params["max_depth"]),
        n_estimators=n_est,
        min_child_weight=float(params["min_child_weight"]),
        subsample=float(params["subsample"]),
        colsample_bytree=float(params["colsample_bytree"]),
        gamma=float(params["gamma"]),
        reg_lambda=float(params["reg_lambda"]),
        reg_alpha=float(params["reg_alpha"]),
        tree_method="hist",
        n_jobs=-1,
        verbosity=0,
    )
    if n_classes <= 2:
        return xgb.XGBClassifier(eval_metric="logloss", **common)
    return xgb.XGBClassifier(
        eval_metric="mlogloss", objective="multi:softprob", num_class=n_classes, **common
    )


def evaluate(params, data, n_estimators: int | None = None) -> tuple[float, float, list[int]]:
    Xtr, ytr, Xva, yva, n_classes = data
    model = make_model(params, n_classes, n_estimators=n_estimators)
    t0 = time.time()
    model.fit(Xtr, ytr)
    y_pred = model.predict(Xva)
    correct = (y_pred == yva)
    score = float(correct.mean())
    correct_idx = np.flatnonzero(correct).astype(int).tolist()
    return score, time.time() - t0, correct_idx


# ============================================================
# Tuner runners
# ============================================================
def run_random(task_name, data, n_trials, seed=42):
    return _run_optuna_basic(
        task_name, data, n_trials, suggest_full,
        sampler=optuna.samplers.RandomSampler(seed=seed),
    )


def run_cmaes(task_name, data, n_trials, seed=42):
    # First n_startup_trials use Random; CMA-ES kicks in after.
    return _run_optuna_basic(
        task_name, data, n_trials, suggest_full,
        sampler=optuna.samplers.CmaEsSampler(seed=seed, n_startup_trials=10),
    )


def run_genetic(task_name, data, n_trials, seed=42):
    # NSGA-II: operator-based GA (mutation + crossover on a population).
    return _run_optuna_basic(
        task_name, data, n_trials, suggest_full,
        sampler=optuna.samplers.NSGAIISampler(
            seed=seed,
            population_size=min(20, n_trials // 4 + 5),
        ),
    )


def run_successive_halving(task_name, data, n_trials, seed=42):
    """SuccessiveHalving: random sampling + budget-based aggressive halving.
    Multi-fidelity (no surrogate). n_estimators is the resource axis: each
    trial fits at budgets [50, 100, 200, 300], reports the score after each,
    and is pruned if the SH bracket says so."""
    sampler = optuna.samplers.RandomSampler(seed=seed)
    pruner = optuna.pruners.SuccessiveHalvingPruner(
        min_resource=50, reduction_factor=3, min_early_stopping_rate=0,
    )
    study = optuna.create_study(direction="maximize", sampler=sampler, pruner=pruner)
    trials_log: list[dict] = []

    def objective(trial: optuna.Trial) -> float:
        params = suggest_full(trial)
        budgets = [50, 100, 200, N_ESTIMATORS_MAX]
        budgets = [b for b in budgets if b <= int(params["n_estimators"])]
        if not budgets:
            budgets = [int(params["n_estimators"])]
        t0 = time.time()
        score = 0.0
        last_b = budgets[-1]
        last_correct: list[int] = []
        for b in budgets:
            score, _, correct_idx = evaluate(params, data, n_estimators=b)
            last_correct = correct_idx
            trial.report(score, step=b)
            if trial.should_prune() and b != budgets[-1]:
                trials_log.append({
                    "trialId": trial.number + 1,
                    "parameters": {**params, "n_estimators": b},
                    "score": score,
                    "elapsed": time.time() - t0,
                    "fidelity": b,
                    "pruned": True,
                    "correctIndices": last_correct,
                })
                raise optuna.TrialPruned()
        elapsed = time.time() - t0
        trials_log.append({
            "trialId": trial.number + 1,
            "parameters": {**params, "n_estimators": last_b},
            "score": score,
            "elapsed": elapsed,
            "fidelity": last_b,
            "pruned": False,
            "correctIndices": last_correct,
        })
        return score

    study.optimize(objective, n_trials=n_trials, catch=(Exception,))
    return trials_log


def _run_optuna_basic(task_name, data, n_trials, suggest_fn, sampler):
    study = optuna.create_study(direction="maximize", sampler=sampler)
    trials_log: list[dict] = []

    def objective(trial: optuna.Trial) -> float:
        params = suggest_fn(trial)
        score, elapsed, correct_idx = evaluate(params, data)
        trials_log.append({
            "trialId": trial.number + 1,
            "parameters": params,
            "score": score,
            "elapsed": elapsed,
            "correctIndices": correct_idx,
        })
        return score

    study.optimize(objective, n_trials=n_trials, catch=(Exception,))
    return trials_log


# ============================================================
# Save
# ============================================================
def save_trials(task: str, tuner: str, trials: list[dict], n_val: int):
    path = OUT_DIR / f"{task}_{tuner}.json"
    payload = {
        "task": task,
        "tuner": tuner,
        "totalTrials": len(trials),
        "nValSamples": int(n_val),
        "trials": trials,
    }
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)
    if trials:
        scores = [t["score"] for t in trials]
        print(f"    → {path}  (best={max(scores):.4f}  mean={np.mean(scores):.4f})")
    else:
        print(f"    → {path}  (no trials)")


# ============================================================
# Main
# ============================================================
TUNER_RUNNERS: dict[str, Any] = {
    "Random": run_random,
    "Genetic": run_genetic,
    "CMA_ES": run_cmaes,
    "SuccessiveHalving": run_successive_halving,
}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--tasks", nargs="+", default=list(TASKS.keys()),
                   choices=list(TASKS.keys()),
                   help="Tasks to run")
    p.add_argument("--tuners", nargs="+", default=list(TUNER_RUNNERS.keys()),
                   choices=list(TUNER_RUNNERS.keys()),
                   help="Tuners to run")
    p.add_argument("--trials", type=int, default=150,
                   help="Trials per (task, tuner)")
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()

    cache: dict = {}
    for task_name in args.tasks:
        print(f"\n{'='*60}")
        print(f"Task: {task_name}")
        print(f"{'='*60}")
        data = load_task(task_name, cache=cache)
        n_val = int(data[3].shape[0])  # yva length
        for tuner in args.tuners:
            print(f"\n  Tuner: {tuner}  (n_trials={args.trials})")
            t0 = time.time()
            trials = TUNER_RUNNERS[tuner](task_name, data, args.trials, seed=args.seed)
            print(f"    done in {time.time() - t0:.1f}s, {len(trials)} trials logged")
            save_trials(task_name, tuner, trials, n_val)


if __name__ == "__main__":
    main()
