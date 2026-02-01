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

// Decision Tree visualization types
export interface ParamImportance {
  name: string;
  importance: number;
  unique_values: number[];
  is_boolean: boolean;
}

export interface DecisionTreeTrial {
  trial_id: number;
  coverage: number;
  parameters: Record<string, boolean | number>;
}

export interface DecisionTreeTunerData {
  param_importance: ParamImportance[];
  trials: DecisionTreeTrial[];
  stats: {
    total_trials: number;
    min_coverage: number;
    max_coverage: number;
    mean_coverage: number;
  };
}

export interface DecisionTreeData {
  [program: string]: {
    [tuner: string]: DecisionTreeTunerData;
  };
}
