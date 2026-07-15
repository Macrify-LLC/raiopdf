//! Platform-neutral discovery for binaries inside RaioPDF's payload.
//!
//! Installed bundles always expose one canonical `payload/` resource root.
//! Source/build trees may namespace payloads by platform; callers should pass
//! the selected root explicitly when more than one is present.

use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimePlatform {
    Windows,
    Unix,
}

impl RuntimePlatform {
    pub const fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unix
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PayloadTool {
    Java,
    Ocrmypdf,
    Python,
    Tesseract,
    TessdataEnglish,
    Ghostscript,
    Qpdf,
    OcrProgress,
    Node,
}

pub fn tool_candidates(
    tool: PayloadTool,
    platform: RuntimePlatform,
) -> Vec<&'static [&'static str]> {
    use PayloadTool::*;
    use RuntimePlatform::*;

    match (tool, platform) {
        (Java, Windows) => vec![&["jre", "bin", "java.exe"], &["jre", "bin", "java"]],
        (Java, Unix) => vec![
            &["jre", "bin", "java"],
            &["jre", "Contents", "Home", "bin", "java"],
        ],
        (Ocrmypdf, Windows) => vec![&["ocr", "ocrmypdf.cmd"]],
        (Ocrmypdf, Unix) => vec![
            &["ocr", "ocrmypdf"],
            &["ocr", "bin", "ocrmypdf"],
            &["ocr", "python", "bin", "ocrmypdf"],
        ],
        (Python, Windows) => vec![&["ocr", "python", "python.exe"]],
        (Python, Unix) => vec![
            &["ocr", "python", "bin", "python3"],
            &["ocr", "python", "bin", "python"],
        ],
        (Tesseract, Windows) => vec![
            &["ocr", "tesseract", "tesseract.exe"],
            &["ocr", "tesseract", "bin", "tesseract.exe"],
        ],
        (Tesseract, Unix) => vec![
            &["ocr", "tesseract", "bin", "tesseract"],
            &["ocr", "tesseract", "tesseract"],
        ],
        (TessdataEnglish, Windows) => {
            vec![&["ocr", "tesseract", "tessdata", "eng.traineddata"]]
        }
        (TessdataEnglish, Unix) => vec![
            &["ocr", "tesseract", "share", "tessdata", "eng.traineddata"],
            &["ocr", "tesseract", "tessdata", "eng.traineddata"],
        ],
        (Ghostscript, Windows) => vec![
            &["ocr", "gs", "bin", "gs.exe"],
            &["ocr", "gs", "bin", "gswin64c.exe"],
        ],
        (Ghostscript, Unix) => vec![&["ocr", "gs", "bin", "gs"]],
        (Qpdf, Windows) => vec![&["ocr", "qpdf", "bin", "qpdf.exe"]],
        (Qpdf, Unix) => vec![&["ocr", "qpdf", "bin", "qpdf"]],
        (OcrProgress, Windows) => vec![&["ocr", "raiopdf-ocr-progress.cmd"]],
        (OcrProgress, Unix) => vec![
            &["ocr", "raiopdf-ocr-progress"],
            &["ocr", "bin", "raiopdf-ocr-progress"],
        ],
        (Node, Windows) => vec![&["mcp", "node", "node.exe"]],
        (Node, Unix) => vec![&["mcp", "node", "bin", "node"], &["mcp", "node", "node"]],
    }
}

pub fn find_payload_tool(
    payload_dir: &Path,
    tool: PayloadTool,
    platform: RuntimePlatform,
) -> Option<PathBuf> {
    tool_candidates(tool, platform)
        .iter()
        .map(|parts| join_parts(payload_dir, parts))
        .find(|candidate| candidate.is_file())
}

pub fn expected_payload_path(tool: PayloadTool, platform: RuntimePlatform) -> String {
    tool_candidates(tool, platform)[0].join("/")
}

pub fn payload_path_entries(payload_dir: &Path, platform: RuntimePlatform) -> Vec<PathBuf> {
    let mut entries = vec![payload_dir.join("ocr")];
    for tool in [
        PayloadTool::Python,
        PayloadTool::Tesseract,
        PayloadTool::Ghostscript,
        PayloadTool::Qpdf,
    ] {
        if let Some(parent) = find_payload_tool(payload_dir, tool, platform)
            .and_then(|path| path.parent().map(Path::to_path_buf))
        {
            entries.push(parent);
        }
    }
    entries.sort();
    entries.dedup();
    entries.into_iter().filter(|path| path.is_dir()).collect()
}

fn join_parts(root: &Path, parts: &[&str]) -> PathBuf {
    parts
        .iter()
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(name: &str) -> Self {
            let unique = format!(
                "raiopdf-runtime-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock")
                    .as_nanos()
            );
            let path = std::env::temp_dir().join(unique);
            fs::create_dir_all(&path).expect("create temp root");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().expect("test file parent")).expect("create parent");
        fs::write(path, []).expect("write test file");
    }

    #[test]
    fn windows_and_unix_paths_never_cross_resolve() {
        let root = TestDir::new("windows");
        let payload = root.path();
        touch(&payload.join("jre/bin/java.exe"));
        touch(&payload.join("ocr/ocrmypdf.cmd"));

        assert!(find_payload_tool(payload, PayloadTool::Java, RuntimePlatform::Windows).is_some());
        assert!(
            find_payload_tool(payload, PayloadTool::Ocrmypdf, RuntimePlatform::Windows).is_some()
        );
        assert!(find_payload_tool(payload, PayloadTool::Java, RuntimePlatform::Unix).is_none());
        assert!(find_payload_tool(payload, PayloadTool::Ocrmypdf, RuntimePlatform::Unix).is_none());
    }

    #[test]
    fn unix_layout_discovers_native_runtime_names() {
        let root = TestDir::new("unix");
        let payload = root.path();
        touch(&payload.join("jre/bin/java"));
        touch(&payload.join("ocr/python/bin/ocrmypdf"));
        touch(&payload.join("ocr/python/bin/python3"));
        touch(&payload.join("ocr/tesseract/bin/tesseract"));
        touch(&payload.join("ocr/tesseract/share/tessdata/eng.traineddata"));
        touch(&payload.join("ocr/gs/bin/gs"));
        touch(&payload.join("ocr/qpdf/bin/qpdf"));

        for tool in [
            PayloadTool::Java,
            PayloadTool::Ocrmypdf,
            PayloadTool::Python,
            PayloadTool::Tesseract,
            PayloadTool::TessdataEnglish,
            PayloadTool::Ghostscript,
            PayloadTool::Qpdf,
        ] {
            assert!(
                find_payload_tool(payload, tool, RuntimePlatform::Unix).is_some(),
                "missing {tool:?}"
            );
        }
    }

    #[test]
    fn missing_messages_are_platform_specific() {
        assert_eq!(
            expected_payload_path(PayloadTool::Ocrmypdf, RuntimePlatform::Windows),
            "ocr/ocrmypdf.cmd"
        );
        assert_eq!(
            expected_payload_path(PayloadTool::Ocrmypdf, RuntimePlatform::Unix),
            "ocr/ocrmypdf"
        );
    }
}
