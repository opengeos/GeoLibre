/**
 * Whether the Time Slider dock is open *because* a layer was bound to it, as
 * opposed to the user opening it from the Plugins menu.
 *
 * The distinction is the whole policy behind {@link shouldCloseTimeSliderDock}:
 * a dock that a binding opened is closed again when the last binding goes away,
 * while a dock the user opened stays put even with an empty timeline — they may
 * be about to add a raster time series through its own "Add data" form.
 */
let openedByBinding = false;

/**
 * Record how the dock came to be open. Set true right after a binding activates
 * it, and false whenever the plugin goes inactive by any route so a later manual
 * activation starts from a clean slate.
 *
 * @param opened - True when a binding is what opened the dock.
 */
export function setTimeSliderOpenedByBinding(opened: boolean): void {
  openedByBinding = opened;
}

/** Whether a binding, rather than the user, opened the dock. */
export function isTimeSliderOpenedByBinding(): boolean {
  return openedByBinding;
}

/**
 * Whether a binding-opened Time Slider dock now has nothing left to drive and
 * should close itself (#1512).
 *
 * `isIdle` is what keeps this honest about the dock's other duties: the dock
 * stays open while any binding, dock raster source, or KML `<TimeSpan>` overlay
 * remains, because it is the only way to reach the last two. It is taken as a
 * thunk so the layer scan is skipped on the overwhelmingly common path (a dock
 * the user opened, or none at all), and so this module stays free of the plugins
 * barrel.
 *
 * @param active - Whether the Time Slider plugin is currently active.
 * @param isIdle - Reads whether the slider has anything left to drive, normally
 *   `isTimeSliderIdle` from `@geolibre/plugins`.
 * @returns True when the dock should be deactivated.
 */
export function shouldCloseTimeSliderDock(active: boolean, isIdle: () => boolean): boolean {
  return openedByBinding && active && isIdle();
}

/** Reset the module state between tests. */
export function __resetTimeSliderDockForTests(): void {
  openedByBinding = false;
}
