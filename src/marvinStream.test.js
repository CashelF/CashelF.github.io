import { TextDecoder, TextEncoder } from "util";

// Observe the public hook's subscriptions without mounting either WebGL view.
// Network chunks and aborts still travel through the real stream implementation.
jest.mock("react", () => ({
  ...require.requireActual("react"),
  useState: jest.fn(),
  useEffect: jest.fn(),
}));

const originalFetch = global.fetch;
const originalDecoder = global.TextDecoder;
const originalAbortController = global.AbortController;
const originalWindow = global.window;
const originalDocument = global.document;
const encoder = new TextEncoder();
let stream;
let observers;
let cleanups;

function observe() {
  stream.useMarvin();
  return observers[observers.length - 1];
}

function telemetry(patch = {}) {
  return {
    version: 1,
    metric: "hidden_state_rms",
    normalization: "rms/(1+rms)",
    layerIndices: [0, 1],
    tokenPositions: [0, 1],
    activations: [
      [0, 0.25],
      [0.5, 1],
    ],
    ...patch,
  };
}

function event(payload) {
  return `data: ${JSON.stringify(payload)}\r\n\r\n`;
}

function responseWithChunks(chunks) {
  let index = 0;
  const reader = {
    read: jest.fn(() =>
      Promise.resolve(
        index < chunks.length
          ? { done: false, value: chunks[index++] }
          : { done: true },
      ),
    ),
    cancel: jest.fn(() => Promise.resolve()),
  };
  return { ok: true, body: { getReader: () => reader }, reader };
}

async function ready(architecture = null) {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          model_loaded: true,
          model: architecture ? architecture.modelId : undefined,
          telemetry: {
            available: true,
            version: 1,
            layer_count: 28,
            max_tokens: 32,
            architecture,
          },
        }),
    }),
  );
  await stream.checkMarvinHealth();
  return observe();
}

beforeEach(() => {
  jest.resetModules();
  observers = [];
  cleanups = [];
  global.TextDecoder = TextDecoder;
  // Jest 20 does not copy newer Node globals into its test environment.
  global.AbortController = require("vm").runInThisContext("AbortController");
  global.window = {
    AbortController: global.AbortController,
    crypto: { getRandomValues: (bytes) => require("crypto").randomFillSync(bytes) },
  };
  const React = require("react");
  React.useState.mockImplementation((initial) => {
    const observer = { state: initial };
    observers.push(observer);
    return [
      initial,
      (next) => {
        observer.state = next;
      },
    ];
  });
  React.useEffect.mockImplementation((effect) => cleanups.push(effect()));
  stream = require("./marvinStream");
});

afterEach(() => {
  stream.stopMarvin();
  cleanups.forEach((cleanup) => cleanup && cleanup());
  global.fetch = originalFetch;
  global.TextDecoder = originalDecoder;
  global.AbortController = originalAbortController;
  global.window = originalWindow;
  global.document = originalDocument;
  jest.useRealTimers();
});

async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function controlledResponse(ignoreAbort = false) {
  const chunks = [];
  let waiting = null;
  let failure = null;
  const response = {
    ok: true,
    body: { getReader: () => response.reader },
    reader: {
      read: () => {
        if (failure) return Promise.reject(failure);
        if (chunks.length) return Promise.resolve(chunks.shift());
        return new Promise((resolve, reject) => { waiting = { resolve, reject }; });
      },
      cancel: jest.fn(() => {
        if (waiting) waiting.resolve({ done: true });
        waiting = null;
        return Promise.resolve();
      }),
    },
    send: (payload) => {
      const chunk = { done: false, value: encoder.encode(event(payload)) };
      if (waiting) {
        waiting.resolve(chunk);
        waiting = null;
      } else chunks.push(chunk);
    },
    connect: (signal) => {
      if (!ignoreAbort) signal.addEventListener("abort", () => {
        failure = new Error("aborted");
        failure.name = "AbortError";
        if (waiting) waiting.reject(failure);
        waiting = null;
      });
      return response;
    },
  };
  return response;
}

function queueNetwork(responses) {
  let index = 0;
  global.fetch = jest.fn((url, options) => Promise.resolve(
    /generate_sse$/.test(url)
      ? responses[index++].connect(options.signal)
      : { ok: true },
  ));
}

function eventTarget() {
  const handlers = {};
  return {
    addEventListener: (type, handler) => {
      if (!handlers[type]) handlers[type] = new Set();
      handlers[type].add(handler);
    },
    removeEventListener: (type, handler) => {
      if (handlers[type]) handlers[type].delete(handler);
    },
    dispatch: (type, target) => {
      if (handlers[type]) handlers[type].forEach((handler) => handler({ type, target }));
    },
  };
}

function presence() {
  Object.assign(global.window, eventTarget(), { innerWidth: 1200, innerHeight: 800 });
  global.document = { ...eventTarget(), hidden: false };
  const makeSurface = (name, enabled = true) => {
    const child = {};
    const surface = {
      child,
      rect: { top: 0, right: 400, bottom: 400, left: 0 },
      contains: (target) => target === child,
      getBoundingClientRect: () => surface.rect,
    };
    cleanups.push(stream.registerMarvinSurface(name, surface, enabled));
    return surface;
  };
  return { brain: makeSurface("brain"), robot: makeSurface("robot", false) };
}

test("joins a queue with a private UUID, updates position, and starts without another submission", async () => {
  const observer = await ready();
  const response = controlledResponse();
  queueNetwork([response]);
  const running = stream.generateMarvin("hello");
  response.send({ type: "queued", position: 2 });
  await settle();
  const body = JSON.parse(global.fetch.mock.calls[0][1].body);
  expect(body.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(observer.state.phase).toBe("queued");
  expect(observer.state.queuePosition).toBe(2);
  expect(observer.state.frames).toEqual([]);
  response.send({ type: "queued", position: 1 });
  await settle();
  expect(observer.state.queuePosition).toBe(1);
  response.send({ type: "start" });
  await settle();
  expect(observer.state.phase).toBe("streaming");
  expect(observer.state.queuePosition).toBe(null);
  response.send({ type: "final", text: "Hello." });
  await running;
  expect(observer.state.phase).toBe("complete");
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test("renews an engaged queue lease and releases it immediately on cancel", async () => {
  const observer = await ready();
  jest.useFakeTimers();
  const response = controlledResponse();
  queueNetwork([response]);
  const running = stream.generateMarvin("hello");
  response.send({ type: "queued", position: 1 });
  await settle();
  const id = JSON.parse(global.fetch.mock.calls[0][1].body).request_id;
  jest.runTimersToTime(3000);
  expect(global.fetch.mock.calls[1][0]).toMatch(new RegExp(`/requests/${id}/keepalive$`));
  stream.stopMarvin();
  expect(observer.state.phase).toBe("stopped");
  expect(global.fetch.mock.calls[2][0]).toMatch(new RegExp(`/requests/${id}/cancel$`));
  expect(global.fetch.mock.calls[2][1]).toEqual({ method: "POST", keepalive: true });
  expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  await running;
  jest.runTimersToTime(20000);
  expect(global.fetch).toHaveBeenCalledTimes(3);
});

test("completing a request stops lease renewals without sending a cancellation", async () => {
  await ready();
  jest.useFakeTimers();
  const response = controlledResponse();
  queueNetwork([response]);
  const running = stream.generateMarvin("hello");
  response.send({ type: "final", text: "done" });
  await running;
  jest.runTimersToTime(20000);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test("late events from a cancelled request cannot overwrite its replacement", async () => {
  const observer = await ready();
  const previous = controlledResponse(true);
  const next = controlledResponse();
  queueNetwork([previous, next]);
  const first = stream.generateMarvin("first");
  previous.send({ type: "queued", position: 1 });
  await settle();
  stream.stopMarvin();
  const second = stream.generateMarvin("second");
  next.send({ type: "queued", position: 2 });
  await settle();
  previous.send({ type: "final", text: "obsolete", telemetry: telemetry() });
  await first;
  expect(observer.state.phase).toBe("queued");
  expect(observer.state.prompt).toBe("second");
  expect(observer.state.frames).toEqual([]);
  expect(observer.state.text).toBe("");
  next.send({ type: "final", text: "current" });
  await second;
  expect(observer.state.text).toBe("current");
});

test("an untouched visible brain does not preserve a closed chat request", async () => {
  const observer = await ready();
  presence();
  stream.setMarvinSurfaceEnabled("robot", true);
  const response = controlledResponse();
  queueNetwork([response]);
  const running = stream.generateMarvin("hello");
  response.send({ type: "queued", position: 1 });
  await settle();
  stream.setMarvinSurfaceEnabled("robot", false);
  await running;
  expect(observer.state.phase).toBe("stopped");
  expect(global.fetch.mock.calls.filter((call) => /cancel$/.test(call[0]))).toHaveLength(1);
});

test("a direct handoff to the brain preserves a request, then clicking elsewhere cancels", async () => {
  const observer = await ready();
  const views = presence();
  stream.setMarvinSurfaceEnabled("robot", true);
  const response = controlledResponse();
  queueNetwork([response]);
  const running = stream.generateMarvin("hello");
  response.send({ type: "queued", position: 1 });
  await settle();
  stream.setMarvinSurfaceEnabled("robot", false);
  global.document.dispatch("focusin", views.brain.child);
  await settle();
  expect(observer.state.phase).toBe("queued");
  expect(global.fetch).toHaveBeenCalledTimes(1);
  global.document.dispatch("click", {});
  await running;
  expect(observer.state.phase).toBe("stopped");
});

test("leaving the brain viewport releases the request and returning does not resume it", async () => {
  const observer = await ready();
  const views = presence();
  global.document.dispatch("click", views.brain.child);
  const response = controlledResponse();
  queueNetwork([response]);
  const running = stream.generateMarvin("hello");
  response.send({ type: "start" });
  await settle();
  views.brain.rect.top = 900;
  global.window.dispatch("scroll");
  await running;
  expect(observer.state.phase).toBe("stopped");
  views.brain.rect.top = 0;
  global.window.dispatch("scroll");
  await settle();
  await stream.generateMarvin("not engaged");
  expect(global.fetch.mock.calls.filter((call) => /generate_sse$/.test(call[0]))).toHaveLength(1);
});

["blur", "pagehide", "visibilitychange"].forEach((boundary) => {
  test(`${boundary} immediately cancels and never automatically resumes`, async () => {
    const observer = await ready();
    const views = presence();
    global.document.dispatch("click", views.brain.child);
    const response = controlledResponse();
    queueNetwork([response]);
    const running = stream.generateMarvin("hello");
    response.send({ type: "queued", position: 1 });
    await settle();
    if (boundary === "visibilitychange") {
      global.document.hidden = true;
      global.document.dispatch(boundary);
    } else global.window.dispatch(boundary);
    expect(observer.state.phase).toBe("stopped");
    await running;
    global.document.hidden = false;
    global.window.dispatch("focus");
    global.document.dispatch("visibilitychange");
    await settle();
    expect(global.fetch.mock.calls.filter((call) => /generate_sse$/.test(call[0]))).toHaveLength(1);
  });
});

test("unmounting the engaged surface cancels even if the other surface remains visible", async () => {
  const observer = await ready();
  const views = presence();
  global.document.dispatch("click", views.brain.child);
  const response = controlledResponse();
  queueNetwork([response]);
  const running = stream.generateMarvin("hello");
  response.send({ type: "queued", position: 1 });
  await settle();
  cleanups[1]();
  await running;
  expect(observer.state.phase).toBe("stopped");
});

test("queue expiry reports a released spot rather than a model failure", async () => {
  const observer = await ready();
  global.fetch = jest.fn(() => Promise.resolve(responseWithChunks([
    encoder.encode(event({ type: "error", code: "queue_expired" })),
  ])));
  await stream.generateMarvin("hello");
  expect(observer.state.phase).toBe("error");
  expect(observer.state.error).toMatch(/spot was released/);
});

test("parses split CRLF boundaries, multiline data, comments, and a final unterminated event", () => {
  const received = [];
  const parse = stream.createEventParser((payload) => received.push(payload));
  parse(': heartbeat\r\ndata: {"type":"intermediate",\r\n');
  parse('data: "text":"first"}\r');
  parse("\n\r");
  expect(received).toEqual([]);
  parse('\ndata: [DONE]\r\n\r\ndata: {"type":"final","text":"done"}');
  expect(received).toEqual([{ type: "intermediate", text: "first" }]);
  parse("", true);
  expect(received).toEqual([
    { type: "intermediate", text: "first" },
    { type: "final", text: "done" },
  ]);
});

test("rejects unsupported, ragged, nonfinite, and oversized activation frames", () => {
  expect(stream.validTelemetry(telemetry())).toBe(true);
  [
    null,
    telemetry({ version: 2 }),
    telemetry({ metric: "attention" }),
    telemetry({ normalization: "minmax" }),
    telemetry({ layerIndices: [] }),
    telemetry({ layerIndices: [-1, 1] }),
    telemetry({ tokenPositions: [0, 1.5] }),
    telemetry({ activations: [[0], [0.5, 1]] }),
    telemetry({
      activations: [
        [NaN, 0],
        [0, 1],
      ],
    }),
    telemetry({
      activations: [
        [Infinity, 0],
        [0, 1],
      ],
    }),
    telemetry({
      activations: [
        [-0.1, 0],
        [0, 1.1],
      ],
    }),
    telemetry({
      layerIndices: Array(129).fill(0),
      activations: Array(129).fill([0, 1]),
    }),
  ].forEach((frame) => expect(stream.validTelemetry(frame)).toBe(false));
});

test("shares live text and measured frames between consumers, including UTF-8 split across every byte", async () => {
  const robot = await ready();
  const brain = observe();
  const bytes = encoder.encode(
    event({
      type: "intermediate",
      step: 1,
      total_steps: 2,
      text: "café 🤖",
      telemetry: telemetry(),
    }) + event({ type: "final", step: 2, total_steps: 2, text: "prêt 🤖" }),
  );
  const response = responseWithChunks(
    Array.from(bytes, (byte) => new Uint8Array([byte])),
  );
  global.fetch = jest.fn(() => Promise.resolve(response));
  await stream.generateMarvin("  bonjour  ");
  expect(robot.state).toEqual(brain.state);
  expect(brain.state.phase).toBe("complete");
  expect(brain.state.prompt).toBe("bonjour");
  expect(brain.state.text).toBe("prêt 🤖");
  expect(brain.state.frames.length).toBe(1);
  expect(brain.state.frames[0].text).toBe("café 🤖");
  expect(brain.state.frames[0].activations).toEqual([
    [0, 0.25],
    [0.5, 1],
  ]);
  expect(response.reader.cancel).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(global.fetch.mock.calls[0][1].body).capture_activations,
  ).toBe(true);
});

test("keeps text but does not visualize invalid telemetry", async () => {
  const observer = await ready();
  global.fetch = jest.fn(() =>
    Promise.resolve(
      responseWithChunks([
        encoder.encode(
          event({
            type: "intermediate",
            step: 1,
            text: "still useful",
            telemetry: telemetry({ activations: [[5]] }),
          }),
        ),
        encoder.encode(event({ type: "final", step: 2, text: "done" })),
      ]),
    ),
  );
  await stream.generateMarvin("hello");
  expect(observer.state.phase).toBe("complete");
  expect(observer.state.text).toBe("done");
  expect(observer.state.frames).toEqual([]);
});

test("requests text-only generation when health explicitly says telemetry is unsupported", async () => {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          model_loaded: true,
          telemetry: {
            available: false,
            version: 1,
            layer_count: 0,
            max_tokens: 32,
          },
        }),
    }),
  );
  await stream.checkMarvinHealth();
  const observer = observe();
  global.fetch = jest.fn(() =>
    Promise.resolve(
      responseWithChunks([
        encoder.encode(
          event({ type: "final", text: "Still happy to chat.", step: 2 }),
        ),
      ]),
    ),
  );
  await stream.generateMarvin("hello");
  expect(
    JSON.parse(global.fetch.mock.calls[0][1].body).capture_activations,
  ).toBe(false);
  expect(observer.state.phase).toBe("complete");
  expect(observer.state.text).toBe("Still happy to chat.");
  expect(observer.state.frames).toEqual([]);
  expect(observer.state.telemetryAvailable).toBe(false);
});

test("preserves received frames and reports a connection that closes without a final event", async () => {
  const observer = await ready();
  global.fetch = jest.fn(() =>
    Promise.resolve(
      responseWithChunks([
        encoder.encode(
          event({
            type: "intermediate",
            step: 7,
            text: "partial answer",
            telemetry: telemetry(),
          }),
        ),
      ]),
    ),
  );
  await stream.generateMarvin("hello");
  expect(observer.state.phase).toBe("error");
  expect(observer.state.error).toMatch(/before Marvin finished/);
  expect(observer.state.text).toBe("partial answer");
  expect(observer.state.frames.length).toBe(1);
});

test("reports explicit inference errors and permits a subsequent request", async () => {
  const observer = await ready();
  global.fetch = jest.fn(() =>
    Promise.resolve(
      responseWithChunks([
        encoder.encode(event({ type: "error", error: "backend internals" })),
      ]),
    ),
  );
  await stream.generateMarvin("hello");
  expect(observer.state.phase).toBe("error");
  expect(observer.state.error).toMatch(/inference stopped/);
  global.fetch = jest.fn(() =>
    Promise.resolve(
      responseWithChunks([
        encoder.encode(event({ type: "final", step: 96, text: "recovered" })),
      ]),
    ),
  );
  await stream.generateMarvin("try again");
  expect(observer.state.phase).toBe("complete");
  expect(observer.state.error).toBe("");
});

test("surfaces a full queue and releases the request guard", async () => {
  const observer = await ready();
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 429 }));
  await stream.generateMarvin("hello");
  expect(observer.state.phase).toBe("error");
  expect(observer.state.error).toMatch(/little crowd/);
  await stream.generateMarvin("again");
  expect(global.fetch.mock.calls.filter((call) => /generate_sse$/.test(call[0]))).toHaveLength(2);
});

test("stops a pending request, ignores concurrent submissions, and can start again", async () => {
  const observer = await ready();
  global.fetch = jest.fn(
    (url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  );
  const running = stream.generateMarvin("first");
  await stream.generateMarvin("second");
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(observer.state.prompt).toBe("first");
  stream.stopMarvin();
  await running;
  expect(observer.state.phase).toBe("stopped");
  expect(observer.state.error).toBe("");
  global.fetch = jest.fn(() =>
    Promise.resolve(
      responseWithChunks([
        encoder.encode(event({ type: "final", text: "new answer", step: 96 })),
      ]),
    ),
  );
  await stream.generateMarvin("third");
  expect(observer.state.phase).toBe("complete");
});

test("stopping during a pending stream read retains captured frames and cancels the reader", async () => {
  const observer = await ready();
  let reading;
  const waitingForRead = new Promise((resolve) => {
    reading = resolve;
  });
  let firstRead = true;
  let signal;
  const reader = {
    read: () => {
      if (firstRead) {
        firstRead = false;
        return Promise.resolve({
          done: false,
          value: encoder.encode(
            event({
              type: "intermediate",
              step: 1,
              text: "partial",
              telemetry: telemetry(),
            }),
          ),
        });
      }
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
        reading();
      });
    },
    cancel: jest.fn(() => Promise.resolve()),
  };
  global.fetch = jest.fn((url, options) => {
    signal = options.signal;
    return Promise.resolve({ ok: true, body: { getReader: () => reader } });
  });
  const running = stream.generateMarvin("hello");
  await waitingForRead;
  stream.stopMarvin();
  await running;
  expect(observer.state.phase).toBe("stopped");
  expect(observer.state.text).toBe("partial");
  expect(observer.state.frames.length).toBe(1);
  expect(reader.cancel).toHaveBeenCalledTimes(1);
});

test("distinguishes a stalled connection timeout from an intentional stop", async () => {
  const observer = await ready();
  jest.useFakeTimers();
  global.fetch = jest.fn(
    (url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  );
  const running = stream.generateMarvin("hello");
  jest.runOnlyPendingTimers();
  await running;
  expect(observer.state.phase).toBe("error");
  expect(observer.state.error).toMatch(/too long/);
});

test("deduplicates health checks and distinguishes warming from offline", async () => {
  let resolveHealth;
  global.fetch = jest.fn(
    () =>
      new Promise((resolve) => {
        resolveHealth = resolve;
      }),
  );
  const first = stream.checkMarvinHealth();
  const second = stream.checkMarvinHealth();
  expect(first).toBe(second);
  const observer = observe();
  resolveHealth({
    ok: true,
    json: () => Promise.resolve({ model_loaded: false }),
  });
  await first;
  expect(observer.state.health).toBe("warming");
  expect(observer.state.telemetryAvailable).toBe(false);
  global.fetch = jest.fn(() => Promise.reject(new Error("network down")));
  await stream.checkMarvinHealth();
  expect(observer.state.health).toBe("offline");
});

function tokenState(patch = {}) {
  return {
    version: 1,
    blockIndex: 0,
    blockStart: 0,
    blockSize: 2,
    tokens: [
      {
        position: 0,
        tokenId: 7,
        piece: "[MASK]",
        state: "masked",
        newlyCommitted: false,
        special: true,
      },
      {
        position: 1,
        tokenId: 42,
        piece: " hello",
        state: "committed",
        newlyCommitted: true,
        special: false,
      },
    ],
    ...patch,
  };
}

test("validates bounded response-only token states and commit flags", () => {
  expect(stream.validTokenState(tokenState())).toBe(true);
  [
    null,
    tokenState({ version: 2 }),
    tokenState({ blockSize: 0 }),
    tokenState({ blockStart: 255 }),
    tokenState({ blockIndex: -1 }),
    tokenState({ tokens: [] }),
    tokenState({
      tokens: [
        { ...tokenState().tokens[0], position: 1 },
        tokenState().tokens[1],
      ],
    }),
    tokenState({
      tokens: [
        { ...tokenState().tokens[0], newlyCommitted: true },
        tokenState().tokens[1],
      ],
    }),
    tokenState({
      tokens: [
        { ...tokenState().tokens[0], state: "guessed" },
        tokenState().tokens[1],
      ],
    }),
    tokenState({
      tokens: [
        { ...tokenState().tokens[0], tokenId: Infinity },
        tokenState().tokens[1],
      ],
    }),
    tokenState({ blockStart: 1, blockSize: 1 }), // Previous blocks cannot still be masked.
    tokenState({
      tokens: [
        tokenState().tokens[0],
        { ...tokenState().tokens[1], piece: "x".repeat(513) },
      ],
    }),
  ].forEach((snapshot) => expect(stream.validTokenState(snapshot)).toBe(false));
});

test("retains exact mask and commit snapshots across blocks and resets same-prompt runs", async () => {
  const observer = await ready();
  const first = tokenState();
  const second = tokenState({
    tokens: [
      {
        ...first.tokens[0],
        tokenId: 20,
        piece: "Well",
        state: "committed",
        special: false,
        newlyCommitted: true,
      },
      { ...first.tokens[1], newlyCommitted: false },
    ],
  });
  const third = tokenState({
    blockIndex: 1,
    blockStart: 2,
    blockSize: 1,
    tokens: [
      ...second.tokens.map((token) => ({ ...token, newlyCommitted: false })),
      { ...first.tokens[0], position: 2 },
    ],
  });
  const frames = [
    telemetry({ blockIndex: 0, tokenState: first }),
    telemetry({ blockIndex: 0, tokenState: second }),
    telemetry({
      blockIndex: 1,
      tokenPositions: [2],
      activations: [[0.5], [0.6]],
      tokenState: third,
    }),
  ];
  global.fetch = jest.fn(() =>
    Promise.resolve(
      responseWithChunks([
        ...frames.map((frame, index) =>
          encoder.encode(
            event({
              type: "intermediate",
              step: index + 1,
              total_steps: 3,
              text: "hello",
              telemetry: frame,
            }),
          ),
        ),
        encoder.encode(
          event({ type: "final", step: 3, total_steps: 3, text: "Well hello" }),
        ),
      ]),
    ),
  );
  await stream.generateMarvin("hello");
  expect(observer.state.frames.map((frame) => frame.tokenState)).toEqual([
    first,
    second,
    third,
  ]);
  expect(observer.state.frames[0].tokenState.tokens[0].state).toBe("masked");
  expect(observer.state.frames[1].tokenState.tokens[0].tokenId).toBe(20);
  expect(observer.state.tokenStatesAvailable).toBe(true);
  expect(observer.state.runId).toBe(1);
  global.fetch = jest.fn(() =>
    Promise.resolve(
      responseWithChunks([
        encoder.encode(event({ type: "final", step: 1, text: "new run" })),
      ]),
    ),
  );
  await stream.generateMarvin("hello");
  expect(observer.state.runId).toBe(2);
  expect(observer.state.frames).toEqual([]);
});

test("keeps measured activations when token data is malformed or belongs to another block", async () => {
  const observer = await ready();
  global.fetch = jest.fn(() =>
    Promise.resolve(
      responseWithChunks([
        encoder.encode(
          event({
            type: "intermediate",
            step: 1,
            telemetry: telemetry({ blockIndex: 1, tokenState: tokenState() }),
          }),
        ),
        encoder.encode(
          event({
            type: "intermediate",
            step: 2,
            telemetry: telemetry({
              blockIndex: 0,
              tokenState: tokenState({ tokens: [] }),
            }),
          }),
        ),
        encoder.encode(event({ type: "final", step: 2, text: "hello" })),
      ]),
    ),
  );
  await stream.generateMarvin("hello");
  expect(observer.state.frames.length).toBe(2);
  expect(
    observer.state.frames.every((frame) => frame.tokenState === null),
  ).toBe(true);
  expect(observer.state.telemetryAvailable).toBe(true);
  expect(observer.state.tokenStatesAvailable).toBe(false);
});

test("accepts bounded projection measurements and rejects invalid head or neuron mappings", () => {
  const internals = {
    version: 1,
    headCount: 2,
    headDim: 128,
    neuronIndices: [0, 3071],
    attentionHeadRms: [
      [0, 2],
      [1, 3],
    ],
    mlpNeuronRms: [
      [4, 0],
      [2, 5],
    ],
  };
  expect(stream.validInternals(internals, 2)).toBe(true);
  [
    { ...internals, version: 2 },
    { ...internals, headCount: 129 },
    { ...internals, headDim: -1 },
    { ...internals, neuronIndices: [0, 0] },
    { ...internals, neuronIndices: [2, 1] },
    { ...internals, neuronIndices: [0, 65536] },
    {
      ...internals,
      attentionHeadRms: [
        [0, Infinity],
        [1, 3],
      ],
    },
    { ...internals, mlpNeuronRms: [[1], [2]] },
    {
      ...internals,
      mlpNeuronRms: [
        [1, 2],
        [-1, 2],
      ],
    },
  ].forEach((value) => expect(stream.validInternals(value, 2)).toBe(false));
  expect(stream.validInternals(internals, 28)).toBe(false);
});

test("keeps valid same-pass internals and discards malformed internals without losing token or layer frames", async () => {
  const brain = await ready();
  const internals = {
    version: 1,
    headCount: 2,
    headDim: 128,
    neuronIndices: [0, 3071],
    attentionHeadRms: [
      [0, 2],
      [1, 3],
    ],
    mlpNeuronRms: [
      [4, 0],
      [2, 5],
    ],
  };
  global.fetch = jest.fn(() =>
    Promise.resolve(
      responseWithChunks([
        encoder.encode(
          event({
            type: "intermediate",
            step: 1,
            telemetry: telemetry({ internals }),
          }) +
            event({
              type: "intermediate",
              step: 2,
              telemetry: telemetry({
                internals: { ...internals, mlpNeuronRms: [[1]] },
              }),
            }) +
            event({ type: "final", step: 2, text: "done" }),
        ),
      ]),
    ),
  );
  await stream.generateMarvin("hello");
  expect(brain.state.frames.length).toBe(2);
  expect(brain.state.frames[0].internals).toEqual(internals);
  expect(brain.state.frames[1].internals).toBe(null);
  expect(brain.state.frames[1].activations).toEqual(telemetry().activations);
});

function projectionInternals() {
  return {
    version: 1,
    headCount: 2,
    kvHeadCount: 1,
    headDim: 128,
    neuronIndices: [0, 3071],
    attentionHeadRms: [[0, 2], [1, 3]],
    mlpNeuronRms: [[4, 0], [2, 5]],
    queryHeadRms: [[1, 2], [3, 4]],
    keyHeadRms: [[2], [3]],
    valueHeadRms: [[4], [5]],
  };
}

function stageMeasurements() {
  return {
    embeddingRms: [0, 1],
    finalNormRms: [2, 3],
    lmHeadRms: [4, 5],
    lmHeadTokenIndices: [0, 151935],
  };
}

test("keeps optional stage measurements only with bounded token and vocabulary samples", () => {
  const stages = stageMeasurements();
  expect(stream.sanitizeStages(stages, 2)).toEqual(stages);
  expect(stream.sanitizeStages({ embeddingRms: [1, 2] }, 2)).toEqual({ embeddingRms: [1, 2] });
  expect(stream.sanitizeStages({ unknown: new Array(1000).fill(1) }, 2)).toBe(null);
  [null, [], {}, { embeddingRms: [1] }, { embeddingRms: [0, -1] },
    { embeddingRms: [0, Infinity] }, { finalNormRms: [0, NaN] },
    { lmHeadRms: [1, 2] }, { lmHeadTokenIndices: [0, 1] },
    { embeddingRms: new Array(129).fill(0) },
  ].forEach((value) => expect(stream.sanitizeStages(value, 2)).toBe(null));
  [0, 129, 1.5].forEach((count) => expect(stream.sanitizeStages(stages, count)).toBe(null));
  [[], [1, 1], [2, 1], [-1, 2], [0, 1.5], [0, 2000000],
    Array.from({ length: 65 }, (_, index) => index),
  ].forEach((indices) => {
    expect(stream.sanitizeStages({ ...stages, lmHeadTokenIndices: indices }, 2)).toEqual({
      embeddingRms: stages.embeddingRms,
      finalNormRms: stages.finalNormRms,
    });
  });
  expect(stream.sanitizeStages({ ...stages, lmHeadRms: [1] }, 2)).toEqual({
    embeddingRms: stages.embeddingRms,
    finalNormRms: stages.finalNormRms,
  });
});

test("validates QKV grouped-head dimensions without discarding valid legacy measurements", () => {
  const internals = projectionInternals();
  const architecture = { queryHeads: 2, kvHeads: 1, headDim: 128 };
  expect(stream.sanitizeInternals(internals, 2, architecture)).toEqual(internals);
  const legacy = stream.sanitizeInternals({ ...internals, queryHeadRms: null }, 2);
  expect(legacy).toEqual({
    version: 1,
    headCount: 2,
    headDim: 128,
    neuronIndices: internals.neuronIndices,
    attentionHeadRms: internals.attentionHeadRms,
    mlpNeuronRms: internals.mlpNeuronRms,
  });
  [
    { ...internals, kvHeadCount: 0 },
    { ...internals, kvHeadCount: 3 },
    { ...internals, kvHeadCount: 1.5 },
    { ...internals, queryHeadRms: [[1], [2]] },
    { ...internals, queryHeadRms: [[1, 2]] },
    { ...internals, keyHeadRms: [[1, 2], [3, 4]] },
    { ...internals, valueHeadRms: [[Infinity], [2]] },
    { ...internals, valueHeadRms: [[-1], [2]] },
    { ...internals, valueHeadRms: new Array(129).fill([1]) },
  ].forEach((value) => expect(stream.sanitizeInternals(value, 2)).toEqual(legacy));
  [
    { ...architecture, queryHeads: 4 },
    { ...architecture, kvHeads: 2 },
    { ...architecture, headDim: 64 },
  ].forEach((value) => expect(stream.sanitizeInternals(internals, 2, value)).toEqual(legacy));
  const threeHeads = {
    ...internals,
    headCount: 3,
    kvHeadCount: 2,
    attentionHeadRms: [[1, 2, 3], [4, 5, 6]],
    queryHeadRms: [[1, 2, 3], [4, 5, 6]],
    keyHeadRms: [[1, 2], [3, 4]],
    valueHeadRms: [[1, 2], [3, 4]],
  };
  expect(stream.sanitizeInternals(threeHeads, 2).queryHeadRms).toBe(undefined);
  expect(stream.sanitizeInternals({ ...internals, attentionHeadRms: [] }, 2)).toBe(null);
  expect(stream.sanitizeInternals(internals, 129)).toBe(null);
});

test("sanitizes new telemetry groups before retaining streamed frames", async () => {
  const architecture = { ...stream.DEFAULT_ARCHITECTURE, layers: 2, queryHeads: 2, kvHeads: 1 };
  const brain = await ready(architecture);
  const stages = stageMeasurements();
  const internals = projectionInternals();
  global.fetch = jest.fn(() => Promise.resolve(responseWithChunks([
    encoder.encode([
      event({ type: "intermediate", step: 1, telemetry: telemetry({ stages, internals, architecture }) }),
      event({ type: "intermediate", step: 2, telemetry: telemetry({
        architecture,
        stages: { ...stages, finalNormRms: [0], lmHeadTokenIndices: [2, 1] },
        internals: { ...internals, valueHeadRms: [[1, 2], [3, 4]] },
      }) }),
      event({ type: "intermediate", step: 3, telemetry: telemetry({
        stages: { embeddingRms: [0, Infinity] },
        internals: { ...internals, mlpNeuronRms: [] },
      }) }),
      event({ type: "final", step: 3, text: "done" }),
    ].join("")),
  ])));
  await stream.generateMarvin("hello");
  expect(brain.state.frames.length).toBe(3);
  expect(brain.state.frames[0].stages).toEqual(stages);
  expect(brain.state.frames[0].internals).toEqual(internals);
  expect(brain.state.frames[1].stages).toEqual({ embeddingRms: stages.embeddingRms });
  expect(brain.state.frames[1].internals.queryHeadRms).toBe(undefined);
  expect(brain.state.frames[1].internals.attentionHeadRms).toEqual(internals.attentionHeadRms);
  expect(brain.state.frames[2].stages).toBe(null);
  expect(brain.state.frames[2].internals).toBe(null);
  expect(brain.state.frames.every((frame) => frame.activations.length === 2)).toBe(true);
});

function fastArchitecture() {
  return {
    modelId: "Efficient-Large-Model/Fast_dLLM_v2_1.5B",
    modelLabel: "Fast-dLLM · 1.5B",
    modelUrl: "https://huggingface.co/Efficient-Large-Model/Fast_dLLM_v2_1.5B",
    modelFamily: "Qwen2.5",
    layers: 28,
    hiddenSize: 1536,
    mlpWidth: 8960,
    queryHeads: 12,
    kvHeads: 2,
    headDim: 128,
  };
}

test("accepts both model architectures and rejects unsafe links or impossible grouped-query dimensions", () => {
  const architecture = fastArchitecture();
  expect(stream.validArchitecture(stream.DEFAULT_ARCHITECTURE)).toBe(true);
  expect(stream.validArchitecture(architecture)).toBe(true);
  [
    null,
    { ...architecture, modelUrl: "javascript:alert(1)" },
    { ...architecture, modelUrl: "https://example.com/model" },
    { ...architecture, modelId: "../../model" },
    { ...architecture, modelLabel: "model\nwith newline" },
    { ...architecture, layers: 129 },
    { ...architecture, mlpWidth: Infinity },
    { ...architecture, hiddenSize: 0 },
    { ...architecture, queryHeads: 12.5 },
    { ...architecture, kvHeads: 5 },
    { ...architecture, kvHeads: 0 },
    { ...architecture, headDim: 513 },
  ].forEach((value) => expect(stream.validArchitecture(value)).toBe(false));
});

test("snapshots each frame's model when health later changes", async () => {
  const architecture = fastArchitecture();
  const brain = await ready(architecture);
  expect(brain.state.config.architecture).toEqual(architecture);
  const measuredFrame = telemetry({
    layerIndices: Array.from({ length: 28 }, (_, index) => index),
    activations: Array.from({ length: 28 }, () => [0.1, 0.2]),
  });
  global.fetch = jest.fn(() =>
    Promise.resolve(
      responseWithChunks([
        encoder.encode(
          event({
            type: "intermediate",
            step: 1,
            telemetry: measuredFrame,
          }) +
            event({
              type: "intermediate",
              step: 2,
              telemetry: { ...measuredFrame, architecture },
            }) +
            event({
              type: "intermediate",
              step: 3,
              telemetry: {
                ...measuredFrame,
                architecture: { ...architecture, kvHeads: 5 },
              },
            }) +
            event({ type: "final", step: 3, text: "done" }),
        ),
      ]),
    ),
  );
  await stream.generateMarvin("hello");
  expect(
    brain.state.frames.every(
      (frame) => frame.architecture.modelId === architecture.modelId,
    ),
  ).toBe(true);
  expect(brain.state.frames[1].architecture).not.toBe(architecture);
  await ready(stream.DEFAULT_ARCHITECTURE);
  expect(brain.state.config.architecture).toEqual(stream.DEFAULT_ARCHITECTURE);
  expect(
    stream.marvinArchitecture(brain.state.frames[0], brain.state.config),
  ).toEqual(architecture);
});

test("uses model metadata and actual sampled channels with a legacy Qwen3 fallback", async () => {
  const brain = await ready(fastArchitecture());
  const { brainDimensions } = require("./components/BrainScene");
  expect(brainDimensions(null, brain.state.config)).toEqual({
    layers: 28,
    queryHeads: 12,
    kvHeads: 2,
    channels: 32,
    mlpWidth: 8960,
  });
  expect(brainDimensions(null, null)).toEqual({
    layers: 28,
    queryHeads: 16,
    kvHeads: 8,
    channels: 32,
    mlpWidth: 3072,
  });
  expect(
    brainDimensions(
      {
        architecture: fastArchitecture(),
        internals: { headCount: 12, neuronIndices: [0, 4480, 8959] },
      },
      brain.state.config,
    ),
  ).toEqual({
    layers: 28,
    queryHeads: 12,
    kvHeads: 2,
    channels: 3,
    mlpWidth: 8960,
  });
});
