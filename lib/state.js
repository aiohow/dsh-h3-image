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

import { TEXT_ENCODER_PACKAGE, WEIGHTS } from "./pinned.js";
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
  const both = Array.isArray(rec?.agreements)
    && rec.agreements.includes(WEIGHTS.license)
    && rec.agreements.includes(TEXT_ENCODER_PACKAGE.license);
  if (rec?.accepted === true && rec?.agreement === WEIGHTS.license && both) {
    return null;
  }
  return envelope(
    "license",
    `The model weights are distributed under the "${WEIGHTS.license}" and the quantized text ` +
      `encoder under the "${TEXT_ENCODER_PACKAGE.license}", both with territorial exclusions and ` +
      `usage terms. No acceptance record exists for both agreements on this model directory.`,
    `Read both agreements at the pinned Hugging Face model cards, then record YOUR acceptance: ` +
      `h3_setup action=license accept=true. The plugin never accepts on your behalf.`,
  );
}

/** Summary shown by `h3_setup action=license` before acceptance (no I/O). */
export function licenseSummary() {
  return [
    `Agreement 1: ${WEIGHTS.license}`,
    `  Weights: ${WEIGHTS.repo} @ ${WEIGHTS.revision.slice(0, 12)}`,
    `  Full text: https://huggingface.co/${WEIGHTS.repo}/raw/${WEIGHTS.revision}/LICENSE`,
    `Agreement 2: ${TEXT_ENCODER_PACKAGE.license} (quantized text encoder, a separate third-party repo)`,
    `  Package: ${TEXT_ENCODER_PACKAGE.repo} @ ${TEXT_ENCODER_PACKAGE.revision.slice(0, 12)}`,
    `  Full text: https://huggingface.co/${TEXT_ENCODER_PACKAGE.repo}/raw/${TEXT_ENCODER_PACKAGE.revision}/LICENSE`,
    "Key points shared by both agreements:",
    " - TERRITORIAL EXCLUSIONS: authorized worldwide EXCEPT the EU, UK, South Korea and the US —",
    "   use outside the authorized territory is not licensed; confirm your jurisdiction first;",
    " - commercial use above US$1M annualized revenue, or offering a hosted service, needs separate",
    "   written authorization from MiniMax; outputs may not train other models (see the AUP in the text);",
    " - the original agreement files land on your disk with the downloads (LICENSE/NOTICE);",
    " - usage, redistribution and commercial terms are defined by those agreements, not by this plugin;",
    " - acceptance is recorded locally (timestamp + agreement names) and gates every download and generation;",
    " - this plugin never clicks accept for you: acceptance requires accept=true from you.",
  ].join("\n");
}

/** Pure transition: returns the new state with the acceptance record stamped. */
export function acceptLicense(state, at = new Date().toISOString()) {
  return {
    ...state,
    license: {
      accepted: true,
      agreement: WEIGHTS.license,
      agreements: [WEIGHTS.license, TEXT_ENCODER_PACKAGE.license],
      at,
    },
  };
}
