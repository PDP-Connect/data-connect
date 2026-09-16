// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
  ConnectorCatalogEntry,
  ConnectorInstallRecord,
  ConnectorInstallService,
} from "../connector-install/index.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

interface Request {
  readonly body?: Record<string, unknown>;
}
interface Response {
  json: (body: unknown) => unknown;
  status: (status: number) => Response;
}
type Handler = (req: Request, res: Response) => Promise<void>;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
interface App {
  get: (path: string, ...args: RouteArg<Handler>[]) => App;
  post: (path: string, ...args: RouteArg<Handler>[]) => App;
}

function projectCatalogEntry(entry: ConnectorCatalogEntry): Record<string, unknown> {
  return {
    ...(entry.catalog_connector_id ? { catalog_connector_id: entry.catalog_connector_id } : {}),
    ...(entry.display_name ? { display_name: entry.display_name } : {}),
    ...(entry.published_at ? { published_at: entry.published_at } : {}),
    ...(entry.setup_modality === undefined ? {} : { setup_modality: entry.setup_modality }),
    ...(entry.tier ? { tier: entry.tier } : {}),
    bindings: entry.bindings ?? {},
    connector_id: entry.connector_id,
    connector_key: entry.connector_key,
    digest: entry.digest,
    latest: entry.latest === true,
    version: entry.version ?? null,
  };
}

function projectStatus(record: ConnectorInstallRecord): Record<string, unknown> {
  return {
    activated_at: record.activatedAt,
    activation_state: "active",
    bindings: record.bindings,
    config_digest: record.configDigest,
    connector_id: record.connectorId,
    digest: record.digest,
    entrypoint_sha256: record.entrypointSha256,
    manifest_sha256: record.manifestSha256,
    provenance_sha256: record.provenanceSha256,
    registry: record.registry,
    repository: record.repository,
    tier: record.tier,
    version: record.version,
  };
}

export function mountOwnerConnectorInstall(
  app: App,
  options: {
    readonly service: ConnectorInstallService;
    readonly requireOwner: MiddlewareHandler;
    readonly requireToken: MiddlewareHandler;
    readonly handleError: (res: unknown, error: unknown) => void;
    readonly pdppError: PdppErrorFn;
  }
): void {
  const guarded = [options.requireToken, options.requireOwner] as const;
  const catalogHandler: Handler = async (_req, res) => {
    try {
      res.json({
        data: (await options.service.catalog()).map(projectCatalogEntry),
        object: "connector_install_catalog",
      });
    } catch (error) {
      options.handleError(res, error);
    }
  };
  const statusHandler: Handler = async (_req, res) => {
    try {
      res.json({ data: (await options.service.status()).map(projectStatus), object: "connector_install_status" });
    } catch (error) {
      options.handleError(res, error);
    }
  };
  const installHandler: Handler = async (req, res) => {
    try {
      const connectorId = req.body?.connector_id;
      const digest = req.body?.digest;
      if (typeof connectorId !== "string" || connectorId.trim() === "") {
        options.pdppError(res, 400, "invalid_request", "connector_id is required", "connector_id");
        return;
      }
      if (typeof digest !== "string" || !DIGEST.test(digest)) {
        options.pdppError(res, 400, "invalid_request", "digest must be a sha256 digest", "digest");
        return;
      }
      res
        .status(201)
        .json({ data: projectStatus(await options.service.install(connectorId, digest)), object: "connector_install" });
    } catch (error) {
      options.handleError(res, error);
    }
  };
  const updateHandler: Handler = async (req, res) => {
    try {
      const connectorId = req.body?.connector_id;
      if (typeof connectorId !== "string" || connectorId.trim() === "") {
        options.pdppError(res, 400, "invalid_request", "connector_id is required", "connector_id");
        return;
      }
      res.json({ data: projectStatus(await options.service.update(connectorId)), object: "connector_install" });
    } catch (error) {
      options.handleError(res, error);
    }
  };
  app.get("/v1/owner/connector-install/catalog", ...guarded, catalogHandler);
  app.get("/v1/owner/connector-install/status", ...guarded, statusHandler);
  app.post("/v1/owner/connector-install/install", ...guarded, installHandler);
  app.post("/v1/owner/connector-install/update", ...guarded, updateHandler);
}
