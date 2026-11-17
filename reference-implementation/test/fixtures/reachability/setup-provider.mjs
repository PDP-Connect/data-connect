// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import base from "./base.mjs"
import { readFile, writeFile } from "node:fs/promises"

const worldFile = new URL("./world.json", import.meta.url)
const world = async () => JSON.parse(await readFile(worldFile, "utf8"))
const save = state => writeFile(worldFile, JSON.stringify(state))
const action = (id, kind, label, purpose, extra = {}, step = {}) => ({
  id,
  kind,
  label,
  digest: id,
  required: true,
  disclosure: { revision: "1", text: label, links: [] },
  step: {
    actor: "owner",
    permission: { id, label },
    verification: "provider",
    purpose,
    ...step,
  },
  ...extra,
})

function next(state, configuration) {
  if (state.grant === "pending") {
    return action(
      "handoff",
      "open-url",
      "Open enrollment",
      "authorize",
      { href: state.handoff },
      {
        browser: { expiresAt: state.expiresAt, pollAfterMs: 100 },
      }
    )
  }
  if (state.grant !== "verified") return null
  if (!configuration?.account) {
    return action(
      "account",
      "provide-value",
      "Select an account",
      "configure",
      { valueFormat: "text" },
      {
        options: [{ label: "Workshop", value: "opaque-account" }],
      }
    )
  }
  if (!state.secretObserved) {
    return action(
      "key",
      "provide-secret",
      "Store enrollment secret",
      "authorize",
      { secretLabel: "Enrollment secret" }
    )
  }
  if (!state.created) {
    return action(
      "create",
      "gozar-runs",
      "Allocate the reviewed resource",
      "provision",
      {},
      { actor: "machine" }
    )
  }
  return null
}

export default {
  ...base,
  async detect(ctx) {
    const state = await world()
    const offer = next(state, await ctx.configuration(null))
    return {
      state: state.created ? "ready" : "action-required",
      facts: { offer },
    }
  },
  setupActions: facts => (facts?.offer ? [facts.offer] : []),
  async observeSetup(ctx, operation) {
    const state = await world()
    const row = operation.resources[0]
    const subject = { operation: operation.id }
    const observedAt = new Date().toISOString()
    const evidence =
      state.grant === "pending"
        ? undefined
        : {
            operationId: operation.id,
            stepId: "handoff",
            source: "provider",
            observedAt,
            summary: "Enrollment status observed.",
          }
    if (row && state.created) {
      const identity = { id: state.created }
      const present = state.owned === state.created
      const observations = [
        {
          intentId: row.id,
          subject,
          observedAt,
          identity,
          status: present ? "present" : "absent",
        },
      ]
      if (operation.cancelled && present && ctx.configurationInUse()) {
        return {
          state: "pending",
          observations,
          nextAction: action(
            "stop",
            "instructions",
            "Stop the active route",
            "stop-connector",
            {
              instructions:
                "Stop the exact route before removing the resource.",
            }
          ),
        }
      }
      const nextAction =
        !present || !operation.cancelled
          ? null
          : state.assisted
            ? action(
                "assist",
                "instructions",
                "Remove the retained resource",
                "reconcile",
                {
                  instructions:
                    "Ask the administrator to check the retained resource.",
                },
                { actor: "administrator" }
              )
            : action(
                "remove",
                "gozar-runs",
                "Remove the reviewed resource",
                "remove-resource",
                {},
                {
                  actor: "machine",
                  resourceHandle: row.id,
                }
              )
      return {
        state: operation.cancelled
          ? "cancelled"
          : state.assisted
            ? "blocked"
            : "complete",
        nextAction,
        observations,
      }
    }
    const nextAction = next(state, await ctx.configuration(null))
    return {
      state: operation.cancelled
        ? "cancelled"
        : state.grant === "verified"
          ? "authorization-required"
          : state.grant,
      nextAction,
      evidence,
      ...(nextAction?.id === "create" && {
        intent: { kind: "other", label: "Workshop allocation", subject },
      }),
    }
  },
  async executeSetup(ctx, { action: command, intent, resource }) {
    const state = await world()
    state.effects.push(command.id)
    if (command.id === "key") {
      state.secretObserved = await ctx.withInputSecret(
        async bytes => bytes.byteLength > 0
      )
    }
    if (command.id === "create") {
      state.created = intent.id
      state.owned = intent.id
      await ctx.recordAllocation({ id: intent.id })
    }
    if (command.id === "remove" && state.owned === resource.identity.id)
      delete state.owned
    await save(state)
    return { state: "complete" }
  },
}
