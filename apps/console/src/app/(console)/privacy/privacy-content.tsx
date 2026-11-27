// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Text } from "@pdpp/brand-react"
import { Section } from "@pdpp/operator-ui/components/primitives"

// The three things most readers come for, in the page's own sentences (each also stands in its section below).
const overview = [
  "DataConnect keeps your records, the data sources connected to them, which apps you approved, and records of sign-ins and access tokens.",
  "On desktop, the Personal Server (the part that stores your records) keeps an encrypted database in DataConnect’s app folder. The file needs an encryption key to be read.",
  "Owner-only pages require owner sign-in. Apps can read records covered by the access you approve.",
] as const

function PrivacyOverview() {
  return (
    <div className="mb-8 grid gap-3" data-testid="privacy-overview">
      {overview.map((line) => (
        <Text as="p" className="max-w-3xl text-foreground" key={line}>
          {line}
        </Text>
      ))}
    </div>
  )
}

const sections = [
  {
    id: "keeps",
    title: "What DataConnect keeps",
    paragraphs: [
      "DataConnect keeps your records, the data sources connected to them, which apps you approved, and records of sign-ins and access tokens.",
    ],
  },
  {
    id: "where",
    title: "Where it keeps them",
    paragraphs: [
      "On desktop, the Personal Server (the part that stores your records) keeps an encrypted database in DataConnect’s app folder. The file needs an encryption key to be read.",
      "DataConnect keeps encryption keys in the operating system’s built-in secret store when available. It uses files in its app folder as a fallback. Browser sign-in profiles and app logs are also stored on that computer.",
      "Some data-source sign-in details are encrypted before a server stores them. The server must be set up with an encryption key.",
      "A separate server can store data in a local database file or a separate database service. Its location depends on the setup.",
    ],
  },
  {
    id: "who",
    title: "Who can read your records",
    paragraphs: [
      "Owner-only pages require owner sign-in. Apps can read records covered by the access you approve.",
      "An owner access token (a key you create so a tool can act as you) can read all your records.",
      "If you turn on remote access, requests to your server pass through the service you choose. Some of these services, such as Cloudflare, can read the data in those requests. Before you turn it on, the setup says whether the service you chose can read it.",
    ],
  },
  {
    id: "sends",
    fold: true,
    title: "What DataConnect sends out on its own",
    paragraphs: [
      "If you set up event notices for another app, the server sends event information to the address you chose.",
      "When browser notifications are enabled and an alert is sent, the server sends an encrypted notice to the address your browser provides. A notice can include a data-source name, the kind of action, and a link to a sync.",
      "When an app asks for access, the server may get the app’s description and logo from the app’s own web address. These requests do not carry your records.",
      "Each time the desktop app starts, it checks GitHub Container Registry (GitHub’s package service) for new collection software and installs the updates it finds. Installing collection software also downloads it from there. Installing the browser for collection downloads it from a server that hosts Chromium builds.",
      "For some data sources without a built-in logo, the desktop app loads the logo from logo.dev, a logo service. That service can see which logos are asked for.",
      "The desktop app sends usage and reliability reports to Open Data Labs only if you turn on “Share anonymous usage & reliability data” in its settings. It is off at first.",
      "A server installed from the DataConnect Docker image (a ready-made server package) downloads a search model from Hugging Face (a site that hosts these models) the first time it needs one. The desktop app turns this download off.",
      "The desktop app does not check for new versions of itself.",
    ],
  },
  {
    id: "removing-access",
    title: "What removing access does",
    paragraphs: [
      "Removing an app’s access stops it from reading more records.",
      "Removing an app’s access does not delete what the app already read.",
      "Disconnecting a data source stops future collection. Records already collected stay on the server. Deleting a data source removes its records and sync history; DataConnect then tries to remove its browser sign-in profile.",
      "The recovery kit restores keys, not records.",
    ],
  },
  {
    id: "unknown",
    title: "What we do not know yet",
    paragraphs: [
      "We have not verified every request that collection software makes while collecting data, or the information it sends.",
      "We have not confirmed how every separate server protects its database, or every file and log it keeps.",
      "We have not checked every request made by other software DataConnect uses or by web pages opened during browser collection, including requests to external font or file-hosting services.",
      "The desktop app also offers sign-in with a Vana account. We have not yet written down what it sends to Vana after you sign in.",
      "Apart from the usage reports above, we found no DataConnect code that sends usage data or crash reports, but we have not checked every dependency.",
    ],
  },
] as const

export function PrivacyContent() {
  return (
    <div>
      <PrivacyOverview />
      {sections.map((section) => {
        const body = (
          <div className="grid gap-3">
            {section.paragraphs.map((paragraph) => (
              <Text
                as="p"
                className="max-w-3xl text-muted-foreground"
                key={paragraph}
              >
                {paragraph}
              </Text>
            ))}
          </div>
        )
        return "fold" in section ? (
          <section className="mb-8 scroll-mt-16" id={section.id} key={section.id}>
            <details>
              <summary className="pdpp-heading min-h-11">{section.title}</summary>
              <div className="mt-3">{body}</div>
            </details>
          </section>
        ) : (
          <Section
            id={section.id}
            key={section.id}
            title={section.title}
          >
            {body}
          </Section>
        )
      })}
    </div>
  )
}
