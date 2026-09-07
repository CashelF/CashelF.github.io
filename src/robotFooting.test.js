import * as THREE from "three";
import { getFootingCorrection } from "./robotFooting";

const width = 200;
const height = 200;
const scratch = new THREE.Vector3();

function foot(screenPoints, matrix = new THREE.Matrix4()) {
  return {
    node: { matrixWorld: matrix },
    points: screenPoints.map(point => new THREE.Vector3(point[0] - width / 2, height / 2 - point[1], point[2] || 0)),
  };
}

function correction(feet, surface) {
  return getFootingCorrection(feet, surface, width, height, scratch);
}

const flat = { left: 10, right: 100, top: 100 };

test("grounds the lowest projected sole and can move the model up or down", () => {
  const sample = foot([[20, 98], [30, 98], [30, 103], [20, 103], [25, 101]]);
  expect(correction([sample], flat)).toBeCloseTo(2.4);
  expect(correction([foot([[20, 95], [30, 95]])], flat)).toBeCloseTo(-5.6);
});

test("samples sole edges between mesh vertices to meet a raised part of the terrain", () => {
  const surface = { ...flat, profile: [{ x: 10, y: 100 }, { x: 24, y: 100 }, { x: 25, y: 94 }, { x: 26, y: 100 }, { x: 100, y: 100 }] };
  expect(correction([foot([[20, 103], [30, 103]])], surface)).toBeCloseTo(8.4);
});

test("ignores text whitespace even when its interpolated height is much higher", () => {
  const surface = {
    ...flat,
    supports: [{ left: 20, right: 22 }, { left: 28, right: 30 }],
    profile: [{ x: 20, y: 100 }, { x: 22, y: 100 }, { x: 25, y: 20 }, { x: 28, y: 100 }, { x: 30, y: 100 }],
  };
  expect(correction([foot([[20, 103], [30, 103]])], surface)).toBeCloseTo(2.4);
  expect(correction([foot([[24, 103], [26, 103]])], surface)).toBe(0);
});

test("finds a subpixel letter stem between regularly spaced samples", () => {
  const surface = { ...flat, top: 96, supports: [{ left: 25.21, right: 25.29 }] };
  expect(correction([foot([[20, 103], [30, 103]])], surface)).toBeCloseTo(6.4);
});

test("projects animated world transforms without mutating vertices or matrices", () => {
  const matrix = new THREE.Matrix4().makeTranslation(0, -4, 0);
  const sample = foot([[20, 98], [30, 98]], matrix);
  const originalPoints = sample.points.map(point => point.clone());
  const originalMatrix = matrix.clone();
  expect(correction([sample], flat)).toBeCloseTo(1.4);
  expect(sample.points).toEqual(originalPoints);
  expect(matrix).toEqual(originalMatrix);
  matrix.makeTranslation(0, -6, 0);
  expect(correction([sample], flat)).toBeCloseTo(3.4);
});

test("uses both feet but does not bridge the unsupported space between them", () => {
  const surface = { ...flat, top: 40, supports: [{ left: 24, right: 26 }] };
  expect(correction([foot([[15, 103], [20, 103]]), foot([[30, 106], [35, 106]])], surface)).toBe(0);
  expect(correction([foot([[15, 103], [20, 103]]), foot([[30, 106], [35, 106]])], flat)).toBeCloseTo(5.4);
});

test("uses the bottom convex envelope, including identical X projections", () => {
  const sample = foot([[20, 97], [20, 104], [25, 99], [30, 104], [30, 96]]);
  expect(correction([sample], { ...flat, supports: [{ left: 24.9, right: 25.1 }] })).toBeCloseTo(3.4);
});

test("returns zero for unsupported, empty, or nonfinite geometry", () => {
  expect(correction([foot([[110, 104], [120, 104]])], flat)).toBe(0);
  expect(correction([foot([[20, 104], [30, 104]])], { ...flat, supports: [] })).toBe(0);
  expect(correction([], flat)).toBe(0);
  expect(correction([foot([[NaN, 100]])], flat)).toBe(0);
  expect(correction([foot([[20, 100]])], { ...flat, top: NaN })).toBe(0);
});

test("walking contact can distinguish a gap from level support and step past lower punctuation", () => {
  const surface = { ...flat, profile: [{ x: 10, y: 100 }, { x: 22, y: 100 }, { x: 28, y: 145 }, { x: 100, y: 145 }],
    supports: [{ left: 20, right: 22 }, { left: 28, right: 30 }] };
  const options = { reportUnsupported: true, maxSurfaceY: 118 };
  const sample = points => getFootingCorrection([foot(points)], surface, width, height, scratch, options);
  expect(sample([[24, 103], [26, 103]])).toBe(null);
  expect(sample([[28, 103], [30, 103]])).toBe(null);
  expect(sample([[20, 103], [30, 103]])).toBeCloseTo(2.4);
  expect(correction([foot([[28, 103], [30, 103]])], surface)).toBeCloseTo(-42.6);
});
