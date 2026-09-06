"""Bounded streaming adapter for the pinned, genuine Fast-dLLM v2 checkpoint.

Diffusion forwards use the author's shifted logits and confidence threshold.
Completed blocks are cached; their last logit seeds the next block. Those seed
updates carry tokens, but never pretend to be measurements of the new token.
The caller owns the inference lock throughout iteration and closes on disconnect.
"""

from contextlib import nullcontext
import math

import torch

from telemetry import capture_forward, capture_token_state

MODEL_ID = "Efficient-Large-Model/Fast_dLLM_v2_1.5B"
MODEL_REVISION = "25093b6f63300adfd57f72145083c8a528fe4f16"
MASK_ID = 151665


def architecture(model):
    config = model.config
    return {
        "modelId": MODEL_ID,
        "modelLabel": "Fast-dLLM v2 · 1.5B",
        "modelUrl": "https://huggingface.co/" + MODEL_ID,
        "modelFamily": "Qwen2.5 · block diffusion",
        "layers": config.num_hidden_layers,
        "hiddenSize": config.hidden_size,
        "mlpWidth": config.intermediate_size,
        "queryHeads": config.num_attention_heads,
        "kvHeads": config.num_key_value_heads,
        "headDim": getattr(config, "head_dim", config.hidden_size // config.num_attention_heads),
    }


def load_model(device="cpu", dtype=torch.bfloat16):
    """Load reviewed local code and pinned weights, without remote-code execution."""
    from transformers import AutoTokenizer
    from fast_dllm.configuration import Fast_dLLM_QwenConfig
    from fast_dllm.modeling import Fast_dLLM_QwenForCausalLM

    config = Fast_dLLM_QwenConfig.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
    model = Fast_dLLM_QwenForCausalLM.from_pretrained(
        MODEL_ID, revision=MODEL_REVISION, config=config, dtype=dtype,
    ).to(device).eval()
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
    if tokenizer.mask_token_id is None:
        # The author's generation uses this existing vocabulary token, while
        # some tokenizer revisions omit its mask-role assignment.
        tokenizer.mask_token = tokenizer.convert_ids_to_tokens(MASK_ID)
    if tokenizer.mask_token_id != MASK_ID:
        raise ValueError("Unexpected Fast-dLLM mask token")
    return model, tokenizer


def _settle_eos(tokens, prompt_length, stop_id, pad_id, mask_id):
    response = tokens[0, prompt_length:]
    if stop_id is None:
        return False
    endings = (response == stop_id).nonzero(as_tuple=False)
    if not len(endings):
        return False
    first = int(endings[0, 0])
    if bool((response[:first] == mask_id).any()):
        return False
    response[first + 1:] = pad_id
    return True


@torch.no_grad()
def generate_stream(
    model, tokenizer, prompt, max_new_tokens=96, block_size=32,
    small_block_size=8, threshold=0.9, temperature=0.0, top_p=0.95,
    capture_activations=False, use_block_cache=True,
):
    """Yield real denoising frames plus truthful token-only block seed updates.

    The author's optional sub-block cache only recomputes queried rows; cached
    rows never receive invented measurements. Prompt-tail and out-of-budget rows
    remain model context but are excluded from measurements and token state.
    `total_steps`/`blockSteps` are upper bounds because threshold sampling is
    adaptive; `adaptive: true` marks this, and the final count is exact.
    """
    if isinstance(max_new_tokens, bool) or not isinstance(max_new_tokens, int) or not 1 <= max_new_tokens <= 256:
        raise ValueError("max_new_tokens must be an integer from 1 through 256")
    if block_size != 32 or small_block_size not in (1, 2, 4, 8, 16, 32):
        raise ValueError("Fast-dLLM uses 32-token blocks with a dividing sub-block size")
    if not math.isfinite(threshold) or not 0 <= threshold <= 1:
        raise ValueError("threshold must be between zero and one")
    if not math.isfinite(temperature) or temperature < 0 or not math.isfinite(top_p) or not 0 < top_p <= 1:
        raise ValueError("Invalid sampling settings")
    x = torch.as_tensor(prompt, dtype=torch.long, device=model.device)
    if x.ndim == 1:
        x = x.unsqueeze(0)
    if x.ndim != 2 or x.shape[0] != 1 or x.shape[1] < 1:
        raise ValueError("Fast-dLLM streaming requires one nonempty prompt")
    x = x.clone()
    prompt_length = x.shape[1]
    end_position = prompt_length + max_new_tokens
    mask_id = tokenizer.mask_token_id
    stop_id = tokenizer.eos_token_id
    pad_id = tokenizer.pad_token_id if tokenizer.pad_token_id is not None else stop_id
    if mask_id is None or pad_id is None:
        raise ValueError("Fast-dLLM needs mask and padding token IDs")
    piece_cache = {}
    model_architecture = architecture(model)
    past = None
    step = 0
    block_index = 0
    finished = False
    step_budget = max_new_tokens

    def seed_event(seed, previous_length):
        nonlocal x, finished
        x = torch.cat((x, seed), dim=1)
        finished = _settle_eos(x, prompt_length, stop_id, pad_id, mask_id)
        response = x[0, prompt_length:].tolist()
        snapshot = capture_token_state(
            tokenizer, response, block_index, previous_length - prompt_length,
            1, [False], finished, piece_cache,
        )
        # It was predicted from a visible preceding token, never unmasked.
        return {
            "type": "intermediate", "phase": "seed", "step": step,
            "total_steps": step_budget, "adaptive": True,
            "text": tokenizer.decode(response, skip_special_tokens=True),
            "tokenState": snapshot,
        }

    # Cache only complete prompt blocks, preserving the author's attention
    # alignment. A prompt ending at a block boundary needs its native seed.
    prefix_length = prompt_length // block_size * block_size
    if prefix_length:
        output = model(
            input_ids=x[:, :prefix_length], use_cache=True,
            update_past_key_values=True, block_size=block_size,
        )
        past = output.past_key_values
        if prefix_length == prompt_length:
            yield seed_event(output.logits[:, -1:, :].argmax(dim=-1), prompt_length)

    while x.shape[1] < end_position and not finished:
        origin = x.shape[1] // block_size * block_size
        active_end = min(origin + block_size, end_position)
        active_start = max(origin, prompt_length)
        block_start = active_start - prompt_length
        block_length = active_end - active_start
        padding = torch.full(
            (1, origin + block_size - x.shape[1]), mask_id,
            dtype=torch.long, device=model.device,
        )
        x = torch.cat((x, padding), dim=1)
        block_step = 0
        block_past = None

        for local_start in range(0, block_size, small_block_size):
            local_end = local_start + small_block_size
            candidate_start = max(origin + local_start, active_start)
            candidate_end = min(origin + local_end, active_end)
            if candidate_start >= candidate_end:
                continue
            while bool((x[:, candidate_start:candidate_end] == mask_id).any()) and not finished:
                mask_before = (x[0, active_start:active_end] == mask_id).tolist()
                use_small_cache = (
                    use_block_cache and block_past is not None
                    and not bool((x[:, origin + local_start] == mask_id).any())
                )
                query_start = origin + local_start if use_small_cache else origin
                query_end = origin + local_end if use_small_cache else origin + block_size
                measured_start = max(query_start, active_start)
                measured_end = min(query_end, active_end)
                query_indices = list(range(measured_start - query_start, measured_end - query_start))
                capture = (
                    capture_forward(
                        model, measured_start - prompt_length, measured_end - measured_start,
                        query_indices=query_indices, query_count=query_end - query_start,
                    ) if capture_activations else nullcontext(None)
                )
                cache_options = {"use_block_cache": True} if use_block_cache else {}
                if use_small_cache:
                    cache_options.update({
                        "block_past_key_values": block_past,
                        "replace_position": local_start,
                    })
                with capture as telemetry:
                    output = model(
                        input_ids=x[:, query_start:query_end],
                        use_cache=True, past_key_values=past,
                        update_past_key_values=False, block_size=block_size,
                        **cache_options,
                    )
                if use_block_cache and not use_small_cache:
                    block_past = output.block_past_key_values
                # Preserve native shifted prediction: a row predicts the next
                # position. Measured rows retain their actual input identities.
                shifted = torch.cat((output.logits[:, :1], output.logits[:, :-1]), dim=1)
                logits = shifted[:, candidate_start - query_start:candidate_end - query_start]
                predictions, probabilities = model.sample_with_top_p(
                    logits, top_p=top_p, temperature=temperature,
                )
                confidence = probabilities.gather(-1, predictions.unsqueeze(-1)).squeeze(-1)
                masked = x[:, candidate_start:candidate_end] == mask_id
                confidence = torch.where(masked, confidence, -torch.inf)
                commit = confidence > threshold
                commit[0, confidence[0].argmax()] = True
                commit &= masked
                target = x[:, candidate_start:candidate_end]
                target[commit] = predictions[commit]
                if not bool((commit & (predictions != mask_id)).any()):
                    raise RuntimeError("Fast-dLLM did not commit a non-mask token")
                finished = _settle_eos(x[:, :active_end], prompt_length, stop_id, pad_id, mask_id)
                step += 1
                block_step += 1
                response = x[0, prompt_length:active_end].tolist()
                state = {
                    "type": "intermediate", "phase": "denoise", "step": step,
                    "total_steps": step_budget, "adaptive": True,
                    "text": tokenizer.decode(response, skip_special_tokens=True),
                }
                if telemetry is not None:
                    telemetry.update({
                        "phase": "denoise", "adaptive": True,
                        "architecture": model_architecture,
                        "blockIndex": block_index, "blockStep": block_step,
                        "blockSteps": block_length,
                        "tokenState": capture_token_state(
                            tokenizer, response, block_index, block_start,
                            block_length, mask_before, finished, piece_cache,
                        ),
                    })
                    state["telemetry"] = telemetry
                yield state
            if finished:
                break

        x = x[:, :active_end]
        if finished or active_end == end_position:
            break
        # This full visible-block pass populates the next block's KV prefix.
        # Its last logit produces one native AR seed, not a diffusion commit.
        output = model(
            input_ids=x[:, origin:origin + block_size], use_cache=True,
            past_key_values=past, update_past_key_values=True,
            block_size=block_size,
        )
        past = output.past_key_values
        block_index += 1
        yield seed_event(output.logits[:, -1:, :].argmax(dim=-1), x.shape[1])

    response = x[0, prompt_length:min(x.shape[1], end_position)].tolist()
    yield {
        "type": "final", "text": tokenizer.decode(response, skip_special_tokens=True),
        "step": step, "total_steps": step, "adaptive": True,
    }
