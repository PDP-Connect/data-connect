// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface BindingRequirement {
  readonly features?: readonly string[];
  readonly required?: boolean;
}

export interface RuntimeBindingSupport {
  readonly bindingFeatures?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly bindings: ReadonlySet<string>;
  /** A partial binding cannot satisfy a required declaration without features. */
  readonly partialBindings?: ReadonlySet<string>;
}

export interface MissingBindingFeatures {
  readonly binding: string;
  readonly features: readonly string[];
}

/** CP §3.3 and §3.3.8: an optional, incompatible binding is omitted as a whole. */
export function matchRuntimeBindings(
  declared: Readonly<Record<string, BindingRequirement>>,
  runtime: RuntimeBindingSupport
): { omitted: string[]; missing: string[]; missingFeatures: MissingBindingFeatures[]; unspecifiedFeatures: string[] } {
  const omitted: string[] = [];
  const missing: string[] = [];
  const missingFeatures: MissingBindingFeatures[] = [];
  const unspecifiedFeatures: string[] = [];
  for (const [binding, requirement] of Object.entries(declared)) {
    const available = runtime.bindings.has(binding);
    const features = available
      ? (requirement.features ?? []).filter((feature) => !runtime.bindingFeatures?.get(binding)?.has(feature))
      : [];
    const unspecified = available && requirement.features === undefined && runtime.partialBindings?.has(binding);
    if (available && features.length === 0 && !unspecified) {
      continue;
    }
    omitted.push(binding);
    if (!requirement.required) {
      continue;
    }
    missing.push(binding);
    if (features.length) {
      missingFeatures.push({ binding, features });
    }
    if (unspecified) {
      unspecifiedFeatures.push(binding);
    }
  }
  return { missing, missingFeatures, omitted, unspecifiedFeatures };
}

export function diffProtocolCapabilities<Capability extends string>(
  required: readonly Capability[],
  advertised: ReadonlySet<string>
): Capability[] {
  return required.filter((capability) => !advertised.has(capability));
}

// CP §3.3.8 vocabulary for unrestricted Node/Playwright hosts. These are
// functionality declarations, not independently enforced authority limits.
export const NODE_BROWSER_FEATURES: ReadonlySet<string> = new Set([
  "page_navigation",
  "page_script_evaluation",
  "page_content_read",
  "page_condition_wait",
  "page_input",
  "cookie_read",
  "page_response_observation",
  "host_download_capture",
  "host_archive_extraction",
  "host_archive_entry_chunk_read",
  "host_cookie_jar_request",
  "host_http_request",
]);
export const NODE_NETWORK_FEATURES: ReadonlySet<string> = new Set(["same_origin_page_fetch", "host_http_request"]);
