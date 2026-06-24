# Morgen Obsidian Sync — Design Review

**Research compiled:** 2026-06-24  
**Sources verified from primary:**
- `morgen-so/morgen-obsidian` GitHub (public, Apache-2.0): https://github.com/morgen-so/morgen-obsidian  
- Morgen official guide: https://www.morgen.so/guides/integrate-and-time-block-tasks-from-obsidian  
- Morgen dev docs / Task API: https://github.com/morgen-so/morgen-dev-docs/blob/main/content/tasks.mdx  
- Obsidian Tasks emoji format spec: https://publish.obsidian.md/tasks/Reference/Task+Formats/Tasks+Emoji+Format  
- Real user vault with live Morgen tasks: https://github.com/UglyWillDuckling/diamond-mine  

---

## Executive Summary

Morgen's Obsidian integration is architecturally a **local, file-based, append-in-place sync**: the
closed-source Morgen desktop app directly reads and writes `.md` files in the user's vault. The
public Obsidian plugin (`morgen-tasks`, v1.0.7) is **purely cosmetic** — it only hides or emoji-
replaces the embedded `🆔` IDs in the Obsidian editor UI. All actual sync logic lives in the Morgen
desktop app (closed source). The integration is tightly coupled to the **Obsidian Tasks plugin in
Emoji format**, and reuses the Tasks plugin's native `🆔` emoji as the stable task correlation key.

---

## 1. Metadata Fields Written Into Markdown

### Format: Tasks Plugin Emoji (Not Dataview, Not Frontmatter)

Morgen uses **Obsidian Tasks plugin Emoji format** exclusively. This is the *only* format supported
as of mid-2026. From the official guide:

> *"This is currently the only format we support for identifying and interpreting tasks… Dataview
> format is particularly popular, so please let us know if you would like to see it prioritized."*

All task metadata is **inline on the task line**, after the task text, using emoji sigils:

| Emoji | Meaning | Notes |
|-------|---------|-------|
| `🆔 <id>` | **Correlation ID** (Morgen's stable key) | 6-char alphanumeric, e.g. `YXQzL9` |
| `📅 YYYY-MM-DD` | Due date | Bidirectional |
| `⏳ YYYY-MM-DD` | Scheduled ("do") date | Read-only from Morgen |
| `🛫 YYYY-MM-DD` | Start date | Read-only from Morgen |
| `✅ YYYY-MM-DD` | Done date | Written by Morgen on remote completion |
| `➕ YYYY-MM-DD` | Created date | Informational |
| `🔁 <pattern>` | Recurrence rule | e.g. `every 2 weeks` |
| `⏫` / `🔺` | High / Highest priority | |
| `🔼` | Medium priority | |
| `🔽` / `⏬` | Low / Lowest priority | |
| `❌ YYYY-MM-DD` | Cancelled date | |

### Concrete Task Line Examples

From a real user vault (`UglyWillDuckling/diamond-mine`, multiple files):

```markdown
- [x] #task **explore** [[Morgen]] with [[Obsidian]] 🆔 YXQzL9 ⏳ 2025-01-29 📅 2025-01-29 ✅ 2025-01-29
- [x] #task **explore** [[Morgen team work]] ⏫ ⏳ 2025-01-29 📅 2025-03-02 🆔 wIEulH ✅ 2025-02-26
- [ ] #task try out [[Git Butler]] again 🆔 Xtacc3 🔼 📅 2026-03-31
- [x] #task review reminders 🆔 GoJDVK 🔁 every 2 weeks ⏳ 2025-06-20 📅 2025-06-20 ✅ 2025-06-10
- [x] #task fill out daily note ⏫ 📅 2025-01-20 🆔 2e9xPG ✅ 2025-01-21
- [x] #task setup dictionary autocompletion for Nvim 🛫 2025-05-30 ⏳ 2025-05-30 📅 2025-06-06 🆔 TMDS2t ✅ 2025-06-03
- [x] #task explore tasks in [[Obsidian]] 🆔 tXya1Y ⏳ 2025-01-26 📅 2025-01-26 ✅ 2025-01-25
```

**Observations:**
- `🆔` position is **flexible** (can appear mid-line or at end); Morgen places it after task text
- The global filter tag (e.g. `#task`) is set in the Tasks plugin config and respected by Morgen
- Checkbox state (`[ ]` / `[x]`) is the primary completion marker
- Wikilinks `[[...]]` are preserved verbatim in the task title

---

## 2. Unique ID: Format, Generation, and Correlation

### Regex (from source)

- **`extension.ts`**: `/🆔 ([A-Za-z0-9]+)/g` — matches strictly alphanumeric (no hyphens/underscores)  
- **`postProcessor.ts`**: `/🆔 *([a-zA-Z0-9-_]+)/iu` — allows hyphens/underscores (superset, for future-proofing)

**Format**: ~6 characters, base62 (`[A-Za-z0-9]`), case-sensitive. Examples: `YXQzL9`, `rboaJy`,
`tXya1Y`, `Qi4xRT`, `GoJDVK`, `TMDS2t`, `2e9xPG`, `Xtacc3`.

### Generation (Two Modes)

IDs are **generated and written by the closed-source Morgen desktop app**. Two user-configured modes:

1. **Auto-ID (default)**: Before initial sync, Morgen scans the vault, identifies all task lines
   without a `🆔` field, and **batch-inserts IDs** into those files. The user sees a confirmation
   popup with a count of affected notes before any writes happen.

2. **Manual-ID**: User types `ID` next to a task in Obsidian and hits Enter (Tasks plugin
   autocomplete generates the ID). Morgen only imports tasks that already carry a `🆔` field.

### Correlation Mapping

The `🆔 <shortId>` is the **stable bridge** between:
- The markdown task line (keyed by `🆔` value, agnostic to file path or line number)
- Morgen's internal task record (which uses a separate long opaque `id` like
  `"WyJBUU1rQURaa1lXWXpOel..."` per the Task API schema)

The mapping table `shortId ↔ internal Morgen ID` is maintained inside the closed-source desktop
app. The short ID is **permanent and immutable** — moving or renaming the file does not break sync
as long as the `🆔 <id>` remains on the task line.

---

## 3. Task and Folder Selection (What Gets Synced)

The Morgen desktop app reads the entire vault root directory. Filtering is multi-level:

### Note-Level
| Mechanism | Configuration |
|-----------|--------------|
| Default (all notes) | All vault notes are candidates |
| Per-note opt-out | Add `morgen-tasks-include: false` to note frontmatter |
| Per-note opt-in | Add `morgen-tasks-include: true` to note frontmatter |
| Obsidian excluded files | Morgen reads and respects `Settings → Files & Links → Excluded Files` |
| Ignored directories | Configured in Morgen Prefs → Obsidian → Ignored Directories |
| Recency filter | Optional: only notes modified in the past 30 days |

### Task-Level
| Mechanism | Configuration |
|-----------|--------------|
| Tasks plugin Global Task Filter | Morgen reads Tasks plugin config and applies the same filter (e.g. `#task`) |
| ID presence | If set to "Only import tasks with existing IDs," tasks without `🆔` are skipped |

---

## 4. Bidirectional Updates and Conflict Handling

### Architecture

The integration is **purely local** — the Morgen desktop app directly reads/writes `.md` files in
the vault folder with **no cloud intermediary** for vault content (privacy feature). The Obsidian
plugin performs **zero file writes**.

### Confirmed Sync Behaviors

**Morgen → Markdown (writeback triggered by remote action):**
- Complete a task in Morgen → `[ ]` → `[x]`, `✅ YYYY-MM-DD` appended to the line
- Complete a recurring task in Morgen → Morgen writes a fresh task instance to the markdown (for
  the next recurrence occurrence)
- (Likely) Change due date in Morgen → `📅 YYYY-MM-DD` updated in the markdown ⚠️ unverified for
  Obsidian specifically; confirmed for Todoist/Notion

**Markdown → Morgen (triggered by filesystem events):**
- Any edit to a `.md` file causes Morgen to re-read the modified file
- Task lines with matching `🆔` IDs are diffed and updated in Morgen's internal state
- New `🆔`-tagged tasks appear in the Morgen task pane on next refresh

### Conflict Resolution

**⚠️ NOT explicitly documented in any public source.** No mention of last-writer-wins, timestamps,
vector clocks, or explicit merge strategy in Morgen's documentation. Inferred patterns (unverified):
- After writing to a file, the app likely marks that modification as self-originated and suppresses
  re-processing it as an external change (write-then-suppress)
- A debounce window after user edits before treating the file as ready to sync
- Content-hash guard to avoid duplicate writes

---

## 5. Field Round-Tripping

| Obsidian Emoji | Morgen API Field | Bidirectional? |
|----------------|-----------------|----------------|
| `[ ]` / `[x]` | `progress: "needs-action"` / `"completed"` | ✅ Yes |
| `📅 YYYY-MM-DD` | `due: "YYYY-MM-DDTHH:mm:ss"` | ✅ Yes |
| `✅ YYYY-MM-DD` | Derived on task completion | ✅ Morgen writes on close |
| `🔼`/`⏫`/`🔺`/`🔽`/`⏬` | `priority: 1–9` (0=undefined, 1=highest) | ✅ Yes |
| `🔁 every N ...` | Recurrence (internal) | ✅ Read; new instance written on completion |
| `⏳ YYYY-MM-DD` | Scheduled/do-date | ⚠️ Read-only in Morgen |
| `🛫 YYYY-MM-DD` | Start date | ⚠️ Read-only in Morgen |
| Task text | `title` | ✅ Yes |
| Note filename/path | UI context (not a writable field) | ✅ Display only |

**NOT round-tripped:** inline `#tags`, Wikilinks (preserved as literal text), subtask hierarchy
(top-level tasks only currently), Dataview fields.

---

## 6. Feedback Loop Prevention

The Obsidian plugin is **read-only by design** — it is a CodeMirror editor extension + markdown
post-processor that only manipulates the DOM/visual rendering, never the underlying `.md` files.
This eliminates one class of feedback loop.

Write path is entirely in the closed-source Morgen desktop app. Observed design constraints:
- Explicit user confirmation gate on initial batch-ID-insertion
- The plugin README comment reveals careful concern about ID position to avoid Tasks plugin
  re-parsing loops:  
  > *"Task is rendered by the Tasks plugin by a query block. If the ID isn't the last item in the
  > text, it will sometimes fail to give the ID its own span"*

**Inferred (⚠️ unverified):**
- Write-then-suppress: self-originated writes are not re-processed as external changes
- Debounce on file-change events (1–2 second window)
- Read-before-write: check if the field already exists before writing

---

## 7. Limitations, Gotchas, and Compatibility Notes

| Issue | Details |
|-------|---------|
| **Emoji format only** | Dataview `key:: value` is explicitly unsupported. Feature-request exists. |
| **Tasks plugin mandatory** | Morgen depends on the Tasks plugin's parsing conventions; raw markdown checkboxes alone are insufficient |
| **Desktop app only** | No mobile sync. Morgen desktop (Mac/Windows/Linux) required |
| **Template pollution** | Failing to exclude template directories causes IDs to be written into templates, propagating duplicate IDs to every note created from them — a critical misconfiguration |
| **`🆔` emoji collision** | `🆔` is also the Tasks plugin's native task-dependency ID sigil. Using both Morgen sync and Tasks dependency IDs on the same task is ambiguous. Not addressed in any Morgen docs. |
| **Obsidian Sync races** | Morgen writes directly to vault files; Obsidian Sync cloud syncs the same files. Simultaneous writes can create conflict copies. Not documented by Morgen. |
| **Kanban plugin quirks** | Kanban renders tasks without wrapping the `🆔` ID in a containing span. Morgen's plugin has explicit workarounds (`postProcessor.ts`, `styles.css` targeting `.kanban-plugin__inline-metadata__id`). |
| **Scheduled/start dates read-only** | `⏳` and `🛫` are displayed in Morgen but cannot be edited there. Time-blocking does NOT write back a scheduled date to markdown. |
| **Notes as tasks: not supported** | Only checklist items (`- [ ]`) sync. Note-level tasks (via frontmatter) are on the roadmap. |
| **Large vault performance** | Recommend 30-day recency filter for vaults with many old notes |
| **No mobile sync** | Not supported; confirmed in FAQ |

---

## Reusable Patterns for Our Node.js / Microsoft To Do Service

### ✅ Adopt

1. **Short opaque inline correlation ID**: Write a 6–8 char base62 ID directly on the task line
   (e.g. `<!-- todoid:aB3xYZ -->` or a custom emoji sigil). Robust to renames/moves; travels with
   the task text; file-diffable.

2. **Reuse existing task-format conventions**: Build on top of Obsidian Tasks emoji format rather
   than inventing a new schema. Existing queries, filters, and UI all continue working.

3. **Opt-in/opt-out per note via frontmatter**: Support a `todo-sync: false` frontmatter key to
   exclude specific notes from sync scope.

4. **Respect Tasks plugin's Global Task Filter**: Read the Tasks plugin config and apply the same
   filter — avoids double-processing tasks the user has intentionally scoped.

5. **Default-exclude templates directory**: Auto-detect directories containing "template" in their
   name and exclude them. Display a warning in setup if templates are in scope.

6. **Confirmation gate before initial batch-ID-insertion**: Show count of files/tasks that will be
   modified. Give user a chance to back up first.

7. **Decouple cosmetic plugin from sync daemon**: The sync daemon should never be part of the
   Obsidian plugin. UI concerns (hiding IDs) are separate from sync correctness.

8. **Done-date writeback**: When a task completes on Microsoft To Do, write `✅ YYYY-MM-DD` to
   the markdown line AND toggle `[x]`. Make the writeback idempotent (check for existing `✅`
   before writing).

9. **Position ID near end of line**: Place the correlation ID after the task text, following date
   fields. Minimizes parsing conflicts with other tools that truncate or process task lines.

10. **Read-before-write guard**: Before writing any change to a task line, re-read the current
    file content and verify the line still matches what we last read (optimistic concurrency). Abort
    if it changed.

### ⚠️ Avoid

1. **Don't put the correlation ID in frontmatter** — frontmatter is per-file; a file can contain
   dozens of tasks.

2. **Don't use line number as the correlation key** — line numbers shift with every user edit.

3. **Don't use the `🆔` emoji** — it's the Tasks plugin's task-dependency sigil. Use a different
   emoji or a prefixed string notation to avoid ambiguity (e.g. `🔗 ms-todo:<id>`).

4. **Don't ignore Obsidian Sync races** — implement a modified-time check or file-lock before
   writing to detect concurrent external modifications.

5. **Don't skip debouncing file-change events** — Obsidian fires multiple events per save. Debounce
   per file with at least a 1-second window before triggering outbound sync.

6. **Don't silently handle recurring task completion** — when a recurring task is completed on
   Microsoft To Do, explicitly generate the next recurrence instance in the markdown (or at minimum,
   document that recurrence is not supported for MS To Do tasks).

7. **Don't claim to round-trip all fields** — be explicit that scheduled/start dates, inline tags,
   and Wikilinks are read-only or ignored. Users will otherwise be surprised when edits disappear.

---

## Architecture Summary (Morgen's Model)

```
┌──────────────────────────────────────────────────────────────┐
│  Obsidian Vault  (.md files on local disk)                   │
│                                                              │
│  note.md:                                                    │
│  - [ ] #task Buy milk 🆔 aB3xYZ 📅 2025-02-01               │
│  - [x] #task Call dentist 🆔 qR7mNp ✅ 2025-01-28           │
└──────────┬──────────────────────────────────▲───────────────┘
           │ filesystem watch                  │ file write
           │ (read .md on change)              │ (append ✅ date,
           ▼                                   │  toggle [x],
┌──────────────────────────────┐               │  insert 🆔 ID)
│  Morgen Desktop App          │───────────────┘
│  (closed source)             │
│  ┌──────────────────────┐    │
│  │ Internal task store  │    │
│  │ 🆔 aB3xYZ ↔ long     │    │
│  │ internal Morgen ID   │    │
│  └──────────────────────┘    │
└──────────────────────────────┘
           │
           │  UI: task pane, calendar time-blocking,
           │  drag-drop, completion, due-date display
           ▼
┌──────────────────────────────┐
│  Morgen UI + Calendar        │
└──────────────────────────────┘

┌──────────────────────────────┐
│  Obsidian Plugin             │  ← COSMETIC ONLY — never writes files
│  (morgen-tasks v1.0.7)       │  CodeMirror editor extension
│  Hides/replaces 🆔 IDs in UI │  + MarkdownPostProcessor
│  Three modes: show/hide/emoji│  + styles.css (CSS container queries)
└──────────────────────────────┘
```

---

## Source Citations

| Source | URL | What it confirms |
|--------|-----|-----------------|
| Morgen Obsidian plugin (public source) | https://github.com/morgen-so/morgen-obsidian | ID regex, plugin is cosmetic-only, settings schema, CSS class names |
| Morgen official integration guide | https://www.morgen.so/guides/integrate-and-time-block-tasks-from-obsidian | Inclusion/exclusion config, ID modes, completion writeback, limitations |
| Morgen dev docs – Task API | https://github.com/morgen-so/morgen-dev-docs/blob/main/content/tasks.mdx | Internal task schema: `progress`, `due`, `priority`, `relatedTo`, `id` |
| Obsidian Tasks emoji format spec | https://publish.obsidian.md/tasks/Reference/Task+Formats/Tasks+Emoji+Format | All emoji sigil definitions and meaning |
| Real user vault (diamond-mine) | https://github.com/UglyWillDuckling/diamond-mine | Concrete real-world task examples with Morgen IDs |
| Morgen due dates guide | https://www.morgen.so/guides/how-to-see-due-dates-in-your-calendar | Due date display, "do" vs "due" distinction, recurrence behavior |

---

## Gaps / Unverified Items

- **⚠️ Conflict resolution algorithm**: Entirely inside closed-source desktop app; no public docs.
- **⚠️ ID generation algorithm**: 6-char base62 observed in real vaults; generation code not public.
- **⚠️ File-watcher debounce strategy**: Not documented; inferred from standard practice.
- **⚠️ Due-date writeback for Obsidian tasks**: Confirmed for Todoist/Notion; not explicitly
  confirmed for Obsidian markdown (likely yes, but unverified).
- **⚠️ `🆔` collision with Tasks dependency IDs**: Potential ambiguity; neither Morgen nor Tasks
  plugin documentation addresses it.
- **⚠️ `help.morgen.so` unreachable**: DNS resolution failure during research. Detailed help-center
  articles (if any) beyond the `/guides/` pages could not be consulted.
- **⚠️ Priority mapping details**: The exact mapping between Morgen's 0–9 priority scale and the
  Tasks plugin's 5-level emoji priority is not documented.
```

---

## Research Report Delivery

The complete report above is ready for the main agent to write to `/home/ade/.copilot/session-state/9ec4e0fe-aab8-42cb-993f-00d9261d9b14/files/research-morgen.md`. Here are the **top-line findings** for immediate use:

### Key Findings Summary

1. **ID format confirmed from source**: `🆔 <6-char-base62>` inline on the task line (e.g. `🆔 YXQzL9`). Regex: `/🆔 ([A-Za-z0-9]+)/g`. Source: `morgen-so/morgen-obsidian:extension.ts`

2. **Format is Tasks plugin Emoji — not Dataview**: The entire metadata schema piggybacks on the Obsidian Tasks plugin's emoji sigils (`📅`, `✅`, `⏳`, `🔼`, `🔁`, etc.). Dataview format is explicitly unsupported.

3. **The Obsidian plugin is purely cosmetic**: It hides/replaces `🆔` IDs visually. Zero file writes. All sync logic is in the closed-source Morgen desktop app which watches the filesystem directly.

4. **Conflict resolution is undocumented**: No public information on how simultaneous edits are handled. This is the biggest gap for our design.

5. **Done-date writeback is confirmed**: When a task is completed in Morgen, it writes `[x]` + `✅ YYYY-MM-DD` back to the markdown file. This is the primary Morgen→Markdown write path.

6. **Template protection is critical**: Templates must be in an ignored directory or Morgen will embed IDs into them, causing every note created from the template to share the same ID.

7. **Don't reuse `🆔`**: It conflicts with the Tasks plugin's own task-dependency ID feature. Use a different sigil for our Microsoft To Do correlation key.
