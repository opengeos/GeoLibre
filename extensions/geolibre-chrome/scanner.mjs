/**
 * Inspect the current document for links GeoLibre can open. Keep every helper
 * inside this function: Chrome serializes the function when it injects it into
 * the active tab, so it cannot close over module-level values.
 */
export function scanDocumentForDatasets() {
  const datasets = new Map();
  const styleLinks = [];
  const geoHint =
    /geojson|feature\s*collection|geoparquet|pmtiles|geotiff|cloud.?optimized|\bcog\b/i;
  const jsonHint = /geo|spatial|geographic|vector|dataset|features?/i;

  const absoluteHttpUrl = (raw) => {
    if (typeof raw !== "string" || !raw.trim()) return null;
    try {
      const url = new URL(raw.trim(), document.baseURI);
      return url.protocol === "http:" || url.protocol === "https:" ? url : null;
    } catch {
      return null;
    }
  };

  const cleanName = (url, fallback = "Dataset") => {
    const part = url.pathname.split("/").filter(Boolean).pop();
    if (!part) return fallback;
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };

  const huggingFaceHost = (url) => /^(?:huggingface\.co|hf\.co)$/i.test(url.hostname);

  // The Hub links one file from seven routes -- blob, raw, blame, edit, delete,
  // commits and the ?download=true button -- and every one of them ends in the
  // file's own extension, so a repository page yields near-duplicate hits where
  // only `resolve` (which 302s to the CDN) serves bytes a map source can read.
  const huggingFaceFileUrl = (url) => {
    if (!huggingFaceHost(url)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const isRoute = (part) => /^(?:blob|raw|blame|edit|delete|commits|resolve)$/.test(part ?? "");
    // /<owner>/<repo>/<route>/<revision>/<path> for models, one segment deeper
    // under /datasets and /spaces, and one shallower for the namespaceless
    // legacy repos both shapes still carry. Read the route from the positions
    // the grammar allows rather than scanning for the first keyword, so an
    // owner, repository or revision named after a route cannot stand in for
    // one, and prefer the deeper position since namespaced repos are the norm.
    const route = (/^(?:datasets|spaces)$/.test(parts[0]) ? [3, 2] : [2, 1]).find(
      (index) => isRoute(parts[index]) && parts.length >= index + 3,
    );
    if (route === undefined) return null;
    parts[route] = "resolve";
    const canonical = new URL(url.href);
    canonical.pathname = `/${parts.join("/")}`;
    canonical.searchParams.delete("download");
    // A line anchor off a blob page would otherwise split one file into two
    // entries that the CDN serves identically.
    canonical.hash = "";
    return canonical;
  };

  const canonicalUrl = (url) => {
    if (huggingFaceHost(url)) return huggingFaceFileUrl(url) ?? url;
    if (url.hostname !== "source.coop") return url;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 3) return url;
    const canonical = new URL(url.href);
    canonical.hostname = "data.source.coop";
    return canonical;
  };

  const canonicalHttpUrl = (raw) => {
    const url = absoluteHttpUrl(raw);
    return url ? canonicalUrl(url) : null;
  };

  const wordsIn = (value) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter(Boolean);

  /**
   * True when the link text reads back the URL's last path segment. A site
   * root has no segment to read back and is never a dataset either way, so it
   * counts as a page outright.
   */
  const echoesSlug = (path, clue) => {
    const slug = wordsIn(path.split("/").filter(Boolean).pop() ?? "");
    if (!slug.length) return true;
    const said = wordsIn(clue);
    return slug.every((word) => said.includes(word));
  };

  const classify = (url, hint = "") => {
    const path = url.pathname.toLowerCase();
    const clue = String(hint).toLowerCase();
    // A hint alone identifies an extensionless download endpoint, but on a URL
    // that is plainly a web page the same words describe the page rather than
    // name data it serves: a documentation site links "Add a GeoJSON line" to
    // `/examples/add-a-geojson-line/`, which is HTML. A page extension says so
    // outright; a directory-style URL says so only when the link text is the
    // slug read back, which is what a page *about* a format looks like. An
    // endpoint that merely ends in a slash (`/api/datasets/123/`) keeps its
    // hint, since its slug names a resource rather than echoing the words.
    const isPage =
      /\.(?:html?|php|aspx?|jsp)$/.test(path) || (/\/$/.test(path) && echoesSlug(path, clue));
    const says = (pattern) => !isPage && pattern.test(clue);
    if (/\.geojson$/.test(path) || says(/geo\+json|geojson|feature\s*collection/)) {
      return { format: "GeoJSON", kind: "vector", confidence: 3 };
    }
    if (/\.(?:geoparquet|parquet)$/.test(path) || says(/geoparquet|parquet/)) {
      return { format: "GeoParquet", kind: "vector", confidence: 3 };
    }
    if (/\.pmtiles$/.test(path) || says(/pmtiles/)) {
      return { format: "PMTiles", kind: "vector", confidence: 3 };
    }
    if (/\.(?:tif|tiff|cog)$/.test(path) || says(/geotiff|cloud.?optimized|\bcog\b/)) {
      return { format: "GeoTIFF", kind: "raster", confidence: 3 };
    }
    if (/\.zip$/.test(path) || says(/application\/zip|geojson.*zip|zip.*geojson/)) {
      return { format: "ZIP", kind: "vector", confidence: 2 };
    }
    if (
      /\.json$/.test(path) &&
      !/(?:\.style|\.geolibre\.style)\.json$/.test(path) &&
      jsonHint.test(clue)
    ) {
      return { format: "JSON", kind: "vector", confidence: 1 };
    }
    return says(geoHint)
      ? {
          format: "Data API",
          kind: /geotiff|cloud.?optimized|\bcog\b/.test(clue) ? "raster" : "vector",
          confidence: 2,
        }
      : null;
  };

  const addDataset = (raw, hint = "", label = "", explicitStyle = null) => {
    const url = canonicalHttpUrl(raw);
    if (!url) return;

    // Source Cooperative data objects have already been rewritten to the
    // data.source.coop host by canonicalUrl. Anything left on source.coop is
    // site navigation, such as `/products?tags=cloud%20optimised%20geotiff`,
    // whose label can otherwise look like a raster format hint.
    if (url.hostname === "source.coop") return;

    // A page may link to an existing GeoLibre deep link. Unpack it so users can
    // combine its datasets with other links found on the same page.
    const nestedData = url.searchParams.getAll("data");
    if (nestedData.length && /(?:^|\.)geolibre\.app$/i.test(url.hostname)) {
      const nestedStyles = url.searchParams.getAll("style");
      nestedData.forEach((dataUrl, index) =>
        addDataset(dataUrl, hint, "", nestedStyles[index] || null),
      );
      return;
    }

    // Every Hub route other than a file route is a UI page -- tree, viewer, the
    // "Auto-converted to Parquet" branch -- so a hint-based match there would
    // offer HTML as data.
    const onHub = huggingFaceHost(url);
    if (onHub && !huggingFaceFileUrl(url)) return;

    const kind = classify(url, hint);
    if (!kind) return;
    const existing = datasets.get(url.href);
    // Hub links carry UI chrome as their text ("Download", "History", "308 kB
    // xet"), so the file name has to come from the path.
    const name = (onHub ? "" : label.trim()) || cleanName(url);
    const candidate = {
      url: url.href,
      name,
      format: kind.format,
      kind: kind.kind,
      confidence: kind.confidence,
      styleUrl: canonicalHttpUrl(explicitStyle)?.href ?? existing?.styleUrl ?? null,
    };
    if (!existing || candidate.confidence > existing.confidence) datasets.set(url.href, candidate);
    else if (!existing.styleUrl && candidate.styleUrl) existing.styleUrl = candidate.styleUrl;
  };

  for (const element of document.querySelectorAll("a[href], link[href]")) {
    const raw = element.getAttribute("href");
    const hint = [
      element.getAttribute("type"),
      element.getAttribute("rel"),
      element.getAttribute("download"),
      element.getAttribute("title"),
      element.textContent,
    ]
      .filter(Boolean)
      .join(" ");
    const url = absoluteHttpUrl(raw);
    if (!url) continue;
    if (/(?:\.style|\.geolibre\.style)\.json$/i.test(url.pathname)) {
      styleLinks.push(canonicalUrl(url));
      continue;
    }
    addDataset(url.href, hint, element.getAttribute("download") || element.textContent || "");
  }

  for (const element of document.querySelectorAll("[data-url], [data-href], source[src]")) {
    const raw =
      element.getAttribute("data-url") ||
      element.getAttribute("data-href") ||
      element.getAttribute("src");
    const hint = [element.getAttribute("type"), element.getAttribute("title"), element.textContent]
      .filter(Boolean)
      .join(" ");
    addDataset(raw, hint, element.getAttribute("title") || "");
  }

  const visitStructuredData = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visitStructuredData);
      return;
    }
    if (!value || typeof value !== "object") return;
    const hint = [value.encodingFormat, value.fileFormat, value.name, value.description]
      .filter((part) => typeof part === "string")
      .join(" ");
    for (const key of ["contentUrl", "downloadUrl"]) {
      if (typeof value[key] === "string") addDataset(value[key], hint, value.name || "");
    }
    Object.values(value).forEach(visitStructuredData);
  };

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      visitStructuredData(JSON.parse(script.textContent || "null"));
    } catch {
      // Invalid third-party structured data should not prevent ordinary link discovery.
    }
  }

  // Source Cooperative virtualizes large repository listings, leaving only
  // the visible rows as anchors. Its Next.js payload still contains every
  // object in the current directory, so recover supported file paths from that
  // embedded inventory and point them at the public data host.
  const pageUrl = absoluteHttpUrl(document.baseURI);
  if (pageUrl?.hostname === "source.coop") {
    const [account, product] = pageUrl.pathname.split("/").filter(Boolean);
    if (account && product) {
      const inventory = [...document.querySelectorAll("script")]
        .map((script) => script.textContent || "")
        .filter((content) => content.includes("self.__next_f.push"))
        .join("\n");
      const objectPattern = /\{[^{}]*\}/g;
      let recoveredFiles = 0;
      for (const match of inventory.matchAll(objectPattern)) {
        const object = match[0];
        const pathMatch = object.match(/\\"path\\":\\"([^"]+)\\"/);
        const typeMatch = object.match(/\\"type\\":\\"([^"]+)\\"/);
        if (!pathMatch || typeMatch?.[1] !== "file") continue;
        recoveredFiles += 1;
        let path = pathMatch[1];
        try {
          path = JSON.parse(`"${path}"`);
        } catch {
          // A plain path needs no unescaping; malformed serialized data is ignored by addDataset.
        }
        addDataset(
          `https://data.source.coop/${encodeURIComponent(account)}/${encodeURIComponent(product)}/${path
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`,
          path,
          path,
        );
      }
      if (recoveredFiles === 0) {
        console.warn("GeoLibre found no file entries in the Source Cooperative page inventory.");
      }
    }
  }

  const stem = (url, style = false) => {
    const name = cleanName(url, "").toLowerCase();
    return style
      ? name.replace(/(?:\.geolibre\.style|\.style)\.json$/, "")
      : name.replace(/\.(?:geojson|json|zip|geoparquet|parquet|pmtiles|tiff?|cog)$/, "");
  };
  for (const dataset of datasets.values()) {
    if (dataset.styleUrl) continue;
    const datasetStem = stem(new URL(dataset.url));
    const match = styleLinks.find((styleUrl) => stem(styleUrl, true) === datasetStem);
    if (match) dataset.styleUrl = match.href;
  }

  return [...datasets.values()]
    .sort(
      (left, right) => right.confidence - left.confidence || left.name.localeCompare(right.name),
    )
    .map(({ confidence: _confidence, ...dataset }) => dataset);
}
