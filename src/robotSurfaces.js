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

  Array.from(scopeElement.querySelectorAll(SURFACE_SELECTOR)).forEach(element => {
    if (!element.getClientRects().length) return;
    const rect = element.getBoundingClientRect();
    if (![rect.left, rect.right, rect.top, rect.bottom].every(Number.isFinite) ||
        rect.width < 28 || rect.height < 1) return;

    let left = Math.max(rect.left, scopeRect.left);
    let right = Math.min(rect.right, scopeRect.right);
    let current = element;
    // Clipped-away tops are not platforms. In particular this excludes closed
    // disclosures and content scrolled above the edge of an inner scrollbox.
    while (current && current.nodeType === 1) {
      if (current.matches(EXCLUDED)) return;
      if (current.tagName === "DETAILS" && !current.open) {
        const summary = Array.from(current.children).find(child => child.tagName === "SUMMARY");
        if (!summary || !summary.contains(element)) return;
      }
      const style = styleOf(current);
      if (style.display === "none" || style.visibility === "hidden" ||
          style.visibility === "collapse" || Number.parseFloat(style.opacity) === 0) return;
      if (current !== element && current !== scopeElement) {
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
          if (clipY && (rect.top < clipTop - 0.5 || rect.top >= clipTop + current.clientHeight)) return;
        }
      }
      if (current === scopeElement) break;
      current = current.parentElement;
    }
    if (right - left < 28) return;

    const surface = {
      element,
      left: left - scopeRect.left,
      right: right - scopeRect.left,
      top: rect.top - scopeRect.top,
      bottom: rect.bottom - scopeRect.top,
      width: right - left,
      height: rect.height,
    };
    // An image and its link/figure often share the exact same top edge.
    // Prefer an explicitly named target, while keeping stable document order.
    const edge = [surface.left, surface.right, surface.top].map(value => Math.round(value * 2)).join(":");
    if (edges.has(edge)) {
      const index = edges.get(edge);
      if (element.matches(EXPLICIT) && !surfaces[index].element.matches(EXPLICIT)) surfaces[index] = surface;
    } else {
      edges.set(edge, surfaces.length);
      surfaces.push(surface);
    }
  });
  return surfaces;
}
