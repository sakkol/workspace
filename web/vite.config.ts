import { defineConfig } from "vite";

// base "./" makes the build work under the GitHub Pages project path (/workspace/).
export default defineConfig({
  base: "./",
  plugins: [
    {
      // In `vite dev` only: drop the strict CSP <meta> so hot reload (websocket + inline helpers) works.
      // The production build keeps the CSP.
      name: "dev-no-csp",
      apply: "serve",
      transformIndexHtml: (html) => html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ""),
    },
  ],
});
