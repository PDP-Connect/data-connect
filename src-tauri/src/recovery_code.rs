// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

//! A re-encoded, checksummed, printable recovery code for an opaque durable
//! credential string (e.g. the database encryption key from
//! `owner_credential.rs`).
//!
//! This is NOT a BIP39 wordlist and NOT a raw keyfile dump. The credential it
//! wraps is already high-entropy random bytes that are never meant to be
//! memorized -- only transcribed once during an incident -- so there is no
//! KDF here and no memorization aid. The format follows the 1Password Secret
//! Key pattern: hex-encode the credential's bytes, append a short checksum so
//! transcription typos are caught instead of silently producing a different
//! (wrong) key, then group the result for readability. See
//! ai/research/product-design/local-vault-key-recovery-artifact-should-be-a-checksummed-code-not-a-raw-keyfile-or-bip39-mnemonic.md
//! for the sourced comparison against 1Password/Signal/Bitwarden/Proton/Apple/age.
//!
//! Operates on the credential STRING's UTF-8 bytes, not on any decoded form
//! of it -- `load_or_create_secret_with_store_inner` treats every credential
//! this way (an opaque string), so this format is reusable for any of the
//! three credentials that module manages, not just the database key.

use sha2::{Digest, Sha256};
use std::fmt;

const CHECKSUM_HEX_LEN: usize = 4;
const GROUP_LEN: usize = 4;
const RECOVERY_KIT_V2_VERSION: u8 = 2;
const RECOVERY_KIT_V2_MAX_ENCODED_CHARS: usize = 8_192;
const RECOVERY_KIT_V2_MAX_ENCODED_BYTES: usize = RECOVERY_KIT_V2_MAX_ENCODED_CHARS / 2;
const RECOVERY_KIT_V2_FIXED_BYTES: usize = 1 + 2 + 2 + 2;
pub(crate) const RECOVERY_KIT_V2_MAX_KEY_BYTES: usize =
    (RECOVERY_KIT_V2_MAX_ENCODED_BYTES - RECOVERY_KIT_V2_FIXED_BYTES) / 2;

/// Errors deliberately never echo the caller-supplied code: a rejected code
/// may be a near-miss transcription of a real secret, and including it in an
/// error (which could end up in a log) would defeat the purpose of keeping
/// the secret out of logs in the first place.
#[derive(Debug, Eq, PartialEq)]
pub(crate) enum RecoveryCodeError {
    EmptyCredential,
    TooShort,
    InvalidHex,
    ChecksumMismatch,
    InvalidUtf8,
    KeyTooLong,
    MissingCredentialKey,
    MissingDatabaseKey,
    TrailingData,
    UnsupportedVersion,
    TooLarge,
    Truncated,
}

impl fmt::Display for RecoveryCodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::EmptyCredential => "Cannot create a recovery code for an empty credential",
            Self::TooShort => "Recovery code is too short to be valid",
            Self::InvalidHex => "Recovery code contains characters that are not valid hex",
            Self::ChecksumMismatch => {
                "Recovery code failed its checksum; check for a typo and try again"
            }
            Self::InvalidUtf8 => "Recovery code did not decode to valid credential data",
            Self::KeyTooLong => "Recovery kit key exceeds the v2 length limit",
            Self::MissingCredentialKey => "Recovery kit credential key is required",
            Self::MissingDatabaseKey => "Recovery kit does not contain a database key",
            Self::TrailingData => "Recovery kit code contains trailing data",
            Self::UnsupportedVersion => "Recovery kit code uses an unsupported version",
            Self::TooLarge => "Recovery kit code is too large",
            Self::Truncated => "Recovery kit code is truncated",
        };
        f.write_str(message)
    }
}

impl std::error::Error for RecoveryCodeError {}

#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) struct RecoveryKitV2 {
    pub(crate) database_encryption_key: Option<String>,
    pub(crate) credential_encryption_key: String,
}

/// Encode a credential string into a segmented, checksummed printable code.
///
/// Layout: `HEX(credential bytes) || HEX(checksum)`, where checksum is the
/// first 2 bytes of `Sha256(credential bytes)`, all uppercase, grouped into
/// `GROUP_LEN`-character segments joined by `-`. The final group may be
/// shorter than `GROUP_LEN`; that is unambiguous to parse back since `decode`
/// strips dashes before re-grouping.
pub(crate) fn encode(credential: &str) -> Result<String, RecoveryCodeError> {
    if credential.is_empty() {
        return Err(RecoveryCodeError::EmptyCredential);
    }

    let payload_hex = hex::encode_upper(credential.as_bytes());
    let checksum = checksum_hex(credential.as_bytes());
    let full_hex = format!("{payload_hex}{checksum}");

    let grouped = full_hex
        .as_bytes()
        .chunks(GROUP_LEN)
        .map(|chunk| std::str::from_utf8(chunk).expect("hex output is ASCII"))
        .collect::<Vec<_>>()
        .join("-");
    Ok(grouped)
}

/// Decode a previously-encoded recovery code back into the original
/// credential string.
///
/// Tolerant of whitespace, dashes in any position, and lowercase input --
/// owners will not perfectly reproduce the segment boundaries or case this
/// module emitted when they transcribe a code by hand.
pub(crate) fn decode(code: &str) -> Result<String, RecoveryCodeError> {
    let cleaned: String = code
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '-')
        .flat_map(char::to_uppercase)
        .collect();

    if cleaned.len() < CHECKSUM_HEX_LEN + 2 {
        return Err(RecoveryCodeError::TooShort);
    }
    if !cleaned.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(RecoveryCodeError::InvalidHex);
    }

    let split_at = cleaned.len() - CHECKSUM_HEX_LEN;
    let (payload_hex, checksum_hex) = cleaned.split_at(split_at);

    let payload_bytes = hex::decode(payload_hex).map_err(|_| RecoveryCodeError::InvalidHex)?;
    let expected_checksum = checksum_hex.to_ascii_uppercase();
    let actual_checksum = self::checksum_hex(&payload_bytes);
    if actual_checksum != expected_checksum {
        return Err(RecoveryCodeError::ChecksumMismatch);
    }

    String::from_utf8(payload_bytes).map_err(|_| RecoveryCodeError::InvalidUtf8)
}

/// Keys an owner-supplied recovery code restores. A v1 code carries only
/// the database key; a v2 kit also carries the credential encryption key.
#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) struct ImportedRecoveryKeys {
    pub(crate) database_encryption_key: String,
    pub(crate) credential_encryption_key: Option<String>,
}

/// Decode a recovery code of either format for import.
///
/// Both formats use the same trailing checksum, so a v2 kit also passes v1
/// `decode` and yields a garbage key. Try v2 first and fall back to v1 only
/// when the input is not a v2 kit (wrong version byte, or too short to be
/// one). A printable v1 credential never starts with the 0x02 version byte.
pub(crate) fn decode_for_import(code: &str) -> Result<ImportedRecoveryKeys, RecoveryCodeError> {
    match decode_v2(code) {
        Ok(kit) => Ok(ImportedRecoveryKeys {
            database_encryption_key: kit
                .database_encryption_key
                .ok_or(RecoveryCodeError::MissingDatabaseKey)?,
            credential_encryption_key: Some(kit.credential_encryption_key),
        }),
        Err(RecoveryCodeError::UnsupportedVersion | RecoveryCodeError::Truncated) => {
            Ok(ImportedRecoveryKeys {
                database_encryption_key: decode(code)?,
                credential_encryption_key: None,
            })
        }
        Err(error) => Err(error),
    }
}

pub(crate) fn encode_v2(kit: &RecoveryKitV2) -> Result<String, RecoveryCodeError> {
    let database_key = optional_key_bytes(kit.database_encryption_key.as_deref())?;
    let credential_key = required_key_bytes(&kit.credential_encryption_key)?;
    let mut payload =
        Vec::with_capacity(RECOVERY_KIT_V2_FIXED_BYTES + database_key.len() + credential_key.len());
    payload.push(RECOVERY_KIT_V2_VERSION);
    push_length_prefixed(&mut payload, database_key)?;
    push_length_prefixed(&mut payload, credential_key)?;
    let checksum = checksum_bytes(&payload);
    payload.extend_from_slice(&checksum);
    Ok(group_upper_hex(&payload))
}

pub(crate) fn decode_v2(code: &str) -> Result<RecoveryKitV2, RecoveryCodeError> {
    let cleaned: String = code
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '-')
        .flat_map(char::to_uppercase)
        .collect();

    if cleaned.len() > RECOVERY_KIT_V2_MAX_ENCODED_CHARS {
        return Err(RecoveryCodeError::TooLarge);
    }
    if cleaned.len() < (RECOVERY_KIT_V2_FIXED_BYTES * 2) || cleaned.len() % 2 != 0 {
        return Err(RecoveryCodeError::Truncated);
    }
    if !cleaned.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(RecoveryCodeError::InvalidHex);
    }
    let bytes = hex::decode(&cleaned).map_err(|_| RecoveryCodeError::InvalidHex)?;
    let split_at = bytes.len() - 2;
    let (payload, checksum) = bytes.split_at(split_at);
    if checksum_bytes(payload) != checksum {
        return Err(RecoveryCodeError::ChecksumMismatch);
    }
    if payload.first().copied() != Some(RECOVERY_KIT_V2_VERSION) {
        return Err(RecoveryCodeError::UnsupportedVersion);
    }

    let (database_key_bytes, offset) = read_length_prefixed(payload, 1)?;
    let (credential_key_bytes, offset) = read_length_prefixed(payload, offset)?;
    if offset != payload.len() {
        return Err(RecoveryCodeError::TrailingData);
    }
    if credential_key_bytes.is_empty() {
        return Err(RecoveryCodeError::MissingCredentialKey);
    }

    let database_encryption_key = if database_key_bytes.is_empty() {
        None
    } else {
        Some(
            String::from_utf8(database_key_bytes.to_vec())
                .map_err(|_| RecoveryCodeError::InvalidUtf8)?,
        )
    };
    let credential_encryption_key = String::from_utf8(credential_key_bytes.to_vec())
        .map_err(|_| RecoveryCodeError::InvalidUtf8)?;
    Ok(RecoveryKitV2 {
        database_encryption_key,
        credential_encryption_key,
    })
}

/// Uppercase hex of the first 2 bytes of `Sha256(bytes)`. Plain equality is
/// fine for comparing checksums: this detects transcription typos, it does
/// not defend against an adversary who can already see the code (no secret
/// vs. attacker-guess comparison is happening here), so a constant-time
/// comparison would add a dependency for no real benefit.
fn checksum_hex(bytes: &[u8]) -> String {
    hex::encode_upper(checksum_bytes(bytes))
}

fn checksum_bytes(bytes: &[u8]) -> [u8; 2] {
    let digest = Sha256::digest(bytes);
    [digest[0], digest[1]]
}

fn group_upper_hex(bytes: &[u8]) -> String {
    hex::encode_upper(bytes)
        .as_bytes()
        .chunks(GROUP_LEN)
        .map(|chunk| std::str::from_utf8(chunk).expect("hex output is ASCII"))
        .collect::<Vec<_>>()
        .join("-")
}

fn optional_key_bytes(key: Option<&str>) -> Result<&[u8], RecoveryCodeError> {
    let Some(key) = key else {
        return Ok(&[]);
    };
    let bytes = key.as_bytes();
    if bytes.is_empty() {
        return Err(RecoveryCodeError::MissingCredentialKey);
    }
    if bytes.len() > RECOVERY_KIT_V2_MAX_KEY_BYTES {
        return Err(RecoveryCodeError::KeyTooLong);
    }
    Ok(bytes)
}

fn required_key_bytes(key: &str) -> Result<&[u8], RecoveryCodeError> {
    if key.is_empty() {
        return Err(RecoveryCodeError::MissingCredentialKey);
    }
    let bytes = key.as_bytes();
    if bytes.len() > RECOVERY_KIT_V2_MAX_KEY_BYTES {
        return Err(RecoveryCodeError::KeyTooLong);
    }
    Ok(bytes)
}

fn push_length_prefixed(payload: &mut Vec<u8>, bytes: &[u8]) -> Result<(), RecoveryCodeError> {
    let length = u16::try_from(bytes.len()).map_err(|_| RecoveryCodeError::KeyTooLong)?;
    payload.extend_from_slice(&length.to_be_bytes());
    payload.extend_from_slice(bytes);
    Ok(())
}

fn read_length_prefixed(
    payload: &[u8],
    offset: usize,
) -> Result<(&[u8], usize), RecoveryCodeError> {
    if offset + 2 > payload.len() {
        return Err(RecoveryCodeError::Truncated);
    }
    let length = u16::from_be_bytes([payload[offset], payload[offset + 1]]) as usize;
    let start = offset + 2;
    let end = start
        .checked_add(length)
        .ok_or(RecoveryCodeError::Truncated)?;
    if end > payload.len() {
        return Err(RecoveryCodeError::Truncated);
    }
    Ok((&payload[start..end], end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_realistic_base64_credential() {
        // Shape of a real load_or_create_database_encryption_key output:
        // URL_SAFE_NO_PAD base64 of 32 random bytes, 43 ASCII chars.
        let credential = "3n2QeQqzQe1kQwj7yQvV8sQwK3nq9y4pQvXwLd0m5aE";
        let code = encode(credential).expect("encode");
        let decoded = decode(&code).expect("decode");
        assert_eq!(decoded, credential);
    }

    #[test]
    fn round_trips_non_ascii_utf8_credential() {
        // Proves byte-safety, not just ASCII-safety: the format never
        // assumes a fixed byte length or an ASCII-only alphabet.
        let credential = "héllo-wörld-🔑-credential";
        let code = encode(credential).expect("encode");
        let decoded = decode(&code).expect("decode");
        assert_eq!(decoded, credential);
    }

    #[test]
    fn round_trips_a_short_credential() {
        let credential = "x";
        let code = encode(credential).expect("encode");
        let decoded = decode(&code).expect("decode");
        assert_eq!(decoded, credential);
    }

    #[test]
    fn rejects_empty_credential_at_encode_time() {
        assert_eq!(encode(""), Err(RecoveryCodeError::EmptyCredential));
    }

    #[test]
    fn example_code_has_dash_grouped_uppercase_hex_shape() {
        let credential = "3n2QeQqzQe1kQwj7yQvV8sQwK3nq9y4pQvXwLd0m5aE";
        let code = encode(credential).expect("encode");
        for group in code.split('-') {
            assert!(!group.is_empty());
            assert!(group.len() <= GROUP_LEN);
            assert!(group.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert_eq!(group, group.to_ascii_uppercase());
        }
    }

    #[test]
    fn lowercase_input_is_accepted() {
        let credential = "3n2QeQqzQe1kQwj7yQvV8sQwK3nq9y4pQvXwLd0m5aE";
        let code = encode(credential).expect("encode");
        let decoded = decode(&code.to_lowercase()).expect("decode lowercase");
        assert_eq!(decoded, credential);
    }

    #[test]
    fn extra_whitespace_and_dashes_in_arbitrary_positions_are_tolerated() {
        let credential = "3n2QeQqzQe1kQwj7yQvV8sQwK3nq9y4pQvXwLd0m5aE";
        let code = encode(credential).expect("encode");
        let mangled: String = code
            .chars()
            .enumerate()
            .map(|(index, character)| {
                if index % 5 == 0 {
                    format!("  -{character}-\t")
                } else {
                    character.to_string()
                }
            })
            .collect();
        let decoded = decode(&mangled).expect("decode mangled");
        assert_eq!(decoded, credential);
    }

    #[test]
    fn a_single_flipped_hex_character_at_every_position_is_rejected() {
        let credential = "3n2QeQqzQe1kQwj7yQvV8sQwK3nq9y4pQvXwLd0m5aE";
        let code = encode(credential).expect("encode");
        let cleaned: Vec<char> = code.chars().filter(|character| *character != '-').collect();

        for position in 0..cleaned.len() {
            let original_char = cleaned[position];
            let mut flipped = cleaned.clone();
            // Pick a hex digit guaranteed to differ from the original.
            let candidates = [
                '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F',
            ];
            let replacement = candidates
                .into_iter()
                .find(|candidate| *candidate != original_char.to_ascii_uppercase())
                .expect("a differing hex digit exists");
            flipped[position] = replacement;
            let mangled: String = flipped.into_iter().collect();

            let result = decode(&mangled);
            assert!(
                result.is_err(),
                "flipping position {position} ({original_char} -> {replacement}) was not detected"
            );
        }
    }

    #[test]
    fn garbage_input_is_rejected_without_panicking() {
        for garbage in ["", "not hex at all!!", "12", "----", "   ", "ZZZZ-ZZZZ"] {
            assert!(
                decode(garbage).is_err(),
                "expected {garbage:?} to be rejected"
            );
        }
    }

    #[test]
    fn decode_errors_never_include_the_offending_input() {
        let garbage = "totally-not-a-valid-recovery-code-at-all-zzz";
        let error = decode(garbage).expect_err("garbage should be rejected");
        let message = error.to_string();
        assert!(!message.contains(garbage));
        assert!(!message.to_lowercase().contains("totally"));
    }

    #[test]
    fn v2_round_trips_database_and_credential_keys() {
        let kit = RecoveryKitV2 {
            database_encryption_key: Some("sqlite-db-key".to_string()),
            credential_encryption_key: "credential-vault-key".to_string(),
        };
        let code = encode_v2(&kit).expect("encode v2");
        let decoded = decode_v2(&code).expect("decode v2");
        assert_eq!(decoded, kit);
    }

    #[test]
    fn import_rejects_v2_kit_without_database_key_instead_of_falling_back_to_v1() {
        let code = encode_v2(&RecoveryKitV2 {
            database_encryption_key: None,
            credential_encryption_key: "credential-key".to_string(),
        })
        .expect("encode v2");
        assert!(
            decode(&code).is_ok(),
            "v1 decode accepts v2 bytes as garbage"
        );
        assert_eq!(
            decode_for_import(&code),
            Err(RecoveryCodeError::MissingDatabaseKey)
        );
    }

    #[test]
    fn v2_round_trips_absent_database_key() {
        let kit = RecoveryKitV2 {
            database_encryption_key: None,
            credential_encryption_key: "credential-vault-key".to_string(),
        };
        let code = encode_v2(&kit).expect("encode v2");
        let decoded = decode_v2(&code).expect("decode v2");
        assert_eq!(decoded, kit);
    }

    #[test]
    fn v2_matches_typescript_known_answer_vector() {
        let kit = RecoveryKitV2 {
            database_encryption_key: Some("sqlite-db-key".to_string()),
            credential_encryption_key: "credential-vault-key".to_string(),
        };
        let code = "0200-0D73-716C-6974-652D-6462-2D6B-6579-0014-6372-6564-656E-7469-616C-2D76-6175-6C74-2D6B-6579-68B1";
        assert_eq!(encode_v2(&kit).expect("encode v2"), code);
        assert_eq!(decode_v2(code).expect("decode v2"), kit);
    }

    #[test]
    fn v2_preserves_leading_byte_order_mark_bytes() {
        let kit = RecoveryKitV2 {
            database_encryption_key: Some("\u{FEFF}sqlite-db-key".to_string()),
            credential_encryption_key: "\u{FEFF}credential-vault-key".to_string(),
        };
        let code = encode_v2(&kit).expect("encode v2");
        assert_eq!(decode_v2(&code).expect("decode v2"), kit);
    }

    #[test]
    fn v2_rejects_invalid_version() {
        let code = encode_v2(&RecoveryKitV2 {
            database_encryption_key: None,
            credential_encryption_key: "credential-vault-key".to_string(),
        })
        .expect("encode v2");
        let mut bytes = hex::decode(code.replace('-', "")).expect("hex");
        bytes[0] = 3;
        let checksum = checksum_bytes(&bytes[..bytes.len() - 2]);
        let checksum_offset = bytes.len() - 2;
        bytes[checksum_offset..].copy_from_slice(&checksum);
        let code = group_upper_hex(&bytes);
        assert_eq!(decode_v2(&code), Err(RecoveryCodeError::UnsupportedVersion));
    }

    #[test]
    fn v2_rejects_checksum_mismatch() {
        let code = encode_v2(&RecoveryKitV2 {
            database_encryption_key: Some("sqlite-db-key".to_string()),
            credential_encryption_key: "credential-vault-key".to_string(),
        })
        .expect("encode v2");
        let mut bytes = hex::decode(code.replace('-', "")).expect("hex");
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        let code = group_upper_hex(&bytes);
        assert_eq!(decode_v2(&code), Err(RecoveryCodeError::ChecksumMismatch));
    }

    #[test]
    fn v2_rejects_truncated_payload() {
        let payload = [RECOVERY_KIT_V2_VERSION, 0, 4, b'd'];
        let mut bytes = payload.to_vec();
        bytes.extend_from_slice(&checksum_bytes(&payload));
        let code = group_upper_hex(&bytes);
        assert_eq!(decode_v2(&code), Err(RecoveryCodeError::Truncated));
    }

    #[test]
    fn v2_rejects_overlarge_decode_input_before_allocation() {
        let code = "A".repeat(RECOVERY_KIT_V2_MAX_ENCODED_CHARS + 2);
        assert_eq!(decode_v2(&code), Err(RecoveryCodeError::TooLarge));
    }

    #[test]
    fn v2_rejects_key_that_would_exceed_decoder_size_cap() {
        let kit = RecoveryKitV2 {
            database_encryption_key: None,
            credential_encryption_key: "x".repeat(RECOVERY_KIT_V2_MAX_KEY_BYTES + 1),
        };
        assert_eq!(encode_v2(&kit), Err(RecoveryCodeError::KeyTooLong));
    }

    #[test]
    fn v2_rejects_empty_database_key_when_present() {
        let kit = RecoveryKitV2 {
            database_encryption_key: Some(String::new()),
            credential_encryption_key: "credential-vault-key".to_string(),
        };
        assert_eq!(
            encode_v2(&kit),
            Err(RecoveryCodeError::MissingCredentialKey)
        );
    }

    #[test]
    fn v2_rejects_missing_credential_key() {
        let kit = RecoveryKitV2 {
            database_encryption_key: None,
            credential_encryption_key: String::new(),
        };
        assert_eq!(
            encode_v2(&kit),
            Err(RecoveryCodeError::MissingCredentialKey)
        );
    }
}
