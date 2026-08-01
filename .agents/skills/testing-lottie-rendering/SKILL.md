---
name: testing-lottie-rendering
description: How to verify lottie-web rendering changes end-to-end in a browser — serving animations with correct MIME types, building/comparing two player bundles for before/after evidence, and reaching the offset-path (`op`) / zig-zag (`zz`) shape modifiers that no bundled test animation uses.
---

# Testing lottie-web rendering changes

## Environment

- `npm install` can hang for 40+ minutes in puppeteer's post-install. Always use
  `PUPPETEER_SKIP_DOWNLOAD=true npm install` (~15s). The repo blueprint already exports this via `$ENVRC`.
- Unit tests use Node's built-in runner and need `--experimental-default-type=module`, which is already baked into
  `npm run test:unit` / `npm run test:unit:coverage`. Do not invoke `node --test` directly without that flag, and note
  that importing `player/js/**` source modules from an ad-hoc script fails with
  "Named export ... not found ... is a CommonJS module" unless you pass the same flag or use a `.mjs` file.
- `npm run build` (~40-60s) **rewrites the committed bundles under `build/player/**`**. Always finish with
  `git checkout -- build/` so the PR does not include rebuilt bundles, and re-check `git status`.

## Do not use the repo's puppeteer harness

`npm run test:create` / `npm run test:compare` hangs indefinitely and produces zero screenshots. Root causes: it
serves animation JSON with `Content-Type: text/html`, so lottie's XHR loader throws
`Failed to read the 'responseText' property...`; and it has no timeouts plus a lost-event race in its page bridge.
Serve the files yourself instead.

## Working browser setup

Simplest server that works: **`python3 -m http.server 8000` from the repo root** — Python's `mimetypes` maps
`.json` → `application/json` and `.js` → `text/javascript`, which lottie accepts (verified on Python 3.10).
A hand-written ~20-line Node static server also works; set `Content-Type: application/json` for `.json`,
`application/javascript` for `.js`, plus `Cache-Control: no-store`. Serving animation JSON as anything other
than JSON is the single most common cause of "animation silently doesn't load".

Then a viewer page that includes `/build/player/lottie.js` and calls
`lottie.loadAnimation({ container, path, renderer: 'svg'|'canvas', loop: true, autoplay: true })`. Useful additions:

- Render the same animation in **both** `svg` and `canvas` — renderer-specific breakage is common.
- Expose `window.gotoFrame = f => anims.forEach(a => a.goToAndStop(f, true))` so you can pause every player on a
  deterministic frame for pixel comparison. Comparing live/animating frames is worthless.
- Count `window.onerror` events and listen for each animation's `data_failed` event, and print both on the page so a
  screenshot proves "0 errors" rather than you asserting it.
- For SVG, `document.querySelectorAll('svg path')` + `getAttribute('d')` gives exact geometry, which is far more
  precise than eyeballing. Reporting `max abs(coordinate)` parsed out of `d` is a good numeric assertion.

## Before/after comparison: pre-build both bundles

Do **not** rebuild between captures while recording — it wastes ~1 minute of video and risks stale caches. Instead:

1. Build the branch as-is, `cp build/player/lottie.js scratch/lottie-fixed.js`.
2. Temporarily edit the source, `npm run build`, `cp build/player/lottie.js scratch/lottie-unfixed.js`,
   then `git checkout -- <file>` and rebuild.
3. Have the viewer pick the bundle from a `?build=fixed|unfixed` query param and display a big colour-coded
   on-page badge naming the build. Switching is then instant and self-evidencing on video.

If you must use a *committed* viewer page that hard-codes `build/player/lottie.js` (so no `?build=` param exists),
switch states by copying a pre-built bundle over `build/player/lottie.js` and hard-reloading — still instant, and it
keeps the page under test unmodified. The screenshots then carry no build label, so make the before/after
self-evidencing afterwards by compositing the two crops side by side with captioned colour bands (PIL:
`ImageDraw.rectangle` + `truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')`), quoting the on-page
numeric readout in each caption.

If the change under test is a *committed* commit on the branch (not a working-tree change), `git stash push <file>`
is a **no-op** ("No local changes to save"). Patch the file directly and restore with `git checkout -- <file>`.

Verify each bundle really differs, e.g. `grep -c "<changed expression>" build/player/lottie.js`, before trusting a
capture. Use `ctrl+shift+r` to hard-reload.

## Reaching shape modifiers (`op` offset path, `zz` zig-zag)

- Modifiers are registered in `player/js/modules/full.js`: `tm` trim, `pb` pucker/bloat, `rp` repeater,
  `rd` round corners, `zz` zig-zag, `op` offset path.
- **No animation in `test/animations/` or `demo/` uses `op` or `zz`** (grep for `"ty":"op"` / `"ty":"zz"` — zero hits).
  To test these you must author a minimal lottie JSON: a shape layer (`ty:4`) with
  `shapes:[{ty:'gr', it:[ {ty:'sh', ks:{a:0,k:{v,i,o,c}}}, {ty:'op', a:{a:0,k:<amount>}, lj:1, ml:{a:0,k:4}},
  {ty:'st',...}, {ty:'tr',...} ]}]`. `OffsetPathModifier.processShapes` early-returns when `amount === 0`, so use a
  non-zero amount.
- Render offset/zig-zag test shapes **stroke-only** (drop the `fl` item). With a fill, wildly different
  self-intersecting geometry can rasterise to a nearly identical filled region and hide the difference.
- In shape JSON, `o[k]` and `i[k]` are offsets **relative to** `v[k]`; `i[k]` belongs to the curve *arriving* at
  `v[k]`. `PolynomialBezier.shapeSegment(path, k)` builds `(v[k], v[k]+o[k], v[k+1]+i[k+1], v[k+1])`.

## Float32 gotcha when testing geometry/bezier math

`ShapePath` stores vertices in `Float32Array`. Any code path guarded by an exact test such as `a === 0` (e.g. the
degenerate-linear case in `quadRoots`, cubic coefficient `-p0+3p1-3p2+p3`) is therefore only reachable when the
control points are symmetric *and* float32-exact. A shape built from `Math.cos`/`Math.sin` will hit the branch in a
float64 Node harness but render identically in the browser. **Use integer coordinates** for such shapes.

Efficient way to find a shape that exercises a geometry change: copy the module under test twice (old and new
behaviour), reimplement the pure consumer pipeline (for offset path: `linearOffset` → `offsetSegment` →
`offsetSegmentSplit` → `pruneIntersections`, all copy-pasteable from `OffsetPathModifier.js`) against each copy,
apply `Math.fround` to the input shape to mimic `Float32Array`, and brute-force random integer shapes until the two
outputs diverge. Sort candidates by max coordinate deviation and take the largest — that gives the most visually
obvious before/after.

## Regression baseline

`bodymovin`, `bm_ronda`, `dalek`, `ripple`, `starfish`, `monster` from `test/animations/` are good quick smoke
animations. Pause them all at a fixed frame and compare screenshots between builds with PIL/`ImageChops.difference`.
Note `starfish` is legitimately blank at frame 20 — its content starts later, so pick a later frame if you want it
visible.

**Do not expect bit-identical screenshots, and always measure a same-build noise baseline first.** Several of these
animations are *not* deterministic at a given frame across page loads: reloading the **same** bundle and calling
`goToAndStop(20, true)` changes the emitted SVG geometry (observed `bm_ronda` `d`-length 267284 vs 266220, `monster`
317325 vs 309405 on identical builds). Consequently a same-build screenshot pair already differs by ~16-52 px out of
~1.28M, and a cross-build pair by ~37-89 px — the ranges overlap, so a small non-zero diff proves nothing.

Procedure that yields a defensible verdict:

1. Capture the same build twice (two page loads) and diff → that is your noise envelope.
2. Only treat a cross-build diff as real if it is clearly outside that envelope, and localise it per animation cell.
3. For an exact signal, hash the concatenated `d` attributes per animation and **take at least two samples per
   build** — a single sample will mislead you (one `dalek` sample differed across builds and looked like a real
   regression; a second sample on the same build reproduced the "other" hash, showing it was measurement noise).
4. `ripple`, `starfish` and `dalek` (svg) do hash-stabilise across reloads, so they give a clean byte-identical
   cross-build comparison — lean on those rather than on `bm_ronda`/`monster`/`bodymovin`.
5. Sanity-check reachability before chasing a diff: if no test animation contains `"ty":"op"`/`"ty":"zz"` and the
   changed module is only imported by `OffsetPathModifier.js`/`ZigZagModifier.js`, the changed code cannot be on the
   stock animations' path at all.

## Committed repro assets (added on the PolynomialBezier branch)

`test/animations/offset-selfintersect.json` + `test/unit/repro/offset-selfintersect.html` + `test/unit/README.md`
provide a ready-made `op` offset-path repro; prefer them over authoring a new fixture. The page renders svg and
canvas side by side and prints `max abs svg coordinate` and a `window.onerror` count.

**Coordinate-space gotcha:** the page's `maxAbsCoordinate()` reads the raw `d` attribute, which is in **layer
space**, while the layer is positioned by `ks.p = [150,150]` via an enclosing `matrix(1,0,0,1,150,150)`. So the
printed number is 150 less than the composition-space value (fixed state prints **114.9**, not the ~265 the README
table claims; the unfixed ~2266 figure is layer-space and does match). If a documented expected value is off by
exactly the layer offset, suspect this rather than a rendering failure. Always walk up the parent `transform`
attributes before interpreting a coordinate readout.

## Devin Secrets Needed

None — everything runs locally with no credentials.
