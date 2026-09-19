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
        };
        f.write_str(message)
    }
}

impl std::error::Error for RecoveryCodeError {}

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

/// Uppercase hex of the first 2 bytes of `Sha256(bytes)`. Plain equality is
/// fine for comparing checksums: this detects transcription typos, it does
/// not defend against an adversary who can already see the code (no secret
/// vs. attacker-guess comparison is happening here), so a constant-time
/// comparison would add a dependency for no real benefit.
fn checksum_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex::encode_upper(&digest[..2])
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
            let candidates = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F'];
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
            assert!(decode(garbage).is_err(), "expected {garbage:?} to be rejected");
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
}
