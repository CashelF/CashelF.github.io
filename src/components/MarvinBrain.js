import React from "react";
import BrainScene from "./BrainScene";
import TokenFlow from "./TokenFlow";
import {
  useMarvin,
  generateMarvin,
  stopMarvin,
  checkMarvinHealth,
  marvinArchitecture,
  registerMarvinSurface,
  engageMarvinSurface,
  QUEUED_MESSAGE,
  marvinQueuePosition,
} from "../marvinStream";
import "../styles/MarvinBrain.css";

export default function MarvinBrain() {
  const marvin = useMarvin();
  const sectionRef = React.useRef(null);
  const [input, setInput] = React.useState("");
  const [selected, setSelected] = React.useState(null);
  const queued = marvin.phase === "queued";
  const busy = queued || marvin.phase === "connecting" || marvin.phase === "streaming";
  const latest = marvin.frames.length - 1;
  const frameIndex = selected === null ? latest : Math.min(selected, latest);
  const frame = marvin.frames[frameIndex] || null;
  const architecture = marvinArchitecture(frame, marvin.config);
  React.useEffect(() => registerMarvinSurface("brain", sectionRef.current), []);
  React.useEffect(() => {
    setSelected(null);
  }, [marvin.runId]);
  const status =
    selected !== null && frame
      ? "Replay"
      : queued
        ? "Waiting"
        : busy
        ? frame
          ? "Live"
          : "Thinking"
        : frame
          ? "Captured"
          : marvin.health === "checking"
            ? "Connecting"
            : marvin.health === "offline"
              ? "Offline"
              : marvin.health === "warming"
                ? "Warming up"
                : marvin.telemetryAvailable
                  ? "Ready"
                  : "Chat only";
  const output = selected !== null && frame ? frame.text : marvin.text;
  const submit = (event) => {
    event.preventDefault();
    if (busy) return;
    const prompt = input.trim() || "Say hello in one short sentence.";
    if (!input.trim()) setInput(prompt);
    setSelected(null);
    engageMarvinSurface("brain");
    generateMarvin(prompt);
  };

  return (
    <section
      id="brain"
      ref={sectionRef}
      tabIndex={-1}
      onPointerDown={() => engageMarvinSurface("brain")}
      className="brain-section page-width"
      aria-labelledby="brain-title"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">01 / LIVE DIFFUSION</p>
          <h2 id="brain-title">Marvin’s brain.</h2>
        </div>
        <a
          className="brain-model-label"
          href={architecture.modelUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {architecture.modelLabel} <span aria-hidden="true">↗</span>
        </a>
      </div>
      <div className="brain-console">
        <div className="brain-toolbar">
          <span
            className={`brain-status${busy && frame && selected === null ? " is-live" : ""}`}
            role="status"
          >
            <i />
            {status}
          </span>
          {(marvin.health === "offline" || marvin.health === "warming") &&
            !busy && (
              <button
                type="button"
                className="brain-reconnect"
                onClick={checkMarvinHealth}
                aria-label="Reconnect to Marvin"
              >
                ↻
              </button>
            )}
          <span className="brain-runtime">
            {frame && Number.isFinite(frame.forwardMs)
              ? `${Math.round(frame.forwardMs)} ms / pass`
              : marvin.device === "cuda"
                ? "GPU"
                : "CPU"}
          </span>
        </div>
        <div className="brain-stage">
          <div className="brain-visual">
            <BrainScene frame={frame} config={marvin.config} />
          </div>
          <div className="brain-generation">
            <TokenFlow frame={frame} busy={busy && !queued} />
          </div>
        </div>
        <div
          className={`brain-response${queued ? " is-queued" : ""}`}
          aria-label={
            selected !== null ? "Response at this step" : "Marvin’s response"
          }
        >
          <span className="eyebrow">MARVIN</span>
          <p role={queued ? "status" : undefined}>
            {queued ? QUEUED_MESSAGE : output ||
              (busy ? "Thinking…" : "Ask something. Watch it take shape.")}
            {queued && <strong>{marvinQueuePosition(marvin.queuePosition)}</strong>}
          </p>
        </div>
        <div className="brain-timeline">
          <span className="brain-timeline-title">
            STEP{" "}
            <strong>
              {frame ? String(frame.step).padStart(2, "0") : "—"}
              <span> / {marvin.totalSteps}</span>
            </strong>
          </span>
          <input
            aria-label="Inspect captured diffusion step"
            aria-valuetext={
              frame
                ? `Diffusion step ${frame.step} of ${marvin.totalSteps}`
                : "No captured steps"
            }
            type="range"
            min="0"
            max={Math.max(0, latest)}
            value={Math.max(0, frameIndex)}
            disabled={latest < 1}
            onChange={(event) => setSelected(Number(event.target.value))}
          />
          <button
            type="button"
            className={selected === null ? "is-following" : ""}
            onClick={() => setSelected(null)}
            disabled={!frame}
          >
            {busy ? "Live" : "Latest"} <span aria-hidden="true">↗</span>
          </button>
        </div>
        <form className="brain-composer" onSubmit={submit}>
          <label className="brain-sr-only" htmlFor="marvin-prompt">
            Give Marvin a thought
          </label>
          <textarea
            id="marvin-prompt"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              )
                submit(event);
            }}
            placeholder="Ask Marvin…"
            rows={1}
            maxLength={1000}
            disabled={busy}
          />
          {busy ? (
            <button type="button" onClick={(event) => {
              event.preventDefault();
              stopMarvin();
            }}>
              {queued ? "Cancel" : "Stop"} <span aria-hidden="true">■</span>
            </button>
          ) : (
            <button
              type="submit"
              className={!input.trim() ? "brain-try-example" : ""}
            >
              {input.trim() ? "Send" : "Try Marvin"}{" "}
              <span aria-hidden="true">↗</span>
            </button>
          )}
        </form>
        {marvin.error && (
          <p className="brain-error" role="alert">
            {marvin.error}
          </p>
        )}
      </div>
    </section>
  );
}
