//! Per-job Windows paper/source selection and GDI raster printing.
//!
//! The legacy `mswinpr2` route remains responsible for jobs without custom
//! paper/source choices. This module uses a job-local DEVMODE and never
//! changes the printer's saved defaults. Ghostscript renders one PDF page at
//! a time; GDI submits those bitmaps under the single configured job.

use crate::{
    path_ops::{self, OpResult, PathOpError, PathOpsToolchain},
    print_ops::{self, PrintOptionChoice, PrintOptions, PrintSelection, PrinterCapabilities},
};
use std::{
    ffi::OsString,
    fs,
    fs::{File, OpenOptions},
    io::{Read, Write},
    mem::{align_of, offset_of, size_of},
    path::{Path, PathBuf},
    ptr,
    sync::atomic::AtomicU64,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use windows_sys::Win32::{
    Foundation::{GetLastError, POINT},
    Graphics::Gdi::{
        CreateDCW, DeleteDC, GetDeviceCaps, SetBrushOrgEx, SetStretchBltMode, StretchDIBits,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DEVMODEW, DIB_RGB_COLORS, DMPAPER_USER, DM_COPIES,
        DM_DEFAULTSOURCE, DM_FORMNAME, DM_IN_BUFFER, DM_OUT_BUFFER, DM_PAPERLENGTH, DM_PAPERSIZE,
        DM_PAPERWIDTH, HALFTONE, HDC, HORZRES, LOGPIXELSX, LOGPIXELSY, PHYSICALHEIGHT,
        PHYSICALOFFSETX, PHYSICALOFFSETY, PHYSICALWIDTH, SRCCOPY, VERTRES,
    },
    Graphics::Printing::{
        ClosePrinter, DocumentPropertiesW, GetPrinterW, OpenPrinterW, PRINTER_HANDLE,
        PRINTER_INFO_2W,
    },
    Storage::Xps::{
        AbortDoc, DeviceCapabilitiesW, EndDoc, EndPage, SetAbortProc, StartDocW, StartPage,
        DC_BINNAMES, DC_BINS, DC_FIELDS, DC_PAPERNAMES, DC_PAPERS, DC_PAPERSIZE, DOCINFOW,
    },
};

const MAX_DEVMODE_BYTES: usize = 1024 * 1024;
const MAX_CAPABILITY_ENTRIES: usize = 512;
const MAX_BITMAP_BYTES: u64 = 256 * 1024 * 1024;
const RASTER_DPI: u32 = 300;
const RASTER_FLOOR_DPI: u32 = 150;
const MAX_SOURCE_DPI: f64 = 1_000_000.0;
const PRINT_CANCELLED: &str = print_ops::ERR_PRINT_CANCELLED;
const PRINT_PARTIAL_CANCELLED: &str = "PRINT_PARTIAL_CANCELLED";
const PRINT_FAILED: &str = print_ops::ERR_PRINT_FAILED;
static SNAPSHOT_COUNTER: AtomicU64 = AtomicU64::new(1);

struct InputSnapshot(PathBuf);

impl InputSnapshot {
    fn create(input: &Path, work_dir: &Path, cancel_flag: &Arc<AtomicBool>) -> OpResult<Self> {
        let mut source = File::open(input)
            .map_err(|error| PathOpError::io("open input for stable print snapshot", error))?;
        let before = source
            .metadata()
            .map_err(|error| PathOpError::io("inspect input for print snapshot", error))?;
        if !before.is_file() {
            return Err(PathOpError::invalid(
                "the print input is not a regular file",
            ));
        }
        let path = work_dir.join(format!(
            "custom-print-input-{}-{}.pdf",
            std::process::id(),
            SNAPSHOT_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let mut destination = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| PathOpError::io("create private Windows print snapshot", error))?;
        let result = (|| {
            let mut copied = 0u64;
            let mut buffer = [0u8; 64 * 1024];
            loop {
                if cancel_flag.load(Ordering::Relaxed) {
                    return Err(cancelled());
                }
                let read = source
                    .read(&mut buffer)
                    .map_err(|error| PathOpError::io("read input print snapshot", error))?;
                if read == 0 {
                    break;
                }
                copied = copied
                    .checked_add(read as u64)
                    .ok_or_else(|| PathOpError::invalid("print snapshot size overflow"))?;
                if copied > before.len() {
                    return Err(PathOpError::invalid(
                        "input changed while the Windows print snapshot was being created",
                    ));
                }
                destination
                    .write_all(&buffer[..read])
                    .map_err(|error| PathOpError::io("write private print snapshot", error))?;
            }
            let after = source
                .metadata()
                .map_err(|error| PathOpError::io("recheck input print snapshot", error))?;
            if copied != before.len()
                || after.len() != before.len()
                || before.modified().ok() != after.modified().ok()
            {
                return Err(PathOpError::failed(
                    "input changed while the Windows print snapshot was being created",
                ));
            }
            destination
                .flush()
                .map_err(|error| PathOpError::io("flush private print snapshot", error))?;
            Ok(())
        })();
        drop(destination);
        if let Err(error) = result {
            let _ = fs::remove_file(&path);
            return Err(error);
        }
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for InputSnapshot {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PaperCapability {
    id: u16,
    width_tenth_mm: i32,
    height_tenth_mm: i32,
    form_name: String,
    choice: PrintOptionChoice,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrintWindowsOutcome {
    /// Count of pages submitted to GDI. This confirms local submission only,
    /// not that a physical printer finished feeding the pages.
    pub pages_rendered: u32,
}

pub fn printer_capabilities(printer: &str) -> OpResult<PrinterCapabilities> {
    print_ops::validate_printer_name(printer)?;
    let (media, paper_sources) = query_capabilities(printer)?;
    Ok(PrinterCapabilities {
        media: media.into_iter().map(|paper| paper.choice).collect(),
        paper_sources,
    })
}

fn query_capabilities(printer: &str) -> OpResult<(Vec<PaperCapability>, Vec<PrintOptionChoice>)> {
    let printer_handle = Printer::open(printer)?;
    let default = default_devmode(printer_handle.0, printer)?;
    let mode = default.devmode_ptr();
    let port_name = printer_port(printer_handle.0)?;
    let port = port_name.as_ptr();
    let fields = capability_fields(printer, port, mode)?;
    let (query_media, query_sources) = capability_query_flags(fields);
    let media = if query_media {
        let paper_ids = capability_words(printer, port, DC_PAPERS, mode)?;
        let paper_sizes = capability_sizes(printer, port, mode)?;
        let paper_names = capability_names(printer, port, DC_PAPERNAMES, 64, mode)?;
        filter_media_capabilities(fields, &paper_ids, &paper_sizes, &paper_names)?
    } else {
        Vec::new()
    };

    let paper_sources = if query_sources {
        let bin_ids = capability_words(printer, port, DC_BINS, mode)?;
        let bin_names = capability_names(printer, port, DC_BINNAMES, 24, mode)?;
        filter_source_capabilities(&bin_ids, &bin_names)?
    } else {
        Vec::new()
    };
    Ok((media, paper_sources))
}

fn capability_query_flags(fields: u32) -> (bool, bool) {
    (fields & DM_PAPERSIZE != 0, fields & DM_DEFAULTSOURCE != 0)
}

fn filter_media_capabilities(
    fields: u32,
    ids: &[u16],
    sizes: &[POINT],
    names: &[String],
) -> OpResult<Vec<PaperCapability>> {
    if fields & DM_PAPERSIZE == 0 {
        return Ok(Vec::new());
    }
    if ids.len() != sizes.len() || ids.len() != names.len() {
        return Err(PathOpError::failed(
            "printer returned mismatched paper names, sizes, and identifiers",
        ));
    }
    Ok(ids
        .iter()
        .copied()
        .zip(sizes.iter().copied())
        .zip(names.iter())
        .filter_map(|((id, size), name)| {
            if id == 0
                || id > i16::MAX as u16
                || size.x <= 0
                || size.y <= 0
                || paper_ids_duplicate(ids, id)
            {
                return None;
            }
            if id >= DMPAPER_USER as u16
                && (fields & (DM_PAPERWIDTH | DM_PAPERLENGTH | DM_FORMNAME)
                    != (DM_PAPERWIDTH | DM_PAPERLENGTH | DM_FORMNAME)
                    || size.x > i16::MAX as i32
                    || size.y > i16::MAX as i32
                    || name.is_empty()
                    || name.encode_utf16().count() >= 32)
            {
                return None;
            }
            let label = if name.is_empty() {
                format!("Paper {id}")
            } else {
                name.clone()
            };
            Some(PaperCapability {
                id,
                width_tenth_mm: size.x,
                height_tenth_mm: size.y,
                form_name: name.clone(),
                choice: PrintOptionChoice {
                    value: format!("DMPAPER:{id}"),
                    label,
                },
            })
        })
        .collect())
}

fn filter_source_capabilities(ids: &[u16], names: &[String]) -> OpResult<Vec<PrintOptionChoice>> {
    if ids.len() != names.len() {
        return Err(PathOpError::failed(
            "printer returned mismatched paper source names and identifiers",
        ));
    }
    Ok(ids
        .iter()
        .copied()
        .zip(names.iter())
        .filter(|(bin_id, _)| {
            *bin_id > 0 && *bin_id <= i16::MAX as u16 && !paper_source_id_duplicate(ids, *bin_id)
        })
        .map(|(bin_id, name)| PrintOptionChoice {
            value: format!("DMBIN:{bin_id}"),
            label: if name.is_empty() {
                format!("Paper source {bin_id}")
            } else {
                name.clone()
            },
        })
        .collect())
}

#[allow(clippy::too_many_arguments)]
pub fn print_with_options(
    toolchain: &PathOpsToolchain,
    input: &Path,
    printer: &str,
    selection: &PrintSelection,
    copies: u32,
    options: &PrintOptions,
    work_dir: &Path,
    cancel_flag: &Arc<AtomicBool>,
) -> OpResult<PrintWindowsOutcome> {
    print_with_options_output(
        toolchain,
        input,
        printer,
        selection,
        copies,
        options,
        work_dir,
        cancel_flag,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn print_with_options_output(
    toolchain: &PathOpsToolchain,
    input: &Path,
    printer: &str,
    selection: &PrintSelection,
    copies: u32,
    options: &PrintOptions,
    work_dir: &Path,
    cancel_flag: &Arc<AtomicBool>,
    output_path: Option<&Path>,
) -> OpResult<PrintWindowsOutcome> {
    print_ops::validate_copies(copies)?;
    print_ops::validate_print_options(options)?;
    if options.media.is_none() && options.paper_source.is_none() {
        return Err(PathOpError::invalid(
            "the Windows per-job printer path requires a paper size or paper source",
        ));
    }
    if options.sides.is_some() || options.orientation.is_some() {
        return Err(PathOpError::invalid(
            "Windows custom printing currently supports paper size and paper source only",
        ));
    }
    if !work_dir.is_dir() {
        return Err(PathOpError::io(
            "print work directory is unavailable",
            std::io::Error::new(std::io::ErrorKind::NotFound, "work directory missing"),
        ));
    }
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(cancelled());
    }

    let _ = path_ops::require_input_file(input)?;
    let snapshot = InputSnapshot::create(input, work_dir, cancel_flag)?;
    let job_id = SNAPSHOT_COUNTER.fetch_add(1, Ordering::Relaxed);
    let input = snapshot.path();
    let (media_capabilities, paper_sources) = query_capabilities(printer)?;
    let capabilities = PrinterCapabilities {
        media: media_capabilities
            .iter()
            .map(|paper| paper.choice.clone())
            .collect(),
        paper_sources,
    };
    let paper = selected_paper(options.media.as_deref(), &media_capabilities, &capabilities)?;
    let source_id = selected_source_id(options.paper_source.as_deref(), &capabilities)?;
    let printer_handle = Printer::open(printer)?;
    let default_mode = default_devmode(printer_handle.0, printer)?;
    let port_name = printer_port(printer_handle.0)?;
    let fields = capability_fields(printer, port_name.as_ptr(), default_mode.devmode_ptr())?;
    if paper.is_some() && fields & DM_PAPERSIZE == 0 {
        return Err(PathOpError::invalid(
            "printer does not support per-job paper size selection",
        ));
    }
    if paper
        .as_ref()
        .is_some_and(|paper| paper.id >= DMPAPER_USER as u16)
        && [DM_PAPERWIDTH, DM_PAPERLENGTH, DM_FORMNAME]
            .into_iter()
            .any(|field| fields & field == 0)
    {
        return Err(PathOpError::invalid(
            "printer does not support the selected custom paper form",
        ));
    }
    if source_id.is_some() && fields & DM_DEFAULTSOURCE == 0 {
        return Err(PathOpError::invalid(
            "printer does not support per-job paper source selection",
        ));
    }
    let facts = path_ops::document_facts_print_bounded(toolchain, input, cancel_flag)
        .map_err(translate_path_cancel)?;
    let pages = selected_pages(selection, &facts.pages, facts.page_count)?;

    let mode = configured_devmode(
        printer_handle.0,
        printer,
        paper.as_ref(),
        source_id,
        fields & DM_COPIES != 0,
    )?;
    let dc = DeviceContext::create(printer, mode.devmode_ptr())?;
    if let Some(paper) = paper.as_ref() {
        validate_device_paper_size(dc.0, paper)?;
    }
    let printable = printable_area(dc.0)?;
    let effective_dpi_cap = RASTER_DPI.min(printable.2).min(printable.3);
    if effective_dpi_cap < RASTER_FLOOR_DPI {
        return Err(PathOpError::invalid(
            "printer resolution is below the supported 150 dpi minimum",
        ));
    }
    let plans = choose_raster_plans(&pages, printable, effective_dpi_cap)?;

    // The first selected page is rasterized and validated before StartDoc so
    // malformed geometry or a missing Ghostscript bitmap never queues a job.
    let first = pages
        .first()
        .ok_or_else(|| PathOpError::invalid("no pages selected"))?;
    let first_bitmap_path = page_bitmap_path(work_dir, job_id, first.index + 1);
    render_page(
        toolchain,
        input,
        first.index + 1,
        plans[0].dpi,
        &first_bitmap_path,
        cancel_flag,
    )?;
    let first_bitmap = read_bitmap(&first_bitmap_path, plans[0].dpi, first)?;
    let first_fit = fit_rect(
        page_dimensions_points(first),
        printable.0,
        printable.1,
        printable.2,
        printable.3,
    )?;
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(cancelled());
    }

    let mut first_bitmap = Some(first_bitmap);
    let mut jobs_started = 0u32;
    if output_path.is_some() && !is_verified_print_to_pdf(printer_handle.0)? {
        return Err(PathOpError::invalid(
            "file output is restricted to the verified Microsoft Print to PDF driver",
        ));
    }
    let mut starter = GdiPrintStarter(dc.0);
    let result = execute_copies(copies, cancel_flag, |copy_index| {
        let output = output_path.map(|path| copy_output_path(path, copy_index));
        execute_copy(
            &mut starter,
            &pages,
            &plans,
            cancel_flag,
            output.as_deref(),
            |page, plan| {
                if let Some(bitmap) = first_bitmap.take() {
                    Ok((bitmap, first_fit))
                } else {
                    let path = page_bitmap_path(work_dir, job_id, page.index + 1);
                    render_page(
                        toolchain,
                        input,
                        page.index + 1,
                        plan.dpi,
                        &path,
                        cancel_flag,
                    )?;
                    let bitmap = read_bitmap(&path, plan.dpi, page)?;
                    let fit = fit_rect(
                        page_dimensions_points(page),
                        printable.0,
                        printable.1,
                        printable.2,
                        printable.3,
                    )?;
                    Ok((bitmap, fit))
                }
            },
            || jobs_started = jobs_started.saturating_add(1),
        )
    });
    let pages_rendered = match result {
        Ok(pages_rendered) => pages_rendered,
        Err(error) => return Err(classify_native_job_error(error, jobs_started, cancel_flag)),
    };
    Ok(PrintWindowsOutcome { pages_rendered })
}

fn copy_output_path(base: &Path, copy_index: u32) -> PathBuf {
    if copy_index == 0 {
        return base.to_path_buf();
    }
    let stem = base.file_stem().unwrap_or_default().to_string_lossy();
    let extension = base.extension().map(|value| value.to_string_lossy());
    let name = match extension {
        Some(extension) => format!("{stem}-copy-{}.{}", copy_index + 1, extension),
        None => format!("{stem}-copy-{}", copy_index + 1),
    };
    base.with_file_name(name)
}

trait PrintDocumentLifecycle {
    fn start_page(&mut self) -> OpResult<()>;
    fn draw(&mut self, bitmap: &Bitmap, fit: FitRect) -> OpResult<()>;
    fn end_page(&mut self) -> OpResult<()>;
    fn finish(&mut self) -> OpResult<()>;
}

trait PrintJobStarter {
    type Document: PrintDocumentLifecycle;

    fn start_document(
        &mut self,
        cancel_flag: &AtomicBool,
        output_path: Option<&Path>,
    ) -> OpResult<Self::Document>;
}

struct GdiPrintStarter(HDC);

impl PrintJobStarter for GdiPrintStarter {
    type Document = PrintDocument;

    fn start_document(
        &mut self,
        cancel_flag: &AtomicBool,
        output_path: Option<&Path>,
    ) -> OpResult<Self::Document> {
        PrintDocument::start(self.0, cancel_flag, output_path)
    }
}

fn execute_copies(
    copies: u32,
    cancel_flag: &AtomicBool,
    mut submit: impl FnMut(u32) -> OpResult<u32>,
) -> OpResult<u32> {
    let mut pages_submitted = 0u32;
    for copy_index in 0..copies {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        pages_submitted = pages_submitted.saturating_add(submit(copy_index)?);
    }
    Ok(pages_submitted)
}

fn execute_copy<S, R>(
    starter: &mut S,
    pages: &[SelectedPage],
    plans: &[RasterPlan],
    cancel_flag: &AtomicBool,
    output_path: Option<&Path>,
    mut render: R,
    mut job_started: impl FnMut(),
) -> OpResult<u32>
where
    S: PrintJobStarter,
    R: FnMut(&SelectedPage, &RasterPlan) -> OpResult<(Bitmap, FitRect)>,
{
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(cancelled());
    }
    let mut document = starter.start_document(cancel_flag, output_path)?;
    job_started();
    let mut submitted = 0u32;
    for (page, plan) in pages.iter().zip(plans) {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        let (bitmap, fit) = render(page, plan)?;
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        document.start_page()?;
        document.draw(&bitmap, fit)?;
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        document.end_page()?;
        submitted = submitted.saturating_add(1);
    }
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(cancelled());
    }
    document.finish()?;
    Ok(submitted)
}

fn selected_paper(
    media: Option<&str>,
    papers: &[PaperCapability],
    caps: &PrinterCapabilities,
) -> OpResult<Option<PaperCapability>> {
    let Some(media) = media else { return Ok(None) };
    if !caps.media.iter().any(|choice| choice.value == media) {
        return Err(PathOpError::invalid(
            "printer does not support the requested paper size",
        ));
    }
    papers
        .iter()
        .find(|paper| paper.choice.value == media)
        .cloned()
        .map(Some)
        .ok_or_else(|| PathOpError::failed("printer paper capabilities changed during the job"))
}

fn paper_ids_duplicate(ids: &[u16], value: u16) -> bool {
    ids.iter().filter(|candidate| **candidate == value).count() > 1
}

fn paper_source_id_duplicate(ids: &[u16], value: u16) -> bool {
    ids.iter().filter(|candidate| **candidate == value).count() > 1
}

fn devmode_form_name(mode: &DEVMODEW) -> String {
    let end = mode
        .dmFormName
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(32);
    String::from_utf16_lossy(&mode.dmFormName[..end])
}

fn selected_source_id(source: Option<&str>, caps: &PrinterCapabilities) -> OpResult<Option<u16>> {
    let Some(source) = source else {
        return Ok(None);
    };
    let choice = caps
        .paper_sources
        .iter()
        .find(|choice| choice.value == source)
        .ok_or_else(|| {
            PathOpError::invalid("the requested paper source is not available on this printer")
        })?;
    let parsed = parse_prefixed_id(&choice.value, "DMBIN:")?;
    if parsed > i16::MAX as u16 {
        return Err(PathOpError::invalid("invalid paper source selection"));
    }
    Ok(Some(parsed))
}

fn parse_prefixed_id(value: &str, prefix: &str) -> OpResult<u16> {
    value
        .strip_prefix(prefix)
        .ok_or_else(|| PathOpError::invalid("invalid Windows printer option token"))?
        .parse::<u16>()
        .map_err(|_| PathOpError::invalid("invalid Windows printer option token"))
}

struct Printer(PRINTER_HANDLE);

impl Printer {
    fn open(name: &str) -> OpResult<Self> {
        let name_w = wide(name);
        let mut handle = PRINTER_HANDLE {
            Value: ptr::null_mut(),
        };
        let opened = unsafe { OpenPrinterW(name_w.as_ptr(), &mut handle, ptr::null()) };
        if opened == 0 || handle.Value.is_null() {
            return Err(win_error("open printer"));
        }
        Ok(Self(handle))
    }
}

fn printer_port(handle: PRINTER_HANDLE) -> OpResult<Vec<u16>> {
    let (storage, returned) = printer_info_buffer(handle)?;
    let buffer = storage.as_ptr().cast::<u8>();
    let info = unsafe { &*buffer.cast::<PRINTER_INFO_2W>() };
    copy_printer_info_string(buffer, returned, info.pPortName, "port name")
}

fn printer_driver_name(handle: PRINTER_HANDLE) -> OpResult<String> {
    let (storage, returned) = printer_info_buffer(handle)?;
    let buffer = storage.as_ptr().cast::<u8>();
    let info = unsafe { &*buffer.cast::<PRINTER_INFO_2W>() };
    let units = copy_printer_info_string(buffer, returned, info.pDriverName, "driver name")?;
    let end = units
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(units.len());
    Ok(String::from_utf16_lossy(&units[..end]))
}

fn is_verified_print_to_pdf(handle: PRINTER_HANDLE) -> OpResult<bool> {
    Ok(printer_driver_name(handle)?.eq_ignore_ascii_case("Microsoft Print To PDF"))
}

fn printer_info_buffer(handle: PRINTER_HANDLE) -> OpResult<(Vec<usize>, u32)> {
    let mut needed = 0u32;
    unsafe { GetPrinterW(handle, 2, ptr::null_mut(), 0, &mut needed) };
    if needed < size_of::<PRINTER_INFO_2W>() as u32 || needed > 1024 * 1024 {
        return Err(PathOpError::failed(
            "printer returned invalid port metadata",
        ));
    }
    let words = (needed as usize).div_ceil(size_of::<usize>());
    let mut storage = vec![0usize; words];
    let buffer = storage.as_mut_ptr().cast::<u8>();
    let mut returned = 0u32;
    if unsafe { GetPrinterW(handle, 2, buffer, needed, &mut returned) } == 0
        || returned < size_of::<PRINTER_INFO_2W>() as u32
        || returned > needed
    {
        return Err(win_error("read printer port metadata"));
    }
    Ok((storage, returned))
}

fn copy_printer_info_string(
    buffer: *const u8,
    returned: u32,
    value: *const u16,
    description: &str,
) -> OpResult<Vec<u16>> {
    if value.is_null() {
        return Err(PathOpError::failed(format!(
            "printer has no reported {description}"
        )));
    }
    let base = buffer as usize;
    let end = base
        .checked_add(returned as usize)
        .ok_or_else(|| PathOpError::failed("printer metadata bounds overflow"))?;
    let address = value as usize;
    if address < base || address >= end || !(address - base).is_multiple_of(size_of::<u16>()) {
        return Err(PathOpError::failed(format!(
            "printer returned an invalid {description}"
        )));
    }
    let max_units = (end - address) / size_of::<u16>();
    let units = unsafe { std::slice::from_raw_parts(value, max_units) };
    let terminator = units
        .iter()
        .position(|unit| *unit == 0)
        .ok_or_else(|| PathOpError::failed(format!("printer {description} was not terminated")))?;
    if terminator == 0 {
        return Err(PathOpError::failed(format!(
            "printer returned an empty {description}"
        )));
    }
    Ok(units[..=terminator].to_vec())
}

impl Drop for Printer {
    fn drop(&mut self) {
        if !self.0.Value.is_null() {
            unsafe { ClosePrinter(self.0) };
        }
    }
}

struct DeviceContext(HDC);

impl DeviceContext {
    fn create(name: &str, mode: *const DEVMODEW) -> OpResult<Self> {
        let name_w = wide(name);
        let dc = unsafe { CreateDCW(ptr::null(), name_w.as_ptr(), ptr::null(), mode) };
        if dc.is_null() {
            return Err(win_error("create printer device context"));
        }
        Ok(Self(dc))
    }
}

impl Drop for DeviceContext {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { DeleteDC(self.0) };
        }
    }
}

struct PrintDocument {
    dc: HDC,
    active: bool,
    page_active: bool,
    _abort_context: AbortContext,
}

thread_local! {
    static ACTIVE_ABORT_FLAG: std::cell::Cell<*const AtomicBool> = const {
        std::cell::Cell::new(ptr::null())
    };
}

struct AbortContext(*const AtomicBool);

impl AbortContext {
    fn install(flag: &AtomicBool) -> Self {
        let previous = ACTIVE_ABORT_FLAG.with(|cell| cell.replace(flag as *const AtomicBool));
        Self(previous)
    }
}

impl Drop for AbortContext {
    fn drop(&mut self) {
        ACTIVE_ABORT_FLAG.with(|cell| cell.set(self.0));
    }
}

unsafe extern "system" fn abort_proc(_dc: HDC, _error: i32) -> i32 {
    ACTIVE_ABORT_FLAG.with(|cell| {
        let flag = cell.get();
        if flag.is_null() {
            1
        } else if unsafe { (*flag).load(Ordering::Relaxed) } {
            0
        } else {
            1
        }
    })
}

impl PrintDocument {
    fn start(dc: HDC, cancel_flag: &AtomicBool, output_path: Option<&Path>) -> OpResult<Self> {
        let abort_context = AbortContext::install(cancel_flag);
        if unsafe { SetAbortProc(dc, Some(abort_proc)) } <= 0 {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err(cancelled());
            }
            return Err(win_error("configure print cancellation"));
        }
        let name = wide("RaioPDF print job");
        let output = output_path.map(|path| wide(&path.to_string_lossy()));
        let info = DOCINFOW {
            cbSize: size_of::<DOCINFOW>() as i32,
            lpszDocName: name.as_ptr(),
            lpszOutput: output.as_ref().map_or(ptr::null(), |value| value.as_ptr()),
            lpszDatatype: ptr::null(),
            fwType: 0,
        };
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        if unsafe { StartDocW(dc, &info) } <= 0 {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err(cancelled());
            }
            return Err(win_error("start printer job"));
        }
        Ok(Self {
            dc,
            active: true,
            page_active: false,
            _abort_context: abort_context,
        })
    }

    fn start_page(&mut self) -> OpResult<()> {
        if unsafe { StartPage(self.dc) } <= 0 {
            return Err(win_error("start printer page"));
        }
        self.page_active = true;
        Ok(())
    }

    fn end_page(&mut self) -> OpResult<()> {
        if unsafe { EndPage(self.dc) } <= 0 {
            return Err(win_error("finish printer page"));
        }
        self.page_active = false;
        Ok(())
    }

    fn finish(&mut self) -> OpResult<()> {
        if ACTIVE_ABORT_FLAG.with(|cell| {
            let flag = cell.get();
            !flag.is_null() && unsafe { (*flag).load(Ordering::Relaxed) }
        }) {
            return Err(cancelled());
        }
        if unsafe { EndDoc(self.dc) } <= 0 {
            return Err(win_error("finish printer job"));
        }
        self.active = false;
        Ok(())
    }
}

impl PrintDocumentLifecycle for PrintDocument {
    fn start_page(&mut self) -> OpResult<()> {
        PrintDocument::start_page(self)
    }

    fn draw(&mut self, bitmap: &Bitmap, fit: FitRect) -> OpResult<()> {
        draw_bitmap(self.dc, bitmap, fit)
    }

    fn end_page(&mut self) -> OpResult<()> {
        PrintDocument::end_page(self)
    }

    fn finish(&mut self) -> OpResult<()> {
        PrintDocument::finish(self)
    }
}

impl Drop for PrintDocument {
    fn drop(&mut self) {
        if self.active {
            unsafe { AbortDoc(self.dc) };
        }
    }
}

struct DevModeBuffer {
    storage: Vec<usize>,
    byte_len: usize,
}

impl DevModeBuffer {
    fn new(byte_len: usize) -> OpResult<Self> {
        let min = size_of::<DEVMODEW>();
        if byte_len < min
            || byte_len > MAX_DEVMODE_BYTES
            || align_of::<usize>() < align_of::<DEVMODEW>()
        {
            return Err(PathOpError::failed(
                "printer returned an invalid DEVMODE size",
            ));
        }
        let words = byte_len
            .checked_add(size_of::<usize>() - 1)
            .ok_or_else(|| PathOpError::failed("printer DEVMODE size overflow"))?
            / size_of::<usize>();
        Ok(Self {
            storage: vec![0; words],
            byte_len,
        })
    }

    fn devmode_ptr(&self) -> *const DEVMODEW {
        self.storage.as_ptr().cast()
    }

    fn devmode_mut_ptr(&mut self) -> *mut DEVMODEW {
        self.storage.as_mut_ptr().cast()
    }

    fn clone_bytes(&self) -> Vec<usize> {
        self.storage.clone()
    }
}

fn settings_rejected(message: &str) -> PathOpError {
    PathOpError {
        code: PRINT_FAILED,
        message: format!("{message}. Choose different printer settings and try again."),
    }
}

fn configured_devmode(
    handle: PRINTER_HANDLE,
    printer: &str,
    paper: Option<&PaperCapability>,
    source_id: Option<u16>,
    copies_supported: bool,
) -> OpResult<DevModeBuffer> {
    let name = wide(printer);
    let default = default_devmode(handle, printer)?;

    let mut input = DevModeBuffer {
        storage: default.clone_bytes(),
        byte_len: default.byte_len,
    };
    unsafe {
        apply_devmode_selection(
            &mut *input.devmode_mut_ptr(),
            paper,
            source_id,
            copies_supported,
        )
    };
    let mut output = DevModeBuffer::new(default.byte_len)?;
    if unsafe {
        DocumentPropertiesW(
            ptr::null_mut(),
            handle,
            name.as_ptr(),
            output.devmode_mut_ptr(),
            input.devmode_ptr(),
            DM_IN_BUFFER | DM_OUT_BUFFER,
        )
    } != 1
    {
        return Err(settings_rejected(
            "printer rejected the requested per-job settings",
        ));
    }
    validate_devmode_bounds(&output)?;
    unsafe {
        let mode = &*output.devmode_ptr();
        let public = mode.Anonymous1.Anonymous1;
        if !normalized_single_copy_is_valid(mode.dmFields, public.dmCopies, copies_supported) {
            return Err(settings_rejected(
                "printer did not preserve the single-copy per-job mode",
            ));
        }
        if let Some(paper) = paper {
            if mode.dmFields & DM_PAPERSIZE == 0 || public.dmPaperSize != paper.id as i16 {
                return Err(settings_rejected(
                    "printer did not preserve the requested paper size",
                ));
            }
            if paper.id >= DMPAPER_USER as u16
                && (mode.dmFields & (DM_PAPERWIDTH | DM_PAPERLENGTH)
                    != (DM_PAPERWIDTH | DM_PAPERLENGTH)
                    || public.dmPaperWidth != paper.width_tenth_mm as i16
                    || public.dmPaperLength != paper.height_tenth_mm as i16)
            {
                return Err(settings_rejected(
                    "printer did not preserve the requested custom paper dimensions",
                ));
            }
            if paper.id >= DMPAPER_USER as u16
                && (mode.dmFields & DM_FORMNAME == 0 || devmode_form_name(mode) != paper.form_name)
            {
                return Err(settings_rejected(
                    "printer did not preserve the selected custom paper form",
                ));
            }
        }
        if source_id.is_some_and(|id| {
            mode.dmFields & DM_DEFAULTSOURCE == 0 || public.dmDefaultSource != id as i16
        }) {
            return Err(settings_rejected(
                "printer did not preserve the requested paper source",
            ));
        }
    }
    Ok(output)
}

fn apply_devmode_selection(
    mode: &mut DEVMODEW,
    paper: Option<&PaperCapability>,
    source_id: Option<u16>,
    copies_supported: bool,
) {
    if copies_supported {
        mode.dmFields |= DM_COPIES;
        mode.Anonymous1.Anonymous1.dmCopies = 1;
    } else {
        mode.dmFields &= !DM_COPIES;
    }
    if let Some(paper) = paper {
        mode.dmFields |= DM_PAPERSIZE;
        mode.Anonymous1.Anonymous1.dmPaperSize = paper.id as i16;
        if paper.id >= DMPAPER_USER as u16 {
            mode.dmFields |= DM_PAPERWIDTH | DM_PAPERLENGTH;
            mode.Anonymous1.Anonymous1.dmPaperWidth = paper.width_tenth_mm as i16;
            mode.Anonymous1.Anonymous1.dmPaperLength = paper.height_tenth_mm as i16;
            mode.dmFields |= DM_FORMNAME;
            mode.dmFormName = [0; 32];
            let units = paper.form_name.encode_utf16().collect::<Vec<_>>();
            mode.dmFormName[..units.len()].copy_from_slice(&units);
        } else {
            mode.dmFields &= !(DM_PAPERWIDTH | DM_PAPERLENGTH | DM_FORMNAME);
            mode.Anonymous1.Anonymous1.dmPaperWidth = 0;
            mode.Anonymous1.Anonymous1.dmPaperLength = 0;
            mode.dmFormName = [0; 32];
        }
    }
    if let Some(source_id) = source_id {
        mode.dmFields |= DM_DEFAULTSOURCE;
        mode.Anonymous1.Anonymous1.dmDefaultSource = source_id as i16;
    }
}

fn normalized_single_copy_is_valid(fields: u32, copies: i16, copies_supported: bool) -> bool {
    if fields & DM_COPIES != 0 {
        copies == 1
    } else {
        !copies_supported
    }
}

fn default_devmode(handle: PRINTER_HANDLE, printer: &str) -> OpResult<DevModeBuffer> {
    let name = wide(printer);
    let needed = unsafe {
        DocumentPropertiesW(
            ptr::null_mut(),
            handle,
            name.as_ptr(),
            ptr::null_mut(),
            ptr::null(),
            0,
        )
    };
    if needed <= 0 || needed as usize > MAX_DEVMODE_BYTES {
        return Err(PathOpError::failed(
            "printer returned an invalid DEVMODE size",
        ));
    }
    let mut default = DevModeBuffer::new(needed as usize)?;
    if unsafe {
        DocumentPropertiesW(
            ptr::null_mut(),
            handle,
            name.as_ptr(),
            default.devmode_mut_ptr(),
            ptr::null(),
            DM_OUT_BUFFER,
        )
    } != 1
    {
        return Err(win_error("read printer defaults"));
    }
    validate_devmode_bounds(&default)?;
    Ok(default)
}

fn validate_devmode_bounds(buffer: &DevModeBuffer) -> OpResult<()> {
    let public = raw_devmode_u16(buffer, offset_of!(DEVMODEW, dmSize))? as usize;
    let private = raw_devmode_u16(buffer, offset_of!(DEVMODEW, dmDriverExtra))? as usize;
    validate_devmode_lengths(public, private, buffer.byte_len)
}

fn raw_devmode_u16(buffer: &DevModeBuffer, offset: usize) -> OpResult<u16> {
    let end = offset
        .checked_add(size_of::<u16>())
        .ok_or_else(|| PathOpError::failed("printer DEVMODE field offset overflow"))?;
    if end > buffer.byte_len {
        return Err(PathOpError::failed("printer returned a truncated DEVMODE"));
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(buffer.devmode_ptr().cast::<u8>(), buffer.byte_len) };
    let pair = bytes
        .get(offset..end)
        .ok_or_else(|| PathOpError::failed("printer returned a truncated DEVMODE"))?;
    Ok(u16::from_ne_bytes([pair[0], pair[1]]))
}

fn validate_devmode_lengths(public: usize, private: usize, buffer_len: usize) -> OpResult<()> {
    let total = public
        .checked_add(private)
        .ok_or_else(|| PathOpError::failed("printer DEVMODE length overflow"))?;
    if public < size_of::<DEVMODEW>() || total > buffer_len {
        return Err(PathOpError::failed("printer returned a truncated DEVMODE"));
    }
    Ok(())
}

fn printable_area(dc: HDC) -> OpResult<(u32, u32, u32, u32)> {
    let width = unsafe { GetDeviceCaps(dc, HORZRES as i32) };
    let height = unsafe { GetDeviceCaps(dc, VERTRES as i32) };
    let dpi_x = unsafe { GetDeviceCaps(dc, LOGPIXELSX as i32) };
    let dpi_y = unsafe { GetDeviceCaps(dc, LOGPIXELSY as i32) };
    let physical_width = unsafe { GetDeviceCaps(dc, PHYSICALWIDTH as i32) };
    let physical_height = unsafe { GetDeviceCaps(dc, PHYSICALHEIGHT as i32) };
    let offset_x = unsafe { GetDeviceCaps(dc, PHYSICALOFFSETX as i32) };
    let offset_y = unsafe { GetDeviceCaps(dc, PHYSICALOFFSETY as i32) };
    if width <= 0
        || height <= 0
        || width > 200_000
        || height > 200_000
        || dpi_x <= 0
        || dpi_y <= 0
        || dpi_x > 10_000
        || dpi_y > 10_000
        || physical_width <= 0
        || physical_height <= 0
        || offset_x < 0
        || offset_y < 0
        || offset_x
            .checked_add(width)
            .is_none_or(|edge| edge > physical_width)
        || offset_y
            .checked_add(height)
            .is_none_or(|edge| edge > physical_height)
    {
        return Err(PathOpError::failed(
            "printer reported invalid printable dimensions or resolution",
        ));
    }
    Ok((width as u32, height as u32, dpi_x as u32, dpi_y as u32))
}

fn validate_device_paper_size(dc: HDC, paper: &PaperCapability) -> OpResult<()> {
    let physical_width = unsafe { GetDeviceCaps(dc, PHYSICALWIDTH as i32) };
    let physical_height = unsafe { GetDeviceCaps(dc, PHYSICALHEIGHT as i32) };
    let dpi_x = unsafe { GetDeviceCaps(dc, LOGPIXELSX as i32) };
    let dpi_y = unsafe { GetDeviceCaps(dc, LOGPIXELSY as i32) };
    if physical_width <= 0 || physical_height <= 0 || dpi_x <= 0 || dpi_y <= 0 {
        return Err(PathOpError::failed(
            "printer did not report a valid physical paper size",
        ));
    }
    let width_tenth_mm = physical_width as i64 * 254 / dpi_x as i64;
    let height_tenth_mm = physical_height as i64 * 254 / dpi_y as i64;
    let close = |actual: i64, expected: i32, dpi: i32| {
        let two_pixels_tenth_mm = (508 + dpi as i64 - 1) / dpi as i64;
        (actual - expected as i64).abs() <= 10.max(two_pixels_tenth_mm)
    };
    if !(close(width_tenth_mm, paper.width_tenth_mm, dpi_x)
        && close(height_tenth_mm, paper.height_tenth_mm, dpi_y)
        || close(width_tenth_mm, paper.height_tenth_mm, dpi_x)
            && close(height_tenth_mm, paper.width_tenth_mm, dpi_y))
    {
        return Err(PathOpError::failed(
            "printer device context does not match the selected paper dimensions",
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq)]
struct SelectedPage {
    index: u32,
    visible_box: [f64; 4],
    rotate: i64,
}

fn selected_pages(
    selection: &PrintSelection,
    facts: &[path_ops::PageFacts],
    page_count: u32,
) -> OpResult<Vec<SelectedPage>> {
    let mut indexes = Vec::new();
    match selection {
        PrintSelection::WholeDocument => indexes.extend(0..page_count),
        PrintSelection::Segments(segments) => {
            if segments.is_empty() {
                return Err(PathOpError::invalid("no pages selected"));
            }
            for segment in segments {
                if segment.first == 0 || segment.last < segment.first || segment.last > page_count {
                    return Err(PathOpError::invalid("invalid page selection"));
                }
                indexes.extend((segment.first - 1)..segment.last);
            }
        }
    }
    if indexes.is_empty() {
        return Err(PathOpError::invalid("document has no pages"));
    }
    indexes
        .into_iter()
        .map(|index| {
            let page = facts
                .get(index as usize)
                .filter(|page| page.index == index)
                .ok_or_else(|| PathOpError::failed("PDF page geometry is incomplete"))?;
            if page
                .media_box
                .iter()
                .any(|value| !value.is_finite() || value.abs() >= 1.0e9)
            {
                return Err(PathOpError::invalid(
                    "PDF page has invalid MediaBox geometry",
                ));
            }
            if page.media_box[2] <= page.media_box[0]
                || page.media_box[3] <= page.media_box[1]
                || !matches!(page.rotate, 0 | 90 | 180 | 270)
            {
                return Err(PathOpError::invalid(
                    "PDF page has invalid MediaBox geometry",
                ));
            }
            let visible_box = page.print_box.ok_or_else(|| {
                PathOpError::invalid("PDF page has no validated effective print box")
            })?;
            if visible_box
                .iter()
                .any(|value| !value.is_finite() || value.abs() >= 1.0e9)
                || visible_box[2] <= visible_box[0]
                || visible_box[3] <= visible_box[1]
                || visible_box[0] < page.media_box[0]
                || visible_box[1] < page.media_box[1]
                || visible_box[2] > page.media_box[2]
                || visible_box[3] > page.media_box[3]
            {
                return Err(PathOpError::invalid(
                    "PDF page has invalid effective print box geometry",
                ));
            }
            if !page.user_unit.is_finite() || (page.user_unit - 1.0).abs() > f64::EPSILON {
                return Err(PathOpError::invalid(
                    "Windows custom printing does not support PDF /UserUnit values other than 1",
                ));
            }
            let selected = SelectedPage {
                index,
                visible_box,
                rotate: page.rotate,
            };
            Ok(selected)
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct RasterPlan {
    dpi: f64,
    width: u32,
    height: u32,
    bytes: u64,
}

fn choose_raster_plans(
    pages: &[SelectedPage],
    printable: (u32, u32, u32, u32),
    maximum_effective_dpi: u32,
) -> OpResult<Vec<RasterPlan>> {
    let preferred = maximum_effective_dpi.min(RASTER_DPI) as f64;
    let floor = maximum_effective_dpi.min(RASTER_FLOOR_DPI) as f64;
    for effective_dpi in [preferred, floor] {
        let plans = pages
            .iter()
            .map(|page| raster_plan(page, printable, effective_dpi))
            .collect::<OpResult<Vec<_>>>();
        let plans = match plans {
            Ok(plans) => plans,
            Err(error)
                if error
                    .message
                    .contains("unsupported Ghostscript raster resolution") =>
            {
                continue;
            }
            Err(error) => return Err(error),
        };
        if plans.iter().all(|plan| plan.bytes <= MAX_BITMAP_BYTES) {
            return Ok(plans);
        }
    }
    Err(PathOpError::invalid(
        "the selected pages exceed the safe Windows print raster size at 150 dpi",
    ))
}

fn raster_plan(
    page: &SelectedPage,
    printable: (u32, u32, u32, u32),
    effective_dpi: f64,
) -> OpResult<RasterPlan> {
    let (width_points, height_points) = page_dimensions_points(page);
    let target_width_inches = printable.0 as f64 / printable.2 as f64;
    let target_height_inches = printable.1 as f64 / printable.3 as f64;
    let source_width_inches = width_points / 72.0;
    let source_height_inches = height_points / 72.0;
    let fit_scale = (target_width_inches / source_width_inches)
        .min(target_height_inches / source_height_inches);
    let dpi = effective_dpi * fit_scale;
    if !dpi.is_finite() || !(0.000_001..=MAX_SOURCE_DPI).contains(&dpi) {
        return Err(PathOpError::invalid(
            "the selected page requires an unsupported Ghostscript raster resolution",
        ));
    }
    let width = (source_width_inches * dpi).ceil();
    let height = (source_height_inches * dpi).ceil();
    if !width.is_finite() || !height.is_finite() || width < 1.0 || height < 1.0 {
        return Err(PathOpError::invalid("PDF page dimensions are invalid"));
    }
    // Allow for Ghostscript's integer-dimension rounding before selecting a
    // plan; the parsed BMP is still capped against its actual payload.
    let budget_width = (width as u64)
        .checked_add(2)
        .ok_or_else(|| PathOpError::invalid("PDF page raster size overflow"))?;
    let budget_height = (height as u64)
        .checked_add(2)
        .ok_or_else(|| PathOpError::invalid("PDF page raster size overflow"))?;
    let row_bytes = budget_width
        .checked_mul(3)
        .and_then(|value| value.checked_add(3))
        .map(|value| value & !3)
        .ok_or_else(|| PathOpError::invalid("PDF page raster size overflow"))?;
    let image_bytes = row_bytes
        .checked_mul(budget_height)
        .ok_or_else(|| PathOpError::invalid("PDF page raster size overflow"))?;
    if width > path_ops::MAX_PRINT_RASTER_AXIS_PIXELS as f64
        || height > path_ops::MAX_PRINT_RASTER_AXIS_PIXELS as f64
        || width > i32::MAX as f64
        || height > i32::MAX as f64
    {
        return Err(PathOpError::invalid("PDF page dimensions are too large"));
    }
    let bytes = image_bytes
        .checked_add(1024)
        .ok_or_else(|| PathOpError::invalid("PDF page raster size overflow"))?;
    Ok(RasterPlan {
        dpi,
        width: width as u32,
        height: height as u32,
        bytes,
    })
}

fn page_dimensions_points(page: &SelectedPage) -> (f64, f64) {
    let width = page.visible_box[2] - page.visible_box[0];
    let height = page.visible_box[3] - page.visible_box[1];
    if matches!(page.rotate, 90 | 270) {
        (height, width)
    } else {
        (width, height)
    }
}

fn page_bitmap_path(work_dir: &Path, job_id: u64, page_number: u32) -> PathBuf {
    work_dir.join(format!("custom-print-{job_id}-page-{page_number:06}.bmp"))
}

fn render_page(
    toolchain: &PathOpsToolchain,
    input: &Path,
    page_number: u32,
    dpi: f64,
    output: &Path,
    cancel_flag: &Arc<AtomicBool>,
) -> OpResult<()> {
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(cancelled());
    }
    match fs::remove_file(output) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(PathOpError::io("replace stale print bitmap", error)),
    }
    let arguments = render_page_args(input, page_number, dpi, output);
    if let Err(error) = path_ops::run_ghostscript_print_bounded(toolchain, &arguments, cancel_flag)
    {
        let _ = fs::remove_file(output);
        return Err(translate_path_cancel(error));
    }
    let metadata = match fs::metadata(output) {
        Ok(metadata) => metadata,
        Err(error) => {
            let _ = fs::remove_file(output);
            return Err(PathOpError::io("read rendered print page", error));
        }
    };
    if metadata.len() > MAX_BITMAP_BYTES + 1024 {
        let _ = fs::remove_file(output);
        return Err(PathOpError::invalid(
            "Ghostscript produced a page bitmap above the safe size limit",
        ));
    }
    Ok(())
}

fn gs_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn render_page_args(input: &Path, page_number: u32, dpi: f64, output: &Path) -> Vec<OsString> {
    let mut arguments = vec![
        OsString::from("-dBATCH"),
        OsString::from("-dNOPAUSE"),
        OsString::from("-dSAFER"),
        OsString::from(format!("--permit-file-read={}", gs_path(input))),
        OsString::from(format!("--permit-file-write={}", gs_path(output))),
        OsString::from("-dTextAlphaBits=4"),
        OsString::from("-dGraphicsAlphaBits=4"),
        OsString::from("-sDEVICE=bmp16m"),
        OsString::from("-dUseCropBox"),
        OsString::from(format!("-r{dpi}")),
        OsString::from(format!("-dFirstPage={page_number}")),
        OsString::from(format!("-dLastPage={page_number}")),
        OsString::from(format!("-sOutputFile={}", gs_path(output))),
    ];
    arguments.push(path_ops::path_arg(input));
    arguments
}

#[derive(Debug, PartialEq, Eq)]
struct Bitmap {
    width: u32,
    height: u32,
    signed_height: i32,
    bytes: Vec<u8>,
    pixel_offset: usize,
    row_stride: u32,
}

fn read_bitmap(path: &Path, dpi: f64, page: &SelectedPage) -> OpResult<Bitmap> {
    let result = (|| {
        let mut file = File::open(path)
            .map_err(|error| PathOpError::io("open rendered print bitmap", error))?;
        let initial_len = file
            .metadata()
            .map_err(|error| PathOpError::io("inspect rendered print bitmap", error))?
            .len();
        let limit = MAX_BITMAP_BYTES + 1024;
        if initial_len > limit {
            return Err(PathOpError::invalid(
                "Ghostscript produced a page bitmap above the safe size limit",
            ));
        }
        let mut bytes = vec![0; initial_len as usize];
        file.read_exact(&mut bytes)
            .map_err(|error| PathOpError::io("read print bitmap", error))?;
        let mut extra = [0u8; 1];
        if file
            .read(&mut extra)
            .map_err(|error| PathOpError::io("recheck print bitmap", error))?
            != 0
        {
            return Err(PathOpError::failed(
                "rendered print bitmap changed while it was being read",
            ));
        }
        let layout = inspect_bitmap(&bytes, dpi, page)?;
        Ok(Bitmap {
            width: layout.width,
            height: layout.height,
            signed_height: layout.signed_height,
            pixel_offset: layout.pixel_offset,
            row_stride: layout.row_stride,
            bytes,
        })
    })();
    let _ = fs::remove_file(path);
    result
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct BitmapLayout {
    width: u32,
    height: u32,
    signed_height: i32,
    pixel_offset: usize,
    row_stride: u32,
}

fn inspect_bitmap(bytes: &[u8], dpi: f64, page: &SelectedPage) -> OpResult<BitmapLayout> {
    if bytes.len() < 54 || &bytes[..2] != b"BM" {
        return Err(PathOpError::invalid(
            "Ghostscript returned an invalid BMP page",
        ));
    }
    let pixel_offset = read_u32(bytes, 10)? as usize;
    let header_size = read_u32(bytes, 14)? as usize;
    let width_signed = read_i32(bytes, 18)?;
    let height_signed = read_i32(bytes, 22)?;
    let planes = read_u16(bytes, 26)?;
    let bit_count = read_u16(bytes, 28)?;
    let compression = read_u32(bytes, 30)?;
    let declared_file_size = read_u32(bytes, 2)? as usize;
    let declared_image_size = read_u32(bytes, 34)? as u64;
    if header_size != 40
        || width_signed <= 0
        || height_signed == 0
        || planes != 1
        || bit_count != 24
        || compression != BI_RGB
    {
        return Err(PathOpError::invalid(
            "Ghostscript returned an unsupported BMP format",
        ));
    }
    let width = width_signed as u32;
    let height = height_signed.unsigned_abs();
    if width == 0
        || height == 0
        || width > path_ops::MAX_PRINT_RASTER_AXIS_PIXELS
        || height > path_ops::MAX_PRINT_RASTER_AXIS_PIXELS
    {
        return Err(PathOpError::invalid(
            "Ghostscript returned invalid BMP dimensions",
        ));
    }
    let row_stride = width
        .checked_mul(3)
        .and_then(|value| value.checked_add(3))
        .map(|value| value & !3)
        .ok_or_else(|| PathOpError::invalid("BMP row size overflow"))?;
    let image_bytes = (row_stride as u64)
        .checked_mul(height as u64)
        .ok_or_else(|| PathOpError::invalid("BMP page size overflow"))?;
    let end = pixel_offset
        .checked_add(image_bytes as usize)
        .ok_or_else(|| PathOpError::invalid("BMP file size overflow"))?;
    if image_bytes > MAX_BITMAP_BYTES
        || pixel_offset != 14 + header_size
        || end != bytes.len()
        || declared_file_size != bytes.len()
        || (declared_image_size != 0 && declared_image_size != image_bytes)
    {
        return Err(PathOpError::invalid(
            "Ghostscript returned a truncated or oversized BMP",
        ));
    }
    let (media_width, media_height) = page_dimensions_points(page);
    let expected_width = (media_width * dpi / 72.0).round() as i64;
    let expected_height = (media_height * dpi / 72.0).round() as i64;
    if (width as i64 - expected_width).abs() > 2 || (height as i64 - expected_height).abs() > 2 {
        return Err(PathOpError::failed(
            "Ghostscript bitmap dimensions do not match the PDF effective print box",
        ));
    }
    Ok(BitmapLayout {
        width,
        height,
        signed_height: height_signed,
        pixel_offset,
        row_stride,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FitRect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

fn fit_rect(
    source_points: (f64, f64),
    target_width: u32,
    target_height: u32,
    dpi_x: u32,
    dpi_y: u32,
) -> OpResult<FitRect> {
    if !source_points.0.is_finite()
        || !source_points.1.is_finite()
        || source_points.0 <= 0.0
        || source_points.1 <= 0.0
        || target_width == 0
        || target_height == 0
        || dpi_x == 0
        || dpi_y == 0
    {
        return Err(PathOpError::invalid("cannot fit an empty print page"));
    }
    let source_width_in = source_points.0 / 72.0;
    let source_height_in = source_points.1 / 72.0;
    let target_width_in = target_width as f64 / dpi_x as f64;
    let target_height_in = target_height as f64 / dpi_y as f64;
    let scale = (target_width_in / source_width_in).min(target_height_in / source_height_in);
    let width = ((source_width_in * scale * dpi_x as f64).floor() as u32).clamp(1, target_width);
    let height = ((source_height_in * scale * dpi_y as f64).floor() as u32).clamp(1, target_height);
    Ok(FitRect {
        x: ((target_width - width) / 2) as i32,
        y: ((target_height - height) / 2) as i32,
        width: width as i32,
        height: height as i32,
    })
}

fn draw_bitmap(dc: HDC, bitmap: &Bitmap, fit: FitRect) -> OpResult<()> {
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: bitmap.width as i32,
            biHeight: bitmap.signed_height,
            biPlanes: 1,
            biBitCount: 24,
            biCompression: BI_RGB,
            biSizeImage: bitmap.row_stride.saturating_mul(bitmap.height),
            ..Default::default()
        },
        ..Default::default()
    };
    if unsafe { SetStretchBltMode(dc, HALFTONE) } == 0 {
        return Err(win_error("configure bitmap scaling"));
    }
    if unsafe { SetBrushOrgEx(dc, 0, 0, ptr::null_mut()) } == 0 {
        return Err(win_error("configure bitmap halftone alignment"));
    }
    let result = unsafe {
        StretchDIBits(
            dc,
            fit.x,
            fit.y,
            fit.width,
            fit.height,
            0,
            0,
            bitmap.width as i32,
            bitmap.height as i32,
            bitmap.bytes[bitmap.pixel_offset..].as_ptr().cast(),
            &info,
            DIB_RGB_COLORS,
            SRCCOPY,
        )
    };
    if result == 0 || result == -1 {
        return Err(win_error("draw bitmap page"));
    }
    Ok(())
}

fn capability_words(
    printer: &str,
    port: *const u16,
    capability: u16,
    mode: *const DEVMODEW,
) -> OpResult<Vec<u16>> {
    let name = wide(printer);
    let count =
        unsafe { DeviceCapabilitiesW(name.as_ptr(), port, capability, ptr::null_mut(), mode) };
    let count = valid_capability_count(count)?;
    if count == 0 {
        return Ok(Vec::new());
    }
    let mut values = vec![0u16; count];
    let result =
        unsafe { DeviceCapabilitiesW(name.as_ptr(), port, capability, values.as_mut_ptr(), mode) };
    if result != count as i32 {
        return Err(win_error("read printer capabilities"));
    }
    Ok(values)
}

fn capability_fields(printer: &str, port: *const u16, mode: *const DEVMODEW) -> OpResult<u32> {
    let name = wide(printer);
    let fields =
        unsafe { DeviceCapabilitiesW(name.as_ptr(), port, DC_FIELDS, ptr::null_mut(), mode) };
    if fields == -1 {
        return Err(win_error("read supported DEVMODE fields"));
    }
    Ok(fields as u32)
}

fn capability_names(
    printer: &str,
    port: *const u16,
    capability: u16,
    chars_per_name: usize,
    mode: *const DEVMODEW,
) -> OpResult<Vec<String>> {
    let name = wide(printer);
    let count =
        unsafe { DeviceCapabilitiesW(name.as_ptr(), port, capability, ptr::null_mut(), mode) };
    let count = valid_capability_count(count)?;
    if count == 0 {
        return Ok(Vec::new());
    }
    let units = count
        .checked_mul(chars_per_name)
        .ok_or_else(|| PathOpError::failed("printer capability size overflow"))?;
    let mut values = vec![0u16; units];
    let result =
        unsafe { DeviceCapabilitiesW(name.as_ptr(), port, capability, values.as_mut_ptr(), mode) };
    if result != count as i32 {
        return Err(win_error("read printer capability names"));
    }
    Ok(values
        .chunks_exact(chars_per_name)
        .map(|slice| {
            let end = slice
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(slice.len());
            String::from_utf16_lossy(&slice[..end]).trim().to_string()
        })
        .collect())
}

fn capability_sizes(
    printer: &str,
    port: *const u16,
    mode: *const DEVMODEW,
) -> OpResult<Vec<POINT>> {
    let name = wide(printer);
    let count =
        unsafe { DeviceCapabilitiesW(name.as_ptr(), port, DC_PAPERSIZE, ptr::null_mut(), mode) };
    let count = valid_capability_count(count)?;
    if count == 0 {
        return Ok(Vec::new());
    }
    let mut values = vec![POINT::default(); count];
    let result = unsafe {
        DeviceCapabilitiesW(
            name.as_ptr(),
            port,
            DC_PAPERSIZE,
            values.as_mut_ptr().cast(),
            mode,
        )
    };
    if result != count as i32 {
        return Err(win_error("read printer paper dimensions"));
    }
    Ok(values)
}

fn valid_capability_count(count: i32) -> OpResult<usize> {
    if count < 0 || count as usize > MAX_CAPABILITY_ENTRIES {
        return Err(PathOpError::failed("printer returned invalid capabilities"));
    }
    Ok(count as usize)
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn read_u16(bytes: &[u8], offset: usize) -> OpResult<u16> {
    let slice = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| PathOpError::invalid("truncated BMP header"))?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> OpResult<u32> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| PathOpError::invalid("truncated BMP header"))?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_i32(bytes: &[u8], offset: usize) -> OpResult<i32> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| PathOpError::invalid("truncated BMP header"))?;
    Ok(i32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn cancelled() -> PathOpError {
    PathOpError {
        code: PRINT_CANCELLED,
        message: "Printing was cancelled.".to_string(),
    }
}

fn translate_path_cancel(mut error: PathOpError) -> PathOpError {
    if error.code == path_ops::ERR_CANCELLED {
        error.code = PRINT_CANCELLED;
        error.message = "Printing was cancelled.".to_string();
    }
    error
}

fn classify_job_error(mut error: PathOpError, jobs_started: u32) -> PathOpError {
    if jobs_started > 0 {
        if error.code == PRINT_CANCELLED {
            error.code = PRINT_PARTIAL_CANCELLED;
            error.message = "Some pages or copies may already have printed. Check the printer queue before retrying.".to_string();
        } else {
            error.code = PRINT_FAILED;
            error.message = "The print job failed. Some pages or copies may already have printed. Check the printer queue before retrying.".to_string();
        }
    }
    error
}

fn classify_native_job_error(
    error: PathOpError,
    jobs_started: u32,
    cancel_flag: &AtomicBool,
) -> PathOpError {
    // Driver calls can fail because SetAbortProc observed the user's cancel.
    // Keep that user action distinct from a driver failure after submission.
    let error = if cancel_flag.load(Ordering::Relaxed) {
        cancelled()
    } else {
        error
    };
    classify_job_error(error, jobs_started)
}

fn win_error(action: &str) -> PathOpError {
    let error = unsafe { GetLastError() };
    PathOpError {
        code: PRINT_FAILED,
        message: format!("Could not {action} (Windows error {error})."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::print_ops::PageSegmentRange;

    fn selected_page(width: f64, height: f64) -> SelectedPage {
        SelectedPage {
            index: 0,
            visible_box: [0.0, 0.0, width, height],
            rotate: 0,
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum MockFailure {
        StartDocument,
        StartPage,
        Draw,
        EndPage,
        Finish,
    }

    #[derive(Default)]
    struct MockLifecycleState {
        failure: Option<MockFailure>,
        starts: u32,
        page_starts: u32,
        draws: u32,
        page_ends: u32,
        finishes: u32,
        aborts: u32,
        cancel_after_draw: bool,
        cancel_after_end_page: bool,
    }

    #[derive(Clone)]
    struct MockStarter {
        state: Arc<std::sync::Mutex<MockLifecycleState>>,
        cancel: Arc<AtomicBool>,
    }

    struct MockDocument {
        state: Arc<std::sync::Mutex<MockLifecycleState>>,
        cancel: Arc<AtomicBool>,
        active: bool,
    }

    impl PrintJobStarter for MockStarter {
        type Document = MockDocument;

        fn start_document(
            &mut self,
            _cancel_flag: &AtomicBool,
            _output_path: Option<&Path>,
        ) -> OpResult<Self::Document> {
            let mut state = self.state.lock().unwrap();
            state.starts += 1;
            if state.failure == Some(MockFailure::StartDocument) {
                return Err(PathOpError::failed("injected StartDoc failure"));
            }
            drop(state);
            Ok(MockDocument {
                state: self.state.clone(),
                cancel: self.cancel.clone(),
                active: true,
            })
        }
    }

    impl PrintDocumentLifecycle for MockDocument {
        fn start_page(&mut self) -> OpResult<()> {
            let mut state = self.state.lock().unwrap();
            state.page_starts += 1;
            if state.failure == Some(MockFailure::StartPage) {
                return Err(PathOpError::failed("injected StartPage failure"));
            }
            Ok(())
        }

        fn draw(&mut self, _bitmap: &Bitmap, _fit: FitRect) -> OpResult<()> {
            let mut state = self.state.lock().unwrap();
            state.draws += 1;
            if state.failure == Some(MockFailure::Draw) {
                return Err(PathOpError::failed("injected draw failure"));
            }
            if state.cancel_after_draw {
                self.cancel.store(true, Ordering::Relaxed);
            }
            Ok(())
        }

        fn end_page(&mut self) -> OpResult<()> {
            let mut state = self.state.lock().unwrap();
            state.page_ends += 1;
            if state.failure == Some(MockFailure::EndPage) {
                return Err(PathOpError::failed("injected EndPage failure"));
            }
            if state.cancel_after_end_page {
                self.cancel.store(true, Ordering::Relaxed);
            }
            Ok(())
        }

        fn finish(&mut self) -> OpResult<()> {
            let mut state = self.state.lock().unwrap();
            if state.failure == Some(MockFailure::Finish) {
                return Err(PathOpError::failed("injected EndDoc failure"));
            }
            state.finishes += 1;
            self.active = false;
            Ok(())
        }
    }

    impl Drop for MockDocument {
        fn drop(&mut self) {
            if self.active {
                self.state.lock().unwrap().aborts += 1;
            }
        }
    }

    fn mock_job(
        failure: Option<MockFailure>,
    ) -> (MockStarter, Arc<std::sync::Mutex<MockLifecycleState>>) {
        let state = Arc::new(std::sync::Mutex::new(MockLifecycleState {
            failure,
            ..MockLifecycleState::default()
        }));
        let cancel = Arc::new(AtomicBool::new(false));
        (
            MockStarter {
                state: state.clone(),
                cancel,
            },
            state,
        )
    }

    fn mock_bitmap() -> Bitmap {
        Bitmap {
            width: 1,
            height: 1,
            signed_height: 1,
            bytes: vec![0; 58],
            pixel_offset: 54,
            row_stride: 4,
        }
    }

    fn mock_fit() -> FitRect {
        FitRect {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
        }
    }

    fn bmp(width: u32, height: i32, offset: u32, image_size: usize) -> Vec<u8> {
        let row_stride = (width * 3 + 3) & !3;
        let data_len = if image_size == 0 {
            row_stride as usize * height.unsigned_abs() as usize
        } else {
            image_size
        };
        let mut bytes = vec![0u8; offset as usize + data_len];
        bytes[0..2].copy_from_slice(b"BM");
        let file_len = bytes.len() as u32;
        bytes[2..6].copy_from_slice(&file_len.to_le_bytes());
        bytes[10..14].copy_from_slice(&offset.to_le_bytes());
        bytes[14..18].copy_from_slice(&40u32.to_le_bytes());
        bytes[18..22].copy_from_slice(&(width as i32).to_le_bytes());
        bytes[22..26].copy_from_slice(&height.to_le_bytes());
        bytes[26..28].copy_from_slice(&1u16.to_le_bytes());
        bytes[28..30].copy_from_slice(&24u16.to_le_bytes());
        bytes[30..34].copy_from_slice(&BI_RGB.to_le_bytes());
        bytes[34..38].copy_from_slice(&(data_len as u32).to_le_bytes());
        bytes
    }

    #[test]
    fn raster_dpi_tracks_physical_fit_and_preserves_effective_print_resolution() {
        let printable = (4800, 3150, 600, 300);
        let one_inch = raster_plan(&selected_page(72.0, 72.0), printable, 300.0).unwrap();
        assert!((one_inch.dpi - 2400.0).abs() < 0.001);
        assert_eq!((one_inch.width, one_inch.height), (2400, 2400));
        let poster =
            raster_plan(&selected_page(36.0 * 72.0, 48.0 * 72.0), printable, 300.0).unwrap();
        assert!((poster.dpi - 65.625).abs() < 0.001);
        assert_eq!((poster.width, poster.height), (2363, 3150));
    }

    #[test]
    fn print_raster_falls_back_to_150_effective_dpi_only_when_needed() {
        let page = selected_page(32.0 * 72.0, 32.0 * 72.0);
        let plans = choose_raster_plans(&[page], (3200, 3200, 100, 100), 300).unwrap();
        assert_eq!(plans.len(), 1);
        assert!((plans[0].dpi - 150.0).abs() < 0.001);
        assert!(plans[0].bytes <= MAX_BITMAP_BYTES);
    }

    #[test]
    fn fit_rect_preserves_aspect_and_centers_inside_printable_area() {
        assert_eq!(
            fit_rect((600.0, 800.0), 1000, 1000, 100, 100).unwrap(),
            FitRect {
                x: 125,
                y: 0,
                width: 750,
                height: 1000,
            }
        );
        let anisotropic = fit_rect((72.0, 72.0), 4800, 3150, 600, 300).unwrap();
        assert_eq!((anisotropic.width, anisotropic.height), (4800, 2400));
        assert_eq!((anisotropic.x, anisotropic.y), (0, 375));
    }

    #[test]
    fn bmp_parser_checks_media_box_geometry_and_truncation() {
        let page = selected_page(72.0, 72.0);
        let bytes = bmp(300, 300, 54, 0);
        let parsed = inspect_bitmap(&bytes, 300.0, &page).unwrap();
        assert_eq!((parsed.width, parsed.height), (300, 300));
        assert!(inspect_bitmap(&bytes[..100], 300.0, &page).is_err());
        assert!(inspect_bitmap(&bmp(600, 300, 54, 0), 300.0, &page).is_err());
    }

    #[test]
    fn bmp_parser_rejects_trailing_data_and_inconsistent_headers() {
        let page = selected_page(72.0, 72.0);
        let valid = bmp(300, 300, 54, 0);
        let mut trailing = valid.clone();
        trailing.push(0);
        assert!(inspect_bitmap(&trailing, 300.0, &page).is_err());
        let mut wrong_size = valid.clone();
        wrong_size[2..6].copy_from_slice(&54u32.to_le_bytes());
        assert!(inspect_bitmap(&wrong_size, 300.0, &page).is_err());
        let mut wrong_payload = valid;
        wrong_payload[34..38].copy_from_slice(&1u32.to_le_bytes());
        assert!(inspect_bitmap(&wrong_payload, 300.0, &page).is_err());
    }

    #[test]
    fn source_dpi_argument_preserves_preflight_size_for_huge_shrunk_pages() {
        let page = selected_page(1_000_000_000.0, 1_000_000_000.0);
        let plan = raster_plan(&page, (4800, 3150, 600, 300), 300.0).unwrap();
        let arguments =
            render_page_args(Path::new("input.pdf"), 1, plan.dpi, Path::new("page.bmp"));
        let passed_dpi: f64 = arguments
            .iter()
            .find_map(|arg| arg.to_str()?.strip_prefix("-r"))
            .unwrap()
            .parse()
            .unwrap();
        assert!(
            (page_dimensions_points(&page).0 * passed_dpi / 72.0).ceil() as u32 <= plan.width + 2
        );
        assert!(!arguments.iter().any(|arg| arg == "-dPDFFitPage"));
    }

    #[test]
    fn selection_preserves_segment_order_and_rejects_out_of_bounds() {
        let facts = vec![
            path_ops::PageFacts {
                index: 0,
                media_box: [0.0, 0.0, 72.0, 72.0],
                print_box: Some([0.0, 0.0, 72.0, 72.0]),
                rotate: 0,
                user_unit: 1.0,
                orientation: "portrait",
                letter_portrait: false,
            },
            path_ops::PageFacts {
                index: 1,
                media_box: [0.0, 0.0, 72.0, 72.0],
                print_box: Some([0.0, 0.0, 72.0, 72.0]),
                rotate: 0,
                user_unit: 1.0,
                orientation: "portrait",
                letter_portrait: false,
            },
        ];
        let pages = selected_pages(
            &PrintSelection::Segments(vec![
                PageSegmentRange { first: 2, last: 2 },
                PageSegmentRange { first: 1, last: 1 },
            ]),
            &facts,
            2,
        )
        .unwrap();
        assert_eq!(
            pages.iter().map(|page| page.index).collect::<Vec<_>>(),
            vec![1, 0]
        );
        assert!(selected_pages(
            &PrintSelection::Segments(vec![PageSegmentRange { first: 1, last: 3 }]),
            &facts,
            2,
        )
        .is_err());
    }

    #[test]
    fn selection_rejects_nondefault_user_unit_and_invalid_geometry() {
        let fact = |user_unit, media_box, print_box| path_ops::PageFacts {
            index: 0,
            media_box,
            print_box,
            rotate: 0,
            user_unit,
            orientation: "portrait",
            letter_portrait: false,
        };
        assert!(selected_pages(
            &PrintSelection::WholeDocument,
            &[fact(
                2.0,
                [0.0, 0.0, 72.0, 72.0],
                Some([0.0, 0.0, 72.0, 72.0])
            )],
            1,
        )
        .is_err());
        assert!(selected_pages(
            &PrintSelection::WholeDocument,
            &[fact(
                1.0,
                [0.0, 0.0, f64::INFINITY, 72.0],
                Some([0.0, 0.0, 72.0, 72.0])
            )],
            1,
        )
        .is_err());
        assert!(selected_pages(
            &PrintSelection::WholeDocument,
            &[fact(
                1.0,
                [10.0, 0.0, 9.0, 72.0],
                Some([10.0, 0.0, 9.0, 72.0])
            )],
            1,
        )
        .is_err());
    }

    #[test]
    fn selection_requires_a_valid_effective_print_box_inside_media_box() {
        let fact = |print_box| path_ops::PageFacts {
            index: 0,
            media_box: [37.0, 53.0, 649.0, 845.0],
            print_box,
            rotate: 0,
            user_unit: 1.0,
            orientation: "portrait",
            letter_portrait: false,
        };
        let select =
            |page: path_ops::PageFacts| selected_pages(&PrintSelection::WholeDocument, &[page], 1);
        assert!(select(fact(None)).is_err());
        assert!(select(fact(Some([37.0, 53.0, 36.0, 845.0]))).is_err());
        assert!(select(fact(Some([36.0, 53.0, 649.0, 845.0]))).is_err());
        assert!(select(fact(Some([37.0, 53.0, 650.0, 845.0]))).is_err());
        assert!(select(fact(Some([37.0, 53.0, f64::NAN, 845.0]))).is_err());
        assert!(select(fact(Some([137.0, 153.0, 549.0, 745.0]))).is_ok());

        let first = fact(Some([137.0, 153.0, 549.0, 745.0]));
        let mut invalid_later = fact(None);
        invalid_later.index = 1;
        assert!(
            selected_pages(&PrintSelection::WholeDocument, &[first, invalid_later], 2).is_err()
        );
    }

    #[test]
    fn cropped_visible_box_drives_raster_geometry_and_rotation() {
        let media_box = [37.0, 53.0, 649.0, 845.0];
        let crop_box = [137.0, 153.0, 549.0, 745.0];
        let fact = |rotate| path_ops::PageFacts {
            index: 0,
            media_box,
            print_box: Some(crop_box),
            rotate,
            user_unit: 1.0,
            orientation: "portrait",
            letter_portrait: false,
        };
        let select = |rotate| {
            selected_pages(&PrintSelection::WholeDocument, &[fact(rotate)], 1).unwrap()[0].clone()
        };
        let portrait = select(0);
        assert_eq!(page_dimensions_points(&portrait), (412.0, 592.0));
        let bmp_portrait = inspect_bitmap(&bmp(412, 592, 54, 0), 72.0, &portrait).unwrap();
        assert_eq!((bmp_portrait.width, bmp_portrait.height), (412, 592));
        let portrait_plan = raster_plan(&portrait, (4800, 3150, 600, 300), 300.0).unwrap();
        assert!(
            (portrait_plan.dpi
                - 300.0 * (8.0_f64 / (412.0_f64 / 72.0)).min(10.5_f64 / (592.0_f64 / 72.0)))
            .abs()
                < 1e-9
        );

        let rotated = select(90);
        assert_eq!(page_dimensions_points(&rotated), (592.0, 412.0));
        let bmp_rotated = inspect_bitmap(&bmp(592, 412, 54, 0), 72.0, &rotated).unwrap();
        assert_eq!((bmp_rotated.width, bmp_rotated.height), (592, 412));
        let rotated_plan = raster_plan(&rotated, (4800, 3150, 600, 300), 300.0).unwrap();
        assert!(
            (rotated_plan.dpi
                - 300.0 * (8.0_f64 / (592.0_f64 / 72.0)).min(10.5_f64 / (412.0_f64 / 72.0)))
            .abs()
                < 1e-9
        );
    }

    #[test]
    fn ghostscript_raster_arguments_use_crop_box_without_global_fit_or_rotation() {
        let args = render_page_args(Path::new("input.pdf"), 1, 300.0, Path::new("page.bmp"));
        assert!(args.iter().any(|arg| arg == "-dUseCropBox"));
        assert!(!args.iter().any(|arg| arg == "-dPDFFitPage"));
        assert!(!args.iter().any(|arg| arg == "-dFIXEDMEDIA"));
        assert!(!args
            .iter()
            .any(|arg| arg.to_string_lossy().starts_with("-g")));
        assert!(!args
            .iter()
            .any(|arg| arg.to_string_lossy().contains("AutoRotate")));
    }

    #[test]
    fn printer_capability_filter_honors_supported_fields_and_custom_form_requirements() {
        assert_eq!(capability_query_flags(DM_COPIES), (false, false));
        assert_eq!(capability_query_flags(DM_PAPERSIZE), (true, false));
        assert_eq!(capability_query_flags(DM_DEFAULTSOURCE), (false, true));
        assert_eq!(
            capability_query_flags(DM_PAPERSIZE | DM_DEFAULTSOURCE),
            (true, true)
        );

        let ids = [9, DMPAPER_USER as u16];
        let sizes = [POINT { x: 2159, y: 2794 }, POINT { x: 1234, y: 2345 }];
        let names = ["Letter".to_string(), "Private custom form".to_string()];
        let standard_only = filter_media_capabilities(DM_PAPERSIZE, &ids, &sizes, &names).unwrap();
        assert_eq!(
            standard_only.iter().map(|p| p.id).collect::<Vec<_>>(),
            vec![9]
        );

        let all_custom_fields = DM_PAPERSIZE | DM_PAPERWIDTH | DM_PAPERLENGTH | DM_FORMNAME;
        let with_custom =
            filter_media_capabilities(all_custom_fields, &ids, &sizes, &names).unwrap();
        assert_eq!(
            with_custom.iter().map(|p| p.id).collect::<Vec<_>>(),
            vec![9, DMPAPER_USER as u16]
        );

        for missing in [DM_PAPERWIDTH, DM_PAPERLENGTH, DM_FORMNAME] {
            let supported =
                filter_media_capabilities(all_custom_fields & !missing, &ids, &sizes, &names)
                    .unwrap();
            assert_eq!(supported.iter().map(|p| p.id).collect::<Vec<_>>(), vec![9]);
        }
        assert!(filter_media_capabilities(0, &ids, &sizes, &names)
            .unwrap()
            .is_empty());

        // Paper/source choices remain discoverable when the driver does not
        // advertise DM_COPIES; copy handling is configured per job separately.
        let (query_media, query_sources) = capability_query_flags(DM_PAPERSIZE | DM_DEFAULTSOURCE);
        assert!(query_media && query_sources);
        assert_eq!(
            filter_media_capabilities(DM_PAPERSIZE, &ids[..1], &sizes[..1], &names[..1])
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            filter_source_capabilities(&[1], &["Tray 1".to_string()]).unwrap()[0].value,
            "DMBIN:1"
        );
    }

    #[test]
    fn devmode_lengths_reject_truncated_public_and_private_regions() {
        let public = size_of::<DEVMODEW>();
        assert!(validate_devmode_lengths(public - 1, 0, public + 64).is_err());
        assert!(validate_devmode_lengths(public, 1, public).is_err());
        assert!(validate_devmode_lengths(public, 64, public + 63).is_err());
        assert!(validate_devmode_lengths(public, 64, public + 64).is_ok());
        assert!(validate_devmode_lengths(usize::MAX, 1, usize::MAX).is_err());
    }

    #[test]
    fn output_copy_paths_are_distinct_for_each_driver_job() {
        let base = Path::new("C:\\private\\canary.pdf");
        assert_eq!(copy_output_path(base, 0), base);
        assert_eq!(
            copy_output_path(base, 1),
            Path::new("C:\\private\\canary-copy-2.pdf")
        );
        assert_eq!(
            copy_output_path(Path::new("C:\\private\\canary"), 2),
            Path::new("C:\\private\\canary-copy-3")
        );
    }

    #[test]
    fn job_error_codes_distinguish_prestart_and_partial_cancellation() {
        let before_start = classify_job_error(cancelled(), 0);
        assert_eq!(before_start.code, PRINT_CANCELLED);
        assert_eq!(before_start.message, "Printing was cancelled.");

        let after_start = classify_job_error(cancelled(), 1);
        assert_eq!(after_start.code, PRINT_PARTIAL_CANCELLED);
        assert!(after_start.message.contains("may already have printed"));
        assert!(after_start.message.contains("Check the printer queue"));

        let failed_after_start = classify_job_error(PathOpError::failed("raw internal detail"), 1);
        assert_eq!(failed_after_start.code, PRINT_FAILED);
        assert!(failed_after_start
            .message
            .contains("may already have printed"));
        assert!(!failed_after_start.message.contains("raw internal detail"));
    }

    #[test]
    fn abort_callback_observes_cancel_and_restores_nested_context() {
        let first = AtomicBool::new(false);
        let outer = AbortContext::install(&first);
        assert_eq!(unsafe { abort_proc(ptr::null_mut(), 0) }, 1);
        let second = AtomicBool::new(true);
        let inner = AbortContext::install(&second);
        assert_eq!(unsafe { abort_proc(ptr::null_mut(), 0) }, 0);
        drop(inner);
        assert_eq!(unsafe { abort_proc(ptr::null_mut(), 0) }, 1);
        first.store(true, Ordering::Relaxed);
        assert_eq!(unsafe { abort_proc(ptr::null_mut(), 0) }, 0);
        drop(outer);
        assert_eq!(unsafe { abort_proc(ptr::null_mut(), 0) }, 1);
    }

    #[test]
    fn native_callback_abort_is_presented_as_partial_cancellation() {
        let cancel = AtomicBool::new(true);
        let error = classify_native_job_error(
            PathOpError {
                code: PRINT_FAILED,
                message: "driver aborted drawing".into(),
            },
            1,
            &cancel,
        );
        assert_eq!(error.code, PRINT_PARTIAL_CANCELLED);
        assert!(error.message.contains("may already have printed"));
    }

    fn run_mock_copy(
        starter: &mut MockStarter,
        pages: &[SelectedPage],
        cancel: &Arc<AtomicBool>,
        render_failure: bool,
    ) -> OpResult<u32> {
        let plans = vec![
            RasterPlan {
                dpi: 300.0,
                width: 1,
                height: 1,
                bytes: 58,
            };
            pages.len()
        ];
        execute_copy(
            starter,
            pages,
            &plans,
            cancel,
            None,
            |_, _| {
                if render_failure {
                    Err(PathOpError::failed("injected render failure"))
                } else {
                    Ok((mock_bitmap(), mock_fit()))
                }
            },
            || {},
        )
    }

    #[test]
    fn lifecycle_cancellation_before_startdoc_creates_no_document() {
        let (mut starter, state) = mock_job(None);
        let cancel = starter.cancel.clone();
        cancel.store(true, Ordering::Relaxed);
        assert!(run_mock_copy(&mut starter, &[selected_page(72.0, 72.0)], &cancel, false).is_err());
        let state = state.lock().unwrap();
        assert_eq!(state.starts, 0);
        assert_eq!(state.aborts, 0);
        assert_eq!(state.finishes, 0);
    }

    #[test]
    fn lifecycle_startdoc_failure_does_not_abort_a_nonexistent_document() {
        let (mut starter, state) = mock_job(Some(MockFailure::StartDocument));
        let cancel = starter.cancel.clone();
        assert!(run_mock_copy(&mut starter, &[selected_page(72.0, 72.0)], &cancel, false).is_err());
        let state = state.lock().unwrap();
        assert_eq!(state.starts, 1);
        assert_eq!(state.aborts, 0);
        assert_eq!(state.finishes, 0);
    }

    #[test]
    fn lifecycle_render_failure_after_startdoc_aborts_once_without_ending_doc() {
        let (mut starter, state) = mock_job(None);
        let cancel = starter.cancel.clone();
        assert!(run_mock_copy(&mut starter, &[selected_page(72.0, 72.0)], &cancel, true).is_err());
        let state = state.lock().unwrap();
        assert_eq!(state.starts, 1);
        assert_eq!(state.aborts, 1);
        assert_eq!(state.page_starts, 0);
        assert_eq!(state.finishes, 0);
    }

    #[test]
    fn lifecycle_cancel_after_draw_aborts_active_document_without_ending_page_or_doc() {
        let (mut starter, state) = mock_job(None);
        state.lock().unwrap().cancel_after_draw = true;
        let cancel = starter.cancel.clone();
        assert!(run_mock_copy(&mut starter, &[selected_page(72.0, 72.0)], &cancel, false).is_err());
        let state = state.lock().unwrap();
        assert_eq!(state.starts, 1);
        assert_eq!(state.page_starts, 1);
        assert_eq!(state.draws, 1);
        assert_eq!(state.page_ends, 0);
        assert_eq!(state.aborts, 1);
        assert_eq!(state.finishes, 0);
    }

    #[test]
    fn lifecycle_cancel_during_render_aborts_before_startpage() {
        let (mut starter, state) = mock_job(None);
        let cancel = starter.cancel.clone();
        let pages = [selected_page(72.0, 72.0)];
        let plans = [RasterPlan {
            dpi: 300.0,
            width: 1,
            height: 1,
            bytes: 58,
        }];
        let result = execute_copy(
            &mut starter,
            &pages,
            &plans,
            &cancel,
            None,
            |_, _| {
                cancel.store(true, Ordering::Relaxed);
                Ok((mock_bitmap(), mock_fit()))
            },
            || {},
        );
        assert!(result.is_err());
        let state = state.lock().unwrap();
        assert_eq!(state.starts, 1);
        assert_eq!(state.page_starts, 0);
        assert_eq!(state.aborts, 1);
        assert_eq!(state.finishes, 0);
    }

    #[test]
    fn lifecycle_cancel_after_endpage_aborts_before_enddoc() {
        let (mut starter, state) = mock_job(None);
        state.lock().unwrap().cancel_after_end_page = true;
        let cancel = starter.cancel.clone();
        assert!(run_mock_copy(&mut starter, &[selected_page(72.0, 72.0)], &cancel, false).is_err());
        let state = state.lock().unwrap();
        assert_eq!(state.starts, 1);
        assert_eq!(state.page_ends, 1);
        assert_eq!(state.aborts, 1);
        assert_eq!(state.finishes, 0);
    }

    #[test]
    fn lifecycle_native_failures_abort_once_and_never_finish_after_failure() {
        for failure in [
            MockFailure::StartPage,
            MockFailure::Draw,
            MockFailure::EndPage,
            MockFailure::Finish,
        ] {
            let (mut starter, state) = mock_job(Some(failure));
            let cancel = starter.cancel.clone();
            assert!(
                run_mock_copy(&mut starter, &[selected_page(72.0, 72.0)], &cancel, false).is_err()
            );
            let state = state.lock().unwrap();
            assert_eq!(state.starts, 1, "{failure:?}");
            assert_eq!(state.aborts, 1, "{failure:?}");
            assert_eq!(state.finishes, 0, "{failure:?}");
        }
    }

    #[test]
    fn lifecycle_cancel_between_copies_does_not_start_another_document() {
        let (mut starter, state) = mock_job(None);
        let cancel = starter.cancel.clone();
        let result = execute_copies(2, &cancel, |copy_index| {
            let count = run_mock_copy(&mut starter, &[selected_page(72.0, 72.0)], &cancel, false)?;
            assert_eq!(copy_index, 0);
            cancel.store(true, Ordering::Relaxed);
            Ok(count)
        });
        assert!(result.is_err());
        let state = state.lock().unwrap();
        assert_eq!(state.starts, 1);
        assert_eq!(state.finishes, 1);
        assert_eq!(state.aborts, 0);
    }

    #[test]
    fn job_devmode_clears_standard_paper_conflicts_and_forces_driver_copies_one() {
        let mut mode = DEVMODEW {
            dmFields: DM_PAPERSIZE
                | DM_PAPERWIDTH
                | DM_PAPERLENGTH
                | DM_FORMNAME
                | DM_DEFAULTSOURCE,
            ..Default::default()
        };
        mode.Anonymous1.Anonymous1.dmOrientation = 2;
        let paper = PaperCapability {
            id: 9,
            width_tenth_mm: 2159,
            height_tenth_mm: 2794,
            form_name: "Letter".to_string(),
            choice: PrintOptionChoice {
                value: "DMPAPER:9".to_string(),
                label: "Letter".to_string(),
            },
        };
        apply_devmode_selection(&mut mode, Some(&paper), Some(3), true);
        assert_eq!(
            mode.dmFields & (DM_PAPERWIDTH | DM_PAPERLENGTH | DM_FORMNAME),
            0
        );
        assert_ne!(mode.dmFields & DM_DEFAULTSOURCE, 0);
        assert_ne!(mode.dmFields & DM_PAPERSIZE, 0);
        unsafe {
            assert_eq!(mode.Anonymous1.Anonymous1.dmCopies, 1);
            assert_eq!(mode.Anonymous1.Anonymous1.dmPaperSize, 9);
            assert_eq!(mode.Anonymous1.Anonymous1.dmDefaultSource, 3);
        }
        unsafe { assert_eq!(mode.Anonymous1.Anonymous1.dmOrientation, 2) };
    }

    #[test]
    fn driver_copy_normalization_accepts_only_consistent_active_values() {
        assert!(normalized_single_copy_is_valid(DM_COPIES, 1, true));
        assert!(!normalized_single_copy_is_valid(0, 1, true));
        assert!(!normalized_single_copy_is_valid(DM_COPIES, 0, true));
        assert!(!normalized_single_copy_is_valid(DM_COPIES, 2, true));

        assert!(normalized_single_copy_is_valid(0, 0, false));
        assert!(normalized_single_copy_is_valid(0, 2, false));
        assert!(normalized_single_copy_is_valid(DM_COPIES, 1, false));
        assert!(!normalized_single_copy_is_valid(DM_COPIES, 0, false));
        assert!(!normalized_single_copy_is_valid(DM_COPIES, 2, false));
    }

    #[test]
    fn input_devmode_omits_unsupported_driver_copy_field() {
        let mut supported = DEVMODEW::default();
        supported.Anonymous1.Anonymous1.dmCopies = 2;
        apply_devmode_selection(&mut supported, None, None, true);
        assert_ne!(supported.dmFields & DM_COPIES, 0);
        unsafe { assert_eq!(supported.Anonymous1.Anonymous1.dmCopies, 1) };

        for inactive_value in [0, 2] {
            let mut unsupported = DEVMODEW {
                dmFields: DM_COPIES,
                ..Default::default()
            };
            unsupported.Anonymous1.Anonymous1.dmCopies = inactive_value;
            apply_devmode_selection(&mut unsupported, None, None, false);
            assert_eq!(unsupported.dmFields & DM_COPIES, 0);
        }
    }

    #[test]
    fn copy_count_jobs_keep_one_full_lifecycle_per_application_copy() {
        let (mut starter, state) = mock_job(None);
        let cancel = starter.cancel.clone();
        let result = execute_copies(3, &cancel, |_| {
            run_mock_copy(&mut starter, &[selected_page(72.0, 72.0)], &cancel, false)
        });
        assert_eq!(result.unwrap(), 3);
        let state = state.lock().unwrap();
        assert_eq!(state.starts, 3);
        assert_eq!(state.page_starts, 3);
        assert_eq!(state.page_ends, 3);
        assert_eq!(state.finishes, 3);
        assert_eq!(state.aborts, 0);
    }

    #[test]
    fn rejected_driver_settings_are_actionable_before_submission() {
        let error = settings_rejected("printer did not preserve the requested paper source");
        assert_eq!(error.code, PRINT_FAILED);
        assert!(error.message.contains("Choose different printer settings"));
        assert!(!error.message.contains("may already have printed"));
    }

    #[test]
    fn custom_devmode_selection_preserves_driver_private_bytes() {
        let standard_size = size_of::<DEVMODEW>();
        let mut buffer = DevModeBuffer::new(standard_size + 64).unwrap();
        let tail = unsafe {
            std::slice::from_raw_parts_mut(
                (buffer.devmode_mut_ptr().cast::<u8>()).add(standard_size),
                64,
            )
        };
        tail.fill(0xA5);
        let paper = PaperCapability {
            id: DMPAPER_USER as u16,
            width_tenth_mm: 1234,
            height_tenth_mm: 2345,
            form_name: "Private custom form".to_string(),
            choice: PrintOptionChoice {
                value: format!("DMPAPER:{}", DMPAPER_USER),
                label: "Private custom form".to_string(),
            },
        };
        let mode = unsafe { &mut *buffer.devmode_mut_ptr() };
        mode.dmSize = standard_size as u16;
        apply_devmode_selection(mode, Some(&paper), Some(4), true);
        assert_ne!(
            mode.dmFields & (DM_PAPERWIDTH | DM_PAPERLENGTH | DM_FORMNAME),
            0
        );
        unsafe {
            assert_eq!(mode.Anonymous1.Anonymous1.dmPaperWidth, 1234);
            assert_eq!(mode.Anonymous1.Anonymous1.dmPaperLength, 2345);
            assert_eq!(mode.Anonymous1.Anonymous1.dmDefaultSource, 4);
            assert_eq!(mode.Anonymous1.Anonymous1.dmCopies, 1);
        }
        assert_eq!(devmode_form_name(mode), "Private custom form");
        let tail_after = unsafe {
            std::slice::from_raw_parts((buffer.devmode_ptr().cast::<u8>()).add(standard_size), 64)
        };
        assert!(tail_after.iter().all(|byte| *byte == 0xA5));
    }

    #[test]
    #[ignore = "read-only probe; run explicitly on Windows with RAIOPDF_WINDOWS_PRINT_PROBE=1"]
    fn readonly_builtin_print_to_pdf_dc_probe() {
        if std::env::var_os("RAIOPDF_WINDOWS_PRINT_PROBE").is_none() {
            return;
        }
        let printer = std::env::var("RAIOPDF_WINDOWS_PRINT_PROBE_PRINTER")
            .unwrap_or_else(|_| "Microsoft Print to PDF".to_string());
        let (media, paper_sources) = query_capabilities(&printer).unwrap();
        assert!(
            !media.is_empty(),
            "built-in PDF driver reported no paper sizes"
        );
        let handle = Printer::open(&printer).unwrap();
        assert!(is_verified_print_to_pdf(handle.0).unwrap());
        let mode = default_devmode(handle.0, &printer).unwrap();
        let dc = DeviceContext::create(&printer, mode.devmode_ptr()).unwrap();
        let printable = printable_area(dc.0).unwrap();
        println!(
            "read-only PDF driver probe: media={}, paper_sources={}, printable={:?}",
            media.len(),
            paper_sources.len(),
            printable
        );
    }

    #[test]
    #[ignore = "prints only to the verified built-in PDF driver; run explicitly with RAIOPDF_WINDOWS_PRINT_CANARY=1"]
    fn opt_in_virtual_pdf_copy_boundary_canary() {
        if std::env::var_os("RAIOPDF_WINDOWS_PRINT_CANARY").is_none() {
            return;
        }
        let input = PathBuf::from(
            std::env::var_os("RAIOPDF_WINDOWS_PRINT_CANARY_INPUT")
                .expect("set RAIOPDF_WINDOWS_PRINT_CANARY_INPUT to a disposable 3-page PDF"),
        );
        let printer = std::env::var("RAIOPDF_WINDOWS_PRINT_CANARY_PRINTER")
            .unwrap_or_else(|_| "Microsoft Print to PDF".to_string());
        let caps = printer_capabilities(&printer).unwrap();
        let printer_handle = Printer::open(&printer).unwrap();
        assert!(is_verified_print_to_pdf(printer_handle.0).unwrap());
        let (media_capabilities, _) = query_capabilities(&printer).unwrap();
        let media_choice = caps
            .media
            .iter()
            .find(|choice| choice.label.to_ascii_lowercase().contains("legal"))
            .expect("virtual PDF driver needs Legal media");
        let media = media_choice.value.clone();
        let paper = selected_paper(Some(&media), &media_capabilities, &caps)
            .unwrap()
            .unwrap();
        let port = printer_port(printer_handle.0).unwrap();
        let default = default_devmode(printer_handle.0, &printer).unwrap();
        let fields = capability_fields(&printer, port.as_ptr(), default.devmode_ptr()).unwrap();
        let mode = configured_devmode(
            printer_handle.0,
            &printer,
            Some(&paper),
            None,
            fields & DM_COPIES != 0,
        )
        .unwrap();
        let dc = DeviceContext::create(&printer, mode.devmode_ptr()).unwrap();
        let physical_width = unsafe { GetDeviceCaps(dc.0, PHYSICALWIDTH as i32) };
        let physical_height = unsafe { GetDeviceCaps(dc.0, PHYSICALHEIGHT as i32) };
        let dpi_x = unsafe { GetDeviceCaps(dc.0, LOGPIXELSX as i32) };
        let dpi_y = unsafe { GetDeviceCaps(dc.0, LOGPIXELSY as i32) };
        let expected_width = physical_width as f64 * 72.0 / dpi_x as f64;
        let expected_height = physical_height as f64 * 72.0 / dpi_y as f64;
        let (print_width, print_height, _, _) = printable_area(dc.0).unwrap();
        let offset_x = unsafe { GetDeviceCaps(dc.0, PHYSICALOFFSETX as i32) };
        let offset_y = unsafe { GetDeviceCaps(dc.0, PHYSICALOFFSETY as i32) };
        // File inspectors use a bottom-left PDF origin; GDI reports the
        // imageable rectangle's top-left offset on the physical sheet.
        let print_x = offset_x as f64 * 72.0 / dpi_x as f64;
        let print_y =
            (physical_height as f64 - offset_y as f64 - print_height as f64) * 72.0 / dpi_y as f64;
        println!(
            "virtual PDF geometry: sheet={expected_width},{expected_height}; printable={print_x},{print_y},{},{}",
            print_width as f64 * 72.0 / dpi_x as f64,
            print_height as f64 * 72.0 / dpi_y as f64
        );

        let root = std::env::temp_dir().join(format!(
            "raiopdf-print-canary-{}-{}",
            std::process::id(),
            SNAPSHOT_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        path_ops::create_private_dir(&root).expect("create private canary output directory");
        let base = root.join("copy-one.pdf");
        let cancel = Arc::new(AtomicBool::new(false));
        let toolchain = PathOpsToolchain::discover(None);
        let result = print_with_options_output(
            &toolchain,
            &input,
            &printer,
            &PrintSelection::Segments(vec![
                PageSegmentRange { first: 2, last: 3 },
                PageSegmentRange { first: 1, last: 1 },
            ]),
            2,
            &PrintOptions {
                media: Some(media),
                ..PrintOptions::default()
            },
            &root,
            &cancel,
            Some(&base),
        )
        .unwrap();
        assert_eq!(result.pages_rendered, 6);
        for output in [&base, &copy_output_path(&base, 1)] {
            assert!(fs::metadata(output).unwrap().len() > 0);
            let facts =
                path_ops::document_facts_print_bounded(&toolchain, output, &cancel).unwrap();
            assert_eq!(
                facts.page_count, 3,
                "each driver job should contain one complete copy"
            );
            for page in facts.pages {
                assert!((page.media_box[2] - page.media_box[0] - expected_width).abs() <= 3.0);
                assert!((page.media_box[3] - page.media_box[1] - expected_height).abs() <= 3.0);
            }
        }
        if std::env::var_os("RAIOPDF_WINDOWS_PRINT_CANARY_KEEP").is_some() {
            println!("preserved virtual PDF canary outputs at {}", root.display());
        } else {
            let _ = fs::remove_dir_all(root);
        }
    }
}
