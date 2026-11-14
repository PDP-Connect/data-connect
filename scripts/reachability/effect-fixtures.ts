// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import net from "node:net"
import tls from "node:tls"
import type {
  JsonValue,
  ListenerEffectRequest,
  ListenerEffectResult,
  ArtifactEffectRequest,
  ArtifactEffectResult,
  ProcessEffectResult,
  LocalApiEffectRequest,
  LocalApiEffectResult,
  NetworkEffectRequest,
  ProcessEffectRequest,
  RecipeProbeRequest,
  SpawnEffectRequest,
  TestingEffect,
  TestingEffectContext,
} from "@tnunamak/gozar/testing"

type Listener = {
  handle: string
  url: string
  target: { host: string; port: number }
  present: boolean
  closeAttempts: number
}
type ServeWeb = { Handlers?: Record<string, { Proxy?: string }> }
type ServeConfig = {
  TCP?: Record<string, { HTTPS?: boolean }>
  Web?: Record<string, ServeWeb>
  Foreground?: Record<string, ServeConfig>
  AllowFunnel?: Record<string, boolean>
}
type RecipeResult = { stdout: string; stderr: string; exitCode: number }
type RecipeCase = {
  args: string[]
  output?: "node-status" | "serve-config"
  result?: RecipeResult
}
type NodeStatus = {
  BackendState: string
  Self: {
    ID: string
    DNSName: string
    TailscaleIPs: string[]
    CapMap: Record<string, string[]>
  }
  CurrentTailnet: { MagicDNSSuffix: string; MagicDNSEnabled: boolean }
  CertDomains: string[]
}
type FixtureData = {
  "recipe/probe": { cases: RecipeCase[]; nodeStatus: NodeStatus }
  "local-api/request": { statusPath: string; configPath: string }
  "spawn/run": {
    trialArgs: string[]
    trialOutput: string
    publicArgs: string[]
    privateArgs: string[]
    httpsPrefix: string
  }
  "artifact/fetch": { content: string }
  "artifact/execute": { result: ArtifactEffectResult }
  "sdk-listener/open": { safeFailureCode: string }
}
function effect<Input>(
  kind: string,
  operation: string,
  handler: (input: Input, context: TestingEffectContext) => Promise<JsonValue>
): TestingEffect {
  return {
    kind,
    operation,
    handle: (input, context) => handler(input as Input, context),
  }
}

function unsupported(): never {
  throw Object.assign(new Error("Fixture effect is unsupported"), {
    code: "unsupported",
  })
}
function targetAddress(addr: string) {
  const parsed = new URL(addr.includes("://") ? addr : `tcp://${addr}`)
  // Fixture effects may reach only the owned local gate, never a public account.
  if (!["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname))
    unsupported()
  return {
    host: parsed.hostname.replace(/^\[|\]$/g, ""),
    port: Number(parsed.port),
  }
}

const fixtureData = JSON.parse(
  readFileSync(
    new URL(
      "../../reference-implementation/test/fixtures/reachability/effects.json",
      import.meta.url
    ),
    "utf8"
  )
) as FixtureData
// Each handler is selected only by the public exact kind and operation pair.
export function createEffectFixtures({
  uncertainCloseOnce = false,
  streamDelayMs = 0,
  failInitialStream = false,
  sdkOpenFailure = false,
} = {}) {
  const listeners = new Map<string, Listener>()
  const origins = new Map<string, Listener>()
  const children = new Map<
    string,
    { child: ChildProcess; listener?: Listener }
  >()
  let serveConfig: ServeConfig = {},
    configRevision = 0
  const nodeStatus = fixtureData["recipe/probe"].nodeStatus
  const dnsName = nodeStatus.Self.DNSName.replace(/\.$/, "")
  function register(url: string, addr: string) {
    const parsed = new URL(url)
    url = `${parsed.protocol}//${parsed.host}`
    const item = {
      handle: randomUUID(),
      url,
      target: targetAddress(addr),
      present: true,
      closeAttempts: 0,
    }
    listeners.set(item.handle, item)
    origins.set(url, item)
    return item
  }
  function syncConfig() {
    for (const item of origins.values())
      if (item.url.includes(dnsName)) item.present = false
    const configs = [
      serveConfig,
      ...Object.values(serveConfig.Foreground ?? {}),
    ]
    for (const config of configs)
      for (const [authority, web] of Object.entries(config.Web ?? {})) {
        const proxy = web.Handlers?.["/"]?.Proxy
        if (typeof proxy === "string") register(`https://${authority}`, proxy)
      }
  }
  function sourceOutput(args: string[]) {
    const row = fixtureData["recipe/probe"].cases.find(
      row => JSON.stringify(row.args) === JSON.stringify(args)
    )
    if (!row) unsupported()
    if (row.result) return row.result
    return {
      stdout: JSON.stringify(
        row.output === "node-status" ? nodeStatus : serveConfig
      ),
      stderr: "",
      exitCode: 0,
    }
  }
  async function closeChild(handle: string) {
    const record = children.get(handle)
    if (!record) unsupported()
    if (record.child.exitCode === null && record.child.signalCode === null) {
      const exited = new Promise<void>(resolve =>
        record.child.once("exit", () => resolve())
      )
      record.child.kill("SIGTERM")
      await exited
    }
    if (record.listener) record.listener.present = false
    delete serveConfig.Foreground?.[handle]
    syncConfig()
    return { closed: true }
  }
  let credentialSeen = false
  let initialStreamSeen = false
  let artifactExecutions = 0
  function entry(endpoint: string) {
    const parsed = new URL(endpoint)
    const origin = `${parsed.protocol}//${parsed.host}`
    const item = origins.get(origin)
    if (!item || !item.present) unsupported()
    return item
  }
  const effects = [
    effect<Extract<ProcessEffectRequest, { operation: "detect" }>["input"]>(
      "process-runtime",
      "detect",
      async () => ({ available: true })
    ),
    effect<Extract<ProcessEffectRequest, { operation: "open" }>["input"]>(
      "process-runtime",
      "open",
      async input => {
        assertTransientProcessCredential(input)
        credentialSeen = Boolean(input.credential)
        const item = register(input.origin, input.target)
        return { handle: item.handle }
      }
    ),
    effect<
      Extract<ProcessEffectRequest, { operation: "read" | "close" }>["input"]
    >(
      "process-runtime",
      "read",
      async ({ handle }): Promise<ProcessEffectResult> => {
        const item = listeners.get(handle)
        if (!item) unsupported()
        return { present: item.present }
      }
    ),
    effect<
      Extract<ProcessEffectRequest, { operation: "read" | "close" }>["input"]
    >("process-runtime", "close", async ({ handle }) => {
      const item = listeners.get(handle)
      if (!item) unsupported()
      if (uncertainCloseOnce && ++item.closeAttempts === 1)
        return { closed: false }
      item.present = false
      return { closed: true }
    }),
    effect<RecipeProbeRequest["input"]>(
      "recipe",
      "probe",
      async ({ recipe }) => {
        if (
          !recipe ||
          typeof recipe !== "object" ||
          Array.isArray(recipe) ||
          !Array.isArray(recipe.args)
        )
          unsupported()
        return sourceOutput(recipe.args as string[])
      }
    ),
    effect<LocalApiEffectRequest["input"]>(
      "local-api",
      "request",
      async ({
        path,
        method,
        headers,
        body,
      }): Promise<LocalApiEffectResult> => {
        const data = fixtureData["local-api/request"]
        if (path === data.statusPath && method === "GET")
          return { status: 200, headers: {}, body: JSON.stringify(nodeStatus) }
        if (path !== data.configPath) unsupported()
        if (method === "GET")
          return {
            status: 200,
            headers: { etag: String(configRevision) },
            body: JSON.stringify(serveConfig),
          }
        if (method !== "POST") unsupported()
        if (headers["If-Match"] !== String(configRevision))
          return { status: 412, headers: {}, body: "" }
        if (!body || typeof body !== "object" || Array.isArray(body))
          unsupported()
        serveConfig = structuredClone(body)
        configRevision++
        syncConfig()
        return { status: 200, headers: {}, body: "" }
      }
    ),
    effect<Extract<SpawnEffectRequest, { operation: "run" }>["input"]>(
      "spawn",
      "run",
      async ({ args, longRunning }) => {
        if (!longRunning) return sourceOutput(args)
        const data = fixtureData["spawn/run"]
        let item: Listener,
          output = ""
        const handle = randomUUID()
        if (data.trialArgs.every((arg: string) => args.includes(arg))) {
          const redirect = args[args.indexOf(data.trialArgs[0]) + 1]
          const port = Number(redirect?.split(":").at(-1))
          if (!port) unsupported()
          output = data.trialOutput
          item = register(output.trim(), `localhost:${port}`)
        } else {
          const port = Number(
            args
              .find(arg => arg.startsWith(data.httpsPrefix))
              ?.slice(data.httpsPrefix.length)
          )
          if (!port) unsupported()
          const proxy = args.at(-1)!
          const authority = `${dnsName}:${port}`
          const config: ServeConfig = {
            TCP: { [port]: { HTTPS: true } },
            Web: { [authority]: { Handlers: { "/": { Proxy: proxy } } } },
          }
          if (data.publicArgs.every((arg: string) => args.includes(arg)))
            config.AllowFunnel = { [authority]: true }
          else if (!data.privateArgs.every((arg: string) => args.includes(arg)))
            unsupported()
          ;(serveConfig.Foreground ??= {})[handle] = config
          item = register(`https://${authority}`, proxy)
        }
        // An actual harmless child supplies a verifiable PID and birth identity.
        const child = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          { stdio: "ignore", env: {} }
        )
        if (!child.pid) unsupported()
        children.set(handle, { child, listener: item })
        return {
          stdout: output,
          stderr: "",
          exitCode: null,
          handle,
          pid: child.pid,
        }
      }
    ),
    effect<Extract<SpawnEffectRequest, { operation: "read" }>["input"]>(
      "spawn",
      "read",
      async ({ handle }) => {
        const item = children.get(handle)
        if (!item) unsupported()
        return {
          present:
            item.child.exitCode === null && item.child.signalCode === null,
          ...(item.child.exitCode === null
            ? {}
            : { exitCode: item.child.exitCode }),
        }
      }
    ),
    effect<Extract<SpawnEffectRequest, { operation: "close" }>["input"]>(
      "spawn",
      "close",
      async ({ handle }) => closeChild(handle)
    ),
    effect<Record<string, never>>("sdk-listener", "detect", async () => ({
      available: true,
    })),
    effect<Extract<ListenerEffectRequest, { operation: "open" }>["input"]>(
      "sdk-listener",
      "open",
      async ({ options }, { signal }): Promise<ListenerEffectResult> => {
        signal.throwIfAborted()
        if (sdkOpenFailure)
          return {
            error: { code: fixtureData["sdk-listener/open"].safeFailureCode },
          }
        const target = targetAddress(options.addr)
        if (typeof options.authtoken !== "string" || !options.authtoken)
          unsupported()
        credentialSeen = true // Never retain or log the token.
        const handle = randomUUID()
        const scheme =
          options.proto === "tcp" || options.proto === "tls"
            ? options.proto
            : "https"
        const authority =
          options.remote_addr ?? options.domain ?? `${handle}.invalid`
        const allocated = new URL(
          authority.includes("://") ? authority : `${scheme}://${authority}`
        )
        if (scheme === "tls" && !allocated.port) allocated.port = "443"
        const url = `${allocated.protocol}//${allocated.host}`
        const item = { handle, url, target, present: true, closeAttempts: 0 }
        listeners.set(handle, item)
        origins.set(url, item)
        return { handle, url }
      }
    ),
    effect<
      Extract<ListenerEffectRequest, { operation: "read" | "close" }>["input"]
    >(
      "sdk-listener",
      "read",
      async ({ handle }): Promise<ListenerEffectResult> => {
        const item = listeners.get(handle)
        if (!item) unsupported()
        return item.present
          ? { present: true, url: item.url }
          : { present: false }
      }
    ),
    effect<
      Extract<ListenerEffectRequest, { operation: "read" | "close" }>["input"]
    >("sdk-listener", "close", async ({ handle }) => {
      const item = listeners.get(handle)
      if (!item) unsupported()
      item.closeAttempts++
      if (uncertainCloseOnce && item.closeAttempts === 1)
        return { closed: false }
      item.present = false
      return { closed: true }
    }),
    effect<Extract<ArtifactEffectRequest, { operation: "fetch" }>["input"]>(
      "artifact",
      "fetch",
      async () => ({
        bytes: Buffer.from(fixtureData["artifact/fetch"].content).toString(
          "base64"
        ),
      })
    ),
    effect<Extract<ArtifactEffectRequest, { operation: "execute" }>["input"]>(
      "artifact",
      "execute",
      async ({ bytes }): Promise<ArtifactEffectResult> => {
        const expected = Buffer.from(
          fixtureData["artifact/fetch"].content
        ).toString("base64")
        if (bytes !== expected) unsupported()
        artifactExecutions++
        return fixtureData["artifact/execute"].result
      }
    ),
    effect<Extract<NetworkEffectRequest, { operation: "fetch" }>["input"]>(
      "network",
      "fetch",
      async ({ url, method, headers }, { signal }) => {
        const item = entry(url),
          request = new URL(url)
        const target = new URL(
          `http://${net.isIP(item.target.host) === 6 ? `[${item.target.host}]` : item.target.host}:${item.target.port}`
        )
        target.pathname = request.pathname
        target.search = request.search
        const response = await fetch(target, {
          method,
          headers,
          signal,
          redirect: "error",
        })
        const body = Buffer.from(await response.arrayBuffer())
        const stream =
          response.headers.get("content-type")?.split(";")[0] ===
          "text/event-stream"
        if (stream) initialStreamSeen = true
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          chunks: [
            {
              data: (stream && failInitialStream
                ? body.subarray(0, 1)
                : body
              ).toString("base64"),
              delayMs: stream ? streamDelayMs : 0,
            },
          ],
        }
      }
    ),
    effect<Extract<NetworkEffectRequest, { operation: "exchange" }>["input"]>(
      "network",
      "exchange",
      async (
        { endpoint, transport, bytes, pinnedCertificate, deadlineMs },
        { signal }
      ) => {
        const item = entry(endpoint)
        // A TLS result must carry real gate TLS evidence; never invent a cert.
        if (transport !== "tcp" && transport !== "tls") unsupported()
        return new Promise<JsonValue>((resolve, reject) => {
          signal.throwIfAborted()
          const socket =
            transport === "tls"
              ? tls.connect({ ...item.target, rejectUnauthorized: false })
              : net.connect(item.target)
          const chunks: Buffer[] = []
          const timer = setTimeout(
            () =>
              socket.destroy(new Error("Fixture exchange deadline exceeded")),
            Math.max(1, Math.min(10_000, deadlineMs - Date.now()))
          )
          const abort = () =>
            socket.destroy(new Error("Fixture exchange cancelled"))
          signal.addEventListener("abort", abort, { once: true })
          socket.once(transport === "tls" ? "secureConnect" : "connect", () => {
            if (
              socket instanceof tls.TLSSocket &&
              pinnedCertificate &&
              socket
                .getPeerCertificate()
                .fingerprint256?.replaceAll(":", "")
                .toLowerCase() !==
                pinnedCertificate.replaceAll(":", "").toLowerCase()
            ) {
              socket.destroy(new Error("Fixture certificate mismatch"))
              return
            }
            socket.end(Buffer.from(bytes, "base64"))
          })
          socket.on("data", data =>
            chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
          )
          socket.once("error", reject)
          socket.once("end", () => {
            const result: { bytes: string; certificate?: string } = {
              bytes: Buffer.concat(chunks).toString("base64"),
            }
            if (socket instanceof tls.TLSSocket) {
              const raw = socket.getPeerCertificate().raw
              if (raw)
                result.certificate = `-----BEGIN CERTIFICATE-----\n${raw
                  .toString("base64")
                  .match(/.{1,64}/g)
                  ?.join("\n")}\n-----END CERTIFICATE-----\n`
            }
            resolve(result)
          })
          socket.once("close", () => {
            clearTimeout(timer)
            signal.removeEventListener("abort", abort)
          })
        })
      }
    ),
  ]
  return {
    effects,
    get initialStreamSeen() {
      return initialStreamSeen
    },
    get credentialSeen() {
      return credentialSeen
    },
    get artifactExecutions() {
      return artifactExecutions
    },
    // Deliberately redacted ledger for leak assertions and independent absence.
    ledger: () =>
      [...listeners.values()].map(({ handle, url, present }) => ({
        handle,
        url,
        present,
      })),
    close: async () => {
      for (const handle of children.keys()) await closeChild(handle)
      for (const item of listeners.values()) item.present = false
      origins.clear()
    },
  }
}

// Check transient credential delivery before any trace or ledger write.
export function assertTransientProcessCredential(input: JsonValue): void {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof input.credential !== "string" ||
    !input.credential
  )
    return
  const credential = input.credential
  function contains(value: JsonValue): boolean {
    if (typeof value === "string") return value.includes(credential)
    if (value && typeof value === "object")
      return Object.values(value).some(contains)
    return false
  }
  if (
    Object.entries(input).some(
      ([key, value]) => key !== "credential" && contains(value)
    )
  ) {
    throw new Error("Credential must not be delivered through process metadata")
  }
}
