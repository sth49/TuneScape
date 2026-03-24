import { useState } from "react";
import { GiHoneycomb } from "react-icons/gi";
import { TreeComparison } from "./components/TreeComparison";
import { ExplorationOverview } from "./components/ExplorationOverview";
import { DiscoveryTimeline } from "./components/DiscoveryTimeline";
import { OverviewMap } from "./components/OverviewMap";
import { HexMap } from "./components/HexMap";
import { TrialGraph } from "./components/TrialGraph";
import { ParameterHexMap } from "./components/ParameterHexMap";
import { RegionMap } from "./components/RegionMap";
import "./App.css";

// type ViewMode = "overview" | "tree" | "timeline" | "map" | "hexmap";
type ViewMode = "hexmap" | "graph" | "paramhex" | "regionmap";
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
            <div className="w-8 h-8 rounded-lg bg-amber-500 flex items-center justify-center">
              <GiHoneycomb className="text-white text-xl" />
            </div>
            <div>
              <h1 className="text-lg font-bold">SymComb</h1>
              {/* <span className="text-xs text-gray-500">
                Symbolic Execution Tuner Landscape
              </span> */}
            </div>
          </div>
        </div>

        {/* Program selector */}
        <div className="flex-none flex items-center gap-2">
          <span className="text-sm font-medium text-gray-500">Program:</span>
          <div className="flex gap-1">
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
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-hidden p-4">
        <section className="w-full h-full">
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
          <div className="flex flex-col h-full">
            <HexMap program={mapProgram} />
          </div>
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
          {viewMode === "regionmap" && (
            <div className="flex flex-col h-full">
              <div className="flex items-center gap-4 mb-3">
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
              <div className="flex-1 overflow-hidden">
                <RegionMap program={mapProgram} />
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
