import React from "react";
import * as THREE from "three/build/three";
import { useTheme } from "../siteTheme";
import { brainPalette } from "./BrainStructure";

function colorAt(value, palette, normalized = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  const strength = normalized ? value : value / (1 + value);
  return `#${new THREE.Color(palette.overviewInk).lerp(new THREE.Color(palette.accent), Math.min(1, strength)).getHexString()}`;
}

function Stage({ label, values, kind, title, palette }) {
  const measured = Array.isArray(values) && values.length;
  const count = measured ? values.length : 16;
  const columns = Math.min(8, count);
  const rows = Math.ceil(count / columns);
  return (
    <div className={`brain-overview__stage brain-overview__stage--${kind}`} title={title}>
      <span>{label}</span>
      <svg viewBox="0 0 48 28" aria-hidden="true">
        <rect x="0.5" y="0.5" width="47" height="27" rx="2" fill="none" stroke={palette.border} />
        {Array.from({ length: count }, (_, index) => (
          <rect
            key={index}
            x={5 + (index % columns) * (38 / columns)}
            y={4 + Math.floor(index / columns) * (20 / rows)}
            width={Math.max(2, 38 / columns - 1.6)}
            height={Math.max(2, 20 / rows - 2)}
            rx="0.5"
            fill={measured ? colorAt(values[index], palette) : palette.idle}
          />
        ))}
      </svg>
    </div>
  );
}

export default function BrainOverview({ frame, layers, layer, hiddenSize, setSelectedLayer, selectLayer }) {
  const { theme } = useTheme();
  const palette = brainPalette(theme);
  const stages = frame && frame.stages;
  const finalValues = stages && stages.finalNormRms;
  const finalMagnitude = Array.isArray(finalValues) && finalValues.length
    ? finalValues.reduce((sum, value) => sum + value, 0) / finalValues.length
    : null;
  return (
    <div className="brain-overview" aria-label="Model architecture: token embedding, transformer blocks, final normalization, and language model output head">
      <Stage
        palette={palette}
        label="Embedding"
        kind="embedding"
        values={stages && stages.embeddingRms}
        title={`Token embedding · ${hiddenSize.toLocaleString("en-US")} dimensions. Color shows each sampled token’s embedding RMS when measured.`}
      />
      <span className="brain-overview__arrow" aria-hidden="true">→</span>
      <div className="brain-overview__stack">
        <span>{layers} transformer blocks</span>
        <div className="brain-scene__layers" role="group" aria-label="Transformer layer">
          {Array.from({ length: layers }, (_, index) => {
            const row = frame && frame.activations && frame.activations[index];
            const magnitude = Array.isArray(row) && row.length
              ? row.reduce((sum, value) => sum + value, 0) / row.length : null;
            return (
              <button
                key={index}
                data-layer={index}
                type="button"
                className={`brain-scene__layer${index === layer ? " is-selected" : ""}`}
                aria-label={`Layer ${index + 1}${magnitude === null ? "" : `, mean normalized residual RMS ${magnitude.toFixed(3)}`}`}
                aria-pressed={index === layer}
                tabIndex={index === layer ? 0 : -1}
                title={`Block ${index + 1} · click to inspect`}
                onClick={() => setSelectedLayer(index)}
                onKeyDown={(event) => selectLayer(event, index)}
              >
                <span style={{ backgroundColor: colorAt(magnitude, palette, true) }} />
              </button>
            );
          })}
        </div>
      </div>
      <span className="brain-overview__arrow" aria-hidden="true">→</span>
      <div className="brain-overview__norm" title="Final RMSNorm · mean RMS across sampled token outputs">
        <span>Norm</span>
        <i style={{ borderColor: colorAt(finalMagnitude, palette) }} />
      </div>
      <span className="brain-overview__arrow brain-overview__arrow--last" aria-hidden="true">→</span>
      <Stage
        palette={palette}
        label="LM head"
        kind="lm-head"
        values={stages && stages.lmHeadRms}
        title="Language model output head · color shows each sampled token’s RMS over 64 sampled vocabulary logits."
      />
    </div>
  );
}
