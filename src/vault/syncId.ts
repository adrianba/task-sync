/**
 * Correlation-ID helpers.
 *
 * The service stores a stable, opaque correlation id on each task line as an
 * HTML comment: `<!-- sync-id: … -->`. This is invisible in Obsidian's rendered
 * view, travels with the task text across moves/renames, is diff-friendly, and
 * — critically — does NOT collide with the Tasks plugin's own `🆔` field.
 *
 * For interoperability the parser also accepts a Dataview `[sync-id:: …]` form,
 * but the writer always emits the comment form.
 */

const SYNC_ID_COMMENT = /<!--\s*sync-id:\s*([A-Za-z0-9._~-]+)\s*-->/u;
const SYNC_ID_COMMENT_STRIP = /\s*<!--\s*sync-id:\s*[A-Za-z0-9._~-]+\s*-->/u;
const SYNC_ID_DATAVIEW =
  /(?:\[|\() *sync-id *:: *([A-Za-z0-9._~-]+) *(?:\]|\)),?/u;

/** A trailing block reference (`^abc123`) kept at the very end of a line. */
const BLOCK_REF = /(\s+\^[A-Za-z0-9-]+)\s*$/u;

export interface ExtractedSyncId {
  syncId?: string;
  /** The line text with any sync-id marker removed and right-trimmed. */
  rest: string;
}

/** Read a sync-id (comment or Dataview form) and strip it from the text. */
export function extractSyncId(text: string): ExtractedSyncId {
  let rest = text;
  let syncId: string | undefined;

  const comment = rest.match(SYNC_ID_COMMENT);
  if (comment?.[1]) {
    syncId = comment[1];
    rest = rest.replace(SYNC_ID_COMMENT, "");
  }

  const dv = rest.match(SYNC_ID_DATAVIEW);
  if (dv?.[1]) {
    syncId ??= dv[1];
    rest = rest.replace(SYNC_ID_DATAVIEW, "");
  }

  rest = rest.replace(/\s+$/u, "");
  return syncId !== undefined ? { syncId, rest } : { rest };
}

/**
 * Ensure the line carries exactly the given sync-id comment, inserting it just
 * before any trailing block reference. Idempotent.
 */
export function ensureSyncIdComment(line: string, syncId: string): string {
  const marker = ` <!-- sync-id: ${syncId} -->`;
  if (SYNC_ID_COMMENT_STRIP.test(line)) {
    return line.replace(SYNC_ID_COMMENT_STRIP, marker);
  }
  const block = line.match(BLOCK_REF);
  if (block && block.index !== undefined) {
    return `${line.slice(0, block.index)}${marker}${line.slice(block.index)}`;
  }
  return `${line.replace(/\s+$/u, "")}${marker}`;
}
