import { getTextInkProfile, traceTextAlpha } from "./robotTextSurface";

function paint(data, width, left, top, right, bottom, alpha = 255) {
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) data[(y * width + x) * 4 + 3] = alpha;
}

test("traces the different tops of capitals and lowercase glyphs without bridging spaces", () => {
  const width = 16;
  const data = new Uint8ClampedArray(width * 14 * 4);
  paint(data, width, 1, 2, 4, 12);
  paint(data, width, 9, 6, 14, 12);
  paint(data, width, 0, 0, 1, 1, 30); // Faint antialiasing is not a floating perch.
  const result = traceTextAlpha(data, width, 14);
  expect(result.supports).toEqual([{ left: 1, right: 4 }, { left: 9, right: 14 }]);
  expect(result.columns[0]).toEqual({ x: 1.5, y: 2, bottom: 12 });
  expect(result.columns[3]).toEqual({ x: 9.5, y: 6, bottom: 12 });
  expect(result.columns.every((point, index) => !index || point.x > result.columns[index - 1].x)).toBe(true);
});

function canvasDocument() {
  const canvases = [];
  const listeners = {};
  const document = {
    defaultView: { CanvasRenderingContext2D: function () {} },
    fonts: { status: "loaded", addEventListener: (name, listener) => { listeners[name] = listener; } },
    createElement() {
      const canvas = { width: 0, height: 0 };
      const context = {
        letterSpacing: "0px", wordSpacing: "0px", fontKerning: "auto", fontStretch: "normal", fontVariantCaps: "normal",
        measureText: () => ({ width: 40, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 38,
          fontBoundingBoxAscent: 18, fontBoundingBoxDescent: 6, actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 3 }),
        scale: jest.fn(), fillText: jest.fn(),
        getImageData: jest.fn(() => {
          const data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
          // Raster scale is 2. Distinct glyph tops, separated by a full space.
          paint(data, canvas.width, 6, 8, 20, 42);
          paint(data, canvas.width, 44, 20, 74, 42);
          return { data };
        }),
      };
      canvas.getContext = () => context;
      canvases.push({ canvas, context });
      return canvas;
    },
  };
  return { document, canvases, listeners };
}

const style = { fontSize: "24px", fontFamily: "sans-serif", fontWeight: "400", letterSpacing: "-1px", wordSpacing: "2px", fontKerning: "normal" };

test("maps cached glyph contours and support gaps to moving DOM ranges without rereading pixels", () => {
  const { document, canvases } = canvasDocument();
  const first = getTextInkProfile(document, "Hi m", style, { left: 100, width: 80 }, 200);
  expect(first.supports).toEqual([{ left: 102, right: 116 }, { left: 140, right: 170 }]);
  expect(first.profile[0]).toEqual({ x: 102.5, y: 184 });
  expect(first.profile[14]).toEqual({ x: 140.5, y: 190 });
  expect(canvases[0].context.letterSpacing).toBe("-1px");
  expect(canvases[0].context.wordSpacing).toBe("2px");
  const moved = getTextInkProfile(document, "Hi m", style, { left: 125, width: 80 }, 260);
  expect(canvases).toHaveLength(1);
  expect(canvases[0].context.getImageData).toHaveBeenCalledTimes(1);
  expect(moved.profile[0]).toEqual({ x: first.profile[0].x + 25, y: first.profile[0].y + 60 });
});

test("font, spacing, text, and width changes invalidate cached contours", () => {
  const { document, canvases, listeners } = canvasDocument();
  getTextInkProfile(document, "Hi m", style, { left: 100, width: 80 }, 200);
  getTextInkProfile(document, "Hi m", { ...style, letterSpacing: "0px" }, { left: 100, width: 80 }, 200);
  getTextInkProfile(document, "Hi m", { ...style, fontWeight: "700" }, { left: 100, width: 80 }, 200);
  getTextInkProfile(document, "Hi m", style, { left: 100, width: 90 }, 200);
  getTextInkProfile(document, "Hi n", style, { left: 100, width: 80 }, 200);
  expect(canvases).toHaveLength(5);
  listeners.loadingdone();
  getTextInkProfile(document, "Hi m", style, { left: 100, width: 80 }, 200);
  expect(canvases).toHaveLength(6);
});
