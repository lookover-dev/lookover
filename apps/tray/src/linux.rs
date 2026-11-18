//! The icon on Linux: a StatusNotifierItem over D-Bus (`ksni`, pure Rust, no GTK), run on `ksni`'s own thread.
//! Standard input is read on the main thread and handed to the `Driver`; clicks are written from `ksni`'s thread.
//! A desktop with no StatusNotifierItem host (GNOME without the AppIndicator extension) is `unavailable`.

use std::io::{stderr, stdout};

use ksni::blocking::{Handle, TrayMethods};
use ksni::menu::{StandardItem, SubMenu};
use ksni::{Icon, MenuItem, ToolTip};
use serde_json::json;

use crate::driver::{Driver, Tray, pump, say};
use crate::icons::{Variant, argb, pixels};
use crate::protocol::{self, Item, PAUSE_LABEL, PAUSES, Show, State};
use crate::self_test::Report;

/// What `ksni` asks of the item, from what it was last told to show.
struct PanelItem {
    shown: Show,
}

fn click(item: Item) -> MenuItem<PanelItem> {
    StandardItem {
        label: item.label().to_string(),
        activate: Box::new(move |_: &mut PanelItem| say(&mut stdout(), &protocol::click(item))),
        ..Default::default()
    }
    .into()
}

impl ksni::Tray for PanelItem {
    fn id(&self) -> String {
        "lookover-tray".to_string()
    }

    fn title(&self) -> String {
        "Lookover".to_string()
    }

    fn activate(&mut self, _x: i32, _y: i32) {
        say(&mut stdout(), &protocol::click(Item::Open));
    }

    fn icon_pixmap(&self) -> Vec<Icon> {
        Variant::Panel
            .sizes()
            .iter()
            .filter_map(|&size| pixels(self.shown.state, Variant::Panel, size).ok())
            .map(|p| Icon {
                width: p.size as i32,
                height: p.size as i32,
                data: argb(&p.rgba),
            })
            .collect()
    }

    fn tool_tip(&self) -> ToolTip {
        ToolTip {
            title: self.shown.tooltip.clone(),
            ..Default::default()
        }
    }

    fn menu(&self) -> Vec<MenuItem<Self>> {
        let line = StandardItem {
            label: self.shown.line.clone(),
            enabled: false,
            ..Default::default()
        };
        let pause_or_resume = if self.shown.paused {
            click(Item::Resume)
        } else {
            SubMenu {
                label: PAUSE_LABEL.to_string(),
                submenu: PAUSES.into_iter().map(click).collect(),
                ..Default::default()
            }
            .into()
        };
        vec![
            click(Item::Open),
            line.into(),
            MenuItem::Separator,
            pause_or_resume,
            MenuItem::Separator,
            click(Item::Quit),
        ]
    }
}

/// The item on the panel.
struct LinuxTray {
    handle: Option<Handle<PanelItem>>,
}

/// Why no icon can be shown here, if none can.
fn no_desktop() -> Option<String> {
    let set = |name: &str| std::env::var_os(name).is_some_and(|v| !v.is_empty());
    (!set("DISPLAY") && !set("WAYLAND_DISPLAY"))
        .then(|| "No desktop to show an icon on".to_string())
}

impl LinuxTray {
    fn new(tooltip: &str) -> Result<Self, String> {
        if let Some(why) = no_desktop() {
            return Err(why);
        }
        let shown = Show {
            tooltip: tooltip.to_string(),
            ..protocol::first_show()
        };
        let handle = PanelItem { shown }.spawn().map_err(|e| match e {
            ksni::Error::Dbus(e) => format!("No D-Bus session to reach the panel: {e}"),
            e => format!("No tray host on this desktop: {e}"),
        })?;
        Ok(LinuxTray {
            handle: Some(handle),
        })
    }
}

impl Tray for LinuxTray {
    fn show(&mut self, show: &Show) -> Result<(), String> {
        let updated = self
            .handle
            .as_ref()
            .and_then(|h| h.update(|item| item.shown = show.clone()));
        updated.ok_or_else(|| "the panel's item has stopped".to_string())
    }

    fn remove(&mut self) {
        if let Some(handle) = self.handle.take() {
            handle.shutdown().wait();
        }
    }
}

/// Serves the protocol until standard input closes.
pub fn serve() {
    match LinuxTray::new("Lookover") {
        Ok(tray) => {
            say(&mut stdout(), &protocol::ready(crate::VERSION));
            let mut driver = Driver::new(tray, stderr());
            pump(std::io::stdin().lock(), |input| driver.input(input));
        }
        Err(why) => say(&mut stdout(), &protocol::unavailable(&why)),
    }
}

/// What `ksni`'s registration answered, as a self-test step's `said`, and whether the item still runs. `spawn`
/// returns a handle only once the session bus took the item's name, `org.kde.StatusNotifierWatcher` accepted
/// `RegisterStatusNotifierItem` and said a host is registered (`IsStatusNotifierHostRegistered`); an error from
/// any of them is the step's failure instead.
fn registered(tray: &LinuxTray) -> (bool, serde_json::Value) {
    let running = tray.handle.as_ref().is_some_and(|h| !h.is_closed());
    let said = json!({
        "watcher": "org.kde.StatusNotifierWatcher accepted RegisterStatusNotifierItem",
        "host_registered": true,
        "running": running,
    });
    (running, said)
}

/// Adds the item, shows each state, adds it again, removes it; the exit code.
pub fn self_test(tooltip: &str) -> i32 {
    let mut report = Report::new();
    report.fact("variant", json!(Variant::Panel.name()));
    let mut tray = match LinuxTray::new(tooltip) {
        Ok(tray) => tray,
        Err(why) => {
            report.step("add", false, json!(why));
            return report.print();
        }
    };
    let (ok, said) = registered(&tray);
    report.step("add", ok, said);
    for (i, state) in State::ALL.into_iter().enumerate() {
        let shown = tray.show(&Show {
            state,
            tooltip: tooltip.to_string(),
            line: state.name().to_string(),
            paused: i % 2 == 0,
        });
        report.step(
            &format!("show {}", state.name()),
            shown.is_ok(),
            json!(shown.err()),
        );
    }
    tray.remove();
    match LinuxTray::new(tooltip) {
        Ok(again) => {
            let (ok, said) = registered(&again);
            report.step("add again", ok, said);
            tray = again;
        }
        Err(why) => report.step("add again", false, json!(why)),
    }
    let closed = tray.handle.as_ref().map(|h| {
        h.shutdown().wait();
        h.is_closed()
    });
    report.step("remove", closed.unwrap_or(true), serde_json::Value::Null);
    report.print()
}
