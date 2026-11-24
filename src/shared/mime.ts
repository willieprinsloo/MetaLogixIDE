/**
 * Extension → MIME lookup for raw file serving. Shared by the
 * `files:read-bytes` IPC (image + PDF viewers) and the `metafile://`
 * protocol (rendered HTML preview). Keys are lowercase extensions.
 */
export const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tif: 'image/tiff', tiff: 'image/tiff',
  // Rendered-HTML support: the page itself plus the relative assets a
  // sandboxed iframe loads from the same project root.
  html: 'text/html', htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json',
  woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf',
  txt: 'text/plain',
  xml: 'application/xml',
};
