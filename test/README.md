# Visual regression tests

Renders every animation in the list at the top of `test/index.js` frame by frame in headless
Chromium and compares the screenshots against a previous run.

```bash
npm install
npm run test:create     # render every frame using the committed build/player/lottie.min.js
npm run build           # rebuild the player from player/js
npm run test:compare    # render again and diff against the screenshots from test:create
```

That is also what CI runs, so a change in `player/js` that alters the rendered output of an
existing animation fails `test:compare`. Screenshots are written to `screenshots/create` and
`screenshots/compare` (ignored by git); frames differing by more than 200 pixels fail.

Both steps accept `-a` to work on a single animation, which is much faster while iterating:

```bash
node test/index.js -a banner
node test/index.js -s compare -a banner
```

A full run takes roughly 7 minutes per step.

## Determinism

Screenshots have to be reproducible across runs, so the page in `test/index.html`:

- seeds `Math.random` before the player loads — text animators with randomized order
  (`s.rn === 1`) call it while laying out text, which otherwise moves characters between runs;
- waits for the font manager to settle before capturing, since text is positioned from font
  measurements that resolve asynchronously;
- waits for fonts and a painted frame before reporting each frame.

Chromium is launched with hinting and subpixel text positioning disabled for the same reason,
and with `--no-sandbox`, which CI runners require.

## Failure handling

Every wait is bounded (see `timeouts` in `test/index.js`), a page error or a failed animation
load fails that animation immediately, and both steps exit non-zero if any animation fails —
including `test:create`, so a run that produces no screenshots cannot report success.
