"""The archiver hand-off (the owner's flow, 2026-11-06): after 1 minute of waiting for a session open in the app, ask
the archiver; archived, the bridge sends; then unarchive. Refused sessions are never asked again."""

import threading
import time

from agent_bridge.archiver import Archiver, Hand


def test_the_flow_ask_archive_send_unarchive(tmp_path):
    bridge, hand = Archiver(tmp_path), Hand(tmp_path, "archiver-sid")
    assert not bridge.maybe_ask("c1", "s1", "K:/w", time.time() - 120, "x")  # no archiver alive yet: nothing asked
    hand.take(0)  # the archiver starts waiting
    assert not bridge.maybe_ask("c1", "s1", "K:/w", time.time() - 30, "x")  # under 1 minute
    assert bridge.maybe_ask("c1", "s1", "K:/w", time.time() - 61, "x") and bridge.of("c1") == "asked"
    assert not bridge.maybe_ask("c1", "s1", "K:/w", time.time() - 300, "x")  # once per message
    ask = hand.take(1, poll=0.05)
    assert ask["action"] == "archive" and ask["sessionId"] == "s1" and ask["cwd"] == "K:/w"
    hand.report("c1", "archive", True, app_session="local_s1")
    assert bridge.collect() == [("c1", "archived", "")]
    bridge.ask_unarchive("c1")
    ask = hand.take(1, poll=0.05)
    assert ask["action"] == "unarchive" and ask["appSession"] == "local_s1" and bridge.of("c1") == "unarchiving"
    hand.report("c1", "unarchive", True)
    assert bridge.collect() == [("c1", "done", "")]
    assert hand.take(0) is None and Archiver(tmp_path).of("c1") == "done"  # the state survives a bridge restart


def test_a_refused_session_is_not_asked_again_and_the_archiver_never_archives_itself(tmp_path):
    bridge, hand = Archiver(tmp_path), Hand(tmp_path, "me")
    hand.take(0)
    bridge.maybe_ask("c1", "s1", "K:/w", 0, "x")
    hand.take(1, poll=0.05)
    hand.report("c1", "archive", False, "pinned")
    assert bridge.collect() == [("c1", "refused", "pinned")] and not bridge.maybe_ask("c1", "s1", "K:/w", 0, "x")
    bridge.maybe_ask("c2", "me", "K:/w", 0, "x")
    assert hand.take(0.2, poll=0.05) is None  # its own session is answered "never", not handed out
    assert bridge.collect() == [("c2", "refused", "the archiver never archives itself")]


def test_take_blocks_until_an_ask_arrives(tmp_path):
    bridge, hand = Archiver(tmp_path), Hand(tmp_path)
    hand.take(0)
    got = []
    t = threading.Thread(target=lambda: got.append(hand.take(5, poll=0.05)))
    t.start()
    time.sleep(0.3)
    bridge.maybe_ask("c9", "s9", "K:/w", 0, "x")
    t.join(5)
    assert got and got[0]["cid"] == "c9"
