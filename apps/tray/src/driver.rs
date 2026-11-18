//! What the helper does with what it reads, behind the `Tray` seam: each platform's icon is a `Tray`, and the
//! tests drive a fake one, so they draw nothing. Standard input is read on its own thread (`pump`) and handed to
//! the `Driver`, on the thread that owns the icon.

use std::io::{BufRead, Write};
use std::time::{Duration, Instant};

use crate::protocol::{self, Show};

/// The icon on one platform's tray.
pub trait Tray {
    /// Shows what the service asked for; why it couldn't, if it couldn't.
    fn show(&mut self, show: &Show) -> Result<(), String>;
    /// Takes the icon off the tray.
    fn remove(&mut self);
}

/// What standard input gave.
#[derive(Debug, PartialEq, Eq)]
pub enum Input {
    Line(String),
    /// It closed (or failed): the service is gone.
    Closed,
}

/// Reads `reader` a line at a time into `send`, then `Closed` once it ends or fails; stops early when `send`
/// answers false (nobody is listening any more).
pub fn pump(reader: impl BufRead, mut send: impl FnMut(Input) -> bool) {
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if !send(Input::Line(line)) {
            return;
        }
    }
    send(Input::Closed);
}

/// Hands each line to the tray, says each bad one on `err`, and takes the icon off when input closes.
pub struct Driver<T: Tray, E: Write> {
    tray: Option<T>,
    err: E,
}

impl<T: Tray, E: Write> Driver<T, E> {
    pub fn new(tray: T, err: E) -> Self {
        Driver {
            tray: Some(tray),
            err,
        }
    }

    /// The icon, while it is on the tray.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn tray_mut(&mut self) -> Option<&mut T> {
        self.tray.as_mut()
    }

    /// Acts on `input`; whether the helper runs on (false once input closed and the icon is off).
    pub fn input(&mut self, input: Input) -> bool {
        match input {
            Input::Line(line) => {
                let shown = protocol::read(&line).and_then(|show| match self.tray.as_mut() {
                    Some(tray) => tray.show(&show),
                    None => Ok(()),
                });
                if let Err(why) = shown {
                    say(
                        &mut self.err,
                        &format!("lookover-tray: ignored a line ({why}): {line}"),
                    );
                }
                true
            }
            Input::Closed => {
                if let Some(mut tray) = self.tray.take() {
                    tray.remove();
                }
                false
            }
        }
    }
}

/// Writes `line` and flushes it, so the reader at the other end has it now. A closed pipe is not an error here:
/// the service is gone, and closed input ends the helper.
pub fn say(out: &mut impl Write, line: &str) {
    let _ = writeln!(out, "{line}").and_then(|()| out.flush());
}

/// How soon a second left click counts as a repeat (a double click's second half), not a new click.
#[cfg_attr(
    target_os = "linux",
    allow(dead_code, reason = "the panel tells clicks apart itself")
)]
const REPEAT: Duration = Duration::from_millis(600);

/// Left clicks on the icon: one opens Lookover, a repeat within a moment does nothing. Windows only: the Linux
/// panel tells a click (`activate`) from a double click itself.
#[derive(Default)]
#[cfg_attr(
    target_os = "linux",
    allow(dead_code, reason = "the panel tells clicks apart itself")
)]
pub struct LeftClicks {
    last: Option<Instant>,
}

#[cfg_attr(
    target_os = "linux",
    allow(dead_code, reason = "the panel tells clicks apart itself")
)]
impl LeftClicks {
    /// A left button went up at `at`: whether it opens Lookover.
    pub fn up(&mut self, at: Instant) -> bool {
        if self
            .last
            .is_some_and(|last| at.saturating_duration_since(last) < REPEAT)
        {
            return false;
        }
        self.last = Some(at);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::State;
    use std::io::Cursor;

    /// A tray that keeps what it was told.
    #[derive(Default)]
    struct Fake {
        shown: Vec<Show>,
        removed: bool,
    }

    impl Tray for &mut Fake {
        fn show(&mut self, show: &Show) -> Result<(), String> {
            self.shown.push(show.clone());
            Ok(())
        }
        fn remove(&mut self) {
            self.removed = true;
        }
    }

    /// Runs the driver on `input` as the helper does, a thread reading it; what was shown, said and removed.
    fn run(input: &str) -> (Fake, String) {
        let mut fake = Fake::default();
        let mut err = Vec::new();
        {
            let mut driver = Driver::new(&mut fake, &mut err);
            let (send, receive) = std::sync::mpsc::channel();
            let reader = Cursor::new(input.as_bytes().to_vec());
            std::thread::spawn(move || pump(reader, |line| send.send(line).is_ok()));
            for line in receive {
                if !driver.input(line) {
                    break;
                }
            }
        }
        (fake, String::from_utf8(err).unwrap())
    }

    #[test]
    fn a_show_line_is_shown() {
        let (fake, err) = run(
            r#"{"type":"show","state":"reviewing","tooltip":"Lookover: Reviewing lookover-sandbox #12","line":"Reviewing lookover-sandbox #12","paused":false}
"#,
        );
        assert_eq!(
            fake.shown,
            [Show {
                state: State::Reviewing,
                tooltip: "Lookover: Reviewing lookover-sandbox #12".to_string(),
                line: "Reviewing lookover-sandbox #12".to_string(),
                paused: false,
            }]
        );
        assert_eq!(err, "");
    }

    #[test]
    fn a_bad_line_is_ignored_and_said_on_stderr_and_the_next_one_is_read() {
        let (fake, err) = run(concat!(
            "hello\n",
            r#"{"type":"show","state":"idle","tooltip":"Lookover: All good","line":"All good","paused":true}"#,
            "\n"
        ));
        assert_eq!(fake.shown.len(), 1);
        assert!(fake.shown[0].paused);
        assert!(
            err.starts_with("lookover-tray: ignored a line (") && err.ends_with("): hello\n"),
            "{err}"
        );
    }

    #[test]
    fn closed_input_takes_the_icon_off_and_ends() {
        let (fake, _) = run("");
        assert!(fake.removed);
        let (fake, _) = run(
            r#"{"type":"show","state":"problem","tooltip":"Lookover: GitHub signed out","line":"GitHub signed out","paused":false}"#,
        );
        assert_eq!(fake.shown.len(), 1, "a last line with no newline is read");
        assert!(fake.removed);
    }

    #[test]
    fn a_line_ending_in_crlf_is_read() {
        let (fake, err) = run(
            "{\"type\":\"show\",\"state\":\"paused\",\"tooltip\":\"t\",\"line\":\"Paused until you resume\",\"paused\":true}\r\n",
        );
        assert_eq!(fake.shown.len(), 1);
        assert_eq!(err, "");
    }

    #[test]
    fn pump_says_each_line_then_closed() {
        let mut got = Vec::new();
        pump(Cursor::new("a\nb\n"), |input| {
            got.push(input);
            true
        });
        assert_eq!(
            got,
            [
                Input::Line("a".to_string()),
                Input::Line("b".to_string()),
                Input::Closed
            ]
        );
    }

    #[test]
    fn pump_stops_when_nobody_listens() {
        let mut got = 0;
        pump(Cursor::new("a\nb\n"), |_| {
            got += 1;
            false
        });
        assert_eq!(got, 1);
    }

    #[test]
    fn a_left_click_opens_and_its_repeat_within_a_moment_does_not() {
        let mut clicks = LeftClicks::default();
        let start = Instant::now();
        assert!(clicks.up(start));
        assert!(!clicks.up(start + Duration::from_millis(250)));
        assert!(!clicks.up(start + Duration::from_millis(599)));
        assert!(clicks.up(start + Duration::from_millis(600)));
        assert!(clicks.up(start + Duration::from_millis(2000)));
    }
}
