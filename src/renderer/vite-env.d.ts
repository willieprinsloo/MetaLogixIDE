/// <reference types="vite/client" />

// Vite's `?url` suffix turns any import into a stable asset URL at build
// time. pdfjs uses it for its worker (`pdf.worker.min.mjs?url`).
declare module '*?url' {
  const url: string;
  export default url;
}
