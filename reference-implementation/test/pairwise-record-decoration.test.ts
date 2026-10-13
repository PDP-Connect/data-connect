// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decoratePairwiseRecord,
  type PairwiseDecorationStreamGrant,
  type PairwiseRecordDecorationOptions,
} from "../server/pairwise-record-decoration.ts";

const sourceId = "https://example.test/source";
const instanceId = "inst_client_a";
const ref = { record_id: "target", source_id: sourceId, stream: "targets" };
const redacted = { redacted: true, source_id: sourceId, stream: "targets" };
const resolved = { ...ref, instance_id: instanceId };

function options(streamPatch: Partial<PairwiseDecorationStreamGrant> = {}): PairwiseRecordDecorationOptions {
  return {
    blobBaseUrl: "/v1/blobs",
    getTargetPrimaryKeyFields: async () => ["id"],
    getTargetRecord: async () => ({
      data: { id: "target", occurred: "2026-10-10T12:00:00Z" },
      id: "target",
      stream: "targets",
    }),
    grant: {
      source: { id: sourceId },
      streams: [
        {
          fields: ["id"],
          instance_ids: [instanceId],
          name: "targets",
          ...streamPatch,
        },
      ],
    },
    instanceId,
    sourceId,
  };
}

async function servedReference(opts: PairwiseRecordDecorationOptions, reference: unknown = ref) {
  const record = await decoratePairwiseRecord({ data: { required_reference: reference } }, opts);
  return record.data.required_reference;
}

test("same-source authorized target resolves with the caller's pairwise handle", async () => {
  assert.deepEqual(await servedReference(options()), resolved);
});

test("nested arrays and objects decorate blobs and references without producer mutation", async () => {
  const original = {
    data: {
      nested: [
        {
          blob_ref: {
            blob_id: "a/b ?",
            fetch_url: "stale",
            mime_type: "text/plain",
          },
          ref,
        },
        null,
        4,
      ],
    },
    id: "parent",
  };
  const before = structuredClone(original);
  const result = await decoratePairwiseRecord(original, {
    ...options(),
    grant: null,
    instanceId: "inst x&",
  });
  assert.equal(result.instance_id, "inst x&");
  assert.deepEqual(result.data.nested[0], {
    blob_ref: {
      blob_id: "a/b ?",
      fetch_url: "/v1/blobs/a%2Fb%20%3F?instance_id=inst%20x%26",
      mime_type: "text/plain",
    },
    ref: { ...ref, instance_id: "inst x&" },
  });
  assert.deepEqual(result.data.nested.slice(1), [null, 4]);
  assert.deepEqual(original, before);
});

test("empty blob IDs and ordinary values do not gain fetch URLs", async () => {
  const original = {
    data: { blob_ref: { blob_id: "" }, other: { name: "ordinary" } },
  };
  assert.deepEqual((await decoratePairwiseRecord(original, options())).data, original.data);
});

test("owner blob source selector is encoded so the emitted URL can resolve owner scope", async () => {
  const record = await decoratePairwiseRecord(
    { data: { blob_ref: { blob_id: "blob" } } },
    { ...options(), blobConnectorId: "custom/source &" }
  );
  assert.deepEqual(record.data.blob_ref, {
    blob_id: "blob",
    fetch_url: "/v1/blobs/blob?instance_id=inst_client_a&connector_id=custom%2Fsource%20%26",
  });
});

test("tombstone gains instance handle without invented data", async () => {
  assert.deepEqual(await decoratePairwiseRecord({ deleted: true, id: "gone" }, options()), {
    deleted: true,
    id: "gone",
    instance_id: instanceId,
  });
});

test("cross-source reference redacts exactly in place without looking up target", async () => {
  let lookups = 0;
  const opts = {
    ...options(),
    getTargetRecord: () => {
      lookups += 1;
      return Promise.resolve(null);
    },
  };
  assert.deepEqual(
    await servedReference(opts, {
      ...ref,
      extra: "leak",
      instance_id: "leak",
      source_id: "https://other.test",
    }),
    { ...redacted, source_id: "https://other.test" }
  );
  assert.equal(lookups, 0);
});

test("ungranted stream and ungranted instance redact", async () => {
  assert.deepEqual(
    await servedReference({
      ...options(),
      grant: { source: { id: sourceId }, streams: [] },
    }),
    redacted
  );
  assert.deepEqual(await servedReference(options({ instance_ids: ["inst_other"] })), redacted);
});

test("grant for a different source cannot resolve local reference", async () => {
  const opts = options();
  opts.grant = { ...opts.grant, source: { id: "https://other.test" } };
  assert.deepEqual(await servedReference(opts), redacted);
});

test("resource allowlist matches canonical IDs and rejects excluded or empty lists", async () => {
  assert.deepEqual(await servedReference(options({ resources: ["target"] })), resolved);
  assert.deepEqual(await servedReference(options({ resources: ["another"] })), redacted);
  assert.deepEqual(await servedReference(options({ resources: [] })), redacted);
});

test("compound reference uses canonical array string and requires every target key field", async () => {
  const compound = { ...ref, record_id: ["part", "two"] };
  const opts = {
    ...options({ fields: ["first", "second"], resources: ['["part","two"]'] }),
    getTargetPrimaryKeyFields: async () => ["first", "second"],
    getTargetRecord: async (stream: string, id: string) => ({
      data: {},
      id,
      stream,
    }),
  };
  assert.deepEqual(await servedReference(opts, compound), {
    ...compound,
    instance_id: instanceId,
  });
  assert.deepEqual(
    await servedReference(
      {
        ...opts,
        grant: {
          source: { id: sourceId },
          streams: [{ fields: ["first"], instance_ids: [instanceId], name: "targets" }],
        },
      },
      compound
    ),
    redacted
  );
});

test("missing frozen primary key facts redact even apparent id access; wildcard is not resolved authority", async () => {
  const { getTargetPrimaryKeyFields: _keyFields, ...opts } = options();
  assert.deepEqual(await servedReference(opts), redacted);
  assert.deepEqual(
    await servedReference({
      ...options(),
      getTargetPrimaryKeyFields: async () => [],
    }),
    redacted
  );
  assert.deepEqual(await servedReference(options({ fields: ["*"] })), redacted);
});

test("missing, deleted, wrong key, wrong stream, or mismatched handle target redacts", async () => {
  await Promise.all(
    [null, { deleted: true }, { id: "other" }, { stream: "other" }, { instance_id: "inst_other" }].map(
      async (target) => {
        assert.deepEqual(
          await servedReference({
            ...options(),
            getTargetRecord: async () => target,
          }),
          redacted
        );
      }
    )
  );
});

test("owner resolves existing same-source target without grant metadata but redacts missing and cross-source targets", async () => {
  const { getTargetPrimaryKeyFields: _keyFields, ...ownerOptions } = options();
  const opts = { ...ownerOptions, grant: null };
  assert.deepEqual(await servedReference(opts), resolved);
  assert.deepEqual(await servedReference({ ...opts, getTargetRecord: async () => null }), redacted);
  assert.deepEqual(await servedReference(opts, { ...ref, source_id: "https://other.test" }), {
    ...redacted,
    source_id: "https://other.test",
  });
});

test("time constraint includes since, excludes until, and checks unprojected target time", async () => {
  assert.deepEqual(
    await servedReference(
      options({
        time_constraint: {
          field: "occurred",
          since: "2026-10-10T12:00:00Z",
          until: "2026-10-11T00:00:00Z",
        },
      })
    ),
    resolved
  );
  assert.deepEqual(
    await servedReference(
      options({
        time_constraint: { field: "occurred", until: "2026-10-10T12:00:00Z" },
      })
    ),
    redacted
  );
  assert.deepEqual(
    await servedReference(
      options({
        time_constraint: { field: "occurred", since: "2026-10-10T12:00:01Z" },
      })
    ),
    redacted
  );
});

test("date bounds use frozen field and invalid, absent, or null target time redacts", async () => {
  const opts = options({
    time_constraint: { field: "day", since: "2026-10-10", until: "2026-10-11" },
  });
  assert.deepEqual(
    await servedReference({
      ...opts,
      getTargetRecord: async () => ({ data: { day: "2026-10-10" } }),
    }),
    resolved
  );
  await Promise.all(
    [undefined, null, "not-a-time", "2026-10-11"].map(async (day) => {
      assert.deepEqual(
        await servedReference({
          ...opts,
          getTargetRecord: async () => ({ data: { day } }),
        }),
        redacted
      );
    })
  );
});

test("malformed or unsupported frozen time constraint never widens reference authorization", async () => {
  await Promise.all(
    [
      { field: "occurred" },
      { field: "occurred", since: "bad" },
      { field: "occurred", since: "2026-10-10", type: "unsupported" },
    ].map(async (time_constraint) => {
      assert.deepEqual(await servedReference(options({ time_constraint })), redacted);
    })
  );
});

test("malformed and already-redacted references never expose producer record or instance IDs", async () => {
  assert.deepEqual(await servedReference(options(), { ...ref, record_id: [] }), redacted);
  assert.deepEqual(
    await servedReference(options(), {
      ...redacted,
      extra: "leak",
      instance_id: "leak",
    }),
    redacted
  );
});
