//! Linux WebKitGTK environment workarounds applied before the webview starts:
//! the DMABUF renderer choice, the no-AVX WebAssembly OSR crash, and portal
//! file dialogs.

#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "linux")]
use std::path::Path;

#[cfg(target_os = "linux")]
fn nvidia_is_primary_gpu(drm_root: &Path) -> bool {
    let Ok(entries) = fs::read_dir(drm_root) else {
        return false;
    };
    entries.filter_map(Result::ok).any(|entry| {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("card") || name.contains('-') {
            return false;
        }
        let device = entry.path().join("device");
        fs::read_to_string(device.join("vendor"))
            .is_ok_and(|vendor| vendor.trim().eq_ignore_ascii_case("0x10de"))
            && fs::read_to_string(device.join("boot_vga"))
                .is_ok_and(|boot_vga| boot_vga.trim() == "1")
            && fs::read_link(device.join("driver")).is_ok_and(|driver| {
                driver
                    .file_name()
                    .is_some_and(|name| name.eq_ignore_ascii_case("nvidia"))
            })
    })
}

#[cfg(target_os = "linux")]
fn linux_uses_nvidia_renderer(
    drm_root: &Path,
    prime_offload: Option<&std::ffi::OsStr>,
    glx_vendor: Option<&std::ffi::OsStr>,
) -> bool {
    prime_offload.is_some_and(|value| value != "0")
        || glx_vendor.is_some_and(|value| value.eq_ignore_ascii_case("nvidia"))
        || nvidia_is_primary_gpu(drm_root)
}

#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq, Eq)]
enum LinuxDmabufWorkaround {
    Disable,
    ForceShm,
}

#[cfg(target_os = "linux")]
fn linux_dmabuf_workaround(
    webkit_version: (u32, u32),
    uses_nvidia: bool,
) -> Option<LinuxDmabufWorkaround> {
    if webkit_version < (2, 48) || (uses_nvidia && webkit_version < (2, 52)) {
        Some(LinuxDmabufWorkaround::Disable)
    } else if uses_nvidia {
        Some(LinuxDmabufWorkaround::ForceShm)
    } else {
        None
    }
}

/// JavaScriptCore options that keep WebKitGTK's WebAssembly tier-up off its
/// OSR-entry path (see `configure_linux_webkit`). Both are needed: the first
/// covers OSR entry out of the WebAssembly interpreter, the second the loop
/// tier-up checks the baseline (BBQ) JIT emits. Leaving either on still
/// reaches the trampoline.
#[cfg(target_os = "linux")]
const WASM_OSR_ENTRY_JSC_OPTIONS: [&str; 2] = ["JSC_useWasmOSR", "JSC_useBBQTierUpChecks"];

/// Whether this CPU implements AVX. The trampoline behind GeoLibre#2087 is
/// x86-only, so every other architecture answers yes and skips the workaround.
#[cfg(all(target_os = "linux", any(target_arch = "x86", target_arch = "x86_64")))]
fn cpu_supports_avx() -> bool {
    std::arch::is_x86_feature_detected!("avx")
}

#[cfg(all(
    target_os = "linux",
    not(any(target_arch = "x86", target_arch = "x86_64"))
))]
fn cpu_supports_avx() -> bool {
    true
}

/// Whether an explicit value for one of `WASM_OSR_ENTRY_JSC_OPTIONS` leaves it
/// off. JavaScriptCore reads `false`, `no` (either in any case) and `0` as off
/// and `true`, `yes` and `1` as on, and keeps the option's default, which for
/// both of these is on, for anything it cannot parse. Answer the way it does
/// rather than treating "set" as "off".
#[cfg(target_os = "linux")]
fn jsc_option_is_off(value: &std::ffi::OsStr) -> bool {
    value.to_str().is_some_and(|value| {
        value.eq_ignore_ascii_case("false") || value.eq_ignore_ascii_case("no") || value == "0"
    })
}

/// Whether `WASM_OSR_ENTRY_JSC_OPTIONS` has to be pinned off, given whether the
/// CPU supports AVX and whether either option is explicitly *on*. The two are
/// one decision, not two: leaving half the pair applied costs WebAssembly
/// performance without keeping the renderer alive. So an option somebody has
/// already turned off is fine to build on (the other half still gets applied),
/// while an option somebody has turned on is the escape hatch and takes the
/// whole workaround out of GeoLibre's hands, as does pinning `JSC_useBBQJIT`
/// instead.
#[cfg(target_os = "linux")]
fn linux_needs_wasm_osr_workaround(cpu_supports_avx: bool, opted_out: bool) -> bool {
    !cpu_supports_avx && !opted_out
}

#[cfg(target_os = "linux")]
pub(crate) fn configure_linux_webkit() {
    // WebKitGTK's DMABUF renderer could fail to allocate GBM buffers on older
    // graphics stacks, leaving the Tauri window blank, so it used to be
    // disabled here unconditionally. Disabling it also forces a slow readback
    // compositing path that visibly drops MapLibre pan/zoom FPS, and the
    // allocation bugs are fixed on most current graphics stacks. Nvidia's GBM
    // allocation still fails on current drivers, but WebKitGTK 2.52 added a
    // modern shared-memory fallback that avoids both the blank window and the
    // slow legacy renderer selected by WEBKIT_DISABLE_DMABUF_RENDERER. Keep the
    // legacy escape hatch for older WebKitGTK. An explicit user/distributor
    // value always wins.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        let webkit_version = unsafe {
            (
                webkit2gtk_sys::webkit_get_major_version(),
                webkit2gtk_sys::webkit_get_minor_version(),
            )
        };
        let prime_offload = std::env::var_os("__NV_PRIME_RENDER_OFFLOAD");
        let glx_vendor = std::env::var_os("__GLX_VENDOR_LIBRARY_NAME");
        let uses_nvidia = webkit_version >= (2, 48)
            && linux_uses_nvidia_renderer(
                Path::new("/sys/class/drm"),
                prime_offload.as_deref(),
                glx_vendor.as_deref(),
            );
        match linux_dmabuf_workaround(webkit_version, uses_nvidia) {
            Some(LinuxDmabufWorkaround::Disable) => {
                std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }
            Some(LinuxDmabufWorkaround::ForceShm) => {
                if std::env::var_os("WEBKIT_DMABUF_RENDERER_FORCE_SHM").is_none() {
                    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "0");
                    std::env::set_var("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1");
                }
            }
            None => {}
        }
    }
    // WebAssembly tier-up kills the renderer on x86-64 CPUs without AVX
    // (GeoLibre#2087). When a loop inside a WebAssembly function gets hot,
    // JavaScriptCore performs OSR entry into a JIT tier, and that path runs
    // `ctiMasmProbeTrampoline`, which spills xmm0-xmm15 with VEX-encoded
    // `vmovaps` and no runtime AVX check. On a CPU without AVX the first of
    // those instructions raises SIGILL, the WebKitWebProcess dies, and the
    // window stays blank forever with nothing shown to the user. It is an
    // upstream WebKit bug that no GeoLibre code can avoid emitting, and it is
    // reached in normal use because the app runs WebAssembly (DuckDB-WASM,
    // Whitebox) in a worker. All we can do is keep JavaScriptCore off the OSR
    // entry path. WebAssembly still gets baseline-compiled when a function is
    // called repeatedly, so the cost is bounded (a few times slower on repeated
    // calls; a single long-running call with a hot loop stays interpreted)
    // instead of the app being unusable. Verified against WebKitGTK 2.52.6 by
    // breakpointing the trampoline in the web process: with both options off it
    // is never entered, with either one on it still is.
    let cpu_supports_avx = cpu_supports_avx();
    let kept_on = WASM_OSR_ENTRY_JSC_OPTIONS
        .into_iter()
        .find(|option| std::env::var_os(option).is_some_and(|value| !jsc_option_is_off(&value)));
    if linux_needs_wasm_osr_workaround(cpu_supports_avx, kept_on.is_some()) {
        for option in WASM_OSR_ENTRY_JSC_OPTIONS {
            if std::env::var_os(option).is_none() {
                std::env::set_var(option, "false");
            }
        }
        eprintln!(
            "GeoLibre: this CPU has no AVX, so WebAssembly tier-up would crash the WebKit \
             renderer (see GeoLibre issue 2087). {} are off to keep the app running; \
             WebAssembly-heavy work will be slower.",
            WASM_OSR_ENTRY_JSC_OPTIONS.join(" and ")
        );
    } else if !cpu_supports_avx {
        if let Some(option) = kept_on {
            eprintln!(
                "GeoLibre: this CPU has no AVX, but {option} is set to keep WebAssembly tier-up \
                 on, so the workaround for GeoLibre issue 2087 was left alone. The renderer can \
                 still die with SIGILL unless {} are both off.",
                WASM_OSR_ENTRY_JSC_OPTIONS.join(" and ")
            );
        }
    }

    // Prefer portal-backed native dialogs on Linux. This avoids GTK/GIO file
    // metadata warnings that can appear around file and folder pickers.
    if std::env::var_os("GTK_USE_PORTAL").is_none() {
        std::env::set_var("GTK_USE_PORTAL", "1");
    }
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn configure_linux_webkit() {}

#[cfg(all(test, target_os = "linux", not(feature = "mas")))]
mod tests {
    use super::{
        cpu_supports_avx, jsc_option_is_off, linux_dmabuf_workaround,
        linux_needs_wasm_osr_workaround, linux_uses_nvidia_renderer, nvidia_is_primary_gpu,
        LinuxDmabufWorkaround, WASM_OSR_ENTRY_JSC_OPTIONS,
    };
    use crate::test_support::ScratchDir;
    use std::ffi::OsStr;

    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn detects_primary_nvidia_gpu() {
        let root = ScratchDir::new("nvidia-primary");
        let device = root.path().join("card0/device");
        std::fs::create_dir_all(&device).unwrap();
        std::fs::write(device.join("vendor"), "0x10de\n").unwrap();
        std::fs::write(device.join("boot_vga"), "1\n").unwrap();
        std::os::unix::fs::symlink("/sys/bus/pci/drivers/nvidia", device.join("driver")).unwrap();

        assert!(nvidia_is_primary_gpu(root.path()));
    }

    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn ignores_secondary_nvidia_gpu() {
        let root = ScratchDir::new("nvidia-secondary");
        let device = root.path().join("card1/device");
        std::fs::create_dir_all(&device).unwrap();
        std::fs::write(device.join("vendor"), "0x10de\n").unwrap();
        std::fs::write(device.join("boot_vga"), "0\n").unwrap();
        std::os::unix::fs::symlink("/sys/bus/pci/drivers/nvidia", device.join("driver")).unwrap();

        assert!(!nvidia_is_primary_gpu(root.path()));
    }

    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn ignores_primary_nvidia_gpu_using_nouveau() {
        let root = ScratchDir::new("nouveau-primary");
        let device = root.path().join("card0/device");
        std::fs::create_dir_all(&device).unwrap();
        std::fs::write(device.join("vendor"), "0x10de\n").unwrap();
        std::fs::write(device.join("boot_vga"), "1\n").unwrap();
        std::os::unix::fs::symlink("/sys/bus/pci/drivers/nouveau", device.join("driver")).unwrap();

        assert!(!nvidia_is_primary_gpu(root.path()));
    }

    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn detects_explicit_nvidia_renderer_environment() {
        let root = ScratchDir::new("nvidia-renderer-env");

        assert!(linux_uses_nvidia_renderer(
            root.path(),
            Some(OsStr::new("1")),
            None,
        ));
        assert!(linux_uses_nvidia_renderer(
            root.path(),
            None,
            Some(OsStr::new("NVIDIA")),
        ));
        assert!(!linux_uses_nvidia_renderer(
            root.path(),
            Some(OsStr::new("0")),
            Some(OsStr::new("mesa")),
        ));
    }

    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn selects_modern_shm_fallback_for_current_nvidia_webkitgtk() {
        assert_eq!(
            linux_dmabuf_workaround((2, 47), false),
            Some(LinuxDmabufWorkaround::Disable)
        );
        assert_eq!(
            linux_dmabuf_workaround((2, 51), true),
            Some(LinuxDmabufWorkaround::Disable)
        );
        assert_eq!(
            linux_dmabuf_workaround((2, 52), true),
            Some(LinuxDmabufWorkaround::ForceShm)
        );
        assert_eq!(linux_dmabuf_workaround((2, 52), false), None);
    }

    // Regression for issue #2087: on an x86-64 CPU without AVX, WebKitGTK's
    // WebAssembly OSR entry runs an unconditionally AVX trampoline and takes
    // the renderer down with SIGILL, so both options have to be pinned off.
    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn disables_wasm_osr_entry_only_without_avx() {
        assert!(linux_needs_wasm_osr_workaround(false, false));
        assert!(!linux_needs_wasm_osr_workaround(true, false));
    }

    // Turning either option back on is the escape hatch, and it takes the whole
    // pair out of GeoLibre's hands: half the workaround costs WebAssembly
    // performance without saving the renderer.
    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn keeps_an_explicit_wasm_osr_setting() {
        assert!(!linux_needs_wasm_osr_workaround(false, true));
        assert!(!linux_needs_wasm_osr_workaround(true, true));
    }

    // An option someone already turned off is not an opt-out, so the other half
    // of the pair still gets applied. Which values count as off is
    // JavaScriptCore's rule, verified against WebKitGTK 2.52.6: `false` and
    // `no` in any case, and `0`, disable an option; `true`, `yes` and `1` turn
    // it on; and a value it cannot parse leaves the default, which for both of
    // these options is on.
    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn reads_wasm_osr_values_the_way_javascriptcore_does() {
        for off in ["false", "FALSE", "False", "no", "NO", "No", "0"] {
            assert!(jsc_option_is_off(OsStr::new(off)), "{off}");
        }
        for on in ["true", "TRUE", "1", "yes", "YES", "garbage", ""] {
            assert!(!jsc_option_is_off(OsStr::new(on)), "{on}");
        }
    }

    // Both options are needed: with either one left on, the web process still
    // enters the trampoline (measured on WebKitGTK 2.52.6). They are read by
    // JavaScriptCore straight out of the environment, so the names carry the
    // `JSC_` prefix.
    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn pins_both_javascriptcore_wasm_osr_options() {
        assert_eq!(
            WASM_OSR_ENTRY_JSC_OPTIONS,
            ["JSC_useWasmOSR", "JSC_useBBQTierUpChecks"]
        );
    }

    // Every architecture other than x86 skips the workaround, and the x86
    // answer has to come from the running CPU rather than from build flags.
    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn reports_avx_support_for_this_cpu() {
        let supported = cpu_supports_avx();
        if !cfg!(any(target_arch = "x86", target_arch = "x86_64")) {
            assert!(supported);
            return;
        }
        // Cross-check against the kernel where it reports the flags. A
        // hypervisor can mask them, and a restricted /proc need not carry a
        // `flags` line at all, so a missing line means "nothing to compare",
        // not a failure.
        let cpuinfo = std::fs::read_to_string("/proc/cpuinfo").unwrap_or_default();
        let mut flag_lines = cpuinfo.lines().filter(|line| line.starts_with("flags"));
        if let Some(flags) = flag_lines.next() {
            assert_eq!(
                supported,
                flags.split_whitespace().any(|flag| flag == "avx")
            );
        }
    }
}
