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
 *   files:      map url-path -> Buffer (served with Range support)
 *   mode:       "serve" (default) | "404" | "redirect308:<url>"
 *   badContent: serve declared length but wrong bytes (sha mismatch test)
 * Requests are recorded: { url, range }.
 */
function startServer(options) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, range: req.headers.range ?? null });
    if (options.mode === "404") {
      res.writeHead(404);
      res.end("nope");
      return;
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
    let start = 0;
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (m) start = Math.min(parseInt(m[1], 10), buf.length);
    if (start > 0) {
      res.writeHead(206, { "Content-Range": `bytes ${start}-${buf.length - 1}/${buf.length}`, "Content-Length": buf.length - start });
      res.end(buf.subarray(start));
      return;
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

function runDriver({ dir, engineScript, endpoints, timeoutMs = 25_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [DRIVER, "--dir", dir, "--engine-script", engineScript, "--endpoints", endpoints], {
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
