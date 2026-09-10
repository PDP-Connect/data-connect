// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Hostile stand-in for consent-handoff-restart-server-fixture.ts: exits
 * nonzero without ever printing its `ready` line. Used by
 * test/security-consent-token-handoff-fixture-lifecycle.test.ts to prove
 * the parent helper reports a child that dies before `ready` instead of
 * awaiting a promise nothing will settle.
 */
process.stderr.write("dies-before-ready fixture: refusing to start\n");
process.exit(3);
