/**
 * Plugin state (ARCHITECTURE §3): one JSON file per model_dir, written
 * atomically (tmp + rename, the same style as the engine's metrics writer).
 *
 * M1 uses it for exactly one thing — the license acceptance record. The
 * plugin NEVER accepts on the user's behalf: `h3_setup action=license`
 * without `accept: true` only displays the agreement summary; the record is
 * written solely when the caller passes accept:true (which the wizard will
 * surface as an explicit user checkbox in M2).
 *
 * Location: `<model_dir>/h3-plugin-state.json`. It travels with the weights
 * it gates, is visible to the user, and `reset` deletes only this file.
 */
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { WEIGHTS } from "./pinned.js";
import { envelope } from "./checks.js";

export const STATE_FILE_NAME = "h3-plugin-state.json";

export function statePath(modelDir) {
  return join(modelDir, STATE_FILE_NAME);
}

/** Missing or corrupt state reads as empty — a fresh machine, not an error. */
export async function readState(path, readFile) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Atomic write: tmp in the same directory, then rename over the target. */
export async function writeState(path, state, { writeFileP = writeFile, renameP = rename } = {}) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFileP(tmp, JSON.stringify(state, null, 1) + "\n", "utf8");
  await renameP(tmp, path);
}

/** Pure gate: returns null when generation may proceed, else the envelope. */
export function licenseGate(state) {
  const rec = state?.license;
  if (rec?.accepted === true && rec?.agreement === WEIGHTS.license) {
    return null;
  }
  return envelope(
    "license",
    `The model weights are distributed under the "${WEIGHTS.license}", which includes territorial ` +
      `exclusions and usage terms. No acceptance record exists for this model directory.`,
    `Read the agreement at the pinned Hugging Face model card, then record YOUR acceptance: ` +
      `h3_setup action=license accept=true. The plugin never accepts on your behalf.`,
  );
}

/** Summary shown by `h3_setup action=license` before acceptance (no I/O). */
export function licenseSummary() {
  return [
    `Agreement: ${WEIGHTS.license}`,
    `Weights source: ${WEIGHTS.repo} @ ${WEIGHTS.revision.slice(0, 12)}`,
    "Key points (read the full text at the model card before accepting):",
    " - community license with TERRITORIAL EXCLUSIONS — check your region is permitted;",
    " - usage, redistribution and commercial terms are defined by the agreement, not by this plugin;",
    " - acceptance is recorded locally (timestamp + agreement name) and gates every download and generation;",
    " - this plugin never clicks accept for you: acceptance requires accept=true from you.",
  ].join("\n");
}

/** Pure transition: returns the new state with the acceptance record stamped. */
export function acceptLicense(state, at = new Date().toISOString()) {
  return { ...state, license: { accepted: true, agreement: WEIGHTS.license, at } };
}
