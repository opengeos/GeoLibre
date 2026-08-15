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

  const canonicalUrl = (url) => {
    if (url.hostname !== "source.coop") return url;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 3) return url;
    const canonical = new URL(url.href);
    canonical.hostname = "data.source.coop";
    return canonical;
  };

  const classify = (url, hint = "") => {
    const path = url.pathname.toLowerCase();
    const clue = String(hint).toLowerCase();
    if (/\.geojson$/.test(path) || /geo\+json|geojson|feature\s*collection/.test(clue)) {
      return { format: "GeoJSON", kind: "vector", confidence: 3 };
    }
    if (/\.(?:geoparquet|parquet)$/.test(path) || /geoparquet|parquet/.test(clue)) {
      return { format: "GeoParquet", kind: "vector", confidence: 3 };
    }
    if (/\.pmtiles$/.test(path) || /pmtiles/.test(clue)) {
      return { format: "PMTiles", kind: "vector", confidence: 3 };
    }
    if (/\.(?:tif|tiff|cog)$/.test(path) || /geotiff|cloud.?optimized|\bcog\b/.test(clue)) {
      return { format: "GeoTIFF", kind: "raster", confidence: 3 };
    }
    if (/\.zip$/.test(path) || /application\/zip|geojson.*zip|zip.*geojson/.test(clue)) {
      return { format: "ZIP", kind: "vector", confidence: 2 };
    }
    if (
      /\.json$/.test(path) &&
      !/(?:\.style|\.geolibre\.style)\.json$/.test(path) &&
      jsonHint.test(clue)
    ) {
      return { format: "JSON", kind: "vector", confidence: 1 };
    }
    return geoHint.test(clue)
      ? {
          format: "Data API",
          kind: /geotiff|cloud.?optimized|\bcog\b/.test(clue) ? "raster" : "vector",
          confidence: 2,
        }
      : null;
  };

  const addDataset = (raw, hint = "", label = "", explicitStyle = null) => {
    let url = absoluteHttpUrl(raw);
    if (!url) return;

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

    url = canonicalUrl(url);

    const kind = classify(url, hint);
    if (!kind) return;
    const existing = datasets.get(url.href);
    const name = label.trim() || cleanName(url);
    const candidate = {
      url: url.href,
      name,
      format: kind.format,
      kind: kind.kind,
      confidence: kind.confidence,
      styleUrl: absoluteHttpUrl(explicitStyle)?.href ?? null,
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
      styleLinks.push(url);
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
        .join("\n");
      const filePattern = /\\"path\\":\\"([^"]+)\\"[^{}]*?\\"type\\":\\"file\\"/g;
      for (const match of inventory.matchAll(filePattern)) {
        let path = match[1];
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
