#!/bin/bash
# Full HPO regeneration pipeline for one task.
# Usage: ./scripts/run_hpo_pipeline.sh <task>     # adult | phoneme

set -e
TASK="${1:-adult}"
PYTHON=/Users/hongdonghee/opt/anaconda3/envs/swt-learning/bin/python

cd "$(dirname "$0")/.."

echo "=== [1/4] preprocess_hpo for $TASK ==="
$PYTHON scripts/preprocess_hpo.py --task "$TASK"

echo ""
echo "=== [2/4] verify complementarity ==="
$PYTHON scripts/verify_hpo_complementarity.py "$TASK"

echo ""
echo "=== [3/4] precompute hexmap (TS) ==="
npx tsx scripts/precompute-hexmap.ts

echo ""
echo "=== [4/4] analyze findings ==="
$PYTHON scripts/analyze_hpo_findings.py --task "$TASK"
