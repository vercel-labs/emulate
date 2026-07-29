import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// The root config ignores examples/**, and this example is plain Node + TypeScript
// rather than a Next.js app, so it carries its own mirror of the root rules.
export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**"],
  },
  tseslint.configs.recommended,
  prettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
