"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  CopyMono,
  RecordBody,
  Sheet,
  SheetBody,
  SheetFoot,
  SheetHead,
  SheetTitle,
} from "@pdpp/brand-react";
import type {
  ExplorerBlobAffordance,
  ExplorerPeekData,
} from "@pdpp/operator-ui/components/views/records-explorer-view";
import { formatStorageBytes } from "@pdpp/operator-ui/lib/storage-footprint";
import { humanizeFieldLabel } from "@pdpp/display";
import type { ParentBackLink, RelatedLink, ReverseChildListLink } from "../sources/lib/relationships.ts";

const IMAGE_MIME_RE = /^image\//i;

export interface RecordInspectorRelationships {
  parentBackLinks: ParentBackLink[];
  relatedLinks: RelatedLink[];
  reverseChildListLinks: ReverseChildListLink[];
}

export interface RecordInspectorProps {
  record: ExplorerPeekData | null;
  relationships?: RecordInspectorRelationships | null;
  streamRecordsHref?: string | null;
  recordHref?: string | null;
}

function parseRecordBody(record: ExplorerPeekData): Record<string, unknown> {
  if (!record.bodyJson) {
    return {};
  }
  try {
    const parsed = JSON.parse(record.bodyJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function blobAffordance(record: ExplorerPeekData): ExplorerBlobAffordance | null {
  for (const field of record.fields) {
    if (field.blobAffordance) {
      return field.blobAffordance;
    }
  }
  return null;
}

// `undefined`/`null` (unmeasured, or a record read via a path that does not
// carry `record_json_bytes`) renders `—`, never a fabricated `0 B`.
function recordSizeLabel(sizeBytes: number | null | undefined): string {
  return typeof sizeBytes === "number" ? formatStorageBytes(sizeBytes) : "—";
}

function declaredBlobMime(body: Record<string, unknown>, fieldName: string): string | undefined {
  const ref = body[fieldName];
  if (!(ref && typeof ref === "object") || Array.isArray(ref)) {
    return;
  }
  const mime = (ref as { mime_type?: unknown }).mime_type;
  return typeof mime === "string" && mime.length > 0 ? mime : undefined;
}

function BlobAffordanceView({
  affordance,
  mimeType,
}: {
  affordance: ExplorerBlobAffordance;
  mimeType: string | undefined;
}) {
  if (affordance.state === "unavailable") {
    return <span className="rr-x-blob rr-x-blob--off">File unavailable.</span>;
  }
  if (!affordance.href) {
    return null;
  }
  const isImage = mimeType ? IMAGE_MIME_RE.test(mimeType) : false;
  // `undefined`/`null` (unmeasured) renders no parenthetical rather than a
  // fabricated size — never "(0 B)".
  const sizeLabel = typeof affordance.sizeBytes === "number" ? formatStorageBytes(affordance.sizeBytes) : null;
  return (
    <div className="rr-x-blob">
      {isImage ? (
        // biome-ignore lint/correctness/useImageSize: a remote record blob has no known intrinsic dimensions; the CSS box constrains it.
        <img alt={humanizeFieldLabel(affordance.fieldName)} className="rr-x-blob__img" src={affordance.href} />
      ) : null}
      <a className="rr-x-blob__open" href={affordance.href}>
        Open file →{sizeLabel ? ` (${sizeLabel})` : ""}
      </a>
    </div>
  );
}

export function RecordInspector({ record, relationships, streamRecordsHref, recordHref }: RecordInspectorProps) {
  if (!record) {
    return null;
  }

  const body = parseRecordBody(record);
  const declaredTypes: Record<string, string> = {};
  for (const field of record.fields) {
    if (field.type) {
      declaredTypes[field.name] = field.type;
    }
  }
  const withheld = record.fields.filter((field) => field.state === "withheld");
  const visibleFieldCount = record.fields.filter((field) => field.state === "visible").length;
  const blob = blobAffordance(record);
  const blobMime = blob ? declaredBlobMime(body, blob.fieldName) : undefined;
  const relationGroups = [
    ...(relationships?.parentBackLinks ?? []).map((item) => ({ href: item.href, label: `${humanizeFieldLabel(item.parentStream)} · ${humanizeFieldLabel(item.childParentKeyField)}` })),
    ...(relationships?.relatedLinks ?? []).filter((item) => item.navigable && item.href).map((item) => ({ href: item.href as string, label: humanizeFieldLabel(item.relation) })),
    ...(relationships?.reverseChildListLinks ?? []).map((item) => ({ href: item.href, label: humanizeFieldLabel(item.childStream) })),
  ];
  const advisoryRelations = (relationships?.relatedLinks ?? []).filter((item) => !(item.navigable && item.href));

  return (
    <Sheet className="rr-inspector">
      <SheetHead>
        <SheetTitle>{humanizeFieldLabel(record.stream)}</SheetTitle>
        <p className="rr-x-facets__note">{record.connectionDisplayName ?? "Data source"}</p>
      </SheetHead>
      <SheetBody>
        {record.error ? (
          <p className="rr-x-warn__msg">This could not be loaded. Try again.</p>
        ) : (
          <RecordBody blobAffordance={blob ?? undefined} data={body} declaredTypes={declaredTypes} stream={record.stream} />
        )}
        {blob ? <BlobAffordanceView affordance={blob} mimeType={blobMime} /> : null}
        {relationGroups.length > 0 ? (
          <div className="rr-x-rel">
            <span className="rr-ex-keep__label">Related records</span>
            {relationGroups.map((item) => <a className="rr-x-rel__row rr-x-rel__row--link" href={item.href} key={`${item.href}:${item.label}`}>{item.label}</a>)}
          </div>
        ) : null}
      </SheetBody>
      <SheetFoot>
        {streamRecordsHref ? <a className="rr-x-stream-all" href={streamRecordsHref}>Browse this kind →</a> : null}
        <details className="rr-x-raw rr-x-inspector-details">
          <summary>Details</summary>
          <div className="rr-x-inspector-details__body">
            {recordHref ? <a href={recordHref}>Open full record</a> : null}
            <div className="rr-x-compiled">
              <span className="rr-x-compiled__label">Record ID</span>
              <CopyMono text={record.recordId} />
            </div>
            <div className="rr-x-compiled">
              <span className="rr-x-compiled__label">Read request</span>
              <CopyMono text={`GET ${record.readUrl}`} />
            </div>
            <dl className="rr-x-inspector-details__fields">
              {record.fields.map((field) => (
                <div className="rr-x-inspector-details__row" key={field.name}>
                  <dt>{humanizeFieldLabel(field.name)} · {field.name}</dt>
                  <dd>{field.type ?? "Type not declared"} · {field.state}</dd>
                </div>
              ))}
            </dl>
            <p>{visibleFieldCount} of {record.fields.length} fields readable</p>
            {withheld.length > 0 ? <p>Withheld fields: {withheld.map((field) => field.name).join(" · ")}</p> : null}
            {advisoryRelations.map((item) => (
              <p key={`${item.relation}:${item.cardinality}`}>
                {humanizeFieldLabel(item.relation)} · {item.advisory ?? "Related records cannot be opened from here."}
              </p>
            ))}
            <p>Record size: {recordSizeLabel(record.recordSizeBytes)}</p>
            {record.bodyJson ? (
              <details>
                <summary>Raw JSON</summary>
                <pre>{record.bodyJson}</pre>
              </details>
            ) : null}
            {blob?.state === "unavailable" ? <p>{blob.reason ?? "File unavailable for this view."}</p> : null}
          </div>
        </details>
      </SheetFoot>
    </Sheet>
  );
}
