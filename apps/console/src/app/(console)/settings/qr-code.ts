// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// The QR code for the address on the On card. The encoder is the vendored
// qrcodegen reference library; this file only turns its modules into one SVG
// path and decides when the code is shown.
import { qrcodegen } from "../../../vendor/qrcodegen.ts";
import { normalizeOrigin } from "./remote-origin.ts";

// A phone camera needs a light border of four modules around the code.
const QUIET_ZONE = 4;

/** The dark/light grid for `text`, row by row. Medium error correction. */
export function qrModules(text: string): boolean[][] {
  const code = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  return Array.from({ length: code.size }, (_, y) => Array.from({ length: code.size }, (_, x) => code.getModule(x, y)));
}

/** The SVG for `text`: a light square and one path of dark one-module squares, quiet zone included. */
export function qrSvg(text: string): { size: number; path: string } {
  const modules = qrModules(text);
  const parts: string[] = [];
  modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x + QUIET_ZONE},${y + QUIET_ZONE}h1v1h-1z`);
    });
  });
  return { size: modules.length + QUIET_ZONE * 2, path: parts.join("") };
}

/**
 * The address a phone can open from the internet: a public check of an https
 * address. A private-network or local address, or no address, gets no code.
 */
export function publicHttpsAddress(origin: string | null | undefined, vantage: string): string | null {
  // The code carries the address exactly as the card shows it.
  return origin && normalizeOrigin(origin)?.startsWith("https://") && vantage === "public" ? origin : null;
}
