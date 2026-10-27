import { expect, test, type Page } from "./test";
import { bindMapLibreMap } from "./helpers";

// Exercise the real presenter and renderer without a tile/geocoding service.
// Route by pathname so the ?project= page URL is not intercepted as JSON.
const PROJECT_PATH = "/story-presentation.geolibre.json";
const STYLE_PATH = "/story-presentation-style.json";
const FIRST_CENTER: [number, number] = [117.197, 39.117];
const SECOND_CENTER: [number, number] = [117.044, 39.384];

interface ChapterOptions {
  title: string;
  center: [number, number];
  durationSeconds?: number;
  mapAnimation?: "jumpTo" | "flyTo";
  description?: string;
}

interface StoryOptions {
  chapters?: ChapterOptions[];
  startSlide?: "none" | "black";
  endSlide?: "none" | "adjacent";
}

async function openPresentation(page: Page, baseURL: string, options: StoryOptions = {}) {
  const chapters = options.chapters ?? [
    { title: "City overview", center: FIRST_CENTER },
    { title: "District discussion", center: SECOND_CENTER },
    { title: "Final overview", center: [117.309, 39.717] },
  ];
  await page.route(
    (url) => url.pathname === STYLE_PATH,
    (route) =>
      route.fulfill({
        json: {
          version: 8,
          sources: {},
          layers: [
            { id: "background", type: "background", paint: { "background-color": "#eef2f6" } },
          ],
        },
      }),
  );
  await page.route(
    (url) => url.pathname === PROJECT_PATH,
    (route) =>
      route.fulfill({
        json: {
          version: "0.2.0",
          name: "Interactive presentation test",
          mapView: { center: FIRST_CENTER, zoom: 11, pitch: 0, bearing: 0 },
          mapProjection: "mercator",
          basemapStyleUrl: `${baseURL}${STYLE_PATH}`,
          layers: [],
          storymap: {
            title: "Interactive presentation",
            theme: "light",
            inset: false,
            showMarkers: false,
            startSlide: options.startSlide ?? "none",
            endSlide: options.endSlide ?? "none",
            chapters: chapters.map((chapter, index) => ({
              id: `chapter-${index}`,
              title: chapter.title,
              description: chapter.description ?? "Explore the map while discussing this chapter.",
              alignment: "left",
              hidden: false,
              location: { center: chapter.center, zoom: 11, pitch: 0, bearing: 0 },
              mapAnimation: chapter.mapAnimation ?? "jumpTo",
              rotateAnimation: false,
              durationSeconds: chapter.durationSeconds ?? 30,
              onChapterEnter: [],
              onChapterExit: [],
            })),
          },
        },
      }),
  );
  await page.goto(`/?locale=en&project=${encodeURIComponent(`${baseURL}${PROJECT_PATH}`)}`);
  await expect(page.getByTestId("story-presentation")).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await bindMapLibreMap(page);
  await page.waitForFunction(() => !window.__geolibreTestMap!.isMoving());
}

function status(page: Page) {
  return page.getByTestId("story-playback-status");
}

async function expectChapter(page: Page, title: string, timeout = 15_000) {
  await expect(
    page.getByRole("navigation", { name: "Story chapters" }).locator('[aria-current="step"]'),
  ).toContainText(title, { timeout });
}

async function camera(page: Page) {
  return page.evaluate(() => {
    const map = window.__geolibreTestMap!;
    const center = map.getCenter();
    return { lng: center.lng, lat: center.lat, zoom: map.getZoom() };
  });
}

async function dragMap(page: Page) {
  const box = await page.locator(".maplibregl-canvas").boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error("Map canvas has no bounds");
  // Below the text card/tools, above the playback bar: the gesture must reach
  // the live map, rather than moving a card or clicking a presentation control.
  const x = box.x + box.width * 0.72;
  const y = box.y + box.height * 0.72;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 150, y - 35, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => !window.__geolibreTestMap!.isMoving());
}

test.use({ viewport: { width: 1600, height: 1000 }, reducedMotion: "no-preference" });

test("starts paused and manual chapter navigation never starts a timer", async ({
  page,
  baseURL,
}) => {
  await openPresentation(page, baseURL!, {
    chapters: [
      { title: "City overview", center: FIRST_CENTER, durationSeconds: 1 },
      { title: "District discussion", center: SECOND_CENTER, durationSeconds: 1 },
    ],
  });
  await expectChapter(page, "City overview");
  await expect(status(page)).toContainText("Paused for discussion");
  await expect(page.getByRole("button", { name: "Play automatically", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next chapter", exact: true }).click();
  await expectChapter(page, "District discussion");
  await expect(status(page)).toContainText("Paused for discussion");
  await page
    .getByRole("navigation", { name: "Story chapters" })
    .getByRole("button", { name: /City overview/ })
    .click();
  // Wait beyond the one-second chapter duration: a stray timer would advance.
  await page.waitForTimeout(1300);
  await expectChapter(page, "City overview");
  await expect(status(page)).toContainText("Paused for discussion");
});

interface PlaybackObservations {
  statuses: { text: string; time: number }[];
  arrivals: { lng: number; lat: number; time: number }[];
}

declare global {
  interface Window {
    __storyPlaybackObservations?: PlaybackObservations;
  }
}

test("autoplay starts the dwell timer after the real camera arrives", async ({ page, baseURL }) => {
  const destination: [number, number] = [-74, 40.7];
  await openPresentation(page, baseURL!, {
    chapters: [
      { title: "City overview", center: FIRST_CENTER, durationSeconds: 1 },
      { title: "Long flight", center: destination, durationSeconds: 1, mapAnimation: "flyTo" },
      { title: "Final overview", center: SECOND_CENTER, durationSeconds: 30 },
    ],
  });
  await page.evaluate(() => {
    const observations: PlaybackObservations = { statuses: [], arrivals: [] };
    window.__storyPlaybackObservations = observations;
    const statusElement = document.querySelector('[data-testid="story-playback-status"]')!;
    new MutationObserver(() => {
      observations.statuses.push({
        text: statusElement.textContent ?? "",
        time: performance.now(),
      });
    }).observe(statusElement, { subtree: true, childList: true, characterData: true });
    const map = window.__geolibreTestMap!;
    // The shared test handle only types movestart; this listener reads the
    // engine's public moveend event, without replacing any renderer behavior.
    (map as unknown as { on(type: string, listener: () => void): void }).on("moveend", () => {
      const center = map.getCenter();
      observations.arrivals.push({ lng: center.lng, lat: center.lat, time: performance.now() });
    });
  });
  await page.getByRole("button", { name: "Play automatically", exact: true }).click();
  await expectChapter(page, "Final overview", 30_000);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const observations = await page.evaluate(() => window.__storyPlaybackObservations!);
  const arrival = observations.arrivals.find(
    (entry) =>
      Math.abs(entry.lng - destination[0]) < 0.001 && Math.abs(entry.lat - destination[1]) < 0.001,
  );
  const moving = observations.statuses.find(
    (entry) => entry.text.includes("Chapter 2 / 3") && entry.text.includes("Moving to chapter"),
  );
  const countdown = observations.statuses.find(
    (entry) => entry.text.includes("Chapter 2 / 3") && entry.text.includes("Next in"),
  );
  const next = observations.statuses.find((entry) => entry.text.includes("Chapter 3 / 3"));
  expect(arrival).toBeDefined();
  expect(moving).toBeDefined();
  expect(countdown).toBeDefined();
  expect(next).toBeDefined();
  expect(moving!.time).toBeLessThan(arrival!.time);
  expect(countdown!.time).toBeGreaterThanOrEqual(arrival!.time);
  expect(next!.time - arrival!.time).toBeGreaterThanOrEqual(950);
});

test("dragging pauses autoplay, reset restores this view, and play resumes at the next chapter", async ({
  page,
  baseURL,
}) => {
  await openPresentation(page, baseURL!, {
    chapters: [
      { title: "City overview", center: FIRST_CENTER, durationSeconds: 3 },
      { title: "District discussion", center: SECOND_CENTER, durationSeconds: 30 },
      { title: "Final overview", center: [117.309, 39.717], durationSeconds: 30 },
    ],
  });
  const authored = await camera(page);
  await page.getByRole("button", { name: "Play automatically", exact: true }).click();
  await expect(status(page)).toContainText("Next in");
  await dragMap(page);
  await expect(status(page)).toContainText("Paused for discussion");
  const explored = await camera(page);
  expect(Math.abs(explored.lng - authored.lng)).toBeGreaterThan(0.001);
  // Neither the cancelled timer nor an idle timeout may reclaim the map.
  await page.waitForTimeout(3250);
  await expectChapter(page, "City overview");
  expect(await camera(page)).toEqual(explored);
  await page.getByRole("button", { name: "Return to chapter view", exact: true }).click();
  await expect.poll(async () => (await camera(page)).lng).toBeCloseTo(FIRST_CENTER[0], 4);
  await expect(status(page)).toContainText("Paused for discussion");
  await dragMap(page);
  await page.getByRole("button", { name: "Autoplay next chapter", exact: true }).click();
  await expectChapter(page, "District discussion");
  await expect(status(page)).toContainText("Next in");
  await expect.poll(async () => (await camera(page)).lng).toBeCloseTo(SECOND_CENTER[0], 4);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Previous chapter", exact: true }).click();
  await expectChapter(page, "City overview");
  // Exploring did not overwrite the authored chapter camera.
  await expect.poll(async () => (await camera(page)).lng).toBeCloseTo(FIRST_CENTER[0], 4);
});

test("scrolling chapter text does not change chapters or zoom the map", async ({
  page,
  baseURL,
}) => {
  await openPresentation(page, baseURL!, {
    chapters: [
      {
        title: "Long explanation",
        center: FIRST_CENTER,
        description: Array.from(
          { length: 60 },
          (_, i) => `<p>Discussion paragraph ${i + 1}.</p>`,
        ).join(""),
      },
      { title: "Next location", center: SECOND_CENTER },
    ],
  });
  const before = await camera(page);
  await page.getByRole("button", { name: "Play automatically", exact: true }).click();
  const body = page.locator(".glsm-active .glsm-card-body");
  await body.hover();
  await page.mouse.wheel(0, 650);
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expectChapter(page, "Long explanation");
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  expect(await camera(page)).toEqual(before);
});

test("opening and closing slides remain reachable and the final step does not loop", async ({
  page,
  baseURL,
}) => {
  await openPresentation(page, baseURL!, { startSlide: "black", endSlide: "adjacent" });
  await expect(status(page)).toContainText("Opening / closing slide");
  await expect(page.locator(".glsm-slide-step.glsm-active")).toHaveCount(1);
  await page.getByRole("button", { name: "Next chapter", exact: true }).click();
  await expectChapter(page, "City overview");
  await page
    .getByRole("navigation", { name: "Story chapters" })
    .getByRole("button", { name: /Final overview/ })
    .click();
  await page.getByRole("button", { name: "Next chapter", exact: true }).click();
  await expect(status(page)).toContainText("Opening / closing slide");
  await expect(page.getByRole("button", { name: "Next chapter", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Finish presentation", exact: true }).click();
  await expect(status(page)).toContainText("Presentation finished");
  await expect(page.getByRole("button", { name: "Replay", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Replay", exact: true }).click();
  await expect(status(page)).toContainText("Opening / closing slide");
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
});

test("Escape respects an editable control and still exits back to the story editor", async ({
  page,
  baseURL,
}) => {
  await openPresentation(page, baseURL!);
  await page.getByRole("button", { name: "Exit", exact: true }).click();
  await page.getByRole("button", { name: "Project", exact: true }).click();
  await page.getByRole("menuitem", { name: "Story map…", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Present", exact: true }).click();
  await page.getByRole("button", { name: "Presentation tools", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Search a place or latitude, longitude" });
  await search.fill("39.117, 117.197");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("story-presentation")).toBeVisible();
  // Move focus out of the input before the presentation owns Escape again.
  await page.getByRole("button", { name: "Return to chapter view", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("story-presentation")).toBeHidden();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "Story map", exact: true }),
  ).toBeVisible();
});

test("chapter duration stays editable until blur and then normalizes", async ({
  page,
  baseURL,
}) => {
  await openPresentation(page, baseURL!);
  await page.getByRole("button", { name: "Exit", exact: true }).click();
  await page.getByRole("button", { name: "Project", exact: true }).click();
  await page.getByRole("menuitem", { name: "Story map…", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /1 City overview/ }).click();
  const duration = dialog.getByRole("spinbutton", { name: "Stay duration (seconds)" });
  await duration.fill("0");
  await expect(duration).toHaveValue("0");
  await duration.pressSequentially(".5");
  await expect(duration).toHaveValue("0.5");
  await duration.blur();
  await expect(duration).toHaveValue("1");
  await duration.fill("120.5");
  await duration.blur();
  await expect(duration).toHaveValue("120.5");
  await duration.fill("4000");
  await duration.blur();
  await expect(duration).toHaveValue("3600");
  await duration.fill("");
  await duration.blur();
  await expect(duration).toHaveValue("");
});
