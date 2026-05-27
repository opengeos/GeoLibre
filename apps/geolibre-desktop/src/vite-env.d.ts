/// <reference types="vite/client" />

declare module "*.geojson?url" {
  const url: string;
  export default url;
}
