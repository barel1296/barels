import { defineConfig } from 'vitest/config';

// `vite build --mode artifact` produces a build that loads three.js from a CDN through an
// import map (used for hosting where only the game's own code is published alongside it).
export default defineConfig(({ mode }) => ({
  // Relative base so the build works from any sub-path (GitHub Pages, static hosts, file servers).
  base: './',
  build:
    mode === 'artifact'
      ? {
          outDir: 'dist-artifact',
          target: 'es2022',
          chunkSizeWarningLimit: 1500,
          rollupOptions: { external: ['three', /^three\/examples\//] },
        }
      : {
          target: 'es2022',
          chunkSizeWarningLimit: 1500,
          rollupOptions: {
            output: {
              manualChunks: { three: ['three'] },
            },
          },
        },
  worker: { format: 'es' },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
}));
