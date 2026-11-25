import { configureBuiltInPluginModule } from "@geolibre/plugins/builtin-plugins";
import { appendDiagnostic } from "./diagnostics";

type ModuleId = Parameters<typeof configureBuiltInPluginModule>[0];

/** Keep failed live host setup out of React effects and report it for diagnosis. */
export function configureHostPluginModule<Id extends ModuleId>(
  id: Id,
  initializers: Parameters<typeof configureBuiltInPluginModule<Id>>[1],
): void {
  try {
    configureBuiltInPluginModule(id, initializers);
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    appendDiagnostic({
      category: "runtime",
      level: "error",
      message: `Built-in module "${id}" failed to configure: ${normalized.message}`,
      detail: normalized.stack,
      source: `plugin-module:${id}`,
    });
  }
}
