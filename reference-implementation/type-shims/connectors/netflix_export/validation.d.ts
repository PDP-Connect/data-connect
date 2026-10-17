// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ViewingActivitySourceSchema } from "./types.ts";
export type NetflixExportValidationStatus = "valid" | "duplicate" | "empty" | "unsupported" | "too_large" | "ambiguous_date_order";
export interface NetflixExportValidationOptions {
    readonly existingFileHashes?: readonly string[];
    readonly fileName?: string | null;
    readonly maxFileBytes?: number | null;
}
export interface NetflixExportValidation {
    readonly date_range: {
        readonly end: string | null;
        readonly start: string | null;
    };
    readonly detected_format: "viewing_activity_csv" | "viewing_activity_zip" | "unsupported";
    readonly detected_schema: ViewingActivitySourceSchema | null;
    readonly estimated_records: number;
    readonly file_sha256: string;
    readonly remediation: string | null;
    readonly status: NetflixExportValidationStatus;
}
export declare function validateNetflixExportArtifact(input: Buffer | Uint8Array | string, options?: NetflixExportValidationOptions): NetflixExportValidation;
export interface NetflixExportFileValidationOptions {
    readonly existingFileHashes?: readonly string[];
    readonly fileName?: string | null;
    /** Already-known SHA-256 of the file (e.g. computed once during the
     *  streaming upload write) — passed in rather than recomputed, so this
     *  validator never needs a second whole-file read just to hash it again. */
    readonly fileSha256: string;
    readonly maxFileBytes?: number | null;
}
/**
 * File-descriptor-backed variant of {@link validateNetflixExportArtifact}:
 * the artifact's bytes are never buffered whole for its zip branch (see
 * {@link extractViewingActivityArtifactFromFile}'s own doc comment for the
 * one disclosed exception -- its .csv branch is a bounded, capped whole-file
 * read, not a structurally streamed one; that residual is unchanged by this
 * function and remains explicitly documented there, not silently narrowed
 * here). `fd`/`fileName` are caller-owned; this function neither opens nor
 * closes `fd`.
 */
export declare function validateNetflixExportArtifactFromFile(fd: number, fileName: string, fileSize: number, options: NetflixExportFileValidationOptions): NetflixExportValidation;
//# sourceMappingURL=validation.d.ts.map