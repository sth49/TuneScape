import { useState, useCallback, useEffect } from "react";
import { GiHoneycomb } from "react-icons/gi";
import { HexMap } from "./components/hexmap";
import { CartPanel } from "./components/hexmap/CartPanel";
import type { CartData } from "./components/hexmap/types";
import { ParameterPanel } from "./components/ParameterPanel";
import { TunerSummary } from "./components/TunerSummary";
import { TUNER_NAMES, type TunerType } from "./utils/hexMapUtils";
import "./App.css";

type Program = "gawk" | "gcal" | "grep";

function App() {
  const [mapProgram, setMapProgram] = useState<Program>("gawk");
  const [selectedParam, setSelectedParam] = useState<string | null>(null);
  const [selectedTuners, setSelectedTuners] = useState<Set<TunerType>>(
    () => new Set(TUNER_NAMES),
  );
  const [cartIds, setCartIds] = useState<Set<number>>(() => new Set());
  const [cartData, setCartData] = useState<CartData | null>(null);
  const [paramSeparability, setParamSeparability] = useState<Record<string, number>>({});

  const handleParamSelect = useCallback((param: string | null) => {
    setSelectedParam(param);
  }, []);

  const handleToggleTuner = useCallback((tuner: TunerType) => {
    setSelectedTuners((prev) => {
      const next = new Set(prev);
      if (next.has(tuner)) {
        if (next.size > 1) next.delete(tuner);
      } else {
        next.add(tuner);
      }
      return next;
    });
  }, []);

  const handleCartToggle = useCallback((clusterId: number) => {
    setCartIds((prev) => {
      const next = new Set(prev);
      if (next.has(clusterId)) next.delete(clusterId);
      else next.add(clusterId);
      return next;
    });
  }, []);

  const handleClearCart = useCallback(() => {
    setCartIds(new Set());
    setCartData(null);
  }, []);

  // Clear cart when program changes
  useEffect(() => {
    setCartIds(new Set());
    setCartData(null);
  }, [mapProgram]);

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
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-hidden">
        <div className="flex flex-row h-full w-full">
          <div className="w-[20%] min-w-[240px] flex flex-col h-full overflow-hidden">
            <div className="flex-shrink-0 py-2">
              <TunerSummary
                program={mapProgram}
                selectedTuners={selectedTuners}
                onToggleTuner={handleToggleTuner}
                onSetAllTuners={setSelectedTuners}
              />
            </div>
            <div className="flex-1 min-h-0">
              <ParameterPanel
                program={mapProgram}
                selectedParam={selectedParam}
                onParamSelect={handleParamSelect}
                interactive={selectedParam !== null}
                separability={paramSeparability}
              />
            </div>
          </div>

          <div className="mx-1 my-2 border-l border-gray-200" />
          <div className="flex-1 min-w-0 h-full">
            <HexMap
              program={mapProgram}
              selectedParam={selectedParam}
              onParamSelect={handleParamSelect}
              selectedTuners={selectedTuners}
              onToggleTuner={handleToggleTuner}
              cartIds={cartIds}
              onCartToggle={handleCartToggle}
              onCartDataUpdate={setCartData}
              onParamSeparability={setParamSeparability}
            />
          </div>
          <div className="mx-1 my-2 border-l border-gray-200" />

          <div className="w-[20%] min-w-[260px] flex flex-col h-full overflow-y-auto">
            <CartPanel
              cartIds={cartIds}
              cartData={cartData}
              selectedTuners={selectedTuners}
              onRemove={handleCartToggle}
              onClear={handleClearCart}
            />
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
