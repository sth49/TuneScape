import { useState, useMemo, useCallback, useEffect, type ReactElement } from 'react';
import type { DecisionTreeTunerData, DecisionTreeTrial } from '../types/data';

interface TreeNode {
  id: string;
  paramName: string | null;
  paramValue: boolean | number | null;
  splitType: 'true' | 'false' | 'low' | 'high' | null;
  trials: DecisionTreeTrial[];
  children: TreeNode[];
  depth: number;
  isExpanded: boolean;
  importance: number;
}

interface ParameterDecisionTreeProps {
  data: DecisionTreeTunerData;
  width: number;
  height: number;
  tunerName: string;
  color: string;
  trialRange?: [number, number];
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

export function ParameterDecisionTree({
  data,
  width,
  height,
  tunerName,
  color,
  trialRange,
  onNodeHover,
}: ParameterDecisionTreeProps) {
  // Auto-expand first 2 levels
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
    const initial = new Set(['root']);
    // Will be populated after first render
    return initial;
  });
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
    return data.param_importance.slice(0, 8);
  }, [data.param_importance]);

  // Max importance for scaling
  const maxImportance = useMemo(() => {
    return Math.max(...topParams.map(p => p.importance));
  }, [topParams]);

  // Build tree structure
  const buildTree = useCallback(
    (
      trials: DecisionTreeTrial[],
      depth: number,
      parentId: string,
      usedParams: Set<string>
    ): TreeNode => {
      const nodeId = parentId;
      const isExpanded = expandedNodes.has(nodeId);

      // Find next parameter to split on
      const nextParam = topParams.find((p) => !usedParams.has(p.name));

      if (!nextParam || depth >= 4 || trials.length < 5) {
        return {
          id: nodeId,
          paramName: null,
          paramValue: null,
          splitType: null,
          trials,
          children: [],
          depth,
          isExpanded: false,
          importance: 0,
        };
      }

      const children: TreeNode[] = [];

      if (isExpanded) {
        const newUsedParams = new Set(usedParams);
        newUsedParams.add(nextParam.name);

        if (nextParam.is_boolean) {
          const trueTrials = trials.filter((t) => t.parameters[nextParam.name] === true);
          const falseTrials = trials.filter((t) => t.parameters[nextParam.name] === false);

          if (trueTrials.length > 0) {
            const child = buildTree(trueTrials, depth + 1, `${nodeId}-true`, newUsedParams);
            child.paramName = nextParam.name;
            child.paramValue = true;
            child.splitType = 'true';
            child.importance = nextParam.importance;
            children.push(child);
          }
          if (falseTrials.length > 0) {
            const child = buildTree(falseTrials, depth + 1, `${nodeId}-false`, newUsedParams);
            child.paramName = nextParam.name;
            child.paramValue = false;
            child.splitType = 'false';
            child.importance = nextParam.importance;
            children.push(child);
          }
        } else {
          const values = trials.map((t) => t.parameters[nextParam.name] as number);
          const median = values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

          const lowTrials = trials.filter((t) => (t.parameters[nextParam.name] as number) <= median);
          const highTrials = trials.filter((t) => (t.parameters[nextParam.name] as number) > median);

          if (lowTrials.length > 0) {
            const child = buildTree(lowTrials, depth + 1, `${nodeId}-low`, newUsedParams);
            child.paramName = nextParam.name;
            child.paramValue = median;
            child.splitType = 'low';
            child.importance = nextParam.importance;
            children.push(child);
          }
          if (highTrials.length > 0) {
            const child = buildTree(highTrials, depth + 1, `${nodeId}-high`, newUsedParams);
            child.paramName = nextParam.name;
            child.paramValue = median;
            child.splitType = 'high';
            child.importance = nextParam.importance;
            children.push(child);
          }
        }
      }

      return {
        id: nodeId,
        paramName: null,
        paramValue: null,
        splitType: null,
        trials,
        children,
        depth,
        isExpanded,
        importance: nextParam?.importance || 0,
      };
    },
    [expandedNodes, topParams]
  );

  const tree = useMemo(() => {
    return buildTree(filteredTrials, 0, 'root', new Set());
  }, [filteredTrials, buildTree]);

  // Auto-expand first 2 levels on mount
  useEffect(() => {
    const autoExpand = new Set(['root']);

    // Get first level children IDs
    if (topParams.length > 0) {
      autoExpand.add('root-true');
      autoExpand.add('root-false');
      autoExpand.add('root-low');
      autoExpand.add('root-high');
    }

    setExpandedNodes(autoExpand);
  }, [topParams.length]);

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

  // Compact node dimensions
  const nodeWidth = 110;
  const nodeHeight = 44;
  const verticalGap = 12;

  // Render tree recursively
  const renderNode = (node: TreeNode, x: number, y: number, availableWidth: number): ReactElement[] => {
    const elements: ReactElement[] = [];

    const avgCoverage =
      node.trials.length > 0
        ? node.trials.reduce((sum, t) => sum + t.coverage, 0) / node.trials.length
        : 0;

    const coverageColor = getCoverageColor(
      avgCoverage,
      data.stats.min_coverage,
      data.stats.max_coverage
    );

    const coveragePercent = ((avgCoverage - data.stats.min_coverage) /
      (data.stats.max_coverage - data.stats.min_coverage)) * 100;

    // Next param to show
    const usedParamNames = new Set<string>();
    let current: TreeNode | null = node;
    while (current && current.paramName) {
      usedParamNames.add(current.paramName);
      current = null; // simplified
    }
    const nextParam = topParams.find((p) => !usedParamNames.has(p.name) && node.children.length === 0);
    const canExpand = node.trials.length >= 5 && node.depth < 4;

    // Format split label
    const getSplitLabel = () => {
      if (!node.paramName) return null;
      const shortName = node.paramName.length > 12
        ? node.paramName.slice(0, 10) + '..'
        : node.paramName;

      if (node.splitType === 'true') return `${shortName}=T`;
      if (node.splitType === 'false') return `${shortName}=F`;
      if (node.splitType === 'low') return `${shortName}≤${(node.paramValue as number).toFixed(0)}`;
      if (node.splitType === 'high') return `${shortName}>${(node.paramValue as number).toFixed(0)}`;
      return null;
    };

    // Node rectangle
    elements.push(
      <g
        key={node.id}
        transform={`translate(${x - nodeWidth / 2}, ${y})`}
        style={{ cursor: canExpand ? 'pointer' : 'default' }}
        onClick={() => canExpand && toggleNode(node.id)}
        onMouseEnter={() => handleNodeHover(node)}
        onMouseLeave={() => handleNodeHover(null)}
      >
        {/* Background */}
        <rect
          width={nodeWidth}
          height={nodeHeight}
          rx={4}
          fill={hoveredNode?.id === node.id ? '#f9fafb' : 'white'}
          stroke={node.isExpanded ? color : '#d1d5db'}
          strokeWidth={node.isExpanded ? 1.5 : 1}
        />

        {/* Importance indicator (left edge) */}
        {node.importance > 0 && (
          <rect
            x={0}
            y={0}
            width={3}
            height={nodeHeight}
            rx={1}
            fill={color}
            opacity={node.importance / maxImportance}
          />
        )}

        {/* Split label */}
        {node.paramName && (
          <text x={nodeWidth / 2} y={11} textAnchor="middle" fontSize={8} fill="#6b7280" fontWeight={500}>
            {getSplitLabel()}
          </text>
        )}

        {/* Trial count */}
        <text
          x={nodeWidth / 2}
          y={node.paramName ? 24 : 18}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill="#1f2937"
        >
          {node.trials.length}
        </text>

        {/* Coverage bar */}
        <g transform={`translate(6, ${nodeHeight - 10})`}>
          <rect width={nodeWidth - 12} height={5} rx={2} fill="#e5e7eb" />
          <rect
            width={Math.max(0, (coveragePercent / 100) * (nodeWidth - 12))}
            height={5}
            rx={2}
            fill={coverageColor}
          />
        </g>

        {/* Avg coverage text */}
        <text
          x={nodeWidth / 2}
          y={node.paramName ? 35 : 30}
          textAnchor="middle"
          fontSize={8}
          fill="#9ca3af"
        >
          μ={avgCoverage.toFixed(0)}
        </text>

        {/* Expand indicator */}
        {canExpand && (
          <circle
            cx={nodeWidth - 8}
            cy={8}
            r={6}
            fill={node.isExpanded ? color : '#e5e7eb'}
          />
        )}
        {canExpand && (
          <text
            x={nodeWidth - 8}
            y={11}
            textAnchor="middle"
            fontSize={10}
            fill={node.isExpanded ? 'white' : '#6b7280'}
            fontWeight={600}
          >
            {node.isExpanded ? '−' : '+'}
          </text>
        )}
      </g>
    );

    // Draw children
    if (node.children.length > 0) {
      const childWidth = availableWidth / node.children.length;
      const childY = y + nodeHeight + verticalGap;

      node.children.forEach((child, i) => {
        const childX = x - availableWidth / 2 + childWidth * (i + 0.5);

        // Connection line
        elements.push(
          <path
            key={`${node.id}-${child.id}-line`}
            d={`M${x},${y + nodeHeight} L${x},${y + nodeHeight + verticalGap/2} L${childX},${y + nodeHeight + verticalGap/2} L${childX},${childY}`}
            fill="none"
            stroke="#d1d5db"
            strokeWidth={1}
          />
        );

        // Recursive render
        elements.push(...renderNode(child, childX, childY, childWidth - 8));
      });
    }

    return elements;
  };

  // Calculate tree depth for dynamic height
  const getTreeDepth = (node: TreeNode): number => {
    if (node.children.length === 0) return 1;
    return 1 + Math.max(...node.children.map(getTreeDepth));
  };

  const treeDepth = getTreeDepth(tree);
  const dynamicHeight = Math.min(height, 50 + treeDepth * (nodeHeight + verticalGap + 5));

  const treeElements = renderNode(tree, width / 2, 8, width - 20);

  return (
    <div className="relative">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2 px-1">
        <div
          className="w-3 h-3 rounded-sm"
          style={{ backgroundColor: color }}
        />
        <span className="font-semibold text-sm">{tunerName}</span>
        {trialRange && (
          <span className="text-xs text-gray-500">
            (Trial {trialRange[0]}-{trialRange[1]})
          </span>
        )}
        <span className="text-xs text-gray-400 ml-auto">
          {filteredTrials.length} trials
        </span>
      </div>

      {/* Top parameters legend */}
      <div className="flex flex-wrap gap-1 mb-2 px-1">
        {topParams.slice(0, 5).map((p, i) => (
          <div
            key={p.name}
            className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600"
            title={`Importance: ${p.importance.toFixed(1)}`}
          >
            <span className="font-medium text-gray-800">{i + 1}.</span>{' '}
            {p.name.length > 15 ? p.name.slice(0, 13) + '..' : p.name}
          </div>
        ))}
      </div>

      {/* Tree SVG */}
      <svg width={width} height={dynamicHeight} style={{ overflow: 'visible' }}>
        {treeElements}
      </svg>

      {/* Hover tooltip */}
      {hoveredNode && (
        <div className="absolute top-0 right-0 bg-white border border-gray-200 rounded-lg p-2 shadow-lg z-50 min-w-[140px] text-xs">
          <div className="font-semibold mb-1">{hoveredNode.trials.length} Trials</div>
          <MiniHistogram
            values={hoveredNode.trials.map((t) => t.coverage)}
            min={data.stats.min_coverage}
            max={data.stats.max_coverage}
            width={120}
            height={32}
            color={color}
          />
          <div className="mt-1 text-gray-500 flex justify-between">
            <span>min: {Math.min(...hoveredNode.trials.map((t) => t.coverage))}</span>
            <span>max: {Math.max(...hoveredNode.trials.map((t) => t.coverage))}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// Mini histogram component
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
  const bins = 8;
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
          opacity={0.6}
          rx={1}
        />
      ))}
    </svg>
  );
}
