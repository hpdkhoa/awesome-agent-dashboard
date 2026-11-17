// The board's Materials list: the session's list plus the files the reports point to, newest version of each
// (the owner's pick "Cả hai", 2026-11-17). Pure; no emulator needed.
import { describe, expect, it } from "vitest";
import { boardMaterials, family, fileRefs, gathered } from "../web/src/materials";
import type { InboxItem, PlanStep, StepEvidence } from "../web/src/data";

const CWD = "K:\\Projects\\story";
const step = (reply: string, report?: object) =>
  ({ id: "p_s1", planId: "p", stepId: "s1", state: "done", updatedAt: "", versions: [{ n: 1, state: "done", reply, at: "a", planVersion: 1, report }] }) as PlanStep;

describe("materials", () => {
  it("finds links and code paths, not fenced code or web links", () => {
    expect(fileRefs("[map](<map/a-v1.svg>) `the-gioi-v2.md` [web](https://x.io/a.md)\n```\n`b.md`\n```")).toEqual(["map/a-v1.svg", "the-gioi-v2.md"]);
  });

  it("families drop the -vN ending", () => {
    expect(family({ name: "x", path: "K:\\a\\the-gioi-v3.md" })).toEqual(["k:/a|the-gioi.md", 3]);
    expect(family({ name: "Tư liệu #19" })).toEqual(["|tư liệu #19", 0]);
  });

  it("gathers from step reports, the newest evidence set and results, full paths, once each", () => {
    const ev = [{ id: "e", planId: "p", stepId: "s1", sets: [{ pictures: ["K:\\Projects\\story\\shot-v2.png"] }, { pictures: ["K:\\old.png"] }] }] as StepEvidence[];
    const res = [{ kind: "result", cwd: CWD, files: ["out/r.png"], text: "see `the-gioi-v1.md`", createdAt: "1" },
      { kind: "question", cwd: CWD, files: ["q.png"], text: "", createdAt: "2" }] as unknown as InboxItem[];
    const got = gathered(CWD, [step("done: `the-gioi-v1.md`", { built: ["[map](<map/so-do-v1.svg>)"] })], ev, res);
    expect(got).toEqual(["K:\\Projects\\story\\the-gioi-v1.md", "K:\\Projects\\story\\map\\so-do-v1.svg",
      "K:\\Projects\\story\\shot-v2.png", "K:\\Projects\\story\\out\\r.png"]);
  });

  it("keeps the newest of each family; a gathered newer file keeps the session's kind and note, labelled auto", () => {
    const listed = [{ name: "Thế giới quan", path: `${CWD}\\the-gioi-v1.md`, kind: "story" as const, note: "s3" },
      { name: "Tư liệu #19", kind: "material" as const }];
    const out = boardMaterials(listed, [`${CWD}\\the-gioi-v2.md`, `${CWD}\\map\\so-do-v1.svg`, `${CWD}\\map\\so-do-v3.svg`]);
    expect(out).toEqual([
      { name: "the-gioi-v2.md", path: `${CWD}\\the-gioi-v2.md`, kind: "story", note: "s3", auto: true },
      { name: "Tư liệu #19", kind: "material" },
      { name: "so-do-v3.svg", path: `${CWD}\\map\\so-do-v3.svg`, kind: "file", auto: true },
    ]);
  });

  it("the same version: the session's entry wins, not labelled auto", () => {
    const listed = [{ name: "Thế giới quan", path: `${CWD}\\the-gioi-v1.md`, kind: "story" as const }];
    expect(boardMaterials(listed, [`${CWD}\\the-gioi-v1.md`])).toEqual(listed);
  });
});
