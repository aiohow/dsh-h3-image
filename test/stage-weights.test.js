import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * L2 test for assets/stage_weights.py: a fake engine script (constants only,
 * import-safe), two local http endpoints (one 404s to force the endpoint
 * switch, one serves), and the driver run end to end. The child always gets
 * HTTP(S)_PROXY pointed at a dead port so the system-proxy round can never
 * touch a real proxy and fails instantly.
 */

const PYTHON = ["/opt/homebrew/bin/python3", "/usr/bin/python3"].find((p) => existsSync(p)) ?? "python3";
const DRIVER = join(import.meta.dirname, "..", "assets", "stage_weights.py");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Fake engine: the exact constant surface stage_weights.py imports. */
function fakeEngineSource(files) {
  const core = Object.entries(files.core)
    .map(([rel, e]) => `    ${JSON.stringify(rel)}: (${e.buf.length}, ${e.sha ? JSON.stringify(e.sha) : "None"}),`)
    .join("\n");
  const shards = Object.entries(files.shards)
    .map(([name, e]) => `    ${JSON.stringify(name)}: (${e.buf.length}, ${JSON.stringify(e.sha)}),`)
    .join("\n");
  return `"""Fake engine fixture (constants only; import has no side effects)."""
REPO = "FakeOrg/FakeModel"
REVISION = "0123456789abcdef0123456789abcdef01234567"
CORE_FILES = {
${core}
}
SHARDS = {
${shards}
}
SHARD_FILE = "transformer/{name}"

def main(argv=None):
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
`;
}

function entry(buf) {
  return { buf, sha: sha256(buf) };
}

/**
 * Local endpoint. Options:
 *   files:       map url-path -> Buffer (served with Range support)
 *   mode:        "serve" (default) | "404" | "redirect308:<url>"
 *   badContent:  serve declared length but wrong bytes (sha mismatch test)
 *   ignoreRange: answer every request with a full 200 (server without Range
 *                support — the segmented path must fall back to single-stream)
 * Requests are recorded: { url, range }.
 */
function startServer(options) {
  const requests = [];
  const seen = new Map();
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, range: req.headers.range ?? null });
    if (options.mode === "404") {
      res.writeHead(404);
      res.end("nope");
      return;
    }
    if (options.failFirst) {
      // Bursty-mirror simulation: the first request per path fails, later
      // ones serve normally (a second direct round recovers).
      const n = (seen.get(req.url) ?? 0) + 1;
      seen.set(req.url, n);
      if (n === 1) {
        res.writeHead(500);
        res.end("flaky");
        return;
      }
    }
    if (options.mode && options.mode.startsWith("redirect308:")) {
      res.writeHead(308, { Location: options.mode.slice("redirect308:".length) + req.url });
      res.end();
      return;
    }
    const key = req.url.replace(/^.*\/resolve\/[^/]+\//, "");
    const buf = options.badContent ?? options.files?.[key];
    if (buf === undefined) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    // Open-ended (`bytes=N-`) and closed (`bytes=N-M`) ranges both answer 206
    // — the segmented path always asks for a closed range so a segment can
    // never swallow its neighbour's bytes.
    let start = 0;
    let end = buf.length - 1;
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    if (m && !options.ignoreRange) {
      start = Math.min(parseInt(m[1], 10), buf.length);
      if (m[2] !== "") end = Math.min(parseInt(m[2], 10), buf.length - 1);
      if (start <= end) {
        res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${buf.length}`, "Content-Length": end - start + 1 });
        res.end(buf.subarray(start, end + 1));
        return;
      }
    }
    res.writeHead(200, { "Content-Length": buf.length });
    res.end(buf);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) }),
    );
  });
}

function runDriver({ dir, engineScript, endpoints, segThreshold, timeoutMs = 25_000 }) {
  const argv = [DRIVER, "--dir", dir, "--engine-script", engineScript, "--endpoints", endpoints];
  if (segThreshold !== undefined) argv.push("--seg-threshold", String(segThreshold));
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, argv, {
      env: { ...process.env, HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", http_proxy: "http://127.0.0.1:1", https_proxy: "http://127.0.0.1:1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`stage_weights.py exceeded ${timeoutMs}ms\nstdout:${out}\nstderr:${err}`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

async function setupFixture(files) {
  const root = await mkdtemp(join(tmpdir(), "h3-stage-"));
  const scripts = join(root, "engine", "scripts");
  await mkdir(scripts, { recursive: true });
  const engineScript = join(scripts, "fetch_h3_image.py");
  await writeFile(engineScript, fakeEngineSource(files));
  return { root, modelDir: join(root, "models"), engineScript };
}

/** Every file under d — used to prove no `.part` / `.part.<i>` is left behind. */
async function walkFiles(d) {
  const entries = await readdir(d, { withFileTypes: true });
  const nested = await Promise.all(entries.map((e) => (e.isDirectory() ? walkFiles(join(d, e.name)) : [join(d, e.name)])));
  return nested.flat();
}

// Shared fixture: 2 core files (one nested under transformer/ → source/) + 2 shards.
const license = entry(Buffer.from("LICENSE TEXT"));
const tcfg = entry(Buffer.from('{"transformer":true}'));
const shard1 = entry(Buffer.from("0".repeat(1000) + "shard-one-tail"));
const shard2 = entry(Buffer.from("1".repeat(500)));
const FILES = { core: { LICENSE: license, "transformer/config.json": tcfg }, shards: { "model-00002-of-00002.safetensors": shard2, "model-00001-of-00002.safetensors": shard1 } };
const SERVE = { LICENSE: license.buf, "transformer/config.json": tcfg.buf, "transformer/model-00001-of-00002.safetensors": shard1.buf, "transformer/model-00002-of-00002.safetensors": shard2.buf };

test("stage: happy path places the engine layout, sentinels in order", async () => {
  const { root, modelDir, engineScript } = await setupFixture(FILES);
  const good = await startServer({ files: SERVE });
  try {
    const r = await runDriver({ dir: modelDir, engineScript, endpoints: good.url });
    assert.equal(r.code, 0, r.out + r.err);
    // Engine layout: core → root/<rel> (transformer/* → root/source/), shards → root/source/transformer/
    assert.equal((await readFile(join(modelDir, "LICENSE"))).toString(), "LICENSE TEXT");
    assert.equal((await readFile(join(modelDir, "source", "transformer", "config.json"))).toString(), '{"transformer":true}');
    assert.deepEqual((await readFile(join(modelDir, "source", "transformer", "model-00001-of-00002.safetensors"))), shard1.buf);
    assert.equal((await readFile(join(modelDir, "source", "transformer", "model-00002-of-00002.safetensors"))).toString(), shard2.buf.toString());
    // Sentinel contract: N = 2 core + 2 shards, CORE_FILES order first then sorted shards, terminal STAGE OK.
    const lines = r.out.trim().split("\n");
    assert.equal(lines[0], "[stage 1/4] fetching LICENSE via 127.0.0.1");
    assert.ok(lines.includes("[stage 1/4] placed LICENSE"));
    assert.ok(lines.includes("[stage 2/4] fetching transformer/config.json via 127.0.0.1"));
    assert.ok(lines.includes("[stage 3/4] fetching model-00001-of-00002.safetensors via 127.0.0.1"));
    assert.ok(lines.includes("[stage 4/4] placed model-00002-of-00002.safetensors"));
    assert.equal(lines.at(-1), "STAGE OK");
    assert.ok(!lines.some((l) => l.includes("switched endpoint")));
    assert.ok(!r.out.includes("system proxy")); // a direct success never mentions the proxy round
    // No .part leftovers anywhere.
    const walk = async (d) => (await Promise.all((await readdir(d, { withFileTypes: true })).map((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])))).flat();
    assert.ok(!(await walk(modelDir)).some((f) => f.endsWith(".part")));
  } finally {
    await good.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stage: dead endpoint switches to the mirror; already-placed files skip", async () => {
  const { root, modelDir, engineScript } = await setupFixture(FILES);
  const dead = await startServer({ mode: "404" });
  const good = await startServer({ files: SERVE });
  await mkdir(modelDir, { recursive: true });
  await writeFile(join(modelDir, "LICENSE"), license.buf); // pre-placed, sha matches
  try {
    const r = await runDriver({ dir: modelDir, engineScript, endpoints: `${dead.url},${good.url}` });
    assert.equal(r.code, 0, r.out + r.err);
    const lines = r.out.trim().split("\n");
    assert.ok(lines.includes("[stage 1/4] skipped LICENSE (already present)"));
    assert.ok(lines.includes("[stage 2/4] switched endpoint: 127.0.0.1"));
    assert.ok(lines.includes("[stage 2/4] fetching transformer/config.json via 127.0.0.1"));
    assert.equal(lines.at(-1), "STAGE OK");
    // Every file was attempted at the dead endpoint first.
    assert.ok(dead.requests.length >= 3);
  } finally {
    await dead.close();
    await good.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stage: 308 redirect is followed (urllib alone would fail) and Range survives resume", async () => {
  const { root, modelDir, engineScript } = await setupFixture(FILES);
  const good = await startServer({ files: SERVE });
  const redirector = await startServer({ mode: `redirect308:${good.url}` });
  // Half of shard1 already on disk as .part → the resume path.
  const shardDir = join(modelDir, "source", "transformer");
  await mkdir(shardDir, { recursive: true });
  await writeFile(join(shardDir, "model-00001-of-00002.safetensors.part"), shard1.buf.subarray(0, 400));
  try {
    const r = await runDriver({ dir: modelDir, engineScript, endpoints: redirector.url });
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.out.trim().split("\n").at(-1), "STAGE OK");
    assert.deepEqual((await readFile(join(shardDir, "model-00001-of-00002.safetensors"))), shard1.buf);
    // The resumed file went out with a Range header, and the 206 was appended
    // (final bytes == full content, not doubled or truncated).
    const ranged = good.requests.filter((q) => q.range === "bytes=400-");
    assert.ok(ranged.length >= 1, JSON.stringify(good.requests));
  } finally {
    await redirector.close();
    await good.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stage: bursty mirror (first request per file fails) recovers on the second direct round without touching the proxy", async () => {
  const { root, modelDir, engineScript } = await setupFixture(FILES);
  const flaky = await startServer({ files: SERVE, failFirst: true });
  try {
    const r = await runDriver({ dir: modelDir, engineScript, endpoints: flaky.url });
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.out.trim().split("\n").at(-1), "STAGE OK");
    // The recovery is announced per file and the proxy round is never mentioned.
    assert.ok(r.out.includes("direct round failed"));
    assert.ok(!r.out.includes("system proxy"), "a second direct success must not spend proxy bytes");
    assert.ok(!r.out.includes("note:")); // same-host redirect chain: no bounce note
  } finally {
    await flaky.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stage: sha mismatch deletes the part, announces the proxy round, exits 1 with STAGE FAIL", async () => {
  const { root, modelDir, engineScript } = await setupFixture(FILES);
  const bad = await startServer({ files: SERVE, badContent: Buffer.from("X".repeat(license.buf.length)) });
  try {
    const r = await runDriver({ dir: modelDir, engineScript, endpoints: bad.url });
    assert.equal(r.code, 1);
    assert.match(r.err, /STAGE FAIL LICENSE/);
    assert.ok(r.out.includes("stage: retrying via system proxy (may count against proxy data)"));
    assert.ok(!existsSync(join(modelDir, "LICENSE")), "bad content must never be renamed into place");
    assert.ok(!existsSync(join(modelDir, "LICENSE.part")), "sha-mismatched part must be deleted");
    // It stopped at the first failed file — nothing after it was attempted.
    assert.ok(!r.out.includes("transformer/config.json"));
  } finally {
    await bad.close();
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * Segmented downloads (--seg-threshold). The fixtures are tiny, so the
 * threshold is dropped to 100 bytes: the 1015/500-byte shards go through
 * the 4-segment path while the 12/19-byte core files stay single-stream,
 * so one run covers both routes. No real network anywhere.
 * ------------------------------------------------------------------ */

/** Mirror of segment_ranges() in the driver: 4 contiguous [start,end) blocks. */
function expectedRanges(size, count = 4) {
  const base = Math.floor(size / count);
  const extra = size % count;
  const out = [];
  let start = 0;
  for (let i = 0; i < count; i++) {
    const end = start + base + (i < extra ? 1 : 0);
    if (end > start) out.push([start, end]);
    start = end;
  }
  return out;
}

test("stage: big files download in 4 concurrent Range segments and stitch byte-exact", async () => {
  const { root, modelDir, engineScript } = await setupFixture(FILES);
  const good = await startServer({ files: SERVE });
  try {
    const r = await runDriver({ dir: modelDir, engineScript, endpoints: good.url, segThreshold: 100 });
    assert.equal(r.code, 0, r.out + r.err);
    const shardDir = join(modelDir, "source", "transformer");
    // Byte-exact after the stitch, for both segmented files.
    assert.deepEqual(await readFile(join(shardDir, "model-00001-of-00002.safetensors")), shard1.buf);
    assert.deepEqual(await readFile(join(shardDir, "model-00002-of-00002.safetensors")), shard2.buf);
    // Small files never entered the segmented path.
    assert.equal((await readFile(join(modelDir, "LICENSE"))).toString(), "LICENSE TEXT");

    // One seg line per segment of the segmented file, on the contract shape.
    const lines = r.out.trim().split("\n");
    for (let i = 1; i <= 4; i++) {
      assert.ok(lines.includes(`[stage 3/4] seg ${i}/4 model-00001-of-00002.safetensors via 127.0.0.1`),
        `missing seg line ${i} in:\n${r.out}`);
    }
    assert.ok(lines.includes("[stage 3/4] placed model-00001-of-00002.safetensors"));
    assert.equal(lines.at(-1), "STAGE OK");

    // Every segmented request asked for its own closed range, and the four
    // ranges tile the file exactly once (no gap, no overlap, no overrun).
    const seg1 = expectedRanges(shard1.buf.length);
    const seenRanges = good.requests
      .filter((q) => q.url.includes("model-00001") && q.range)
      .map((q) => q.range);
    assert.deepEqual(seenRanges.slice().sort(), seg1.map(([s, e]) => `bytes=${s}-${e - 1}`).sort(),
      JSON.stringify(good.requests));
    assert.ok(seenRanges.every((h) => /^bytes=\d+-\d+$/.test(h)), "segment ranges must be closed, never open-ended");
    // The small file was fetched with no Range header at all (single-stream).
    assert.ok(good.requests.filter((q) => q.url.endsWith("/LICENSE")).every((q) => q.range === null));

    // No .part and no .part.<i> left behind anywhere.
    const files = await walkFiles(modelDir);
    assert.ok(!files.some((f) => /\.part(\.\d+)?$/.test(f)), JSON.stringify(files));
  } finally {
    await good.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stage: a server that answers 200 to a Range request falls back to single-stream", async () => {
  const { root, modelDir, engineScript } = await setupFixture(FILES);
  const noRange = await startServer({ files: SERVE, ignoreRange: true });
  try {
    const r = await runDriver({ dir: modelDir, engineScript, endpoints: noRange.url, segThreshold: 100 });
    assert.equal(r.code, 0, r.out + r.err);
    const placed = join(modelDir, "source", "transformer", "model-00001-of-00002.safetensors");
    assert.deepEqual(await readFile(placed), shard1.buf, "the fallback must still place the whole file");
    // The segmented attempt really happened before the fallback…
    assert.ok(r.out.includes("[stage 3/4] seg 1/4 model-00001-of-00002.safetensors via 127.0.0.1"), r.out);
    // …and the file was then fetched in one piece (a request with no Range).
    assert.ok(noRange.requests.some((q) => q.url.includes("model-00001") && q.range === null),
      JSON.stringify(noRange.requests));
    assert.ok(r.out.includes("[stage 3/4] placed model-00001-of-00002.safetensors"));
    assert.equal(r.out.trim().split("\n").at(-1), "STAGE OK");
    // The abandoned segment parts are cleaned up, and the fallback never
    // escalated to the proxy round for a mere capability mismatch.
    const files = await walkFiles(modelDir);
    assert.ok(!files.some((f) => /\.part(\.\d+)?$/.test(f)), JSON.stringify(files));
    assert.ok(!r.out.includes("system proxy"), "a 200 fallback is not an endpoint failure");
  } finally {
    await noRange.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stage: a half-written segment part resumes with a Range pinned to its own end", async () => {
  const { root, modelDir, engineScript } = await setupFixture(FILES);
  const good = await startServer({ files: SERVE });
  const shardDir = join(modelDir, "source", "transformer");
  await mkdir(shardDir, { recursive: true });
  // Segment 0 of shard1 already half on disk (a previous attempt's leftovers).
  const [[s0, e0]] = expectedRanges(shard1.buf.length);
  const have = Math.floor((e0 - s0) / 2);
  const segPart = join(shardDir, "model-00001-of-00002.safetensors.part.0");
  await writeFile(segPart, shard1.buf.subarray(s0, s0 + have));
  try {
    const r = await runDriver({ dir: modelDir, engineScript, endpoints: good.url, segThreshold: 100 });
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(await readFile(join(shardDir, "model-00001-of-00002.safetensors")), shard1.buf,
      "the resumed segment must be appended, not doubled or truncated");
    // The resume request started exactly at have and stopped at the segment's
    // own end — an open-ended resume would have pulled the next segments in.
    const resumed = good.requests.filter((q) => q.url.includes("model-00001") && q.range === `bytes=${s0 + have}-${e0 - 1}`);
    assert.equal(resumed.length, 1, JSON.stringify(good.requests));
    // The other three segments still fetched from their own starts.
    for (const [s, e] of expectedRanges(shard1.buf.length).slice(1)) {
      assert.ok(good.requests.some((q) => q.url.includes("model-00001") && q.range === `bytes=${s}-${e - 1}`),
        `segment starting at ${s} was not fetched`);
    }
    assert.ok(!existsSync(segPart), "the resumed segment part must be gone after the stitch");
    const files = await walkFiles(modelDir);
    assert.ok(!files.some((f) => /\.part(\.\d+)?$/.test(f)), JSON.stringify(files));
  } finally {
    await good.close();
    await rm(root, { recursive: true, force: true });
  }
});
