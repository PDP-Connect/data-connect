# Public startup repros

Install the selected archive with the repository's `scripts/reachability/install-tarball.mjs`, using `GOZAR_TARBALL`, `GOZAR_TARBALL_SHA256` and `GOZAR_SOURCE_SHA`. Run an entry with Node 24:

```sh
node reference-implementation/test/fixtures/reachability/minimal/lan-session.mjs
```

Each entry uses the public testing factory, its declared effect handlers, an independent memory secret backend and a real owned local application with the public service verifier. It imports no DataConnect service, owner API or UI. Common wiring is shared to avoid eight copies. Effects match exact kind/operation pairs; network proof reaches the actual owned gate.

The scripts log setup inputs/actions, exact public call inputs, verification and cleanup independently. A startup verification result does not certify boot identity, initial generation or recovery. The full release journey retains those stricter assertions. Use the existing resource governor or private PID/network isolation to reap descendants after completion. The external release report names the self-contained forwarding directory and one log per entry.

`durable-fresh-consent.mjs` and `session-fresh-consent.mjs` establish verified allocation and current status before changing a runtime observation and requesting same-generation consent. Their shared helper logs exact public calls and the first divergence. `consent-effects.json` maps only explicit fixture origins to the actual owned local application; no proof response is canned. A failure to establish initial proof stops before review.
