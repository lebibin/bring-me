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
  build: {
    rollupOptions: {
      output: {
        // three.js dwarfs the bundle and changes ~never between deploys —
        // in its own immutable-cached chunk, repeat visitors re-download
        // only the game code after a deploy
        manualChunks: { three: ["three"] },
      },
    },
  },
});
