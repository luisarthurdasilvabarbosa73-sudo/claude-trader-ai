import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./", // funciona no endereço do GitHub Pages (/claude-trader-ai/)
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, assetsDir: "assets" },
});
