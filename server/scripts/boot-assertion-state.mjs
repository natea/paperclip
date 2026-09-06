/**
 * AND-39: the AND-30 boot assertion, as a fact about the source rather than a
 * pending patch.
 *
 * History, because the shape here is otherwise inexplicable. AND-30 could not
 * edit `server/src/index.ts` from inside an agent run: that edit restarts the
 * dev server, and the restart drains the run making it. So the edit was
 * committed as an *unapplied* patch (`e4b88b76f`), to be applied by
 * `restart-dev-watch.mjs` at the one moment a restart is deliberate. That
 * happened — `7f166e1f5` applied and committed it.
 *
 * Which left the repo describing the same change twice: a patch file that
 * reads as pending, and the applied source. Deleting the patch file was not
 * safe either, because `restart-dev-watch.mjs` aborted when the file was
 * missing — so the obvious cleanup would have disabled the unattended restart
 * path AND-34 exists to provide.
 *
 * The patch file is gone. The invariant the restart actually needs is not "a
 * patch file exists and applies cleanly" but "the boot assertion is present in
 * the source about to be restarted", which is what this checks.
 */

/** Both halves of the assertion: the import, and the call inside startServer. */
const REQUIRED = [
  'from "./dev-watch-staleness.js"',
  "reportDevWatchStaleness(",
];

/**
 * @param {string} indexSource contents of server/src/index.ts
 * @returns {{ state: "present" | "absent", missing: string[] }}
 */
export function bootAssertionState(indexSource) {
  const missing = REQUIRED.filter((needle) => !indexSource.includes(needle));
  return { state: missing.length === 0 ? "present" : "absent", missing };
}

export const BOOT_ASSERTION_MARKERS = REQUIRED;
