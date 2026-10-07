// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export type WhatsAppChatExportValidationStatus = "valid" | "duplicate" | "empty" | "unsupported" | "too_large";
export interface WhatsAppChatExportValidationOptions {
    readonly existingFileHashes?: readonly string[];
    readonly fileName?: string | null;
    readonly maxFileBytes?: number | null;
}
export interface WhatsAppChatExportValidation {
    readonly date_range: {
        readonly end: string | null;
        readonly start: string | null;
    };
    readonly detected_format: "whatsapp_chat_export" | "whatsapp_chat_export_zip" | "unsupported";
    readonly estimated_attachments: number;
    readonly estimated_chats: number;
    readonly estimated_messages: number;
    readonly estimated_participants: number;
    readonly estimated_records: number;
    readonly file_sha256: string;
    readonly media_coverage: {
        readonly attached_media_files: number;
        readonly referenced_media_files: number;
        readonly status: "included_for_import" | "none_referenced" | "not_included";
    };
    readonly remediation: string | null;
    readonly source_identity: {
        readonly kind: "whatsapp_chat";
        readonly participant_count: number;
        readonly participant_preview: readonly string[];
        readonly stable_id: string;
        readonly suggested_display_name: string;
        readonly title: string;
    } | null;
    readonly status: WhatsAppChatExportValidationStatus;
    readonly warnings: readonly string[];
}
export declare function validateWhatsAppChatExportArtifact(input: Uint8Array | string, options?: WhatsAppChatExportValidationOptions): WhatsAppChatExportValidation;
export interface WhatsAppChatExportFileValidationOptions {
    readonly existingFileHashes?: readonly string[];
    readonly fileName?: string | null;
    /** Already-known SHA-256 of the file (e.g. computed once during the
     *  streaming upload write) — passed in rather than recomputed, so this
     *  validator never needs a second whole-file read just to hash it again. */
    readonly fileSha256: string;
    readonly maxFileBytes?: number | null;
}
/**
 * File-backed variant of {@link validateWhatsAppChatExportArtifact}: the
 * artifact's bytes are never buffered whole. `fileSize` is used directly for
 * the size-limit check (no read needed), zip archives are read via
 * extractWhatsAppChatArtifactFromFile (bounded-zip-archive.ts's file-backed
 * reader; the chat-text entry it locates is bounded to MAX_CHAT_TEXT_BYTES
 * before being parsed), and plain .txt exports are parsed directly from a
 * streamed line source (readline over createReadStream) via
 * parseWhatsAppChatFileStream — the message list is built in ONE pass either
 * way, never parsed twice. `fd`/`fileName` are caller-owned; this function
 * neither opens nor closes `fd`.
 */
export declare function validateWhatsAppChatExportArtifactFromFile(fd: number, fileName: string, fileSize: number, options: WhatsAppChatExportFileValidationOptions): Promise<WhatsAppChatExportValidation>;
//# sourceMappingURL=validation.d.ts.map