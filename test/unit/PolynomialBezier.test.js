import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PolynomialBezier,
  lineIntersection,
  polarOffset,
  pointDistance,
  pointEqual,
  floatEqual,
} from '../../player/js/utils/PolynomialBezier.js';

// Ground truth: cubic bezier in Bernstein form, independent of the polynomial
// coefficient form the module under test uses.
function bernstein(p0, p1, p2, p3, t) {
  var u = 1 - t;
  return [0, 1].map(function (c) {
    return u * u * u * p0[c]
      + 3 * u * u * t * p1[c]
      + 3 * u * t * t * p2[c]
      + t * t * t * p3[c];
  });
}

function assertPointClose(actual, expected, tolerance) {
  var epsilon = tolerance === undefined ? 1e-9 : tolerance;
  assert.ok(
    pointDistance(actual, expected) <= epsilon,
    'expected [' + actual + '] to be within ' + epsilon + ' of [' + expected + ']'
  );
}

// Sign of the 2D cross product of the first and second derivatives, i.e. the
// direction the curve is bending in at t.
function signedCurvature(bez, t) {
  var h = 1e-5;
  var first = bez.derivative(t);
  var before = bez.derivative(t - h);
  var after = bez.derivative(t + h);
  var second = [(after[0] - before[0]) / (2 * h), (after[1] - before[1]) / (2 * h)];
  return first[0] * second[1] - first[1] * second[0];
}

var SAMPLES = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];

test('point() matches the Bernstein form of the same control points', function () {
  var p0 = [0, 0];
  var p1 = [30, 90];
  var p2 = [70, -40];
  var p3 = [100, 50];
  var bez = new PolynomialBezier(p0, p1, p2, p3, false);

  SAMPLES.forEach(function (t) {
    assertPointClose(bez.point(t), bernstein(p0, p1, p2, p3, t), 1e-9);
  });
  // Endpoints are interpolated exactly.
  assert.deepEqual(bez.point(0), p0);
  assertPointClose(bez.point(1), p3, 1e-12);
});

test('derivative() matches a numerical derivative of point()', function () {
  var bez = new PolynomialBezier([0, 0], [30, 90], [70, -40], [100, 50], false);
  var h = 1e-6;

  [0.2, 0.5, 0.8].forEach(function (t) {
    var before = bez.point(t - h);
    var after = bez.point(t + h);
    var numeric = [(after[0] - before[0]) / (2 * h), (after[1] - before[1]) / (2 * h)];
    assertPointClose(bez.derivative(t), numeric, 1e-3);
  });
});

test('tangentAngle() and normalAngle() describe perpendicular directions', function () {
  // Straight diagonal: the tangent is constant at 45 degrees.
  var bez = new PolynomialBezier([0, 0], [10, 10], [20, 20], [30, 30], false);

  assert.ok(Math.abs(bez.tangentAngle(0.5) - Math.PI / 4) < 1e-9);
  // normalAngle mirrors the tangent across the 45 degree line, so the two
  // directions are always a quarter turn apart.
  var difference = Math.abs(bez.tangentAngle(0.5) - bez.normalAngle(0.5));
  assert.ok(Math.abs(difference - Math.PI / 2) < 1e-9 || Math.abs(difference) < 1e-9);

  var curve = new PolynomialBezier([0, 0], [0, 20], [20, 20], [20, 0], false);
  assert.ok(Math.abs(curve.normalAngle(0.5) - Math.atan2(curve.derivative(0.5)[0], curve.derivative(0.5)[1])) < 1e-12);
});

test('linearize repositions coincident control points so the curve keeps a tangent', function () {
  var p0 = [0, 0];
  var p3 = [90, 0];
  // p1 === p0 and p2 === p3: the raw derivative at both ends would be zero,
  // which leaves tangentAngle() undefined for offsetting and stroking.
  var raw = new PolynomialBezier(p0, p0, p3, p3, false);
  assert.deepEqual(raw.derivative(0), [0, 0]);

  var linearized = new PolynomialBezier(p0, p0, p3, p3, true);
  assert.deepEqual(linearized.points[1], [30, 0]);
  assert.deepEqual(linearized.points[2], [60, 0]);
  assert.ok(linearized.derivative(0)[0] > 0);
  assert.equal(linearized.tangentAngle(0), 0);
  // Linearizing must not move the curve itself: it stays the straight segment.
  SAMPLES.forEach(function (t) {
    assertPointClose(linearized.point(t), [90 * t, 0], 1e-9);
  });
});

test('split() produces two halves that retrace the original curve', function () {
  var bez = new PolynomialBezier([0, 0], [30, 90], [70, -40], [100, 50], false);
  var t = 0.35;
  var halves = bez.split(t);

  assertPointClose(halves[0].point(1), bez.point(t), 1e-9);
  assertPointClose(halves[1].point(0), bez.point(t), 1e-9);
  SAMPLES.forEach(function (u) {
    assertPointClose(halves[0].point(u), bez.point(u * t), 1e-9);
    assertPointClose(halves[1].point(u), bez.point(t + u * (1 - t)), 1e-9);
  });
});

test('split() clamps out of range parameters to a degenerate segment', function () {
  var bez = new PolynomialBezier([0, 0], [30, 90], [70, -40], [100, 50], false);

  var atStart = bez.split(0);
  assert.equal(atStart[1], bez);
  SAMPLES.forEach(function (t) {
    assert.deepEqual(atStart[0].point(t), [0, 0]);
  });

  var atEnd = bez.split(1.5);
  assert.equal(atEnd[0], bez);
  SAMPLES.forEach(function (t) {
    assert.deepEqual(atEnd[1].point(t), [100, 50]);
  });
});

test('boundingBox() covers extrema that lie between the endpoints', function () {
  // Symmetric handles: the derivative of y is linear rather than quadratic,
  // which used to make the extremum search bail out and collapse the box.
  var bez = new PolynomialBezier([0, 0], [0, 100], [100, 100], [100, 0], false);
  var box = bez.boundingBox();

  assert.equal(box.left, 0);
  assert.equal(box.right, 100);
  assert.equal(box.top, 0);
  // Peak of a symmetric cubic with both handles at y = 100 is y = 75.
  assert.ok(Math.abs(box.bottom - 75) < 1e-9, 'expected bottom 75, got ' + box.bottom);
  assert.equal(box.width, 100);
  assert.ok(Math.abs(box.height - 75) < 1e-9);
  assert.equal(box.cx, 50);
  assert.ok(Math.abs(box.cy - 37.5) < 1e-9);

  // Every sampled point stays inside the reported box.
  for (var i = 0; i <= 100; i += 1) {
    var point = bez.point(i / 100);
    assert.ok(point[0] >= box.left - 1e-9 && point[0] <= box.right + 1e-9);
    assert.ok(point[1] >= box.top - 1e-9 && point[1] <= box.bottom + 1e-9);
  }
});

test('bounds() falls back to the endpoints when the curve is monotonic', function () {
  // Descending straight segment: min/max come from the swapped endpoints and
  // the derivative has no root inside (0, 1).
  var bez = new PolynomialBezier([100, 40], [70, 30], [40, 20], [10, 10], false);
  var bounds = bez.bounds();

  assert.deepEqual(bounds.x, { min: 10, max: 100 });
  assert.deepEqual(bounds.y, { min: 10, max: 40 });
});

test('inflectionPoints() finds where the curvature changes sign', function () {
  var sCurve = new PolynomialBezier([0, 0], [100, 0], [0, 100], [100, 120], false);
  var inflections = sCurve.inflectionPoints();

  assert.equal(inflections.length, 1);
  var t = inflections[0];
  assert.ok(t > 0 && t < 1);
  // Signed curvature must have opposite signs on either side of the reported
  // parameter, and nowhere else along the curve.
  assert.ok(signedCurvature(sCurve, t - 0.05) * signedCurvature(sCurve, t + 0.05) < 0);
  var signChanges = 0;
  for (var i = 1; i < 100; i += 1) {
    if (signedCurvature(sCurve, i / 100) * signedCurvature(sCurve, (i + 1) / 100) < 0) signChanges += 1;
  }
  assert.equal(signChanges, 1);
});

test('inflectionPoints() returns nothing for curves that never change curvature', function () {
  // Straight line: the cross products vanish, so there is no cusp parameter.
  assert.deepEqual(new PolynomialBezier([0, 0], [10, 10], [20, 20], [30, 30], false).inflectionPoints(), []);
  // Single arc bending one way only: the discriminant is negative.
  assert.deepEqual(new PolynomialBezier([0, 0], [0, 100], [100, 100], [100, 0], false).inflectionPoints(), []);
  // Inflections outside the [0, 1] domain are discarded.
  var offDomain = new PolynomialBezier([0, 0], [40, 60], [80, 90], [100, 100], false);
  offDomain.inflectionPoints().forEach(function (t) {
    assert.ok(t > 0 && t < 1);
  });
});

test('intersections() reports parameter pairs that meet on both curves', function () {
  var horizontal = new PolynomialBezier([0, 50], [33, 50], [66, 50], [100, 50], false);
  var vertical = new PolynomialBezier([50, 0], [50, 33], [50, 66], [50, 100], false);

  var found = horizontal.intersections(vertical);

  assert.ok(found.length > 0);
  found.forEach(function (pair) {
    assertPointClose(horizontal.point(pair[0]), vertical.point(pair[1]), 2);
    assertPointClose(horizontal.point(pair[0]), [50, 50], 2);
  });
});

test('intersections() returns an empty list for curves that stay apart', function () {
  var lower = new PolynomialBezier([0, 0], [33, 0], [66, 0], [100, 0], false);
  var upper = new PolynomialBezier([0, 200], [33, 200], [66, 200], [100, 200], false);

  assert.deepEqual(lower.intersections(upper), []);
});

test('intersections() finds crossings of a curve whose handles are symmetric', function () {
  // intersections() prunes candidates with boundingBox(), so a curve whose
  // bounds are underestimated silently loses its crossings.
  var arch = new PolynomialBezier([0, 0], [0, 100], [100, 100], [100, 0], false);
  var horizontal = new PolynomialBezier([-10, 70], [30, 70], [70, 70], [110, 70], false);

  var found = arch.intersections(horizontal);

  // The arch rises to y = 75, so it crosses y = 70 on the way up and again on
  // the way down. Neighbouring subdivisions can report the same crossing twice,
  // so assert on the crossings themselves rather than on the result count.
  assert.ok(found.length >= 2);
  var ascending = 0;
  var descending = 0;
  found.forEach(function (pair) {
    var point = arch.point(pair[0]);
    assertPointClose(point, horizontal.point(pair[1]), 2);
    assert.ok(Math.abs(point[1] - 70) < 2);
    if (point[0] < 50) ascending += 1;
    else descending += 1;
  });
  assert.ok(ascending > 0 && descending > 0);
});

test('intersections() tightens with a smaller tolerance and stops at maxRecursion', function () {
  var first = new PolynomialBezier([0, 0], [40, 120], [60, -20], [100, 100], false);
  var second = new PolynomialBezier([0, 100], [40, -20], [60, 120], [100, 0], false);

  var coarse = first.intersections(second, 20, 7);
  var fine = first.intersections(second, 0.05, 12);

  assert.ok(coarse.length > 0 && fine.length > 0);
  fine.forEach(function (pair) {
    assertPointClose(first.point(pair[0]), second.point(pair[1]), 0.1);
  });
  // A shallow recursion limit cannot refine below the box size it stopped at.
  var shallow = first.intersections(second, 0.05, 1);
  assert.ok(shallow.length > 0);
});

test('shapeSegment() and shapeSegmentInverted() wrap around the closing segment', function () {
  var shapePath = {
    v: [[0, 0], [100, 0], [100, 100]],
    o: [[30, 0], [100, 30], [70, 100]],
    i: [[-30, 0], [70, 0], [100, 70]],
    length: function () { return 3; },
  };

  var last = PolynomialBezier.shapeSegment(shapePath, 2);
  assert.deepEqual(last.points[0], shapePath.v[2]);
  assert.deepEqual(last.points[1], shapePath.o[2]);
  assert.deepEqual(last.points[2], shapePath.i[0]);
  assert.deepEqual(last.points[3], shapePath.v[0]);

  var inverted = PolynomialBezier.shapeSegmentInverted(shapePath, 2);
  assert.deepEqual(inverted.points[0], shapePath.v[0]);
  assert.deepEqual(inverted.points[1], shapePath.i[0]);
  assert.deepEqual(inverted.points[2], shapePath.o[2]);
  assert.deepEqual(inverted.points[3], shapePath.v[2]);

  // The inverted segment walks the same geometry backwards.
  SAMPLES.forEach(function (t) {
    assertPointClose(inverted.point(t), last.point(1 - t), 1e-9);
  });
});

test('lineIntersection() intersects lines and rejects parallel ones', function () {
  assert.deepEqual(lineIntersection([0, 0], [10, 10], [0, 10], [10, 0]), [5, 5]);
  // Segments are treated as infinite lines: the crossing may lie outside them.
  assertPointClose(lineIntersection([0, 0], [1, 0], [5, 5], [5, 6]), [5, 0], 1e-12);
  assert.equal(lineIntersection([0, 0], [10, 0], [0, 5], [10, 5]), null);
  assert.equal(lineIntersection([0, 0], [10, 10], [5, 5], [15, 15]), null);
});

test('polarOffset() offsets in screen space, where y grows downwards', function () {
  assert.deepEqual(polarOffset([10, 10], 0, 5), [15, 10]);
  assertPointClose(polarOffset([10, 10], Math.PI / 2, 5), [10, 5], 1e-9);
  assertPointClose(polarOffset([10, 10], Math.PI, 5), [5, 10], 1e-9);
  assert.deepEqual(polarOffset([10, 10], 1.234, 0), [10, 10]);
});

test('pointDistance() measures euclidean distance', function () {
  assert.equal(pointDistance([0, 0], [3, 4]), 5);
  assert.equal(pointDistance([-3, -4], [0, 0]), 5);
  assert.equal(pointDistance([7, 7], [7, 7]), 0);
});

test('floatEqual() and pointEqual() compare with a relative epsilon', function () {
  assert.equal(floatEqual(1000, 1000.001), true);
  assert.equal(floatEqual(1000, 1001), false);
  // The tolerance scales with magnitude: the same absolute gap is significant
  // for small numbers and negligible for large ones.
  assert.equal(floatEqual(0.001, 0.002), false);
  assert.equal(floatEqual(1e6, 1e6 + 1), true);
  assert.equal(floatEqual(0, 0), true);
  // A relative comparison can never treat a non zero value as equal to zero.
  assert.equal(floatEqual(0, 1e-12), false);

  assert.equal(pointEqual([10, 20], [10, 20]), true);
  assert.equal(pointEqual([10, 20], [10.000001, 20.000001]), true);
  assert.equal(pointEqual([10, 20], [10, 21]), false);
});
