// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
  ConnectorCatalogEntry,
  ConnectorInstallRecord,
  ConnectorInstallService,
  ConnectorInstallStatusRecord,
} from "../connector-install/index.ts";
import type { LocalConnectorSourceRecord } from "../connector-install/local-source.ts";
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

function projectStatus(record: ConnectorInstallRecord | ConnectorInstallStatusRecord): Record<string, unknown> {
  const statusRecord = "activationState" in record ? record : null;
  const activationState = statusRecord?.activationState ?? "active";
  return {
    activated_at: record.activatedAt,
    activation_state: activationState,
    bindings: record.bindings,
    config_digest: record.configDigest,
    connector_id: record.connectorId,
    digest: record.digest,
    entrypoint_sha256: record.entrypointSha256,
    manifest_sha256: record.manifestSha256,
    provenance_sha256: record.provenanceSha256,
    registry: record.registry,
    repository: record.repository,
    ...(statusRecord && activationState !== "active"
      ? { repair_reason: statusRecord.repairReason }
      : {}),
    tier: record.tier,
    version: record.version,
  };
}

function projectLocalSource(record: LocalConnectorSourceRecord): Record<string, unknown> {
  return {
    connector_id: record.connectorId,
    connector_key: record.connectorKey,
    display_name: record.displayName,
    entrypoint_path: record.entrypointPath,
    manifest_path: record.manifestPath,
    provenance: record.trust,
    selected: record.selected,
    source_id: record.sourceId,
    source_path: record.root,
    updated_at: record.updatedAt,
    version: record.version,
  };
}

function bodyString(req: Request, key: string): string | null {
  const value = req.body?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
  const localSourcesHandler: Handler = async (_req, res) => {
    try {
      const records = options.service.listLocalSources ? await options.service.listLocalSources() : [];
      res.json({ data: records.map(projectLocalSource), object: "connector_install_local_sources" });
    } catch (error) {
      options.handleError(res, error);
    }
  };
  const localAddHandler: Handler = async (req, res) => {
    try {
      const sourcePath = bodyString(req, "source_path");
      if (!sourcePath) {
        options.pdppError(res, 400, "invalid_request", "source_path is required", "source_path");
        return;
      }
      if (!options.service.addLocalSource) {
        options.pdppError(res, 501, "unsupported", "Developer local sources are unavailable.", "source_path");
        return;
      }
      res.status(201).json({
        data: projectLocalSource(await options.service.addLocalSource(sourcePath)),
        object: "connector_install_local_source",
      });
    } catch (error) {
      options.handleError(res, error);
    }
  };
  const localReloadHandler: Handler = async (req, res) => {
    try {
      const sourceId = bodyString(req, "source_id");
      if (!sourceId) {
        options.pdppError(res, 400, "invalid_request", "source_id is required", "source_id");
        return;
      }
      if (!options.service.reloadLocalSource) {
        options.pdppError(res, 501, "unsupported", "Developer local sources are unavailable.", "source_id");
        return;
      }
      res.json({
        data: projectLocalSource(await options.service.reloadLocalSource(sourceId)),
        object: "connector_install_local_source",
      });
    } catch (error) {
      options.handleError(res, error);
    }
  };
  const localRemoveHandler: Handler = async (req, res) => {
    try {
      const sourceId = bodyString(req, "source_id");
      if (!sourceId) {
        options.pdppError(res, 400, "invalid_request", "source_id is required", "source_id");
        return;
      }
      if (!options.service.removeLocalSource) {
        options.pdppError(res, 501, "unsupported", "Developer local sources are unavailable.", "source_id");
        return;
      }
      await options.service.removeLocalSource(sourceId);
      res.json({ data: { removed: true, source_id: sourceId }, object: "connector_install_local_source" });
    } catch (error) {
      options.handleError(res, error);
    }
  };
  const localSelectHandler: Handler = async (req, res) => {
    try {
      const connectorKey = bodyString(req, "connector_key");
      const rawSourceId = req.body?.source_id;
      const sourceId = rawSourceId === null ? null : typeof rawSourceId === "string" ? rawSourceId.trim() : undefined;
      if (!connectorKey || sourceId === undefined) {
        options.pdppError(res, 400, "invalid_request", "connector_key and source_id are required", "connector_key");
        return;
      }
      if (!options.service.selectLocalSource) {
        options.pdppError(res, 501, "unsupported", "Developer local sources are unavailable.", "connector_key");
        return;
      }
      await options.service.selectLocalSource(connectorKey, sourceId || null);
      res.json({ data: { connector_key: connectorKey, selected_source_id: sourceId || null }, object: "connector_install_local_source" });
    } catch (error) {
      options.handleError(res, error);
    }
  };
  app.get("/v1/owner/connector-install/catalog", ...guarded, catalogHandler);
  app.get("/v1/owner/connector-install/status", ...guarded, statusHandler);
  app.get("/v1/owner/connector-install/local-sources", ...guarded, localSourcesHandler);
  app.post("/v1/owner/connector-install/install", ...guarded, installHandler);
  app.post("/v1/owner/connector-install/update", ...guarded, updateHandler);
  app.post("/v1/owner/connector-install/local-sources/add", ...guarded, localAddHandler);
  app.post("/v1/owner/connector-install/local-sources/reload", ...guarded, localReloadHandler);
  app.post("/v1/owner/connector-install/local-sources/remove", ...guarded, localRemoveHandler);
  app.post("/v1/owner/connector-install/local-sources/select", ...guarded, localSelectHandler);
}
