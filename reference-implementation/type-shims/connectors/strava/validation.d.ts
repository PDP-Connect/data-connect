// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export type StravaAccountExportValidationStatus = "valid" | "duplicate" | "empty" | "unsupported" | "too_large";
type StravaExportFormat = "strava_account_export_csv" | "strava_account_export_zip";
export interface StravaAccountExportValidationOptions {
    readonly existingFileHashes?: readonly string[];
    readonly fileName?: string | null;
    readonly maxFileBytes?: number | null;
}
export interface StravaAccountExportFileValidationOptions {
    readonly existingFileHashes?: readonly string[];
    readonly fileName: string;
    /** Already-known SHA-256 from the staged upload write. */
    readonly fileSha256: string;
    readonly maxFileBytes?: number | null;
}
export interface StravaAccountExportValidation {
    readonly date_range: {
        readonly end: string | null;
        readonly start: string | null;
    };
    readonly detected_format: StravaExportFormat | "unsupported";
    readonly detected_headers: readonly string[] | null;
    readonly estimated_records: number;
    readonly file_sha256: string;
    readonly remediation: string | null;
    readonly repeated_headers: {
        readonly distance: readonly number[];
        readonly elapsed_time: readonly number[];
    } | null;
    readonly status: StravaAccountExportValidationStatus;
}
export declare function validateStravaAccountExportArtifact(input: Buffer | Uint8Array | string, options?: StravaAccountExportValidationOptions): StravaAccountExportValidation;
export declare function validateStravaAccountExportArtifactFromFile(fd: number, _filePath: string, fileSize: number, options: StravaAccountExportFileValidationOptions): Promise<StravaAccountExportValidation>;
export {};
//# sourceMappingURL=validation.d.ts.map