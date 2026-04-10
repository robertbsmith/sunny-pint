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
        // Take control immediately so the new SW serves landing pages on the
        // very next page load — no second visit needed for the SEO content.
        skipWaiting: true,
        clientsClaim: true,
        // Drop outdated precache entries when the new SW activates.
        // Without this, old asset hashes linger in the SW cache after a
        // deploy, and returning users hit "Refused to apply style: MIME
        // text/html" errors when the old hash 404s and the SPA fallback
        // returns HTML in its place.
        cleanupOutdatedCaches: true,
        // Don't precache HTML — the static landing pages we generate
        // (/norwich/index.html etc.) and the per-pub Pages Function (PR #2)
        // are network-first via runtimeCaching, not precached. Precaching
        // ~33k pub pages would also blow the SW cache budget at full UK.
        globPatterns: ["**/*.{js,css,png,svg,woff2}"],
        // No SPA fallback — every URL we serve is a real document (static
        // file or Function-rendered), so navigation requests go straight to
        // the network-first handler below.
        navigateFallback: null,
        runtimeCaching: [
          {
            // HTML navigation requests — NetworkFirst so SEO content updates
            // reach returning users immediately, with cache fallback offline.
            urlPattern: ({ request }) => request.mode === "navigate",
            handler: "NetworkFirst",
            options: {
              cacheName: "pages-v3",
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 50, maxAgeSeconds: 7 * 24 * 60 * 60 },
            },
          },
          {
            // Cache Mapbox raster tiles (streets + satellite)
            urlPattern: /^https:\/\/api\.mapbox\.com\//,
            handler: "CacheFirst",
            options: {
              cacheName: "map-tiles",
              expiration: { maxEntries: 1000, maxAgeSeconds: 7 * 24 * 60 * 60 },
            },
          },
          {
            // Cache building tiles — PMTiles range requests on R2, or
            // individual .pbf files in local dev.
            urlPattern: /\.(pmtiles|pbf)$/,
            handler: "NetworkFirst",
            options: {
              cacheName: "building-tiles-v2",
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 500, maxAgeSeconds: 30 * 24 * 60 * 60 },
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
              cacheName: "app-data-v3",
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
