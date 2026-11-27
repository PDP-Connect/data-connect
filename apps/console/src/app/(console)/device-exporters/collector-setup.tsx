"use client"
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { IcButton } from "@pdpp/brand-react"
import { useState, type ComponentProps } from "react"
import { EnrollmentForm } from "./enrollment-form.tsx"
export function CollectorSetup(props: ComponentProps<typeof EnrollmentForm> & { practice?: boolean }) {
  const [open, setOpen] = useState(Boolean(props.defaultConnectorId))
  return (
    <section className="grid gap-3">
      <IcButton
        className="w-fit"
        variant="ghost"
        onClick={() => setOpen(!open)}
      >
        {open ? "Close setup" : "Set up a collector"}
      </IcButton>
      {open ? <EnrollmentForm {...props} /> : null}
    </section>
  )
}
