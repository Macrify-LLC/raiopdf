//! Range-read primitives for large-document streaming.
//!
//! Contract (large-pdf-handling plan, Phase 1):
//! - Grants snapshot `{len, mtime}` at grant time; every ranged read re-checks
//!   the snapshot so pdf.js can never see torn bytes from a file that changed
//!   on disk underneath an open document [R1-5].
//! - Bounds are end-exclusive (`offset + length <= len`); out-of-range and
//!   EOF are typed errors, not short reads.
//! - Per-call length cap = `max(4 MB, threshold)` — viewer chunks stay small
//!   while the whole-small-file fetch in the add-picker flow
//!   (`read_pdf_range(grant, 0, sizeBytes)`) fits in one call [R6-2].
//! - Open-per-call: no cached file handles to leak; pure `std::fs`
//!   (seek + read_exact) so the code is portable to macOS by construction.

use serde::Serialize;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    time::SystemTime,
};

/// Default large-document threshold: 50 MB. Files at or above this size are
/// opened as range-read grants instead of being materialized in memory.
pub const DEFAULT_LARGE_DOC_THRESHOLD_BYTES: u64 = 52_428_800;

/// Floor for the per-call read cap: pdf.js viewer chunks are ~1 MB, so 4 MB
/// leaves generous headroom without letting a single call balloon.
const MIN_RANGE_CALL_CAP_BYTES: u64 = 4 * 1024 * 1024;

/// The shell owns the threshold; the env override exists so testers can
/// exercise the streamed path with small fixtures. The value is returned with
/// open results so UI and shell always agree.
pub fn large_doc_threshold_bytes() -> u64 {
    threshold_from(
        std::env::var("RAIOPDF_LARGE_DOC_THRESHOLD_BYTES")
            .ok()
            .as_deref(),
    )
}

fn threshold_from(override_value: Option<&str>) -> u64 {
    override_value
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_LARGE_DOC_THRESHOLD_BYTES)
}

pub fn range_call_cap_bytes(threshold: u64) -> u64 {
    threshold.max(MIN_RANGE_CALL_CAP_BYTES)
}

/// What the file looked like when the grant was issued. `mtime` is optional
/// because some filesystems cannot report it; `len` alone still catches
/// truncation and replacement-by-larger-file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileSnapshot {
    pub len: u64,
    pub mtime: Option<SystemTime>,
}

pub fn snapshot_file(path: &Path) -> std::io::Result<FileSnapshot> {
    let metadata = std::fs::metadata(path)?;
    Ok(FileSnapshot {
        len: metadata.len(),
        mtime: metadata.modified().ok(),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum RangeReadErrorCode {
    #[serde(rename = "FILE_CHANGED")]
    FileChanged,
    #[serde(rename = "OUT_OF_BOUNDS")]
    OutOfBounds,
    #[serde(rename = "RANGE_TOO_LARGE")]
    RangeTooLarge,
    #[serde(rename = "GRANT_NOT_FOUND")]
    GrantNotFound,
    #[serde(rename = "IO")]
    Io,
}

/// Typed error surfaced to the WebView as `{ code, message }` so the UI can
/// branch on `FILE_CHANGED` ("This file changed on disk — reopen it.")
/// without string matching.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct RangeReadError {
    pub code: RangeReadErrorCode,
    pub message: String,
}

impl RangeReadError {
    pub fn file_changed() -> Self {
        Self {
            code: RangeReadErrorCode::FileChanged,
            message: "This file changed on disk — reopen it.".to_string(),
        }
    }

    fn out_of_bounds(offset: u64, length: u64, len: u64) -> Self {
        Self {
            code: RangeReadErrorCode::OutOfBounds,
            message: format!(
                "Requested range {offset}..{} is outside the file (length {len}).",
                offset.saturating_add(length)
            ),
        }
    }

    fn range_too_large(length: u64, cap: u64) -> Self {
        Self {
            code: RangeReadErrorCode::RangeTooLarge,
            message: format!("Requested {length} bytes exceeds the per-call cap of {cap} bytes."),
        }
    }

    pub fn grant_not_found() -> Self {
        Self {
            code: RangeReadErrorCode::GrantNotFound,
            message: "File grant not found.".to_string(),
        }
    }

    pub fn grant_without_snapshot() -> Self {
        // A grant with no snapshot means the file could not be stat'ed when
        // the grant was issued — ranged reads have no drift baseline, so they
        // are refused rather than served unverified.
        Self {
            code: RangeReadErrorCode::FileChanged,
            message: "This file could not be verified against its open-time snapshot — reopen it."
                .to_string(),
        }
    }

    fn io(error: &std::io::Error) -> Self {
        Self {
            code: RangeReadErrorCode::Io,
            message: format!("Failed to read PDF range: {error}"),
        }
    }
}

/// Read `[offset, offset + length)` from `path`, validating bounds against —
/// and drift from — the grant-time snapshot. End-exclusive; never returns a
/// short read.
pub fn read_file_range(
    path: &Path,
    snapshot: &FileSnapshot,
    offset: u64,
    length: u64,
    cap: u64,
) -> Result<Vec<u8>, RangeReadError> {
    if length == 0 {
        return Err(RangeReadError::out_of_bounds(offset, length, snapshot.len));
    }

    if length > cap {
        return Err(RangeReadError::range_too_large(length, cap));
    }

    let end = offset
        .checked_add(length)
        .ok_or_else(|| RangeReadError::out_of_bounds(offset, length, snapshot.len))?;

    if end > snapshot.len {
        return Err(RangeReadError::out_of_bounds(offset, length, snapshot.len));
    }

    // Open-per-call, then verify the snapshot on the OPEN handle so the
    // stat and the read cannot race a file swap.
    let mut file = File::open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            RangeReadError::file_changed()
        } else {
            RangeReadError::io(&error)
        }
    })?;
    let metadata = file
        .metadata()
        .map_err(|error| RangeReadError::io(&error))?;

    if metadata.len() != snapshot.len {
        return Err(RangeReadError::file_changed());
    }

    // mtime equality is only enforced when both sides could report it.
    if let (Some(granted), Ok(current)) = (snapshot.mtime, metadata.modified()) {
        if granted != current {
            return Err(RangeReadError::file_changed());
        }
    }

    file.seek(SeekFrom::Start(offset))
        .map_err(|error| RangeReadError::io(&error))?;

    let mut buffer = vec![
        0_u8;
        usize::try_from(length)
            .map_err(|_| { RangeReadError::range_too_large(length, cap) })?
    ];
    file.read_exact(&mut buffer).map_err(|error| {
        // A short read despite the length check means the file shrank between
        // the metadata check and the read — that is drift, not plain IO.
        if error.kind() == std::io::ErrorKind::UnexpectedEof {
            RangeReadError::file_changed()
        } else {
            RangeReadError::io(&error)
        }
    })?;

    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_pdf(contents: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("case.pdf");
        std::fs::File::create(&path)
            .expect("create temp pdf")
            .write_all(contents)
            .expect("write temp pdf");
        (dir, path)
    }

    #[test]
    fn reads_an_exact_end_exclusive_range() {
        let (_dir, path) = temp_pdf(b"0123456789");
        let snapshot = snapshot_file(&path).expect("snapshot");

        let bytes = read_file_range(&path, &snapshot, 2, 5, 1024).expect("range read");

        assert_eq!(bytes, b"23456");
    }

    #[test]
    fn reads_the_final_byte_at_the_exact_end_boundary() {
        let (_dir, path) = temp_pdf(b"0123456789");
        let snapshot = snapshot_file(&path).expect("snapshot");

        let bytes = read_file_range(&path, &snapshot, 9, 1, 1024).expect("range read");

        assert_eq!(bytes, b"9");
    }

    #[test]
    fn rejects_ranges_past_eof_with_a_typed_error() {
        let (_dir, path) = temp_pdf(b"0123456789");
        let snapshot = snapshot_file(&path).expect("snapshot");

        let error = read_file_range(&path, &snapshot, 8, 3, 1024).expect_err("past EOF");
        assert_eq!(error.code, RangeReadErrorCode::OutOfBounds);

        let error = read_file_range(&path, &snapshot, 10, 1, 1024).expect_err("at EOF");
        assert_eq!(error.code, RangeReadErrorCode::OutOfBounds);

        let error = read_file_range(&path, &snapshot, u64::MAX, 2, 1024).expect_err("overflow");
        assert_eq!(error.code, RangeReadErrorCode::OutOfBounds);
    }

    #[test]
    fn rejects_empty_ranges() {
        let (_dir, path) = temp_pdf(b"0123456789");
        let snapshot = snapshot_file(&path).expect("snapshot");

        let error = read_file_range(&path, &snapshot, 0, 0, 1024).expect_err("empty range");
        assert_eq!(error.code, RangeReadErrorCode::OutOfBounds);
    }

    #[test]
    fn rejects_ranges_over_the_per_call_cap() {
        let (_dir, path) = temp_pdf(&[0_u8; 64]);
        let snapshot = snapshot_file(&path).expect("snapshot");

        let error = read_file_range(&path, &snapshot, 0, 33, 32).expect_err("over cap");
        assert_eq!(error.code, RangeReadErrorCode::RangeTooLarge);
    }

    #[test]
    fn detects_length_drift_as_file_changed() {
        let (_dir, path) = temp_pdf(b"0123456789");
        let snapshot = snapshot_file(&path).expect("snapshot");

        std::fs::write(&path, b"01234").expect("truncate");

        let error = read_file_range(&path, &snapshot, 0, 4, 1024).expect_err("drift");
        assert_eq!(error.code, RangeReadErrorCode::FileChanged);
    }

    #[test]
    fn detects_mtime_drift_as_file_changed() {
        let (_dir, path) = temp_pdf(b"0123456789");
        let mut snapshot = snapshot_file(&path).expect("snapshot");

        // Same length, different mtime — a same-size overwrite must still be
        // treated as a different file.
        snapshot.mtime = snapshot
            .mtime
            .map(|mtime| mtime - std::time::Duration::from_secs(120));

        let error = read_file_range(&path, &snapshot, 0, 4, 1024).expect_err("mtime drift");
        assert_eq!(error.code, RangeReadErrorCode::FileChanged);
    }

    #[test]
    fn deleted_file_reports_file_changed_not_io() {
        let (_dir, path) = temp_pdf(b"0123456789");
        let snapshot = snapshot_file(&path).expect("snapshot");

        std::fs::remove_file(&path).expect("delete");

        let error = read_file_range(&path, &snapshot, 0, 4, 1024).expect_err("deleted");
        assert_eq!(error.code, RangeReadErrorCode::FileChanged);
    }

    #[test]
    fn threshold_override_parses_and_falls_back() {
        assert_eq!(threshold_from(None), DEFAULT_LARGE_DOC_THRESHOLD_BYTES);
        assert_eq!(threshold_from(Some("1048576")), 1_048_576);
        assert_eq!(threshold_from(Some(" 2048 ")), 2048);
        // Garbage and zero fall back to the default rather than disabling reads.
        assert_eq!(
            threshold_from(Some("not-a-number")),
            DEFAULT_LARGE_DOC_THRESHOLD_BYTES
        );
        assert_eq!(threshold_from(Some("0")), DEFAULT_LARGE_DOC_THRESHOLD_BYTES);
    }

    #[test]
    fn per_call_cap_is_max_of_4mb_and_threshold() {
        assert_eq!(
            range_call_cap_bytes(DEFAULT_LARGE_DOC_THRESHOLD_BYTES),
            DEFAULT_LARGE_DOC_THRESHOLD_BYTES,
        );
        // Below the 4 MB floor the cap clamps up so viewer chunks always fit.
        assert_eq!(range_call_cap_bytes(1024), MIN_RANGE_CALL_CAP_BYTES);
    }
}
