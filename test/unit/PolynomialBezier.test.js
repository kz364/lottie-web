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

// Angles produced by this module are consumed by polarOffset, which treats y as
// growing downwards; these helpers keep the tests in that same frame.
function offsetDirection(bez, t, angle) {
  var origin = bez.point(t);
  var moved = polarOffset(origin, angle, 1);
  return [moved[0] - origin[0], moved[1] - origin[1]];
}

function dot(u, v) {
  return u[0] * v[0] + u[1] * v[1];
}

function cross(u, v) {
  return u[0] * v[1] - u[1] * v[0];
}

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

test('tangentAngle() follows the direction the curve is travelling in', function () {
  var bez = new PolynomialBezier([0, 0], [30, 90], [70, -40], [100, 50], false);
  var h = 1e-6;

  [0.1, 0.4, 0.75].forEach(function (t) {
    var before = bez.point(t - h);
    var after = bez.point(t + h);
    var travel = Math.atan2(after[1] - before[1], after[0] - before[0]);
    assert.ok(Math.abs(bez.tangentAngle(t) - travel) < 1e-4, bez.tangentAngle(t) + ' vs ' + travel);
  });

  // Straight diagonal: the direction of travel does not depend on t.
  var diagonal = new PolynomialBezier([0, 0], [10, 10], [20, 20], [30, 30], false);
  SAMPLES.forEach(function (t) {
    assert.ok(Math.abs(diagonal.tangentAngle(t) - Math.PI / 4) < 1e-9);
  });
});

test('normalAngle() is the polarOffset angle that steps sideways off the curve', function () {
  // The convention is set by the callers, not by textbook geometry:
  // OffsetPathModifier's linearOffset() computes atan2(dx, dy) and hands it
  // straight to polarOffset(), and its round join builds the same direction as
  // -tangentAngle() + PI / 2. So normalAngle is deliberately NOT
  // tangentAngle +/- PI / 2; it is the tangent mirrored across the 45 degree
  // line, which is what polarOffset's downward y needs to yield a perpendicular
  // step. The assertions below are on that step, not on the raw angle.
  var bez = new PolynomialBezier([0, 0], [30, 90], [70, -40], [100, 50], false);

  [0.2, 0.5, 0.8].forEach(function (t) {
    var tangent = bez.derivative(t);
    var step = offsetDirection(bez, t, bez.normalAngle(t));

    assert.ok(Math.abs(dot(tangent, step)) < 1e-9, 'not perpendicular: ' + dot(tangent, step));
    assert.ok(Math.abs(pointDistance([0, 0], step) - 1) < 1e-12);
    // Always the same side of the curve, otherwise an offset path built from
    // these angles would flip across itself part way along.
    assert.ok(cross(tangent, step) < 0, 'side flipped: ' + cross(tangent, step));

    // Mirror identity, and agreement with the round-join construction.
    assert.ok(Math.abs(bez.normalAngle(t) - (Math.PI / 2 - bez.tangentAngle(t))) < 1e-12);
    assertPointClose(offsetDirection(bez, t, -bez.tangentAngle(t) + Math.PI / 2), step, 1e-12);
    // The quarter turn a naive reading would expect is wrong here.
    assert.ok(Math.abs(Math.abs(bez.normalAngle(t) - bez.tangentAngle(t)) - Math.PI / 2) > 1e-6);
  });

  // Straight segment: the same angle linearOffset() would compute for it.
  var horizontal = new PolynomialBezier([0, 0], [10, 0], [20, 0], [30, 0], false);
  assert.equal(horizontal.normalAngle(0.5), Math.atan2(30, 0));
  assertPointClose(polarOffset([0, 0], horizontal.normalAngle(0.5), 5), [0, -5], 1e-12);
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
});

test('inflectionPoints() discards roots that fall outside the drawn segment', function () {
  // Both roots of this curve's inflection quadratic are real, but only one of
  // them lies on [0, 1]. Evaluating the polynomial before t = 0 shows the other
  // inflection genuinely exists near t = -0.74, so a single returned value is
  // evidence that the domain filter dropped it -- not that the curve only ever
  // had one.
  var bez = new PolynomialBezier([0, 0], [100, 20], [60, 40], [100, 100], false);

  var inflections = bez.inflectionPoints();
  assert.equal(inflections.length, 1);
  assert.ok(inflections[0] > 0 && inflections[0] < 1);
  assert.ok(signedCurvature(bez, inflections[0] - 0.05) * signedCurvature(bez, inflections[0] + 0.05) < 0);

  // Exactly one curvature sign change on the segment itself...
  var inDomainChanges = 0;
  for (var i = 0; i < 100; i += 1) {
    if (signedCurvature(bez, i / 100) * signedCurvature(bez, (i + 1) / 100) < 0) inDomainChanges += 1;
  }
  assert.equal(inDomainChanges, 1);
  // ...and a second one before it starts, which must not be reported.
  assert.ok(signedCurvature(bez, -0.9) * signedCurvature(bez, -0.6) < 0);
  assert.ok(inflections.every(function (t) { return t > 0; }));
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

test('intersections() converges as tolerance shrinks, and maxRecursion caps the search', function () {
  var first = new PolynomialBezier([0, 0], [40, 120], [60, -20], [100, 100], false);
  var second = new PolynomialBezier([0, 100], [40, -20], [60, 120], [100, 0], false);

  // The observable quality of an answer: how far apart the two points that are
  // claimed to coincide actually are.
  function worstGap(pairs) {
    return pairs.reduce(function (worst, pair) {
      return Math.max(worst, pointDistance(first.point(pair[0]), second.point(pair[1])));
    }, 0);
  }

  // Recursion deep enough that tolerance, not depth, is the binding constraint.
  var coarse = first.intersections(second, 20, 12);
  var medium = first.intersections(second, 2, 12);
  var fine = first.intersections(second, 0.05, 12);

  assert.equal(coarse.length, 2);
  assert.equal(medium.length, 2);
  assert.equal(fine.length, 2);
  assert.ok(worstGap(coarse) > worstGap(medium), 'coarse ' + worstGap(coarse) + ' vs medium ' + worstGap(medium));
  assert.ok(worstGap(medium) > worstGap(fine), 'medium ' + worstGap(medium) + ' vs fine ' + worstGap(fine));
  assert.ok(worstGap(coarse) > 1, 'coarse gap was ' + worstGap(coarse));
  assert.ok(worstGap(fine) < 0.05, 'fine gap was ' + worstGap(fine));

  // maxRecursion is a hard stop on subdivision: with a tolerance it can never
  // reach, the reported parameters are exactly the midpoints of the boxes still
  // alive at that depth -- halves at depth 1, quarters at depth 2. Error is not
  // monotonic in depth (a deeper search keeps a different set of candidate
  // boxes), so only this structural claim is asserted.
  assert.deepEqual(first.intersections(second, 0.05, 1), [[0.25, 0.25], [0.75, 0.75]]);
  assert.deepEqual(first.intersections(second, 0.05, 2), [[0.375, 0.375], [0.625, 0.625]]);
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
