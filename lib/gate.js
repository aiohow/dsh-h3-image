/**
 * Concurrency gate (design D5 / PRD §3.3): the engine needs ~27 GB of unified
 * memory per run, so exactly ONE generation may be in flight per plugin
 * process. A second call returns `busy` immediately — no queueing, no hang.
 *
 * This is the in-process guarantee (structure-level for the plugin's own
 * surface). Cross-process orphans (DSH killed mid-run) are reclaimed by the
 * jobs table in M2 (ARCHITECTURE §2); until then the effect disposer kills the
 * live child on plugin unload, so a disable/restart never leaves a generator
 * running behind the host.
 */

let current = null; // { ticket, startedAt, promptPreview, kill }
let ticketSeq = 0;

/**
 * Try to take the single slot. Returns { ok: true, ticket } or
 * { ok: false, busy: { elapsed_seconds, prompt_preview } }.
 */
export function acquire(promptPreview) {
  if (current !== null) {
    return {
      ok: false,
      busy: {
        elapsed_seconds: Math.max(0, Math.round((Date.now() - current.startedAt) / 1000)),
        prompt_preview: current.promptPreview,
      },
    };
  }
  ticketSeq += 1;
  current = { ticket: ticketSeq, startedAt: Date.now(), promptPreview, kill: null };
  return { ok: true, ticket: ticketSeq };
}

/** Attach the live child killer to the held slot (runner calls this). */
export function noteKill(ticket, kill) {
  if (current !== null && current.ticket === ticket) current.kill = kill;
}

/** Release the slot; only the holder may release it. */
export function release(ticket) {
  if (current !== null && current.ticket === ticket) current = null;
}

/** Kill whatever is running (plugin unload path); idempotent. */
export function killActive(reason) {
  if (current !== null) {
    const { kill } = current;
    current = null;
    if (typeof kill === "function") {
      try {
        kill(reason ?? "plugin unloaded");
      } catch {
        /* killing a dead child is a normal answer */
      }
    }
  }
}

/** Test seam: force the slot empty. */
export function resetGate() {
  current = null;
}
