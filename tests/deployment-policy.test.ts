import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020";
import { DEPLOYMENT_CAPABILITIES } from "@geolibre/core";
import { SERVICE_KINDS } from "../apps/geolibre-desktop/src/components/layout/add-data/service-library";
import { EXPERIENCE_LEVELS } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import {
  getDeploymentPolicy,
  setDeploymentPolicy,
} from "../apps/geolibre-desktop/src/lib/deployment-env";
import { OPTIONAL_RESOURCE_HEADER } from "../apps/geolibre-desktop/src/lib/diagnostics";
import {
  fetchDeploymentPolicy,
  loadDeploymentPolicy,
  parseDeploymentPolicy,
  resolveDeploymentPolicy,
} from "../apps/geolibre-desktop/src/lib/deployment-policy";
import { loadAdminProfile } from "../apps/geolibre-desktop/src/lib/admin-profile";

const FIXTURES = fileURLToPath(new URL("./fixtures/deployment-policy/", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("../schema/deployment.schema.json", import.meta.url));

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const validate = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
}).compile(schema);

const SECTIONS = [
  "capabilities",
  "interface",
  "plugins",
  "services",
  "sharing",
  "geolens",
  "ai",
  "branding",
];

function readFixture(name: string): string {
  return readFileSync(`${FIXTURES}${name}`, "utf8");
}

/** Collects console.warn messages into the returned array; restored after the test. */
function captureWarnings(t: TestContext): string[] {
  const messages: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    messages.push(args.join(" "));
  });
  return messages;
}

const SCHEMA_ID =
  "https://raw.githubusercontent.com/opengeos/GeoLibre/main/schema/deployment.schema.json";

// Small valid documents kept inline; the exhaustive one lives in good/full.json.
const GOOD_DOCUMENTS: Record<string, string> = {
  minimal: readFixture("good/minimal.json"),
  full: readFixture("good/full.json"),
  "empty lists": JSON.stringify({
    version: 1,
    capabilities: [],
    plugins: { allowed: [], sideload: false },
  }),
  "off switches": JSON.stringify({
    version: 1,
    sharing: { shareUrl: "off", embedOrigins: ["*"] },
    geolens: { url: "off" },
    services: { builtins: false },
    branding: { welcome: false },
  }),
  "with $schema": JSON.stringify({
    $schema: SCHEMA_ID,
    version: 1,
    capabilities: ["data:add"],
  }),
};

test("good documents validate and round-trip silently", (t) => {
  const warnings = captureWarnings(t);
  for (const [name, text] of Object.entries(GOOD_DOCUMENTS)) {
    const json = JSON.parse(text);
    assert.equal(validate(json), true, `${name}: ${JSON.stringify(validate.errors)}`);
    const { $schema: _ignored, ...expected } = json;
    assert.deepEqual(parseDeploymentPolicy(text), expected, name);
  }
  assert.equal(warnings.length, 0);
});

interface BadCase {
  input: unknown;
  /** Whether JSON Schema alone rejects it; "accept" marks rules only the parser enforces. */
  schema: "reject" | "accept";
  /** Substring the container entrypoint error must contain (docker/deployment_policy.py). */
  container: string;
  parser: "null" | { dropped: string[] };
}

test("bad cases match expected schema and parser results", (t) => {
  const cases = JSON.parse(readFixture("bad-cases.json")) as Record<string, BadCase>;
  const warnings = captureWarnings(t);
  for (const [name, expected] of Object.entries(cases)) {
    // 9007199254740993 cannot survive JSON.stringify, so the case holds a placeholder.
    const text = JSON.stringify(expected.input).replace('"__UNSAFE__"', "9007199254740993");
    const json = JSON.parse(text);
    assert.equal(validate(json), expected.schema === "accept", `${name}: schema`);

    warnings.length = 0;
    const result = parseDeploymentPolicy(text);
    if (expected.parser === "null") {
      assert.equal(result, null, name);
      continue;
    }
    const { dropped } = expected.parser;
    const kept = SECTIONS.filter((s) => json[s] !== undefined && !dropped.includes(s));
    assert.deepEqual(
      Object.keys(result ?? {})
        .filter((k) => k !== "version")
        .sort(),
      kept.sort(),
      name,
    );
    const unknownKeyWarning = name === "unknown-top-level-key" ? 1 : 0;
    assert.equal(warnings.length, expected.parser.dropped.length + unknownKeyWarning, name);
  }
});

test("unsupported versions return null with one warning", (t) => {
  const warnings = captureWarnings(t);
  for (const text of ['{"version":2}', "{}", '{"version":"1"}']) {
    warnings.length = 0;
    assert.equal(parseDeploymentPolicy(text), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unsupported version/);
  }
});

test("non-objects and non-JSON return null silently", (t) => {
  const warnings = captureWarnings(t);
  assert.equal(parseDeploymentPolicy("[]"), null);
  assert.equal(parseDeploymentPolicy("<!doctype html>"), null);
  assert.equal(parseDeploymentPolicy(""), null);
  assert.equal(parseDeploymentPolicy(null), null);
  assert.equal(warnings.length, 0);
});

test("a leading UTF-8 BOM is accepted", () => {
  assert.deepEqual(parseDeploymentPolicy('\uFEFF{"version":1,"capabilities":[]}'), {
    version: 1,
    capabilities: [],
  });
});

test("an invalid section does not affect the others", (t) => {
  captureWarnings(t);
  const policy = resolveDeploymentPolicy({
    version: 1,
    capabilities: ["data:add"],
    plugins: { sideload: "no" },
  });
  assert.deepEqual(policy, { version: 1, capabilities: ["data:add"] });
});

test("omitted differs from empty", () => {
  assert.equal(resolveDeploymentPolicy({ version: 1 })?.capabilities, undefined);
  assert.deepEqual(resolveDeploymentPolicy({ version: 1, capabilities: [] })?.capabilities, []);
  assert.equal(resolveDeploymentPolicy({ version: 1, plugins: {} })?.plugins?.allowed, undefined);
  assert.deepEqual(
    resolveDeploymentPolicy({ version: 1, plugins: { allowed: [] } })?.plugins?.allowed,
    [],
  );
});

test("id lists are trimmed", () => {
  const policy = resolveDeploymentPolicy({
    version: 1,
    plugins: { blocked: [" a "] },
  });
  assert.deepEqual(policy?.plugins?.blocked, ["a"]);
});

test("schema enums stay in sync with code", () => {
  assert.equal(
    schema.$id,
    "https://raw.githubusercontent.com/opengeos/GeoLibre/main/schema/deployment.schema.json",
  );
  assert.deepEqual(schema.properties.capabilities.items.enum, [...DEPLOYMENT_CAPABILITIES]);
  assert.deepEqual(schema.properties.interface.properties.level.enum, [...EXPERIENCE_LEVELS]);
  assert.deepEqual(schema.properties.services.properties.catalog.items.properties.kind.enum, [
    ...SERVICE_KINDS,
  ]);
});

function fakeFetch(body: string, init: ResponseInit = {}): typeof fetch {
  return (async () => new Response(body, init)) as typeof fetch;
}

test("fetchDeploymentPolicy treats absence as no policy, silently", async (t) => {
  const warnings = captureWarnings(t);
  const url = "/deployment.json";
  assert.equal(
    await fetchDeploymentPolicy({
      url,
      fetchImpl: fakeFetch("", { status: 404 }),
    }),
    null,
  );
  assert.equal(
    await fetchDeploymentPolicy({
      url,
      fetchImpl: fakeFetch("<!doctype html><html></html>"),
    }),
    null,
  );
  const rejecting = (async () => {
    throw new TypeError("network");
  }) as typeof fetch;
  assert.equal(await fetchDeploymentPolicy({ url, fetchImpl: rejecting }), null);
  assert.deepEqual(warnings, []);
});

test("the shipped deployment.json stub is no policy, silently", (t) => {
  // public/deployment.json exists only so static hosts answer the startup fetch
  // with a 200 instead of logging a 404 (issue #2916). It must stay a no-op.
  const warnings = captureWarnings(t);
  const stub = readFileSync(
    new URL("../apps/geolibre-desktop/public/deployment.json", import.meta.url),
    "utf8",
  );
  assert.equal(parseDeploymentPolicy(stub), null);
  assert.deepEqual(warnings, []);
});

test("fetchDeploymentPolicy parses a served policy and marks the request optional", async () => {
  let seen: RequestInit | undefined;
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    seen = init;
    return new Response('{"version":1,"capabilities":["data:add"]}');
  }) as typeof fetch;
  const policy = await fetchDeploymentPolicy({
    url: "/deployment.json",
    fetchImpl,
  });
  assert.deepEqual(policy?.capabilities, ["data:add"]);
  assert.equal((seen?.headers as Record<string, string>)[OPTIONAL_RESOURCE_HEADER], "1");
  assert.equal(seen?.cache, "no-store");
});

test("fetchDeploymentPolicy ignores an unknown version with one warning", async (t) => {
  const warnings = captureWarnings(t);
  const policy = await fetchDeploymentPolicy({
    url: "/deployment.json",
    fetchImpl: fakeFetch('{"version":2}'),
  });
  assert.equal(policy, null);
  assert.equal(warnings.length, 1);
});

test("fetchDeploymentPolicy gives up on a hung request after the timeout", async () => {
  const hung = ((_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    })) as typeof fetch;
  const started = Date.now();
  assert.equal(
    await fetchDeploymentPolicy({
      url: "/d.json",
      fetchImpl: hung,
      timeoutMs: 20,
    }),
    null,
  );
  assert.ok(Date.now() - started < 2000);
});

test("loadDeploymentPolicy fetches once and installs the policy", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response('{"version":1,"branding":{"welcome":false}}');
  });
  try {
    const first = loadDeploymentPolicy();
    assert.equal(loadDeploymentPolicy(), first);
    assert.deepEqual((await first)?.branding, { welcome: false });
    assert.equal(calls, 1);
    assert.deepEqual(getDeploymentPolicy()?.branding, { welcome: false });
  } finally {
    setDeploymentPolicy(null);
  }
});

test("desktop config delivery is authoritative or falls back by read result", async (t) => {
  const cases = [
    {
      name: "valid BOM",
      text: '\uFEFF{"version":1,"capabilities":["data:add"]}',
      expected: { version: 1, capabilities: ["data:add"] },
      warnings: 0,
    },
    {
      name: "empty grants",
      text: '{"version":1,"capabilities":[]}',
      expected: { version: 1, capabilities: [] },
      warnings: 0,
    },
    {
      name: "interface replaces admin profile",
      text: '{"version":1,"interface":{"lock":true}}',
      expected: { version: 1, interface: { lock: true } },
      warnings: 0,
    },
    { name: "invalid JSON", text: "{", expected: null, warnings: 0 },
    { name: "empty file", text: "", expected: null, warnings: 0 },
    {
      name: "unknown version",
      text: '{"version":2}',
      expected: null,
      warnings: 1,
    },
    {
      name: "absent",
      text: null,
      expected: { version: 1, branding: { welcome: false } },
      warnings: 0,
    },
    {
      name: "absent everywhere",
      text: null,
      webAbsent: true,
      expected: null,
      warnings: 0,
    },
    {
      name: "read error",
      text: null,
      error: "Could not read deployment policy: denied",
      expected: { version: 1, branding: { welcome: false } },
      warnings: 1,
    },
  ];
  const globals = globalThis as unknown as { window?: unknown };
  const previousWindow = globals.window;
  try {
    for (const [index, scenario] of cases.entries()) {
      await t.test(scenario.name, async (t) => {
        const warnings = captureWarnings(t);
        let fetches = 0;
        globals.window = {
          __TAURI_INTERNALS__: {
            invoke: async (command: string) => {
              assert.equal(command, "read_deployment_policy");
              if (scenario.error) throw scenario.error;
              return scenario.text;
            },
          },
        };
        t.mock.method(globalThis, "fetch", async () => {
          fetches += 1;
          if (scenario.webAbsent) return new Response("", { status: 404 });
          return new Response('{"version":1,"branding":{"welcome":false}}');
        });
        // Each case exercises a fresh module's one-shot startup boundary;
        // a static import would reuse the previous case's cached promise.
        const { loadDeploymentPolicy: load } = await import(
          `../apps/geolibre-desktop/src/lib/deployment-policy.ts?desktop=${index}`
        );
        const pending = load();
        assert.equal(load(), pending);
        assert.deepEqual(await pending, scenario.expected);
        assert.deepEqual(getDeploymentPolicy(), scenario.expected);
        assert.equal(fetches, scenario.text === null ? 1 : 0);
        assert.equal(warnings.length, scenario.warnings);
        if (scenario.error) assert.match(warnings[0], /read_deployment_policy failed.*denied/);
        if (scenario.name === "interface replaces admin profile") {
          const profile = await loadAdminProfile([]);
          assert.equal(profile?.locked, true);
          assert.deepEqual(profile?.hiddenMenus, []);
          // The invoke stub rejects any admin-profile read; fetch stays unused.
          assert.equal(fetches, 0);
        }
      });
    }
  } finally {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
    setDeploymentPolicy(null);
  }
});

test("catalog id and name are stored trimmed", () => {
  const policy = resolveDeploymentPolicy({
    version: 1,
    services: {
      catalog: [
        {
          id: " city ",
          name: " City WMS ",
          kind: "wms",
          fields: { url: "https://e.example/wms" },
        },
      ],
    },
  });
  assert.equal(policy?.services?.catalog?.[0].id, "city");
  assert.equal(policy?.services?.catalog?.[0].name, "City WMS");
});
