// ============================================================
//  S0NAR — IRON DOME v12.0
//  4 Algorithms. DexScreener only. No WebSockets. No complexity.
//
//  THE ONE FIX: DexScreener 429 backoff.
//  When we get a 429 we back off for 60s and use cached data.
//  We poll ONE query at a time, staggered. Never concurrent.
//  This is what was killing us — the 429 ban made us blind.
//
//  ALGO A — WAVE:    10-180min, FOMO 10-80, broad momentum entry
//  ALGO B — SURGE:   3-480min,  FOMO 15-85, volume spike focus
//  ALGO C — STEADY:  10-300min, FOMO 0-60,  quiet accumulation
//  ALGO D — ROCKET:  3-150min,  FOMO 15-88, fast in fast out
// ============================================================

const express  = require("express");
const cors     = require("cors");
const fetch    = require("node-fetch");
const { Pool } = require("pg");
const path     = require("path");
const crypto   = require("crypto");
const fs       = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

// ── DATABASE ───────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,                // Hard cap — prevents connection pile-up that killed Render
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

async function db(sql, params = []) {
  const c = await pool.connect();
  try {
    const r = await c.query(sql, params);
    sysStatus.database.ok     = true;
    sysStatus.database.lastAt = new Date().toISOString();
    sysStatus.database.err    = null;
    return r;
  } catch (e) {
    sysStatus.database.ok  = false;
    sysStatus.database.err = e.message;
    sysErr("database", e.message);
    throw e;
  } finally { c.release(); }
}

// ── SCHEMA ─────────────────────────────────────────────────
const TRADE_COLS = `
  id SERIAL PRIMARY KEY,
  ticker TEXT, name TEXT,
  pair_address TEXT, dex_url TEXT,
  score INTEGER, entry_price NUMERIC,
  bet_size NUMERIC DEFAULT 25,
  status TEXT DEFAULT 'OPEN',
  exit_mult NUMERIC, highest_mult NUMERIC DEFAULT 1.0,
  pnl NUMERIC, exit_reason TEXT,
  vol_5m NUMERIC, vol_1h NUMERIC, liq NUMERIC, pc_5m NUMERIC,
  buys_5m INTEGER, sells_5m INTEGER,
  boosted BOOLEAN DEFAULT FALSE,
  market_mood TEXT, age_min NUMERIC DEFAULT 0,
  fomo_score INTEGER DEFAULT 0,
  stealth_score INTEGER DEFAULT 0,
  is_stealth BOOLEAN DEFAULT FALSE,
  rug_score INTEGER DEFAULT 0,
  algo TEXT,
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  exit_fomo INTEGER DEFAULT 0,
  exit_liq NUMERIC DEFAULT 0,
  exit_vol_5m NUMERIC DEFAULT 0,
  exit_pc_5m NUMERIC DEFAULT 0,
  exit_buys_5m INTEGER DEFAULT 0,
  exit_sells_5m INTEGER DEFAULT 0,
  hold_minutes NUMERIC DEFAULT 0
`;

const SIGNAL_COLS = `
  id SERIAL PRIMARY KEY,
  ticker TEXT, pair_address TEXT, dex_url TEXT,
  score INTEGER, price NUMERIC,
  vol_5m NUMERIC, liq NUMERIC, pc_5m NUMERIC,
  boosted BOOLEAN DEFAULT FALSE,
  entered BOOLEAN DEFAULT FALSE,
  skip_reason TEXT, market_mood TEXT,
  age_min NUMERIC DEFAULT 0,
  fomo_score INTEGER DEFAULT 0,
  algo TEXT,
  seen_at TIMESTAMPTZ DEFAULT NOW()
`;

const ALGO_KEYS = ["a", "b", "c", "d"];

async function initDB() {
  for (const k of ALGO_KEYS) {
    await db(`CREATE TABLE IF NOT EXISTS trades_${k} (${TRADE_COLS})`);
    await db(`CREATE TABLE IF NOT EXISTS signals_${k} (${SIGNAL_COLS})`);
    await db(`CREATE INDEX IF NOT EXISTS idx_tr_${k}_status ON trades_${k}(status)`);
    await db(`CREATE INDEX IF NOT EXISTS idx_tr_${k}_opened ON trades_${k}(opened_at DESC)`);
    await db(`CREATE INDEX IF NOT EXISTS idx_tr_${k}_ticker ON trades_${k}(ticker, opened_at DESC)`);
    await db(`CREATE INDEX IF NOT EXISTS idx_sig_${k}_seen  ON signals_${k}(seen_at DESC)`);
    // Safe migrations — add columns if they don't exist
    await pool.query(`ALTER TABLE trades_${k} ADD COLUMN IF NOT EXISTS rug_score INTEGER DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE trades_${k} ADD COLUMN IF NOT EXISTS exit_fomo INTEGER DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE trades_${k} ADD COLUMN IF NOT EXISTS exit_liq NUMERIC DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE trades_${k} ADD COLUMN IF NOT EXISTS exit_vol_5m NUMERIC DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE trades_${k} ADD COLUMN IF NOT EXISTS exit_pc_5m NUMERIC DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE trades_${k} ADD COLUMN IF NOT EXISTS exit_buys_5m INTEGER DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE trades_${k} ADD COLUMN IF NOT EXISTS exit_sells_5m INTEGER DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE trades_${k} ADD COLUMN IF NOT EXISTS hold_minutes NUMERIC DEFAULT 0`).catch(() => {});
  }
  console.log("DB ready — v12.0 (exit snapshots enabled)");
}

// ── AUTH ───────────────────────────────────────────────────
const PORT     = process.env.PORT || 3000;
const APP_PASS = process.env.APP_PASSWORD || "sonar2024";
const SECRET   = process.env.SESSION_SECRET || "sonar-secret-key";

function makeToken(pw) {
  return crypto.createHmac("sha256", SECRET).update(pw).digest("hex");
}
const VALID_TOKEN = makeToken(APP_PASS);

function authMiddleware(req, res, next) {
  if (req.path === "/health" || req.path === "/api/login") return next();
  if (!req.path.startsWith("/api/") && req.path !== "/") return next();
  const token = req.headers["x-auth-token"] || req.query.token;
  if (token === VALID_TOKEN) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
  next();
}
app.use(authMiddleware);

app.post("/api/login", (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Password required" });
  if (password !== APP_PASS) return res.status(401).json({ error: "Wrong password" });
  res.json({ token: VALID_TOKEN, ok: true });
});

const STATIC_DIR = path.join(__dirname, "dist");
const hasDist    = fs.existsSync(path.join(STATIC_DIR, "index.html"));
if (hasDist) {
  app.use(express.static(STATIC_DIR));
  console.log("Serving frontend from dist/");
}

// ── ALGO CONFIGS ───────────────────────────────────────────
const ALGOS = {
  a: {
    name: "WAVE",
    desc: "Broad momentum — coins 10-180min with building FOMO. Early in the move.",
    color: "#00e5ff",
    minScore: 38, maxScore: 99,
    minFomo: 10,  maxFomo: 80,
    minLiq: 5000, minVol5m: 150, minBuyPct: 50,
    minAge: 10,   maxAge: 180,
    minPc5m: -5,  maxPc5m: 80,
    baseBet: 50,
    stopLoss: 0.84, earlyStop: 0.88, earlyStopMinutes: 5,
    trailingPct: 0.85, trailingActivateMin: 20,
    tier1: 1.35, tier1Sell: 0.60,
    tier2: 1.80, tier2Sell: 0.30,
    tier3: 3.00, maxHold: 45,
  },
  b: {
    name: "SURGE",
    desc: "Volume spike on any age — abnormal activity, get in fast.",
    color: "#ff6d00",
    minScore: 38, maxScore: 99,
    minFomo: 15,  maxFomo: 85,
    minLiq: 5000, minVol5m: 150, minBuyPct: 50,
    minAge: 3,    maxAge: 480,
    minPc5m: -5,  maxPc5m: 85,
    baseBet: 35,
    // Tightened stop 0.82→0.87 and early stop 0.86→0.90 — cuts losses faster
    // Avg loss was $10.27 vs avg win $4.69 — this closes that gap
    stopLoss: 0.87, earlyStop: 0.91, earlyStopMinutes: 5,
    trailingPct: 0.84, trailingActivateMin: 15,
    tier1: 1.30, tier1Sell: 0.65,
    tier2: 1.70, tier2Sell: 0.25,
    tier3: 2.50, maxHold: 30,
  },
  c: {
    name: "STEADY",
    desc: "High liq, low FOMO, quiet price — slow build before retail notices.",
    color: "#69f0ae",
    minScore: 38, maxScore: 88,
    minFomo: 0,   maxFomo: 60,
    minLiq: 8000, minVol5m: 100, minBuyPct: 48,
    minAge: 10,   maxAge: 300,
    minPc5m: -10, maxPc5m: 30,
    baseBet: 55,
    stopLoss: 0.82, earlyStop: 0.87, earlyStopMinutes: 10,
    trailingPct: 0.84, trailingActivateMin: 30,
    tier1: 1.30, tier1Sell: 0.40,
    tier2: 2.20, tier2Sell: 0.35,
    tier3: 4.50, maxHold: 120,
  },
  d: {
    name: "ROCKET",
    desc: "High FOMO, fast momentum — jump on early, exit before gravity.",
    color: "#ff1744",
    minScore: 38, maxScore: 99,
    minFomo: 15,  maxFomo: 88,
    minLiq: 5000, minVol5m: 150, minBuyPct: 50,
    minAge: 3,    maxAge: 150,
    minPc5m: -5,  maxPc5m: 100,
    baseBet: 35,
    stopLoss: 0.80, earlyStop: 0.85, earlyStopMinutes: 3,
    trailingPct: 0.83, trailingActivateMin: 10,
    tier1: 1.25, tier1Sell: 0.70,
    tier2: 1.60, tier2Sell: 0.20,
    tier3: 2.50, maxHold: 25,
  },
};

const DAILY_LIMIT = 200; // Circuit break per algo per day
const FETCH_MS    = 45000; // Poll every 45s — slow enough to avoid 429 bans
const CHECK_MS    = 25000; // Check positions every 25s

// ── RUNTIME STATE ──────────────────────────────────────────
let mood      = "normal";
let pollCount = 0;
let qi        = 0;

// 429 backoff state
let dexBackoffUntil = 0;      // epoch ms — don't call DexScreener until this time
let dexBackoffCount = 0;      // consecutive 429s
const DEX_BACKOFF_BASE = 60000; // 60s base backoff
const DEX_BACKOFF_MAX  = 300000; // 5 min max backoff

const algoState = {
  a: { dailyPnl: 0, circuitBroken: false, circuitAt: null },
  b: { dailyPnl: 0, circuitBroken: false, circuitAt: null },
  c: { dailyPnl: 0, circuitBroken: false, circuitAt: null },
  d: { dailyPnl: 0, circuitBroken: false, circuitAt: null },
};

class LRUMap {
  constructor(max) { this.max = max; this.map = new Map(); }
  has(k) { return this.map.has(k); }
  get(k) {
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    else if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(k, v);
  }
}

const volHistory        = new LRUMap(5000);
const fomoHistory       = new LRUMap(5000);
const rugCache          = new LRUMap(2000);
const fomoFadeCounter   = new Map();
const delistMissCounter = new Map();
const crossAlgoExposure = new Map();

// Last known good pairs — used when 429'd
const pairCache = new LRUMap(500);

// ── SYSTEM STATUS ──────────────────────────────────────────
const sysStatus = {
  dexscreener: { ok: null, lastMs: null, lastAt: null, err: null, backoffUntil: null },
  rugcheck:    { ok: null, lastMs: null, lastAt: null, err: null },
  database:    { ok: null, lastAt: null, err: null },
  lastErrors:  [],
  rugLog:      [],
  funnel: {
    a: { seen: 0, gate: 0, rugPass: 0, entered: 0 },
    b: { seen: 0, gate: 0, rugPass: 0, entered: 0 },
    c: { seen: 0, gate: 0, rugPass: 0, entered: 0 },
    d: { seen: 0, gate: 0, rugPass: 0, entered: 0 },
  },
};

function sysErr(source, msg) {
  const entry = { source, msg, at: new Date().toISOString() };
  sysStatus.lastErrors.unshift(entry);
  if (sysStatus.lastErrors.length > 20) sysStatus.lastErrors.pop();
}

// ── DEXSCREENER — with 429 backoff ────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));

function dex429Hit() {
  dexBackoffCount++;
  const backoff = Math.min(DEX_BACKOFF_BASE * dexBackoffCount, DEX_BACKOFF_MAX);
  dexBackoffUntil = Date.now() + backoff;
  sysStatus.dexscreener.backoffUntil = new Date(dexBackoffUntil).toISOString();
  sysStatus.dexscreener.ok  = false;
  sysStatus.dexscreener.err = `429 — backing off ${Math.round(backoff/1000)}s (hit #${dexBackoffCount})`;
  sysErr("dexscreener", `HTTP 429 — backoff ${Math.round(backoff/1000)}s`);
  console.log(`[429] DexScreener rate limited — backoff ${Math.round(backoff/1000)}s (hit #${dexBackoffCount})`);
}

function dexOkHit() {
  dexBackoffCount = Math.max(0, dexBackoffCount - 1); // Slowly recover
  dexBackoffUntil = 0;
  sysStatus.dexscreener.ok           = true;
  sysStatus.dexscreener.err          = null;
  sysStatus.dexscreener.backoffUntil = null;
}

function dexIsBlocked() {
  return Date.now() < dexBackoffUntil;
}

async function dexSearch(q) {
  if (dexIsBlocked()) return [];
  const t0 = Date.now();
  try {
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
      { timeout: 10000 }
    );
    sysStatus.dexscreener.lastMs = Date.now() - t0;
    sysStatus.dexscreener.lastAt = new Date().toISOString();
    if (r.status === 429) { dex429Hit(); return []; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    dexOkHit();
    return (d?.pairs || []).filter(p => p.chainId === "solana" && parseFloat(p.priceUsd || 0) > 0);
  } catch (e) {
    sysStatus.dexscreener.ok  = false;
    sysStatus.dexscreener.err = e.message;
    sysErr("dexscreener", e.message);
    return [];
  }
}

async function dexBoosted() {
  if (dexIsBlocked()) return [];
  try {
    const r = await fetch("https://api.dexscreener.com/token-boosts/latest/v1", { timeout: 10000 });
    if (r.status === 429) { dex429Hit(); return []; }
    if (!r.ok) return [];
    const d = await r.json();
    dexOkHit();
    return (d || []).filter(t => t.chainId === "solana").slice(0, 20);
  } catch (e) { return []; }
}

async function dexPairs(addresses) {
  if (!addresses.length) return [];
  if (dexIsBlocked()) {
    // Return cached data if we have it
    return addresses.map(a => pairCache.get(a)).filter(Boolean);
  }
  const results = [];
  for (let i = 0; i < addresses.length; i += 10) {
    const chunk = addresses.slice(i, i + 10);
    try {
      const r = await fetch(
        `https://api.dexscreener.com/latest/dex/pairs/solana/${chunk.join(",")}`,
        { timeout: 10000 }
      );
      if (r.status === 429) { dex429Hit(); break; }
      if (!r.ok) continue;
      const d = await r.json();
      const pairs = (d?.pairs || []).filter(p => parseFloat(p.priceUsd || 0) > 0);
      pairs.forEach(p => pairCache.set(p.pairAddress, p)); // Cache for backoff
      results.push(...pairs);
      dexOkHit();
    } catch (e) { continue; }
    if (i + 10 < addresses.length) await delay(300); // Space chunks
  }
  return results;
}

async function dexPair(address) {
  if (pairCache.has(address) && dexIsBlocked()) return pairCache.get(address);
  const ps = await dexPairs([address]);
  return ps[0] || null;
}

// ── RUGCHECK ───────────────────────────────────────────────
async function checkRugcheck(tokenAddress) {
  if (!tokenAddress) return { score: 0, flags: [], pass: true, apiStatus: "no_address" };
  if (rugCache.has(tokenAddress)) return rugCache.get(tokenAddress);

  const t0 = Date.now();
  try {
    const r = await fetch(
      `https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report/summary`,
      { timeout: 6000 }
    );
    sysStatus.rugcheck.lastMs = Date.now() - t0;
    sysStatus.rugcheck.lastAt = new Date().toISOString();

    if (!r.ok) {
      sysStatus.rugcheck.ok  = false;
      sysStatus.rugcheck.err = `HTTP ${r.status}`;
      sysErr("rugcheck", `HTTP ${r.status}`);
      return { score: 0, flags: [], pass: true, apiStatus: `http_${r.status}` };
    }

    const d     = await r.json();
    const score = d?.score || 0;

    if (score === 0 && !d?.topHolders?.length && !d?.markets?.length) {
      return { score: 0, flags: [], pass: true, apiStatus: "empty" };
    }

    sysStatus.rugcheck.ok  = true;
    sysStatus.rugcheck.err = null;

    const flags = [];
    if (d?.mintAuthority)   flags.push("mint_authority");
    if (d?.freezeAuthority) flags.push("freeze_authority");
    if (d?.mutable)         flags.push("mutable_metadata");

    const markets = d?.markets || [];
    let anyLocked = false, anyUnlocked = false;
    for (const m of markets) {
      const lp = m?.lp || {};
      if (lp.lpBurned || (lp.lpLockedPct || 0) >= 80) anyLocked = true;
      else anyUnlocked = true;
    }
    if (markets.length > 0 && anyUnlocked && !anyLocked) flags.push("lp_unlocked");

    const top1  = d?.topHolders?.[0]?.pct || 0;
    const top10 = (d?.topHolders || []).slice(0, 10).reduce((s, h) => s + (h.pct || 0), 0);
    if (top1  > 30) flags.push(`top1_${Math.round(top1)}pct`);
    if (top10 > 80) flags.push(`top10_${Math.round(top10)}pct`);

    const hardFlags = ["mint_authority", "freeze_authority", "lp_unlocked"];
    const pass      = !flags.some(f => hardFlags.includes(f));

    const result = { score, flags, pass, top10: Math.round(top10), apiStatus: "ok" };
    rugCache.set(tokenAddress, result);

    sysStatus.rugLog.unshift({ addr: tokenAddress.slice(0, 12), pass, flags, score, at: new Date().toISOString() });
    if (sysStatus.rugLog.length > 20) sysStatus.rugLog.pop();

    return result;
  } catch (e) {
    sysStatus.rugcheck.ok  = false;
    sysStatus.rugcheck.err = e.message;
    sysErr("rugcheck", e.message);
    return { score: 0, flags: [], pass: true, apiStatus: "timeout" };
  }
}

// ── SCORING ────────────────────────────────────────────────
function getZScore(addr, vol) {
  if (!volHistory.has(addr)) volHistory.set(addr, []);
  const h = volHistory.get(addr);
  h.push(vol);
  if (h.length > 20) h.shift();
  if (h.length < 3) return 0;
  const mean = h.reduce((a, b) => a + b, 0) / h.length;
  const std  = Math.sqrt(h.reduce((a, b) => a + (b - mean) ** 2, 0) / h.length);
  return std === 0 ? 0 : (vol - mean) / std;
}

function calcFomoScore(p) {
  const liq = p.liquidity?.usd || 0;
  const raw = calcRawFomo(p);
  return liq < 500 ? Math.min(30, raw) : raw;
}

function calcRawFomo(p) {
  const v5   = p.volume?.m5   || 0;
  const v1   = p.volume?.h1   || 0.001;
  const pc5  = parseFloat(p.priceChange?.m5 || 0);
  const pc1  = parseFloat(p.priceChange?.h1 || 0);
  const b    = p.txns?.m5?.buys  || 0;
  const s    = p.txns?.m5?.sells || 0;
  const liq  = p.liquidity?.usd  || 0;
  const age  = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : 999;
  const bst  = (p.boosts?.active || 0) > 0;
  const addr = p.pairAddress;
  let fomo = 0;

  fomo += Math.min(35, v1 > 0 ? (v5 / (v1 / 12)) * 10 : 0);

  if (pc5 >  5 && pc5 <= 15) fomo += 20;
  if (pc5 > 15 && pc5 <= 30) fomo += 12;
  if (pc5 > 30 && pc5 <= 60) fomo +=  5;
  if (pc5 > 60 && pc5 <= 100) fomo += 3;
  if (pc5 > 100)               fomo += 1;
  if (pc5 <  0)               fomo -=  5;

  const total = b + s;
  if (total > 10) {
    const br = b / total;
    if      (br > 0.75) fomo += 18;
    else if (br > 0.65) fomo += 12;
    else if (br > 0.55) fomo +=  6;
  }

  if (age >=  3 && age <  10) fomo += 15;
  if (age >= 10 && age <  30) fomo += 20;
  if (age >= 30 && age <  60) fomo += 10;
  if (age >= 60 && age < 120) fomo +=  3;
  if (age >= 120)              fomo -= 10;

  if (pc1 >   0 && pc1 < 100) fomo +=  8;
  if (pc1 >= 100)              fomo +=  3;
  if (pc1 <  -10)              fomo -=  8;

  if (liq >= 500 && v5 > 0) {
    const vlr = v5 / liq;
    if (vlr > 0.5 && vlr < 5) fomo += 8;
    if (vlr >= 5)              fomo += 3;
  }

  const z = getZScore(addr, v5);
  if      (z > 2) fomo += 15;
  else if (z > 1) fomo +=  8;
  else if (z > 0) fomo +=  3;

  if (bst) fomo += 10;

  if (fomoHistory.has(addr)) {
    const prev  = fomoHistory.get(addr);
    const delta = fomo - prev;
    if (delta >  10) fomo += 8;
    if (delta < -15) fomo -= 5;
  }

  const result = Math.round(Math.max(0, Math.min(99, fomo)));
  fomoHistory.set(addr, result);
  return result;
}

function calcQualityScore(p) {
  const v5  = p.volume?.m5  || 0;
  const v1  = p.volume?.h1  || 1;
  const pc5 = parseFloat(p.priceChange?.m5 || 0);
  const pc1 = parseFloat(p.priceChange?.h1 || 0);
  const liq = p.liquidity?.usd || 0;
  const b   = p.txns?.m5?.buys  || 0;
  const s   = p.txns?.m5?.sells || 1;
  const bst = (p.boosts?.active || 0) > 0;
  const age = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : 999;
  const z   = getZScore(p.pairAddress, v5);

  let sc = 0;
  sc += Math.min(100, (v5 / Math.max(v1 / 12, 1)) * 100) * 0.28;
  sc += Math.min(100, Math.max(0, (pc5 + 30) / 1.3))     * 0.18;
  sc += (liq > 100000 ? 100 : liq > 50000 ? 85 : liq > 20000 ? 65 : liq > 5000 ? 45 : liq > 1000 ? 25 : 5) * 0.14;
  sc += Math.min(100, (b / (b + s)) * 100) * 0.15;
  sc += Math.min(15, Math.max(0, z * 5));
  sc += age < 10 ? 18 : age < 20 ? 14 : age < 40 ? 10 : age < 60 ? 5 : age >= 120 ? -8 : 0;
  sc += pc1 > 30 ? 10 : pc1 > 10 ? 6 : pc1 < -20 ? -10 : 0;
  if (bst)       sc += 5;
  if (liq < 1500) sc -= 20;
  if (v5  < 100)  sc -=  8;

  return Math.round(Math.max(0, Math.min(99, sc)));
}

function rugCheck(p) {
  const liq = p.liquidity?.usd || 0;
  const v5  = p.volume?.m5    || 0;
  const b   = p.txns?.m5?.buys  || 0;
  const s   = p.txns?.m5?.sells || 0;
  const pc5 = parseFloat(p.priceChange?.m5 || 0);
  const pc1 = parseFloat(p.priceChange?.h1 || 0);
  const age = (Date.now() - (p.pairCreatedAt || Date.now())) / 60000;
  const w   = [];

  if (age < 3)                         w.push(`too_new_${age.toFixed(1)}min`);
  if (v5 > 80000 && liq < 4000)        w.push("vol_liq_mismatch");
  if (s > b * 3)                       w.push("heavy_sell_wall");
  if (liq < 500)                       w.push("thin_liq");
  if (liq < 25000 && pc5 > 30)         w.push("low_liq_high_velocity");
  if (pc5 > 100 && liq < 50000)        w.push("100pct_spike_thin_liq");
  if (pc1 > 300 && liq < 30000)        w.push("already_pumped_300pct");
  if (b > 0 && s > b * 2 && v5 > 1000) w.push("sells_doubling_buys");

  return { pass: w.length === 0, warnings: w };
}

function algoGate(p, sc, fomo, z, algoKey) {
  const cfg = ALGOS[algoKey];
  const liq = p.liquidity?.usd || 0;
  const v5  = p.volume?.m5    || 0;
  const b   = p.txns?.m5?.buys  || 0;
  const s   = p.txns?.m5?.sells || 0;
  const bp  = (b + s) > 0 ? (b / (b + s)) * 100 : 0;
  const pc5 = parseFloat(p.priceChange?.m5 || 0);
  const age = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : -1;
  const ageUnknown = age < 0;

  const checks = {
    score:  { pass: sc >= cfg.minScore && sc <= cfg.maxScore,    why: `score_${sc}_not_in_[${cfg.minScore}-${cfg.maxScore}]` },
    fomo:   { pass: fomo >= cfg.minFomo && fomo <= cfg.maxFomo,  why: `fomo_${fomo}_not_in_[${cfg.minFomo}-${cfg.maxFomo}]` },
    liq:    { pass: liq >= cfg.minLiq,                           why: `liq_$${Math.round(liq)}_<_$${cfg.minLiq}` },
    vol:    { pass: v5 >= cfg.minVol5m,                          why: `vol5m_$${Math.round(v5)}_<_$${cfg.minVol5m}` },
    buys:   { pass: bp >= cfg.minBuyPct,                         why: `buys_${Math.round(bp)}pct_<_${cfg.minBuyPct}pct` },
    pc5min: { pass: pc5 >= cfg.minPc5m,                          why: `pc5_${pc5.toFixed(0)}pct_<_${cfg.minPc5m}pct` },
    pc5max: { pass: pc5 <= cfg.maxPc5m,                          why: `pc5_${pc5.toFixed(0)}pct_>_${cfg.maxPc5m}pct_pumped` },
    ageMin: { pass: ageUnknown || age >= cfg.minAge,             why: `age_${age.toFixed(1)}m_<_${cfg.minAge}m` },
    ageMax: { pass: ageUnknown || age <= cfg.maxAge,             why: `age_${Math.round(age)}m_>_${cfg.maxAge}m` },
    price:  { pass: parseFloat(p.priceUsd || 0) > 0,            why: "no_price" },
  };

  const failed = Object.values(checks).filter(c => !c.pass).map(c => c.why);
  return { pass: failed.length === 0, failed };
}

function betSize(sc, algoKey, liq) {
  const cfg   = ALGOS[algoKey];
  const base  = cfg.baseBet;
  const range = cfg.maxScore - cfg.minScore;
  const pct   = range > 0 ? (sc - cfg.minScore) / range : 0.5;
  const mult  = 0.8 + pct * 0.4;
  const liqCap = liq > 0 ? Math.max(10, liq * 0.001) : 150;
  return Math.min(liqCap, Math.min(150, Math.max(15, Math.round((base * mult) / 5) * 5)));
}

function calcPnL(trade, curPrice) {
  const cfg    = ALGOS[trade.algo];
  if (!cfg) return { status: "OPEN", exit: null, mult: 1, pnl: null, highMult: 1 };
  const mult   = curPrice / parseFloat(trade.entry_price);
  const bet    = parseFloat(trade.bet_size);
  const ageMin = (Date.now() - new Date(trade.opened_at).getTime()) / 60000;
  const hi     = Math.max(parseFloat(trade.highest_mult || 1), mult);
  const s1     = cfg.tier1Sell, s2 = cfg.tier2Sell, s3 = 1 - s1 - s2;

  if (mult <= cfg.earlyStop && ageMin < cfg.earlyStopMinutes) {
    return { status: "CLOSED", exit: "EARLY_STOP", mult, pnl: +(bet * (mult - 1)).toFixed(2), highMult: hi };
  }
  if (mult <= cfg.stopLoss) {
    return { status: "CLOSED", exit: "STOP_LOSS", mult, pnl: +(bet * (mult - 1)).toFixed(2), highMult: hi };
  }
  if (mult >= cfg.tier3) {
    const pnl = (bet * s1 * (cfg.tier1 - 1)) + (bet * s2 * (cfg.tier2 - 1)) + (bet * s3 * (mult - 1));
    return { status: "CLOSED", exit: "TIER3", mult, pnl: +pnl.toFixed(2), highMult: hi };
  }
  if (mult >= cfg.tier2) {
    const pnl = (bet * s1 * (cfg.tier1 - 1)) + (bet * s2 * (mult - 1)) + (bet * s3 * (mult - 1));
    return { status: "CLOSED", exit: "TIER2", mult, pnl: +pnl.toFixed(2), highMult: hi };
  }
  // Trailing only fires BELOW tier1 — once past tier1 let the tier targets do the work
  if (ageMin >= cfg.trailingActivateMin && hi > 1.2 && mult < cfg.tier1 && mult <= hi * cfg.trailingPct) {
    return { status: "CLOSED", exit: "TRAILING_STOP", mult, pnl: +(bet * (mult - 1)).toFixed(2), highMult: hi };
  }
  if (mult >= cfg.tier1 && ageMin >= 5) {
    return { status: "OPEN", exit: null, mult, pnl: null, highMult: hi };
  }
  if (ageMin >= cfg.maxHold) {
    return { status: "CLOSED", exit: mult >= 1 ? "TIME_UP" : "TIME_DOWN", mult, pnl: +(bet * (mult - 1)).toFixed(2), highMult: hi };
  }
  return { status: "OPEN", exit: null, mult, pnl: null, highMult: hi };
}

function checkCircuit(algoKey) {
  const st = algoState[algoKey];
  if (st.circuitAt) {
    const then = new Date(st.circuitAt);
    if (then.toDateString() !== new Date().toDateString()) {
      st.circuitBroken = false; st.circuitAt = null; st.dailyPnl = 0;
    }
  }
  if (st.dailyPnl <= -DAILY_LIMIT && !st.circuitBroken) {
    st.circuitBroken = true;
    st.circuitAt     = new Date().toISOString();
    console.log(`[CIRCUIT] ${algoKey.toUpperCase()} down $${Math.abs(st.dailyPnl).toFixed(2)} — pausing entries`);
  }
}

// ── DB HELPERS ─────────────────────────────────────────────
async function getOpen(algoKey) {
  const r = await db(`SELECT * FROM trades_${algoKey} WHERE status='OPEN' ORDER BY opened_at DESC`);
  return r.rows;
}

async function hadTrade(algoKey, pairAddr, ticker, name) {
  const byAddr = await db(
    `SELECT id FROM trades_${algoKey} WHERE pair_address=$1 AND status='OPEN' LIMIT 1`,
    [pairAddr]
  );
  if (byAddr.rows.length) return true;

  // 30 min cooldown per ticker (was 90 — re-pumps now catchable after 30min)
  const byTicker = await db(
    `SELECT id FROM trades_${algoKey} WHERE LOWER(ticker)=LOWER($1) AND opened_at>NOW()-INTERVAL '30 minutes' LIMIT 1`,
    [ticker]
  );
  if (byTicker.rows.length) return true;

  // Name match removed — too broad, blocked unrelated tokens sharing common words
  return false;
}

async function insertTrade(algoKey, p, sc, fomo, rugScore) {
  const liq      = p.liquidity?.usd || 0;
  const bet      = betSize(sc, algoKey, liq);
  const age      = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : 0;
  const tokenAddr = p.baseToken?.address || p.pairAddress;

  const r = await db(
    `INSERT INTO trades_${algoKey}
       (ticker, name, pair_address, dex_url, score, entry_price, bet_size,
        status, highest_mult,
        vol_5m, vol_1h, liq, pc_5m, buys_5m, sells_5m,
        boosted, market_mood, age_min, fomo_score,
        stealth_score, is_stealth, rug_score, algo, opened_at)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7,
        'OPEN',1.0,
        $8,$9,$10,$11,$12,$13,
        $14,$15,$16,$17,
        0,false,$18,$19,NOW())
     RETURNING *`,
    [
      p.baseToken?.symbol || "???",
      p.baseToken?.name   || "",
      p.pairAddress,
      p.url || "",
      sc,
      parseFloat(p.priceUsd),
      bet,
      p.volume?.m5      || 0,
      p.volume?.h1      || 0,
      liq,
      parseFloat(p.priceChange?.m5 || 0),
      p.txns?.m5?.buys  || 0,
      p.txns?.m5?.sells || 0,
      (p.boosts?.active || 0) > 0,
      mood,
      parseFloat(age.toFixed(1)),
      fomo,
      rugScore || 0,
      algoKey,
    ]
  );

  if (r.rows[0]) {
    if (!crossAlgoExposure.has(tokenAddr)) crossAlgoExposure.set(tokenAddr, new Set());
    crossAlgoExposure.get(tokenAddr).add(algoKey);
  }
  return r.rows[0];
}

async function closeTrade(algoKey, id, res, snap = {}) {
  const holdMin = snap.openedAt
    ? +((Date.now() - new Date(snap.openedAt).getTime()) / 60000).toFixed(1)
    : 0;
  await db(
    `UPDATE trades_${algoKey}
     SET status='CLOSED', exit_mult=$1, highest_mult=$2, pnl=$3, exit_reason=$4, closed_at=NOW(),
         exit_fomo=$5, exit_liq=$6, exit_vol_5m=$7, exit_pc_5m=$8,
         exit_buys_5m=$9, exit_sells_5m=$10, hold_minutes=$11
     WHERE id=$12`,
    [
      res.mult, res.highMult, res.pnl, res.exit,
      snap.fomo    || 0,
      snap.liq     || 0,
      snap.vol5m   || 0,
      snap.pc5m    || 0,
      snap.buys5m  || 0,
      snap.sells5m || 0,
      holdMin,
      id,
    ]
  );
  try {
    const row = (await db(`SELECT pair_address FROM trades_${algoKey} WHERE id=$1`, [id])).rows[0];
    if (row) {
      const key = row.pair_address;
      if (crossAlgoExposure.has(key)) {
        crossAlgoExposure.get(key).delete(algoKey);
        if (crossAlgoExposure.get(key).size === 0) crossAlgoExposure.delete(key);
      }
    }
  } catch (e) {}
}

async function logSig(algoKey, p, sc, fomo, entered, skipReason) {
  const age = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : 0;
  await db(
    `INSERT INTO signals_${algoKey}
       (ticker, pair_address, dex_url, score, price,
        vol_5m, liq, pc_5m, boosted,
        entered, skip_reason, market_mood,
        age_min, fomo_score, algo, seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())`,
    [
      p.baseToken?.symbol || "???",
      p.pairAddress, p.url || "", sc,
      parseFloat(p.priceUsd || 0),
      p.volume?.m5 || 0, p.liquidity?.usd || 0,
      parseFloat(p.priceChange?.m5 || 0),
      (p.boosts?.active || 0) > 0,
      entered, skipReason || null, mood,
      parseFloat(age.toFixed(1)), fomo, algoKey,
    ]
  ).catch(() => {});
}

// ── SEARCH QUERIES ─────────────────────────────────────────
const QUERIES = [
  "pump.fun", "pumpfun", "pump fun sol",
  "dog sol", "cat sol", "frog sol", "pepe sol", "doge sol",
  "hamster sol", "bear sol", "bull sol", "wolf sol", "ape sol", "crab sol",
  "based sol", "wagmi sol", "moon sol", "gem sol",
  "ai sol", "gpt sol", "robot sol", "neural sol",
  "solana meme", "sol token", "new sol", "launch sol",
  "raydium new", "sol gem", "100x sol", "sol launch",
];

// ── POLL SIGNALS ───────────────────────────────────────────
async function pollSignals() {
  pollCount++;

  if (dexIsBlocked()) {
    const secsLeft = Math.round((dexBackoffUntil - Date.now()) / 1000);
    console.log(`[POLL #${pollCount}] DexScreener blocked — ${secsLeft}s remaining`);
    return;
  }

  console.log(`[POLL #${pollCount}] ${new Date().toISOString()} mood:${mood}`);

  try {
    // ONE query at a time, staggered — this is what stops 429s
    const q0 = QUERIES[qi % QUERIES.length]; qi++;
    const q1 = QUERIES[qi % QUERIES.length]; qi++;

    const r1 = await dexSearch(q0);
    if (dexIsBlocked()) return; // 429 hit mid-poll, abort
    await delay(1000);          // 1s between each search call

    const r2 = await dexSearch(q1);
    if (dexIsBlocked()) { processAll(r1, []); return; }
    await delay(1000);

    const boostedTokens = await dexBoosted();
    let boostedPairs = [];
    if (boostedTokens.length && !dexIsBlocked()) {
      const addrs = boostedTokens.map(t => t.tokenAddress).filter(Boolean);
      boostedPairs = await dexPairs(addrs).catch(() => []);
    }

    await processAll([...r1, ...r2], boostedPairs);

  } catch (e) { console.error("pollSignals:", e.message); }
}

async function processAll(searchPairs, boostedPairs) {
  const seenAddrs = new Set();
  const all = [];
  for (const p of [...searchPairs, ...boostedPairs]) {
    if (!p.pairAddress || seenAddrs.has(p.pairAddress)) continue;
    seenAddrs.add(p.pairAddress);
    pairCache.set(p.pairAddress, p); // Cache every pair we see
    all.push(p);
  }

  console.log(`  search:${searchPairs.length} boosted:${boostedPairs.length} unique:${all.length}`);

  const scored = all.map(p => ({
    p, sc: calcQualityScore(p), fomo: calcFomoScore(p),
    z: getZScore(p.pairAddress, p.volume?.m5 || 0), rug: rugCheck(p),
  }));

  const entries = { a: 0, b: 0, c: 0, d: 0 };

  for (const algoKey of ALGO_KEYS) {
    checkCircuit(algoKey);
    if (algoState[algoKey].circuitBroken) continue;

    for (const { p, sc, fomo, z, rug } of scored) {
      if (sc < 38 || (p.liquidity?.usd || 0) < 500) continue;

      const gate = algoGate(p, sc, fomo, z, algoKey);
      sysStatus.funnel[algoKey].seen++;

      if (!gate.pass || !rug.pass) {
        await logSig(algoKey, p, sc, fomo, false, !gate.pass ? gate.failed.join("; ") : rug.warnings.join("; "));
        continue;
      }

      sysStatus.funnel[algoKey].gate++;

      const already = await hadTrade(algoKey, p.pairAddress, p.baseToken?.symbol || "???", p.baseToken?.name || "");
      if (already) { await logSig(algoKey, p, sc, fomo, false, "already_traded"); continue; }

      const tokenKey = p.baseToken?.address || p.pairAddress;
      const existing = crossAlgoExposure.get(tokenKey);
      if (existing && existing.size >= 2 && !existing.has(algoKey)) {
        await logSig(algoKey, p, sc, fomo, false, "cross_algo_limit");
        continue;
      }

      const rugResult = p.baseToken?.address
        ? await checkRugcheck(p.baseToken.address)
        : { score: 0, flags: [], pass: true, apiStatus: "no_mint" };

      if (!rugResult.pass) {
        await logSig(algoKey, p, sc, fomo, false, `rug:[${rugResult.flags.join(",")}]`);
        continue;
      }

      sysStatus.funnel[algoKey].rugPass++;

      const trade = await insertTrade(algoKey, p, sc, fomo, rugResult.score).catch(e => {
        if (!e.message.toLowerCase().includes("unique") && !e.message.toLowerCase().includes("duplicate")) {
          console.error(`insertTrade-${algoKey}:`, e.message);
        }
        return null;
      });

      if (trade) {
        await logSig(algoKey, p, sc, fomo, true, null);
        sysStatus.funnel[algoKey].entered++;
        entries[algoKey]++;
        const age = p.pairCreatedAt ? ((Date.now() - p.pairCreatedAt) / 60000).toFixed(0) : "?";
        console.log(`  [${algoKey.toUpperCase()}] ENTERED ${p.baseToken?.symbol} sc:${sc} fomo:${fomo} age:${age}m bet:$${trade.bet_size}`);
      }
    }
  }
  console.log(`  entries A:${entries.a} B:${entries.b} C:${entries.c} D:${entries.d}`);
}

// ── CHECK POSITIONS ────────────────────────────────────────
async function checkPositions() {
  for (const algoKey of ALGO_KEYS) {
    try {
      const open = await getOpen(algoKey);
      if (!open.length) continue;

      const addrs   = open.map(t => t.pair_address);
      const pairs   = await dexPairs(addrs).catch(() => []);
      const pairMap = new Map(pairs.map(p => [p.pairAddress, p]));

      for (const trade of open) {
        try {
          const st   = algoState[algoKey];
          const pair = pairMap.get(trade.pair_address) || await dexPair(trade.pair_address).catch(() => null);

          if (!pair) {
            const ageMin = (Date.now() - new Date(trade.opened_at).getTime()) / 60000;
            if (ageMin > 3) {
              const missKey = `${algoKey}_${trade.id}`;
              const misses  = (delistMissCounter.get(missKey) || 0) + 1;
              delistMissCounter.set(missKey, misses);
              if (misses >= 3) {
                delistMissCounter.delete(missKey);
                const pnl = +(parseFloat(trade.bet_size) * -1.0).toFixed(2);
                await closeTrade(algoKey, trade.id, { mult: 0, pnl, exit: "DELISTED", highMult: parseFloat(trade.highest_mult || 1) });
                st.dailyPnl += pnl;
                console.log(`  [${algoKey.toUpperCase()}] DELISTED ${trade.ticker} $${pnl}`);
              }
            }
            continue;
          }

          delistMissCounter.delete(`${algoKey}_${trade.id}`);

          const curPrice  = parseFloat(pair.priceUsd);
          if (!curPrice || curPrice <= 0) continue;

          const res      = calcPnL(trade, curPrice);
          const pct      = ((curPrice / parseFloat(trade.entry_price)) - 1) * 100;
          const curLiq   = pair.liquidity?.usd || 0;
          const entryLiq = parseFloat(trade.liq || 0);
          const curFomo  = calcFomoScore(pair);

          // Exit snapshot — what the market looks like RIGHT NOW at close time
          const snap = {
            fomo:    curFomo,
            liq:     curLiq,
            vol5m:   pair.volume?.m5 || 0,
            pc5m:    parseFloat(pair.priceChange?.m5 || 0),
            buys5m:  pair.txns?.m5?.buys  || 0,
            sells5m: pair.txns?.m5?.sells || 0,
            openedAt: trade.opened_at,
          };

          // Velocity check — detect tokens crashing between poll cycles
          // Tightened from -25% to -15% so we exit before the full rug hits
          const liqCollapse = entryLiq > 5000 && curLiq < entryLiq * 0.35;
          const hardDump    = pct < -15;

          if ((liqCollapse || hardDump) && res.status === "OPEN") {
            const mult   = curPrice / parseFloat(trade.entry_price);
            const rugPnl = +(parseFloat(trade.bet_size) * (mult - 1)).toFixed(2);
            const reason = liqCollapse ? "LIQ_PULLED" : "HARD_DUMP";
            await closeTrade(algoKey, trade.id, { mult, pnl: rugPnl, exit: reason, highMult: Math.max(parseFloat(trade.highest_mult || 1), mult) }, snap);
            st.dailyPnl += rugPnl;
            console.log(`  [${algoKey.toUpperCase()}] ${reason} ${trade.ticker} ${pct.toFixed(0)}% $${rugPnl}`);
            continue;
          }

          if (res.highMult > parseFloat(trade.highest_mult || 1)) {
            await db(`UPDATE trades_${algoKey} SET highest_mult=$1 WHERE id=$2`, [res.highMult, trade.id]);
          }

          if (curFomo < 12 && pct > 5 && res.status === "OPEN") {
            const fadeKey   = `${algoKey}_${trade.id}`;
            const fadeCount = (fomoFadeCounter.get(fadeKey) || 0) + 1;
            fomoFadeCounter.set(fadeKey, fadeCount);
            if (fadeCount >= 2) {
              fomoFadeCounter.delete(fadeKey);
              const mult    = curPrice / parseFloat(trade.entry_price);
              const fadePnl = +(parseFloat(trade.bet_size) * (mult - 1)).toFixed(2);
              await closeTrade(algoKey, trade.id, { mult, pnl: fadePnl, exit: "FOMO_FADE", highMult: res.highMult }, snap);
              st.dailyPnl += fadePnl;
              console.log(`  [${algoKey.toUpperCase()}] FOMO_FADE ${trade.ticker} +${pct.toFixed(0)}% $${fadePnl}`);
            }
            continue;
          } else { fomoFadeCounter.delete(`${algoKey}_${trade.id}`); }

          if (res.status === "CLOSED") {
            await closeTrade(algoKey, trade.id, res, snap);
            st.dailyPnl += res.pnl;
            checkCircuit(algoKey);
            console.log(`  [${algoKey.toUpperCase()}] CLOSED ${trade.ticker} ${res.exit} ${res.pnl >= 0 ? "+" : ""}$${res.pnl.toFixed(2)}`);
          }

        } catch (e) { console.error(`  checkPos [${algoKey}] ${trade.ticker}:`, e.message); }
        await delay(200);
      }
    } catch (e) { console.error(`checkPositions-${algoKey}:`, e.message); }
  }
}

// ── MARKET MOOD ────────────────────────────────────────────
async function updateMood() {
  if (dexIsBlocked()) return;
  try {
    // Sequential — not concurrent. Concurrent calls burn 429 budget.
    const r1 = await dexSearch("solana meme");
    if (dexIsBlocked()) return;
    await delay(1000);
    const r2 = await dexSearch("pump.fun");
    const pairs = [...r1, ...r2].slice(0, 40);
    if (!pairs.length) return;
    const avg = pairs.reduce((a, p) => a + parseFloat(p.priceChange?.m5 || 0), 0) / pairs.length;
    const hot = pairs.filter(p => parseFloat(p.priceChange?.m5 || 0) > 8).length;
    const pct = (hot / pairs.length) * 100;
    if      (avg >  8 && pct >= 60) mood = "frenzy";
    else if (avg >  4 && pct >= 40) mood = "hot";
    else if (avg >  1 && pct >= 25) mood = "warm";
    else if (avg < -8 && pct <  10) mood = "dead";
    else if (avg < -5 && pct <  15) mood = "cold";
    else                             mood = "normal";
    console.log(`[MOOD] ${mood} avg:${avg.toFixed(1)}%`);
  } catch (e) {}
}

async function refreshDaily() {
  try {
    // Get start of current day in EST cleanly — no broken date arithmetic
    const nowEST     = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const startOfDay = new Date(nowEST);
    startOfDay.setHours(0, 0, 0, 0);
    // Convert back to UTC for the DB query
    const offsetMs   = new Date().getTime() - nowEST.getTime();
    const startUTC   = new Date(startOfDay.getTime() + offsetMs);
    for (const k of ALGO_KEYS) {
      const r = await db(
        `SELECT COALESCE(SUM(pnl), 0) AS t FROM trades_${k} WHERE status='CLOSED' AND closed_at >= $1`,
        [startUTC.toISOString()]
      );
      algoState[k].dailyPnl = parseFloat(r.rows[0].t);
    }
  } catch (e) { console.error("refreshDaily:", e.message); }
}

async function cleanupSignals() {
  try {
    for (const k of ALGO_KEYS) {
      const r = await db(`DELETE FROM signals_${k} WHERE seen_at < NOW() - INTERVAL '24 hours'`);
      if (r.rowCount > 0) console.log(`[CLEANUP] signals_${k}: removed ${r.rowCount}`);
    }
  } catch (e) {}
}

// ── STATS ──────────────────────────────────────────────────
async function getAlgoStats(algoKey) {
  const [closedRes, openRes] = await Promise.all([
    db(`SELECT pnl, exit_reason, exit_mult, closed_at, ticker FROM trades_${algoKey} WHERE status='CLOSED' ORDER BY closed_at ASC`),
    db(`SELECT id FROM trades_${algoKey} WHERE status='OPEN'`),
  ]);
  const closed = closedRes.rows;
  const open   = openRes.rows;
  const wins   = closed.filter(t => parseFloat(t.pnl || 0) > 0);
  const losses = closed.filter(t => parseFloat(t.pnl || 0) <= 0);
  const tp     = closed.reduce((a, t) => a + parseFloat(t.pnl || 0), 0);
  const wr     = closed.length ? (wins.length / closed.length) * 100 : 0;
  const aw     = wins.length   ? wins.reduce((a, t) => a + parseFloat(t.pnl || 0), 0) / wins.length : 0;
  const al     = losses.length ? losses.reduce((a, t) => a + parseFloat(t.pnl || 0), 0) / losses.length : 0;
  const pf     = losses.length && Math.abs(al) > 0 ? Math.abs(aw * wins.length) / Math.abs(al * losses.length) : null;
  let run = 1000;
  const equity = [1000, ...closed.map(t => { run += parseFloat(t.pnl || 0); return +run.toFixed(2); })];
  const exits = {};
  closed.forEach(t => { const k = t.exit_reason || "unknown"; exits[k] = (exits[k] || 0) + 1; });
  const cfg = ALGOS[algoKey];
  const st  = algoState[algoKey];
  return {
    algo: algoKey, name: cfg.name, desc: cfg.desc, color: cfg.color,
    bankroll: +(1000 + tp).toFixed(2),
    totalPnl: +tp.toFixed(2),
    winRate:  +wr.toFixed(1),
    avgWin:   +aw.toFixed(2),
    avgLoss:  +al.toFixed(2),
    profitFactor: pf ? +pf.toFixed(2) : null,
    totalTrades: closed.length,
    openTrades:  open.length,
    dailyPnl:    +st.dailyPnl.toFixed(2),
    circuitBroken: st.circuitBroken,
    equity, exits, config: cfg,
  };
}

// ── API ROUTES ─────────────────────────────────────────────
app.get("/health", (req, res) => res.json({
  status: "ok", ts: new Date().toISOString(), version: "12.0",
  marketMood: mood, pollCount,
  dexStatus: dexIsBlocked() ? `blocked_until_${new Date(dexBackoffUntil).toISOString()}` : "ok",
  algos: Object.fromEntries(ALGO_KEYS.map(k => [k, {
    name: ALGOS[k].name,
    dailyPnl: +algoState[k].dailyPnl.toFixed(2),
    circuitBroken: algoState[k].circuitBroken,
  }])),
}));

app.get("/api/stats", async (req, res) => {
  try { res.json(await Promise.all(ALGO_KEYS.map(k => getAlgoStats(k)))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/stats/:algo", async (req, res) => {
  const k = req.params.algo.toLowerCase();
  if (!ALGO_KEYS.includes(k)) return res.status(400).json({ error: "Invalid algo" });
  try { res.json(await getAlgoStats(k)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/trades/:algo", async (req, res) => {
  const k = req.params.algo.toLowerCase();
  if (!ALGO_KEYS.includes(k)) return res.status(400).json({ error: "Invalid algo" });
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const r = await db(`SELECT * FROM trades_${k} ORDER BY opened_at DESC LIMIT $1`, [limit]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/open-pnl", async (req, res) => {
  try {
    const result = {};
    for (const k of ALGO_KEYS) {
      const open = await getOpen(k);
      if (!open.length) { result[k] = []; continue; }
      // Use pairCache — checkPositions already keeps this fresh every 25s.
      // Do NOT call dexPairs() here — that fires DexScreener on every dashboard refresh (every 8s).
      result[k] = open.map(t => {
        const pair     = pairCache.get(t.pair_address);
        const curPrice = pair ? parseFloat(pair.priceUsd) : null;
        const entry    = parseFloat(t.entry_price);
        const bet      = parseFloat(t.bet_size);
        const ageMin   = (Date.now() - new Date(t.opened_at).getTime()) / 60000;
        const hi       = parseFloat(t.highest_mult || 1);
        if (!curPrice || !entry) return {
          id: t.id, ticker: t.ticker, pair_address: t.pair_address, dex_url: t.dex_url,
          score: t.score, fomo_score: t.fomo_score || 0, bet_size: bet, entry_price: entry,
          opened_at: t.opened_at, cur_price: null, pct_change: null, unrealized_pnl: null,
          highest_mult: hi, age_min: +ageMin.toFixed(1), warning: "no_price", algo: k,
        };
        const mult  = curPrice / entry;
        const pct   = (mult - 1) * 100;
        const upnl  = +(bet * (mult - 1)).toFixed(2);
        const newHi = Math.max(hi, mult);
        const cfg   = ALGOS[k];
        const warning =
          mult <= cfg.stopLoss + 0.05 ? "near_stop" :
          mult <= cfg.earlyStop + 0.03 && ageMin < cfg.earlyStopMinutes ? "near_early_stop" :
          newHi > 1.2 && mult <= newHi * cfg.trailingPct + 0.05 && ageMin >= cfg.trailingActivateMin ? "near_trailing" :
          mult >= cfg.tier2 - 0.1 ? "near_tier2" :
          mult >= cfg.tier1 - 0.05 ? "near_tier1" : "ok";
        return {
          id: t.id, ticker: t.ticker, pair_address: t.pair_address, dex_url: t.dex_url,
          score: t.score, fomo_score: t.fomo_score || 0, bet_size: bet, entry_price: entry,
          opened_at: t.opened_at, cur_price: +curPrice.toFixed(10), pct_change: +pct.toFixed(2),
          unrealized_pnl: upnl, mult: +mult.toFixed(4), highest_mult: +newHi.toFixed(4),
          age_min: +ageMin.toFixed(1), warning, algo: k,
        };
      });
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// IMPORTANT: /api/debug/all BEFORE /api/debug/:algo
app.get("/api/debug/all", async (req, res) => {
  try {
    const out = {};
    for (const k of ALGO_KEYS) {
      const rows = (await db(`SELECT entered, skip_reason FROM signals_${k} WHERE seen_at > NOW() - INTERVAL '1 hour'`)).rows;
      const tally = {};
      rows.filter(s => s.skip_reason).forEach(s => {
        s.skip_reason.split("; ").forEach(r => { const key = r.split("_").slice(0, 3).join("_"); tally[key] = (tally[key] || 0) + 1; });
      });
      out[k] = { name: ALGOS[k].name, total: rows.length, entered: rows.filter(s => s.entered).length, top3: Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 3) };
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/debug/:algo", async (req, res) => {
  const k = req.params.algo.toLowerCase();
  if (!ALGO_KEYS.includes(k)) return res.status(400).json({ error: "Invalid algo" });
  try {
    const rows = (await db(`SELECT ticker, score, fomo_score, liq, vol_5m, pc_5m, age_min, entered, skip_reason, seen_at FROM signals_${k} ORDER BY seen_at DESC LIMIT 50`)).rows;
    const tally = {};
    rows.filter(s => s.skip_reason).forEach(s => {
      s.skip_reason.split("; ").forEach(r => { const key = r.split("_").slice(0, 3).join("_"); tally[key] = (tally[key] || 0) + 1; });
    });
    res.json({
      algo: k, name: ALGOS[k].name, config: ALGOS[k],
      summary: { total: rows.length, entered: rows.filter(s => s.entered).length, skipped: rows.filter(s => !s.entered).length, avgScore: rows.length ? Math.round(rows.reduce((a, s) => a + parseInt(s.score || 0), 0) / rows.length) : 0, avgFomo: rows.length ? Math.round(rows.reduce((a, s) => a + parseInt(s.fomo_score || 0), 0) / rows.length) : 0, skipReasons: Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 10) },
      recent: rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/wipe", async (req, res) => {
  const { password } = req.body;
  if (password !== APP_PASS) return res.status(401).json({ error: "Wrong password" });
  try {
    for (const k of ALGO_KEYS) {
      await db(`TRUNCATE trades_${k} RESTART IDENTITY`);
      await db(`TRUNCATE signals_${k} RESTART IDENTITY`);
      algoState[k].dailyPnl = 0; algoState[k].circuitBroken = false; algoState[k].circuitAt = null;
    }
    const old = ["wave","surge","steady","rocket","e","a1","b1","c1","d1","e1"];
    for (const o of old) { await pool.query(`TRUNCATE trades_${o} RESTART IDENTITY`).catch(() => {}); await pool.query(`TRUNCATE signals_${o} RESTART IDENTITY`).catch(() => {}); }
    res.json({ ok: true, message: "All data wiped." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/system", async (req, res) => {
  try {
    await db("SELECT 1").then(() => {}).catch(() => {});
    const openCounts = {};
    for (const k of ALGO_KEYS) {
      const r = await db(`SELECT COUNT(*) AS n FROM trades_${k} WHERE status='OPEN'`).catch(() => null);
      openCounts[k] = r ? parseInt(r.rows[0].n) : "?";
    }
    res.json({
      ts: new Date().toISOString(), version: "12.0",
      uptime: Math.round(process.uptime()), pollCount, marketMood: mood,
      dexStatus: dexIsBlocked() ? `blocked_${Math.round((dexBackoffUntil - Date.now()) / 1000)}s` : "ok",
      dexBackoffCount,
      apis: { dexscreener: sysStatus.dexscreener, rugcheck: { ...sysStatus.rugcheck, recentResults: sysStatus.rugLog.slice(0, 10) }, database: sysStatus.database },
      funnel: sysStatus.funnel,
      openTrades: openCounts,
      lastErrors: sysStatus.lastErrors.slice(0, 10),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/report", async (req, res) => {
  try {
    // One URL — everything needed for full analysis
    const [stats, systemData] = await Promise.all([
      Promise.all(ALGO_KEYS.map(k => getAlgoStats(k))),
      (async () => {
        const openCounts = {};
        for (const k of ALGO_KEYS) {
          const r = await db(`SELECT COUNT(*) AS n FROM trades_${k} WHERE status='OPEN'`).catch(() => null);
          openCounts[k] = r ? parseInt(r.rows[0].n) : "?";
        }
        return openCounts;
      })(),
    ]);

    const trades = {};
    const debug  = {};
    for (const k of ALGO_KEYS) {
      const tRows = (await db(`SELECT * FROM trades_${k} ORDER BY opened_at DESC LIMIT 200`)).rows;
      trades[k] = tRows;

      const sRows = (await db(`SELECT ticker, score, fomo_score, liq, vol_5m, pc_5m, age_min, entered, skip_reason, seen_at FROM signals_${k} ORDER BY seen_at DESC LIMIT 50`)).rows;
      const tally = {};
      sRows.filter(s => s.skip_reason).forEach(s => {
        s.skip_reason.split("; ").forEach(r => { const key = r.split("_").slice(0, 3).join("_"); tally[key] = (tally[key] || 0) + 1; });
      });
      debug[k] = {
        name: ALGOS[k].name,
        summary: {
          total: sRows.length,
          entered: sRows.filter(s => s.entered).length,
          skipped: sRows.filter(s => !s.entered).length,
          skipReasons: Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 10),
        },
      };
    }

    res.json({
      ts: new Date().toISOString(),
      version: "12.0",
      uptime: Math.round(process.uptime()),
      pollCount,
      marketMood: mood,
      dexStatus: dexIsBlocked() ? `blocked_${Math.round((dexBackoffUntil - Date.now()) / 1000)}s` : "ok",
      funnel: sysStatus.funnel,
      openTrades: systemData,
      stats,
      trades,
      debug,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  if (hasDist) return res.sendFile(path.join(STATIC_DIR, "index.html"));
  res.status(200).send("S0NAR Iron Dome v12.0 running.");
});

// ── START ──────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\nS0NAR IRON DOME v12.0 | Port:${PORT}`);
  console.log(`Algos: WAVE | SURGE | STEADY | ROCKET`);
  console.log(`Poll: ${FETCH_MS}ms (slow/safe) | Check: ${CHECK_MS}ms | 429 backoff: active\n`);
  await initDB();
  await refreshDaily();
  await updateMood();
  setTimeout(pollSignals, 3000);
  setInterval(pollSignals,    FETCH_MS);
  setInterval(checkPositions, CHECK_MS);
  setInterval(updateMood,     5 * 60 * 1000);
  setInterval(refreshDaily,   2 * 60 * 1000);
  setInterval(cleanupSignals, 6 * 60 * 60 * 1000);
});
