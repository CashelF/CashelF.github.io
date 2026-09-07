import React from "react";
import { createPortal } from "react-dom";
import * as THREE from "three/build/three";
import { getRobotSurfaces } from "../robotSurfaces";
import { getStandingPoint, getSurfaceHeight, getWalkingHeight, getSurfaceSlope, advanceAlongSurface, splitSurfaceAtCliffs } from "../robotTerrain";
import { getFootingCorrection } from "../robotFooting";
import {
  useMarvin, generateMarvin, stopMarvin, registerMarvinSurface,
  setMarvinSurfaceEnabled, engageMarvinSurface, QUEUED_MESSAGE, marvinQueuePosition,
} from "../marvinStream";
import "../styles/SiteRobot.css";

if (typeof window !== "undefined") {
  window.THREE = THREE;
  require("three/examples/js/loaders/GLTFLoader");
}

const MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const MODEL_URL = `${process.env.PUBLIC_URL || ""}/models/marvin/Animated Robot.glb`;
const MODEL_BASE_YAW = -0.58;
const ROBOT_HEAD = { x: 12, y: -4 };
const UI_ANCHOR_OFFSET = { x: -18, y: -72 };
const MAX_TETHER_LENGTH = 196;
const ROBOT_DRAG_THRESHOLD = 7;
const MARVIN_ACCENT_DARK = new THREE.Color(0x3f3f46);

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sample(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function replaceYellowAccent(color) {
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  const isYellowHue = hsl.h >= 0.06 && hsl.h <= 0.18;
  const isAccent = hsl.s >= 0.22 && hsl.l >= 0.2;

  if (isYellowHue && isAccent) {
    color.copy(MARVIN_ACCENT_DARK);
  }
}

function isWarmAccentPixel(red, green, blue) {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  if (max < 70 || delta < 18) {
    return false;
  }

  let hue = 0;
  if (delta > 0) {
    if (max === red) {
      hue = ((green - blue) / delta) % 6;
    } else if (max === green) {
      hue = (blue - red) / delta + 2;
    } else {
      hue = (red - green) / delta + 4;
    }
  }

  hue *= 60;
  if (hue < 0) {
    hue += 360;
  }

  const saturation = max === 0 ? 0 : delta / max;
  const luminance = (max + min) / 510;

  return hue >= 28 && hue <= 72 && saturation >= 0.16 && luminance >= 0.16;
}

function remapYellowTexture(texture) {
  if (
    !texture ||
    texture.userData.marvinYellowRemapped ||
    typeof document === "undefined" ||
    !texture.image ||
    !texture.image.width ||
    !texture.image.height
  ) {
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = texture.image.width;
  canvas.height = texture.image.height;

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  context.drawImage(texture.image, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const alpha = data[index + 3];

    if (!alpha) {
      continue;
    }

    if (!isWarmAccentPixel(red, green, blue)) {
      continue;
    }

    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    const shade = clamp(Math.round(34 + luminance * 40), 34, 82);
    data[index] = shade;
    data[index + 1] = shade;
    data[index + 2] = Math.min(255, shade + 8);
  }

  context.putImageData(imageData, 0, 0);
  texture.image = canvas;
  texture.userData.marvinYellowRemapped = true;
  texture.needsUpdate = true;
}

function getScopeLayoutMetrics(scopeElement) {
  if (!scopeElement) {
    return { width: 0, height: 0 };
  }

  const rect = scopeElement.getBoundingClientRect();
  return {
    width: Math.ceil(rect.width || scopeElement.clientWidth || 0),
    height: Math.ceil(
      Math.max(
        rect.height || 0,
        scopeElement.scrollHeight || 0,
        scopeElement.offsetHeight || 0
      )
    ),
  };
}

function getJumpProfile(start, end) {
  const horizontalGap = Math.abs(end.x - start.x);
  const verticalRise = Math.max(0, start.y - end.y);
  const verticalDrop = Math.max(0, end.y - start.y);
  const sameLevel = Math.abs(end.y - start.y) < 18;

  if (sameLevel) {
    return {
      duration: clamp(760 + horizontalGap * 2.1, 760, 1160),
      height: clamp(24 + horizontalGap * 0.075, 24, 46),
    };
  }

  return {
    duration: clamp(920 + horizontalGap * 1.9 + verticalRise * 6.4 + verticalDrop * 2.2, 920, 1780),
    height: clamp(34 + horizontalGap * 0.065 + verticalRise * 0.95 + verticalDrop * 0.28, 34, 96),
  };
}

function clampPoseToLayout(pose, layout) {
  return {
    x: clamp(pose.x, 28, Math.max(28, layout.width - 28)),
    y: clamp(pose.y, 24, Math.max(24, layout.height - 12)),
  };
}

function wrapCoordinate(value, size) {
  if (!size) {
    return value;
  }

  return ((value % size) + size) % size;
}

function wrapPoseToLayout(pose, layout) {
  return {
    x: wrapCoordinate(pose.x, layout.width || 1),
    y: wrapCoordinate(pose.y, layout.height || 1),
  };
}

function getDisplayPose(motion, pose, layout) {
  const sourcePose = motion && motion.airbornePose ? motion.airbornePose : pose;
  const wrappedPose = wrapPoseToLayout(sourcePose, layout);
  return {
    ...sourcePose,
    ...wrappedPose,
  };
}

function resizeRenderer(renderer, camera, width, height) {
  if (!renderer || !camera || !width || !height) {
    return;
  }

  const requestedPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  let safePixelRatio = requestedPixelRatio;

  if (renderer.getContext) {
    const gl = renderer.getContext();
    if (gl) {
      const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
      const maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 0;
      const maxDimension = Math.min(
        maxTextureSize || Number.POSITIVE_INFINITY,
        maxRenderbufferSize || Number.POSITIVE_INFINITY
      );

      if (Number.isFinite(maxDimension) && maxDimension > 0) {
        const limitedByDimension = (maxDimension * 0.94) / Math.max(width, height);
        safePixelRatio = Math.min(requestedPixelRatio, limitedByDimension);
      }
    }
  }

  renderer.setPixelRatio(clamp(safePixelRatio, 0.5, requestedPixelRatio));
  renderer.setSize(width, height, false);
  camera.left = -width / 2;
  camera.right = width / 2;
  camera.top = height / 2;
  camera.bottom = -height / 2;
  camera.updateProjectionMatrix();
}

function normalizeClipName(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

function resolveClipBindings(clips, mixer) {
  const clipToAction = new Map();
  const used = new Set();
  const actionMap = {};
  const actionSpeedMap = {};
  const clipEntries = clips.map((clip, index) => ({
    clip,
    index,
    normalizedName: normalizeClipName(clip.name),
  }));

  const ensureAction = (clip) => {
    if (!clipToAction.has(clip)) {
      clipToAction.set(clip, mixer.clipAction(clip));
    }

    return clipToAction.get(clip);
  };

  const assignByPatterns = (key, patterns) => {
    let match;
    patterns.some(pattern => {
      match = clipEntries.find(({ clip, normalizedName }) => !used.has(clip) && normalizedName.includes(pattern));
      return Boolean(match);
    });

    if (!match) {
      return null;
    }

    used.add(match.clip);
    actionMap[key] = ensureAction(match.clip);
    return match.clip;
  };

  assignByPatterns("idle", ["idle", "standing", "stand", "breathe"]);
  assignByPatterns("walkJump", ["walkjump", "walk jump", "vault", "hop"]);
  assignByPatterns("jump", ["jump", "leap", "fall"]);
  assignByPatterns("walk", ["walking", "walk", "running", "run", "jog", "locomotion"]);
  assignByPatterns("wave", ["wave", "hello", "greet", "thumbs up", "thumbsup"]);

  if (!actionMap.walk && clipEntries.length === 1) {
    actionMap.walk = ensureAction(clipEntries[0].clip);
  }

  if (!actionMap.idle && clipEntries.length === 1 && actionMap.walk) {
    actionMap.idle = actionMap.walk;
  }

  if (!actionMap.jump && actionMap.walk) {
    actionMap.jump = actionMap.walk;
  }

  if (!actionMap.walkJump && (actionMap.jump || actionMap.walk)) {
    actionMap.walkJump = actionMap.jump || actionMap.walk;
  }

  actionSpeedMap.idle = actionMap.idle && actionMap.idle === actionMap.walk ? 0.2 : 1;
  actionSpeedMap.walk = 1;
  actionSpeedMap.walkJump = actionMap.walkJump && actionMap.walkJump === actionMap.walk ? 1.06 : 1;
  actionSpeedMap.jump = actionMap.jump && actionMap.jump === actionMap.walk ? 1.08 : 1;
  actionSpeedMap.wave = 1;

  return { actionMap, actionSpeedMap };
}

function fadeToAction(actionMap, activeActionRef, nextKey, actionSpeedMap) {
  const nextAction = actionMap[nextKey];
  if (!nextAction) {
    return;
  }

  const previous = activeActionRef.current;
  if (previous.action === nextAction && previous.key === nextKey) {
    return;
  }

  activeActionRef.current = {
    key: nextKey,
    action: nextAction,
  };
  nextAction.enabled = true;
  nextAction.setEffectiveTimeScale(actionSpeedMap[nextKey] || 1);
  nextAction.setEffectiveWeight(1);

  if (previous.action === nextAction) {
    nextAction.play();
    return;
  }

  nextAction.reset().fadeIn(0.24).play();

  if (previous.action) {
    previous.action.fadeOut(0.24);
  }
}

function snapToAction(actionMap, activeActionRef, nextKey, actionSpeedMap) {
  const nextAction = actionMap[nextKey];
  if (!nextAction) {
    return;
  }

  Array.from(new Set(Object.values(actionMap))).forEach((action) => {
    if (action !== nextAction) {
      action.stop();
    }
  });

  activeActionRef.current = {
    key: nextKey,
    action: nextAction,
  };
  nextAction.enabled = true;
  nextAction.reset();
  nextAction.setEffectiveTimeScale(actionSpeedMap[nextKey] || 1);
  nextAction.setEffectiveWeight(1);
  nextAction.play();
}

function getNearestCardIndex(cards, pose) {
  if (!cards.length) {
    return 0;
  }

  let bestIndex = 0;
  let bestScore = Infinity;

  cards.forEach((card, index) => {
    const standing = getStandingPoint(card, pose.x || card.left + card.width * 0.5);
    const score = Math.abs(standing.x - pose.x) + Math.abs(standing.y - pose.y) * 3.4;

    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function getSurfaceBelow(cards, pose, layoutWidth, layoutHeight) {
  if (!cards.length) {
    return null;
  }

  const overshootAllowance = 24;
  const horizontalLandingMargin = 18;
  const wrappedX = wrapCoordinate(pose.x, layoutWidth || 1);
  const candidates = cards
    .map((card, index) => {
      let downwardDelta = getStandingPoint(card, wrappedX).y - pose.y;
      if (downwardDelta < -overshootAllowance) {
        downwardDelta =
          wrapCoordinate(downwardDelta + overshootAllowance, layoutHeight || 1) -
          overshootAllowance;
      }

      return {
        card,
        index,
        downwardDelta,
      };
    })
    .filter(
      (item) =>
        wrappedX >= item.card.left - (item.card.profile ? 0 : horizontalLandingMargin) &&
        wrappedX <= item.card.right + (item.card.profile ? 0 : horizontalLandingMargin)
    );

  if (!candidates.length) {
    return null;
  }

  candidates.sort((left, right) => {
    return left.downwardDelta - right.downwardDelta;
  });

  const nextSurface = candidates[0];
  if (!nextSurface) {
    return null;
  }

  return {
    card: nextSurface.card,
    index: nextSurface.index,
    point: getStandingPoint(nextSurface.card, wrappedX),
    downwardDelta: nextSurface.downwardDelta,
    overshootAllowance,
  };
}

function getViewportSize() {
  return {
    width: window.innerWidth || 1280,
    height: window.innerHeight || 720,
  };
}

function getDefaultPanelPosition(side, head, panelSize) {
  return side === "left"
    ? { x: head.x - panelSize.width - 28, y: head.y - 194 }
    : { x: head.x + 28, y: head.y - 194 };
}

function clampPanelPosition(position, viewport, panelSize) {
  return {
    x: clamp(position.x, 16, Math.max(16, viewport.width - panelSize.width - 16)),
    y: clamp(position.y, 16, Math.max(16, viewport.height - panelSize.height - 16)),
  };
}

function getPanelAnchor(position, panelSize) {
  return {
    x: clamp(ROBOT_HEAD.x, position.x + 22, position.x + panelSize.width - 22),
    y: position.y + panelSize.height,
  };
}

function getConnectorPath(head, anchor) {
  const dx = anchor.x - head.x;
  const dy = anchor.y - head.y;
  const distance = Math.hypot(dx, dy) || 1;
  const sag = clamp(distance * 0.18, 18, 54);
  const lateralBias = clamp(dx * 0.08, -20, 20);
  const c1x = head.x + dx * 0.28 + lateralBias * 0.35;
  const c1y = head.y + dy * 0.1 + sag * 0.82;
  const c2x = anchor.x - dx * 0.28 + lateralBias * 0.2;
  const c2y = anchor.y - dy * 0.12 + sag * 0.82;

  return `M ${head.x} ${head.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${anchor.x} ${anchor.y}`;
}

function getTetherExcess(head, anchor) {
  const dx = anchor.x - head.x;
  const dy = anchor.y - head.y;
  const distance = Math.hypot(dx, dy);

  if (!distance || distance <= MAX_TETHER_LENGTH) {
    return { x: 0, y: 0 };
  }

  const overshoot = (distance - MAX_TETHER_LENGTH) / distance;
  return {
    x: dx * overshoot,
    y: dy * overshoot,
  };
}

function getRobotHeadViewport(scopeElement, pose) {
  if (!scopeElement) {
    return {
      x: UI_ANCHOR_OFFSET.x + ROBOT_HEAD.x,
      y: UI_ANCHOR_OFFSET.y + ROBOT_HEAD.y,
    };
  }

  const scopeRect = scopeElement.getBoundingClientRect();
  return {
    x: scopeRect.left + pose.x + UI_ANCHOR_OFFSET.x + ROBOT_HEAD.x,
    y: scopeRect.top + pose.y + UI_ANCHOR_OFFSET.y + ROBOT_HEAD.y,
  };
}

function getRobotHeadLayout(pose) {
  return {
    x: pose.x + UI_ANCHOR_OFFSET.x + ROBOT_HEAD.x,
    y: pose.y + UI_ANCHOR_OFFSET.y + ROBOT_HEAD.y,
  };
}

function getPoseFromHeadLayout(headLayout) {
  return {
    x: headLayout.x - UI_ANCHOR_OFFSET.x - ROBOT_HEAD.x,
    y: headLayout.y - UI_ANCHOR_OFFSET.y - ROBOT_HEAD.y,
  };
}

function getLayoutPointFromViewport(scopeElement, viewportPoint) {
  if (!scopeElement) {
    return viewportPoint;
  }

  const scopeRect = scopeElement.getBoundingClientRect();
  return {
    x: viewportPoint.x - scopeRect.left,
    y: viewportPoint.y - scopeRect.top,
  };
}

function getPoseFromHeadViewport(scopeElement, headViewport) {
  if (!scopeElement) {
    return {
      x: headViewport.x - UI_ANCHOR_OFFSET.x - ROBOT_HEAD.x,
      y: headViewport.y - UI_ANCHOR_OFFSET.y - ROBOT_HEAD.y,
    };
  }

  const scopeRect = scopeElement.getBoundingClientRect();
  return {
    x: headViewport.x - scopeRect.left - UI_ANCHOR_OFFSET.x - ROBOT_HEAD.x,
    y: headViewport.y - scopeRect.top - UI_ANCHOR_OFFSET.y - ROBOT_HEAD.y,
  };
}

export default function SiteRobot({ scopeRef }) {
  const mountRef = React.useRef(null);
  const walkerRef = React.useRef(null);
  const buttonRef = React.useRef(null);
  const avatarBoundsRef = React.useRef(new THREE.Box3());
  const footVertexRef = React.useRef(new THREE.Vector3());
  const groundingRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const cardsRef = React.useRef([]);
  const layoutRef = React.useRef({ width: 0, height: 0 });
  const poseRef = React.useRef({
    x: 0,
    y: 0,
    facingLeft: false,
    visible: false,
  });
  const motionRef = React.useRef({
    mode: "idle",
    cardIndex: 0,
    targetX: 0,
    nextActionAt: 0,
    pendingJump: null,
    jumpStart: null,
    jumpEnd: null,
    jumpStartAt: 0,
    jumpDuration: 1700,
    jumpHeight: 56,
    velocityX: 0,
    velocityY: 0,
    dragActive: false,
    airbornePose: null,
    landedAt: 0,
  });
  const threeRef = React.useRef({
    renderer: null,
    scene: null,
    camera: null,
    mixer: null,
    clock: null,
    characterPivot: null,
    actionMap: {},
    actionSpeedMap: {},
  });
  const activeActionRef = React.useRef({ key: null, action: null });
  const activeElementRef = React.useRef(null);
  const inputRef = React.useRef(null);
  const chatOpenRef = React.useRef(false);
  const focusOpenRef = React.useRef(false);
  const streamingRef = React.useRef(false);
  const panelPositionRef = React.useRef({ x: 40, y: 40 });
  const panelSizeRef = React.useRef({ width: 236, height: 154 });
  const dragStateRef = React.useRef(null);
  const robotDragStateRef = React.useRef(null);
  const suppressRobotClickRef = React.useRef(false);

  const marvin = useMarvin();
  const status = { online: marvin.health === "ready", text: marvin.health === "ready" ? "Online" : marvin.health === "offline" ? "Offline" : "Connecting" };
  const promptText = marvin.prompt;
  const replyText = marvin.text;
  const queued = marvin.phase === "queued";
  const streamMeta = { step: marvin.step, totalSteps: marvin.totalSteps, streaming: queued || marvin.phase === "connecting" || marvin.phase === "streaming" };
  const [reduceMotion, setReduceMotion] = React.useState(false);
  const [chatOpen, setChatOpen] = React.useState(false);
  const [focusOpen, setFocusOpen] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [visible, setVisible] = React.useState(false);
  const [bubbleSide, setBubbleSide] = React.useState("right");
  const [modelReady, setModelReady] = React.useState(false);
  const [webglUnavailable, setWebglUnavailable] = React.useState(false);
  const [panelPosition, setPanelPosition] = React.useState({ x: 40, y: 40 });
  const [panelSize, setPanelSize] = React.useState({ width: 236, height: 154 });
  const [robotHeadOverlay, setRobotHeadOverlay] = React.useState({ x: 0, y: 0 });

  React.useEffect(() => registerMarvinSurface(
    "robot", mountRef.current, false, () => panelRef.current,
  ), []);

  const pullMarvinByOffset = React.useCallback((offset) => {
    if (Math.abs(offset.x) < 0.5 && Math.abs(offset.y) < 0.5) {
      return;
    }

    motionRef.current.mode = "dangling";
    motionRef.current.dragActive = true;
    motionRef.current.velocityX += offset.x * 0.038;
    motionRef.current.velocityY += offset.y * 0.038;
    motionRef.current.targetX = poseRef.current.x;
    motionRef.current.nextActionAt = performance.now() + 180;
    motionRef.current.pendingJump = null;
    motionRef.current.jumpStart = null;
    motionRef.current.jumpEnd = null;
    motionRef.current.jumpStartAt = 0;
    motionRef.current.jumpHeight = 56;
    motionRef.current.airbornePose = motionRef.current.airbornePose || {
      x: poseRef.current.x,
      y: poseRef.current.y,
      facingLeft: poseRef.current.facingLeft,
      visible: true,
    };
  }, []);

  const clearActiveElement = React.useCallback(() => {
    if (activeElementRef.current) {
      activeElementRef.current.classList.remove("robot-bopped");
      activeElementRef.current = null;
    }
  }, []);

  const freezeMarvinForDrag = React.useCallback(() => {
    const motion = motionRef.current;

    motion.mode = "held";
    motion.targetX = poseRef.current.x;
    motion.nextActionAt = performance.now() + 160;
    motion.pendingJump = null;
    motion.jumpStart = null;
    motion.jumpEnd = null;
    motion.jumpStartAt = 0;
    motion.jumpHeight = 56;
    motion.velocityX = 0;
    motion.velocityY = 0;
    motion.dragActive = false;
    motion.airbornePose = {
      x: poseRef.current.x,
      y: poseRef.current.y,
      facingLeft: poseRef.current.facingLeft,
      visible: true,
    };

    snapToAction(
      threeRef.current.actionMap,
      activeActionRef,
      "idle",
      threeRef.current.actionSpeedMap
    );
  }, []);

  const measureLayout = React.useCallback(() => {
    const scopeElement = scopeRef && scopeRef.current;
    const mountElement = mountRef.current;
    const threeState = threeRef.current;

    if (!scopeElement || !mountElement) {
      return;
    }

    const previousLayout = layoutRef.current;
    const { width, height } = getScopeLayoutMetrics(scopeElement);
    const motion = motionRef.current;
    const previousCard = cardsRef.current[motion.cardIndex];
    const previousTarget = motion.pendingJump && cardsRef.current[motion.pendingJump.targetIndex];
    const measuredSurfaces = getRobotSurfaces(scopeElement).reduce((surfaces, surface) => surfaces.concat(splitSurfaceAtCliffs(surface)), []);
    // A shoulder ledge continues underneath the hair. Prefer its full path to
    // the shorter, overlapping part of the outer silhouette.
    cardsRef.current = measuredSurfaces.filter(surface => !(
      surface.kind === "image" && surface.key.indexOf("image-outline-section-") === 0 &&
      measuredSurfaces.some(ledge => ledge.element === surface.element && ledge.key.indexOf("image-alpha-ledge-") === 0 &&
        ledge.left <= surface.left + 8 && ledge.right >= surface.right - 8 && ledge.width > surface.width &&
        [0.2, 0.5, 0.8].every(fraction => {
          const x = surface.left + surface.width * fraction;
          return Math.abs(getSurfaceHeight(surface, x) - getSurfaceHeight(ledge, x)) < 4;
        }))
    ));
    layoutRef.current = { width, height };

    // The portal is outside main's stacking context; its drawing coordinates
    // still start at main's document position, including on deep-linked loads.
    const scopeRect = scopeElement.getBoundingClientRect();
    const portalStyle = {
      left: `${scopeRect.left + window.pageXOffset}px`,
      top: `${scopeRect.top + window.pageYOffset}px`,
      width: `${width}px`,
      height: `${height}px`,
    };
    Object.keys(portalStyle).forEach((key) => {
      if (mountElement.style[key] !== portalStyle[key]) mountElement.style[key] = portalStyle[key];
    });

    if (previousCard) {
      const standingIndex = cardsRef.current.findIndex((card) => card.element === previousCard.element && card.key === previousCard.key);
      motion.cardIndex = standingIndex >= 0 ? standingIndex : getNearestCardIndex(cardsRef.current, poseRef.current);
      const standingCard = cardsRef.current[motion.cardIndex];
      if (standingCard && (motion.mode === "idle" || motion.mode === "walking")) {
        motion.targetX = getStandingPoint(standingCard, motion.targetX).x;
      }
    }
    if (previousTarget) {
      const targetIndex = cardsRef.current.findIndex((card) => card.element === previousTarget.element && card.key === previousTarget.key);
      if (targetIndex >= 0) {
        motion.pendingJump.targetIndex = targetIndex;
        const targetCard = cardsRef.current[targetIndex];
        const landing = getStandingPoint(targetCard, motion.pendingJump.landingX);
        motion.pendingJump.landingX = landing.x;
        motion.pendingJump.settleX = getStandingPoint(targetCard, motion.pendingJump.settleX).x;
        if (motion.mode === "jumping") motion.jumpEnd = landing;
      } else {
        motion.pendingJump = null;
        if (motion.mode === "jumping") {
          motion.mode = "falling";
          motion.airbornePose = { ...poseRef.current };
          motion.velocityX = 0;
          motion.velocityY = 0;
        }
      }
    }

    if (
      width !== previousLayout.width ||
      height !== previousLayout.height
    ) {
      resizeRenderer(threeState.renderer, threeState.camera, width, height);
    }

    if (!poseRef.current.visible && cardsRef.current.length) {
      const viewportHeight = window.innerHeight || 800;
      const visibleIndex = cardsRef.current.findIndex((card) => (
        card.top + scopeRect.top >= 78 && card.top + scopeRect.top <= viewportHeight - 20
      ));
      const firstIndex = visibleIndex >= 0 ? visibleIndex : 0;
      const first = cardsRef.current[firstIndex];
      const initial = getStandingPoint(first, first.left + first.width * 0.24);
      poseRef.current = {
        x: initial.x,
        y: initial.y,
        facingLeft: false,
        visible: true,
      };
      motionRef.current.cardIndex = firstIndex;
      motionRef.current.targetX = initial.x;
      motionRef.current.nextActionAt = performance.now() + 2600;
      setVisible(true);
    }
  }, [scopeRef]);

  React.useEffect(() => {
    const mediaQuery = window.matchMedia(MOTION_QUERY);
    const updateMotionPreference = () => setReduceMotion(mediaQuery.matches);

    updateMotionPreference();
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", updateMotionPreference);
    } else {
      mediaQuery.addListener(updateMotionPreference);
    }

    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener("change", updateMotionPreference);
      } else {
        mediaQuery.removeListener(updateMotionPreference);
      }
    };
  }, []);

  React.useEffect(() => {
    if (!mountRef.current) {
      return undefined;
    }

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: "high-performance",
      });
    } catch (error) {
      // The DOM chat remains usable when the browser cannot create a 3D context.
      setWebglUnavailable(true);
      return undefined;
    }
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.className = "site-robot__webgl";
    renderer.outputEncoding = THREE.sRGBEncoding;

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
    camera.position.set(0, 0, 900);

    const hemi = new THREE.HemisphereLight(0xe7f4ff, 0x1a2435, 2.2);
    hemi.position.set(0, 240, 180);
    scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(140, 220, 260);
    scene.add(key);

    const rim = new THREE.DirectionalLight(0x78e8ff, 1.2);
    rim.position.set(-160, 120, 120);
    scene.add(rim);

    const fill = new THREE.DirectionalLight(0xffd8a2, 0.75);
    fill.position.set(40, -80, 160);
    scene.add(fill);

    const characterPivot = new THREE.Group();
    scene.add(characterPivot);

    const mixerClock = new THREE.Clock();
    threeRef.current = {
      renderer,
      scene,
      camera,
      mixer: null,
      clock: mixerClock,
      characterPivot,
      actionMap: {},
      actionSpeedMap: {},
    };

    mountRef.current.appendChild(renderer.domElement);
    measureLayout();

    const loader = new THREE.GLTFLoader();
    loader.load(
      encodeURI(MODEL_URL),
      (gltf) => {
        const model = gltf.scene;
        model.traverse((node) => {
          if (node.isMesh) {
            node.castShadow = false;
            node.receiveShadow = false;
            const materials = Array.isArray(node.material) ? node.material : [node.material];

            materials.forEach((material) => {
              if (!material) {
                return;
              }

              if (material.map) {
                material.map.anisotropy = 4;
                remapYellowTexture(material.map);
              }

              if (material.emissiveMap) {
                material.emissiveMap.anisotropy = 4;
                remapYellowTexture(material.emissiveMap);
              }

              if (material.color) {
                replaceYellowAccent(material.color);
              }

              if (material.emissive) {
                replaceYellowAccent(material.emissive);
              }
            });
          }
        });

        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);

        const targetHeight = 58;
        const scale = size.y > 0 ? targetHeight / size.y : 1;
        model.scale.setScalar(scale);

        const scaledBox = new THREE.Box3().setFromObject(model);
        const scaledCenter = new THREE.Vector3();
        scaledBox.getCenter(scaledCenter);

        model.position.x = -scaledCenter.x;
        model.position.z = -scaledCenter.z;
        model.position.y = -scaledBox.min.y;
        model.rotation.set(0, MODEL_BASE_YAW, 0);

        characterPivot.add(model);

        // The feet are rigid meshes animated by their parent bones. Cache their
        // actual vertices once; bounding boxes leave slack as the feet rotate.
        const footSamples = [];
        model.traverse((node) => {
          if (!node.isMesh || !/foot/i.test(node.name) || !node.geometry.attributes.position) return;
          const positions = node.geometry.attributes.position;
          const seen = new Set();
          const points = [];
          for (let index = 0; index < positions.count; index += 1) {
            const point = new THREE.Vector3().fromBufferAttribute(positions, index);
            const key = `${point.x},${point.y},${point.z}`;
            if (!seen.has(key)) {
              seen.add(key);
              points.push(point);
            }
          }
          footSamples.push({ node, points });
        });
        threeRef.current.footSamples = footSamples;

        const mixer = new THREE.AnimationMixer(model);
        const { actionMap, actionSpeedMap } = resolveClipBindings(gltf.animations, mixer);

        Array.from(new Set(Object.values(actionMap))).forEach((action) => {
          action.enabled = true;
          action.setLoop(THREE.LoopRepeat);
        });

        if (actionMap.wave) {
          actionMap.wave.setLoop(THREE.LoopOnce, 1);
          actionMap.wave.clampWhenFinished = true;
        }

        threeRef.current.mixer = mixer;
        threeRef.current.actionMap = actionMap;
        threeRef.current.actionSpeedMap = actionSpeedMap;
        fadeToAction(
          actionMap,
          activeActionRef,
          actionMap.idle ? "idle" : actionMap.walk ? "walk" : Object.keys(actionMap)[0],
          actionSpeedMap
        );
        setModelReady(true);
      },
      undefined,
      () => {
        setModelReady(false);
      }
    );

    return () => {
      clearActiveElement();
      if (renderer.domElement.parentNode === mountRef.current) {
        mountRef.current.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
  }, [clearActiveElement, measureLayout]);

  React.useEffect(() => {
    measureLayout();

    let resizeScheduled = false;
    let scrollScheduled = false;
    const handleResize = () => {
      if (resizeScheduled) {
        return;
      }
      resizeScheduled = true;
      window.requestAnimationFrame(() => {
        resizeScheduled = false;
        measureLayout();
      });
    };
    const handleScroll = () => {
      if (scrollScheduled) {
        return;
      }
      scrollScheduled = true;
      window.requestAnimationFrame(() => {
        scrollScheduled = false;
        measureLayout();
      });
    };
    const observer = window.ResizeObserver && scopeRef && scopeRef.current
      ? new window.ResizeObserver(handleResize)
      : null;

    if (observer && scopeRef.current) {
      observer.observe(scopeRef.current);
    }

    window.addEventListener("resize", handleResize);
    window.addEventListener("scroll", handleScroll, { passive: true });
    const scopeElement = scopeRef && scopeRef.current;
    if (scopeElement) {
      scopeElement.addEventListener("load", handleResize, true);
      scopeElement.addEventListener("toggle", handleResize, true);
    }

    return () => {
      if (observer) {
        observer.disconnect();
      }
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleScroll);
      if (scopeElement) {
        scopeElement.removeEventListener("load", handleResize, true);
        scopeElement.removeEventListener("toggle", handleResize, true);
      }
    };
  }, [measureLayout, scopeRef]);

  React.useEffect(() => {
    if (focusOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [focusOpen]);

  React.useEffect(() => {
    chatOpenRef.current = chatOpen;
  }, [chatOpen]);

  React.useEffect(() => {
    focusOpenRef.current = focusOpen;
  }, [focusOpen]);

  React.useEffect(() => {
    streamingRef.current = streamMeta.streaming;
  }, [streamMeta.streaming]);

  React.useEffect(() => {
    panelPositionRef.current = panelPosition;
  }, [panelPosition]);

  React.useEffect(() => {
    panelSizeRef.current = panelSize;
  }, [panelSize]);

  React.useEffect(() => {
    if (!chatOpen || !panelRef.current) {
      return undefined;
    }

    const updatePanelSize = () => {
      if (!panelRef.current) {
        return;
      }

      const nextSize = {
        width: panelRef.current.offsetWidth || 236,
        height: panelRef.current.offsetHeight || 154,
      };
      const viewport = getViewportSize();

      setPanelSize(nextSize);
      setPanelPosition((current) => clampPanelPosition(current, viewport, nextSize));
    };

    updatePanelSize();

    const observer = window.ResizeObserver
      ? new window.ResizeObserver(updatePanelSize)
      : null;

    if (observer) {
      observer.observe(panelRef.current);
    }

    return () => {
      if (observer) {
        observer.disconnect();
      }
    };
  }, [chatOpen, focusOpen, promptText, replyText, streamMeta.step]);

  React.useEffect(() => {
    const handlePointerMove = (event) => {
      if (dragStateRef.current) {
        const viewport = getViewportSize();
        const desiredPosition = clampPanelPosition({
          x: dragStateRef.current.baseX + (event.clientX - dragStateRef.current.startX),
          y: dragStateRef.current.baseY + (event.clientY - dragStateRef.current.startY),
        }, viewport, panelSizeRef.current);
        const headViewport = getRobotHeadViewport(
          scopeRef && scopeRef.current,
          getDisplayPose(motionRef.current, poseRef.current, layoutRef.current)
        );
        const anchor = getPanelAnchor(desiredPosition, panelSizeRef.current);
        const excess = getTetherExcess(headViewport, anchor);

        setPanelPosition(desiredPosition);
        pullMarvinByOffset(excess);
      }

      const robotDrag = robotDragStateRef.current;
      if (!robotDrag) {
        return;
      }

      const movedDistance = Math.hypot(
        event.clientX - robotDrag.startX,
        event.clientY - robotDrag.startY
      );

      if (!robotDrag.dragging && movedDistance >= ROBOT_DRAG_THRESHOLD) {
        robotDrag.dragging = true;
        suppressRobotClickRef.current = true;
        freezeMarvinForDrag();
      }

      if (!robotDrag.dragging) {
        return;
      }

      const nextHead = {
        x: event.clientX + robotDrag.offsetX,
        y: event.clientY + robotDrag.offsetY,
      };
      const nextAirbornePose = {
        ...getPoseFromHeadViewport(scopeRef && scopeRef.current, nextHead),
        facingLeft: event.clientX < robotDrag.startX,
        visible: true,
      };
      const nextPose = wrapPoseToLayout(nextAirbornePose, layoutRef.current);
      const now = performance.now();
      const elapsed = Math.max(8, now - robotDrag.lastAt);

      robotDrag.velocityX = ((nextHead.x - robotDrag.lastX) / elapsed) * 16;
      robotDrag.velocityY = ((nextHead.y - robotDrag.lastY) / elapsed) * 16;
      robotDrag.lastX = nextHead.x;
      robotDrag.lastY = nextHead.y;
      robotDrag.lastAt = now;

      poseRef.current = {
        ...poseRef.current,
        ...nextAirbornePose,
        facingLeft: nextAirbornePose.facingLeft,
        visible: true,
      };
      motionRef.current.airbornePose = nextAirbornePose;
      motionRef.current.cardIndex = getNearestCardIndex(cardsRef.current, nextPose);
      motionRef.current.targetX = nextPose.x;
      motionRef.current.mode = "held";
      motionRef.current.velocityX = 0;
      motionRef.current.velocityY = 0;
      setRobotHeadOverlay(getRobotHeadViewport(scopeRef && scopeRef.current, nextPose));
    };

    const handlePointerUp = () => {
      motionRef.current.dragActive = false;
      dragStateRef.current = null;

      const robotDrag = robotDragStateRef.current;
      if (!robotDrag) {
        return;
      }

      robotDragStateRef.current = null;

      if (!robotDrag.dragging) {
        return;
      }

      const motion = motionRef.current;
      motion.velocityX = robotDrag.velocityX;
      motion.velocityY = robotDrag.velocityY;
      motion.pendingJump = null;
      motion.jumpStart = null;
      motion.jumpEnd = null;
      motion.jumpStartAt = 0;
      motion.jumpHeight = 56;
      motion.targetX = (motion.airbornePose || poseRef.current).x;
      motion.nextActionAt = performance.now() + 180;
      motion.mode = chatOpenRef.current || focusOpenRef.current ? "dangling" : "falling";
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [freezeMarvinForDrag, pullMarvinByOffset, scopeRef]);

  const settleToNearestCard = React.useCallback((delayMs) => {
    if (!cardsRef.current.length) {
      return;
    }

    const pose = poseRef.current;
    const nextCardIndex = getNearestCardIndex(cardsRef.current, pose);
    const nextCard = cardsRef.current[nextCardIndex];
    const stand = getStandingPoint(nextCard, pose.x || nextCard.left + nextCard.width * 0.5);
    const nextPose = clampPoseToLayout({
      x: stand.x,
      y: stand.y,
      facingLeft: pose.facingLeft,
      visible: true,
    }, layoutRef.current);

    poseRef.current = {
      ...poseRef.current,
      ...nextPose,
      facingLeft: pose.facingLeft,
      visible: true,
    };

    motionRef.current.mode = "idle";
    motionRef.current.cardIndex = nextCardIndex;
    motionRef.current.targetX = stand.x;
    motionRef.current.nextActionAt = performance.now() + delayMs;
    motionRef.current.pendingJump = null;
    motionRef.current.jumpStart = null;
    motionRef.current.jumpEnd = null;
    motionRef.current.jumpStartAt = 0;
    motionRef.current.jumpHeight = 56;
    motionRef.current.velocityX = 0;
    motionRef.current.velocityY = 0;
    motionRef.current.dragActive = false;
    motionRef.current.airbornePose = null;

    snapToAction(
      threeRef.current.actionMap,
      activeActionRef,
      "idle",
      threeRef.current.actionSpeedMap
    );
  }, []);

  React.useEffect(() => {
    let frameId;
    let disposed = false;
    let lastTime = 0;
    let lastMeasureAt = 0;
    const scheduleFrame = () => {
      if (!disposed) frameId = window.requestAnimationFrame(animate);
    };

    const pickWalkTarget = (card) => {
      const positions = card.profile ? [0.08, 0.3, 0.5, 0.7, 0.92] : [0.26, 0.5, 0.74];
      const targets = positions.map(position => card.left + card.width * position);
      const away = targets.filter(x => Math.abs(x - poseRef.current.x) > Math.min(24, card.width * 0.2));
      return sample(away.length ? away : targets);
    };

    const pickJumpTargetIndex = (currentIndex) => {
      const currentCard = cardsRef.current[currentIndex];
      const currentPoint = getStandingPoint(currentCard, poseRef.current.x);
      if (currentCard.kind === "image" && Math.random() < 0.7) {
        const imageLedges = cardsRef.current.map((card, index) => ({ card, index }))
          .filter(item => item.index !== currentIndex && item.card.element === currentCard.element);
        if (imageLedges.length) return sample(imageLedges).index;
      }
      const candidates = cardsRef.current
        .map((card, index) => ({
          card,
          index,
          score:
            Math.abs(getStandingPoint(card, currentPoint.x).y - currentPoint.y) * 3.2 +
            Math.abs((card.left + card.right) / 2 - (currentCard.left + currentCard.right) / 2),
        }))
        .filter((item) => item.index !== currentIndex)
        .sort((left, right) => left.score - right.score)
        .slice(0, 3);

      return candidates.length ? sample(candidates).index : currentIndex;
    };

    const landOnCard = (cardIndex) => {
      const card = cardsRef.current[cardIndex];
      if (!card) {
        return;
      }

      clearActiveElement();
      motionRef.current.landedAt = performance.now();
      card.element.classList.add("robot-bopped");
      activeElementRef.current = card.element;
      window.setTimeout(() => {
        card.element.classList.remove("robot-bopped");
      }, 720);
    };

    const animate = (now) => {
      if (disposed) return;
      if (!lastTime) {
        lastTime = now;
      }

      // Layout events still refresh immediately; do the periodic catch-up
      // between walks so raster/path measurements cannot interrupt a stride.
      if (now - lastMeasureAt > 900 && motionRef.current.mode === "idle") {
        measureLayout();
        lastMeasureAt = now;
      }

      const dt = Math.min(now - lastTime, 32);
      lastTime = now;

      const threeState = threeRef.current;
      const { renderer, scene, camera, mixer, clock, characterPivot, actionMap, actionSpeedMap } = threeState;

      if (!renderer || !scene || !camera || !characterPivot) {
        scheduleFrame();
        return;
      }

      if (!cardsRef.current.length || !poseRef.current.visible) {
        renderer.render(scene, camera);
        scheduleFrame();
        return;
      }

      const motion = motionRef.current;
      const currentCard = cardsRef.current[motion.cardIndex] || cardsRef.current[0];
      const chatIsOpen = chatOpenRef.current;
      const currentPanelAnchor = getPanelAnchor(panelPositionRef.current, panelSizeRef.current);
      let displayPose = getDisplayPose(motion, poseRef.current, layoutRef.current);
      const headViewport = getRobotHeadViewport(scopeRef && scopeRef.current, displayPose);

      if (
        chatIsOpen &&
        motion.mode !== "dangling" &&
        motion.mode !== "falling" &&
        motion.mode !== "held" &&
        (motion.mode !== "idle" || motion.pendingJump || motion.jumpStart || motion.jumpEnd)
      ) {
        motion.mode = "idle";
        motion.targetX = poseRef.current.x;
        motion.pendingJump = null;
        motion.jumpStart = null;
        motion.jumpEnd = null;
        motion.jumpHeight = 56;
        motion.nextActionAt = now + 120;
        motion.velocityX = 0;
        motion.velocityY = 0;
        motion.airbornePose = null;
        snapToAction(actionMap, activeActionRef, "idle", actionSpeedMap);
      }

      if (motion.mode === "idle" && now >= motion.nextActionAt && !chatIsOpen && !reduceMotion) {
        const shouldJump = !reduceMotion && cardsRef.current.length > 1 && Math.random() > 0.64;

        if (shouldJump) {
          const targetIndex = pickJumpTargetIndex(motion.cardIndex);
          const endCard = cardsRef.current[targetIndex];
          const movingRight = (endCard.left + endCard.right) / 2 >= (currentCard.left + currentCard.right) / 2;
          const currentEdgeX = getStandingPoint(
            currentCard,
            movingRight ? currentCard.right - currentCard.width * 0.18 : currentCard.left + currentCard.width * 0.18
          ).x;
          const landingEdgeX = getStandingPoint(
            endCard,
            movingRight ? endCard.left + endCard.width * 0.2 : endCard.right - endCard.width * 0.2
          ).x;
          const settleX = getStandingPoint(endCard, pickWalkTarget(endCard)).x;

          motion.mode = "walking";
          motion.targetX = currentEdgeX;
          motion.pendingJump = {
            targetIndex,
            landingX: landingEdgeX,
            settleX,
          };
        } else {
          motion.mode = "walking";
          motion.targetX = getStandingPoint(currentCard, pickWalkTarget(currentCard)).x;
          motion.pendingJump = null;
        }
      }

      if (motion.mode === "walking") {
        const dx = motion.targetX - poseRef.current.x;
        const step = reduceMotion ? Math.abs(dx) : 0.024 * dt;
        const nextX = reduceMotion ? motion.targetX : advanceAlongSurface(currentCard, poseRef.current.x, motion.targetX, step);

        if (Math.abs(motion.targetX - nextX) < 0.01 || reduceMotion) {
          if (motion.pendingJump) {
            const jumpTarget = cardsRef.current[motion.pendingJump.targetIndex];
            const start = getStandingPoint(currentCard, nextX);
            const end = getStandingPoint(jumpTarget, motion.pendingJump.landingX);
            const jumpProfile = getJumpProfile(start, end);
            motion.mode = "jumping";
            motion.jumpStart = start;
            motion.jumpEnd = end;
            motion.jumpStartAt = now;
            motion.jumpDuration = jumpProfile.duration;
            motion.jumpHeight = jumpProfile.height;
          } else {
            motion.mode = "idle";
            motion.nextActionAt = now + 3600 + Math.random() * 4200;
            fadeToAction(actionMap, activeActionRef, "idle", actionSpeedMap);
          }
        } else {
          fadeToAction(actionMap, activeActionRef, actionMap.walk ? "walk" : "idle", actionSpeedMap);
        }

        const nextPose = clampPoseToLayout({
          x: nextX,
          y: getWalkingHeight(currentCard, nextX),
          facingLeft: dx < 0,
          visible: true,
        }, layoutRef.current);
        poseRef.current = {
          ...poseRef.current,
          ...nextPose,
          facingLeft: dx < 0,
          visible: true,
        };
      } else if (motion.mode === "jumping") {
        const progress = clamp((now - motion.jumpStartAt) / motion.jumpDuration, 0, 1);
        const arc = Math.sin(progress * Math.PI) * (motion.jumpHeight || 56);
        const nextX = motion.jumpStart.x + (motion.jumpEnd.x - motion.jumpStart.x) * progress;
        const nextY = motion.jumpStart.y + (motion.jumpEnd.y - motion.jumpStart.y) * progress - arc;

        const nextPose = clampPoseToLayout({
          x: nextX,
          y: nextY,
          facingLeft: motion.jumpEnd.x < motion.jumpStart.x,
          visible: true,
        }, layoutRef.current);
        poseRef.current = {
          ...poseRef.current,
          ...nextPose,
          facingLeft: motion.jumpEnd.x < motion.jumpStart.x,
          visible: true,
        };

        fadeToAction(
          actionMap,
          activeActionRef,
          actionMap.walkJump ? "walkJump" : actionMap.jump ? "jump" : "idle",
          actionSpeedMap
        );

        if (progress >= 1) {
          const landedIndex = motion.pendingJump ? motion.pendingJump.targetIndex : motion.cardIndex;
          const settleX = motion.pendingJump ? motion.pendingJump.settleX : motion.jumpEnd.x;
          motion.cardIndex = landedIndex;
          motion.pendingJump = null;
          motion.mode = "walking";
          motion.targetX = settleX;
          motion.jumpHeight = 56;
          motion.nextActionAt = now + 3800 + Math.random() * 4600;
          motion.airbornePose = null;
          const landedPose = clampPoseToLayout({
            x: motion.jumpEnd.x,
            y: motion.jumpEnd.y,
            facingLeft: motion.jumpEnd.x < motion.jumpStart.x,
            visible: true,
          }, layoutRef.current);
          poseRef.current = {
            ...poseRef.current,
            ...landedPose,
            facingLeft: motion.jumpEnd.x < motion.jumpStart.x,
            visible: true,
          };
          landOnCard(landedIndex);
          fadeToAction(actionMap, activeActionRef, actionMap.walk ? "walk" : "idle", actionSpeedMap);
        }
      } else if (motion.mode === "held") {
        fadeToAction(actionMap, activeActionRef, "idle", actionSpeedMap);
      } else if (motion.mode === "dangling") {
        const airbornePose = motion.airbornePose || poseRef.current;
        const currentHeadLayout = getRobotHeadLayout(airbornePose);
        const currentPanelAnchorLayout = getLayoutPointFromViewport(
          scopeRef && scopeRef.current,
          currentPanelAnchor
        );
        const nextHeadLayout = {
          x: currentHeadLayout.x + motion.velocityX * (dt / 16),
          y: currentHeadLayout.y + motion.velocityY * (dt / 16),
        };

        motion.velocityY += 0.12 * (dt / 16);
        motion.velocityX *= motion.dragActive ? 0.94 : 0.985;
        motion.velocityY *= motion.dragActive ? 0.94 : 0.99;

        const tetherDx = nextHeadLayout.x - currentPanelAnchorLayout.x;
        const tetherDy = nextHeadLayout.y - currentPanelAnchorLayout.y;
        const tetherDistance = Math.hypot(tetherDx, tetherDy) || 1;
        let constrainedHeadLayout = nextHeadLayout;

        if (tetherDistance > MAX_TETHER_LENGTH) {
          const unitX = tetherDx / tetherDistance;
          const unitY = tetherDy / tetherDistance;
          constrainedHeadLayout = {
            x: currentPanelAnchorLayout.x + unitX * MAX_TETHER_LENGTH,
            y: currentPanelAnchorLayout.y + unitY * MAX_TETHER_LENGTH,
          };

          const radialVelocity = motion.velocityX * unitX + motion.velocityY * unitY;
          if (radialVelocity > 0) {
            motion.velocityX -= radialVelocity * unitX;
            motion.velocityY -= radialVelocity * unitY;
          }
        }

        const nextAirbornePose = {
          ...getPoseFromHeadLayout(constrainedHeadLayout),
          facingLeft: currentPanelAnchorLayout.x < constrainedHeadLayout.x,
          visible: true,
        };
        motion.airbornePose = nextAirbornePose;

        poseRef.current = {
          ...poseRef.current,
          ...nextAirbornePose,
          facingLeft: nextAirbornePose.facingLeft,
          visible: true,
        };

        if (!motion.dragActive) {
          const nextSurface = getSurfaceBelow(
            cardsRef.current,
            nextAirbornePose,
            layoutRef.current.width,
            layoutRef.current.height
          );
          const landingIndex = nextSurface ? nextSurface.index : null;
          const landingPoint = nextSurface ? nextSurface.point : null;

          if (landingPoint && nextSurface.downwardDelta <= nextSurface.overshootAllowance) {
            const landedPose = clampPoseToLayout({
              x: landingPoint.x,
              y: landingPoint.y,
              facingLeft: motion.velocityX < 0,
              visible: true,
            }, layoutRef.current);

            poseRef.current = {
              ...poseRef.current,
              ...landedPose,
              facingLeft: motion.velocityX < 0,
              visible: true,
            };

            motion.mode = "idle";
            motion.cardIndex = landingIndex;
            motion.targetX = landingPoint.x;
            motion.nextActionAt = now + (chatIsOpen ? 240 : 2800);
            motion.velocityX = 0;
            motion.velocityY = 0;
            motion.airbornePose = null;
            landOnCard(landingIndex);
          }
        }

        fadeToAction(actionMap, activeActionRef, "idle", actionSpeedMap);
      } else if (motion.mode === "falling") {
        const airbornePose = motion.airbornePose || poseRef.current;
        const currentHeadLayout = getRobotHeadLayout(airbornePose);
        const nextHeadLayout = {
          x: currentHeadLayout.x + motion.velocityX * (dt / 16),
          y: currentHeadLayout.y + motion.velocityY * (dt / 16),
        };

        motion.velocityY += 0.18 * (dt / 16);
        motion.velocityX *= 0.992;
        motion.velocityY *= 0.998;

        const nextAirbornePose = {
          ...getPoseFromHeadLayout(nextHeadLayout),
          facingLeft: motion.velocityX < 0,
          visible: true,
        };
        motion.airbornePose = nextAirbornePose;

        poseRef.current = {
          ...poseRef.current,
          ...nextAirbornePose,
          facingLeft: nextAirbornePose.facingLeft,
          visible: true,
        };

        const nextSurface = getSurfaceBelow(
          cardsRef.current,
          nextAirbornePose,
          layoutRef.current.width,
          layoutRef.current.height
        );
        const landingIndex = nextSurface ? nextSurface.index : null;
        const landingPoint = nextSurface ? nextSurface.point : null;

        if (landingPoint && nextSurface.downwardDelta <= nextSurface.overshootAllowance) {
          const landedPose = clampPoseToLayout({
            x: landingPoint.x,
            y: landingPoint.y,
            facingLeft: motion.velocityX < 0,
            visible: true,
          }, layoutRef.current);

          poseRef.current = {
            ...poseRef.current,
            ...landedPose,
            facingLeft: motion.velocityX < 0,
            visible: true,
          };

          motion.mode = "idle";
          motion.cardIndex = landingIndex;
          motion.targetX = landingPoint.x;
          motion.nextActionAt = now + (chatIsOpen ? 240 : 2800);
          motion.velocityX = 0;
          motion.velocityY = 0;
          motion.airbornePose = null;
          landOnCard(landingIndex);
        }

        fadeToAction(actionMap, activeActionRef, "idle", actionSpeedMap);
      } else {
        const stand = getStandingPoint(currentCard, poseRef.current.x || currentCard.left + currentCard.width * 0.46);
        const nextPose = clampPoseToLayout({
          x: stand.x,
          y: stand.y,
          facingLeft: poseRef.current.facingLeft,
          visible: true,
        }, layoutRef.current);
        poseRef.current = {
          ...poseRef.current,
          ...nextPose,
          facingLeft: poseRef.current.facingLeft,
          visible: true,
        };
        motion.airbornePose = null;
        fadeToAction(actionMap, activeActionRef, "idle", actionSpeedMap);
      }

      if (mixer && clock) {
        mixer.update(clock.getDelta());
      }

      const { width, height } = layoutRef.current;
      displayPose = getDisplayPose(motion, poseRef.current, layoutRef.current);
      const isLocomoting = motion.mode === "walking" || motion.mode === "jumping";
      const isGrounded = motion.mode === "idle" || motion.mode === "walking";
      const standingSurface = cardsRef.current[motion.cardIndex] || currentCard;
      const slopeLean = isGrounded && !reduceMotion
        ? clamp(-Math.atan(getSurfaceSlope(standingSurface, displayPose.x)) * 0.32, -0.22, 0.22)
        : 0;
      const isDangling = motion.mode === "dangling";
      const danglingTilt = isDangling
        ? clamp((currentPanelAnchor.x - headViewport.x) / MAX_TETHER_LENGTH, -0.28, 0.28)
        : 0;
      const danglingPitch = isDangling
        ? clamp((currentPanelAnchor.y - headViewport.y - 140) / 420, -0.08, 0.14)
        : 0;
      const baseYawPositionX = displayPose.x - width / 2;
      const baseYawPositionY = height / 2 - displayPose.y;
      const desiredYaw = isLocomoting
        ? displayPose.facingLeft
          ? -Math.PI / 2
          : Math.PI / 2
        : 0;
      const targetPivotYaw = desiredYaw - MODEL_BASE_YAW;
      characterPivot.rotation.y += (targetPivotYaw - characterPivot.rotation.y) * 0.18;
      characterPivot.rotation.x += (danglingPitch - characterPivot.rotation.x) * 0.14;
      characterPivot.rotation.z += (danglingTilt + slopeLean - characterPivot.rotation.z) * 0.14;
      const landingProgress = clamp((now - motion.landedAt) / 280, 0, 1);
      const landingBend = isGrounded && !reduceMotion ? Math.sin(landingProgress * Math.PI) * 0.035 : 0;
      characterPivot.scale.set(1 + landingBend * 0.3, 1 - landingBend, 1);

      if (walkerRef.current) {
        walkerRef.current.style.transform = `translate3d(${displayPose.x}px, ${displayPose.y}px, 0)`;
      }

      if (
        chatOpenRef.current ||
        motion.mode === "dangling" ||
        motion.mode === "falling" ||
        motion.mode === "held"
      ) {
        const nextHeadOverlay = getRobotHeadViewport(scopeRef && scopeRef.current, displayPose);
        setRobotHeadOverlay((current) => (
          Math.abs(current.x - nextHeadOverlay.x) < 0.35 &&
            Math.abs(current.y - nextHeadOverlay.y) < 0.35
            ? current
            : nextHeadOverlay
        ));
      }

      setBubbleSide(displayPose.x > width * 0.58 ? "left" : "right");
      characterPivot.position.set(baseYawPositionX, baseYawPositionY, 0);

      if (isGrounded && threeState.footSamples && threeState.footSamples.length) {
        characterPivot.updateMatrixWorld(true);
        const correction = getFootingCorrection(
          threeState.footSamples, standingSurface, width, height, footVertexRef.current,
          { reportUnsupported: true, maxSurfaceY: motion.mode === "walking"
            ? getWalkingHeight(standingSurface, displayPose.x) + (standingSurface.kind === "text" ? 6 : 18) : Infinity }
        );
        const previous = groundingRef.current;
        const continuous = previous && previous.element === standingSurface.element && previous.key === standingSurface.key &&
          Math.abs(previous.x - displayPose.x) < 12;
        const targetY = correction === null
          ? continuous ? previous.y + displayPose.y - previous.poseY : displayPose.y
          : displayPose.y - correction;
        // Transfer weight between the feet over a few frames. Exact per-pixel
        // contact can otherwise snap the torso as a sole crosses a letter gap.
        const delta = continuous ? (targetY - previous.y) * (1 - Math.exp(-dt / 65)) : 0;
        const groundedY = continuous ? previous.y + clamp(delta, -0.12 * dt, 0.12 * dt) : targetY;
        characterPivot.position.y = height / 2 - groundedY;
        groundingRef.current = { element: standingSurface.element, key: standingSurface.key, x: displayPose.x, poseY: displayPose.y, y: groundedY };
      } else {
        groundingRef.current = null;
      }

      // Follow the animated model, including feet, waving hands and drag tilt.
      // A fixed rectangle at the chat anchor used to miss the lower body.
      const avatarBounds = avatarBoundsRef.current.setFromObject(characterPivot);
      if (buttonRef.current && !avatarBounds.isEmpty()) {
        const padding = 5;
        const hitWidth = Math.max(44, avatarBounds.max.x - avatarBounds.min.x + padding * 2);
        const hitHeight = Math.max(44, avatarBounds.max.y - avatarBounds.min.y + padding * 2);
        const hitCenterX = (avatarBounds.min.x + avatarBounds.max.x) / 2 + width / 2;
        const hitCenterY = height / 2 - (avatarBounds.min.y + avatarBounds.max.y) / 2;
        buttonRef.current.style.left = `${hitCenterX - hitWidth / 2 - displayPose.x - UI_ANCHOR_OFFSET.x}px`;
        buttonRef.current.style.top = `${hitCenterY - hitHeight / 2 - displayPose.y - UI_ANCHOR_OFFSET.y}px`;
        buttonRef.current.style.width = `${hitWidth}px`;
        buttonRef.current.style.height = `${hitHeight}px`;
      }
      renderer.render(scene, camera);
      scheduleFrame();
    };

    scheduleFrame();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frameId);
    };
  }, [clearActiveElement, measureLayout, reduceMotion]);

  const closeChat = React.useCallback(() => {
    const isAirborne = motionRef.current.mode === "dangling" || motionRef.current.mode === "falling";

    chatOpenRef.current = false;
    focusOpenRef.current = false;
    motionRef.current.dragActive = false;
    if (motionRef.current.mode === "dangling") {
      motionRef.current.mode = "falling";
    } else if (!isAirborne) {
      settleToNearestCard(220);
    }
    setFocusOpen(false);
    setChatOpen(false);
    setMarvinSurfaceEnabled("robot", false);
  }, [settleToNearestCard]);

  const handleRobotPointerDown = React.useCallback((event) => {
    if (event.button !== undefined && event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.currentTarget.setPointerCapture) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }

    const headViewport = getRobotHeadViewport(
      scopeRef && scopeRef.current,
      getDisplayPose(motionRef.current, poseRef.current, layoutRef.current)
    );
    robotDragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: headViewport.x - event.clientX,
      offsetY: headViewport.y - event.clientY,
      lastX: headViewport.x,
      lastY: headViewport.y,
      lastAt: performance.now(),
      velocityX: 0,
      velocityY: 0,
      dragging: false,
    };
    suppressRobotClickRef.current = false;
  }, [scopeRef]);

  const handleRobotClick = React.useCallback(() => {
    if (suppressRobotClickRef.current) {
      suppressRobotClickRef.current = false;
      return;
    }

    const isAirborne = motionRef.current.mode === "dangling" || motionRef.current.mode === "falling";

    if (chatOpenRef.current || focusOpenRef.current) {
      closeChat();
      return;
    }

    chatOpenRef.current = true;
    focusOpenRef.current = true;
    const headViewport = getRobotHeadViewport(
      scopeRef && scopeRef.current,
      getDisplayPose(motionRef.current, poseRef.current, layoutRef.current)
    );
    const viewport = getViewportSize();
    setPanelPosition(
      clampPanelPosition(
        getDefaultPanelPosition(bubbleSide, headViewport, panelSizeRef.current),
        viewport,
        panelSizeRef.current
      )
    );
    if (!isAirborne) {
      settleToNearestCard(220);
    }
    setChatOpen(true);
    setFocusOpen(true);
    setMarvinSurfaceEnabled("robot", true);
  }, [bubbleSide, closeChat, scopeRef, settleToNearestCard]);

  React.useEffect(() => {
    const handleOutside = (event) => {
      if (chatOpenRef.current && mountRef.current && !mountRef.current.contains(event.target))
        closeChat();
    };
    const handleKeyDown = (event) => {
      if (event.key !== "Escape") {
        return;
      }

      if (!chatOpenRef.current && !focusOpenRef.current) {
        return;
      }

      event.preventDefault();
      closeChat();
    };

    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("click", handleOutside, true);
    document.addEventListener("focusin", handleOutside, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("click", handleOutside, true);
      document.removeEventListener("focusin", handleOutside, true);
    };
  }, [closeChat]);

  const handlePanelDragStart = React.useCallback((event) => {
    event.preventDefault();
    if (event.currentTarget.setPointerCapture) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    motionRef.current.dragActive = true;
    dragStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      baseX: panelPositionRef.current.x,
      baseY: panelPositionRef.current.y,
    };
  }, []);

  const handleComposerKeyDown = React.useCallback(
    (event) => {
      if (event.key !== "Enter" || event.shiftKey) {
        return;
      }

      event.preventDefault();

      if (!input.trim() || streamMeta.streaming) {
        return;
      }

      if (event.currentTarget.form) {
        event.currentTarget.form.requestSubmit();
      }
    },
    [input, streamMeta.streaming]
  );

  const handleSubmit = React.useCallback((event) => {
    event.preventDefault();
    if (!input.trim() || streamMeta.streaming) return;
    setInput("");
    chatOpenRef.current = true;
    focusOpenRef.current = true;
    setChatOpen(true);
    setFocusOpen(true);
    setMarvinSurfaceEnabled("robot", true);
    generateMarvin(input);
  }, [input, streamMeta.streaming]);

  const handleStop = (event) => {
    event.preventDefault();
    stopMarvin();
  };

  if (!visible) {
    return createPortal(<div ref={mountRef} className="site-robot site-robot--page" />, document.body);
  }

  const introText = "I’m Marvin, a little diffusion model running on CPU. Ask me something, then watch my steps in the brain view.";
  const showIntroDialogue = focusOpen && !promptText && !replyText && !streamMeta.streaming;
  const hasDialogue = Boolean(promptText || replyText || streamMeta.streaming || showIntroDialogue);
  const showBubbleStack = chatOpen;
  const robotHeadViewport = showBubbleStack && !webglUnavailable
    ? robotHeadOverlay
    : getRobotHeadViewport(
      scopeRef && scopeRef.current,
      getDisplayPose(motionRef.current, poseRef.current, layoutRef.current)
    );
  const panelAnchor = getPanelAnchor(panelPosition, panelSize);
  const connectorHeadViewport = motionRef.current.mode === "dangling"
    ? {
      x: robotHeadViewport.x + clamp((panelAnchor.x - robotHeadViewport.x) * 0.12, -10, 10),
      y: robotHeadViewport.y + clamp((panelAnchor.y - robotHeadViewport.y) * 0.08, -2, 12),
    }
    : robotHeadViewport;
  const connectorPath = getConnectorPath(connectorHeadViewport, panelAnchor);

  return createPortal(
    <div ref={mountRef} className="site-robot site-robot--page">
      <div
        ref={walkerRef}
        className="site-robot__walker"
        style={webglUnavailable ? {
          transform: `translate3d(${poseRef.current.x}px, ${poseRef.current.y}px, 0)`,
        } : undefined}
      >
        <div className="site-robot__ui-anchor">
          <button
            ref={buttonRef}
            type="button"
            className={`site-robot__button${modelReady ? " is-ready" : ""}`}
            onClick={handleRobotClick}
            onPointerDown={handleRobotPointerDown}
            aria-expanded={focusOpen}
            aria-label="Talk to Marvin"
            style={webglUnavailable ? {
              width: 64, height: 30, top: 24, left: -14,
              background: "#f0efea", border: "1px solid #c4cbb8",
              color: "#535d49", fontSize: 11,
            } : undefined}
          >
            {webglUnavailable ? "Marvin" : null}
          </button>
        </div>
      </div>
      {showBubbleStack && (
        <div className="site-robot__chat-overlay">
          <svg className="site-robot__connector" viewBox={`0 0 ${window.innerWidth || 1} ${window.innerHeight || 1}`} aria-hidden="true">
            <path d={connectorPath} />
            <circle cx={connectorHeadViewport.x} cy={connectorHeadViewport.y} r="4.5" />
          </svg>
          <div
            ref={panelRef}
            className={`site-robot__bubble-stack${focusOpen && !hasDialogue ? " is-composer-only" : ""}`}
            style={{
              transform: `translate3d(${panelPosition.x}px, ${panelPosition.y}px, 0)`,
            }}
          >
            <div className="site-robot__drag-handle" onPointerDown={handlePanelDragStart}>
              <span>Marvin</span>
              <span>Drag</span>
            </div>
            {hasDialogue && (
              <div className={`site-robot__dialogue site-robot__dialogue--${bubbleSide}${streamMeta.streaming ? " is-streaming" : ""}`}>
                <div className="site-robot__dialogue-header">
                  <span>Marvin</span>
                  <span className={status.online ? "is-online" : ""}>
                    {queued ? "Waiting" : streamMeta.streaming ? `step ${streamMeta.step}/${streamMeta.totalSteps || "?"}` : marvin.phase === "error" ? "Connection interrupted" : status.text}
                  </span>
                </div>
                {promptText ? <div className="site-robot__prompt-label">{promptText}</div> : null}
                <p role={queued ? "status" : undefined}>
                  {queued ? QUEUED_MESSAGE : replyText || (showIntroDialogue ? introText : streamMeta.streaming ? "Thinking…" : "Ask Marvin something.")}
                  {queued && <strong className="site-robot__queue-position">{marvinQueuePosition(marvin.queuePosition)}</strong>}
                </p>
                {marvin.error && <p className="site-robot__error" role="alert">{marvin.error}</p>}
              </div>
            )}

            {focusOpen && (
              <form className="site-robot__composer is-open" onSubmit={handleSubmit}>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  aria-label="Message Marvin"
                  maxLength={1000}
                  rows={2}
                  placeholder="Ask Marvin about a project or diffusion..."
                  disabled={streamMeta.streaming}
                />
                <div className="site-robot__composer-actions">
                  <a href="#brain" onClick={() => {
                    const brain = document.getElementById("brain");
                    if (brain) {
                      brain.scrollIntoView({ block: "start", behavior: "instant" });
                      brain.focus({ preventScroll: true });
                      engageMarvinSurface("brain");
                    }
                    closeChat();
                  }}>See my brain ↗</a>
                  <div className="site-robot__composer-buttons">
                    {streamMeta.streaming ? (
                      <button type="button" className="is-secondary" onClick={handleStop}>
                        {queued ? "Cancel" : "Stop"}
                      </button>
                    ) : null}
                    <button type="submit" disabled={!input.trim() || streamMeta.streaming}>
                      Send
                    </button>
                  </div>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
