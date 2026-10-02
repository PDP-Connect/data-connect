// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export type AppleHealthExportValidationStatus = "valid" | "duplicate" | "empty" | "unsupported" | "too_large";
export interface AppleHealthExportValidationOptions {
    readonly existingFileHashes?: readonly string[];
    readonly fileName?: string | null;
    readonly maxFileBytes?: number | null;
}
export interface AppleHealthExportValidation {
    readonly date_range: {
        readonly end: string | null;
        readonly start: string | null;
    };
    readonly detected_format: "apple_health_export_xml" | "apple_health_export_zip" | "unsupported";
    readonly estimated_records: number;
    readonly estimated_workouts: number;
    readonly file_sha256: string;
    readonly remediation: string | null;
    readonly status: AppleHealthExportValidationStatus;
}
/**
 * Validate an already-staged Apple Health export artifact from disk (a bare
 * export.xml, or the .zip Health app produces) — the primary entrypoint,
 * used by the manual-upload route's file-backed dispatch. `fd`/`filePath`
 * are caller-owned; this function neither opens nor closes `fd`, but DOES
 * open its own second descriptor internally for a .zip's temporary
 * extraction (closed before returning). Matches
 * {@link scanExportXmlSummary}'s O(1)-memory streaming guarantee.
 */
export declare function validateAppleHealthExportArtifactFromFile(fd: number, filePath: string, fileSize: number, options: {
    readonly existingFileHashes?: readonly string[];
    readonly fileName: string;
    readonly fileSha256: string;
    readonly maxFileBytes?: number | null;
}): Promise<AppleHealthExportValidation>;
/**
 * Buffer-backed entrypoint required by the connector-owned validation
 * registry's uniform dispatch shape (see manual-upload-validation.ts) even
 * though Apple Health exports are never appropriately validated from an
 * in-memory buffer at real-world size — this writes the buffer to a scratch
 * temp file and delegates to the file-backed path above, so the SAME
 * streaming logic runs either way and a small buffer (e.g. a synthetic
 * fixture in a test) is not a second, divergent code path.
 */
export declare function validateAppleHealthExportArtifact(input: Buffer | Uint8Array | string, options?: AppleHealthExportValidationOptions): Promise<AppleHealthExportValidation>;
//# sourceMappingURL=validation.d.ts.map