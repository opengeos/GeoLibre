// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

import { createConfig } from "../../shared/rollup.config.js";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import terser from "@rollup/plugin-terser";

export default createConfig({
  additionalConfigs: {
    input: "guest-js/init.ts",
    output: {
      file: "src/init-iife.js",
      format: "iife",
    },
    plugins: [typescript(), terser(), nodeResolve()],
    onwarn: (warning) => {
      throw Object.assign(new Error(), warning);
    },
  },
});
