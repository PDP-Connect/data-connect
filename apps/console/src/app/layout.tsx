// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { brandMono, brandSans } from "@pdpp/brand/fonts";
import { LAUNCH_COLORS } from "@pdpp/brand/launch-colors";
import { ThemeProvider } from "@pdpp/operator-ui/components/theme/theme-provider";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import DensityProvider from "@/components/density/density-provider.tsx";
import { DENSITY_KEY, normalizeDensity } from "@/components/density/density-state.ts";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";
import { getProductIdentity } from "./(console)/lib/product-identity.ts";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const identity = getProductIdentity();
  const title = identity.name;
  const description = identity.description;

  return {
    // iOS home-screen launch. statusBarStyle "default" lets iOS pick the bar
    // treatment per system appearance (light bar on light, dark bar on dark)
    // instead of forcing one — so the launch reads correctly under both themes,
    // matching the theme-following first-paint guard below. The apple-icon.tsx
    // file convention supplies the touch icon itself.
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: identity.name,
    },
    description,
    metadataBase: new URL("https://pdpp.dev"),
    openGraph: {
      description,
      title,
      type: "website",
    },
    title,
    twitter: {
      card: "summary_large_image",
      description,
      title,
    },
  };
}

export const viewport = {
  initialScale: 1,
  // Theme-following chrome color: the browser/PWA picks the entry matching the
  // OS scheme, so the splash/chrome never flashes the wrong color before the
  // app paints. Both colors are sourced from LAUNCH_COLORS (the single source
  // of truth derived from the `--background` tokens) — no drifting hex here.
  themeColor: [
    { color: LAUNCH_COLORS.dark, media: "(prefers-color-scheme: dark)" },
    { color: LAUNCH_COLORS.light, media: "(prefers-color-scheme: light)" },
  ],
  width: "device-width",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const density = normalizeDensity(cookieStore.get(DENSITY_KEY)?.value);

  return (
    <html
      className={cn(brandSans.variable, brandMono.variable)}
      data-density={density}
      lang="en"
      suppressHydrationWarning
    >
      <body>
        <ThemeProvider>
          <DensityProvider initialDensity={density}>
            <TooltipProvider>{children}</TooltipProvider>
          </DensityProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
