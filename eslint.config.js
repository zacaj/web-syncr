/*{
  "parser": "@typescript-eslint/parser",
  "parserOptions": {
    "project": "./tsconfig.json"
  },
  "plugins": ["@typescript-eslint"],
  "extends": [
    "plugin:solid/typescript",
    "plugin:@typescript-eslint/recommended"
  ],
  "rules": {
    "@typescript-eslint/consistent-type-imports": "warn"
  }
}
*/

import { defineConfig } from "eslint/config";
import baseConfig from "./common/eslint/base.config.js";
import formatConfig from "./common/eslint/format.config.js";
// import reactConfig from "./common/eslint/react.config.js";
import tsConfig from "./common/eslint/typescript.config.js";

// /** @type { import("eslint").Linter.Config[] } */
export default defineConfig(
  {
    ignores: [`**/.template*/`],
  },
  baseConfig,
  tsConfig,
  formatConfig,
)
