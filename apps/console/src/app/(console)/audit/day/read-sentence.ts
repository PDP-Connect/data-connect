// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { humanizeFieldLabel } from "@pdpp/display";
import type { AppReadEntry } from "../../lib/ref-client.ts";
export function readSentence(read: AppReadEntry, source: string | null): string {
  const kind = read.record_kind ? humanizeFieldLabel(read.record_kind).toLowerCase() : "records";
  const from = source ? ` from ${source}` : "";
  const results = read.records === null ? "" : ` · ${read.records} results`;
  switch (read.shape) {
    case "schema": return "Asked what it may read";
    case "stream_list": return "Listed the kinds of records it may read";
    case "connector_list": return "Listed the data sources it may read";
    case "stream_metadata": return `Asked about ${kind}${from}`;
    case "record_list": return `Listed ${read.records === null ? "" : `${read.records} `}${kind}${from}`;
    case "record_detail": return `Opened one record${from}`;
    case "field_window": return `Read part of a field${from}`;
    case "search": case "search_hybrid": case "search_semantic": return `Searched ${source ? `your ${source} data` : "across your data sources"}${results}`;
    case "stream_aggregate": {
      const action = read.metric === "sum" ? "Added up" : read.metric === "min" ? "Found the smallest value in" : read.metric === "max" ? "Found the largest value in" : "Counted";
      return `${action} ${source ? `${source} ` : ""}${kind}`;
    }
    default: return `Read your data${from}`;
  }
}
export function refusalReason(code: string | null): string | null {
  if (["grant_revoked","grant_invalid","grant_expired"].includes(code ?? "")) return "Its permission has ended or is no longer valid.";
  if (["field_not_granted","grant_stream_not_allowed"].includes(code ?? "")) return "Its permission does not cover this data.";
  if (code === "invalid_request") return "The app's request could not be understood.";
  if (["stream_not_declared","connection_not_found","unknown_field","not_found"].includes(code ?? "")) return "The app asked for something that could not be found.";
  return null;
}
