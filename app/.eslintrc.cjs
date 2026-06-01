module.exports = {
  root: true,
  env: { browser: true, es2021: true },
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended", "plugin:react-hooks/recommended"],
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  ignorePatterns: ["dist", ".eslintrc.cjs", "amplify/**/amplify_outputs*"],
  rules: {},
  overrides: [
    {
      // Tests legitimately reach into library internals / mock shapes; allow `any` there.
      files: ["tests/**/*.ts", "tests/**/*.tsx", "src/test/**/*.ts"],
      rules: { "@typescript-eslint/no-explicit-any": "off" },
    },
  ],
};
