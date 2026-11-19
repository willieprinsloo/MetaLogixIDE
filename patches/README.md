# Dependency patches

Applied by pnpm on install (`patchedDependencies` in `pnpm-workspace.yaml`).

## `@xterm/addon-webgl@0.18.0`

One change, in `updateBackgrounds` of the minified `lib/addon-webgl.js`:

```
d=e.cells[c+o.RENDER_MODEL_BG_OFFSET]   ->   d=e.cells[c+o.RENDER_MODEL_BG_OFFSET]&67108863
```

The renderer draws a background rectangle for every cell whose background word is non-zero,
at full opacity. xterm keeps the italic, dim, overline and protected flags in that word, so
styled text on the default background got a rectangle in the theme background colour. Our theme
background is transparent (`rgba(0,0,0,0)`, for frosted glass), which came out as opaque black
behind italic or dim text. The mask (`0x03FFFFFF`) keeps only the colour mode and colour bits.

The diff is large because the file is a single minified line. 0.19.0 has the same code, so the
patch is still needed after an upgrade; re-create it with `pnpm patch @xterm/addon-webgl`.
Covered by `tests/e2e/terminal-styled-background.spec.ts`.
