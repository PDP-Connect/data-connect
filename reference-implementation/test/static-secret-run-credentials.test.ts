// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { readPolyfillManifests } from "@pdpp/polyfill-connectors/manifests";

import { closeDb, getDb, initDb } from "../server/db.ts";

const MANIFESTS: Record<string, unknown> = {
  chatgpt: {
    setup: {
      modality: "static_secret",
      credential_capture: {
        kind: "username_password",
        required: false,
        fields: [
          { name: "username", type: "text", secret: false, env: ["CHATGPT_USERNAME"] },
          { name: "password", type: "password", secret: true, required: false, env: ["CHATGPT_PASSWORD"] },
        ],
      },
    },
  },
  gmail: {
    setup: {
      modality: "static_secret",
      credential_capture: {
        kind: "app_password",
        fields: [
          { name: "account_email", type: "email", secret: false, env: ["GMAIL_ADDRESS"] },
          { name: "secret", type: "password", secret: true, env: ["GOOGLE_APP_PASSWORD_PDPP", "GMAIL_APP_PASSWORD"] },
        ],
      },
    },
  },
  usaa: {
    setup: {
      modality: "static_secret",
      credential_capture: {
        kind: "username_password",
        fields: [{ name: "password", type: "password", secret: true, env: ["USAA_PASSWORD"] }],
      },
    },
  },
  venmo: {
    setup: {
      modality: "static_secret",
      credential_capture: {
        kind: "username_password",
        required: false,
        fields: [{ name: "password", type: "password", secret: true, required: false, env: ["VENMO_PASSWORD"] }],
      },
    },
  },
};

import {
  ConnectorInstanceCredentialError,
  createSqliteConnectorInstanceCredentialStore,
} from "../server/stores/connector-instance-credential-store.ts";
import {
  resolveStaticSecretRunEnv as resolveStaticSecretRunEnvUntyped,
  StaticSecretRunCredentialError,
} from "../server/stores/static-secret-run-credentials.ts";

// `resolveStaticSecretRunEnv` is untyped JS with no annotated parameters; the
// real runtime contract is exactly this shape (verified against the source
// above), so this restates it rather than leaving every call site with
// implicit-any args.
type ResolveStaticSecretRunEnv = (args: {
  connectorId: string;
  connectorInstanceId: string;
  ownerSubjectId: string;
  sourceBinding?: unknown;
  credentialStore: unknown;
  manifest: unknown;
}) => Promise<Record<string, string> | null>;

const resolveStaticSecretRunEnv = resolveStaticSecretRunEnvUntyped as ResolveStaticSecretRunEnv;

const NOW = "2026-06-01T12:00:00.000Z";
const LATER = "2026-06-01T12:05:00.000Z";
const LATEST = "2026-06-01T12:10:00.000Z";
const TEST_KEY = "test-operator-key-do-not-use-in-prod";
const APP_PASSWORD = "abcd efgh ijkl mnop";
const ROTATED = "zzzz yyyy xxxx wwww";

type CredentialStore = ReturnType<typeof createSqliteConnectorInstanceCredentialStore>;

function seedConnectorInstance({
  connectorInstanceId,
  ownerSubjectId,
  connectorId,
  sourceBinding = {},
}: {
  connectorInstanceId: string;
  ownerSubjectId: string;
  connectorId: string;
  sourceBinding?: unknown;
}): void {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
    connectorId,
    JSON.stringify({ connector_id: connectorId }),
    NOW
  );
  db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES (?, ?, ?, ?, 'active', 'account', ?, ?, ?, ?, NULL)`
  ).run(
    connectorInstanceId,
    ownerSubjectId,
    connectorId,
    connectorInstanceId,
    connectorInstanceId,
    JSON.stringify(sourceBinding),
    NOW,
    NOW
  );
}

function withStore(fn: (store: CredentialStore) => Promise<void>): () => Promise<void> {
  return async () => {
    initDb(":memory:");
    try {
      const store = createSqliteConnectorInstanceCredentialStore({
        env: { PDPP_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY },
      });
      await fn(store);
    } finally {
      closeDb();
    }
  };
}

function resolveEnv(
  store: CredentialStore,
  {
    connectorId,
    connectorInstanceId,
    ownerSubjectId,
    sourceBinding,
  }: {
    connectorId: string;
    connectorInstanceId: string;
    ownerSubjectId: string;
    sourceBinding?: unknown;
  }
): Promise<Record<string, string> | null> {
  return resolveStaticSecretRunEnv({
    connectorId,
    connectorInstanceId,
    credentialStore: store,
    manifest: MANIFESTS[connectorId] ?? null,
    ownerSubjectId,
    sourceBinding,
  });
}

test(
  "an active credential resolves a connection-scoped run env fragment",
  withStore(async (store) => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    const env = await resolveEnv(store, {
      connectorId: "gmail",
      connectorInstanceId: "cin_a",
      ownerSubjectId: "owner_1",
    });
    assert.ok(env);
    assert.equal(env.GOOGLE_APP_PASSWORD_PDPP, APP_PASSWORD);
    assert.equal(env.GMAIL_APP_PASSWORD, APP_PASSWORD);
  })
);

test(
  "a missing credential fails the run closed (no env fragment)",
  withStore(async (store) => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    await assert.rejects(
      () => resolveEnv(store, { connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" }),
      (err) => err instanceof ConnectorInstanceCredentialError && err.code === "credential_not_found"
    );
  })
);

test(
  "a browser-session source may launch without an optional static login credential",
  withStore(async (store) => {
    const sourceBinding = {
      connector_id: "chatgpt",
      enrollment_completed_at: "2026-06-01T12:01:00.000Z",
      enrollment_expires_at: "2026-06-01T14:00:00.000Z",
      kind: "browser_collector",
    };
    seedConnectorInstance({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt",
      ownerSubjectId: "owner_1",
      sourceBinding,
    });
    const env = await resolveEnv(store, {
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt",
      ownerSubjectId: "owner_1",
      sourceBinding,
    });
    assert.equal(env, null);
  })
);

test(
  "a browser-session source ignores a revoked optional static login credential",
  withStore(async (store) => {
    const sourceBinding = {
      connector_id: "chatgpt",
      enrollment_completed_at: "2026-06-01T12:01:00.000Z",
      enrollment_expires_at: "2026-06-01T14:00:00.000Z",
      kind: "browser_collector",
    };
    seedConnectorInstance({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt",
      ownerSubjectId: "owner_1",
      sourceBinding,
    });
    await store.capture({
      connectorInstanceId: "cin_chatgpt",
      credentialKind: "username_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: "not-used-after-revoke",
    });
    await store.revoke({ connectorInstanceId: "cin_chatgpt", now: LATER });
    const env = await resolveEnv(store, {
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt",
      ownerSubjectId: "owner_1",
      sourceBinding,
    });
    assert.equal(env, null);
  })
);

test(
  "a browser-session source ignores a rejected optional static login credential",
  withStore(async (store) => {
    const sourceBinding = {
      connector_id: "chatgpt",
      enrollment_completed_at: "2026-06-01T12:01:00.000Z",
      enrollment_expires_at: "2026-06-01T14:00:00.000Z",
      kind: "browser_collector",
    };
    seedConnectorInstance({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt",
      ownerSubjectId: "owner_1",
      sourceBinding,
    });
    await store.capture({
      connectorInstanceId: "cin_chatgpt",
      credentialKind: "username_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: "not-used-after-rejection",
    });
    await store.markRejected({
      connectorInstanceId: "cin_chatgpt",
      reason: "provider rejected stored credential",
      rejectedAt: LATER,
    });
    const env = await resolveEnv(store, {
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt",
      ownerSubjectId: "owner_1",
      sourceBinding,
    });
    assert.equal(env, null);
  })
);

// Optional capture is a manifest policy, independent of source binding. This
// test pins the static-secret draft journey where browser enrollment remains
// gated but missing optional credentials must still allow manual sign-in.
test(
  "a connector whose manifest declares credential_capture.required: false may run without a static credential, even on a plain static_secret binding",
  withStore(async (store) => {
    seedConnectorInstance({
      connectorId: "venmo",
      connectorInstanceId: "cin_venmo",
      ownerSubjectId: "owner_1",
      sourceBinding: { kind: "static_secret" },
    });
    const env = await resolveEnv(store, {
      connectorId: "venmo",
      connectorInstanceId: "cin_venmo",
      ownerSubjectId: "owner_1",
      sourceBinding: { kind: "static_secret" },
    });
    assert.equal(env, null);
  })
);

test(
  "the SAME optional connector still injects its stored credential when one IS present",
  withStore(async (store) => {
    seedConnectorInstance({
      connectorId: "venmo",
      connectorInstanceId: "cin_venmo_saved",
      ownerSubjectId: "owner_1",
      sourceBinding: { kind: "static_secret" },
    });
    await store.capture({
      connectorInstanceId: "cin_venmo_saved",
      credentialKind: "username_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: JSON.stringify({ password: "synthetic-venmo-password" }),
    });
    const env = await resolveEnv(store, {
      connectorId: "venmo",
      connectorInstanceId: "cin_venmo_saved",
      ownerSubjectId: "owner_1",
      sourceBinding: { kind: "static_secret" },
    });
    assert.ok(env);
    assert.equal(env.VENMO_PASSWORD, "synthetic-venmo-password");
  })
);

// Counterweight: a REQUIRED static-secret connector (usaa — no
// credential_capture.required: false fact) with no stored credential must
// still fail the run closed on a plain static_secret binding — the new
// captureOptional path must not accidentally forgive every connector.
test(
  "a REQUIRED static-secret connector still fails closed on a missing credential (captureOptional does not leak to it)",
  withStore(async (store) => {
    seedConnectorInstance({
      connectorId: "usaa",
      connectorInstanceId: "cin_usaa",
      ownerSubjectId: "owner_1",
      sourceBinding: { kind: "static_secret" },
    });
    await assert.rejects(
      () =>
        resolveEnv(store, {
          connectorId: "usaa",
          connectorInstanceId: "cin_usaa",
          ownerSubjectId: "owner_1",
          sourceBinding: { kind: "static_secret" },
        }),
      (err) => err instanceof ConnectorInstanceCredentialError && err.code === "credential_not_found"
    );
  })
);

test(
  "a revoked credential fails the run closed; a run cannot authenticate with a stale secret",
  withStore(async (store) => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    await store.revoke({ connectorInstanceId: "cin_a", now: LATER });
    await assert.rejects(
      () => resolveEnv(store, { connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" }),
      (err) => err instanceof ConnectorInstanceCredentialError && err.code === "credential_revoked"
    );
  })
);

test(
  "a rejected credential fails the run closed; a run cannot keep retrying stale provider credentials",
  withStore(async (store) => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    await store.markRejected({
      connectorInstanceId: "cin_a",
      reason: "provider rejected stored credential",
      rejectedAt: LATER,
    });
    await assert.rejects(
      () => resolveEnv(store, { connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" }),
      (err) => err instanceof ConnectorInstanceCredentialError && err.code === "credential_rejected"
    );
  })
);

test(
  "a deleted credential fails the run closed and does not resurrect",
  withStore(async (store) => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    await store.delete("cin_a");
    await assert.rejects(
      () => resolveEnv(store, { connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" }),
      (err) => err instanceof ConnectorInstanceCredentialError && err.code === "credential_not_found"
    );
  })
);

test(
  "after an explicit re-capture, the run resolves the new secret (not the revoked one)",
  withStore(async (store) => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: APP_PASSWORD,
    });
    await store.revoke({ connectorInstanceId: "cin_a", now: LATER });
    await store.capture({
      connectorInstanceId: "cin_a",
      credentialKind: "app_password",
      now: LATEST,
      ownerSubjectId: "owner_1",
      secret: ROTATED,
    });
    const env = await resolveEnv(store, {
      connectorId: "gmail",
      connectorInstanceId: "cin_a",
      ownerSubjectId: "owner_1",
    });
    assert.ok(env);
    assert.equal(env.GOOGLE_APP_PASSWORD_PDPP, ROTATED);
  })
);

test(
  "two connections resolve two distinct run envs (no process-global collision at the seam)",
  withStore(async (store) => {
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_personal", ownerSubjectId: "owner_1" });
    seedConnectorInstance({ connectorId: "gmail", connectorInstanceId: "cin_work", ownerSubjectId: "owner_1" });
    await store.capture({
      connectorInstanceId: "cin_personal",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: "personal one here",
    });
    await store.capture({
      connectorInstanceId: "cin_work",
      credentialKind: "app_password",
      now: NOW,
      ownerSubjectId: "owner_1",
      secret: "work two distinct",
    });
    const personal = await resolveEnv(store, {
      connectorId: "gmail",
      connectorInstanceId: "cin_personal",
      ownerSubjectId: "owner_1",
    });
    const work = await resolveEnv(store, {
      connectorId: "gmail",
      connectorInstanceId: "cin_work",
      ownerSubjectId: "owner_1",
    });
    assert.ok(personal);
    assert.ok(work);
    assert.equal(personal.GOOGLE_APP_PASSWORD_PDPP, "personal one here");
    assert.equal(work.GOOGLE_APP_PASSWORD_PDPP, "work two distinct");
    assert.notEqual(personal.GOOGLE_APP_PASSWORD_PDPP, work.GOOGLE_APP_PASSWORD_PDPP);
  })
);

test(
  "a connector without an installed static-secret manifest keeps the non-static behavior",
  withStore(async (store) => {
    const env = await resolveEnv(store, { connectorId: "anthropic", connectorInstanceId: "cin_a", ownerSubjectId: "owner_1" });
    assert.equal(env, null);
  })
);

test("manifest aliases drive basic secret injection and non-secret setup fields", async () => {
  const env = await resolveStaticSecretRunEnv({
    connectorId: "mailbox",
    connectorInstanceId: "cin_mailbox",
    ownerSubjectId: "owner_1",
    manifest: {
      setup: {
        modality: "static_secret",
        credential_capture: {
          kind: "app_password",
          fields: [
            { name: "account", type: "email", secret: false, env: ["MAIL_USER"] },
            { name: "secret", type: "password", secret: true, env: ["MAIL_SECRET", "MAIL_PASSWORD"] },
          ],
        },
      },
    },
    sourceBinding: { setup_fields: { account: "owner@example.test" } },
    credentialStore: { recoverSecret: async () => ({ credentialKind: "app_password", secret: APP_PASSWORD }) },
  });
  assert.deepEqual(env, {
    MAIL_PASSWORD: APP_PASSWORD,
    MAIL_SECRET: APP_PASSWORD,
    MAIL_USER: "owner@example.test",
  });
});

test("username_password bundles inject secret aliases and source non-secret fields from setup_fields", async () => {
  const env = await resolveStaticSecretRunEnv({
    connectorId: "chat-login",
    connectorInstanceId: "cin_chat-login",
    ownerSubjectId: "owner_1",
    manifest: {
      setup: {
        modality: "static_secret",
        credential_capture: {
          kind: "username_password",
          fields: [
            { name: "username", type: "text", secret: false, env: ["CHAT_USER"] },
            { name: "password", type: "password", secret: true, env: ["CHAT_PASSWORD"] },
          ],
        },
      },
    },
    sourceBinding: { setup_fields: { username: "owner@example.test" } },
    credentialStore: { recoverSecret: async () => ({ credentialKind: "username_password", secret: '{"password":"p@ss","username":"bundle-decoy"}' }) },
  });
  assert.deepEqual(env, { CHAT_PASSWORD: "p@ss", CHAT_USER: "owner@example.test" });
});

test("current Jellyfin username_password manifest keeps required base_url in sourceBinding while secrets come from the sealed bundle", withStore(async (store) => {
  const manifestEntry = readPolyfillManifests().find((entry) => entry.file === "jellyfin.json");
  assert.ok(manifestEntry, "current Jellyfin manifest must be available from the installed profile package");
  const sourceBinding = {
    kind: "static_secret_draft",
    setup_fields: { base_url: "https://media.example.test", jellyfin_user_id: "user-42" },
  };
  seedConnectorInstance({
    connectorId: "jellyfin",
    connectorInstanceId: "cin_jellyfin_current",
    ownerSubjectId: "owner_1",
    sourceBinding,
  });
  await store.capture({
    connectorInstanceId: "cin_jellyfin_current",
    credentialKind: "username_password",
    now: NOW,
    ownerSubjectId: "owner_1",
    secret: JSON.stringify({ username: "alice", password: "jellyfin-password" }),
  });

  const env = await resolveStaticSecretRunEnv({
    connectorId: "jellyfin",
    connectorInstanceId: "cin_jellyfin_current",
    ownerSubjectId: "owner_1",
    sourceBinding,
    credentialStore: store,
    manifest: manifestEntry.manifest,
  });
  assert.deepEqual(env, {
    JELLYFIN_BASE_URL: "https://media.example.test",
    JELLYFIN_PASSWORD: "jellyfin-password",
    JELLYFIN_USER_ID: "user-42",
    JELLYFIN_USERNAME: "alice",
  });
}));

test("optional capture may omit credentials, while wrong-kind and invalid bundles fail closed", async () => {
  const noCredential = await resolveStaticSecretRunEnv({
    connectorId: "venmo",
    connectorInstanceId: "cin_optional",
    ownerSubjectId: "owner_1",
    manifest: MANIFESTS.venmo,
    credentialStore: {
      recoverSecret: async () => {
        throw new ConnectorInstanceCredentialError("credential_not_found", "missing");
      },
    },
  });
  assert.equal(noCredential, null);
  await assert.rejects(
    () =>
      resolveStaticSecretRunEnv({
        connectorId: "venmo",
        connectorInstanceId: "cin_wrong_kind",
        ownerSubjectId: "owner_1",
        manifest: MANIFESTS.venmo,
        credentialStore: { recoverSecret: async () => ({ credentialKind: "app_password", secret: "stale" }) },
      }),
    (error) => error instanceof StaticSecretRunCredentialError && error.code === "credential_kind_mismatch",
  );
  await assert.rejects(
    () =>
      resolveStaticSecretRunEnv({
        connectorId: "chat-login",
        connectorInstanceId: "cin_invalid_bundle",
        ownerSubjectId: "owner_1",
        manifest: {
          setup: {
            modality: "static_secret",
            credential_capture: {
              kind: "username_password",
              fields: [{ name: "password", type: "password", secret: true, env: ["CHAT_PASSWORD"] }],
            },
          },
        },
        credentialStore: { recoverSecret: async () => ({ credentialKind: "username_password", secret: "not-json" }) },
      }),
    (error) => error instanceof StaticSecretRunCredentialError && error.code === "recovered_secret_bundle_invalid",
  );
});
