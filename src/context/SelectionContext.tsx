/**
 * Selection Context for Linked Brushing
 * Allows sharing selected trials between views
 */

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface Selection {
  program: string;
  trialIds: Set<number>;
}

interface SelectionContextType {
  selection: Selection | null;
  setSelection: (selection: Selection | null) => void;
  isSelected: (program: string, trialId: number) => boolean;
  clearSelection: () => void;
}

const SelectionContext = createContext<SelectionContextType | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selection, setSelectionState] = useState<Selection | null>(null);

  const setSelection = useCallback((newSelection: Selection | null) => {
    setSelectionState(newSelection);
  }, []);

  const isSelected = useCallback(
    (program: string, trialId: number) => {
      if (!selection) return false;
      if (selection.program !== program) return false;
      return selection.trialIds.has(trialId);
    },
    [selection]
  );

  const clearSelection = useCallback(() => {
    setSelectionState(null);
  }, []);

  return (
    <SelectionContext.Provider value={{ selection, setSelection, isSelected, clearSelection }}>
      {children}
    </SelectionContext.Provider>
  );
}

export function useSelection() {
  const context = useContext(SelectionContext);
  if (!context) {
    throw new Error('useSelection must be used within a SelectionProvider');
  }
  return context;
}
