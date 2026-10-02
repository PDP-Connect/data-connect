// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { mountRefManualUploadDraftConnection } from "../server/routes/ref-manual-upload-draft-connection.ts";

type Handler = (req: { params: Record<string, string> }, res: ResponseStub) => Promise<void> | void;

class ResponseStub {
  body: unknown = null;
  statusCode = 200;
  getHeader(): undefined {
    return undefined;
  }
  json(body: unknown): this {
    this.body = body;
    return this;
  }
  setHeader(): void {
    return undefined;
  }
  status(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { code: "not_found" });
}

const installedManualUploadManifest = {
  connector_id: "whatsapp",
  connector_key: "whatsapp",
  display_name: "WhatsApp",
  setup: {
    manual_or_upload: {
      accepted_file_extensions: [".txt", ".zip"],
      import_dir_env_var: "WHATSAPP_EXPORT_DIR",
      label: "Upload a WhatsApp chat export",
      validation: { kind: "whatsapp_chat_export" },
    },
    modality: "manual_or_upload",
  },
};

test("manual-upload setup falls back to a verified active install manifest when registry persistence is skipped", async () => {
  const routes = new Map<string, Handler>();
  const app = {
    get(path: string, ...args: unknown[]) {
      routes.set(`GET ${path}`, args.at(-1) as Handler);
      return this;
    },
    post(path: string, ...args: unknown[]) {
      routes.set(`POST ${path}`, args.at(-1) as Handler);
      return this;
    },
  };

  mountRefManualUploadDraftConnection(app, {
    canonicalConnectorKey: (value) => value ?? null,
    createRequestAcquisitionBatchStore: () => ({}) as never,
    createRequestConnectorInstanceStore: () => ({}) as never,
    createRequestManualUploadArtifactStore: () => ({}) as never,
    createTraceContext: () => ({ request_id: "req_test", scenario_id: "scenario_test", trace_id: "trc_test" }),
    emitSpineEvent: async () => undefined,
    ensureRequestId: () => "req_test",
    getOwnerSubjectId: () => "owner_local",
    handleError: (res, error) => {
      const response = res as ResponseStub;
      response.status((error as { code?: unknown }).code === "not_found" ? 404 : 500).json({ error: String(error) });
    },
    importBaseDir: "/tmp/pdpp-test-imports",
    pdppError: (res, statusCode, code, message, param) => {
      (res as ResponseStub).status(statusCode).json({ code, message, param });
    },
    requireOwnerSession: () => undefined,
    resolveActiveConnectorManifest: async (connectorId) =>
      connectorId === "whatsapp" ? installedManualUploadManifest : null,
    resolveRegisteredConnectorManifest: async (connectorId) => {
      throw notFound(`Unknown connector: ${connectorId}`);
    },
    setReferenceTraceId: () => undefined,
  });

  const handler = routes.get("GET /_ref/connectors/:connectorId/manual-upload-setup");
  assert.ok(handler, "manual-upload setup route must be mounted");
  const res = new ResponseStub();
  await handler({ params: { connectorId: "whatsapp" } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    {
      connector_id: (res.body as { connector_id?: unknown }).connector_id,
      display_name: (res.body as { display_name?: unknown }).display_name,
      object: (res.body as { object?: unknown }).object,
    },
    { connector_id: "whatsapp", display_name: "WhatsApp", object: "manual_upload_setup" }
  );
});
