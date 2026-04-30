import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  // Relative paths so the built bundle works under any subpath
  // (e.g., Anonymous GitHub /w/TuneScape-XXXX/dist/, GitHub Pages, etc.)
  base: "./",
  plugins: [react(), tailwindcss()],
});
