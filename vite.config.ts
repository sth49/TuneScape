import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  // Use relative asset URLs ("./assets/..." etc.) so the build works under
  // any subpath: GitHub Pages (/TuneScape/), Anonymous GitHub
  // (/w/TuneScape-XXXX/), local file://, etc.
  base: "./",
  plugins: [react(), tailwindcss()],
});
