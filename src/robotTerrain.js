const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export function hasSurfaceSupport(surface, x) {
  return !surface.supports || surface.supports.some(span => x >= span.left && x <= span.right);
}

export function getSurfaceHeight(surface, x) {
  const points = surface.profile;
  if (!points || !points.length) return surface.top;
  if (x <= points[0].x) return points[0].y;
  if (x >= points[points.length - 1].x) return points[points.length - 1].y;
  let low = 0;
  let high = points.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].x <= x) low = middle;
    else high = middle;
  }
  const start = points[low];
  const end = points[high];
  const progress = (x - start.x) / (end.x - start.x);
  return start.y + (end.y - start.y) * progress;
}

export function getStandingPoint(surface, preferredX) {
  // Leave room for the animated stride at a portrait ledge. A foot stepping
  // beyond a cliff must not abruptly transfer all support to the raised foot.
  const margin = surface.kind === "image" && (surface.width >= 100 || (surface.key || "").indexOf("-section-") >= 0)
    ? Math.min(24, surface.width * 0.38)
    : Math.min(surface.profile ? 12 : 16, surface.width * 0.14);
  let x = clamp(preferredX, surface.left + margin, surface.right - margin);
  if (surface.supports && surface.supports.length && !hasSurfaceSupport(surface, x)) {
    let nearest = x;
    let distance = Infinity;
    surface.supports.forEach(span => {
      const left = Math.max(surface.left + margin, span.left);
      const right = Math.min(surface.right - margin, span.right);
      if (right < left) return;
      const candidate = clamp(x, left + (right - left) * 0.25, right - (right - left) * 0.25);
      if (Math.abs(candidate - x) < distance) {
        distance = Math.abs(candidate - x);
        nearest = candidate;
      }
    });
    x = nearest;
  }
  return { x, y: getSurfaceHeight(surface, x) };
}

// An overhanging hair silhouette creates near-vertical height discontinuities.
// Keep those as distinct ledges; the normal jump controller crosses them.
export function splitSurfaceAtCliffs(surface) {
  if (surface.kind !== "image" || !surface.profile || surface.width < 100) return [surface];
  const sections = [];
  const points = surface.profile;
  const threshold = Math.max(18, surface.height * 0.08);
  let start = 0;
  const addSection = end => {
    const profile = points.slice(start, end);
    if (profile.length < 2) return;
    const left = profile[0].x;
    const right = profile[profile.length - 1].x;
    if (right - left < 24) return;
    const top = Math.min(...profile.map(point => point.y));
    sections.push({ ...surface, left, right, width: right - left, top, height: surface.bottom - top,
      key: `${surface.key}-section-${sections.length}`, profile });
  };
  for (let index = 1; index < points.length; index += 1) {
    const rise = Math.abs(points[index].y - points[index - 1].y);
    const run = points[index].x - points[index - 1].x;
    if (rise > threshold && rise > run * 3) {
      addSection(index);
      start = index;
    }
  }
  addSection(points.length);
  return sections.length > 1 ? sections : [surface];
}

const walkingPaths = new WeakMap();

function segmentAt(points, value, field = "x") {
  let low = 0;
  let high = points.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle][field] <= value) low = middle;
    else high = middle;
  }
  return low;
}

function smoothSection(points, kind) {
  if (points.length < 2 || (kind !== "text" && kind !== "image")) return points;
  const left = points[0].x;
  const right = points[points.length - 1].x;
  if (!(right > left)) return points;
  // One sample per CSS pixel is plenty for the body's path. The raw half-pixel
  // glyph/portrait outline remains untouched for precise sole contact.
  const count = Math.min(4096, Math.max(1, Math.ceil(right - left)));
  const step = (right - left) / count;
  const sampled = [];
  let segment = 0;
  for (let index = 0; index <= count; index += 1) {
    const x = left + index * step;
    while (segment < points.length - 2 && points[segment + 1].x < x) segment += 1;
    const from = points[segment];
    const to = points[segment + 1];
    const y = from.y + (to.y - from.y) * (x - from.x) / (to.x - from.x);
    sampled.push({ x, y });
  }
  let heights = sampled.map(point => point.y);
  if (kind === "text") {
    // A stance spans neighboring ink, instead of diving into every counter,
    // punctuation gap or narrow space between letters (screen Y grows down).
    // Include the next footfall as well as the current stance. A comma plus
    // its following space must not become a deep pit before the next letter.
    const reach = 22;
    const radius = Math.ceil(reach / step);
    heights = sampled.map((point, index) => {
      let highest = point.y;
      for (let neighbor = Math.max(0, index - radius); neighbor <= Math.min(count, index + radius); neighbor += 1) {
        if (Math.abs(sampled[neighbor].x - point.x) <= reach) highest = Math.min(highest, sampled[neighbor].y);
      }
      return highest;
    });
  }
  const smoothingRadius = kind === "text" ? 6 : 3;
  const radius = Math.ceil(smoothingRadius / step);
  const sigma = smoothingRadius / 2;
  const filtered = sampled.map((point, index) => {
    let total = 0;
    let weights = 0;
    for (let neighbor = Math.max(0, index - radius); neighbor <= Math.min(count, index + radius); neighbor += 1) {
      const dx = sampled[neighbor].x - point.x;
      if (Math.abs(dx) > smoothingRadius) continue;
      const weight = Math.exp(-0.5 * dx * dx / (sigma * sigma));
      total += heights[neighbor] * weight;
      weights += weight;
    }
    return { x: point.x, y: total / weights };
  });
  if (kind === "image") {
    // Adjacent cliff sections meet the original jump/ledge boundary exactly.
    filtered[0].y = points[0].y;
    filtered[filtered.length - 1].y = points[points.length - 1].y;
  }
  return filtered;
}

function walkingPath(surface) {
  const raw = surface.profile;
  if (!raw || !raw.length) return null;
  const cached = walkingPaths.get(surface);
  if (cached && cached.raw === raw && cached.kind === surface.kind && cached.height === surface.height) return cached.points;
  const sections = [];
  let start = 0;
  if (surface.kind === "image") {
    // Usually the page already split these ledges. Keep the same protection
    // here so smoothing never rounds a genuine hair overhang into a ramp.
    const threshold = Math.max(18, (surface.height || 0) * 0.08);
    for (let index = 1; index < raw.length; index += 1) {
      const rise = Math.abs(raw[index].y - raw[index - 1].y);
      const run = raw[index].x - raw[index - 1].x;
      if (rise > threshold && rise > run * 3) {
        sections.push(raw.slice(start, index));
        start = index;
      }
    }
  }
  sections.push(raw.slice(start));
  const points = [];
  let distance = 0;
  sections.forEach(section => {
    smoothSection(section, surface.kind).forEach(point => {
      const previous = points[points.length - 1];
      if (previous) distance += Math.hypot(point.x - previous.x, point.y - previous.y);
      points.push({ x: point.x, y: point.y, distance });
    });
  });
  walkingPaths.set(surface, { raw, kind: surface.kind, height: surface.height, points });
  return points;
}

/** Body/travel height only. Resting and foot contact use getSurfaceHeight. */
export function getWalkingHeight(surface, x) {
  const points = walkingPath(surface);
  if (!points || !points.length) return surface.top;
  if (x <= points[0].x) return points[0].y;
  const last = points[points.length - 1];
  if (x >= last.x) return last.y;
  const index = segmentAt(points, x);
  const from = points[index];
  const to = points[index + 1];
  return from.y + (to.y - from.y) * (x - from.x) / (to.x - from.x);
}

export function getSurfaceSlope(surface, x) {
  const left = Math.max(surface.left, x - 8);
  const right = Math.min(surface.right, x + 8);
  return right > left
    ? (getWalkingHeight(surface, right) - getWalkingHeight(surface, left)) / (right - left)
    : 0;
}

function walkingDistanceAt(points, x) {
  const first = points[0];
  const last = points[points.length - 1];
  if (x <= first.x) return x - first.x;
  if (x >= last.x) return last.distance + x - last.x;
  const index = segmentAt(points, x);
  const from = points[index];
  const to = points[index + 1];
  return from.distance + (to.distance - from.distance) * (x - from.x) / (to.x - from.x);
}

function walkingXAt(points, distance) {
  const first = points[0];
  const last = points[points.length - 1];
  if (distance <= 0) return first.x + distance;
  if (distance >= last.distance) return last.x + distance - last.distance;
  const index = segmentAt(points, distance, "distance");
  const from = points[index];
  const to = points[index + 1];
  return from.x + (to.x - from.x) * (distance - from.distance) / (to.distance - from.distance);
}

// Spend distance on the stable travel curve, using its cached cumulative arc
// length. No forward scan or reversed profile allocation happens per frame.
export function advanceAlongSurface(surface, fromX, targetX, distance) {
  const direction = Math.sign(targetX - fromX);
  if (!direction || distance <= 0) return fromX;
  const points = walkingPath(surface);
  if (!points) return fromX + direction * Math.min(Math.abs(targetX - fromX), distance);
  const from = walkingDistanceAt(points, fromX);
  const target = walkingDistanceAt(points, targetX);
  if (Math.abs(target - from) <= distance) return targetX;
  return walkingXAt(points, from + direction * distance);
}
