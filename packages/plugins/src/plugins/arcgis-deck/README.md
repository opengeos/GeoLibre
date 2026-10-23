# ArcGIS deck.gl bridge

`commons.js`, `deck-renderer.js` and their declarations adapt the MIT-licensed framebuffer compositor
from `@deck.gl/arcgis` 9.4.0 (git 5eded84b438eef83387dc6579c51670389053602).
See the adjacent LICENSE and https://github.com/visgl/deck.gl/tree/v9.4.0/modules/arcgis.

The package entry imports `@arcgis/core` directly and its props Accessor uses
the removed `watch` method. GeoLibre instead imports the SDK classes from its
pinned CDN and supplies props through the shared overlay's `setProps` contract.
This keeps the SDK out of the build and supports SDK 5.1. The compositor remains
shared with the upstream implementation; re-verify it on deck/luma upgrades.

Local SceneView rendering uses the experimental upstream camera approximation.
The scene adapter imports MapView from the public deck entry, destroys its
RenderNode on disposal, clears prop listeners, and forwards device readiness.
Global scenes and secondary panes do not host this shared overlay.
