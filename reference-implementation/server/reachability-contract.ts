// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Provider-neutral reachability contract for the reference server.
 *
 * The parser is pure. Startup reads the environment and passes the snapshot
 * here; request policy then uses the parsed values without reading process.env.
 * This keeps the security boundary small enough to test without listeners.
 */

import { BlockList, isIP } from "node:net"

export const DEFAULT_BIND_HOST = "127.0.0.1"

const FORWARDED_HEADER_RE = /^x-forwarded-/i
const HOST_SEPARATOR_RE = /[\s,]/
const HOST_PATTERN_RE = /^(\*\.)?([^:]+)(?::(\d+))?$/
const TRAILING_DOT_RE = /\.+$/

export interface ReachabilityEnv {
  readonly PDPP_BIND_HOST?: string | undefined
  readonly PDPP_REFERENCE_ORIGIN?: string | undefined
  readonly PDPP_TRUSTED_HOSTS?: string | undefined
  readonly PDPP_TRUSTED_PROXIES?: string | undefined
}

export interface ReachabilityContractOverrides {
  readonly bindHost?: string | null | undefined
  readonly referenceOrigin?: string | null | undefined
  readonly trustedHosts?: string | null | undefined
  readonly trustedProxies?: string | null | undefined
}

export interface ReachabilityContract {
  readonly bindHost: string
  readonly referenceOrigin: string | null
  readonly trustedHosts: readonly TrustedHostPattern[]
  readonly trustedProxies: readonly TrustedProxy[]
}

export interface ReachabilityRequest {
  headers?: Readonly<Record<string, string | string[] | undefined>>
  get?: (name: string) => string | undefined
  path?: string
  protocol?: string
  raw?: {
    readonly socket?: { readonly remoteAddress?: string }
    readonly url?: string
  }
  socket?: { readonly remoteAddress?: string }
  connection?: { readonly remoteAddress?: string }
}

export interface ReachabilityResponseDecision {
  readonly code: "invalid_host" | "invalid_origin"
  readonly message: string
  readonly status: 400 | 403
}

export interface ReachabilityRequestContext {
  readonly hosted: boolean
  readonly referenceOrigin: string | null
}

export const REACHABILITY_REQUEST_CONTEXT = Symbol.for(
  "pdpp.reachability.request-context"
)

export type ReachabilityRequestWithContext = ReachabilityRequest & {
  [REACHABILITY_REQUEST_CONTEXT]?: ReachabilityRequestContext
}

interface TrustedHostPattern {
  readonly hostname: string
  readonly port: string | null
  readonly wildcard: boolean
}

interface TrustedProxy {
  readonly address: string
  readonly prefixLength: number
  readonly type: "ipv4" | "ipv6"
}

interface ParsedHost {
  readonly hostname: string
  readonly port: string | null
}

export class ReachabilityContractError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = "ReachabilityContractError"
    this.field = field
  }
}

function readOverride(
  override: string | null | undefined,
  envValue: string | undefined,
  defaultValue: string | null
): string | null {
  if (override !== undefined) {
    const value = override?.trim() ?? ""
    return value || null
  }
  const value = envValue?.trim() ?? ""
  return value || defaultValue
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(TRAILING_DOT_RE, "")
}

function stripBrackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value
}

export function isLoopbackBindHost(host: string | null | undefined): boolean {
  if (typeof host !== "string") {
    return true
  }
  const normalized = normalizeHostname(stripBrackets(host))
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  )
}

export function isLoopbackOriginHost(hostname: string): boolean {
  const normalized = normalizeHostname(stripBrackets(hostname))
  return (
    normalized === "localhost" ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    normalized.startsWith("127.") ||
    normalized.endsWith(".local")
  )
}

export function isNonLoopbackBindHost(host: string): boolean {
  return !isLoopbackBindHost(host)
}

function parseOrigin(rawValue: string | null): string | null {
  if (!rawValue) {
    return null
  }
  let origin: URL
  try {
    origin = new URL(rawValue)
  } catch {
    throw new ReachabilityContractError(
      "PDPP_REFERENCE_ORIGIN",
      "must be an absolute http(s) origin such as https://vault.example.com"
    )
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    !origin.hostname ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new ReachabilityContractError(
      "PDPP_REFERENCE_ORIGIN",
      "must contain only an absolute http(s) scheme, host, and optional port; paths, queries, and fragments are not allowed"
    )
  }
  return origin.origin
}

function parseHostPattern(rawValue: string): TrustedHostPattern {
  const value = rawValue.trim().toLowerCase()
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value)
  if (bracketed && isIP(bracketed[1] ?? "") === 6) {
    return {
      hostname: normalizeHostname(bracketed[1] ?? ""),
      port: bracketed[2] ?? null,
      wildcard: false,
    }
  }
  if (isIP(value) === 6) {
    return { hostname: normalizeHostname(value), port: null, wildcard: false }
  }
  const match = HOST_PATTERN_RE.exec(value)
  if (!match || HOST_SEPARATOR_RE.test(value) || value.includes("/")) {
    throw new ReachabilityContractError(
      "PDPP_TRUSTED_HOSTS",
      `contains malformed host '${rawValue}'. Use comma-separated hostnames or *.example.com wildcards`
    )
  }
  const hostname = normalizeHostname(match[2] ?? "")
  if (!hostname || hostname.startsWith(".") || hostname.endsWith(".")) {
    throw new ReachabilityContractError(
      "PDPP_TRUSTED_HOSTS",
      `contains malformed host '${rawValue}'`
    )
  }
  return { hostname, port: match[3] ?? null, wildcard: Boolean(match[1]) }
}

function parseTrustedHosts(
  rawValue: string | null
): readonly TrustedHostPattern[] {
  if (!rawValue) {
    return []
  }
  return rawValue
    .split(",")
    .filter(entry => entry.trim())
    .map(parseHostPattern)
}

function parseTrustedProxy(rawValue: string): TrustedProxy {
  const value = rawValue.trim()
  try {
    const parts = value.split("/")
    if (parts.length > 2) {
      throw new Error("invalid proxy")
    }
    const [address, prefix] = parts
    const normalizedAddress = address ?? ""
    const version = isIP(normalizedAddress)
    if (
      version === 0 ||
      (value.includes("/") && (!prefix || !/^\d+$/.test(prefix)))
    ) {
      throw new Error("invalid proxy")
    }
    const prefixLength =
      prefix === undefined ? (version === 4 ? 32 : 128) : Number(prefix)
    if (prefixLength < 0 || prefixLength > (version === 4 ? 32 : 128)) {
      throw new Error("invalid prefix")
    }
    return {
      address: normalizedAddress,
      prefixLength,
      type: version === 4 ? "ipv4" : "ipv6",
    }
  } catch {
    throw new ReachabilityContractError(
      "PDPP_TRUSTED_PROXIES",
      `contains malformed IP or CIDR '${rawValue}'. Use comma-separated IP addresses or CIDRs`
    )
  }
}

function parseTrustedProxies(rawValue: string | null): readonly TrustedProxy[] {
  if (!rawValue) {
    return []
  }
  return rawValue
    .split(",")
    .filter(entry => entry.trim())
    .map(parseTrustedProxy)
}

function parseBindHost(rawValue: string | null): string {
  if (!rawValue) {
    return DEFAULT_BIND_HOST
  }
  const normalized = stripBrackets(rawValue.trim())
  if (isIP(normalized) === 0) {
    throw new ReachabilityContractError(
      "PDPP_BIND_HOST",
      "must be an IP literal such as 127.0.0.1 or ::1"
    )
  }
  return normalized
}

export function parseReachabilityContract({
  env = process.env,
  bindHost,
  referenceOrigin,
  trustedHosts,
  trustedProxies,
}: ReachabilityContractOverrides & {
  readonly env?: ReachabilityEnv
} = {}): ReachabilityContract {
  const originValue = readOverride(
    referenceOrigin,
    env.PDPP_REFERENCE_ORIGIN,
    null
  )
  const trustedHostsValue = readOverride(
    trustedHosts,
    env.PDPP_TRUSTED_HOSTS,
    null
  )
  const trustedProxiesValue = readOverride(
    trustedProxies,
    env.PDPP_TRUSTED_PROXIES,
    null
  )
  const bindHostValue = readOverride(bindHost, env.PDPP_BIND_HOST, null)
  return {
    bindHost: parseBindHost(bindHostValue),
    referenceOrigin: parseOrigin(originValue),
    trustedHosts: parseTrustedHosts(trustedHostsValue),
    trustedProxies: parseTrustedProxies(trustedProxiesValue),
  }
}

export function validateReachabilityContract(
  contract: ReachabilityContract,
  hosted: boolean
): void {
  if (hosted && !contract.referenceOrigin) {
    throw new ReachabilityContractError(
      "PDPP_REFERENCE_ORIGIN",
      "is required for hosted posture. Set it, or use the loopback default PDPP_BIND_HOST=127.0.0.1; also set PDPP_TRUSTED_HOSTS when a proxy host differs"
    )
  }
  if (hosted && contract.referenceOrigin) {
    const hostname = new URL(contract.referenceOrigin).hostname
    if (isLoopbackOriginHost(hostname)) {
      throw new ReachabilityContractError(
        "PDPP_REFERENCE_ORIGIN",
        "must use a non-loopback host in hosted posture; set it to the published origin"
      )
    }
  }
}

function headerValue(
  req: ReachabilityRequest,
  name: string
): string | undefined {
  const fromGetter = req.get?.(name)
  if (typeof fromGetter === "string") {
    return fromGetter
  }
  const value = req.headers?.[name.toLowerCase()]
  return typeof value === "string" ? value : undefined
}

function isMcpRequest(req: ReachabilityRequest): boolean {
  const path = req.path || req.raw?.url?.split("?", 1)[0]
  return path === "/mcp"
}

function peerAddress(req: ReachabilityRequest): string | null {
  return (
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    req.raw?.socket?.remoteAddress ||
    null
  )
}

function isTrustedProxyPeer(
  req: ReachabilityRequest,
  trustedProxies: readonly TrustedProxy[]
): boolean {
  const rawPeer = peerAddress(req)
  if (!rawPeer || trustedProxies.length === 0) {
    return false
  }
  try {
    return trustedProxies.some(({ address, prefixLength, type }) => {
      try {
        const version = isIP(rawPeer)
        if (version === 0 || type !== (version === 4 ? "ipv4" : "ipv6")) {
          return false
        }
        const blockList = new BlockList()
        blockList.addSubnet(address, prefixLength, type)
        return blockList.check(rawPeer, type)
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

export function discardUntrustedForwardedHeaders(
  req: ReachabilityRequest,
  contract: ReachabilityContract
): boolean {
  if (isTrustedProxyPeer(req, contract.trustedProxies)) {
    return false
  }
  let discarded = false
  for (const name of Object.keys(req.headers ?? {})) {
    if (FORWARDED_HEADER_RE.test(name) || name.toLowerCase() === "forwarded") {
      delete (req.headers as Record<string, string | string[] | undefined>)[
        name
      ]
      discarded = true
    }
  }
  return discarded
}

function parseRequestHost(rawValue: string | undefined): ParsedHost | null {
  if (!rawValue || HOST_SEPARATOR_RE.test(rawValue.trim())) {
    return null
  }
  const value = rawValue.trim()
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value)
  if (bracketed) {
    return {
      hostname: normalizeHostname(bracketed[1] ?? ""),
      port: bracketed[2] ?? null,
    }
  }
  const match = /^([^:]+)(?::(\d+))?$/.exec(value)
  if (!match) {
    return null
  }
  const hostname = normalizeHostname(match[1] ?? "")
  if (!hostname) {
    return null
  }
  return { hostname, port: match[2] ?? null }
}

function hostMatches(
  pattern: TrustedHostPattern,
  request: ParsedHost
): boolean {
  if (pattern.port && pattern.port !== request.port) {
    return false
  }
  if (pattern.wildcard) {
    return (
      request.hostname.endsWith(`.${pattern.hostname}`) &&
      request.hostname !== pattern.hostname
    )
  }
  return request.hostname === pattern.hostname
}

function originHostPattern(origin: string): TrustedHostPattern {
  const parsed = new URL(origin)
  return {
    hostname: normalizeHostname(stripBrackets(parsed.hostname)),
    port: parsed.port || null,
    wildcard: false,
  }
}

export function isAllowedRequestHost(
  req: ReachabilityRequest,
  contract: ReachabilityContract
): boolean {
  const fromTrustedProxy = isTrustedProxyPeer(req, contract.trustedProxies)
  const rawHost = fromTrustedProxy
    ? (headerValue(req, "x-forwarded-host") ?? headerValue(req, "host"))
    : headerValue(req, "host")
  const request = parseRequestHost(rawHost)
  if (!request) {
    return false
  }
  // A request whose Host names this process's OWN bind address is the
  // process talking to itself: `isLoopbackBindHost` is only true for a
  // listener that accepts loopback connections exclusively (127.0.0.1,
  // ::1, localhost -- NOT 0.0.0.0, which is a real bind-all posture this
  // exemption must not weaken), so nothing external can cause such a
  // listener to receive a connection it did not originate locally. This is
  // the trust the internal readiness probe, owner-login bootstrap, and the
  // console's own server-side calls to the reference server all need once
  // PDPP_TRUSTED_HOSTS is a public hostname none of them present -- without
  // it, every loopback-originated caller inside this same machine is
  // rejected identically to an external DNS-rebinding attempt.
  //
  // Deliberately excluded from `fromTrustedProxy`: `x-forwarded-host` is
  // attacker-controlled from any peer that is not itself a trusted proxy,
  // so an untrusted remote caller could otherwise claim a loopback Host
  // through a forwarded header and pass this check without ever holding a
  // real loopback connection. Only the OWN un-proxied `Host` header --
  // which requires actually connecting to the loopback-bound listener --
  // is eligible for this exemption. The request's claimed host must
  // exactly match `bindHost` (not merely "also happen to be loopback"),
  // since a request naming a DIFFERENT loopback family than the one this
  // process actually bound is not this process's own traffic.
  if (
    !fromTrustedProxy &&
    isLoopbackBindHost(contract.bindHost) &&
    request.hostname === normalizeHostname(stripBrackets(contract.bindHost))
  ) {
    return true
  }
  if (
    contract.referenceOrigin &&
    hostMatches(originHostPattern(contract.referenceOrigin), request)
  ) {
    return true
  }
  return contract.trustedHosts.some(pattern => hostMatches(pattern, request))
}

function isPrivateOrLoopbackOriginHost(hostname: string): boolean {
  const normalized = normalizeHostname(stripBrackets(hostname))
  if (isLoopbackOriginHost(normalized) || normalized.endsWith(".local")) {
    return true
  }
  try {
    const version = isIP(normalized)
    if (version === 4) {
      const [first = -1, second = -1] = normalized.split(".").map(Number)
      return (
        first === 10 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) ||
        (first === 169 && second === 254)
      )
    }
    if (version === 6) {
      const blockList = new BlockList()
      blockList.addSubnet("fc00::", 7, "ipv6")
      blockList.addSubnet("fe80::", 10, "ipv6")
      return blockList.check(normalized, "ipv6")
    }
    return false
  } catch {
    return false
  }
}

export function isAllowedMcpOrigin(
  req: ReachabilityRequest,
  contract: ReachabilityContract
): boolean {
  const rawOrigin = headerValue(req, "origin")
  if (!rawOrigin) {
    return true
  }
  let origin: URL
  try {
    origin = new URL(rawOrigin)
  } catch {
    return false
  }
  if (
    !origin.protocol ||
    !origin.hostname ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    return false
  }
  if (contract.referenceOrigin) {
    return origin.origin === contract.referenceOrigin
  }
  return isPrivateOrLoopbackOriginHost(origin.hostname)
}

export function attachReachabilityRequestContext(
  req: ReachabilityRequestWithContext,
  context: ReachabilityRequestContext
): void {
  req[REACHABILITY_REQUEST_CONTEXT] = context
}

export function getReachabilityRequestContext(
  req: ReachabilityRequest
): ReachabilityRequestContext | null {
  return (
    (req as ReachabilityRequestWithContext)[REACHABILITY_REQUEST_CONTEXT] ??
    null
  )
}

export function evaluateReachabilityRequest(
  req: ReachabilityRequestWithContext,
  contract: ReachabilityContract,
  {
    hosted,
    mcpSurface = false,
  }: { readonly hosted: boolean; readonly mcpSurface?: boolean }
): ReachabilityResponseDecision | null {
  discardUntrustedForwardedHeaders(req, contract)
  attachReachabilityRequestContext(req, {
    hosted,
    referenceOrigin: contract.referenceOrigin,
  })
  if (hosted && !isAllowedRequestHost(req, contract)) {
    return {
      code: "invalid_host",
      message:
        "Request host is not allowed. Set PDPP_REFERENCE_ORIGIN to the published origin or add the proxy host to PDPP_TRUSTED_HOSTS.",
      status: 400,
    }
  }
  if (mcpSurface && isMcpRequest(req) && !isAllowedMcpOrigin(req, contract)) {
    return {
      code: "invalid_origin",
      message:
        "Origin is not allowed for MCP. Set PDPP_REFERENCE_ORIGIN to the published origin.",
      status: 403,
    }
  }
  return null
}
