// @ts-check
import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";

/**
 * Lint AND format in one tool, the way `arcnow-io/web` does it: the Nuxt preset
 * it uses folds @stylistic's formatting rules into ESLint rather than running a
 * separate formatter, so there is one command to run and one config to argue
 * with. `npm run lint:fix` is the formatter.
 */
export default tseslint.config(
  {
    // eslint.config.mjs itself is not in the TypeScript program, and type-aware
    // linting of the lint config is not a thing worth arranging.
    ignores: ["dist/**", "node_modules/**", "src/generated/**", "coverage/**", "eslint.config.mjs"],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@stylistic": stylistic },
    rules: {
      ...stylistic.configs.customize({
        indent: 2,
        quotes: "double",
        semi: true,
        arrowParens: true,
        braceStyle: "1tbs",
      }).rules,
      "@stylistic/max-len": ["error", { code: 100, ignoreUrls: true, ignoreStrings: true, ignoreTemplateLiterals: true, ignoreRegExpLiterals: true, ignoreComments: false }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowBoolean: true }],
      "no-console": "off",
    },
  },
  {
    // The examples and the harness talk to a terminal and to `docker`; the
    // library itself does neither.
    files: ["examples/**/*.ts", "test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
);
