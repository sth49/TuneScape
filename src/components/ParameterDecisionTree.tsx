import { useState, useMemo, useCallback, type ReactElement } from 'react';
import type { DecisionTreeTunerData, DecisionTreeTrial } from '../types/data';

interface TreeNode {
  id: string;
  paramName: string | null;
  paramValue: boolean | number | null;
  trials: DecisionTreeTrial[];
  children: TreeNode[];
  depth: number;
  isExpanded: boolean;
}

interface ParameterDecisionTreeProps {
  data: DecisionTreeTunerData;
  width: number;
  height: number;
  tunerName: string;
  color: string;
  trialRange?: [number, number]; // For time-based segmentation
  onNodeHover?: (node: TreeNode | null) => void;
}

const COLORS = {
  low: '#ef4444',
  mid: '#f59e0b',
  high: '#10b981',
};

function getCoverageColor(coverage: number, min: number, max: number): string {
  const ratio = (coverage - min) / (max - min);
  if (ratio < 0.33) return COLORS.low;
  if (ratio < 0.67) return COLORS.mid;
  return COLORS.high;
}

function formatParamValue(value: boolean | number): string {
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return value.toFixed(2);
}

export function ParameterDecisionTree({
  data,
  width,
  height,
  tunerName,
  color,
  trialRange,
  onNodeHover,
}: ParameterDecisionTreeProps) {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set(['root']));
  const [hoveredNode, setHoveredNode] = useState<TreeNode | null>(null);

  // Filter trials by range if specified
  const filteredTrials = useMemo(() => {
    if (!trialRange) return data.trials;
    return data.trials.filter(
      (t) => t.trial_id >= trialRange[0] && t.trial_id <= trialRange[1]
    );
  }, [data.trials, trialRange]);

  // Get top N important parameters
  const topParams = useMemo(() => {
    return data.param_importance.slice(0, 10);
  }, [data.param_importance]);

  // Build tree structure based on expanded nodes
  const buildTree = useCallback(
    (
      trials: DecisionTreeTrial[],
      depth: number,
      parentId: string,
      usedParams: Set<string>
    ): TreeNode => {
      const nodeId = parentId;
      const isExpanded = expandedNodes.has(nodeId);

      // Find next parameter to split on (highest importance not yet used)
      const nextParam = topParams.find((p) => !usedParams.has(p.name));

      if (!nextParam || depth >= 5 || trials.length < 10) {
        return {
          id: nodeId,
          paramName: null,
          paramValue: null,
          trials,
          children: [],
          depth,
          isExpanded: false,
        };
      }

      const children: TreeNode[] = [];

      if (isExpanded) {
        const newUsedParams = new Set(usedParams);
        newUsedParams.add(nextParam.name);

        if (nextParam.is_boolean) {
          // Split by true/false
          const trueTrials = trials.filter(
            (t) => t.parameters[nextParam.name] === true
          );
          const falseTrials = trials.filter(
            (t) => t.parameters[nextParam.name] === false
          );

          if (trueTrials.length > 0) {
            children.push(
              buildTree(
                trueTrials,
                depth + 1,
                `${nodeId}-${nextParam.name}-true`,
                newUsedParams
              )
            );
            children[children.length - 1].paramName = nextParam.name;
            children[children.length - 1].paramValue = true;
          }
          if (falseTrials.length > 0) {
            children.push(
              buildTree(
                falseTrials,
                depth + 1,
                `${nodeId}-${nextParam.name}-false`,
                newUsedParams
              )
            );
            children[children.length - 1].paramName = nextParam.name;
            children[children.length - 1].paramValue = false;
          }
        } else {
          // Split numeric by median
          const values = trials.map((t) => t.parameters[nextParam.name] as number);
          const median = values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

          const lowTrials = trials.filter(
            (t) => (t.parameters[nextParam.name] as number) <= median
          );
          const highTrials = trials.filter(
            (t) => (t.parameters[nextParam.name] as number) > median
          );

          if (lowTrials.length > 0) {
            children.push(
              buildTree(
                lowTrials,
                depth + 1,
                `${nodeId}-${nextParam.name}-low`,
                newUsedParams
              )
            );
            children[children.length - 1].paramName = nextParam.name;
            children[children.length - 1].paramValue = median;
          }
          if (highTrials.length > 0) {
            children.push(
              buildTree(
                highTrials,
                depth + 1,
                `${nodeId}-${nextParam.name}-high`,
                newUsedParams
              )
            );
            children[children.length - 1].paramName = nextParam.name;
            children[children.length - 1].paramValue = median + 0.01;
          }
        }
      }

      return {
        id: nodeId,
        paramName: depth === 0 ? null : null,
        paramValue: null,
        trials,
        children,
        depth,
        isExpanded,
      };
    },
    [expandedNodes, topParams]
  );

  const tree = useMemo(() => {
    return buildTree(filteredTrials, 0, 'root', new Set());
  }, [filteredTrials, buildTree]);

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

  const handleNodeHover = (node: TreeNode | null) => {
    setHoveredNode(node);
    onNodeHover?.(node);
  };

  // Render tree recursively
  const renderNode = (node: TreeNode, x: number, y: number, availableWidth: number): ReactElement[] => {
    const elements: ReactElement[] = [];
    const nodeWidth = 140;
    const nodeHeight = 50;
    const verticalGap = 20;

    const avgCoverage =
      node.trials.length > 0
        ? node.trials.reduce((sum, t) => sum + t.coverage, 0) / node.trials.length
        : 0;

    const coverageColor = getCoverageColor(
      avgCoverage,
      data.stats.min_coverage,
      data.stats.max_coverage
    );

    // Next param to show
    const nextParam = topParams.find(
      (p) =>
        !node.children.some((c) => c.paramName === p.name) &&
        node.children.length === 0
    );
    const nextParamName = node.isExpanded
      ? null
      : nextParam?.name || null;

    // Node rectangle
    elements.push(
      <g
        key={node.id}
        transform={`translate(${x - nodeWidth / 2}, ${y})`}
        style={{ cursor: 'pointer' }}
        onClick={() => toggleNode(node.id)}
        onMouseEnter={() => handleNodeHover(node)}
        onMouseLeave={() => handleNodeHover(null)}
      >
        <rect
          width={nodeWidth}
          height={nodeHeight}
          rx={6}
          fill={hoveredNode?.id === node.id ? '#f3f4f6' : 'white'}
          stroke={color}
          strokeWidth={node.isExpanded ? 2 : 1}
        />
        {/* Coverage bar */}
        <rect
          x={4}
          y={nodeHeight - 8}
          width={nodeWidth - 8}
          height={4}
          rx={2}
          fill="#e5e7eb"
        />
        <rect
          x={4}
          y={nodeHeight - 8}
          width={
            ((avgCoverage - data.stats.min_coverage) /
              (data.stats.max_coverage - data.stats.min_coverage)) *
            (nodeWidth - 8)
          }
          height={4}
          rx={2}
          fill={coverageColor}
        />
        {/* Label */}
        {node.paramName && (
          <text x={nodeWidth / 2} y={12} textAnchor="middle" fontSize={9} fill="#6b7280">
            {node.paramName}={formatParamValue(node.paramValue!)}
          </text>
        )}
        <text x={nodeWidth / 2} y={node.paramName ? 26 : 18} textAnchor="middle" fontSize={11} fontWeight={600}>
          {node.trials.length} trials
        </text>
        <text x={nodeWidth / 2} y={node.paramName ? 38 : 32} textAnchor="middle" fontSize={10} fill="#6b7280">
          avg: {avgCoverage.toFixed(0)}
        </text>
        {/* Expand indicator */}
        {node.trials.length >= 10 && node.depth < 5 && (
          <text
            x={nodeWidth - 8}
            y={14}
            textAnchor="middle"
            fontSize={12}
            fill={color}
          >
            {node.isExpanded ? '−' : '+'}
          </text>
        )}
        {/* Next param hint */}
        {nextParamName && !node.isExpanded && node.trials.length >= 10 && (
          <text
            x={nodeWidth / 2}
            y={nodeHeight + 12}
            textAnchor="middle"
            fontSize={8}
            fill="#9ca3af"
          >
            split by: {nextParamName}
          </text>
        )}
      </g>
    );

    // Draw children
    if (node.children.length > 0) {
      const childWidth = availableWidth / node.children.length;
      const childY = y + nodeHeight + verticalGap + 15;

      node.children.forEach((child, i) => {
        const childX = x - availableWidth / 2 + childWidth * (i + 0.5);

        // Connection line
        elements.push(
          <path
            key={`${node.id}-${child.id}-line`}
            d={`M${x},${y + nodeHeight} Q${x},${childY - 10} ${childX},${childY}`}
            fill="none"
            stroke="#d1d5db"
            strokeWidth={1}
          />
        );

        // Recursive render
        elements.push(...renderNode(child, childX, childY, childWidth - 10));
      });
    }

    return elements;
  };

  const treeElements = renderNode(tree, width / 2, 10, width - 40);

  return (
    <div style={{ position: 'relative' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
          paddingLeft: 4,
        }}
      >
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: 2,
            backgroundColor: color,
          }}
        />
        <span style={{ fontWeight: 600, fontSize: 13 }}>{tunerName}</span>
        {trialRange && (
          <span style={{ fontSize: 11, color: '#6b7280' }}>
            (Trial {trialRange[0]}-{trialRange[1]})
          </span>
        )}
      </div>

      {/* Tree SVG */}
      <svg width={width} height={height} style={{ overflow: 'visible' }}>
        {treeElements}
      </svg>

      {/* Hover tooltip with distribution */}
      {hoveredNode && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            background: 'white',
            border: '1px solid #e5e7eb',
            borderRadius: 6,
            padding: 8,
            fontSize: 11,
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            zIndex: 100,
            minWidth: 150,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {hoveredNode.trials.length} Trials
          </div>
          <MiniHistogram
            values={hoveredNode.trials.map((t) => t.coverage)}
            min={data.stats.min_coverage}
            max={data.stats.max_coverage}
            width={130}
            height={40}
            color={color}
          />
          <div style={{ marginTop: 4, color: '#6b7280' }}>
            Min: {Math.min(...hoveredNode.trials.map((t) => t.coverage))} | Max:{' '}
            {Math.max(...hoveredNode.trials.map((t) => t.coverage))}
          </div>
        </div>
      )}
    </div>
  );
}

// Mini histogram component for tooltip
function MiniHistogram({
  values,
  min,
  max,
  width,
  height,
  color,
}: {
  values: number[];
  min: number;
  max: number;
  width: number;
  height: number;
  color: string;
}) {
  const bins = 10;
  const binWidth = (max - min) / bins;
  const counts = new Array(bins).fill(0);

  values.forEach((v) => {
    const binIdx = Math.min(Math.floor((v - min) / binWidth), bins - 1);
    if (binIdx >= 0) counts[binIdx]++;
  });

  const maxCount = Math.max(...counts, 1);
  const barWidth = width / bins - 1;

  return (
    <svg width={width} height={height}>
      {counts.map((count, i) => (
        <rect
          key={i}
          x={i * (barWidth + 1)}
          y={height - (count / maxCount) * height}
          width={barWidth}
          height={(count / maxCount) * height}
          fill={color}
          opacity={0.7}
        />
      ))}
    </svg>
  );
}
