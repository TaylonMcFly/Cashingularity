import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";

// Vite's local React refresh preamble is inline. Hash the generated development
// scripts rather than weakening the wallet policy with unsafe-inline or eval.
const developmentScriptHashes: Plugin = {
  name: 'wallet-development-script-hashes',
  transformIndexHtml: { order: 'post', handler(html, context) {
    if (!context.server) return html;
    const hashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
      .filter(match => match[1].trim())
      .map(match => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`);
    return html.replace("script-src 'self' 'wasm-unsafe-eval'", `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(' ')}`);
  } },
};

export default defineConfig({
  plugins: [react(), developmentScriptHashes],
  build: { target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
    },
  },
});
