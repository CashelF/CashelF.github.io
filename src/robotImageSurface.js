// Read the portrait's alpha once, then map the cached outline into its current
// CSS box. No canvas reads or image work happen while Marvin walks a surface.
const outlines = new WeakMap();
const MAX_SAMPLE_SIZE = 384;
const ALPHA_THRESHOLD = 160;


function medianProfile(points) {
  return points.map((point, index) => {
    const neighbors = [];
    for (let offset = -2; offset <= 2; offset++) {
      neighbors.push(points[Math.max(0, Math.min(points.length - 1, index + offset))].y);
    }
    neighbors.sort((a, b) => a - b);
    return { x: point.x, y: neighbors[2], bottom: point.bottom };
  });
}

function lowerAlphaLedges(component, width, height, tops) {
  const tracks = [];
  let previous = [];
  const minimumThickness = Math.max(3, Math.ceil(height * 0.08));
  const maximumRise = Math.max(3, height * 0.045);
  for (let x = 0; x < width; x++) {
    const current = [];
    let y = 0;
    while (y < height) {
      while (y < height && !component[y * width + x]) y++;
      const top = y;
      while (y < height && component[y * width + x]) y++;
      const bottom = y;
      if (bottom - top < minimumThickness) continue;
      let nearest = null;
      let distance = Infinity;
      previous.forEach(track => {
        if (current.indexOf(track) >= 0) return;
        const last = track.points[track.points.length - 1];
        const rise = Math.abs(last.y - top);
        if (rise <= maximumRise && Math.min(last.bottom, bottom) > Math.max(last.y, top) && rise < distance) {
          nearest = track;
          distance = rise;
        }
      });
      const track = nearest || { points: [], hiddenColumns: 0 };
      if (!nearest) tracks.push(track);
      track.points.push({ x, y: top, bottom });
      if (top - tops[x] > Math.max(3, height * 0.045)) track.hiddenColumns++;
      current.push(track);
    }
    previous = current;
  }
  // Only substantial ledges hidden below the topmost silhouette qualify.
  // The thickness and span requirements reject individual hair wisps and
  // texture holes while retaining the two shoulders beneath the hair.
  return tracks.filter(track =>
    track.points.length >= Math.max(4, width * 0.07) &&
    track.hiddenColumns >= Math.max(2, width * 0.03)
  ).map(track => medianProfile(track.points.map(point => ({
    x: (point.x + 0.5) / width,
    y: point.y / height,
    bottom: point.bottom / height,
  }))));
}

function readOutline(element) {
  const source = element.currentSrc || element.src;
  const naturalWidth = element.naturalWidth;
  const naturalHeight = element.naturalHeight;
  if (!element.complete || !source || !naturalWidth || !naturalHeight) return null;
  const key = `${source}:${naturalWidth}:${naturalHeight}`;
  const cached = outlines.get(element);
  if (cached && cached.key === key) return cached.outline;
  // Failed/tainted images are cached too, so cross-origin assets never cause
  // repeated exceptions. A new source or intrinsic size gets another attempt.
  outlines.set(element, { key, outline: null });

  try {
    const scale = Math.min(1, MAX_SAMPLE_SIZE / Math.max(naturalWidth, naturalHeight));
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));
    const canvas = element.ownerDocument.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(element, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    const mask = new Uint8Array(width * height);
    let solidCount = 0;
    for (let i = 0; i < mask.length; i++) {
      if (data[i * 4 + 3] >= ALPHA_THRESHOLD) {
        mask[i] = 1;
        solidCount++;
      }
    }
    if (solidCount === mask.length || solidCount < 12) return null;

    // Keep the largest connected shape, excluding isolated alpha flecks and
    // detached decorations that would otherwise become floating platforms.
    const queue = new Uint32Array(mask.length);
    let largest = [];
    for (let start = 0; start < mask.length; start++) {
      if (mask[start] !== 1) continue;
      let head = 0;
      let tail = 1;
      queue[0] = start;
      mask[start] = 2;
      while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = Math.floor(index / width);
        for (let dy = -1; dy <= 1; dy++) {
          const nextY = y + dy;
          if (nextY < 0 || nextY >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nextX = x + dx;
            if (nextX < 0 || nextX >= width) continue;
            const next = nextY * width + nextX;
            if (mask[next] === 1) {
              mask[next] = 2;
              queue[tail++] = next;
            }
          }
        }
      }
      if (tail > largest.length) largest = Array.from(queue.subarray(0, tail));
    }
    if (largest.length < Math.max(12, mask.length * 0.002)) return null;

    const component = new Uint8Array(mask.length);
    const tops = new Array(width).fill(height);
    const bottoms = new Array(width).fill(-1);
    const counts = new Array(width).fill(0);
    largest.forEach(index => {
      component[index] = 1;
      const x = index % width;
      const y = Math.floor(index / width);
      tops[x] = Math.min(tops[x], y);
      bottoms[x] = Math.max(bottoms[x], y);
      counts[x]++;
    });
    // Trim very thin end pixels without cutting interior columns out of an
    // otherwise continuous shoulder/hair outline.
    let first = 0;
    let last = width - 1;
    while (first <= last && counts[first] < 3) first++;
    while (last >= first && counts[last] < 3) last--;
    if (last - first < 2) return null;
    const profile = [];
    for (let x = first; x <= last; x++) {
      if (bottoms[x] < 0) continue;
      const neighbors = [];
      for (let offset = -2; offset <= 2; offset++) {
        neighbors.push(tops[Math.max(first, Math.min(last, x + offset))]);
      }
      neighbors.sort((a, b) => a - b);
      profile.push({ x: (x + 0.5) / width, y: neighbors[2] / height, bottom: (bottoms[x] + 1) / height });
    }
    const ledges = lowerAlphaLedges(component, width, height, tops);
    const outline = { profile, ledges, naturalWidth, naturalHeight };
    outlines.set(element, { key, outline });
    return outline;
  } catch (error) {
    return null;
  }
}

function pixels(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function offset(value, available, scale) {
  if (value === "left" || value === "top") return 0;
  if (value === "right" || value === "bottom") return available;
  if (!value || value === "center") return available / 2;
  if (value.indexOf("calc(") === 0) {
    let result = 0;
    const terms = value.slice(5, -1).replace(/\s+/g, "").match(/[+-]?(?:\d*\.)?\d+(?:%|px)/g) || [];
    terms.forEach(term => { result += term.indexOf("%") >= 0 ? pixels(term) * available / 100 : pixels(term) * scale; });
    return result;
  }
  return value.indexOf("%") >= 0 ? pixels(value) * available / 100 : pixels(value) * scale;
}

function positionOffsets(position, availableX, availableY, scaleX, scaleY) {
  const tokens = (position || "50% 50%").match(/calc\([^)]*\)|[^\s]+/g);
  if (tokens.length > 2) {
    let x = availableX / 2;
    let y = availableY / 2;
    for (let i = 0; i < tokens.length; i++) {
      const edge = tokens[i];
      const horizontal = edge === "left" || edge === "right";
      const vertical = edge === "top" || edge === "bottom";
      if (!horizontal && !vertical) continue;
      const available = horizontal ? availableX : availableY;
      const scale = horizontal ? scaleX : scaleY;
      const next = tokens[i + 1];
      const hasDistance = next && !/^(left|right|top|bottom|center)$/.test(next);
      const distance = hasDistance ? offset(next, available, scale) : 0;
      const value = edge === "right" || edge === "bottom" ? available - distance : distance;
      if (horizontal) x = value;
      else y = value;
      if (hasDistance) i++;
    }
    return { x, y };
  }
  let x = tokens[0];
  let y = tokens[1] || "center";
  if (x === "top" || x === "bottom" || y === "left" || y === "right") {
    const swap = x;
    x = tokens[1] || "center";
    y = swap;
  }
  return { x: offset(x, availableX, scaleX), y: offset(y, availableY, scaleY) };
}

function clippedProfile(points, left, right) {
  const result = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const next = points[i + 1];
    if (point.x >= left && point.x <= right) result.push(point);
    if (!next) continue;
    [left, right].forEach(edge => {
      if (point.x < edge && next.x > edge) {
        const fraction = (edge - point.x) / (next.x - point.x);
        result.push({ x: edge, y: point.y + (next.y - point.y) * fraction });
      }
    });
  }
  return result.sort((a, b) => a.x - b.x);
}

function getImageGeometry(element, scopeRect) {
  if (!element || element.tagName !== "IMG" || !element.hasAttribute("data-robot-contour")) return null;
  const outline = readOutline(element);
  if (!outline) return null;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  const insetLeft = pixels(style.borderLeftWidth) + pixels(style.paddingLeft);
  const insetRight = pixels(style.borderRightWidth) + pixels(style.paddingRight);
  const insetTop = pixels(style.borderTopWidth) + pixels(style.paddingTop);
  const insetBottom = pixels(style.borderBottomWidth) + pixels(style.paddingBottom);
  const layoutWidth = pixels(style.width) + (style.boxSizing === "border-box" ? 0 : insetLeft + insetRight) || rect.width;
  const layoutHeight = pixels(style.height) + (style.boxSizing === "border-box" ? 0 : insetTop + insetBottom) || rect.height;
  const scaleX = rect.width / layoutWidth;
  const scaleY = rect.height / layoutHeight;
  const contentWidth = layoutWidth - insetLeft - insetRight;
  const contentHeight = layoutHeight - insetTop - insetBottom;
  if (contentWidth <= 0 || contentHeight <= 0) return null;
  const contentLeft = rect.left + insetLeft * scaleX - scopeRect.left;
  const contentTop = rect.top + insetTop * scaleY - scopeRect.top;
  const contentRight = contentLeft + contentWidth * scaleX;
  const contentBottom = contentTop + contentHeight * scaleY;

  let paintedWidth = contentWidth;
  let paintedHeight = contentHeight;
  const fit = style.objectFit || "fill";
  if (fit !== "fill") {
    const contain = Math.min(contentWidth / outline.naturalWidth, contentHeight / outline.naturalHeight);
    const factor = fit === "cover"
      ? Math.max(contentWidth / outline.naturalWidth, contentHeight / outline.naturalHeight)
      : fit === "none" ? 1 : fit === "scale-down" ? Math.min(1, contain) : contain;
    paintedWidth = outline.naturalWidth * factor;
    paintedHeight = outline.naturalHeight * factor;
  }
  paintedWidth *= scaleX;
  paintedHeight *= scaleY;
  const position = positionOffsets(style.objectPosition, contentWidth * scaleX - paintedWidth, contentHeight * scaleY - paintedHeight, scaleX, scaleY);
  const originX = contentLeft + position.x;
  const originY = contentTop + position.y;
  return { outline, contentLeft, contentTop, contentRight, contentBottom, originX, originY, paintedWidth, paintedHeight };
}

function mapProfile(element, scopeRect, geometry, normalizedProfile, key) {
  const { contentLeft, contentTop, contentRight, contentBottom, originX, originY, paintedWidth, paintedHeight } = geometry;
  let current = [];
  let longest = [];
  let bottom = contentTop;
  normalizedProfile.forEach(point => {
    const y = Math.max(contentTop, originY + point.y * paintedHeight);
    const lower = Math.min(contentBottom, originY + point.bottom * paintedHeight);
    if (lower <= contentTop || y >= contentBottom) {
      if (current.length > longest.length) longest = current;
      current = [];
      return;
    }
    bottom = Math.max(bottom, lower);
    current.push({ x: originX + point.x * paintedWidth, y });
  });
  if (current.length > longest.length) longest = current;
  const leftLimit = Math.max(contentLeft, 0);
  const rightLimit = Number.isFinite(scopeRect.right) ? Math.min(contentRight, scopeRect.right - scopeRect.left) : contentRight;
  const profile = clippedProfile(longest, leftLimit, rightLimit);
  if (profile.length < 2) return null;
  const left = profile[0].x;
  const right = profile[profile.length - 1].x;
  const top = Math.min.apply(null, profile.map(point => point.y));
  return { element, left, right, top, bottom, width: right - left, height: bottom - top, kind: "image", key, profile };
}


export function getImageSurface(element, scopeRect) {
  const geometry = getImageGeometry(element, scopeRect);
  return geometry ? mapProfile(element, scopeRect, geometry, geometry.outline.profile, "image-outline") : null;
}

export function getImageSurfaces(element, scopeRect) {
  const geometry = getImageGeometry(element, scopeRect);
  if (!geometry) return [];
  const outer = mapProfile(element, scopeRect, geometry, geometry.outline.profile, "image-outline");
  const surfaces = outer ? [outer] : [];
  geometry.outline.ledges.forEach((profile, index) => {
    const surface = mapProfile(element, scopeRect, geometry, profile, `image-alpha-ledge-${index}`);
    // On a tiny mobile portrait, these shoulder sections are narrower than
    // Marvin's feet. The original outer silhouette remains available there.
    if (surface && surface.width >= 24) surfaces.push(surface);
  });
  return surfaces;
}
