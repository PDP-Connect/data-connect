// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface OwnedTestResource {
  release: () => Promise<void>;
}

// onCreated must be called immediately after successful creation, before
// provisioning, unlock, or connection teardown can fail. Never call it merely
// because a same-named resource exists: that resource belongs to someone else.
export async function createOwnedTestResource<T>({
  create,
  provision,
  destroy,
  registry,
}: {
  create: (onCreated: () => void) => Promise<T>;
  provision?: (value: T) => Promise<void>;
  destroy: () => Promise<void>;
  registry: Set<OwnedTestResource>;
}): Promise<OwnedTestResource & { value: T }> {
  let owned = false;
  let released = false;
  let pending: Promise<void> | undefined;
  const resource: OwnedTestResource = {
    release: () => {
      if (!owned || released) {
        return Promise.resolve();
      }
      if (pending) {
        return pending;
      }
      pending = Promise.resolve().then(destroy).then(() => {
        released = true;
        registry.delete(resource);
      }).catch((error) => {
        pending = undefined;
        throw error;
      });
      return pending;
    },
  };
  try {
    const value = await create(() => {
      owned = true;
      registry.add(resource);
    });
    if (!owned) {
      throw new Error("resource creation did not establish ownership");
    }
    await provision?.(value);
    return { value, release: resource.release };
  } catch (error) {
    try {
      await resource.release();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "test resource creation and rollback failed");
    }
    throw error;
  }
}

// Promise.all rejects early; cleanup must wait for every running worker.
export async function settleAll(operations: readonly Promise<void>[]): Promise<void> {
  const settled = await Promise.allSettled(operations);
  const errors = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) {
    throw new AggregateError(errors, "one or more operations failed");
  }
}
