/**
 * Whether a plugin-supplied icon string is a fetchable image source (an http(s)
 * URL, a `data:`/`blob:` URI, or an absolute path) that should be rendered as
 * an `<img>`. Any other value falls back to a default glyph. Shared by the
 * plugin UI surfaces (right panel, toolbar menus, floating panels).
 *
 * @param icon - The icon string from a plugin registration.
 * @returns True when `icon` should be rendered as an image source.
 */
export function isImageSource(icon: string): boolean {
  // Accept absolute http(s) URLs, image data URIs (not data:text/html etc.),
  // and object URLs. Bare root-relative ("/...") paths are intentionally not
  // accepted: a plugin references its bundled assets via an absolute URL from
  // resolvePluginAssetUrl, and this avoids treating an arbitrary same-origin or
  // Tauri-asset path as an icon source.
  return /^(https?:|data:image\/|blob:)/.test(icon);
}
