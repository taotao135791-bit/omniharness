{
  "root": true,
  "env": { "node": true, "es2023": true },
  "parser": "@typescript-eslint/parser",
  "parserOptions": { "sourceType": "module", "ecmaVersion": 2023 },
  "plugins": ["@typescript-eslint"],
  "extends": ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  "ignorePatterns": ["dist/", "out/", "release/", "node_modules/", "coverage/", "apps/desktop/dist-electron/"],
  "rules": {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }],
    "@typescript-eslint/consistent-type-imports": ["error", { "prefer": "type-imports" }],
    "no-console": "off"
  },
  "overrides": [
    {
      "files": ["**/*.test.ts", "**/test/**"],
      "rules": { "@typescript-eslint/no-non-null-assertion": "off" }
    }
  ]
}
