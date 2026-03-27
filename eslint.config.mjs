import js from "@eslint/js";
import tsParser from "typescript-eslint";
import prettierPlugin from "eslint-plugin-prettier";
import unusedImportsPlugin from "eslint-plugin-unused-imports";
import sonarjsPlugin from "eslint-plugin-sonarjs";

export default [
  js.configs.recommended,
  ...tsParser.configs.recommended,
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**", "jest.config.ts"],
  },
  {
    files: ["**/*.ts"],
    plugins: {
      prettier: prettierPlugin,
      "unused-imports": unusedImportsPlugin,
      sonarjs: sonarjsPlugin,
    },
    rules: {
      "prettier/prettier": "error",
      "unused-imports/no-unused-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "sonarjs/no-duplicate-string": "off",
    },
  },
];
