// server.js
import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

// ----- paths / env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0"; // απαραίτητο για Render/Cloud
const ALLOW_EDITOR_NETWORK = process.env.ALLOW_EDITOR_NETWORK === "1"; // προαιρετικό override
const IS_PROD = process.env.NODE_ENV === "production";

// ----- app init
const app = express();
app.set("trust proxy", 1); // πίσω από proxy (Render)
app.use(express.json({ limit: "100mb" }));
app.use(cors());

// basic headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// (προαιρετικό) force HTTPS μόνο σε production
app.use((req, res, next) => {
  if (IS_PROD && req.headers["x-forwarded-proto"] !== "https") {
    return res.redirect("https://" + req.headers.host + req.url);
  }
  next();
});

// ----- sqlite init
let db;
(async () => {
  db = await open({ filename: path.join(__dirname, "geostory.db"), driver: sqlite3.Database });
  await db.exec(`
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
})();

const now = () => Math.floor(Date.now() / 1000);
const slug = (n = 7) => crypto.randomBytes(16).toString("base64url").slice(0, n);

// ---- helper: είναι το αίτημα από τον ίδιο υπολογιστή;
function isLoopback(req) {
  const ip = (req.ip || "").replace("::ffff:", "");
  return ip === "127.0.0.1" || ip === "::1";
}

// ---- guard για Editor & API (μόνο τοπικά, εκτός αν ALLOW_EDITOR_NETWORK=1)
function editorGuard(req, res, next) {
  if (ALLOW_EDITOR_NETWORK || isLoopback(req)) return next();
  return res.status(403).send("Editor/API is accessible only from this computer.");
}

// ----- housekeeping: καθάρισμα ληγμένων 1x/ημέρα
setInterval(async () => {
  try {
    const r = await db.run(
      `DELETE FROM stories WHERE expires_at IS NOT NULL AND expires_at < ?`,
      [now()]
    );
    if (r?.changes) console.log(`🧹 Cleaned expired stories: ${r.changes}`);
  } catch (e) {
    console.warn("Housekeeping error:", e?.message);
  }
}, 24 * 3600 * 1000);

// health (χρήσιμο για έλεγχο)
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// -------------------------------------------------------------------
// (ΠΡΟΣΩΡΙΝΟ για ανάπτυξη) No-cache για viewer και attrwin αρχεία,
// ώστε να βλέπεις αμέσως τις αλλαγές μετά το deploy
// -------------------------------------------------------------------
app.use((req, res, next) => {
  try {
    const p = req.path || "";
    if (
      p === "/" ||
      p.startsWith("/s/") ||
      p === "/public/js/attrwin.js" ||
      p === "/public/css/attrwin.css"
    ) {
      res.setHeader("Cache-Control", "no-store");
    }
  } catch {}
  next();
});

// ----- STATIC HOSTING

// 1) Editor (ΜΟΝΟ από το local machine, εκτός αν ALLOW_EDITOR_NETWORK=1)
app.use("/app", editorGuard, express.static(path.join(__dirname, "app"), { extensions: ["html"] }));
app.get("/", editorGuard, (_req, res) => {
  res.sendFile(path.join(__dirname, "app", "index.html"));
});

// 2) Viewer assets (ελεύθερα για το δίκτυο)
app.use("/public", express.static(path.join(__dirname, "public")));

// 3) SPA fallback για Viewer: /s/:id → viewer.html (ελεύθερο)
app.get("/s/:id", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "viewer.html"));
});

// ----- API (create/read)
app.post("/api/stories", editorGuard, async (req, res) => {
  try {
    const { state, ttlDays = 7 } = req.body || {};
    if (!state || !Array.isArray(state.layers)) {
      return res.status(400).json({ error: "Invalid state: expected { layers: [] }" });
    }
    if (state.layers.length === 0) {
      return res.status(400).json({ error: "No layers to publish" });
    }
    if (state.layers.length > 3) {
      return res.status(400).json({ error: "Max 3 layers (free)" });
    }

    const raw = JSON.stringify(state);
    const id = slug(7);
    const created = now();
    const expires = created + Number(ttlDays) * 86400;

    await db.run(
      `INSERT INTO stories (id, created_at, expires_at, title, state_json)
       VALUES (?, ?, ?, ?, ?)`,
      [id, created, expires, state.title || "Untitled", raw]
    );

    return res.json({ id, url: `/s/${id}`, expires_at: expires });
  } catch (err) {
    console.error("POST /api/stories error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/stories/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const row = await db.get(`SELECT * FROM stories WHERE id = ?`, [id]);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.expires_at && row.expires_at < now()) {
      return res.status(410).json({ error: "Expired" });
    }
    res.setHeader("Cache-Control", "public, max-age=900");
    return res.json({ id: row.id, title: row.title, state: JSON.parse(row.state_json) });
  } catch (err) {
    console.error("GET /api/stories/:id error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ----- start
app.listen(PORT, HOST, () => {
  console.log(`✅ Server running at http://${HOST}:${PORT}`);
  console.log(
    ALLOW_EDITOR_NETWORK
      ? "⚠️ Editor/API is accessible on the network (ALLOW_EDITOR_NETWORK=1)."
      : "🔒 Editor/API is locked to localhost (only you on this PC)."
  );
});
