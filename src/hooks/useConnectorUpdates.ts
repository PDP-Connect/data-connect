// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useDispatch, useSelector } from 'react-redux';
import {
  removeConnectorUpdate,
} from '../state/store';
import type { RootState } from '../state/store';
import { checkConnectorUpdates } from './check-connector-updates';

export function useConnectorUpdates() {
  const dispatch = useDispatch();
  const updates = useSelector((state: RootState) => state.app.connectorUpdates);
  const lastUpdateCheck = useSelector(
    (state: RootState) => state.app.lastUpdateCheck
  );
  const isCheckingUpdates = useSelector(
    (state: RootState) => state.app.isCheckingUpdates
  );
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const checkForUpdates = useCallback(
    async (force = false) => {
      setError(null);
      return checkConnectorUpdates(dispatch, {
        force,
        onError: err => {
          const errorMsg =
            err instanceof Error ? err.message : 'Failed to check for updates';
          setError(errorMsg);
          console.error('Failed to check for updates:', err);
        },
      });
    },
    [dispatch]
  );

  const downloadConnector = useCallback(
    async (id: string) => {
      setDownloadErrors(prev => ({ ...prev, [id]: '' }));
      setDownloadingIds((prev) => new Set(prev).add(id));

      try {
        await invoke('download_connector', { id });
        // Keep new connectors in the list until the platform reload completes.
        // AvailableSourcesList uses the retained entry to keep the source's
        // stable card order while the newly installed platform is discovered.
        const update = updates.find(candidate => candidate.id === id);
        if (!update?.isNew) {
          dispatch(removeConnectorUpdate(id));
        }
        // Note: Caller is responsible for reloading platforms after successful download
        return true;
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : String(err || 'Failed to download connector');
        setDownloadErrors(prev => ({ ...prev, [id]: errorMsg }));
        console.error('Failed to download connector:', err);
        return false;
      } finally {
        setDownloadingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [dispatch, updates]
  );

  const isDownloading = useCallback(
    (id: string) => downloadingIds.has(id),
    [downloadingIds]
  );

  const hasUpdates = updates.length > 0;

  // Memoize count calculations to avoid recomputing on every render
  const { updateCount, newConnectorCount, updateableCount } = useMemo(() => ({
    updateCount: updates.length,
    newConnectorCount: updates.filter((u) => u.isNew).length,
    updateableCount: updates.filter((u) => u.hasUpdate).length,
  }), [updates]);

  return {
    updates,
    lastUpdateCheck,
    isCheckingUpdates,
    error,
    downloadErrors,
    hasUpdates,
    updateCount,
    newConnectorCount,
    updateableCount,
    checkForUpdates,
    downloadConnector,
    isDownloading,
  };
}
