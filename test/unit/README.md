# Unit tests

Pure modules under `player/js` are tested with Node's built-in test runner, so there is no test
framework dependency. Requires **Node >= 20.10** (`--experimental-default-type=module` is what lets the
runner load `player/js/**/*.js` as ES modules; the root `package.json` has no `"type"` field).

```
npm run test:unit            # run the suite
npm run test:unit:coverage   # same, with Node's experimental coverage report
npx eslint test/unit/        # lint the tests
```

Run in CI by `.github/workflows/unitTests.yml`, separately from the puppeteer animation workflow.

## Reproducing the offset-path defect

`test/animations/offset-selfintersect.json` is the smallest animation that shows the rendering bug the
`quadRoots` fix addresses. Its path handles make the cubic coefficient of both axes exactly zero
(`-p0 + 3p1 - 3p2 + p3 === 0`), which is the degenerate-linear case in the extrema search. The
coordinates are integers on purpose: `ShapePath` stores vertices in a `Float32Array`, so the branch is
only reached when the geometry is float32-exact. The animation is deliberately positioned via the layer
transform rather than baked into the path, because `floatEqual` is a *relative* comparison and
translating the raw control points changes which comparisons trip.

```
npm run build                                # produces build/player/lottie.js
python3 -m http.server 8000                  # from the repo root; serves .json as application/json
# open http://localhost:8000/test/unit/repro/offset-selfintersect.html
```

The page renders the animation in both the `svg` and `canvas` renderers, and prints the largest absolute
coordinate found in the rendered SVG path data. That figure is in layer space: the layer is placed into
the frame by an enclosing `matrix(1,0,0,1,150,150)`, so add 150 to compare it against the viewport.

| `quadRoots` | max abs SVG coordinate | appearance |
| --- | --- | --- |
| fixed (current) | ~115 | bounded closed loop inside the 300x300 frame |
| degenerate case removed | ~2266 | offset path shoots far outside the frame |

To see the broken state, revert only the `a === 0` branch of `quadRoots` in
`player/js/utils/PolynomialBezier.js` to `if (a === 0) return [];`, re-run `npm run build`, and reload.
`npm run test:unit` fails at the same time, on `boundingBox() covers extrema that lie between the
endpoints` and `intersections() finds crossings of a curve whose handles are symmetric`.

Any static server works as long as it sends `Content-Type: application/json` for `.json`; the repo's own
puppeteer harness in `test/index.js` sends `text/html`, which makes lottie's XHR loader throw.
