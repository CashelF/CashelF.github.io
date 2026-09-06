# CPU diffusion comparison

Measured September 5, 2026 on the local AMD Ryzen Threadripper 9970X,
restricted to two physical cores (CPU affinity `0,1`) and two PyTorch threads.
All inference was CPU-only, bfloat16, batch size one, with representative
prefill and 32-token forward passes warmed before measurement. Model download,
loading, HTTP latency, and queue time are excluded.

**This is a local comparison, not a Hugging Face Space latency measurement.**
The Space also has two vCPUs, but its underlying CPU and software differ.
Local software was Python 3.12, PyTorch `2.13.0+cu130` (CUDA disabled), and
Transformers `4.57.1`; the deployed container pins CPU PyTorch `2.6.0`.
Core counts alone do not make these machines equivalent.

Every run used the exact 1,892-character site system prompt in `prompts.json`
and the same three user prompts. Their tokenizer-specific input lengths were
408/416/415 for Qwen3 and 404/412/411 for Fast-dLLM. Both used a requested
96-token generation budget and 32-token blocks. There was one measured sample
per prompt/configuration, with random seed 1234; this is a latency probe and
qualitative smoke check, not a statistical quality evaluation.

| Configuration | Hello | Zomma | Diffusion explanation | Peak process RSS |
| --- | ---: | ---: | ---: | ---: |
| Current Qwen3 0.6B, 96 steps, temperature 0.2, live telemetry | 6.53 s | 11.19 s | 11.07 s | 2.47 GiB |
| TIDE LLaDA2 Cross 0.6B, 96 steps, temperature 0.2, live telemetry | 6.53 s | 11.18 s | 11.03 s | 2.45 GiB |
| Current Qwen3 0.6B, 32 steps, temperature 0.2, live telemetry | 3.11 s | 4.78 s | 5.11 s | 2.47 GiB |
| Fast-dLLM v2 1.5B, cache on, temperature 0 | 2.40 s | 3.92 s | 8.94 s* | 3.94 GiB |
| Fast-dLLM v2 1.5B, cache off, temperature 0 | 2.80 s | 9.12 s* | 12.01 s* | 3.94 GiB |
| Fast-dLLM v2 1.5B, cache on, temperature 0.2 | 2.12 s | 4.07 s | 6.14 s* | 3.94 GiB |

All Fast runs used threshold 0.9, sub-block size 8, top-p 0.95, and the
unmodified official generator. Their timings exclude visualization telemetry,
which requires a streaming adapter. The current model includes the live
residual, attention-head-output, sampled-MLP, and token-state capture.

An asterisk marks a response that reached the native generator's effective
length limit without EOS. Its `max_new_tokens` handling uses
`floor(max_new_tokens / block_size)` blocks; prefix alignment and a seed token
mean a requested 96-token budget produced only 69 or 70 positions for these
long responses. These samples are not completed-response comparisons.

The first completed decoding forward took 0.71–0.78 seconds for the current
model and 1.35–1.36 seconds for Fast-dLLM. This metric includes prompt prefill
and the first forward over unresolved response positions. Current token-frame
delivery followed at 0.73–0.80 seconds. Fast's native generator is not streaming,
so no first visible-token time is claimed for it.

For the completed hello and Zomma responses, cached Fast took about 36% and
35% of current 96-step latency. Those responses had 11 and 42 visible tokens
versus 18 and 47 for current. Fast needed 11 and 23 total forwards versus 50
and 66, explaining how a larger model could finish sooner despite a slower
first pass. These are end-to-end observations, not an equal-output throughput
benchmark or a guaranteed hosted speedup.

The cache comparison also needs care: hello generated identical text in both
modes, but Zomma's output changed. Cached Zomma ended at 42 visible tokens;
uncached Zomma reached 69 without EOS. Its latency difference includes both
different work and different caching costs.

Quality affected the useful settings. The 32-step current model produced
grammatical errors and repeated phrases in the Zomma and diffusion responses.
Fast at temperature 0.2 repeated words in all three samples. Greedy cached
Fast produced a coherent, grounded Zomma answer; its diffusion explanation
still began with “Block block” and was truncated. Raw outputs and exact counts
are preserved in `results-2026-09-05.json`; no sample text was cleaned up.

## TIDE follow-up

The later TIDE probe used `TIDE-dllm/distill-LLaDA2-TIDE_Cross` at
`41d79bf453a90bed91e461cd845788e2d2dc66c0`, the identical prompt fixture,
96 steps, 96-token budget, temperature 0.2, seed 1234, CPU affinity, and full
telemetry. The original baseline was retained without rerunning it.

TIDE's pinned model classes were compared with the reviewed local A2D
implementation. The only inference difference in its source inlines the
shape and device when constructing a missing default mask; this is equivalent
to the local code. It was loaded using the local classes, without executing
remote Python. Its configuration matches the current model's architecture.

TIDE took 6.529/11.177/11.027 seconds for hello/Zomma/diffusion versus
6.530/11.191/11.067 seconds for the baseline. First token frames arrived at
0.726/0.800/0.773 seconds. All three reached EOS, with 12/51/43 non-special
output tokens. Total forwards remained 50/66/75 in both models: the fixed
step allocation accounts for nearly identical time despite different text.
These single samples establish comparable latency on this machine, not a
statistically significant speed improvement.

The TIDE hello was coherent. Its Zomma response included the erroneous phrase
“a ZYC S26 company.” Its diffusion answer incorrectly described generating
images and sub-images. The original model's diffusion explanation was also
inaccurate. These three samples do not demonstrate a conversational-quality
upgrade, so this experiment does not justify changing the deployed default.

Checkpoint identity was verified separately: TIDE uses HF blob
`1e42083182b60de2514f9b983adb04b5dac652ef46d65aaada3b36e3779f927c`, distinct
from the original checkpoint's blob. Layer 0 query-projection tensor hashes
also differ. Both hashes, all six exact baseline/TIDE responses, and timing
details are preserved in the JSON report. No model or inference rerun was
needed for this check.

## Reproduce

Pinned checkpoints:

- `dllm-hub/Qwen3-0.6B-diffusion-bd3lm-v0.1` at
  `60f77bba67ba94231c16f5fb29bc66c500b038f1`.
- `Efficient-Large-Model/Fast_dLLM_v2_1.5B` at
  `25093b6f63300adfd57f72145083c8a528fe4f16`.
- `TIDE-dllm/distill-LLaDA2-TIDE_Cross` at
  `41d79bf453a90bed91e461cd845788e2d2dc66c0`.

The Fast checkpoint's `configuration.py` and `modeling.py` were reviewed
before enabling `trust_remote_code`. Inference uses CPU-capable SDPA; its
compiled flex-attention path is training-only. No CPU compatibility or
sampling patch was needed. `einops` is an additional import dependency.

Run one model process at a time to avoid CPU contention and separate RSS
high-water marks. On the current development machine:

```bash
export PYTHONPATH=/tmp/marvin-telemetry-deps:/tmp/marvin-fast-benchmark-deps
/usr/bin/python3 backend/marvin/benchmarks/cpu_compare.py --model current --steps 96 --tokens 96 --telemetry --output /tmp/marvin-cpu-current96.json
/usr/bin/python3 backend/marvin/benchmarks/cpu_compare.py --model current --steps 32 --tokens 96 --telemetry --output /tmp/marvin-cpu-current32.json
/usr/bin/python3 backend/marvin/benchmarks/cpu_compare.py --model fast --tokens 96 --temperature 0 --block-cache --output /tmp/marvin-cpu-fast-cache.json
/usr/bin/python3 backend/marvin/benchmarks/cpu_compare.py --model fast --tokens 96 --temperature 0 --output /tmp/marvin-cpu-fast-no-cache.json
/usr/bin/python3 backend/marvin/benchmarks/cpu_compare.py --model fast --tokens 96 --temperature 0.2 --block-cache --output /tmp/marvin-cpu-fast-cache-sampled.json
/usr/bin/python3 backend/marvin/benchmarks/cpu_compare.py --model tide --steps 96 --tokens 96 --temperature 0.2 --telemetry --output /tmp/marvin-cpu-tide96.json
```

Each full JSON report includes individual forward timings. The checked-in
results omit those detailed traces while retaining settings, exact outputs,
forward counts, token counts, EOS status, and memory measurements.
