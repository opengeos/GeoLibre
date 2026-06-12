import "i18next";

import type en from "./locales/en.json";

// Type the `t()` keys against the English catalog so missing/misspelled keys are
// compile errors. `en.json` is the source of truth; other locales may be partial
// and fall back to it at runtime.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: typeof en;
    };
  }
}
