import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readControlPreference,
  writeControlPreference,
} from "../apps/geolibre-desktop/src/lib/control-preferences";

test("control choices survive reads, preserve other choices, and tolerate unavailable storage", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let stored: string | null = null;
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => stored,
        setItem: (_key: string, value: string) => {
          stored = value;
        },
      },
    });
    assert.equal(readControlPreference("geolocate", false), false);
    writeControlPreference("geolocate", true);
    writeControlPreference("field-collection", true);
    assert.equal(readControlPreference("geolocate", false), true);
    writeControlPreference("field-collection", false);
    assert.equal(readControlPreference("field-collection", true), false);
    stored = '{"geolocate":"true"}';
    assert.equal(readControlPreference("geolocate", false), false);
    stored = "broken";
    assert.equal(readControlPreference("geolocate", true), true);
    writeControlPreference("geolocate", true);
    assert.equal(readControlPreference("geolocate", false), true);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    assert.equal(readControlPreference("geolocate", true), true);
    assert.doesNotThrow(() => writeControlPreference("geolocate", false));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
