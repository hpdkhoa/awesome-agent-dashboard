"""F10 disk and resource check (plan bf73af63): under the limit the run waits with the number; above it, it starts."""
from agent_bridge.resources import low
from test_runs import cmd, setup


def reading(disk=50.0, ram=8.0, gpu=2.0, lim=(5, 2, 0)):
    return {"disks": [{"drive": "K:\\", "freeGB": disk, "totalGB": 931.5}], "ramGB": ram, "ramTotalGB": 31.8,
            "gpus": [{"name": "GTX 1060", "freeGB": gpu, "totalGB": 3.0}],
            "limits": {"diskGB": lim[0], "ramGB": lim[1], "gpuGB": lim[2]}}


def test_low_names_each_reading_under_its_limit_with_its_number():
    assert low(reading()) == []
    assert low(reading(disk=3.1)) == ["disk K:\\ 3.1 GB free, limit 5 GB"]
    assert low(reading(ram=1.5, gpu=0.4, lim=(5, 2, 1))) == ["RAM 1.5 GB free, limit 2 GB", "GPU GTX 1060 0.4 GB free, limit 1 GB"]
    assert low(reading(disk=0.1, ram=0.1, gpu=0.0, lim=(0, 0, 0))) == []  # 0 turns a check off


def test_low_disk_blocks_the_run_with_the_number_then_it_starts(tmp_path, monkeypatch):
    store, runs, work = setup(tmp_path, monkeypatch)
    monkeypatch.setenv("AAD_MIN_DISK_GB", "1000000")
    cmd(store, "c1", action="start", folder=str(work), prompt="hello")
    runs.step()
    c = store.get("commands/c1")
    assert c["status"] == "waiting" and c["waitReason"] == "resources" and "pid" not in c
    assert c["resources"]["low"][0].startswith("disk ") and "limit 1000000 GB" in c["resources"]["low"][0]
    runs.step()
    assert store.get("commands/c1")["status"] == "waiting"
    monkeypatch.setenv("AAD_MIN_DISK_GB", "0.001")
    runs.step()
    c = store.get("commands/c1")
    assert c["status"] == "running" and c["resources"]["low"] == []
