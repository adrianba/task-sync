import { describe, it, expect } from "vitest";
import { parseTasks } from "../src/vault/document.js";
import { parseBody, statusToChar, statusCharToStatus } from "../src/vault/taskMeta.js";

describe("vault/document parseTasks", () => {
  it("parses emoji-notation tasks with status, tags, due and priority", () => {
    const md = "- [ ] Audit pages #work #website ⏫ 📅 2026-07-10\n";
    const tasks = parseTasks(md, "Note.md");
    expect(tasks).toHaveLength(1);
    const t = tasks[0]!;
    expect(t.status).toBe("todo");
    expect(t.description).toBe("Audit pages");
    expect(t.tags).toEqual(["work", "website"]);
    expect(t.fields.due).toBe("2026-07-10");
    expect(t.fields.priority).toBe("high");
    expect(t.location.line).toBe(0);
  });

  it("parses Dataview-notation fields", () => {
    const md = "- [ ] Order filters #home [due:: 2026-06-30] [priority:: high]\n";
    const t = parseTasks(md, "Home.md")[0]!;
    expect(t.fields.due).toBe("2026-06-30");
    expect(t.fields.priority).toBe("high");
    expect(t.tags).toEqual(["home"]);
  });

  it("recognizes all status characters", () => {
    const md = [
      "- [ ] todo",
      "- [/] in progress",
      "- [x] done ✅ 2026-06-12",
      "- [X] also done",
      "- [-] cancelled",
    ].join("\n");
    const statuses = parseTasks(md, "S.md").map((t) => t.status);
    expect(statuses).toEqual(["todo", "in-progress", "done", "done", "cancelled"]);
  });

  it("reads an existing sync-id comment and strips it from the description", () => {
    const md = "- [ ] Build lib #work <!-- sync-id: abc123 -->\n";
    const t = parseTasks(md, "W.md")[0]!;
    expect(t.syncId).toBe("abc123");
    expect(t.description).toBe("Build lib");
  });

  it("ignores tasks inside fenced code blocks", () => {
    const md = "- [ ] real\n\n```\n- [ ] fake\n```\n\n~~~\n- [ ] also fake\n~~~\n";
    const tasks = parseTasks(md, "C.md");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.description).toBe("real");
  });

  it("parses nested list items as separate tasks", () => {
    const md = "- [ ] parent #p\n    - [ ] child #c\n";
    const tasks = parseTasks(md, "N.md");
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.description)).toEqual(["parent", "child"]);
  });

  it("does not treat non-checkbox list items as tasks", () => {
    const md = "- just a bullet\n- [ ] a task\n";
    const tasks = parseTasks(md, "B.md");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.description).toBe("a task");
  });
});

describe("vault/taskMeta", () => {
  it("status char mapping round-trips", () => {
    expect(statusCharToStatus(statusToChar("done"))).toBe("done");
    expect(statusCharToStatus(statusToChar("in-progress"))).toBe("in-progress");
    expect(statusCharToStatus(statusToChar("cancelled"))).toBe("cancelled");
    expect(statusCharToStatus(statusToChar("todo"))).toBe("todo");
  });

  it("parseBody captures start, scheduled, recurrence and dependsOn", () => {
    const body = "Task 🛫 2026-01-01 ⏳ 2026-01-02 🔁 every week ⛔ a1, b2";
    const parsed = parseBody(body);
    expect(parsed.fields.start).toBe("2026-01-01");
    expect(parsed.fields.scheduled).toBe("2026-01-02");
    expect(parsed.fields.recurrence).toBe("every week");
    expect(parsed.fields.dependsOn).toEqual(["a1", "b2"]);
  });

  it("does not confuse the Tasks 🆔 field with our sync id", () => {
    const parsed = parseBody("Thing 🆔 native123");
    expect(parsed.fields.tasksId).toBe("native123");
    expect(parsed.syncId).toBeUndefined();
  });
});
