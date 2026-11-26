/**
 * Registers every built-in offline edit sync backend with the outbox runner
 * (#3530). Idempotent, so each entry point that can sync calls it.
 */

import { registerEditSyncBackend } from "./edit-outbox-runner";
import { postgisEditSyncHandler } from "./postgis-edit-sync";

let registered = false;

/** Register the built-in backends once. */
export function ensureEditSyncBackends(): void {
  if (registered) return;
  registered = true;
  registerEditSyncBackend("postgis", postgisEditSyncHandler);
}
