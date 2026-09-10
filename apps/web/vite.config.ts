import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "HideSeek Atlas",
        short_name: "HideSeek",
        description: "A shared investigation map for real-world Hide + Seek games.",
        theme_color: "#0d1514",
        background_color: "#0d1514",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        icons: [
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin === "https://tile.openstreetmap.org",
            handler: "CacheFirst",
            options: {
              cacheName: "osm-map-tiles",
              expiration: { maxEntries: 180, maxAgeSeconds: 86400 * 7 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/socket.io": { target: "ws://localhost:3000", ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
