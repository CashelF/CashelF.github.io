"""Deterministic admission, lifetime and cooperative inference cancellation."""

import json
import threading
import uuid

import pytest

import app as server
from request_queue import AdmissionError, InferenceQueue, RequestCancelled
from test_telemetry import ProjectionModel, TinyTokenizer, assert_no_capture_hooks


class Clock:
    def __init__(self):
        self.now = 1000

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def make_queue(runner=None, **kwargs):
    return InferenceQueue(runner or (lambda ticket, queue: None), autostart=False, **kwargs)


def test_fifo_capacity_and_positions_update_after_cancel():
    served = []
    queue = make_queue(lambda ticket, _: served.append(ticket.request_id))
    first = queue.submit("a", {})
    second = queue.submit("b", {})
    third = queue.submit("c", {})
    assert list(second.events) == [{"type": "queued", "position": 1}]
    assert list(third.events) == [{"type": "queued", "position": 2}]
    with pytest.raises(AdmissionError) as rejected:
        queue.submit("d", {})
    assert rejected.value.status == 429
    queue.cancel("b")
    assert list(third.events) == [{"type": "queued", "position": 1}]
    queue.run_once()
    queue.run_once()
    assert served == ["a", "c"]
    assert first.done and second.done and third.done
    assert queue.snapshot() == {"active": False, "waiting": 0, "capacity": 2, "lease_seconds": 12}


def test_duplicate_cannot_consume_another_slot_or_replace_payload():
    queue = make_queue()
    first = queue.submit("same", {"prompt": "original"})
    with pytest.raises(AdmissionError) as duplicate:
        queue.submit("same", {"prompt": "replacement"})
    assert duplicate.value.status == 409
    assert first.payload["prompt"] == "original"
    assert queue.snapshot()["waiting"] == 0


def test_simultaneous_visitors_cannot_overbook_the_three_slots():
    queue = make_queue()
    gate = threading.Barrier(13)
    accepted, rejected = [], []

    def submit(index):
        gate.wait()
        try:
            accepted.append(queue.submit(str(index), {}))
        except AdmissionError as error:
            rejected.append(error.status)

    visitors = [threading.Thread(target=submit, args=(index,)) for index in range(12)]
    for visitor in visitors:
        visitor.start()
    gate.wait()
    for visitor in visitors:
        visitor.join(timeout=2)
        assert not visitor.is_alive()
    assert len(accepted) == 3
    assert rejected == [429] * 9
    assert queue.snapshot()["waiting"] == 2


def test_cancel_before_original_post_arrives_prevents_admission():
    served = []
    queue = make_queue(lambda ticket, _: served.append(ticket.request_id))
    queue.cancel("late-post")
    queue.cancel("late-post")
    with pytest.raises(AdmissionError) as cancelled:
        queue.submit("late-post", {})
    assert cancelled.value.code == "cancelled"
    assert not queue.run_once()
    assert served == []


def test_lease_expiry_is_checked_atomically_before_promotion_and_cannot_revive():
    clock = Clock()
    served = []
    queue = make_queue(lambda ticket, _: served.append(ticket.request_id), clock=clock)
    queue.submit("active", {})
    expired = queue.submit("expired", {})
    clock.advance(8)
    assert queue.keepalive("active")
    fresh = queue.submit("fresh", {})
    clock.advance(4)
    assert not queue.keepalive("expired")
    queue.run_once()
    queue.run_once()
    assert served == ["active", "fresh"]
    assert expired.cancelled and fresh.done
    assert expired.events[0]["code"] == "lease_expired"


def test_expired_reserved_first_request_never_calls_runner():
    clock = Clock()
    served = []
    queue = make_queue(lambda ticket, _: served.append(ticket.request_id), clock=clock)
    queue.submit("expired", {})
    clock.advance(12)
    queue.run_once()
    assert served == []
    assert queue.snapshot()["active"] is False


def test_closed_socket_cannot_be_promoted_even_with_valid_lease():
    disconnected = False
    served = []
    queue = make_queue(lambda ticket, _: served.append(ticket.request_id))
    queue.submit("first", {})
    departed = queue.submit("departed", {}, is_disconnected=lambda: disconnected)
    queue.submit("third", {})
    disconnected = True
    queue.run_once()
    queue.run_once()
    assert served == ["first", "third"]
    assert departed.cancelled
    assert not queue.keepalive("departed")


def test_max_wait_expires_even_with_regular_heartbeats():
    clock = Clock()
    queue = make_queue(clock=clock, lease_seconds=500)
    queue.submit("a", {})
    waiting = queue.submit("b", {})
    clock.advance(180)
    assert not queue.keepalive("b")
    assert waiting.events[0]["code"] == "queue_expired"
    assert queue.snapshot()["waiting"] == 0


def test_legacy_admission_never_bypasses_queue_and_queued_job_waits_for_legacy():
    served = []
    queue = make_queue(lambda ticket, _: served.append(ticket.request_id))
    assert queue.acquire_legacy()
    queue.submit("queued", {})
    assert not queue.run_once()
    assert not queue.acquire_legacy()
    with pytest.raises(AdmissionError):
        queue.submit("old-client", {}, leased=False, allow_wait=False)
    queue.release_legacy()
    assert not queue.acquire_legacy()
    queue.run_once()
    assert served == ["queued"]
    assert queue.acquire_legacy()
    queue.release_legacy()


def test_cancelling_running_job_keeps_slot_until_forward_unwinds():
    entered = threading.Event()
    release = threading.Event()
    cleaned = threading.Event()
    served = []

    def runner(ticket, queue):
        served.append(ticket.request_id)
        try:
            if ticket.request_id == "first":
                entered.set()
                assert release.wait(2)
            queue.checkpoint(ticket)
        finally:
            cleaned.set()

    queue = InferenceQueue(runner)
    try:
        queue.submit("first", {})
        assert entered.wait(2)
        queue.submit("second", {})
        queue.cancel("first")
        assert queue.snapshot()["active"] is True
        assert queue.snapshot()["waiting"] == 1
        assert not queue.acquire_legacy()
        assert served == ["first"]
        release.set()
        assert cleaned.wait(2)
        with queue._condition:
            assert queue._condition.wait_for(lambda: not queue.snapshot()["active"], timeout=2)
        assert served == ["first", "second"]
        assert not queue.inference_lock.locked()
    finally:
        release.set()
        queue.close()


def test_stream_close_cancels_queued_ticket_without_work():
    served = []
    queue = make_queue(lambda ticket, _: served.append(ticket.request_id))
    queue.submit("first", {})
    waiting = queue.submit("gone", {})
    stream = queue.events(waiting)
    assert next(stream)["position"] == 1
    stream.close()
    queue.run_once()
    assert not queue.run_once()
    assert served == ["first"]


def test_output_buffer_blocks_and_active_cancel_releases_worker():
    produced = []
    blocked = threading.Event()

    def runner(ticket, queue):
        for value in range(100):
            if value == 2:
                blocked.set()
            queue.emit(ticket, {"type": "intermediate", "value": value})
            produced.append(value)

    queue = InferenceQueue(runner, buffer_size=2)
    try:
        ticket = queue.submit("slow", {})
        assert blocked.wait(2)
        assert len(ticket.events) == 2
        queue.cancel("slow")
        with queue._condition:
            assert queue._condition.wait_for(lambda: ticket.done, timeout=2)
        assert produced == [0, 1]
        assert not queue.inference_lock.locked()
    finally:
        queue.close()


@pytest.mark.parametrize("cancel_after,cfg_scale,capture", [(1, 0, True), (2, 0, True), (2, 1, True), (4, 1, True), (4, 0, False)])
def test_sampler_cancels_after_inflight_forward_even_between_capture_events(cancel_after, cfg_scale, capture):
    calls = []
    cancelled = False

    class CancellableModel(ProjectionModel):
        def forward(self, tokens, **kwargs):
            nonlocal cancelled
            result = super().forward(tokens, **kwargs)
            calls.append(kwargs.get("use_cache"))
            if len(calls) == cancel_after:
                cancelled = True
            return result

    def checkpoint():
        if cancelled:
            raise RequestCancelled()

    model = CancellableModel()
    generator = server.generate_stream(
        model, TinyTokenizer(), [1, 2, 3, 4], steps=16, max_new_tokens=8,
        block_size=4, cfg_scale=cfg_scale, capture_interval=100,
        capture_activations=capture, check_cancelled=checkpoint,
    )
    with pytest.raises(RequestCancelled):
        list(generator)
    assert len(calls) == cancel_after
    assert_no_capture_hooks(model)


def test_worker_closes_generator_before_promoting_next_request(monkeypatch):
    closed = []
    executed = []

    def sampler(*args, **kwargs):
        try:
            executed.append("forward")
            yield {"type": "intermediate"}
            kwargs["check_cancelled"]()
        finally:
            closed.append(True)

    monkeypatch.setattr(server, "model", ProjectionModel())
    monkeypatch.setattr(server, "tokenizer", TinyTokenizer())
    monkeypatch.setattr(server, "device", "cpu")
    monkeypatch.setattr(server, "generate_stream", sampler)
    queue = make_queue(server.run_generation)
    original_emit = queue.emit

    def cancel_on_frame(ticket, event):
        original_emit(ticket, event)
        if event["type"] == "intermediate":
            queue.cancel(ticket.request_id)

    queue.emit = cancel_on_frame
    queue.submit("a", {"prompt": "hello"})
    queue.run_once()
    assert closed == [True]
    assert executed == ["forward"]
    assert not queue.inference_lock.locked()


def test_http_queue_status_cancellation_and_request_id_validation(monkeypatch):
    queue = make_queue()
    monkeypatch.setattr(server, "generation_queue", queue)
    monkeypatch.setattr(server, "model", ProjectionModel())
    monkeypatch.setattr(server, "tokenizer", TinyTokenizer())
    first_id, second_id = str(uuid.uuid4()), str(uuid.uuid4())
    queue.submit(first_id, {})
    with server.app.test_client() as client:
        assert client.post('/generate_sse', json={"prompt": "hi", "request_id": "guessable"}).status_code == 400
        response = client.post('/generate_sse', json={"prompt": "hi", "request_id": second_id}, buffered=False)
        assert response.status_code == 200
        event = json.loads(next(iter(response.response)).decode().removeprefix("data: "))
        assert event == {"type": "queued", "position": 1}
        assert client.get('/health').json['queue']['waiting'] == 1
        assert client.post(f'/requests/{second_id}/keepalive').status_code == 200
        assert client.post(f'/requests/{second_id}/cancel').status_code == 200
        assert client.post(f'/requests/{second_id}/cancel').status_code == 200
        assert client.post(f'/requests/{second_id}/keepalive').status_code == 404
        assert client.get('/health').json['queue']['waiting'] == 0
        assert client.post('/generate_sse', json={"prompt": "hi", "request_id": second_id}).status_code == 409
        response.close()
