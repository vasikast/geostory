// server.js
import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zconst
} from "zlib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0";
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";
const ALLOW_EDITOR_NETWORK = process.env.ALLOW_EDITOR_NETWORK === "1";

const MAX_LAYERS_FREE = 3;
const MAX_TITLE_LEN = 160;
const MAX_COMPRESSED_BYTES = 10_000_000; // 10MB compressed limit
const JSON_LIMIT = "50mb";

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: JSON_LIMIT }));
app.use(cors());

process.on("unhandledRejection", (reason) => console.error("UnhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("UncaughtException:", err));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com",
      "style-src  'self' 'unsafe-inline' https://unpkg.com",
      "img-src 'self' data: blob: https://tile.openstreetmap.org https://server.arcgisonline.com https://a.tile.opentopomap.org https://b.tile.opentopomap.org https://c.tile.opentopomap.org",
      "font-src 'self' data: https:",
      "connect-src 'self' https:",
      "worker-src 'self' blob:",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  );
  next();
});

app.use((req, res, next) => {
  const xfProto = req.headers["x-forwarded-proto"];
  if (IS_PROD && xfProto && xfProto !== "https") {
    return res.redirect("https://" + req.headers.host + req.url);
  }
  next();
});

let db;
let dbPromise = null;
async function initDbOnce() {
  if (db) return db;
  if (dbPromise) return dbPromise;
  const dbPath = path.join(__dirname, "geostory.db");
  dbPromise = open({ filename: dbPath, driver: sqlite3.Database })
    .then(async (conn) => {
      await conn.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        PRAGMA foreign_keys=ON;
        PRAGMA temp_store=MEMORY;
        PRAGMA mmap_size=268435456;
        PRAGMA busy_timeout=10000;
      `);
      await conn.exec(`
        CREATE TABLE IF NOT EXISTS stories (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          title TEXT,
          state_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_expires ON stories(expires_at);
        CREATE INDEX IF NOT EXISTS idx_created ON stories(created_at);
      `);
      db = conn; return db;
    })
    .catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}
const now = () => Math.floor(Date.now() / 1000);
const slug = (n = 7) => crypto.randomBytes(16).toString("base64url").slice(0, n);

async function runWithRetry(sql, params = [], retries = 2, name = "sql") {
  await initDbOnce();
  try { return await db.run(sql, params); }
  catch (e) {
    if (e && e.code === "SQLITE_BUSY" && retries > 0) {
      const delay = 200 + Math.floor(Math.random() * 200);
      console.warn(`[${name}] SQLITE_BUSY — retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
      return runWithRetry(sql, params, retries - 1, name);
    }
    throw e;
  }
}
function isLoopback(req) {
  const ip = (req.ip || "").replace("::ffff:", "");
  return ip === "127.0.0.1" || ip === "::1";
}
function editorGuard(req, res, next) {
  if (ALLOW_EDITOR_NETWORK || isLoopback(req)) return next();
  return res.status(403).send("Editor/API is accessible only from this computer.");
}

async function purgeExpired(retries = 3) {
  try {
    await initDbOnce();
    const r = await db.run(`DELETE FROM stories WHERE expires_at IS NOT NULL AND expires_at < ?`, [now()]);
    if (r?.changes) console.log(`🧹 Cleaned expired stories: ${r.changes}`);
  } catch (e) {
    if (e && e.code === "SQLITE_BUSY" && retries > 0) {
      const backoff = (4 - retries) * 300 + Math.floor(Math.random() * 200);
      console.warn(`Housekeeping busy, retrying in ${backoff}ms…`);
      await new Promise(res => setTimeout(res, backoff));
      return purgeExpired(retries - 1);
    }
    console.warn("Housekeeping error:", e?.message || e);
  }
}
(async () => {
  try { await initDbOnce(); await purgeExpired(); setInterval(purgeExpired, 24*3600*1000); }
  catch (e) { console.error("DB init failed:", e); process.exit(1); }
})();

app.get("/health", (_req, res) => res.json({ ok: true, env: NODE_ENV, time: new Date().toISOString() }));

app.use((req, res, next) => {
  const p = req.path || "";
  if (p === "/" || p.startsWith("/s/") || p === "/public/js/attrwin.js" || p === "/public/css/attrwin.css") {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

app.use("/app", editorGuard, express.static(path.join(__dirname, "app"), { extensions: ["html"] }));
app.get("/", editorGuard, (_req, res) => res.sendFile(path.join(__dirname, "app", "index.html")));
app.use("/public", express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-store");
    else res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  },
}));
app.get("/s/:id", (_req, res) => res.sendFile(path.join(__dirname, "public", "viewer.html")));

const BR_PREFIX = "br64:";
function toBr64(jsonString) {
  const input = Buffer.from(jsonString, "utf8");
  const br = brotliCompressSync(input, {
    params: {
      [zconst.BROTLI_PARAM_QUALITY]: 11,
      [zconst.BROTLI_PARAM_MODE]: zconst.BROTLI_MODE_TEXT
    }
  });
  return BR_PREFIX + br.toString("base64");
}
function fromBr64(possiblyBr64) {
  if (typeof possiblyBr64 !== "string") return possiblyBr64;
  if (!possiblyBr64.startsWith(BR_PREFIX)) return possiblyBr64;
  const b64 = possiblyBr64.slice(BR_PREFIX.length);
  const buf = Buffer.from(b64, "base64");
  const out = brotliDecompressSync(buf);
  return out.toString("utf8");
}

app.post("/api/stories", editorGuard, async (req, res) => {
  try {
    await initDbOnce();
    const { state, ttlDays = 7 } = req.body || {};
    if (!state || !Array.isArray(state.layers)) return res.status(400).json({ error: "Invalid state: expected { layers: [] }" });
    if (state.layers.length === 0) return res.status(400).json({ error: "No layers to publish" });
    if (state.layers.length > MAX_LAYERS_FREE) return res.status(400).json({ error: `Max ${MAX_LAYERS_FREE} layers (free)` });

    const title = (typeof state.title === "string" && state.title.trim())
      ? state.title.trim().slice(0, MAX_TITLE_LEN) : "Untitled";

    const ttlNum = Number(ttlDays);
    if (!Number.isFinite(ttlNum) || ttlNum < 1 || ttlNum > 60) {
      return res.status(400).json({ error: "ttlDays must be between 1 and 60" });
    }

    const raw = JSON.stringify(state);
    const br64 = toBr64(raw);
    const compressedBytes = Buffer.byteLength(br64, "utf8");
    if (compressedBytes > MAX_COMPRESSED_BYTES) {
      return res.status(413).json({ error: `State too large after compression: ${compressedBytes} bytes (limit ${MAX_COMPRESSED_BYTES})` });
    }

    const id = slug(7);
    const created = now();
    const expires = created + ttlNum * 86400;

    await runWithRetry(
      `INSERT INTO stories (id, created_at, expires_at, title, state_json) VALUES (?, ?, ?, ?, ?)`,
      [id, created, expires, title, br64],
      3,
      "insert-story"
    );

    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http")).toString();
    const urlPath = `/s/${id}`;
    const absUrl = host ? `${proto}://${host}${urlPath}` : urlPath;

    return res.json({ id, url: urlPath, absolute_url: absUrl, expires_at: expires });
  } catch (err) {
    if (err && err.code === "SQLITE_BUSY") return res.status(503).json({ error: "Database is busy, please retry." });
    console.error("POST /api/stories error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/stories/:id", async (req, res) => {
  try {
    await initDbOnce();
    const { id } = req.params;
    if (!/^[A-Za-z0-9_-]{5,20}$/.test(id)) return res.status(400).json({ error: "Invalid id" });
    const row = await db.get(`SELECT * FROM stories WHERE id = ?`, [id]);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.expires_at && row.expires_at < now()) return res.status(410).json({ error: "Expired" });

    const stored = row.state_json;
    const jsonText = (typeof stored === "string" && stored.startsWith("br64:")) ? fromBr64(stored) : stored;

    res.setHeader("Cache-Control", "public, max-age=900");
    return res.json({ id: row.id, title: row.title, state: JSON.parse(jsonText) });
  } catch (err) {
    if (err && err.code === "SQLITE_BUSY") return res.status(503).json({ error: "Database is busy, please retry." });
    console.error("GET /api/stories/:id error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => { console.error("Unhandled error:", err); res.status(500).json({ error: "Internal server error" }); });

app.listen(PORT, HOST, () => {
  console.log(`✅ Server running at http://${HOST}:${PORT} (${NODE_ENV})`);
  console.log(ALLOW_EDITOR_NETWORK
      ? "⚠️ Editor/API is accessible on the network (ALLOW_EDITOR_NETWORK=1)."
      : "🔒 Editor/API is locked to localhost (only this machine)."
  );
});
