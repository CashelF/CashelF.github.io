import React from "react";
import { SPACE_URL, SYSTEM_PROMPT } from "./marvinContext";

export const DEFAULT_ARCHITECTURE = {
  modelId: "dllm-hub/Qwen3-0.6B-diffusion-bd3lm-v0.1",
  modelLabel: "Qwen3 · 0.6B",
  modelUrl: "https://huggingface.co/dllm-hub/Qwen3-0.6B-diffusion-bd3lm-v0.1",
  modelFamily: "Qwen3",
  layers: 28,
  hiddenSize: 1024,
  mlpWidth: 3072,
  queryHeads: 16,
  kvHeads: 8,
  headDim: 128,
};

export function validArchitecture(architecture) {
  if (!architecture) return false;
  const boundedInteger = (key, maximum) =>
    Number.isInteger(architecture[key]) &&
    architecture[key] > 0 &&
    architecture[key] <= maximum;
  const shortText = (key) =>
    typeof architecture[key] === "string" &&
    architecture[key].length > 0 &&
    architecture[key].length <= 80 &&
    !/[\u0000-\u001f\u007f]/.test(architecture[key]);
  return Boolean(
    typeof architecture.modelId === "string" &&
      architecture.modelId.length <= 200 &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(architecture.modelId) &&
      architecture.modelUrl ===
        `https://huggingface.co/${architecture.modelId}` &&
      shortText("modelLabel") &&
      shortText("modelFamily") &&
      boundedInteger("layers", 128) &&
      boundedInteger("hiddenSize", 65536) &&
      boundedInteger("mlpWidth", 65536) &&
      boundedInteger("queryHeads", 128) &&
      boundedInteger("kvHeads", architecture.queryHeads) &&
      architecture.queryHeads % architecture.kvHeads === 0 &&
      boundedInteger("headDim", 512),
  );
}

export function marvinArchitecture(frame, config) {
  return (
    (frame && frame.architecture) ||
    (config && config.architecture) ||
    DEFAULT_ARCHITECTURE
  );
}

const listeners = new Set();
let state = {
  health: "checking",
  telemetryAvailable: false,
  tokenStatesAvailable: false,
  config: null,
  phase: "idle",
  runId: 0,
  prompt: "",
  text: "",
  step: 0,
  totalSteps: 96,
  frames: [],
  queuePosition: null,
  error: "",
};
let controller = null;
let request = null;
let healthPromise = null;
function update(patch) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener(state));
}

export const QUEUED_MESSAGE =
  "Marvin’s talking to someone else right now. Give him a sec :/";

export function marvinQueuePosition(position) {
  return position === 1 ? "You’re next." : "1 request ahead of you.";
}

// A visible section alone is not engagement. Visitors must open the chat or
// interact with the brain, and leaving either surface gives up their turn.
const surfaces = new Map();
let removePresenceListeners = null;
let engagementCheck = 0;
let pageFocused = true;

function surfaceVisible(surface) {
  const element = (surface.viewportElement && surface.viewportElement()) || surface.element;
  const rect = element.getBoundingClientRect();
  return rect.bottom > 0 && rect.right > 0 &&
    rect.top < window.innerHeight && rect.left < window.innerWidth;
}

function hasEngagement() {
  return pageFocused && !document.hidden && Array.from(surfaces.values()).some(
    (surface) => surface.enabled && surface.engaged && surfaceVisible(surface),
  );
}

function checkEngagementSoon() {
  const check = ++engagementCheck;
  // Finish the click's handlers first, allowing a direct chat → brain handoff.
  Promise.resolve().then(() => {
    if (check === engagementCheck && request && !hasEngagement()) stopMarvin();
  });
}

function installPresenceListeners() {
  const interact = (event) => {
    surfaces.forEach((surface) => {
      surface.engaged = surface.enabled &&
        surface.element.contains(event.target) && surfaceVisible(surface);
    });
    checkEngagementSoon();
  };
  const checkViewport = () => {
    surfaces.forEach((surface) => {
      if (!surfaceVisible(surface)) surface.engaged = false;
    });
    checkEngagementSoon();
  };
  const leave = () => {
    surfaces.forEach((surface) => { surface.engaged = false; });
    stopMarvin();
  };
  const blur = () => { pageFocused = false; leave(); };
  const focus = () => { pageFocused = true; };
  const visibility = () => { if (document.hidden) leave(); };
  document.addEventListener("click", interact, true);
  document.addEventListener("focusin", interact, true);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("blur", blur);
  window.addEventListener("focus", focus);
  window.addEventListener("pagehide", leave);
  window.addEventListener("scroll", checkViewport, true);
  window.addEventListener("resize", checkViewport);
  return () => {
    document.removeEventListener("click", interact, true);
    document.removeEventListener("focusin", interact, true);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("blur", blur);
    window.removeEventListener("focus", focus);
    window.removeEventListener("pagehide", leave);
    window.removeEventListener("scroll", checkViewport, true);
    window.removeEventListener("resize", checkViewport);
  };
}

export function registerMarvinSurface(name, element, enabled = true, viewportElement = null) {
  const surface = { element, enabled, engaged: false, viewportElement };
  surfaces.set(name, surface);
  if (!removePresenceListeners) removePresenceListeners = installPresenceListeners();
  return () => {
    if (surfaces.get(name) !== surface) return;
    surfaces.delete(name);
    checkEngagementSoon();
    if (!surfaces.size && removePresenceListeners) {
      removePresenceListeners();
      removePresenceListeners = null;
    }
  };
}

export function engageMarvinSurface(name) {
  const surface = surfaces.get(name);
  if (surface && surface.enabled) surface.engaged = surfaceVisible(surface);
}

export function setMarvinSurfaceEnabled(name, enabled) {
  const surface = surfaces.get(name);
  if (surface) {
    surface.enabled = enabled;
    surface.engaged = enabled && surfaceVisible(surface);
    checkEngagementSoon();
  }
}

function requestId() {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [hex.slice(0, 4).join(""), hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""), hex.slice(8, 10).join(""),
    hex.slice(10).join("")].join("-");
}

function notifyRequest(activeRequest, action) {
  // A simple POST also works during navigation without a CORS preflight.
  try {
    return fetch(`${SPACE_URL}/requests/${activeRequest.id}/${action}`, {
      method: "POST",
      keepalive: true,
    }).catch(() => null);
  } catch (_) {
    return Promise.resolve(null);
  }
}

function cancelRequest(activeRequest) {
  if (activeRequest.cancelled) return;
  activeRequest.cancelled = true;
  clearInterval(activeRequest.heartbeat);
  clearTimeout(activeRequest.timeout);
  notifyRequest(activeRequest, "cancel");
  activeRequest.controller.abort();
}

export function validTelemetry(frame) {
  return Boolean(
    frame &&
      frame.version === 1 &&
      frame.metric === "hidden_state_rms" &&
      frame.normalization === "rms/(1+rms)" &&
      Array.isArray(frame.layerIndices) &&
      frame.layerIndices.length > 0 &&
      frame.layerIndices.length <= 128 &&
      frame.layerIndices.every(
        (index) => Number.isInteger(index) && index >= 0,
      ) &&
      Array.isArray(frame.tokenPositions) &&
      frame.tokenPositions.length > 0 &&
      frame.tokenPositions.length <= 128 &&
      frame.tokenPositions.every(
        (index) => Number.isInteger(index) && index >= 0,
      ) &&
      Array.isArray(frame.activations) &&
      frame.activations.length === frame.layerIndices.length &&
      frame.activations.every(
        (row) =>
          Array.isArray(row) &&
          row.length === frame.tokenPositions.length &&
          row.every(
            (value) => Number.isFinite(value) && value >= 0 && value <= 1,
          ),
      ),
  );
}

export function validTokenState(snapshot) {
  if (
    !snapshot ||
    snapshot.version !== 1 ||
    !Number.isInteger(snapshot.blockIndex) ||
    snapshot.blockIndex < 0 ||
    snapshot.blockIndex > 255 ||
    !Number.isInteger(snapshot.blockStart) ||
    snapshot.blockStart < 0 ||
    !Number.isInteger(snapshot.blockSize) ||
    snapshot.blockSize < 1 ||
    snapshot.blockSize > 128 ||
    snapshot.blockStart + snapshot.blockSize > 256 ||
    !Array.isArray(snapshot.tokens) ||
    snapshot.tokens.length !== snapshot.blockStart + snapshot.blockSize
  )
    return false;
  return snapshot.tokens.every(
    (token, index) =>
      token &&
      token.position === index &&
      Number.isInteger(token.tokenId) &&
      token.tokenId >= 0 &&
      token.tokenId < 10000000 &&
      typeof token.piece === "string" &&
      token.piece.length <= 512 &&
      ["masked", "committed", "discarded"].includes(token.state) &&
      typeof token.newlyCommitted === "boolean" &&
      typeof token.special === "boolean" &&
      (!token.newlyCommitted ||
        (token.state === "committed" && index >= snapshot.blockStart)) &&
      (index >= snapshot.blockStart || token.state !== "masked"),
  );
}

export function validInternals(internals, layerCount) {
  if (
    !Number.isInteger(layerCount) ||
    layerCount < 1 ||
    layerCount > 128 ||
    !internals ||
    internals.version !== 1 ||
    !Number.isInteger(internals.headCount) ||
    internals.headCount < 1 ||
    internals.headCount > 128 ||
    !Number.isInteger(internals.headDim) ||
    internals.headDim < 1 ||
    internals.headDim > 512 ||
    !Array.isArray(internals.neuronIndices) ||
    !internals.neuronIndices.length ||
    internals.neuronIndices.length > 128 ||
    !internals.neuronIndices.every(
      (index, position, indices) =>
        Number.isInteger(index) &&
        index >= 0 &&
        index < 65536 &&
        (position === 0 || index > indices[position - 1]),
    )
  )
    return false;
  const validRows = (rows, width) =>
    Array.isArray(rows) &&
    rows.length === layerCount &&
    rows.every(
      (row) =>
        Array.isArray(row) &&
        row.length === width &&
        row.every((value) => Number.isFinite(value) && value >= 0),
    );
  return (
    validRows(internals.attentionHeadRms, internals.headCount) &&
    validRows(internals.mlpNeuronRms, internals.neuronIndices.length)
  );
}

function validRmsValues(values, count) {
  return Array.isArray(values) && values.length === count &&
    values.every((value) => Number.isFinite(value) && value >= 0);
}

// New measurement groups are optional: older servers still provide useful
// layer/head activity, and a malformed addition must not hide those readings.
export function sanitizeStages(stages, tokenCount) {
  if (!stages || Array.isArray(stages) ||
      !Number.isInteger(tokenCount) || tokenCount < 1 || tokenCount > 128)
    return null;
  const sanitized = {};
  ["embeddingRms", "finalNormRms"].forEach((key) => {
    if (validRmsValues(stages[key], tokenCount)) sanitized[key] = stages[key];
  });
  const indices = stages.lmHeadTokenIndices;
  if (validRmsValues(stages.lmHeadRms, tokenCount) &&
      Array.isArray(indices) && indices.length > 0 && indices.length <= 64 &&
      indices.every((index, position) =>
        Number.isInteger(index) && index >= 0 && index < 2000000 &&
        (position === 0 || index > indices[position - 1]))) {
    sanitized.lmHeadRms = stages.lmHeadRms;
    sanitized.lmHeadTokenIndices = indices;
  }
  return Object.keys(sanitized).length ? sanitized : null;
}

export function sanitizeInternals(internals, layerCount, architecture = null) {
  if (!validInternals(internals, layerCount)) return null;
  const sanitized = {
    version: internals.version,
    headCount: internals.headCount,
    headDim: internals.headDim,
    neuronIndices: internals.neuronIndices,
    attentionHeadRms: internals.attentionHeadRms,
    mlpNeuronRms: internals.mlpNeuronRms,
  };
  const kvHeadCount = internals.kvHeadCount;
  const validProjection = (key, count) =>
    Array.isArray(internals[key]) && internals[key].length === layerCount &&
    internals[key].every((row) => validRmsValues(row, count));
  if (Number.isInteger(kvHeadCount) && kvHeadCount > 0 &&
      kvHeadCount <= internals.headCount && internals.headCount % kvHeadCount === 0 &&
      (!architecture ||
        (internals.headCount === architecture.queryHeads &&
         kvHeadCount === architecture.kvHeads && internals.headDim === architecture.headDim)) &&
      validProjection("queryHeadRms", internals.headCount) &&
      validProjection("keyHeadRms", kvHeadCount) &&
      validProjection("valueHeadRms", kvHeadCount)) {
    sanitized.kvHeadCount = kvHeadCount;
    sanitized.queryHeadRms = internals.queryHeadRms;
    sanitized.keyHeadRms = internals.keyHeadRms;
    sanitized.valueHeadRms = internals.valueHeadRms;
  }
  return sanitized;
}

// A streaming decoder keeps UTF-8 and CRLF boundaries intact, even across chunks.
export function createEventParser(onEvent) {
  let buffer = "";
  const consume = (raw) => {
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data && data !== "[DONE]") onEvent(JSON.parse(data));
  };
  return (chunk, final = false) => {
    buffer += chunk;
    let boundary = /\r?\n\r?\n/.exec(buffer);
    while (boundary) {
      consume(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
      boundary = /\r?\n\r?\n/.exec(buffer);
    }
    if (final && buffer.trim()) {
      consume(buffer);
      buffer = "";
    }
  };
}

export function checkMarvinHealth() {
  if (healthPromise) return healthPromise;
  update({ health: "checking" });
  const healthController = new window.AbortController();
  const timeout = setTimeout(() => healthController.abort(), 15000);
  healthPromise = fetch(`${SPACE_URL}/health`, {
    signal: healthController.signal,
  })
    .then((response) => {
      if (!response.ok) throw new Error("Unavailable");
      return response.json();
    })
    .then((data) => {
      const telemetry = data.telemetry;
      const architecture =
        telemetry && validArchitecture(telemetry.architecture)
          ? { ...telemetry.architecture }
          : DEFAULT_ARCHITECTURE;
      update({
        health: data.model_loaded ? "ready" : "warming",
        device: data.device,
        telemetryAvailable: Boolean(
          telemetry && telemetry.available && telemetry.version === 1,
        ),
        tokenStatesAvailable: Boolean(telemetry && telemetry.token_states),
        config: {
          architecture,
          num_layers:
            telemetry &&
            Number.isInteger(telemetry.layer_count) &&
            telemetry.layer_count > 0 &&
            telemetry.layer_count <= 128
              ? telemetry.layer_count
              : architecture.layers,
          token_count:
            telemetry &&
            Number.isInteger(telemetry.max_tokens) &&
            telemetry.max_tokens > 0 &&
            telemetry.max_tokens <= 128
              ? telemetry.max_tokens
              : 32,
        },
      });
    })
    .catch(() =>
      update({
        health: "offline",
        telemetryAvailable: false,
        tokenStatesAvailable: false,
      }),
    )
    .finally(() => {
      clearTimeout(timeout);
      healthPromise = null;
    });
  return healthPromise;
}

export async function generateMarvin(prompt) {
  if (controller || !prompt.trim() || (surfaces.size && !hasEngagement())) return;
  const activeController = new window.AbortController();
  const activeRequest = {
    id: requestId(), controller: activeController, heartbeat: null, cancelled: false,
  };
  controller = activeController;
  request = activeRequest;
  const isCurrent = () => request === activeRequest && !activeRequest.cancelled;
  let timedOut = false;
  let timeout;
  const resetTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      if (!isCurrent()) return;
      timedOut = true;
      cancelRequest(activeRequest);
    }, 180000);
    activeRequest.timeout = timeout;
  };
  update({
    phase: "connecting",
    runId: state.runId + 1,
    prompt: prompt.trim(),
    text: "",
    step: 0,
    totalSteps: 96,
    frames: [],
    queuePosition: null,
    error: "",
  });
  resetTimeout();
  activeRequest.heartbeat = setInterval(() => {
    if (!isCurrent()) return;
    if (surfaces.size && !hasEngagement()) {
      stopMarvin();
      return;
    }
    notifyRequest(activeRequest, "keepalive");
  }, 3000);
  let reader;
  let terminal = false;
  try {
    const response = await fetch(`${SPACE_URL}/generate_sse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: activeController.signal,
      body: JSON.stringify({
        request_id: activeRequest.id,
        prompt: prompt.trim(),
        system_prompt: SYSTEM_PROMPT,
        steps: 96,
        max_new_tokens: 96,
        capture_interval: 1,
        capture_activations: !state.config || state.telemetryAvailable,
        temperature: 0.2,
        cfg_scale: 0.0,
        remasking: "low_confidence",
      }),
    });
    if (!isCurrent()) return;
    if (!response.ok || !response.body)
      throw new Error(
        response.status === 429
          ? "Marvin’s got a little crowd—try again shortly."
          : response.status === 409
            ? "That request is already with Marvin. Try again in a moment."
          : "Couldn’t reach Marvin. Please try again.",
      );
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parse = createEventParser((payload) => {
      if (terminal || !isCurrent()) return;
      if (payload.type === "queued") {
        if (Number.isInteger(payload.position) && payload.position >= 1 && payload.position <= 2)
          update({ phase: "queued", queuePosition: payload.position });
        return;
      }
      if (payload.type === "start") {
        if (surfaces.size && !hasEngagement()) {
          stopMarvin();
          return;
        }
        update({ phase: "streaming", queuePosition: null });
        return;
      }
      if (payload.type === "cancelled" || (payload.type === "error" && payload.code === "cancelled")) {
        terminal = true;
        update({ phase: "stopped", queuePosition: null, error: "" });
        return;
      }
      if (payload.type === "error")
        throw new Error(payload.code === "queue_expired"
          ? "Marvin’s taking a while. Your spot was released—try again shortly."
          : payload.code === "lease_expired"
            ? "Marvin lost your connection. Send again when you’re ready."
          : "Marvin’s inference stopped. Please try again.");
      if (payload.type !== "intermediate" && payload.type !== "final") return;
      terminal = payload.type === "final";
      const patch = {
        phase: terminal ? "complete" : "streaming",
        queuePosition: null,
        health: "ready",
        text: typeof payload.text === "string" ? payload.text : state.text,
        step: payload.step || payload.total_steps || 0,
        totalSteps: payload.total_steps || 96,
      };
      if (validTelemetry(payload.telemetry)) {
        const architecture =
          validArchitecture(payload.telemetry.architecture) &&
          payload.telemetry.architecture.layers === payload.telemetry.layerIndices.length
            ? { ...payload.telemetry.architecture }
            : { ...marvinArchitecture(null, state.config) };
        const tokenState =
          validTokenState(payload.telemetry.tokenState) &&
          payload.telemetry.tokenState.blockIndex ===
            payload.telemetry.blockIndex &&
          payload.telemetry.tokenPositions.every(
            (position) =>
              position >= payload.telemetry.tokenState.blockStart &&
              position <
                payload.telemetry.tokenState.blockStart +
                  payload.telemetry.tokenState.blockSize,
          )
            ? payload.telemetry.tokenState
            : null;
        patch.telemetryAvailable = true;
        if (tokenState) patch.tokenStatesAvailable = true;
        patch.frames = state.frames
          .concat({
            ...payload.telemetry,
            architecture,
            tokenState,
            stages: sanitizeStages(payload.telemetry.stages, payload.telemetry.tokenPositions.length),
            internals: sanitizeInternals(
              payload.telemetry.internals,
              payload.telemetry.layerIndices.length,
              architecture,
            ),
            step: patch.step,
            text: patch.text,
          })
          .slice(-256);
      }
      update(patch);
    });
    while (!terminal && isCurrent()) {
      const { done, value } = await reader.read();
      if (done || !isCurrent()) break;
      resetTimeout();
      parse(decoder.decode(value, { stream: true }));
    }
    parse(decoder.decode(), true);
    if (!terminal && isCurrent())
      throw new Error(
        "The connection ended before Marvin finished. You can still inspect the steps received.",
      );
  } catch (error) {
    if (request !== activeRequest) return;
    const stopped = error.name === "AbortError" && !timedOut;
    update({
      phase: stopped ? "stopped" : "error",
      queuePosition: null,
      error: stopped
        ? ""
        : timedOut
          ? "Marvin took too long to respond. Please try again."
          : error.message,
    });
  } finally {
    clearTimeout(timeout);
    clearInterval(activeRequest.heartbeat);
    if (!terminal) cancelRequest(activeRequest);
    if (reader) {
      try {
        await reader.cancel();
      } catch (_) {
        /* Closed by the server. */
      }
    }
    if (controller === activeController) {
      controller = null;
      request = null;
    }
  }
}

export function stopMarvin() {
  if (!request) return;
  cancelRequest(request);
  controller = null;
  request = null;
  update({ phase: "stopped", queuePosition: null, error: "" });
}
export function useMarvin() {
  const [snapshot, setSnapshot] = React.useState(state);
  React.useEffect(() => {
    listeners.add(setSnapshot);
    setSnapshot(state);
    if (state.health === "checking") checkMarvinHealth();
    return () => listeners.delete(setSnapshot);
  }, []);
  return snapshot;
}
