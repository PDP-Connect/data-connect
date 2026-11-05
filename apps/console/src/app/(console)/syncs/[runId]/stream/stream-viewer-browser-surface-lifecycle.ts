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
 * cleanup. Each mount owns its transport: cleanup always retires it, even when
 * a mount notification or the viewer's own unmount throws, so a retired
 * viewer cannot keep posting input to the stream.
 */
export function mountBrowserSurfaceViewer({
  createViewer,
  node,
  onTransportMounted,
  onViewerMounted,
  transportRef,
  ...transportOptions
}: MountBrowserSurfaceViewerOptions): () => void {
  let disposed = false;
  const transport = createPdppRemoteSurfaceTransport(transportOptions);
  const viewer = createViewer(transport);
  transportRef.current = transport;
  transport.setPresentationAttachmentReady(transportOptions.presentationAttachmentReadyRef.current);
  try {
    const mountPromise = viewer.mount(node);
    if (!disposed) {
      onTransportMounted(transport);
      onViewerMounted(viewer);
    }
    mountPromise.catch((error) => {
      transportOptions.logDebug("surface.cdp-frame.viewer_mount_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    transportOptions.logDebug("surface.cdp-frame.viewer_mount_error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return () => {
    disposed = true;
    try {
      transport.setPresentationAttachmentReady(false);
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
}
