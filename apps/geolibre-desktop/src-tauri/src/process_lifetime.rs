//! OS-enforced child process lifetimes so sidecars (FastAPI, Jupyter, Martin)
//! are automatically reaped by the kernel if GeoLibre crashes or is killed.
//!
//! - Linux: spawns children from a dedicated long-lived supervisor thread that
//!   sets `PR_SET_PDEATHSIG(SIGTERM)` via `CommandExt::pre_exec` and verifies
//!   the parent PID immediately after `fork`. Spawning from a permanent thread
//!   (instead of a Tokio `spawn_blocking` worker that may retire when idle)
//!   ensures the kernel only signals the child when the GeoLibre process exits.
//! - Windows: assigns every spawned child to a Win32 Job Object configured with
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` immediately after spawn, logging a
//!   warning and allowing startup to proceed if job creation or assignment
//!   fails in a restricted environment. Note that `std::process::Command::spawn`
//!   does not expose the primary thread handle for `CREATE_SUSPENDED` +
//!   `ResumeThread`, so a narrow window exists between process creation and job
//!   assignment.

use std::process::{Child, Command};

#[cfg(all(target_os = "linux", not(feature = "mas")))]
mod linux_supervisor {
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command};
    use std::sync::{mpsc, OnceLock};

    struct SpawnRequest {
        command: Command,
        reply: mpsc::SyncSender<std::io::Result<Child>>,
    }

    fn supervisor_tx() -> &'static mpsc::Sender<SpawnRequest> {
        static TX: OnceLock<mpsc::Sender<SpawnRequest>> = OnceLock::new();
        TX.get_or_init(|| {
            let (tx, rx) = mpsc::channel::<SpawnRequest>();
            std::thread::Builder::new()
                .name("geolibre-child-supervisor".to_string())
                .spawn(move || {
                    const PR_SET_PDEATHSIG: i32 = 1;
                    const SIGTERM: i32 = 15;

                    unsafe extern "C" {
                        fn prctl(
                            option: i32,
                            arg2: usize,
                            arg3: usize,
                            arg4: usize,
                            arg5: usize,
                        ) -> i32;
                        fn getppid() -> i32;
                        fn getpid() -> i32;
                        fn kill(pid: i32, sig: i32) -> i32;
                    }

                    while let Ok(mut req) = rx.recv() {
                        let parent_pid = std::process::id() as i32;
                        // SAFETY: `pre_exec` runs between `fork` and `exec` on this
                        // long-lived supervisor thread. `prctl`, `getppid`, `getpid`,
                        // and `kill` are async-signal-safe syscalls and perform no
                        // heap allocation or Rust locking.
                        unsafe {
                            req.command.pre_exec(move || {
                                let _ = prctl(PR_SET_PDEATHSIG, SIGTERM as usize, 0, 0, 0);
                                if getppid() != parent_pid {
                                    let _ = kill(getpid(), SIGTERM);
                                }
                                Ok(())
                            });
                        }
                        let result = req.command.spawn();
                        let _ = req.reply.send(result);
                    }
                })
                .expect("failed to spawn geolibre child supervisor thread");
            tx
        })
    }

    pub(super) fn spawn(command: Command) -> Result<Child, String> {
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        supervisor_tx()
            .send(SpawnRequest {
                command,
                reply: reply_tx,
            })
            .map_err(|_| "Child supervisor thread is unavailable".to_string())?;
        reply_rx
            .recv()
            .map_err(|_| "Child supervisor thread terminated unexpectedly".to_string())?
            .map_err(|error| error.to_string())
    }
}

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
        use std::ptr::null;
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
            Self {
                handle: handle as isize,
            }
        }
    }

    /// Assign a newly spawned `child` to this Job Object so Windows reaps it
    /// automatically if the parent exits or crashes.
    pub(crate) fn assign_child(&self, child: &Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::GetLastError;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

        if self.handle == 0 {
            return Err("Win32 Job Object handle could not be initialized".to_string());
        }
        let ok = unsafe {
            AssignProcessToJobObject(
                self.handle as windows_sys::Win32::Foundation::HANDLE,
                child.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE,
            )
        };
        if ok == 0 {
            let err = unsafe { GetLastError() };
            return Err(format!(
                "Could not assign child process to Win32 Job Object (error {err})"
            ));
        }
        Ok(())
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

/// Assign a spawned child process to the process-wide OS lifetime Job Object on Windows.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
pub(crate) fn assign_child_to_job(child: &Child) -> Result<(), String> {
    static GLOBAL_JOB: std::sync::OnceLock<ChildProcessJob> = std::sync::OnceLock::new();
    GLOBAL_JOB
        .get_or_init(ChildProcessJob::default)
        .assign_child(child)
}

/// Spawn a managed child process with OS-enforced lifetime protection.
///
/// - On Linux, the spawn is dispatched through a permanent supervisor thread
///   that configures `PR_SET_PDEATHSIG(SIGTERM)` so retiring worker threads do
///   not prematurely kill long-running sidecar processes.
/// - On Windows, the child is assigned to the process-wide Job Object; if
///   assignment fails, a warning is logged and the child is allowed to continue
///   so restricted environments without Job Object permissions still work.
#[cfg(not(feature = "mas"))]
pub(crate) fn spawn_managed_child(mut command: Command) -> Result<Child, String> {
    #[cfg(target_os = "linux")]
    let child = {
        let _ = &mut command;
        linux_supervisor::spawn(command)?
    };
    #[cfg(not(target_os = "linux"))]
    let mut child = command.spawn().map_err(|error| error.to_string())?;

    #[cfg(target_os = "windows")]
    if let Err(error) = assign_child_to_job(&child) {
        // Log and continue rather than killing the child so restricted Windows
        // environments where Job Objects cannot be created/assigned still run.
        eprintln!("[GeoLibre] Could not attach child process to Win32 Job Object: {error}");
    }

    Ok(child)
}

#[cfg(all(test, not(feature = "mas")))]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn managed_child_survives_exiting_caller_thread() {
        // Spawn a sleeping child from a short-lived worker thread (simulating a
        // Tokio `spawn_blocking` worker that retires after idle keep-alive).
        // Because Linux delegates spawning to the permanent supervisor thread,
        // the child must remain alive after the worker thread exits.
        let mut child = std::thread::spawn(|| {
            #[cfg(unix)]
            let cmd = {
                let mut c = Command::new("sleep");
                c.arg("5");
                c
            };
            #[cfg(windows)]
            let cmd = {
                let mut c = Command::new("ping");
                c.args(["-n", "6", "127.0.0.1"]);
                c
            };
            spawn_managed_child(cmd).expect("spawn managed child")
        })
        .join()
        .expect("worker thread finished");

        std::thread::sleep(Duration::from_millis(150));
        assert!(
            child.try_wait().expect("poll child").is_none(),
            "managed child must survive after the calling worker thread exits"
        );
        let _ = child.kill();
        let _ = child.wait();
    }
}
