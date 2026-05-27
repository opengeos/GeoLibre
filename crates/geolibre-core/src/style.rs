use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Color {
    pub const fn rgb(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b, a: 255 }
    }

    pub const fn rgba(r: u8, g: u8, b: u8, a: u8) -> Self {
        Self { r, g, b, a }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorStyle {
    pub stroke_color: Color,
    pub fill_color: Color,
    pub stroke_width: f32,
    pub fill_opacity: f32,
}

impl Default for VectorStyle {
    fn default() -> Self {
        Self {
            stroke_color: Color::rgb(42, 104, 186),
            fill_color: Color::rgba(80, 160, 220, 96),
            stroke_width: 1.5,
            fill_opacity: 0.35,
        }
    }
}
