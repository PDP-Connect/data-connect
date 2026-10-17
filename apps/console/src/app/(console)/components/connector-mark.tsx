// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { ConnectorIcon, type ConnectorIconLike } from "@pdpp/brand-react";
import { resolveConnectorIcon } from "../lib/resolve-connector-icon.ts";

/** One connector identity mark for every console surface. */
export function ConnectorMark({
  className,
  icon,
  name,
}: {
  className?: string;
  icon?: ConnectorIconLike | null;
  name: string;
}) {
  return <ConnectorIcon className={className} icon={resolveConnectorIcon(icon)} name={name} />;
}
