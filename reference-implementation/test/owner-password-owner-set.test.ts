// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  OWNER_PASSWORD_OWNER_SET_MARKER_FILE,
  OWNER_OS_REAUTH_REQUEST_FILE,
  OWNER_PASSWORD_STACK_RESTART_REQUEST_FILE,
  OWNER_PASSWORD_WINDOW_REQUEST_FILE,
  ownerOsReauthIndexPath,
  ownerOsReauthRequestPath,
  ownerPasswordWindowRequestPath,
  readOwnerOsReauthRequest,
  ownerOsReauthAllowsReveal,
  ownerOsReauthResultPath,
  ownerOsReauthSucceeded,
  ownerPasswordOwnerSet,
  requestOwnerOsReauth,
  requestOwnerPasswordStackRestart,
  requestOwnerPasswordWindow,
} from "../server/owner-password-owner-set.ts"

async function withTempDir(
  run: (dataDir: string) => Promise<void>
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "pdpp-owner-password-"))
  try {
    await run(dataDir)
  } finally {
    await rm(dataDir, { force: true, recursive: true })
  }
}

async function withOwnerPasswordEnv(
  values: Record<string, string | undefined>,
  run: () => Promise<void>
): Promise<void> {
  const names = Object.keys(values)
  const previous = new Map(names.map(name => [name, process.env[name]]))
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    await run()
  } finally {
    for (const name of names) {
      const value = previous.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test("desktop-generated runtime password does not count as an owner-set password", async () => {
  await withOwnerPasswordEnv(
    {
      DATACONNECT_OWNER_PASSWORD: undefined,
      PDPP_OWNER_PASSWORD: "generated-runtime-password",
      PDPP_OWNER_PASSWORD_SOURCE: "desktop_generated",
    },
    async () =>
      withTempDir(async dataDir => {
        assert.equal(await ownerPasswordOwnerSet(dataDir), false)
        await writeFile(
          join(dataDir, OWNER_PASSWORD_OWNER_SET_MARKER_FILE),
          "{}\n"
        )
        assert.equal(await ownerPasswordOwnerSet(dataDir), true)
      })
  )
})

test("environment-managed passwords remain owner-set when no desktop-generated source is marked", async () => {
  await withOwnerPasswordEnv(
    {
      DATACONNECT_OWNER_PASSWORD: undefined,
      PDPP_OWNER_PASSWORD: "operator-selected-password",
      PDPP_OWNER_PASSWORD_SOURCE: undefined,
    },
    async () =>
      withTempDir(async dataDir => {
        assert.equal(await ownerPasswordOwnerSet(dataDir), true)
      })
  )
})

test("window and restart requests advance durable request IDs", async () => {
  await withTempDir(async dataDir => {
    assert.deepEqual(await requestOwnerPasswordWindow(dataDir), {
      requestId: 1,
    })
    assert.deepEqual(await requestOwnerPasswordWindow(dataDir), {
      requestId: 2,
    })
    assert.deepEqual(await requestOwnerPasswordStackRestart(dataDir), {
      requestId: 1,
    })
    assert.deepEqual(await requestOwnerPasswordStackRestart(dataDir), {
      requestId: 2,
    })
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(dataDir, OWNER_PASSWORD_WINDOW_REQUEST_FILE),
          "utf8"
        )
      ),
      { purpose: "initial_setup", requestId: 2 }
    )
    assert.deepEqual(
      JSON.parse(
        await readFile(ownerPasswordWindowRequestPath(dataDir, 1), "utf8")
      ),
      {
        purpose: "initial_setup",
        requestId: 1,
      }
    )
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(dataDir, OWNER_PASSWORD_STACK_RESTART_REQUEST_FILE),
          "utf8"
        )
      ),
      { requestId: 2 }
    )
  })
})

test("OS re-auth requests advance beyond completed request IDs", async () => {
  await withTempDir(async dataDir => {
    await writeFile(
      join(dataDir, OWNER_OS_REAUTH_REQUEST_FILE),
      JSON.stringify({
        requestId: 4,
        completedRequestId: 7,
        status: "authenticated",
      })
    )

    assert.deepEqual(await requestOwnerOsReauth(dataDir), { requestId: 8 })
    const state = await readOwnerOsReauthRequest(dataDir)
    assert.equal(state.requestId, 8)
    assert.equal(state.status, "pending")
    assert.equal(typeof state.deadlineUnixMs, "number")
  })
})

test("owner password requests serialize concurrent increments", async () => {
  await withTempDir(async dataDir => {
    const requests = await Promise.all(
      Array.from({ length: 20 }, () => requestOwnerOsReauth(dataDir))
    )
    assert.deepEqual(
      requests.map(request => request.requestId).sort((a, b) => a - b),
      Array.from({ length: 20 }, (_, index) => index + 1)
    )
    const state = await readOwnerOsReauthRequest(dataDir)
    assert.equal(state.requestId, 20)
    assert.equal(state.status, "pending")
    assert.equal(typeof state.deadlineUnixMs, "number")
    assert.ok((state.deadlineUnixMs ?? 0) > Date.now())
  })
})

test("window request carries only the reauth request correlation id", async () => {
  await withTempDir(async dataDir => {
    assert.deepEqual(
      await requestOwnerPasswordWindow(dataDir, {
        grantForRequestId: 3,
        grantId: "grant-1",
        purpose: "change",
      }),
      { requestId: 1 }
    )
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(dataDir, OWNER_PASSWORD_WINDOW_REQUEST_FILE),
          "utf8"
        )
      ),
      {
        grantForRequestId: 3,
        grantId: "grant-1",
        purpose: "change",
        requestId: 1,
      }
    )
  })
})

test("reauth predicates split reveal-only Linux fallback from write-grant success", () => {
  const linuxSkipped = {
    completedRequestId: 9,
    requestId: 9,
    status: "skipped_linux_polkit_unverified",
  }
  assert.equal(ownerOsReauthSucceeded(linuxSkipped, 9), false)
  assert.equal(ownerOsReauthAllowsReveal(linuxSkipped, 9), true)
  assert.equal(
    ownerOsReauthSucceeded(
      { completedRequestId: 9, requestId: 9, status: "timed_out" },
      9
    ),
    false
  )
})

test("reauth result records are per request so later requests cannot overwrite earlier results", async () => {
  await withTempDir(async dataDir => {
    await writeFile(
      ownerOsReauthResultPath(dataDir, 1),
      JSON.stringify({
        completedRequestId: 1,
        requestId: 1,
        status: "authenticated",
      })
    )
    await writeFile(
      ownerOsReauthResultPath(dataDir, 2),
      JSON.stringify({
        completedRequestId: 2,
        requestId: 2,
        status: "timed_out",
      })
    )

    assert.deepEqual(await readOwnerOsReauthRequest(dataDir, 1), {
      completedRequestId: 1,
      requestId: 1,
      status: "authenticated",
    })
    assert.deepEqual(await readOwnerOsReauthRequest(dataDir, 2), {
      completedRequestId: 2,
      requestId: 2,
      status: "timed_out",
    })
  })
})

test("OS re-auth concurrent requests are retained as unique request files", async () => {
  await withTempDir(async dataDir => {
    const requests = await Promise.all(
      Array.from({ length: 5 }, () => requestOwnerOsReauth(dataDir))
    )
    for (const { requestId } of requests) {
      const state = JSON.parse(
        await readFile(ownerOsReauthRequestPath(dataDir, requestId), "utf8")
      )
      assert.equal(state.requestId, requestId)
      assert.equal(state.status, "pending")
    }
  })
})

test("completed reauth result wins over a stale request record", async () => {
  await withTempDir(async dataDir => {
    await requestOwnerOsReauth(dataDir)
    await writeFile(
      ownerOsReauthResultPath(dataDir, 1),
      JSON.stringify({
        completedRequestId: 1,
        grantId: "opaque",
        requestId: 1,
        status: "authenticated",
      })
    )
    await writeFile(
      ownerOsReauthRequestPath(dataDir, 1),
      JSON.stringify({ deadlineUnixMs: 1, requestId: 1, status: "pending" })
    )

    assert.deepEqual(await readOwnerOsReauthRequest(dataDir, 1), {
      completedRequestId: 1,
      grantId: "opaque",
      requestId: 1,
      status: "authenticated",
    })
  })
})

test("OS re-auth allocation recovers from a missing index without overwriting retained request/result", async () => {
  await withTempDir(async dataDir => {
    const retainedRequest = {
      completedRequestId: 1,
      requestId: 1,
      status: "authenticated",
    }
    const retainedResult = {
      completedRequestId: 1,
      grantId: "opaque",
      requestId: 1,
      status: "authenticated",
    }
    await writeFile(
      ownerOsReauthRequestPath(dataDir, 1),
      JSON.stringify(retainedRequest)
    )
    await writeFile(
      ownerOsReauthResultPath(dataDir, 1),
      JSON.stringify(retainedResult)
    )

    assert.deepEqual(await requestOwnerOsReauth(dataDir), { requestId: 2 })
    assert.deepEqual(
      JSON.parse(await readFile(ownerOsReauthRequestPath(dataDir, 1), "utf8")),
      retainedRequest
    )
    assert.deepEqual(
      JSON.parse(await readFile(ownerOsReauthResultPath(dataDir, 1), "utf8")),
      retainedResult
    )
    assert.equal((await readOwnerOsReauthRequest(dataDir, 1)).grantId, "opaque")
  })
})

test("OS re-auth allocation rejects an empty index without overwriting retained request/result", async () => {
  await withTempDir(async dataDir => {
    const retainedRequest = {
      completedRequestId: 1,
      requestId: 1,
      status: "authenticated",
    }
    const retainedResult = {
      completedRequestId: 1,
      grantId: "opaque",
      requestId: 1,
      status: "authenticated",
    }
    await writeFile(
      ownerOsReauthRequestPath(dataDir, 1),
      JSON.stringify(retainedRequest)
    )
    await writeFile(
      ownerOsReauthResultPath(dataDir, 1),
      JSON.stringify(retainedResult)
    )
    await writeFile(ownerOsReauthIndexPath(dataDir), "")

    await assert.rejects(requestOwnerOsReauth(dataDir), /empty/)
    await assert.rejects(readFile(ownerOsReauthRequestPath(dataDir, 2), "utf8"))
    assert.deepEqual(
      JSON.parse(await readFile(ownerOsReauthRequestPath(dataDir, 1), "utf8")),
      retainedRequest
    )
    assert.deepEqual(
      JSON.parse(await readFile(ownerOsReauthResultPath(dataDir, 1), "utf8")),
      retainedResult
    )
  })
})

test("window allocation rejects a corrupt index without overwriting retained request", async () => {
  await withTempDir(async dataDir => {
    const retainedRequest = { purpose: "initial_setup", requestId: 1 }
    await writeFile(
      ownerPasswordWindowRequestPath(dataDir, 1),
      JSON.stringify(retainedRequest)
    )
    await writeFile(join(dataDir, OWNER_PASSWORD_WINDOW_REQUEST_FILE), "{")

    await assert.rejects(requestOwnerPasswordWindow(dataDir), SyntaxError)
    await assert.rejects(
      readFile(ownerPasswordWindowRequestPath(dataDir, 2), "utf8")
    )
    assert.deepEqual(
      JSON.parse(
        await readFile(ownerPasswordWindowRequestPath(dataDir, 1), "utf8")
      ),
      retainedRequest
    )
  })
})

test("restart allocation rejects a corrupt index instead of resetting", async () => {
  await withTempDir(async dataDir => {
    await writeFile(
      join(dataDir, OWNER_PASSWORD_STACK_RESTART_REQUEST_FILE),
      "{"
    )

    await assert.rejects(requestOwnerPasswordStackRestart(dataDir), SyntaxError)
  })
})
