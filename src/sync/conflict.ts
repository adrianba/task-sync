/**
 * Conflict resolution for 3-way reconciliation.
 *
 * When both the vault and an external backend changed a task since the last
 * reconcile, a policy decides which side wins. Resolution is whole-task
 * (last-writer-wins on the task), not field-level, by design.
 */
import type { ConflictPolicy } from "../config.js";

export type SyncDirection = "outbound" | "inbound";

export interface ConflictInputs {
  /** Vault file mtime in epoch ms (used by the `newer` policy). */
  vaultMtimeMs: number;
  /** External `lastModified` ISO timestamp, if known. */
  externalModified?: string | undefined;
}

/**
 * Decide the winning direction for a conflicting task. Pure.
 *
 * - `vault-wins`     → always outbound (markdown is source of truth).
 * - `external-wins`  → inbound when we have external state, else outbound.
 * - `newer`          → compare vault mtime vs external lastModified; ties go to
 *                      the vault (outbound) to avoid clobbering local edits.
 */
export function resolveConflict(
  policy: ConflictPolicy,
  inputs: ConflictInputs,
): SyncDirection {
  switch (policy) {
    case "vault-wins":
      return "outbound";
    case "external-wins":
      return inputs.externalModified ? "inbound" : "outbound";
    case "newer": {
      if (!inputs.externalModified) return "outbound";
      const extTime = new Date(inputs.externalModified).getTime();
      if (Number.isNaN(extTime)) return "outbound";
      return inputs.vaultMtimeMs >= extTime ? "outbound" : "inbound";
    }
  }
}
