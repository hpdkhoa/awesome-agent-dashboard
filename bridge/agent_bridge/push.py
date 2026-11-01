"""Web Push to the owner's phone (the owner's choice, 2026-11-01: "do the web push"): a run that needs an approval,
and a run that ended.

The page subscribes once (Home Screen app on iOS 16.4+) and saves its push address to pushSubs/<id>. The bridge signs
each push with its own VAPID key, which never leaves this machine (the OS key store, or a user-only file); only the
public half goes to meta/push for the page. The message is encrypted for the phone, so the push service cannot read it.
A failed push never stops the bridge, and an address the push service no longer knows is removed.
"""

from __future__ import annotations

import json
import os

from .config import data_dir
from .redact import redact

KEY_USER = "vapid-private"
GONE = (404, 410)  # the push service no longer knows this address


def _store_key(pem: str) -> None:
    from .auth import SERVICE, _keyring

    kr = _keyring()
    if kr is not None:
        kr.set_password(SERVICE, KEY_USER, pem)
        return
    fd = os.open(os.path.join(data_dir(), "vapid.pem"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(pem)


def _load_key() -> str | None:
    from .auth import SERVICE, _keyring

    kr = _keyring()
    if kr is not None and (pem := kr.get_password(SERVICE, KEY_USER)):
        return pem
    try:
        with open(os.path.join(data_dir(), "vapid.pem")) as f:
            return f.read() or None
    except OSError:
        return None


def public_key(pem: str) -> str:
    """The application server key the page subscribes with: the public point, uncompressed, base64url."""
    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid02
    from py_vapid.utils import b64urlencode

    raw = Vapid02.from_pem(pem.encode()).public_key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return b64urlencode(raw)


def setup(store) -> str:
    """Makes the key once (kept on later runs) and publishes its public half. Returns the public key."""
    pem = _load_key()
    if not pem:
        from py_vapid import Vapid02

        v = Vapid02()
        v.generate_keys()
        pem = v.private_pem().decode()
        _store_key(pem)
    key = public_key(pem)
    store.put_many({"meta/push": {"publicKey": key}})
    return key


class Pusher:
    """Sends one notification to every subscribed device. `send` is injectable for tests."""

    def __init__(self, store, subject: str, send=None):
        self.store, self.subject, self._send = store, subject, send

    def notify(self, title: str, body: str, url: str = "/", tag: str = "") -> int:
        """Returns how many devices took it. Never raises."""
        try:
            subs = self.store.where("pushSubs", "kind", "webpush")
        except Exception:
            return 0
        if not subs:
            return 0
        send = self._send or self._webpush()
        if send is None:
            return 0
        data = json.dumps({"title": redact(title, 120), "body": redact(body, 300), "url": url, "tag": tag})
        ok = 0
        for s in subs:
            try:
                status = send({"endpoint": s["endpoint"], "keys": s["keys"]}, data)
            except Exception:
                continue
            if status in GONE:
                try:
                    self.store.delete(f"pushSubs/{s['id']}")
                except Exception:
                    pass
            elif status is not None and 200 <= status < 300:
                ok += 1
        return ok

    def _webpush(self):
        pem = _load_key()
        if not pem or not self.subject:
            return None
        from py_vapid import Vapid02
        from pywebpush import WebPushException, webpush

        vapid = Vapid02.from_pem(pem.encode())

        def send(sub: dict, data: str) -> int | None:
            try:
                r = webpush(sub, data, vapid_private_key=vapid, vapid_claims={"sub": self.subject}, ttl=3600, timeout=10)
                return getattr(r, "status_code", 201)
            except WebPushException as e:
                return getattr(e.response, "status_code", None)

        return send


def pusher(store, owner_email: str) -> Pusher:
    return Pusher(store, f"mailto:{owner_email}" if owner_email else "")
