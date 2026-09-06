"""CPU-only, pinned-model latency probe. See README.md for interpretation."""

import argparse
import json
import os
from pathlib import Path
import resource
import sys
import time


CURRENT = "dllm-hub/Qwen3-0.6B-diffusion-bd3lm-v0.1"
CURRENT_REVISION = "60f77bba67ba94231c16f5fb29bc66c500b038f1"
FAST = "Efficient-Large-Model/Fast_dLLM_v2_1.5B"
FAST_REVISION = "25093b6f63300adfd57f72145083c8a528fe4f16"
TIDE = "TIDE-dllm/distill-LLaDA2-TIDE_Cross"
TIDE_REVISION = "41d79bf453a90bed91e461cd845788e2d2dc66c0"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=["current", "fast", "tide"], required=True)
    parser.add_argument("--steps", type=int, default=96)
    parser.add_argument("--tokens", type=int, default=96)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--block-cache", action="store_true")
    parser.add_argument("--telemetry", action="store_true")
    parser.add_argument("--prompt", default="all")
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--cores", default="0,1")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    cores = [int(value) for value in args.cores.split(",")]
    os.sched_setaffinity(0, cores)
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    os.environ["OMP_NUM_THREADS"] = str(len(cores))
    os.environ["MKL_NUM_THREADS"] = str(len(cores))

    import torch
    import transformers
    from transformers import AutoModelForCausalLM, AutoTokenizer

    torch.set_num_threads(len(cores))
    torch.set_num_interop_threads(1)
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import app as current_runtime
    from modeling_qwen3 import A2DQwen3Config, A2DQwen3LMHeadModel

    fixture = json.loads(Path(__file__).with_name("prompts.json").read_text())
    prompts = [p for p in fixture["prompts"] if args.prompt in ("all", p["id"])]
    if not prompts:
        raise ValueError("Unknown prompt")
    repo, revision = {
        "current": (CURRENT, CURRENT_REVISION),
        "fast": (FAST, FAST_REVISION),
        "tide": (TIDE, TIDE_REVISION),
    }[args.model]
    uses_a2d = args.model in ("current", "tide")
    load_started = time.perf_counter()
    if uses_a2d:
        # TIDE's pinned model classes match this reviewed implementation. Its
        # only inference-code change inlines shape/device in the default mask.
        # No remote model Python is executed for either A2D checkpoint.
        config = A2DQwen3Config.from_pretrained(repo, revision=revision)
        model = A2DQwen3LMHeadModel.from_pretrained(
            repo, revision=revision, config=config, dtype=torch.bfloat16,
        ).to("cpu").eval()
    else:
        # The two remote Python files at this exact revision were reviewed before
        # this benchmark. No generated code, inference kernels, or sampling rules
        # are patched. Its flex-attention compilation is used only in training.
        model = AutoModelForCausalLM.from_pretrained(
            repo, revision=revision, code_revision=revision,
            dtype=torch.bfloat16, trust_remote_code=True,
        ).to("cpu").eval()
    tokenizer = AutoTokenizer.from_pretrained(repo, revision=revision)
    loaded_seconds = time.perf_counter() - load_started
    assert next(model.parameters()).device.type == "cpu"

    def encode(prompt):
        messages = [
            {"role": "system", "content": fixture["system_prompt"]},
            {"role": "user", "content": prompt},
        ]
        return tokenizer.apply_chat_template(
            messages, add_generation_prompt=True, tokenize=True,
            enable_thinking=False, return_tensors="pt",
        )

    # Warm representative prefill and 32-token shapes without counting model
    # loading, downloads, or the warmup as inference latency.
    warm_ids = encode(prompts[0]["text"])
    with torch.inference_mode():
        if uses_a2d:
            attn, pos = current_runtime.build_staircase_attention_mask(warm_ids, 32, tokenizer.pad_token_id)
            model(warm_ids, attention_mask=attn, position_ids=pos, use_cache=True)
            short = warm_ids[:, -32:]
            attn, pos = current_runtime.build_staircase_attention_mask(short, 32, tokenizer.pad_token_id)
            model(short, attention_mask=attn, position_ids=pos, use_cache=True)
        else:
            model(warm_ids, use_cache=True, update_past_key_values=True, block_size=32)
            model(warm_ids[:, -32:], use_cache=True, update_past_key_values=True, block_size=32)

    report = {
        "model": repo, "revision": revision, "args": {**vars(args), "output": str(args.output)},
        "cpu_model": next(line.split(":", 1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines() if line.startswith("model name")),
        "affinity": sorted(os.sched_getaffinity(0)), "torch_threads": torch.get_num_threads(),
        "torch": torch.__version__, "transformers": transformers.__version__,
        "dtype": str(next(model.parameters()).dtype), "device": "cpu",
        "load_seconds": loaded_seconds, "runs": [],
        "notes": [
            "Two physical Threadripper cores; NOT the hosted Space CPU. Warm, single-request, no network latency.",
            "First forward includes prompt prefill; first decoding forward is the first forward over unresolved response tokens.",
            "Fast official generator uses floor(budget/32) blocks and prompt alignment; actual output length is recorded, not assumed.",
            "Fast telemetry is not implemented: its timing excludes the visualization capture overhead included by --telemetry for current.",
        ],
    }
    original_forward = model.forward
    tracker = None

    def measured_forward(*forward_args, **kwargs):
        started = time.perf_counter()
        output = original_forward(*forward_args, **kwargs)
        finished = time.perf_counter()
        if tracker is not None:
            ids = kwargs.get("input_ids", forward_args[0] if forward_args else None)
            decoding = not kwargs.get("update_past_key_values", False) if args.model == "fast" else not kwargs.get("use_cache", False)
            tracker["forwards"].append({
                "seconds": finished - started, "completed_seconds": finished - tracker["started"],
                "input_tokens": ids.shape[1], "decoding": decoding,
            })
        return output

    model.forward = measured_forward
    for prompt in prompts:
        for repeat in range(args.repeats):
            torch.manual_seed(1234 + repeat)
            ids = encode(prompt["text"])
            tracker = {"started": time.perf_counter(), "forwards": []}
            first_visible = None
            first_frame = None
            final_ids = None
            frame_count = 0
            with torch.inference_mode():
                if uses_a2d:
                    for event in current_runtime.generate_stream(
                        model, tokenizer, ids, steps=args.steps,
                        max_new_tokens=args.tokens, block_size=32,
                        temperature=args.temperature, capture_interval=1,
                        capture_activations=args.telemetry,
                    ):
                        if event["type"] == "intermediate":
                            frame_count += 1
                            if first_frame is None:
                                first_frame = time.perf_counter() - tracker["started"]
                            if first_visible is None and event["text"].strip():
                                first_visible = time.perf_counter() - tracker["started"]
                            if event.get("telemetry"):
                                final_ids = [token["tokenId"] for token in event["telemetry"]["tokenState"]["tokens"]]
                        final_text = event["text"]
                else:
                    generated = model.generate(
                        ids, max_new_tokens=args.tokens, tokenizer=tokenizer,
                        block_size=32, small_block_size=8, threshold=0.9,
                        temperature=args.temperature, top_p=0.95,
                        use_block_cache=args.block_cache,
                    )
                    final_ids = generated[0, ids.shape[1]:].tolist()
                    final_text = tokenizer.decode(final_ids, skip_special_tokens=True)
            elapsed = time.perf_counter() - tracker["started"]
            forwards = tracker["forwards"]
            tracker = None
            non_special_ids = [i for i in final_ids if i not in tokenizer.all_special_ids] if final_ids is not None else None
            result = {
                "prompt_id": prompt["id"], "prompt": prompt["text"], "repeat": repeat,
                "prompt_tokens": ids.shape[1], "total_seconds": elapsed,
                "first_forward_seconds": forwards[0]["completed_seconds"],
                "first_decoding_forward_seconds": next((f["completed_seconds"] for f in forwards if f["decoding"]), None),
                "first_token_frame_seconds": first_frame,
                "first_visible_text_seconds": first_visible,
                "forward_count": len(forwards), "decoding_forward_count": sum(f["decoding"] for f in forwards),
                "frame_count": frame_count, "response_slots": len(final_ids) if final_ids is not None else None,
                "non_special_output_tokens": len(non_special_ids) if non_special_ids is not None else None,
                "output_text_retokenized_length": len(tokenizer.encode(final_text, add_special_tokens=False)),
                "eos_seen": tokenizer.eos_token_id in final_ids if final_ids is not None else None,
                "peak_process_rss_mib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
                "text": final_text, "forwards": forwards,
            }
            report["runs"].append(result)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps({k: v for k, v in result.items() if k != "forwards"}), flush=True)
    print("Report:", args.output, flush=True)


if __name__ == "__main__":
    main()
