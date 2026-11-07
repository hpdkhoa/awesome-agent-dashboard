import json
import urllib.error
import urllib.request

import pytest

from agent_bridge.files import Files, clean, kind_of, serve


def verify(token):
    if token != "owner":
        raise PermissionError("not the owner")


@pytest.fixture
def site(tmp_path):
    root = tmp_path / "work"
    (root / "web" / "img").mkdir(parents=True)
    (root / "web" / "page.html").write_text('<img src="img/a.png">', encoding="utf-8")
    (root / "web" / "img" / "a.png").write_bytes(b"\x89PNG data")
    (root / ".env").write_text("KEY=1")
    (tmp_path / "outside.txt").write_text("no")
    now = [1000.0]
    files = Files([("work", str(root))], verify, clock=lambda: now[0])
    srv = serve(files, ["https://agent.example.com"], 0)
    yield f"http://127.0.0.1:{srv.server_address[1]}", root, now
    srv.shutdown()


def call(base, path, body=None, token="owner", origin="https://agent.example.com"):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {token}", "Origin": origin,
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def test_paths_as_sessions_write_them():
    assert clean("`web/a.html:42`") == "web/a.html"
    assert clean("file:///K:/x/a%20b.png") == "K:/x/a b.png"
    assert clean("K:\statements\10.pdf") == "K:\statements\10.pdf"
    assert clean("docs/a.md#part") == "docs/a.md"
    assert kind_of("a.PNG") == "image" and kind_of("a.html") == "html" and kind_of("a.bin") == "file"


def test_ticket_serves_the_page_and_its_own_images(site):
    base, root, _ = site
    st, h, body = call(base, "/ticket", {"path": "web/page.html", "cwd": str(root)})
    assert st == 200 and h["Access-Control-Allow-Origin"] == "https://agent.example.com"
    t = json.loads(body)
    assert t["kind"] == "html" and t["path"] == "web/page.html"
    st, h, body = call(base, t["url"])
    assert st == 200 and body.startswith(b"<img") and "sandbox" in h["Content-Security-Policy"]
    assert h["Cache-Control"] == "private, no-store" and h["Referrer-Policy"] == "no-referrer"
    img = t["url"].rsplit("/", 1)[0] + "/img/a.png"  # the page's relative image, through the same ticket
    st, h, body = call(base, img)
    assert st == 200 and body == b"\x89PNG data" and h["Content-Type"] == "image/png"


def test_refused(site):
    base, root, now = site
    assert call(base, "/ticket", {"path": "web/page.html", "cwd": str(root)}, token="someone")[0] == 401
    assert call(base, "/ticket", {"path": "../outside.txt", "cwd": str(root)})[0] == 400
    assert call(base, "/ticket", {"path": str(root.parent / "outside.txt"), "cwd": ""})[0] == 400
    assert call(base, "/ticket", {"path": ".env", "cwd": str(root)})[0] == 400
    assert call(base, "/ticket", {"path": "web/none.html", "cwd": str(root)})[0] == 404
    t = json.loads(call(base, "/ticket", {"path": "web/page.html", "cwd": str(root)})[2])
    escape = t["url"].rsplit("/", 2)[0] + "/../outside.txt"
    assert call(base, escape.replace("..", "%2e%2e"))[0] == 404
    assert call(base, t["url"].rsplit("/", 2)[0] + "/.env")[0] == 404
    assert call(base, "/t/madeup/web/page.html")[0] == 404
    _, h, _ = call(base, "/ticket", {"path": "web/page.html", "cwd": str(root)}, origin="https://evil.example")
    assert "Access-Control-Allow-Origin" not in h
    now[0] += 601  # a ticket lasts 10 minutes
    assert call(base, t["url"])[0] == 404


def test_download_sends_the_file_as_an_attachment(site):
    base, root, _ = site
    t = json.loads(call(base, "/ticket", {"path": "web/page.html", "cwd": str(root)})[2])
    st, h, body = call(base, t["url"] + "?download=1")
    assert st == 200 and body.startswith(b"<img")
    assert h["Content-Disposition"] == "attachment; filename=\"page.html\"; filename*=UTF-8''page.html"
    assert "Content-Disposition" not in call(base, t["url"])[1]  # the viewer itself still shows it inline
