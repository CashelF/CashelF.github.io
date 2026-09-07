import { getImageSurface, getImageSurfaces } from "./robotImageSurface";
import { jsdom } from "jsdom";

const document = jsdom("<!doctype html><html><body></body></html>");
const scope = { left: 100, top: 100, right: 1000 };
let originalCreateElement;
let originalGetComputedStyle;
let context;
let alpha;

function silhouette() {
  const data = new Uint8ClampedArray(20 * 20 * 4);
  for (let x = 2; x <= 17; x++) {
    const top = x >= 7 && x <= 12 ? 3 : x >= 5 && x <= 14 ? 10 : 14;
    for (let y = top; y < 20; y++) data[(y * 20 + x) * 4 + 3] = 255;
  }
  // A detached group of opaque pixels must not become a floating ledge.
  [0, 1, 20, 21].forEach(index => { data[index * 4 + 3] = 255; });
  return data;
}

function portrait(width = 200, height = 200) {
  const image = originalCreateElement.call(document, "img");
  image.src = "https://cashel.dev/cashel_animated.png";
  image.setAttribute("data-robot-contour", "true");
  image.style.width = `${width}px`;
  image.style.height = `${height}px`;
  image.style.objectFit = "contain";
  image.style.objectPosition = "50% 50%";
  Object.defineProperty(image, "complete", { configurable: true, value: true });
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: 20 });
  Object.defineProperty(image, "naturalHeight", { configurable: true, value: 20 });
  image.getBoundingClientRect = () => ({ left: 100, top: 300, width, height, right: 100 + width, bottom: 300 + height });
  document.body.appendChild(image);
  return image;
}

beforeEach(() => {
  originalGetComputedStyle = document.defaultView.getComputedStyle;
  // This repository’s jsdom predates object-fit/object-position support.
  document.defaultView.getComputedStyle = element => element.style;
  alpha = silhouette();
  context = { drawImage: jest.fn(), getImageData: jest.fn(() => ({ data: alpha })) };
  originalCreateElement = document.createElement;
  document.createElement = function createElement(tagName) {
    if (tagName === "canvas") return { width: 0, height: 0, getContext: () => context };
    return originalCreateElement.call(this, tagName);
  };
});

afterEach(() => {
  document.createElement = originalCreateElement;
  document.defaultView.getComputedStyle = originalGetComputedStyle;
  document.body.innerHTML = "";
});

test("follows the visible shoulders and hair, rejecting detached alpha pixels", () => {
  const image = portrait();
  const surface = getImageSurface(image, scope);
  expect(surface).toMatchObject({ element: image, kind: "image", key: "image-outline", left: 25, right: 175, top: 230, bottom: 400 });
  expect(surface.profile[0].y).toBe(340);
  expect(surface.profile.find(point => point.x === 95).y).toBe(230);
  expect(surface.profile.every((point, index, points) => !index || point.x > points[index - 1].x)).toBe(true);
});

test("maps contain/object-position into current CSS geometry without re-reading pixels", () => {
  const image = portrait(400, 200);
  image.style.objectPosition = "25% 75%";
  expect(getImageSurface(image, scope).left).toBe(75);
  image.style.width = "600px";
  image.getBoundingClientRect = () => ({ left: 100, top: 300, width: 600, height: 200, right: 700, bottom: 500 });
  expect(getImageSurface(image, scope).left).toBe(125);
  expect(context.drawImage).toHaveBeenCalledTimes(1);
  expect(context.getImageData).toHaveBeenCalledTimes(1);
});

test("excludes padding and borders from the painted image content", () => {
  const image = portrait(440, 240);
  image.style.boxSizing = "border-box";
  image.style.border = "10px solid black";
  image.style.padding = "10px";
  const surface = getImageSurface(image, scope);
  expect(surface.left).toBe(145);
  expect(surface.top).toBe(250);
  expect(surface.bottom).toBe(420);
});

test("clips cover silhouettes to the visible image box and scope", () => {
  const image = portrait(100, 200);
  image.style.objectFit = "cover";
  const surface = getImageSurface(image, { left: 100, top: 100, right: 175 });
  expect(surface.left).toBe(0);
  expect(surface.right).toBe(75);
  expect(surface.profile.every(point => point.x >= 0 && point.x <= 75 && point.y >= 200 && point.y <= 400)).toBe(true);
});

test("supports edge offsets and computed calc positions", () => {
  const image = portrait(400, 200);
  image.style.objectPosition = "right 10px bottom 20px";
  expect(getImageSurface(image, scope).left).toBe(215);
  image.style.objectPosition = "calc(100% - 10px) calc(50% + 0px)";
  expect(getImageSurface(image, scope).left).toBe(215);
});

test("returns null for opaque images, unloaded images, and images without opt-in", () => {
  const opaque = portrait();
  alpha = new Uint8ClampedArray(20 * 20 * 4).fill(255);
  expect(getImageSurface(opaque, scope)).toBe(null);
  const loading = portrait();
  Object.defineProperty(loading, "complete", { value: false });
  expect(getImageSurface(loading, scope)).toBe(null);
  const regular = portrait();
  regular.removeAttribute("data-robot-contour");
  expect(getImageSurface(regular, scope)).toBe(null);
  expect(context.drawImage).toHaveBeenCalledTimes(1);
});

test("retries after loading and after a source change, but caches CORS failures", () => {
  const image = portrait();
  Object.defineProperty(image, "complete", { configurable: true, value: false });
  expect(getImageSurface(image, scope)).toBe(null);
  Object.defineProperty(image, "complete", { value: true });
  expect(getImageSurface(image, scope)).not.toBe(null);
  image.src = "https://example.com/blocked.png";
  context.getImageData.mockImplementation(() => { throw new Error("Canvas is tainted"); });
  expect(getImageSurface(image, scope)).toBe(null);
  expect(getImageSurface(image, scope)).toBe(null);
  expect(context.getImageData).toHaveBeenCalledTimes(2);
});


function concaveShoulders() {
  const data = new Uint8ClampedArray(20 * 20 * 4);
  const fill = (left, top, right, bottom) => {
    for (let x = left; x <= right; x++) {
      for (let y = top; y <= bottom; y++) data[(y * 20 + x) * 4 + 3] = 255;
    }
  };
  fill(2, 14, 17, 19); // Shoulders.
  fill(5, 3, 14, 8); // Overhanging hair.
  fill(9, 3, 10, 19); // Neck joins everything into one alpha component.
  return data;
}

test("includes visible shoulder runs underneath overhanging hair", () => {
  alpha = concaveShoulders();
  const image = portrait();
  const surfaces = getImageSurfaces(image, scope);
  expect(surfaces.map(surface => surface.key)).toEqual(["image-outline", "image-alpha-ledge-0", "image-alpha-ledge-1"]);
  expect(surfaces[1]).toMatchObject({ left: 25, right: 85, top: 340 });
  expect(surfaces[2]).toMatchObject({ right: 175, top: 340 });
  expect(surfaces[2].left).toBeCloseTo(115);
  expect(surfaces[1].profile.every(point => point.y === 340)).toBe(true);
  expect(getImageSurface(image, scope)).toEqual(surfaces[0]);
  expect(context.getImageData).toHaveBeenCalledTimes(1);
});

test("maps all shoulder ledges with object-position and keeps stable keys", () => {
  alpha = concaveShoulders();
  const image = portrait(400, 200);
  image.style.objectPosition = "25% 75%";
  const surfaces = getImageSurfaces(image, scope);
  expect(surfaces[1]).toMatchObject({ key: "image-alpha-ledge-0", left: 75, right: 135 });
  expect(surfaces[2]).toMatchObject({ key: "image-alpha-ledge-1", left: 165, right: 225 });
  image.style.objectPosition = "100% 0%";
  expect(getImageSurfaces(image, scope)[1]).toMatchObject({ key: "image-alpha-ledge-0", left: 225, right: 285 });
  expect(context.getImageData).toHaveBeenCalledTimes(1);
});

test("keeps only the useful outer silhouette on a tiny mobile portrait", () => {
  alpha = concaveShoulders();
  const image = portrait(45, 45);
  const surfaces = getImageSurfaces(image, scope);
  expect(surfaces.length).toBe(1);
  expect(surfaces[0].key).toBe("image-outline");
});

test("does not invent interior ledges in an ordinary uninterrupted silhouette", () => {
  expect(getImageSurfaces(portrait(), scope).map(surface => surface.key)).toEqual(["image-outline"]);
});
