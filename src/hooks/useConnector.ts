import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useDispatch, useSelector } from 'react-redux';
import { deleteRun, startRun, updateRunStatus, stopRun } from '../state/store';
import type { RootState } from '../state/store';
import type { Platform, Run } from '../types';
import { getPlatformRegistryEntry } from '@/lib/platform/utils';
import {
  trackCollectionFailed,
  trackCollectionStarted,
} from '@/lib/telemetry/events';
import { durationSince } from '@/lib/telemetry/client';

const DUPLICATE_ACTIVE_RUN_ERROR_CODE = 'DUPLICATE_ACTIVE_RUN';
const PDPP_NETWORK_RUNTIME = 'pdpp-network';
const GITHUB_PDPP_STREAM_BY_SCOPE: Record<string, string> = {
  'github.profile': 'user',
  'github.repositories': 'repositories',
  'github.starred': 'starred',
};

function isDuplicateStartError(error: unknown): boolean {
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : String(error);
  return message.includes(DUPLICATE_ACTIVE_RUN_ERROR_CODE);
}

function getPdppStreams(platform: Platform): string[] {
  if (platform.id !== 'github-pdpp') return [];
  return (platform.scopes ?? [])
    .map(scope => GITHUB_PDPP_STREAM_BY_SCOPE[scope])
    .filter((stream): stream is string => Boolean(stream));
}

async function startInstalledPdppConnectorRun(
  runId: string,
  platform: Platform
): Promise<void> {
  await invoke('start_installed_pdpp_connector_run', {
    request: {
      runId,
      connectorId: platform.id,
      collectionMode: 'incremental',
      streams: getPdppStreams(platform),
      githubToken: null,
    },
  });
}

export function useConnector() {
  const dispatch = useDispatch();
  const runs = useSelector((state: RootState) => state.app.runs);

  const startImport = useCallback(
    async (platform: Platform) => {
      const runId = `${platform.id}-${Date.now()}`;
      const source = getPlatformRegistryEntry(platform)?.id ?? platform.id;

      const newRun: Run = {
        id: runId,
        platformId: platform.id,
        filename: platform.filename,
        runtime: platform.runtime,
        isConnected: false,
        startDate: new Date().toISOString(),
        status: 'running',
        url: platform.connectURL || '',
        company: platform.company,
        name: platform.name,
        logs: '',
      };

      dispatch(startRun(newRun));
      trackCollectionStarted({
        collectionRunId: runId,
        source,
        authMode: 'interactive',
      });

      // The installed PDPP host streams progress and terminal state through
      // `connector-status`. Its command response arrives only after the
      // subprocess finishes, so waiting here would leave /connect without a
      // run id (and therefore without live busy/progress UI).
      if (platform.runtime === PDPP_NETWORK_RUNTIME) {
        void startInstalledPdppConnectorRun(runId, platform).catch((error) => {
          if (isDuplicateStartError(error)) {
            dispatch(deleteRun(runId));
            return;
          }

          console.error('Failed to start installed PDPP connector run:', error);
          // A host-side failure normally emits its own terminal event. This
          // only closes the UI state when no event has already done so.
          dispatch(
            updateRunStatus({
              runId,
              status: 'error',
              endDate: new Date().toISOString(),
              onlyIfRunning: true,
            })
          );
        });
        return runId;
      }

      try {
        const simulateNoChrome =
          typeof window !== 'undefined' && window.localStorage?.getItem?.('dataconnect_simulate_no_chrome') === 'true';

        await invoke('start_connector_run', {
          runId,
          platformId: platform.id,
          filename: platform.filename,
          company: platform.company,
          name: platform.name,
          connectUrl: platform.connectURL || '',
          runtime: platform.runtime || null,
          simulateNoChrome,
        });
      } catch (error) {
        if (isDuplicateStartError(error)) {
          dispatch(deleteRun(runId));
          return null;
        }

        console.error('Failed to start connector run:', error);
        dispatch(
          updateRunStatus({
            runId,
            status: 'error',
            endDate: new Date().toISOString(),
          })
        );
        trackCollectionFailed({
          collectionRunId: runId,
          source,
          durationMs: durationSince(newRun.startDate),
          error,
        });
      }

      return runId;
    },
    [dispatch]
  );

  const stopExport = useCallback(
    async (runId: string) => {
      try {
        const run = runs.find(candidate => candidate.id === runId);
        if (run?.runtime === PDPP_NETWORK_RUNTIME) {
          await invoke('stop_installed_pdpp_connector_run', { runId });
          // The PDPP host emits STOPPED after its subprocess is actually
          // reaped. Keep the source card active until then.
        } else {
          dispatch(stopRun(runId));
          await invoke('stop_connector_run', { runId });
        }
      } catch (error) {
        console.log('Stop connector run (window may be closed):', error);
      }
    },
    [dispatch, runs]
  );

  const getRunById = useCallback(
    (runId: string) => {
      return runs.find((r) => r.id === runId);
    },
    [runs]
  );

  return {
    runs,
    startImport,
    stopExport,
    getRunById,
  };
}
