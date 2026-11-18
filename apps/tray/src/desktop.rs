//! The icon on Windows and macOS: `tray-icon` and its `muda` menu on a `tao` loop on the main thread. Standard
//! input is read on a thread and reaches the loop through an `EventLoopProxy`; the icon is created once the loop
//! runs (`StartCause::Init`), as `tray-icon` asks. On Windows a left click opens Lookover and the drawing follows
//! the taskbar's DPI and theme, looked at again every few seconds; on macOS the helper is an accessory (no Dock
//! icon), the drawing a template image the menu bar tints, and a click opens the menu.

use std::io::{Stderr, stderr, stdout};
use std::time::Instant;

use serde_json::json;
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder};
use tray_icon::menu::{IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder, TrayIconEvent};

use crate::driver::{Driver, Input, LeftClicks, Tray, pump, say};
use crate::icons::{Variant, pixels};
use crate::protocol::{self, Item, PAUSE_LABEL, PAUSES, Show, State};
use crate::self_test::Report;

/// What reaches the loop from other threads.
enum Ev {
    Input(Input),
    Tray(TrayIconEvent),
    Menu(MenuEvent),
}

/// The drawing the tray takes now: its variant and side.
type Look = (Variant, u32);

#[cfg(windows)]
fn look() -> Look {
    let look = crate::win32::look();
    (look.variant, look.size)
}

#[cfg(target_os = "macos")]
fn look() -> Look {
    // The menu bar's 18 pt at 2x.
    (Variant::Template, 36)
}

/// How often Windows' DPI and taskbar theme are looked at again. Polled, because the change messages never reach
/// the helper: Windows sends (not posts) `WM_SETTINGCHANGE` and `WM_DPICHANGED` straight to a top-level window's
/// procedure, so `tao`'s loop, which has no window here, never sees them, and the one window the helper has is
/// `tray-icon`'s hidden one, whose procedure isn't ours to hook. Each look is a registry read and two cheap calls; the icon is drawn again only when it changed.
#[cfg(windows)]
const LOOK_AGAIN: std::time::Duration = std::time::Duration::from_secs(2);

/// Where Pause reviews (or Resume reviews) sits in the menu: after Open Lookover, the line and a separator.
const PAUSE_AT: usize = 3;

/// What the menu's place for Pause reviews holds now: the submenu, Resume reviews, or neither (one taken out, the
/// other not yet put in).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Offered {
    Pause,
    Resume,
    Neither,
}

/// The menu's place for Pause reviews: its item taken out, or put in. Either can fail, as the OS's menu can.
trait PauseSlot {
    fn take_out(&self, offered: Offered) -> Result<(), String>;
    fn put_in(&self, offered: Offered) -> Result<(), String>;
}

/// Makes `slot` offer Resume when `paused`, else Pause, `offered` saying what it holds after each step that worked:
/// a step that fails leaves it true, so the next show takes up from there, never takes out what isn't in.
fn offer(slot: &impl PauseSlot, offered: &mut Offered, paused: bool) -> Result<(), String> {
    let wanted = if paused {
        Offered::Resume
    } else {
        Offered::Pause
    };
    if *offered == wanted {
        return Ok(());
    }
    if *offered != Offered::Neither {
        slot.take_out(*offered)?;
        *offered = Offered::Neither;
    }
    slot.put_in(wanted)?;
    *offered = wanted;
    Ok(())
}

/// The icon and its menu.
struct DesktopTray {
    tray: Option<TrayIcon>,
    menu: Menu,
    line: MenuItem,
    pause: Submenu,
    resume: MenuItem,
    /// What the menu offers, apart from the last show: a show that fails after the swap leaves `shown` behind.
    offered: Offered,
    shown: Show,
    look: Look,
}

impl PauseSlot for DesktopTray {
    fn take_out(&self, offered: Offered) -> Result<(), String> {
        match offered {
            Offered::Pause => self.menu.remove(&self.pause),
            Offered::Resume => self.menu.remove(&self.resume),
            Offered::Neither => return Ok(()),
        }
        .map_err(|e| e.to_string())
    }

    fn put_in(&self, offered: Offered) -> Result<(), String> {
        match offered {
            Offered::Pause => self.menu.insert(&self.pause, PAUSE_AT),
            Offered::Resume => self.menu.insert(&self.resume, PAUSE_AT),
            Offered::Neither => return Ok(()),
        }
        .map_err(|e| e.to_string())
    }
}

fn item(item: Item) -> MenuItem {
    MenuItem::with_id(item.name(), item.label(), true, None)
}

fn icon(state: State, (variant, size): Look) -> Result<Icon, String> {
    let pixels = pixels(state, variant, size)?;
    Icon::from_rgba(pixels.rgba, pixels.size, pixels.size).map_err(|e| e.to_string())
}

impl DesktopTray {
    /// The icon on the tray, with `tooltip`, showing the first state.
    fn new(tooltip: &str) -> Result<Self, String> {
        let shown = Show {
            tooltip: tooltip.to_string(),
            ..protocol::first_show()
        };
        let line = MenuItem::new(&shown.line, false, None);
        let pauses: Vec<MenuItem> = PAUSES.into_iter().map(item).collect();
        let pause_items: Vec<&dyn IsMenuItem> =
            pauses.iter().map(|p| p as &dyn IsMenuItem).collect();
        let pause =
            Submenu::with_items(PAUSE_LABEL, true, &pause_items).map_err(|e| e.to_string())?;
        let menu = Menu::with_items(&[
            &item(Item::Open),
            &line,
            &PredefinedMenuItem::separator(),
            &pause,
            &PredefinedMenuItem::separator(),
            &item(Item::Quit),
        ])
        .map_err(|e| e.to_string())?;
        #[cfg(windows)]
        default_item(&menu);
        let look = look();
        let first = icon(shown.state, look)?;
        let builder = TrayIconBuilder::new()
            .with_menu(Box::new(menu.clone()))
            .with_tooltip(&shown.tooltip)
            .with_menu_on_left_click(cfg!(target_os = "macos"));
        #[cfg(target_os = "macos")]
        let builder = builder.with_icon_templated(first);
        #[cfg(windows)]
        let builder = builder.with_icon(first);
        let tray = builder.build().map_err(|e| e.to_string())?;
        Ok(DesktopTray {
            tray: Some(tray),
            menu,
            line,
            pause,
            resume: item(Item::Resume),
            offered: Offered::Pause,
            shown,
            look,
        })
    }

    /// Draws the state shown at the look the tray takes.
    fn draw(&self) -> Result<(), String> {
        let Some(tray) = &self.tray else {
            return Ok(());
        };
        let icon = icon(self.shown.state, self.look)?;
        #[cfg(target_os = "macos")]
        let set = tray.set_icon_templated(Some(icon));
        #[cfg(windows)]
        let set = tray.set_icon(Some(icon));
        set.map_err(|e| e.to_string())
    }

    /// Draws again when the taskbar's DPI or theme changed; whether it did.
    #[cfg(windows)]
    fn look_again(&mut self) -> Result<bool, String> {
        let now = look();
        if now == self.look {
            return Ok(false);
        }
        self.look = now;
        self.draw().map(|()| true)
    }

    #[cfg(windows)]
    fn hwnd(&self) -> Option<windows_sys::Win32::Foundation::HWND> {
        self.tray.as_ref().map(TrayIcon::window_handle)
    }
}

/// Open Lookover is the menu's default item, drawn in bold, as Windows' notification area menus have one.
#[cfg(windows)]
fn default_item(menu: &Menu) {
    use tray_icon::menu::ContextMenu;
    use windows_sys::Win32::UI::WindowsAndMessaging::SetMenuDefaultItem;
    // SAFETY: the menu's own live handle; position 0, by position (1).
    unsafe {
        SetMenuDefaultItem(menu.hpopupmenu() as _, 0, 1);
    }
}

impl Tray for DesktopTray {
    fn show(&mut self, show: &Show) -> Result<(), String> {
        let mut offered = self.offered;
        let swapped = offer(self, &mut offered, show.paused);
        self.offered = offered;
        swapped?;
        self.line.set_text(&show.line);
        if let Some(tray) = &self.tray {
            tray.set_tooltip(Some(&show.tooltip))
                .map_err(|e| e.to_string())?;
        }
        let redraw = show.state != self.shown.state;
        self.shown = show.clone();
        if redraw { self.draw() } else { Ok(()) }
    }

    fn remove(&mut self) {
        // Dropping it takes it off the tray.
        self.tray.take();
    }
}

/// The loop, with every other thread's events reaching it.
fn event_loop() -> EventLoop<Ev> {
    #[cfg(windows)]
    crate::win32::per_monitor_dpi_aware();
    #[cfg(windows)]
    let event_loop = EventLoopBuilder::<Ev>::with_user_event().build();
    #[cfg(target_os = "macos")]
    let event_loop = {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        let mut event_loop = EventLoopBuilder::<Ev>::with_user_event().build();
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
        event_loop
    };
    let proxy = event_loop.create_proxy();
    TrayIconEvent::set_event_handler(Some(move |e| {
        let _ = proxy.send_event(Ev::Tray(e));
    }));
    let proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |e| {
        let _ = proxy.send_event(Ev::Menu(e));
    }));
    event_loop
}

/// How long the loop sleeps before it next wakes on its own.
fn wait() -> ControlFlow {
    #[cfg(windows)]
    return ControlFlow::WaitUntil(Instant::now() + LOOK_AGAIN);
    #[cfg(not(windows))]
    ControlFlow::Wait
}

/// Serves the protocol until standard input closes.
pub fn serve() {
    let event_loop = event_loop();
    let proxy = event_loop.create_proxy();
    std::thread::spawn(move || {
        pump(std::io::stdin().lock(), |input| {
            proxy.send_event(Ev::Input(input)).is_ok()
        })
    });
    let mut driver: Option<Driver<DesktopTray, Stderr>> = None;
    let mut clicks = LeftClicks::default();
    event_loop.run(move |event, _, flow| {
        *flow = wait();
        match event {
            Event::NewEvents(StartCause::Init) => match DesktopTray::new("Lookover") {
                Ok(tray) => {
                    say(&mut stdout(), &protocol::ready(crate::VERSION));
                    driver = Some(Driver::new(tray, stderr()));
                }
                Err(why) => {
                    say(&mut stdout(), &protocol::unavailable(&why));
                    *flow = ControlFlow::Exit;
                }
            },
            #[cfg(windows)]
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) => {
                if let Some(Err(why)) = driver
                    .as_mut()
                    .and_then(Driver::tray_mut)
                    .map(DesktopTray::look_again)
                {
                    say(
                        &mut stderr(),
                        &format!("lookover-tray: couldn't draw again: {why}"),
                    );
                }
            }
            Event::UserEvent(Ev::Input(input)) => {
                let runs_on = match driver.as_mut() {
                    Some(driver) => driver.input(input),
                    None => input != Input::Closed,
                };
                if !runs_on {
                    driver = None;
                    *flow = ControlFlow::Exit;
                }
            }
            Event::UserEvent(Ev::Menu(event)) => {
                if let Some(item) = Item::named(event.id.as_ref()) {
                    say(&mut stdout(), &protocol::click(item));
                }
            }
            Event::UserEvent(Ev::Tray(event)) if opens(&event) && clicks.up(Instant::now()) => {
                say(&mut stdout(), &protocol::click(Item::Open));
            }
            _ => {}
        }
    });
}

/// Whether a click on the icon opens Lookover: a left button's release on Windows; never on macOS, where a click
/// opens the menu.
fn opens(event: &TrayIconEvent) -> bool {
    use tray_icon::{MouseButton, MouseButtonState};
    cfg!(windows)
        && matches!(
            event,
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
        )
}

/// Adds the icon, shows each state, adds it again as after Explorer restarts, removes it; the exit code.
pub fn self_test(tooltip: &str) -> i32 {
    let tooltip = tooltip.to_string();
    let event_loop = event_loop();
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        if let Event::NewEvents(StartCause::Init) = event {
            let code = run_self_test(&tooltip).print();
            std::process::exit(code);
        }
    })
}

fn run_self_test(tooltip: &str) -> Report {
    let mut report = Report::new();
    #[cfg(windows)]
    {
        let look = crate::win32::look();
        report.fact("dpi", json!(look.dpi));
        report.fact("asked", json!(look.asked));
        report.fact("size", json!(look.size));
        report.fact("variant", json!(look.variant.name()));
    }
    #[cfg(target_os = "macos")]
    report.fact("variant", json!(Variant::Template.name()));
    let mut tray = match DesktopTray::new(tooltip) {
        Ok(tray) => tray,
        Err(why) => {
            report.step("add", false, json!(why));
            return report;
        }
    };
    let on_tray = |tray: &DesktopTray| -> serde_json::Value {
        #[cfg(windows)]
        {
            let hwnd = tray.hwnd();
            let rect = hwnd
                .and_then(crate::win32::icon_id)
                .zip(hwnd)
                .and_then(|(id, hwnd)| crate::win32::on_tray(hwnd, id));
            json!(rect.map(|(w, h)| [w, h]))
        }
        #[cfg(not(windows))]
        json!(
            tray.tray
                .as_ref()
                .and_then(TrayIcon::rect)
                .map(|r| [r.size.width, r.size.height])
        )
    };
    let rect = on_tray(&tray);
    report.step("add", !rect.is_null(), json!({ "rect": rect }));
    for (i, state) in State::ALL.into_iter().enumerate() {
        let show = Show {
            state,
            tooltip: tooltip.to_string(),
            line: state.name().to_string(),
            paused: i % 2 == 0,
        };
        let shown = tray.show(&show);
        let rect = on_tray(&tray);
        report.step(
            &format!("show {}", state.name()),
            shown.is_ok() && !rect.is_null(),
            json!({ "error": shown.err(), "rect": rect }),
        );
    }
    re_add(&mut report, &tray);
    remove(&mut report, tray);
    report
}

/// What Explorer's restart does: the icon goes with the old Explorer (taken off here behind `tray-icon`'s back),
/// the new one broadcasts `TaskbarCreated`, and `tray-icon` adds the icon again. Each half asks the tray itself.
/// `tray-icon` writes "Error removing system tray icon" to standard error on the way, as after a real restart: it
/// deletes the icon before adding it, and finds it already gone.
#[cfg(windows)]
fn re_add(report: &mut Report, tray: &DesktopTray) {
    use crate::win32::{icon_id, on_tray, take_off, taskbar_created};
    let Some((hwnd, id)) = tray.hwnd().and_then(|hwnd| Some((hwnd, icon_id(hwnd)?))) else {
        report.step(
            "take off (Explorer stops)",
            false,
            json!("the icon wasn't on the tray"),
        );
        return;
    };
    let taken = take_off(hwnd, id);
    let still = on_tray(hwnd, id);
    report.step(
        "take off (Explorer stops)",
        taken && still.is_none(),
        json!({ "deleted": taken, "still_on_tray": still.is_some() }),
    );
    taskbar_created(hwnd);
    let rect = on_tray(hwnd, id);
    report.step(
        "add again (TaskbarCreated)",
        rect.is_some(),
        json!({ "rect": rect.map(|(w, h)| [w, h]) }),
    );
}

/// macOS has no Explorer to restart: the item hidden and shown again.
#[cfg(target_os = "macos")]
fn re_add(report: &mut Report, tray: &DesktopTray) {
    let again = tray
        .tray
        .as_ref()
        .map(|t| t.set_visible(false).and_then(|()| t.set_visible(true)));
    let ok = matches!(again, Some(Ok(())));
    report.step(
        "add again (hidden, shown)",
        ok,
        json!(again.and_then(Result::err).map(|e| e.to_string())),
    );
}

/// Takes the icon off; on Windows, asks the tray whether it is gone.
fn remove(report: &mut Report, mut tray: DesktopTray) {
    #[cfg(windows)]
    {
        let hwnd = tray.hwnd();
        let id = hwnd.and_then(crate::win32::icon_id);
        tray.remove();
        let still = hwnd
            .zip(id)
            .and_then(|(hwnd, id)| crate::win32::on_tray(hwnd, id));
        report.step(
            "remove",
            id.is_some() && still.is_none(),
            json!({ "still_on_tray": still.is_some() }),
        );
    }
    #[cfg(not(windows))]
    {
        tray.remove();
        report.step("remove", tray.tray.is_none(), serde_json::Value::Null);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    /// A menu's place as `muda`'s is: taking out what isn't in fails (`NotAChildOfThisMenu`); a put in can be told
    /// to fail once. It keeps what it holds.
    struct Fake {
        holds: RefCell<Vec<Offered>>,
        put_in_fails: Cell<bool>,
    }

    impl Fake {
        fn offering_pause() -> Self {
            Fake {
                holds: RefCell::new(vec![Offered::Pause]),
                put_in_fails: Cell::new(false),
            }
        }
        fn holds(&self) -> Vec<Offered> {
            self.holds.borrow().clone()
        }
    }

    impl PauseSlot for Fake {
        fn take_out(&self, offered: Offered) -> Result<(), String> {
            let mut holds = self.holds.borrow_mut();
            let at = holds
                .iter()
                .position(|&o| o == offered)
                .ok_or("NotAChildOfThisMenu")?;
            holds.remove(at);
            Ok(())
        }
        fn put_in(&self, offered: Offered) -> Result<(), String> {
            if self.put_in_fails.replace(false) {
                return Err("the menu refused".to_string());
            }
            self.holds.borrow_mut().push(offered);
            Ok(())
        }
    }

    #[test]
    fn paused_offers_resume_and_the_same_paused_again_leaves_the_menu_as_it_is() {
        // As when a show swapped the menu, then failed on its tooltip: the next show says the same paused.
        let slot = Fake::offering_pause();
        let mut offered = Offered::Pause;
        offer(&slot, &mut offered, true).unwrap();
        assert_eq!(slot.holds(), vec![Offered::Resume]);
        offer(&slot, &mut offered, true).unwrap();
        assert_eq!(slot.holds(), vec![Offered::Resume]);
        assert_eq!(offered, Offered::Resume);
        offer(&slot, &mut offered, false).unwrap();
        assert_eq!(slot.holds(), vec![Offered::Pause]);
    }

    #[test]
    fn a_put_in_that_fails_is_put_in_by_the_next_show_without_taking_anything_out() {
        let slot = Fake::offering_pause();
        let mut offered = Offered::Pause;
        slot.put_in_fails.set(true);
        assert!(offer(&slot, &mut offered, true).is_err());
        assert_eq!(slot.holds(), vec![]);
        assert_eq!(offered, Offered::Neither);
        offer(&slot, &mut offered, true).unwrap();
        assert_eq!(slot.holds(), vec![Offered::Resume]);
    }

    #[test]
    fn a_put_in_that_fails_then_a_show_back_to_the_first_puts_that_one_in() {
        let slot = Fake::offering_pause();
        let mut offered = Offered::Pause;
        slot.put_in_fails.set(true);
        assert!(offer(&slot, &mut offered, true).is_err());
        offer(&slot, &mut offered, false).unwrap();
        assert_eq!(slot.holds(), vec![Offered::Pause]);
        assert_eq!(offered, Offered::Pause);
    }
}
