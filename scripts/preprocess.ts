/**
 * Data preprocessing script for SymTuner visualization
 * Converts raw experiment data into visualization-ready JSON
 *
 * Run with: npx ts-node --esm src/data/preprocess.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TrialData {
  trialId: number;
  coveredBranches: number[];
  marginalCoverage: number;  // new branches discovered in this trial
  cumulativeCoverage: number;  // total unique branches up to this trial
  parameters: Record<string, string | boolean | number>;
}

interface ProcessedData {
  program: string;
  tuner: string;
  totalTrials: number;
  totalUniqueBranches: number;
  trials: TrialData[];
  parameters: string[];  // list of parameter names
  branchIndices?: Record<string, string>;  // branch ID -> source location
}

function parseCoveredBranches(line: string): number[] {
  // Format: {2049, 2, 3, 4, 2053, ...}
  const content = line.trim().slice(1, -1);  // remove { }
  if (!content) return [];
  return content.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}

// Parameters that should be treated as categorical (not numeric)
const CATEGORICAL_PARAMS = new Set([
  'search', 'switch-type', 'smtlib-display-constants', 'smtlib-abbreviation-mode',
  'seed-file'  // seed-file is categorical (file index like seed1.ktest, seed2.ktest, etc.)
]);

function parseParametersCsv(csvPath: string): { paramNames: string[]; trialParams: Record<string, string | boolean | number>[] } {
  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.trim().split('\n');

  // CSV has no header - first line is already a parameter row
  // Determine number of trials from first line
  const firstLineParts = lines[0].split(',');
  const numTrials = firstLineParts.length - 1;  // first column is parameter name

  // Initialize trial parameters
  const trialParams: Record<string, string | boolean | number>[] = [];
  for (let i = 0; i < numTrials; i++) {
    trialParams.push({});
  }

  const paramNames: string[] = [];

  // Parse each parameter row (starting from line 0, not 1)
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const paramName = parts[0].trim();

    // Skip empty or metadata rows
    if (!paramName || paramName === 'ter_cov' || paramName === 'otal_cov') continue;

    // Special handling for sym-files: split into sym-files-num and sym-files-size
    if (paramName === 'sym-files') {
      paramNames.push('sym-files-num');
      paramNames.push('sym-files-size');

      for (let j = 1; j < parts.length && j <= numTrials; j++) {
        const value = parts[j]?.trim();
        // Format: "NUM SIZE" (e.g., "1 8", "2 23")
        const [numPart, sizePart] = value.split(' ');
        trialParams[j - 1]['sym-files-num'] = parseInt(numPart, 10) || 0;
        trialParams[j - 1]['sym-files-size'] = parseInt(sizePart, 10) || 0;
      }
      continue;
    }

    paramNames.push(paramName);

    for (let j = 1; j < parts.length && j <= numTrials; j++) {
      const value = parts[j]?.trim();
      if (value === 'TRUE') {
        trialParams[j - 1][paramName] = true;
      } else if (value === 'FALSE') {
        trialParams[j - 1][paramName] = false;
      } else if (CATEGORICAL_PARAMS.has(paramName)) {
        // Keep categorical parameters as strings
        trialParams[j - 1][paramName] = value || '';
      } else if (!isNaN(parseFloat(value))) {
        trialParams[j - 1][paramName] = parseFloat(value);
      } else {
        trialParams[j - 1][paramName] = value || '';
      }
    }
  }

  return { paramNames, trialParams };
}

function processData(
  program: string,
  tuner: string,
  coveredBranchesPath: string,
  parametersPath: string,
  branchIndicesPath?: string
): ProcessedData {
  console.log(`Processing ${program} data...`);

  // Load covered branches
  const branchesContent = fs.readFileSync(coveredBranchesPath, 'utf-8');
  const branchLines = branchesContent.trim().split('\n');

  // Load parameters
  const { paramNames, trialParams } = parseParametersCsv(parametersPath);

  // Load branch indices if available
  let branchIndices: Record<string, string> | undefined;
  if (branchIndicesPath && fs.existsSync(branchIndicesPath)) {
    branchIndices = JSON.parse(fs.readFileSync(branchIndicesPath, 'utf-8'));
  }

  // Process trials and calculate marginal coverage
  const trials: TrialData[] = [];
  const allCoveredBranches = new Set<number>();

  for (let i = 0; i < branchLines.length; i++) {
    const coveredBranches = parseCoveredBranches(branchLines[i]);

    // Calculate marginal coverage (new branches in this trial)
    const newBranches: number[] = [];
    for (const branch of coveredBranches) {
      if (!allCoveredBranches.has(branch)) {
        newBranches.push(branch);
        allCoveredBranches.add(branch);
      }
    }

    trials.push({
      trialId: i + 1,
      coveredBranches,
      marginalCoverage: newBranches.length,
      cumulativeCoverage: allCoveredBranches.size,
      parameters: trialParams[i] || {}
    });
  }

  console.log(`  Total trials: ${trials.length}`);
  console.log(`  Total unique branches: ${allCoveredBranches.size}`);
  console.log(`  Parameters: ${paramNames.length}`);

  return {
    program,
    tuner,
    totalTrials: trials.length,
    totalUniqueBranches: allCoveredBranches.size,
    trials,
    parameters: paramNames,
    branchIndices
  };
}

function saveProcessedData(data: ProcessedData, name: string, outputDir: string) {
  // Save full data
  const outputPath = path.join(outputDir, `${name}_processed.json`);
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
  console.log(`  Saved to: ${outputPath}`);

  // Save lightweight version without full branch lists
  const lightData = {
    ...data,
    trials: data.trials.map(t => ({
      trialId: t.trialId,
      marginalCoverage: t.marginalCoverage,
      cumulativeCoverage: t.cumulativeCoverage,
      totalCovered: t.coveredBranches.length,  // total branches covered in this trial (0 = failed)
      parameters: t.parameters
    }))
  };

  const lightOutputPath = path.join(outputDir, `${name}_processed_light.json`);
  fs.writeFileSync(lightOutputPath, JSON.stringify(lightData, null, 2));
  console.log(`  Saved lightweight version to: ${lightOutputPath}`);
}

// Main execution
const dataDir = path.join(__dirname, '../src/data/extracted');
const outputDir = path.join(__dirname, '../public/data');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Process grep
console.log('\n=== Processing grep ===');
const grepData = processData(
  'grep',
  'SymTuner',
  path.join(dataDir, 'Covered Branches', 'grep_2200_filtered.txt'),
  path.join(dataDir, 'Parameters', 'grep_test.csv'),
  path.join(dataDir, 'Branch Indices', 'grep_filtered.json')
);
saveProcessedData(grepData, 'grep', outputDir);

// Process gcal
console.log('\n=== Processing gcal ===');
const gcalData = processData(
  'gcal',
  'SymTuner',
  path.join(dataDir, 'Covered Branches', 'gcal_2200_filtered.txt'),
  path.join(dataDir, 'Parameters', 'gcal_test.csv'),
  path.join(dataDir, 'Branch Indices', 'gcal_filtered.json')
);
saveProcessedData(gcalData, 'gcal', outputDir);

// Process gawk
console.log('\n=== Processing gawk ===');
const gawkData = processData(
  'gawk',
  'SymTuner',
  path.join(dataDir, 'Covered Branches', 'gawk_2200_filtered.txt'),
  path.join(dataDir, 'Parameters', 'gawk_test.csv'),
  path.join(dataDir, 'Branch Indices', 'gawk_filtered.json')
);
saveProcessedData(gawkData, 'gawk', outputDir);

console.log('\n=== Done ===');
