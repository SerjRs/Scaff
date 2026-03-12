/**
 * Library Retry Logic — retry failed ingestions.
 *
 * Provides functions to query and manage failed items.
 * Not automated in Phase 3 — the LLM can call library_retry manually,
 * or a cron can be added later.
 *
 * @see docs/library-architecture.md §4 (edge cases)
 */

import type { DatabaseSync } from "node:sqlite";

export interface FailedItem {
  id: number;
  url: string;
  error: string;
  created_at: string;
}

/**
 * Get items with status='failed' that are eligible for retry.
 * Only retry items less than 7 days old (after that, consider them permanently dead).
 */
export function getRetryableItems(db: DatabaseSync, limit: number = 5): FailedItem[] {
  return db.prepare(`
    SELECT id, url, error, created_at
    FROM items
    WHERE status = 'failed'
      AND created_at > datetime('now', '-7 days')
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as unknown as FailedItem[];
}

/**
 * Mark a failed item as 'dead' (permanently unreachable).
 * Called when retry also fails, or when item is older than 7 days.
 */
export function markDead(db: DatabaseSync, itemId: number, error: string): void {
  db.prepare("UPDATE items SET status = 'dead', error = ?, updated_at = datetime('now') WHERE id = ?")
    .run(error, itemId);
}

/**
 * Reset a failed item to be re-processed.
 * Called when the URL becomes reachable on retry.
 * The library_ingest handler will update it with real content.
 */
export function resetForReprocessing(db: DatabaseSync, itemId: number): void {
  db.prepare("UPDATE items SET status = 'active', error = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(itemId);
}
