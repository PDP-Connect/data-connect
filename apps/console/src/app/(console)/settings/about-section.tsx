// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ProductIdentity } from "@pdpp/brand-react"
import { KV, KVRow, Text } from "@pdpp/brand-react"
import { Section } from "@pdpp/operator-ui/components/primitives"
import Link from "next/link"
import { OpenExternalLink } from "../components/open-external-link.tsx"

const PROJECT_URL = "https://github.com/PDP-Connect/data-connect"
const DOCS_URL = "https://pdpp.dev"
const LICENSE_URL = "https://www.apache.org/licenses/LICENSE-2.0"
const NOTICES_URL = `${PROJECT_URL}/blob/main/NOTICE`
const SUPPORT_URL = `${PROJECT_URL}/issues`

// TODO(legal): confirm the canonical privacy-policy URL and whether one policy
// covers both the DataConnect desktop and the PDPP self-hosted console.
// TODO(legal): replace the repository NOTICE link with a complete third-party
// notices artifact for every dependency shipped in the desktop bundle.

export function AboutSection({ identity }: { identity: ProductIdentity }) {
  return (
    <Section
      title="About"
    >
      <KV>
        <KVRow k="Product">{identity.name}</KVRow>
        <KVRow k="Copyright">© 2026 The PDP-Connect Contributors</KVRow>
      </KV>
      <nav
        aria-label="Product resources"
        className="mt-4 flex flex-wrap gap-x-4 gap-y-2"
      >
        <OpenExternalLink
          className="pdpp-caption text-foreground underline underline-offset-4"
          href={DOCS_URL}
        >
          Docs
        </OpenExternalLink>
        <OpenExternalLink
          className="pdpp-caption text-foreground underline underline-offset-4"
          href={PROJECT_URL}
        >
          Source
        </OpenExternalLink>
        <OpenExternalLink
          className="pdpp-caption text-foreground underline underline-offset-4"
          href={LICENSE_URL}
        >
          Apache-2.0 license
        </OpenExternalLink>
        <OpenExternalLink
          className="pdpp-caption text-foreground underline underline-offset-4"
          href={NOTICES_URL}
        >
          Third-party notices
        </OpenExternalLink>
        <OpenExternalLink
          className="pdpp-caption text-foreground underline underline-offset-4"
          href={SUPPORT_URL}
        >
          Support
        </OpenExternalLink>
        <Text
          as={Link}
          className="pdpp-caption text-foreground underline underline-offset-4"
          href="/privacy"
        >
          Privacy
        </Text>
      </nav>
    </Section>
  )
}
