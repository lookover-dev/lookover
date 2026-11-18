//! What Windows answers the helper: its DPI, the taskbar's small icon's size and theme, and whether an icon is on
//! the tray. Each call is the OS's own; nothing here draws.

use windows_sys::Win32::Foundation::{ERROR_SUCCESS, HWND, RECT, S_OK};
use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
use windows_sys::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForSystem, GetDpiForWindow,
    GetSystemMetricsForDpi, SetProcessDpiAwarenessContext,
};
use windows_sys::Win32::UI::Shell::{
    NIM_DELETE, NOTIFYICONDATAW, NOTIFYICONIDENTIFIER, Shell_NotifyIconGetRect, Shell_NotifyIconW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    FindWindowW, RegisterWindowMessageW, SM_CXSMICON, SendMessageW,
};

use crate::icons::{Variant, size_for};

/// A string as Windows takes it: UTF-16, ending in a zero.
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

/// Makes the process aware of each monitor's DPI, before any window exists; whether Windows agreed.
pub fn per_monitor_dpi_aware() -> bool {
    // SAFETY: a plain call with a constant; it only fails if the awareness was already set.
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) != 0 }
}

/// The DPI of the taskbar's monitor (where the notification area is), else the system's.
fn taskbar_dpi() -> u32 {
    let class = wide("Shell_TrayWnd");
    // SAFETY: `class` is a live, zero-ended UTF-16 string; a null title matches any window of the class.
    let taskbar = unsafe { FindWindowW(class.as_ptr(), std::ptr::null()) };
    // SAFETY: GetDpiForWindow takes any window handle and answers 0 for an invalid one.
    let dpi = if taskbar.is_null() {
        0
    } else {
        unsafe { GetDpiForWindow(taskbar) }
    };
    // SAFETY: no arguments.
    if dpi == 0 {
        unsafe { GetDpiForSystem() }
    } else {
        dpi
    }
}

/// Whether the taskbar is light (`SystemUsesLightTheme` = 1); dark when Windows doesn't say.
fn light_taskbar() -> bool {
    let key = wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
    let value = wide("SystemUsesLightTheme");
    let mut data: u32 = 0;
    let mut size = size_of::<u32>() as u32;
    // SAFETY: the strings are zero-ended UTF-16 and live; `data` holds the DWORD the flags restrict it to.
    let read = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&raw mut data).cast(),
            &mut size,
        )
    };
    read == ERROR_SUCCESS && data == 1
}

/// The drawing the taskbar takes now, and what Windows answered to pick it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Look {
    pub variant: Variant,
    pub size: u32,
    pub dpi: u32,
    /// The small icon's side Windows asks for at that DPI (`SM_CXSMICON`).
    pub asked: i32,
}

/// The variant and size for the taskbar as it is now: asked again on each call, so a DPI or theme change is seen.
pub fn look() -> Look {
    let dpi = taskbar_dpi();
    // SAFETY: a metric index and a DPI; answers 0 on failure.
    let asked = unsafe { GetSystemMetricsForDpi(SM_CXSMICON, dpi) };
    let variant = if light_taskbar() {
        Variant::Light
    } else {
        Variant::Dark
    };
    let size = size_for(u32::try_from(asked).unwrap_or(16), variant.sizes());
    Look {
        variant,
        size,
        dpi,
        asked,
    }
}

/// The rectangle, width and height, of the icon `id` of the window `hwnd` on the tray; none when it isn't there.
pub fn on_tray(hwnd: HWND, id: u32) -> Option<(i32, i32)> {
    let identifier = NOTIFYICONIDENTIFIER {
        cbSize: size_of::<NOTIFYICONIDENTIFIER>() as u32,
        hWnd: hwnd,
        uID: id,
        // SAFETY: a plain C struct, all zero is its empty GUID.
        ..unsafe { std::mem::zeroed() }
    };
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    // SAFETY: both point to live structs of the right size.
    let found = unsafe { Shell_NotifyIconGetRect(&identifier, &mut rect) } == S_OK;
    found.then_some((rect.right - rect.left, rect.bottom - rect.top))
}

/// The id `tray-icon` gave the window's icon (its own counter, from 1): the first id the tray knows.
pub fn icon_id(hwnd: HWND) -> Option<u32> {
    (1..=64).find(|&id| on_tray(hwnd, id).is_some())
}

/// Takes the icon `id` of the window `hwnd` off the tray behind `tray-icon`'s back (`NIM_DELETE`), as an Explorer
/// that dies takes every icon with it; whether the tray said it did.
pub fn take_off(hwnd: HWND, id: u32) -> bool {
    let data = NOTIFYICONDATAW {
        cbSize: size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: hwnd,
        uID: id,
        // SAFETY: a plain C struct; all zero is no flags, no icon, no text.
        ..unsafe { std::mem::zeroed() }
    };
    // SAFETY: points to a live struct of the right size.
    unsafe { Shell_NotifyIconW(NIM_DELETE, &data) != 0 }
}

/// Sends the window what Explorer broadcasts when it starts again (`TaskbarCreated`): `tray-icon`'s own window
/// handles it as after a real restart, adding the icon again (`NIM_ADD`) with the drawing and tooltip it last had.
pub fn taskbar_created(hwnd: HWND) {
    let name = wide("TaskbarCreated");
    // SAFETY: a zero-ended UTF-16 name; the message is sent to the helper's own live window.
    unsafe {
        let message = RegisterWindowMessageW(name.as_ptr());
        SendMessageW(hwnd, message, 0, 0);
    }
}
