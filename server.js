// ============================================================
//  S0NAR — IRON DOME v7.0  "LAB + KIMI FIXES"
//  Best of both: our 4-algo A/B engine + Kimi's production hardening
//  Fixes: LRU maps (memory), 3-miss delisted (false -100%), 2-check FOMO fade,
//         liq-adjusted bet sizing, cross-algo exposure limit, slippage simulation
// ============================================================
const express  = require("express");
const cors     = require("cors");
const fetch    = require("node-fetch");
const { Pool } = require("pg");
const path     = require("path");
const crypto   = require("crypto");

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
  try { return await c.query(sql, params); } finally { c.release(); }
}

// One shared schema for all 4 algos — table name is parameterized
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
  stealth_score INTEGER DEFAULT 0,
  algo TEXT,
  seen_at TIMESTAMPTZ DEFAULT NOW()
`;

async function initDB() {
  // Create one table per algorithm — using IF NOT EXISTS so safe to re-run
  for (const algo of ["a","b","c","d"]) {
    await db(`CREATE TABLE IF NOT EXISTS trades_${algo} (${TRADE_COLS})`);
    await db(`CREATE TABLE IF NOT EXISTS signals_${algo} (${SIGNAL_COLS})`);
    await db(`CREATE INDEX IF NOT EXISTS trades_${algo}_status ON trades_${algo}(status)`);
    await db(`CREATE INDEX IF NOT EXISTS trades_${algo}_opened ON trades_${algo}(opened_at DESC)`);
    await db(`CREATE INDEX IF NOT EXISTS trades_${algo}_ticker ON trades_${algo}(ticker, opened_at DESC)`);
    await db(`CREATE INDEX IF NOT EXISTS signals_${algo}_seen  ON signals_${algo}(seen_at DESC)`);
    // Verify table exists and is separate
    const count = await db(`SELECT COUNT(*) FROM trades_${algo}`);
    console.log(`  trades_${algo}: ${count.rows[0].count} rows`);
  }
  console.log("DB ready v7.0 — 4 separate algo tables verified");
}

// ── AUTH ───────────────────────────────────────────────────
const PORT     = process.env.PORT || 3000;
const APP_PASS = process.env.APP_PASSWORD || "sonar2024";
const SECRET   = process.env.SESSION_SECRET || "sonar-secret-key";

function makeToken(password) {
  return crypto.createHmac("sha256", SECRET).update(password).digest("hex");
}
const VALID_TOKEN = makeToken(APP_PASS);

function authMiddleware(req, res, next) {
  if (req.path === "/health" || req.path === "/api/login") return next();
  if (!req.path.startsWith("/api/") && req.path !== "/") return next();
  const token = req.headers["x-auth-token"] || req.query.token;
  if (token && token === VALID_TOKEN) return next();
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

// Serve built frontend
const STATIC_DIR = path.join(__dirname, "dist");
const fs = require("fs");
const hasDist = fs.existsSync(path.join(STATIC_DIR, "index.html"));
if (hasDist) {
  app.use(require("express").static(STATIC_DIR));
  console.log("Serving frontend from dist/");
}

// ── NTFY — DISABLED ────────────────────────────────────────
// Notifications off during A/B testing — 4 algos would spam
// Re-enable when we pick a winner and go live
async function notify() { return; } // No-op

// ── ALGORITHM CONFIGS ──────────────────────────────────────
const ALGOS = {
  a: {
    name: "BGOLD Hunter",
    desc: "Low FOMO + high liq + quiet price. The proven winner profile.",
    color: "#ce93d8", // purple
    // Entry rules
    minScore:   60,
    maxScore:   80,   // Cap score — high score + high FOMO = bad
    minFomo:    15,
    maxFomo:    45,   // Low FOMO only — crowd not there yet
    minLiq:     30000, // Lowered from $50k — MOLLY hit 3334x with $33k liq
    minVol5m:   200,
    minBuyPct:  50,
    minAge:     20,
    maxAge:     120,
    minPc5m:    -5,   // Quiet price
    maxPc5m:    15,   // Not already running
    // Bet sizing
    baseBet:    60,   // Higher confidence = bigger base bet
  },
  b: {
    name: "Momentum",
    desc: "Confirms the move is starting. Enters early in the pump.",
    color: "#40c4ff", // blue
    minScore:   70,
    maxScore:   99,
    minFomo:    40,
    maxFomo:    70,   // Building momentum, not peaked
    minLiq:     20000,
    minVol5m:   500,
    minBuyPct:  55,
    minAge:     10,
    maxAge:     60,
    minPc5m:    10,   // Already moving up
    maxPc5m:    40,   // But not already pumped
    baseBet:    40,
  },
  c: {
    name: "Early Mover",
    desc: "Ultra early entry. First 15 minutes. High risk, high reward.",
    color: "#ffd740", // yellow
    minScore:   60,
    maxScore:   99,
    minFomo:    20,
    maxFomo:    70,
    minLiq:     10000, // Lower liq ok — token is brand new
    minVol5m:   200,
    minBuyPct:  52,
    minAge:     3,
    maxAge:     15,   // Only first 15 minutes
    minPc5m:    -10,
    maxPc5m:    99,
    baseBet:    25,   // Smaller bet — higher risk
  },
  d: {
    name: "Control (v5.5)",
    desc: "Current system unchanged. Baseline for comparison.",
    color: "#00e676", // green
    minScore:   60,
    maxScore:   99,
    minFomo:    20,
    maxFomo:    99,
    minLiq:     2000,
    minVol5m:   300,
    minBuyPct:  52,
    minAge:     3,
    maxAge:     180,
    minPc5m:    -25,
    maxPc5m:    999,
    baseBet:    40,
  },
};

// ── EXIT CONSTANTS (shared by all algos) ───────────────────
const STOP_LOSS    = 0.72;
const EARLY_STOP   = 0.82;
const TRAILING_PCT = 0.82;
const TIER1        = 1.5;
const TIER1_SELL   = 0.40;
const TIER2        = 3.0;
const TIER2_SELL   = 0.35;
const TIER3        = 6.0;
const MAX_HOLD     = 120;
const FETCH_MS     = 15000;
const CHECK_MS     = 30000;
const DAILY_LIMIT  = 300;

// ── RUNTIME STATE (shared) ─────────────────────────────────
let mood     = "normal";
let dynScore = 60;
let pollCount = 0;

// Per-algo state
const algoState = {
  a: { dailyPnl: 0, circuitBroken: false, pollCount: 0 },
  b: { dailyPnl: 0, circuitBroken: false, pollCount: 0 },
  c: { dailyPnl: 0, circuitBroken: false, pollCount: 0 },
  d: { dailyPnl: 0, circuitBroken: false, pollCount: 0 },
};

// Kimi fix: FOMO fade requires 2 consecutive low readings to avoid exiting winners on API blips
// Key: `${algoKey}_${tradeId}` → count of consecutive low-fomo checks
const fomoFadeCounter = new Map();

// Kimi fix: delisted requires 3 consecutive not-found before closing at full loss
// Prevents -100% on DexScreener temporary API failures
// Key: `${algoKey}_${tradeId}` → count of consecutive misses
const delistMissCounter = new Map();

// Per-pair history maps with LRU eviction (max 5000 entries each)
// Kimi fix: unbounded Maps OOM on high-velocity Solana token minting
class LRUMap {
  constructor(max) { this.max = max; this.map = new Map(); }
  has(k)    { return this.map.has(k); }
  get(k)    { const v = this.map.get(k); if (v !== undefined) { this.map.delete(k); this.map.set(k, v); } return v; }
  set(k, v) { if (this.map.has(k)) this.map.delete(k); else if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value); this.map.set(k, v); }
}
const volHistory  = new LRUMap(5000);
const fomoHistory = new LRUMap(5000);

// Cross-algo exposure tracker: tokenAddress -> Set of algoKeys currently open
// Kimi fix: prevents 4x $150 = $600 exposure on one rug pull
const crossAlgoExposure = new Map();

// ── QUERIES ────────────────────────────────────────────────
const QUERIES = [
  "pump.fun","pumpfun","pump fun sol",
  "dog sol","cat sol","frog sol","fish sol","pepe sol","doge sol",
  "hamster sol","bear sol","bull sol","wolf sol","ape sol","crab sol",
  "based sol","wagmi sol","ngmi sol","moon sol","gem sol",
  "chad sol","sigma sol","alpha sol","giga sol","chad coin",
  "ai sol","gpt sol","robot sol","neural sol",
  "solana meme","sol token","new sol","launch sol","bonk sol",
  "raydium new","jupiter new","sol gem","100x sol","1000x sol",
  "sol launch","fair launch sol","stealth sol",
];
let qi = 0;

// ── DEXSCREENER ────────────────────────────────────────────
async function dexSearch(q) {
  const r = await fetch(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
    { timeout: 10000 }
  );
  if (!r.ok) throw new Error(`dexSearch ${r.status}`);
  const d = await r.json();
  return (d?.pairs || []).filter(p => p.chainId === "solana" && parseFloat(p.priceUsd || 0) > 0);
}

async function dexBoosted() {
  const r = await fetch(`https://api.dexscreener.com/token-boosts/latest/v1`, { timeout: 10000 });
  if (!r.ok) throw new Error(`dexBoosted ${r.status}`);
  const d = await r.json();
  return (d || []).filter(t => t.chainId === "solana").slice(0, 20);
}

async function dexNewTokens() {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=solana`, { timeout: 10000 });
  if (!r.ok) return [];
  const d = await r.json();
  return (d?.pairs || [])
    .filter(p =>
      p.chainId === "solana" &&
      parseFloat(p.priceUsd || 0) > 0 &&
      p.pairCreatedAt &&
      (Date.now() - p.pairCreatedAt) < 30 * 60000
    )
    .sort((a, b) => b.pairCreatedAt - a.pairCreatedAt);
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
      results.push(...(d?.pairs || []).filter(p => parseFloat(p.priceUsd || 0) > 0));
    } catch(e) { continue; }
  }
  return results;
}

async function dexPair(address) {
  const p = await dexPairs([address]);
  return p[0] || null;
}

// ── SCORING (shared by all algos) ─────────────────────────
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
  const v5   = p.volume?.m5  || 0;
  const v1   = p.volume?.h1  || 0.001;
  const pc5  = parseFloat(p.priceChange?.m5 || 0);
  const pc1  = parseFloat(p.priceChange?.h1 || 0);
  const b    = p.txns?.m5?.buys  || 0;
  const s    = p.txns?.m5?.sells || 0;
  const liq  = p.liquidity?.usd  || 0;
  const age  = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : 999;
  const bst  = (p.boosts?.active || 0) > 0;
  const addr = p.pairAddress;

  let fomo = 0;

  const expected5m = v1 / 12;
  fomo += Math.min(35, expected5m > 0 ? (v5 / expected5m) * 10 : 0);

  if (pc5 >  5 && pc5 <= 15) fomo += 20;
  if (pc5 > 15 && pc5 <= 30) fomo += 12;
  if (pc5 > 30 && pc5 <= 60) fomo +=  5;
  if (pc5 > 60)               fomo -= 10;
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
  if (age >= 120)             fomo -= 10;

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
  sc += (liq>100000?100:liq>50000?85:liq>20000?65:liq>5000?45:liq>1000?25:5) * 0.14;
  sc += Math.min(100, (b / (b + s)) * 100)                * 0.15;
  sc += Math.min(15, Math.max(0, z * 5));
  sc += age<10?18:age<20?14:age<40?10:age<60?5:age>=120?-8:0;
  sc += pc1>30?10:pc1>10?6:pc1<-20?-10:0;
  if (bst)        sc += 5;
  if (liq < 1500) sc -= 20;
  if (v5  < 100)  sc -=  8;

  return Math.round(Math.max(0, Math.min(99, sc)));
}

function calcStealthScore(p) {
  const liq  = p.liquidity?.usd || 0;
  const pc5  = parseFloat(p.priceChange?.m5 || 0);
  const age  = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : 999;
  const b    = p.txns?.m5?.buys  || 0;
  const s    = p.txns?.m5?.sells || 0;
  const v5   = p.volume?.m5 || 0;
  const fomo = calcFomoScore(p);
  const bst  = (p.boosts?.active || 0) > 0;

  let st = 0;

  if      (liq >= 200000) st += 40;
  else if (liq >= 100000) st += 35;
  else if (liq >= 50000)  st += 25;
  else if (liq >= 20000)  st += 12;
  else if (liq >= 10000)  st +=  5;
  else                    st -= 10;

  if      (pc5 >= -3  && pc5 <= 5)  st += 20;
  else if (pc5 >= -5  && pc5 <= 10) st += 12;
  else if (pc5 >= -10 && pc5 <= 20) st +=  5;
  else if (pc5 >  20)               st -= 15;
  else if (pc5 < -10)               st -= 10;

  if      (fomo >= 15 && fomo <= 35) st += 20;
  else if (fomo >= 35 && fomo <= 50) st += 10;
  else if (fomo >  50 && fomo <= 65) st +=  3;
  else if (fomo >  65)               st -= 15;
  else if (fomo <  15)               st +=  5;

  if      (age >= 20  && age <= 60)  st += 15;
  else if (age >= 60  && age <= 120) st += 10;
  else if (age >= 120 && age <= 180) st +=  5;
  else if (age <  20)                st -=  5;
  else if (age >  180)               st -= 10;

  const total = b + s;
  if (total > 5) {
    const br = b / total;
    if      (br >= 0.52 && br <= 0.68) st += 10;
    else if (br >= 0.68 && br <= 0.80) st +=  5;
    else if (br >  0.80)               st -=  5;
    else if (br <  0.52)               st -=  5;
  }

  if (liq > 0 && v5 > 0) {
    const vlr = v5 / liq;
    if      (vlr < 0.1) st += 5;
    else if (vlr < 0.3) st += 2;
    else if (vlr > 1.0) st -= 5;
  }

  if (bst) st -= 8;

  return Math.round(Math.max(0, Math.min(100, st)));
}

// ── RUG CHECK (shared) ─────────────────────────────────────
function rugCheck(p) {
  const liq  = p.liquidity?.usd || 0;
  const v5   = p.volume?.m5    || 0;
  const v1   = p.volume?.h1    || 0;
  const b    = p.txns?.m5?.buys  || 0;
  const s    = p.txns?.m5?.sells || 0;
  const pc5  = parseFloat(p.priceChange?.m5 || 0);
  const pc1  = parseFloat(p.priceChange?.h1 || 0);
  const age  = (Date.now() - (p.pairCreatedAt || Date.now())) / 60000;
  const w    = [];

  if (age < 3)                          w.push(`too new (${age.toFixed(1)}min)`);
  if (v5 > 80000 && liq < 4000)         w.push("vol/liq mismatch");
  if (s > b * 3)                        w.push("heavy sell wall");
  if (v1 > 800000 && liq < 8000)        w.push("late pump thin liq");
  if (liq < 500)                        w.push("dangerously thin liq");
  if (liq < 25000 && pc5 > 30)          w.push("low liq high velocity");
  if (pc5 > 100 && liq < 50000)         w.push("100%+ spike thin liq");
  if (pc1 > 300 && liq < 30000)         w.push("already pumped 300%+");
  if (b > 0 && s > b * 2 && v5 > 1000) w.push("sells doubling buys");

  return { pass: w.length === 0, warnings: w };
}

// ── ALGO-SPECIFIC GATE ─────────────────────────────────────
function algoGate(p, sc, fomo, algoKey) {
  const cfg = ALGOS[algoKey];
  const liq = p.liquidity?.usd || 0;
  const v5  = p.volume?.m5    || 0;
  const b   = p.txns?.m5?.buys  || 0;
  const s   = p.txns?.m5?.sells || 0;
  const bp  = b + s > 0 ? (b / (b + s)) * 100 : 0;
  const pc5 = parseFloat(p.priceChange?.m5 || 0);
  const age = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : -1;
  const ageUnknown = age < 0;

  const checks = {
    score:    { pass: sc >= cfg.minScore && sc <= cfg.maxScore,   why: `score ${sc} not in ${cfg.minScore}-${cfg.maxScore}` },
    fomo:     { pass: fomo >= cfg.minFomo && fomo <= cfg.maxFomo, why: `fomo ${fomo} not in ${cfg.minFomo}-${cfg.maxFomo}` },
    liq:      { pass: liq >= cfg.minLiq,                          why: `liq $${Math.round(liq)}<$${cfg.minLiq}` },
    vol:      { pass: v5 >= cfg.minVol5m,                         why: `vol $${Math.round(v5)}<$${cfg.minVol5m}` },
    buys:     { pass: bp >= cfg.minBuyPct,                        why: `buys ${Math.round(bp)}%<${cfg.minBuyPct}%` },
    pc5min:   { pass: pc5 >= cfg.minPc5m,                         why: `pc5 ${pc5.toFixed(0)}%<${cfg.minPc5m}%` },
    pc5max:   { pass: pc5 <= cfg.maxPc5m,                         why: `pc5 ${pc5.toFixed(0)}%>${cfg.maxPc5m}% already pumped` },
    ageMin:   { pass: ageUnknown || age >= cfg.minAge,            why: `age ${age.toFixed(1)}m<${cfg.minAge}m` },
    ageMax:   { pass: ageUnknown || age <= cfg.maxAge,            why: `age ${Math.round(age)}m>${cfg.maxAge}m` },
    hasPrice: { pass: parseFloat(p.priceUsd || 0) > 0,           why: "no price" },
  };

  const failed = Object.values(checks).filter(c => !c.pass).map(c => c.why);
  return { pass: failed.length === 0, failed };
}

// ── BET SIZING (per algo) ──────────────────────────────────
function betSize(sc, fomo, isStealth, algoKey, liq = 0) {
  const cfg  = ALGOS[algoKey];
  const base = cfg.baseBet;

  // Scale by score within algo's range
  const scoreRange = cfg.maxScore - cfg.minScore;
  const scorePct   = scoreRange > 0 ? (sc - cfg.minScore) / scoreRange : 0.5;
  const scoreMult  = 0.8 + (scorePct * 0.4); // 0.8x to 1.2x

  // Stealth bonus
  const stealthMult = isStealth ? 1.3 : 1.0;

  // Kimi fix: cap at 0.1% of liquidity to prevent >0.1% price impact
  // e.g. $10k liq → max $10 bet. $50k liq → max $50. $200k liq → cap at $150.
  const liqCap = liq > 0 ? Math.max(10, liq * 0.001) : 150;

  return Math.min(liqCap, Math.min(150, Math.max(25, Math.round((base * scoreMult * stealthMult) / 5) * 5)));
}

// ── PNL CALC (shared) ──────────────────────────────────────
// Kimi fix: apply 2% simulated slippage on paper trades (entry + exit)
// Real DEX execution on thin-liq tokens costs 1-3% per side
const PAPER_SLIPPAGE = 0.02; // 2% round-trip cost simulation

function applySlippage(pnl, bet) {
  // Deduct 2% of bet size to simulate real execution costs
  return +(pnl - (bet * PAPER_SLIPPAGE)).toFixed(2);
}

function calcPnL(trade, curPrice) {
  const mult   = curPrice / parseFloat(trade.entry_price);
  const bet    = parseFloat(trade.bet_size);
  const ageMin = (Date.now() - new Date(trade.opened_at).getTime()) / 60000;
  const hi     = Math.max(parseFloat(trade.highest_mult || 1), mult);

  if (mult <= EARLY_STOP && ageMin < 10) {
    return { status:"CLOSED", exit:"EARLY STOP", mult, pnl:applySlippage(+(bet*(mult-1)).toFixed(2), bet), highMult:hi };
  }
  if (ageMin >= 45 && hi > 1.3 && mult <= hi * TRAILING_PCT) {
    return { status:"CLOSED", exit:"TRAILING STOP", mult, pnl:applySlippage(+(bet*(mult-1)).toFixed(2), bet), highMult:hi };
  }
  if (mult <= STOP_LOSS) {
    return { status:"CLOSED", exit:"STOP LOSS", mult, pnl:applySlippage(+(bet*(mult-1)).toFixed(2), bet), highMult:hi };
  }
  if (mult >= TIER3) {
    const raw = +((bet*TIER1_SELL*(TIER1-1))+(bet*TIER2_SELL*(TIER2-1))+(bet*0.25*(mult-1))).toFixed(2);
    return { status:"CLOSED", exit:"TIER 3 MOON", mult, pnl:applySlippage(raw, bet), highMult:hi };
  }
  if (mult >= TIER2) {
    const raw = +((bet*TIER1_SELL*(TIER1-1))+(bet*TIER2_SELL*(mult-1))).toFixed(2);
    return { status:"CLOSED", exit:"TIER 2", mult, pnl:applySlippage(raw, bet), highMult:hi };
  }
  if (mult >= TIER1 && ageMin >= 8) {
    return { status:"OPEN", exit:null, mult, pnl:null, highMult:hi };
  }
  if (ageMin >= MAX_HOLD) {
    return { status:"CLOSED", exit:mult>=1?"TIME EXIT UP":"TIME EXIT DOWN", mult, pnl:applySlippage(+(bet*(mult-1)).toFixed(2), bet), highMult:hi };
  }
  return { status:"OPEN", exit:null, mult, pnl:null, highMult:hi };
}

// ── CIRCUIT BREAKER (per algo) ─────────────────────────────
function checkCircuit(algoKey) {
  const st  = algoState[algoKey];
  const now = new Date();
  if (st.circuitAt && new Date(st.circuitAt).getDate() !== now.getDate()) {
    st.circuitBroken = false;
    st.circuitAt     = null;
    st.dailyPnl      = 0;
  }
  if (st.dailyPnl <= -DAILY_LIMIT && !st.circuitBroken) {
    st.circuitBroken = true;
    st.circuitAt     = now.toISOString();
    console.log(`[CIRCUIT] Algo-${algoKey.toUpperCase()} down $${Math.abs(st.dailyPnl).toFixed(2)}`);
  }
}

// ── MARKET MOOD (shared) ───────────────────────────────────
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

    if      (avg >  8 && pct >= 60) { mood = "frenzy"; dynScore = 56; }
    else if (avg >  4 && pct >= 40) { mood = "hot";    dynScore = 58; }
    else if (avg >  1 && pct >= 25) { mood = "warm";   dynScore = 60; }
    else if (avg < -8 && pct <  10) { mood = "dead";   dynScore = 68; }
    else if (avg < -5 && pct <  15) { mood = "cold";   dynScore = 65; }
    else                             { mood = "normal"; dynScore = 60; }

    console.log(`[MOOD] ${mood} avg:${avg.toFixed(1)}% hot:${hot}/${pairs.length}`);
  } catch(e) { console.error("updateMood:", e.message); }
}

async function refreshDaily() {
  try {
    // Use America/New_York midnight — app is used from NYC
    const now     = new Date();
    const nyDate  = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    nyDate.setHours(0, 0, 0, 0);
    const startOfDay = new Date(now.getTime() - (now - nyDate));

    for (const algoKey of ["a","b","c","d"]) {
      const r = await db(
        `SELECT COALESCE(SUM(pnl),0) AS t FROM trades_${algoKey} WHERE status='CLOSED' AND closed_at >= $1`,
        [startOfDay.toISOString()]
      );
      algoState[algoKey].dailyPnl = parseFloat(r.rows[0].t);
    }
  } catch(e) { console.error("refreshDaily:", e.message); }
}

// ── DB HELPERS ─────────────────────────────────────────────
async function getOpen(algoKey) {
  return (await db(`SELECT * FROM trades_${algoKey} WHERE status='OPEN' ORDER BY opened_at DESC`)).rows;
}

async function hadTrade(algoKey, addr, ticker, name) {
  // 1. Block if same pair address is currently OPEN
  const openCheck = await db(
    `SELECT id FROM trades_${algoKey} WHERE pair_address=$1 AND status='OPEN' LIMIT 1`,
    [addr]
  );
  if (openCheck.rows.length > 0) return true;

  // 2. Block if same TICKER traded in last 90 minutes
  // Prevents re-entering tokens that delist and reappear with new pair address
  const tickerCheck = await db(
    `SELECT id FROM trades_${algoKey}
     WHERE LOWER(ticker)=LOWER($1)
     AND opened_at > NOW() - INTERVAL '90 minutes'
     LIMIT 1`,
    [ticker]
  );
  if (tickerCheck.rows.length > 0) return true;

  // 3. Block if same TOKEN NAME traded in last 90 minutes
  // Catches MOLLY / MOLLY🔥 / MOLLY variants with different ticker symbols
  if (name && name.length > 3) {
    const nameCheck = await db(
      `SELECT id FROM trades_${algoKey}
       WHERE LOWER(name)=LOWER($1)
       AND opened_at > NOW() - INTERVAL '90 minutes'
       LIMIT 1`,
      [name]
    );
    if (nameCheck.rows.length > 0) return true;
  }

  return false;
}

async function insertTrade(algoKey, p, sc, fomo) {
  const stealthSc = calcStealthScore(p);
  const isStealth = stealthSc >= 60;
  const liq       = p.liquidity?.usd || 0;
  const bet       = betSize(sc, fomo, isStealth, algoKey, liq); // pass liq for slippage cap
  const age       = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : 0;
  const tokenAddr = p.baseToken?.address || p.pairAddress;

  const r = await db(`
    INSERT INTO trades_${algoKey}
      (ticker, name, pair_address, dex_url, score, entry_price, bet_size,
       status, highest_mult,
       vol_5m, vol_1h, liq, pc_5m, buys_5m, sells_5m,
       boosted, market_mood, age_min, fomo_score,
       stealth_score, is_stealth, algo, opened_at)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,
       'OPEN',1.0,
       $8,$9,$10,$11,$12,$13,
       $14,$15,$16,$17,
       $18,$19,$20,NOW())
    RETURNING *`,
    [
      p.baseToken?.symbol || "???",        // $1
      p.baseToken?.name   || "",           // $2
      p.pairAddress,                       // $3
      p.url,                               // $4
      sc,                                  // $5
      parseFloat(p.priceUsd),              // $6
      bet,                                 // $7
      p.volume?.m5     || 0,               // $8
      p.volume?.h1     || 0,               // $9
      p.liquidity?.usd || 0,               // $10
      parseFloat(p.priceChange?.m5 || 0),  // $11
      p.txns?.m5?.buys  || 0,              // $12
      p.txns?.m5?.sells || 0,              // $13
      (p.boosts?.active || 0) > 0,         // $14
      mood,                                // $15
      parseFloat(age.toFixed(1)),          // $16
      fomo,                                // $17
      stealthSc,                           // $18
      isStealth,                           // $19
      algoKey,                             // $20
    ]
  );
  // Track cross-algo exposure in memory
  if (r.rows[0]) {
    if (!crossAlgoExposure.has(tokenAddr)) crossAlgoExposure.set(tokenAddr, new Set());
    crossAlgoExposure.get(tokenAddr).add(algoKey);
  }
  return r.rows[0];
}

async function closeTrade(algoKey, id, res) {
  await db(
    `UPDATE trades_${algoKey} SET status='CLOSED', exit_mult=$1, highest_mult=$2, pnl=$3, exit_reason=$4, closed_at=NOW() WHERE id=$5`,
    [res.mult, res.highMult, res.pnl, res.exit, id]
  );
  // Clean up cross-algo tracker — look up the token address for this trade
  try {
    const t = (await db(`SELECT pair_address, name FROM trades_${algoKey} WHERE id=$1`, [id])).rows[0];
    if (t) {
      const tokenKey = t.pair_address;
      if (crossAlgoExposure.has(tokenKey)) {
        crossAlgoExposure.get(tokenKey).delete(algoKey);
        if (crossAlgoExposure.get(tokenKey).size === 0) crossAlgoExposure.delete(tokenKey);
      }
    }
  } catch(e) { /* non-fatal */ }
}

async function logSig(algoKey, p, sc, fomo, stealthSc, g1, g2) {
  const age = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : 0;
  await db(`
    INSERT INTO signals_${algoKey}
      (ticker, pair_address, dex_url, score, price, vol_5m, liq, pc_5m,
       boosted, entered, skip_reason, market_mood, age_min, fomo_score,
       stealth_score, algo, seen_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())`,
    [
      p.baseToken?.symbol || "???",
      p.pairAddress, p.url, sc,
      parseFloat(p.priceUsd  || 0),
      p.volume?.m5     || 0,
      p.liquidity?.usd || 0,
      parseFloat(p.priceChange?.m5 || 0),
      (p.boosts?.active || 0) > 0,
      g1.pass && g2.pass,
      [...g1.failed, ...g2.warnings].join("; ") || null,
      mood,
      parseFloat(age.toFixed(1)),
      fomo, stealthSc, algoKey,
    ]
  ).catch(() => {});
}

// ── POLL — all 4 algos process same market data ────────────
async function pollSignals() {
  pollCount++;
  console.log(`[POLL #${pollCount}] ${new Date().toISOString()} mood:${mood}`);

  try {
    // Fetch market data once — shared by all 4 algos
    const q0 = QUERIES[qi % QUERIES.length];
    const q1 = QUERIES[(qi + 1) % QUERIES.length];
    const q2 = QUERIES[(qi + 2) % QUERIES.length];
    qi += 3;

    const [r1, r2, r3, r4, r5] = await Promise.allSettled([
      dexSearch(q0),
      dexSearch(q1),
      dexSearch(q2),
      dexBoosted(),
      dexNewTokens(),
    ]);

    const searchPairs   = [
      ...(r1.status === "fulfilled" ? r1.value : []),
      ...(r2.status === "fulfilled" ? r2.value : []),
      ...(r3.status === "fulfilled" ? r3.value : []),
    ];
    const boostedTokens = r4.status === "fulfilled" ? r4.value : [];
    const newTokens     = r5.status === "fulfilled" ? r5.value : [];

    let boostedPairs = [];
    if (boostedTokens.length) {
      const addrs = boostedTokens.map(t => t.tokenAddress).filter(Boolean);
      boostedPairs = await dexPairs(addrs).catch(() => []);
    }

    // Dedupe
    const seen = new Set();
    const all  = [];
    for (const p of [...searchPairs, ...boostedPairs, ...newTokens]) {
      if (!p.pairAddress || seen.has(p.pairAddress)) continue;
      seen.add(p.pairAddress);
      all.push(p);
    }

    console.log(`  data: search:${searchPairs.length} boosted:${boostedPairs.length} new:${newTokens.length} total:${all.length}`);

    // Score every token once
    const scored = all.map(p => ({
      p,
      sc:       calcQualityScore(p),
      fomo:     calcFomoScore(p),
      stealthSc: calcStealthScore(p),
      rug:      rugCheck(p),
    }));

    // Run each algo against the scored tokens
    const totals = { a:0, b:0, c:0, d:0 };
    for (const algoKey of ["a","b","c","d"]) {
      const st = algoState[algoKey];
      checkCircuit(algoKey); // Track P&L but don't stop — paper trading
      // Circuit breaker disabled during paper testing — collect max data

      let entered = 0;
      for (const { p, sc, fomo, stealthSc, rug } of scored) {
        if (sc < 45 || (p.liquidity?.usd || 0) < 300) continue; // Skip junk before logging
        const gate = algoGate(p, sc, fomo, algoKey);
        await logSig(algoKey, p, sc, fomo, stealthSc, gate, rug);

        if (!gate.pass || !rug.pass) continue;
        if (await hadTrade(algoKey, p.pairAddress, p.baseToken?.symbol || "???", p.baseToken?.name || "")) continue;

        // Kimi fix: max 2 algos in same token at once — prevents 4x concentrated rug exposure
        const tokenKey = p.baseToken?.address || p.pairAddress;
        const existingAlgos = crossAlgoExposure.get(tokenKey);
        if (existingAlgos && existingAlgos.size >= 2 && !existingAlgos.has(algoKey)) continue;

        const trade = await insertTrade(algoKey, p, sc, fomo).catch(e => {
          const msg = e.message.toLowerCase();
          if (!msg.includes("unique") && !msg.includes("duplicate")) {
            console.error(`insertTrade-${algoKey}:`, e.message);
          }
          return null;
        });

        if (trade) {
          entered++;
          const liq = p.liquidity?.usd || 0;
          const age = p.pairCreatedAt ? ((Date.now()-p.pairCreatedAt)/60000).toFixed(0) : "?";
          const pc5 = parseFloat(p.priceChange?.m5 || 0).toFixed(0);
          console.log(`  [${algoKey.toUpperCase()}] ENTERED ${p.baseToken?.symbol} sc:${sc} fomo:${fomo} bet:$${trade.bet_size} age:${age}m`);
        }
      }
      totals[algoKey] = entered;
    }

    console.log(`  entries: A:${totals.a} B:${totals.b} C:${totals.c} D:${totals.d}`);

  } catch(e) { console.error("pollSignals:", e.message); }
}

// ── CHECK POSITIONS (all algos) ────────────────────────────
async function checkPositions() {
  for (const algoKey of ["a","b","c","d"]) {
    try {
      const open = await getOpen(algoKey);
      if (!open.length) continue;

      const addrs   = open.map(t => t.pair_address);
      const pairs   = await dexPairs(addrs).catch(() => []);
      const pairMap = new Map(pairs.map(p => [p.pairAddress, p]));

      for (const t of open) {
        try {
          const pair = pairMap.get(t.pair_address) || await dexPair(t.pair_address).catch(() => null);
          const st   = algoState[algoKey];

          if (!pair) {
            const ageMin = (Date.now() - new Date(t.opened_at).getTime()) / 60000;
            if (ageMin > 3) {
              // Kimi fix: require 3 consecutive not-found before marking DELISTED
              // Prevents false -100% on DexScreener API blips or rate limits
              const missKey = `${algoKey}_${t.id}`;
              const misses  = (delistMissCounter.get(missKey) || 0) + 1;
              delistMissCounter.set(missKey, misses);

              if (misses >= 3) {
                delistMissCounter.delete(missKey);
                const pnl = +(parseFloat(t.bet_size) * -1.0).toFixed(2);
                await closeTrade(algoKey, t.id, { mult:0, pnl, exit:"DELISTED", highMult:parseFloat(t.highest_mult||1) });
                st.dailyPnl += pnl;
                console.log(`  [${algoKey.toUpperCase()}] DELISTED ${t.ticker} -100% -$${Math.abs(pnl)} (confirmed 3 checks)`);
              } else {
                console.log(`  [${algoKey.toUpperCase()}] ${t.ticker} not found (miss ${misses}/3, waiting)`);
              }
            }
            continue;
          }
          // Token found — reset any miss counter
          delistMissCounter.delete(`${algoKey}_${t.id}`);

          const cur      = parseFloat(pair.priceUsd);
          if (!cur || cur <= 0) continue;

          const res      = calcPnL(t, cur);
          const pct      = ((cur / parseFloat(t.entry_price)) - 1) * 100;
          const fomo     = calcFomoScore(pair);
          const curLiq   = pair.liquidity?.usd || 0;
          const entryLiq = parseFloat(t.liq || 0);

          // Live rug detection
          const liqCollapse = entryLiq > 5000 && curLiq < entryLiq * 0.30;
          const hardDump    = pct < -40;

          if ((liqCollapse || hardDump) && res.status === "OPEN") {
            const rugPnl = +(parseFloat(t.bet_size) * (cur/parseFloat(t.entry_price)-1)).toFixed(2);
            const reason = liqCollapse ? "LIQ PULLED" : "HARD DUMP";
            await closeTrade(algoKey, t.id, { mult:cur/parseFloat(t.entry_price), pnl:rugPnl, exit:reason, highMult:res.highMult });
            st.dailyPnl += rugPnl;
            console.log(`  [${algoKey.toUpperCase()}] ${reason} ${t.ticker} ${pct.toFixed(0)}%`);
            continue;
          }

          if (res.highMult > parseFloat(t.highest_mult || 1)) {
            await db(`UPDATE trades_${algoKey} SET highest_mult=$1 WHERE id=$2`, [res.highMult, t.id]);
          }

          // FOMO fade — Kimi fix: require 2 consecutive low readings to avoid exiting on blips
          if (fomo < 15 && pct > 5 && res.status === "OPEN") {
            const fadeKey   = `${algoKey}_${t.id}`;
            const fadeCount = (fomoFadeCounter.get(fadeKey) || 0) + 1;
            fomoFadeCounter.set(fadeKey, fadeCount);

            if (fadeCount >= 2) {
              fomoFadeCounter.delete(fadeKey);
              const fadePnl = +(parseFloat(t.bet_size)*(cur/parseFloat(t.entry_price)-1)).toFixed(2);
              await closeTrade(algoKey, t.id, { mult:cur/parseFloat(t.entry_price), pnl:fadePnl, exit:"FOMO FADE", highMult:res.highMult });
              st.dailyPnl += fadePnl;
              console.log(`  [${algoKey.toUpperCase()}] FOMO FADE ${t.ticker} +${pct.toFixed(0)}% (confirmed 2 checks)`);
            } else {
              console.log(`  [${algoKey.toUpperCase()}] ${t.ticker} FOMO low (${fomo}) — waiting for confirmation`);
            }
            continue;
          } else {
            // FOMO recovered — reset counter
            fomoFadeCounter.delete(`${algoKey}_${t.id}`);
          }

          if (res.status === "CLOSED") {
            await closeTrade(algoKey, t.id, res);
            st.dailyPnl += res.pnl;
            checkCircuit(algoKey);
            console.log(`  [${algoKey.toUpperCase()}] CLOSED ${t.ticker} ${res.exit} ${res.pnl>=0?"+":""}$${res.pnl.toFixed(2)}`);
          }
        } catch(e) { console.error(`  [${algoKey}] ${t.ticker}:`, e.message); }

        await new Promise(r => setTimeout(r, 300));
      }
    } catch(e) { console.error(`checkPositions-${algoKey}:`, e.message); }
  }
}

// ── SIGNALS CLEANUP (runs every 6 hours) ──────────────────
async function cleanupSignals() {
  try {
    for (const algoKey of ["a","b","c","d"]) {
      const r = await db(
        `DELETE FROM signals_${algoKey} WHERE seen_at < NOW() - INTERVAL '24 hours'`
      );
      if (r.rowCount > 0) console.log(`[CLEANUP] signals_${algoKey}: deleted ${r.rowCount} old rows`);
    }
  } catch(e) { console.error("cleanupSignals:", e.message); }
}

// ── STATS HELPER ───────────────────────────────────────────
async function getAlgoStats(algoKey) {
  // Use aggregation queries instead of loading all rows into memory
  const [closedRows, openRows] = await Promise.all([
    db(`SELECT pnl, exit_reason, exit_mult, closed_at, opened_at, ticker FROM trades_${algoKey} WHERE status='CLOSED' ORDER BY closed_at ASC`),
    db(`SELECT id FROM trades_${algoKey} WHERE status='OPEN'`),
  ]);

  const closed = closedRows.rows;
  const open   = openRows.rows;
  const wins   = closed.filter(t => parseFloat(t.pnl || 0) > 0);
  const losses = closed.filter(t => parseFloat(t.pnl || 0) <= 0);
  const tp     = closed.reduce((a, t) => a + parseFloat(t.pnl || 0), 0);
  const wr     = closed.length ? (wins.length / closed.length) * 100 : 0;
  const aw     = wins.length   ? wins.reduce((a,t)=>a+parseFloat(t.pnl||0),0)/wins.length : 0;
  const al     = losses.length ? losses.reduce((a,t)=>a+parseFloat(t.pnl||0),0)/losses.length : 0;
  const pf     = losses.length && Math.abs(al) > 0 ? Math.abs(aw*wins.length)/Math.abs(al*losses.length) : null;
  const best   = closed.length ? closed.reduce((a,b)=>parseFloat(a.pnl||0)>parseFloat(b.pnl||0)?a:b,closed[0]) : null;
  const st     = algoState[algoKey];

  const ord = [...closed].sort((a,b)=>new Date(a.closed_at)-new Date(b.closed_at));
  let run = 1000;
  const equity = [1000, ...ord.map(t=>{run+=parseFloat(t.pnl||0);return +run.toFixed(2);})];

  const exits = {};
  closed.forEach(t=>{ const k=t.exit_reason||"unknown"; exits[k]=(exits[k]||0)+1; });

  return {
    algo:        algoKey,
    name:        ALGOS[algoKey].name,
    desc:        ALGOS[algoKey].desc,
    color:       ALGOS[algoKey].color,
    bankroll:    +(1000+tp).toFixed(2),
    totalPnl:    +tp.toFixed(2),
    winRate:     +wr.toFixed(1),
    avgWin:      +aw.toFixed(2),
    avgLoss:     +al.toFixed(2),
    profitFactor:pf?+pf.toFixed(2):null,
    totalTrades: closed.length,
    openTrades:  open.length,
    dailyPnl:    +st.dailyPnl.toFixed(2),
    circuitBroken: st.circuitBroken,
    best: best ? { ticker:best.ticker, pnl:+parseFloat(best.pnl||0).toFixed(2), mult:+parseFloat(best.exit_mult||0).toFixed(2) } : null,
    equity, exits,
    config: ALGOS[algoKey],
  };
}

// ── API ────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({
  status: "ok",
  ts: new Date().toISOString(),
  version: "7.0",
  marketMood: mood,
  pollCount,
  ntfy: "DISABLED",
  algos: Object.fromEntries(
    ["a","b","c","d"].map(k => [k, {
      name: ALGOS[k].name,
      dailyPnl: +algoState[k].dailyPnl.toFixed(2),
      circuitBroken: algoState[k].circuitBroken,
    }])
  ),
}));

// All 4 algo stats in one call
app.get("/api/stats", async(req, res) => {
  try {
    const stats = await Promise.all(["a","b","c","d"].map(k => getAlgoStats(k)));
    res.json(stats);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Single algo stats
app.get("/api/stats/:algo", async(req, res) => {
  const algoKey = req.params.algo.toLowerCase();
  if (!["a","b","c","d"].includes(algoKey)) return res.status(400).json({ error: "Invalid algo" });
  try {
    res.json(await getAlgoStats(algoKey));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Trades for a specific algo
app.get("/api/trades/:algo", async(req, res) => {
  const algoKey = req.params.algo.toLowerCase();
  if (!["a","b","c","d"].includes(algoKey)) return res.status(400).json({ error: "Invalid algo" });
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    res.json((await db(`SELECT * FROM trades_${algoKey} ORDER BY opened_at DESC LIMIT $1`, [limit])).rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Live P&L for open positions (all algos)
app.get("/api/open-pnl", async(req, res) => {
  try {
    const result = {};
    for (const algoKey of ["a","b","c","d"]) {
      const open = await getOpen(algoKey);
      if (!open.length) { result[algoKey] = []; continue; }
      const addrs  = open.map(t => t.pair_address);
      const pairs  = await dexPairs(addrs).catch(() => []);
      const pm     = new Map(pairs.map(p => [p.pairAddress, p]));

      result[algoKey] = open.map(t => {
        const pair     = pm.get(t.pair_address);
        const curPrice = pair ? parseFloat(pair.priceUsd) : null;
        const entry    = parseFloat(t.entry_price);
        const bet      = parseFloat(t.bet_size);
        const ageMin   = (Date.now()-new Date(t.opened_at).getTime())/60000;
        const hi       = parseFloat(t.highest_mult||1);

        if (!curPrice || curPrice <= 0 || !entry || entry <= 0) {
          return { id:t.id, ticker:t.ticker, pair_address:t.pair_address,
            dex_url:t.dex_url, score:t.score, fomo_score:t.fomo_score||0,
            bet_size:bet, entry_price:entry, opened_at:t.opened_at,
            cur_price:null, pct_change:null, unrealized_pnl:null,
            highest_mult:hi, age_min:+ageMin.toFixed(1), warning:"no_price", algo:algoKey };
        }

        const mult = curPrice/entry;
        const pct  = (mult-1)*100;
        const upnl = +(bet*(mult-1)).toFixed(2);
        const newHi = Math.max(hi, mult);

        const warning = mult <= STOP_LOSS+0.05        ? "near_stop"
                      : mult <= EARLY_STOP+0.03 && ageMin<10 ? "near_early_stop"
                      : newHi>1.3 && mult<=newHi*TRAILING_PCT+0.05 && ageMin>=45 ? "near_trailing"
                      : mult >= TIER2-0.1             ? "near_tier2"
                      : mult >= TIER1-0.05            ? "near_tier1"
                      : "ok";

        return { id:t.id, ticker:t.ticker, pair_address:t.pair_address,
          dex_url:t.dex_url, score:t.score, fomo_score:t.fomo_score||0,
          bet_size:bet, entry_price:entry, opened_at:t.opened_at,
          cur_price:+curPrice.toFixed(10), pct_change:+pct.toFixed(2),
          unrealized_pnl:upnl, mult:+mult.toFixed(4),
          highest_mult:+newHi.toFixed(4), age_min:+ageMin.toFixed(1),
          warning, algo:algoKey, is_stealth:t.is_stealth };
      });
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Debug — why tokens are being rejected per algo
app.get("/api/debug/:algo", async(req, res) => {
  const algoKey = req.params.algo.toLowerCase();
  if (!["a","b","c","d"].includes(algoKey)) return res.status(400).json({ error: "Invalid algo" });
  try {
    const rows = (await db(`
      SELECT ticker, score, fomo_score, stealth_score, liq, vol_5m, pc_5m,
             age_min, entered, skip_reason, seen_at
      FROM signals_${algoKey} ORDER BY seen_at DESC LIMIT 50`
    )).rows;

    const skipTally = {};
    rows.filter(s => s.skip_reason).forEach(s => {
      s.skip_reason.split("; ").forEach(reason => {
        const key = reason.split(" ").slice(0, 3).join(" ");
        skipTally[key] = (skipTally[key] || 0) + 1;
      });
    });

    res.json({
      algo: algoKey,
      name: ALGOS[algoKey].name,
      config: ALGOS[algoKey],
      summary: {
        total:       rows.length,
        entered:     rows.filter(s => s.entered).length,
        skipped:     rows.filter(s => !s.entered).length,
        avgScore:    rows.length ? Math.round(rows.reduce((a,s)=>a+parseInt(s.score||0),0)/rows.length) : 0,
        avgFomo:     rows.length ? Math.round(rows.reduce((a,s)=>a+parseInt(s.fomo_score||0),0)/rows.length) : 0,
        skipReasons: Object.entries(skipTally).sort((a,b)=>b[1]-a[1]).slice(0,10),
      },
      recent: rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// WIPE — full data reset (password protected)
app.post("/api/wipe", async(req, res) => {
  const { password } = req.body;
  if (password !== APP_PASS) return res.status(401).json({ error: "Wrong password" });
  try {
    for (const algoKey of ["a","b","c","d"]) {
      await db(`TRUNCATE trades_${algoKey} RESTART IDENTITY`);
      await db(`TRUNCATE signals_${algoKey} RESTART IDENTITY`);
      algoState[algoKey].dailyPnl      = 0;
      algoState[algoKey].circuitBroken = false;
      algoState[algoKey].circuitAt     = null;
    }
    // Also wipe old single tables if they exist
    await db(`TRUNCATE trades RESTART IDENTITY`).catch(()=>{});
    await db(`TRUNCATE signals RESTART IDENTITY`).catch(()=>{});
    console.log("FULL DATA WIPE completed");
    res.json({ ok: true, message: "All data wiped. Fresh start." });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Catch-all
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  if (hasDist) return res.sendFile(path.join(STATIC_DIR, "index.html"));
  res.status(200).send("S0NAR v7.0 backend running.");
});

// ── START ──────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\nS0NAR LAB v7.0 | Port:${PORT}`);
  console.log(`DB:${process.env.DATABASE_URL?"connected":"MISSING"}`);
  console.log(`NTFY: DISABLED during A/B test`);
  console.log(`Algos: A=${ALGOS.a.name} B=${ALGOS.b.name} C=${ALGOS.c.name} D=${ALGOS.d.name}`);
  console.log(`Poll:${FETCH_MS}ms Check:${CHECK_MS}ms\n`);

  await initDB();
  await refreshDaily();
  await updateMood();

  setTimeout(pollSignals, 2000);
  setInterval(pollSignals,    FETCH_MS);
  setInterval(checkPositions, CHECK_MS);
  setInterval(updateMood,     5 * 60 * 1000);
  setInterval(refreshDaily,   2 * 60 * 1000);
  setInterval(cleanupSignals, 6 * 60 * 60 * 1000); // Clean old signals every 6h
});
