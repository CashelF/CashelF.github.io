// Glyph rasters are cached independently of layout. A scroll/robot animation
// only maps their opaque columns back onto the current DOM Range rectangle.
const documents = new WeakMap();
const MAX_RASTERS = 192;
const ALPHA_THRESHOLD = 96;

function pixels(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

export function configureTextContext(context, style) {
  const size = pixels(style.fontSize) || 16;
  context.font = `${style.fontStyle || "normal"} ${style.fontWeight || "400"} ${size}px ${style.fontFamily || "sans-serif"}`;
  if ("fontKerning" in context) context.fontKerning = style.fontKerning || "auto";
  if ("fontStretch" in context) context.fontStretch = style.fontStretch || "normal";
  if ("fontVariantCaps" in context) context.fontVariantCaps = style.fontVariantCaps || "normal";
  if ("letterSpacing" in context) context.letterSpacing = `${pixels(style.letterSpacing)}px`;
  if ("wordSpacing" in context) context.wordSpacing = `${pixels(style.wordSpacing)}px`;
  context.textBaseline = "alphabetic";
  context.textAlign = "left";
}

// Every nonempty column is a possible contact. Whitespace remains a gap instead
// of becoming an interpolated bridge between two neighboring letters.
export function traceTextAlpha(data, width, height) {
  const columns = [];
  const supports = [];
  let interval = null;
  for (let x = 0; x < width; x += 1) {
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < height; y += 1) {
      if (data[(y * width + x) * 4 + 3] >= ALPHA_THRESHOLD) {
        if (top < 0) top = y;
        bottom = y + 1;
      }
    }
    if (top >= 0) {
      columns.push({ x: x + 0.5, y: top, bottom });
      if (!interval) { interval = { left: x, right: x + 1 }; supports.push(interval); }
      else interval.right = x + 1;
    } else interval = null;
  }
  return { columns, supports };
}

function rasterCache(document) {
  if (!documents.has(document)) {
    const cache = new Map();
    documents.set(document, cache);
    if (document.fonts && document.fonts.addEventListener) {
      document.fonts.addEventListener("loadingdone", () => cache.clear());
    }
  }
  return documents.get(document);
}

function readRaster(document, text, style, width) {
  const signature = [text, style.fontFamily, style.fontSize, style.fontWeight, style.fontStyle,
    style.fontKerning, style.fontStretch, style.fontVariantCaps, style.letterSpacing, style.wordSpacing,
    Math.round(width * 16) / 16, document.fonts && document.fonts.status];
  const key = JSON.stringify(signature);
  const cache = rasterCache(document);
  if (cache.has(key)) {
    const cached = cache.get(key);
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  let raster = null;
  try {
    if (!document.defaultView.CanvasRenderingContext2D) return null;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context || !context.getImageData) return null;
    configureTextContext(context, style);
    let metrics = context.measureText(text);
    const size = pixels(style.fontSize) || 16;
    const characters = Array.from(text);
    const letterSpacing = pixels(style.letterSpacing);
    const wordSpacing = pixels(style.wordSpacing);
    const manualSpacing = (!("letterSpacing" in context) && letterSpacing) || (!("wordSpacing" in context) && wordSpacing);
    if (manualSpacing) {
      if ("letterSpacing" in context) context.letterSpacing = "0px";
      if ("wordSpacing" in context) context.wordSpacing = "0px";
      metrics = context.measureText(text);
    }
    const advance = metrics.width + (manualSpacing ? letterSpacing * characters.length + wordSpacing * (text.match(/\s/g) || []).length : 0);
    if (!(advance > 0)) return null;
    const padLeft = Math.ceil(Math.max(0, metrics.actualBoundingBoxLeft || 0) + 2);
    const ascent = Math.ceil(Math.max(metrics.fontBoundingBoxAscent || size, metrics.actualBoundingBoxAscent || 0));
    const descent = Math.ceil(Math.max(metrics.fontBoundingBoxDescent || size * 0.3, metrics.actualBoundingBoxDescent || 0));
    const rasterWidth = Math.ceil(Math.max(advance, metrics.actualBoundingBoxRight || 0) + padLeft + 4);
    const rasterHeight = ascent + descent + 4;
    // At most ~1M pixels even for unusually large imported text. Normal heading
    // glyphs use 2 samples per CSS pixel; tiny body text stays legible too.
    const scale = Math.min(2, 2048 / rasterWidth, 512 / rasterHeight);
    canvas.width = Math.max(1, Math.ceil(rasterWidth * scale));
    canvas.height = Math.max(1, Math.ceil(rasterHeight * scale));
    configureTextContext(context, style);
    context.scale(scale, scale);
    context.fillStyle = "#000";
    const baseline = ascent + 2;
    if (manualSpacing) {
      // Legacy canvases lack spacing properties. Preserve browser advances
      // using measured prefixes, adding only the unsupported CSS spacing.
      if ("letterSpacing" in context) context.letterSpacing = "0px";
      if ("wordSpacing" in context) context.wordSpacing = "0px";
      let prefix = "";
      let spaces = 0;
      characters.forEach((character, index) => {
        const x = padLeft + context.measureText(prefix).width + index * letterSpacing + spaces * wordSpacing;
        context.fillText(character, x, baseline);
        prefix += character;
        if (/\s/.test(character)) spaces += 1;
      });
    } else context.fillText(text, padLeft, baseline);
    const traced = traceTextAlpha(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
    if (traced.columns.length) {
      raster = { ...traced, scale, advance, padLeft, baseline };
    }
  } catch (error) { /* Font/canvas restrictions retain the Range ink fallback. */ }
  cache.set(key, raster);
  if (cache.size > MAX_RASTERS) cache.delete(cache.keys().next().value);
  return raster;
}

/** Return viewport coordinates; callers convert to their own layout scope. */
export function getTextInkProfile(document, text, style, rect, baseline) {
  const raster = readRaster(document, text, style, rect.width);
  if (!raster) return null;
  const horizontalScale = rect.width / raster.advance;
  const xAt = x => rect.left + (x / raster.scale - raster.padLeft) * horizontalScale;
  const yAt = y => baseline + y / raster.scale - raster.baseline;
  const profile = raster.columns.map(point => ({ x: xAt(point.x), y: yAt(point.y) }));
  const supports = raster.supports.map(interval => ({ left: xAt(interval.left), right: xAt(interval.right) }));
  const left = supports[0].left;
  const right = supports[supports.length - 1].right;
  const top = Math.min(...profile.map(point => point.y));
  const bottom = Math.max(...raster.columns.map(point => yAt(point.bottom)));
  return { profile, supports, sampleWidth: horizontalScale / raster.scale, left, right, top, bottom, width: right - left, height: bottom - top };
}
