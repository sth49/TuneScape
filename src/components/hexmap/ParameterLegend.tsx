import React from "react";
import { MIXED_COLOR } from "./types";

export interface ParameterLegendProps {
  selectedParam: string | null;
  selectedParamType: "boolean" | "numeric" | "categorical" | null;
  paramCellBins: {
    binNames: string[];
    binColors: Record<string, string>;
  } | null;
}

export function ParameterLegend({
  selectedParam,
  selectedParamType,
  paramCellBins,
}: ParameterLegendProps) {
  if (!selectedParam || !paramCellBins) return null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 12,
        left: 12,
        zIndex: 10,
        background: "rgba(255,255,255,0.92)",
        backdropFilter: "blur(4px)",
        borderRadius: 8,
        border: "1px solid #E5E7EB",
        boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
        padding: "6px 10px",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          fontSize: 9,
          fontWeight: 700,
          color: "#374151",
          marginBottom: 3,
        }}
      >
        {selectedParam} ({selectedParamType})
      </div>
      {paramCellBins.binNames.map((bin) => (
        <div
          key={bin}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            marginBottom: 1,
          }}
        >
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              backgroundColor: paramCellBins.binColors[bin] ?? MIXED_COLOR,
              opacity: 0.7,
            }}
          />
          <span
            style={{
              fontSize: 9,
              fontWeight: 600,
              color: paramCellBins.binColors[bin] ?? MIXED_COLOR,
            }}
          >
            {bin}
          </span>
        </div>
      ))}
    </div>
  );
}
