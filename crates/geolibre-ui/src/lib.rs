use egui::{CentralPanel, Color32, Frame, Rect, SidePanel, Slider, TopBottomPanel, Vec2};
use geolibre_core::{GeoLibreProject, Layer, TileType};
use geolibre_io::{
    cog_placeholder_layer, duckdb_placeholder_layer, flatgeobuf_placeholder_layer,
    geoduckdb_vector_placeholder_layer, load_geojson_layer, pmtiles_placeholder_layer,
    xyz_tile_layer,
};
use geolibre_plugins::{AddOpenStreetMapBasemapPlugin, GeoLibrePlugin};
use geolibre_processing::{
    BoundingBoxAlgorithm, BufferPlaceholderAlgorithm, ProcessingAlgorithm, ProcessingOutput,
    ReprojectPlaceholderAlgorithm,
};
use geolibre_render::{CanvasResponse, EguiMapCanvas, MapCanvas, MapLibreMapCanvas};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanvasBackend {
    MapLibre,
    EguiFallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MapLibreUiMode {
    Embedded,
    Launcher,
}

pub struct GeoLibreDesktopApp {
    project: GeoLibreProject,
    maplibre_canvas: MapLibreMapCanvas,
    egui_canvas: EguiMapCanvas,
    canvas_backend: CanvasBackend,
    selected_layer_id: Option<String>,
    next_layer_number: usize,
    map_rect: Option<Rect>,
    last_canvas_response: Option<CanvasResponse>,
    last_message: String,
}

impl Default for GeoLibreDesktopApp {
    fn default() -> Self {
        let mut app = Self {
            project: GeoLibreProject::new("Untitled GeoLibre Project"),
            maplibre_canvas: MapLibreMapCanvas::default(),
            egui_canvas: EguiMapCanvas::default(),
            canvas_backend: CanvasBackend::MapLibre,
            selected_layer_id: None,
            next_layer_number: 1,
            map_rect: None,
            last_canvas_response: None,
            last_message: "Ready".to_string(),
        };
        app.add_sample_geojson();
        app
    }
}

impl GeoLibreDesktopApp {
    pub fn map_rect(&self) -> Option<Rect> {
        self.map_rect
    }

    pub fn show(&mut self, ctx: &egui::Context, maplibre_mode: MapLibreUiMode) {
        self.top_toolbar(ctx);
        self.left_layer_panel(ctx);
        self.right_properties_panel(ctx);
        self.bottom_status_bar(ctx);

        CentralPanel::default()
            .frame(Frame::none().fill(Color32::TRANSPARENT))
            .show(ctx, |ui| {
                self.last_canvas_response = Some(match self.canvas_backend {
                    CanvasBackend::MapLibre => match maplibre_mode {
                        MapLibreUiMode::Embedded => self.embedded_maplibre_canvas(ui),
                        MapLibreUiMode::Launcher => self.maplibre_canvas.show(ui, &self.project),
                    },
                    CanvasBackend::EguiFallback => self.egui_canvas.show(ui, &self.project),
                });
            });
    }

    fn top_toolbar(&mut self, ctx: &egui::Context) {
        TopBottomPanel::top("top_toolbar").show(ctx, |ui| {
            ui.horizontal_wrapped(|ui| {
                ui.heading("GeoLibre Desktop");
                ui.separator();
                let _ = ui.selectable_label(true, "Pan");
                ui.label("Zoom: mouse wheel");
                ui.label("Identify: placeholder");
                ui.separator();
                ui.selectable_value(
                    &mut self.canvas_backend,
                    CanvasBackend::MapLibre,
                    "MapLibre canvas",
                );
                ui.selectable_value(
                    &mut self.canvas_backend,
                    CanvasBackend::EguiFallback,
                    "egui fallback",
                );
                ui.separator();

                if ui.button("Add sample GeoJSON").clicked() {
                    self.add_sample_geojson();
                }
                if ui.button("Add OSM basemap").clicked() {
                    let plugin = AddOpenStreetMapBasemapPlugin;
                    match plugin.activate(&mut self.project) {
                        Ok(()) => {
                            self.selected_layer_id = self.project.active_layer_id.clone();
                            self.last_message =
                                "Added OpenStreetMap basemap placeholder".to_string();
                        }
                        Err(error) => self.last_message = error.to_string(),
                    }
                }
                if ui.button("Add XYZ vector URL").clicked() {
                    let id = self.next_layer_id("xyz-vector");
                    self.project.add_layer(xyz_tile_layer(
                        id,
                        "XYZ vector tiles",
                        "https://example.com/tiles/{z}/{x}/{y}.pbf",
                        TileType::Vector,
                    ));
                    self.selected_layer_id = self.project.active_layer_id.clone();
                }
                if ui.button("Add placeholders").clicked() {
                    self.add_placeholder_layers();
                }
            });
        });
    }

    fn left_layer_panel(&mut self, ctx: &egui::Context) {
        SidePanel::left("layer_panel")
            .default_width(260.0)
            .show(ctx, |ui| {
                ui.heading("Layers");
                ui.separator();

                let mut remove_id = None;
                for layer in &mut self.project.layers {
                    ui.group(|ui| {
                        ui.horizontal(|ui| {
                            let mut visible = layer.visible();
                            if ui.checkbox(&mut visible, "").changed() {
                                layer.set_visible(visible);
                            }

                            let selected = self.selected_layer_id.as_deref() == Some(layer.id());
                            if ui.selectable_label(selected, layer.name()).clicked() {
                                self.selected_layer_id = Some(layer.id().to_string());
                                self.project.active_layer_id = self.selected_layer_id.clone();
                            }

                            if ui.small_button("x").clicked() {
                                remove_id = Some(layer.id().to_string());
                            }
                        });
                        let mut opacity = layer.opacity();
                        if ui
                            .add(Slider::new(&mut opacity, 0.0..=1.0).text("opacity"))
                            .changed()
                        {
                            layer.set_opacity(opacity);
                        }
                        ui.horizontal(|ui| {
                            ui.label(layer.source_label());
                            ui.add_enabled(false, egui::Button::new("reorder"));
                        });
                    });
                }

                if let Some(id) = remove_id {
                    self.project.remove_layer(&id);
                    if self.selected_layer_id.as_deref() == Some(&id) {
                        self.selected_layer_id = self.project.active_layer_id.clone();
                    }
                    self.last_message = format!("Removed layer {id}");
                }
            });
    }

    fn right_properties_panel(&mut self, ctx: &egui::Context) {
        SidePanel::right("properties_panel")
            .default_width(300.0)
            .show(ctx, |ui| {
                ui.heading("Properties");
                ui.separator();

                ui.label(format!("Project: {}", self.project.name));
                ui.label(format!("Layers: {}", self.project.layers.len()));
                ui.separator();

                if let Some(id) = self.selected_layer_id.as_deref() {
                    if let Some(layer) = self.project.layer_mut(id) {
                        ui.heading(layer.name());
                        ui.label(layer.source_label());
                        ui.label(format!("ID: {}", layer.id()));

                        if let Layer::Vector(vector_layer) = layer {
                            ui.separator();
                            ui.label(format!("Features: {}", vector_layer.data.feature_count()));
                            ui.add(
                                Slider::new(&mut vector_layer.style.stroke_width, 0.25..=8.0)
                                    .text("stroke width"),
                            );
                            ui.add(
                                Slider::new(&mut vector_layer.style.fill_opacity, 0.0..=1.0)
                                    .text("fill opacity"),
                            );
                        }
                    }
                } else {
                    ui.label("No layer selected");
                }

                ui.separator();
                ui.heading("Processing");
                self.processing_toolbox(ui);

                ui.separator();
                if let Some(response) = &self.last_canvas_response {
                    for message in &response.placeholder_messages {
                        ui.label(message);
                    }
                }
            });
    }

    fn bottom_status_bar(&mut self, ctx: &egui::Context) {
        TopBottomPanel::bottom("status_bar").show(ctx, |ui| {
            ui.horizontal_wrapped(|ui| {
                ui.label(&self.last_message);
                if let Some(response) = &self.last_canvas_response {
                    ui.separator();
                    if let Some(coord) = response.cursor_world {
                        ui.label(format!("x: {:.5}, y: {:.5}", coord[0], coord[1]));
                    } else {
                        ui.label("x: -, y: -");
                    }
                    ui.separator();
                    ui.label(format!("zoom: {:.2}", response.zoom));
                    ui.separator();
                    ui.label(format!(
                        "extent: {:.3}, {:.3}, {:.3}, {:.3}",
                        response.extent.min_x,
                        response.extent.min_y,
                        response.extent.max_x,
                        response.extent.max_y
                    ));
                }
            });
        });
    }

    fn embedded_maplibre_canvas(&mut self, ui: &mut egui::Ui) -> CanvasResponse {
        let available = ui.available_size();
        let size = Vec2::new(available.x.max(200.0), available.y.max(160.0));
        let (_id, rect) = ui.allocate_space(size);
        self.map_rect = Some(rect);
        let extent = self.maplibre_canvas.extent([rect.width(), rect.height()]);

        CanvasResponse {
            cursor_world: None,
            extent,
            zoom: self.maplibre_canvas.viewport().pixels_per_unit,
            placeholder_messages: vec![
                "MapLibre GL JS webview is the primary desktop renderer".to_string()
            ],
        }
    }

    fn processing_toolbox(&mut self, ui: &mut egui::Ui) {
        let algorithms: Vec<Box<dyn ProcessingAlgorithm>> = vec![
            Box::new(BoundingBoxAlgorithm),
            Box::new(BufferPlaceholderAlgorithm),
            Box::new(ReprojectPlaceholderAlgorithm),
        ];

        let Some(layer_id) = self.selected_layer_id.clone() else {
            ui.label("Select a layer to run algorithms");
            return;
        };

        for algorithm in algorithms {
            if ui.button(algorithm.name()).clicked() {
                match algorithm.run(&self.project, &layer_id) {
                    Ok(ProcessingOutput::Message(message)) => self.last_message = message,
                    Ok(ProcessingOutput::Layer(layer)) => {
                        self.project.add_layer(layer);
                        self.selected_layer_id = self.project.active_layer_id.clone();
                    }
                    Err(error) => self.last_message = error.to_string(),
                }
            }
        }
    }

    fn add_sample_geojson(&mut self) {
        let id = self.next_layer_id("sample-geojson");
        match load_geojson_layer("examples/data/sample.geojson", &id, "Sample GeoJSON") {
            Ok(layer) => {
                self.project.add_layer(Layer::Vector(layer));
                self.selected_layer_id = self.project.active_layer_id.clone();
                self.last_message = "Loaded sample GeoJSON".to_string();
            }
            Err(error) => {
                self.project
                    .add_layer(Layer::Vector(geolibre_core::VectorLayer::new(
                        &id,
                        "Sample GeoJSON placeholder",
                        geolibre_core::VectorSource::GeoJson {
                            path: "examples/data/sample.geojson".to_string(),
                        },
                    )));
                self.selected_layer_id = self.project.active_layer_id.clone();
                self.last_message = format!("Sample GeoJSON placeholder: {error}");
            }
        }
    }

    fn add_placeholder_layers(&mut self) {
        let fgb_id = self.next_layer_id("flatgeobuf");
        let pmtiles_id = self.next_layer_id("pmtiles");
        let cog_id = self.next_layer_id("cog");
        let duckdb_id = self.next_layer_id("duckdb");
        let geoparquet_id = self.next_layer_id("geoparquet");

        self.project.add_layer(flatgeobuf_placeholder_layer(
            fgb_id,
            "FlatGeobuf placeholder",
            "data/example.fgb",
        ));
        self.project.add_layer(pmtiles_placeholder_layer(
            pmtiles_id,
            "PMTiles placeholder",
            "data/example.pmtiles",
        ));
        self.project.add_layer(cog_placeholder_layer(
            cog_id,
            "COG placeholder",
            "data/example.tif",
        ));
        self.project.add_layer(duckdb_placeholder_layer(
            duckdb_id,
            "DuckDB placeholder",
            "data/example.duckdb",
            Some("features".to_string()),
        ));
        self.project.add_layer(geoduckdb_vector_placeholder_layer(
            geoparquet_id,
            "GeoParquet placeholder",
            "data/example.parquet",
            None,
        ));
        self.selected_layer_id = self.project.active_layer_id.clone();
        self.last_message = "Added placeholder layers".to_string();
    }

    fn next_layer_id(&mut self, prefix: &str) -> String {
        let id = format!("{prefix}-{}", self.next_layer_number);
        self.next_layer_number += 1;
        id
    }
}
