// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AppAccess, GrantSummary, ListResponse, PendingApproval } from "../lib/ref-client.ts";
import type { AppAccessDataSource } from "../lib/data-source.ts";

export function createAppAccessDemoDataSource(): AppAccessDataSource {
  const list = buildAppAccessDemoData();
  return {
    listAppAccess: async () => structuredClone(list),
    removeAppAccess: async (input) => {
      const ended = new Set<string>();
      for (const app of list.data) {
        if (!input.client_ids.includes(app.client_id)) {
          continue;
        }
        for (const source of app.sources) {
          if (
            input.source &&
            (source.source.kind !== input.source.kind ||
              source.source.id !== input.source.id ||
              source.source.connector_id !== input.source.connector_id ||
              source.source.connection_id !== input.source.connection_id)
          ) {
            continue;
          }
          if (!source.in_force) {
            continue;
          }
          for (const id of source.active_grant_ids) {
            ended.add(id);
          }
          source.in_force = false;
          source.active_grant_ids = [];
          source.stopped_at = new Date().toISOString();
          source.stopped_reason = "removed";
        }
      }
      return {
        object: "app_access_remove_result",
        ended_count: ended.size,
        failed_count: 0,
        ended_grant_ids: [...ended],
        failed_grant_ids: [],
      };
    },
  };
}

/** Fictional registrations for practice pages; no owner request is made. */
export function buildAppAccessDemoData(): ListResponse<AppAccess> {
  return {
    object: "list",
    has_more: false,
    data: [
      {
        client_id: "demo_research_assistant",
        client_name: "Research Assistant",
        return_host: "assistant.example.test",
        returns_to_this_computer: false,
        domain_control_verified: false,
        reads_last_7_days: 4,
        sources: [
          {
            source: { kind: "connector", id: "gmail", connector_id: "gmail", connection_id: "cin_demo_mail" },
            kinds: ["messages", "threads"],
            in_force: true,
            first_issued_at: "2026-06-28T10:30:00.000Z",
            expires_at: null,
            stopped_at: null,
            stopped_reason: null,
            last_read_at: "2026-07-01T11:51:00.000Z",
            grant_ids: ["grt_demo_mail"],
            active_grant_ids: ["grt_demo_mail"],
            package_ids: [],
          },
        ],
      },
      {
        client_id: "demo_past_assistant",
        client_name: "Past Assistant",
        return_host: null,
        returns_to_this_computer: false,
        domain_control_verified: false,
        reads_last_7_days: 0,
        sources: [
          {
            source: { kind: "connector", id: "amazon", connector_id: "amazon", connection_id: "cin_demo_orders" },
            kinds: ["orders"],
            in_force: false,
            first_issued_at: "2026-06-10T08:00:00.000Z",
            expires_at: null,
            stopped_at: "2026-06-21T14:45:00.000Z",
            stopped_reason: "removed",
            last_read_at: null,
            grant_ids: ["grt_demo_orders"],
            active_grant_ids: [],
            package_ids: [],
          },
        ],
      },
    ],
  };
}

export function buildGrantsDemoData(): {
  approvals: ListResponse<PendingApproval>;
  grants: ListResponse<GrantSummary>;
} {
  return {
    approvals: {
      data: [
        {
          approval_id: "apr_demo_agent_review",
          batch: false,
          client_id: "https://agent.example.test/oauth/client",
          created_at: "2026-07-01T12:04:00.000Z",
          grant_preview: {
            source: {
              connection_id: "cin_demo_chatgpt_work",
              connector_id: "chatgpt",
              id: "chatgpt",
              kind: "connector",
            },
            streams: [{ name: "conversations" }, { name: "messages" }],
          },
          kind: "consent",
          object: "approval",
          user_code: "DEMO-42",
        },
      ],
      has_more: false,
      object: "list",
    },
    grants: {
      data: [
        {
          client: {
            client_id: "https://claude.example.test/oauth/client",
            client_name: "Claude Desktop",
            registration_mode: "dynamic",
          },
          client_id: "https://claude.example.test/oauth/client",
          connector_id: "chatgpt",
          event_count: 18,
          failure: null,
          first_at: "2026-06-28T10:30:00.000Z",
          grant_id: "grt_demo_claude_chatgpt",
          kinds: ["chatgpt.conversations.read", "chatgpt.messages.read"],
          last_at: "2026-07-01T11:51:00.000Z",
          object: "grant_summary",
          source: {
            connection_id: "cin_demo_chatgpt_work",
            connector_id: "chatgpt",
            id: "chatgpt",
            kind: "connector",
          },
          status: "issued",
        },
        {
          client: {
            client_id: "https://research.example.test/oauth/client",
            client_name: "Research notebook",
            registration_mode: "dynamic",
          },
          client_id: "https://research.example.test/oauth/client",
          connector_id: "amazon",
          event_count: 9,
          failure: { event_type: "grant.revoked", reason: "owner revoked access" },
          first_at: "2026-06-10T08:00:00.000Z",
          grant_id: "grt_demo_revoked_orders",
          kinds: ["amazon.orders.read"],
          last_at: "2026-06-21T14:45:00.000Z",
          object: "grant_summary",
          source: {
            connection_id: "cin_demo_amazon_home",
            connector_id: "amazon",
            id: "amazon",
            kind: "connector",
          },
          status: "revoked",
        },
      ],
      has_more: false,
      object: "list",
    },
  };
}

export function buildEmptyGrantsDemoData(): ReturnType<typeof buildGrantsDemoData> {
  const data = buildGrantsDemoData();
  return {
    approvals: { ...data.approvals, data: [] },
    grants: { ...data.grants, data: [] },
  };
}
