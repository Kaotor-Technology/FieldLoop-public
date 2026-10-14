import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";

export default defineConfig(({ command }) => {
  const plugins = [react(), tailwindcss()];
  if (command !== "serve") return { plugins };

  const certPath = process.env["FIELDLOOP_DEV_TLS_CERT"];
  const keyPath = process.env["FIELDLOOP_DEV_TLS_KEY"];
  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new Error("Set both FIELDLOOP_DEV_TLS_CERT and FIELDLOOP_DEV_TLS_KEY for HTTPS development");
  }
  return {
    plugins,
    server: {
      port: 5173, strictPort: true,
      ...(certPath && keyPath ? { https: { cert: readFileSync(certPath), key: readFileSync(keyPath) } } : {}),
      proxy: {
        "/api": {
          target: process.env["FIELDLOOP_DEV_API_TARGET"] ?? "http://127.0.0.1:8080",
          // Opt in only for a local BFF using a self-signed certificate.
          secure: process.env["FIELDLOOP_DEV_API_INSECURE"] !== "true",
        },
      },
    },
  };
});
