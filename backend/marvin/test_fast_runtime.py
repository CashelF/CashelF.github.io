"""Adapter contracts use tiny real tensor forwards, not downloaded weights."""

from types import SimpleNamespace

import pytest
import torch
from torch import nn

from fast_runtime import generate_stream


class Tokenizer:
    mask_token_id = 7
    eos_token_id = 6
    pad_token_id = 0
    all_special_ids = [0, 6, 7]

    def decode(self, tokens, skip_special_tokens=False, **kwargs):
        return " ".join(str(token) for token in tokens if not skip_special_tokens or token not in self.all_special_ids)


class Decoder(nn.Module):
    def forward(self, hidden):
        return hidden * 2


class Model(nn.Module):
    device = torch.device("cpu")

    def __init__(self, confidence=20, eos_position=None, stall=False, confident_suffix=False):
        super().__init__()
        self.config = SimpleNamespace(
            num_hidden_layers=2, hidden_size=4, intermediate_size=8,
            num_attention_heads=2, num_key_value_heads=1, head_dim=2,
        )
        self.model = nn.Module()
        self.model.layers = nn.ModuleList([Decoder(), Decoder()])
        self.confidence = confidence
        self.eos_position = eos_position
        self.stall = stall
        self.confident_suffix = confident_suffix
        self.calls = []

    def forward(self, input_ids, past_key_values=None, update_past_key_values=False, **kwargs):
        prefix = past_key_values or 0
        origin = prefix + (kwargs.get("replace_position") or 0)
        self.calls.append({"origin": origin, "tokens": input_ids.clone(), "cache": update_past_key_values})
        hidden = torch.stack((input_ids.float() + 1, input_ids.float() + 2), dim=-1)
        for layer in self.model.layers:
            hidden = layer(hidden)
        logits = torch.zeros(1, input_ids.shape[1], 8)
        for row in range(input_ids.shape[1]):
            position = origin + row + 1
            token = 7 if self.stall else (6 if position == self.eos_position else 3)
            certain = token in (6, 7) or (self.confident_suffix and position > self.eos_position)
            logits[0, row, token] = 20 if certain else self.confidence
        return SimpleNamespace(
            logits=logits,
            past_key_values=prefix + input_ids.shape[1] if update_past_key_values else past_key_values,
            block_past_key_values=True,
        )

    def sample_with_top_p(self, logits, **kwargs):
        probabilities = logits.softmax(dim=-1)
        return probabilities.argmax(dim=-1), probabilities


def measured(events):
    return [event["telemetry"] for event in events if "telemetry" in event]


def test_partial_first_block_excludes_prompt_rows_and_partial_last_stays_bounded():
    model = Model()
    events = list(generate_stream(model, Tokenizer(), [1] * 29, max_new_tokens=8, capture_activations=True))
    frames = measured(events)
    assert [(frame["tokenState"]["blockStart"], frame["tokenState"]["blockSize"]) for frame in frames] == [(0, 3), (3, 5)]
    assert frames[0]["tokenPositions"] == [0, 1, 2]
    # The measured inputs are actual response masks; prompt values would give
    # a different known RMS. Capturing the first three query rows would fail.
    expected = (torch.tensor([8., 9.]).square().mean().sqrt() * 2).item()
    assert frames[0]["rawRms"][0] == pytest.approx([expected] * 3)
    assert len(frames[-1]["tokenState"]["tokens"]) == 8
    assert events[-1]["text"] == " ".join(["3"] * 8)
    assert all(position < 8 for frame in frames for position in frame["tokenPositions"])


def test_native_seed_has_no_fictitious_activation_or_unmask_flag():
    events = list(generate_stream(Model(), Tokenizer(), [1] * 32, max_new_tokens=9, capture_activations=True))
    seed = events[0]
    assert seed["phase"] == "seed" and "telemetry" not in seed
    assert seed["tokenState"]["tokens"][0] == {
        "position": 0, "tokenId": 3, "piece": "3", "state": "committed",
        "newlyCommitted": False, "special": False,
    }
    assert measured(events)[0]["tokenState"]["tokens"][0]["newlyCommitted"] is False
    assert events[-1]["text"] == " ".join(["3"] * 9)


def test_cached_subblocks_only_measure_actual_queried_rows():
    model = Model(confidence=1)
    events = list(generate_stream(model, Tokenizer(), [1] * 33, max_new_tokens=16, capture_activations=True))
    denoise_calls = [call for call in model.calls if not call["cache"]]
    frames = measured(events)
    assert {call["tokens"].shape[1] for call in denoise_calls} == {8, 32}
    for call, frame in zip(denoise_calls, frames):
        expected_start = max(call["origin"], 33) - 33
        expected_end = min(call["origin"] + call["tokens"].shape[1], 49) - 33
        assert frame["tokenPositions"] == list(range(expected_start, expected_end))
    assert events[-1]["step"] == 16
    assert events[-1]["text"] == " ".join(["3"] * 16)


def test_eos_waits_for_masked_prefix_and_discards_committed_suffix():
    events = list(generate_stream(Model(confidence=1, eos_position=35, confident_suffix=True), Tokenizer(), [1] * 33, max_new_tokens=8, capture_activations=True))
    frames = measured(events)
    first_tokens = frames[0]["tokenState"]["tokens"]
    assert first_tokens[2]["tokenId"] == 6
    assert first_tokens[0]["state"] == "masked"
    assert first_tokens[3]["state"] == "committed"
    assert len(frames) > 1
    final_tokens = frames[-1]["tokenState"]["tokens"]
    assert [token["state"] for token in final_tokens] == ["committed"] * 3 + ["discarded"] * 5
    assert not any(token["newlyCommitted"] for token in final_tokens[3:])
    assert events[-1]["text"] == "3 3" == events[-2]["text"]


def test_closed_stream_and_failure_remove_hooks():
    model = Model(confidence=1)
    stream = generate_stream(model, Tokenizer(), [1] * 33, max_new_tokens=8, capture_activations=True)
    next(stream)
    stream.close()
    assert all(not module._forward_hooks and not module._forward_pre_hooks for module in model.modules())
    stalled = Model(stall=True)
    with pytest.raises(RuntimeError, match="did not commit"):
        list(generate_stream(stalled, Tokenizer(), [1] * 33, max_new_tokens=8, capture_activations=True))
    assert all(not module._forward_hooks and not module._forward_pre_hooks for module in stalled.modules())


@pytest.mark.parametrize("budget", [0, 257, True, 2.5])
def test_invalid_budget_is_rejected_before_forward(budget):
    model = Model()
    with pytest.raises(ValueError, match="max_new_tokens"):
        list(generate_stream(model, Tokenizer(), [1], max_new_tokens=budget))
    assert model.calls == []
