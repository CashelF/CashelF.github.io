import { getRobotSurfaces } from "./robotSurfaces";
import { jsdom } from "jsdom";

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

afterEach(() => { document.body.innerHTML = ""; });

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
