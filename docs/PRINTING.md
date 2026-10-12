# Desktop printing

The desktop print dialog queries paper sizes and paper sources for the selected
printer. Choices apply to one job. Printer default omits the override; a
source is selectable only when the queue or driver advertises it. Changing
printers clears paper choices, and submission rechecks explicit choices so a
removed printer option produces an error rather than a silent substitution.

On macOS, the dialog retains sides and orientation controls. CUPS receives
advertised `PageSize` and `InputSlot` tokens, with existing `sides` and
`orientation-requested` options. Page ranges follow CUPS's ascending document
order, and copies/collation follow queue semantics. Printer discovery failure
still allows default paper settings.

On Windows, jobs with default options retain the existing Ghostscript
`mswinpr2` path and divide-and-queue `printto` fallback. An explicit paper size
or source uses a job-local, driver-normalized DEVMODE and GDI document. It
preserves the driver's duplex, orientation, color and other defaults, forces
driver copies to one, and submits one whole document per requested copy. It
never falls back to a path that discards the selected settings. No `SetPrinter`
call changes global preferences.

Windows explicit-option jobs rasterize one page at a time from a private file
snapshot, fitting the visible CropBox/MediaBox intersection proportionally into
the printer's printable area. An absent CropBox uses MediaBox. PDF rotation is
honored once; the driver controls paper orientation. Raster resolution targets
300 DPI on the printed
page, adjusting for enlargement or reduction, limited by driver resolution and
a 256 MiB bitmap ceiling. Oversize printer forms that cannot fit at 150 DPI
fail before submission. PDFs with unsupported page units, numerically unstable
page coordinates, or malformed, reversed, empty or disjoint page boxes produce
an error before rendering;
printing is stricter than the viewer's recovery for malformed boxes. Output
raster and application bitmap buffers are capped; PDF-interpreter content
processing and vendor spool memory have separate costs. Cancellation is cooperative
inside synchronous driver calls. Once a document starts, a failure or cancel
may leave pages already submitted; check the output before retrying.

Automatic per-page mixed-media selection, arbitrary custom paper dimensions,
and every vendor-specific setting are outside these controls. A virtual printer
can verify job settings and output geometry; hardware drawer feeding requires
the relevant driver and printer.
