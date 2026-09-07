import { getSurfaceHeight, getWalkingHeight, getSurfaceSlope, getStandingPoint, advanceAlongSurface, hasSurfaceSupport, splitSurfaceAtCliffs } from "./robotTerrain";

const portrait = {
  left: 0, right: 100, top: 30, width: 100,
  profile: [{ x: 0, y: 90 }, { x: 30, y: 90 }, { x: 40, y: 30 }, { x: 100, y: 30 }],
};

test("uses the shoulder and hair contour at the requested horizontal position", () => {
  expect(getSurfaceHeight(portrait, 15)).toBe(90);
  expect(getSurfaceHeight(portrait, 35)).toBe(60);
  expect(getStandingPoint(portrait, 70)).toEqual({ x: 70, y: 30 });
  expect(getSurfaceHeight(portrait, -10)).toBe(90);
  expect(getSurfaceHeight(portrait, 110)).toBe(30);
});

test("a steep edge uses actual walking distance in both directions", () => {
  const uphillX = advanceAlongSurface(portrait, 30, 80, 5);
  const downhillX = advanceAlongSurface(portrait, 40, 20, 5);
  expect(Math.hypot(uphillX - 30, getSurfaceHeight(portrait, uphillX) - 90)).toBeCloseTo(5);
  expect(Math.hypot(downhillX - 40, getSurfaceHeight(portrait, downhillX) - 30)).toBeCloseTo(5);
  expect(uphillX).toBeLessThan(31);
  expect(downhillX).toBeGreaterThan(39);
});

test("crosses contour segments without overshooting its destination", () => {
  expect(advanceAlongSurface(portrait, 28, 80, 2 + Math.hypot(10, 60) + 10)).toBeCloseTo(50);
  expect(advanceAlongSurface(portrait, 30, 80, 1000)).toBe(80);
  expect(advanceAlongSurface(portrait, 80, 30, 1000)).toBe(30);
  expect(advanceAlongSurface(portrait, 30, 80, 0)).toBe(30);
});

test("flat page surfaces retain their height and ordinary walking speed", () => {
  const panel = { left: 10, right: 210, width: 200, top: 160 };
  expect(getStandingPoint(panel, 100)).toEqual({ x: 100, y: 160 });
  expect(advanceAlongSurface(panel, 100, 200, 3)).toBe(103);
  expect(advanceAlongSurface(panel, 100, 101, 3)).toBe(101);
});

test("whitespace is not support and resting points move onto visible letters", () => {
  const text = { left: 0, right: 100, width: 100, top: 20, supports: [{ left: 0, right: 35 }, { left: 60, right: 100 }] };
  expect(hasSurfaceSupport(text, 45)).toBe(false);
  expect(hasSurfaceSupport(text, 70)).toBe(true);
  expect(hasSurfaceSupport(text, getStandingPoint(text, 45).x)).toBe(true);
});

test("shoulders and hair become distinct ledges at vertical overhangs", () => {
  const image = { element: {}, kind: "image", key: "image-outline", left: 0, right: 220, width: 220, top: 20, bottom: 240, height: 220,
    profile: [{x:0,y:220}, {x:49,y:200}, {x:50,y:25}, {x:170,y:20}, {x:171,y:200}, {x:220,y:220}] };
  const ledges = splitSurfaceAtCliffs(image);
  expect(ledges.length).toBe(3);
  expect(ledges.map(ledge => [ledge.left, ledge.right])).toEqual([[0,49], [50,170], [171,220]]);
  expect(ledges[0].element).toBe(image.element);
  expect(new Set(ledges.map(ledge => ledge.key)).size).toBe(3);
  expect(splitSurfaceAtCliffs({ ...image, width: 45 })).toHaveLength(1);
});


function sampledSurface(kind, width, heightAt) {
  return { kind, left: 0, right: width, top: 20, width, height: 80,
    profile: Array.from({ length: width + 1 }, (_, x) => ({ x, y: heightAt(x) })) };
}

test("walking crosses narrow glyph holes while raw resting contact stays on the actual ink", () => {
  const text = sampledSurface("text", 100, x => x >= 40 && x <= 45 ? 58 : 20);
  expect(getSurfaceHeight(text, 42)).toBe(58);
  expect(getStandingPoint(text, 42).y).toBe(58);
  expect(getWalkingHeight(text, 42)).toBeCloseTo(20);
  expect(getWalkingHeight(text, 25)).toBeCloseTo(20);
});

test("pixel-level glyph steps no longer slow every other walking frame", () => {
  const text = sampledSurface("text", 200, x => 20 + (x % 2) * 2);
  let x = 20;
  for (let frame = 0; frame < 100; frame += 1) {
    const next = advanceAlongSurface(text, x, 180, 0.4);
    expect(next - x).toBeCloseTo(0.4, 6);
    x = next;
  }
  expect(x).toBeCloseTo(60, 6);
  expect(getSurfaceHeight(text, 21)).toBe(22);
  expect(getSurfaceSlope(text, 30)).toBeCloseTo(0);
});

test("walking bridges a deep comma and following space before the next capital", () => {
  const text = sampledSurface("text", 140, x => x >= 45 && x <= 83 ? 72 : 20);
  for (let x = 40; x < 90; x += 0.4) expect(getWalkingHeight(text, x)).toBeCloseTo(20);
  expect(getSurfaceHeight(text, 60)).toBe(72);
  expect(getStandingPoint(text, 60).y).toBe(72);
});

test("broad letter-height changes survive the stance envelope with smooth transitions", () => {
  const text = sampledSurface("text", 140, x => x >= 40 && x <= 100 ? 34 : 20);
  expect(getWalkingHeight(text, 15)).toBeCloseTo(20);
  expect(getWalkingHeight(text, 70)).toBeCloseTo(34);
  let previous = getWalkingHeight(text, 30);
  for (let x = 30.4; x <= 60; x += 0.4) {
    const y = getWalkingHeight(text, x);
    expect(Math.abs(y - previous)).toBeLessThan(1);
    previous = y;
  }
});

test("image pixel staircases get gentle smoothing without erasing the large slope", () => {
  const image = sampledSurface("image", 140, x => 20 + x * 0.2 + (x % 2) * 0.5);
  const steps = [];
  let x = 25;
  for (let frame = 0; frame < 100; frame += 1) {
    const next = advanceAlongSurface(image, x, 120, 0.4);
    steps.push(next - x);
    x = next;
  }
  expect(Math.max(...steps) - Math.min(...steps)).toBeLessThan(0.01);
  expect(getWalkingHeight(image, 100) - getWalkingHeight(image, 30)).toBeCloseTo(14, 1);
});

test("image smoothing preserves genuine cliff endpoints and distinct ledges", () => {
  const image = { kind: "image", left: 0, right: 220, width: 220, top: 20, bottom: 240, height: 220,
    profile: [{ x: 0, y: 220 }, { x: 49, y: 200 }, { x: 50, y: 25 }, { x: 170, y: 20 }, { x: 171, y: 200 }, { x: 220, y: 220 }] };
  expect(getWalkingHeight(image, 49)).toBe(200);
  expect(getWalkingHeight(image, 50)).toBe(25);
  expect(getWalkingHeight(image, 170)).toBe(20);
  expect(getWalkingHeight(image, 171)).toBe(200);
  expect(splitSurfaceAtCliffs(image)).toHaveLength(3);
});

test("cached curved travel is reversible, clamps at the target, and refreshes with a changed profile", () => {
  const text = sampledSurface("text", 180, x => 25 + 10 * Math.sin(x / 22));
  const end = advanceAlongSurface(text, 35, 130, 24);
  expect(advanceAlongSurface(text, end, 35, 24)).toBeCloseTo(35, 8);
  expect(advanceAlongSurface(text, end, end + 0.1, 24)).toBe(end + 0.1);
  expect(getWalkingHeight(text, 90)).not.toBe(50);
  text.profile = [{ x: 0, y: 50 }, { x: 180, y: 50 }];
  expect(getWalkingHeight(text, 90)).toBeCloseTo(50);
  expect(advanceAlongSurface(text, 35, 130, 24)).toBeCloseTo(59);
});
