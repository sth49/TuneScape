import { useState, useMemo, useCallback, useEffect } from "react";
import type { DecisionTreeTunerData, DecisionTreeTrial } from "../types/data";

// Parameter name abbreviations (initials)
const PARAM_ABBREV: Record<string, string> = {
  "max-memory": "MM",
  "max-stack-frames": "MSF",
  "max-depth": "MD",
  "max-forks": "MFo",
  "max-sym-array-size": "MSA",
  "max-solver-time": "MSo",
  "max-static-solve-pct": "SSP",
  "max-static-fork-pct": "SFP",
  "max-static-cpfork-pct": "SCP",
  "batch-instructions": "BI",
  "batch-time": "BT",
  "uncovered-update-interval": "UUI",
  "array-value-symb-ratio": "AVS",
  "array-value-ratio": "AVR",
  "seed-time": "SeT",
  "seed-file": "SeF",
  "sym-arg": "SA",
  "sym-stdin": "SSt",
  "sym-files": "SyF",
  "redzone-size": "RS",
  "switch-type": "SwT",
  "search": "Src",
};

function abbreviateParam(name: string): string {
  if (PARAM_ABBREV[name]) {
    return PARAM_ABBREV[name];
  }
  // Fallback: take first letter of each word
  const parts = name.split(/[-_]/);
  let abbrev = parts.map(p => p[0]?.toUpperCase() || "").join("");
  if (abbrev.length < 2) {
    abbrev = name.slice(0, 3).toUpperCase();
  }
  return abbrev;
}

interface TreeNode {
  id: string;
  paramName: string | null;
  splitCondition: string | null;
  trials: DecisionTreeTrial[];
  children: TreeNode[];
  depth: number;
  isExpanded: boolean;
  coverageStats: {
    min: number;
    max: number;
    mean: number;
  };
  nextSplitParam: { name: string; importance: number; is_boolean: boolean } | null;
}

interface EnhancedDecisionTreeProps {
  data: DecisionTreeTunerData;
  width: number;
  height: number;
  tunerName: string;
  color: string;
  trialRange?: [number, number];
}

export function EnhancedDecisionTree({
  data,
  width,
  height,
  tunerName,
  color,
  trialRange,
}: EnhancedDecisionTreeProps) {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [hoveredNode, setHoveredNode] = useState<{ node: TreeNode; x: number; y: number } | null>(null);

  // Filter trials by range
  const filteredTrials = useMemo(() => {
    if (!trialRange) return data.trials;
    return data.trials.filter(
      (t) => t.trial_id >= trialRange[0] && t.trial_id <= trialRange[1]
    );
  }, [data.trials, trialRange]);

  // Top important parameters
  const topParams = useMemo(() => {
    return data.param_importance.slice(0, 10);
  }, [data.param_importance]);

  // Compute coverage stats
  const computeCoverageStats = useCallback((trials: DecisionTreeTrial[]) => {
    if (trials.length === 0) {
      return { min: 0, max: 0, mean: 0 };
    }
    const coverages = trials.map((t) => t.coverage);
    return {
      min: Math.min(...coverages),
      max: Math.max(...coverages),
      mean: coverages.reduce((a, b) => a + b, 0) / coverages.length,
    };
  }, []);

  // Find best split parameter for a set of trials
  const findBestSplitParam = useCallback(
    (trials: DecisionTreeTrial[], usedParams: Set<string>) => {
      if (trials.length < 5) return null;

      const candidates = topParams.filter((p) => !usedParams.has(p.name));
      if (candidates.length === 0) return null;

      let best = candidates[0];
      let bestScore = 0;

      for (const param of candidates.slice(0, 5)) {
        const values = trials.map((t) => ({
          value: t.parameters[param.name],
          coverage: t.coverage,
        }));

        let score = 0;
        if (param.is_boolean) {
          const trueTrials = values.filter((v) => v.value === true);
          const falseTrials = values.filter((v) => v.value === false);
          if (trueTrials.length > 0 && falseTrials.length > 0) {
            const trueMean = trueTrials.reduce((s, v) => s + v.coverage, 0) / trueTrials.length;
            const falseMean = falseTrials.reduce((s, v) => s + v.coverage, 0) / falseTrials.length;
            score = Math.abs(trueMean - falseMean);
          }
        } else {
          const numericValues = values
            .filter((v) => typeof v.value === "number")
            .sort((a, b) => (a.value as number) - (b.value as number));
          if (numericValues.length >= 2) {
            const mid = Math.floor(numericValues.length / 2);
            const leftMean = numericValues.slice(0, mid).reduce((s, v) => s + v.coverage, 0) / mid;
            const rightMean = numericValues.slice(mid).reduce((s, v) => s + v.coverage, 0) / (numericValues.length - mid);
            score = Math.abs(leftMean - rightMean);
          }
        }

        if (score > bestScore) {
          bestScore = score;
          best = param;
        }
      }

      return { name: best.name, importance: bestScore, is_boolean: best.is_boolean };
    },
    [topParams]
  );

  // Build tree recursively
  const buildTree = useCallback(
    (
      trials: DecisionTreeTrial[],
      depth: number,
      nodeId: string,
      usedParams: Set<string>,
      splitCondition: string | null,
      splitParamName: string | null
    ): TreeNode => {
      const isExpanded = expandedNodes.has(nodeId);
      const coverageStats = computeCoverageStats(trials);
      const nextSplitParam = findBestSplitParam(trials, usedParams);

      const children: TreeNode[] = [];

      if (isExpanded && nextSplitParam && depth < 5 && trials.length >= 5) {
        const newUsedParams = new Set(usedParams);
        newUsedParams.add(nextSplitParam.name);

        const paramAbbrev = abbreviateParam(nextSplitParam.name);

        if (nextSplitParam.is_boolean) {
          const trueTrials = trials.filter((t) => t.parameters[nextSplitParam.name] === true);
          const falseTrials = trials.filter((t) => t.parameters[nextSplitParam.name] === false);

          if (trueTrials.length > 0) {
            children.push(
              buildTree(trueTrials, depth + 1, `${nodeId}-true`, newUsedParams, `${paramAbbrev}=T`, nextSplitParam.name)
            );
          }
          if (falseTrials.length > 0) {
            children.push(
              buildTree(falseTrials, depth + 1, `${nodeId}-false`, newUsedParams, `${paramAbbrev}=F`, nextSplitParam.name)
            );
          }
        } else {
          const values = trials
            .map((t) => t.parameters[nextSplitParam.name])
            .filter((v) => typeof v === "number") as number[];
          if (values.length >= 2) {
            const sorted = [...values].sort((a, b) => a - b);
            const threshold = sorted[Math.floor(sorted.length / 2)];

            const leftTrials = trials.filter((t) => (t.parameters[nextSplitParam.name] as number) <= threshold);
            const rightTrials = trials.filter((t) => (t.parameters[nextSplitParam.name] as number) > threshold);

            if (leftTrials.length > 0) {
              children.push(
                buildTree(leftTrials, depth + 1, `${nodeId}-left`, newUsedParams, `${paramAbbrev}≤${threshold.toFixed(0)}`, nextSplitParam.name)
              );
            }
            if (rightTrials.length > 0) {
              children.push(
                buildTree(rightTrials, depth + 1, `${nodeId}-right`, newUsedParams, `${paramAbbrev}>${threshold.toFixed(0)}`, nextSplitParam.name)
              );
            }
          }
        }
      }

      return {
        id: nodeId,
        paramName: splitParamName,
        splitCondition,
        trials,
        children,
        depth,
        isExpanded,
        coverageStats,
        nextSplitParam,
      };
    },
    [expandedNodes, computeCoverageStats, findBestSplitParam]
  );

  const tree = useMemo(() => {
    return buildTree(filteredTrials, 0, "root", new Set(), null, null);
  }, [filteredTrials, buildTree]);

  // Auto-expand first 2 levels on mount
  useEffect(() => {
    setExpandedNodes(new Set(["root", "root-true", "root-false", "root-left", "root-right"]));
  }, [data, trialRange]);

  const toggleNode = (nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  const expandAll = () => {
    const allNodes = new Set<string>();
    const collectIds = (node: TreeNode) => {
      allNodes.add(node.id);
      node.children.forEach(collectIds);
    };
    collectIds(tree);
    setExpandedNodes(allNodes);
  };

  const collapseAll = () => {
    setExpandedNodes(new Set(["root"]));
  };

  // Layout
  const nodeWidth = 120;
  const nodeHeight = 50;
  const verticalGap = 40;
  const horizontalGap = 12;

  const calculatePositions = (
    node: TreeNode,
    x: number,
    y: number,
    positions: Map<string, { x: number; y: number; width: number }>
  ): number => {
    if (node.children.length === 0) {
      positions.set(node.id, { x, y, width: nodeWidth });
      return nodeWidth;
    }

    let totalWidth = 0;
    for (const child of node.children) {
      const childWidth = calculatePositions(child, x + totalWidth, y + nodeHeight + verticalGap, positions);
      totalWidth += childWidth + horizontalGap;
    }
    totalWidth -= horizontalGap;

    const nodeX = x + totalWidth / 2 - nodeWidth / 2;
    positions.set(node.id, { x: nodeX, y, width: totalWidth });

    return totalWidth;
  };

  const positions = useMemo(() => {
    const pos = new Map<string, { x: number; y: number; width: number }>();
    calculatePositions(tree, 0, 0, pos);
    return pos;
  }, [tree]);

  const getTreeDepth = (node: TreeNode): number => {
    if (node.children.length === 0) return 1;
    return 1 + Math.max(...node.children.map(getTreeDepth));
  };

  const svgWidth = Math.max(width - 20, (positions.get("root")?.width || 0) + nodeWidth);
  const treeDepth = getTreeDepth(tree);
  const svgHeight = Math.max(400, treeDepth * (nodeHeight + verticalGap) + 50);

  const renderNode = (node: TreeNode): React.ReactNode => {
    const pos = positions.get(node.id);
    if (!pos) return null;

    const canExpand = node.trials.length >= 5 && node.depth < 5 && node.nextSplitParam;
    const coverageRatio = (node.coverageStats.mean - data.stats.min_coverage) / (data.stats.max_coverage - data.stats.min_coverage || 1);

    return (
      <g key={node.id}>
        {/* Connection lines */}
        {node.children.map((child) => {
          const childPos = positions.get(child.id);
          if (!childPos) return null;

          const startX = pos.x + nodeWidth / 2;
          const startY = pos.y + nodeHeight;
          const endX = childPos.x + nodeWidth / 2;
          const endY = childPos.y;
          const midY = (startY + endY) / 2;

          const coverageGain = child.coverageStats.mean - node.coverageStats.mean;
          const lineColor = coverageGain >= 0 ? "#10b981" : "#ef4444";

          // Stroke width based on effect size
          const maxGain = data.stats.max_coverage - data.stats.min_coverage || 1;
          const absGain = Math.abs(coverageGain);
          const normalizedGain = absGain / maxGain;
          const strokeWidth = 3 + Math.pow(normalizedGain, 0.5) * 20; // 3px to 23px

          return (
            <g key={`line-${child.id}`}>
              <path
                d={`M${startX},${startY} Q${startX},${midY} ${endX},${endY}`}
                fill="none"
                stroke={lineColor}
                strokeWidth={strokeWidth}
                opacity={0.5}
                strokeLinecap="round"
              />
              {/* Branch label with condition and coverage change */}
              <g transform={`translate(${endX}, ${midY})`}>
                <rect x={-45} y={-16} width={90} height={32} rx={4} fill="white" stroke="#e5e7eb" />
                <text x={0} y={-3} textAnchor="middle" fontSize={10} fill="#374151">
                  {child.splitCondition}
                </text>
                <text x={0} y={10} textAnchor="middle" fontSize={11} fontWeight={600} fill={lineColor}>
                  {coverageGain >= 0 ? "+" : ""}{coverageGain.toFixed(1)}
                </text>
              </g>
            </g>
          );
        })}

        {/* Node */}
        <g
          transform={`translate(${pos.x}, ${pos.y})`}
          style={{ cursor: canExpand ? "pointer" : "default" }}
          onClick={() => canExpand && toggleNode(node.id)}
          onMouseEnter={(e) => setHoveredNode({ node, x: e.clientX, y: e.clientY })}
          onMouseMove={(e) => setHoveredNode({ node, x: e.clientX, y: e.clientY })}
          onMouseLeave={() => setHoveredNode(null)}
        >
          <rect
            width={nodeWidth}
            height={nodeHeight}
            rx={6}
            fill="white"
            stroke={color}
            strokeWidth={1.5}
          />

          {/* Coverage bar */}
          <rect
            x={4}
            y={nodeHeight - 8}
            width={(nodeWidth - 8) * coverageRatio}
            height={4}
            rx={2}
            fill={color}
            opacity={0.6}
          />

          {/* Content */}
          <text x={nodeWidth / 2} y={18} textAnchor="middle" fontSize={12} fontWeight={600} fill="#374151">
            {node.trials.length} trials
          </text>
          <text x={nodeWidth / 2} y={32} textAnchor="middle" fontSize={10} fill="#6b7280">
            μ={node.coverageStats.mean.toFixed(0)}
          </text>

          {/* Expand indicator */}
          {canExpand && (
            <g transform={`translate(${nodeWidth - 14}, 4)`}>
              <circle r={6} cx={6} cy={6} fill={node.isExpanded ? color : "#f3f4f6"} stroke={color} />
              <text x={6} y={9} textAnchor="middle" fontSize={10} fontWeight={600} fill={node.isExpanded ? "white" : color}>
                {node.isExpanded ? "−" : "+"}
              </text>
            </g>
          )}
        </g>

        {node.children.map((child) => renderNode(child))}
      </g>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2 px-1">
        <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: color }} />
        <span className="font-semibold text-sm">{tunerName}</span>
        {trialRange && (
          <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
            Trial {trialRange[0]}-{trialRange[1]}
          </span>
        )}
        <div className="ml-auto flex gap-1">
          <button className="btn btn-xs btn-ghost" onClick={expandAll}>Expand All</button>
          <button className="btn btn-xs btn-ghost" onClick={collapseAll}>Collapse</button>
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-auto">
        <svg width={svgWidth} height={svgHeight} style={{ minWidth: "100%" }}>
          <g transform="translate(20, 20)">{renderNode(tree)}</g>
        </svg>
      </div>

      {/* Hover tooltip */}
      {hoveredNode && (
        <div
          className="fixed bg-white rounded-lg border shadow-lg p-3 z-50 pointer-events-none text-xs w-56"
          style={{
            left: hoveredNode.x + 15,
            top: hoveredNode.y - 10,
            transform: hoveredNode.x > window.innerWidth - 280 ? "translateX(-110%)" : "none",
          }}
        >
          <div className="font-semibold mb-2" style={{ color }}>
            {hoveredNode.node.trials.length} trials
          </div>

          <div className="space-y-1 mb-2">
            <div className="flex justify-between">
              <span className="text-gray-500">Coverage:</span>
              <span>{hoveredNode.node.coverageStats.mean.toFixed(1)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Range:</span>
              <span>{hoveredNode.node.coverageStats.min.toFixed(0)} - {hoveredNode.node.coverageStats.max.toFixed(0)}</span>
            </div>
          </div>

          {hoveredNode.node.nextSplitParam && (
            <div className="pt-2 border-t">
              <div className="text-gray-500 mb-1">Next split:</div>
              <div className="font-medium text-primary">
                {hoveredNode.node.nextSplitParam.name}
                <span className="text-gray-400 font-normal ml-1">
                  ({abbreviateParam(hoveredNode.node.nextSplitParam.name)})
                </span>
              </div>
              <div className="text-gray-400">Δ coverage: {hoveredNode.node.nextSplitParam.importance.toFixed(1)}</div>
            </div>
          )}
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-gray-500 mt-2 px-1 pt-2 border-t">
        <div className="flex items-center gap-1">
          <svg width="20" height="10"><path d="M0,5 L20,5" stroke="#10b981" strokeWidth="6" opacity="0.5"/></svg>
          <span>+coverage</span>
        </div>
        <div className="flex items-center gap-1">
          <svg width="20" height="10"><path d="M0,5 L20,5" stroke="#ef4444" strokeWidth="3" opacity="0.5"/></svg>
          <span>-coverage</span>
        </div>
        <span className="text-gray-400">wider = bigger effect</span>
        <span className="text-gray-400 ml-auto">click node to expand</span>
      </div>
    </div>
  );
}
