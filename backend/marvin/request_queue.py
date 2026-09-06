"""A bounded, single-worker inference queue with cancellable visitor leases."""

import logging
import threading
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field


class AdmissionError(Exception):
    def __init__(self, message, status=429, code="queue_full"):
        super().__init__(message)
        self.status = status
        self.code = code


class RequestCancelled(Exception):
    pass


@dataclass(eq=False)
class Ticket:
    request_id: str
    payload: dict
    created: float
    lease_until: float | None
    is_disconnected: object = None
    events: deque = field(default_factory=deque)
    status: str = "waiting"
    cancelled: bool = False
    done: bool = False


class InferenceQueue:
    def __init__(self, runner, inference_lock=None, capacity=2, lease_seconds=12,
                 max_wait=180, buffer_size=8, clock=time.monotonic, autostart=True):
        self.runner = runner
        self.inference_lock = inference_lock or threading.Lock()
        self.capacity = capacity
        self.lease_seconds = lease_seconds
        self.max_wait = max_wait
        self.buffer_size = buffer_size
        self.clock = clock
        self._condition = threading.Condition()
        self._tickets = {}
        self._waiting = deque()
        self._active = None
        self._legacy = False
        self._closed = False
        self._cancelled_ids = OrderedDict()
        self._thread = None
        self._autostart = autostart

    def _start_locked(self):
        if self._autostart and self._thread is None:
            self._thread = threading.Thread(target=self._work, name="marvin-inference", daemon=True)
            self._thread.start()

    def _remember_cancelled_locked(self, request_id):
        self._cancelled_ids[request_id] = self.clock() + 30
        self._cancelled_ids.move_to_end(request_id)
        while len(self._cancelled_ids) > 1024:
            self._cancelled_ids.popitem(last=False)

    def _positions_locked(self):
        for position, ticket in enumerate(self._waiting, 1):
            # Positions can change faster than a slow client reads. Only the
            # current position matters, and these updates must stay bounded.
            ticket.events = deque(event for event in ticket.events if event.get("type") != "queued")
            ticket.events.append({"type": "queued", "position": position})
        self._condition.notify_all()

    def _cancel_locked(self, ticket, message="Request cancelled.", code="cancelled"):
        if ticket.done or ticket.cancelled:
            return
        ticket.cancelled = True
        ticket.events.clear()
        ticket.events.append({"type": "error", "error": message, "code": code})
        self._remember_cancelled_locked(ticket.request_id)
        if ticket in self._waiting:
            self._waiting.remove(ticket)
            ticket.done = True
            self._positions_locked()
        self._condition.notify_all()

    def _expire_locked(self):
        now = self.clock()
        for request_id, expiry in list(self._cancelled_ids.items()):
            if expiry <= now:
                del self._cancelled_ids[request_id]
        for ticket in list(self._tickets.values()):
            expired = ticket.lease_until is not None and ticket.lease_until <= now
            if ticket.done:
                if expired or now - ticket.created > self.max_wait + 300:
                    self._tickets.pop(ticket.request_id, None)
                continue
            if ticket.is_disconnected is not None and ticket.is_disconnected():
                self._cancel_locked(ticket)
            elif expired:
                self._cancel_locked(ticket, "Your turn ended because you left Marvin. Come back and try again.", "lease_expired")
            elif ticket.status == "waiting" and now - ticket.created >= self.max_wait:
                self._cancel_locked(ticket, "Marvin's taking a while. Please try again in a moment.", "queue_expired")

    def submit(self, request_id, payload, leased=True, allow_wait=True, is_disconnected=None):
        with self._condition:
            self._expire_locked()
            if self._closed:
                raise AdmissionError("Marvin is restarting. Give him a moment.", 503, "unavailable")
            if request_id in self._cancelled_ids:
                raise AdmissionError("This request was cancelled. Send a new message when you're ready.", 409, "cancelled")
            if request_id in self._tickets:
                raise AdmissionError("That request is already with Marvin.", 409, "duplicate_request")
            occupied = self._active is not None or self._legacy
            if occupied and (not allow_wait or len(self._waiting) >= self.capacity):
                raise AdmissionError("Marvin's got a little crowd. Try again shortly.")
            now = self.clock()
            ticket = Ticket(request_id, payload, now, now + self.lease_seconds if leased else None, is_disconnected)
            self._tickets[request_id] = ticket
            if occupied:
                self._waiting.append(ticket)
                self._positions_locked()
            else:
                ticket.status = "starting"
                self._active = ticket
            self._start_locked()
            self._condition.notify_all()
            return ticket

    def keepalive(self, request_id):
        with self._condition:
            self._expire_locked()
            ticket = self._tickets.get(request_id)
            if ticket is None or ticket.cancelled or ticket.done:
                return False
            if ticket.lease_until is not None:
                ticket.lease_until = self.clock() + self.lease_seconds
            return True

    def cancel(self, request_id):
        with self._condition:
            # A pagehide beacon can overtake the original POST on the network.
            # Remember it even before admission, so that POST cannot start work.
            self._remember_cancelled_locked(request_id)
            ticket = self._tickets.get(request_id)
            if ticket is not None:
                self._cancel_locked(ticket)
            self._condition.notify_all()

    def checkpoint(self, ticket):
        with self._condition:
            self._expire_locked()
            if ticket.cancelled or ticket.done or self._closed:
                raise RequestCancelled()

    def emit(self, ticket, event):
        with self._condition:
            stalled_at = self.clock()
            while len(ticket.events) >= self.buffer_size:
                self.checkpoint(ticket)
                if self.clock() - stalled_at >= self.lease_seconds:
                    self._cancel_locked(ticket, "The connection to Marvin stopped. Please try again.", "connection_stalled")
                    raise RequestCancelled()
                self._condition.wait(0.25)
            self.checkpoint(ticket)
            ticket.events.append(event)
            self._condition.notify_all()

    def events(self, ticket):
        try:
            while True:
                with self._condition:
                    self._expire_locked()
                    if not ticket.events and not ticket.done and not ticket.cancelled:
                        self._condition.wait(2)
                        self._expire_locked()
                    if ticket.events:
                        event = ticket.events.popleft()
                        self._condition.notify_all()
                    elif ticket.done or ticket.cancelled:
                        break
                    else:
                        event = None  # An SSE heartbeat notices broken sockets.
                yield event
        finally:
            self.cancel(ticket.request_id)
            with self._condition:
                if ticket.done:
                    self._tickets.pop(ticket.request_id, None)

    def _promote_locked(self):
        self._expire_locked()
        if self._active is None and not self._legacy and self._waiting:
            self._active = self._waiting.popleft()
            self._active.events.clear()
            self._active.status = "starting"
            self._positions_locked()

    def run_once(self):
        """Run one reserved job; also permits deterministic tests without threads."""
        with self._condition:
            self._expire_locked()
            ticket = self._active
            if ticket is None or ticket.status != "starting":
                return False
            ticket.status = "running"
        locked = False
        try:
            self.checkpoint(ticket)
            locked = self.inference_lock.acquire(blocking=False)
            if not locked:
                raise RuntimeError("Inference admission lost its exclusive lock")
            self.runner(ticket, self)
        except RequestCancelled:
            pass
        except Exception:
            logging.exception("Diffusion generation failed")
            try:
                self.emit(ticket, {"type": "error", "error": "Generation failed. Please try again."})
            except RequestCancelled:
                pass
        finally:
            if locked:
                self.inference_lock.release()
            with self._condition:
                ticket.done = True
                ticket.payload = None
                self._active = None
                self._promote_locked()
                self._condition.notify_all()
        return True

    def _work(self):
        while True:
            with self._condition:
                self._expire_locked()
                if self._closed:
                    return
                if self._active is None:
                    self._condition.wait(0.5)
                    continue
            self.run_once()

    def acquire_legacy(self):
        with self._condition:
            self._expire_locked()
            if self._closed or self._active is not None or self._waiting or self._legacy:
                return False
            if not self.inference_lock.acquire(blocking=False):
                return False
            self._legacy = True
            return True

    def release_legacy(self):
        with self._condition:
            self.inference_lock.release()
            self._legacy = False
            self._promote_locked()
            self._condition.notify_all()

    def snapshot(self):
        with self._condition:
            self._expire_locked()
            return {"active": self._active is not None or self._legacy,
                    "waiting": len(self._waiting), "capacity": self.capacity,
                    "lease_seconds": self.lease_seconds}

    def close(self):
        with self._condition:
            self._closed = True
            for ticket in list(self._tickets.values()):
                self._cancel_locked(ticket)
            self._condition.notify_all()
        if self._thread:
            self._thread.join(timeout=5)
