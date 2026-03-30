import { useState, useCallback } from "react";
import { GiHoneycomb } from "react-icons/gi";
import { VscSplitHorizontal } from "react-icons/vsc";
import { HexMap, type DrillState } from "./components/HexMap";
import "./App.css";

type Program = "gawk" | "gcal" | "grep";

function App() {
  const [mapProgram, setMapProgram] = useState<Program>("gawk");
  const [splitView, setSplitView] = useState(false);

  // Drill state from the left (primary) view
  const [leftDrillState, setLeftDrillState] = useState<DrillState | null>(null);
  // Whether the right view is synced to the left
  const [syncEnabled, setSyncEnabled] = useState(false);

  const handleLeftDrillChange = useCallback((state: DrillState) => {
    setLeftDrillState(state);
  }, []);

  const handleSyncToggle = useCallback(() => {
    setSyncEnabled((v) => !v);
  }, []);

  return (
    <div className="w-[100vw] h-[100vh] flex flex-col bg-base-100">
      {/* Header */}
      <header className="navbar bg-base-200 px-6 shadow-sm min-h-0 h-12">
        <div className="flex-1 gap-3">
          <div className="flex items-center gap-2">
            <GiHoneycomb className="text-amber-400 text-xl" />
            <h1 className="text-lg font-bold">SymComb</h1>
          </div>
        </div>

        <div className="flex-none flex items-center gap-4">
          {/* Program selector */}
          <div className="flex items-center gap-2">
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

          {/* Split view toggle */}
          <button
            onClick={() => setSplitView((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1 text-sm rounded ${
              splitView
                ? "bg-indigo-600 text-white"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
            title="Split view"
          >
            <VscSplitHorizontal className="text-base" />
            Split
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-hidden">
        {splitView ? (
          <div className="flex h-full">
            <div className="flex-1 h-full border-r border-gray-200 min-w-0">
              <HexMap
                program={mapProgram}
                compact
                onDrillStateChange={handleLeftDrillChange}
              />
            </div>
            <div className="flex-1 h-full min-w-0">
              <HexMap
                program={mapProgram}
                compact
                syncDrillState={syncEnabled ? leftDrillState : null}
                showSyncButton
                syncEnabled={syncEnabled}
                onSyncToggle={handleSyncToggle}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col h-full p-4">
            <HexMap program={mapProgram} />
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
