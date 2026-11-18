import { defineConfig } from "vitest/config";

// Several tests run real git (repos in a temp folder); git is slow on Windows.
export default defineConfig({ test: { testTimeout: 60_000 } });
