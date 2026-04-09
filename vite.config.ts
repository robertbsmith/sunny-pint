import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Sunny Pint",
        short_name: "Sunny Pint",
        description: "Find sunny beer garden seats",
        theme_color: "#F59E0B",
        background_color: "#1A1A1A",
        display: "standalone",
        orientation: "portrait",
        categories: ["food", "lifestyle", "utilities"],
        icons: [
          { src: "/icon-192-v2.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512-v2.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512-v2.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,woff2}"],
        runtimeCaching: [
          {
            // Cache map tiles
            urlPattern: /^https:\/\/.*\.fastly\.net\//,
            handler: "CacheFirst",
            options: {
              cacheName: "map-tiles",
              expiration: { maxEntries: 500, maxAgeSeconds: 7 * 24 * 60 * 60 },
            },
          },
          {
            // Cache building vector tiles. NetworkFirst (not CacheFirst) so a
            // new pipeline run is picked up on the next visit instead of being
            // pinned to a stale tile for 30 days.
            urlPattern: /\/data\/tiles\/.+\.pbf$/,
            handler: "NetworkFirst",
            options: {
              cacheName: "building-tiles-v2",
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 500, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
          {
            // Cache Armoria coat of arms SVGs
            urlPattern: /armoria\.herokuapp\.com/,
            handler: "CacheFirst",
            options: {
              cacheName: "armoria",
              expiration: { maxEntries: 200, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
          {
            // Cache weather API (short TTL)
            urlPattern: /api\.open-meteo\.com/,
            handler: "NetworkFirst",
            options: {
              cacheName: "weather",
              expiration: { maxEntries: 10, maxAgeSeconds: 10 * 60 },
            },
          },
          {
            // Cache pub data. NetworkFirst so pubs.json updates show up on
            // the next visit; falls back to cache offline.
            urlPattern: /\/data\/.+\.json$/,
            handler: "NetworkFirst",
            options: {
              cacheName: "app-data-v2",
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 10, maxAgeSeconds: 7 * 24 * 60 * 60 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string): string | undefined {
          // Split heavy opening_hours.js + i18next into a separate chunk so
          // the main bundle stays small.
          if (id.includes("opening_hours") || id.includes("i18next")) {
            return "opening-hours";
          }
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
