//! The icons, embedded from `apps/tray/icons/` (`<state>-<variant>-<size>.png`, written by `bun run brand`):
//! straight 8-bit RGBA PNGs, decoded here into the pixels each platform takes.

use std::io::Cursor;

use crate::protocol::State;

/// Which drawing a platform takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(
    dead_code,
    reason = "each platform draws its own variants; the tests read them all"
)]
pub enum Variant {
    /// Windows, a light taskbar (`SystemUsesLightTheme` = 1).
    Light,
    /// Windows, a dark taskbar.
    Dark,
    /// macOS: a template image, black and alpha, which the menu bar tints.
    Template,
    /// Linux: the icon on its tile, for a panel of either colour.
    Panel,
}

impl Variant {
    #[cfg(test)]
    pub const ALL: [Variant; 4] = [
        Variant::Light,
        Variant::Dark,
        Variant::Template,
        Variant::Panel,
    ];

    /// Its name in the icons' file names.
    pub fn name(self) -> &'static str {
        match self {
            Variant::Light => "light",
            Variant::Dark => "dark",
            Variant::Template => "template",
            Variant::Panel => "panel",
        }
    }

    /// The sides, in pixels, it is drawn at, smallest first.
    #[cfg_attr(
        target_os = "macos",
        allow(dead_code, reason = "macOS takes its one size")
    )]
    pub fn sizes(self) -> &'static [u32] {
        match self {
            Variant::Light | Variant::Dark => &[16, 20, 24, 32, 48],
            Variant::Template => &[36],
            Variant::Panel => &[24, 48],
        }
    }
}

macro_rules! file {
    ($state:literal, $variant:literal, $size:literal) => {
        (
            $state,
            $variant,
            $size,
            include_bytes!(concat!(
                "../icons/",
                $state,
                "-",
                $variant,
                "-",
                $size,
                ".png"
            )) as &[u8],
        )
    };
}

macro_rules! files {
    ($($state:literal),*) => {
        &[$(
            file!($state, "light", 16), file!($state, "light", 20), file!($state, "light", 24),
            file!($state, "light", 32), file!($state, "light", 48),
            file!($state, "dark", 16), file!($state, "dark", 20), file!($state, "dark", 24),
            file!($state, "dark", 32), file!($state, "dark", 48),
            file!($state, "template", 36),
            file!($state, "panel", 24), file!($state, "panel", 48),
        )*]
    };
}

/// Every icon: its state, its variant, its side and its PNG.
static FILES: &[(&str, &str, u32, &[u8])] =
    files!("problem", "paused", "needs-you", "reviewing", "idle");

/// The PNG of `state` drawn for `variant` at `size` pixels, if there is one.
fn png(state: State, variant: Variant, size: u32) -> Option<&'static [u8]> {
    FILES
        .iter()
        .find(|(s, v, n, _)| *s == state.name() && *v == variant.name() && *n == size)
        .map(|(_, _, _, bytes)| *bytes)
}

/// An icon's pixels: straight (not premultiplied) RGBA, row by row, `size` × `size`.
pub struct Pixels {
    pub rgba: Vec<u8>,
    pub size: u32,
}

/// The pixels of `state` drawn for `variant` at `size`, or why there are none.
pub fn pixels(state: State, variant: Variant, size: u32) -> Result<Pixels, String> {
    let name = format!("{}-{}-{size}.png", state.name(), variant.name());
    let bytes = png(state, variant, size).ok_or_else(|| format!("no icon {name}"))?;
    let mut reader = png::Decoder::new(Cursor::new(bytes))
        .read_info()
        .map_err(|e| format!("{name}: {e}"))?;
    let mut rgba = vec![0; reader.output_buffer_size().unwrap_or(0)];
    let frame = reader
        .next_frame(&mut rgba)
        .map_err(|e| format!("{name}: {e}"))?;
    if frame.color_type != png::ColorType::Rgba
        || frame.bit_depth != png::BitDepth::Eight
        || frame.width != size
        || frame.height != size
    {
        return Err(format!(
            "{name} is {}x{} {:?} {:?}, not {size}x{size} 8-bit RGBA",
            frame.width, frame.height, frame.color_type, frame.bit_depth
        ));
    }
    rgba.truncate(frame.buffer_size());
    Ok(Pixels { rgba, size })
}

/// The size to draw at when the tray asks for `asked` pixels: the smallest of `sizes` that is as large, else the
/// largest (the tray scales down).
#[cfg_attr(
    not(windows),
    allow(dead_code, reason = "only Windows asks for a size")
)]
pub fn size_for(asked: u32, sizes: &[u32]) -> u32 {
    sizes
        .iter()
        .copied()
        .find(|&size| size >= asked)
        .or_else(|| sizes.last().copied())
        .unwrap_or(asked)
}

/// RGBA pixels as ARGB32 in network byte order, as StatusNotifierItem takes them.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
pub fn argb(rgba: &[u8]) -> Vec<u8> {
    rgba.as_chunks::<4>()
        .0
        .iter()
        .flat_map(|&[r, g, b, a]| [a, r, g, b])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_state_decodes_at_every_size_of_every_variant() {
        let mut count = 0;
        for state in State::ALL {
            for variant in Variant::ALL {
                for &size in variant.sizes() {
                    let pixels = pixels(state, variant, size).unwrap();
                    assert_eq!(pixels.size, size);
                    assert_eq!(pixels.rgba.len(), (size * size * 4) as usize);
                    assert!(
                        pixels.rgba.as_chunks::<4>().0.iter().any(|p| p[3] > 0),
                        "{:?} {:?} {size} is empty",
                        state,
                        variant
                    );
                    count += 1;
                }
            }
        }
        assert_eq!(count, 65);
        assert_eq!(FILES.len(), 65);
    }

    #[test]
    fn a_size_with_no_drawing_says_so() {
        assert_eq!(
            pixels(State::Idle, Variant::Template, 16).err().as_deref(),
            Some("no icon idle-template-16.png")
        );
    }

    #[test]
    fn the_size_drawn_is_the_smallest_as_large_as_asked() {
        let sizes = Variant::Dark.sizes();
        assert_eq!(size_for(16, sizes), 16);
        assert_eq!(size_for(20, sizes), 20);
        assert_eq!(size_for(18, sizes), 20);
        assert_eq!(size_for(30, sizes), 32);
        assert_eq!(size_for(40, sizes), 48);
        assert_eq!(size_for(64, sizes), 48);
        assert_eq!(size_for(12, sizes), 16);
    }

    #[test]
    fn argb_moves_alpha_first() {
        assert_eq!(argb(&[1, 2, 3, 4, 5, 6, 7, 8]), [4, 1, 2, 3, 8, 5, 6, 7]);
    }
}
