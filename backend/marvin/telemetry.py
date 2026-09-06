"""Compact measurements of real decoder outputs; never synthetic activity."""

from contextlib import contextmanager
from time import perf_counter

import torch

VERSION = 1
MAX_TOKENS = 32
MAX_NEURONS = 32
MAX_LOGITS = 64
METRIC = "hidden_state_rms"


def architecture(model):
    config = getattr(model, "config", None)
    model_id = getattr(config, "_name_or_path", "")
    names = {
        "dllm-hub/Qwen3-0.6B-diffusion-bd3lm-v0.1": ("Qwen3 · 0.6B", "bd3lm"),
        "Efficient-Large-Model/Fast_dLLM_v2_1.5B": ("Fast-dLLM · 1.5B", "fast-dllm-v2"),
    }
    if model_id not in names:
        return None
    fields = {
        "layers": "num_hidden_layers", "hiddenSize": "hidden_size",
        "mlpWidth": "intermediate_size", "queryHeads": "num_attention_heads",
        "kvHeads": "num_key_value_heads",
    }
    shape = {name: getattr(config, field, None) for name, field in fields.items()}
    if not all(type(value) is int and value > 0 for value in shape.values()):
        return None
    head_dim = getattr(config, "head_dim", None) or shape["hiddenSize"] // shape["queryHeads"]
    label, family = names[model_id]
    return {
        "modelId": model_id, "modelLabel": label,
        "modelUrl": f"https://huggingface.co/{model_id}", "modelFamily": family,
        **shape, "headDim": head_dim,
    }


def decoder_layers(model):
    """The deployed A2DQwen3 model does not implement output_hidden_states."""
    return getattr(getattr(model, "model", None), "layers", ())


def sampled_indices(size, limit):
    count = min(size, limit)
    return (
        [round(index * (size - 1) / (count - 1)) for index in range(count)]
        if count > 1 else [0]
    )


def internals_layout(layers):
    """Use actual projection widths, rather than assuming a checkpoint shape."""
    layouts = []
    for layer in layers:
        attention = getattr(layer, "self_attn", None)
        output = getattr(attention, "o_proj", None)
        down = getattr(getattr(layer, "mlp", None), "down_proj", None)
        head_dim = getattr(attention, "head_dim", None)
        width = getattr(output, "in_features", None)
        neurons = getattr(down, "in_features", None)
        if (
            not all(isinstance(value, int) and value > 0 for value in (head_dim, width, neurons))
            or width % head_dim
            or not callable(getattr(output, "register_forward_pre_hook", None))
            or not callable(getattr(down, "register_forward_pre_hook", None))
        ):
            return None
        layouts.append((width // head_dim, head_dim, neurons))
    return layouts[0] if layouts and all(layout == layouts[0] for layout in layouts) else None


def qkv_layout(layers, layout):
    """Q/K/V projections are optional; never infer their widths from a label."""
    if layout is None:
        return None
    head_count, head_dim, _ = layout
    layouts = []
    for layer in layers:
        attention = getattr(layer, "self_attn", None)
        projections = [getattr(attention, name, None) for name in ("q_proj", "k_proj", "v_proj")]
        widths = [getattr(projection, "out_features", None) for projection in projections]
        if (
            not all(type(width) is int and width > 0 and width % head_dim == 0 for width in widths)
            or widths[0] != head_count * head_dim or widths[1] != widths[2]
            or widths[0] % widths[1]
            or not all(callable(getattr(projection, "register_forward_hook", None)) for projection in projections)
        ):
            return None
        layouts.append(widths[1] // head_dim)
    return layouts[0] if layouts and all(value == layouts[0] for value in layouts) else None


def stage_modules(model):
    decoder = getattr(model, "model", None)
    candidates = {
        "embeddingRms": getattr(decoder, "embed_tokens", None),
        "finalNormRms": getattr(decoder, "norm", None),
        "lmHeadRms": getattr(model, "lm_head", None),
    }
    # The output width fixes a deterministic bounded vocabulary sample before
    # inference. Models with unconventional output heads simply omit this stage.
    output_width = getattr(candidates["lmHeadRms"], "out_features", None)
    if type(output_width) is not int or output_width < 1:
        candidates.pop("lmHeadRms")
    return {
        name: module for name, module in candidates.items()
        if callable(getattr(module, "register_forward_hook", None))
    }


def capability(model):
    layers = decoder_layers(model)
    layout = internals_layout(layers)
    return {
        "available": bool(len(layers)),
        "version": VERSION,
        "metric": METRIC,
        "layer_count": len(layers),
        "max_tokens": MAX_TOKENS,
        "token_states": True,
        "internals": layout is not None,
        "qkv": qkv_layout(layers, layout) is not None,
        "stages": list(stage_modules(model)),
        "architecture": architecture(model),
    }


def capture_token_state(
    tokenizer, response_tokens, block_index, block_start, block_size,
    mask_before, finished, piece_cache,
):
    """Describe actual response tokens after this forward's commit and EOS trim.

    RMS hooks observe the inputs to this update. The token snapshot observes its
    result. Only masks that became retained non-mask tokens count as new commits;
    padding a discarded suffix is not a prediction. A previously committed token
    keeps its identity unless the sampler discards it after a settled EOS.
    """
    mask_id = tokenizer.mask_token_id
    eos_id = tokenizer.eos_token_id
    special_ids = set(tokenizer.all_special_ids)
    first_eos = (
        response_tokens.index(eos_id)
        if finished and eos_id is not None and eos_id in response_tokens else None
    )
    tokens = []
    for position, token_id in enumerate(response_tokens):
        if first_eos is not None and position > first_eos:
            state = "discarded"
        elif token_id == mask_id:
            state = "masked"
        else:
            state = "committed"
        local_position = position - block_start
        newly_committed = (
            state == "committed"
            and 0 <= local_position < block_size
            and mask_before[local_position]
        )
        if token_id not in piece_cache:
            piece_cache[token_id] = tokenizer.decode(
                [token_id], skip_special_tokens=False,
                clean_up_tokenization_spaces=False,
            )
        tokens.append({
            "position": position,
            "tokenId": token_id,
            "piece": piece_cache[token_id],
            "state": state,
            "newlyCommitted": newly_committed,
            "special": token_id in special_ids,
        })
    return {
        "version": VERSION,
        "blockIndex": block_index,
        "blockStart": block_start,
        "blockSize": block_size,
        "tokens": tokens,
    }


@contextmanager
def capture_forward(model, token_offset, token_count, query_indices=None, query_count=None):
    """Register hooks only around one conditional denoising forward pass.

    The caller holds the model inference lock. We reduce each decoder's residual
    output [batch, tokens, hidden] immediately, keeping no full hidden tensors.
    Layer indices are zero-based; token positions are relative to the response.
    Optional query indices map response positions to actual tensor rows, so a
    first block containing prompt tokens can exclude those rows completely.
    """
    layers = decoder_layers(model)
    if not len(layers):
        raise ValueError("This model does not expose decoder layers for telemetry")

    if token_count < 1:
        raise ValueError("Telemetry needs an active token block")
    query_count = token_count if query_count is None else query_count
    query_indices = list(range(token_count)) if query_indices is None else list(query_indices)
    if (
        type(query_count) is not int or query_count < 1
        or len(query_indices) != token_count
        or any(type(index) is not int or not 0 <= index < query_count for index in query_indices)
        or any(left >= right for left, right in zip(query_indices, query_indices[1:]))
    ):
        raise ValueError("Invalid response-to-query mapping for telemetry")
    sample_indices = sampled_indices(token_count, MAX_TOKENS)
    sampled_queries = [query_indices[index] for index in sample_indices]
    frame = {
        "version": VERSION,
        "metric": METRIC,
        "normalization": "rms/(1+rms)",
        "activations": [],
        "rawRms": [],
        "layerIndices": list(range(len(layers))),
        "tokenPositions": [token_offset + index for index in sample_indices],
        "architecture": architecture(model),
        "phase": "denoise",
    }
    measurements = {}
    attention_measurements = {}
    neuron_measurements = {}
    qkv_measurements = {name: {} for name in ("queryHeadRms", "keyHeadRms", "valueHeadRms")}
    stages = stage_modules(model)
    stage_measurements = {}
    logit_indices = (
        sampled_indices(stages["lmHeadRms"].out_features, MAX_LOGITS)
        if "lmHeadRms" in stages else None
    )
    layout = internals_layout(layers)
    kv_head_count = qkv_layout(layers, layout)
    if layout is not None:
        head_count, head_dim, neuron_count = layout
        neuron_indices = sampled_indices(neuron_count, MAX_NEURONS)
    handles = []

    def make_hook(layer_index):
        def measure(_module, _inputs, output):
            hidden = output[0] if isinstance(output, (tuple, list)) else output
            if not isinstance(hidden, torch.Tensor) or hidden.ndim != 3 or hidden.shape[1] != query_count:
                raise ValueError("Unexpected decoder output shape for telemetry")
            values = hidden.detach()[0, sampled_queries, :].float()
            rms = values.square().mean(dim=-1).sqrt()
            if not bool(torch.isfinite(rms).all()):
                raise ValueError("Non-finite decoder activations")
            measurements[layer_index] = (
                rms.cpu().tolist(), (rms / (1.0 + rms)).cpu().tolist()
            )
        return measure

    def make_stage_hook(name):
        def measure(_module, _inputs, output):
            if (
                not isinstance(output, torch.Tensor) or output.ndim != 3
                or output.shape[0] < 1 or output.shape[1] != query_count or output.shape[2] < 1
            ):
                raise ValueError("Unexpected architecture stage output shape for telemetry")
            output = output.detach()
            if name == "lmHeadRms":
                if output.shape[2] != stages[name].out_features:
                    raise ValueError("Unexpected language-model head width for telemetry")
                # Index rows and vocabulary columns together. Selecting rows
                # first would copy the full 151,936-wide logits unnecessarily.
                rows = torch.tensor(sampled_queries, device=output.device).unsqueeze(1)
                columns = torch.tensor(logit_indices, device=output.device)
                values = output[0, rows, columns].float()
            else:
                values = output[0, sampled_queries, :].float()
            rms = values.square().mean(dim=-1).sqrt()
            if not bool(torch.isfinite(rms).all()):
                raise ValueError("Non-finite architecture stage activations")
            stage_measurements[name] = rms.cpu().tolist()
        return measure

    def make_qkv_hook(layer_index, name, count):
        def measure(_module, _inputs, output):
            if (
                not isinstance(output, torch.Tensor) or output.ndim != 3
                or output.shape[0] < 1 or output.shape[1] != query_count
                or output.shape[2] != count * head_dim
            ):
                raise ValueError("Unexpected Q/K/V projection output shape for telemetry")
            # These are projection outputs before Q/K norm, RoPE, KV caching,
            # head repetition, or attention. Only current response rows count.
            values = output.detach()[0, sampled_queries, :].float()
            values = values.reshape(len(sample_indices), count, head_dim)
            rms = values.square().mean(dim=(0, 2)).sqrt()
            if not bool(torch.isfinite(rms).all()):
                raise ValueError("Non-finite Q/K/V activations")
            qkv_measurements[name][layer_index] = rms.cpu().tolist()
        return measure

    def make_projection_hook(layer_index, attention):
        def measure(_module, inputs):
            values = inputs[0] if inputs else None
            width = head_count * head_dim if attention else neuron_count
            if (
                not isinstance(values, torch.Tensor) or values.ndim != 3
                or values.shape[1] != query_count or values.shape[2] != width
            ):
                raise ValueError("Unexpected projection input shape for telemetry")
            values = values.detach()[0, sampled_queries, :]
            if attention:
                # o_proj receives concatenated, attention-weighted value heads.
                # These are head outputs, not query/key scores or attention weights.
                values = values.float().reshape(len(sample_indices), head_count, head_dim)
                rms = values.square().mean(dim=(0, 2)).sqrt()
                target = attention_measurements
            else:
                # down_proj receives actual SwiGLU channel outputs. Preserve the
                # sampled channel identities and aggregate only over active tokens.
                values = values[:, neuron_indices].float()
                rms = values.square().mean(dim=0).sqrt()
                target = neuron_measurements
            if not bool(torch.isfinite(rms).all()):
                raise ValueError("Non-finite internal activations")
            target[layer_index] = rms.cpu().tolist()
        return measure

    started = perf_counter()
    try:
        for name, module in stages.items():
            handles.append(module.register_forward_hook(make_stage_hook(name)))
        for index, layer in enumerate(layers):
            handles.append(layer.register_forward_hook(make_hook(index)))
            if layout is not None:
                handles.append(layer.self_attn.o_proj.register_forward_pre_hook(make_projection_hook(index, True)))
                handles.append(layer.mlp.down_proj.register_forward_pre_hook(make_projection_hook(index, False)))
            if kv_head_count is not None:
                for projection, name, count in (
                    ("q_proj", "queryHeadRms", head_count),
                    ("k_proj", "keyHeadRms", kv_head_count),
                    ("v_proj", "valueHeadRms", kv_head_count),
                ):
                    handles.append(getattr(layer.self_attn, projection).register_forward_hook(make_qkv_hook(index, name, count)))
        yield frame
        if len(measurements) != len(layers):
            raise ValueError("Incomplete decoder telemetry")
        if len(stage_measurements) != len(stages):
            raise ValueError("Incomplete architecture stage telemetry")
        result = {
            "rawRms": [measurements[index][0] for index in range(len(layers))],
            "activations": [measurements[index][1] for index in range(len(layers))],
        }
        if layout is not None:
            if len(attention_measurements) != len(layers) or len(neuron_measurements) != len(layers):
                raise ValueError("Incomplete internal telemetry")
            result["internals"] = {
                "version": VERSION,
                "headCount": head_count,
                "headDim": head_dim,
                "neuronIndices": neuron_indices,
                "attentionHeadRms": [attention_measurements[index] for index in range(len(layers))],
                "mlpNeuronRms": [neuron_measurements[index] for index in range(len(layers))],
            }
            if kv_head_count is not None:
                if any(len(values) != len(layers) for values in qkv_measurements.values()):
                    raise ValueError("Incomplete Q/K/V telemetry")
                result["internals"].update({
                    "kvHeadCount": kv_head_count,
                    **{name: [values[index] for index in range(len(layers))] for name, values in qkv_measurements.items()},
                })
        if stages:
            result["stages"] = stage_measurements
            if logit_indices is not None:
                result["stages"]["lmHeadTokenIndices"] = logit_indices
        result["forwardMs"] = round((perf_counter() - started) * 1000, 2)
        # Publish only after every installed hook has supplied a valid result.
        frame.update(result)
    finally:
        for handle in handles:
            handle.remove()
