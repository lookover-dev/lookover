//! `lookover-tray` (ADR 0105): Lookover's icon in the tray. The service starts it and drives it over its standard
//! streams (`protocol`); it holds no logic and no secret, never reads the data folder, the session or the network,
//! and draws what it is told. It ends when its standard input closes, taking its icon off first.
//!
//!   lookover-tray                       serve the protocol on stdin and stdout
//!   lookover-tray --version             print the version `bun run build` compiled in (LOOKOVER_VERSION)
//!   lookover-tray --self-test <tooltip> add an icon with that tooltip, show each state, add it again as after
//!                                       Explorer restarts, remove it, print one JSON line of what the OS
//!                                       answered; exit 0 only if every call succeeded
//!
//! Windows and macOS draw through `tray-icon` on a `tao` loop (`desktop`), Linux through `ksni` (`linux`).

// No console window on Windows: the service starts it, and its standard streams are pipes.
#![cfg_attr(windows, windows_subsystem = "windows")]

mod driver;
mod icons;
mod protocol;
mod self_test;

#[cfg(any(windows, target_os = "macos"))]
mod desktop;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod win32;

/// The program's version, as `bun run build` compiles it in from the root package.json; else the crate's.
pub const VERSION: &str = match option_env!("LOOKOVER_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

/// What the command line asks for.
#[derive(Debug, PartialEq, Eq)]
enum Mode {
    Serve,
    Version,
    SelfTest(String),
}

/// The mode `args` (after the program's name) ask for, or why they can't be read.
fn mode(args: &[String]) -> Result<Mode, String> {
    match args {
        [] => Ok(Mode::Serve),
        [flag] if flag == "--version" => Ok(Mode::Version),
        [flag, tooltip] if flag == "--self-test" && !tooltip.is_empty() => {
            Ok(Mode::SelfTest(tooltip.clone()))
        }
        _ => Err(format!(
            "lookover-tray reads no arguments, --version, or --self-test <tooltip>; not {}",
            args.join(" ")
        )),
    }
}

#[cfg(any(windows, target_os = "macos"))]
use desktop as platform;
#[cfg(target_os = "linux")]
use linux as platform;

/// Anywhere else: no tray this helper knows how to draw on.
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
mod platform {
    pub fn serve() {
        crate::driver::say(
            &mut std::io::stdout(),
            &crate::protocol::unavailable("No tray on this system"),
        );
    }
    pub fn self_test(_tooltip: &str) -> i32 {
        let mut report = crate::self_test::Report::new();
        report.step("add", false, serde_json::json!("No tray on this system"));
        report.print()
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match mode(&args) {
        Ok(Mode::Serve) => platform::serve(),
        Ok(Mode::Version) => driver::say(&mut std::io::stdout(), VERSION),
        Ok(Mode::SelfTest(tooltip)) => std::process::exit(platform::self_test(&tooltip)),
        Err(why) => {
            driver::say(&mut std::io::stderr(), &why);
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn no_argument_serves_the_protocol() {
        assert_eq!(mode(&[]), Ok(Mode::Serve));
    }

    #[test]
    fn version_and_self_test_are_read() {
        assert_eq!(mode(&args(&["--version"])), Ok(Mode::Version));
        assert_eq!(
            mode(&args(&["--self-test", "lookover-dev-a1"])),
            Ok(Mode::SelfTest("lookover-dev-a1".to_string()))
        );
    }

    #[test]
    fn anything_else_is_refused() {
        for words in [
            &["--self-test"][..],
            &["--self-test", ""],
            &["--help"],
            &["--version", "x"],
        ] {
            assert!(mode(&args(words)).is_err(), "{words:?}");
        }
    }
}
