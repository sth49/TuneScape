import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  // Repo is served from https://sth49.github.io/Tuner-Comparison/, so all
  // built asset URLs must be prefixed with the repo name.
  base: "/Tuner-Comparison/",
  plugins: [react(), tailwindcss()],
});
