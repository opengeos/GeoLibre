/** Create every launch before activating a tab, keeping the popup alive until then. */
export async function openGeoLibreTabs(urls, tabs) {
  let firstId;
  for (const url of urls) {
    const tab = await tabs.create({ url, active: false });
    firstId ??= tab.id;
  }
  if (firstId !== undefined) await tabs.update(firstId, { active: true });
}
