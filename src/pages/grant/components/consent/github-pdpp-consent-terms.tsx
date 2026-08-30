// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { Text } from "@/components/typography/text"
import { ActionPanel } from "@/components/typography/button-action"
import type { PdppAuthorizationDetail } from "@/services/pdppAuthorization"

export function GithubPdppConsentTerms({
  terms,
}: {
  terms: PdppAuthorizationDetail
}) {
  return (
    <section aria-labelledby="github-pdpp-authorization-heading">
      <ActionPanel className="block h-auto space-y-2 py-3">
        <Text as="h2" id="github-pdpp-authorization-heading" intent="small">
          GitHub authorization request
        </Text>
        <Text as="p" intent="fine" dim>
          Enforced by your Personal Server
        </Text>
        {terms.streams.map(stream => (
          <section
            aria-labelledby={`github-pdpp-stream-${stream.name}`}
            key={stream.name}
          >
            <Text
              as="h3"
              id={`github-pdpp-stream-${stream.name}`}
              intent="fine"
            >
              {stream.name}
            </Text>
            <dl>
              {stream.view ? (
                <>
                  <Text as="dt" intent="fine" dim>
                    View
                  </Text>
                  <Text as="dd" intent="fine">
                    {stream.view}
                  </Text>
                </>
              ) : null}
              {stream.fields ? (
                <>
                  <Text as="dt" intent="fine" dim>
                    Fields
                  </Text>
                  <Text as="dd" intent="fine">
                    {stream.fields.join(", ")}
                  </Text>
                </>
              ) : null}
              {stream.resources ? (
                <>
                  <Text as="dt" intent="fine" dim>
                    Resources
                  </Text>
                  <Text as="dd" intent="fine">
                    {stream.resources.join(", ")}
                  </Text>
                </>
              ) : null}
              {stream.time_range ? (
                <>
                  <Text as="dt" intent="fine" dim>
                    Time range
                  </Text>
                  <Text as="dd" intent="fine">
                    {stream.time_range.since ?? "start"} to{" "}
                    {stream.time_range.until ?? "now"}
                  </Text>
                </>
              ) : null}
            </dl>
          </section>
        ))}
        <dl>
          <Text as="dt" intent="fine" dim>
            Access mode
          </Text>
          <Text as="dd" intent="fine">
            {terms.access_mode === "continuous" ? "Continuous" : "One-time"}
          </Text>
          <Text as="dt" intent="fine" dim>
            Purpose
          </Text>
          <Text as="dd" intent="fine">
            {terms.purpose_description ?? terms.purpose_code}
          </Text>
          {terms.retention ? (
            <>
              <Text as="dt" intent="fine" dim>
                Retention
              </Text>
              <Text as="dd" intent="fine">
                {terms.retention.on_expiry} after {terms.retention.max_duration}
              </Text>
            </>
          ) : null}
        </dl>
      </ActionPanel>
    </section>
  )
}
