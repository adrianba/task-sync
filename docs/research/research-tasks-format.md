# Obsidian Tasks Format — Parsing Spec

*Researched from the authoritative source: [obsidian-tasks-group/obsidian-tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) (commit `0c32a11`) and the official published docs at [publish.obsidian.md/tasks](https://publish.obsidian.md/tasks/).*

---

## 1. Task-Line Grammar

### 1.1 What Makes a Line a Task

A task is a list item whose checkbox captures **exactly one character** between `[` and `]`. The canonical regex from the source (verbatim):

```
// src/Task/TaskRegularExpressions.ts
indentationRegex  = /^([\s\t>]*)/
listMarkerRegex   = /([-*+]|[0-9]+[.)])/
checkboxRegex     = /\[(.)\]/u
afterCheckboxRegex = / *(.*)/u

taskRegex = indentation + listMarker + ' +' + checkbox + afterCheckbox
         = /^([\s\t>]*)([-*+]|[0-9]+[.)]) +\[(.)\] *(.*)/u
```

**Annotated grammar:**

```
^                       start of line (no ^ in the regex itself; applied per-line)
([\s\t>]*)              Group 1: indentation — zero or more of: space, tab, >
([-*+]|[0-9]+[.)])      Group 2: list marker — hyphen, asterisk, plus, OR 1+ digits followed by . or )
[ ]+                    one or more spaces between marker and checkbox
\[                      literal [
(.)                     Group 3: status character — exactly ONE unicode code point
\]                      literal ]
[ ]*                    zero or more spaces after checkbox
(.*)                    Group 4: the rest — description + metadata + block link
```

**Valid list markers:**

| Marker | Example | Notes |
|---|---|---|
| `-` | `- [ ] task` | Most common |
| `*` | `* [ ] task` | Supported since Tasks 1.0 |
| `+` | `+ [ ] task` | Supported since Tasks 4.5.0 |
| `N.` | `1. [ ] task` | Numbered, dot separator (Tasks 1.20.0+) |
| `N)` | `2) [ ] task` | Numbered, paren separator (Tasks 7.18.5+) |

**Key rules:**
- At least **one space** is required between the list marker and `[`.
- Zero or more spaces after `]` before the description.
- The **indentation** group (`[\s\t>]*`) also captures `>` characters, which is how tasks inside blockquotes and callouts are handled.
- The regex is **per-line**; the plugin reads files line-by-line, so multi-line items are not supported.

### 1.2 Block Link at End of Line

```
blockLinkRegex = / \^[a-zA-Z0-9-]+$/u
```

A block reference identifier: a space, then `^`, then alphanumeric + hyphens. It must be **the very last thing** on the line (after all metadata).

---

## 2. Status Character Model

### 2.1 Built-in Core Statuses

The two core statuses require no CSS theming:

| Symbol (in `[]`) | Status Name | StatusType | Next Symbol | `done` filter |
|---|---|---|---|---|
| ` ` (space) | Todo | `TODO` | `x` | `not done` |
| `x` | Done | `DONE` | ` ` | `done` |

**`[X]` (capital X) is also parsed as DONE** — see `Status.getTypeForUnknownSymbol()` in `Status.ts`.

### 2.2 Built-in Custom Statuses (default in settings)

| Symbol | Status Name | StatusType | Next Symbol | Needs CSS? |
|---|---|---|---|---|
| `/` | In Progress | `IN_PROGRESS` | `x` | Yes |
| `-` | Cancelled | `CANCELLED` | ` ` | Yes |

### 2.3 StatusType Enum

There are **7** status types (`src/Statuses/StatusConfiguration.ts`):

```typescript
export enum StatusType {
    TODO        = 'TODO',
    DONE        = 'DONE',
    IN_PROGRESS = 'IN_PROGRESS',
    ON_HOLD     = 'ON_HOLD',        // introduced Tasks 7.23.0
    CANCELLED   = 'CANCELLED',
    NON_TASK    = 'NON_TASK',
    EMPTY       = 'EMPTY',          // internal sentinel
}
```

### 2.4 Status Type Behaviours

| StatusType | Matches `done` | Matches `not done` | Gets done-date on toggle | Creates recurrence |
|---|---|---|---|---|
| TODO | No | **Yes** | No | No |
| IN_PROGRESS | No | **Yes** | No | No |
| ON_HOLD | No | **Yes** | No | No |
| DONE | **Yes** | No | **Yes** | **Yes** |
| CANCELLED | **Yes** | No | No | No |
| NON_TASK | **Yes** | No | No | No |

### 2.5 Unknown/Custom Status Fallback

For any symbol not in the registry:

```typescript
// Status.ts: getTypeForUnknownSymbol()
switch (symbol) {
    case 'x': case 'X': return StatusType.DONE;
    case '/':           return StatusType.IN_PROGRESS;
    case '-':           return StatusType.CANCELLED;
    case '':            return StatusType.EMPTY;
    case ' ': default:  return StatusType.TODO;   // any unrecognized → TODO
}
```

So `[?]`, `[>]`, `[!]`, `[h]`, etc., all default to `TODO` type unless explicitly configured in Settings.

### 2.6 Common Example Statuses (from themes/community collections)

```
- [ ] Todo (standard)
- [x] Done (standard)
- [X] Done (alt — also recognized as DONE)
- [/] In Progress (default custom)
- [-] Cancelled (default custom)
- [?] Question (custom, typically TODO type)
- [>] Forwarded (custom, typically TODO type)
- [!] Important (custom, typically TODO type)
- [h] On Hold (example custom ON_HOLD)
```

---

## 3. Metadata Fields: Complete Reference

### 3.1 Parsing Algorithm Overview

Parsing is performed by `DefaultTaskSerializer.deserialize()` (`src/TaskSerializer/DefaultTaskSerializer.ts`). It works **right-to-left**, matching and stripping fields from the end of the line in a loop:

```
state.line = full text after checkbox
loop (max 20 iterations):
    state.matched = false
    try to match each field regex against state.line (all regexes end with $)
    if matched: strip that field from state.line, state.matched = true
    also strip trailing tags (saved separately, re-added to description later)
    also strip id and dependsOn
until state.matched is false OR 20 runs exceeded
```

**Critical consequence:** parsing stops as soon as there is unrecognized text at the end. Any arbitrary text placed *after* metadata will prevent that metadata from being read.

### 3.2 Field Regex Details (Emoji Format)

All regexes from `DEFAULT_SYMBOLS.TaskFormatRegularExpressions`:

```typescript
// Note: \uFE0F? allows optional Variation Selector-16 on emojis
// All regexes end with $ (matched from end of string)

priorityRegex     = /(🔺|⏫|🔼|🔽|⏬)\uFE0F?$/
startDateRegex    = /🛫\uFE0F? *(\d{4}-\d{2}-\d{2})$/
createdDateRegex  = /➕\uFE0F? *(\d{4}-\d{2}-\d{2})$/
scheduledDateRegex= /(?:⏳|⌛)\uFE0F? *(\d{4}-\d{2}-\d{2})$/   // ⌛ is an alias
dueDateRegex      = /(?:📅|📆|🗓)\uFE0F? *(\d{4}-\d{2}-\d{2})$/  // 📆,🗓 are aliases
doneDateRegex     = /✅\uFE0F? *(\d{4}-\d{2}-\d{2})$/
cancelledDateRegex= /❌\uFE0F? *(\d{4}-\d{2}-\d{2})$/
recurrenceRegex   = /🔁\uFE0F? *([a-zA-Z0-9, !]+)$/
onCompletionRegex = /🏁\uFE0F? *([a-zA-Z]+)$/
dependsOnRegex    = /⛔\uFE0F? *([a-zA-Z0-9-_]+( *, *[a-zA-Z0-9-_]+ *)*)$/
idRegex           = /🆔\uFE0F? *([a-zA-Z0-9-_]+)$/
```

### 3.3 Complete Field Table — Emoji Format

| Field | Emoji (written) | Alternate Emoji (read only) | Dataview Key | Value Format | Notes |
|---|---|---|---|---|---|
| Description | *(implicit)* | — | — | Free text | Everything not matched as metadata |
| Task ID | 🆔 | — | `id::` | `[a-zA-Z0-9-_]+` | Intended unique across vault |
| Depends On | ⛔ | — | `dependsOn::` | comma-sep IDs | e.g. `dcf64c,0h17ye` |
| Priority Highest | 🔺 | — | `priority:: highest` | (no value) | Highest = 0 |
| Priority High | ⏫ | — | `priority:: high` | (no value) | High = 1 |
| Priority Medium | 🔼 | — | `priority:: medium` | (no value) | Medium = 2 |
| Priority None | *(absent)* | — | *(absent)* | — | None = 3 (default) |
| Priority Low | 🔽 | — | `priority:: low` | (no value) | Low = 4 |
| Priority Lowest | ⏬️ | — | `priority:: lowest` | (no value) | Lowest = 5 |
| Recurrence | 🔁 | — | `repeat::` | `every ...` text | Must start with `every` |
| On Completion | 🏁 | — | `onCompletion::` | `keep` or `delete` | Default: `keep` (omitted) |
| Created Date | ➕ | — | `created::` | `YYYY-MM-DD` | |
| Start Date | 🛫 | — | `start::` | `YYYY-MM-DD` | |
| Scheduled Date | ⏳ | ⌛ | `scheduled::` | `YYYY-MM-DD` | ⌛ read but ⏳ written |
| Due Date | 📅 | 📆 🗓 | `due::` | `YYYY-MM-DD` | Aliases read, 📅 written |
| Cancelled Date | ❌ | — | `cancelled::` | `YYYY-MM-DD` | Auto-added on cancel |
| Done Date | ✅ | — | `completion::` | `YYYY-MM-DD` | Auto-added on complete |
| Block Link | `^id` | — | — | `^[a-zA-Z0-9-]+` | Very end of line, space-prefixed |

**Priority ordering (numeric, used for sorts):** Highest(0) > High(1) > Medium(2) > None(3) > Low(4) > Lowest(5)

> *Note:* "None" sorts between Low and Medium — tasks with no priority rank between Medium and Low.

### 3.4 Canonical Serialization Order (Write Order)

From the `TaskLayoutComponent` enum in `src/Layout/TaskLayoutOptions.ts` — this is the order the plugin **writes** fields when editing a task:

```
1.  Description
2.  🆔 id
3.  ⛔ dependsOn
4.  priority emoji (🔺 / ⏫ / 🔼 / 🔽 / ⏬)
5.  🔁 recurrence rule
6.  🏁 onCompletion
7.  ➕ createdDate
8.  🛫 startDate
9.  ⏳ scheduledDate
10. 📅 dueDate
11. ❌ cancelledDate
12. ✅ doneDate
13. ^blockLink
```

Tags (which are part of the description) appear inside the description, before position 2.

**When writing, format is:** `emoji YYYY-MM-DD` with a single space between emoji and date. Priority has no following value — just the emoji.

### 3.5 Example Fully-Populated Task

```markdown
- [ ] Write the report 🆔 abc123 ⛔ xyz789 🔺 🔁 every week 🏁 keep ➕ 2024-01-01 🛫 2024-01-05 ⏳ 2024-01-06 📅 2024-01-10 ^ref1
```

---

## 4. Dataview Inline-Field Format

### 4.1 Bracket Syntax

Fields are written as **bracketed inline fields** compatible with the [Dataview plugin](https://github.com/blacksmithgu/obsidian-dataview):

```
[key:: value]    ← Tasks writes this form
(key:: value)    ← Tasks can also read this form
```

When Tasks writes Dataview-format, it adds **two leading spaces** before the bracket to avoid a rendering issue ([issue #1913](https://github.com/obsidian-tasks-group/obsidian-tasks/issues/1913)):

```markdown
- [ ] Do something  [due:: 2024-01-10]  [priority:: high]
```

### 4.2 Dataview Field Name Table

| Dataview Key | Value Format | Emoji Equivalent |
|---|---|---|
| `id::` | `[a-zA-Z0-9-_]+` | 🆔 |
| `dependsOn::` | comma-sep IDs | ⛔ |
| `priority::` | `highest`/`high`/`medium`/`low`/`lowest` | 🔺⏫🔼🔽⏬ |
| `repeat::` | `every ...` text | 🔁 |
| `onCompletion::` | `keep` or `delete` | 🏁 |
| `created::` | `YYYY-MM-DD` | ➕ |
| `start::` | `YYYY-MM-DD` | 🛫 |
| `scheduled::` | `YYYY-MM-DD` | ⏳ |
| `due::` | `YYYY-MM-DD` | 📅 |
| `completion::` | `YYYY-MM-DD` | ✅ (note: NOT `done::`) |
| `cancelled::` | `YYYY-MM-DD` | ❌ |

### 4.3 Dataview Regex Construction

Each Dataview regex is wrapped to match `[key:: value]` or `(key:: value)` at end of line:

```
(?:(?=[^\]]+\])\[|(?=[^)]+\))\() *{innerRegex} *[)\]](?:,)?$
```

Allows optional trailing comma (workaround for rendering issues).

**Example Dataview task:**

```markdown
- [ ] Do this first  [id:: dcf64c]
- [ ] Do this after  [dependsOn:: dcf64c,0h17ye]
- [x] Completed task  [completion:: 2024-01-15]
- [ ] High priority  [priority:: high]
- [ ] Recurring  [repeat:: every week when done]  [due:: 2024-01-20]
```

---

## 5. Tags

### 5.1 Tag Recognition Regex

```typescript
// src/Task/TaskRegularExpressions.ts
hashTags = /(^|\s)#[^ !@#$%^&*(),.?":{}|<>]+/g
// For end-of-line matching:
hashTagsFromEnd = /(^|\s)#[^ !@#$%^&*(),.?":{}|<>]+$/
```

A tag must be:
- Preceded by start-of-string OR whitespace (prevents matching `URL#anchor`)
- `#` followed by one or more characters that are **not** in the set ` !@#$%^&*(),.?":{}|<>`

### 5.2 Tag Rules

1. **Tags are part of the description.** The `description` field includes all tags.
2. **Tags may appear anywhere** on the task line, interspersed with metadata emojis.
3. During parsing, tags are extracted from the end and re-appended to the description — so mixed tag placement like `do something #tag1 📅 2024-01-10 #tag2` will result in description `do something #tag1 #tag2` (tags consolidated at end of description text).
4. Tags survive the editing cycle but may be **repositioned** when the plugin rewrites the line.
5. **Obsidian tag rules differ from Tasks:** Obsidian requires at least one non-numeric character; Tasks allows all-numeric tags. Obsidian stops at `.`, Tasks treats `.` as a tag-terminator too (stops there naturally).
6. `%% comment %%` and `<!-- comment -->` tags: Obsidian ignores them, but Tasks **will** see tags inside comments.

### 5.3 Global Filter (Optional Setting)

If a global filter tag (e.g. `#task`) is configured, only lines containing that tag are treated as tasks. The global filter tag is **removed** from the line before parsing the description.

---

## 6. ID and DependsOn Fields

### 6.1 ID Format

```
Regex: /[a-zA-Z0-9-_]+/
```

- Characters: lowercase letters, uppercase letters, digits 0–9, hyphen `-`, underscore `_`
- No minimum length restriction in regex (though the UI generates 6-char IDs like `dcf64c`)
- Should be **unique across the vault** (not enforced automatically)
- The plugin's "generate unique id" feature creates short alphanumeric IDs

**Valid examples:** `1`, `abc`, `task-1`, `task_A`, `dcf64c`, `do-me-first`, `PROJ_123`

### 6.2 DependsOn Format

```
Regex: /[a-zA-Z0-9-_]+( *, *[a-zA-Z0-9-_]+ *)*/
```

A comma-separated list of task IDs:
- Optional spaces around commas are allowed **when reading**
- When Tasks **writes** dependsOn, spaces are removed: `id1,id2` (no spaces)

**Valid examples:** `dcf64c`, `dcf64c,0h17ye`, `dcf64c, 0h17ye`, `task-1,task-2,task-3`

### 6.3 Dependency Semantics

- Only **"Finish to Start" (FS)** dependency type is supported
- A task is `blocked` when it and one of its `dependsOn` targets are both non-DONE
- A task is `blocking` when it is non-DONE and another non-DONE task `dependsOn` it
- When a **recurring task** is completed, the **next occurrence removes both `id` and `dependsOn`** (intentional design)

### 6.4 Practical Notes for External ID Injection

Since IDs use `[a-zA-Z0-9-_]+`, external correlation IDs (e.g., UUIDs) will work if you **strip hyphens are the only special char** — so `550e8400-e29b-41d4-a716-446655440000` is valid. Shorter IDs (8–12 chars) are more user-friendly.

---

## 7. Recurrence Syntax

### 7.1 Format

```
🔁 every <rule>
```

The recurrence rule must start with the word `every`. Value regex: `[a-zA-Z0-9, !]+`

### 7.2 Examples

```
🔁 every day
🔁 every 3 days
🔁 every weekday
🔁 every week on Sunday
🔁 every week on Tuesday, Friday
🔁 every 2 weeks
🔁 every month
🔁 every month on the 1st
🔁 every month on the last
🔁 every month on the last Friday
🔁 every 3 months
🔁 every year
🔁 every 10 days when done      ← "when done" = relative to completion date
```

### 7.3 Date Selection for Next Occurrence

Priority order for calculating next recurrence date:
1. **Due date** (highest priority)
2. **Scheduled date**
3. **Start date**

If "Remove scheduled date on recurrence" setting is enabled, priority becomes: Due > Start > Scheduled.

A recurring task **should have at least one date** (Due, Scheduled, or Start); without a date, the recurrence is not useful for date-based searches.

### 7.4 Library

Uses the [rrule](https://github.com/jakubroztocil/rrule) library (iCalendar RFC 5545 semantics) for date calculation.

---

## 8. On Completion Field

```
🏁 keep      ← do nothing (same as omitting the field)
🏁 delete    ← remove the completed line
```

- Dataview: `[onCompletion:: keep]` / `[onCompletion:: delete]`
- Default (absent) = `keep`
- Useful with recurring tasks to avoid accumulation of completed instances

---

## 9. Multi-Line Tasks and Block Contexts

### 9.1 Multi-Line: NOT Supported

Tasks **only processes single lines**. The `TaskSerializer` interface documents:

> "A TaskSerializer is only responsible for the single line of text that follows after the checkbox."

Text on subsequent indented lines is **ignored** by Tasks (though it is preserved in the file and visible in Obsidian).

```markdown
- [ ] This is parsed ✅             ← parsed
      continuation line             ← IGNORED by Tasks
```

### 9.2 Tasks in Blockquotes and Callouts

The indentation regex `^([\s\t>]*)` captures `>` characters, so tasks inside blockquotes and callouts **are** recognized:

```markdown
> - [ ] task inside blockquote 📅 2024-01-10

> [!NOTE]
> - [ ] task inside callout 📅 2024-01-10
```

**Limitation:** In Live Preview mode, clicking checkboxes in callouts does not work correctly (Obsidian bug, tracked as [issue #1768](https://github.com/obsidian-tasks-group/obsidian-tasks/issues/1768)). Use `Tasks: Toggle Done` command instead.

### 9.3 Tasks Inside Code Blocks

**Not supported.** Tasks inside ```` ``` ```` code blocks are not read.

### 9.4 Tasks in Canvas

**Not supported.** Obsidian Canvas cards are not read.

---

## 10. Parsing/Editing Gotchas and Recommendations

### 10.1 Right-to-Left Parsing — Stop-on-Unknown-Text

**Gotcha:** The parser reads fields from the **right end** of the line. As soon as it encounters text that does not match any known field regex or tag regex, it **stops**, leaving everything to the left as part of the description.

```markdown
- [ ] Buy groceries 📅 2024-01-10 some random text
```

Here `some random text` terminates parsing — the due date is **not** read.

**Recommendation:** Always keep metadata fields **after** the description text, and do not insert unrecognized text between fields. Only tags and block links are allowed after metadata.

### 10.2 NBSP (Non-Breaking Space) Not Treated as Space

**Gotcha:** When copying from websites, `\u00A0` (NBSP) may appear instead of regular spaces. Tasks does not treat NBSP as a space, so `📅\u00A0 2024-01-10` would fail to parse.

**Recommendation:** Normalize whitespace to ASCII space before writing task lines. Tracked in [issue #606](https://github.com/obsidian-tasks-group/obsidian-tasks/issues/606).

### 10.3 Unicode Variation Selectors on Emojis

**Gotcha:** Some emoji keyboards append a Variation Selector-16 (`\uFE0F`). The regex includes `\uFE0F?` to handle this, but inconsistencies (especially with ⏫ High Priority) have been reported.

**Recommendation:** When generating task text programmatically, use the bare emoji code point without VS-16. Tracked in [issue #2273](https://github.com/obsidian-tasks-group/obsidian-tasks/issues/2273).

### 10.4 Alternate Emojis for Due and Scheduled

**Gotcha:** The parser accepts `📆` and `🗓` as aliases for due date (📅), and `⌛` as alias for scheduled date (⏳). But when Tasks **writes** a task line, it always uses the canonical emojis (📅, ⏳). Round-tripping via Tasks will silently replace alternate emojis.

**Recommendation:** Your parser should handle all aliases, but always write canonical forms.

### 10.5 Tag Repositioning

**Gotcha:** Tags interspersed with metadata (e.g., `📅 2024-01-10 #tag`) are stripped during parsing and re-appended to the description. When the task is rewritten, the tags will appear in the description area, not after the date.

**Recommendation:** When editing a task programmatically, place tags at the end of the description (before any emoji metadata) or accept that their position may shift.

### 10.6 `[X]` (Capital X) is DONE

**Gotcha:** `[X]` is treated as DONE, not as a custom status. This is a hardcoded check in `Status.getTypeForUnknownSymbol()`.

### 10.7 Links (`[[wikilinks]]` and `[Markdown](links)`) in Description

**Gotcha:** Wikilinks like `[[Some Note]]` and Markdown links `[text](url)` are part of the description text. The `#` in URL fragments (e.g., `http://example.com/#anchor`) is not picked up as a tag because the tag regex requires the `#` to be at the start of a string or preceded by whitespace — but be careful about edge cases.

**Recommendation:** When editing descriptions, treat wikilinks and markdown links as opaque atoms. Do not search for emoji inside link text without accounting for embedded brackets.

### 10.8 Emoji Inside Description Text

**Gotcha:** If the description text itself contains one of the reserved metadata emojis (e.g., `Buy ✅ stickers`), the parser will misinterpret `✅` as a done-date marker and expect a date after it. If no date follows (or the text is at the end), the emoji may "consume" the end of the description.

**Recommendation:** Avoid using Tasks' reserved emoji characters in description text. The reserved emoji are: `🔺 ⏫ 🔼 🔽 ⏬ 🛫 ➕ ⏳ ⌛ 📅 📆 🗓 ✅ ❌ 🔁 🏁 🆔 ⛔`.

### 10.9 Recurrence Removes `id` and `dependsOn`

**Gotcha:** When a recurring task is completed, the **next occurrence** has both `id` and `dependsOn` fields stripped. This is intentional (prevents duplicate IDs blocking the dependency graph), but means you cannot use static IDs on recurring tasks for dependency tracking.

### 10.10 Block Link Format

**Gotcha:** Block links (`^blockid`) must appear as the very last token, separated by a space: `📅 2024-01-10 ^abc123`. The regex is `/[ ]\^[a-zA-Z0-9-]+$/u`.

**Recommendation:** Always append block links after all metadata fields.

### 10.11 Dataview Format: Two Leading Spaces

**Gotcha:** When Tasks serializes Dataview-format fields, it prepends **two spaces**: `  [due:: 2024-01-10]`. This is a workaround for a rendering bug ([issue #1913](https://github.com/obsidian-tasks-group/obsidian-tasks/issues/1913)). Your parser should strip leading whitespace when reading field values.

### 10.12 `completion::` Not `done::`

**Gotcha:** In Dataview format, the done-date key is `completion::`, not `done::`. This is consistent with Dataview's own metadata spec for tasks.

### 10.13 Tasks in Numbered Lists

**Gotcha:** Tasks inside numbered lists (`1. [ ] item`, `2) [ ] item`) are read correctly, but when displayed in a `tasks` query block they are rendered as **bullet list items** (the original numbers are discarded in the rendered view).

### 10.14 Priority `⏬️` with Variation Selector

**Gotcha:** The lowest-priority emoji `⏬️` is sometimes written with VS-16 (`⏬\uFE0F`). The regex handles this with `\uFE0F?`. When generating programmatically, use the bare `⏬` (`U+23EC`) without the variation selector.

### 10.15 Parsing Loop Maximum: 20 Iterations

The `deserialize` loop runs at most **20 times**. In practice a fully-populated task has about 12 fields, so this is not a real limitation — but an adversarial string with 21+ alternating valid/invalid patterns near the end could truncate.

---

## 11. Detect-a-Task Regex (for Node.js/TypeScript)

```typescript
// Exact equivalent of TaskRegularExpressions.taskRegex
const TASK_REGEX = /^([\s\t>]*)([-*+]|[0-9]+[.)]) +\[(.)\] *(.*)/u;

// Match a line and destructure it:
function extractTaskComponents(line: string) {
    const match = line.match(TASK_REGEX);
    if (!match) return null;
    return {
        indentation:     match[1],  // e.g. "  " or "> "
        listMarker:      match[2],  // "-", "*", "+", "1.", "2)"
        statusChar:      match[3],  // " ", "x", "/", "-", etc.
        body:            match[4],  // everything after the checkbox
    };
}

// Detect block link at end of body
const BLOCK_LINK_REGEX = / \^[a-zA-Z0-9-]+$/u;

// Detect tags anywhere
const HASHTAG_REGEX = /(^|\s)#[^ !@#$%^&*(),.?":{}|<>]+/g;
```

---

## 12. Summary: Parsing a Task Line (Algorithm)

```
INPUT: a single line from a .md file

STEP 1 — Detect task:
  Apply /^([\s\t>]*)([-*+]|[0-9]+[.)]) +\[(.)\] *(.*)/u
  If no match → not a task, skip

STEP 2 — Extract components:
  indentation = match[1]
  listMarker  = match[2]
  statusChar  = match[3]   ← exactly one unicode char
  body        = match[4]   ← description + metadata

STEP 3 — Strip block link (if present):
  If body ends with / \^[a-zA-Z0-9-]+$/u → save blockLink, strip from body

STEP 4 — Strip metadata from right of body (loop, max 20x):
  For each pass:
    a. Try to match priority regex at end → extract priority
    b. Try to match doneDate regex → extract date
    c. Try to match cancelledDate regex → extract date
    d. Try to match dueDate regex (incl. aliases 📆 🗓) → extract date
    e. Try to match scheduledDate regex (incl. alias ⌛) → extract date
    f. Try to match startDate regex → extract date
    g. Try to match createdDate regex → extract date
    h. Try to match recurrence regex → extract rule text
    i. Try to match onCompletion regex → extract action
    j. Try to match trailing tag regex → prepend to trailingTags buffer
    k. Try to match id regex → extract id
    l. Try to match dependsOn regex → extract comma-split array
    If none matched in this pass → stop loop

STEP 5 — Reconstruct description:
  description = body + (trailingTags ? " " + trailingTags : "")
  tags = all hashtags in description (re-extract with HASHTAG_REGEX)

STEP 6 — Parse recurrence (if recurrenceRule string captured):
  recurrence = Recurrence.fromText({ rule, occurrence: {startDate, scheduledDate, dueDate} })
  (recurrence must be parsed AFTER all dates are known)

OUTPUT: { indentation, listMarker, statusChar, description, priority,
          createdDate, startDate, scheduledDate, dueDate, doneDate, cancelledDate,
          recurrence, onCompletion, id, dependsOn, tags, blockLink }
```

---

## 13. Source Citations

| Topic | Source |
|---|---|
| Core task regex | [`src/Task/TaskRegularExpressions.ts`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/src/Task/TaskRegularExpressions.ts) |
| Emoji symbols & parsing loop | [`src/TaskSerializer/DefaultTaskSerializer.ts`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/src/TaskSerializer/DefaultTaskSerializer.ts) |
| Dataview format | [`src/TaskSerializer/DataviewTaskSerializer.ts`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/src/TaskSerializer/DataviewTaskSerializer.ts) |
| TaskSerializer interface & TaskDetails | [`src/TaskSerializer/index.ts`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/src/TaskSerializer/index.ts) |
| Canonical field order | [`src/Layout/TaskLayoutOptions.ts`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/src/Layout/TaskLayoutOptions.ts) |
| Status types enum | [`src/Statuses/StatusConfiguration.ts`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/src/Statuses/StatusConfiguration.ts) |
| Status model & unknowns | [`src/Statuses/Status.ts`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/src/Statuses/Status.ts) |
| Priority enum | [`src/Task/Priority.ts`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/src/Task/Priority.ts) |
| Task model (full) | [`src/Task/Task.ts`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/src/Task/Task.ts) |
| Task dependencies doc | [`docs/Getting Started/Task Dependencies.md`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/docs/Getting%20Started/Task%20Dependencies.md) |
| Tags doc | [`docs/Getting Started/Tags.md`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/docs/Getting%20Started/Tags.md) |
| Dates doc | [`docs/Getting Started/Dates.md`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/docs/Getting%20Started/Dates.md) |
| Priority doc | [`docs/Getting Started/Priority.md`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/docs/Getting%20Started/Priority.md) |
| Recurring tasks doc | [`docs/Getting Started/Recurring Tasks.md`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/docs/Getting%20Started/Recurring%20Tasks.md) |
| On Completion doc | [`docs/Getting Started/On Completion.md`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/docs/Getting%20Started/On%20Completion.md) |
| Status types doc | [`docs/Getting Started/Statuses/Status Types.md`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/docs/Getting%20Started/Statuses/Status%20Types.md) |
| Core statuses doc | [`docs/Getting Started/Statuses/Core Statuses.md`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/docs/Getting%20Started/Statuses/Core%20Statuses.md) |
| Custom statuses doc | [`docs/Getting Started/Statuses/Custom Statuses.md`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/docs/Getting%20Started/Statuses/Custom%20Statuses.md) |
| Emoji format reference | [`docs/Reference/Task Formats/Tasks Emoji Format.md`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/docs/Reference/Task%20Formats/Tasks%20Emoji%20Format.md) (also fetched from publish CDN) |
| Dataview format reference | [`docs/Reference/Task Formats/Dataview Format.md`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/docs/Reference/Task%20Formats/Dataview%20Format.md) |
| Getting started / multi-line warning | [`docs/Getting Started/Getting Started.md`](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/0c32a11/docs/Getting%20Started/Getting%20Started.md) |

---

## Gaps and Uncertainties

1. **`Task.fromLine()` internals not fully traced** — the Task.ts file is 33 KB and was too large to fetch in full. The `fromLine` method likely handles the global filter stripping and scheduled-date inference from filename, but this was not fully verified from source. Recommend checking `src/Task/Task.ts` lines ~150–300.
2. **Scheduled date inference from filename** — When "Use Filename as Default Date" is enabled, Tasks may infer a scheduled date from the note's filename (e.g., `2024-01-15.md`). This is a plugin-level behaviour, not part of the line format itself.
3. **`[X]` capital X** — Verified from `Status.getTypeForUnknownSymbol()` that it maps to DONE. But it is unclear if the plugin *writes* `[X]` in any scenario or always writes `[x]`.
4. **Dataview format output in tests** — The two-leading-spaces rule for Dataview writing is verified in the serializer source. The exact parsing behavior for Dataview fields placed mid-line (not at end) is unverified — the docs say "Tasks cannot yet read Dataview fields arbitrarily anywhere within a task line."
5. **`ON_HOLD` status type** — Introduced in Tasks 7.23.0, it is very new. Its default symbol `h` was found in `Status.ts` but is not part of the built-in defaults exposed in settings by default — users must configure it manually.
