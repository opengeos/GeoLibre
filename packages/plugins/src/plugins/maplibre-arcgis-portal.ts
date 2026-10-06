// ArcGIS Portal: browse a signed-in user's ArcGIS Online organization or
// ArcGIS Enterprise portal (my content, favorites, groups, the organization,
// or the whole portal) and add its items to the map. Sign-in itself belongs to
// the app (the OAuth flow and token sessions in apps/geolibre-desktop), which
// hands it in through setArcGisPortalAuth, so a session started here is the
// same one Add Data → ArcGIS uses, and the other way round.

import { useAppStore } from "@geolibre/core";
import { createPluginTranslator, pluginDisplayTitle } from "../plugin-i18n";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { addArcGISLayer } from "./arcgis-layer";
import {
  ARCGIS_PORTAL_VIEWS,
  PORTAL_ITEM_TYPES,
  arcgisPortalItemPageUrl,
  arcgisPortalSharingUrl,
  arcgisPortalThumbnailUrl,
  isTrustedPortalServiceUrl,
  buildPortalSearchQuery,
  fetchPortalUser,
  fetchPortalWebMapLayers,
  portalItemBounds,
  portalItemLayerType,
  searchPortal,
  type ArcGisPortalItem,
  type ArcGisPortalUser,
  type ArcGisPortalView,
} from "./arcgis-portal-api";

export const ARCGIS_PORTAL_PLUGIN_ID = "geolibre-arcgis-portal";
const PAGE_SIZE = 20;

/** A signed-in portal: its normalized base URL and the user. */
export interface ArcGisPortalConnection {
  portal: string;
  username: string;
}

/** The app's ArcGIS sign-in, as this plugin uses it. */
export interface ArcGisPortalAuth {
  /** The signed-in portals. */
  connections: () => ArcGisPortalConnection[];
  /** Call `listener` when a portal is signed into or out of. Returns an unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** A normalized portal base, or null for an unusable URL (blank is ArcGIS Online). */
  normalizePortalUrl: (input: string) => string | null;
  /** The client ID remembered for, or configured as the default of, a portal. */
  clientId: (portal: string) => string;
  /** Start the portal's sign-in page. Call it straight from a click (web opens a popup). */
  signIn: (portalUrl: string, clientId: string) => Promise<ArcGisPortalConnection>;
  signOut: (portal: string) => Promise<void>;
  /** A current access token for a signed-in portal. */
  getToken: (portal: string) => Promise<string>;
  /** A layer's token provider, renewing the token for later requests. */
  tokenProvider: (portal: string) => () => Promise<string | undefined>;
  /** A user-facing message for a sign-in failure. */
  errorMessage: (error: unknown) => string;
}

let auth: ArcGisPortalAuth | null = null;

/** Hand the app's ArcGIS sign-in to the plugin. Called once by the host at startup. */
export function setArcGisPortalAuth(next: ArcGisPortalAuth | null): void {
  auth = next;
}

let appRef: GeoLibreAppAPI | null = null;
const tr = createPluginTranslator(() => appRef, ARCGIS_PORTAL_PLUGIN_ID);

const VIEW_LABELS: Record<ArcGisPortalView, string> = {
  content: "My content",
  favorites: "My favorites",
  groups: "My groups",
  organization: "My organization",
  portal: "All of the portal",
};

const styles = {
  panel:
    "display:flex;flex-direction:column;gap:8px;padding:8px;height:100%;box-sizing:border-box;" +
    "font-size:12px;color:hsl(var(--foreground));",
  row: "display:flex;gap:6px;align-items:center;flex-wrap:wrap;",
  input:
    "min-width:0;flex:1 1 140px;padding:6px 8px;border:1px solid hsl(var(--border));" +
    "border-radius:6px;background:hsl(var(--background));color:hsl(var(--foreground));",
  field:
    "box-sizing:border-box;width:100%;padding:6px 8px;border:1px solid hsl(var(--border));" +
    "border-radius:6px;background:hsl(var(--background));color:hsl(var(--foreground));",
  button:
    "padding:5px 9px;border:1px solid hsl(var(--border));border-radius:5px;cursor:pointer;" +
    "background:hsl(var(--background));color:hsl(var(--foreground));",
  primary:
    "padding:6px 10px;border:1px solid hsl(var(--primary));border-radius:6px;cursor:pointer;" +
    "background:hsl(var(--primary));color:hsl(var(--primary-foreground));",
  status: "font-size:11px;color:hsl(var(--muted-foreground));line-height:1.4;",
  results: "display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0;flex:1;",
  card:
    "display:flex;gap:8px;padding:8px;border:1px solid hsl(var(--border));" +
    "border-radius:6px;background:hsl(var(--muted));",
  thumbnail:
    "width:88px;height:58px;flex:0 0 88px;object-fit:cover;border-radius:4px;" +
    "background:hsl(var(--accent));",
  cardBody: "display:flex;flex:1;min-width:0;flex-direction:column;gap:5px;",
  title: "font-weight:600;line-height:1.3;overflow-wrap:anywhere;",
} as const;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  style?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (style) node.style.cssText = style;
  return node;
}

function button(text: string, style: string = styles.button): HTMLButtonElement {
  const node = element("button", text, style);
  node.type = "button";
  return node;
}

// The panel's choices outlive a rebuild (a language change, a sign-in) and a reopen.
let selectedPortal: string | null = null;
let selectedView: ArcGisPortalView = "content";
let selectedGroupId = "";
let selectedType = "";
// One lookup per portal, shared by every rebuild (a sign-in rebuilds the panel
// both from the auth subscription and from the form).
const users = new Map<string, Promise<ArcGisPortalUser>>();

/** Store layer ids added per portal item, so its card can offer to remove them. */
const addedLayers = new Map<string, string[]>();

function itemKey(portal: string, item: ArcGisPortalItem): string {
  return `${portal}\n${item.id}`;
}

/** The item's layers still in the project; the user may have removed some. */
function liveLayers(key: string): string[] {
  const ids = addedLayers.get(key);
  if (!ids?.length) return [];
  const present = new Set(useAppStore.getState().layers.map((layer) => layer.id));
  const live = ids.filter((id) => present.has(id));
  if (live.length) addedLayers.set(key, live);
  else addedLayers.delete(key);
  return live;
}

/** Add one portal item to the map; resolves to the store ids of the layers added. */
async function addItem(
  app: GeoLibreAppAPI,
  portal: string,
  item: ArcGisPortalItem,
): Promise<string[]> {
  if (!auth) throw new Error("ArcGIS sign-in is not available.");
  const layerType = portalItemLayerType(item.type);
  const portalUrl = arcgisPortalSharingUrl(portal);
  const token = await auth.getToken(portal);
  const tokenProvider = auth.tokenProvider(portal);
  if (layerType === "web-map") {
    const layers = await fetchPortalWebMapLayers(portal, item.id, token);
    const ids: string[] = [];
    for (const layer of layers) {
      // The map's author picks these URLs: credentials go only to trusted hosts.
      const trusted = isTrustedPortalServiceUrl(portal, layer.url);
      const id = await addArcGISLayer(app, {
        layerType: layer.layerType,
        sourceType: "url",
        url: layer.url,
        name: layer.title,
        portalUrl,
        ...(trusted ? { token, tokenProvider } : {}),
      });
      if (id) ids.push(id);
    }
    return ids;
  }
  if (!layerType) throw new Error(`${item.type} items cannot be added.`);
  // An item registers its own service URL; one on an untrusted host is loaded
  // without credentials (a public item and service still work).
  const trusted = !item.url || isTrustedPortalServiceUrl(portal, item.url);
  const id = await addArcGISLayer(app, {
    layerType,
    sourceType: "portal-item",
    itemId: item.id,
    name: item.title,
    portalUrl,
    ...(trusted ? { token, tokenProvider } : {}),
  });
  return id ? [id] : [];
}

// The portal last signed in to, so the form starts with it (and its client ID).
const LAST_PORTAL_KEY = "geolibre:arcgis-portal:last-portal";

function loadLastPortal(): string {
  try {
    return globalThis.localStorage?.getItem(LAST_PORTAL_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastPortal(portal: string): void {
  try {
    globalThis.localStorage?.setItem(LAST_PORTAL_KEY, portal);
  } catch {
    // Storage blocked or full; the form just starts blank next time.
  }
}

/** The sign-in form, for the first portal or another one. */
function buildSignIn(
  onSignedIn: (portal: string) => void,
  initialPortal = loadLastPortal(),
): HTMLElement {
  const form = element("form", undefined, "display:flex;flex-direction:column;gap:6px;");
  const portalInput = element("input", undefined, styles.field);
  portalInput.value = initialPortal;
  portalInput.placeholder = tr("portalPlaceholder", "Portal URL (blank for ArcGIS Online)");
  portalInput.ariaLabel = portalInput.placeholder;
  const clientInput = element("input", undefined, styles.field);
  clientInput.placeholder = tr("clientIdPlaceholder", "OAuth client ID");
  clientInput.ariaLabel = clientInput.placeholder;
  const fillClientId = () => {
    const portal = auth?.normalizePortalUrl(portalInput.value);
    clientInput.value = portal && auth ? auth.clientId(portal) : "";
  };
  fillClientId();
  portalInput.addEventListener("input", fillClientId);
  const submit = element("button", tr("signIn", "Sign in"), styles.primary);
  submit.type = "submit";
  const hint = element(
    "div",
    tr(
      "signInHint",
      "Sign in to browse the content you can access. Enter your organization URL (https://yourorg.maps.arcgis.com) for its sign-in page, or your ArcGIS Enterprise portal.",
    ),
    styles.status,
  );
  const error = element("div", undefined, styles.status);
  form.append(hint, portalInput, clientInput, submit, error);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!auth) return;
    error.textContent = "";
    submit.disabled = true;
    // No await before signIn: the web popup must open inside the click.
    auth
      .signIn(portalInput.value, clientInput.value)
      .then((connection) => {
        saveLastPortal(portalInput.value.trim());
        onSignedIn(connection.portal);
      })
      .catch((caught: unknown) => {
        error.textContent = auth?.errorMessage(caught) ?? String(caught);
      })
      .finally(() => {
        submit.disabled = false;
      });
  });
  return form;
}

function buildPanel(container: HTMLElement): () => void {
  container.replaceChildren();
  const panel = element("div", undefined, styles.panel);
  container.append(panel);
  let controller: AbortController | null = null;
  let generation = 0;

  if (!auth) {
    panel.append(
      element(
        "div",
        tr("unavailable", "ArcGIS sign-in is not available in this build."),
        styles.status,
      ),
    );
    return () => container.replaceChildren();
  }
  const connections = auth.connections();
  if (!connections.some((connection) => connection.portal === selectedPortal)) {
    selectedPortal = connections[0]?.portal ?? null;
  }
  const rebuild = () => queueMicrotask(rebuildPanel);
  if (!selectedPortal) {
    panel.append(
      buildSignIn((portal) => {
        if (selectedPortal === portal) return;
        selectedPortal = portal;
        rebuild();
      }),
    );
    return () => container.replaceChildren();
  }
  const portal = selectedPortal;

  // Connection row: which portal, as whom, sign out, connect another.
  const connectionRow = element("div", undefined, styles.row);
  const portalSelect = element("select", undefined, styles.input);
  portalSelect.ariaLabel = tr("portal", "Portal");
  for (const connection of connections) {
    const option = element("option", `${connection.username} @ ${new URL(connection.portal).host}`);
    option.value = connection.portal;
    option.selected = connection.portal === portal;
    portalSelect.append(option);
  }
  portalSelect.addEventListener("change", () => {
    selectedPortal = portalSelect.value;
    rebuild();
  });
  const signOut = button(tr("signOut", "Sign out"));
  signOut.addEventListener("click", () => {
    users.delete(portal);
    void auth?.signOut(portal);
  });
  const another = button(tr("addPortal", "Another portal"));
  connectionRow.append(portalSelect, signOut, another);
  const anotherForm = buildSignIn((next) => {
    if (selectedPortal === next) return;
    selectedPortal = next;
    rebuild();
  }, "");
  anotherForm.hidden = true;
  another.addEventListener("click", () => {
    anotherForm.hidden = !anotherForm.hidden;
  });

  // Browse controls: the view, a group, the item type and a keyword.
  const viewRow = element("div", undefined, styles.row);
  const viewSelect = element("select", undefined, styles.input);
  viewSelect.ariaLabel = tr("view", "Browse");
  for (const view of ARCGIS_PORTAL_VIEWS) {
    const option = element("option", tr(`views.${view}`, VIEW_LABELS[view]));
    option.value = view;
    option.selected = view === selectedView;
    viewSelect.append(option);
  }
  const groupSelect = element("select", undefined, styles.input);
  groupSelect.ariaLabel = tr("group", "Group");
  const typeSelect = element("select", undefined, styles.input);
  typeSelect.ariaLabel = tr("itemType", "Item type");
  typeSelect.append(element("option", tr("allTypes", "All supported types")));
  typeSelect.options[0].value = "";
  for (const type of PORTAL_ITEM_TYPES) {
    const option = element("option", type);
    option.value = type;
    option.selected = type === selectedType;
    typeSelect.append(option);
  }
  viewRow.append(viewSelect, groupSelect, typeSelect);
  const form = element("form", undefined, styles.row);
  const input = element("input", undefined, styles.input);
  input.type = "search";
  input.placeholder = tr("searchPlaceholder", "Filter by keyword");
  input.ariaLabel = input.placeholder;
  const submit = element("button", tr("search", "Search"), styles.primary);
  submit.type = "submit";
  form.append(input, submit);
  const status = element("div", undefined, styles.status);
  const results = element("div", undefined, styles.results);
  const more = button(tr("loadMore", "Load more"));
  more.hidden = true;
  panel.append(connectionRow, anotherForm, viewRow, form, status, results, more);

  let user: ArcGisPortalUser | undefined;
  // Each card's Add/Remove button follows the project's layers, so removing a
  // layer in the Layers panel turns its card back to Add to map.
  const addSyncs = new Set<() => void>();
  const unsubscribeLayers = useAppStore.subscribe((state, previous) => {
    if (state.layers !== previous.layers) addSyncs.forEach((sync) => sync());
  });
  let token = "";
  let start = 1;
  let shown = 0;

  const syncGroups = () => {
    groupSelect.hidden = selectedView !== "groups";
    const groups = user?.groups ?? [];
    if (!groups.some((group) => group.id === selectedGroupId)) {
      selectedGroupId = groups[0]?.id ?? "";
    }
    groupSelect.replaceChildren(
      ...groups.map((group) => {
        const option = element("option", group.title);
        option.value = group.id;
        option.selected = group.id === selectedGroupId;
        return option;
      }),
    );
  };
  syncGroups();

  const renderItem = (item: ArcGisPortalItem) => {
    const card = element("article", undefined, styles.card);
    const thumbnailUrl = arcgisPortalThumbnailUrl(portal, item, token);
    if (thumbnailUrl) {
      const thumbnail = element("img", undefined, styles.thumbnail);
      thumbnail.src = thumbnailUrl;
      thumbnail.alt = "";
      thumbnail.loading = "lazy";
      thumbnail.referrerPolicy = "no-referrer";
      thumbnail.addEventListener("error", () => thumbnail.remove(), { once: true });
      card.append(thumbnail);
    }
    const body = element("div", undefined, styles.cardBody);
    const meta = [item.type, item.owner, item.access].filter(Boolean).join(" · ");
    const actions = element("div", undefined, styles.row);
    // Add to map, or Remove from map while the item's layers are in the project.
    const key = itemKey(portal, item);
    const add = button("");
    let adding = false;
    const syncAdd = () => {
      const added = liveLayers(key).length > 0;
      add.textContent = adding
        ? tr("addingButton", "Adding…")
        : added
          ? tr("remove", "Remove from map")
          : tr("add", "Add to map");
      add.disabled = adding || (!added && !portalItemLayerType(item.type));
    };
    syncAdd();
    addSyncs.add(syncAdd);
    add.addEventListener("click", async () => {
      if (!appRef || adding) return;
      const live = liveLayers(key);
      if (live.length) {
        for (const id of live) useAppStore.getState().removeLayer(id);
        addedLayers.delete(key);
        status.textContent = tr("removed", "Removed {{title}}.", { title: item.title });
        syncAdd();
        return;
      }
      adding = true;
      syncAdd();
      status.textContent = tr("adding", "Adding {{title}}…", { title: item.title });
      try {
        const ids = await addItem(appRef, portal, item);
        if (ids.length) addedLayers.set(key, ids);
        status.textContent =
          ids.length === 0
            ? tr("webMapEmpty", "{{title}} has no layers that can be added.", { title: item.title })
            : tr("added", "Added {{title}}.", { title: item.title });
      } catch (error) {
        console.error("Could not add the ArcGIS portal item.", error);
        status.textContent = tr("addError", "Could not add {{title}}.", { title: item.title });
      } finally {
        adding = false;
        syncAdd();
      }
    });
    const bounds = portalItemBounds(item);
    const zoom = button(tr("zoom", "Zoom"));
    zoom.disabled = !bounds;
    zoom.addEventListener("click", () => bounds && appRef?.fitBounds?.(bounds));
    const details = button(tr("details", "Details"));
    details.addEventListener("click", () =>
      appRef?.openExternalUrl?.(arcgisPortalItemPageUrl(portal, item.id)),
    );
    actions.append(add, zoom, details);
    body.append(
      element("div", item.title, styles.title),
      element("div", meta, styles.status),
      ...(item.snippet ? [element("div", item.snippet, styles.status)] : []),
      actions,
    );
    card.append(body);
    results.append(card);
  };

  const runSearch = async (append: boolean) => {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const run = ++generation;
    if (!append) {
      start = 1;
      shown = 0;
      addSyncs.clear();
      results.replaceChildren();
    }
    more.hidden = true;
    submit.disabled = true;
    status.textContent = tr("searching", "Searching…");
    try {
      const fresh = await auth!.getToken(portal);
      // A newer search owns the panel now; do not overwrite its token.
      if (run !== generation) return;
      token = fresh;
      if (!user) {
        let lookup = users.get(portal);
        if (!lookup) {
          // Not tied to this search's signal: a rebuild must not abort the shared lookup.
          lookup = fetchPortalUser(portal, token);
          users.set(portal, lookup);
          lookup.catch(() => users.delete(portal));
        }
        user = await lookup;
        if (run !== generation) return;
        syncGroups();
      }
      const query = buildPortalSearchQuery({
        view: selectedView,
        user,
        text: input.value,
        groupId: selectedGroupId,
        types: selectedType ? [selectedType] : undefined,
      });
      if (run !== generation) return;
      if (!query) {
        status.textContent =
          selectedView === "groups"
            ? tr("noGroups", "You are not a member of any group.")
            : tr("viewUnavailable", "This view is not available for your account.");
        return;
      }
      const page = await searchPortal(portal, query, {
        start,
        num: PAGE_SIZE,
        token,
        relevance: Boolean(input.value.trim()),
        signal,
      });
      if (run !== generation) return;
      page.results.forEach(renderItem);
      shown += page.results.length;
      start = page.nextStart;
      status.textContent =
        shown === 0
          ? tr("noResults", "No items found.")
          : tr("showing", "Showing {{shown}} of {{total}} items.", {
              shown,
              total: page.total,
            });
      more.hidden = page.nextStart < 1 || shown >= page.total;
    } catch (error) {
      if ((error as Error).name === "AbortError" || run !== generation) return;
      console.error("Could not browse the ArcGIS portal.", error);
      status.textContent = auth?.errorMessage(error) ?? String(error);
    } finally {
      if (run === generation) submit.disabled = false;
    }
  };

  viewSelect.addEventListener("change", () => {
    selectedView = viewSelect.value as ArcGisPortalView;
    syncGroups();
    void runSearch(false);
  });
  groupSelect.addEventListener("change", () => {
    selectedGroupId = groupSelect.value;
    void runSearch(false);
  });
  typeSelect.addEventListener("change", () => {
    selectedType = typeSelect.value;
    void runSearch(false);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void runSearch(false);
  });
  more.addEventListener("click", () => void runSearch(true));
  void runSearch(false);

  return () => {
    controller?.abort();
    generation += 1;
    unsubscribeLayers();
    addSyncs.clear();
    container.replaceChildren();
  };
}

let panelContainer: HTMLElement | null = null;
let disposePanel: (() => void) | null = null;
let unregisterPanel: (() => void) | null = null;
let unsubscribeAuth: (() => void) | null = null;
let unsubscribeLocale: (() => void) | null = null;

function rebuildPanel(): void {
  if (!panelContainer) return;
  disposePanel?.();
  disposePanel = buildPanel(panelContainer);
}

export const maplibreArcGisPortalPlugin: GeoLibrePlugin = {
  id: ARCGIS_PORTAL_PLUGIN_ID,
  name: "ArcGIS Portal",
  version: "0.1.0",
  engines: ["maplibre", "cesium", "mapbox", "arcgis"],
  activate: (app) => {
    appRef = app;
    unregisterPanel =
      app.registerRightPanel?.({
        id: ARCGIS_PORTAL_PLUGIN_ID,
        title: pluginDisplayTitle(app, ARCGIS_PORTAL_PLUGIN_ID, "ArcGIS Portal"),
        dock: "replace-style",
        defaultWidth: 380,
        render: (container) => {
          panelContainer = container;
          disposePanel = buildPanel(container);
          return () => {
            disposePanel?.();
            disposePanel = null;
            if (panelContainer === container) panelContainer = null;
          };
        },
      }) ?? null;
    // Signing in or out here or in Add Data changes what the panel shows.
    unsubscribeAuth = auth?.subscribe(rebuildPanel) ?? null;
    unsubscribeLocale = app.onLocaleChange?.(rebuildPanel) ?? null;
    app.openRightPanel?.(ARCGIS_PORTAL_PLUGIN_ID);
  },
  deactivate: (app) => {
    app.closeRightPanel?.(ARCGIS_PORTAL_PLUGIN_ID);
    unsubscribeAuth?.();
    unsubscribeAuth = null;
    unsubscribeLocale?.();
    unsubscribeLocale = null;
    disposePanel?.();
    disposePanel = null;
    unregisterPanel?.();
    unregisterPanel = null;
    appRef = null;
  },
};
