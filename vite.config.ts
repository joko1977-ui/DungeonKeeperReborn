import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Relative base so the build works from a file:// bundle, a subdirectory on
// GitHub Pages, or the Tauri/Electron shells without reconfiguration.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
  server: { host: true, port: 5173 },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      manifest: {
        name: 'Dungeon Keeper Reborn',
        short_name: 'DK Reborn',
        description: 'Carve a dungeon, lure creatures, repel the heroes.',
        theme_color: '#0a0705',
        background_color: '#0a0705',
        display: 'fullscreen',
        orientation: 'landscape',
        start_url: './',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
    }),
  ],
});
