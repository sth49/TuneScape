import React from "react";
import {
  QUAL_LABEL_COLORS,
  QUAL_LABEL_NAMES,
  type QualitativeLabel,
} from "./hexmap/types";

const LABEL_DESCRIPTIONS: Record<QualitativeLabel, string> = {
  "Failure-prone": "Coverage = 0 trials dominate this region",
  "High Novelty": "High marginal coverage — discovers many new branches",
  "High Avg Cov": "Consistently high average branch coverage",
  "High Cum Cov": "Large cumulative branch union across trials",
  "High Density": "Many trials concentrated in this region",
  "Low Density": "Few trials — under-explored parameter space",
};

export interface LabelsPanelProps {
  selectedLabels: Set<QualitativeLabel>;
  onToggle: (label: QualitativeLabel) => void;
}

export function LabelsPanel({ selectedLabels, onToggle }: LabelsPanelProps) {
  return (
    <div
      style={{
        background: "white",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "10px 14px 8px",
          borderBottom: "1px solid #F1F5F9",
          fontWeight: 700,
          fontSize: 15,
          color: "#1E293B",
        }}
      >
        Region Labels
      </div>
      <div style={{ padding: "6px 10px 10px" }}>
        {QUAL_LABEL_NAMES.map((ql) => {
          const isOn = selectedLabels.has(ql);
          const color = QUAL_LABEL_COLORS[ql];
          return (
            <div
              key={ql}
              onClick={() => onToggle(ql)}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                padding: "5px 6px",
                borderRadius: 6,
                cursor: "pointer",
                opacity: isOn ? 1 : 0.35,
                transition: "opacity 0.12s ease",
              }}
            >
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  backgroundColor: color,
                  flexShrink: 0,
                  marginTop: 2,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color,
                    lineHeight: 1.3,
                  }}
                >
                  {ql}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: "#94A3B8",
                    lineHeight: 1.3,
                    marginTop: 1,
                  }}
                >
                  {LABEL_DESCRIPTIONS[ql]}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
