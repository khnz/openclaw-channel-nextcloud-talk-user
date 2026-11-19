import { defineConfig } from "vitest/config";

// All test files run. Test helpers missing from the published "openclaw" package
// (createPluginRuntimeMock, createRuntimeSpies, withServer, withTempDir) live as lean
// rebuilds in test-support/. Tests that need the host's durable reply delivery are skipped
// with a reason in inbound.behavior.test.ts.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "arbeit/**"],
  },
});
