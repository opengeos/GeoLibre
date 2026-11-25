//! Managed child processes (the sidecar, Jupyter and Martin servers): output
//! capture for failure reports, AppImage environment cleanup, process-group
//! and console setup, and termination. Compiled out of the Mac App Store
//! build, which spawns no child processes.

use std::collections::VecDeque;
use std::env;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(all(unix, not(feature = "mas")))]
pub(crate) const SIGTERM: i32 = 15;
#[cfg(all(unix, not(feature = "mas")))]
pub(crate) const SIGKILL: i32 = 9;

#[cfg(all(unix, not(feature = "mas")))]
unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

// Append the tail of a managed child's output to a failure summary. That output
// is the only thing that identifies *why* startup failed (a uv resolution error,
// a missing `jupyter` executable, a port conflict...), and in an installed build
// there is no terminal to read it from, so it has to travel with the error.
// Shared by the Jupyter, sidecar and Martin waiters, and by both of their
// failure paths (early exit and timeout), so no path can quietly drop the one
// useful detail.
#[cfg(not(feature = "mas"))]
pub(crate) fn child_failure_message(summary: &str, output: &CapturedOutput) -> String {
    // The child may have only just exited, with its last lines still in flight.
    output.settle();
    let tail = output.tail();
    if tail.is_empty() {
        format!("{summary} It produced no output.")
    } else {
        format!("{summary}\n\nLast output:\n{tail}")
    }
}

// How many trailing output lines a captured child keeps, and how many of them a
// failure message quotes. The log is a ring buffer so a chatty child (uv sync +
// JupyterLab startup write hundreds of lines) can never grow without bound, and
// the tail is what matters: the error that killed the process is at the end.
#[cfg(not(feature = "mas"))]
pub(crate) const CAPTURED_LOG_MAX_LINES: usize = 200;
#[cfg(not(feature = "mas"))]
pub(crate) const CAPTURED_LOG_REPORTED_LINES: usize = 20;
// How long a failure report waits for the reader threads to reach EOF before
// quoting what they have. `try_wait` reports the exit as soon as the process is
// reaped, which can be before the readers have consumed the last lines still
// sitting in the pipe — and those last lines are the error itself. Waiting is
// necessarily *bounded*: `uv` spawns `jupyter`, which spawns kernels that
// inherit these same pipe handles, so a grandchild outliving the child keeps the
// write end open and EOF never arrives. An unbounded join would hang the Tauri
// command forever, which is worse than a truncated tail.
#[cfg(not(feature = "mas"))]
pub(crate) const CAPTURED_LOG_SETTLE: Duration = Duration::from_millis(500);
#[cfg(not(feature = "mas"))]
const CAPTURED_LOG_SETTLE_POLL: Duration = Duration::from_millis(10);

/// The trailing output of a spawned child, drained on background threads.
///
/// `Stdio::piped()` alone is not enough for a child we only poll for health: an
/// undrained OS pipe fills at ~64 KB and blocks the writer forever, so a chatty
/// child would hang instead of becoming ready. These readers consume both
/// streams continuously, keep the last `CAPTURED_LOG_MAX_LINES` in memory, and
/// echo each line to the parent's own stdio so a dev terminal still shows the
/// live log.
#[cfg(not(feature = "mas"))]
#[derive(Clone)]
pub(crate) struct CapturedOutput {
    lines: Arc<Mutex<VecDeque<String>>>,
    // Reader threads that have not yet seen EOF. Drives `settle`.
    draining: Arc<AtomicUsize>,
}

#[cfg(not(feature = "mas"))]
impl CapturedOutput {
    pub(crate) fn new() -> Self {
        Self {
            lines: Arc::new(Mutex::new(VecDeque::with_capacity(CAPTURED_LOG_MAX_LINES))),
            draining: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Take the child's piped stdout/stderr and start draining them.
    pub(crate) fn attach(child: &mut Child) -> Self {
        let captured = Self::new();
        if let Some(stdout) = child.stdout.take() {
            captured.drain(stdout, false);
        }
        if let Some(stderr) = child.stderr.take() {
            captured.drain(stderr, true);
        }
        captured
    }

    pub(crate) fn drain<R>(&self, stream: R, is_stderr: bool)
    where
        R: Read + Send + 'static,
    {
        let captured = self.clone();
        // Registered before the thread starts, so a `settle` racing the spawn
        // still sees this reader as outstanding.
        self.draining.fetch_add(1, Ordering::SeqCst);
        // Detached: the thread ends on its own when the pipe closes at child
        // exit. `settle` waits on the counter rather than a JoinHandle so the
        // wait can be bounded (see CAPTURED_LOG_SETTLE).
        thread::spawn(move || {
            let mut reader = BufReader::new(stream);
            loop {
                let mut bytes = Vec::new();
                match reader.read_until(b'\n', &mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                // Match BufRead::lines' newline handling, but a child's
                // locale-specific bytes must never stop draining its pipe.
                if bytes.last() == Some(&b'\n') {
                    bytes.pop();
                    if bytes.last() == Some(&b'\r') {
                        bytes.pop();
                    }
                }
                let line = String::from_utf8(bytes)
                    .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned());
                // Tee to the parent's stdio. In a dev terminal this preserves
                // the old inherit-style live log; in a bundled GUI build (no
                // console on Windows) it is simply discarded.
                if is_stderr {
                    let _ = writeln!(std::io::stderr(), "{line}");
                } else {
                    let _ = writeln!(std::io::stdout(), "{line}");
                }
                captured.push(line);
            }
            captured.draining.fetch_sub(1, Ordering::SeqCst);
        });
    }

    /// Give the reader threads a bounded moment to reach EOF, so a report made
    /// right after `try_wait` sees the child's final lines instead of racing
    /// them. Returns early once every reader is done; otherwise gives up at
    /// `CAPTURED_LOG_SETTLE` and lets the caller quote a partial tail.
    pub(crate) fn settle(&self) {
        let deadline = CAPTURED_LOG_SETTLE.as_millis() / CAPTURED_LOG_SETTLE_POLL.as_millis();
        for _ in 0..deadline {
            if self.draining.load(Ordering::SeqCst) == 0 {
                return;
            }
            thread::sleep(CAPTURED_LOG_SETTLE_POLL);
        }
    }

    /// Record one line, evicting the oldest once the ring buffer is full.
    pub(crate) fn push(&self, line: String) {
        let Ok(mut lines) = self.lines.lock() else {
            return;
        };
        while lines.len() >= CAPTURED_LOG_MAX_LINES {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    /// The last few captured lines, blank-trimmed, for an error message.
    /// Empty when the child produced no output at all.
    pub(crate) fn tail(&self) -> String {
        let Ok(lines) = self.lines.lock() else {
            return String::new();
        };
        let start = lines.len().saturating_sub(CAPTURED_LOG_REPORTED_LINES);
        lines
            .iter()
            .skip(start)
            .map(|line| line.trim_end())
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// The AppImage mount root, when running from an AppImage. `APPDIR` is exported
/// by AppRun and is the prefix of everything it injects.
#[cfg(not(feature = "mas"))]
fn appimage_dir() -> Option<String> {
    env::var("APPDIR").ok().filter(|dir| !dir.is_empty())
}

/// Read a `PATH`-style variable with any entry that points inside the AppImage
/// mount removed. Returns `None` when the variable is unset or every entry was
/// an AppDir entry (so the caller unsets it rather than passing an empty value).
/// Outside an AppImage the value is returned untouched.
#[cfg(not(feature = "mas"))]
pub(crate) fn appdir_free_path_var(name: &str) -> Option<String> {
    let value = env::var(name).ok()?;
    let Some(appdir) = appimage_dir() else {
        return Some(value);
    };
    let sep = if cfg!(windows) { ';' } else { ':' };
    let kept: Vec<&str> = value
        .split(sep)
        .filter(|entry| !entry.is_empty() && !entry.starts_with(appdir.as_str()))
        .collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept.join(&sep.to_string()))
    }
}

/// Undo the environment an AppImage forces on every child process.
///
/// AppImageKit's AppRun exports a fixed set of variables so the bundled GUI can
/// find its own libraries, including:
///
/// ```text
/// PYTHONHOME=$APPDIR/usr/
/// PYTHONPATH=$APPDIR/usr/share/pyshared/:$PYTHONPATH
/// LD_LIBRARY_PATH=$APPDIR/usr/lib/:…:$LD_LIBRARY_PATH
/// ```
///
/// They leak into everything we spawn. `PYTHONHOME` is the fatal one: a Python
/// that honours it looks for its standard library under the AppImage mount,
/// finds no `encodings` module, and aborts with "Failed to import encodings
/// module" before executing a line of code. That killed `uv`'s build backend —
/// and so the Notebook panel and the sidecar — in every AppImage build, while
/// the .deb/.rpm (which have no AppRun) were unaffected.
///
/// We never want an inherited `PYTHONHOME`: the interpreter is chosen by uv and
/// the project environment we point it at, so drop it unconditionally rather
/// than only under an AppImage. The two search paths keep any entries the user
/// legitimately set and lose only the AppDir ones.
#[cfg(not(feature = "mas"))]
pub(crate) fn clear_appimage_python_env(command: &mut Command) {
    command.env_remove("PYTHONHOME");
    for name in ["LD_LIBRARY_PATH", "PYTHONPATH"] {
        // The Jupyter launch sets its own PYTHONPATH (already AppDir-free, via
        // prepend_pythonpath) before this runs, and overwriting it here would
        // drop the notebook-lib directory that makes `import geolibre` work.
        if command
            .get_envs()
            .any(|(key, value)| key == OsStr::new(name) && value.is_some())
        {
            continue;
        }
        match appdir_free_path_var(name) {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        };
    }
}

#[cfg(not(feature = "mas"))]
pub(crate) fn configure_sidecar_process(command: &mut Command) {
    // Both callers (the sidecar and Jupyter launches) run Python through uv.
    clear_appimage_python_env(command);
    configure_sidecar_process_impl(command);
}

#[cfg(all(unix, not(feature = "mas")))]
fn configure_sidecar_process_impl(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(all(not(unix), not(feature = "mas")))]
fn configure_sidecar_process_impl(command: &mut Command) {
    hide_console_window(command);
}

/// Keep a spawned console program from opening a console window.
///
/// Release builds are GUI-subsystem (`windows_subsystem = "windows"`), so they
/// have no console of their own. Spawning `uv.exe` (a console program) then
/// makes Windows allocate a fresh console *window* for it, which appears on the
/// user's desktop and stays for as long as the child runs -- for the Notebook
/// panel that is the whole session. `CREATE_NO_WINDOW` runs the child without
/// one. Output is unaffected: every caller already pipes stdout/stderr and
/// drains them (see CapturedOutput).
#[cfg(all(target_os = "windows", not(feature = "mas")))]
pub(crate) fn hide_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(all(not(target_os = "windows"), not(feature = "mas")))]
pub(crate) fn hide_console_window(_command: &mut Command) {}

#[cfg(not(feature = "mas"))]
pub(crate) fn terminate_sidecar_child(child: &mut Child) {
    // Signal the process group first so surviving grandchildren (such as
    // Jupyter kernels or uvicorn workers) are terminated even if the group
    // leader already exited. Skip `child.kill()` / `child.wait()` once
    // `try_wait()` confirms the leader was already reaped.
    terminate_sidecar_process_group(child);
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(all(unix, not(feature = "mas")))]
fn terminate_sidecar_process_group(child: &mut Child) {
    // Guard the negation: a PID that wrapped to a non-positive i32 would make
    // `kill` target process group 0 (the caller's own group, including the
    // Tauri parent) or overflow on i32::MIN.
    let Some(process_group) = i32::try_from(child.id())
        .ok()
        .filter(|pid| *pid > 0)
        .and_then(|pid| pid.checked_neg())
    else {
        return;
    };
    let _ = unsafe { kill(process_group, SIGTERM) };
    thread::sleep(Duration::from_millis(250));
    let _ = unsafe { kill(process_group, SIGKILL) };
}

#[cfg(all(not(unix), not(feature = "mas")))]
fn terminate_sidecar_process_group(_child: &mut Child) {}

#[cfg(all(unix, not(feature = "mas")))]
pub(crate) fn terminate_pid(pid: i32, signal: i32) {
    let _ = unsafe { kill(pid, signal) };
}

#[cfg(test)]
mod tests {
    use super::{
        child_failure_message, clear_appimage_python_env, CapturedOutput, CAPTURED_LOG_MAX_LINES,
        CAPTURED_LOG_REPORTED_LINES, CAPTURED_LOG_SETTLE,
    };
    use crate::test_support::ENV_LOCK;
    use std::env;
    use std::ffi::OsStr;
    use std::process::Command;
    use std::time::Duration;

    #[test]
    fn captured_output_keeps_draining_after_non_utf8_lines() {
        for is_stderr in [false, true] {
            let captured = CapturedOutput::new();
            captured.drain(
                std::io::Cursor::new(b"start\r\nbad: \xff\r\nlast diagnostic".to_vec()),
                is_stderr,
            );
            captured.settle();
            assert_eq!(captured.tail(), "start\nbad: \u{fffd}\nlast diagnostic");
        }
    }

    #[test]
    fn captured_output_drains_past_a_pipe_buffer_after_invalid_bytes() {
        use std::io::{Cursor, Read};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        struct Chunked {
            stream: Cursor<Vec<u8>>,
            read: Arc<AtomicUsize>,
        }
        impl Read for Chunked {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let size = buffer.len().min(7);
                let count = self.stream.read(&mut buffer[..size])?;
                self.read.fetch_add(count, Ordering::SeqCst);
                Ok(count)
            }
        }
        let mut bytes = b"invalid: \xff\n".to_vec();
        for _ in 0..128 {
            bytes.extend_from_slice("noise π".repeat(128).as_bytes());
            bytes.push(b'\n');
        }
        bytes.extend_from_slice(b"FINAL_DIAGNOSTIC\n");
        assert!(bytes.len() > 65536);
        let length = bytes.len();
        let read = Arc::new(AtomicUsize::new(0));
        let captured = CapturedOutput::new();
        captured.drain(
            Chunked {
                stream: Cursor::new(bytes),
                read: read.clone(),
            },
            false,
        );
        // Production settle is deliberately limited to 500 ms. This bulk-read
        // regression should tolerate a loaded test runner without changing it.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while captured.draining.load(Ordering::SeqCst) != 0 && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(captured.draining.load(Ordering::SeqCst), 0);
        assert_eq!(read.load(Ordering::SeqCst), length);
        let tail = captured.tail();
        assert!(tail.contains("noise π"));
        assert!(tail.ends_with("FINAL_DIAGNOSTIC"));
    }

    #[test]
    fn captured_output_releases_its_reader_after_an_io_error() {
        struct Failed;
        impl std::io::Read for Failed {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("pipe read failed"))
            }
        }
        let captured = CapturedOutput::new();
        captured.drain(Failed, false);
        captured.settle();
        assert_eq!(
            captured.draining.load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert!(captured.tail().is_empty());
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn captured_output_keeps_only_the_trailing_lines() {
        let captured = CapturedOutput::new();
        for index in 0..(CAPTURED_LOG_MAX_LINES * 3) {
            captured.push(format!("line {index}"));
        }
        let tail = captured.tail();
        let lines: Vec<_> = tail.lines().collect();
        // The buffer is bounded and the report quotes only its end, so a child
        // that writes thousands of lines still yields a short, recent tail.
        assert_eq!(lines.len(), CAPTURED_LOG_REPORTED_LINES);
        let last = CAPTURED_LOG_MAX_LINES * 3 - 1;
        assert_eq!(lines[lines.len() - 1], format!("line {last}"));
        assert_eq!(
            lines[0],
            format!("line {}", last + 1 - CAPTURED_LOG_REPORTED_LINES)
        );
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn captured_output_drops_blank_lines_from_the_tail() {
        let captured = CapturedOutput::new();
        captured.push("error: Failed to spawn: `jupyter`".to_string());
        captured.push("   ".to_string());
        captured.push(String::new());
        captured.push("  Caused by: No such file or directory (os error 2)  ".to_string());
        assert_eq!(
            captured.tail(),
            "error: Failed to spawn: `jupyter`\n  Caused by: No such file or directory (os error 2)"
        );
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn child_failure_message_quotes_the_child_output() {
        let captured = CapturedOutput::new();
        captured.push("error: Extra `notebook` is not defined".to_string());
        let message = child_failure_message("Jupyter server exited.", &captured);
        assert!(message.starts_with("Jupyter server exited."));
        // The cause has to travel with the error: an installed build is
        // GUI-subsystem on Windows and has no terminal to read it from.
        assert!(message.contains("error: Extra `notebook` is not defined"));
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn child_failure_message_says_so_when_there_was_no_output() {
        let message = child_failure_message("Jupyter server exited.", &CapturedOutput::new());
        assert_eq!(message, "Jupyter server exited. It produced no output.");
    }

    // The whole point of the capture is that the child's *last* lines — the
    // error that killed it — reach the report. `try_wait` can observe the exit
    // while those lines are still in the pipe, so the report has to wait for the
    // readers to drain. Uses a real child so the race is real: a spawn that
    // writes and exits immediately, reported the way the health waiters do.
    #[cfg(all(unix, not(feature = "mas")))]
    #[test]
    fn child_failure_message_waits_for_output_still_in_the_pipe() {
        use std::process::{Command, Stdio};

        let mut child = Command::new("sh")
            .arg("-c")
            .arg("echo 'error: the cause'; echo 'to stderr' >&2")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn a child that writes and exits");
        let output = CapturedOutput::attach(&mut child);
        // Mirror the waiters: report as soon as the exit is observed.
        while child.try_wait().expect("inspect child").is_none() {
            std::thread::sleep(Duration::from_millis(5));
        }
        let message = child_failure_message("Child exited.", &output);
        assert!(message.contains("error: the cause"), "got: {message}");
        assert!(message.contains("to stderr"), "got: {message}");
    }

    // The race the report has to win, made deterministic. A reader that is
    // provably still behind at report time stands in for bytes sitting in the
    // OS pipe after `try_wait` has already reported the child gone. Without
    // `settle` the report races past it and quotes nothing — which is the
    // failure mode the capture exists to prevent. (The real-child test above
    // exercises the same path end to end, but its timing is not guaranteed:
    // on a fast machine the reader usually wins on its own.)
    #[cfg(not(feature = "mas"))]
    #[test]
    fn child_failure_message_waits_for_output_still_in_flight() {
        struct SlowThenEof {
            sent: bool,
        }
        impl std::io::Read for SlowThenEof {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.sent {
                    return Ok(0); // EOF
                }
                std::thread::sleep(Duration::from_millis(100));
                let line = b"error: the cause\n";
                buf[..line.len()].copy_from_slice(line);
                self.sent = true;
                Ok(line.len())
            }
        }

        let captured = CapturedOutput::new();
        captured.drain(SlowThenEof { sent: false }, false);
        let message = child_failure_message("Child exited.", &captured);
        assert!(message.contains("error: the cause"), "got: {message}");
    }

    // AppImageKit's AppRun exports PYTHONHOME=$APPDIR/usr/ into every child. A
    // Python that honours it looks for its stdlib inside the AppImage mount and
    // aborts with "Failed to import encodings module" before running any code,
    // which is how the Notebook panel and the sidecar died in AppImage builds.
    // Serialized with the other env-mutating test: these share process env.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn appimage_python_env_is_stripped_from_children() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let appdir = "/tmp/.mount_GeoLibreXXXX";
        // Reproduce what AppRun exports.
        env::set_var("APPDIR", appdir);
        env::set_var("PYTHONHOME", format!("{appdir}/usr/"));
        env::set_var(
            "PYTHONPATH",
            env::join_paths([
                format!("{appdir}/usr/share/pyshared/"),
                "/home/me/lib".into(),
            ])
            .unwrap(),
        );
        env::set_var(
            "LD_LIBRARY_PATH",
            env::join_paths([format!("{appdir}/usr/lib/"), format!("{appdir}/lib/")]).unwrap(),
        );

        let mut command = Command::new("true");
        clear_appimage_python_env(&mut command);
        let envs: Vec<_> = command.get_envs().collect();
        let lookup = |name: &str| {
            envs.iter()
                .find(|(key, _)| *key == OsStr::new(name))
                .map(|(_, value)| *value)
        };

        // PYTHONHOME is dropped outright — it is the fatal one.
        assert_eq!(lookup("PYTHONHOME"), Some(None));
        // The user's own PYTHONPATH entry survives; the AppDir one does not.
        assert_eq!(lookup("PYTHONPATH"), Some(Some(OsStr::new("/home/me/lib"))));
        // Every LD_LIBRARY_PATH entry was an AppDir entry, so the variable is
        // unset rather than passed through empty.
        assert_eq!(lookup("LD_LIBRARY_PATH"), Some(None));

        env::remove_var("APPDIR");
        env::remove_var("PYTHONHOME");
        env::remove_var("PYTHONPATH");
        env::remove_var("LD_LIBRARY_PATH");
    }

    // Outside an AppImage nothing is filtered: a user who deliberately set these
    // for their own Python must keep them.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn python_env_is_untouched_outside_an_appimage() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        env::remove_var("APPDIR");
        env::set_var("PYTHONPATH", "/home/me/lib:/opt/other");

        let mut command = Command::new("true");
        clear_appimage_python_env(&mut command);
        let value = command
            .get_envs()
            .find(|(key, _)| *key == OsStr::new("PYTHONPATH"))
            .map(|(_, value)| value);
        assert_eq!(value, Some(Some(OsStr::new("/home/me/lib:/opt/other"))));

        env::remove_var("PYTHONPATH");
    }

    // The Jupyter launch sets PYTHONPATH itself (notebook-lib, so `import
    // geolibre` works) before the sanitizer runs; the sanitizer must not
    // overwrite it.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn a_pythonpath_the_caller_already_set_is_preserved() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        env::set_var("APPDIR", "/tmp/.mount_GeoLibreXXXX");
        env::set_var("PYTHONPATH", "/tmp/.mount_GeoLibreXXXX/usr/share/pyshared/");

        let mut command = Command::new("true");
        command.env("PYTHONPATH", "/app/runtime/notebook-lib");
        clear_appimage_python_env(&mut command);
        let value = command
            .get_envs()
            .find(|(key, _)| *key == OsStr::new("PYTHONPATH"))
            .map(|(_, value)| value);
        assert_eq!(value, Some(Some(OsStr::new("/app/runtime/notebook-lib"))));

        env::remove_var("APPDIR");
        env::remove_var("PYTHONPATH");
    }

    // A reader that never reaches EOF must not hang the report: `uv` spawns
    // `jupyter`, which spawns kernels holding these same pipe handles, so a
    // grandchild outliving the child keeps the write end open forever. `settle`
    // is bounded for exactly this case.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn settle_gives_up_on_a_reader_that_never_reaches_eof() {
        struct NeverEnds;
        impl std::io::Read for NeverEnds {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                std::thread::sleep(Duration::from_millis(50));
                buf[0] = b'\n';
                Ok(1)
            }
        }

        let captured = CapturedOutput::new();
        captured.drain(NeverEnds, false);
        let started = std::time::Instant::now();
        captured.settle();
        // Bounded: returns at the deadline rather than blocking forever. The
        // generous upper bound keeps this from flaking on a loaded CI runner.
        assert!(
            started.elapsed() < CAPTURED_LOG_SETTLE * 10,
            "settle blocked for {:?}",
            started.elapsed()
        );
    }

    #[cfg(all(unix, not(feature = "mas")))]
    #[test]
    fn terminate_sidecar_child_handles_already_exited_process() {
        let mut child = std::process::Command::new("true")
            .spawn()
            .expect("spawn true");
        let status = child.wait().expect("wait for true");
        assert!(status.success());
        super::terminate_sidecar_child(&mut child);
        assert!(matches!(child.try_wait(), Ok(Some(s)) if s.success()));
    }
}
