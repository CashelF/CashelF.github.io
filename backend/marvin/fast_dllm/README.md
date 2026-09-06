# Pinned Fast-dLLM v2 definition

`modeling.py`, `configuration.py`, and `config.json` are unmodified files from
[Efficient-Large-Model/Fast_dLLM_v2_1.5B](https://huggingface.co/Efficient-Large-Model/Fast_dLLM_v2_1.5B/tree/25093b6f63300adfd57f72145083c8a528fe4f16),
revision `25093b6f63300adfd57f72145083c8a528fe4f16`. The Apache 2.0 license is
from the authors' [official repository](https://github.com/NVlabs/Fast-dLLM).

The separate `../fast_runtime.py` adapter adds bounded, streaming inference
and real telemetry without changing the model or its threshold sampling.
Block diffusion retains causal ordering between blocks; a native next-token
prediction seeds the next block. Within each block, masked tokens are committed
in parallel using shifted logits. No auxiliary autoregressive verifier runs.

The default site model is unchanged until this candidate is explicitly loaded.
