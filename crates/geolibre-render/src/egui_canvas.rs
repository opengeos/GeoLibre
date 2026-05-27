use egui::{Color32, Painter, Pos2, Rect, Sense, Shape, Stroke, Ui, Vec2};
use geolibre_core::{Color, Extent, GeoLibreProject, Geometry, Layer, VectorLayer};

use crate::MapCanvas;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MapViewport {
    pub center: [f64; 2],
    pub pixels_per_unit: f64,
}

impl Default for MapViewport {
    fn default() -> Self {
        Self {
            center: [-95.0, 39.0],
            pixels_per_unit: 5.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanvasResponse {
    pub cursor_world: Option<[f64; 2]>,
    pub extent: Extent,
    pub zoom: f64,
    pub placeholder_messages: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct EguiMapCanvas {
    viewport: MapViewport,
}

impl Default for EguiMapCanvas {
    fn default() -> Self {
        Self {
            viewport: MapViewport::default(),
        }
    }
}

impl EguiMapCanvas {
    pub fn show(&mut self, ui: &mut Ui, project: &GeoLibreProject) -> CanvasResponse {
        let available = ui.available_size();
        let size = Vec2::new(available.x.max(200.0), available.y.max(160.0));
        let (response, painter) = ui.allocate_painter(size, Sense::drag());
        let rect = response.rect;

        if response.dragged() {
            let delta = ui.input(|input| input.pointer.delta());
            self.pan_pixels(delta.x, delta.y);
        }

        if response.hovered() {
            let scroll_delta = ui.input(|input| input.smooth_scroll_delta.y);
            if scroll_delta.abs() > f32::EPSILON {
                let factor = if scroll_delta > 0.0 { 1.15 } else { 1.0 / 1.15 };
                if let Some(pos) = response.hover_pos() {
                    let anchor = self.world_at_pos(pos, rect);
                    self.zoom_around(factor, anchor);
                }
            }
        }

        self.draw_background(&painter, rect);
        let placeholder_messages = self.draw_layers(&painter, rect, project);

        let cursor_world = response.hover_pos().map(|pos| self.world_at_pos(pos, rect));
        CanvasResponse {
            cursor_world,
            extent: self.extent([rect.width(), rect.height()]),
            zoom: self.viewport.pixels_per_unit,
            placeholder_messages,
        }
    }

    fn draw_background(&self, painter: &Painter, rect: Rect) {
        painter.rect_filled(rect, 0.0, Color32::from_rgb(244, 247, 250));
        painter.rect_stroke(
            rect,
            0.0,
            Stroke::new(1.0, Color32::from_rgb(195, 204, 215)),
        );

        let grid_color = Color32::from_rgb(220, 226, 232);
        let grid_step = (10.0 * self.viewport.pixels_per_unit as f32).clamp(32.0, 160.0);
        let mut x = rect.left();
        while x <= rect.right() {
            painter.line_segment(
                [Pos2::new(x, rect.top()), Pos2::new(x, rect.bottom())],
                Stroke::new(1.0, grid_color),
            );
            x += grid_step;
        }
        let mut y = rect.top();
        while y <= rect.bottom() {
            painter.line_segment(
                [Pos2::new(rect.left(), y), Pos2::new(rect.right(), y)],
                Stroke::new(1.0, grid_color),
            );
            y += grid_step;
        }
    }

    fn draw_layers(&self, painter: &Painter, rect: Rect, project: &GeoLibreProject) -> Vec<String> {
        let mut placeholders = Vec::new();
        for layer in &project.layers {
            if !layer.visible() {
                continue;
            }

            match layer {
                Layer::Vector(vector_layer) if vector_layer.data.feature_count() > 0 => {
                    self.draw_vector_layer(painter, rect, vector_layer, layer.opacity());
                }
                Layer::Vector(vector_layer) => {
                    placeholders.push(format!(
                        "{}: {}",
                        vector_layer.common.name,
                        layer.source_label()
                    ));
                }
                Layer::Raster(_) | Layer::Tile(_) | Layer::Database(_) => {
                    placeholders.push(format!("{}: {}", layer.name(), layer.source_label()));
                }
            }
        }
        placeholders
    }

    fn draw_vector_layer(
        &self,
        painter: &Painter,
        rect: Rect,
        layer: &VectorLayer,
        layer_opacity: f32,
    ) {
        let stroke = Stroke::new(
            layer.style.stroke_width,
            color_to_egui(layer.style.stroke_color, layer_opacity),
        );
        let fill = color_to_egui(
            Color {
                a: ((layer.style.fill_opacity.clamp(0.0, 1.0) * 255.0) as u8),
                ..layer.style.fill_color
            },
            layer_opacity,
        );

        for feature in &layer.data.features {
            if let Some(geometry) = &feature.geometry {
                self.draw_geometry(painter, rect, geometry, stroke, fill);
            }
        }
    }

    fn draw_geometry(
        &self,
        painter: &Painter,
        rect: Rect,
        geometry: &Geometry,
        stroke: Stroke,
        fill: Color32,
    ) {
        match geometry {
            Geometry::Point(coord) => {
                painter.circle_filled(self.pos_for_coord(*coord, rect), 4.0, stroke.color);
            }
            Geometry::MultiPoint(coords) => {
                for coord in coords {
                    painter.circle_filled(self.pos_for_coord(*coord, rect), 4.0, stroke.color);
                }
            }
            Geometry::LineString(coords) => self.draw_line(painter, rect, coords, stroke),
            Geometry::MultiLineString(lines) => {
                for line in lines {
                    self.draw_line(painter, rect, line, stroke);
                }
            }
            Geometry::Polygon(rings) => self.draw_polygon(painter, rect, rings, stroke, fill),
            Geometry::MultiPolygon(polygons) => {
                for polygon in polygons {
                    self.draw_polygon(painter, rect, polygon, stroke, fill);
                }
            }
            Geometry::GeometryCollection(geometries) => {
                for geometry in geometries {
                    self.draw_geometry(painter, rect, geometry, stroke, fill);
                }
            }
        }
    }

    fn draw_line(&self, painter: &Painter, rect: Rect, coords: &[[f64; 2]], stroke: Stroke) {
        for segment in coords.windows(2) {
            painter.line_segment(
                [
                    self.pos_for_coord(segment[0], rect),
                    self.pos_for_coord(segment[1], rect),
                ],
                stroke,
            );
        }
    }

    fn draw_polygon(
        &self,
        painter: &Painter,
        rect: Rect,
        rings: &[Vec<[f64; 2]>],
        stroke: Stroke,
        fill: Color32,
    ) {
        if let Some(outer) = rings.first() {
            let points: Vec<Pos2> = outer
                .iter()
                .map(|coord| self.pos_for_coord(*coord, rect))
                .collect();
            if points.len() >= 3 {
                painter.add(Shape::convex_polygon(points.clone(), fill, stroke));
            }
            for segment in outer.windows(2) {
                painter.line_segment(
                    [
                        self.pos_for_coord(segment[0], rect),
                        self.pos_for_coord(segment[1], rect),
                    ],
                    stroke,
                );
            }
        }
    }

    fn pos_for_coord(&self, coord: [f64; 2], rect: Rect) -> Pos2 {
        let x = rect.center().x
            + ((coord[0] - self.viewport.center[0]) * self.viewport.pixels_per_unit) as f32;
        let y = rect.center().y
            - ((coord[1] - self.viewport.center[1]) * self.viewport.pixels_per_unit) as f32;
        Pos2::new(x, y)
    }

    fn world_at_pos(&self, pos: Pos2, rect: Rect) -> [f64; 2] {
        self.screen_to_world(
            [pos.x, pos.y],
            [rect.min.x, rect.min.y],
            [rect.width(), rect.height()],
        )
    }
}

impl MapCanvas for EguiMapCanvas {
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

fn color_to_egui(color: Color, layer_opacity: f32) -> Color32 {
    let alpha = (color.a as f32 * layer_opacity.clamp(0.0, 1.0)).round() as u8;
    Color32::from_rgba_unmultiplied(color.r, color.g, color.b, alpha)
}
