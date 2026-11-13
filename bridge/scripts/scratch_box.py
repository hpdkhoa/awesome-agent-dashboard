"""A scratch second box for the live check (tests/live.boxes.test.ts): the bridge's data API on an empty database in a
temporary folder, on 127.0.0.1:<port>. Any sign-in is accepted: it holds nothing and listens on this machine only.

    python scripts/scratch_box.py 8899
"""

import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent_bridge.dataapi import DataApi  # noqa: E402
from agent_bridge.files import Files, serve  # noqa: E402
from agent_bridge.localdb import LocalStore  # noqa: E402

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
folder = Path(tempfile.mkdtemp(prefix="aad-box2-"))
serve(Files([("scratch", str(folder))], lambda token: None), [], port, data=DataApi(LocalStore(folder / "data.sqlite")))
print(f"scratch box on 127.0.0.1:{port}, database {folder / 'data.sqlite'}", flush=True)
while True:
    time.sleep(3600)
