import { expect, test } from "../test";
import { waitForMap } from "../helpers";

// Services started by the `enterprise-sso` job in .github/workflows/e2e-full.yml.
const API_URL = "http://localhost:8000";
const ISSUER = "https://localhost:8443/realms/geolibre";
const ORG_SLUG = "e2e-org";
// The gallery never prints organization names, so an organization-visible
// project is what proves the SSO account landed in the organization.
const ORG_PROJECT_TITLE = "E2E Org map";

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: API_URL });
  try {
    // Idempotent so a CI retry can run against the same database.
    const credentials = { username: "e2e-admin", password: "e2e-admin-password" };
    const created = await api.post("/api/accounts", { data: credentials });
    expect([201, 409], await created.text()).toContain(created.status());
    const signedIn = await api.post("/api/auth/token", { data: credentials });
    expect(signedIn.status(), await signedIn.text()).toBe(200);
    const { token } = (await signedIn.json()) as { token: string };
    const headers = { Authorization: `Bearer ${token}` };

    const createdOrg = await api.post("/api/organizations", {
      headers,
      data: { slug: ORG_SLUG, name: "E2E Org" },
    });
    expect([201, 409], await createdOrg.text()).toContain(createdOrg.status());
    const mine = await api.get("/api/organizations/mine", { headers });
    const { organizations } = (await mine.json()) as {
      organizations: { id: string; slug: string }[];
    };
    const organization = organizations.find((org) => org.slug === ORG_SLUG);
    expect(organization, "e2e-admin administers e2e-org").toBeDefined();
    const organizationId = organization!.id;

    const provider = await api.put(`/api/organizations/${organizationId}/identity-provider`, {
      headers,
      data: {
        issuer: ISSUER,
        clientId: "geolibre-server",
        clientSecret: "e2e-secret",
        roleMappings: [{ value: "gis-admins", role: "publisher" }],
      },
    });
    expect(provider.status(), await provider.text()).toBe(200);

    const project = await api.post("/api/projects", {
      headers,
      data: {
        filename: "e2e-org-map.geolibre.json",
        content: JSON.stringify({ version: "1.0", title: ORG_PROJECT_TITLE, layers: [] }),
        visibility: "organization",
        organizationId,
      },
    });
    expect(project.status(), await project.text()).toBe(201);
  } finally {
    await api.dispose();
  }
});

// Fails if the consent page CSP blocks the 303 to the IdP, or if the
// SameSite=Lax interaction cookie is not sent on the IdP's redirect back to
// /oauth/sso/callback.
test("signs in to the gallery through the organization's identity provider", async ({ page }) => {
  await waitForMap(page);

  await page.getByRole("button", { name: "Project", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open From" }).click();
  await page.getByRole("menuitem", { name: "Gallery..." }).click();
  const gallery = page.getByRole("dialog", { name: "Project gallery" });
  await expect(gallery).toBeVisible();

  const popupPromise = page.waitForEvent("popup");
  await gallery.getByRole("button", { name: /^Sign in to / }).click();
  const popup = await popupPromise;

  // The server-owned consent page.
  await popup.getByLabel("Organization", { exact: true }).fill(ORG_SLUG);
  await popup.getByRole("button", { name: "Sign in with your organization" }).click();

  // Keycloak's login form.
  await popup.waitForURL("https://localhost:8443/**");
  await popup.locator("#username").fill("grace");
  await popup.locator("#password").fill("e2e-password");
  await popup.locator("#kc-login").click();

  // The callback page posts the code back and the popup closes; the gallery
  // then lists grace's organization projects (a CI retry may have created a
  // second copy of the project, hence `first()`).
  await gallery.getByRole("button", { name: "Organizations", exact: true }).click();
  await expect(gallery.getByText(ORG_PROJECT_TITLE).first()).toBeVisible({ timeout: 30_000 });
});
