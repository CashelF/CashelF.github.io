import React from "react";
import "./TokenFlow.css";

const SPECIAL_LABELS = {
  "<|im_end|>": "END",
  "<|endoftext|>": "END",
  "<|eot_id|>": "END",
  "</s>": "END",
  "<|im_start|>": "START",
  "<s>": "START",
};

function visiblePiece(token) {
  if (token.special) {
    return SPECIAL_LABELS[token.piece] || "SPECIAL";
  }
  const piece = token.piece || "";
  if (!piece) return "∅";
  // Preserve spaces within text. A standalone whitespace token needs a mark
  // to remain visible; its exact decoded piece is available in the inspector.
  if (/^\s+$/.test(piece)) {
    return piece
      .replace(/\r\n|\n|\r/g, "↵")
      .replace(/\t/g, "⇥")
      .replace(/ /g, "·");
  }
  return piece.replace(/\r\n|\n|\r/g, "↵").replace(/\t/g, "⇥");
}

function stateLabel(token) {
  if (token.state === "masked") return "Masked";
  if (token.state === "discarded") return "Discarded after end of response";
  return token.newlyCommitted ? "Settled this step" : "Settled";
}

function tokenDescription(token) {
  return `Position ${token.position + 1} · ${stateLabel(token)} · Token ID ${token.tokenId} · ${JSON.stringify(token.piece)}`;
}

export default function TokenFlow({ frame = null, busy = false }) {
  const [selectedPosition, setSelectedPosition] = React.useState(null);
  const state = frame && frame.tokenState;
  const hasTokens = Boolean(state && Array.isArray(state.tokens));
  const tokens = hasTokens ? state.tokens : [];
  const active = hasTokens
    ? tokens.filter(
        (token) =>
          token.position >= state.blockStart &&
          token.position < state.blockStart + state.blockSize,
      )
    : [];
  const context = hasTokens
    ? tokens.filter(
        (token) =>
          token.position < state.blockStart && token.state === "committed",
      )
    : [];
  const settled = active.filter((token) => token.state === "committed").length;
  const discarded = active.filter(
    (token) => token.state === "discarded",
  ).length;
  const remaining = active.filter((token) => token.state === "masked").length;
  const selectedToken = active.find(
    (token) => token.position === selectedPosition,
  );

  React.useEffect(() => {
    if (!hasTokens) setSelectedPosition(null);
  }, [hasTokens]);

  return (
    <div
      className={`token-flow${hasTokens ? " token-flow--captured" : " token-flow--empty"}`}
    >
      <div className="token-flow__heading">
        <div className="token-flow__block-label">
          <span className="token-flow__eyebrow">BLOCK</span>
          <span className="token-flow__block-number">
            {hasTokens ? String(state.blockIndex + 1).padStart(2, "0") : "—"}
          </span>
        </div>
        <span className="token-flow__count">
          {hasTokens ? (
            <React.Fragment>
              <strong>{settled}</strong> / {active.length - discarded} settled
            </React.Fragment>
          ) : (
            "TOKENS"
          )}
        </span>
      </div>

      {context.length > 0 && (
        <div className="token-flow__context">
          <p aria-label="Previously settled tokens">
            {context.map((token) => (
              <span
                key={token.position}
                title={tokenDescription(token)}
                className={
                  token.special ? "token-flow__context-special" : undefined
                }
              >
                {token.special ? `[${visiblePiece(token)}]` : token.piece}
              </span>
            ))}
          </p>
        </div>
      )}

      {hasTokens ? (
        <React.Fragment>
          <div
            className="token-flow__tokens"
            role="group"
            aria-label={`Block ${state.blockIndex + 1}: ${settled} settled, ${remaining} masked, ${discarded} discarded token positions`}
          >
            {active.map((token) => (
              <button
                type="button"
                key={token.position}
                className={`token-flow__token token-flow__token--${token.state}${token.newlyCommitted ? " token-flow__token--new" : ""}${token.special ? " token-flow__token--special" : ""}${selectedPosition === token.position ? " token-flow__token--selected" : ""}`}
                aria-label={tokenDescription(token)}
                aria-pressed={selectedPosition === token.position}
                title={tokenDescription(token)}
                onClick={() =>
                  setSelectedPosition(
                    selectedPosition === token.position ? null : token.position,
                  )
                }
              >
                <span className="token-flow__piece" aria-hidden="true">
                  {token.state === "masked" ? (
                    <i className="token-flow__mask" />
                  ) : token.state === "discarded" ? (
                    "×"
                  ) : (
                    visiblePiece(token)
                  )}
                </span>
              </button>
            ))}
          </div>
          {selectedToken && (
            <div
              className="token-flow__inspection"
              aria-live="polite"
              title={tokenDescription(selectedToken)}
            >
              <span className="token-flow__inspection-position">
                #{selectedToken.position + 1}
              </span>
              <span className="token-flow__token-id">
                ID {selectedToken.tokenId}
              </span>
              <code>{JSON.stringify(selectedToken.piece)}</code>
            </div>
          )}
        </React.Fragment>
      ) : (
        <div className="token-flow__waiting">
          <div className="token-flow__waiting-slots" aria-hidden="true">
            {Array.from({ length: 8 }, (_, index) => (
              <i key={index} />
            ))}
          </div>
          {(busy || frame) && (
            <p>{busy ? "Awaiting first pass" : "No token states"}</p>
          )}
        </div>
      )}

      {hasTokens && (
        <div className="token-flow__footer">
          <div className="token-flow__legend" aria-label="Token state legend">
            <span>
              <i className="token-flow__legend-mask" />
              Masked
            </span>
            <span>
              <i className="token-flow__legend-new" />
              New
            </span>
            <span>
              <i className="token-flow__legend-settled" />
              Settled
            </span>
            {discarded > 0 && (
              <span>
                <i className="token-flow__legend-discarded">×</i>Discarded
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
