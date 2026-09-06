# Marvin's activation stream

Marvin runs in the public [Cashel/diffusion-chatbot Hugging Face Space](https://huggingface.co/spaces/Cashel/diffusion-chatbot).
The original backend was inspected at revision `07584118b0f9a81244ef6ae560f1676ca1dd0ea0`.
`app.py` is based on that Space's source. The model is
[`dllm-hub/Qwen3-0.6B-diffusion-bd3lm-v0.1`](https://huggingface.co/dllm-hub/Qwen3-0.6B-diffusion-bd3lm-v0.1):
28 decoder layers, 1,024 hidden channels, running on the Space's CPU.

The activation, token-state, internal-measurement, and visitor queue backend is deployed at
[`dd8e9d6`](https://huggingface.co/spaces/Cashel/diffusion-chatbot/commit/dd8e9d6af19cc2c255966f7828592301a53d5f2f).
The runtime files are deployed from this directory, and the public
`/health` endpoint reports `telemetry.available: true`, `token_states: true`, and `internals: true`
with 28 layers on CPU.
The September 6 architecture extension also reports `qkv: true` and all three
stage metrics. A live hosted request returned eight complete measured frames
and its final response in 5.73 seconds; all seven deployed runtime files matched
the local source. The extension passed 75 backend tests and 35 frontend tests.
An interleaved local CPU benchmark measured 3.95 ms additional work per pass
relative to the previous telemetry (5.28%), with identical model outputs.
The original Space streamed text only; this version adds actual decoder
measurements. When checking a future deployment, verify telemetry support and
a complete measured `/generate_sse` response, not just the health status.

The website's standard public request was verified end to end in the browser:
48 consecutive measured steps across two blocks, all 28 layers, 16 attention
head outputs and 32 sampled MLP channels per layer, actual masked and committed
tokens, and final text matching the last measured frame. That CPU run delivered
its first frame after 9.75 seconds and finished after 52.21 seconds, measured
from response headers. These are observed
timings for one request, not latency guarantees. Recorded-frame browser checks
also cover timeline inspection, token inspection, keyboard navigation, and
mobile layout.

The queue deployment was verified with real public HTTP requests: one active
generation, two waiting requests, and a fourth rejected with HTTP 429. The
cancelled waiter produced no `start` or activation frames; the remaining waiter
advanced from position two to one and completed automatically. Cancelling an
active request after its first measured frame stopped it without a final
response, and the server returned to an empty queue. The recorded event trace
is in [queue-verification-2026-09-05.json](queue-verification-2026-09-05.json).
Checks also passed for 61 backend tests, 32 frontend tests, 18 browser lifecycle
cases, a browser-to-real-backend cancellation test, and the production build.

## What is measured

Each conditional denoising forward pass gets temporary hooks on all 28 decoder
layers. Each hook measures the RMS across the hidden channels of each token's
residual output, before the model's final norm. Two projection-input hooks also
measure each attention head's mixed-value output and 32 actual SwiGLU channels
per layer. These are real activation summaries, not attention weights or a full
neuron map.
The architecture extension also measures token embeddings, the final RMSNorm
output, and a bounded sample of vocabulary logits at the LM head. Each layer's
Q/K/V projection outputs are reduced by head before Q/K normalization, RoPE,
or key/value repetition. This keeps the 16 query heads and 8 shared key/value
heads distinct. Residual lines and head-sharing connections in the view describe
the model's structure; they are not measured attention probabilities.
The model's custom forward does not implement `output_hidden_states`, so hooks
are necessary. Prefix-cache and unconditional CFG forwards are excluded.

Up to 32 positions in the active generation block are measured. No prompt
tokens, prompts, or activations from other visitors are broadcast. Data flows
only down the requesting visitor's response. A model lock serializes inference
and scoped hooks are removed even on failure or cancellation. Telemetry is
opt-in and uses no additional model forward passes. Its CPU reductions and
serialization add some overhead.

## Wire format

`GET /health` includes:

```json
{"telemetry":{"available":true,"version":1,"metric":"hidden_state_rms","layer_count":28,"max_tokens":32,"token_states":true,"internals":true,"qkv":true,"stages":["embeddingRms","finalNormRms","lmHeadRms"]}}
```

`POST /generate_sse` accepts the existing options plus a client-generated UUID
`request_id` and `"capture_activations": true`. This emits a measurement on **every** denoising
forward, independent of `capture_interval`. Events remain ordinary SSE JSON:

```text
data: {"type":"intermediate","text":"…","step":1,"total_steps":96,"telemetry":{"version":1,"metric":"hidden_state_rms","normalization":"rms/(1+rms)","activations":[[0.25,0.5]],"rawRms":[[0.3333333,1.0]],"layerIndices":[0],"tokenPositions":[0,1],"blockIndex":0,"blockStep":1,"blockSteps":32,"forwardMs":18.5}}
```

The example is shortened schema documentation, not a captured model frame.
`activations` and `rawRms` have shape `[layer][sampled token]`. Layer indices,
block indices, and response-relative token positions start at zero. `step` and
`blockStep` start at one. `total_steps` accounts for a prompt ending within a
block; the final event reports the actual number executed if EOS ends it early.
Color uses the fixed transform `rms / (1 + rms)`, preserving comparisons across
steps rather than renormalizing each frame. `forwardMs` includes measurement
overhead. The stream starts with a `start` event, ends with `final`, and reports
inference failures as an `error` event. A queued request receives `queued` events
before `start`. Cancellation releases the model lock after the current forward
finishes; it cannot interrupt an individual PyTorch operation already executing.

## Queue and active visitors

Waitress serves HTTP connections in one process, and a dedicated inference
worker runs the model. One request can generate while up to two others wait in
FIFO order. All generation routes share the same admission guard and model
lock; simultaneous visitors cannot mix their activation measurements.

The browser creates an unpredictable UUID for each submission. An accepted
waiting request receives `{"type":"queued","position":1}` (next) or position
2. Position updates and SSE heartbeats keep the connection open; a `start`
event begins the existing measured stream automatically. A full queue returns
HTTP 429 with a friendly message. A duplicate live UUID returns HTTP 409.

`POST /requests/<request_id>/keepalive` renews that request's 12-second activity
lease. The frontend renews every three seconds while the visitor remains
engaged. `POST /requests/<request_id>/cancel` cancels idempotently, including
when cancellation arrives before the original submission. The UUID acts as
the cancellation capability; another visitor's request ID is never exposed.

Closing Marvin's composer, clicking outside the engaged brain section,
scrolling the brain out of view, hiding the tab, losing window focus, and
leaving the page all trigger a cancellation POST and abort the stream. Moving
directly between the chat and the brain keeps the same request if the new view
is engaged. Merely having the brain on screen does not keep a dismissed chat
request alive. Returning to the page does not restart a cancelled request.

The server checks leases before queue promotion and between model forwards.
Stream disconnect, lease expiry, and cancellation remove waiting tickets;
active inference stops cooperatively and removes its hooks. Waiting requests
expire after 180 seconds, and per-request output buffers are bounded. Terminal
SSE errors include `cancelled`, `lease_expired`, `queue_expired`, or
`connection_stalled` codes. Queues are intentionally in memory: a Space restart
ends the connection and the visitor can submit again.

`GET /health` also includes aggregate `queue` fields `active`, `waiting`,
`capacity` (waiting spots), and `lease_seconds`. It exposes no visitor content.
Legacy clients without a `request_id` can still generate immediately when
idle, but never enter the waiting queue and do not require keepalives.
Their disconnect and stalled-output cleanup still apply.

## Activation and token snapshots

On compatible models, each frame also includes `internals`:

```json
{
  "version": 1,
  "headCount": 16,
  "headDim": 128,
  "neuronIndices": [0, 99, 198],
  "attentionHeadRms": [[0.12, 0.34]],
  "mlpNeuronRms": [[0.56, 0.78]]
}
```

This shortened schema example omits most values. `attentionHeadRms` has shape
`[28][16]`: RMS across the same sampled active tokens and each head's 128 channels,
measured immediately before `self_attn.o_proj`. It measures the output of
attention, not the query/key scores or attention probabilities. `mlpNeuronRms`
has shape `[28][32]`: RMS across those tokens for 32 evenly spaced actual channel
indices from 0 through 3,071, immediately before `mlp.down_proj` and after the
SwiGLU gate. Values are raw, nonnegative RMS. These hooks share the residual
capture's conditional forward, scope, token sampling, and cleanup. They add no
forward passes. Models without compatible projection modules omit `internals`
and report the capability as false; residual and token-state telemetry remain
available.

When all layers expose compatible Q/K/V projections, `internals` additionally
contains `queryHeadRms` with shape `[28][16]`, `keyHeadRms` and `valueHeadRms`
with shape `[28][8]`, and `kvHeadCount: 8`. Each value is RMS over the sampled
active response tokens and that head's 128 projection channels. The widths and
grouping are checked against the actual modules; these fields are omitted
together if the modules are incompatible. These measurements precede Q/K
RMSNorm and RoPE and do not include cached prefix rows. Missing Q/K/V capability
does not disable existing attention-output or MLP measurements.

Compatible architecture modules add a `stages` object to the frame:

```json
{
  "embeddingRms": [0.12, 0.14],
  "finalNormRms": [0.85, 0.91],
  "lmHeadRms": [2.1, 2.3],
  "lmHeadTokenIndices": [0, 2412, 4823]
}
```

This example is shortened. Each RMS array aligns with `tokenPositions` and
contains one value per sampled active token. `embeddingRms` and `finalNormRms`
reduce the complete hidden dimension of those tokens. `lmHeadRms` reduces only
up to 64 deterministic, evenly spaced vocabulary columns, including both ends;
`lmHeadTokenIndices` gives their exact identities. It measures sampled logits,
not the RMS of the entire vocabulary, probabilities, or the chosen token's
confidence. Selecting rows and vocabulary columns in one indexing operation
avoids copying or reducing the full 151,936-column logit tensor for telemetry.
Stage fields are independently optional; the LM-head values and sampled token
indices appear together. Health and `start` capability metadata list the
available stage metric keys and report Q/K/V support as `qkv`.

All these additive fields retain telemetry version 1 and the existing token
sampling contract. Every installed hook must produce finite, correctly shaped
measurements before any frame metrics are published. Failure, cancellation,
and missing hook outputs remove all scoped hooks; no previous request's values
are reused.

Each measured intermediate also carries `telemetry.tokenState`:

```json
{
  "version": 1,
  "blockIndex": 0,
  "blockStart": 0,
  "blockSize": 2,
  "tokens": [
    {"position": 0, "tokenId": 9707, "piece": "Hello", "state": "committed", "newlyCommitted": true, "special": false},
    {"position": 1, "tokenId": 151669, "piece": "<|mask|>", "state": "masked", "newlyCommitted": false, "special": true}
  ]
}
```

This is a shortened schema example, not a captured frame. `blockStart` and each
token's `position` count from the beginning of the generated response. `blockSize`
is the actual active block length, including partial first and last blocks.
`tokens` contains the completed response prefix and active block only: no prompt
or future blocks. Every active position is included, even if the RMS view samples
a larger block down to 32 positions.

The token snapshot is taken **after** this forward's commit and EOS cleanup;
the RMS values describe decoder outputs **before** that commit. A position is
`masked` while its actual token ID is the mask ID, and `committed` once it holds a
retained non-mask token. `newlyCommitted` is true only when a mask becomes such a
token during this exact forward; zero-commit forwards still produce frames.
Earlier committed tokens keep their IDs and pieces across steps. If the first
EOS and its entire preceding prefix have settled, positions after that EOS
become `discarded`, carrying their actual padding IDs with `newlyCommitted: false`.
The EOS itself stays committed and special. This also covers already committed
suffix tokens discarded when an earlier EOS finishes the response. The last
measured frame already contains the same cleanup and text as the final event;
`final` remains text-only so no forward appears twice.

`piece` is the tokenizer's direct single-token decode with special tokens kept
and cleanup disabled. It is never a made-up mask placeholder or a guessed word.
Some byte-level pieces cannot individually decode to a complete Unicode
character; clients should use the event's full `text` for the readable response,
and preserve token IDs for inspection. `special` comes from the tokenizer's
special-ID list. Token states use the existing sampling result and require no
extra forwards. The additive `token_states` capability and `tokenState` field
preserve telemetry version 1 and older text/activation consumers.

The inherited sampler also stopped immediately when an EOS token committed,
even if earlier positions were still masked. Both generation paths now wait
for that preceding text to settle and discard tokens after the first EOS.

## Run and verify

```bash
python -m pip install -r backend/marvin/requirements.txt pytest
python -m pytest backend/marvin -q
PORT=7861 python backend/marvin/app.py
```

The model downloads on first start. `MODEL_NAME` and `MODEL_REVISION` can point
to another compatible A2D Qwen3 checkpoint. The default model revision is pinned
to `60f77bba67ba94231c16f5fb29bc66c500b038f1`.
The Dockerfile uses CPU PyTorch because the existing Space has CPU hardware.
`modeling_qwen3.py` is the exact model definition from that revision, with only
its unused `__main__` training example omitted. This avoids requiring the
unrelated dLLM training and evaluation stack at inference time. The decoder
architecture, weights, and tokenizer remain the same as the existing Space.

## Deploy to the existing Space

With a Hugging Face token that can write `Cashel/diffusion-chatbot` available
through `HF_TOKEN` or `hf auth login`:

```bash
python backend/marvin/deploy.py
```

The command updates only the runtime files and license, preserves Space metadata, and
checks the reviewed source revision before writing. A Space rebuild begins
automatically. After it finishes, verify `/health` advertises telemetry and
submit a small `capture_activations: true` request to `/generate_sse`.
If the Space has changed, review the new version before overriding the expected
revision. The token belongs in the local environment, never in the React app.
