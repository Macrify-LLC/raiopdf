//! Print-to-PDF canary: drive the real CUPS `lp` pipeline against a virtual
//! PDF printer and prove the WHOLE document comes out — no truncation.
//!
//! This exercises the same `#[cfg(unix)]` code the packaged app uses on macOS
//! (CUPS `lp`/`lpstat`), so it validates the print path end-to-end without a
//! physical printer or an interactive print panel.
//!
//! It is gated on `RAIOPDF_CUPS_CANARY` because it needs a provisioned virtual
//! printer (set up by the CI canary step); a normal `cargo test` run — which
//! has no such printer — skips it. Configuration comes from the environment:
//!   - `RAIOPDF_CUPS_CANARY`  — must be set to run at all.
//!   - `RAIOPDF_CUPS_PRINTER` — the CUPS queue name to print to.
//!   - `RAIOPDF_CUPS_OUTDIR`  — where the virtual printer deposits the produced
//!     PDF: cups-pdf's output dir on Linux, the `ippeveprinter` capture dir on
//!     macOS. When set, the produced PDF's page count is verified — proving the
//!     WHOLE document (and an exact mid-document page range) actually comes out.
//!     When unset, the run falls back to a submission-only check (`lpstat`
//!     parsing + `lp` accepting the jobs) for a backend that can't capture.
#![cfg(unix)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

use engine_sidecar_core::print_ops::{
    contiguous_segments, list_printers, lp_print, PrintOptions, PrintSelection,
};

/// A "very long" document, to prove the whole thing prints rather than a
/// mounted-pages subset.
const LONG_PDF_PAGES: usize = 300;
/// A mid-document contiguous range (1-based, inclusive).
const RANGE_FIRST: u32 = 50;
const RANGE_LAST: u32 = 59;

struct CanaryConfig {
    printer: String,
    /// When present, the virtual printer writes PDFs here and page counts are
    /// verified. Absent → submission-only (no print-to-file backend).
    out_dir: Option<PathBuf>,
}

fn canary_config() -> Option<CanaryConfig> {
    if std::env::var_os("RAIOPDF_CUPS_CANARY").is_none() {
        eprintln!("print_to_pdf: RAIOPDF_CUPS_CANARY unset — skipping (needs a virtual printer)");
        return None;
    }
    let printer = std::env::var("RAIOPDF_CUPS_PRINTER")
        .expect("RAIOPDF_CUPS_PRINTER must be set when RAIOPDF_CUPS_CANARY is");
    let out_dir = std::env::var_os("RAIOPDF_CUPS_OUTDIR").map(PathBuf::from);
    Some(CanaryConfig { printer, out_dir })
}

/// Emit a valid `pages`-page PDF (letter size, a line of text per page). Pure,
/// self-validating (the test asserts its own page count via qpdf before use).
fn synthesize_pdf(pages: usize) -> Vec<u8> {
    // Object numbering: 1 = catalog, 2 = pages tree, then per page i (0-based)
    // a page object (3 + 2i) and its content stream (4 + 2i).
    let object_count = 2 + 2 * pages;
    let mut offsets = vec![0usize; object_count];
    let mut buf: Vec<u8> = Vec::new();
    buf.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

    fn push_object(buf: &mut Vec<u8>, offsets: &mut [usize], number: usize, body: &str) {
        offsets[number - 1] = buf.len();
        buf.extend_from_slice(format!("{number} 0 obj\n{body}\nendobj\n").as_bytes());
    }

    push_object(
        &mut buf,
        &mut offsets,
        1,
        "<< /Type /Catalog /Pages 2 0 R >>",
    );
    let kids: Vec<String> = (0..pages).map(|i| format!("{} 0 R", 3 + 2 * i)).collect();
    push_object(
        &mut buf,
        &mut offsets,
        2,
        &format!(
            "<< /Type /Pages /Count {pages} /Kids [ {} ] >>",
            kids.join(" ")
        ),
    );
    for i in 0..pages {
        let page_number = 3 + 2 * i;
        let content_number = 4 + 2 * i;
        push_object(
            &mut buf,
            &mut offsets,
            page_number,
            &format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
                 /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> \
                 /Contents {content_number} 0 R >>"
            ),
        );
        let stream = format!("BT /F1 24 Tf 72 700 Td (Page {} of {pages}) Tj ET", i + 1);
        push_object(
            &mut buf,
            &mut offsets,
            content_number,
            &format!(
                "<< /Length {} >>\nstream\n{stream}\nendstream",
                stream.len()
            ),
        );
    }

    let xref_offset = buf.len();
    buf.extend_from_slice(format!("xref\n0 {}\n", object_count + 1).as_bytes());
    buf.extend_from_slice(b"0000000000 65535 f \n");
    for offset in &offsets {
        buf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    buf.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
            object_count + 1
        )
        .as_bytes(),
    );
    buf
}

/// Page count of a PDF via the bundled `qpdf` (present in the canary env).
fn pdf_page_count(path: &Path) -> usize {
    let output = Command::new("qpdf")
        .arg("--show-npages")
        .arg(path)
        .output()
        .expect("run qpdf --show-npages");
    assert!(
        output.status.success(),
        "qpdf failed on {}: {}",
        path.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .expect("qpdf page count")
}

fn remove_pdfs(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for path in entries.flatten().map(|e| e.path()) {
            if path.is_dir() {
                remove_pdfs(&path);
            } else if path.extension().and_then(|s| s.to_str()) == Some("pdf") {
                let _ = fs::remove_file(path);
            }
        }
    }
}

fn find_pdf(dir: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for path in entries.flatten().map(|e| e.path()) {
        if path.is_dir() {
            if let Some(found) = find_pdf(&path) {
                return Some(found);
            }
        } else if path.extension().and_then(|s| s.to_str()) == Some("pdf") {
            return Some(path);
        }
    }
    None
}

/// The virtual printer writes asynchronously; poll for the output PDF and wait
/// for its size to settle so qpdf reads a fully-written file.
fn await_output_pdf(dir: &Path) -> PathBuf {
    let deadline = Instant::now() + Duration::from_secs(90);
    let path = loop {
        if let Some(path) = find_pdf(dir) {
            break path;
        }
        assert!(
            Instant::now() < deadline,
            "no PDF appeared in {} within the timeout",
            dir.display()
        );
        sleep(Duration::from_millis(400));
    };
    let mut last_size = 0u64;
    let mut stable_reads = 0;
    while Instant::now() < deadline {
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if size > 0 && size == last_size {
            stable_reads += 1;
            if stable_reads >= 3 {
                return path;
            }
        } else {
            stable_reads = 0;
            last_size = size;
        }
        sleep(Duration::from_millis(300));
    }
    path
}

#[test]
fn prints_whole_long_document_and_page_range() {
    let Some(config) = canary_config() else {
        return;
    };

    // 1. `list_printers()` must parse real `lpstat` output and find our queue.
    let printers = list_printers().expect("list_printers");
    assert!(
        printers.iter().any(|p| p.name == config.printer),
        "configured printer {:?} not found in {:?}",
        config.printer,
        printers
    );

    // 2. A very long synthetic document, self-validated before printing.
    let pdf = synthesize_pdf(LONG_PDF_PAGES);
    let input = std::env::temp_dir().join(format!("rp-canary-input-{}.pdf", std::process::id()));
    fs::write(&input, &pdf).expect("write synthetic pdf");
    assert_eq!(
        pdf_page_count(&input),
        LONG_PDF_PAGES,
        "synthetic PDF generator sanity"
    );

    let range = PrintSelection::Segments(
        contiguous_segments(&((RANGE_FIRST - 1)..=(RANGE_LAST - 1)).collect::<Vec<_>>())
            .expect("range segments"),
    );

    match &config.out_dir {
        // Linux / cups-pdf: verify the produced PDF actually has every page.
        Some(dir) => {
            remove_pdfs(dir);
            lp_print(
                &input,
                &config.printer,
                &PrintSelection::WholeDocument,
                1,
                &PrintOptions::default(),
            )
            .expect("lp whole document");
            let whole = await_output_pdf(dir);
            assert_eq!(
                pdf_page_count(&whole),
                LONG_PDF_PAGES,
                "the WHOLE {LONG_PDF_PAGES}-page document must print, not a truncated subset"
            );

            remove_pdfs(dir);
            lp_print(&input, &config.printer, &range, 1, &PrintOptions::default())
                .expect("lp page range");
            let ranged = await_output_pdf(dir);
            assert_eq!(
                pdf_page_count(&ranged),
                (RANGE_LAST - RANGE_FIRST + 1) as usize,
                "page range {RANGE_FIRST}-{RANGE_LAST} must print exactly that many pages"
            );
        }
        // macOS: no print-to-file backend. Verify the macOS-specific surface —
        // `lp` accepts the whole-doc and range jobs against a real CUPS queue.
        None => {
            lp_print(
                &input,
                &config.printer,
                &PrintSelection::WholeDocument,
                1,
                &PrintOptions::default(),
            )
            .expect("lp must accept the whole-document job");
            lp_print(&input, &config.printer, &range, 1, &PrintOptions::default())
                .expect("lp must accept the page-range job");
        }
    }

    let _ = fs::remove_file(&input);
}
