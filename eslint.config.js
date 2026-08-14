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
import baseConfig from "@zacaj/eslint-config-base";
import tseslint from "typescript-eslint";

// /** @type { import("eslint").Linter.Config[] } */
export default defineConfig(
  {
    ignores: [`**/.template*/`, `db/`, `build/`, `.*/`, `playwright-report/`, `test-results/`],
  },
  baseConfig,
  {
    files: [`src/injected.js`],
    ...tseslint.configs.disableTypeChecked,
  },
);
