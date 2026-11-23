// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

pub(crate) fn format_build_receipt(
    version: &str,
    sha: Option<&str>,
    profile: Option<&str>,
) -> String {
    let build = sha
        .filter(|sha| {
            (7..=40).contains(&sha.len())
                && sha
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .map(|sha| &sha[..sha.len().min(12)])
        .unwrap_or("unknown");
    let profile = profile.unwrap_or("default");
    format!("DataConnect {version} build {build} profile {profile}")
}

#[cfg(test)]
mod tests {
    use super::format_build_receipt;

    #[test]
    fn truncates_a_full_sha_to_twelve_characters() {
        assert_eq!(
            format_build_receipt(
                "0.5.5",
                Some("0123456789abcdef0123456789abcdef01234567"),
                Some("preview"),
            ),
            "DataConnect 0.5.5 build 0123456789ab profile preview"
        );
    }

    #[test]
    fn keeps_a_valid_short_sha_and_defaults_the_profile() {
        assert_eq!(
            format_build_receipt("0.5.5", Some("a1b2c3d"), None),
            "DataConnect 0.5.5 build a1b2c3d profile default"
        );
    }

    #[test]
    fn does_not_echo_missing_or_invalid_shas() {
        for sha in [
            None,
            Some(""),
            Some("ABCDEF0"),
            Some("not-hex"),
            Some("abcdef"),
            Some("0123456789abcdef0123456789abcdef012345678"),
            Some("abc\n123"),
            Some("éabcdef"),
        ] {
            assert_eq!(
                format_build_receipt("0.5.5", sha, None),
                "DataConnect 0.5.5 build unknown profile default"
            );
        }
    }
}
