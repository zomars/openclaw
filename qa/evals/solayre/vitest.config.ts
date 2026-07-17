import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.eval.ts", "**/*.test.ts"],
    watch: false,
  },
});
