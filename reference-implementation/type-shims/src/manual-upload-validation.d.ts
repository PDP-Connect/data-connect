// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { validateAppleHealthExportArtifactFromFile } from "../connectors/apple_health/validation.ts";
import { validateGoogleMapsTimelineArtifact } from "../connectors/google_maps/validation.ts";
import { validateNetflixExportArtifact } from "../connectors/netflix_export/validation.ts";
import { validateStravaAccountExportArtifact, validateStravaAccountExportArtifactFromFile } from "../connectors/strava/validation.ts";
import { validateWhatsAppChatExportArtifact } from "../connectors/whatsapp/validation.ts";
export type ManualUploadValidationResult = Awaited<ReturnType<typeof validateAppleHealthExportArtifactFromFile>> | ReturnType<typeof validateGoogleMapsTimelineArtifact> | ReturnType<typeof validateNetflixExportArtifact> | ReturnType<typeof validateStravaAccountExportArtifact> | Awaited<ReturnType<typeof validateStravaAccountExportArtifactFromFile>> | ReturnType<typeof validateWhatsAppChatExportArtifact>;
export interface ManualUploadValidationOptions {
    readonly fileName?: string | null;
    readonly existingFileHashes?: readonly string[];
    readonly maxFileBytes?: number | null;
}
export declare function validateManualUploadArtifactByKind(kind: string | null, input: Buffer | Uint8Array | string, options?: ManualUploadValidationOptions): ManualUploadValidationResult | null;
export interface ManualUploadFileValidationOptions {
    /** Display file name (the owner-facing upload name, e.g. "WhatsApp Chat
     *  - Alice.zip") -- NOT necessarily a real filesystem path; used for
     *  extension sniffing and shown back to the owner in error messages. */
    readonly fileName: string;
    /** Real on-disk path `fd` was opened from. Needed separately from
     *  `fileName`: some file-backed validators (e.g. WhatsApp's .txt path)
     *  open a SECOND, independent read of the artifact by path rather than
     *  solely through `fd` (see that validator's own doc comment for why),
     *  so the real staging path must survive the dispatch, not just the
     *  display name. */
    readonly filePath: string;
    readonly fileSha256: string;
    readonly existingFileHashes?: readonly string[];
    readonly maxFileBytes?: number | null;
}
/**
 * File-descriptor-backed counterpart to {@link validateManualUploadArtifactByKind}:
 * dispatches to a kind's file-backed validator (never buffers the whole
 * artifact) when one exists, `null` otherwise. This is the ONLY place in the
 * codebase that both knows which `kind` strings have a file-backed validator
 * AND imports the connector modules that implement them -- it is the
 * connector-owned registry (this whole file lives in
 * `packages/polyfill-connectors`, outside the reference implementation), the
 * same architectural role `validateManualUploadArtifactByKind` above already
 * plays for the buffer-based path.
 *
 * RI callers must never branch on a `kind ===` string themselves or import a
 * connector's validation module directly -- they call this function (or its
 * buffer-based sibling) and get back a result or `null`, staying entirely
 * ignorant of which kinds happen to have a file-backed implementation. That
 * is decided here, and only here, driven by whether `kind` is present in
 * this function's own dispatch table -- the manifest's `file_backed: true`
 * flag is what tells an RI CALLER whether to route through this function at
 * all, not what this function itself branches on.
 */
export declare function validateManualUploadArtifactFromFileByKind(kind: string | null, fd: number, fileSize: number, options: ManualUploadFileValidationOptions): Promise<ManualUploadValidationResult | null>;
//# sourceMappingURL=manual-upload-validation.d.ts.map