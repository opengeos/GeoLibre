/// <reference types="vite/client" />

declare module "*.geojson?url" {
  const url: string;
  export default url;
}

declare module "shpjs" {
  const shp: (input: unknown) => Promise<unknown>;
  export default shp;
}
