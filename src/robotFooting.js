import { getSurfaceHeight, hasSurfaceSupport } from "./robotTerrain";

const MAX_SAMPLE_DISTANCE = 0.75;
const CONTACT_ALLOWANCE = 0.6;
const workspaces = new WeakMap();

function cross(origin, a, b) {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

function lowerEnvelope(sample, width, height, scratchVector) {
  let workspace = workspaces.get(sample);
  if (!workspace) {
    workspace = { projected: [], hull: [] };
    workspaces.set(sample, workspace);
  }
  const projected = workspace.projected;
  let count = 0;
  sample.points.forEach(point => {
    scratchVector.copy(point).applyMatrix4(sample.node.matrixWorld);
    const x = scratchVector.x + width / 2;
    const y = height / 2 - scratchVector.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const result = projected[count] || { x: 0, y: 0 };
    result.x = x;
    result.y = y;
    projected[count++] = result;
  });
  projected.length = count;
  projected.sort((a, b) => a.x - b.x || b.y - a.y);

  // Screen Y increases downward. Keep the clockwise chain joining the lowest
  // projected vertices, including sole edges between the original mesh points.
  const hull = workspace.hull;
  hull.length = 0;
  projected.forEach((point, index) => {
    if (index && point.x === projected[index - 1].x) return;
    while (hull.length > 1 && cross(hull[hull.length - 2], hull[hull.length - 1], point) >= 0) hull.pop();
    hull.push(point);
  });
  return hull;
}

export function getFootingCorrection(footSamples, surface, width, height, scratchVector, options = {}) {
  if (!surface || !footSamples || !footSamples.length || !scratchVector ||
      !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;
  const surfaceLeft = Number.isFinite(surface.left) ? surface.left : 0;
  const surfaceRight = Number.isFinite(surface.right) ? surface.right : width;
  if (surfaceRight < surfaceLeft) return 0;
  let correction = -Infinity;

  const contact = (x, y) => {
    if (x < surfaceLeft || x > surfaceRight || !hasSurfaceSupport(surface, x)) return;
    const terrainY = getSurfaceHeight(surface, x);
    // A stepping foot may pass over punctuation or a hole between strokes.
    // Keep that lower ink from pulling the whole body down mid-stride.
    if (Number.isFinite(terrainY) && !(terrainY > options.maxSurfaceY)) {
      correction = Math.max(correction, y - terrainY - CONTACT_ALLOWANCE);
    }
  };

  const sampleEdge = (start, end) => {
    const left = Math.max(surfaceLeft, start.x);
    const right = Math.min(surfaceRight, end.x);
    if (right < left) return;
    const slope = (end.y - start.y) / (end.x - start.x);
    const sampleSpan = (spanLeft, spanRight) => {
      const from = Math.max(left, spanLeft);
      const to = Math.min(right, spanRight);
      if (to < from) return;
      const startY = start.y + (from - start.x) * slope;
      const endY = start.y + (to - start.x) * slope;
      const steps = Math.max(1, Math.ceil(Math.hypot(to - from, endY - startY) / MAX_SAMPLE_DISTANCE));
      for (let index = 0; index <= steps; index++) {
        const progress = index / steps;
        contact(from + (to - from) * progress, startY + (endY - startY) * progress);
      }
    };
    if (surface.supports) {
      // Start and end on actual ink, so a narrow stem cannot fall between a
      // pair of regularly spaced samples or attract a foot across whitespace.
      for (let index = 0; index < surface.supports.length; index++) {
        const span = surface.supports[index];
        if (span.right < left) continue;
        if (span.left > right) break;
        sampleSpan(span.left, span.right);
      }
    } else {
      sampleSpan(left, right);
    }
  };

  footSamples.forEach(sample => {
    if (!sample || !sample.node || !sample.node.matrixWorld || !sample.points || !sample.points.length) return;
    const hull = lowerEnvelope(sample, width, height, scratchVector);
    if (hull.length === 1) contact(hull[0].x, hull[0].y);
    for (let index = 1; index < hull.length; index++) sampleEdge(hull[index - 1], hull[index]);
  });
  return Number.isFinite(correction) ? correction : options.reportUnsupported ? null : 0;
}
