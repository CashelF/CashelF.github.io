import os
import math
import copy
import json
import threading
import uuid
from contextlib import nullcontext
from functools import wraps
import torch
import torch.nn.functional as F
from flask import Flask, request, jsonify, Response
from transformers import AutoTokenizer
from telemetry import capability, capture_forward, capture_token_state
from request_queue import AdmissionError, InferenceQueue

app = Flask(__name__)

model = None
tokenizer = None
device = None
inference_lock = threading.Lock()


def exclusive_inference(handler):
    @wraps(handler)
    def wrapped(*args, **kwargs):
        if not generation_queue.acquire_legacy():
            return jsonify({"error": "Marvin is busy. Try again shortly."}), 429
        try:
            return handler(*args, **kwargs)
        finally:
            generation_queue.release_legacy()
    return wrapped


@app.after_request
def cors(response):
    # Public portfolio inference, with no cookies or client-side credentials.
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


@app.before_request
def validate_generation():
    if request.method != "POST" or request.path not in {"/generate", "/generate_stream", "/generate_sse"}:
        return None
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not isinstance(data.get("prompt"), str) or not data["prompt"].strip():
        return jsonify({"error": "A non-empty prompt is required"}), 400
    if len(data["prompt"]) > 8000 or not isinstance(data.get("system_prompt", ""), str) or len(data.get("system_prompt", "")) > 12000:
        return jsonify({"error": "Prompt is too long or invalid"}), 400
    for field, limit in [("steps", 256), ("max_new_tokens", 256), ("block_size", 128), ("capture_interval", 256)]:
        value = data.get(field, 1)
        if type(value) is not int or not 1 <= value <= limit:
            return jsonify({"error": f"{field} must be an integer between 1 and {limit}"}), 400
    for field, limit in [("temperature", 2), ("cfg_scale", 10)]:
        value = data.get(field, 0)
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= limit:
            return jsonify({"error": f"Invalid {field}"}), 400
    if data.get("remasking", "low_confidence") not in ("low_confidence", "random"):
        return jsonify({"error": "Invalid remasking strategy"}), 400
    if type(data.get("capture_activations", False)) is not bool:
        return jsonify({"error": "capture_activations must be a boolean"}), 400
    return None


def add_gumbel_noise(logits, temperature):
    if temperature == 0:
        return logits
    logits = logits.to(torch.float64)
    noise = torch.rand_like(logits, dtype=torch.float64)
    g = (-torch.log(noise)) ** temperature
    return logits.exp() / g


def get_num_transfer_tokens(mask_index, steps):
    mask_num = mask_index.sum(dim=1, keepdim=True)
    base = mask_num // steps
    rem = mask_num % steps
    out = torch.zeros(mask_num.size(0), steps, device=mask_index.device, dtype=torch.long) + base
    for i in range(mask_num.size(0)):
        out[i, : rem[i]] += 1
    return out


def build_staircase_attention_mask(x, block_size, pad_id):
    B, T = x.shape
    device = x.device

    valid = x != pad_id
    pos_raw = torch.cumsum(valid.long(), dim=-1)
    position_ids = torch.where(valid, pos_raw - 1, torch.zeros_like(pos_raw)).long()

    col = torch.arange(T, device=device)
    block_ids = (col // block_size).view(1, T).expand(B, T)
    block_ids = torch.where(valid, block_ids, torch.full_like(block_ids, -1))

    q = block_ids.view(B, 1, T, 1)
    k = block_ids.view(B, 1, 1, T)
    attn = (k <= q) & (q >= 0) & (k >= 0)

    return attn, position_ids


def diffusion_step_block(logits, x_block, mask_block, num_transfer, temperature, remasking):
    B, L, _ = logits.shape
    if not mask_block.any():
        return x_block

    noisy = add_gumbel_noise(logits, temperature)
    x0 = noisy.argmax(dim=-1)

    if remasking == "low_confidence":
        p = F.softmax(logits, dim=-1)
        conf = p.gather(-1, x0.unsqueeze(-1)).squeeze(-1)
    elif remasking == "random":
        conf = torch.rand((B, L), device=logits.device)
    else:
        raise ValueError(remasking)

    x0 = torch.where(mask_block, x0, x_block)
    neg_inf = torch.full_like(conf, -float("inf"))
    conf = torch.where(mask_block, conf, neg_inf)

    commit = torch.zeros_like(x_block, dtype=torch.bool)
    for i in range(B):
        k = int(num_transfer[i].item())
        if k > 0:
            valid = (conf[i] > -float("inf")).sum().item()
            k = min(k, valid)
            _, idx = torch.topk(conf[i], k)
            commit[i, idx] = True

    out = x_block.clone()
    out[commit] = x0[commit]
    return out


def finish_settled_prefix(block, mask_id, eos_id, pad_id):
    """An EOS can settle before earlier positions in a diffusion block.

    Only finish once its entire preceding prefix is unmasked. Suppress anything
    after that first EOS, including suffix tokens committed out of order.
    """
    if eos_id is None:
        return torch.zeros(block.size(0), dtype=torch.bool, device=block.device)
    positions = torch.arange(block.size(1), device=block.device).unsqueeze(0)
    eos = block == eos_id
    first_eos = torch.where(eos, positions, block.size(1)).amin(dim=1, keepdim=True)
    unfinished_prefix = ((block == mask_id) & (positions < first_eos)).any(dim=1)
    finished = eos.any(dim=1) & ~unfinished_prefix
    block.masked_fill_(finished.unsqueeze(1) & (positions > first_eos), pad_id)
    return finished


@torch.no_grad()
def generate(
    model,
    tokenizer,
    prompt,
    steps=128,
    max_new_tokens=128,
    block_size=32,
    temperature=0.0,
    cfg_scale=0.0,
    remasking="low_confidence",
    capture_interval=0,
):
    device = model.device
    mask_id = tokenizer.mask_token_id
    pad_id = tokenizer.pad_token_id
    if pad_id is None:
        pad_id = tokenizer.eos_token_id if tokenizer.eos_token_id is not None else tokenizer.mask_token_id

    if isinstance(prompt, torch.Tensor):
        x = prompt.to(device).long()
    else:
        if isinstance(prompt[0], (list, tuple)):
            max_len = max(len(p) for p in prompt)
            x = torch.full((len(prompt), max_len), pad_id, device=device, dtype=torch.long)
            for i, p in enumerate(prompt):
                x[i, : len(p)] = torch.tensor(p, device=device)
        else:
            x = torch.tensor(prompt, device=device).long()
    if x.dim() == 1:
        x = x.unsqueeze(0)

    B = x.size(0)
    finished = torch.zeros(B, dtype=torch.bool, device=device)

    num_blocks = math.ceil(max_new_tokens / block_size)
    steps_per_block = math.ceil(steps / num_blocks)
    generated = 0
    
    intermediates = []
    total_step = 0

    while generated < max_new_tokens:
        if finished.all():
            break
        T_prefix = x.size(1)
        offset = T_prefix % block_size
        room = block_size if offset == 0 else block_size - offset
        cur_len = min(room, max_new_tokens - generated)
        if cur_len <= 0:
            break

        attn_pfx, pos_pfx = build_staircase_attention_mask(x, block_size, pad_id)

        out = model(x, attention_mask=attn_pfx, position_ids=pos_pfx, use_cache=True)
        cond_past = out.past_key_values

        if cfg_scale > 0:
            un_x = x.clone()
            un_x[:] = mask_id
            out_un = model(un_x, attention_mask=attn_pfx, position_ids=pos_pfx, use_cache=True)
            uncond_past = out_un.past_key_values
        else:
            uncond_past = None

        block = torch.full((B, cur_len), mask_id, device=device, dtype=torch.long)
        block[finished] = pad_id
        x = torch.cat([x, block], dim=1)
        T_total = x.size(1)

        block_mask = x[:, -cur_len:] == mask_id
        num_transfer = get_num_transfer_tokens(block_mask, steps_per_block)
        eff_steps = num_transfer.size(1)

        full_attn, full_pos = build_staircase_attention_mask(x, block_size, pad_id)
        attn_blk = full_attn[:, :, T_prefix:T_total, :]
        pos_blk = full_pos[:, T_prefix:T_total]

        for t in range(eff_steps):
            x_blk = x[:, T_prefix:T_total]
            m_blk = x_blk == mask_id

            cond_logits = model(
                x_blk, attention_mask=attn_blk, position_ids=pos_blk,
                past_key_values=copy.deepcopy(cond_past), use_cache=False
            ).logits

            logits = cond_logits
            if cfg_scale > 0:
                un_logits = model(
                    x_blk, attention_mask=attn_blk, position_ids=pos_blk,
                    past_key_values=copy.deepcopy(uncond_past), use_cache=False
                ).logits
                logits = un_logits + (cfg_scale + 1.0) * (cond_logits - un_logits)

            x_blk_new = diffusion_step_block(
                logits, x_blk, m_blk, num_transfer[:, t], temperature, remasking
            )
            finished |= finish_settled_prefix(x_blk_new, mask_id, tokenizer.eos_token_id, pad_id)
            x[:, T_prefix:T_total] = x_blk_new
            
            if capture_interval > 0 and total_step % capture_interval == 0:
                intermediates.append(x.clone())
            
            total_step += 1
            
            if finished.all():
                break

        generated += cur_len
        if finished.all():
            break

    if capture_interval > 0:
        return x, intermediates
    return x


@torch.no_grad()
def generate_stream(
    model,
    tokenizer,
    prompt,
    steps=128,
    max_new_tokens=128,
    block_size=32,
    temperature=0.0,
    cfg_scale=0.0,
    remasking="low_confidence",
    capture_interval=10,
    capture_activations=False,
    check_cancelled=None,
):
    check_cancelled = check_cancelled or (lambda: None)
    check_cancelled()
    device = model.device
    mask_id = tokenizer.mask_token_id
    pad_id = tokenizer.pad_token_id
    if pad_id is None:
        pad_id = tokenizer.eos_token_id if tokenizer.eos_token_id is not None else tokenizer.mask_token_id

    if isinstance(prompt, torch.Tensor):
        x = prompt.to(device).long()
    else:
        if isinstance(prompt[0], (list, tuple)):
            max_len = max(len(p) for p in prompt)
            x = torch.full((len(prompt), max_len), pad_id, device=device, dtype=torch.long)
            for i, p in enumerate(prompt):
                x[i, : len(p)] = torch.tensor(p, device=device)
        else:
            x = torch.tensor(prompt, device=device).long()
    if x.dim() == 1:
        x = x.unsqueeze(0)

    B = x.size(0)
    finished = torch.zeros(B, dtype=torch.bool, device=device)

    prompt_len = x.size(1)
    # A prompt can end inside a block. Include that partial first block when
    # reporting the actual number of model forwards in this generation.
    num_blocks = math.ceil(((prompt_len % block_size) + max_new_tokens) / block_size)
    steps_per_block = math.ceil(steps / num_blocks)
    planned_steps = steps_per_block * num_blocks
    generated = 0
    total_step = 0
    block_index = 0
    token_piece_cache = {}

    while generated < max_new_tokens:
        check_cancelled()
        if finished.all():
            break
        T_prefix = x.size(1)
        offset = T_prefix % block_size
        room = block_size if offset == 0 else block_size - offset
        cur_len = min(room, max_new_tokens - generated)
        if cur_len <= 0:
            break

        attn_pfx, pos_pfx = build_staircase_attention_mask(x, block_size, pad_id)

        check_cancelled()
        out = model(x, attention_mask=attn_pfx, position_ids=pos_pfx, use_cache=True)
        check_cancelled()
        cond_past = out.past_key_values

        if cfg_scale > 0:
            un_x = x.clone()
            un_x[:] = mask_id
            check_cancelled()
            out_un = model(un_x, attention_mask=attn_pfx, position_ids=pos_pfx, use_cache=True)
            check_cancelled()
            uncond_past = out_un.past_key_values
        else:
            uncond_past = None

        block = torch.full((B, cur_len), mask_id, device=device, dtype=torch.long)
        block[finished] = pad_id
        x = torch.cat([x, block], dim=1)
        T_total = x.size(1)

        block_mask = x[:, -cur_len:] == mask_id
        num_transfer = get_num_transfer_tokens(block_mask, steps_per_block)
        eff_steps = num_transfer.size(1)

        full_attn, full_pos = build_staircase_attention_mask(x, block_size, pad_id)
        attn_blk = full_attn[:, :, T_prefix:T_total, :]
        pos_blk = full_pos[:, T_prefix:T_total]

        for t in range(eff_steps):
            check_cancelled()
            x_blk = x[:, T_prefix:T_total]
            m_blk = x_blk == mask_id

            capture = (
                capture_forward(model, generated, cur_len)
                if capture_activations else nullcontext(None)
            )
            with capture as telemetry:
                cond_logits = model(
                    x_blk, attention_mask=attn_blk, position_ids=pos_blk,
                    past_key_values=copy.deepcopy(cond_past), use_cache=False
                ).logits

            check_cancelled()
            logits = cond_logits
            if cfg_scale > 0:
                un_logits = model(
                    x_blk, attention_mask=attn_blk, position_ids=pos_blk,
                    past_key_values=copy.deepcopy(uncond_past), use_cache=False
                ).logits
                check_cancelled()
                logits = un_logits + (cfg_scale + 1.0) * (cond_logits - un_logits)

            x_blk_new = diffusion_step_block(
                logits, x_blk, m_blk, num_transfer[:, t], temperature, remasking
            )
            finished |= finish_settled_prefix(x_blk_new, mask_id, tokenizer.eos_token_id, pad_id)
            x[:, T_prefix:T_total] = x_blk_new
            
            total_step += 1
            if capture_activations or (total_step - 1) % capture_interval == 0:
                new_tokens = x[0, prompt_len:prompt_len + max_new_tokens].tolist()
                text = tokenizer.decode(new_tokens, skip_special_tokens=True)
                state = {
                    "type": "intermediate",
                    "step": total_step,
                    "text": text,
                    "total_steps": planned_steps,
                }
                if telemetry is not None:
                    telemetry.update({
                        "blockIndex": block_index,
                        "blockStep": t + 1,
                        "blockSteps": eff_steps,
                        "tokenState": capture_token_state(
                            tokenizer, new_tokens, block_index, generated, cur_len,
                            m_blk[0].tolist(), bool(finished[0]), token_piece_cache,
                        ),
                    })
                    state["telemetry"] = telemetry
                yield state
            
            if finished.all():
                break

        generated += cur_len
        block_index += 1
        if finished.all():
            break

    check_cancelled()
    new_tokens = x[0, prompt_len:prompt_len + max_new_tokens].tolist()
    final_text = tokenizer.decode(new_tokens, skip_special_tokens=True)
    yield {
        "type": "final",
        "text": final_text,
        "step": total_step,
        "total_steps": total_step
    }


def load_model():
    global model, tokenizer, device
    from modeling_qwen3 import A2DQwen3Config, A2DQwen3LMHeadModel
    
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model_name = os.getenv("MODEL_NAME", "dllm-hub/Qwen3-0.6B-diffusion-bd3lm-v0.1")
    revision = os.getenv("MODEL_REVISION", "60f77bba67ba94231c16f5fb29bc66c500b038f1")
    
    print(f"Loading model {model_name} on {device}...")
    config = A2DQwen3Config.from_pretrained(model_name, revision=revision)
    model = A2DQwen3LMHeadModel.from_pretrained(
        model_name,
        config=config,
        revision=revision,
        dtype=torch.bfloat16, 
    ).to(device).eval()
    
    tokenizer = AutoTokenizer.from_pretrained(
        model_name, 
        config=config,
        revision=revision,
    )
    print("Model loaded successfully!")


@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        "status": "healthy",
        "model_loaded": model is not None,
        "model": os.getenv("MODEL_NAME", "dllm-hub/Qwen3-0.6B-diffusion-bd3lm-v0.1"),
        "device": str(device),
        "telemetry": capability(model),
        "queue": generation_queue.snapshot(),
    })


@app.route('/generate', methods=['POST'])
@exclusive_inference
def generate_text():
    if model is None or tokenizer is None:
        return jsonify({"error": "Model not loaded"}), 503
    
    data = request.get_json()
    
    if not data or 'prompt' not in data:
        return jsonify({"error": "Missing 'prompt' field"}), 400
    
    prompt = data['prompt']
    steps = data.get('steps', 256)
    max_new_tokens = data.get('max_new_tokens', 256)
    block_size = data.get('block_size', 32)
    temperature = data.get('temperature', 0.0)
    cfg_scale = data.get('cfg_scale', 0.0)
    remasking = data.get('remasking', 'low_confidence')
    system_prompt = data.get('system_prompt', 'You are a helpful AI assistant.')
    
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": prompt}
    ]
    
    encoded = tokenizer.apply_chat_template(
        messages, 
        add_generation_prompt=True, 
        tokenize=True, 
        enable_thinking=False
    )
    
    input_ids = torch.tensor([encoded], dtype=torch.long, device=device)
    
    output = generate(
        model,
        tokenizer,
        input_ids,
        steps=steps,
        max_new_tokens=max_new_tokens,
        block_size=block_size,
        temperature=temperature,
        cfg_scale=cfg_scale,
        remasking=remasking,
    )
    
    prompt_len = len(encoded)
    new_tokens = output[0, prompt_len:prompt_len + max_new_tokens].tolist()
    generated_text = tokenizer.decode(new_tokens, skip_special_tokens=True)
    
    return jsonify({
        "prompt": prompt,
        "generated_text": generated_text,
        "parameters": {
            "steps": steps,
            "max_new_tokens": max_new_tokens,
            "block_size": block_size,
            "temperature": temperature,
            "cfg_scale": cfg_scale,
            "remasking": remasking
        }
    })


@app.route('/generate_stream', methods=['POST'])
@exclusive_inference
def generate_text_stream():
    if model is None or tokenizer is None:
        return jsonify({"error": "Model not loaded"}), 503
    
    data = request.get_json()
    
    if not data or 'prompt' not in data:
        return jsonify({"error": "Missing 'prompt' field"}), 400
    
    prompt = data['prompt']
    steps = data.get('steps', 256)
    max_new_tokens = data.get('max_new_tokens', 256)
    block_size = data.get('block_size', 32)
    temperature = data.get('temperature', 0.0)
    cfg_scale = data.get('cfg_scale', 0.0)
    remasking = data.get('remasking', 'low_confidence')
    system_prompt = data.get('system_prompt', 'You are a helpful AI assistant.')
    capture_interval = data.get('capture_interval', 10)
    
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": prompt}
    ]
    
    encoded = tokenizer.apply_chat_template(
        messages, 
        add_generation_prompt=True, 
        tokenize=True, 
        enable_thinking=False
    )
    
    input_ids = torch.tensor([encoded], dtype=torch.long, device=device)
    
    output, intermediates = generate(
        model,
        tokenizer,
        input_ids,
        steps=steps,
        max_new_tokens=max_new_tokens,
        block_size=block_size,
        temperature=temperature,
        cfg_scale=cfg_scale,
        remasking=remasking,
        capture_interval=capture_interval,
    )
    
    prompt_len = len(encoded)
    
    intermediate_states = []
    for i, intermediate in enumerate(intermediates):
        new_tokens = intermediate[0, prompt_len:prompt_len + max_new_tokens].tolist()
        text = tokenizer.decode(new_tokens, skip_special_tokens=True)
        intermediate_states.append({
            "step": i * capture_interval,
            "text": text
        })
    
    new_tokens = output[0, prompt_len:prompt_len + max_new_tokens].tolist()
    generated_text = tokenizer.decode(new_tokens, skip_special_tokens=True)
    
    return jsonify({
        "prompt": prompt,
        "generated_text": generated_text,
        "intermediate_states": intermediate_states,
        "parameters": {
            "steps": steps,
            "max_new_tokens": max_new_tokens,
            "block_size": block_size,
            "temperature": temperature,
            "cfg_scale": cfg_scale,
            "remasking": remasking,
            "capture_interval": capture_interval
        }
    })


def run_generation(ticket, queue):
    """All SSE model work runs on one thread, including tokenization and hooks."""
    data = ticket.payload
    queue.checkpoint(ticket)
    queue.emit(ticket, {"type": "start", "request_id": ticket.request_id, "telemetry": capability(model)})
    messages = [
        {"role": "system", "content": data.get("system_prompt", "You are a helpful AI assistant.")},
        {"role": "user", "content": data["prompt"]},
    ]
    encoded = tokenizer.apply_chat_template(
        messages, add_generation_prompt=True, tokenize=True, enable_thinking=False,
    )
    queue.checkpoint(ticket)
    input_ids = torch.tensor([encoded], dtype=torch.long, device=device)
    generator = generate_stream(
        model, tokenizer, input_ids,
        steps=data.get("steps", 256),
        max_new_tokens=data.get("max_new_tokens", 256),
        block_size=data.get("block_size", 32),
        temperature=data.get("temperature", 0.0),
        cfg_scale=data.get("cfg_scale", 0.0),
        remasking=data.get("remasking", "low_confidence"),
        capture_interval=data.get("capture_interval", 10),
        capture_activations=data.get("capture_activations", False),
        check_cancelled=lambda: queue.checkpoint(ticket),
    )
    try:
        for state in generator:
            queue.emit(ticket, state)
    finally:
        # Explicit close also tears down a suspended sampler on cancellation.
        generator.close()


generation_queue = InferenceQueue(run_generation, inference_lock=inference_lock)


def valid_request_id(value):
    if not isinstance(value, str) or len(value) != 36:
        return False
    try:
        parsed = uuid.UUID(value)
        return parsed.version == 4 and str(parsed) == value.lower()
    except (ValueError, AttributeError):
        return False


@app.route('/requests/<request_id>/keepalive', methods=['POST'])
def keepalive_request(request_id):
    if not valid_request_id(request_id):
        return jsonify({"error": "Invalid request ID"}), 400
    if not generation_queue.keepalive(request_id.lower()):
        return jsonify({"error": "This request is no longer active.", "code": "request_inactive"}), 404
    return jsonify({"ok": True})


@app.route('/requests/<request_id>/cancel', methods=['POST'])
def cancel_request(request_id):
    if not valid_request_id(request_id):
        return jsonify({"error": "Invalid request ID"}), 400
    generation_queue.cancel(request_id.lower())
    return jsonify({"ok": True})


@app.route('/generate_sse', methods=['POST'])
def generate_text_sse():
    if model is None or tokenizer is None:
        return jsonify({"error": "Model not loaded"}), 503
    data = request.get_json()
    supplied_id = data.get("request_id")
    leased = "request_id" in data
    if leased and not valid_request_id(supplied_id):
        return jsonify({"error": "request_id must be a random UUID"}), 400
    request_id = supplied_id.lower() if leased else str(uuid.uuid4())
    if data.get("capture_activations", False) and not capability(model)["available"]:
        return jsonify({"error": "Activation telemetry is unavailable for this model"}), 503
    try:
        # Cached older site versions have no keepalive. Preserve their existing
        # immediate-only API, without letting them take a waiting spot.
        ticket = generation_queue.submit(
            request_id, data, leased=leased, allow_wait=leased,
            is_disconnected=request.environ.get("waitress.client_disconnected"),
        )
    except AdmissionError as error:
        return jsonify({"error": str(error), "code": error.code}), error.status

    def stream():
        try:
            for state in generation_queue.events(ticket):
                if state is None:
                    yield ": keepalive\n\n"
                else:
                    yield f"data: {json.dumps(state, allow_nan=False)}\n\n"
        finally:
            generation_queue.cancel(request_id)

    response = Response(
        stream(), mimetype='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )
    response.call_on_close(lambda: generation_queue.cancel(request_id))
    return response


if __name__ == '__main__':
    from waitress import serve

    load_model()
    # One process/model plus independent HTTP threads for three SSE streams,
    # health checks and cancellation. The queue owns the sole inference worker.
    serve(app, host='0.0.0.0', port=int(os.getenv('PORT', 5000)), threads=12,
          channel_timeout=30, channel_request_lookahead=1, outbuf_overflow=65536,
          outbuf_high_watermark=262144, max_request_body_size=65536)
