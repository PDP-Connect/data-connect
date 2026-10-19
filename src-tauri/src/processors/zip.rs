// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zip::ZipArchive;

/// Extract a ZIP file to a target directory
pub fn extract_zip(source: &Path, target: &Path) -> Result<(), String> {
    let file = File::open(source).map_err(|e| format!("Failed to open ZIP file: {}", e))?;

    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Failed to read ZIP archive: {}", e))?;

    // Two entries can map to one output path, e.g. legacy (non-UTF-8) names
    // that zip 9 decodes to the same string. Fail instead of letting the
    // second entry silently overwrite the first.
    let mut written: HashSet<PathBuf> = HashSet::new();

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read ZIP entry: {}", e))?;

        let outpath = match file.enclosed_name() {
            Some(path) => target.join(path),
            None => continue,
        };

        if file.is_dir() {
            // Directory entry
            fs::create_dir_all(&outpath)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        } else {
            // File entry
            if !written.insert(outpath.clone()) {
                return Err(format!(
                    "Duplicate ZIP entry path: {}",
                    outpath.display()
                ));
            }
            if let Some(parent) = outpath.parent() {
                if !parent.exists() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create parent directory: {}", e))?;
                }
            }

            let mut outfile =
                File::create(&outpath).map_err(|e| format!("Failed to create file: {}", e))?;

            let mut buffer = Vec::new();
            file.read_to_end(&mut buffer)
                .map_err(|e| format!("Failed to read file content: {}", e))?;

            outfile
                .write_all(&buffer)
                .map_err(|e| format!("Failed to write file: {}", e))?;
        }

        // Set file permissions on Unix
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = file.unix_mode() {
                fs::set_permissions(&outpath, fs::Permissions::from_mode(mode)).ok();
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;

    fn write_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, data) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn extracts_files_and_directories() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("in.zip");
        fs::write(&source, write_zip(&[("a/one.txt", b"1"), ("two.txt", b"2")])).unwrap();
        let target = dir.path().join("out");

        extract_zip(&source, &target).unwrap();

        assert_eq!(fs::read(target.join("a/one.txt")).unwrap(), b"1");
        assert_eq!(fs::read(target.join("two.txt")).unwrap(), b"2");
    }

    fn replace_all(bytes: &mut [u8], from: &[u8], to: &[u8]) {
        assert_eq!(from.len(), to.len());
        let mut i = 0;
        while i + from.len() <= bytes.len() {
            if &bytes[i..i + from.len()] == from {
                bytes[i..i + from.len()].copy_from_slice(to);
            }
            i += 1;
        }
    }

    #[test]
    fn rejects_legacy_names_that_decode_to_the_same_path() {
        // Without the UTF-8 flag, zip 9 decodes a name as UTF-8 when it is
        // valid and as CP437 otherwise. So the raw names C3 A9 and 82 are
        // different entries that both decode to "é". Write two ASCII names
        // of matching lengths and patch in the raw bytes; the CRC covers
        // file data only, so the archive stays valid.
        let mut bytes = write_zip(&[("ABx.txt", b"first"), ("Dx.txt", b"second")]);
        replace_all(&mut bytes, b"ABx.txt", b"\xC3\xA9x.txt");
        replace_all(&mut bytes, b"Dx.txt", b"\x82x.txt");
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("in.zip");
        fs::write(&source, bytes).unwrap();
        let target = dir.path().join("out");

        let err = extract_zip(&source, &target).unwrap_err();

        assert!(err.contains("Duplicate ZIP entry path"), "{err}");
        assert_eq!(fs::read(target.join("\u{e9}x.txt")).unwrap(), b"first");
    }
}
