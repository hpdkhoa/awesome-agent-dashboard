// Step i8: the page's tick hash is the bridge's (stepcheck.py check_hash), so a tick made here lets the bridge run it.
import { describe, expect, it } from "vitest";
import { checkHash } from "../web/src/harness";

describe("step check tick", () => {
  it("hashes like the bridge and changes with the command", () => {
    expect(checkHash("npm test")).toBe("f95edee8");
    expect(checkHash("npm test -- --bail")).not.toBe("f95edee8");
  });
});
