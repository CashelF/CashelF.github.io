import { getRobotSurfaces } from "./robotSurfaces";
import { jsdom } from "jsdom";
import { getImageSurfaces } from "./robotImageSurface";
import * as textSurface from "./robotTextSurface";

jest.mock("./robotImageSurface", () => ({ getImageSurfaces: jest.fn(() => []) }));

const document = jsdom("<!doctype html><html><body></body></html>");

function box(element, left, top, width = 120, height = 24) {
  const rect = { left, top, width, height, right: left + width, bottom: top + height };
  element.getBoundingClientRect = () => rect;
  element.getClientRects = () => width && height ? [rect] : [];
  Object.defineProperty(element, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: height });
}

function page(markup) {
  const scope = document.createElement("main");
  scope.innerHTML = markup;
  document.body.appendChild(scope);
  box(scope, 100, -200, 600, 2000);
  return scope;
}

afterEach(() => { document.body.innerHTML = ""; getImageSurfaces.mockReset(); getImageSurfaces.mockReturnValue([]); });

test("discovers headings, navigation, brain panels and contact controls across the page", () => {
  const scope = page('<nav><a id="nav">Brain</a></nav><h1 id="hero">Cash</h1><div class="brain-console" id="brain"></div><button id="send">Send</button><textarea id="input"></textarea><a id="contact">Say hello</a>');
  ["nav", "hero", "brain", "send", "input", "contact"].forEach((id, index) => {
    box(scope.querySelector(`#${id}`), 140, index * 100);
  });
  const surfaces = getRobotSurfaces(scope);
  expect(surfaces.map(surface => surface.element.id)).toEqual(["nav", "hero", "brain", "send", "input", "contact"]);
  expect(surfaces[1]).toMatchObject({ left: 40, right: 160, top: 300, width: 120 });
});

test("does not perch on hidden content, the robot, or tiny visualization internals", () => {
  const scope = page('<div hidden><h2 id="hidden">Hidden</h2></div><div style="opacity:0"><p id="transparent">Hidden</p></div><div class="site-robot"><button id="robot">Marvin</button></div><div class="brain-scene"><button id="layer">Layer</button></div><details><a id="closed">Closed</a></details><p id="visible">Visible</p>');
  scope.querySelectorAll("h2,p,a,button").forEach((element, index) => box(element, 140, index * 100));
  expect(getRobotSurfaces(scope).map(surface => surface.element.id)).toEqual(["visible"]);
});

test("project platforms offer one full top edge while ordinary page text remains walkable", () => {
  const scope = page('<a class="project" data-robot-platform="card"><img /><h3>Project</h3><p>Description</p></a><h2>More work</h2>');
  const project = scope.querySelector(".project");
  box(project, 140, 100, 300, 400);
  Array.from(project.children).forEach((element, index) => box(element, 150, 110 + index * 90, 280, 70));
  box(scope.querySelector("h2"), 140, 550);
  const surfaces = getRobotSurfaces(scope);
  expect(surfaces).toHaveLength(2);
  expect(surfaces[0]).toMatchObject({ element: project, kind: "box", key: "box", left: 40, right: 340, top: 300, width: 300 });
  expect(surfaces[0].profile).toBeUndefined();
  expect(surfaces[1].element).toBe(scope.querySelector("h2"));
});

test("refreshes opened disclosures without losing element identities", () => {
  const scope = page('<h2 id="heading">Projects</h2><details><summary id="summary">More</summary><a id="archive">Experiment</a></details>');
  const heading = scope.querySelector("#heading");
  const archive = scope.querySelector("#archive");
  const summary = scope.querySelector("#summary");
  box(heading, 140, 100);
  box(summary, 140, 160);
  // Browsers can retain layout rectangles for unpainted disclosure content.
  box(archive, 140, 200);
  expect(getRobotSurfaces(scope).map(surface => surface.element)).toEqual([heading, summary]);
  scope.querySelector("details").open = true;
  box(archive, 140, 200);
  expect(getRobotSurfaces(scope).map(surface => surface.element)).toEqual([heading, summary, archive]);
});

test("uses only visible top edges inside scroll and clipping containers", () => {
  const scope = page('<div id="clip" style="overflow:hidden"><a id="above">Above</a><a id="inside">Inside</a></div>');
  box(scope.querySelector("#clip"), 160, 200, 100, 100);
  box(scope.querySelector("#above"), 140, 190, 140, 30);
  box(scope.querySelector("#inside"), 140, 240, 140, 30);
  const surfaces = getRobotSurfaces(scope);
  expect(surfaces.map(surface => surface.element.id)).toEqual(["inside"]);
  expect(surfaces[0]).toMatchObject({ left: 60, right: 160, width: 100, top: 440 });
});

test("deduplicates a shared image edge and remeasures fixed navigation after scrolling", () => {
  const scope = page('<figure><img data-robot-target="Cash" id="portrait" alt="Cash" /></figure><a id="fixed" style="position:fixed">Navigation</a>');
  box(scope.querySelector("figure"), 150, 100, 200, 200);
  box(scope.querySelector("img"), 150, 100, 200, 200);
  box(scope.querySelector("#fixed"), 450, 50);
  expect(getRobotSurfaces(scope).map(surface => surface.element.id)).toEqual(["portrait", "fixed"]);
  box(scope, 100, -500, 600, 2000);
  expect(getRobotSurfaces(scope)[1].top).toBe(550);
});

// A deterministic layout engine for geometry tests: each character has a real
// line rectangle, and Canvas reports separate font-box and painted-ink bounds.
function textPage(markup) {
  const doc = jsdom("<!doctype html><html><body></body></html>");
  const scope = doc.createElement("main");
  scope.innerHTML = markup;
  doc.body.appendChild(scope);
  box(scope, 100, -200, 600, 2000);
  doc.defaultView.CanvasRenderingContext2D = function () {};
  const createElement = doc.createElement.bind(doc);
  doc.createElement = tag => tag === "canvas" ? { getContext: () => ({
    measureText: text => ({ width: text.length * 10, fontBoundingBoxAscent: 38, fontBoundingBoxDescent: 10,
      actualBoundingBoxAscent: 28, actualBoundingBoxDescent: 8, actualBoundingBoxLeft: -2, actualBoundingBoxRight: text.length * 10 - 1 }),
  }) } : createElement(tag);
  doc.createRange = () => {
    let text;
    let start;
    let end;
    return {
      setStart(node, offset) { text = node; start = offset; },
      setEnd(node, offset) { end = offset; },
      getClientRects() {
        const rows = [];
        (text.testGlyphs || []).slice(start, end).forEach(glyph => {
          let row = rows.find(item => item.top === glyph.top);
          if (!row) { row = { ...glyph }; rows.push(row); }
          else { row.right = Math.max(row.right, glyph.right); row.width = row.right - row.left; }
        });
        return rows;
      },
    };
  };
  return scope;
}

function glyphs(node, lines) {
  node.testGlyphs = [];
  lines.forEach(line => {
    for (let index = 0; index < line.text.length; index += 1) {
      const left = line.left + index * 10;
      node.testGlyphs.push({ left, right: left + 10, top: line.top, bottom: line.top + 48, width: 10, height: 48 });
    }
  });
}

test("perches on painted glyph ink instead of the heading's full line box", () => {
  const scope = textPage('<h1 style="font-size:40px;line-height:80px">Cash</h1>');
  const heading = scope.querySelector("h1");
  box(heading, 130, 100, 500, 80);
  glyphs(heading.firstChild, [{ text: "Cash", left: 140, top: 110 }]);
  expect(getRobotSurfaces(scope)).toEqual([expect.objectContaining({
    element: heading, key: "text-line-0", kind: "text", left: 42, right: 79, top: 320, bottom: 356, width: 37, height: 36,
  })]);
});

test("wrapped headings get separate stable perches with each line's visible width", () => {
  const scope = textPage('<h1 style="font-size:40px">Cash learns</h1>');
  const heading = scope.querySelector("h1");
  box(heading, 130, 100, 500, 160);
  glyphs(heading.firstChild, [{ text: "Cash ", left: 140, top: 110 }, { text: "learns", left: 140, top: 190 }]);
  const surfaces = getRobotSurfaces(scope);
  expect(surfaces.map(surface => ({ key: surface.key, width: surface.width, top: surface.top }))).toEqual([
    { key: "text-line-0", width: 37, top: 320 }, { key: "text-line-1", width: 57, top: 400 },
  ]);
  box(scope, 100, -300, 600, 2000);
  expect(getRobotSurfaces(scope).map(surface => surface.key)).toEqual(surfaces.map(surface => surface.key));
});

test("inline spans and links merge under one text owner without a blank parent edge", () => {
  const scope = textPage('<p style="font-size:40px">Hello <span style="font-size:40px">Cash</span><a style="font-size:40px"> friend</a></p>');
  const paragraph = scope.querySelector("p");
  box(paragraph, 130, 100, 500, 80);
  box(scope.querySelector("span"), 200, 110, 40, 48);
  box(scope.querySelector("a"), 240, 110, 70, 48);
  glyphs(paragraph.firstChild, [{ text: "Hello ", left: 140, top: 110 }]);
  glyphs(scope.querySelector("span").firstChild, [{ text: "Cash", left: 200, top: 110 }]);
  glyphs(scope.querySelector("a").firstChild, [{ text: " friend", left: 240, top: 110 }]);
  expect(getRobotSurfaces(scope)).toEqual([expect.objectContaining({ element: paragraph, left: 42, right: 209, top: 320 })]);
});

test("clips text per line and keeps a line whose ink is visible below a clipped font box", () => {
  const scope = textPage('<p style="font-size:40px;overflow:hidden">Cash learns</p>');
  const paragraph = scope.querySelector("p");
  box(paragraph, 150, 120, 70, 100);
  glyphs(paragraph.firstChild, [{ text: "Cash ", left: 140, top: 110 }, { text: "learns", left: 140, top: 220 }]);
  expect(getRobotSurfaces(scope)).toEqual([expect.objectContaining({ key: "text-line-0", left: 50, right: 79, top: 320, width: 29 })]);
});

test("keeps real button and painted panel edges instead of measuring only their label", () => {
  const scope = textPage('<button>Send</button><a style="background-color:rgb(20, 30, 20)">Contact</a>');
  Array.from(scope.children).forEach((element, index) => box(element, 140, 100 + index * 80, 120, 48));
  expect(getRobotSurfaces(scope).map(surface => ({ kind: surface.kind, width: surface.width, top: surface.top }))).toEqual([
    { kind: "box", width: 120, top: 300 }, { kind: "box", width: 120, top: 380 },
  ]);
});

test("uses the image contour without offering the transparent portrait wrapper as a perch", () => {
  const scope = page('<figure><img data-robot-contour id="portrait" /></figure>');
  const portrait = scope.querySelector("img");
  box(scope.querySelector("figure"), 150, 100, 200, 200);
  box(portrait, 150, 100, 200, 200);
  const outline = { element: portrait, key: "image-outline", kind: "image", left: 90, right: 200, top: 350, bottom: 480,
    width: 110, height: 130, profile: [{ x: 90, y: 360 }, { x: 140, y: 350 }, { x: 200, y: 370 }] };
  const shoulder = { ...outline, key: "image-alpha-ledge-0", top: 440, left: 70, right: 150, width: 80,
    profile: [{ x: 70, y: 470 }, { x: 150, y: 440 }] };
  getImageSurfaces.mockReturnValue([outline, shoulder]);
  expect(getRobotSurfaces(scope)).toEqual([outline, shoulder]);
  getImageSurfaces.mockReturnValue([]);
  expect(getRobotSurfaces(scope)).toEqual([]);
});


test("text columns on a shared baseline never make a perch over their empty gap", () => {
  const scope = textPage('<figcaption style="font-size:40px"><span style="font-size:40px">Cash</span><span style="font-size:40px">Zomma</span></figcaption>');
  const caption = scope.querySelector("figcaption");
  box(caption, 130, 100, 500, 80);
  const spans = scope.querySelectorAll("span");
  box(spans[0], 140, 110, 40, 48);
  box(spans[1], 440, 110, 50, 48);
  glyphs(spans[0].firstChild, [{ text: "Cash", left: 140, top: 110 }]);
  glyphs(spans[1].firstChild, [{ text: "Zomma", left: 440, top: 110 }]);
  expect(getRobotSurfaces(scope).map(surface => ({ key: surface.key, left: surface.left, right: surface.right }))).toEqual([
    { key: "text-line-0", left: 42, right: 79 }, { key: "text-line-1", left: 342, right: 389 },
  ]);
});


test("structural headers offer their painted bottom border rather than an invisible top edge", () => {
  const scope = page('<header class="site-header" style="border-bottom:1px solid black"></header>');
  box(scope.firstChild, 100, 0, 600, 110);
  expect(getRobotSurfaces(scope)).toEqual([expect.objectContaining({ element: scope.firstChild, kind: "box", top: 309, bottom: 310, height: 1 })]);
});


test("merges inline glyph contours with strictly ordered points and no support across whitespace", () => {
  const scope = textPage('<h1 style="font-size:40px">Cash <span style="font-size:40px">Zomma</span></h1>');
  const heading = scope.querySelector("h1");
  const span = scope.querySelector("span");
  box(heading, 130, 100, 500, 80);
  box(span, 160, 110, 50, 48);
  glyphs(heading.firstChild, [{ text: "Cash ", left: 140, top: 110 }]);
  glyphs(span.firstChild, [{ text: "Zomma", left: 160, top: 110 }]);
  const raster = jest.spyOn(textSurface, "getTextInkProfile").mockImplementation((doc, text) => {
    const profile = text === "Cash"
      ? [{ x: 141, y: 120 }, { x: 142, y: 122 }, { x: 143, y: 121 }, { x: 160, y: 130 }]
      : [{ x: 160, y: 125 }, { x: 161, y: 127 }, { x: 180, y: 120 }];
    const left = profile[0].x - 0.5;
    const right = profile[profile.length - 1].x + 0.5;
    return { profile, sampleWidth: 1, left, right, top: 120, bottom: 150, width: right - left, height: 30 };
  });
  try {
    const surface = getRobotSurfaces(scope)[0];
    expect(surface.profile).toEqual([{ x: 41, y: 320 }, { x: 42, y: 322 }, { x: 43, y: 321 }, { x: 60, y: 325 }, { x: 61, y: 327 }, { x: 80, y: 320 }]);
    expect(surface.supports).toEqual([{ left: 40.5, right: 43.5 }, { left: 59.5, right: 61.5 }, { left: 79.5, right: 80.5 }]);
  } finally { raster.mockRestore(); }
});
