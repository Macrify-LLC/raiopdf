//! Pure DOCX tracked-changes/comment scanner.
//!
//! This pre-pass intentionally fails closed: a file that is not a normal DOCX
//! ZIP, or that contains an unparseable inspected Word XML part, is
//! `Uninspectable` rather than clean.

use quick_xml::{events::Event, Reader};
use serde::Serialize;
use std::{
    fs::File,
    io::{Read, Seek},
    path::Path,
};
use zip::ZipArchive;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MarkupScan {
    Clean,
    HasMarkup,
    Uninspectable,
}

pub fn scan_docx_markup(path: &Path) -> MarkupScan {
    let Ok(file) = File::open(path) else {
        return MarkupScan::Uninspectable;
    };
    scan_docx_markup_reader(file)
}

fn scan_docx_markup_reader<R>(reader: R) -> MarkupScan
where
    R: Read + Seek,
{
    let Ok(mut archive) = ZipArchive::new(reader) else {
        return MarkupScan::Uninspectable;
    };

    let parts = inspected_word_parts(&mut archive);
    for part_name in parts {
        let mut xml = String::new();
        match archive.by_name(&part_name) {
            Ok(mut part) => {
                if part.read_to_string(&mut xml).is_err() {
                    return MarkupScan::Uninspectable;
                }
            }
            Err(_) => return MarkupScan::Uninspectable,
        }

        match scan_word_xml_part(&xml, is_comments_part(&part_name)) {
            PartScan::Clean => {}
            PartScan::HasMarkup => return MarkupScan::HasMarkup,
            PartScan::Uninspectable => return MarkupScan::Uninspectable,
        }
    }

    MarkupScan::Clean
}

fn inspected_word_parts<R>(archive: &mut ZipArchive<R>) -> Vec<String>
where
    R: Read + Seek,
{
    archive
        .file_names()
        .filter(|name| is_inspected_word_part(name))
        .map(ToOwned::to_owned)
        .collect()
}

fn is_inspected_word_part(name: &str) -> bool {
    if !name.starts_with("word/") || !name.ends_with(".xml") {
        return false;
    }
    matches!(
        name,
        "word/document.xml" | "word/footnotes.xml" | "word/endnotes.xml"
    ) || name.starts_with("word/header")
        || name.starts_with("word/footer")
        || is_comments_part(name)
}

fn is_comments_part(name: &str) -> bool {
    name == "word/comments.xml"
        || name.starts_with("word/comments")
        || name.starts_with("word/people")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PartScan {
    Clean,
    HasMarkup,
    Uninspectable,
}

fn scan_word_xml_part(xml: &str, comments_part: bool) -> PartScan {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut depth = 0_u32;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                depth = depth.saturating_add(1);
                if is_markup_element(element.name().as_ref(), comments_part) {
                    return PartScan::HasMarkup;
                }
            }
            Ok(Event::Empty(element)) => {
                if is_markup_element(element.name().as_ref(), comments_part) {
                    return PartScan::HasMarkup;
                }
            }
            Ok(Event::End(_)) => {
                let Some(next_depth) = depth.checked_sub(1) else {
                    return PartScan::Uninspectable;
                };
                depth = next_depth;
            }
            Ok(Event::Eof) => {
                return if depth == 0 {
                    PartScan::Clean
                } else {
                    PartScan::Uninspectable
                }
            }
            Err(_) => return PartScan::Uninspectable,
            _ => {}
        }
    }
}

fn is_markup_element(name: &[u8], comments_part: bool) -> bool {
    let local = local_name(name);
    matches!(
        local,
        b"ins"
            | b"del"
            | b"moveFrom"
            | b"moveTo"
            | b"commentReference"
            | b"commentRangeStart"
            | b"commentRangeEnd"
    ) || (comments_part && local == b"comment")
}

fn local_name(name: &[u8]) -> &[u8] {
    name.rsplit(|byte| *byte == b':').next().unwrap_or(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    #[test]
    fn clean_fixture_scans_clean() {
        assert_eq!(scan_docx_markup(&fixture("clean.docx")), MarkupScan::Clean);
    }

    #[test]
    fn tracked_changes_fixture_detects_revisions() {
        assert_eq!(
            scan_docx_markup(&fixture("tracked-changes.docx")),
            MarkupScan::HasMarkup
        );
    }

    #[test]
    fn comments_fixture_detects_comments() {
        assert_eq!(
            scan_docx_markup(&fixture("comments.docx")),
            MarkupScan::HasMarkup
        );
    }

    #[test]
    fn garbage_docx_fails_closed() {
        assert_eq!(
            scan_docx_markup(&fixture("not-a-zip.docx")),
            MarkupScan::Uninspectable
        );
    }

    #[test]
    fn malformed_inspected_xml_fails_closed() {
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>"#;
        assert_eq!(scan_word_xml_part(xml, false), PartScan::Uninspectable);
    }

    #[test]
    fn textbox_markup_is_seen_by_structural_scan() {
        let xml = r#"
            <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
              <w:body>
                <w:pict><w:txbxContent><w:p><w:r><w:ins><w:t>new</w:t></w:ins></w:r></w:p></w:txbxContent></w:pict>
              </w:body>
            </w:document>
        "#;
        assert_eq!(scan_word_xml_part(xml, false), PartScan::HasMarkup);
    }
}
