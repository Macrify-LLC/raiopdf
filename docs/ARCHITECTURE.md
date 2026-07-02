# RaioPDF Architecture

RaioPDF is a fully local desktop PDF suite. The product is organized around three tiers: a Tauri desktop shell, a bundled Stirling-PDF sidecar, and a bundled OCR toolchain. The shell owns windows, menus, file access, and the React UI. The Stirling sidecar runs on localhost inside the installed app and provides the heavier PDF operations that should stay outside the UI process. The OCR toolchain is bundled alongside the app so searchable-PDF workflows can run without cloud services, accounts, telemetry, or user-managed system dependencies.

The TypeScript workspace starts with a `PdfEngine` seam in `packages/engine-api`. The UI depends on that interface, not on any particular engine implementation. `packages/engine-local` provides the Phase-1 local JavaScript implementation using `pdf-lib`; a future localhost sidecar adapter will satisfy the same interface. That keeps UI workflows stable while implementation details move from pure TypeScript transforms to sidecar-backed operations.

`packages/engine-sidecar` is the second implementation of the `PdfEngine` seam. It is an HTTP client for a localhost Stirling-PDF backend and keeps document bytes client-side behind the same opaque handle pattern as `engine-local`. The UI does not use this package yet; it remains dormant until the engine bundling phase wires the desktop shell to launch and select the sidecar-backed engine.

The UI must never call the Stirling sidecar directly. All document operations go through `PdfEngine` so handles, byte serialization, errors, and future sidecar behavior stay behind one boundary. This also keeps the Tauri shell free to decide how local services are launched, discovered, supervised, and shut down without leaking those mechanics into React components.

Stirling-PDF code may be consumed only from MIT-licensed directories. Do not copy, vendor, adapt, or link code from `frontend/editor/src/desktop`, `app/proprietary`, `app/saas`, `engine/`, or any other carved-out or non-MIT area. If a Stirling source path is not clearly covered by the MIT license grant, treat it as unavailable for RaioPDF.
