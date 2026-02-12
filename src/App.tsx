import { useState } from "react";
import { TreeComparison } from "./components/TreeComparison";
import { ExplorationOverview } from "./components/ExplorationOverview";
import { DiscoveryTimeline } from "./components/DiscoveryTimeline";
import { OverviewMap } from "./components/OverviewMap";
import { HexMap } from "./components/HexMap";
import { TrialGraph } from "./components/TrialGraph";
import { ParameterHexMap } from "./components/ParameterHexMap";
import "./App.css";

// type ViewMode = "overview" | "tree" | "timeline" | "map" | "hexmap";
type ViewMode = "hexmap" | "graph" | "paramhex";
type Program = "gawk" | "gcal" | "grep";

function App() {
  const [viewMode, setViewMode] = useState<ViewMode>("hexmap");
  const [mapProgram, setMapProgram] = useState<Program>("gawk");

  return (
    <div className="w-[100vw] h-[100vh] flex flex-col bg-base-100">
      {/* Header */}
      <header className="navbar bg-base-200 px-6 shadow-sm">
        <div className="flex-1 gap-3">
          <div className="flex items-center gap-2">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="8" fill="#4f46e5" />
              <path
                d="M8 22V10h4v12H8zm6-8v8h4v-8h-4zm6-4v12h4V10h-4z"
                fill="white"
              />
            </svg>
            <div>
              <h1 className="text-lg font-bold">TunerVis</h1>
              <span className="text-xs text-gray-500">
                Tuner Comparison Dashboard
              </span>
            </div>
          </div>
        </div>

        {/* View mode tabs */}
        <div className="flex-none">
          <div role="tablist" className="tabs tabs-boxed">
            {/* <button
              role="tab"
              className={`tab ${viewMode === "overview" ? "tab-active" : ""}`}
              onClick={() => setViewMode("overview")}
            >
              Overview
            </button>
            <button
              role="tab"
              className={`tab ${viewMode === "tree" ? "tab-active" : ""}`}
              onClick={() => setViewMode("tree")}
            >
              Decision Tree
            </button>
            <button
              role="tab"
              className={`tab ${viewMode === "timeline" ? "tab-active" : ""}`}
              onClick={() => setViewMode("timeline")}
            >
              Discovery Timeline
            </button>
            <button
              role="tab"
              className={`tab ${viewMode === "map" ? "tab-active" : ""}`}
              onClick={() => setViewMode("map")}
            >
              Overview Map
            </button> */}
            <button
              role="tab"
              className={`tab ${viewMode === "hexmap" ? "tab-active" : ""}`}
              onClick={() => setViewMode("hexmap")}
            >
              Hex Map
            </button>
            <button
              role="tab"
              className={`tab ${viewMode === "graph" ? "tab-active" : ""}`}
              onClick={() => setViewMode("graph")}
            >
              Trial Graph
            </button>
            <button
              role="tab"
              className={`tab ${viewMode === "paramhex" ? "tab-active" : ""}`}
              onClick={() => setViewMode("paramhex")}
            >
              Param Hex
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-auto p-4">
        <section className="w-full h-full bg-base-100 p-4 rounded-lg border border-base-300">
          {/* {viewMode === "overview" && <ExplorationOverview />}
          {viewMode === "tree" && <TreeComparison />}
          {viewMode === "timeline" && <DiscoveryTimeline />}
          {viewMode === "map" && (
            <div className="flex flex-col h-full">
              <div className="flex items-center gap-4 mb-4">
                <span className="text-sm font-medium text-gray-600">
                  Program:
                </span>
                <div className="flex gap-2">
                  {(["gawk", "gcal", "grep"] as Program[]).map((p) => (
                    <button
                      key={p}
                      onClick={() => setMapProgram(p)}
                      className={`px-3 py-1 text-sm rounded ${
                        mapProgram === p
                          ? "bg-indigo-600 text-white"
                          : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <OverviewMap width={1100} height={700} program={mapProgram} />
            </div>
          )} */}
          {viewMode === "hexmap" && (
            <div className="flex flex-col h-full">
              <div className="flex items-center gap-4 mb-4">
                <span className="text-sm font-medium text-gray-600">
                  Program:
                </span>
                <div className="flex gap-2">
                  {(["gawk", "gcal", "grep"] as Program[]).map((p) => (
                    <button
                      key={p}
                      onClick={() => setMapProgram(p)}
                      className={`px-3 py-1 text-sm rounded ${
                        mapProgram === p
                          ? "bg-indigo-600 text-white"
                          : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <HexMap width={1100} height={700} program={mapProgram} />
            </div>
          )}
          {viewMode === "graph" && (
            <div className="flex flex-col h-full">
              <div className="flex items-center gap-4 mb-4">
                <span className="text-sm font-medium text-gray-600">
                  Program:
                </span>
                <div className="flex gap-2">
                  {(["gawk", "gcal", "grep"] as Program[]).map((p) => (
                    <button
                      key={p}
                      onClick={() => setMapProgram(p)}
                      className={`px-3 py-1 text-sm rounded ${
                        mapProgram === p
                          ? "bg-indigo-600 text-white"
                          : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <TrialGraph width={1100} height={700} program={mapProgram} />
            </div>
          )}
          {viewMode === "paramhex" && (
            <div className="flex flex-col h-full relative">
              <div className="flex items-center gap-4 mb-4">
                <span className="text-sm font-medium text-gray-600">
                  Program:
                </span>
                <div className="flex gap-2">
                  {(["gawk", "gcal", "grep"] as Program[]).map((p) => (
                    <button
                      key={p}
                      onClick={() => setMapProgram(p)}
                      className={`px-3 py-1 text-sm rounded ${
                        mapProgram === p
                          ? "bg-indigo-600 text-white"
                          : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <ParameterHexMap width={1200} height={800} program={mapProgram} />
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
