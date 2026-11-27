# Notifications and event subscriptions

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 11. Notifications and event subscriptions

**Who starts:** The person enrolls a browser/device for owner alerts. An app with an owner-issued grant creates an event subscription. **Where:** `/notifications`; `/event-subscriptions`; `/event-subscriptions/<id>`. **Code:** `apps/console/src/app/(console)/notifications/page.tsx:1`; `apps/console/src/app/(console)/components/web-push-settings.tsx:1`; `apps/console/src/app/(console)/event-subscriptions/page.tsx:1`; detail route/actions; `reference-implementation/server/routes/rs-mutation.ts:1`; event-subscription operations (V).

1. `/notifications` is headed `Notifications`; description: “Enable owner-action alerts for the browser profile or installed app you are using right now. Each device is configured separately.” The section `What DataConnect sends` says `Only owner-action alerts` (source reconnects, syncs waiting on you, other events needing owner attention), `Headline only` (payloads stay non-secret and route to the owner-authenticated console), and `Per device` (each browser/PWA must be enabled here). **V** `apps/console/src/app/(console)/notifications/page.tsx:45-69`.
2. `Browser notifications` describes “Optional browser-native alerts for pending connector interactions.” It initially shows device state such as “This device is not subscribed yet.” The setup button is `Set up notifications`; when open it is `Hide setup`, and when already enabled it is `Manage`. Click `Enable this device`, allow the browser permission prompt, and DataConnect registers a service worker, creates/reuses a browser push subscription, and registers it with the server. Checklist labels: `Open the right device`, `Allow notifications`, `Subscribe this device`, `Send a test`. It warns: “Installing the PWA only adds the app icon. You still need to enable notifications from this device.” and “Mobile browsers may require opening the installed DataConnect app before notifications can arrive. Each phone, tablet, and browser profile must be enabled separately.” **V** `apps/console/src/app/(console)/components/web-push-settings.tsx:374-435,635-685,749-753,773-818`.
3. The expanded browser-push controls are `Enable this device`, `Disable this device`, and `Send test notification`. Test states include “Sending test notification…”, “Test notification sent to N subscription(s).”, “No active subscriptions for this owner. Enable this device first.”, “Push provider did not accept the test notification. Re-enable Web Push for this browser.”, and “Web Push is unavailable on the server.” `Disable this device` unsubscribes the current browser and removes its server subscription; state becomes “Web Push is disabled for this browser.” Setup can fail if the browser lacks HTTPS/localhost, service workers, Push API or Notification API, permission is denied, or server VAPID keys are missing. Examples: “Web Push needs HTTPS or localhost.”, “Notifications are denied. Change browser or OS notification settings to opt in.”, “Server VAPID keys are not configured.” **V** `apps/console/src/app/(console)/components/web-push-settings.tsx:98-117,687-747,893-949`.
4. App event subscriptions are separate from browser push. There is no console create form: an app posts to `POST /v1/event-subscriptions` using its grant-scoped bearer, with `callback_url` and optional `filters.streams`. Callback must be an absolute HTTPS URL (HTTP is allowed only for localhost in development) and at most 2048 bytes. Stream filters can narrow the grant; requesting a stream outside the grant fails. Omitting filters uses the whole grant scope. The response returns `subscription_id`, `status`, `callback_url`, `created_at`, and a `secret`; initial status is `pending_verification`. The server sends a `pdpp.subscription.verify` challenge to the callback; after successful verification it becomes active. Record changes create `pdpp.records.changed` events scoped to the grant/selected streams; the event carries a change cursor and count hint, not record fields. The app must read the records API to retrieve changed data. Other event types include `pdpp.subscription.test` and `pdpp.grant.revoked`. **V** `reference-implementation/server/routes/rs-mutation.ts:763-808`; `reference-implementation/operations/as-client-event-subscriptions/index.ts:120-244,506-523`; `reference-implementation/operations/rs-client-event-derive/index.ts:58-62,144-203`.
5. `/event-subscriptions` is titled `Client event subscriptions`; its description says “Webhook-style event subscriptions registered by clients against owner-issued grants. This surface reads them and can disable one; rotate and replay stay with the client.” Filters are `Client id`, `Grant id`, and `Status` (`any`, `active`, `pending verification`, `disabled`, `disabled · failure`, `disabled · revoked`), with a `Filter` button. Rows show subscription ID/status/updated time, client and grant IDs, callback host, pending count, failed count, and last attempt `ok`/`fail` with status code/time. Empty: “No subscriptions match these filters”; hint: “A subscription appears once a client posts to /v1/event-subscriptions against an owner-issued grant.” **V** `apps/console/src/app/(console)/event-subscriptions/page.tsx:240-333,336-405`.
6. On desktop, selecting a row opens a peek; on small screens it opens `/event-subscriptions/<id>`. Detail shows status, grant/client, callback URL, created/updated/disabled times and reason, pending queue, final-failure count, stream scope, and `Recent attempts` with `ok`/`fail`, response status, event type, latency, time and error. Empty attempt copy: “No delivery attempts recorded yet.” An active subscription can be disabled by entering optional `Reason (optional, max 256 bytes UTF-8)` (placeholder `loop_suspected`), checking “I understand this stops deliveries for the subscription. The bound grant stays active and the client may re-enable.”, and clicking `Disable subscription`. This stops delivery without revoking the grant. **V** `apps/console/src/app/(console)/event-subscriptions/[subscriptionId]/page.tsx:170-230,285-355`.
7. The client owns rotate, test/replay, re-enable, and delete operations through its API. The console has no delete or rotate control. For a `disabled_revoked` item it says: “The bound grant has been revoked, so this subscription is not recoverable in place. The client’s re-enable PATCH is rejected with 409 grant_revoked; the client would need to obtain a new grant and create a new subscription.” Delivery failure also disables a subscription after repeated failures. **V** `reference-implementation/server/routes/rs-mutation.ts:857-934`; `reference-implementation/operations/as-client-event-subscriptions/index.ts:390-459,485-538`; `apps/console/src/app/(console)/event-subscriptions/[subscriptionId]/page.tsx:136-167`.

**Needs already true:** Browser push needs HTTPS or localhost, server VAPID keys, a supported browser/installed app, and permission. Each browser profile/device has a separate subscription. App webhooks need an active grant, an HTTPS callback endpoint reachable by the server, and client code that handles verification and delivery. **V/I** above; receiver implementation is outside this console.

**Rough edges:** Browser push and app webhooks are separate systems with different setup owners. The console can enroll/disable the current push device and inspect/disable app subscriptions, but it cannot create, rotate, replay, re-enable, or delete app subscriptions. The callback needs to be created and kept reachable by the app owner. Delivery event names and status/error codes are protocol vocabulary. **V** cited code.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `notifications-and-webhooks`. **Combined isolated run:** `notifications-and-webhooks`: **pass**.

**What it verifies:** The capture reaches the browser notification settings page.

**Reaches:** The `/notifications` page renders with its “Notifications” heading at both viewports.

**Stops at:** It does not grant browser notification permission, register a webhook, or verify a callback delivery.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: notifications-and-webhooks"
```

**Evidence:** `evidence/notifications-and-webhooks/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

Browser permission and an HTTPS webhook receiver are external to the offline stack.
