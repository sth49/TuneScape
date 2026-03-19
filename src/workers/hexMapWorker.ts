import { processHexMapData } from "../utils/hexMapUtils";
import type { ProcessedData } from "../types/data";

self.onmessage = (
  e: MessageEvent<{
    id: number;
    tunerData: ProcessedData[];
    shapImportance: { name: string; importance: number }[];
    numClusters: number;
  }>,
) => {
  const { id, tunerData, shapImportance, numClusters } = e.data;
  try {
    const result = processHexMapData(tunerData, shapImportance, numClusters);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({
      id,
      error: err instanceof Error ? err.message : "Processing failed",
    });
  }
};
