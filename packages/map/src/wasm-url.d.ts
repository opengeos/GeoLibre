/** Bundlers expose explicitly imported WASM assets as served URLs. */
declare module "*.wasm?url" {
  const url: string;
  export default url;
}
