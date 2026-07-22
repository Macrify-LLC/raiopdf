//! AppKit termination handling that Tauri's cross-platform run loop cannot
//! intercept. Dock Quit and logout ask the `NSApplication` delegate directly,
//! before tao emits its terminal `LoopDestroyed` event.

use std::{mem::transmute, sync::OnceLock};

use objc2::{
    ffi,
    runtime::{AnyObject, Imp, Sel},
    sel, MainThreadMarker,
};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
use tauri::{AppHandle, Wry};

static APP_HANDLE: OnceLock<AppHandle<Wry>> = OnceLock::new();

/// Installs `applicationShouldTerminate:` on tao's active AppKit delegate.
///
/// Tauri/tao owns this delegate and presently exposes no public hook before
/// `applicationWillTerminate:`. Installing the optional AppKit delegate method
/// lets us return `NSTerminateLater`, show the normal unsaved-work dialog, and
/// then resume or cancel the pending system termination.
pub(super) fn install(app: &AppHandle) -> Result<(), String> {
    APP_HANDLE
        .set(app.clone())
        .map_err(|_| "macOS termination guard was installed more than once".to_string())?;

    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "macOS termination guard must install on the main thread".to_string())?;
    let ns_app = NSApplication::sharedApplication(mtm);
    let delegate = ns_app
        .delegate()
        .ok_or_else(|| "macOS application delegate is unavailable".to_string())?;
    let delegate_object = AsRef::<AnyObject>::as_ref(&*delegate);
    let delegate_class = delegate_object.class();

    // `NSApplicationTerminateReply` is an NSUInteger, which is an unsigned
    // 64-bit integer on every supported macOS target. `@:@` is the Objective-C
    // encoding for self, selector, and the NSApplication argument.
    let added = unsafe {
        ffi::class_addMethod(
            delegate_class as *const _ as *mut _,
            sel!(applicationShouldTerminate:),
            transmute::<
                unsafe extern "C-unwind" fn(
                    &AnyObject,
                    Sel,
                    &NSApplication,
                ) -> NSApplicationTerminateReply,
                Imp,
            >(application_should_terminate),
            c"Q@:@".as_ptr(),
        )
    };
    if !added.as_bool() {
        return Err(format!(
            "failed to install applicationShouldTerminate: on {}",
            delegate_class.name().to_string_lossy()
        ));
    }

    Ok(())
}

unsafe extern "C-unwind" fn application_should_terminate(
    _delegate: &AnyObject,
    _selector: Sel,
    _application: &NSApplication,
) -> NSApplicationTerminateReply {
    let Some(app) = APP_HANDLE.get() else {
        // The guard is registered only after the handle is stored. Should the
        // process terminate before setup finishes, preserve normal AppKit
        // behavior rather than leaving it permanently unable to quit.
        return NSApplicationTerminateReply::TerminateNow;
    };

    if super::request_macos_termination(app) {
        NSApplicationTerminateReply::TerminateLater
    } else {
        NSApplicationTerminateReply::TerminateNow
    }
}

/// Completes an AppKit termination decision from the dialog callback, which
/// the dialog plugin intentionally invokes off the main thread.
pub(super) fn reply_to_termination(app: &AppHandle, should_terminate: bool) {
    let _ = app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        NSApplication::sharedApplication(mtm).replyToApplicationShouldTerminate(should_terminate);
    });
}
