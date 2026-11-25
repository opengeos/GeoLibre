//! Reclaiming the sidecar and Jupyter ports from servers a previous session
//! left running: finding the process that owns a listening socket (procfs on
//! Linux, the IP Helper TCP table on Windows, lsof on macOS) and terminating it
//! only when its command line or image path shows it is ours.

#[cfg(all(any(target_os = "linux", target_os = "macos"), not(feature = "mas")))]
use crate::child_process::{terminate_pid, SIGKILL, SIGTERM};
#[cfg(all(
    any(target_os = "linux", target_os = "macos", target_os = "windows"),
    not(feature = "mas")
))]
use std::collections::HashSet;
#[cfg(all(target_os = "linux", not(feature = "mas")))]
use std::fs;
#[cfg(any(all(target_os = "windows", not(feature = "mas")), test))]
use std::path::Path;
#[cfg(all(target_os = "windows", not(feature = "mas")))]
use std::path::PathBuf;
#[cfg(all(target_os = "macos", not(feature = "mas")))]
use std::process::{Command, Stdio};
#[cfg(all(any(target_os = "linux", target_os = "macos"), not(feature = "mas")))]
use std::thread;
#[cfg(all(any(target_os = "linux", target_os = "macos"), not(feature = "mas")))]
use std::time::Duration;

#[cfg(all(target_os = "linux", not(feature = "mas")))]
pub(crate) fn terminate_sidecar_listeners_on_port(port: u16) -> Result<(), String> {
    terminate_listeners_on_port(port, is_geolibre_sidecar_process)
}

// Reap a stale Jupyter server that still holds the port (e.g. orphaned by a
// non-graceful exit of a previous app session). Recognized by its cmdline so we
// never touch an unrelated jupyter (the user's own JupyterHub, etc.).
#[cfg(all(target_os = "linux", not(feature = "mas")))]
pub(crate) fn terminate_jupyter_listeners_on_port(
    port: u16,
    _runtime_dir: &std::path::Path,
) -> Result<(), String> {
    terminate_listeners_on_port(port, is_geolibre_jupyter_process)
}

// Known gap: still a no-op on macOS (there is no /proc, and the Windows IP
// Helper route below does not exist either). The current session's child is
// reaped on exit via JupyterProcess::Drop, but an orphan left by a *previous*
// crashed session can keep holding the port, in which case the next launch
// fails to bind and surfaces "exited before it was ready". An lsof-based
// port-owner lookup would be needed to close this.
#[cfg(all(
    not(target_os = "linux"),
    not(target_os = "windows"),
    not(feature = "mas")
))]
pub(crate) fn terminate_jupyter_listeners_on_port(
    _port: u16,
    _runtime_dir: &std::path::Path,
) -> Result<(), String> {
    Ok(())
}

// Windows equivalent of the Linux reaper (issue #1643): an orphaned Jupyter
// server from a crashed session keeps holding 8766, and every later launch dies
// with "the port 8766 is already in use" until the user kills it by hand.
//
// There is no /proc here, so the owner of the listening socket comes from the IP
// Helper TCP table, and "is it ours?" is answered by the process image path: we
// only ever terminate a listener whose executable lives inside this user's own
// GeoLibre runtime directory (the uv-managed environment under
// `%APPDATA%\org.geolibre.desktop\runtime\`). A Jupyter the user installed
// themselves lives outside it and is left alone. The sidecar's port is reaped
// the same way but recognized by its command line instead (see
// terminate_sidecar_listeners_on_port), since its interpreter can be a system
// Python that uv picked outside the runtime directory.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
pub(crate) fn terminate_jupyter_listeners_on_port(
    port: u16,
    runtime_dir: &std::path::Path,
) -> Result<(), String> {
    for pid in listening_tcp_pids(port) {
        terminate_listener_if(pid, |process| process_image_is_under(process, runtime_dir));
    }
    Ok(())
}

// PIDs of the processes listening on `port`, over both IPv4 and IPv6. The two
// families are read independently: a machine with IPv6 disabled outright can
// fail the second read, and letting that discard the IPv4 result would drop the
// orphan we are here to reclaim (Jupyter binds 127.0.0.1, so it is nearly
// always the IPv4 table that holds it).
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn listening_tcp_pids(port: u16) -> HashSet<u32> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID,
    };

    // The address families as GetExtendedTcpTable wants them: a plain u32, not
    // the u16 `ADDRESS_FAMILY` the WinSock module exports.
    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;

    let mut pids = HashSet::new();
    match extended_tcp_table(AF_INET) {
        Ok(table) => collect_owner_pids::<MIB_TCPROW_OWNER_PID>(
            &table,
            port,
            |row| (row.dwLocalPort, row.dwOwningPid),
            &mut pids,
        ),
        Err(error) => eprintln!("GeoLibre: {error}"),
    }
    match extended_tcp_table(AF_INET6) {
        Ok(table) => collect_owner_pids::<MIB_TCP6ROW_OWNER_PID>(
            &table,
            port,
            |row| (row.dwLocalPort, row.dwOwningPid),
            &mut pids,
        ),
        Err(error) => eprintln!("GeoLibre: {error}"),
    }
    pids
}

// Walk one MIB_TCP*TABLE_OWNER_PID and collect the PIDs listening on `port`.
// Both the IPv4 and IPv6 tables have the same shape -- a DWORD entry count
// followed by the rows -- so the row type and the two fields we need are the
// only things that differ.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn collect_owner_pids<Row>(
    buffer: &[u32],
    port: u16,
    fields: fn(&Row) -> (u32, u32),
    pids: &mut HashSet<u32>,
) {
    use std::mem::{size_of, size_of_val};

    if buffer.is_empty() {
        return;
    }
    let base = buffer.as_ptr();
    // SAFETY: `buffer` is a u32-aligned allocation that GetExtendedTcpTable
    // filled for this table class, and it holds at least the leading entry
    // count. Every row type here has 4-byte alignment, so the rows -- which
    // start one DWORD in -- are aligned too. The walk is capped at the number
    // of rows the allocation can actually hold, so an entry count that
    // disagrees with the reported size cannot read past the end.
    let count = unsafe { *base } as usize;
    let capacity = (size_of_val(buffer) - size_of::<u32>()) / size_of::<Row>();
    let rows = unsafe { base.add(1) }.cast::<Row>();
    for index in 0..count.min(capacity) {
        let (local_port, owning_pid) = fields(unsafe { &*rows.add(index) });
        if tcp_table_port(local_port) == port {
            pids.insert(owning_pid);
        }
    }
}

// Read the TCP listener table for one address family into a u32-aligned buffer.
// GetExtendedTcpTable reports the size it needs on the first (null) call, but
// the table can grow between that call and the read, so retry a bounded number
// of times rather than trusting the first answer.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn extended_tcp_table(family: u32) -> Result<Vec<u32>, String> {
    use std::mem::size_of;
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, TCP_TABLE_OWNER_PID_LISTENER,
    };

    const NO_ERROR: u32 = 0;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
    const ATTEMPTS: usize = 8;

    let mut size: u32 = 0;
    let mut buffer: Vec<u32> = Vec::new();
    for _ in 0..ATTEMPTS {
        // SAFETY: the pointer and `size` describe the same allocation (null and
        // zero on the sizing call, which is what the API asks for), and the API
        // only writes within `size` bytes.
        let result = unsafe {
            GetExtendedTcpTable(
                if buffer.is_empty() {
                    std::ptr::null_mut()
                } else {
                    buffer.as_mut_ptr().cast()
                },
                &mut size,
                0, // unsorted: we look up a single port
                family,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        match result {
            NO_ERROR => return Ok(buffer),
            ERROR_INSUFFICIENT_BUFFER => {
                if size == 0 {
                    return Ok(Vec::new());
                }
                buffer = vec![0u32; (size as usize).div_ceil(size_of::<u32>())];
            }
            other => {
                return Err(format!(
                    "Could not read the TCP listener table for address family {family}: \
                     Windows error {other}."
                ))
            }
        }
    }
    Err("Could not read the TCP listener table: it kept growing between calls.".to_string())
}

// Terminate `pid`, but only if `is_ours` recognizes the process. Does nothing
// when the process has already exited or we may not touch it.
//
// The identity check and the kill deliberately share ONE handle. An open handle
// pins the process object, so the PID cannot be recycled onto some unrelated
// process in between -- re-opening by PID to terminate would leave exactly that
// window, and the whole point of the identity check is that we never kill a
// process that is not ours.
//
// Windows has no SIGTERM, so unlike the Linux path there is no graceful step to
// try first: an orphan from a previous session has no channel we can ask it to
// shut down through.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn terminate_listener_if(
    pid: u32,
    is_ours: impl FnOnce(windows_sys::Win32::Foundation::HANDLE) -> bool,
) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };

    // SAFETY: one handle for both the query and the kill; closed on every path.
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
            0,
            pid,
        )
    };
    if process.is_null() {
        return;
    }
    if is_ours(process) {
        // SAFETY: the same handle, opened with PROCESS_TERMINATE above.
        let _ = unsafe { TerminateProcess(process, 1) };
    }
    let _ = unsafe { CloseHandle(process) };
}

// Whether the executable of `process` lives inside `runtime_dir`.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn process_image_is_under(
    process: windows_sys::Win32::Foundation::HANDLE,
    runtime_dir: &Path,
) -> bool {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Threading::{QueryFullProcessImageNameW, PROCESS_NAME_WIN32};

    // Sized for an extended-length path rather than MAX_PATH, so a deeply
    // nested app-data directory is not silently truncated into a non-match.
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as u32;
    // SAFETY: `buffer` holds `length` u16s; on success the API sets `length` to
    // the number it wrote, which is never more than the value passed in.
    let queried = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            buffer.as_mut_ptr(),
            &mut length,
        )
    };
    if queried == 0 {
        return false;
    }
    let image = PathBuf::from(OsString::from_wide(
        &buffer[..(length as usize).min(buffer.len())],
    ));
    path_is_under(&image, runtime_dir)
}

// The full command line of `process`, via ProcessCommandLineInformation (Windows
// 8.1+), which only needs PROCESS_QUERY_LIMITED_INFORMATION. None when the
// query fails, e.g. the process has exited.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn process_command_line(process: windows_sys::Win32::Foundation::HANDLE) -> Option<String> {
    use std::mem::size_of;
    use windows_sys::Wdk::System::Threading::{
        NtQueryInformationProcess, ProcessCommandLineInformation,
    };
    use windows_sys::Win32::Foundation::UNICODE_STRING;

    // NTSTATUS codes for "buffer too small"; the call reports the size it needs.
    // Which one this info class returns is not documented, so accept all three.
    const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;
    const STATUS_BUFFER_TOO_SMALL: i32 = 0xC000_0023_u32 as i32;
    const STATUS_BUFFER_OVERFLOW: i32 = 0x8000_0005_u32 as i32;

    // The result is a UNICODE_STRING header followed by the text it points at.
    // A u64 buffer keeps the header's pointer field aligned.
    let mut buffer = vec![0u64; 512];
    for _ in 0..4 {
        let capacity = (buffer.len() * size_of::<u64>()) as u32;
        let mut needed: u32 = 0;
        // SAFETY: the pointer and `capacity` describe the same allocation, and
        // the call writes at most `capacity` bytes.
        let status = unsafe {
            NtQueryInformationProcess(
                process,
                ProcessCommandLineInformation,
                buffer.as_mut_ptr().cast(),
                capacity,
                &mut needed,
            )
        };
        if matches!(
            status,
            STATUS_INFO_LENGTH_MISMATCH | STATUS_BUFFER_TOO_SMALL | STATUS_BUFFER_OVERFLOW
        ) && needed > capacity
        {
            buffer = vec![0u64; (needed as usize).div_ceil(size_of::<u64>())];
            continue;
        }
        if status < 0 {
            return None;
        }
        // SAFETY: on success the buffer starts with an initialized, aligned
        // UNICODE_STRING.
        let header = unsafe { &*buffer.as_ptr().cast::<UNICODE_STRING>() };
        let start = buffer.as_ptr() as usize;
        let end = start + capacity as usize;
        let text = header.Buffer as usize;
        let bytes = usize::from(header.Length);
        // The text must lie inside our allocation; anything else is not a
        // shape we trust enough to read.
        if header.Buffer.is_null()
            || text < start + size_of::<UNICODE_STRING>()
            || text
                .checked_add(bytes)
                .is_none_or(|text_end| text_end > end)
            || !text.is_multiple_of(std::mem::align_of::<u16>())
        {
            return None;
        }
        // SAFETY: bounds and alignment were checked against our allocation.
        let units = unsafe { std::slice::from_raw_parts(header.Buffer, bytes / 2) };
        return Some(String::from_utf16_lossy(units));
    }
    None
}

// MIB_TCP*ROW_OWNER_PID keeps the local port in the low word of a DWORD, in
// network byte order.
#[cfg(any(all(target_os = "windows", not(feature = "mas")), test))]
fn tcp_table_port(value: u32) -> u16 {
    u16::from_be((value & 0xFFFF) as u16)
}

// Whether `path` sits inside `root`. Compared with separators normalized and
// case folded, because Windows paths are case-insensitive and the image path
// the OS reports need not spell the directory the way we built it. The trailing
// separator is what keeps `...\runtime` from matching `...\runtime-old`.
//
// Folding is ASCII-only on purpose. What actually varies between the path we
// built and the one the OS reports is the drive letter and the segments we
// wrote ourselves, all ASCII; the rest (a user's name in the profile path) is
// byte-identical on both sides. Unicode `to_lowercase` would buy nothing there
// and can change a string's length (Turkish dotless I, sharp S), which would
// misalign the prefix comparison.
#[cfg(any(all(target_os = "windows", not(feature = "mas")), test))]
fn path_is_under(path: &Path, root: &Path) -> bool {
    fn normalize(value: &Path) -> String {
        value
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase()
    }

    let root = normalize(root);
    let root = root.trim_end_matches('\\');
    if root.is_empty() {
        return false;
    }
    normalize(path).starts_with(&format!("{root}\\"))
}

// Kill the processes listening on `port` that `is_ours` recognizes (SIGTERM then
// SIGKILL). The `is_ours` guard prevents killing an unrelated process that
// happens to hold the port.
#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn terminate_listeners_on_port(port: u16, is_ours: fn(i32) -> bool) -> Result<(), String> {
    let inodes = listening_tcp_inodes(port)?;
    if inodes.is_empty() {
        return Ok(());
    }

    let mut pids = HashSet::new();
    for entry in fs::read_dir("/proc").map_err(|error| format!("Could not read /proc: {error}"))? {
        let entry = entry.map_err(|error| format!("Could not read /proc entry: {error}"))?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|value| value.parse::<i32>().ok())
        else {
            continue;
        };
        if process_has_socket(pid, &inodes)? && is_ours(pid) {
            pids.insert(pid);
        }
    }

    terminate_pids(&pids, is_ours);
    Ok(())
}

// Windows: the listener's owner comes from the IP Helper TCP table, and it is
// only terminated when its command line names our sidecar app -- the same
// identity guard Linux uses. The image path is no help here: uv may run the
// sidecar on a system Python outside the runtime directory.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
pub(crate) fn terminate_sidecar_listeners_on_port(port: u16) -> Result<(), String> {
    for pid in listening_tcp_pids(port) {
        terminate_listener_if(pid, |process| {
            process_command_line(process)
                .is_some_and(|command_line| is_geolibre_sidecar_command_line(&command_line))
        });
    }
    Ok(())
}

// macOS has no /proc, so the listener comes from lsof and its command line from
// ps. Both ship with the OS at fixed paths, which keeps a PATH override from
// substituting either. A failed lookup reclaims nothing rather than erroring, so
// the caller still reports the stale-session message the frontend recognizes.
#[cfg(all(target_os = "macos", not(feature = "mas")))]
pub(crate) fn terminate_sidecar_listeners_on_port(port: u16) -> Result<(), String> {
    let pids: HashSet<i32> = listening_tcp_pids_lsof(port)
        .into_iter()
        .filter(|pid| is_geolibre_sidecar_pid(*pid))
        .collect();
    terminate_pids(&pids, is_geolibre_sidecar_pid);
    Ok(())
}

#[cfg(all(target_os = "macos", not(feature = "mas")))]
fn is_geolibre_sidecar_pid(pid: i32) -> bool {
    process_command_line_ps(pid)
        .is_some_and(|command_line| is_geolibre_sidecar_command_line(&command_line))
}

#[cfg(all(target_os = "macos", not(feature = "mas")))]
fn listening_tcp_pids_lsof(port: u16) -> HashSet<i32> {
    let output = match Command::new("/usr/sbin/lsof")
        .args(["-nP", "-t", "-sTCP:LISTEN"])
        .arg(format!("-iTCP:{port}"))
        .stdin(Stdio::null())
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            eprintln!("GeoLibre: could not run lsof: {error}");
            return HashSet::new();
        }
    };
    // lsof exits 1 when nothing matches, so the status is not an error signal;
    // an empty stdout is.
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<i32>().ok())
        .filter(|pid| *pid > 0)
        .collect()
}

#[cfg(all(target_os = "macos", not(feature = "mas")))]
fn process_command_line_ps(pid: i32) -> Option<String> {
    let output = Command::new("/bin/ps")
        .args(["-ww", "-o", "command="])
        .arg("-p")
        .arg(pid.to_string())
        .stdin(Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

// SIGTERM, a short grace, then SIGKILL for whatever is still alive. `kill(2)`
// cannot pin a process the way a Windows handle does, so `is_ours` is checked
// again right before each signal: a sidecar that exited on SIGTERM frees its
// PID, and the OS may hand it to an unrelated process during the grace period.
#[cfg(all(any(target_os = "linux", target_os = "macos"), not(feature = "mas")))]
fn terminate_pids(pids: &HashSet<i32>, is_ours: fn(i32) -> bool) {
    if pids.is_empty() {
        return;
    }
    for pid in pids {
        if is_ours(*pid) {
            terminate_pid(*pid, SIGTERM);
        }
    }
    thread::sleep(Duration::from_millis(250));
    for pid in pids {
        if is_ours(*pid) {
            terminate_pid(*pid, SIGKILL);
        }
    }
}

#[cfg(all(
    not(any(target_os = "linux", target_os = "windows", target_os = "macos")),
    not(feature = "mas")
))]
pub(crate) fn terminate_sidecar_listeners_on_port(_port: u16) -> Result<(), String> {
    Ok(())
}

#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn listening_tcp_inodes(port: u16) -> Result<HashSet<String>, String> {
    let mut inodes = HashSet::new();
    collect_listening_tcp_inodes("/proc/net/tcp", port, &mut inodes, false)?;
    // Systems booted with `ipv6.disable=1` have no `/proc/net/tcp6`; treat a
    // missing IPv6 table as empty rather than failing IPv4 port reclaim.
    collect_listening_tcp_inodes("/proc/net/tcp6", port, &mut inodes, true)?;
    Ok(inodes)
}

#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn collect_listening_tcp_inodes(
    path: &str,
    port: u16,
    inodes: &mut HashSet<String>,
    optional: bool,
) -> Result<(), String> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if optional && error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not read {path}: {error}")),
    };
    let expected_port = format!("{port:04X}");
    for line in content.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() <= 9 || fields[3] != "0A" {
            continue;
        }
        let Some(local_port) = fields[1].rsplit_once(':').map(|(_, value)| value) else {
            continue;
        };
        if local_port.eq_ignore_ascii_case(&expected_port) {
            inodes.insert(fields[9].to_string());
        }
    }
    Ok(())
}

#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn process_has_socket(pid: i32, inodes: &HashSet<String>) -> Result<bool, String> {
    let fd_dir = format!("/proc/{pid}/fd");
    let Ok(entries) = fs::read_dir(&fd_dir) else {
        return Ok(false);
    };
    for entry in entries {
        let Ok(entry) = entry else {
            continue; // process may have exited between the /proc scan and this read
        };
        let Ok(target) = fs::read_link(entry.path()) else {
            continue;
        };
        let target = target.to_string_lossy();
        if let Some(inode) = target
            .strip_prefix("socket:[")
            .and_then(|value| value.strip_suffix(']'))
        {
            if inodes.contains(inode) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn is_geolibre_sidecar_process(pid: i32) -> bool {
    let path = format!("/proc/{pid}/cmdline");
    let Ok(command_line) = fs::read(path) else {
        return false;
    };
    let command_line = String::from_utf8_lossy(&command_line);
    // Linux has always also accepted the app's directory path; Windows and macOS
    // match only the module the sidecar is launched with.
    is_geolibre_sidecar_command_line(&command_line) || command_line.contains("geolibre_server/app")
}

// Whether a process command line is one of our sidecars, started by
// start_geolibre_sidecar_blocking as `uvicorn geolibre_server.app.main:app`.
#[cfg(any(
    all(
        any(target_os = "linux", target_os = "windows", target_os = "macos"),
        not(feature = "mas")
    ),
    test
))]
pub(crate) fn is_geolibre_sidecar_command_line(command_line: &str) -> bool {
    command_line.contains("geolibre_server.app.main")
}

// Recognize OUR Jupyter server (started by start_jupyter_server) by the bundled
// config path on its command line — specific enough not to match the user's own
// jupyter/JupyterHub processes.
#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn is_geolibre_jupyter_process(pid: i32) -> bool {
    let path = format!("/proc/{pid}/cmdline");
    let Ok(command_line) = fs::read(path) else {
        return false;
    };
    let command_line = String::from_utf8_lossy(&command_line);
    command_line.contains("jupyter_server_config.py") && command_line.contains("geolibre_server")
}

#[cfg(test)]
mod tests {
    use super::{is_geolibre_sidecar_command_line, path_is_under, tcp_table_port};

    // The Windows reaper reads the local port out of a DWORD that holds it in
    // network byte order in its low word. Getting this wrong would match the
    // wrong listener (or none), so pin the decoding here -- these are pure
    // functions, so the check runs on every platform even though their only
    // caller is Windows-only.
    #[test]
    fn decodes_a_network_order_port_from_the_tcp_table() {
        // 8766 = 0x223E; network byte order puts 0x22 first, so the DWORD's low
        // word reads 0x3E22, and the high word is padding the API does not use.
        assert_eq!(tcp_table_port(0x0000_3E22), 8766);
        assert_eq!(tcp_table_port(0xDEAD_3E22), 8766);
        assert_eq!(tcp_table_port(0x0000_223E), 0x3E22);
    }

    // The image-path guard is what keeps the reaper from killing a Jupyter the
    // user installed themselves: only executables under our own runtime
    // directory are ours to terminate.
    #[test]
    fn recognizes_only_paths_inside_the_runtime_directory() {
        let root =
            std::path::Path::new(r"C:\Users\me\AppData\Roaming\org.geolibre.desktop\runtime");
        assert!(path_is_under(
            std::path::Path::new(
                r"C:\Users\me\AppData\Roaming\org.geolibre.desktop\runtime\jupyter-server\Scripts\python.exe"
            ),
            root
        ));
        // Case and separator differences are not a mismatch on Windows.
        assert!(path_is_under(
            std::path::Path::new(
                r"c:\users\me\appdata\roaming\org.geolibre.desktop\RUNTIME/uv-bin/uv.exe"
            ),
            root
        ));
        // A sibling directory sharing the prefix is not inside it.
        assert!(!path_is_under(
            std::path::Path::new(
                r"C:\Users\me\AppData\Roaming\org.geolibre.desktop\runtime-old\jupyter-server\python.exe"
            ),
            root
        ));
        // The user's own Python is left alone.
        assert!(!path_is_under(
            std::path::Path::new(r"C:\Program Files\Python312\python.exe"),
            root
        ));
        // A non-ASCII profile name survives the fold: ASCII case folding leaves
        // it byte-identical on both sides, where Unicode lowercasing could
        // change its length and misalign the prefix.
        let unicode_root = std::path::Path::new(r"C:\Users\İŞIL\AppData\Roaming\runtime");
        assert!(path_is_under(
            std::path::Path::new(
                r"C:\Users\İŞIL\AppData\Roaming\runtime\jupyter-server\python.exe"
            ),
            unicode_root
        ));
        // The directory itself is not "inside" itself, and an empty root never
        // matches (which would otherwise make every listener look like ours).
        assert!(!path_is_under(root, root));
        assert!(!path_is_under(
            std::path::Path::new(r"C:\anything"),
            std::path::Path::new("")
        ));
    }

    #[test]
    fn recognizes_only_geolibre_sidecar_command_lines() {
        // Windows: uv's uvicorn.exe trampoline hands the app spec to Python.
        assert!(is_geolibre_sidecar_command_line(
            r#""C:\Python312\python.exe" "C:\Users\me\AppData\Roaming\org.geolibre.desktop\runtime\sidecar-server\Scripts\uvicorn.exe" geolibre_server.app.main:app --host 127.0.0.1 --port 8765"#
        ));
        // Linux /proc cmdline (NUL-separated) and macOS ps output.
        assert!(is_geolibre_sidecar_command_line(
            "/runtime/sidecar-server/bin/python3\0/runtime/sidecar-server/bin/uvicorn\0geolibre_server.app.main:app\0"
        ));
        // The user's own server on the same port is left alone.
        assert!(!is_geolibre_sidecar_command_line(
            "python -m uvicorn myapp.main:app --port 8765"
        ));
        // A different server merely run from inside the package's directory is
        // not the sidecar.
        assert!(!is_geolibre_sidecar_command_line(
            "python /src/geolibre_server/app/other_server.py --port 8765"
        ));
        assert!(!is_geolibre_sidecar_command_line(""));
    }

    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn collect_listening_tcp_inodes_ignores_missing_optional_table() {
        let mut inodes = std::collections::HashSet::new();
        let result = super::collect_listening_tcp_inodes(
            "/proc/net/geolibre_nonexistent_tcp6",
            8080,
            &mut inodes,
            true,
        );
        assert!(result.is_ok());
        assert!(inodes.is_empty());

        let required = super::collect_listening_tcp_inodes(
            "/proc/net/geolibre_nonexistent_tcp",
            8080,
            &mut inodes,
            false,
        );
        assert!(required.is_err());
    }
}
