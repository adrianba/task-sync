/**
 * Obsidian **Tasks**-plugin field grammar: a pure module that parses the inline
 * metadata of a single task line (emoji signifiers and Dataview `[key:: value]`
 * fields) and serializes targeted edits back onto a line.
 *
 * Document *structure* (which lines are real tasks, what is inside a code fence,
 * etc.) is handled by `document.ts` via remark — this module only deals with the
 * task line's text, mirroring the Tasks plugin's right-to-left metadata strip.
 */
import type {
  TaskFields,
  TaskPriority,
  TaskStatus,
} from "../model/task.js";
import { extractSyncId } from "./syncId.js";

/** Recognizes a checkbox list item and captures the status char + body. */
export const TASK_LINE = /^([\s\t>]*)([-*+]|[0-9]+[.)]) +\[(.)\] *(.*)$/u;

const DATE = String.raw`(\d{4}-\d{2}-\d{2})`;

function dataviewField(key: string, value: string): RegExp {
  return new RegExp(
    String.raw`(?:\[|\() *${key} *:: *${value} *(?:\]|\)),?\s*$`,
    "u",
  );
}

interface FieldRegexes {
  emoji: RegExp;
  dataview: RegExp;
}

const FIELDS: Record<string, FieldRegexes> = {
  due: {
    emoji: new RegExp(String.raw`(?:📅|📆|🗓)\uFE0F? *${DATE}\s*$`, "u"),
    dataview: dataviewField("due", DATE),
  },
  scheduled: {
    emoji: new RegExp(String.raw`(?:⏳|⌛)\uFE0F? *${DATE}\s*$`, "u"),
    dataview: dataviewField("scheduled", DATE),
  },
  start: {
    emoji: new RegExp(String.raw`🛫\uFE0F? *${DATE}\s*$`, "u"),
    dataview: dataviewField("start", DATE),
  },
  created: {
    emoji: new RegExp(String.raw`➕\uFE0F? *${DATE}\s*$`, "u"),
    dataview: dataviewField("created", DATE),
  },
  done: {
    emoji: new RegExp(String.raw`✅\uFE0F? *${DATE}\s*$`, "u"),
    dataview: dataviewField("completion", DATE),
  },
  cancelled: {
    emoji: new RegExp(String.raw`❌\uFE0F? *${DATE}\s*$`, "u"),
    dataview: dataviewField("cancelled", DATE),
  },
  recurrence: {
    emoji: /🔁\uFE0F? *([a-zA-Z0-9, !]+?)\s*$/u,
    dataview: dataviewField("repeat", String.raw`([a-zA-Z0-9, !]+?)`),
  },
  tasksId: {
    emoji: /🆔\uFE0F? *([a-zA-Z0-9-_]+)\s*$/u,
    dataview: dataviewField("id", String.raw`([a-zA-Z0-9-_]+)`),
  },
  dependsOn: {
    emoji: /⛔\uFE0F? *([a-zA-Z0-9-_]+(?: *, *[a-zA-Z0-9-_]+)*)\s*$/u,
    dataview: dataviewField(
      "dependsOn",
      String.raw`([a-zA-Z0-9-_]+(?: *, *[a-zA-Z0-9-_]+)*)`,
    ),
  },
};

const DATE_FIELDS = new Set([
  "due",
  "scheduled",
  "start",
  "created",
  "done",
  "cancelled",
]);

const PRIORITY_EMOJI: Record<string, TaskPriority> = {
  "🔺": "highest",
  "⏫": "high",
  "🔼": "medium",
  "🔽": "low",
  "⏬": "lowest",
};
const PRIORITY_EMOJI_REGEX = /(🔺|⏫|🔼|🔽|⏬)\uFE0F?\s*$/u;
const PRIORITY_DATAVIEW = dataviewField(
  "priority",
  String.raw`(highest|high|medium|low|lowest)`,
);

const TAG_FROM_END = /(?:^|\s)(#[^ !@#$%^&*(),.?":{}|<>]+)\s*$/u;
const BLOCK_REF = /\s+(\^[a-zA-Z0-9-]+)\s*$/u;

// ReDoS note: a few field regexes above (e.g. TASK_LINE's `[\s\t>]* +`, the
// recurrence/repeat patterns' lazy `+?` followed by `\s*$`) contain overlapping
// quantifiers. Worst-case backtracking is polynomial, not exponential, and all
// of these only ever run against a single task line (bounded length), so the
// practical CPU exposure is negligible. Kept as-is intentionally.

export function statusCharToStatus(ch: string): TaskStatus {
  switch (ch) {
    case "x":
    case "X":
      return "done";
    case "/":
      return "in-progress";
    case "-":
      return "cancelled";
    case " ":
      return "todo";
    default:
      return "other";
  }
}

export function statusToChar(status: TaskStatus, fallback = " "): string {
  switch (status) {
    case "done":
      return "x";
    case "in-progress":
      return "/";
    case "cancelled":
      return "-";
    case "todo":
      return " ";
    default:
      return fallback;
  }
}

export interface ParsedBody {
  description: string;
  tags: string[];
  fields: TaskFields;
  syncId?: string;
}

/** Parse the body (text after the checkbox) of a task line. Pure. */
export function parseBody(body: string): ParsedBody {
  const fields: TaskFields = {};
  const tags: string[] = [];

  const sync = extractSyncId(body);
  let line = sync.rest;

  // Keep a trailing block reference out of metadata stripping.
  line = line.replace(BLOCK_REF, "");

  // Iteratively strip recognized metadata and trailing tags from the end,
  // mirroring the Tasks plugin (stops at the first unrecognized trailing text).
  for (let i = 0; i < 40; i++) {
    const tag = line.match(TAG_FROM_END);
    if (tag?.[1] && tag.index !== undefined) {
      tags.unshift(tag[1].slice(1));
      line = line
        .slice(0, tag.index + (tag[0].length - tag[1].length))
        .replace(/\s+$/u, "");
      continue;
    }

    let matched = false;
    for (const [name, rx] of Object.entries(FIELDS)) {
      const m = line.match(rx.emoji) ?? line.match(rx.dataview);
      if (!m) continue;
      const value = (m[1] ?? "").trim();
      if (name === "dependsOn") {
        fields.dependsOn = value.split(",").map((s) => s.trim());
      } else if (name === "recurrence") {
        fields.recurrence = value;
      } else if (DATE_FIELDS.has(name)) {
        (fields as Record<string, string>)[name] = value;
      } else {
        (fields as Record<string, string>)[name] = value;
      }
      line = line.replace(m[0], "").replace(/\s+$/u, "");
      matched = true;
      break;
    }
    if (matched) continue;

    const prio = line.match(PRIORITY_EMOJI_REGEX) ?? line.match(PRIORITY_DATAVIEW);
    if (prio?.[1]) {
      const key = prio[1];
      fields.priority = PRIORITY_EMOJI[key] ?? (key as TaskPriority);
      line = line.replace(prio[0], "").replace(/\s+$/u, "");
      continue;
    }

    break;
  }

  // Remaining inline tags inside the description (not at the end).
  const inlineTags = line.match(/(?:^|\s)#[^ !@#$%^&*(),.?":{}|<>]+/gu) ?? [];
  for (const t of inlineTags) {
    const tag = t.trim().slice(1);
    if (!tags.includes(tag)) tags.push(tag);
  }

  const description = line.replace(/\s+/gu, " ").trim();
  return sync.syncId !== undefined
    ? { description, tags, fields, syncId: sync.syncId }
    : { description, tags, fields };
}

// ---------------------------------------------------------------------------
// Serialization helpers — pure line transforms used by the writer.
// ---------------------------------------------------------------------------

const CHECKBOX = /^(\s*(?:[-*+]|[0-9]+[.)]) +\[)(.)(\].*)$/u;
const DONE_EMOJI = /✅\uFE0F? *\d{4}-\d{2}-\d{2}/u;
const DUE_EMOJI = /(?:📅|📆|🗓)\uFE0F? *\d{4}-\d{2}-\d{2}/u;
const BLOCK_REF_END = /(\s+\^[a-zA-Z0-9-]+)\s*$/u;

export function setStatusChar(line: string, ch: string): string {
  const m = line.match(CHECKBOX);
  if (!m) return line;
  if (m[2] === ch) return line;
  return `${m[1]}${ch}${m[3]}`;
}

function appendBeforeBlockRef(line: string, insert: string): string {
  const m = line.match(BLOCK_REF_END);
  if (m && m.index !== undefined) {
    return `${line.slice(0, m.index)}${insert}${line.slice(m.index)}`;
  }
  return `${line.replace(/\s+$/u, "")}${insert}`;
}

export function ensureDoneDate(line: string, date: string): string {
  if (DONE_EMOJI.test(line)) return line.replace(DONE_EMOJI, `✅ ${date}`);
  return appendBeforeBlockRef(line, ` ✅ ${date}`);
}

export function removeDoneDate(line: string): string {
  return line.replace(new RegExp(`\\s*${DONE_EMOJI.source}`, "u"), "");
}

export function setDueDate(line: string, date: string): string {
  if (DUE_EMOJI.test(line)) return line.replace(DUE_EMOJI, `📅 ${date}`);
  return appendBeforeBlockRef(line, ` 📅 ${date}`);
}
