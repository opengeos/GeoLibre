const list = document.querySelector("#artifact-list");
const filter = document.querySelector("#artifact-filter");
const emptyState = document.querySelector("#empty-state");
const platformNav = document.querySelector("#platform-nav");
let artifacts = [];

const platformOrder = ["Windows", "macOS", "Linux", "Android", "iOS", "Browser", "Other"];

const bytes = new Intl.NumberFormat("en", {
  style: "unit",
  unit: "megabyte",
  unitDisplay: "short",
  maximumFractionDigits: 1,
});

function formatBytes(value) {
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`;
  return bytes.format(value / 1_000_000);
}

function platformFor(name) {
  const value = name.toLowerCase();
  if (value.includes("android") || /\.(apk|aab)$/.test(value)) return "Android";
  if (value.includes("ios") || value.endsWith(".ipa")) return "iOS";
  if (value.includes("chrome")) return "Browser";
  if (/\.(exe|msi|msix)$/.test(value) || value.includes("windows") || value.includes("portable"))
    return "Windows";
  if (/\.(dmg|pkg)$/.test(value) || value.includes("darwin") || value.includes(".app."))
    return "macOS";
  if (/\.(deb|rpm|appimage|zsync)$/.test(value) || value.includes("linux")) return "Linux";
  return "Other";
}

function artifactRow(artifact) {
  const link = document.createElement("a");
  const platform = platformFor(artifact.name);
  link.className = "artifact-row";
  link.href = artifact.download_url;
  link.setAttribute("download", artifact.mirrored ? "" : artifact.name);
  link.dataset.search = `${artifact.name} ${platform}`.toLowerCase();
  if (!artifact.mirrored) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }

  const platformLabel = document.createElement("span");
  platformLabel.className = "artifact-platform";
  platformLabel.textContent = platform;

  const name = document.createElement("span");
  name.className = "artifact-name";
  name.textContent = artifact.name;

  const size = document.createElement("span");
  size.className = "artifact-size";
  size.textContent = formatBytes(artifact.size);

  const source = document.createElement("span");
  source.className = `source-badge${artifact.mirrored ? "" : " github"}`;
  source.textContent = artifact.mirrored ? "Mirrored" : "GitHub only";

  const arrow = document.createElement("span");
  arrow.className = "download-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = artifact.mirrored ? "↓" : "↗";

  link.append(platformLabel, name, size, source, arrow);
  return link;
}

function render(query = "") {
  const normalizedQuery = query.trim().toLowerCase();
  const visible = artifacts.filter(({ element }) =>
    element.dataset.search.includes(normalizedQuery),
  );
  const groups = platformOrder
    .map((platform) => {
      const matches = visible.filter((item) => item.platform === platform);
      if (matches.length === 0) return null;

      const section = document.createElement("section");
      section.className = "platform-group";
      section.id = `platform-${platform.toLowerCase()}`;

      const heading = document.createElement("header");
      heading.className = "platform-heading";
      const title = document.createElement("h3");
      title.textContent = platform;
      const count = document.createElement("span");
      count.className = "platform-count";
      count.textContent = `— ${matches.length} ${matches.length === 1 ? "file" : "files"}`;
      title.append(count);
      heading.append(title);
      section.append(heading, ...matches.map(({ element }) => element));
      return section;
    })
    .filter(Boolean);

  list.replaceChildren(...groups);
  emptyState.hidden = visible.length !== 0;
}

function renderPlatformNav() {
  const counts = new Map(platformOrder.map((platform) => [platform, 0]));
  artifacts.forEach(({ platform }) => counts.set(platform, counts.get(platform) + 1));
  const links = platformOrder
    .filter((platform) => counts.get(platform) > 0)
    .map((platform) => {
      const link = document.createElement("a");
      link.href = `#platform-${platform.toLowerCase()}`;
      link.textContent = platform;
      const count = document.createElement("span");
      count.textContent = ` ${counts.get(platform)}`;
      link.append(count);
      return link;
    });
  platformNav.replaceChildren(...links);
}

async function loadManifest() {
  try {
    const response = await fetch("/manifest.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = await response.json();

    document.querySelector("#release-version").textContent = manifest.release.tag;
    document.querySelector("#published-at").textContent = new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
    }).format(new Date(manifest.release.published_at));
    document.querySelector("#file-count").textContent = manifest.artifacts.length;
    document.querySelector("#mirror-size").textContent = formatBytes(manifest.mirrored_bytes);
    document.title = `${manifest.release.tag} · GeoLibre downloads`;

    artifacts = manifest.artifacts.map((artifact) => {
      const platform = platformFor(artifact.name);
      return { artifact, platform, element: artifactRow(artifact) };
    });
    renderPlatformNav();
    render();
  } catch (error) {
    list.innerHTML = `<p class="error">The release manifest could not be loaded. Reload the page or use the project’s GitHub releases page.</p>`;
    console.error(error);
  }
}

filter.addEventListener("input", () => render(filter.value));
loadManifest();
