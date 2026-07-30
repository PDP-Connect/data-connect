/**
 * Black-box PDPP interoperability contract for DataConnect.
 *
 * The desktop Personal Server package currently exposes legacy grant routes,
 * not the PDPP AS/RS routes required by this journey. This harness therefore
 * runs the real local PDPP reference Personal Server package, uses its real
 * GitHub seed connector for ingestion, and uses the reference third-party
 * client helpers plus public HTTP for the grant/read journey. It deliberately
 * does not replace any server request with a mock.
 *
 * Required contract ports:
 * - ConsentGrantStore: PAR, owner approve/deny, and grant revocation
 * - TokenIntrospector: bearer validity before and after restart
 * - GrantScopedRecordsRepository: stream/record reads and field enforcement
 */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const PDPP_ROOT =
  process.env.DATACONNECT_PDPP_ROOT || "/home/tnunamak/code/pdpp"
const REFERENCE_ROOT = join(PDPP_ROOT, "reference-implementation")
const TEST_DCR_INITIAL_ACCESS_TOKEN = "dataconnect-pdpp-interop-dcr-token"
const OWNER_BOOTSTRAP_CLIENT_ID = "cli_longview"

function requiredPath(path) {
  assert.ok(
    existsSync(path),
    `PDPP reference prerequisite is missing: ${path}. Set DATACONNECT_PDPP_ROOT to a PDPP checkout.`
  )
  return path
}

const referenceServerPath = requiredPath(
  join(REFERENCE_ROOT, "server", "index.js")
)
const referenceFlowPath = requiredPath(
  join(REFERENCE_ROOT, "examples", "third-party-app", "lib", "flow.js")
)
const referenceContractBuildersPath = requiredPath(
  join(
    PDPP_ROOT,
    "packages",
    "reference-contract",
    "src",
    "builders",
    "index.ts"
  )
)
const referenceRuntimePath = requiredPath(
  join(REFERENCE_ROOT, "runtime", "index.js")
)
const githubManifestPath = requiredPath(
  join(REFERENCE_ROOT, "manifests", "github.json")
)
const githubSeedConnectorPath = requiredPath(
  join(REFERENCE_ROOT, "connectors", "seed", "index.js")
)

const { startServer } = await import(referenceServerPath)
const { runConnector } = await import(referenceRuntimePath)
const {
  approveInline,
  buildHostedApprovalUrl,
  denyInline,
  introspectToken,
  queryStreamRecords,
  queryStreams,
  registerClient,
  stageParRequest,
} = await import(referenceFlowPath)
const { buildParRequest } = await import(referenceContractBuildersPath)

async function closeReferenceServer(server) {
  server.schedulerManager?.stop?.()
  server.stopBrowserSurfaceLeaseSweep?.()
  server.asServer.closeAllConnections()
  server.rsServer.closeAllConnections()

  await Promise.allSettled([
    new Promise(resolve => server.asServer.close(resolve)),
    new Promise(resolve => server.rsServer.close(resolve)),
  ])
}

async function startReferencePersonalServer(dbPath) {
  const server = await startServer({
    asPort: 0,
    dbPath,
    dynamicClientRegistrationInitialAccessTokens: [
      TEST_DCR_INITIAL_ACCESS_TOKEN,
    ],
    ignoreAmbientPublicUrls: true,
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })

  return {
    server,
    asUrl: `http://127.0.0.1:${server.asPort}`,
    rsUrl: `http://127.0.0.1:${server.rsPort}`,
  }
}

async function readJson(response, message) {
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  assert.equal(response.ok, true, `${message} (${response.status}): ${text}`)
  return body
}

async function issueOwnerToken(asUrl, subjectId) {
  const deviceResponse = await fetch(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({
      client_id: OWNER_BOOTSTRAP_CLIENT_ID,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  })
  const device = await readJson(
    deviceResponse,
    "owner device authorization failed"
  )

  const approvalResponse = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({
      subject_id: subjectId,
      user_code: device.user_code,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  })
  await readJson(approvalResponse, "owner device approval failed")

  const tokenResponse = await fetch(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: OWNER_BOOTSTRAP_CLIENT_ID,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  })
  const token = await readJson(
    tokenResponse,
    "owner device token redemption failed"
  )
  assert.equal(typeof token.access_token, "string")
  return token.access_token
}

async function seedGitHubRecords({ asUrl, rsUrl, subjectId }) {
  const githubManifest = JSON.parse(await readFile(githubManifestPath, "utf8"))
  const registerResponse = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(githubManifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  })
  await readJson(registerResponse, "GitHub connector registration failed")

  const result = await runConnector({
    collectionMode: "full_refresh",
    connectorId: githubManifest.connector_id,
    connectorPath: githubSeedConnectorPath,
    manifest: githubManifest,
    ownerToken: await issueOwnerToken(asUrl, subjectId),
    rsUrl,
    state: null,
  })
  assert.equal(
    result.status,
    "succeeded",
    "the real GitHub seed connector must succeed"
  )
}

function createPersonalServerPorts({ asUrl, rsUrl }) {
  return {
    ConsentGrantStore: {
      stage: request => stageParRequest({ asUrl, request }),
      approveTestSeam: (requestUri, subjectId) =>
        approveInline({ asUrl, requestUri, subjectId }),
      denyTestSeam: requestUri => denyInline({ asUrl, requestUri }),
      async approveForBearerRedemption(requestUri, subjectId) {
        const approvalUrl = buildHostedApprovalUrl({ asUrl, requestUri })
        assert.equal(new URL(approvalUrl).pathname, "/consent")

        const response = await fetch(`${asUrl}/consent/approve`, {
          body: new URLSearchParams({
            request_uri: requestUri,
            subject_id: subjectId,
          }).toString(),
          headers: {
            Accept: "text/html",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          method: "POST",
        })
        const html = await response.text()
        assert.equal(
          response.status,
          200,
          `hosted consent approval failed: ${html}`
        )
        const exchangeCode = html.match(/cex_[0-9a-f]{64}/)?.[0]
        assert.ok(
          exchangeCode,
          "hosted consent must return a redeemable client bearer exchange code"
        )

        const exchange = await fetch(`${asUrl}/consent/exchange`, {
          body: JSON.stringify({ code: exchangeCode }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        })
        return readJson(exchange, "client bearer redemption failed")
      },
      async revoke(grantId, token) {
        const response = await fetch(
          `${asUrl}/grants/${encodeURIComponent(grantId)}/revoke`,
          {
            headers: { Authorization: `Bearer ${token}` },
            method: "POST",
          }
        )
        return readJson(response, "grant revoke failed")
      },
    },
    TokenIntrospector: {
      introspect: token => introspectToken({ asUrl, token }),
    },
    GrantScopedRecordsRepository: {
      listStreams: token => queryStreams({ rsUrl, token }),
      listRecords: token =>
        queryStreamRecords({ rsUrl, streamName: "repositories", token }),
      async rejectOverbroadFilter(token) {
        const response = await fetch(
          `${rsUrl}/v1/streams/repositories/records?filter[stargazers_count]=12`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
        const body = await response.json()
        return { status: response.status, body }
      },
      async readAfterRevocation(token) {
        const response = await fetch(
          `${rsUrl}/v1/streams/repositories/records?limit=1`,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        )
        return { status: response.status, body: await response.json() }
      },
    },
  }
}

test("DataConnect PDPP interoperability: grant-scoped GitHub records survive restart and fail closed after revoke", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "dataconnect-pdpp-interop-"))
  const dbPath = join(dataDir, "personal-server.sqlite")
  let personalServer

  t.after(async () => {
    if (personalServer) {
      await closeReferenceServer(personalServer.server)
    }
    await rm(dataDir, { force: true, recursive: true })
  })

  personalServer = await startReferencePersonalServer(dbPath)
  await seedGitHubRecords({
    ...personalServer,
    subjectId: "dataconnect_e2e_owner",
  })

  const client = await registerClient({
    asUrl: personalServer.asUrl,
    initialAccessToken: TEST_DCR_INITIAL_ACCESS_TOKEN,
    metadata: {
      client_name: "DataConnect PDPP interoperability E2E",
      token_endpoint_auth_method: "none",
    },
  })
  assert.equal(typeof client.client_id, "string")

  const request = buildParRequest({
    access_mode: "continuous",
    client_id: client.client_id,
    purpose_code: "https://pdpp.org/purpose/analytics",
    purpose_description:
      "Verify DataConnect grant-scoped GitHub interoperability.",
    source: {
      id: "https://registry.pdpp.org/connectors/github",
      kind: "connector",
    },
    streams: [{ fields: ["id", "name", "full_name"], name: "repositories" }],
  })
  const ports = createPersonalServerPorts(personalServer)

  await t.test(
    "ConsentGrantStore honors denial and the JSON owner approval seam",
    async () => {
      const denied = await ports.ConsentGrantStore.stage(request)
      await ports.ConsentGrantStore.denyTestSeam(denied.request_uri)
      await assert.rejects(
        ports.ConsentGrantStore.approveTestSeam(
          denied.request_uri,
          "dataconnect_e2e_owner"
        )
      )

      const testSeamGrant = await ports.ConsentGrantStore.stage(request)
      const approval = await ports.ConsentGrantStore.approveTestSeam(
        testSeamGrant.request_uri,
        "dataconnect_e2e_owner"
      )
      assert.equal(typeof approval.grantId, "string")
      assert.equal(
        (await ports.TokenIntrospector.introspect(approval.token)).active,
        true
      )
    }
  )

  const staged = await ports.ConsentGrantStore.stage(request)
  const redeemed = await ports.ConsentGrantStore.approveForBearerRedemption(
    staged.request_uri,
    "dataconnect_e2e_owner"
  )
  assert.equal(typeof redeemed.grant_id, "string")
  assert.equal(typeof redeemed.token, "string")

  await closeReferenceServer(personalServer.server)
  personalServer = await startReferencePersonalServer(dbPath)
  const restartedPorts = createPersonalServerPorts(personalServer)

  await t.test(
    "TokenIntrospector preserves the redeemed bearer across restart",
    async () => {
      const introspection = await restartedPorts.TokenIntrospector.introspect(
        redeemed.token
      )
      assert.equal(introspection.active, true)
      assert.equal(introspection.grant_id, redeemed.grant_id)
    }
  )

  await t.test(
    "GrantScopedRecordsRepository returns only granted GitHub fields and rejects an overbroad filter",
    async () => {
      const streams =
        await restartedPorts.GrantScopedRecordsRepository.listStreams(
          redeemed.token
        )
      const streamNames = (streams.data || streams.streams || []).map(
        stream => stream.name
      )
      assert.deepEqual(streamNames, ["repositories"])

      const records =
        await restartedPorts.GrantScopedRecordsRepository.listRecords(
          redeemed.token
        )
      assert.ok(
        records.data?.length > 0,
        "the real GitHub seed connector must ingest repository records"
      )
      assert.deepEqual(Object.keys(records.data[0].data).sort(), [
        "full_name",
        "id",
        "name",
      ])

      const overbroad =
        await restartedPorts.GrantScopedRecordsRepository.rejectOverbroadFilter(
          redeemed.token
        )
      assert.equal(overbroad.status, 403)
      assert.equal(overbroad.body.error.code, "field_not_granted")
    }
  )

  await t.test(
    "ConsentGrantStore revocation makes the next scoped read fail",
    async () => {
      const revoked = await restartedPorts.ConsentGrantStore.revoke(
        redeemed.grant_id,
        redeemed.token
      )
      assert.equal(revoked.revoked, true)

      const read =
        await restartedPorts.GrantScopedRecordsRepository.readAfterRevocation(
          redeemed.token
        )
      assert.equal(read.status, 403)
      assert.equal(read.body.error.code, "grant_revoked")
    }
  )
})
