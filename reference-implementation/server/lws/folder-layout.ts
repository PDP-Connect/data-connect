import { createHash } from 'node:crypto';

export interface FileEntry { path: string; bytes: number; sha256: string }
export interface ChangeFileEntry extends FileEntry { generation: number; fromVersion: number; toVersion: number }
export interface StreamEntry {
  generation: number;
  schema: FileEntry | null;
  snapshot: { generation: number; version: number; parts: FileEntry[] } | null;
  changes: ChangeFileEntry[];
  lastCopiedVersion: number;
}
export interface ConnectionEntry { connectionId: string; connectorId: string; manifestRef: string | null; streams: Record<string, StreamEntry> }
export interface IndexFile { format: "dataconnect-lws-v1"; writer: { serverId: string; lastWriteAt: string }; connections: Record<string, ConnectionEntry> }
export interface ChangeLine { key: string; version: number; op: "upsert" | "delete"; emitted_at: string; data: unknown | null }
export interface SnapshotLine { key: string; version: number; emitted_at: string; data: unknown }

type Encoded = { body: Uint8Array; bytes: number; sha256: string };
const encoder = new TextEncoder();
function fail(message: string): never { throw new Error(message); }
function integer(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('Expected nonnegative safe integer');
}
function object(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('Expected object');
}
function string(value: unknown): asserts value is string {
  if (typeof value !== 'string') fail('Expected string');
}
function segment(value: string): string {
  string(value);
  if (!value || value === '.' || value === '..') fail('Invalid path segment');
  return encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
}
function prefix(connectionId: string, stream: string): string {
  return segment(connectionId) + '/' + segment(stream) + '/';
}
export function schemaPath(connectionId: string, stream: string): string {
  return prefix(connectionId, stream) + 'schema.json';
}
export function snapshotPartPath(connectionId: string, stream: string, generation: number, version: number, part: number): string {
  integer(generation); integer(version); integer(part);
  return prefix(connectionId, stream) + `snapshot-${generation}-${version}-part-${part}.ndjson`;
}
export function changesPath(connectionId: string, stream: string, generation: number, from: number, to: number): string {
  integer(generation); integer(from); integer(to);
  if (from > to) fail('Reversed change range');
  return prefix(connectionId, stream) + `changes-${generation}-${from}-${to}.ndjson`;
}
function packed(body: Uint8Array): Encoded {
  return { body, bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex') };
}
function lineBytes(line: object): Uint8Array {
  object(line);
  const text = JSON.stringify(line);
  // toJSON may turn an object into a scalar; NDJSON in this format requires objects.
  if (text === undefined) fail('Line is not JSON');
  object(JSON.parse(text) as unknown);
  return encoder.encode(text + '\n');
}
function join(parts: readonly Uint8Array[]): Encoded {
  const body = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
  return packed(body);
}
export function encodeNdjson(lines: readonly object[]): Encoded {
  return join(lines.map(lineBytes));
}
export function decodeNdjson<T>(body: Uint8Array, expected?: { bytes: number; sha256: string }): T[] {
  if (expected) {
    integer(expected.bytes);
    if (body.byteLength !== expected.bytes || packed(body).sha256 !== expected.sha256) fail('NDJSON size/hash mismatch');
  }
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  if (text === '') return [];
  if (!text.endsWith('\n')) fail('NDJSON requires a final newline');
  return text.slice(0, -1).split('\n').map(line => {
    const value: unknown = JSON.parse(line);
    object(value);
    return value as T;
  });
}
export function splitNdjson(lines: readonly object[], maxBytes: number): Encoded[] {
  integer(maxBytes);
  if (maxBytes === 0) fail('maxBytes must be positive');
  const result: Encoded[] = [];
  let parts: Uint8Array[] = [], bytes = 0;
  for (const line of lines) {
    const part = lineBytes(line);
    if (part.byteLength > maxBytes) fail('One NDJSON line exceeds maxBytes');
    if (bytes + part.byteLength > maxBytes) { result.push(join(parts)); parts = []; bytes = 0; }
    parts.push(part); bytes += part.byteLength;
  }
  if (parts.length) result.push(join(parts));
  return result;
}
export function emptyIndex(serverId: string, now: Date): IndexFile {
  string(serverId);
  return { format: 'dataconnect-lws-v1', writer: { serverId, lastWriteAt: now.toISOString() }, connections: {} };
}
function file(value: unknown): asserts value is FileEntry {
  object(value); string(value.path); integer(value.bytes); string(value.sha256);
  if (!/^[a-f0-9]{64}$/.test(value.sha256)) fail('Invalid SHA256');
  if (!value.path || value.path.startsWith('/') || /[\\:?#]/.test(value.path)) fail('Invalid relative file path');
  for (const part of value.path.split('/')) {
    const decoded = decodeURIComponent(part);
    if (!part || decoded === '.' || decoded === '..') fail('Invalid relative file path');
  }
}
function validateIndex(value: unknown): asserts value is IndexFile {
  object(value);
  if (value.format !== 'dataconnect-lws-v1') fail('Unknown LWS index format');
  object(value.writer); string(value.writer.serverId); string(value.writer.lastWriteAt);
  if (!Number.isFinite(Date.parse(value.writer.lastWriteAt))) fail('Invalid writer timestamp');
  object(value.connections);
  for (const connection of Object.values(value.connections)) {
    object(connection); string(connection.connectionId); string(connection.connectorId);
    if (connection.manifestRef !== null) string(connection.manifestRef);
    object(connection.streams);
    for (const stream of Object.values(connection.streams)) {
      object(stream); integer(stream.generation); integer(stream.lastCopiedVersion);
      if (stream.schema !== null) file(stream.schema);
      let version = 0;
      if (stream.snapshot !== null) {
        object(stream.snapshot); integer(stream.snapshot.generation); integer(stream.snapshot.version);
        if (stream.snapshot.generation !== stream.generation) fail('Snapshot generation mismatch');
        if (!Array.isArray(stream.snapshot.parts)) fail('Expected snapshot parts');
        for (const part of stream.snapshot.parts) file(part);
        version = stream.snapshot.version;
      }
      if (!Array.isArray(stream.changes)) fail('Expected change files');
      for (const change of stream.changes) {
        file(change);
        const range = change as unknown as Record<string, unknown>;
        integer(range.generation); integer(range.fromVersion); integer(range.toVersion);
        if (range.generation !== stream.generation || range.fromVersion !== version + 1 || range.toVersion < range.fromVersion) fail('Noncontiguous change range or generation mismatch');
        version = range.toVersion;
      }
      if (stream.lastCopiedVersion !== version) fail('lastCopiedVersion mismatch');
    }
  }
}
export function parseIndex(body: Uint8Array): IndexFile {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body));
  validateIndex(value);
  return value;
}
// Sort recursively, including dictionary names, without assigning user keys to prototypes.
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value);
    if (text === undefined) fail('Non-JSON value in index');
    return text;
  }
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable((value as Record<string, unknown>)[key])).join(',') + '}';
}
export function serializeIndex(index: IndexFile): Uint8Array {
  validateIndex(index);
  return encoder.encode(stable(index));
}
