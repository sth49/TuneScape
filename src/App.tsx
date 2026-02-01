import { useState, useEffect } from 'react';
import { DecisionTreeComparison } from './components/DecisionTreeComparison';
import type { DecisionTreeData } from './types/data';
import './App.css';

const TUNER_COLORS: Record<string, string> = {
  SymTuner: '#4f46e5',
  CMA_ES: '#10b981',
  Genetic: '#f59e0b',
  SuccessiveHalving: '#ef4444',
};

const TUNER_LABELS: Record<string, string> = {
  SymTuner: 'SymTuner',
  CMA_ES: 'CMA-ES',
  Genetic: 'Genetic',
  SuccessiveHalving: 'Successive Halving',
};

function App() {
  const [data, setData] = useState<DecisionTreeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/data/decision_tree_data.json')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load data');
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

  if (loading) {
    return <div className="loading">Loading data...</div>;
  }

  if (error || !data) {
    return <div className="error">Error: {error || 'No data'}</div>;
  }

  // Get available tuners from first program
  const programs = Object.keys(data);
  const tuners = programs.length > 0 ? Object.keys(data[programs[0]]) : [];

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="logo">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="8" fill="#4f46e5"/>
              <path d="M8 22V10h4v12H8zm6-8v8h4v-8h-4zm6-4v12h4V10h-4z" fill="white"/>
            </svg>
          </div>
          <div className="header-title">
            <h1>TunerVis</h1>
            <span className="header-subtitle">Parameter Space Exploration</span>
          </div>
        </div>
        <div className="header-stats">
          {tuners.map((tuner) => (
            <div key={tuner} className="stat-badge">
              <span
                className="stat-color-dot"
                style={{ backgroundColor: TUNER_COLORS[tuner] || '#6b7280' }}
              />
              <span className="stat-label">{TUNER_LABELS[tuner] || tuner}</span>
            </div>
          ))}
        </div>
      </header>

      <main className="main-single">
        <DecisionTreeComparison />
      </main>
    </div>
  );
}

export default App;
