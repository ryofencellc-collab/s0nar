// ============================================================
//  S0NAR — WAVE RIDER v9.1
//  4-Strategy momentum trading: ride the wave, get out with profit.
//  Strategy: find coins already moving, enter early in the move,
//  exit before the peak. Not sniping launches. Not holding bags.
//
//  ALGO A — WAVE:    Coins 15-90min, FOMO building (40-70), price +8-45%
//  ALGO B — SURGE:   Volume z-score spike >2 on any age, abnormal activity
//  ALGO C — STEADY:  Proven pattern: high liq, low FOMO, quiet price building
//  ALGO D — ROCKET:  Higher risk: FOMO 55-80, price +20-80%, fast exits
//
//  All 4 use blocking rugcheck. Tight exits. Take profit fast.
// ============================================================

const express   = require("express");
const cors      = require("cors");
const fetch     = require("node-fetch");
const { Pool }  = require("pg");
const path      = require("path");
const crypto    = require("crypto");
const fs        = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

// ── DATABASE ───────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function db(sql, params = []) {
  const c = await pool.connect();
  try { return await c.query(sql, params); }
  finally { c.release(); }
}

const TRADE_COLS = `
  id SERIAL PRIMARY KEY,
  ticker TEXT, name TEXT,
  pair_address TEXT, dex_url TEXT,
  score INTEGER, entry_price NUMERIC,
  bet_size NUMERIC DEFAULT 50,
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
  closed_at TIMESTAMPTZ
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

async function initDB() {
  for (const k of ["a", "b", "c", "d"]) {
    await db(`CREATE TABLE IF NOT EXISTS trades_${k} (${TRADE_COLS})`);
    await db(`CREATE TABLE IF NOT EXISTS signals_${k} (${SIGNAL_COLS})`);
    await db(`CREATE INDEX IF NOT EXISTS idx_tr_${k}_status ON trades_${k}(status)`);
    await db(`CREATE INDEX IF NOT EXISTS idx_tr_${k}_opened ON trades_${k}(opened_at DESC)`);
    await db(`CREATE INDEX IF NOT EXISTS idx_sig_${k}_seen  ON signals_${k}(seen_at DESC)`);
    // Safe column migration for existing tables
    await db(`ALTER TABLE trades_${k} ADD COLUMN IF NOT EXISTS rug_score INTEGER DEFAULT 0`).catch(() => {});
    await db(`ALTER TABLE trades_${k} ADD COLUMN IF NOT EXISTS stealth_score INTEGER DEFAULT 0`).catch(() => {});
    await db(`ALTER TABLE trades_${k} ADD COLUMN IF NOT EXISTS is_stealth BOOLEAN DEFAULT FALSE`).catch(() => {});
    const cnt = await db(`SELECT COUNT(*) FROM trades_${k}`);
    console.log(`  trades_${k}: ${cnt.rows[0].count} rows`);
  }
  console.log("DB ready — v9.1 Wave Rider (A=WAVE B=SURGE C=STEADY D=ROCKET)");
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

// Static frontend
const STATIC_DIR = path.join(__dirname, "dist");
const hasDist = fs.existsSync(path.join(STATIC_DIR, "index.html"));
if (hasDist) {
  app.use(express.static(STATIC_DIR));
  console.log("Serving frontend from dist/");
}

// ── ALGO CONFIGS ───────────────────────────────────────────
// Research-backed entry criteria. Key signals that work:
// 1. Volume spike (z-score) + buy pressure dominating
// 2. FOMO 40-70 = building momentum, not peaked
// 3. Price 8-45% up in 5min = wave starting not ending
// 4. Liquidity >$15k = real market exists
// 5. Age 15-90min = beyond instant rug risk, before crowd peak
const ALGOS = {
  a: {
    name: "WAVE",
    desc: "Coins 10-120min with any momentum. Broad entry — get in early, exit with profit.",
    color: "#00e5ff",
    minScore: 38, maxScore: 99,  // was 45 — tokens hitting 40 need to pass
    minFomo: 10,  maxFomo: 80,   // was 20 — dropping to 10, fomo sits low in quiet market
    minLiq: 5000, minVol5m: 200, minBuyPct: 50, // was 8000 — dropping liq min
    minAge: 5,    maxAge: 180,   // was 10-120
    minPc5m: -5,  maxPc5m: 80,  // market flat/slightly down, allow negative
    minZScore: 0,
    baseBet: 50,
    stopLoss: 0.84,
    earlyStop: 0.88, earlyStopMinutes: 5,
    trailingPct: 0.85, trailingActivateMin: 20,
    tier1: 1.35, tier1Sell: 0.60,
    tier2: 1.80, tier2Sell: 0.30,
    tier3: 3.00,
    maxHold: 45,
  },
  b: {
    name: "SURGE",
    desc: "Volume or price activity on any age coin. Catches anything moving.",
    color: "#ff6d00",
    minScore: 38, maxScore: 99,  // was 45
    minFomo: 15,  maxFomo: 85,   // was 20-82
    minLiq: 5000, minVol5m: 150, minBuyPct: 50, // was 8000/300/50
    minAge: 3,    maxAge: 480,
    minPc5m: -5,  maxPc5m: 85,  // allow flat/slight down
    minZScore: 0,                // was 1.5 — nothing spiking, remove requirement
    baseBet: 40,
    stopLoss: 0.82,
    earlyStop: 0.86, earlyStopMinutes: 5,
    trailingPct: 0.84, trailingActivateMin: 15,
    tier1: 1.30, tier1Sell: 0.65,
    tier2: 1.70, tier2Sell: 0.25,
    tier3: 2.50,
    maxHold: 30,
  },
  c: {
    name: "STEADY",
    desc: "Any liq + any fomo + quiet to mild price. Broad steady accumulation pattern.",
    color: "#69f0ae",
    minScore: 38, maxScore: 88,  // was 48-85
    minFomo: 0,   maxFomo: 60,   // was 10-55 — fomo 0 tokens need to pass
    minLiq: 8000, minVol5m: 100, minBuyPct: 48, // was 15k/150/50
    minAge: 10,   maxAge: 300,   // was 15-240
    minPc5m: -10, maxPc5m: 30,  // was -8 to 25
    minZScore: 0,
    baseBet: 55,
    stopLoss: 0.74,
    earlyStop: 0.82, earlyStopMinutes: 10,
    trailingPct: 0.82, trailingActivateMin: 30,
    tier1: 1.50, tier1Sell: 0.40,
    tier2: 3.00, tier2Sell: 0.35,
    tier3: 6.00,
    maxHold: 120,
  },
  d: {
    name: "ROCKET",
    desc: "Any momentum signal. Catches coins starting to move regardless of speed.",
    color: "#ff1744",
    minScore: 38, maxScore: 99,  // was 45
    minFomo: 15,  maxFomo: 88,   // was 25 — dropping, fomo low in quiet market
    minLiq: 5000, minVol5m: 150, minBuyPct: 50, // was 8000/300/52
    minAge: 3,    maxAge: 150,   // was 3-120
    minPc5m: -5,  maxPc5m: 100, // allow flat/slight down
    minZScore: 0,
    baseBet: 35,
    stopLoss: 0.80,
    earlyStop: 0.85, earlyStopMinutes: 3,
    trailingPct: 0.83, trailingActivateMin: 10,
    tier1: 1.25, tier1Sell: 0.70,
    tier2: 1.60, tier2Sell: 0.20,
    tier3: 2.50,
    maxHold: 25,
  },
};

const ALGO_KEYS   = ["a", "b", "c", "d"];
const DAILY_LIMIT = 200;  // Pause entries if down $200/day per algo
const FETCH_MS    = 15000;
const CHECK_MS    = 20000;

// ── RUNTIME STATE ──────────────────────────────────────────
let mood      = "normal";
let pollCount = 0;
let qi        = 0;

const algoState = {
  a: { dailyPnl: 0, circuitBroken: false, circuitAt: null },
  b: { dailyPnl: 0, circuitBroken: false, circuitAt: null },
  c: { dailyPnl: 0, circuitBroken: false, circuitAt: null },
  d: { dailyPnl: 0, circuitBroken: false, circuitAt: null },
};

// ── LRU MAP (bounded cache to prevent memory leak) ─────────
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
    else if (this.map.size >= this.max) {
      this.map.delete(this.map.keys().next().value);
    }
    this.map.set(k, v);
  }
}

const volHistory        = new LRUMap(5000);
const fomoHistory       = new LRUMap(5000);
const rugCache          = new LRUMap(2000);
const fomoFadeCounter   = new Map();
const delistMissCounter = new Map();
const crossAlgoExposure = new Map(); // tokenAddr → Set<algoKey>

// ── SEARCH QUERIES ─────────────────────────────────────────
const QUERIES = [
  "pump.fun", "pumpfun", "pump fun sol",
  "dog sol", "cat sol", "frog sol", "fish sol", "pepe sol", "doge sol",
  "hamster sol", "bear sol", "bull sol", "wolf sol", "ape sol", "crab sol",
  "based sol", "wagmi sol", "ngmi sol", "moon sol", "gem sol",
  "chad sol", "sigma sol", "alpha sol", "giga sol",
  "ai sol", "gpt sol", "robot sol", "neural sol",
  "solana meme", "sol token", "new sol", "launch sol", "bonk sol",
  "raydium new", "jupiter new", "sol gem", "100x sol", "1000x sol",
  "sol launch", "fair launch sol",
];

// ── DEXSCREENER API ────────────────────────────────────────
async function dexSearch(q) {
  const r = await fetch(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
    { timeout: 10000 }
  );
  if (!r.ok) throw new Error(`dexSearch HTTP ${r.status}`);
  const d = await r.json();
  return (d?.pairs || []).filter(
    p => p.chainId === "solana" && parseFloat(p.priceUsd || 0) > 0
  );
}

async function dexBoosted() {
  const r = await fetch(
    "https://api.dexscreener.com/token-boosts/latest/v1",
    { timeout: 10000 }
  );
  if (!r.ok) throw new Error(`dexBoosted HTTP ${r.status}`);
  const d = await r.json();
  return (d || []).filter(t => t.chainId === "solana").slice(0, 20);
}

async function dexPairs(addresses) {
  if (!addresses.length) return [];
  const results = [];
  for (let i = 0; i < addresses.length; i += 10) {
    const chunk = addresses.slice(i, i + 10);
    try {
      const r = await fetch(
        `https://api.dexscreener.com/latest/dex/pairs/solana/${chunk.join(",")}`,
        { timeout: 10000 }
      );
      if (!r.ok) continue;
      const d = await r.json();
      results.push(
        ...(d?.pairs || []).filter(p => parseFloat(p.priceUsd || 0) > 0)
      );
    } catch (e) { continue; }
  }
  return results;
}

async function dexPair(address) {
  const ps = await dexPairs([address]);
  return ps[0] || null;
}

// ── RUGCHECK API (blocking, fail-closed) ──────────────────
// Any API error = block trade. LP unlocked = hard block.
// Mint/freeze authority = hard block. Never fail open.
async function checkRugcheck(tokenAddress) {
  if (!tokenAddress) return { score: -1, flags: ["no_address"], pass: false };
  if (rugCache.has(tokenAddress)) return rugCache.get(tokenAddress);

  try {
    const r = await fetch(
      `https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report/summary`,
      { timeout: 8000 }
    );
    if (!r.ok) {
      console.log(`[RUG] ${r.status} ${tokenAddress.slice(0, 10)} — blocking`);
      return { score: -1, flags: ["api_error"], pass: false };
    }

    const d     = await r.json();
    const score = d?.score || 0;

    // Empty = API issue or wrong address — block
    if (score === 0 && !d?.topHolders?.length && !d?.markets?.length) {
      console.log(`[RUG] Empty response ${tokenAddress.slice(0, 10)} — blocking`);
      return { score: -1, flags: ["empty_response"], pass: false };
    }

    const flags = [];
    if (d?.mintAuthority)   flags.push("mint_authority");
    if (d?.freezeAuthority) flags.push("freeze_authority");
    if (d?.mutable)         flags.push("mutable_metadata");

    // LP lock: must have at least one locked/burned market
    const markets   = d?.markets || [];
    let anyLocked   = false;
    let anyUnlocked = false;
    for (const m of markets) {
      const lp = m?.lp || {};
      if (lp.lpBurned || (lp.lpLockedPct || 0) >= 80) anyLocked = true;
      else anyUnlocked = true;
    }
    if (markets.length > 0 && anyUnlocked && !anyLocked) flags.push("lp_unlocked");

    // Top holder concentration
    const top1  = d?.topHolders?.[0]?.pct || 0;
    const top10 = (d?.topHolders || []).slice(0, 10)
      .reduce((s, h) => s + (h.pct || 0), 0);
    if (top1  > 30) flags.push(`top1_${Math.round(top1)}pct`);
    if (top10 > 80) flags.push(`top10_${Math.round(top10)}pct`);

    const hardFlags = ["mint_authority", "freeze_authority", "lp_unlocked"];
    const pass      = score < 500 && !flags.some(f => hardFlags.includes(f));

    const result = { score, flags, pass, top10: Math.round(top10) };
    rugCache.set(tokenAddress, result);
    console.log(`[RUG] ${tokenAddress.slice(0, 10)} sc:${score} pass:${pass} [${flags.join(",")}]`);
    return result;

  } catch (e) {
    console.log(`[RUG] Error ${tokenAddress.slice(0, 10)}: ${e.message} — blocking`);
    return { score: -1, flags: ["network_error"], pass: false };
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
  const v5  = p.volume?.m5   || 0;
  const v1  = p.volume?.h1   || 0.001;
  const pc5 = parseFloat(p.priceChange?.m5 || 0);
  const pc1 = parseFloat(p.priceChange?.h1 || 0);
  const b   = p.txns?.m5?.buys  || 0;
  const s   = p.txns?.m5?.sells || 0;
  const liq = p.liquidity?.usd  || 0;
  const age = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : 999;
  const bst = (p.boosts?.active || 0) > 0;
  const addr = p.pairAddress;

  let fomo = 0;

  // Volume vs baseline (how much faster than normal?)
  const expected = v1 / 12;
  fomo += Math.min(35, expected > 0 ? (v5 / expected) * 10 : 0);

  // Price movement — sweet spot is 5-30% (starting not ending)
  if (pc5 >  5 && pc5 <= 15) fomo += 20;
  if (pc5 > 15 && pc5 <= 30) fomo += 12;
  if (pc5 > 30 && pc5 <= 60) fomo +=  5;
  if (pc5 > 60)               fomo -= 10; // already ran hard
  if (pc5 <  0)               fomo -=  5;

  // Buy pressure
  const total = b + s;
  if (total > 10) {
    const br = b / total;
    if      (br > 0.75) fomo += 18;
    else if (br > 0.65) fomo += 12;
    else if (br > 0.55) fomo +=  6;
  }

  // Token age sweet spots
  if (age >=  3 && age <  10) fomo += 15;
  if (age >= 10 && age <  30) fomo += 20;
  if (age >= 30 && age <  60) fomo += 10;
  if (age >= 60 && age < 120) fomo +=  3;
  if (age >= 120)              fomo -= 10;

  // 1h context
  if (pc1 >   0 && pc1 < 100) fomo +=  8;
  if (pc1 >= 100)              fomo +=  3;
  if (pc1 <  -10)              fomo -=  8;

  // Vol/liq ratio
  if (liq >= 500 && v5 > 0) {
    const vlr = v5 / liq;
    if (vlr > 0.5 && vlr < 5) fomo += 8;
    if (vlr >= 5)              fomo += 3;
  }

  // Volume z-score bonus
  const z = getZScore(addr, v5);
  if      (z > 2) fomo += 15;
  else if (z > 1) fomo +=  8;
  else if (z > 0) fomo +=  3;

  if (bst) fomo += 10;

  // FOMO momentum (rising vs falling)
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
  sc += (liq > 100000 ? 100
       : liq >  50000 ?  85
       : liq >  20000 ?  65
       : liq >   5000 ?  45
       : liq >   1000 ?  25 : 5)                          * 0.14;
  sc += Math.min(100, (b / (b + s)) * 100)                * 0.15;
  sc += Math.min(15, Math.max(0, z * 5));
  sc += age <  10 ?  18
      : age <  20 ?  14
      : age <  40 ?  10
      : age <  60 ?   5
      : age >= 120 ?  -8 : 0;
  sc += pc1 > 30 ? 10 : pc1 > 10 ? 6 : pc1 < -20 ? -10 : 0;
  if (bst)        sc += 5;
  if (liq < 1500) sc -= 20;
  if (v5  < 100)  sc -=  8;

  return Math.round(Math.max(0, Math.min(99, sc)));
}

// ── INTERNAL RUG FILTER (fast pre-check before API) ───────
function rugCheck(p) {
  const liq = p.liquidity?.usd || 0;
  const v5  = p.volume?.m5    || 0;
  const b   = p.txns?.m5?.buys  || 0;
  const s   = p.txns?.m5?.sells || 0;
  const pc5 = parseFloat(p.priceChange?.m5 || 0);
  const pc1 = parseFloat(p.priceChange?.h1 || 0);
  const age = (Date.now() - (p.pairCreatedAt || Date.now())) / 60000;
  const w   = [];

  if (age < 3)                          w.push(`too_new_${age.toFixed(1)}min`);
  if (v5 > 80000 && liq < 4000)         w.push("vol_liq_mismatch");
  if (s > b * 3)                        w.push("heavy_sell_wall");
  if (liq < 500)                        w.push("thin_liq");
  if (liq < 25000 && pc5 > 30)          w.push("low_liq_high_velocity");
  if (pc5 > 100 && liq < 50000)         w.push("100pct_spike_thin_liq");
  if (pc1 > 300 && liq < 30000)         w.push("already_pumped_300pct");
  if (b > 0 && s > b * 2 && v5 > 1000) w.push("sells_doubling_buys");

  return { pass: w.length === 0, warnings: w };
}

// ── ALGO GATE ──────────────────────────────────────────────
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
    score:    { pass: sc >= cfg.minScore && sc <= cfg.maxScore,
                why: `score_${sc}_not_in_[${cfg.minScore}-${cfg.maxScore}]` },
    fomo:     { pass: fomo >= cfg.minFomo && fomo <= cfg.maxFomo,
                why: `fomo_${fomo}_not_in_[${cfg.minFomo}-${cfg.maxFomo}]` },
    liq:      { pass: liq >= cfg.minLiq,
                why: `liq_$${Math.round(liq)}_<_$${cfg.minLiq}` },
    vol:      { pass: v5 >= cfg.minVol5m,
                why: `vol5m_$${Math.round(v5)}_<_$${cfg.minVol5m}` },
    buys:     { pass: bp >= cfg.minBuyPct,
                why: `buys_${Math.round(bp)}pct_<_${cfg.minBuyPct}pct` },
    pc5min:   { pass: pc5 >= cfg.minPc5m,
                why: `pc5_${pc5.toFixed(0)}pct_<_${cfg.minPc5m}pct` },
    pc5max:   { pass: pc5 <= cfg.maxPc5m,
                why: `pc5_${pc5.toFixed(0)}pct_>_${cfg.maxPc5m}pct_pumped` },
    ageMin:   { pass: ageUnknown || age >= cfg.minAge,
                why: `age_${age.toFixed(1)}m_<_${cfg.minAge}m` },
    ageMax:   { pass: ageUnknown || age <= cfg.maxAge,
                why: `age_${Math.round(age)}m_>_${cfg.maxAge}m` },
    hasPrice: { pass: parseFloat(p.priceUsd || 0) > 0,
                why: "no_price" },
    zscore:   { pass: z >= cfg.minZScore,
                why: `z_${z.toFixed(1)}_<_${cfg.minZScore}_required` },
  };

  const failed = Object.values(checks)
    .filter(c => !c.pass)
    .map(c => c.why);

  return { pass: failed.length === 0, failed };
}

// ── BET SIZING ─────────────────────────────────────────────
function betSize(sc, algoKey, liq) {
  const cfg   = ALGOS[algoKey];
  const base  = cfg.baseBet;
  const range = cfg.maxScore - cfg.minScore;
  const pct   = range > 0 ? (sc - cfg.minScore) / range : 0.5;
  const mult  = 0.8 + pct * 0.4; // 0.8x → 1.2x based on score quality

  // Cap at 0.1% of liquidity to avoid moving the market
  const liqCap = liq > 0 ? Math.max(10, liq * 0.001) : 150;
  return Math.min(liqCap, Math.min(150, Math.max(15, Math.round((base * mult) / 5) * 5)));
}

// ── P&L CALCULATION ────────────────────────────────────────
function calcPnL(trade, curPrice) {
  const cfg    = ALGOS[trade.algo];
  const mult   = curPrice / parseFloat(trade.entry_price);
  const bet    = parseFloat(trade.bet_size);
  const ageMin = (Date.now() - new Date(trade.opened_at).getTime()) / 60000;
  const hi     = Math.max(parseFloat(trade.highest_mult || 1), mult);

  // Early stop — very tight in first N minutes
  if (mult <= cfg.earlyStop && ageMin < cfg.earlyStopMinutes) {
    return { status: "CLOSED", exit: "EARLY_STOP", mult,
             pnl: +(bet * (mult - 1)).toFixed(2), highMult: hi };
  }

  // Hard stop loss
  if (mult <= cfg.stopLoss) {
    return { status: "CLOSED", exit: "STOP_LOSS", mult,
             pnl: +(bet * (mult - 1)).toFixed(2), highMult: hi };
  }

  // Trailing stop — activates after N minutes
  if (ageMin >= cfg.trailingActivateMin && hi > 1.2 && mult <= hi * cfg.trailingPct) {
    return { status: "CLOSED", exit: "TRAILING_STOP", mult,
             pnl: +(bet * (mult - 1)).toFixed(2), highMult: hi };
  }

  // Tier 3 exit (final target)
  if (mult >= cfg.tier3) {
    const sold1  = cfg.tier1Sell;
    const sold2  = cfg.tier2Sell;
    const sold3  = 1 - sold1 - sold2;
    const pnl    = (bet * sold1 * (cfg.tier1 - 1)) +
                   (bet * sold2 * (cfg.tier2 - 1)) +
                   (bet * sold3 * (mult - 1));
    return { status: "CLOSED", exit: "TIER3", mult, pnl: +pnl.toFixed(2), highMult: hi };
  }

  // Tier 2 exit (partial profit lock)
  if (mult >= cfg.tier2) {
    const sold1     = cfg.tier1Sell;
    const sold2     = cfg.tier2Sell;
    const remaining = 1 - sold1 - sold2;
    const pnl = (bet * sold1 * (cfg.tier1 - 1)) +
                (bet * sold2 * (mult - 1)) +
                (bet * remaining * (mult - 1));
    return { status: "CLOSED", exit: "TIER2", mult, pnl: +pnl.toFixed(2), highMult: hi };
  }

  // Tier 1 reached — stay open (partial profit locked conceptually)
  if (mult >= cfg.tier1 && ageMin >= 5) {
    return { status: "OPEN", exit: null, mult, pnl: null, highMult: hi };
  }

  // Max hold time expired
  if (ageMin >= cfg.maxHold) {
    const reason = mult >= 1 ? "TIME_UP" : "TIME_DOWN";
    return { status: "CLOSED", exit: reason, mult,
             pnl: +(bet * (mult - 1)).toFixed(2), highMult: hi };
  }

  return { status: "OPEN", exit: null, mult, pnl: null, highMult: hi };
}

// ── CIRCUIT BREAKER ────────────────────────────────────────
function checkCircuit(algoKey) {
  const st = algoState[algoKey];
  // Reset if new day
  if (st.circuitAt) {
    const then = new Date(st.circuitAt);
    const now  = new Date();
    if (then.toDateString() !== now.toDateString()) {
      st.circuitBroken = false;
      st.circuitAt     = null;
      st.dailyPnl      = 0;
    }
  }
  if (st.dailyPnl <= -DAILY_LIMIT && !st.circuitBroken) {
    st.circuitBroken = true;
    st.circuitAt     = new Date().toISOString();
    console.log(`[CIRCUIT] ${algoKey.toUpperCase()} down $${Math.abs(st.dailyPnl).toFixed(2)} — pausing`);
  }
}

// ── MARKET MOOD ────────────────────────────────────────────
async function updateMood() {
  try {
    const [r1, r2] = await Promise.allSettled([
      dexSearch("solana meme"),
      dexSearch("pump.fun"),
    ]);
    const pairs = [
      ...(r1.status === "fulfilled" ? r1.value : []),
      ...(r2.status === "fulfilled" ? r2.value : []),
    ].slice(0, 40);
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

    console.log(`[MOOD] ${mood} avg:${avg.toFixed(1)}% hot:${hot}/${pairs.length}`);
  } catch (e) { console.error("updateMood:", e.message); }
}

// ── DAILY PNL SYNC ─────────────────────────────────────────
async function refreshDaily() {
  try {
    const now    = new Date();
    const nyDate = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    nyDate.setHours(0, 0, 0, 0);
    const startOfDay = new Date(now.getTime() - (now - nyDate));

    for (const k of ALGO_KEYS) {
      const r = await db(
        `SELECT COALESCE(SUM(pnl), 0) AS t FROM trades_${k}
         WHERE status='CLOSED' AND closed_at >= $1`,
        [startOfDay.toISOString()]
      );
      algoState[k].dailyPnl = parseFloat(r.rows[0].t);
    }
  } catch (e) { console.error("refreshDaily:", e.message); }
}

// ── DB HELPERS ─────────────────────────────────────────────
async function getOpen(algoKey) {
  const r = await db(
    `SELECT * FROM trades_${algoKey} WHERE status='OPEN' ORDER BY opened_at DESC`
  );
  return r.rows;
}

async function hadTrade(algoKey, pairAddr, ticker, name) {
  // Block if same pair is open right now
  const byAddr = await db(
    `SELECT id FROM trades_${algoKey}
     WHERE pair_address = $1 AND status = 'OPEN' LIMIT 1`,
    [pairAddr]
  );
  if (byAddr.rows.length) return true;

  // Block same ticker in last 90 min (covers pair address changes)
  const byTicker = await db(
    `SELECT id FROM trades_${algoKey}
     WHERE LOWER(ticker) = LOWER($1)
     AND opened_at > NOW() - INTERVAL '90 minutes' LIMIT 1`,
    [ticker]
  );
  if (byTicker.rows.length) return true;

  // Block same token name in last 90 min
  if (name && name.length > 3) {
    const byName = await db(
      `SELECT id FROM trades_${algoKey}
       WHERE LOWER(name) = LOWER($1)
       AND opened_at > NOW() - INTERVAL '90 minutes' LIMIT 1`,
      [name]
    );
    if (byName.rows.length) return true;
  }

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
       ($1, $2, $3, $4, $5, $6, $7,
        'OPEN', 1.0,
        $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17,
        0, false, $18, $19, NOW())
     RETURNING *`,
    [
      p.baseToken?.symbol || "???",        // $1
      p.baseToken?.name   || "",           // $2
      p.pairAddress,                       // $3
      p.url || "",                         // $4
      sc,                                  // $5
      parseFloat(p.priceUsd),              // $6
      bet,                                 // $7
      p.volume?.m5      || 0,              // $8
      p.volume?.h1      || 0,              // $9
      liq,                                 // $10
      parseFloat(p.priceChange?.m5 || 0), // $11
      p.txns?.m5?.buys  || 0,             // $12
      p.txns?.m5?.sells || 0,             // $13
      (p.boosts?.active || 0) > 0,        // $14
      mood,                               // $15
      parseFloat(age.toFixed(1)),         // $16
      fomo,                               // $17
      rugScore || 0,                      // $18
      algoKey,                            // $19
    ]
  );

  if (r.rows[0]) {
    if (!crossAlgoExposure.has(tokenAddr)) {
      crossAlgoExposure.set(tokenAddr, new Set());
    }
    crossAlgoExposure.get(tokenAddr).add(algoKey);
  }
  return r.rows[0];
}

async function closeTrade(algoKey, id, res) {
  await db(
    `UPDATE trades_${algoKey}
     SET status='CLOSED', exit_mult=$1, highest_mult=$2, pnl=$3, exit_reason=$4, closed_at=NOW()
     WHERE id=$5`,
    [res.mult, res.highMult, res.pnl, res.exit, id]
  );
  // Maintain cross-algo exposure map
  try {
    const row = (await db(
      `SELECT pair_address FROM trades_${algoKey} WHERE id=$1`, [id]
    )).rows[0];
    if (row) {
      const key = row.pair_address;
      if (crossAlgoExposure.has(key)) {
        crossAlgoExposure.get(key).delete(algoKey);
        if (crossAlgoExposure.get(key).size === 0) crossAlgoExposure.delete(key);
      }
    }
  } catch (e) { /* non-fatal */ }
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
      p.pairAddress,
      p.url || "",
      sc,
      parseFloat(p.priceUsd   || 0),
      p.volume?.m5     || 0,
      p.liquidity?.usd || 0,
      parseFloat(p.priceChange?.m5 || 0),
      (p.boosts?.active || 0) > 0,
      entered,
      skipReason || null,
      mood,
      parseFloat(age.toFixed(1)),
      fomo,
      algoKey,
    ]
  ).catch(() => {}); // Non-fatal logging
}

// ── POLL SIGNALS ───────────────────────────────────────────
async function pollSignals() {
  pollCount++;
  console.log(`[POLL #${pollCount}] ${new Date().toISOString()} mood:${mood}`);

  try {
    // Rotate through search queries
    const q0 = QUERIES[qi % QUERIES.length];
    const q1 = QUERIES[(qi + 1) % QUERIES.length];
    const q2 = QUERIES[(qi + 2) % QUERIES.length];
    qi += 3;

    const [r1, r2, r3, r4] = await Promise.allSettled([
      dexSearch(q0),
      dexSearch(q1),
      dexSearch(q2),
      dexBoosted(),
    ]);

    const searchPairs = [
      ...(r1.status === "fulfilled" ? r1.value : []),
      ...(r2.status === "fulfilled" ? r2.value : []),
      ...(r3.status === "fulfilled" ? r3.value : []),
    ];

    const boostedTokens = r4.status === "fulfilled" ? r4.value : [];
    let boostedPairs = [];
    if (boostedTokens.length) {
      const addrs = boostedTokens.map(t => t.tokenAddress).filter(Boolean);
      boostedPairs = await dexPairs(addrs).catch(() => []);
    }

    // Deduplicate by pairAddress
    const seenAddrs = new Set();
    const all       = [];
    for (const p of [...searchPairs, ...boostedPairs]) {
      if (!p.pairAddress || seenAddrs.has(p.pairAddress)) continue;
      seenAddrs.add(p.pairAddress);
      all.push(p);
    }

    console.log(`  search:${searchPairs.length} boosted:${boostedPairs.length} unique:${all.length}`);

    // Score everything once upfront
    const scored = all.map(p => ({
      p,
      sc:   calcQualityScore(p),
      fomo: calcFomoScore(p),
      z:    getZScore(p.pairAddress, p.volume?.m5 || 0),
      rug:  rugCheck(p),
    }));

    const entries = { a: 0, b: 0, c: 0, d: 0 };

    for (const algoKey of ALGO_KEYS) {
      checkCircuit(algoKey);
      if (algoState[algoKey].circuitBroken) continue;

      for (const { p, sc, fomo, z, rug } of scored) {
        // Skip obvious junk before any async work
        if (sc < 40 || (p.liquidity?.usd || 0) < 500) continue;

        const gate = algoGate(p, sc, fomo, z, algoKey);

        // Log this signal for debug visibility
        const skipReason = !gate.pass
          ? gate.failed.join("; ")
          : !rug.pass
          ? rug.warnings.join("; ")
          : null;
        logSig(algoKey, p, sc, fomo, gate.pass && rug.pass, skipReason);

        if (!gate.pass || !rug.pass) continue;

        // Already traded this token recently?
        const already = await hadTrade(
          algoKey,
          p.pairAddress,
          p.baseToken?.symbol || "???",
          p.baseToken?.name   || ""
        );
        if (already) continue;

        // Max 2 algos in same token (limits concentrated rug exposure)
        const tokenKey = p.baseToken?.address || p.pairAddress;
        const existing = crossAlgoExposure.get(tokenKey);
        if (existing && existing.size >= 2 && !existing.has(algoKey)) continue;

        // BLOCKING rugcheck — requires token mint address
        const tokenMint = p.baseToken?.address;
        if (!tokenMint) {
          logSig(algoKey, p, sc, fomo, false, "no_token_mint_address");
          continue;
        }

        const rugResult = await checkRugcheck(tokenMint);
        if (!rugResult.pass) {
          console.log(
            `  [${algoKey.toUpperCase()}] RUG BLOCKED ${p.baseToken?.symbol} ` +
            `[${rugResult.flags.join(",")}]`
          );
          continue;
        }

        // All checks passed — enter the trade
        const trade = await insertTrade(algoKey, p, sc, fomo, rugResult.score)
          .catch(e => {
            const msg = e.message.toLowerCase();
            // Ignore duplicate key errors (race condition)
            if (!msg.includes("unique") && !msg.includes("duplicate")) {
              console.error(`insertTrade-${algoKey}:`, e.message);
            }
            return null;
          });

        if (trade) {
          entries[algoKey]++;
          const age = p.pairCreatedAt
            ? ((Date.now() - p.pairCreatedAt) / 60000).toFixed(0)
            : "?";
          const pc5 = parseFloat(p.priceChange?.m5 || 0).toFixed(0);
          console.log(
            `  [${algoKey.toUpperCase()}] ENTERED ${p.baseToken?.symbol} ` +
            `sc:${sc} fomo:${fomo} z:${z.toFixed(1)} pc5:${pc5}% ` +
            `age:${age}m bet:$${trade.bet_size} rug:${rugResult.score}`
          );
        }
      }
    }

    console.log(`  entries A:${entries.a} B:${entries.b} C:${entries.c} D:${entries.d}`);

  } catch (e) { console.error("pollSignals error:", e.message); }
}

// ── CHECK POSITIONS ────────────────────────────────────────
async function checkPositions() {
  for (const algoKey of ALGO_KEYS) {
    try {
      const open = await getOpen(algoKey);
      if (!open.length) continue;

      // Bulk fetch all open positions
      const addrs   = open.map(t => t.pair_address);
      const pairs   = await dexPairs(addrs).catch(() => []);
      const pairMap = new Map(pairs.map(p => [p.pairAddress, p]));

      for (const trade of open) {
        try {
          const st   = algoState[algoKey];
          const pair = pairMap.get(trade.pair_address)
            || await dexPair(trade.pair_address).catch(() => null);

          // Token not found on DexScreener
          if (!pair) {
            const ageMin = (Date.now() - new Date(trade.opened_at).getTime()) / 60000;
            if (ageMin > 3) {
              const missKey = `${algoKey}_${trade.id}`;
              const misses  = (delistMissCounter.get(missKey) || 0) + 1;
              delistMissCounter.set(missKey, misses);
              if (misses >= 3) {
                // 3 consecutive not-found = delisted, close at -100%
                delistMissCounter.delete(missKey);
                const pnl = +(parseFloat(trade.bet_size) * -1.0).toFixed(2);
                await closeTrade(algoKey, trade.id, {
                  mult: 0, pnl,
                  exit: "DELISTED",
                  highMult: parseFloat(trade.highest_mult || 1),
                });
                st.dailyPnl += pnl;
                console.log(`  [${algoKey.toUpperCase()}] DELISTED ${trade.ticker} (3 misses) $${pnl}`);
              } else {
                console.log(`  [${algoKey.toUpperCase()}] ${trade.ticker} miss ${misses}/3`);
              }
            }
            continue;
          }

          // Reset miss counter since we found it
          delistMissCounter.delete(`${algoKey}_${trade.id}`);

          const curPrice  = parseFloat(pair.priceUsd);
          if (!curPrice || curPrice <= 0) continue;

          const res      = calcPnL(trade, curPrice);
          const pct      = ((curPrice / parseFloat(trade.entry_price)) - 1) * 100;
          const curLiq   = pair.liquidity?.usd || 0;
          const entryLiq = parseFloat(trade.liq || 0);
          const curFomo  = calcFomoScore(pair);

          // Live rug detection: liquidity collapse or hard dump
          const liqCollapse = entryLiq > 5000 && curLiq < entryLiq * 0.35;
          const hardDump    = pct < -25;

          if ((liqCollapse || hardDump) && res.status === "OPEN") {
            const mult   = curPrice / parseFloat(trade.entry_price);
            const rugPnl = +(parseFloat(trade.bet_size) * (mult - 1)).toFixed(2);
            const reason = liqCollapse ? "LIQ_PULLED" : "HARD_DUMP";
            await closeTrade(algoKey, trade.id, {
              mult, pnl: rugPnl, exit: reason,
              highMult: Math.max(parseFloat(trade.highest_mult || 1), mult),
            });
            st.dailyPnl += rugPnl;
            console.log(`  [${algoKey.toUpperCase()}] ${reason} ${trade.ticker} ${pct.toFixed(0)}% $${rugPnl}`);
            continue;
          }

          // Update peak if we've gone higher
          if (res.highMult > parseFloat(trade.highest_mult || 1)) {
            await db(
              `UPDATE trades_${algoKey} SET highest_mult=$1 WHERE id=$2`,
              [res.highMult, trade.id]
            );
          }

          // FOMO fade — wait for 2 consecutive low readings to avoid false exits
          if (curFomo < 12 && pct > 5 && res.status === "OPEN") {
            const fadeKey   = `${algoKey}_${trade.id}`;
            const fadeCount = (fomoFadeCounter.get(fadeKey) || 0) + 1;
            fomoFadeCounter.set(fadeKey, fadeCount);
            if (fadeCount >= 2) {
              fomoFadeCounter.delete(fadeKey);
              const mult    = curPrice / parseFloat(trade.entry_price);
              const fadePnl = +(parseFloat(trade.bet_size) * (mult - 1)).toFixed(2);
              await closeTrade(algoKey, trade.id, {
                mult, pnl: fadePnl, exit: "FOMO_FADE",
                highMult: res.highMult,
              });
              st.dailyPnl += fadePnl;
              console.log(`  [${algoKey.toUpperCase()}] FOMO_FADE ${trade.ticker} +${pct.toFixed(0)}% $${fadePnl}`);
            }
            continue;
          } else {
            // FOMO recovered — reset counter
            fomoFadeCounter.delete(`${algoKey}_${trade.id}`);
          }

          // Normal tier/time exit
          if (res.status === "CLOSED") {
            await closeTrade(algoKey, trade.id, res);
            st.dailyPnl += res.pnl;
            checkCircuit(algoKey);
            const sign = res.pnl >= 0 ? "+" : "";
            console.log(`  [${algoKey.toUpperCase()}] CLOSED ${trade.ticker} ${res.exit} ${sign}$${res.pnl.toFixed(2)}`);
          }

        } catch (e) {
          console.error(`  checkPositions [${algoKey}] ${trade.ticker}:`, e.message);
        }

        // Spread API calls slightly
        await new Promise(r => setTimeout(r, 200));
      }
    } catch (e) { console.error(`checkPositions-${algoKey}:`, e.message); }
  }
}

// ── CLEANUP ────────────────────────────────────────────────
async function cleanupSignals() {
  try {
    for (const k of ALGO_KEYS) {
      const r = await db(
        `DELETE FROM signals_${k} WHERE seen_at < NOW() - INTERVAL '24 hours'`
      );
      if (r.rowCount > 0) console.log(`[CLEANUP] signals_${k}: removed ${r.rowCount} rows`);
    }
  } catch (e) { console.error("cleanupSignals:", e.message); }
}

// ── STATS HELPER ───────────────────────────────────────────
async function getAlgoStats(algoKey) {
  const [closedRes, openRes] = await Promise.all([
    db(`SELECT pnl, exit_reason, exit_mult, closed_at, ticker
        FROM trades_${algoKey} WHERE status='CLOSED' ORDER BY closed_at ASC`),
    db(`SELECT id FROM trades_${algoKey} WHERE status='OPEN'`),
  ]);

  const closed = closedRes.rows;
  const open   = openRes.rows;
  const wins   = closed.filter(t => parseFloat(t.pnl || 0) > 0);
  const losses = closed.filter(t => parseFloat(t.pnl || 0) <= 0);
  const tp     = closed.reduce((a, t) => a + parseFloat(t.pnl || 0), 0);
  const wr     = closed.length ? (wins.length / closed.length) * 100 : 0;
  const aw     = wins.length
    ? wins.reduce((a, t) => a + parseFloat(t.pnl || 0), 0) / wins.length
    : 0;
  const al     = losses.length
    ? losses.reduce((a, t) => a + parseFloat(t.pnl || 0), 0) / losses.length
    : 0;
  const pf     = (losses.length && Math.abs(al) > 0)
    ? Math.abs(aw * wins.length) / Math.abs(al * losses.length)
    : null;

  // Build equity curve
  let run = 1000;
  const equity = [1000, ...closed.map(t => {
    run += parseFloat(t.pnl || 0);
    return +run.toFixed(2);
  })];

  // Exit reason breakdown
  const exits = {};
  closed.forEach(t => {
    const k = t.exit_reason || "unknown";
    exits[k] = (exits[k] || 0) + 1;
  });

  const cfg = ALGOS[algoKey];
  const st  = algoState[algoKey];

  return {
    algo:          algoKey,
    name:          cfg.name,
    desc:          cfg.desc,
    color:         cfg.color,
    bankroll:      +(1000 + tp).toFixed(2),
    totalPnl:      +tp.toFixed(2),
    winRate:       +wr.toFixed(1),
    avgWin:        +aw.toFixed(2),
    avgLoss:       +al.toFixed(2),
    profitFactor:  pf ? +pf.toFixed(2) : null,
    totalTrades:   closed.length,
    openTrades:    open.length,
    dailyPnl:      +st.dailyPnl.toFixed(2),
    circuitBroken: st.circuitBroken,
    equity,
    exits,
    config:        cfg,
  };
}

// ── API ROUTES ─────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status:     "ok",
    ts:         new Date().toISOString(),
    version:    "9.1",
    marketMood: mood,
    pollCount,
    algos: Object.fromEntries(
      ALGO_KEYS.map(k => [k, {
        name:          ALGOS[k].name,
        dailyPnl:      +algoState[k].dailyPnl.toFixed(2),
        circuitBroken: algoState[k].circuitBroken,
      }])
    ),
  });
});

app.get("/api/stats", async (req, res) => {
  try {
    const stats = await Promise.all(ALGO_KEYS.map(k => getAlgoStats(k)));
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/stats/:algo", async (req, res) => {
  const k = req.params.algo.toLowerCase();
  if (!ALGO_KEYS.includes(k)) return res.status(400).json({ error: "Invalid algo" });
  try {
    res.json(await getAlgoStats(k));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/trades/:algo", async (req, res) => {
  const k = req.params.algo.toLowerCase();
  if (!ALGO_KEYS.includes(k)) return res.status(400).json({ error: "Invalid algo" });
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const r = await db(
      `SELECT * FROM trades_${k} ORDER BY opened_at DESC LIMIT $1`, [limit]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/open-pnl", async (req, res) => {
  try {
    const result = {};
    for (const k of ALGO_KEYS) {
      const open = await getOpen(k);
      if (!open.length) { result[k] = []; continue; }

      const addrs = open.map(t => t.pair_address);
      const pairs = await dexPairs(addrs).catch(() => []);
      const pm    = new Map(pairs.map(p => [p.pairAddress, p]));

      result[k] = open.map(t => {
        const pair     = pm.get(t.pair_address);
        const curPrice = pair ? parseFloat(pair.priceUsd) : null;
        const entry    = parseFloat(t.entry_price);
        const bet      = parseFloat(t.bet_size);
        const ageMin   = (Date.now() - new Date(t.opened_at).getTime()) / 60000;
        const hi       = parseFloat(t.highest_mult || 1);

        if (!curPrice || curPrice <= 0 || !entry || entry <= 0) {
          return {
            id: t.id, ticker: t.ticker, pair_address: t.pair_address,
            dex_url: t.dex_url, score: t.score, fomo_score: t.fomo_score || 0,
            bet_size: bet, entry_price: entry, opened_at: t.opened_at,
            cur_price: null, pct_change: null, unrealized_pnl: null,
            highest_mult: hi, age_min: +ageMin.toFixed(1),
            warning: "no_price", algo: k,
          };
        }

        const mult  = curPrice / entry;
        const pct   = (mult - 1) * 100;
        const upnl  = +(bet * (mult - 1)).toFixed(2);
        const newHi = Math.max(hi, mult);
        const cfg   = ALGOS[k];

        const warning =
          mult <= cfg.stopLoss + 0.05                                           ? "near_stop"
          : mult <= cfg.earlyStop + 0.03 && ageMin < cfg.earlyStopMinutes      ? "near_early_stop"
          : newHi > 1.2 && mult <= newHi * cfg.trailingPct + 0.05
            && ageMin >= cfg.trailingActivateMin                                ? "near_trailing"
          : mult >= cfg.tier2 - 0.1                                             ? "near_tier2"
          : mult >= cfg.tier1 - 0.05                                            ? "near_tier1"
          : "ok";

        return {
          id: t.id, ticker: t.ticker, pair_address: t.pair_address,
          dex_url: t.dex_url, score: t.score, fomo_score: t.fomo_score || 0,
          bet_size: bet, entry_price: entry, opened_at: t.opened_at,
          cur_price:      +curPrice.toFixed(10),
          pct_change:     +pct.toFixed(2),
          unrealized_pnl: upnl,
          mult:           +mult.toFixed(4),
          highest_mult:   +newHi.toFixed(4),
          age_min:        +ageMin.toFixed(1),
          warning, algo: k,
        };
      });
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// IMPORTANT: /api/debug/all MUST be registered before /api/debug/:algo
// Otherwise Express matches "all" as the :algo param and returns 400.
app.get("/api/debug/all", async (req, res) => {
  try {
    const out = {};
    for (const k of ALGO_KEYS) {
      const rows = (await db(
        `SELECT entered, skip_reason FROM signals_${k}
         WHERE seen_at > NOW() - INTERVAL '1 hour'`
      )).rows;
      const tally = {};
      rows.filter(s => s.skip_reason).forEach(s => {
        s.skip_reason.split("; ").forEach(r => {
          const key = r.split("_").slice(0, 3).join("_");
          tally[key] = (tally[key] || 0) + 1;
        });
      });
      out[k] = {
        name:    ALGOS[k].name,
        total:   rows.length,
        entered: rows.filter(s => s.entered).length,
        top3:    Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 3),
      };
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/debug/:algo", async (req, res) => {
  const k = req.params.algo.toLowerCase();
  if (!ALGO_KEYS.includes(k)) return res.status(400).json({ error: "Invalid algo" });
  try {
    const rows = (await db(
      `SELECT ticker, score, fomo_score, liq, vol_5m, pc_5m,
              age_min, entered, skip_reason, seen_at
       FROM signals_${k} ORDER BY seen_at DESC LIMIT 50`
    )).rows;

    const tally = {};
    rows.filter(s => s.skip_reason).forEach(s => {
      s.skip_reason.split("; ").forEach(r => {
        const key = r.split("_").slice(0, 3).join("_");
        tally[key] = (tally[key] || 0) + 1;
      });
    });

    res.json({
      algo:   k,
      name:   ALGOS[k].name,
      config: ALGOS[k],
      summary: {
        total:       rows.length,
        entered:     rows.filter(s => s.entered).length,
        skipped:     rows.filter(s => !s.entered).length,
        avgScore:    rows.length
          ? Math.round(rows.reduce((a, s) => a + parseInt(s.score || 0), 0) / rows.length)
          : 0,
        avgFomo:     rows.length
          ? Math.round(rows.reduce((a, s) => a + parseInt(s.fomo_score || 0), 0) / rows.length)
          : 0,
        skipReasons: Object.entries(tally)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10),
      },
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
      algoState[k].dailyPnl      = 0;
      algoState[k].circuitBroken = false;
      algoState[k].circuitAt     = null;
    }
    // Also clear any old tables from previous versions
    const oldKeys = ["e", "wave", "surge"];
    for (const ok of oldKeys) {
      await db(`TRUNCATE trades_${ok} RESTART IDENTITY`).catch(() => {});
      await db(`TRUNCATE signals_${ok} RESTART IDENTITY`).catch(() => {});
    }
    console.log("FULL WIPE complete");
    res.json({ ok: true, message: "All data wiped. Fresh start." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Catch-all route
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  if (hasDist) return res.sendFile(path.join(STATIC_DIR, "index.html"));
  res.status(200).send("S0NAR Wave Rider v9.1 backend running.");
});

// ── START ──────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\nS0NAR WAVE RIDER v9.1 | Port:${PORT}`);
  console.log(`DB: ${process.env.DATABASE_URL ? "connected" : "MISSING — check env vars"}`);
  console.log(`Strategies: A=${ALGOS.a.name} B=${ALGOS.b.name} C=${ALGOS.c.name} D=${ALGOS.d.name}`);
  console.log(`Poll every ${FETCH_MS}ms | Check positions every ${CHECK_MS}ms\n`);

  await initDB();
  await refreshDaily();
  await updateMood();

  setTimeout(pollSignals, 2000);            // First poll after 2s startup delay

  setInterval(pollSignals,    FETCH_MS);    // 15s
  setInterval(checkPositions, CHECK_MS);    // 20s
  setInterval(updateMood,     5 * 60 * 1000);  // 5 min
  setInterval(refreshDaily,   2 * 60 * 1000);  // 2 min
  setInterval(cleanupSignals, 6 * 60 * 60 * 1000); // 6 hours
});
