import { describe, expect, it } from "vitest";
import { decodeEmoji, encodeEmoji, truncateEncoded } from "../src/adapters/supernote/emoji.js";
import {
  inputToColumns,
  isoDateToMs,
  msToIsoDate,
  priorityFromImportance,
  priorityToImportance,
  rowToExternalTask,
  statusFromDb,
  statusToDb,
  type SupernoteTaskRow,
} from "../src/adapters/supernote/mapping.js";

describe("Supernote emoji encoding", () => {
  it("leaves BMP text unchanged", () => {
    expect(encodeEmoji("plain ASCII and café")).toBe("plain ASCII and café");
  });

  it("encodes and decodes a shopping cart emoji", () => {
    expect(encodeEmoji("Buy 🛒")).toBe("Buy [U+1F6D2]");
    expect(decodeEmoji("Buy [U+1F6D2]")).toBe("Buy 🛒");
  });

  it("round-trips multiple emoji", () => {
    const text = "Plan 🛒 then 🚀 and 😀";
    expect(decodeEmoji(encodeEmoji(text))).toBe(text);
  });

  it("leaves malformed encoded sequences alone", () => {
    expect(decodeEmoji("[U+] [U+XYZ] [U+110000] [U+D800]")).toBe(
      "[U+] [U+XYZ] [U+110000] [U+D800]",
    );
  });

  it("truncates after encoding without splitting a token", () => {
    expect(truncateEncoded("x🛒y", 5)).toBe("x");
    expect(truncateEncoded("x🛒y", 10)).toBe("x[U+1F6D2]");
    expect(truncateEncoded("abc", 2)).toBe("ab");
  });
});

describe("Supernote mapping", () => {
  it("maps status lossily", () => {
    expect(statusToDb("done")).toBe("completed");
    expect(statusToDb("in-progress")).toBe("needsAction");
    expect(statusFromDb({ status: "completed" })).toBe("done");
    expect(statusFromDb({ status: "needsAction" })).toBe("todo");
  });

  it("maps priorities to nullable importance strings", () => {
    expect(priorityToImportance("high")).toBe("4");
    expect(priorityToImportance("low")).toBe("2");
    expect(priorityToImportance("none")).toBeNull();
    expect(priorityFromImportance("4")).toBe("high");
    expect(priorityFromImportance(1)).toBe("lowest");
    expect(priorityFromImportance(null)).toBeUndefined();
  });

  it("converts millisecond timestamps and ISO dates in UTC", () => {
    expect(msToIsoDate(0)).toBeUndefined();
    expect(msToIsoDate(null)).toBeUndefined();
    expect(msToIsoDate(Date.UTC(2026, 5, 24, 23, 59, 59))).toBe("2026-06-24");
    expect(isoDateToMs("2026-06-24")).toBe(Date.UTC(2026, 5, 24));
  });

  it("maps a database row to an external inbox task", () => {
    const row: SupernoteTaskRow = {
      task_id: "abc123",
      task_list_id: null,
      title: "Buy [U+1F6D2]",
      status: "completed",
      due_time: Date.UTC(2026, 5, 25),
      completed_time: Date.UTC(2026, 5, 26),
      importance: "4",
      last_modified: Date.UTC(2026, 5, 27, 1, 2, 3),
      is_deleted: "N",
      links: "base64-link",
    };

    expect(rowToExternalTask(row)).toEqual({
      externalId: "abc123",
      listId: "",
      title: "Buy 🛒",
      status: "done",
      due: "2026-06-25",
      done: "2026-06-26",
      priority: "high",
      lastModified: "2026-06-27T01:02:03.000Z",
    });
  });

  it("maps inputs to encoded database columns", () => {
    expect(
      inputToColumns({
        title: "Buy 🛒",
        status: "done",
        due: "2026-06-25",
        done: "2026-06-26",
        priority: "high",
      }),
    ).toEqual({
      title: "Buy [U+1F6D2]",
      status: "completed",
      due_time: Date.UTC(2026, 5, 25),
      completed_time: Date.UTC(2026, 5, 26),
      importance: "4",
    });
    expect(inputToColumns({ status: "todo" })).toEqual({
      status: "needsAction",
      due_time: 0,
      completed_time: 0,
      importance: null,
    });
  });
});
