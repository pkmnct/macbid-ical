import eslint from "@eslint/js";
import promisePlugin from "eslint-plugin-promise";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/*.js", "**/*.d.ts", "node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      promise: promisePlugin,
    },
    rules: {
      ...promisePlugin.configs.recommended.rules,
    },
  }
);
