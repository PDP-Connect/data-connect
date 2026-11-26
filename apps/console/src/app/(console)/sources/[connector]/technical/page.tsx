// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { RecordroomShellWithPalette } from "../../../components/recordroom-shell-with-palette.tsx";
import {
	loadConnectorPageModel,
	SourceTechnicalDetails,
} from "../source-page.tsx";

export const dynamic = "force-dynamic";

export default async function TechnicalPage({
	params,
	searchParams,
}: {
	params: Promise<{ connector: string }>;
	searchParams: Promise<{ demo?: string; error?: string; message?: string }>;
}) {
	const { connector } = await params;
	const sp = await searchParams;
	const model =
		process.env.NODE_ENV !== "production" && sp.demo
			? (await import("../source-detail-demo-data.ts")).buildRecoveryDemoModel(
					16,
					true,
				)
			: await loadConnectorPageModel(decodeURIComponent(connector));
	return (
		<RecordroomShellWithPalette>
			<PageHeader title={`Technical details for ${model.displayName}`} />
			<p className="mb-4 text-muted-foreground">
				Ids, logs and measurements for whoever is helping you with a problem.
			</p>
			<p className="mb-6">
				<Link
					href={`/sources/${encodeURIComponent(model.connectionId)}${process.env.NODE_ENV !== "production" && sp.demo ? "?demo=atlas" : ""}`}
				>
					Back to {model.displayName}
				</Link>
			</p>
			<SourceTechnicalDetails
				model={model}
				now={new Date().toISOString()}
				dangerError={sp.error}
				dangerMessage={sp.message}
			/>
		</RecordroomShellWithPalette>
	);
}
