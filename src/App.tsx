import { useState, useCallback, useEffect } from "react";
import { GiHoneycomb } from "react-icons/gi";
import { HexMap } from "./components/hexmap";
import { CartPanel } from "./components/hexmap/CartPanel";
import type { CartData } from "./components/hexmap/types";
import {
  getTunersForProgram,
  isHPOProgram,
  metricLabelFor,
  formatMetricValue,
  type TunerType,
} from "./utils/hexMapUtils";
import "./App.css";

type Domain = "SE" | "ML";
type Program =
  | "gawk"
  | "gcal"
  | "grep"
  | "adult"
  | "phoneme";

const PROGRAMS_BY_DOMAIN: Record<Domain, Program[]> = {
  SE: ["gawk", "gcal", "grep"],
  // covertype joins this list once its trial run finishes preprocessing.
  ML: ["adult", "phoneme"],
};

const DOMAIN_LABELS: Record<Domain, string> = {
  SE: "SE",
  ML: "ML",
};

const PROGRAM_LABELS: Record<Domain, string> = {
  SE: "Program",
  ML: "Task",
};

function App() {
  const [mapDomain, setMapDomain] = useState<Domain>("SE");
  const [mapProgram, setMapProgram] = useState<Program>("gawk");
  const [selectedParam, setSelectedParam] = useState<string | null>(null);
  // Tuner subset shown depends on the current program (SE vs HPO).
  const [selectedTuners, setSelectedTuners] = useState<Set<TunerType>>(
    () => new Set(getTunersForProgram("gawk")),
  );
  const [cartIds, setCartIds] = useState<Set<number>>(() => new Set());
  const [cartData, setCartData] = useState<CartData | null>(null);
  const [hoveredClusterId, setHoveredClusterId] = useState<number | null>(null);

  const handleParamSelect = useCallback((param: string | null) => {
    setSelectedParam(param);
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

  // Clear cart + reset tuner selection when program changes (SE/HPO have
  // different tuner sets — selectedTuners must match the current program).
  useEffect(() => {
    setCartIds(new Set());
    setCartData(null);
    setSelectedTuners(new Set(getTunersForProgram(mapProgram)));
    setSelectedParam(null);
  }, [mapProgram]);

  // When domain switches, jump to the first program in that domain.
  const handleDomainChange = useCallback((d: Domain) => {
    setMapDomain(d);
    setMapProgram(PROGRAMS_BY_DOMAIN[d][0]);
  }, []);

  // Keep domain in sync if mapProgram is changed externally (e.g. on load).
  useEffect(() => {
    const expected: Domain = isHPOProgram(mapProgram) ? "ML" : "SE";
    if (expected !== mapDomain) setMapDomain(expected);
  }, [mapProgram, mapDomain]);

  return (
    <div className="w-[100vw] h-[100vh] flex flex-col bg-base-100">
      {/* Header */}
      <header className="navbar bg-base-200 px-6 shadow-sm min-h-0 h-12">
        <div className="flex-1 gap-3">
          <div className="flex items-center gap-2">
            <GiHoneycomb className="text-amber-400 text-xl" />
            <h1 className="text-lg font-bold">TuneScape</h1>
          </div>
        </div>

        <div className="flex-none flex items-center gap-4">
          {/* Domain (SE / ML) toggle */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-500">Domain:</span>
            <div className="flex gap-1">
              {(Object.keys(PROGRAMS_BY_DOMAIN) as Domain[]).map((d) => (
                <button
                  key={d}
                  onClick={() => handleDomainChange(d)}
                  className={`px-3 py-1 text-sm rounded ${
                    mapDomain === d
                      ? "bg-slate-700 text-white"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  {DOMAIN_LABELS[d]}
                </button>
              ))}
            </div>
          </div>

          {/* Program / Task selector — buttons depend on the active domain */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-500">
              {PROGRAM_LABELS[mapDomain]}:
            </span>
            <div className="flex gap-1">
              {PROGRAMS_BY_DOMAIN[mapDomain].map((p) => (
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
          <div className="flex-1 min-w-0 h-full">
            <HexMap
              program={mapProgram}
              selectedParam={selectedParam}
              onParamSelect={handleParamSelect}
              selectedTuners={selectedTuners}
              cartIds={cartIds}
              onCartToggle={handleCartToggle}
              onCartDataUpdate={setCartData}
              externalHoveredClusterId={hoveredClusterId}
              onHoverChange={setHoveredClusterId}
            />
          </div>
          <div className="mx-1 my-2 border-l border-gray-200" />

          <div className="w-[20%] min-w-[260px] flex flex-col h-full overflow-hidden">
            <CartPanel
              cartIds={cartIds}
              cartData={cartData}
              selectedTuners={selectedTuners}
              onRemove={handleCartToggle}
              onClear={handleClearCart}
              hoveredClusterId={hoveredClusterId}
              onHoverChange={setHoveredClusterId}
              metricLabel={metricLabelFor(mapProgram)}
              formatMetric={(v) =>
                formatMetricValue(v, mapProgram, cartData?.totalUniqueBranches)
              }
            />
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
