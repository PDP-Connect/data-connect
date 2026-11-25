// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { ConsentUnavailable } from "@/components/consent-screen/consent-screen-client.tsx";

export default function ConsentNotFound() {
  return <ConsentUnavailable kind="expired" />;
}
