from dash import Dash, Input, Output, html

from geolibre import DashMap

app = Dash(__name__)

m = DashMap(
    center=(-119.0, 39.8),
    zoom=12,
    basemap="dark",
    height="800px",
)

app.layout = html.Div(
    [
        m,
        html.Pre(id="click-output"),
    ]
)


@app.callback(
    Output("click-output", "children"),
    Input(m, "clickData"),
)
def show_click(click_data):
    return "Click the map" if click_data is None else str(click_data)


if __name__ == "__main__":
    app.run(debug=True)
