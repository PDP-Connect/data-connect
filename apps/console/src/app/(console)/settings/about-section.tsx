// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ProductIdentity } from "@pdpp/brand-react"
import { Section } from "@pdpp/operator-ui/components/primitives"

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
      description={`${identity.name} is powered by the ${identity.protocolName} protocol.`}
      title="About"
    >
      <dl className="grid gap-x-6 gap-y-3 rounded-md border border-border/70 bg-muted/10 px-3 py-3 sm:grid-cols-2">
        <div>
          <dt className="pdpp-eyebrow text-muted-foreground">Product</dt>
          <dd className="pdpp-caption font-medium text-foreground">
            {identity.name}
          </dd>
        </div>
        <div>
          <dt className="pdpp-eyebrow text-muted-foreground">Version</dt>
          <dd className="pdpp-caption font-medium text-foreground">
            {identity.version}
          </dd>
        </div>
        <div>
          <dt className="pdpp-eyebrow text-muted-foreground">Build</dt>
          <dd className="pdpp-caption font-medium text-foreground">
            {identity.build}
          </dd>
        </div>
        <div>
          <dt className="pdpp-eyebrow text-muted-foreground">Protocol</dt>
          <dd className="pdpp-caption font-medium text-foreground">
            {identity.protocolName}
          </dd>
        </div>
        <div>
          <dt className="pdpp-eyebrow text-muted-foreground">Copyright</dt>
          <dd className="pdpp-caption font-medium text-foreground">
            © 2026 The PDP-Connect Contributors
          </dd>
        </div>
      </dl>
      <nav
        aria-label="Product resources"
        className="mt-4 flex flex-wrap gap-x-4 gap-y-2"
      >
        <a
          className="pdpp-caption text-foreground underline underline-offset-4"
          href={DOCS_URL}
        >
          Docs
        </a>
        <a
          className="pdpp-caption text-foreground underline underline-offset-4"
          href={PROJECT_URL}
        >
          Source
        </a>
        <a
          className="pdpp-caption text-foreground underline underline-offset-4"
          href={LICENSE_URL}
        >
          Apache-2.0 license
        </a>
        <a
          className="pdpp-caption text-foreground underline underline-offset-4"
          href={NOTICES_URL}
        >
          Third-party notices
        </a>
        <a
          className="pdpp-caption text-foreground underline underline-offset-4"
          href={SUPPORT_URL}
        >
          Support
        </a>
      </nav>
      <p className="pdpp-caption mt-4 max-w-3xl text-muted-foreground">
        DataConnect uses PDPP to keep personal data portable.
      </p>
    </Section>
  )
}
