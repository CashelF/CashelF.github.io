import { getImageSurfaces } from "./robotImageSurface";
import { configureTextContext, getTextInkProfile } from "./robotTextSurface";

// Perches follow visible page content. The robot and the visualization's tiny
// internal controls are excluded; their outer panels remain usable surfaces.
const SURFACE_SELECTOR = [
  ".robot-play-target", "[data-robot-target]", "[data-robot-platform]",
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "span", "label", "li", "figcaption", "button",
  "input:not([type='hidden'])", "textarea", "select", "summary",
  "img", "svg", "canvas", "video", "figure", "pre", "table", "blockquote", "hr",
  "[role='img']", ".site-header", ".hero-footnote", ".footer-bottom",
  ".brain-console", ".brain-visual", ".brain-generation",
].join(",");

const EXCLUDED = ".site-robot, .brain-scene, .token-flow, [data-robot-ignore], [hidden], [inert], [aria-hidden='true']";
const EXPLICIT = ".robot-play-target, [data-robot-target], [data-robot-platform]";
const CLIPS = /^(auto|scroll|hidden|clip)$/;

const TEXT_SELECTOR = "h1,h2,h3,h4,h5,h6,p,a,span,label,li,figcaption,blockquote";
const BOX_SELECTOR = "button,input,textarea,select,summary,pre,table,hr,[data-robot-platform],.site-header,.hero-footnote,.footer-bottom,.brain-console,.brain-visual,.brain-generation";
const metricContexts = new WeakMap();

function metricContext(document) {
  if (!metricContexts.has(document)) {
    let context = null;
    try {
      if (document.defaultView.CanvasRenderingContext2D) context = document.createElement("canvas").getContext("2d");
    } catch (error) { /* DOM ranges still give useful bounds without a canvas. */ }
    metricContexts.set(document, context);
  }
  return metricContexts.get(document);
}

function paintedBox(style) {
  const transparent = value => !value || value === "transparent" || /rgba\([^)]*,\s*0(?:\.0+)?\s*\)/.test(value);
  return (!transparent(style.backgroundColor)) ||
    (style.backgroundImage && style.backgroundImage !== "none") ||
    (Number.parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== "none" && !transparent(style.borderTopColor));
}

function isText(element, styleOf) {
  return element.matches(TEXT_SELECTOR) && !element.matches(BOX_SELECTOR) && !paintedBox(styleOf(element));
}

function textOwner(element, scope, styleOf) {
  let owner = element;
  let parent = element.parentElement;
  while (parent && parent !== scope) {
    if (parent.matches(BOX_SELECTOR) || paintedBox(styleOf(parent))) break;
    if (isText(parent, styleOf)) owner = parent;
    parent = parent.parentElement;
  }
  return owner;
}

// Range rectangles exclude CSS padding and line-height leading. Font bounding
// metrics locate the baseline inside that rectangle; actual ink metrics then
// remove the font's unused ascent/descent space (especially visible on headings).
function inkRect(rect, text, style, context) {
  const size = Number.parseFloat(style.fontSize) || 16;
  let metrics = null;
  if (context) {
    configureTextContext(context, style);
    metrics = context.measureText(text);
  }
  const hasFontBounds = metrics && Number.isFinite(metrics.fontBoundingBoxAscent) && Number.isFinite(metrics.fontBoundingBoxDescent);
  const ascent = hasFontBounds ? metrics.fontBoundingBoxAscent : size * 0.8;
  const descent = hasFontBounds ? metrics.fontBoundingBoxDescent : size * 0.2;
  const baseline = rect.top + (rect.height - ascent - descent) / 2 + ascent;
  const hasInkBounds = metrics && Number.isFinite(metrics.actualBoundingBoxAscent) && Number.isFinite(metrics.actualBoundingBoxDescent);
  const top = baseline - (hasInkBounds ? metrics.actualBoundingBoxAscent : size * 0.72);
  const bottom = baseline + (hasInkBounds ? metrics.actualBoundingBoxDescent : size * 0.18);
  const horizontal = metrics && Number.isFinite(metrics.actualBoundingBoxLeft) && Number.isFinite(metrics.actualBoundingBoxRight);
  // Preserve the browser's shaping/letter-spacing advances while removing only
  // leading/trailing glyph bearings. Rect.width is authoritative for layout.
  const left = rect.left - (horizontal ? metrics.actualBoundingBoxLeft : 0);
  const right = rect.right - (horizontal ? metrics.width - metrics.actualBoundingBoxRight : 0);
  return { left, right, top, bottom, baseline, size, width: right - left, height: bottom - top };
}

function textLines(element, styleOf) {
  const document = element.ownerDocument;
  if (!document.createRange) return null;
  const range = document.createRange();
  if (!range.getClientRects) return null;
  const context = metricContext(document);
  const lines = [];
  const walk = node => {
    if (node.nodeType === 1) {
      if (node !== element && (node.matches(EXCLUDED) || node.matches(BOX_SELECTOR) || paintedBox(styleOf(node)))) return;
      Array.from(node.childNodes).forEach(walk);
      return;
    }
    if (node.nodeType !== 3 || !node.nodeValue.trim()) return;
    const style = styleOf(node.parentElement);
    if (style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.opacity) === 0) return;
    const source = node.nodeValue;
    const start = source.search(/\S/);
    const end = source.length - (source.match(/\s*$/) || [""])[0].length;
    range.setStart(node, start);
    range.setEnd(node, end);
    const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
    let offset = start;
    rects.forEach((lineRect, index) => {
      let lineEnd = end;
      if (index < rects.length - 1) {
        // Find the last character laid out on this line without measuring every
        // glyph individually. This stays cheap for long wrapped paragraphs.
        let low = offset + 1;
        let high = end;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          range.setStart(node, offset);
          range.setEnd(node, middle);
          const partial = Array.from(range.getClientRects()).filter(rect => rect.width > 0);
          const last = partial[partial.length - 1];
          if (!last || last.top <= lineRect.top + 1) low = middle;
          else high = middle - 1;
        }
        lineEnd = low;
      }
      const segment = source.slice(offset, lineEnd);
      const leading = (segment.match(/^\s*/) || [""])[0].length;
      const trailing = (segment.match(/\s*$/) || [""])[0].length;
      if (segment.trim()) {
        range.setStart(node, offset + leading);
        range.setEnd(node, lineEnd - trailing);
        const rect = Array.from(range.getClientRects()).find(item => item.width > 0);
        if (rect) {
          let text = segment.trim().replace(/\s+/g, " ");
          if (style.textTransform === "uppercase") text = text.toUpperCase();
          else if (style.textTransform === "lowercase") text = text.toLowerCase();
          else if (style.textTransform === "capitalize") text = text.replace(/(^|\s)\S/g, value => value.toUpperCase());
          const measured = inkRect(rect, text, style, context);
          const raster = getTextInkProfile(document, text, style, rect, measured.baseline);
          const ink = raster ? { ...measured, ...raster } : measured;
          let line = lines.find(item => Math.abs(item.baseline - ink.baseline) <= Math.max(2, Math.min(item.size, ink.size) * 0.12));
          if (!line) {
            line = { ...ink, fragments: [] };
            lines.push(line);
          }
          line.fragments.push({ ...ink, element: node.parentElement });
        }
      }
      offset = lineEnd;
    });
  };
  walk(element);
  if (range.detach) range.detach();
  const segments = [];
  lines.sort((a, b) => a.baseline - b.baseline).forEach(line => {
    let segment = null;
    line.fragments.sort((a, b) => a.left - b.left).forEach(fragment => {
      // Flex captions and card headings can share a baseline while being far
      // apart. Never turn the empty space between them into a text platform.
      if (!segment || fragment.left - segment.right > Math.max(8, Math.max(fragment.size, segment.size) * 0.8)) {
        segment = { ...fragment, fragments: [] };
        segments.push(segment);
      }
      segment.right = Math.max(segment.right, fragment.right);
      segment.fragments.push(fragment);
    });
  });
  return segments;
}

export function getRobotSurfaces(scopeElement) {
  if (!scopeElement) return [];
  const view = scopeElement.ownerDocument.defaultView;
  const scopeRect = scopeElement.getBoundingClientRect();
  const styles = new Map();
  const styleOf = element => {
    if (!styles.has(element)) styles.set(element, view.getComputedStyle(element));
    return styles.get(element);
  };
  const surfaces = [];
  const edges = new Map();

  function visibleBounds(element, rect, clipSelf = false, profile = false) {
    if (![rect.left, rect.right, rect.top, rect.bottom].every(Number.isFinite) || rect.height < 0.5) return null;
    let left = Math.max(rect.left, scopeRect.left);
    let right = Math.min(rect.right, scopeRect.right);
    let clipTopEdge = -Infinity;
    let clipBottomEdge = Infinity;
    let current = element;
    while (current && current.nodeType === 1) {
      if (current.matches(EXCLUDED)) return null;
      if (current.tagName === "DETAILS" && !current.open) {
        const summary = Array.from(current.children).find(child => child.tagName === "SUMMARY");
        if (!summary || !summary.contains(element)) return null;
      }
      const style = styleOf(current);
      if (style.display === "none" || style.visibility === "hidden" ||
          style.visibility === "collapse" || Number.parseFloat(style.opacity) === 0) return null;
      if ((current !== element || clipSelf) && current !== scopeElement) {
        const clipX = CLIPS.test(style.overflowX || style.overflow);
        const clipY = CLIPS.test(style.overflowY || style.overflow);
        if (clipX || clipY) {
          const parentRect = current.getBoundingClientRect();
          const clipLeft = parentRect.left + current.clientLeft;
          const clipTop = parentRect.top + current.clientTop;
          if (clipX) {
            left = Math.max(left, clipLeft);
            right = Math.min(right, clipLeft + current.clientWidth);
          }
          if (clipY) {
            clipTopEdge = Math.max(clipTopEdge, clipTop);
            clipBottomEdge = Math.min(clipBottomEdge, clipTop + current.clientHeight);
            if (!profile && (rect.top < clipTop - 0.5 || rect.top >= clipTop + current.clientHeight)) return null;
          }
        }
      }
      if (current === scopeElement) break;
      current = current.parentElement;
    }
    return right > left ? { left, right, clipTopEdge, clipBottomEdge } : null;
  }

  function add(surface) {
    if (surface.width < 28) return;
    const edge = [surface.left, surface.right, surface.top].map(value => Math.round(value * 2)).join(":");
    if (edges.has(edge)) {
      const index = edges.get(edge);
      if ((surface.kind === "image" && surface.profile) ||
          (surface.element.matches(EXPLICIT) && !surfaces[index].element.matches(EXPLICIT))) surfaces[index] = surface;
    } else {
      edges.set(edge, surfaces.length);
      surfaces.push(surface);
    }
  }

  Array.from(scopeElement.querySelectorAll(SURFACE_SELECTOR)).forEach(element => {
    // Explicit platforms provide one top edge; their contents add no perches.
    if (element.matches("[data-robot-platform] *")) return;
    if (!element.getClientRects().length) return;
    const rect = element.getBoundingClientRect();
    const text = isText(element, styleOf);
    if (text) {
      if (textOwner(element, scopeElement, styleOf) !== element) return;
      const lines = textLines(element, styleOf);
      if (lines) {
        lines.forEach((line, index) => {
          const fragments = line.fragments.map(fragment => {
            const visible = visibleBounds(fragment.element, fragment, true, Boolean(fragment.profile));
            if (!visible) return null;
            if (!fragment.profile) return { ...fragment, ...visible };
            const profile = fragment.profile.filter(point => point.x >= visible.left && point.x <= visible.right &&
              point.y >= visible.clipTopEdge - 0.5 && point.y < visible.clipBottomEdge);
            if (!profile.length) return null;
            const supports = [];
            profile.forEach(point => {
              const left = Math.max(visible.left, point.x - fragment.sampleWidth / 2);
              const right = Math.min(visible.right, point.x + fragment.sampleWidth / 2);
              const last = supports[supports.length - 1];
              if (last && left <= last.right + 0.001) last.right = Math.max(last.right, right);
              else supports.push({ left, right });
            });
            return { ...fragment, ...visible, profile, supports, left: supports[0].left,
              right: supports[supports.length - 1].right, top: Math.min(...profile.map(point => point.y)),
              bottom: Math.min(fragment.bottom, visible.clipBottomEdge) };
          }).filter(Boolean);
          if (!fragments.length) return;
          const left = Math.min(...fragments.map(fragment => fragment.left));
          const right = Math.max(...fragments.map(fragment => fragment.right));
          const top = Math.min(...fragments.map(fragment => fragment.top));
          const bottom = Math.max(...fragments.map(fragment => fragment.bottom));
          const surface = { element, kind: "text", key: `text-line-${index}`, left: left - scopeRect.left, right: right - scopeRect.left,
            top: top - scopeRect.top, bottom: bottom - scopeRect.top, width: right - left, height: bottom - top };
          if (fragments.some(fragment => fragment.profile)) {
            const profile = [];
            const supports = [];
            fragments.forEach(fragment => {
              profile.push(...(fragment.profile || [{ x: fragment.left, y: fragment.top }, { x: fragment.right, y: fragment.top }]));
              supports.push(...(fragment.supports || [{ left: fragment.left, right: fragment.right }]));
            });
            surface.profile = [];
            profile.sort((a, b) => a.x - b.x).forEach(point => {
              const mapped = { x: point.x - scopeRect.left, y: point.y - scopeRect.top };
              const last = surface.profile[surface.profile.length - 1];
              if (last && mapped.x - last.x < 0.00001) last.y = Math.min(last.y, mapped.y);
              else surface.profile.push(mapped);
            });
            surface.supports = [];
            supports.sort((a, b) => a.left - b.left).forEach(interval => {
              const left = interval.left - scopeRect.left;
              const right = interval.right - scopeRect.left;
              const last = surface.supports[surface.supports.length - 1];
              if (last && left <= last.right + 0.001) last.right = Math.max(last.right, right);
              else surface.supports.push({ left, right });
            });
          }
          add(surface);
        });
        return;
      }
      // Very old layout engines can lack Range geometry; never create a broad
      // platform for an empty wrapper, even in that fallback.
      if (!element.textContent.trim()) return;
    }
    if (element.tagName === "IMG" && element.hasAttribute("data-robot-contour")) {
      getImageSurfaces(element, scopeRect).forEach(image => {
        const visible = visibleBounds(element, { left: image.left + scopeRect.left, right: image.right + scopeRect.left,
          top: image.top + scopeRect.top, bottom: image.bottom + scopeRect.top, height: image.height });
        if (!visible) return;
        const left = Math.max(image.left, visible.left - scopeRect.left);
        const right = Math.min(image.right, visible.right - scopeRect.left);
        add({ ...image, left, right, width: right - left });
      });
      return;
    }
    let boxRect = rect;
    const style = styleOf(element);
    if (element.matches(".site-header,.hero-footnote,.footer-bottom") && !paintedBox(style)) {
      const border = Number.parseFloat(style.borderBottomWidth);
      if (!(border > 0) || style.borderBottomStyle === "none" || style.borderBottomColor === "transparent" || /rgba\([^)]*,\s*0(?:\.0+)?\s*\)/.test(style.borderBottomColor)) return;
      boxRect = { left: rect.left, right: rect.right, top: rect.bottom - border, bottom: rect.bottom, width: rect.width, height: border };
    }
    const visible = visibleBounds(element, boxRect);
    if (!visible) return;
    if (element.querySelector("img[data-robot-contour]") && !element.matches(BOX_SELECTOR) && !paintedBox(styleOf(element))) return;
    add({ element, key: "box", kind: "box", left: visible.left - scopeRect.left, right: visible.right - scopeRect.left,
      top: boxRect.top - scopeRect.top, bottom: boxRect.bottom - scopeRect.top, width: visible.right - visible.left, height: boxRect.height });
  });
  return surfaces;
}
