import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  schemaPath, snapshotPartPath, changesPath, encodeNdjson, decodeNdjson,
  splitNdjson, emptyIndex, parseIndex, serializeIndex,
} from '../server/lws/folder-layout.ts';
import type { IndexFile } from '../server/lws/folder-layout.ts';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const hash = (body: Uint8Array): string => createHash('sha256').update(body).digest('hex');
test('paths encode each segment once and reject invalid ranges', () => {
  assert.equal(schemaPath('a/b', 'c %?#é'), 'a%2Fb/c%20%25%3F%23%C3%A9/schema.json');
  assert.equal(snapshotPartPath('a', 'b', 2, 3, 0), 'a/b/snapshot-2-3-part-0.ndjson');
  assert.equal(changesPath('a', 'b', 2, 4, 9), 'a/b/changes-2-4-9.ndjson');
  for (const bad of ['', '.', '..']) assert.throws(() => schemaPath(bad, 'b'));
  assert.throws(() => schemaPath('\uD800', 'b'));
  for (const bad of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => snapshotPartPath('a', 'b', bad, 0, 0));
    assert.throws(() => snapshotPartPath('a', 'b', 0, bad, 0));
    assert.throws(() => snapshotPartPath('a', 'b', 0, 0, bad));
  }
  assert.throws(() => changesPath('a', 'b', 0, 2, 1));
});

test('NDJSON uses UTF-8 bytes, newline terminators and exact hashes', () => {
  const lines = [{ key: 'é', data: { text: 'a\nb' } }, { key: 'two', data: null }];
  const encoded = encodeNdjson(lines);
  assert.equal(new TextDecoder().decode(encoded.body), lines.map(line => JSON.stringify(line) + '\n').join(''));
  assert.equal(encoded.bytes, encoded.body.byteLength);
  assert.equal(encoded.sha256, hash(encoded.body));
  assert.deepEqual(decodeNdjson(encoded.body, encoded), lines);
  assert.deepEqual(decodeNdjson(encodeNdjson([]).body), []);
  assert.throws(() => decodeNdjson(encoded.body, { bytes: encoded.bytes + 1, sha256: encoded.sha256 }));
  assert.throws(() => decodeNdjson(encoded.body, { bytes: encoded.bytes, sha256: '0'.repeat(64) }));
  for (const text of ['{}', '{}\n\n', 'null\n', '[]\n', '1\n', '{bad}\n', '\uFEFF{}\n']) {
    assert.throws(() => decodeNdjson(utf8(text)));
  }
  assert.throws(() => decodeNdjson(new Uint8Array([0xff, 10])));
  assert.throws(() => encodeNdjson([[]]));
  assert.throws(() => encodeNdjson([{ toJSON: () => null }]));
  const cyclic: { self?: object } = {}; cyclic.self = cyclic;
  assert.throws(() => encodeNdjson([cyclic]));
});

test('splits on complete lines at byte boundaries, never emits oversized parts', () => {
  const lines = [{ x: 'é' }, { x: 'é' }, { x: 'é' }];
  const size = encodeNdjson([lines[0]!]).bytes;
  const chunks = splitNdjson(lines, size * 2);
  assert.deepEqual(chunks.map(chunk => chunk.bytes), [size * 2, size]);
  assert.deepEqual(chunks.flatMap(chunk => decodeNdjson(chunk.body, chunk)), lines);
  assert.equal(splitNdjson(lines, size).length, 3);
  assert.deepEqual(splitNdjson([], 1), []);
  for (const size of [0, -1, 0.5, Infinity]) assert.throws(() => splitNdjson([], size));
  assert.throws(() => splitNdjson(lines, size - 1));
});

function fixture(): IndexFile {
  const index = emptyIndex('server-a', new Date('2026-11-13T00:00:00Z'));
  const entry = { path: 'a/b/schema.json', bytes: 0, sha256: hash(new Uint8Array()) };
  index.connections.a = {
    connectionId: 'a', connectorId: 'connector', manifestRef: null,
    streams: { b: {
      generation: 2, schema: entry,
      snapshot: { generation: 2, version: 4, parts: [] },
      changes: [{ ...entry, path: 'a/b/changes-2-5-7.ndjson', generation: 2, fromVersion: 5, toVersion: 7 }],
      lastCopiedVersion: 7,
    } },
  };
  return index;
}
test('index roundtrips with stable recursive order including special dictionary keys', () => {
  const index = fixture();
  assert.deepEqual(parseIndex(serializeIndex(index)), index);
  const reversed = (value: unknown): unknown => Array.isArray(value) ? value.map(reversed) :
    value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)])) : value;
  assert.deepEqual(serializeIndex(reversed(index) as IndexFile), serializeIndex(index));
  const special = JSON.parse(JSON.stringify(index).replace('"a":', '"__proto__":')) as IndexFile;
  assert.deepEqual(parseIndex(serializeIndex(special)), special);
  assert.deepEqual(parseIndex(serializeIndex(emptyIndex('a', new Date(0)))).connections, {});
  assert.throws(() => emptyIndex('a', new Date(NaN)));
});
test('index validates format, nested types, integrity metadata and version continuity', () => {
  const check = (change: (index: any) => void): void => {
    const index = fixture(); change(index);
    assert.throws(() => parseIndex(utf8(JSON.stringify(index))));
    assert.throws(() => serializeIndex(index));
  };
  check(i => { i.format = 'future'; });
  check(i => { delete i.writer; });
  check(i => { i.writer.lastWriteAt = 'not a date'; });
  check(i => { i.connections = []; });
  check(i => { i.connections.a.manifestRef = 1; });
  check(i => { i.connections.a.streams.b.schema.bytes = -1; });
  check(i => { i.connections.a.streams.b.schema.sha256 = 'no'; });
  check(i => { i.connections.a.streams.b.schema.path = '../escape'; });
  check(i => { i.connections.a.streams.b.schema.path = '%2e%2e/escape'; });
  check(i => { i.connections.a.streams.b.schema.path = 'https://example.com/escape'; });
  check(i => { i.connections.a.streams.b.snapshot.generation = 1; });
  check(i => { i.connections.a.streams.b.snapshot.parts = {}; });
  check(i => { i.connections.a.streams.b.changes[0].fromVersion = 6; });
  check(i => { i.connections.a.streams.b.changes[0].toVersion = 4; });
  check(i => { i.connections.a.streams.b.changes[0].generation = 3; });
  check(i => { i.connections.a.streams.b.lastCopiedVersion = 8; });
  assert.throws(() => parseIndex(utf8('null')));
  assert.throws(() => parseIndex(new Uint8Array([0xff])));
});
