export interface ProcessedTrial {
  trialId: number;
  marginalCoverage: number;
  cumulativeCoverage: number;
  totalCovered: number;
  coveredBranches: number[];
  parameters: Record<string, string | boolean | number | null>;
}

export interface ProcessedData {
  program: string;
  tuner: string;
  totalTrials: number;
  totalUniqueBranches: number;
  trials: ProcessedTrial[];
}
