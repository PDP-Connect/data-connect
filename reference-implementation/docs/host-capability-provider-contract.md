# Host capability provider contract

## Browser surface

The reference implementation can lease a browser from a host agent on the same machine. Enable this mode with:

```text
PDPP_BROWSER_SURFACE_MODE=host
PDPP_BROWSER_SURFACE_HOST_ENDPOINT=http://127.0.0.1:<port>
PDPP_BROWSER_SURFACE_HOST_TOKEN=<shared-secret>
```

`PDPP_BROWSER_HEADLESS=1` sets `headless: true`; any other value sets `false`. If `PDPP_NEKO_MANAGED_CONNECTORS` is set, it remains the managed connector list. Otherwise host mode manages the generated browser-bound connector set. The surface cap defaults to the smallest value that preserves the retained-connector reserve and can be overridden with `PDPP_NEKO_SURFACE_CAP`.

### Acquire

Before a browser connector is spawned, RI sends:

```http
POST <endpoint>/browser-surface/leases
Authorization: Bearer <shared-secret>
Content-Type: application/json
```

```json
{"run_id":"run-123","connector_id":"chase","headless":false}
```

The agent returns HTTP 2xx with:

```json
{"surface_id":"host-surface-7","cdp_url":"http://127.0.0.1:9222"}
```

`cdp_url` must be an HTTP(S) CDP endpoint accepted by RI's existing readiness probe. RI uses that URL for `/json/version`, `/json/list`, window settle, and the semantic CDP check. Host mode does not launch Chrome.

### Lifetime and release

The returned lease belongs to one `run_id`. RI keeps the agent's `surface_id` as opaque host state. On run cleanup, readiness failure, or capacity reclaim, RI sends:

```http
DELETE <endpoint>/browser-surface/leases/<surface_id>
Authorization: Bearer <shared-secret>
```

The host agent owns the browser process and is responsible for killing it when this DELETE succeeds. RI owns only its run lease and never kills the browser directly. The DELETE should be idempotent so cleanup can safely retry.

### Error codes

- `host_browser_surface_missing_lease_context`: RI could not bind a run to the lease.
- `host_browser_surface_invalid_config`: the host endpoint or bearer token is invalid.
- `host_browser_surface_unreachable`: the endpoint could not be reached.
- `host_browser_surface_timeout`: the endpoint exceeded RI's request budget.
- `host_browser_surface_http_error`: the endpoint returned non-2xx.
- `host_browser_surface_malformed_response`: the response lacked a valid `surface_id` or HTTP(S) `cdp_url`.
- `surface_start_failed`: the lease-manager admission reason when host acquisition fails; the connector child is not spawned.
- Existing CDP readiness codes classify failures after acquisition (`browser_surface_not_ready`, `browser_surface_cdp_unreachable`, or `browser_surface_cdp_disconnected`).
