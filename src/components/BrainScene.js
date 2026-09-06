import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three/build/three";
import { marvinArchitecture } from "../marvinStream";
import { useTheme } from "../siteTheme";
import BrainOverview from "./BrainOverview";
import { brainPalette, makeStructure, measuredNode as measurement } from "./BrainStructure";
import "./BrainScene.css";

const INITIAL_ROTATION = { x: -0.08, y: -0.2 };

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function brainDimensions(frame, config) {
  const architecture = marvinArchitecture(frame, config);
  const internals = frame && frame.internals;
  const queryHeads = Math.floor(
    clamp(
      (internals && internals.headCount) || architecture.queryHeads,
      1,
      128,
    ),
  );
  const kvHeads =
    queryHeads % architecture.kvHeads === 0 ? architecture.kvHeads : 1;
  return {
    layers: Math.floor(
      clamp(
        (frame && frame.activations && frame.activations.length) ||
          Number(config && config.num_layers) ||
          architecture.layers,
        1,
        128,
      ),
    ),
    queryHeads,
    kvHeads,
    channels: Math.floor(
      clamp(
        (internals &&
          internals.neuronIndices &&
          internals.neuronIndices.length) ||
          32,
        1,
        128,
      ),
    ),
    mlpWidth: architecture.mlpWidth,
  };
}

function FlatView({ frame, selectedLayer, queryHeads, kvHeads, channels, theme }) {
  const palette = brainPalette(theme);
  const ink = new THREE.Color(palette.ink);
  const accent = new THREE.Color(palette.accent);
  const nodes = [];
  const paths = [];
  const queriesPerKv = queryHeads / kvHeads;
  const groupY = index => kvHeads === 1 ? 90 : 35 + (index / (kvHeads - 1)) * 110;
  function node(kind, index, x, y, radius) {
    const detail = measurement(frame, selectedLayer, { kind, index });
    const color = new THREE.Color().copy(ink).lerp(accent,
      detail ? Math.min(1, 0.15 + detail.value / (1 + detail.value)) : 0);
    nodes.push(
      <circle key={`${kind}-${index}`} cx={x} cy={y} r={radius} fill={`#${color.getHexString()}`}>
        <title>{detail ? `${detail.title} · RMS ${detail.value.toPrecision(4)}` : `${kind} ${index + 1} · awaiting measurement`}</title>
      </circle>
    );
  }
  for (let group = 0; group < kvHeads; group += 1) {
    const y = groupY(group);
    node("key", group, 110, y, 2.2);
    node("value", group, 135, y, 2.2);
    paths.push(<path key={`shared-${group}`} d={`M30 90 L110 ${y} M30 90 L135 ${y} L175 ${y} H215`} />);
    for (let offset = 0; offset < queriesPerKv; offset += 1) {
      const head = group * queriesPerKv + offset;
      const headY = y + (offset - (queriesPerKv - 1) / 2) * 6;
      node("query", head, 80, headY, 2.2);
      node("head", head, 230, headY, 3.8);
      paths.push(<path key={`head-${head}`} d={`M30 90 L80 ${headY} H230 L310 90 M215 ${y} L230 ${headY}`} />);
    }
  }
  for (let index = 0; index < channels; index += 1) {
    const y = 35 + Math.floor(index / 4) * (110 / Math.max(1, Math.ceil(channels / 4) - 1));
    const x = 405 + (index % 4) * 10;
    node("neuron", index, x, y, 2.5);
    paths.push(<path key={`neuron-${index}`} d={`M330 90 L${x} ${y} L500 90`} />);
  }
  node("output", 0, 550, 90, 3.8);
  return (
    <svg className="brain-scene__flat" viewBox="0 0 580 195" role="img"
      aria-label={`Block ${selectedLayer + 1}. QKV projections, ${queryHeads} query heads sharing ${kvHeads} key/value pairs, MLP and residuals. Two-dimensional fallback.`}>
      <g fill="none" stroke={palette.guide} strokeOpacity="0.22" strokeWidth="0.8">{paths}</g>
      <g fill="none" stroke={palette.residual} strokeOpacity="0.65" strokeWidth="1">
        <path d="M30 90 V12 H310 V90 H330 M310 90 V12 H530 V90 M500 90 H550" />
        <circle cx="310" cy="90" r="6" /><circle cx="530" cy="90" r="6" />
        <path d="M307 90 H313 M310 87 V93 M527 90 H533 M530 87 V93" />
      </g>
      {nodes}
      <g fill={palette.label} fontSize="10" textAnchor="middle">
        <text x="108" y="170">Q / K / V</text>
        <text x="232" y="170">Grouped attention</text>
        <text x="425" y="170">MLP</text>
        <text x="232" y="183" fontSize="8">{queryHeads} Q · {kvHeads} KV</text>
        <text className="brain-scene__flat-detail" x="425" y="183" fontSize="8">{channels} sampled channels</text>
      </g>
    </svg>
  );
}

/** No activity is generated here; only actual forward-pass measurements color nodes. */
export default function BrainScene({
  frame = null,
  config = null,
  className = "",
}) {
  const { theme } = useTheme();
  const containerRef = useRef(null);
  const mountRef = useRef(null);
  const labelsRef = useRef(null);
  const controllerRef = useRef(null);
  const dimensions = brainDimensions(frame, config);
  const { layers, queryHeads, kvHeads, channels, mlpWidth } = dimensions;
  const architecture = marvinArchitecture(frame, config);
  const [selectedLayer, setSelectedLayer] = useState(13);
  const layer = Math.min(selectedLayer, layers - 1);
  const latestRef = useRef({ frame, config, layer, theme });
  const [fallback, setFallback] = useState(false);
  const [tooltip, setTooltip] = useState(null);
  latestRef.current = { frame, config, layer, theme };

  useEffect(() => {
    const mount = mountRef.current;
    const container = containerRef.current;
    if (!mount || !container) return undefined;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "low-power",
      });
    } catch (error) {
      setFallback(true);
      return undefined;
    }
    renderer.setClearColor(0xf0efea, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.setAttribute("aria-hidden", "true");
    mount.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-5, 5, 2.5, -2.5, 0.1, 100);
    camera.position.set(5, 1.7, 13);
    camera.lookAt(0, 0.08, 0);
    const pivot = new THREE.Group();
    scene.add(pivot);
    const rotation = { ...INITIAL_ROTATION };
    const structure = makeStructure({ queryHeads, kvHeads, channels, theme: latestRef.current.theme });
    setFallback(false);
    pivot.add(structure.group);
    let requestId = null;
    let visible = true;
    let disposed = false;
    let contextLost = false;
    let pointer = null;
    let highlightGroup = null;
    const raycaster = new THREE.Raycaster();
    const pointerCoordinates = new THREE.Vector2();
    raycaster.params.Points.threshold = 0.09;
    const motionQuery = window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
    let reducedMotion = motionQuery ? motionQuery.matches : false;

    function placeLabels() {
      if (!labelsRef.current) return;
      Array.from(labelsRef.current.children).forEach((element) => {
        const anchor = structure.anchors[element.getAttribute("data-anchor")];
        if (!anchor) return;
        const projected = anchor.clone();
        pivot.localToWorld(projected);
        projected.project(camera);
        element.style.left = `${(projected.x * 0.5 + 0.5) * mount.clientWidth}px`;
        element.style.top = element.classList.contains("brain-scene__primary-label")
          ? `${mount.clientHeight + 2}px`
          : `${(-projected.y * 0.5 + 0.5) * mount.clientHeight}px`;
      });
    }
    function draw() {
      requestId = null;
      if (disposed || contextLost || !visible || document.hidden) return;
      const difference =
        Math.abs(rotation.x - pivot.rotation.x) +
        Math.abs(rotation.y - pivot.rotation.y);
      if (reducedMotion || difference < 0.001)
        pivot.rotation.set(rotation.x, rotation.y, 0);
      else {
        pivot.rotation.x += (rotation.x - pivot.rotation.x) * 0.28;
        pivot.rotation.y += (rotation.y - pivot.rotation.y) * 0.28;
      }
      renderer.render(scene, camera);
      placeLabels();
      if (!reducedMotion && difference > 0.001) schedule();
    }
    function schedule() {
      if (
        !disposed &&
        !contextLost &&
        visible &&
        !document.hidden &&
        requestId === null
      )
        requestId = window.requestAnimationFrame(draw);
    }
    function updateFrame() {
      const latest = latestRef.current;
      structure.update(
        latest.frame,
        latest.layer,
        renderer.getPixelRatio(),
        mount.clientWidth,
        highlightGroup,
      );
      schedule();
    }
    function resize() {
      const width = Math.max(1, mount.clientWidth);
      const height = Math.max(1, mount.clientHeight);
      const aspect = width / height;
      const halfHeight = Math.max(1.55, 4.7 / aspect);
      camera.left = -halfHeight * aspect;
      camera.right = halfHeight * aspect;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      updateFrame();
    }
    function reset() {
      setTooltip(null);
      highlightGroup = null;
      updateFrame();
      rotation.x = INITIAL_ROTATION.x;
      rotation.y = INITIAL_ROTATION.y;
      schedule();
    }
    function onPointerDown(event) {
      if (event.button !== undefined && event.button !== 0) return;
      pointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        distance: 0,
      };
      setTooltip(null);
      if (mount.setPointerCapture) mount.setPointerCapture(event.pointerId);
      mount.classList.add("is-dragging");
    }
    function onPointerMove(event) {
      if (!pointer) {
        inspectPoint(event);
        return;
      }
      if (pointer.id !== event.pointerId) return;
      pointer.distance +=
        Math.abs(event.clientX - pointer.x) +
        Math.abs(event.clientY - pointer.y);
      rotation.y = clamp(
        rotation.y + (event.clientX - pointer.x) * 0.007,
        -1.05,
        0.65,
      );
      rotation.x = clamp(
        rotation.x + (event.clientY - pointer.y) * 0.005,
        -0.65,
        0.65,
      );
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      schedule();
    }
    function onPointerUp(event) {
      if (!pointer || pointer.id !== event.pointerId) return;
      const wasTap = pointer.distance < 5 && event.type === "pointerup";
      pointer = null;
      mount.classList.remove("is-dragging");
      if (mount.hasPointerCapture && mount.hasPointerCapture(event.pointerId))
        mount.releasePointerCapture(event.pointerId);
      if (wasTap) inspectPoint(event);
    }
    function inspectPoint(event) {
      const latest = latestRef.current;
      if (contextLost) return;
      const rect = mount.getBoundingClientRect();
      pointerCoordinates.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointerCoordinates, camera);
      const hits = raycaster.intersectObject(structure.nodes, false);
      const hit = hits.find(
        (item) => structure.descriptors[item.index].kind !== "guide",
      );
      const descriptor = hit ? structure.descriptors[hit.index] : null;
      const nextGroup = descriptor && typeof descriptor.group === "number" ? descriptor.group : null;
      if (highlightGroup !== nextGroup) {
        highlightGroup = nextGroup;
        updateFrame();
      }
      const detail = hit
        ? measurement(
            latest.frame,
            latest.layer,
            structure.descriptors[hit.index],
          )
        : null;
      setTooltip(
        detail
          ? {
              ...detail,
              layer: latest.layer + 1,
              x: clamp(event.clientX - rect.left + 14, 8, rect.width - 154),
              y: clamp(event.clientY - rect.top - 63, 8, rect.height - 71),
            }
          : null,
      );
    }
    function onPointerLeave(event) {
      if (event.pointerType !== "touch") {
        setTooltip(null);
        highlightGroup = null;
        updateFrame();
      }
    }
    function onKeyDown(event) {
      if (event.key === "Escape") setTooltip(null);
      const keys = {
        ArrowLeft: [-0.14, 0],
        ArrowRight: [0.14, 0],
        ArrowUp: [0, -0.1],
        ArrowDown: [0, 0.1],
      };
      if (event.key === "Home") {
        event.preventDefault();
        reset();
      } else if (keys[event.key]) {
        event.preventDefault();
        setTooltip(null);
        rotation.y = clamp(rotation.y + keys[event.key][0], -1.05, 0.65);
        rotation.x = clamp(rotation.x + keys[event.key][1], -0.65, 0.65);
        schedule();
      }
    }
    function onVisibilityChange() {
      if (document.hidden && requestId !== null) {
        window.cancelAnimationFrame(requestId);
        requestId = null;
      } else schedule();
    }
    function onMotionChange(event) {
      reducedMotion = event.matches;
      schedule();
    }
    function onContextLost(event) {
      event.preventDefault();
      contextLost = true;
      setFallback(true);
      setTooltip(null);
      if (requestId !== null) window.cancelAnimationFrame(requestId);
      requestId = null;
    }
    function onContextRestored() {
      contextLost = false;
      setFallback(false);
      updateFrame();
    }
    const resizeObserver = window.ResizeObserver
      ? new window.ResizeObserver(resize)
      : null;
    if (resizeObserver) resizeObserver.observe(mount);
    window.addEventListener("resize", resize);
    const intersectionObserver = window.IntersectionObserver
      ? new window.IntersectionObserver(
          (entries) => {
            visible = entries[0].isIntersecting;
            if (!visible && requestId !== null) {
              window.cancelAnimationFrame(requestId);
              requestId = null;
            } else if (visible) schedule();
          },
          { rootMargin: "80px" },
        )
      : null;
    if (intersectionObserver) intersectionObserver.observe(container);
    if (motionQuery && motionQuery.addEventListener)
      motionQuery.addEventListener("change", onMotionChange);
    else if (motionQuery && motionQuery.addListener)
      motionQuery.addListener(onMotionChange);
    document.addEventListener("visibilitychange", onVisibilityChange);
    mount.addEventListener("pointerdown", onPointerDown);
    mount.addEventListener("pointermove", onPointerMove);
    mount.addEventListener("pointerup", onPointerUp);
    mount.addEventListener("pointercancel", onPointerUp);
    mount.addEventListener("lostpointercapture", onPointerUp);
    mount.addEventListener("pointerleave", onPointerLeave);
    mount.addEventListener("keydown", onKeyDown);
    renderer.domElement.addEventListener("webglcontextlost", onContextLost);
    renderer.domElement.addEventListener(
      "webglcontextrestored",
      onContextRestored,
    );
    controllerRef.current = { updateFrame, reset, updateTheme(nextTheme) { structure.updateTheme(nextTheme); schedule(); }, clearHighlight() { highlightGroup = null; updateFrame(); } };
    pivot.rotation.set(rotation.x, rotation.y, 0);
    resize();
    return () => {
      disposed = true;
      controllerRef.current = null;
      if (requestId !== null) window.cancelAnimationFrame(requestId);
      if (resizeObserver) resizeObserver.disconnect();
      if (intersectionObserver) intersectionObserver.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (motionQuery && motionQuery.removeEventListener)
        motionQuery.removeEventListener("change", onMotionChange);
      else if (motionQuery && motionQuery.removeListener)
        motionQuery.removeListener(onMotionChange);
      mount.removeEventListener("pointerdown", onPointerDown);
      mount.removeEventListener("pointermove", onPointerMove);
      mount.removeEventListener("pointerup", onPointerUp);
      mount.removeEventListener("pointercancel", onPointerUp);
      mount.removeEventListener("lostpointercapture", onPointerUp);
      mount.removeEventListener("pointerleave", onPointerLeave);
      mount.removeEventListener("keydown", onKeyDown);
      renderer.domElement.removeEventListener(
        "webglcontextlost",
        onContextLost,
      );
      renderer.domElement.removeEventListener(
        "webglcontextrestored",
        onContextRestored,
      );
      structure.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (mount.contains(renderer.domElement))
        mount.removeChild(renderer.domElement);
    };
  }, [queryHeads, kvHeads, channels]);

  useEffect(() => {
    if (controllerRef.current) controllerRef.current.updateTheme(theme);
  }, [theme]);

  useEffect(() => {
    setTooltip(null);
    if (controllerRef.current) controllerRef.current.updateFrame();
  }, [frame]);

  useEffect(() => {
    setTooltip(null);
    if (controllerRef.current) controllerRef.current.clearHighlight();
  }, [config, layer]);

  function selectLayer(event, index) {
    const keys = {
      ArrowLeft: -1,
      ArrowRight: 1,
      Home: -index,
      End: layers - 1 - index,
    };
    if (keys[event.key] === undefined) return;
    event.preventDefault();
    const next = clamp(index + keys[event.key], 0, layers - 1);
    setSelectedLayer(next);
    const button = containerRef.current.querySelector(`[data-layer="${next}"]`);
    if (button) button.focus();
  }
  return (
    <div
      ref={containerRef}
      className={`brain-scene${fallback ? " brain-scene--flat" : ""} ${className}`}
    >
      <BrainOverview
        frame={frame}
        layers={layers}
        layer={layer}
        hiddenSize={architecture.hiddenSize}
        setSelectedLayer={setSelectedLayer}
        selectLayer={selectLayer}
      />
      <div className="brain-scene__topline">
        <span>
          Block <strong>{String(layer + 1).padStart(2, "0")}</strong>
          <span className="brain-scene__layer-total"> / {layers}</span>
        </span>
        {!fallback && (
          <button
            type="button"
            className="brain-scene__reset"
            onClick={() =>
              controllerRef.current && controllerRef.current.reset()
            }
            aria-label="Reset 3D view"
            title="Reset view"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 20 20"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M3.5 7.5a6.5 6.5 0 1 1 .2 5.5M3.5 3.5v4.2h4.2"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
      <div className="brain-scene__viewport">
        <div
          ref={mountRef}
          className="brain-scene__canvas"
          role="img"
          aria-hidden={fallback || undefined}
          tabIndex={fallback ? -1 : 0}
          aria-label={`Transformer layer ${layer + 1}. ${queryHeads} query heads share ${kvHeads} key and value heads, followed by ${channels} sampled MLP channels and residual bypasses. Measured nodes, schematic connections. Drag or use arrow keys to rotate; Home resets the view.`}
          aria-describedby={tooltip ? "marvin-activation-detail" : undefined}
        />
        {fallback && (
          <FlatView
            theme={theme}
            frame={frame}
            selectedLayer={layer}
            queryHeads={queryHeads}
            kvHeads={kvHeads}
            channels={channels}
          />
        )}
        {!fallback && (
          <div
            ref={labelsRef}
            className="brain-scene__labels"
            aria-hidden="true"
          >
            <span data-anchor="qkv" className="brain-scene__primary-label">Q / K / V</span>
            <span data-anchor="query" className="brain-scene__micro-label">Q</span>
            <span data-anchor="key" className="brain-scene__micro-label">K</span>
            <span data-anchor="value" className="brain-scene__micro-label">V</span>
            <span data-anchor="attention" className="brain-scene__primary-label">
              <span className="brain-scene__wide-label">Grouped attention</span>
              <span className="brain-scene__compact-label">GQA</span>
              <small>{queryHeads} Q · {kvHeads} KV</small>
            </span>
            <span data-anchor="mlp" className="brain-scene__primary-label">
              MLP <small>{channels} / {mlpWidth.toLocaleString("en-US")} channels</small>
            </span>
            <span data-anchor="residual1" className="brain-scene__residual-label">residual</span>
            <span data-anchor="residual2" className="brain-scene__residual-label">residual</span>
          </div>
        )}
        {tooltip && !fallback && (
          <div
            id="marvin-activation-detail"
            className="brain-scene__detail"
            role="tooltip"
            style={{ left: tooltip.x, top: tooltip.y }}
          >
            <div>
              <span>{tooltip.title}</span>
              <span>L{tooltip.layer}</span>
            </div>
            <p>
              <span>RMS</span>
              <strong>{tooltip.value.toPrecision(4)}</strong>
            </p>
          </div>
        )}
      </div>

    </div>
  );
}
