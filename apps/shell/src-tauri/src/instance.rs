//! Per-process instance identity and cross-process liveness.
//!
//! RaioPDF is deliberately multi-process — "Open in New Window" spawns a
//! sibling process, and the installer's `.pdf` file association launches a new
//! process per double-click — yet several pieces of shared app-data state
//! (path-op temp dirs, session crash markers) need to know whether the process
//! that created them is still running.
//!
//! The mechanism: at startup each instance creates
//! `<app-data>/instances/<uuid>.lock` and holds a non-blocking **exclusive
//! advisory lock** (fs2: `LockFileEx` on Windows, `flock` on Unix) on it for
//! its entire lifetime. The OS releases the lock when the process ends —
//! cleanly, by crash, or by kill — so "can this file be exclusively locked?"
//! is a dependable owner-is-dead test with none of the PID-reuse hazards of
//! recording process ids. Lock files of dead instances are reclaimed by the
//! startup sweep.
//!
//! Ordering contract: an instance acquires its identity **before** writing any
//! state stamped with its id (owner markers, session markers). A reader that
//! can see the id therefore knows the lock already existed when the id was
//! recorded, which is what makes the try-lock probe race-free against
//! instances that are just starting up.

use fs2::FileExt;
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::OnceLock,
};
use uuid::Uuid;

/// Directory under app data holding one held-open lock file per live instance.
pub const INSTANCES_DIR: &str = "instances";
const LOCK_EXTENSION: &str = "lock";

pub struct InstanceIdentity {
    id: String,
    /// Held open and exclusively locked for the lifetime of the process. The
    /// OS releases the lock on process exit however that exit happens, which
    /// is the whole liveness mechanism — never drop this early.
    _lock_file: fs::File,
}

impl InstanceIdentity {
    pub fn acquire(app_data_dir: &Path) -> io::Result<Self> {
        let dir = instances_dir(app_data_dir);
        fs::create_dir_all(&dir)?;
        let id = Uuid::new_v4().to_string();
        let file = fs::OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(lock_path(&dir, &id))?;
        // `create_new` plus a fresh UUID means no other process can already
        // hold this lock; a failure here is a filesystem oddity, surfaced so
        // callers degrade to "no identity" instead of lying about liveness.
        file.try_lock_exclusive()?;
        Ok(Self {
            id,
            _lock_file: file,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }
}

static CURRENT: OnceLock<Option<InstanceIdentity>> = OnceLock::new();

/// Acquire (once) the identity for this process. Returns `None` when the lock
/// file could not be created or locked — consumers degrade gracefully: state
/// written without an owner id is treated as unowned and eventually reclaimed.
pub fn init_current(app_data_dir: &Path) -> Option<&'static InstanceIdentity> {
    CURRENT
        .get_or_init(|| InstanceIdentity::acquire(app_data_dir).ok())
        .as_ref()
}

/// The identity acquired by [`init_current`], if any. Never initializes.
pub fn current() -> Option<&'static InstanceIdentity> {
    CURRENT.get().and_then(Option::as_ref)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Liveness {
    Alive,
    Dead,
    /// Could not be determined — sweepers must treat this as alive.
    Unknown,
}

/// Is the instance that recorded `owner_id` still running?
///
/// An instance's lock file exists (locked) for its whole lifetime, so a
/// missing lock file means the owner is gone — either it never managed to
/// create one (in which case it never handed out its id) or the file was
/// reclaimed after it died. A present lock file is probed with a non-blocking
/// exclusive lock: acquirable ⇒ no process holds it ⇒ owner dead.
pub fn owner_liveness(app_data_dir: &Path, owner_id: &str) -> Liveness {
    if !is_valid_owner_id(owner_id) {
        return Liveness::Unknown;
    }
    lock_file_liveness(&lock_path(&instances_dir(app_data_dir), owner_id))
}

/// Remove lock files whose owning instance is dead. Live (and undecidable)
/// locks are left alone. Best-effort housekeeping run by the startup sweep.
pub fn sweep_dead_instance_locks(app_data_dir: &Path) {
    let Ok(entries) = fs::read_dir(instances_dir(app_data_dir)) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some(LOCK_EXTENSION) {
            continue;
        }
        if lock_file_liveness(&path) == Liveness::Dead {
            let _ = fs::remove_file(&path);
        }
    }
}

/// Owner ids are UUIDs minted by this module; anything else (or anything that
/// could traverse paths) is rejected before it is ever joined into a path.
pub fn is_valid_owner_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn instances_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(INSTANCES_DIR)
}

fn lock_path(instances_dir: &Path, id: &str) -> PathBuf {
    instances_dir.join(format!("{id}.{LOCK_EXTENSION}"))
}

fn lock_file_liveness(path: &Path) -> Liveness {
    match fs::OpenOptions::new().read(true).write(true).open(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Liveness::Dead,
        Err(_) => Liveness::Unknown,
        // Dropping the probe handle releases the probe lock.
        Ok(file) => match file.try_lock_exclusive() {
            Ok(()) => Liveness::Dead,
            Err(_) => Liveness::Alive,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // NOTE: tests construct identities via `InstanceIdentity::acquire`
    // directly and never call `init_current` — the process-global `CURRENT`
    // slot must stay unset so unrelated tests keep deterministic behavior.

    #[test]
    fn owner_is_dead_when_no_lock_file_exists() {
        let root = tempfile::tempdir().expect("temp dir");

        assert_eq!(
            owner_liveness(root.path(), "0000-never-existed"),
            Liveness::Dead
        );
    }

    #[test]
    fn owner_is_alive_while_identity_held_and_dead_after_drop() {
        let root = tempfile::tempdir().expect("temp dir");
        let identity = InstanceIdentity::acquire(root.path()).expect("acquire");
        let id = identity.id().to_string();

        // Both fs2 backends (LockFileEx / flock on separate descriptors)
        // detect the conflict even from within the same process.
        assert_eq!(owner_liveness(root.path(), &id), Liveness::Alive);

        drop(identity);
        assert_eq!(owner_liveness(root.path(), &id), Liveness::Dead);
    }

    #[test]
    fn invalid_owner_ids_are_unknown_not_dead() {
        let root = tempfile::tempdir().expect("temp dir");

        assert_eq!(owner_liveness(root.path(), ""), Liveness::Unknown);
        assert_eq!(owner_liveness(root.path(), "../escape"), Liveness::Unknown);
        assert_eq!(
            owner_liveness(root.path(), "id with spaces"),
            Liveness::Unknown
        );
    }

    #[test]
    fn sweep_removes_only_dead_instance_locks() {
        let root = tempfile::tempdir().expect("temp dir");
        let live = InstanceIdentity::acquire(root.path()).expect("acquire live");
        let dead = InstanceIdentity::acquire(root.path()).expect("acquire dead");
        let live_lock = instances_dir(root.path()).join(format!("{}.lock", live.id()));
        let dead_lock = instances_dir(root.path()).join(format!("{}.lock", dead.id()));
        drop(dead);

        sweep_dead_instance_locks(root.path());

        assert!(live_lock.exists());
        assert!(!dead_lock.exists());
    }
}
