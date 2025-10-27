// server.js
import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

// ===== Paths / Env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0"; // Render/Cloud friendly
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";
const ALLOW_EDITOR_NETWORK = process.env.ALLOW_EDITOR_NETWORK === "1";

// Limits / validation
const MAX_LAYERS_FREE = 3;
const MAX_TITLE_LEN = 160;
const MAX_STATE_BYTES = 2_000_000; // ~2 MB per story (adjust as needed)
const JSON_LIMIT = "25mb"; // incoming JSON body

// ===== App init
const app = express();
app.set("trust proxy", 1); // behind proxy (Render)
app.use(express.json({ limit: JSON_LIMIT }));
app.use(cors());

// Basic security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Mild CSP that works for SPA; tighten once we lock external hosts
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  );
  next();
});

// Force HTTPS only in production
app.use((req, res, next) => {
  const xfProto = req.headers["x-forwarded-proto"];
  if (IS_PROD && xfProto && xfProto !== "https") {
    return res.redirect("https://" + req.headers.host + req.url);
  }
  next();
});

// ===== SQLite init
let db;
async function initDb() {
  const dbPath = path.join(__dirname, "geostory.db");
  const conn = await open({ filename: dbPath, driver: sqlite3.Database });
  // Pragmas for concurrency & integrity
  await conn.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA foreign_keys=ON;
    PRAGMA temp_store=MEMORY;
    PRAGMA mmap_size=268435456; -- 256MB
    PRAGMA busy_timeout=3000;
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
  return conn;
}
const now = () => Math.floor(Date.now() / 1000);
const slug = (n = 7) => crypto.randomBytes(16).toString("base64url").slice(0, n);

// Ensure DB ready for each request (cheap check)
app.use(async (_req, _res, next) => {
  try {
    if (!db) db = await initDb();
    next();
  } catch (e) {
    next(e);
  }
});

// Helper: is request from same machine?
function isLoopback(req) {
  const ip = (req.ip || "").replace("::ffff:", "");
  return ip === "127.0.0.1" || ip === "::1";
}

// Guard for Editor & Create API (local only unless ALLOW_EDITOR_NETWORK=1)
function editorGuard(req, res, next) {
  if (ALLOW_EDITOR_NETWORK || isLoopback(req)) return next();
  return res.status(403).send("Editor/API is accessible only from this computer.");
}

// ===== Housekeeping (startup + daily)
async function purgeExpired() {
  try {
    const r = await db.run(
      `DELETE FROM stories WHERE expires_at IS NOT NULL AND expires_at < ?`,
      [now()]
    );
    if (r?.changes) console.log(`🧹 Cleaned expired stories: ${r.changes}`);
  } catch (e) {
    console.warn("Housekeeping error:", e?.message);
  }
}
(async () => {
  db = await initDb();
  await purgeExpired();
  setInterval(purgeExpired, 24 * 3600 * 1000);
})();

// Health
app.get("/health", (_req, res) =>
  res.json({ ok: true, env: NODE_ENV, time: new Date().toISOString() })
);

// ===== No-cache for viewer/editor shells to see deploy changes immediately
app.use((req, res, next) => {
  const p = req.path || "";
  if (
    p === "/" ||
    p.startsWith("/s/") ||
    p === "/public/js/attrwin.js" ||
    p === "/public/css/attrwin.css"
  ) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

// ===== STATIC HOSTING

// 1) Editor (local only, unless ALLOW_EDITOR_NETWORK=1)
app.use("/app", editorGuard, express.static(path.join(__dirname, "app"), { extensions: ["html"] }));
app.get("/", editorGuard, (_req, res) => {
  res.sendFile(path.join(__dirname, "app", "index.html"));
});

// 2) Viewer assets (public)
// Long cache for static assets (fingerprinted files recommended)
app.use(
  "/public",
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res, filePath) => {
      // Heuristic: cache long for assets except viewer.html shell
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-store");
      } else {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  })
);

// 3) SPA fallback for Viewer: /s/:id → viewer.html (public)
app.get("/s/:id", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "viewer.html"));
});

// ===== API (create/read)
app.post("/api/stories", editorGuard, async (req, res) => {
  try {
    const { state, ttlDays = 7 } = req.body || {};

    // Basic shape
    if (!state || !Array.isArray(state.layers)) {
      return res.status(400).json({ error: "Invalid state: expected { layers: [] }" });
    }
    // Business rules
    if (state.layers.length === 0) {
      return res.status(400).json({ error: "No layers to publish" });
    }
    if (state.layers.length > MAX_LAYERS_FREE) {
      return res.status(400).json({ error: `Max ${MAX_LAYERS_FREE} layers (free)` });
    }

    // Validate title & ttl
    const title =
      typeof state.title === "string" && state.title.trim()
        ? state.title.trim().slice(0, MAX_TITLE_LEN)
        : "Untitled";

    const ttlNum = Number(ttlDays);
    if (!Number.isFinite(ttlNum) || ttlNum < 1 || ttlNum > 60) {
      return res.status(400).json({ error: "ttlDays must be between 1 and 60" });
    }

    // Serialize & size guard
    const raw = JSON.stringify(state);
    const byteLen = Buffer.byteLength(raw, "utf8");
    if (byteLen > MAX_STATE_BYTES) {
      return res
        .status(413)
        .json({ error: `State too large: ${byteLen} bytes (limit ${MAX_STATE_BYTES})` });
    }

    const id = slug(7);
    const created = now();
    const expires = created + ttlNum * 86400;

    await db.run(
      `INSERT INTO stories (id, created_at, expires_at, title, state_json)
       VALUES (?, ?, ?, ?, ?)`,
      [id, created, expires, title, raw]
    );

    // Build absolute URL
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http")).toString();
    const urlPath = `/s/${id}`;
    const absUrl = host ? `${proto}://${host}${urlPath}` : urlPath;

    return res.json({ id, url: urlPath, absolute_url: absUrl, expires_at: expires });
  } catch (err) {
    console.error("POST /api/stories error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/stories/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[A-Za-z0-9_-]{5,20}$/.test(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const row = await db.get(`SELECT * FROM stories WHERE id = ?`, [id]);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.expires_at && row.expires_at < now()) {
      return res.status(410).json({ error: "Expired" });
    }
    res.setHeader("Cache-Control", "public, max-age=900"); // 15min
    return res.json({ id: row.id, title: row.title, state: JSON.parse(row.state_json) });
  } catch (err) {
    console.error("GET /api/stories/:id error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ===== 404 fallthrough (keep after routes)
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ===== Central error handler
// (avoid leaking stack traces in production)
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ===== Start
app.listen(PORT, HOST, () => {
  console.log(`✅ Server running at http://${HOST}:${PORT} (${NODE_ENV})`);
  console.log(
    ALLOW_EDITOR_NETWORK
      ? "⚠️ Editor/API is accessible on the network (ALLOW_EDITOR_NETWORK=1)."
      : "🔒 Editor/API is locked to localhost (only this machine)."
  );
});
