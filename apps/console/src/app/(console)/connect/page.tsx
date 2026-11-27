// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { RecordroomShellWithPalette } from "../components/recordroom-shell-with-palette.tsx";
import { loadConnect } from "./load-connect.ts";
import { ConnectView } from "./connect-page.tsx";
export const dynamic = "force-dynamic";
export default async function ConnectPage({ searchParams }: { searchParams: Promise<{ demo?: string }> }) {
  const { demo } = await searchParams;
  const model = await loadConnect(demo);
  return <RecordroomShellWithPalette><ConnectView {...model} /></RecordroomShellWithPalette>;
}
