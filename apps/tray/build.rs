//! The Windows build's version resource: Windows 11 names a tray icon in Settings › Personalization › Taskbar ›
//! Other system tray icons by its executable's FileDescription, so it says "Lookover", not "lookover-tray.exe". The
//! version is the one `main.rs` compiles in: `LOOKOVER_VERSION` (`bun run build` sets it), else the crate's. Other
//! targets get nothing; the check is on the target, not on the machine building it.

use std::env;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=LOOKOVER_VERSION");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let version = env::var("LOOKOVER_VERSION")
        .ok()
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| env::var("CARGO_PKG_VERSION").unwrap_or_default());
    let mut resource = winresource::WindowsResource::new();
    resource
        .set("FileDescription", "Lookover")
        .set("ProductName", "Lookover")
        .set("FileVersion", &version)
        .set("ProductVersion", &version)
        .set_version_info(winresource::VersionInfo::FILEVERSION, packed(&version))
        .set_version_info(winresource::VersionInfo::PRODUCTVERSION, packed(&version));
    if let Err(error) = resource.compile_for("lookover-tray") {
        panic!("the version resource didn't compile (rc.exe, from the Windows SDK): {error}");
    }
}

/// `major.minor.patch[-pre]` as a version resource's four 16-bit words, the last 0: "1.2.3-rc.1" is 1.2.3.0.
fn packed(version: &str) -> u64 {
    let core = version.split(['-', '+']).next().unwrap_or_default();
    let mut words = core.split('.').map(|word| word.parse::<u16>().unwrap_or(0));
    let mut packed = 0_u64;
    for shift in [48, 32, 16] {
        packed |= u64::from(words.next().unwrap_or(0)) << shift;
    }
    packed
}
