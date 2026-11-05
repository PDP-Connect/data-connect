// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RemoteSurfaceViewerHandle } from "@opendatalabs/remote-surface/client";

import { createPdppRemoteSurfaceTransport, type PdppRemoteSurfaceTransport } from "./stream-viewer-remote-surface-transport.ts";

type TransportOptions = Parameters<typeof createPdppRemoteSurfaceTransport>[0];

export interface MountBrowserSurfaceViewerOptions extends TransportOptions {
  /** Builds the Remote Surface viewer over this mount's transport. */
  createViewer: (transport: PdppRemoteSurfaceTransport) => RemoteSurfaceViewerHandle;
  node: HTMLElement;
  onTransportMounted: (transport: PdppRemoteSurfaceTransport | null) => void;
  onViewerMounted: (viewer: RemoteSurfaceViewerHandle | null) => void;
  /** Identifies the live mount; a stale cleanup must not clear a newer mount. */
  transportRef: { current: PdppRemoteSurfaceTransport | null };
}

/**
 * Mounts one Remote Surface viewer over one PDPP transport and returns its
 * cleanup. Each mount owns its transport and retires it through one idempotent
 * release, used both for normal cleanup and for a failed initialization, even
 * when a mount notification or the viewer's own unmount throws, so a retired
 * viewer cannot keep posting input to the stream.
 *
 * Presentation-attachment readiness belongs to the stream, not to a viewer:
 * a mount never writes it, so replacing a viewer cannot mark a still-attached
 * stream as detached.
 */
export function mountBrowserSurfaceViewer({
  createViewer,
  node,
  onTransportMounted,
  onViewerMounted,
  transportRef,
  ...transportOptions
}: MountBrowserSurfaceViewerOptions): () => void {
  const transport = createPdppRemoteSurfaceTransport(transportOptions);
  const viewer = createViewer(transport);
  transportRef.current = transport;
  let released = false;
  const logMountError = (error: unknown) =>
    transportOptions.logDebug("surface.cdp-frame.viewer_mount_error", {
      error: error instanceof Error ? error.message : String(error),
    });
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    try {
      if (transportRef.current === transport) {
        transportRef.current = null;
        onTransportMounted(null);
        onViewerMounted(null);
      }
    } finally {
      try {
        // Permit synchronous SDK cleanup before retiring its transport.
        viewer.unmount();
      } finally {
        transport.dispose();
      }
    }
  };
  try {
    viewer.mount(node).catch((error) => {
      // A retired mount's late failure is not an event of the live stream.
      if (!released) {
        logMountError(error);
      }
    });
    onTransportMounted(transport);
    onViewerMounted(viewer);
  } catch (error) {
    logMountError(error);
    try {
      release();
    } catch (releaseError) {
      logMountError(releaseError);
    }
  }
  return release;
}
