import { defineConfig } from "vitest/config";

/**
 * The unit suite: everything that can be proved without a chain.
 *
 * Deliberately a separate config from `vitest.fork.config.ts` rather than a
 * tag or a filter. These tests are fast and unconditional; the fork tests pull
 * an image, start a container and talk to a public endpoint. One `vitest run`
 * that sometimes does both is a suite whose runtime nobody can predict and
 * whose skips nobody notices.
 */
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
  },
});
