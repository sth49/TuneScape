/**
 * Program configuration with total branch counts
 * Total branches represent the maximum possible branches in each program
 */

export const PROGRAM_CONFIG: Record<string, { totalBranches: number }> = {
  grep: { totalBranches: 8225 },
  gawk: { totalBranches: 10720 },
  gcal: { totalBranches: 15799 },
};

export function getProgramTotalBranches(programName: string): number {
  const normalized = programName.toLowerCase();
  return PROGRAM_CONFIG[normalized]?.totalBranches ?? 0;
}
