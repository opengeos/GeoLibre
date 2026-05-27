use egui::{Align2, Color32, FontId, Sense, Stroke, Ui, Vec2};
use geolibre_core::{Extent, GeoLibreProject};

use crate::{CanvasResponse, MapCanvas, MapViewport};

pub const MAPLIBRE_RENDERER_ARG: &str = "--geolibre-maplibre-gl-js-renderer";
pub const OPENFREEMAP_LIBERTY_STYLE_URL: &str = "https://tiles.openfreemap.org/styles/liberty";

#[derive(Debug, Clone)]
pub struct MapLibreMapCanvas {
    viewport: MapViewport,
}

impl Default for MapLibreMapCanvas {
    fn default() -> Self {
        Self {
            viewport: MapViewport::default(),
        }
    }
}

impl MapLibreMapCanvas {
    pub fn show(&mut self, ui: &mut Ui, project: &GeoLibreProject) -> CanvasResponse {
        let available = ui.available_size();
        let size = Vec2::new(available.x.max(200.0), available.y.max(160.0));
        let (response, painter) = ui.allocate_painter(size, Sense::hover());
        let rect = response.rect;

        painter.rect_filled(rect, 0.0, Color32::from_rgb(238, 242, 246));
        painter.rect_stroke(
            rect,
            0.0,
            Stroke::new(1.0, Color32::from_rgb(188, 199, 211)),
        );

        let text_origin = rect.min + Vec2::new(18.0, 18.0);
        painter.text(
            text_origin,
            Align2::LEFT_TOP,
            "MapLibre GL JS canvas",
            FontId::proportional(18.0),
            Color32::from_rgb(23, 32, 42),
        );
        painter.text(
            text_origin + Vec2::new(0.0, 32.0),
            Align2::LEFT_TOP,
            "GeoLibre Desktop now launches MapLibre GL JS in a native webview.",
            FontId::proportional(13.0),
            Color32::from_rgb(55, 65, 81),
        );
        painter.text(
            text_origin + Vec2::new(0.0, 54.0),
            Align2::LEFT_TOP,
            "The legacy maplibre-rs backend has been removed.",
            FontId::proportional(13.0),
            Color32::from_rgb(55, 65, 81),
        );
        painter.text(
            text_origin + Vec2::new(0.0, 86.0),
            Align2::LEFT_TOP,
            format!("Project layers: {}", project.layers.len()),
            FontId::proportional(13.0),
            Color32::from_rgb(55, 65, 81),
        );

        CanvasResponse {
            cursor_world: response.hover_pos().map(|pos| {
                self.screen_to_world(
                    [pos.x, pos.y],
                    [rect.min.x, rect.min.y],
                    [rect.width(), rect.height()],
                )
            }),
            extent: self.extent([rect.width(), rect.height()]),
            zoom: self.viewport.pixels_per_unit,
            placeholder_messages: vec![
                "MapLibre GL JS is the desktop renderer; maplibre-rs has been removed.".to_string(),
            ],
        }
    }
}

impl MapCanvas for MapLibreMapCanvas {
    fn viewport(&self) -> MapViewport {
        self.viewport
    }

    fn set_viewport(&mut self, viewport: MapViewport) {
        self.viewport = viewport;
    }

    fn pan_pixels(&mut self, delta_x: f32, delta_y: f32) {
        self.viewport.center[0] -= delta_x as f64 / self.viewport.pixels_per_unit;
        self.viewport.center[1] += delta_y as f64 / self.viewport.pixels_per_unit;
    }

    fn zoom_around(&mut self, factor: f64, anchor_world: [f64; 2]) {
        let old_scale = self.viewport.pixels_per_unit;
        self.viewport.pixels_per_unit =
            (self.viewport.pixels_per_unit * factor).clamp(0.2, 20000.0);
        let scale_ratio = old_scale / self.viewport.pixels_per_unit;
        self.viewport.center[0] =
            anchor_world[0] + (self.viewport.center[0] - anchor_world[0]) * scale_ratio;
        self.viewport.center[1] =
            anchor_world[1] + (self.viewport.center[1] - anchor_world[1]) * scale_ratio;
    }

    fn screen_to_world(
        &self,
        screen: [f32; 2],
        rect_min: [f32; 2],
        rect_size: [f32; 2],
    ) -> [f64; 2] {
        let rect_center = [
            rect_min[0] + rect_size[0] / 2.0,
            rect_min[1] + rect_size[1] / 2.0,
        ];
        [
            self.viewport.center[0]
                + (screen[0] - rect_center[0]) as f64 / self.viewport.pixels_per_unit,
            self.viewport.center[1]
                - (screen[1] - rect_center[1]) as f64 / self.viewport.pixels_per_unit,
        ]
    }

    fn extent(&self, size: [f32; 2]) -> Extent {
        let half_width = size[0] as f64 / self.viewport.pixels_per_unit / 2.0;
        let half_height = size[1] as f64 / self.viewport.pixels_per_unit / 2.0;
        Extent::new(
            self.viewport.center[0] - half_width,
            self.viewport.center[1] - half_height,
            self.viewport.center[0] + half_width,
            self.viewport.center[1] + half_height,
        )
    }
}

pub fn run_standalone_maplibre_canvas() {
    eprintln!("The standalone maplibre-rs canvas was removed. Run geolibre-desktop instead.");
}
