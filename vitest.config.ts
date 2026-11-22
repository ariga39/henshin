import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["apps/server/test/**/*.test.ts"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    pool: "forks"
  }
})
