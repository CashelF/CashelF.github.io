"""Run with: python -m pytest backend/marvin -q."""

import json
import math
from types import SimpleNamespace

import pytest
import torch
from torch import nn

import app as server
from telemetry import capability, capture_forward, sampled_indices
from request_queue import InferenceQueue


class TinyDecoder(nn.Module):
    def __init__(self, scale):
        super().__init__()
        self.scale = scale

    def forward(self, value):
        return value * self.scale


class TinyModel(nn.Module):
    """Small real tensor forwards, with known residual values for assertions."""

    device = torch.device("cpu")

    def __init__(self):
        super().__init__()
        self.model = nn.Module()
        self.model.layers = nn.ModuleList([TinyDecoder(1), TinyDecoder(2)])

    def forward(self, tokens, **kwargs):
        hidden = torch.stack((tokens.float() + 1, tokens.float() + 2), dim=-1)
        for layer in self.model.layers:
            hidden = layer(hidden)
        logits = torch.zeros(*tokens.shape, 8)
        logits[..., 3] = hidden[..., 0] + 10
        return SimpleNamespace(logits=logits, past_key_values=None)


class TinyTokenizer:
    mask_token_id = 7
    pad_token_id = 0
    eos_token_id = None

    @property
    def all_special_ids(self):
        return [value for value in (self.mask_token_id, self.pad_token_id, self.eos_token_id) if value is not None]

    def decode(self, tokens, **kwargs):
        names = {self.mask_token_id: "<mask>", self.pad_token_id: "<pad>"}
        if self.eos_token_id is not None:
            names[self.eos_token_id] = "<eos>"
        return " ".join(
            names.get(token, str(token)) for token in tokens
            if not (kwargs.get("skip_special_tokens", False) and token in self.all_special_ids)
        )

    def apply_chat_template(self, *_args, **_kwargs):
        return [1, 2, 3]


class ProjectionDecoder(nn.Module):
    """Real projections with hand-checkable head and SwiGLU channel inputs."""

    def __init__(self, scale):
        super().__init__()
        self.scale = scale
        self.self_attn = nn.Module()
        self.self_attn.head_dim = 2
        self.self_attn.o_proj = nn.Linear(4, 4, bias=False)
        self.mlp = nn.Module()
        self.mlp.gate_proj = nn.Linear(4, 64)
        self.mlp.up_proj = nn.Linear(4, 64, bias=False)
        self.mlp.down_proj = nn.Linear(64, 4, bias=False)
        with torch.no_grad():
            self.self_attn.o_proj.weight.zero_()
            self.mlp.gate_proj.weight.zero_()
            self.mlp.gate_proj.bias.fill_(1)
            self.mlp.up_proj.weight.zero_()
            self.mlp.up_proj.weight[:, 0] = torch.arange(1, 65)
            self.mlp.down_proj.weight.zero_()

    def forward(self, hidden):
        hidden = hidden * self.scale
        hidden = hidden + self.self_attn.o_proj(hidden)
        channels = torch.nn.functional.silu(self.mlp.gate_proj(hidden)) * self.mlp.up_proj(hidden)
        return hidden + self.mlp.down_proj(channels)


class ProjectionModel(TinyModel):
    def __init__(self):
        super().__init__()
        self.model.layers = nn.ModuleList([ProjectionDecoder(1), ProjectionDecoder(2)])

    def forward(self, tokens, **kwargs):
        hidden = tokens.float().unsqueeze(-1) + torch.arange(1, 5, dtype=torch.float)
        for layer in self.model.layers:
            hidden = layer(hidden)
        logits = torch.zeros(*tokens.shape, 8)
        logits[..., 3] = hidden[..., 0] + 10
        return SimpleNamespace(logits=logits, past_key_values=None)


class ArchitectureDecoder(ProjectionDecoder):
    """Two Q heads sharing one K/V head, with distinguishable projections."""

    def __init__(self, scale):
        super().__init__(scale)
        self.self_attn.q_proj = nn.Linear(4, 4, bias=False)
        self.self_attn.k_proj = nn.Linear(4, 2, bias=False)
        self.self_attn.v_proj = nn.Linear(4, 2, bias=False)
        self.self_attn.q_norm = TinyDecoder(10)
        self.self_attn.k_norm = TinyDecoder(100)
        self.skip_key_projection = False
        with torch.no_grad():
            self.self_attn.q_proj.weight.copy_(2 * torch.eye(4))
            self.self_attn.k_proj.weight.copy_(3 * torch.eye(4)[:2])
            self.self_attn.v_proj.weight.copy_(4 * torch.eye(4)[2:])

    def forward(self, hidden):
        projected_input = hidden * self.scale
        self.self_attn.q_norm(self.self_attn.q_proj(projected_input))
        if not self.skip_key_projection:
            self.self_attn.k_norm(self.self_attn.k_proj(projected_input))
        self.self_attn.v_proj(projected_input)
        return super().forward(hidden)


class ArchitectureModel(ProjectionModel):
    def __init__(self):
        super().__init__()
        self.model.embed_tokens = nn.Embedding(256, 4)
        self.model.layers = nn.ModuleList([ArchitectureDecoder(1), ArchitectureDecoder(2)])
        self.model.norm = TinyDecoder(3)
        self.lm_head = nn.Linear(4, 128, bias=False)
        self.skip_final_norm = False
        with torch.no_grad():
            self.model.embed_tokens.weight.copy_(torch.arange(256).unsqueeze(1) + torch.arange(1, 5))
            self.lm_head.weight.zero_()
            self.lm_head.weight[:, 0] = torch.arange(1, 129)

    def forward(self, tokens, **kwargs):
        hidden = self.model.embed_tokens(tokens)
        for layer in self.model.layers:
            hidden = layer(hidden)
        if not self.skip_final_norm:
            hidden = self.model.norm(hidden)
        return SimpleNamespace(logits=self.lm_head(hidden), past_key_values=None)


def assert_no_capture_hooks(model):
    assert all(not module._forward_hooks and not module._forward_pre_hooks for module in model.modules())


@pytest.fixture
def model():
    return TinyModel()


@pytest.fixture
def client(monkeypatch, model):
    monkeypatch.setattr(server, "model", model)
    monkeypatch.setattr(server, "tokenizer", TinyTokenizer())
    monkeypatch.setattr(server, "device", "cpu")
    queue = InferenceQueue(server.run_generation, inference_lock=server.inference_lock)
    monkeypatch.setattr(server, "generation_queue", queue)
    try:
        with server.app.test_client() as client:
            yield client
    finally:
        queue.close()
    assert not server.inference_lock.locked()


def test_rms_is_measured_from_real_decoder_outputs(model):
    with capture_forward(model, 10, 2) as frame:
        model(torch.tensor([[2, 4]]))
    expected = ((3 ** 2 + 4 ** 2) / 2) ** 0.5
    assert frame["rawRms"][0][0] == pytest.approx(expected)
    assert frame["rawRms"][1][0] == pytest.approx(expected * 2)
    assert frame["activations"][0][0] == pytest.approx(expected / (1 + expected))
    assert frame["layerIndices"] == [0, 1]
    assert frame["tokenPositions"] == [10, 11]
    assert all(not layer._forward_hooks for layer in model.model.layers)


def test_hooks_are_removed_when_forward_fails(model):
    with pytest.raises(RuntimeError):
        with capture_forward(model, 0, 2):
            raise RuntimeError("forward failed")
    assert all(not layer._forward_hooks for layer in model.model.layers)


def test_internals_measure_preprojection_heads_and_actual_swiglu_channels():
    model = ProjectionModel()
    assert capability(model)["internals"] is True
    # The other batch row has much larger activations and must not leak in.
    with capture_forward(model, 100, 2) as frame:
        model(torch.tensor([[0, 2], [100, 200]]))
    internals = frame["internals"]
    assert internals["headCount"] == 2
    assert internals["headDim"] == 2
    indices = internals["neuronIndices"]
    assert len(indices) == len(set(indices)) == 32
    assert indices[:3] == [0, 2, 4]
    assert indices[-3:] == [59, 61, 63]
    expected_heads = [(30 / 4) ** 0.5, (86 / 4) ** 0.5]
    assert internals["attentionHeadRms"][0] == pytest.approx(expected_heads)
    assert internals["attentionHeadRms"][1] == pytest.approx([2 * value for value in expected_heads])
    silu_one = 1 / (1 + math.exp(-1))
    expected_neurons = [silu_one * 5 ** 0.5 * (index + 1) for index in indices]
    assert internals["mlpNeuronRms"][0] == pytest.approx(expected_neurons)
    assert internals["mlpNeuronRms"][1] == pytest.approx([2 * value for value in expected_neurons])
    # Both projection outputs are zero; measuring after either would fail this.
    assert internals["attentionHeadRms"][0][0] > 0
    assert internals["mlpNeuronRms"][0][0] > 0
    assert_no_capture_hooks(model)


def test_internal_sampling_uses_only_the_same_active_positions_as_residuals():
    model = ProjectionModel()
    tokens = torch.zeros(1, 100, dtype=torch.long)
    tokens[0, 1] = 100000  # Position 1 is between the two first sampled positions.
    with capture_forward(model, 500, 100) as frame:
        model(tokens)
    assert frame["tokenPositions"][:2] == [500, 503]
    assert frame["internals"]["attentionHeadRms"][0] == pytest.approx([2.5 ** 0.5, 12.5 ** 0.5])
    assert_no_capture_hooks(model)


@pytest.mark.parametrize("failure", ["forward", "nonfinite", "incomplete"])
def test_internal_hooks_are_removed_after_failure(failure):
    model = ProjectionModel()
    with pytest.raises((RuntimeError, ValueError)):
        with capture_forward(model, 0, 2):
            if failure == "forward":
                model.model.layers[0](torch.ones(1, 2, 4))
                raise RuntimeError("later layer failed")
            if failure == "nonfinite":
                model.model.layers[0](torch.full((1, 2, 4), float("nan")))
            # No forward at all exercises incomplete-telemetry cleanup.
    assert_no_capture_hooks(model)


def test_internal_capture_is_optional_and_does_not_retain_previous_requests(model):
    assert capability(model)["internals"] is False
    with capture_forward(model, 0, 2) as generic:
        model(torch.ones(1, 2, dtype=torch.long))
    assert "internals" not in generic

    projected = ProjectionModel()
    with capture_forward(projected, 0, 2) as first:
        projected(torch.zeros(1, 2, dtype=torch.long))
    first_serialized = json.dumps(first)
    projected(torch.full((1, 2), 999))  # A different, unmeasured request.
    with capture_forward(projected, 8, 2) as second:
        projected(torch.full((1, 2), 4))
    assert json.dumps(first) == first_serialized
    assert first["internals"]["attentionHeadRms"] != second["internals"]["attentionHeadRms"]
    assert_no_capture_hooks(projected)


def test_internal_stream_excludes_prefix_and_keeps_sampling_output_unchanged():
    model = ProjectionModel()
    params = dict(steps=4, max_new_tokens=4, block_size=4, cfg_scale=1.0)
    baseline = list(server.generate_stream(model, TinyTokenizer(), [1, 2, 3, 4], **params))
    captured = list(server.generate_stream(model, TinyTokenizer(), [1, 2, 3, 4], capture_activations=True, **params))
    assert captured[-1]["text"] == baseline[-1]["text"]
    assert len(captured[:-1]) == 4  # One frame per conditional forward only.
    first = captured[0]["telemetry"]["internals"]
    assert first["attentionHeadRms"][0] == pytest.approx([(145 / 2) ** 0.5, (221 / 2) ** 0.5])
    assert_no_capture_hooks(model)


def test_architecture_stages_measure_embedding_final_norm_and_sampled_logits():
    model = ArchitectureModel()
    info = capability(model)
    assert info["qkv"] is True
    assert info["stages"] == ["embeddingRms", "finalNormRms", "lmHeadRms"]
    with capture_forward(model, 4, 2) as frame:
        output = model(torch.tensor([[0, 2], [100, 200]]))
    stages = frame["stages"]
    expected_embedding = [math.sqrt(30 / 4), math.sqrt(86 / 4)]
    assert stages["embeddingRms"] == pytest.approx(expected_embedding)
    assert stages["finalNormRms"] == pytest.approx([value * 6 for value in expected_embedding])
    indices = stages["lmHeadTokenIndices"]
    assert len(indices) == len(set(indices)) == 64
    assert indices[0] == 0 and indices[-1] == 127
    multiplier = math.sqrt(sum((index + 1) ** 2 for index in indices) / len(indices))
    assert stages["lmHeadRms"] == pytest.approx([6 * multiplier, 18 * multiplier])
    assert len(stages["lmHeadRms"]) == len(frame["tokenPositions"])
    assert output.logits.shape == (2, 2, 128)
    assert_no_capture_hooks(model)


def test_qkv_measures_actual_projection_outputs_before_norm_and_gqa_repetition():
    model = ArchitectureModel()
    with capture_forward(model, 4, 2) as frame:
        model(torch.tensor([[0, 2], [100, 200]]))
    internals = frame["internals"]
    assert (internals["headCount"], internals["kvHeadCount"], internals["headDim"]) == (2, 1, 2)
    expected_heads = [math.sqrt(30 / 4), math.sqrt(86 / 4)]
    assert internals["queryHeadRms"][0] == pytest.approx([value * 2 for value in expected_heads])
    assert internals["keyHeadRms"][0] == pytest.approx([expected_heads[0] * 3])
    assert internals["valueHeadRms"][0] == pytest.approx([expected_heads[1] * 4])
    for name in ("queryHeadRms", "keyHeadRms", "valueHeadRms"):
        assert internals[name][1] == pytest.approx([value * 2 for value in internals[name][0]])
    assert_no_capture_hooks(model)


def test_architecture_sampling_and_query_mapping_exclude_prompt_and_other_rows():
    model = ArchitectureModel()
    tokens = torch.zeros(1, 102, dtype=torch.long)
    tokens[0, :2] = 255  # Prompt rows must be excluded.
    tokens[0, 3] = 255  # Also exclude the second, unsampled response row.
    with capture_forward(model, 8, 100, query_indices=range(2, 102), query_count=102) as mapped:
        model(tokens)
    with capture_forward(model, 8, 100) as response_only:
        model(torch.zeros(1, 100, dtype=torch.long))
    assert mapped["tokenPositions"][:2] == [8, 11]
    for name in ("rawRms", "internals", "stages"):
        assert mapped[name] == response_only[name]
    assert_no_capture_hooks(model)


def test_logits_capture_only_reduces_declared_vocabulary_sample():
    model = ArchitectureModel()
    # An unsampled vocabulary column must neither enter the result nor force
    # a reduction of the complete vocabulary output.
    assert 1 not in sampled_indices(128, 64)
    with torch.no_grad():
        model.lm_head.weight[1, 0] = float("inf")
    with capture_forward(model, 0, 2) as frame:
        output = model(torch.tensor([[0, 2]]))
    assert bool(torch.isinf(output.logits[0, :, 1]).all())
    assert all(math.isfinite(value) for value in frame["stages"]["lmHeadRms"])
    assert_no_capture_hooks(model)


@pytest.mark.parametrize("failure", ["missing_stage", "missing_qkv", "nonfinite_stage", "nonfinite_qkv", "wrong_qkv_shape", "forward"])
def test_architecture_failures_publish_no_partial_metrics_and_remove_hooks(failure):
    model = ArchitectureModel()
    if failure == "missing_stage":
        model.skip_final_norm = True
    elif failure == "missing_qkv":
        model.model.layers[1].skip_key_projection = True
    elif failure == "nonfinite_stage":
        with torch.no_grad():
            model.lm_head.weight[0, 0] = float("nan")
    elif failure == "nonfinite_qkv":
        with torch.no_grad():
            model.model.layers[0].self_attn.q_proj.weight[0, 0] = float("nan")
    elif failure == "wrong_qkv_shape":
        model.model.layers[0].self_attn.k_proj.forward = lambda hidden: hidden
    with pytest.raises((ValueError, RuntimeError)):
        with capture_forward(model, 0, 2) as frame:
            model(torch.tensor([[0, 2]]))
            if failure == "forward":
                raise RuntimeError("forward failed after measurements")
    assert frame["rawRms"] == []
    assert frame["activations"] == []
    assert "stages" not in frame and "internals" not in frame
    assert_no_capture_hooks(model)


def test_architecture_capture_remains_optional_for_legacy_models():
    for model in (TinyModel(), ProjectionModel()):
        info = capability(model)
        assert info["qkv"] is False and info["stages"] == []
        with capture_forward(model, 0, 2) as frame:
            model(torch.tensor([[0, 2]]))
        assert "stages" not in frame
        assert "queryHeadRms" not in frame.get("internals", {})
        assert "kvHeadCount" not in frame.get("internals", {})
        assert_no_capture_hooks(model)


def test_incompatible_qkv_keeps_existing_internals():
    model = ArchitectureModel()
    # Both key/value widths must describe the same grouping in every block.
    model.model.layers[1].self_attn.k_proj = nn.Linear(4, 4)
    assert capability(model)["qkv"] is False
    with capture_forward(model, 0, 2) as frame:
        model(torch.tensor([[0, 2]]))
    assert "queryHeadRms" not in frame["internals"]
    assert "attentionHeadRms" in frame["internals"]
    assert "stages" in frame
    assert_no_capture_hooks(model)


def test_stages_are_independently_optional_and_small_vocabulary_is_not_oversampled():
    model = ProjectionModel()
    # Its forward does not call an embedding or final norm, only the decoder
    # blocks. Add just a vocabulary head and invoke it within that same scope.
    model.lm_head = nn.Linear(8, 3, bias=False)
    with capture_forward(model, 0, 2) as frame:
        output = model(torch.tensor([[0, 2]]))
        logits = model.lm_head(output.logits)
    assert capability(model)["stages"] == ["lmHeadRms"]
    assert set(frame["stages"]) == {"lmHeadRms", "lmHeadTokenIndices"}
    assert frame["stages"]["lmHeadTokenIndices"] == [0, 1, 2]
    assert frame["stages"]["lmHeadRms"] == pytest.approx(logits[0].square().mean(-1).sqrt().tolist())
    assert_no_capture_hooks(model)


def test_real_qwen_modules_capture_all_architecture_stages_without_changing_output():
    from modeling_qwen3 import A2DQwen3Config, A2DQwen3LMHeadModel

    config = A2DQwen3Config(
        vocab_size=128, hidden_size=16, intermediate_size=32,
        num_hidden_layers=2, num_attention_heads=4, num_key_value_heads=2,
        head_dim=8, pad_token_id=0,
    )
    model = A2DQwen3LMHeadModel(config).eval()
    tokens = torch.tensor([[1, 2, 3, 4]])
    with torch.inference_mode():
        baseline = model(tokens).logits
        with capture_forward(model, 0, 2, query_indices=[2, 3], query_count=4) as frame:
            measured = model(tokens).logits
    assert torch.equal(baseline, measured)
    assert len(frame["stages"]["embeddingRms"]) == 2
    assert len(frame["stages"]["finalNormRms"]) == 2
    assert len(frame["stages"]["lmHeadRms"]) == 2
    assert len(frame["internals"]["queryHeadRms"]) == 2
    assert len(frame["internals"]["queryHeadRms"][0]) == 4
    assert len(frame["internals"]["keyHeadRms"][0]) == 2
    assert len(frame["internals"]["valueHeadRms"][0]) == 2
    assert_no_capture_hooks(model)


def test_token_sampling_is_bounded_and_includes_both_ends(model):
    with capture_forward(model, 100, 100) as frame:
        model(torch.ones(1, 100, dtype=torch.long))
    assert len(frame["tokenPositions"]) == 32
    assert frame["tokenPositions"][0] == 100
    assert frame["tokenPositions"][-1] == 199
    assert all(len(row) == 32 for row in frame["activations"])


def test_stream_reports_every_forward_without_changing_generation(model):
    params = dict(steps=6, max_new_tokens=8, block_size=4, capture_interval=8)
    baseline = list(server.generate_stream(model, TinyTokenizer(), [1, 2, 3], **params))
    captured = list(server.generate_stream(model, TinyTokenizer(), [1, 2, 3], capture_activations=True, **params))
    frames = captured[:-1]
    assert [frame["step"] for frame in frames] == list(range(1, 7))
    assert all(frame["total_steps"] == 6 for frame in frames)
    assert [frame["telemetry"]["tokenPositions"] for frame in frames] == [
        [0], [0], [1, 2, 3, 4], [1, 2, 3, 4], [5, 6, 7], [5, 6, 7]
    ]
    assert captured[-1]["text"] == baseline[-1]["text"]
    assert captured[-1]["total_steps"] == 6
    assert all("telemetry" not in frame for frame in baseline)
    assert all(not layer._forward_hooks for layer in model.model.layers)


def test_token_snapshots_include_only_response_prefix_and_actual_active_block(model):
    events = list(server.generate_stream(
        model, TinyTokenizer(), [1, 2, 4], steps=6, max_new_tokens=8,
        block_size=4, capture_activations=True,
    ))
    snapshots = [event["telemetry"]["tokenState"] for event in events[:-1]]
    assert [(state["blockIndex"], state["blockStart"], state["blockSize"]) for state in snapshots] == [
        (0, 0, 1), (0, 0, 1), (1, 1, 4), (1, 1, 4), (2, 5, 3), (2, 5, 3),
    ]
    assert [len(state["tokens"]) for state in snapshots] == [1, 1, 5, 5, 8, 8]
    for state in snapshots:
        assert state["version"] == 1
        assert [token["position"] for token in state["tokens"]] == list(range(len(state["tokens"])))
        assert all(token["tokenId"] in (3, 7) for token in state["tokens"])
        for token in state["tokens"][:state["blockStart"]]:
            assert token["state"] == "committed"
            assert token["newlyCommitted"] is False
    # The one-slot first block has a genuine forward with zero new commits.
    assert snapshots[0]["tokens"][0]["newlyCommitted"] is True
    assert snapshots[1]["tokens"][0]["newlyCommitted"] is False
    masked = [token for token in snapshots[2]["tokens"] if token["state"] == "masked"]
    assert len(masked) == 2
    assert all(token["piece"] == "<mask>" and token["special"] for token in masked)
    assert all(not token["newlyCommitted"] for token in masked)
    assert all(token["state"] == "committed" for token in snapshots[-1]["tokens"])
    assert events[-2]["text"] == events[-1]["text"]
    assert "telemetry" not in events[-1]  # one measurement per model forward


def test_commits_follow_real_mask_transitions_and_retain_identity():
    class ChangingPredictionsModel(TinyModel):
        forwards = 0

        def forward(self, tokens, **kwargs):
            output = super().forward(tokens, **kwargs)
            if not kwargs.get("use_cache"):
                predicted_id = 3 + self.forwards % 3
                self.forwards += 1
                output.logits.zero_()
                for position, confidence in enumerate([4.0, 3.0, 2.0, 1.0]):
                    output.logits[:, position, predicted_id] = confidence
            return output

    events = list(server.generate_stream(
        ChangingPredictionsModel(), TinyTokenizer(), [1, 2, 3, 4], steps=4,
        max_new_tokens=4, block_size=4, capture_activations=True,
    ))
    previous = {}
    newly_committed = []
    for event in events[:-1]:
        tokens = event["telemetry"]["tokenState"]["tokens"]
        newly_committed.append([token["position"] for token in tokens if token["newlyCommitted"]])
        for token in tokens:
            old = previous.get(token["position"])
            assert token["newlyCommitted"] == (token["state"] == "committed" and (old is None or old["state"] == "masked"))
            if old is not None and old["state"] == "committed":
                assert token["tokenId"] == old["tokenId"]
                assert token["piece"] == old["piece"]
            previous[token["position"]] = token
    assert newly_committed == [[0], [1], [2], [3]]
    assert [token["tokenId"] for token in previous.values()] == [3, 4, 5, 3]
    assert events[-1]["text"] == "3 4 5 3"


def test_eos_waits_for_earlier_masks_and_discards_committed_suffix():
    class EarlyEosModel(TinyModel):
        def forward(self, tokens, **kwargs):
            output = super().forward(tokens, **kwargs)
            # EOS settles first at position 1. The positions after it settle
            # next, and position 0 settles last. Generation must wait for it.
            output.logits.zero_()
            for position, (token, confidence) in enumerate([(3, 8), (6, 30), (5, 10), (5, 9)]):
                output.logits[:, position, token] = confidence
            return output

    class EosTokenizer(TinyTokenizer):
        eos_token_id = 6

    model = EarlyEosModel()
    tokenizer = EosTokenizer()
    params = dict(steps=4, max_new_tokens=4, block_size=4)
    events = list(server.generate_stream(model, tokenizer, [1, 2, 3, 4], capture_activations=True, **params))
    assert len(events[:-1]) == 4
    assert events[-1]["text"] == "3"
    assert events[-1]["total_steps"] == 4
    states = [event["telemetry"]["tokenState"]["tokens"] for event in events[:-1]]
    assert [token["state"] for token in states[0]] == ["masked", "committed", "masked", "masked"]
    assert states[0][1]["tokenId"] == 6
    assert states[0][1]["piece"] == "<eos>"
    assert states[0][1]["special"] is True
    assert states[0][1]["newlyCommitted"] is True
    assert [token["tokenId"] for token in states[2]] == [7, 6, 5, 5]
    assert [token["state"] for token in states[-1]] == ["committed", "committed", "discarded", "discarded"]
    assert [token["tokenId"] for token in states[-1]] == [3, 6, 0, 0]
    assert [token["newlyCommitted"] for token in states[-1]] == [True, False, False, False]
    assert events[-2]["text"] == events[-1]["text"]
    output = server.generate(model, tokenizer, [1, 2, 3, 4], **params)
    assert output[0, 4:].tolist() == [3, 6, 0, 0]


def test_eos_discards_uncommitted_masks_without_counting_them_as_predictions():
    class ImmediateEosModel(TinyModel):
        def forward(self, tokens, **kwargs):
            output = super().forward(tokens, **kwargs)
            output.logits.zero_()
            output.logits[:, 0, 6] = 10
            output.logits[:, 1:, 3] = 1
            return output

    class EosTokenizer(TinyTokenizer):
        eos_token_id = 6
        pad_token_id = None  # sampler uses EOS as padding for this tokenizer

    events = list(server.generate_stream(
        ImmediateEosModel(), EosTokenizer(), [1, 2, 3, 4], steps=4,
        max_new_tokens=4, block_size=4, capture_activations=True,
    ))
    assert len(events) == 2
    tokens = events[0]["telemetry"]["tokenState"]["tokens"]
    assert [token["tokenId"] for token in tokens] == [6, 6, 6, 6]
    assert [token["state"] for token in tokens] == ["committed", "discarded", "discarded", "discarded"]
    assert [token["newlyCommitted"] for token in tokens] == [True, False, False, False]
    assert events[0]["text"] == events[1]["text"] == ""


def test_sse_capability_cors_and_disconnect_cleanup(client, model):
    health = client.get("/health")
    assert health.json["telemetry"]["available"] is True
    assert health.json["telemetry"]["token_states"] is True
    assert health.headers["Access-Control-Allow-Origin"] == "*"
    preflight = client.options("/generate_sse", headers={"Origin": "https://cashel.dev"})
    assert preflight.status_code == 200
    response = client.post("/generate_sse", json={
        "prompt": "hello", "steps": 24, "max_new_tokens": 8,
        "block_size": 4, "capture_activations": True,
    }, buffered=False)
    assert response.status_code == 200
    iterator = iter(response.response)
    assert json.loads(next(iterator).decode().removeprefix("data: "))["type"] == "start"
    frame = json.loads(next(iterator).decode().removeprefix("data: "))
    assert frame["type"] == "intermediate"
    assert len(frame["telemetry"]["activations"]) == 2
    assert frame["telemetry"]["tokenState"]["tokens"][0]["tokenId"] == 3
    assert client.post("/generate_sse", json={"prompt": "another visitor"}).status_code == 429
    response.close()
    # Cancellation finishes the one forward already in flight on the worker.
    with server.generation_queue._condition:
        assert server.generation_queue._condition.wait_for(lambda: not server.inference_lock.locked(), timeout=2)
    assert not server.inference_lock.locked()
    assert all(not layer._forward_hooks for layer in model.model.layers)


def test_sse_internal_capability_and_disconnect_cleanup(client, monkeypatch):
    model = ProjectionModel()
    monkeypatch.setattr(server, "model", model)
    assert client.get("/health").json["telemetry"]["internals"] is True
    response = client.post("/generate_sse", json={
        "prompt": "hello", "steps": 24, "max_new_tokens": 8,
        "block_size": 4, "capture_activations": True,
    }, buffered=False)
    iterator = iter(response.response)
    start = json.loads(next(iterator).decode().removeprefix("data: "))
    assert start["telemetry"]["internals"] is True
    frame = json.loads(next(iterator).decode().removeprefix("data: "))
    internal = frame["telemetry"]["internals"]
    assert len(internal["attentionHeadRms"]) == len(internal["mlpNeuronRms"]) == 2
    assert len(internal["attentionHeadRms"][0]) == 2
    assert len(internal["mlpNeuronRms"][0]) == 32
    assert frame["telemetry"]["tokenPositions"] == [0]
    # The separate worker may already be measuring its next forward here.
    assert client.post("/generate_sse", json={"prompt": "another visitor"}).status_code == 429
    response.close()
    # Cancellation finishes the one forward already in flight on the worker.
    with server.generation_queue._condition:
        assert server.generation_queue._condition.wait_for(lambda: not server.inference_lock.locked(), timeout=2)
    assert not server.inference_lock.locked()
    assert_no_capture_hooks(model)


@pytest.mark.parametrize("invalid", [
    {"steps": 0}, {"steps": True}, {"max_new_tokens": 257},
    {"capture_interval": 0}, {"capture_activations": "true"},
    {"temperature": float("nan")}, {"prompt": []}, {"remasking": "bad"},
])
def test_rejects_invalid_requests_before_generation(client, invalid):
    response = client.post("/generate_sse", json={"prompt": "hello", **invalid})
    assert response.status_code == 400


def test_query_mapping_excludes_prompt_rows_from_all_measurements():
    model = ProjectionModel()
    # Large prompt-only rows would dominate every metric if accidentally sampled.
    tokens = torch.tensor([[100000, 200000, 0, 2]])
    with capture_forward(model, 9, 2, query_indices=[2, 3], query_count=4) as mapped:
        model(tokens)
    with capture_forward(model, 9, 2) as response_only:
        model(tokens[:, 2:])
    assert mapped['tokenPositions'] == [9, 10]
    assert mapped['rawRms'] == response_only['rawRms']
    assert mapped['internals'] == response_only['internals']
    assert_no_capture_hooks(model)


@pytest.mark.parametrize('indices,count', [([0, 4], 4), ([1, 1], 4), ([3, 2], 4), ([0], 4), ([False, 1], 4), ([0, 1], 0)])
def test_invalid_query_mapping_installs_no_hooks(indices, count):
    model = ProjectionModel()
    with pytest.raises(ValueError, match='mapping'):
        with capture_forward(model, 0, 2, query_indices=indices, query_count=count):
            pass
    assert_no_capture_hooks(model)


def test_architecture_metadata_uses_checkpoint_shape_not_model_name_assumptions():
    model = ProjectionModel()
    model.config = SimpleNamespace(_name_or_path='Efficient-Large-Model/Fast_dLLM_v2_1.5B', num_hidden_layers=28, hidden_size=1536, intermediate_size=8960, num_attention_heads=12, num_key_value_heads=2)
    info = capability(model)['architecture']
    assert (info['queryHeads'], info['kvHeads'], info['headDim'], info['mlpWidth']) == (12, 2, 128, 8960)
    assert info['modelLabel'] == 'Fast-dLLM · 1.5B'
    model.config = SimpleNamespace(_name_or_path='dllm-hub/Qwen3-0.6B-diffusion-bd3lm-v0.1', num_hidden_layers=28, hidden_size=1024, intermediate_size=3072, num_attention_heads=16, num_key_value_heads=8, head_dim=128)
    info = capability(model)['architecture']
    assert (info['queryHeads'], info['kvHeads'], info['headDim'], info['mlpWidth']) == (16, 8, 128, 3072)
    assert info['modelFamily'] == 'bd3lm'
