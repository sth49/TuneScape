import { useState, useEffect, useMemo } from "react";

const TUNER_COLORS: Record<string, string> = {
  SymTuner: "#4f46e5",
  CMA_ES: "#10b981",
  Genetic: "#f59e0b",
  SuccessiveHalving: "#ef4444",
};

const TUNER_LABELS: Record<string, string> = {
  SymTuner: "SymTuner",
  CMA_ES: "CMA-ES",
  Genetic: "Genetic",
  SuccessiveHalving: "Successive Halving",
};

interface Trial {
  trial_id: number;
  marginal_coverage: number;
  cumulative_coverage: number;
  coverage: number;
  parameters: Record<string, any>;
  param_changes?: { param: string; from: any; to: any }[];
  n_changes?: number;
  trials_since_last?: number;
}

interface TunerData {
  n_trials: number;
  n_discoveries: number;
  total_branches: number;
  discoveries: Trial[];
  all_trials: Trial[];
  param_effects: any[];
  summary: {
    avg_marginal: number;
    avg_trials_between: number;
    discovery_rate: number;
  };
}

interface TimelineData {
  [program: string]: {
    [tuner: string]: TunerData;
  };
}

// Tree node structure
interface TreeNode {
  id: string;
  trial: Trial | null;
  children: TreeNode[];
  depth: number;
  x?: number;
  y?: number;
  parentId?: string;
  parentNode?: TreeNode;
  paramDiffCount?: number;
  paramDiffs?: { param: string; from: any; to: any }[];
}

// Calculate parameter similarity (0 = identical, 1 = completely different)
function paramSimilarity(
  params1: Record<string, any>,
  params2: Record<string, any>,
  paramList: string[]
): number {
  let differences = 0;
  let total = 0;

  for (const param of paramList) {
    const v1 = params1[param];
    const v2 = params2[param];

    if (v1 === undefined || v2 === undefined) continue;
    total++;

    if (typeof v1 === "number" && typeof v2 === "number") {
      const maxVal = Math.max(Math.abs(v1), Math.abs(v2), 1);
      differences += Math.abs(v1 - v2) / maxVal;
    } else if (v1 !== v2) {
      differences += 1;
    }
  }

  return total > 0 ? differences / total : 0;
}

// Get parameter differences between two parameter sets
function getParamDiffs(
  params1: Record<string, any>,
  params2: Record<string, any>,
  paramList: string[]
): { param: string; from: any; to: any }[] {
  const diffs: { param: string; from: any; to: any }[] = [];

  for (const param of paramList) {
    const v1 = params1[param];
    const v2 = params2[param];

    if (v1 === undefined || v2 === undefined) continue;

    let isDifferent = false;
    if (typeof v1 === "number" && typeof v2 === "number") {
      isDifferent = Math.abs(v1 - v2) > 0.001;
    } else {
      isDifferent = v1 !== v2;
    }

    if (isDifferent) {
      diffs.push({ param, from: v1, to: v2 });
    }
  }

  return diffs;
}

// Build tree from trials based on parameter similarity
function buildSimilarityTree(
  trials: Trial[],
  similarityThreshold: number = 0.3
): TreeNode {
  const paramList = trials.length > 0
    ? Object.keys(trials[0].parameters).filter(p => {
        const values = trials.map(d => d.parameters[p]).filter(v => v !== null && v !== undefined);
        const uniqueValues = new Set(values.map(v => JSON.stringify(v)));
        return uniqueValues.size > 1;
      })
    : [];

  const root: TreeNode = {
    id: "root",
    trial: null,
    children: [],
    depth: 0,
  };

  const leafNodes: TreeNode[] = [root];

  for (const trial of trials) {
    let bestNode = root;
    let bestSimilarity = 1;

    for (const leaf of leafNodes) {
      if (leaf.trial) {
        const sim = paramSimilarity(trial.parameters, leaf.trial.parameters, paramList);
        if (sim < bestSimilarity) {
          bestSimilarity = sim;
          bestNode = leaf;
        }
      }
    }

    const newNode: TreeNode = {
      id: `node-${trial.trial_id}`,
      trial: trial,
      children: [],
      depth: bestNode.depth + 1,
      parentId: bestNode.id,
      parentNode: bestNode,
    };

    if (bestSimilarity > similarityThreshold && bestNode !== root) {
      let ancestor = bestNode;
      while (ancestor.parentId && ancestor !== root) {
        const parentNodeFound = findNode(root, ancestor.parentId);
        if (parentNodeFound && parentNodeFound.trial) {
          const ancestorSim = paramSimilarity(trial.parameters, parentNodeFound.trial.parameters, paramList);
          if (ancestorSim <= similarityThreshold) {
            ancestor = parentNodeFound;
            break;
          }
        }
        ancestor = parentNodeFound || root;
      }
      newNode.depth = ancestor.depth + 1;
      newNode.parentId = ancestor.id;
      newNode.parentNode = ancestor;
      ancestor.children.push(newNode);
    } else {
      bestNode.children.push(newNode);
    }

    // Calculate param differences from parent
    if (newNode.parentNode && newNode.parentNode.trial && trial) {
      const diffs = getParamDiffs(newNode.parentNode.trial.parameters, trial.parameters, paramList);
      newNode.paramDiffCount = diffs.length;
      newNode.paramDiffs = diffs;
    } else {
      newNode.paramDiffCount = 0;
      newNode.paramDiffs = [];
    }

    leafNodes.push(newNode);
  }

  return root;
}

function findNode(root: TreeNode, id: string): TreeNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

// Calculate tree layout positions
function layoutTree(root: TreeNode, width: number, height: number): TreeNode {
  const depthCounts: Map<number, number> = new Map();
  const depthCurrentIndex: Map<number, number> = new Map();

  function countDepths(node: TreeNode) {
    depthCounts.set(node.depth, (depthCounts.get(node.depth) || 0) + 1);
    for (const child of node.children) {
      countDepths(child);
    }
  }
  countDepths(root);

  const maxDepth = Math.max(...depthCounts.keys());
  const levelHeight = height / (maxDepth + 2);

  function assignPositions(node: TreeNode) {
    const count = depthCounts.get(node.depth) || 1;
    const idx = depthCurrentIndex.get(node.depth) || 0;
    depthCurrentIndex.set(node.depth, idx + 1);

    node.y = (node.depth + 1) * levelHeight;
    node.x = ((idx + 1) / (count + 1)) * width;

    for (const child of node.children) {
      assignPositions(child);
    }
  }
  assignPositions(root);

  return root;
}

function flattenTree(root: TreeNode): TreeNode[] {
  const nodes: TreeNode[] = [root];
  for (const child of root.children) {
    nodes.push(...flattenTree(child));
  }
  return nodes;
}

function getEdges(root: TreeNode): { from: TreeNode; to: TreeNode }[] {
  const edges: { from: TreeNode; to: TreeNode }[] = [];
  for (const child of root.children) {
    edges.push({ from: root, to: child });
    edges.push(...getEdges(child));
  }
  return edges;
}

type ViewMode = "marginal" | "all";

export function DiscoveryTimeline() {
  const [data, setData] = useState<TimelineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProgram, setSelectedProgram] = useState("gawk");
  const [maxTrials, setMaxTrials] = useState(30);
  const [similarityThreshold, setSimilarityThreshold] = useState(0.3);
  const [hoveredNode, setHoveredNode] = useState<{ tuner: string; node: TreeNode; x: number; y: number } | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("marginal");

  useEffect(() => {
    setLoading(true);
    fetch("/data/discovery_timeline_data.json")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load data");
        return res.json();
      })
      .then((json) => {
        setData(json);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const programs = useMemo(() => (data ? Object.keys(data) : []), [data]);
  const tuners = useMemo(() => {
    if (!data || !data[selectedProgram]) return [];
    return Object.keys(data[selectedProgram]);
  }, [data, selectedProgram]);

  // Build trees for each tuner
  const trees = useMemo(() => {
    if (!data || !data[selectedProgram]) return {};

    const result: Record<string, { tree: TreeNode; nodes: TreeNode[]; edges: { from: TreeNode; to: TreeNode }[] }> = {};

    for (const tuner of tuners) {
      const tunerData = data[selectedProgram][tuner];
      if (!tunerData) continue;

      // Choose data source based on view mode
      const trials = viewMode === "marginal"
        ? tunerData.discoveries.slice(0, maxTrials)
        : tunerData.all_trials.slice(0, maxTrials);

      const tree = buildSimilarityTree(trials, similarityThreshold);
      const layoutedTree = layoutTree(tree, 280, 450);
      const nodes = flattenTree(layoutedTree);
      const edges = getEdges(layoutedTree);

      result[tuner] = { tree: layoutedTree, nodes, edges };
    }

    return result;
  }, [data, selectedProgram, tuners, maxTrials, similarityThreshold, viewMode]);

  // Max marginal for scaling
  const maxMarginal = useMemo(() => {
    if (!data || !data[selectedProgram]) return 1;
    let max = 1;
    for (const tuner of tuners) {
      const tunerData = data[selectedProgram][tuner];
      if (tunerData) {
        const trials = viewMode === "marginal"
          ? tunerData.discoveries.slice(0, maxTrials)
          : tunerData.all_trials.slice(0, maxTrials);
        for (const trial of trials) {
          max = Math.max(max, trial.marginal_coverage);
        }
      }
    }
    return max;
  }, [data, selectedProgram, tuners, maxTrials, viewMode]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-10">
        <span className="loading loading-spinner loading-lg text-primary"></span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="alert alert-error">
        <span>Error: {error || "No data"}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4 p-3 bg-base-200 rounded-lg">
        <div className="form-control">
          <label className="label py-0">
            <span className="label-text text-xs font-medium">Program</span>
          </label>
          <select
            className="select select-bordered select-sm w-28"
            value={selectedProgram}
            onChange={(e) => setSelectedProgram(e.target.value)}
          >
            {programs.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>

        {/* View Mode Toggle */}
        <div className="form-control">
          <label className="label py-0">
            <span className="label-text text-xs font-medium">View Mode</span>
          </label>
          <div className="join">
            <button
              className={`join-item btn btn-sm ${viewMode === "marginal" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setViewMode("marginal")}
            >
              Marginal Only
            </button>
            <button
              className={`join-item btn btn-sm ${viewMode === "all" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setViewMode("all")}
            >
              All Trials
            </button>
          </div>
        </div>

        <div className="form-control">
          <label className="label py-0">
            <span className="label-text text-xs font-medium">
              {viewMode === "marginal" ? "Discoveries" : "Trials"}
            </span>
          </label>
          <select
            className="select select-bordered select-sm w-24"
            value={maxTrials}
            onChange={(e) => setMaxTrials(parseInt(e.target.value))}
          >
            {viewMode === "marginal"
              ? [20, 30, 50, 80, 100].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))
              : [50, 100, 200, 500, 1000, 2200].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))
            }
          </select>
        </div>

        <div className="form-control">
          <label className="label py-0">
            <span className="label-text text-xs font-medium">Branch threshold</span>
          </label>
          <select
            className="select select-bordered select-sm w-24"
            value={similarityThreshold}
            onChange={(e) => setSimilarityThreshold(parseFloat(e.target.value))}
          >
            <option value={0.15}>Tight (0.15)</option>
            <option value={0.3}>Medium (0.3)</option>
            <option value={0.5}>Loose (0.5)</option>
          </select>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 ml-auto text-xs">
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-full bg-green-500"></div>
            <span>High marginal</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-full bg-orange-500"></div>
            <span>Low marginal</span>
          </div>
          {viewMode === "all" && (
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded-full bg-gray-300"></div>
              <span>No new coverage</span>
            </div>
          )}
        </div>
      </div>

      {/* Info banner */}
      <div className="text-xs text-gray-500 px-2 flex items-center gap-2 bg-base-200 p-2 rounded">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>
          <strong>Discovery Tree</strong>:
          {viewMode === "marginal"
            ? " 새로운 브랜치를 발견한 trial만 표시합니다."
            : " 모든 trial을 표시합니다. 회색 노드는 새로운 브랜치를 발견하지 못한 trial입니다."
          }
          {" "}파라미터 조합이 비슷하면 같은 분기에, 다르면 새로운 분기로 갈라집니다.
        </span>
      </div>

      {/* Trees side by side */}
      <div className="flex-1 overflow-auto">
        <div className="grid grid-cols-4 gap-2 min-h-[500px]">
          {tuners.map((tuner) => {
            const treeData = trees[tuner];
            if (!treeData) return null;

            const { nodes, edges } = treeData;
            const tunerInfo = data[selectedProgram][tuner];

            return (
              <div
                key={tuner}
                className="bg-base-100 rounded-lg border border-base-300 p-2 flex flex-col"
              >
                {/* Header */}
                <div className="flex items-center justify-between mb-2 pb-2 border-b border-base-300">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-3 h-3 rounded-sm"
                      style={{ backgroundColor: TUNER_COLORS[tuner] }}
                    />
                    <span className="font-semibold text-sm">{TUNER_LABELS[tuner]}</span>
                  </div>
                  <div className="text-[10px] text-gray-500">
                    {viewMode === "marginal"
                      ? `${tunerInfo?.n_discoveries} discoveries`
                      : `${tunerInfo?.n_trials} trials`
                    }
                  </div>
                </div>

                {/* Tree SVG */}
                <div className="flex-1 relative">
                  <svg width="100%" height="100%" viewBox="0 0 280 450" preserveAspectRatio="xMidYMid meet">
                    {/* Edges */}
                    {edges.map((edge, i) => (
                      <line
                        key={i}
                        x1={edge.from.x}
                        y1={edge.from.y}
                        x2={edge.to.x}
                        y2={edge.to.y}
                        stroke={TUNER_COLORS[tuner]}
                        strokeWidth={1.5}
                        strokeOpacity={0.3}
                      />
                    ))}

                    {/* Nodes */}
                    {nodes.map((node) => {
                      if (!node.trial) {
                        // Root node
                        return (
                          <g key={node.id}>
                            <circle
                              cx={node.x}
                              cy={node.y}
                              r={8}
                              fill={TUNER_COLORS[tuner]}
                              stroke="white"
                              strokeWidth={2}
                            />
                            <text
                              x={node.x}
                              y={(node.y || 0) - 12}
                              textAnchor="middle"
                              className="fill-gray-500 text-[9px] font-medium"
                            >
                              Start
                            </text>
                          </g>
                        );
                      }

                      const hasMarginal = node.trial.marginal_coverage > 0;
                      const marginalRatio = hasMarginal ? node.trial.marginal_coverage / maxMarginal : 0;
                      const size = hasMarginal
                        ? Math.max(5, Math.min(14, marginalRatio * 12 + 4))
                        : 4;

                      // Color: green for high marginal, orange for low, gray for no marginal
                      let color: string;
                      if (!hasMarginal) {
                        color = "#d1d5db"; // gray
                      } else {
                        const hue = marginalRatio * 120; // 0 = red, 120 = green
                        color = `hsl(${hue}, 70%, 50%)`;
                      }

                      const isHovered = hoveredNode?.tuner === tuner && hoveredNode?.node.id === node.id;

                      return (
                        <g key={node.id}>
                          <circle
                            cx={node.x}
                            cy={node.y}
                            r={isHovered ? size + 3 : size}
                            fill={color}
                            stroke={isHovered ? TUNER_COLORS[tuner] : "white"}
                            strokeWidth={isHovered ? 2 : 1}
                            className="cursor-pointer transition-all"
                            onMouseEnter={(e) => setHoveredNode({ tuner, node, x: e.clientX, y: e.clientY })}
                            onMouseMove={(e) => setHoveredNode({ tuner, node, x: e.clientX, y: e.clientY })}
                            onMouseLeave={() => setHoveredNode(null)}
                          />
                          {/* Trial ID label for larger nodes */}
                          {size > 8 && (
                            <text
                              x={node.x}
                              y={(node.y || 0) + 3}
                              textAnchor="middle"
                              className="fill-white text-[8px] font-bold pointer-events-none"
                            >
                              {node.trial.trial_id}
                            </text>
                          )}
                        </g>
                      );
                    })}
                  </svg>
                </div>

                {/* Stats */}
                <div className="mt-2 pt-2 border-t border-base-300 grid grid-cols-3 gap-1 text-[10px]">
                  <div className="text-center">
                    <div className="text-gray-400">Branches</div>
                    <div className="font-semibold">{nodes.filter(n => n.children.length > 1).length}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-gray-400">Max Depth</div>
                    <div className="font-semibold">{Math.max(...nodes.map(n => n.depth))}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-gray-400">
                      {viewMode === "marginal" ? "Avg Marginal" : "Discovery Rate"}
                    </div>
                    <div className="font-semibold">
                      {viewMode === "marginal"
                        ? tunerInfo?.summary.avg_marginal.toFixed(1)
                        : `${(tunerInfo?.summary.discovery_rate * 100).toFixed(1)}%`
                      }
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Hover tooltip */}
      {hoveredNode && hoveredNode.node.trial && (
        <div
          className="fixed bg-base-100 rounded-lg border border-base-300 shadow-lg p-3 w-64 z-50 pointer-events-none"
          style={{
            left: hoveredNode.x + 15,
            top: hoveredNode.y - 10,
            transform: hoveredNode.x > window.innerWidth - 300 ? 'translateX(-110%)' : 'none',
          }}
        >
          <div className="flex items-center gap-2 mb-2">
            <div
              className="w-3 h-3 rounded-sm"
              style={{ backgroundColor: TUNER_COLORS[hoveredNode.tuner] }}
            />
            <span className="font-semibold text-sm">{TUNER_LABELS[hoveredNode.tuner]}</span>
          </div>
          <div className="text-xs space-y-1">
            <div><span className="text-gray-400">Trial:</span> {hoveredNode.node.trial.trial_id}</div>
            <div>
              <span className="text-gray-400">Marginal:</span>{" "}
              {hoveredNode.node.trial.marginal_coverage > 0
                ? <span className="text-green-600">+{hoveredNode.node.trial.marginal_coverage} branches</span>
                : <span className="text-gray-400">No new branches</span>
              }
            </div>
            <div><span className="text-gray-400">Cumulative:</span> {hoveredNode.node.trial.cumulative_coverage} branches</div>
            <div><span className="text-gray-400">Coverage:</span> {hoveredNode.node.trial.coverage} branches</div>

            {/* Param diff from parent */}
            {hoveredNode.node.parentNode && (
              <div className="mt-2 pt-2 border-t border-base-300">
                <div className="text-gray-400 mb-1">
                  Diff from parent: <span className="font-semibold text-primary">{hoveredNode.node.paramDiffCount} params</span>
                </div>
                {hoveredNode.node.paramDiffs && hoveredNode.node.paramDiffs.slice(0, 5).map((diff, i) => (
                  <div key={i} className="flex justify-between text-[10px]">
                    <span className="text-gray-500 truncate max-w-[100px]">{diff.param}</span>
                    <span>
                      <span className="text-red-400">{formatValue(diff.from)}</span>
                      {" → "}
                      <span className="text-green-500">{formatValue(diff.to)}</span>
                    </span>
                  </div>
                ))}
                {hoveredNode.node.paramDiffs && hoveredNode.node.paramDiffs.length > 5 && (
                  <div className="text-gray-400 text-[10px]">
                    +{hoveredNode.node.paramDiffs.length - 5} more
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatValue(val: any): string {
  if (val === null || val === undefined) return "?";
  if (typeof val === "boolean") return val ? "T" : "F";
  if (typeof val === "number") return val % 1 === 0 ? val.toString() : val.toFixed(2);
  const str = String(val);
  return str.length > 8 ? str.slice(0, 6) + ".." : str;
}
