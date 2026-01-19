/**
 * Type definitions for tuner comparison visualization data
 */

export interface TrialData {
  trialId: number;
  marginalCoverage: number;
  cumulativeCoverage: number;
  totalCovered: number;  // total branches covered in this trial (0 = failed execution)
  parameters: Record<string, string | boolean | number>;
}

export interface ProcessedData {
  program: string;
  tuner: string;
  totalTrials: number;
  totalUniqueBranches: number;
  trials: TrialData[];
  parameters: string[];
  branchIndices?: Record<string, string>;
}
