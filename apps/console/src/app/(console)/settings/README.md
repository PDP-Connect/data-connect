# Settings

`page.tsx` composes settings. Developer mode remains browser-local and controls optional connector development surfaces.

`remote-access-setting.tsx` renders the provider inventory from `/v1/owner/reachability`, with no initial selection. Declared fields and actions drive setup drafts. `reachability-consent.tsx` renders separate setup and route approvals from their exact consent snapshots. Missing or inconsistent snapshots disable approval.

`reachability-client.ts` sends each request to the console's route handler (`app/api/reachability`) with fetch, and its 15 s deadline counts from the send. The handler checks the owner session and calls `reachability-forward.ts`, which forwards the request to the reference service with the owner's bearer. It is a route handler and not a Server Action because Next.js runs one client's Server Actions one at a time, which made Turn on wait behind the page's own polling. The browser receives projected observations, never credentials, secret handles or candidate tokens. A reload keeps only a draft reference and reads fresh actions through the public draft API.

The service owns leases, route watching, operation intents and cleanup retries. The screen shows proof evidence, requested and observed binding, generic capability reasons and cleanup debt. Listener, password and port changes require the host supervisor. `proof_refresh_unsupported` leaves only Stop available.

The native provider modules and legacy-file importer remain for the migration follow-on. Their deletion requires a crash-safe cutover. Pairing and attach are outside this change.
