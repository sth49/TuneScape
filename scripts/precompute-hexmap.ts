/**
 * Pre-compute HexMap data for 5 independent detail levels (L0–L4).
 *
 * Usage:  npx tsx scripts/precompute-hexmap.ts
 *
 * Outputs: public/data/{program}_hexmap_precomputed.json
 *
 * Each level runs the full processHexMapData pipeline with a different
 * numClusters value, so every level has its own clusters, hexTiles,
 * territories, sub-regions, and labels — enabling uniform feature support
 * across all levels. Trials are shared across levels to minimize file size.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "public", "data");

import {
  processHexMapData,
  buildMergedLevel,
  getTunersForProgram,
  type HexMapData,
  type Trial,
  type HexTile,
  type SubRegion,
  type ParamStats,
  type TunerType,
} from "../src/utils/hexMapUtils.js";
import type { ProcessedData } from "../src/types/data.js";

// ── Level definitions ──
// L4 = finest (full k-means pipeline), L3→L0 = hierarchical merges of the level above
const LEVEL_CLUSTERS = [12, 24, 50, 100, 200]; // L0 → L4

// ── Serialization types (trial-deduplicated) ──

interface SerializedLevel {
  clusters: {
    id: number;
    trialIndices: number[];
    centroid: Record<string, number>;
    tunerCounts: Record<TunerType, number>;
    totalTrials: number;
    avgCoverage: number;
    meanBranchCoverage: number;
    maxBranchCoverage: number;
    meanMarginalCoverage: number;
    coveredBranches: number[];
    tunerCoveredBranches: Partial<Record<TunerType, number[]>>;
    x: number;
    y: number;
    hexQ: number;
    hexR: number;
  }[];
  hexTiles: {
    q: number;
    r: number;
    clusterId: number | null;
    x: number;
    y: number;
  }[];
  territories: {
    id: number;
    clusterIds: number[];
    tileKeys: string[];
    trialIndices: number[];
    totalTrials: number;
    tunerCounts: Record<TunerType, number>;
    centroidX: number;
    centroidY: number;
    pixelCentroidX: number;
    pixelCentroidY: number;
    label: string;
    subRegions: SerializedSubRegion[];
  }[];
  gridRadius: number;
  hexSize: number;
  totalUniqueBranches: number;
  paramImportance: { name: string; importance: number }[];
  paramStats: Record<string, ParamStats>;
  labelParams: string[];
}

interface SerializedSubRegion {
  id: number;
  territoryId: number;
  clusterIds: number[];
  tileKeys: string[];
  trialIndices: number[];
  totalTrials: number;
  tunerCounts: Record<TunerType, number>;
  pixelCentroidX: number;
  pixelCentroidY: number;
  label: string;
  splittable: boolean;
  depth: number;
  children: SerializedSubRegion[];
}

interface PrecomputedMultiLevelJSON {
  trials: Trial[];
  levels: SerializedLevel[]; // index 0 = L0, ... index 4 = L4
}

// ── Helpers ──

function buildTrialIndex(allTrials: Trial[]): Map<string, number> {
  const idx = new Map<string, number>();
  for (let i = 0; i < allTrials.length; i++) {
    idx.set(`${allTrials[i].tuner}:${allTrials[i].id}`, i);
  }
  return idx;
}

function trialIndices(trials: Trial[], idx: Map<string, number>): number[] {
  return trials.map((t) => idx.get(`${t.tuner}:${t.id}`)!);
}

function tileKey(t: HexTile): string {
  return `${t.q},${t.r}`;
}

function serializeLevel(
  data: HexMapData,
  idx: Map<string, number>,
): SerializedLevel {
  const clusters = data.clusters.map((c) => ({
    id: c.id,
    trialIndices: trialIndices(c.trials, idx),
    centroid: c.centroid,
    tunerCounts: c.tunerCounts,
    totalTrials: c.totalTrials,
    avgCoverage: c.avgCoverage,
    meanBranchCoverage: c.meanBranchCoverage,
    maxBranchCoverage: c.maxBranchCoverage,
    meanMarginalCoverage: c.meanMarginalCoverage,
    coveredBranches: c.coveredBranches,
    tunerCoveredBranches: c.tunerCoveredBranches,
    x: c.x,
    y: c.y,
    hexQ: c.hexQ,
    hexR: c.hexR,
  }));

  const hexTiles = data.hexTiles.map((t) => ({
    q: t.q,
    r: t.r,
    clusterId: t.cluster?.id ?? null,
    x: t.x,
    y: t.y,
  }));

  function serSR(sr: SubRegion): SerializedSubRegion {
    return {
      id: sr.id,
      territoryId: sr.territoryId,
      clusterIds: sr.clusters.map((c) => c.id),
      tileKeys: sr.tiles.map(tileKey),
      trialIndices: trialIndices(sr.trials, idx),
      totalTrials: sr.totalTrials,
      tunerCounts: sr.tunerCounts,
      pixelCentroidX: sr.pixelCentroidX,
      pixelCentroidY: sr.pixelCentroidY,
      label: sr.label,
      splittable: sr.splittable,
      depth: sr.depth,
      children: sr.children.map(serSR),
    };
  }

  const territories = data.territories.map((t) => ({
    id: t.id,
    clusterIds: t.clusters.map((c) => c.id),
    tileKeys: t.tiles.map(tileKey),
    trialIndices: trialIndices(t.trials, idx),
    totalTrials: t.totalTrials,
    tunerCounts: t.tunerCounts,
    centroidX: t.centroidX,
    centroidY: t.centroidY,
    pixelCentroidX: t.pixelCentroidX,
    pixelCentroidY: t.pixelCentroidY,
    label: t.label,
    subRegions: t.subRegions.map(serSR),
  }));

  const paramStatsObj: Record<string, ParamStats> = {};
  for (const [k, v] of data.paramStats) paramStatsObj[k] = v;

  return {
    clusters,
    hexTiles,
    territories,
    gridRadius: data.gridRadius,
    hexSize: data.hexSize,
    totalUniqueBranches: data.totalUniqueBranches,
    paramImportance: data.paramImportance,
    paramStats: paramStatsObj,
    labelParams: data.labelParams,
  };
}

// ── Main ──

const PROGRAMS = ["gawk", "gcal", "grep", "adult"] as const;

async function main() {
  const dtPath = path.join(DATA_DIR, "decision_tree_data.json");
  let decisionTreeData: Record<string, any> = {};
  if (fs.existsSync(dtPath)) {
    console.log("Loading decision_tree_data.json ...");
    decisionTreeData = JSON.parse(fs.readFileSync(dtPath, "utf-8"));
  } else {
    console.log("decision_tree_data.json not found, proceeding without SHAP importance.");
  }

  for (const program of PROGRAMS) {
    console.log(`\n=== Processing ${program} ===`);

    // Load tuner data — per-program tuner subset (SE 6 vs HPO 4).
    const programTuners = getTunersForProgram(program);
    const tunerData: ProcessedData[] = [];
    for (const tuner of programTuners) {
      const fpath = path.join(DATA_DIR, `${program}_${tuner}_processed.json`);
      console.log(`  Loading ${tuner} ...`);
      tunerData.push(JSON.parse(fs.readFileSync(fpath, "utf-8")));
    }

    const shapImportance: { name: string; importance: number }[] =
      decisionTreeData[program]?.SymTuner?.param_importance || [];

    // Process L4 with full pipeline, then hierarchically merge L3→L0
    const levelDataArr: HexMapData[] = new Array(LEVEL_CLUSTERS.length);

    // L4: full k-means + MDS pipeline (finest level)
    const l4k = LEVEL_CLUSTERS[LEVEL_CLUSTERS.length - 1];
    console.log(`  L4: processHexMapData (k=${l4k}) — reference level ...`);
    const t0L4 = Date.now();
    levelDataArr[LEVEL_CLUSTERS.length - 1] = processHexMapData(tunerData, shapImportance, l4k);
    console.log(`    done in ${Date.now() - t0L4}ms — ${levelDataArr[4].clusters.length} clusters, ${levelDataArr[4].territories.length} territories`);

    // L3→L0: hierarchical merges of the level above
    for (let li = LEVEL_CLUSTERS.length - 2; li >= 0; li--) {
      const targetK = LEVEL_CLUSTERS[li];
      const parentData = levelDataArr[li + 1];
      console.log(`  L${li}: buildMergedLevel (k=${targetK}) merging L${li + 1} (${parentData.clusters.length} clusters) ...`);
      const t0 = Date.now();
      const data = buildMergedLevel(parentData, targetK, shapImportance);
      console.log(`    done in ${Date.now() - t0}ms — ${data.clusters.length} clusters, ${data.territories.length} territories`);
      levelDataArr[li] = data;
    }

    // Build shared trial list from L4
    const allTrials = levelDataArr[LEVEL_CLUSTERS.length - 1].clusters.flatMap((c) => c.trials);
    const trialIdx = buildTrialIndex(allTrials);

    // Serialize all levels
    const finalLevels: SerializedLevel[] = [];
    for (let li = 0; li < LEVEL_CLUSTERS.length; li++) {
      finalLevels.push(serializeLevel(levelDataArr[li], trialIdx));
    }

    // Strip per-trial coveredBranches to keep file size manageable;
    // coverage vectors are stored at the cluster level instead.
    const trialsForOutput = allTrials.map(({ coveredBranches, ...rest }) => rest);

    const output = {
      trials: trialsForOutput,
      levels: finalLevels,
    };

    const jsonStr = JSON.stringify(output);
    const outPath = path.join(DATA_DIR, `${program}_hexmap_precomputed.json`);
    fs.writeFileSync(outPath, jsonStr);

    const sizeMB = (Buffer.byteLength(jsonStr) / (1024 * 1024)).toFixed(1);
    console.log(`  Written ${outPath} (${sizeMB} MB)`);
    console.log(
      `  Levels: ${finalLevels.map((l, i) => `L${i}(${l.clusters.length})`).join(", ")}`,
    );
  }

  console.log("\nDone!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
