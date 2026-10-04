import i18next from "i18next";

/**
 * Runs `run` once i18next is initialized, at once if it already is. Startup
 * code that fails before the first render (native launch arguments, shared
 * settings) can then still word its notification in the user's language
 * instead of showing a raw translation key.
 *
 * @param run - The work that needs translations, typically a `notify.*` call.
 */
export function afterI18nInit(run: () => void): void {
  if (i18next.isInitialized) {
    run();
    return;
  }
  const onInitialized = () => {
    i18next.off("initialized", onInitialized);
    run();
  };
  i18next.on("initialized", onInitialized);
}
