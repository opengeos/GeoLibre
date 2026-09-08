// Vite asset-URL imports for the wasm binaries the globe's decoders load
// (`import x from "pkg/file.wasm?url"` resolves to the served asset). The app
// gets these from `vite/client`; this package is compiled on its own too, so
// the shape is declared here.
declare module "*.wasm?url" {
  const url: string;
  export default url;
}
