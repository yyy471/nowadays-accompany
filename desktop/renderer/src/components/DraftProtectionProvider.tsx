import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import { useConfirm } from '../ui';
import { DraftRegistry } from '../lib/drafts/registry';
import { TransitionController, type TransitionOptions, type TransitionResult } from '../lib/drafts/transition-controller';

interface DraftProtectionValue {
  registry: DraftRegistry;
  requestTransition: (options: Omit<TransitionOptions, 'confirm'>) => Promise<TransitionResult>;
  transitionPending: () => boolean;
}

const DraftProtectionContext = createContext<DraftProtectionValue | undefined>(undefined);

export function DraftProtectionProvider({ children }: { children: ReactNode }) {
  const confirm = useConfirm();
  const registryRef = useRef<DraftRegistry | null>(null);
  if (!registryRef.current) registryRef.current = new DraftRegistry();
  const controllerRef = useRef<TransitionController | null>(null);
  if (!controllerRef.current) controllerRef.current = new TransitionController(registryRef.current);
  const requestTransition = useCallback(
    (options: Omit<TransitionOptions, 'confirm'>): Promise<TransitionResult> => controllerRef.current!.request({ ...options, confirm }),
    [confirm]
  );
  const value = useMemo<DraftProtectionValue>(() => ({
    registry: registryRef.current!,
    requestTransition,
    transitionPending: () => controllerRef.current!.pending
  }), [requestTransition]);
  return <DraftProtectionContext.Provider value={value}>{children}</DraftProtectionContext.Provider>;
}

export function useDraftProtection(): DraftProtectionValue {
  const value = useContext(DraftProtectionContext);
  if (!value) throw new Error('useDraftProtection must be used inside DraftProtectionProvider');
  return value;
}
