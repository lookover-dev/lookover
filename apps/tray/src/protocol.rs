//! The protocol (ADR 0105 §4): one JSON object per line, both ways. The helper says `ready` (or `unavailable`)
//! first, reads `show` lines, and writes a `click` line for each menu item or left click. Pure: no I/O here.

use serde::{Deserialize, Serialize};

/// The protocol's version, said in `ready`: the service refuses a helper that names another.
pub const PROTOCOL: u32 = 1;

/// The icon's state, worst first, spelled as the protocol and the icons' file names spell it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    Problem,
    Paused,
    NeedsYou,
    Reviewing,
    Idle,
}

impl State {
    /// Every state, worst first.
    pub const ALL: [State; 5] = [
        State::Problem,
        State::Paused,
        State::NeedsYou,
        State::Reviewing,
        State::Idle,
    ];

    /// Its name on the wire and in the icons' file names.
    pub fn name(self) -> &'static str {
        match self {
            State::Problem => "problem",
            State::Paused => "paused",
            State::NeedsYou => "needs-you",
            State::Reviewing => "reviewing",
            State::Idle => "idle",
        }
    }
}

/// What the service asks the icon to show: its state, its tooltip, the menu's one line, Pause or Resume.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Show {
    pub state: State,
    pub tooltip: String,
    pub line: String,
    pub paused: bool,
}

/// What can be clicked, by its name on the wire (also the menu item's id).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Item {
    Open,
    PauseHour,
    PauseTomorrow,
    PauseForever,
    Resume,
    Quit,
}

impl Item {
    /// Every item, in the menu's order.
    #[cfg_attr(
        target_os = "linux",
        allow(dead_code, reason = "ksni's items hold their own")
    )]
    pub const ALL: [Item; 6] = [
        Item::Open,
        Item::PauseHour,
        Item::PauseTomorrow,
        Item::PauseForever,
        Item::Resume,
        Item::Quit,
    ];

    /// Its name on the wire.
    pub fn name(self) -> &'static str {
        match self {
            Item::Open => "open",
            Item::PauseHour => "pause.hour",
            Item::PauseTomorrow => "pause.tomorrow",
            Item::PauseForever => "pause.forever",
            Item::Resume => "resume",
            Item::Quit => "quit",
        }
    }

    /// The item a menu id names, if any.
    #[cfg_attr(
        target_os = "linux",
        allow(dead_code, reason = "ksni's items hold their own")
    )]
    pub fn named(name: &str) -> Option<Item> {
        Item::ALL.into_iter().find(|item| item.name() == name)
    }

    /// The words the menu shows for it.
    pub fn label(self) -> &'static str {
        match self {
            Item::Open => "Open Lookover",
            Item::PauseHour => "For 1 hour",
            Item::PauseTomorrow => "Until tomorrow",
            Item::PauseForever => "Until I resume",
            Item::Resume => "Resume reviews",
            Item::Quit => "Quit Lookover",
        }
    }
}

/// The submenu holding the three pauses.
pub const PAUSE_LABEL: &str = "Pause reviews";

/// The pauses, in the submenu's order.
pub const PAUSES: [Item; 3] = [Item::PauseHour, Item::PauseTomorrow, Item::PauseForever];

/// What the icon shows before the service's first `show`.
pub fn first_show() -> Show {
    Show {
        state: State::Idle,
        tooltip: "Lookover".to_string(),
        line: "Lookover is starting".to_string(),
        paused: false,
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Incoming {
    Show(Show),
}

/// A line the service sent, read as a `show`, or why it can't be.
pub fn read(line: &str) -> Result<Show, String> {
    match serde_json::from_str::<Incoming>(line) {
        Ok(Incoming::Show(show)) => Ok(show),
        Err(error) => Err(error.to_string()),
    }
}

/// A line the helper writes, its fields in the order the protocol lists them.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Outgoing<'a> {
    Ready { version: &'a str, protocol: u32 },
    Unavailable { reason: &'a str },
    Click { item: &'static str },
}

fn written(outgoing: &Outgoing) -> String {
    // A struct of strings and numbers always serializes.
    serde_json::to_string(outgoing).unwrap_or_default()
}

/// The first line when the icon is up.
pub fn ready(version: &str) -> String {
    written(&Outgoing::Ready {
        version,
        protocol: PROTOCOL,
    })
}

/// The first and only line when no icon can be shown.
pub fn unavailable(reason: &str) -> String {
    written(&Outgoing::Unavailable { reason })
}

/// The line for a click on `item`.
pub fn click(item: Item) -> String {
    written(&Outgoing::Click { item: item.name() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_names_the_version_and_protocol_1() {
        assert_eq!(
            ready("0.17.0"),
            r#"{"type":"ready","version":"0.17.0","protocol":1}"#
        );
    }

    #[test]
    fn unavailable_says_why() {
        assert_eq!(
            unavailable("No tray host on this desktop"),
            r#"{"type":"unavailable","reason":"No tray host on this desktop"}"#
        );
    }

    #[test]
    fn each_click_names_its_item() {
        let lines: Vec<String> = Item::ALL.into_iter().map(click).collect();
        assert_eq!(
            lines,
            [
                r#"{"type":"click","item":"open"}"#,
                r#"{"type":"click","item":"pause.hour"}"#,
                r#"{"type":"click","item":"pause.tomorrow"}"#,
                r#"{"type":"click","item":"pause.forever"}"#,
                r#"{"type":"click","item":"resume"}"#,
                r#"{"type":"click","item":"quit"}"#,
            ]
        );
    }

    #[test]
    fn a_menu_id_names_its_item_and_nothing_else_does() {
        assert_eq!(Item::named("pause.tomorrow"), Some(Item::PauseTomorrow));
        assert_eq!(Item::named("quit"), Some(Item::Quit));
        assert_eq!(Item::named("pause"), None);
    }

    #[test]
    fn a_show_line_is_read_with_each_state() {
        let states = [
            ("problem", State::Problem),
            ("paused", State::Paused),
            ("needs-you", State::NeedsYou),
            ("reviewing", State::Reviewing),
            ("idle", State::Idle),
        ];
        for (name, state) in states {
            let line = format!(
                r#"{{"type":"show","state":"{name}","tooltip":"Lookover: All good","line":"All good","paused":true}}"#
            );
            assert_eq!(
                read(&line),
                Ok(Show {
                    state,
                    tooltip: "Lookover: All good".to_string(),
                    line: "All good".to_string(),
                    paused: true,
                })
            );
            assert_eq!(state.name(), name);
        }
    }

    #[test]
    fn a_field_it_does_not_know_is_left_alone() {
        let line =
            r#"{"type":"show","state":"idle","tooltip":"t","line":"l","paused":false,"since":3}"#;
        assert!(read(line).is_ok());
    }

    #[test]
    fn a_bad_line_says_why() {
        for line in [
            "",
            "not json",
            r#"{"type":"hide"}"#,
            r#"{"type":"show","state":"asleep","tooltip":"t","line":"l","paused":false}"#,
            r#"{"type":"show","state":"idle","tooltip":"t","paused":false}"#,
            r#"{"type":"show","state":"idle","tooltip":"t","line":"l","paused":"no"}"#,
            r#"{"state":"idle","tooltip":"t","line":"l","paused":false}"#,
        ] {
            assert!(read(line).is_err(), "{line} was read");
        }
    }
}
