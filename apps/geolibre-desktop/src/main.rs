use geolibre_core::{GeoLibreProject, Layer};
use geolibre_io::load_geojson_layer;
use winit::{
    application::ApplicationHandler,
    dpi::{LogicalPosition, LogicalSize},
    event::WindowEvent,
    event_loop::{ActiveEventLoop, EventLoop},
    window::{Window, WindowId},
};
use wry::{Rect, WebViewBuilder};

const MAPLIBRE_GL_JS_VERSION: &str = "5.24.0";
const OPENFREEMAP_LIBERTY_STYLE_URL: &str = "https://tiles.openfreemap.org/styles/liberty";

fn main() {
    run_maplibre_gl_js_desktop();
}

fn run_maplibre_gl_js_desktop() {
    initialize_webview_platform();

    let event_loop = EventLoop::new().expect("failed to create event loop");
    let mut app = GeoLibreWebViewApp::new();
    event_loop.run_app(&mut app).expect("event loop failed");
}

struct GeoLibreWebViewApp {
    window: Option<Window>,
    webview: Option<wry::WebView>,
    initial_html: String,
}

impl GeoLibreWebViewApp {
    fn new() -> Self {
        Self {
            window: None,
            webview: None,
            initial_html: build_initial_html(),
        }
    }
}

impl ApplicationHandler for GeoLibreWebViewApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }

        let window = event_loop
            .create_window(
                Window::default_attributes()
                    .with_title("GeoLibre Desktop")
                    .with_inner_size(LogicalSize::new(1320.0, 860.0)),
            )
            .expect("failed to create window");

        let webview = WebViewBuilder::new()
            .with_html(self.initial_html.clone())
            .build_as_child(&window)
            .expect("failed to create MapLibre GL JS webview");
        resize_webview_to_window(&webview, &window);

        self.webview = Some(webview);
        self.window = Some(window);
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        event: WindowEvent,
    ) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => {
                let Some(window) = self.window.as_ref() else {
                    return;
                };
                let Some(webview) = self.webview.as_ref() else {
                    return;
                };
                resize_webview(webview, size.to_logical::<u32>(window.scale_factor()));
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
        #[cfg(any(
            target_os = "linux",
            target_os = "dragonfly",
            target_os = "freebsd",
            target_os = "netbsd",
            target_os = "openbsd",
        ))]
        {
            while gtk::events_pending() {
                gtk::main_iteration_do(false);
            }
        }
    }
}

fn resize_webview_to_window(webview: &wry::WebView, window: &Window) {
    resize_webview(
        webview,
        window.inner_size().to_logical::<u32>(window.scale_factor()),
    );
}

fn resize_webview(webview: &wry::WebView, size: LogicalSize<u32>) {
    webview
        .set_bounds(Rect {
            position: LogicalPosition::new(0, 0).into(),
            size: LogicalSize::new(size.width, size.height).into(),
        })
        .expect("failed to resize MapLibre GL JS webview");
}

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd",
))]
fn initialize_webview_platform() {
    use gtk::prelude::DisplayExtManual;

    gtk::init().expect("failed to initialize GTK for WebKitGTK");
    if gtk::gdk::Display::default().is_some_and(|display| display.backend().is_wayland()) {
        eprintln!("GeoLibre Desktop webview currently uses WRY's X11 child-window path.");
    }

    winit::platform::x11::register_xlib_error_hook(Box::new(|_display, error| {
        let error = error as *mut x11_dl::xlib::XErrorEvent;
        (unsafe { (*error).error_code }) == 170
    }));
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd",
)))]
fn initialize_webview_platform() {}

fn build_initial_html() -> String {
    let mut project = GeoLibreProject::new("Untitled GeoLibre Project");
    if let Ok(layer) = load_geojson_layer(
        "examples/data/sample.geojson",
        "sample-geojson",
        "Sample GeoJSON",
    ) {
        project.add_layer(Layer::Vector(layer));
    }

    let project_json =
        serde_json::to_string(&project).expect("failed to serialize initial GeoLibre project");
    let sample_geojson = std::fs::read_to_string("examples/data/sample.geojson")
        .unwrap_or_else(|_| "{\"type\":\"FeatureCollection\",\"features\":[]}".to_string());

    include_str!("../assets/maplibre_gl_app.html")
        .replace("__MAPLIBRE_GL_JS_VERSION__", MAPLIBRE_GL_JS_VERSION)
        .replace(
            "__OPENFREEMAP_LIBERTY_STYLE_URL__",
            OPENFREEMAP_LIBERTY_STYLE_URL,
        )
        .replace("__PROJECT_JSON__", &project_json)
        .replace("__SAMPLE_GEOJSON__", &sample_geojson)
}
