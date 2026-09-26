// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { GoogleMapsSourceFormat } from "./types.ts";
export type TimelineValidationStatus = "valid" | "duplicate" | "stale" | "empty" | "unsupported" | "too_large";
export interface GoogleMapsTimelineValidationOptions {
    readonly existingFileHashes?: readonly string[];
    readonly importedThrough?: string | null;
    readonly maxFileBytes?: number | null;
}
export interface GoogleMapsTimelineValidation {
    readonly date_range: {
        readonly end: string | null;
        readonly start: string | null;
    };
    readonly detected_format: GoogleMapsSourceFormat | "unsupported";
    readonly estimated_points: number;
    readonly estimated_segments: number;
    readonly file_sha256: string;
    readonly remediation: string | null;
    readonly status: TimelineValidationStatus;
}
export declare function validateGoogleMapsTimelineArtifact(input: Uint8Array | string, options?: GoogleMapsTimelineValidationOptions): GoogleMapsTimelineValidation;
export interface GoogleMapsTimelineFileValidationOptions {
    readonly existingFileHashes?: readonly string[];
    /** Already-known SHA-256 of the file (e.g. computed once during the
     *  streaming upload write) — passed in rather than recomputed, so this
     *  validator never needs a second whole-file read just to hash it again. */
    readonly fileSha256: string;
    readonly importedThrough?: string | null;
    readonly maxFileBytes?: number | null;
}
/**
 * File-descriptor-backed variant of {@link validateGoogleMapsTimelineArtifact}:
 * the artifact's bytes are never buffered whole and the document is never
 * `JSON.parse`d as one value -- `@streamparser/json` (already proven for
 * twitter_archive's own multi-hundred-MB streaming reader) parses the file
 * token-by-token off disk, and only running point/segment counts plus a
 * running min/max timestamp are retained, matching the fd-backed pattern
 * already proven for WhatsApp and Netflix in this same dispatch table.
 * `path` is caller-owned; this function only opens a read stream from it, it
 * neither creates nor deletes the file.
 */
export declare function validateGoogleMapsTimelineArtifactFromFile(path: string, fileSize: number, options: GoogleMapsTimelineFileValidationOptions): Promise<GoogleMapsTimelineValidation>;
//# sourceMappingURL=validation.d.ts.map