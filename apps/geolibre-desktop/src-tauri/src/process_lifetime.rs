//! OS-enforced child process lifetimes so sidecars (FastAPI, Jupyter, Martin)
//! are automatically reaped by the kernel if GeoLibre crashes or is killed.
//!
//! - Linux: sets `PR_SET_PDEATHSIG(SIGTERM)` via `CommandExt::pre_exec` and
//!   verifies the parent PID immediately after `fork` to close the race window.
//! - Windows: assigns every spawned child to a Win32 Job Object configured with
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.

use std::process::{Child, Command};

/// Configure `command` so the OS signals the child if this parent process dies.
#[cfg(all(target_os = "linux", not(feature = "mas")))]
pub(crate) fn configure_child_pdeathsig(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    const PR_SET_PDEATHSIG: i32 = 1;
    const SIGTERM: i32 = 15;

    unsafe extern "C" {
        fn prctl(option: i32, arg2: usize, arg3: usize, arg4: usize, arg5: usize) -> i32;
        fn getppid() -> i32;
        fn getpid() -> i32;
        fn kill(pid: i32, sig: i32) -> i32;
    }

    let parent_pid = std::process::id() as i32;
    // SAFETY: `pre_exec` runs between `fork` and `exec`. `prctl`, `getppid`,
    // `getpid`, and `kill` are async-signal-safe syscalls and perform no
    // heap allocation or Rust locking.
    unsafe {
        command.pre_exec(move || {
            let _ = prctl(PR_SET_PDEATHSIG, SIGTERM as usize, 0, 0, 0);
            // Close the race window where the parent died between fork() and
            // prctl(): if we were already reparented, terminate ourselves now.
            if getppid() != parent_pid {
                let _ = kill(getpid(), SIGTERM);
            }
            Ok(())
        });
    }
}

#[cfg(all(not(target_os = "linux"), not(feature = "mas")))]
pub(crate) fn configure_child_pdeathsig(_command: &mut Command) {}

/// Holds an OS-level process lifetime handle (a Win32 Job Object on Windows)
/// that kills every assigned child process when closed or when this process
/// terminates unexpectedly.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
pub(crate) struct ChildProcessJob {
    handle: isize,
}

// Win32 Job Object handles are kernel handles safe to share across threads.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
unsafe impl Send for ChildProcessJob {}
#[cfg(all(target_os = "windows", not(feature = "mas")))]
unsafe impl Sync for ChildProcessJob {}

#[cfg(all(target_os = "windows", not(feature = "mas")))]
impl Default for ChildProcessJob {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(all(target_os = "windows", not(feature = "mas")))]
impl ChildProcessJob {
    pub(crate) fn new() -> Self {
        use std::mem::{size_of, zeroed};
        use std::ptr::{null, null_mut};
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        unsafe {
            let handle = CreateJobObjectW(null(), null());
            if handle.is_null() {
                return Self { handle: 0 };
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&mut info as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                let _ = CloseHandle(handle);
                return Self { handle: 0 };
            }
            let _ = null_mut::<std::ffi::c_void>();
            Self {
                handle: handle as isize,
            }
        }
    }

    /// Assign a newly spawned `child` to this Job Object so Windows reaps it
    /// automatically if the parent exits or crashes.
    pub(crate) fn assign_child(&self, child: &Child) {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

        if self.handle == 0 {
            return;
        }
        unsafe {
            let _ = AssignProcessToJobObject(
                self.handle as windows_sys::Win32::Foundation::HANDLE,
                child.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE,
            );
        }
    }
}

#[cfg(all(target_os = "windows", not(feature = "mas")))]
impl Drop for ChildProcessJob {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;

        if self.handle != 0 {
            unsafe {
                let _ = CloseHandle(self.handle as windows_sys::Win32::Foundation::HANDLE);
            }
            self.handle = 0;
        }
    }
}

#[cfg(all(not(target_os = "windows"), not(feature = "mas")))]
#[derive(Default)]
pub(crate) struct ChildProcessJob;

#[cfg(all(not(target_os = "windows"), not(feature = "mas")))]
impl ChildProcessJob {
    pub(crate) fn assign_child(&self, _child: &Child) {}
}

/// Assign a spawned child process to the process-wide OS lifetime Job Object
/// (on Windows; no-op on Unix where `PR_SET_PDEATHSIG` enforces parent death).
#[cfg(not(feature = "mas"))]
pub(crate) fn assign_child_to_job(child: &Child) {
    static GLOBAL_JOB: std::sync::OnceLock<ChildProcessJob> = std::sync::OnceLock::new();
    GLOBAL_JOB.get_or_init(ChildProcessJob::default).assign_child(child);
}

#[cfg(all(test, not(feature = "mas")))]
mod tests {
    use super::*;

    #[test]
    fn configure_child_pdeathsig_and_job_assignment_succeed() {
        let job = ChildProcessJob::default();
        #[cfg(unix)]
        let mut cmd = Command::new("true");
        #[cfg(windows)]
        let mut cmd = {
            let mut c = Command::new("cmd");
            c.args(["/C", "exit", "0"]);
            c
        };
        configure_child_pdeathsig(&mut cmd);
        let mut child = cmd.spawn().expect("spawn test child");
        job.assign_child(&child);
        let status = child.wait().expect("wait test child");
        assert!(status.success());
    }
}
