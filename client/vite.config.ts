import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5175, // 5174 belongs to the chameleon project
    host: true,
  },
  optimizeDeps: {
    // Workspace package shipped as raw TS source — must not be pre-bundled.
    exclude: ["@bringme/shared"],
  },
});
