pub mod egui_canvas;
pub mod maplibre_canvas;

pub use egui_canvas::{CanvasResponse, EguiMapCanvas, MapViewport};
pub use maplibre_canvas::{
    run_standalone_maplibre_canvas, MapLibreMapCanvas, MAPLIBRE_RENDERER_ARG,
    OPENFREEMAP_LIBERTY_STYLE_URL,
};

use geolibre_core::Extent;

pub trait MapCanvas {
    fn viewport(&self) -> MapViewport;
    fn set_viewport(&mut self, viewport: MapViewport);
    fn pan_pixels(&mut self, delta_x: f32, delta_y: f32);
    fn zoom_around(&mut self, factor: f64, anchor_world: [f64; 2]);
    fn screen_to_world(
        &self,
        screen: [f32; 2],
        rect_min: [f32; 2],
        rect_size: [f32; 2],
    ) -> [f64; 2];
    fn extent(&self, size: [f32; 2]) -> Extent;
}
