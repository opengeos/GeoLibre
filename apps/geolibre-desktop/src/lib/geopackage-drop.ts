/** Import each GeoPackage independently, preserving native paths for project reloads. */
export async function importGeoPackageDrops<T extends File | string>(
  inputs: T[],
  options: {
    readPath: (path: string) => Promise<Uint8Array<ArrayBuffer>>;
    addFile: (file: File, sourcePath?: string) => Promise<number>;
    onError: (name: string, error: unknown) => void;
  },
): Promise<{ remaining: T[]; count: number; layerCount: number }> {
  const remaining: T[] = [];
  let count = 0;
  let layerCount = 0;
  for (const input of inputs) {
    const name = typeof input === "string" ? (input.split(/[\\/]/).pop() ?? input) : input.name;
    if (!/\.gpkg$/i.test(name)) {
      remaining.push(input);
      continue;
    }
    count += 1;
    try {
      const sourcePath = typeof input === "string" ? input : undefined;
      const value: File | string = input;
      const file =
        typeof value === "string" ? new File([await options.readPath(value)], name) : value;
      layerCount += await options.addFile(file, sourcePath);
    } catch (error) {
      options.onError(name, error);
    }
  }
  return { remaining, count, layerCount };
}
