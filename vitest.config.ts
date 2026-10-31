import { defineConfig } from "vitest/config";

// Tests run in Node against the Firestore emulator (npm test starts it).
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], environment: "node", testTimeout: 20000, fileParallelism: false },
});
