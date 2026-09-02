// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-only static asset route for the consent design preview's source
// icons.
//
//   GET /_ref/design/consent/icons/:name
//
// Serves the bundled connector icon SVGs/PNGs used by
// `server/routes/ref-design-consent-mock.ts` to render real platform logos
// in the source list instead of initials. A sibling lane is adding icon
// metadata to the manifests for the live picker; this route stands in for
// that pipeline on the mock route only, using local files copied from
// PDP-Connect/data-connectors `connectors/*/icons/*`.
//
// Every file is read once at module load (mirrors `HOSTED_UI_CSS` in
// `hosted-ui.ts`) and served from memory — this route touches no store and
// reads no owner data, same posture as the rest of `/_ref/design/consent`.
//
// Auth posture: owner session, same as every other `/_ref/` surface.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MiddlewareHandler, RouteArg } from "./_route-contract.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(__dirname, "..", "assets", "source-icons");

interface RouteRequest {
  readonly params?: Record<string, unknown> | null;
}

interface RouteResponse {
  send: (body: string | Buffer) => unknown;
  setHeader: (name: string, value: string) => unknown;
  status: (code: number) => RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => void;

interface AppLike {
  get: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
}

export interface MountRefDesignConsentIconsContext {
  readonly requireOwnerSession: MiddlewareHandler;
}

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  svg: "image/svg+xml",
};

// Filename (without extension) -> bundled asset filename. Only sources with
// a real connector icon in the bundle appear here; every other mock source
// falls back to the neutral placeholder rendered inline by the mock route.
//
// The upstream PDP-Connect/data-connectors icon set also includes heb.png,
// oura.png, and wholefoods.png, but this repo's root `.gitignore` excludes
// `*.png` — those three would not exist in a fresh checkout, and no mock
// source in `ref-design-consent-mock.ts` references them, so they are
// deliberately left out of this list rather than shipped as a dead
// `readFileSync` that crashes server boot for anyone without a local copy.
const ICON_FILES = [
  "amazon.svg",
  "chatgpt.svg",
  "claude.svg",
  "doordash.svg",
  "github.svg",
  "goodreads.svg",
  "icloud.svg",
  "instagram.svg",
  "linkedin.svg",
  "shop.svg",
  "spotify.svg",
  "steam.svg",
  "tinder.svg",
  "uber.svg",
  "youtube.svg",
] as const;

const ICONS = new Map<string, { body: Buffer; contentType: string }>();
for (const filename of ICON_FILES) {
  const ext = filename.slice(filename.lastIndexOf(".") + 1);
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    continue;
  }
  ICONS.set(filename, { body: readFileSync(join(ICONS_DIR, filename)), contentType });
}

// GET /_ref/design/consent/icons/:name
export function mountRefDesignConsentIcons(app: AppLike, ctx: MountRefDesignConsentIconsContext): void {
  app.get(
    "/_ref/design/consent/icons/:name",
    ctx.requireOwnerSession,
    (req: RouteRequest, res: RouteResponse) => {
      const name = typeof req.params?.name === "string" ? req.params.name : "";
      const icon = ICONS.get(name);
      if (!icon) {
        res.status(404).send("");
        return;
      }
      res.setHeader("Content-Type", icon.contentType);
      res.setHeader("Cache-Control", "public, max-age=300");
      res.send(icon.body);
    }
  );
}
