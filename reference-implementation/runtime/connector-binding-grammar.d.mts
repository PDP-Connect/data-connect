// Type declarations for the vendored `connector-binding-grammar.mjs`, a byte
// copy of data-connectors schemas/connector-binding-grammar.mjs at commit
// a87edcdc099284e8582d24a60c9630474bd2af8b. Declarations mirror the exports as
// they are written in that module; they add no behaviour.

export class GrammarError extends Error {}

export function canonicalizeWebHost(raw: string, options?: { schemes?: Set<string> }): string;
export function isCanonicalWebHost(raw: string, options?: { schemes?: Set<string> }): boolean;
export function hostMatchesWildcardApex(apex: string, candidateHost: string): boolean;
export function canonicalizeConnectHost(raw: string): string;
export function isCanonicalConnectHost(raw: string): boolean;
export function canonicalizeEndpoint(raw: string): string;
export function isCanonicalEndpoint(raw: string): boolean;
export function canonicalizeNetworkHost(raw: string): string;
export function isCanonicalNetworkHost(raw: string): boolean;
export function deepEqualJson(a: unknown, b: unknown): boolean;
export function normalizeFilesystemInputs(instance: {
  inputs?: unknown[];
  constraints?: { inputs?: unknown[] };
}): unknown[] | undefined;
export function findDuplicateJsonKeys(jsonText: string): Array<{ path: string; key: string }>;
