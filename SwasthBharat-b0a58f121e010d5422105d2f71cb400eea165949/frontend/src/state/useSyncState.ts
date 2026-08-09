/**
 * React binding for the sync manager.
 *
 * The manager itself is a plain class outside React on purpose: sync has to keep running
 * across route changes and component unmounts. A worker who submits a screening and
 * immediately navigates home must not cancel the upload. React only observes it.
 */

import { useEffect, useState } from 'react';
import { syncManager, type SyncState } from '@/lib/sync';

export function useSyncState(): SyncState {
  const [state, setState] = useState<SyncState>(() => syncManager.getState());

  useEffect(() => syncManager.subscribe(setState), []);

  return state;
}

export { syncManager };
