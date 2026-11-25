// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Named durability boundaries for process-kill tests.
 *
 * Production never installs a hook, so `crashPoint` is one null check. The
 * crash harness (test/helpers/crash-harness.ts) installs a hook inside a child
 * process: at an armed name the child blocks synchronously until the test
 * parent SIGKILLs it or lets it continue. The hook is synchronous on purpose:
 * while the child is parked, no other code in it runs.
 */
type CrashPointHook = (name: string) => void;

let crashPointHookForTest: CrashPointHook | null = null;

export function crashPoint(name: string): void {
  if (crashPointHookForTest) {
    crashPointHookForTest(name);
  }
}

export function __setCrashPointHookForTest(hook: CrashPointHook | null): void {
  crashPointHookForTest = hook;
}
