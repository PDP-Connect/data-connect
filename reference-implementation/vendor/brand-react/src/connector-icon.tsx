// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

/** ConnectorIcon — manifest-declared brand mark from the connector index. */
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Monogram } from "./data-row.tsx";
import "./connector-icon.css";

export interface ConnectorBrandIcon {
  readonly backgroundColor?: string | null;
  readonly darkUrl?: string | null;
  readonly url?: string | null;
}

export interface ConnectorIconIndexLike {
  readonly brandIcons?: Record<string, ConnectorBrandIcon | null> | null;
}

interface ConnectorIconProps {
  className?: string;
  connectorId: string;
  connectorIndex?: ConnectorIconIndexLike | null | undefined;
  name: string;
}

function readThemeSnapshot(): "dark" | "light" {
  if (typeof document === "undefined") {
    return "light";
  }
  const root = document.documentElement;
  return root.dataset.theme === "dark" || root.classList.contains("dark") ? "dark" : "light";
}

function subscribeToThemeChange(onStoreChange: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return () => {};
  }
  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, { attributeFilter: ["class", "data-theme"], attributes: true });
  return () => observer.disconnect();
}

function getIconUrl(icon: ConnectorBrandIcon | null | undefined, theme: "dark" | "light"): string | null {
  if (!icon?.url) {
    return null;
  }
  return theme === "dark" && icon.darkUrl ? icon.darkUrl : icon.url;
}

function iconForConnector(
  brandIcons: ConnectorIconIndexLike["brandIcons"],
  connectorId: string
): ConnectorBrandIcon | null | undefined {
  const exact = brandIcons?.[connectorId];
  if (exact) {
    return exact;
  }

  // Reference-server connection summaries before the connector registry
  // migration use a short key (and sometimes underscores). The index remains
  // the only icon source; this merely recovers its manifest `connector_id`.
  const connectorKey = connectorId.replace(/^https:\/\/registry\.pdpp\.dev\/connectors\//, "").replaceAll("_", "-");
  return brandIcons?.[`https://registry.pdpp.dev/connectors/${connectorKey}`];
}

export function ConnectorIcon({ connectorId, connectorIndex, name, className }: ConnectorIconProps) {
  const theme = useSyncExternalStore(subscribeToThemeChange, readThemeSnapshot, readThemeSnapshot);
  const icon = iconForConnector(connectorIndex?.brandIcons, connectorId);
  const iconUrl = getIconUrl(icon, theme);
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const image = imageRef.current;
    if (iconUrl && image?.complete && image.naturalWidth === 0) {
      setFailedIconUrl(iconUrl);
    }
  }, [iconUrl]);

  if (iconUrl && failedIconUrl !== iconUrl) {
    const cls = ["pdpp-connector-icon", className].filter(Boolean).join(" ");
    return (
      <img
        aria-hidden="true"
        alt=""
        className={cls}
        ref={imageRef}
        onError={() => setFailedIconUrl(iconUrl)}
        onLoad={(event) => {
          if (event.currentTarget.naturalWidth === 0) {
            setFailedIconUrl(iconUrl);
          }
        }}
        src={iconUrl}
        style={icon?.backgroundColor ? { backgroundColor: icon.backgroundColor } : undefined}
      />
    );
  }
  return <Monogram className={className} name={name} tinted />;
}
