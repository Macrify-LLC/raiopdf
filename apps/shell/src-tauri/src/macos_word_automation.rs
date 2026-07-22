//! Native RaioPDF-process Apple Events authorization for Microsoft Word.
//!
//! The conversion helper is `osascript`, but TCC attributes its consent to the
//! caller. Asking through `AEDeterminePermissionToAutomateTarget` here ensures
//! the signed RaioPDF app owns the prompt and, crucially, keeps user think-time
//! outside the conversion helper's deadline.

use engine_sidecar_core::{
    path_ops::PathOpError,
    word_ops::{
        WordAutomationAuthorization, ERR_WORD_AUTOMATION_DENIED, ERR_WORD_AUTOMATION_FAILED,
        ERR_WORD_NOT_SUPPORTED,
    },
};
use std::{
    ffi::c_void,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const NO_ERR: i32 = 0;
const ERR_AE_EVENT_NOT_PERMITTED: i32 = -1743;
const ERR_AE_EVENT_WOULD_REQUIRE_USER_CONSENT: i32 = -1744;
const PROC_NOT_FOUND: i32 = -600;
const TYPE_APPLICATION_BUNDLE_ID: u32 = u32::from_be_bytes(*b"bund");
const CORE_EVENT_CLASS: u32 = u32::from_be_bytes(*b"aevt");
const AE_OPEN_APPLICATION: u32 = u32::from_be_bytes(*b"oapp");
const WORD_BUNDLE_ID: &[u8] = b"com.microsoft.Word";

#[repr(C)]
struct AEAddressDesc {
    descriptor_type: u32,
    data_handle: *mut c_void,
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AECreateDesc(
        descriptor_type: u32,
        data_ptr: *const c_void,
        data_size: i32,
        result: *mut AEAddressDesc,
    ) -> i32;
    fn AEDisposeDesc(desc: *const AEAddressDesc) -> i32;
    fn AEDeterminePermissionToAutomateTarget(
        target: *const AEAddressDesc,
        event_class: u32,
        event_id: u32,
        ask_user_if_needed: u8,
    ) -> i32;
}

/// Read the current RaioPDF -> Word authorization without launching Word or
/// causing a consent prompt. This call is intentionally uncached: a user can
/// change Privacy & Security > Automation while RaioPDF is open.
pub fn current_authorization() -> Result<WordAutomationAuthorization, PathOpError> {
    determine_authorization(false)
}

/// Request consent only at the point the user explicitly begins a conversion.
/// The caller must invoke this before starting the conversion timer.
pub fn require_authorization_for_user_conversion() -> Result<(), PathOpError> {
    let Some(word_bundle) = engine_sidecar_core::word_ops::macos_selected_word_bundle() else {
        return Err(PathOpError {
            code: ERR_WORD_NOT_SUPPORTED,
            message: "Microsoft Word was not found through LaunchServices or /Applications."
                .to_string(),
        });
    };
    launch_cold_word_for_authorization(&word_bundle)?;
    authorization_permits_timed_conversion(wait_for_running_target_authorization()?)
}

/// This decision is intentionally separate from the native prompt. Callers
/// only start the Word helper timer after it returns `Ok`, making the timer
/// handoff observable and testable without exercising TCC in CI.
fn authorization_permits_timed_conversion(
    authorization: WordAutomationAuthorization,
) -> Result<(), PathOpError> {
    match authorization {
        WordAutomationAuthorization::Authorized => Ok(()),
        WordAutomationAuthorization::Denied => Err(PathOpError {
            code: ERR_WORD_AUTOMATION_DENIED,
            message: "RaioPDF is not allowed to control Microsoft Word. Open System Settings > Privacy & Security > Automation, then allow RaioPDF to control Microsoft Word and retry. Retrying alone will not show another prompt.".to_string(),
        }),
        WordAutomationAuthorization::Undetermined => Err(PathOpError {
            code: ERR_WORD_AUTOMATION_FAILED,
            message: "macOS did not finish the Microsoft Word Automation permission request. Approve the RaioPDF prompt, then retry.".to_string(),
        }),
    }
}

fn determine_authorization(
    ask_user_if_needed: bool,
) -> Result<WordAutomationAuthorization, PathOpError> {
    map_authorization_status(determine_authorization_status(ask_user_if_needed)?)
}

fn determine_authorization_status(ask_user_if_needed: bool) -> Result<i32, PathOpError> {
    let mut target = AEAddressDesc {
        descriptor_type: 0,
        data_handle: std::ptr::null_mut(),
    };
    let create_status = unsafe {
        AECreateDesc(
            TYPE_APPLICATION_BUNDLE_ID,
            WORD_BUNDLE_ID.as_ptr().cast(),
            WORD_BUNDLE_ID.len() as i32,
            &mut target,
        )
    };
    if create_status != NO_ERR {
        return Err(authorization_api_error(create_status));
    }
    Ok(unsafe {
        let status = AEDeterminePermissionToAutomateTarget(
            &target,
            CORE_EVENT_CLASS,
            AE_OPEN_APPLICATION,
            u8::from(ask_user_if_needed),
        );
        let _ = AEDisposeDesc(&target);
        status
    })
}

/// `AEDeterminePermissionToAutomateTarget` requires a running target on
/// current macOS releases. LaunchServices gets Word running before this point;
/// wait briefly for that process instead of misclassifying its cold-start
/// `procNotFound` (-600) as a permission denial. The permission prompt itself
/// is still entirely outside the conversion helper's timed section.
fn wait_for_running_target_authorization() -> Result<WordAutomationAuthorization, PathOpError> {
    let started = Instant::now();
    loop {
        let status = determine_authorization_status(true)?;
        if let Some(result) = running_target_handoff(status) {
            return result;
        }
        if started.elapsed() >= Duration::from_secs(15) {
            return Err(PathOpError {
                code: ERR_WORD_AUTOMATION_FAILED,
                message: "Microsoft Word did not become ready for RaioPDF's Automation permission request. Close any Word startup dialog, then retry."
                    .to_string(),
            });
        }
        thread::sleep(Duration::from_millis(100));
    }
}

/// `None` means Word is still cold and no consent decision has been attempted;
/// every other status is the handoff to the timed conversion gate.
fn running_target_handoff(status: i32) -> Option<Result<WordAutomationAuthorization, PathOpError>> {
    (status != PROC_NOT_FOUND).then(|| map_authorization_status(status))
}

fn launch_cold_word_for_authorization(word_bundle: &Path) -> Result<(), PathOpError> {
    let status = Command::new("/usr/bin/open")
        // Do not steal focus while the user is still in RaioPDF. Word may
        // already be open, in which case `open` simply leaves it alone.
        .arg("-g")
        .arg(word_bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| PathOpError {
            code: ERR_WORD_AUTOMATION_FAILED,
            message: format!("could not launch Microsoft Word for Automation permission: {error}"),
        })?;
    if status.success() {
        Ok(())
    } else {
        Err(PathOpError {
            code: ERR_WORD_AUTOMATION_FAILED,
            message: "macOS could not launch the selected Microsoft Word installation for Automation permission."
                .to_string(),
        })
    }
}

fn map_authorization_status(status: i32) -> Result<WordAutomationAuthorization, PathOpError> {
    match status {
        NO_ERR => Ok(WordAutomationAuthorization::Authorized),
        ERR_AE_EVENT_NOT_PERMITTED => Ok(WordAutomationAuthorization::Denied),
        ERR_AE_EVENT_WOULD_REQUIRE_USER_CONSENT => Ok(WordAutomationAuthorization::Undetermined),
        // A no-prompt probe is allowed to see Word closed. We deliberately
        // expose that as undetermined rather than launching Word from a
        // settings/status check; user-initiated conversion handles the cold
        // target with `launch_cold_word_for_authorization` above.
        PROC_NOT_FOUND => Ok(WordAutomationAuthorization::Undetermined),
        other => Err(authorization_api_error(other)),
    }
}

fn authorization_api_error(status: i32) -> PathOpError {
    PathOpError {
        code: ERR_WORD_AUTOMATION_FAILED,
        message: format!(
            "macOS could not determine RaioPDF's Microsoft Word Automation permission (OSStatus {status})."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apple_event_status_mapping_is_explicit_and_ci_safe() {
        assert_eq!(
            map_authorization_status(NO_ERR).unwrap(),
            WordAutomationAuthorization::Authorized
        );
        assert_eq!(
            map_authorization_status(ERR_AE_EVENT_NOT_PERMITTED).unwrap(),
            WordAutomationAuthorization::Denied
        );
        assert_eq!(
            map_authorization_status(ERR_AE_EVENT_WOULD_REQUIRE_USER_CONSENT).unwrap(),
            WordAutomationAuthorization::Undetermined
        );
        assert_eq!(
            map_authorization_status(PROC_NOT_FOUND).unwrap(),
            WordAutomationAuthorization::Undetermined
        );
        let error = map_authorization_status(-50).unwrap_err();
        assert_eq!(error.code, ERR_WORD_AUTOMATION_FAILED);
        assert!(error.message.contains("OSStatus -50"));
    }

    #[test]
    fn consent_resolution_happens_before_the_timed_conversion_handoff() {
        assert!(
            authorization_permits_timed_conversion(WordAutomationAuthorization::Authorized).is_ok()
        );
        let denied = authorization_permits_timed_conversion(WordAutomationAuthorization::Denied)
            .unwrap_err();
        assert_eq!(denied.code, ERR_WORD_AUTOMATION_DENIED);
        let undetermined =
            authorization_permits_timed_conversion(WordAutomationAuthorization::Undetermined)
                .unwrap_err();
        assert_eq!(undetermined.code, ERR_WORD_AUTOMATION_FAILED);
    }

    #[test]
    fn cold_word_is_waited_for_before_permission_or_conversion_handoff() {
        assert!(running_target_handoff(PROC_NOT_FOUND).is_none());
        assert_eq!(
            running_target_handoff(NO_ERR).unwrap().unwrap(),
            WordAutomationAuthorization::Authorized
        );
        assert_eq!(
            running_target_handoff(ERR_AE_EVENT_NOT_PERMITTED)
                .unwrap()
                .unwrap(),
            WordAutomationAuthorization::Denied
        );
    }
}
