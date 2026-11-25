import { useTranslation } from "react-i18next";
import { SectionErrorBoundary } from "../common/error-boundaries";
import { lazy, Suspense, useSyncExternalStore, type ComponentProps } from "react";
import {
  sunPanelStore,
  routeAnimationPanelStore,
  flightSimulatorPanelStore,
} from "../../lib/plugin-panel-stores";

const LoadedSunPanel = lazy(() =>
  import("./SunPanel").then((module) => ({ default: module.SunPanel })),
);
const LoadedRouteAnimationPanel = lazy(() =>
  import("./RouteAnimationPanel").then((module) => ({ default: module.RouteAnimationPanel })),
);
const LoadedFlightSimulatorPanel = lazy(() =>
  import("./FlightSimulatorPanel").then((module) => ({ default: module.FlightSimulatorPanel })),
);

/** Import the simulation UI only after its provider opens the panel. */
export function SunPanel() {
  const visible = useSyncExternalStore(
    sunPanelStore.subscribe,
    sunPanelStore.getSnapshot,
    sunPanelStore.getSnapshot,
  );
  return visible ? (
    <Suspense fallback={null}>
      <LoadedSunPanel />
    </Suspense>
  ) : null;
}

/** Import route controls only after the provider opens its panel. */
export function RouteAnimationPanel(props: ComponentProps<typeof LoadedRouteAnimationPanel>) {
  const visible = useSyncExternalStore(
    routeAnimationPanelStore.subscribe,
    routeAnimationPanelStore.getSnapshot,
    routeAnimationPanelStore.getSnapshot,
  );
  return visible ? (
    <Suspense fallback={null}>
      <LoadedRouteAnimationPanel {...props} />
    </Suspense>
  ) : null;
}

/** Import the flight instruments only when their provider is visible. */
export function FlightSimulatorPanel() {
  const visible = useSyncExternalStore(
    flightSimulatorPanelStore.subscribe,
    flightSimulatorPanelStore.getSnapshot,
    flightSimulatorPanelStore.getSnapshot,
  );
  return visible ? (
    <Suspense fallback={null}>
      <LoadedFlightSimulatorPanel />
    </Suspense>
  ) : null;
}

/** Compose the independent simulation boundaries without loading their hidden interfaces. */
export function DeferredPluginPanels(props: ComponentProps<typeof RouteAnimationPanel>) {
  const { t } = useTranslation();
  return (
    <>
      <SectionErrorBoundary
        label="Sun simulation panel"
        displayName={t("shell.section.sunSimulationPanel")}
      >
        <SunPanel />
      </SectionErrorBoundary>
      <SectionErrorBoundary
        label="Route animation panel"
        displayName={t("shell.section.routeAnimationPanel")}
      >
        <RouteAnimationPanel {...props} />
      </SectionErrorBoundary>
      <SectionErrorBoundary
        label="Flight simulator panel"
        displayName={t("shell.section.flightSimulatorPanel")}
      >
        <FlightSimulatorPanel />
      </SectionErrorBoundary>
    </>
  );
}
