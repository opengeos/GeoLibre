// Vite resolves `?url` imports to the served/hashed asset URL. Declared here
// because @geolibre/plugins does not pull in vite/client's ambient module
// types; only this one asset is imported that way.
declare module "lerc/lerc-wasm.wasm?url" {
  const url: string;
  export default url;
}
