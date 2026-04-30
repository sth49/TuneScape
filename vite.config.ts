import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  // Anonymous GitHub mirror path. If the anon ID is regenerated, update
  // this and rebuild.
  base: "/w/TuneScape-9380/",
  plugins: [react(), tailwindcss()],
});
