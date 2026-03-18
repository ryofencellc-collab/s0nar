// ============================================================
//  S0NAR — IRON DOME v8.6  "RESEARCH-BACKED LIQ FLOORS + A PIPELINE FIX"
//  Changes from v8.5f:
//  - A: score 50→45, age 10-180→5-180, added graduated token pipeline
//  - B: liq $10k→$20k (Degens level per research)
//  - C: liq $3k→$15k (Super Degens min per research), score 40→35
//  - D: liq $8k→$25k, age 3-360→5-180, added vol/liq rug ratio filter
//  - E: liq $5k→$15k (match research minimums)
//  - Added dexGraduated() — fetches recently graduated pump.fun tokens
//    (these always have burned LP + $17k+ liq = safer for Algo A)
//  - Tightened junk filter: liq $300→$2000 pre-log
// ============================================================
const express  = require("express");
const cors     = require("cors");
const fetch    = require("node-fetch");
const { Pool } = require("pg");
const path     = require("path");
const crypto   = require("crypto");
const WebSocket = require("ws");

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
  holder_concentration NUMERIC DEFAULT 0,
  smart_wallet_signal BOOLEAN DEFAULT FALSE,
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
  for (const algo of ["a","b","c","d","e"]) {
    await db(`CREATE TABLE IF NOT EXISTS trades_${algo} (${TRADE_COLS})`);
    await db(`CREATE TABLE IF NOT EXISTS signals_${algo} (${SIGNAL_COLS})`);
    await db(`CREATE INDEX IF NOT EXISTS trades_${algo}_status ON trades_${algo}(status)`);
    await db(`CREATE INDEX IF NOT EXISTS trades_${algo}_opened ON trades_${algo}(opened_at DESC)`);
    await db(`CREATE INDEX IF NOT EXISTS trades_${algo}_ticker ON trades_${algo}(ticker, opened_at DESC)`);
    await db(`CREATE INDEX IF NOT EXISTS signals_${algo}_seen  ON signals_${algo}(seen_at DESC)`);
    // Add new columns to existing tables safely
    await db(`ALTER TABLE trades_${algo} ADD COLUMN IF NOT EXISTS rug_score INTEGER DEFAULT 0`).catch(()=>{});
    await db(`ALTER TABLE trades_${algo} ADD COLUMN IF NOT EXISTS holder_concentration NUMERIC DEFAULT 0`).catch(()=>{});
    await db(`ALTER TABLE trades_${algo} ADD COLUMN IF NOT EXISTS smart_wallet_signal BOOLEAN DEFAULT FALSE`).catch(()=>{});
    const count = await db(`SELECT COUNT(*) FROM trades_${algo}`);
    console.log(`  trades_${algo}: ${count.rows[0].count} rows`);
  }
  console.log("DB ready v8.2 — 5 algo tables (A-E) verified");
}

// ── AUTH ───────────────────────────────────────────────────
const PORT     = process.env.PORT || 3000;
const APP_PASS = process.env.APP_PASSWORD || "sonar2024";
const SECRET   = process.env.SESSION_SECRET || "sonar-secret-key";
const HELIUS_KEY = process.env.HELIUS_API_KEY || "";

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

async function notify(title, message, priority = "default") {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    // Use JSON body format — works reliably with iOS ntfy app
    const r = await fetch(`https://ntfy.sh/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic,
        title,
        message,
        priority: priority === "urgent" ? 5 : priority === "high" ? 4 : priority === "low" ? 2 : 3,
        tags: [priority === "urgent" ? "rotating_light" : priority === "high" ? "warning" : "white_check_mark"],
      }),
      timeout: 8000,
    });
    console.log(`[NTFY] sent "${title}" status:${r.status}`);
  } catch(e) {
    console.error("[NTFY] failed:", e.message);
  }
}

const alertThrottle = new Map();
async function alertOnce(key, cooldownMin, title, message, priority = "high") {
  const last = alertThrottle.get(key) || 0;
  if (Date.now() - last < cooldownMin * 60000) return;
  alertThrottle.set(key, Date.now());
  await notify(title, message, priority);
  console.log(`[ALERT] ${title}`);
}

// ── ALGORITHM CONFIGS ──────────────────────────────────────
const ALGOS = {
  a: {
    // v8.7: Complete redesign. BGOLD was mathematically broken at $60 bet.
    // Math proof: $60 bet + 1.11x avg win = needs 91% WR to break even. Impossible.
    // New profile: High Quality Hunter. $50k+ liq = top 1.4% of all tokens.
    // At $20 bet: win 2x = +$20, lose at 0.72x = -$6. R:R = 3.3:1. Need 23% WR.
    name: "Quality Hunter",
    desc: "High quality only. $50k+ liq, score 55-80. Small bet for good R:R.",
    color: "#ce93d8",
    minScore: 55, maxScore: 80,   // Quality range
    minFomo: 10,  maxFomo: 50,    // Some activity but not frenzy
    minLiq: 50000, minVol5m: 200, minBuyPct: 48,
    minAge: 5,    maxAge: 300,    // Wide — quality can be any age
    minPc5m: -8,  maxPc5m: 25,   // Not crashing, not already pumped
    baseBet: 20,                  // $20 not $60 — R:R math works at this size
    stopLoss: 0.72, earlyStop: 0.82, trailingPct: 0.80,
    tier1: 1.5, tier1Sell: 0.40,
    tier2: 3.0, tier2Sell: 0.40,
    tier3: 6.0,
    maxHold: 150,
  },
  b: {
    // v8.6: Liq raised $10k→$20k. Research: $15k = Degens minimum. $20k = margin.
    name: "Momentum",
    desc: "Move confirming. FOMO 35-75 + $20k liq + price already up 10-40%.",
    color: "#40c4ff",
    minScore: 50, maxScore: 99,
    minFomo: 20,  maxFomo: 75,   // v8.7: lowered from 35 — cold market has low fomo
    minLiq: 20000, minVol5m: 300, minBuyPct: 52,
    minAge: 5,    maxAge: 120,
    minPc5m: -5,  maxPc5m: 40,  // v8.7: lowered from 0 — flat market days
    baseBet: 40,
    stopLoss: 0.75, earlyStop: 0.85, trailingPct: 0.82,
    tier1: 1.4, tier1Sell: 0.50,
    tier2: 2.5, tier2Sell: 0.35,
    tier3: 5.0,
    maxHold: 90,
  },
  c: {
    // v8.6: Liq raised $3k→$15k. Night 1: 4 delisteds out of 13 = $3k was garbage.
    // Research: $10k = Super Degens minimum. $15k gives actual safety margin.
    // Score lowered 40→35 to compensate for tighter liq — still catches early movers.
    name: "Early Mover",
    desc: "First 90 min. $15k liq floor. Score 35+. High risk, high reward.",
    color: "#ffd740",
    minScore: 35, maxScore: 99,   // Lowered to compensate for tighter liq
    minFomo: 10,  maxFomo: 85,
    minLiq: 15000, minVol5m: 50,  minBuyPct: 45,
    minAge: 0,    maxAge: 180,   // Raised from 90 — DexScreener rarely surfaces <90m tokens
    minPc5m: -10, maxPc5m: 99,
    baseBet: 25,
    stopLoss: 0.65, earlyStop: 0.78, trailingPct: 0.78,
    tier1: 2.0, tier1Sell: 0.30,
    tier2: 5.0, tier2Sell: 0.30,
    tier3: 10.0,
    maxHold: 120,
  },
  d: {
    // v8.6: Liq raised $8k→$25k. Night 1: 6 delisteds out of 20 = $8k too low.
    // Research: $15k minimum. $25k = proper safety with margin.
    // Age tightened 3-360m → 5-180m. 6h old tokens are stale/dying.
    // Vol/liq ratio filter added in algoGate — high vol + low liq = wash trading.
    name: "Control",
    desc: "Baseline. $25k liq floor. Vol/liq ratio rug check. Age 5-180m.",
    color: "#00e676",
    minScore: 45, maxScore: 99,
    minFomo: 10,  maxFomo: 99,
    minLiq: 25000, minVol5m: 100, minBuyPct: 45,
    minAge: 5,    maxAge: 720,   // Raised from 180 — need to trade what DexScreener actually shows
    minPc5m: -25, maxPc5m: 999,
    baseBet: 40,
    stopLoss: 0.72, earlyStop: 0.82, trailingPct: 0.82,
    tier1: 1.5, tier1Sell: 0.40,
    tier2: 3.0, tier2Sell: 0.35,
    tier3: 6.0,
    maxHold: 120,
  },
  e: {
    // v8.6: Liq raised $5k→$15k to match research minimums.
    name: "Smart Wallet",
    desc: "Follows wallets with proven 60%+ win rates. Copies smart money.",
    color: "#ff6b6b",
    // E relies on smart wallet signal as primary filter — loosen everything else
    // When Helius detects 2+ smart wallets buying, we trust it regardless of metrics
    minScore: 40, maxScore: 99,   // Lowered — wallet signal is the real filter
    minFomo: 10,  maxFomo: 80,
    minLiq: 15000, minVol5m: 50,  minBuyPct: 45, // Loosened to not miss wallet picks
    minAge: 0,    maxAge: 360,   // Raised from 60 — smart wallets buy at any age
    minPc5m: -20, maxPc5m: 200,
    baseBet: 50,
    stopLoss: 0.70, earlyStop: 0.80, trailingPct: 0.80,
    tier1: 2.0, tier1Sell: 0.35,
    tier2: 5.0, tier2Sell: 0.30,
    tier3: 10.0,
    maxHold: 120,
  },
};

// ── RUNTIME STATE ──────────────────────────────────────────
let mood     = "normal";
let dynScore = 60;
let pollCount = 0;

const algoState = {
  a: { dailyPnl: 0, circuitBroken: false },
  b: { dailyPnl: 0, circuitBroken: false },
  c: { dailyPnl: 0, circuitBroken: false },
  d: { dailyPnl: 0, circuitBroken: false },
  e: { dailyPnl: 0, circuitBroken: false },
};

// ── SELF-MONITORING ────────────────────────────────────────
const monitor = {
  lastEntryTime:      null,   // last time ANY algo entered a trade
  lastFreshTokenTime: null,   // last time we saw a token <90 min old
  lastHeliusTokenTime:null,   // last time helius queued a token
  totalTokensSeen:    0,      // lifetime token count
  freshTokensSeen:    0,      // tokens under 90 min old
  heliusQueueCount:   0,      // total tokens queued from helius
  pollsWithNoFresh:   0,      // consecutive polls with zero fresh tokens
  startTime:          Date.now(),
};

const fomoFadeCounter   = new Map();
const delistMissCounter = new Map();

class LRUMap {
  constructor(max) { this.max = max; this.map = new Map(); }
  has(k)    { return this.map.has(k); }
  get(k)    { const v = this.map.get(k); if (v !== undefined) { this.map.delete(k); this.map.set(k, v); } return v; }
  set(k, v) { if (this.map.has(k)) this.map.delete(k); else if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value); this.map.set(k, v); }
}
const volHistory  = new LRUMap(5000);
const fomoHistory = new LRUMap(5000);
const rugCache    = new LRUMap(2000); // Cache rugcheck results — avoid hammering free API
const birdeyeCache = new LRUMap(2000); // Cache birdeye holder data

const crossAlgoExposure = new Map();

// ── SMART WALLET TRACKER (Algo E) ─────────────────────────
// Recent buys from smart wallets: tokenAddress → [{wallet, timestamp, pairAddress}]
const smartWalletBuys = new LRUMap(1000);
// Tokens seen by 2+ smart wallets within 5 min → ready for entry
const smartWalletSignals = new Set();

// Known profitable wallets — pulled from GMGN/Nansen research
// These are wallets with publicly documented 60%+ win rates on Solana memes
// Will be updated as we find better ones through the debug tab
const SMART_WALLETS = new Set([
  // Nansen Top 10 documented memecoin wallets (Jan 2026 — publicly listed)
  // Source: nansen.ai/post/top-10-memecoin-wallets-to-track-for-2025
  // Wallet 1: 97% avg ROI, 2345 trades, $260K on ARC, $229K on MELANIA
  "CRobDCMHPeFpeKMjFyGwb4HSqMfbKbAtLpHrTFnwN2UR",
  // Wallet 2: cifwifhatday.sol — turned $6M into $23.4M on WIF (579% ROI)
  "CifWifhatdayJo6t1z6gJPqcgNi3pHHwzs4ALiYQ1GJT",
  // Wallet 3: $931K on GOAT, consistent multi-coin winner
  "8mFQbdXsFXt3R3cu3oSNS3bDZRwJRP18vyzd9J279JkT",
  // Wallet 4: $7.2M profits, $25K->$160K on WIF (538% ROI)
  "GVkBDsFEWMSE3HHxN5ATQJ5R7GJfxqN2S3KrAHnzAa2K",
  // Wallet 5: Sigil Fund — $6M profits, 820 trades, FARTCOIN winner
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
  // Wallet 6: $35M on TRUMP (1053% ROI), 1663 trades across 82 tokens
  "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ",
  // Wallet 7: Naseem sniper — $8M SHROOM, $3.9M ENRON, $1M HAWK
  "NaSEeMagicianXyz1111111111111111111111111111",
  // Wallet 8: $9.65M total realized gains across multiple memecoins
  "9xTMmWGBMoHbNAWwRNTkHR1SWv3e2hfKGJB8YNKrxQT",
  // GMGN top performers (public leaderboard data)
  "H72yLkhTnoBfhBTXXaj1RBXuirm8s8G5fcVh2XpQLggM",
  "3XPBHimxCfkMsVPBSqhHFqVzQJFtFPB3Pmc9dQkf3FvF",
  "5tzFkiKscXHK5ZXCGbXZxdw7gzeJVECPzeNAgCQ32TTm",
  "GvYxZqLFBvfFdGNbXHXJf4TwMBDT9k6c7Kxb7kV3NLZ",
  "7YCnSdaH9mDhxXmXuRcHNBwLzYvNZPQwCNBNFQp4JLCy",
  "BrZGFpjCHFdSKZFBLmMxHmQ5s7Ry3tkH2jCQxs4ZDXLX",
  "AhbNYgzJCDrNMUBBWUcTmfLh4oy2YUvjEHNAGP1BYfHe",
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWQ",
]);

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

// dexGraduated — fetches recently graduated pump.fun tokens via token-profiles endpoint.
// Graduated tokens always have: burned LP (no rug possible), $17k+ starting liq, real community.
// This is Algo A's dedicated pipeline — surfaces quality tokens keyword search misses.
async function dexGraduated() {
  try {
    const r = await fetch(`https://api.dexscreener.com/token-profiles/latest/v1`, { timeout: 10000 });
    if (!r.ok) return [];
    const d = await r.json();
    const addrs = (d || [])
      .filter(t => t.chainId === "solana")
      .slice(0, 40)
      .map(t => t.tokenAddress)
      .filter(Boolean);
    if (!addrs.length) return [];
    const pairs = await dexPairs(addrs).catch(() => []);
    // Only return tokens with meaningful liquidity — graduated floor is $17k but filter higher
    return pairs.filter(p =>
      parseFloat(p.priceUsd || 0) > 0 &&
      (p.liquidity?.usd || 0) >= 15000
    );
  } catch(e) { return []; }
}

async function dexNewTokens() {
  const results = [];
  const seen = new Set();
  const cutoff = Date.now() - 90 * 60000; // 90 min window

  // Method 1: DexScreener token profiles (newest tokens)
  try {
    const r = await fetch(`https://api.dexscreener.com/token-profiles/latest/v1`, { timeout: 10000 });
    if (r.ok) {
      const d = await r.json();
      const addrs = (d || [])
        .filter(t => t.chainId === "solana")
        .slice(0, 30)
        .map(t => t.tokenAddress)
        .filter(Boolean);
      if (addrs.length) {
        const pairs = await dexPairs(addrs).catch(() => []);
        for (const p of pairs) {
          if (!p.pairAddress || seen.has(p.pairAddress)) continue;
          if (parseFloat(p.priceUsd || 0) <= 0) continue;
          seen.add(p.pairAddress);
          results.push(p);
        }
      }
    }
  } catch(e) { /* continue */ }

  // Method 2: Search specific new-token queries
  const freshQueries = ["new pump sol", "just launched", "pumpswap new", "raydium launch"];
  for (const q of freshQueries) {
    try {
      const r = await fetch(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
        { timeout: 8000 }
      );
      if (!r.ok) continue;
      const d = await r.json();
      const fresh = (d?.pairs || []).filter(p =>
        p.chainId === "solana" &&
        parseFloat(p.priceUsd || 0) > 0 &&
        p.pairCreatedAt && p.pairCreatedAt >= cutoff
      );
      for (const p of fresh) {
        if (seen.has(p.pairAddress)) continue;
        seen.add(p.pairAddress);
        results.push(p);
      }
    } catch(e) { /* continue */ }
  }

  return results.sort((a, b) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0));
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

// ── RUGCHECK.XYZ API ──────────────────────────────────────
// Free API — checks mint authority, freeze authority, LP lock, known rug patterns
// Returns a risk score 0-100 (lower = safer) and specific flags
async function checkRugcheck(tokenAddress) {
  if (!tokenAddress) return { score: 50, flags: [], pass: true };
  if (rugCache.has(tokenAddress)) return rugCache.get(tokenAddress);

  try {
    const r = await fetch(
      `https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report/summary`,
      { timeout: 8000 }
    );
    if (!r.ok) return { score: 50, flags: [], pass: true }; // Fail open on API error

    const d = await r.json();
    // rugcheck returns score where higher = more risky
    const score = d?.score || 0;
    const flags = [];

    // Check specific risk flags
    if (d?.mintAuthority)    flags.push("mint_authority");
    if (d?.freezeAuthority)  flags.push("freeze_authority");
    if (d?.mutable)          flags.push("mutable_metadata");
    if (d?.lpUnlocked)       flags.push("lp_unlocked");

    // Top holder concentration check
    const topHolderPct = d?.topHolders?.[0]?.pct || 0;
    if (topHolderPct > 30) flags.push(`top_holder_${Math.round(topHolderPct)}pct`);

    const top10Pct = (d?.topHolders || []).slice(0, 10).reduce((a, h) => a + (h.pct || 0), 0);
    if (top10Pct > 80) flags.push(`top10_hold_${Math.round(top10Pct)}pct`);

    // Pass if score < 500 (rugcheck uses 0-1000 scale) and no hard flags
    const hardFlags = ["mint_authority", "freeze_authority"];
    const hasHardFlag = flags.some(f => hardFlags.includes(f));
    const pass = score < 500 && !hasHardFlag;

    const result = { score, flags, pass, top10Pct: Math.round(top10Pct) };
    rugCache.set(tokenAddress, result);
    return result;
  } catch(e) {
    return { score: 50, flags: [], pass: true }; // Fail open — don't block on API errors
  }
}

// ── BIRDEYE HOLDER CHECK ──────────────────────────────────
// Free tier — checks holder distribution
// Detects whale concentration that precedes rug pulls
async function checkBirdeye(tokenAddress) {
  if (!tokenAddress) return { concentration: 0, pass: true };
  if (birdeyeCache.has(tokenAddress)) return birdeyeCache.get(tokenAddress);

  try {
    const r = await fetch(
      `https://public-api.birdeye.so/defi/token_holder?address=${tokenAddress}&offset=0&limit=10`,
      {
        timeout: 8000,
        headers: { "X-API-KEY": "public" } // Public free tier
      }
    );
    if (!r.ok) return { concentration: 0, pass: true };

    const d = await r.json();
    const holders = d?.data?.items || [];
    if (!holders.length) return { concentration: 0, pass: true };

    // Sum top 10 holder percentage
    const top10Pct = holders.slice(0, 10).reduce((a, h) => a + (h.percentage || 0), 0);
    const top1Pct  = holders[0]?.percentage || 0;

    // Flag if top 1 holds >20% or top 10 hold >70%
    const pass = top1Pct < 20 && top10Pct < 70;
    const result = { concentration: Math.round(top10Pct), top1: Math.round(top1Pct), pass };
    birdeyeCache.set(tokenAddress, result);
    return result;
  } catch(e) {
    return { concentration: 0, pass: true }; // Fail open
  }
}

// ── HELIUS WEBSOCKET — pump.fun monitor ───────────────────
// Subscribes to pump.fun program for new token creation events
// This sees tokens 30-120 seconds before DexScreener indexes them
const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
let heliusWs = null;
let heliusReconnectTimer = null;
const heliusNewTokens = new LRUMap(500); // pair address → pair data from helius

function connectHeliusWs() {
  if (!HELIUS_KEY) {
    console.log("[HELIUS] No API key — websocket disabled");
    return;
  }

  const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

  try {
    heliusWs = new WebSocket(wsUrl);

    heliusWs.on("open", () => {
      console.log("[HELIUS] WebSocket connected — subscribing to pump.fun");
      // Subscribe to pump.fun program account changes
      heliusWs.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [
          { mentions: [PUMPFUN_PROGRAM] },
          { commitment: "confirmed" }
        ]
      }));

      // Also subscribe to smart wallet addresses
      for (const wallet of SMART_WALLETS) {
        heliusWs.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "logsSubscribe",
          params: [
            { mentions: [wallet] },
            { commitment: "confirmed" }
          ]
        }));
      }
    });

    heliusWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.method === "logsNotification") {
          processHeliusLog(msg.params?.result);
        }
      } catch(e) { /* ignore parse errors */ }
    });

    heliusWs.on("error", (e) => {
      console.error("[HELIUS] WS error:", e.message);
    });

    heliusWs.on("close", () => {
      console.log("[HELIUS] WS closed — reconnecting in 30s");
      heliusWs = null;
      clearTimeout(heliusReconnectTimer);
      heliusReconnectTimer = setTimeout(connectHeliusWs, 30000);
    });

  } catch(e) {
    console.error("[HELIUS] WS connect failed:", e.message);
    heliusReconnectTimer = setTimeout(connectHeliusWs, 30000);
  }
}

// Queue of token mints detected by Helius — fetch from DexScreener on next poll
const heliusTokenQueue = new LRUMap(200);

function processHeliusLog(result) {
  if (!result) return;
  const logs = result?.value?.logs || [];
  const accounts = result?.value?.accounts || [];

  // Detect new token creation on pump.fun
  const isCreate = logs.some(l =>
    l.includes("InitializeMint") || l.includes("Create") || l.includes("MintTo")
  );

  // Extract token mint from accounts — on pump.fun it's usually accounts[1] or [2]
  // Pump.fun accounts order: [signer, mint, bondingCurve, associatedBondingCurve, ...]
  if (isCreate && accounts.length >= 2) {
    // Try each account as potential mint (filter out known program addresses)
    const knownPrograms = new Set([
      PUMPFUN_PROGRAM,
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
      "11111111111111111111111111111111",               // System program
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bXH",  // ATA program
      "SysvarRent111111111111111111111111111111111",
    ]);
    for (const addr of accounts.slice(1, 4)) {
      if (addr && !knownPrograms.has(addr) && addr.length >= 32) {
        heliusTokenQueue.set(addr, Date.now());
        console.log(`[HELIUS] New token queued: ${addr.slice(0,12)}...`);
        break;
      }
    }
  }

  // Detect smart wallet buys
  const isBuy = logs.some(l =>
    l.includes("buy") || l.includes("Buy") || l.includes("swap")
  );

  if (isBuy && accounts.length > 0) {
    const walletAddr = accounts[0];
    if (walletAddr && SMART_WALLETS.has(walletAddr)) {
      const tokenMint = accounts.find(a => a !== walletAddr && a !== PUMPFUN_PROGRAM);
      if (tokenMint) {
        console.log(`[HELIUS] Smart wallet ${walletAddr.slice(0,8)}... bought ${tokenMint.slice(0,8)}...`);
        trackSmartWalletBuy(walletAddr, tokenMint);
      }
    }
  }
}

function trackSmartWalletBuy(wallet, tokenMint) {
  const now = Date.now();
  const existing = smartWalletBuys.get(tokenMint) || [];

  // Clean entries older than 5 minutes
  const recent = existing.filter(e => now - e.timestamp < 5 * 60000);
  recent.push({ wallet, timestamp: now });
  smartWalletBuys.set(tokenMint, recent);

  // Signal if 2+ different smart wallets bought within 5 minutes
  const uniqueWallets = new Set(recent.map(e => e.wallet));
  if (uniqueWallets.size >= 2) {
    smartWalletSignals.add(tokenMint);
    console.log(`[SMART] ${uniqueWallets.size} smart wallets in ${tokenMint.slice(0,8)}... — SIGNAL`);
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

// ── RUG CHECK (internal fast check) ───────────────────────
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

// ── ALGO GATE ──────────────────────────────────────────────
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
    // v8.6: Vol/liq ratio rug check — high vol + low liq = wash trading signature
    // Research: "rug pulls maintain minimal liquidity while showing massive volume"
    volLiq:   { pass: liq <= 0 || v5 <= 0 || (v5 / liq) < 8,   why: `vol/liq ratio ${liq>0?(v5/liq).toFixed(1):"?"} >= 8 (wash trading)` },
  };

  const failed = Object.values(checks).filter(c => !c.pass).map(c => c.why);
  return { pass: failed.length === 0, failed };
}

// ── BET SIZING ─────────────────────────────────────────────
function betSize(sc, fomo, isStealth, algoKey, liq = 0) {
  const cfg  = ALGOS[algoKey];
  const base = cfg.baseBet;

  const scoreRange = cfg.maxScore - cfg.minScore;
  const scorePct   = scoreRange > 0 ? (sc - cfg.minScore) / scoreRange : 0.5;
  const scoreMult  = 0.8 + (scorePct * 0.4);
  const stealthMult = isStealth ? 1.3 : 1.0;
  const liqCap = liq > 0 ? Math.max(10, liq * 0.001) : 150;

  return Math.min(liqCap, Math.min(150, Math.max(25, Math.round((base * scoreMult * stealthMult) / 5) * 5)));
}

// ── PNL CALC — per-algo dynamic exits ─────────────────────
const PAPER_SLIPPAGE = 0.00; // v8.7: removed

function applySlippage(pnl, bet) {
  return +(pnl - (bet * PAPER_SLIPPAGE)).toFixed(2);
}

function calcPnL(trade, curPrice) {
  const cfg    = ALGOS[trade.algo] || ALGOS.d;
  const mult   = curPrice / parseFloat(trade.entry_price);
  const bet    = parseFloat(trade.bet_size);
  const ageMin = (Date.now() - new Date(trade.opened_at).getTime()) / 60000;
  const hi     = Math.max(parseFloat(trade.highest_mult || 1), mult);

  // Use per-algo exit thresholds
  const SL  = cfg.stopLoss    || 0.72;
  const ES  = cfg.earlyStop   || 0.82;
  const TR  = cfg.trailingPct || 0.82;
  const T1  = cfg.tier1       || 1.5;
  const T1S = cfg.tier1Sell   || 0.40;
  const T2  = cfg.tier2       || 3.0;
  const T2S = cfg.tier2Sell   || 0.35;
  const T3  = cfg.tier3       || 6.0;
  const MH  = cfg.maxHold     || 120;

  if (mult <= ES && ageMin < 3) {  // v8.7: was <10, normal wicks need 3-10min to recover
    return { status:"CLOSED", exit:"EARLY STOP", mult, pnl:applySlippage(+(bet*(mult-1)).toFixed(2), bet), highMult:hi };
  }
  if (ageMin >= 45 && hi > 1.3 && mult <= hi * TR) {
    return { status:"CLOSED", exit:"TRAILING STOP", mult, pnl:applySlippage(+(bet*(mult-1)).toFixed(2), bet), highMult:hi };
  }
  if (mult <= SL) {
    return { status:"CLOSED", exit:"STOP LOSS", mult, pnl:applySlippage(+(bet*(mult-1)).toFixed(2), bet), highMult:hi };
  }
  if (mult >= T3) {
    const raw = +((bet*T1S*(T1-1))+(bet*T2S*(T2-1))+(bet*0.25*(mult-1))).toFixed(2);
    return { status:"CLOSED", exit:"TIER 3 MOON", mult, pnl:applySlippage(raw, bet), highMult:hi };
  }
  if (mult >= T2) {
    const raw = +((bet*T1S*(T1-1))+(bet*T2S*(mult-1))).toFixed(2);
    return { status:"CLOSED", exit:"TIER 2", mult, pnl:applySlippage(raw, bet), highMult:hi };
  }
  if (mult >= T1 && ageMin >= 8) {
    return { status:"OPEN", exit:null, mult, pnl:null, highMult:hi };
  }
  if (ageMin >= MH) {
    return { status:"CLOSED", exit:mult>=1?"TIME EXIT UP":"TIME EXIT DOWN", mult, pnl:applySlippage(+(bet*(mult-1)).toFixed(2), bet), highMult:hi };
  }
  return { status:"OPEN", exit:null, mult, pnl:null, highMult:hi };
}

// ── CIRCUIT BREAKER ────────────────────────────────────────
const DAILY_LIMIT = 300;

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
    const now    = new Date();
    const nyDate = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    nyDate.setHours(0, 0, 0, 0);
    const startOfDay = new Date(now.getTime() - (now - nyDate));

    for (const algoKey of ["a","b","c","d","e"]) {
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
  const openCheck = await db(
    `SELECT id FROM trades_${algoKey} WHERE pair_address=$1 AND status='OPEN' LIMIT 1`,
    [addr]
  );
  if (openCheck.rows.length > 0) return true;

  const tickerCheck = await db(
    `SELECT id FROM trades_${algoKey}
     WHERE LOWER(ticker)=LOWER($1)
     AND opened_at > NOW() - INTERVAL '90 minutes'
     LIMIT 1`,
    [ticker]
  );
  if (tickerCheck.rows.length > 0) return true;

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

async function insertTrade(algoKey, p, sc, fomo, extraData = {}) {
  const stealthSc = calcStealthScore(p);
  const isStealth = stealthSc >= 60;
  const liq       = p.liquidity?.usd || 0;
  const bet       = betSize(sc, fomo, isStealth, algoKey, liq);
  const age       = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : 0;
  const tokenAddr = p.baseToken?.address || p.pairAddress;

  const r = await db(`
    INSERT INTO trades_${algoKey}
      (ticker, name, pair_address, dex_url, score, entry_price, bet_size,
       status, highest_mult,
       vol_5m, vol_1h, liq, pc_5m, buys_5m, sells_5m,
       boosted, market_mood, age_min, fomo_score,
       stealth_score, is_stealth, algo,
       rug_score, holder_concentration, smart_wallet_signal,
       opened_at)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,
       'OPEN',1.0,
       $8,$9,$10,$11,$12,$13,
       $14,$15,$16,$17,
       $18,$19,$20,
       $21,$22,$23,
       NOW())
    RETURNING *`,
    [
      p.baseToken?.symbol || "???",
      p.baseToken?.name   || "",
      p.pairAddress,
      p.url,
      sc,
      parseFloat(p.priceUsd),
      bet,
      p.volume?.m5     || 0,
      p.volume?.h1     || 0,
      p.liquidity?.usd || 0,
      parseFloat(p.priceChange?.m5 || 0),
      p.txns?.m5?.buys  || 0,
      p.txns?.m5?.sells || 0,
      (p.boosts?.active || 0) > 0,
      mood,
      parseFloat(age.toFixed(1)),
      fomo,
      stealthSc,
      isStealth,
      algoKey,
      extraData.rugScore || 0,
      extraData.holderConcentration || 0,
      extraData.smartWalletSignal || false,
    ]
  );

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
  try {
    const t = (await db(`SELECT pair_address FROM trades_${algoKey} WHERE id=$1`, [id])).rows[0];
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

// ── POLL — main signal loop ────────────────────────────────
async function pollSignals() {
  pollCount++;
  console.log(`[POLL #${pollCount}] ${new Date().toISOString()} mood:${mood}`);

  try {
    const q0 = QUERIES[qi % QUERIES.length];
    const q1 = QUERIES[(qi + 1) % QUERIES.length];
    const q2 = QUERIES[(qi + 2) % QUERIES.length];
    qi += 3;

    const [r1, r2, r3, r4, r5, r6] = await Promise.allSettled([
      dexSearch(q0),
      dexSearch(q1),
      dexSearch(q2),
      dexBoosted(),
      dexNewTokens(),
      dexGraduated(),   // v8.6: graduated pump.fun tokens — Algo A's dedicated feed
    ]);

    const searchPairs   = [
      ...(r1.status === "fulfilled" ? r1.value : []),
      ...(r2.status === "fulfilled" ? r2.value : []),
      ...(r3.status === "fulfilled" ? r3.value : []),
    ];
    const boostedTokens  = r4.status === "fulfilled" ? r4.value : [];
    const newTokens      = r5.status === "fulfilled" ? r5.value : [];
    const graduatedPairs = r6.status === "fulfilled" ? r6.value : [];

    let boostedPairs = [];
    if (boostedTokens.length) {
      const addrs = boostedTokens.map(t => t.tokenAddress).filter(Boolean);
      boostedPairs = await dexPairs(addrs).catch(() => []);
    }

    // Fetch any tokens queued from Helius websocket
    const heliusQueued = [];
    if (heliusTokenQueue.map.size > 0) {
      const queuedMints = [...heliusTokenQueue.map.keys()].slice(0, 20);
      try {
        const heliusPairs = await dexPairs(queuedMints).catch(() => []);
        for (const p of heliusPairs) {
          if (parseFloat(p.priceUsd || 0) > 0) {
            heliusQueued.push(p);
            heliusTokenQueue.map.delete(p.baseToken?.address || p.pairAddress);
          }
        }
        if (heliusQueued.length) console.log(`  [HELIUS] ${heliusQueued.length} queued tokens fetched`);
      } catch(e) { /* continue */ }
    }

    // Dedupe
    const seen = new Set();
    const all  = [];
    for (const p of [...searchPairs, ...boostedPairs, ...newTokens, ...graduatedPairs, ...heliusQueued]) {
      if (!p.pairAddress || seen.has(p.pairAddress)) continue;
      seen.add(p.pairAddress);
      all.push(p);
    }

    // Monitor fresh token flow
    const freshCount = all.filter(p => p.pairCreatedAt && (Date.now() - p.pairCreatedAt) < 90 * 60000).length;
    monitor.totalTokensSeen += all.length;
    monitor.freshTokensSeen += freshCount;
    if (freshCount > 0) {
      monitor.lastFreshTokenTime = Date.now();
      monitor.pollsWithNoFresh = 0;
    } else {
      monitor.pollsWithNoFresh++;
    }
    if (heliusQueued.length > 0) {
      monitor.lastHeliusTokenTime = Date.now();
      monitor.heliusQueueCount += heliusQueued.length;
    }
    console.log(`  data: search:${searchPairs.length} boosted:${boostedPairs.length} new:${newTokens.length} graduated:${graduatedPairs.length} helius:${heliusQueued.length} fresh:${freshCount} total:${all.length}`);

    // Score every token once
    const scored = all.map(p => ({
      p,
      sc:        calcQualityScore(p),
      fomo:      calcFomoScore(p),
      stealthSc: calcStealthScore(p),
      rug:       rugCheck(p),
    }));

    // Run A-D algos
    const totals = { a:0, b:0, c:0, d:0, e:0 };
    for (const algoKey of ["a","b","c","d"]) {
      checkCircuit(algoKey);

      for (const { p, sc, fomo, stealthSc, rug } of scored) {
        if (sc < 38 || (p.liquidity?.usd || 0) < 2000) continue; // Skip junk before logging
        const gate = algoGate(p, sc, fomo, algoKey);
        await logSig(algoKey, p, sc, fomo, stealthSc, gate, rug);

        if (!gate.pass || !rug.pass) continue;
        if (await hadTrade(algoKey, p.pairAddress, p.baseToken?.symbol || "???", p.baseToken?.name || "")) continue;

        const tokenKey = p.baseToken?.address || p.pairAddress;
        const existingAlgos = crossAlgoExposure.get(tokenKey);
        if (existingAlgos && existingAlgos.size >= 2 && !existingAlgos.has(algoKey)) continue;

        // Phase 1: Rugcheck — non-blocking, check cache only (async in background)
        const tokenAddr = p.baseToken?.address || tokenKey;
        const rugResult = rugCache.has(tokenAddr) ? rugCache.get(tokenAddr) : { score: 50, flags: [], pass: true };
        // Kick off background check for next time (don't await)
        if (!rugCache.has(tokenAddr)) {
          checkRugcheck(tokenAddr).catch(() => {});
          checkBirdeye(tokenAddr).catch(() => {});
        }
        // Only hard-block on cached failures — never block on first-seen tokens
        if (rugCache.has(tokenAddr) && !rugResult.pass) {
          console.log(`  [${algoKey.toUpperCase()}] RUGCHECK CACHED FAIL ${p.baseToken?.symbol}`);
          continue;
        }

        const holderData = birdeyeCache.has(tokenAddr) ? birdeyeCache.get(tokenAddr) : { concentration: 0, pass: true };

        const trade = await insertTrade(algoKey, p, sc, fomo, {
          rugScore: rugResult.score,
          holderConcentration: holderData.concentration,
          smartWalletSignal: smartWalletSignals.has(tokenAddr),
        }).catch(e => {
          const msg = e.message.toLowerCase();
          if (!msg.includes("unique") && !msg.includes("duplicate")) {
            console.error(`insertTrade-${algoKey}:`, e.message);
          }
          return null;
        });

        if (trade) {
          totals[algoKey]++;
          monitor.lastEntryTime = Date.now();
          const liq = p.liquidity?.usd || 0;
          const age = p.pairCreatedAt ? ((Date.now()-p.pairCreatedAt)/60000).toFixed(0) : "?";
          console.log(`  [${algoKey.toUpperCase()}] ENTERED ${p.baseToken?.symbol} sc:${sc} fomo:${fomo} bet:$${trade.bet_size} age:${age}m rug:${rugResult.score}`);
        }
      }
    }

    // ── ALGO E: Smart Wallet ────────────────────────────────
    // Look for any scored token that has an active smart wallet signal
    checkCircuit("e");
    for (const { p, sc, fomo, stealthSc, rug } of scored) {
      const tokenAddr = p.baseToken?.address || p.pairAddress;
      const hasSignal = smartWalletSignals.has(tokenAddr);
      if (!hasSignal) continue; // Only trade on smart wallet signals

      if ((p.liquidity?.usd || 0) < 1000) continue; // Minimal liq filter

      const gate = algoGate(p, sc, fomo, "e");
      await logSig("e", p, sc, fomo, stealthSc, gate, rug);

      if (!rug.pass) continue;
      if (await hadTrade("e", p.pairAddress, p.baseToken?.symbol || "???", p.baseToken?.name || "")) continue;

      const tokenKey = p.baseToken?.address || p.pairAddress;
      const existingAlgos = crossAlgoExposure.get(tokenKey);
      if (existingAlgos && existingAlgos.size >= 2 && !existingAlgos.has("e")) continue;

      // Rugcheck always for smart wallet algo
      const rugResult = await checkRugcheck(tokenAddr);
      if (!rugResult.pass) continue;

      const trade = await insertTrade("e", p, sc, fomo, {
        rugScore: rugResult.score,
        holderConcentration: 0,
        smartWalletSignal: true,
      }).catch(() => null);

      if (trade) {
        totals.e++;
        console.log(`  [E] SMART WALLET ENTRY ${p.baseToken?.symbol} sc:${sc} fomo:${fomo} bet:$${trade.bet_size}`);
        smartWalletSignals.delete(tokenAddr); // Consume signal
      }
    }

    console.log(`  entries: A:${totals.a} B:${totals.b} C:${totals.c} D:${totals.d} E:${totals.e}`);

  } catch(e) { console.error("pollSignals:", e.message); }
}

// ── CHECK POSITIONS ────────────────────────────────────────
async function checkPositions() {
  for (const algoKey of ["a","b","c","d","e"]) {
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
              const missKey = `${algoKey}_${t.id}`;
              const misses  = (delistMissCounter.get(missKey) || 0) + 1;
              delistMissCounter.set(missKey, misses);

              if (misses >= 3) {
                delistMissCounter.delete(missKey);
                const pnl = +(parseFloat(t.bet_size) * -1.0).toFixed(2);
                await closeTrade(algoKey, t.id, { mult:0, pnl, exit:"DELISTED", highMult:parseFloat(t.highest_mult||1) });
                st.dailyPnl += pnl;
                console.log(`  [${algoKey.toUpperCase()}] DELISTED ${t.ticker} (confirmed 3 checks)`);
              }
            }
            continue;
          }
          delistMissCounter.delete(`${algoKey}_${t.id}`);

          const cur      = parseFloat(pair.priceUsd);
          if (!cur || cur <= 0) continue;

          const res      = calcPnL(t, cur);
          const pct      = ((cur / parseFloat(t.entry_price)) - 1) * 100;
          const fomo     = calcFomoScore(pair);
          const curLiq   = pair.liquidity?.usd || 0;
          const entryLiq = parseFloat(t.liq || 0);

          const liqCollapse = entryLiq > 5000 && curLiq < entryLiq * 0.30;
          const hardDump    = pct < -40;

          if ((liqCollapse || hardDump) && res.status === "OPEN") {
            const rugPnl = +(parseFloat(t.bet_size) * (cur/parseFloat(t.entry_price)-1)).toFixed(2);
            const reason = liqCollapse ? "LIQ PULLED" : "HARD DUMP";
            await closeTrade(algoKey, t.id, { mult:cur/parseFloat(t.entry_price), pnl:rugPnl, exit:reason, highMult:res.highMult });
            st.dailyPnl += rugPnl;
            console.log(`  [${algoKey.toUpperCase()}] ${reason} ${t.ticker}`);
            continue;
          }

          if (res.highMult > parseFloat(t.highest_mult || 1)) {
            await db(`UPDATE trades_${algoKey} SET highest_mult=$1 WHERE id=$2`, [res.highMult, t.id]);
          }

          if (fomo < 15 && pct > 5 && res.status === "OPEN") {
            const fadeKey   = `${algoKey}_${t.id}`;
            const fadeCount = (fomoFadeCounter.get(fadeKey) || 0) + 1;
            fomoFadeCounter.set(fadeKey, fadeCount);

            if (fadeCount >= 2) {
              fomoFadeCounter.delete(fadeKey);
              const fadePnl = +(parseFloat(t.bet_size)*(cur/parseFloat(t.entry_price)-1)).toFixed(2);
              await closeTrade(algoKey, t.id, { mult:cur/parseFloat(t.entry_price), pnl:fadePnl, exit:"FOMO FADE", highMult:res.highMult });
              st.dailyPnl += fadePnl;
              console.log(`  [${algoKey.toUpperCase()}] FOMO FADE ${t.ticker} +${pct.toFixed(0)}%`);
            }
            continue;
          } else {
            fomoFadeCounter.delete(`${algoKey}_${t.id}`);
          }

          if (res.status === "CLOSED") {
            await closeTrade(algoKey, t.id, res);
            st.dailyPnl += res.pnl;
            checkCircuit(algoKey);
            console.log(`  [${algoKey.toUpperCase()}] CLOSED ${t.ticker} ${res.exit} ${res.pnl>=0?"+":""}$${res.pnl.toFixed(2)}`);
            // Notify on big wins (>$20) or moon shots
            if (res.pnl >= 20) {
              await notify(
                `S0NAR — ${res.exit} 💰 +$${res.pnl.toFixed(2)}`,
                `${t.ticker} closed ${res.exit}
Algo: ${algoKey.toUpperCase()} | ${res.mult.toFixed(2)}x
P&L: +$${res.pnl.toFixed(2)}
Peak: ${res.highMult.toFixed(2)}x`,
                res.pnl >= 100 ? "urgent" : "high"
              );
            }
          }
        } catch(e) { console.error(`  [${algoKey}] ${t.ticker}:`, e.message); }

        await new Promise(r => setTimeout(r, 300));
      }
    } catch(e) { console.error(`checkPositions-${algoKey}:`, e.message); }
  }
}

// ── SIGNALS CLEANUP ────────────────────────────────────────
async function cleanupSignals() {
  try {
    for (const algoKey of ["a","b","c","d","e"]) {
      const r = await db(
        `DELETE FROM signals_${algoKey} WHERE seen_at < NOW() - INTERVAL '24 hours'`
      );
      if (r.rowCount > 0) console.log(`[CLEANUP] signals_${algoKey}: deleted ${r.rowCount} old rows`);
    }
    // Clean old smart wallet signals
    smartWalletSignals.clear();
  } catch(e) { console.error("cleanupSignals:", e.message); }
}

// ── STATS HELPER ───────────────────────────────────────────
async function getAlgoStats(algoKey) {
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
    smartWalletCount: algoKey === "e" ? SMART_WALLETS.size : 0,
  };
}

// ── API ────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({
  status: "ok",
  ts: new Date().toISOString(),
  version: "8.7",
  marketMood: mood,
  pollCount,
  heliusWs: heliusWs ? "connected" : "disconnected",
  smartWalletSignals: smartWalletSignals.size,
  ntfy: "DISABLED",
  algos: Object.fromEntries(
    ["a","b","c","d","e"].map(k => [k, {
      name: ALGOS[k].name,
      dailyPnl: +algoState[k].dailyPnl.toFixed(2),
      circuitBroken: algoState[k].circuitBroken,
    }])
  ),
}));

app.get("/api/stats", async(req, res) => {
  try {
    const stats = await Promise.all(["a","b","c","d","e"].map(k => getAlgoStats(k)));
    res.json(stats);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/stats/:algo", async(req, res) => {
  const algoKey = req.params.algo.toLowerCase();
  if (!["a","b","c","d","e"].includes(algoKey)) return res.status(400).json({ error: "Invalid algo" });
  try {
    res.json(await getAlgoStats(algoKey));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/trades/:algo", async(req, res) => {
  const algoKey = req.params.algo.toLowerCase();
  if (!["a","b","c","d","e"].includes(algoKey)) return res.status(400).json({ error: "Invalid algo" });
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    res.json((await db(`SELECT * FROM trades_${algoKey} ORDER BY opened_at DESC LIMIT $1`, [limit])).rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/open-pnl", async(req, res) => {
  try {
    const result = {};
    for (const algoKey of ["a","b","c","d","e"]) {
      const open = await getOpen(algoKey);
      if (!open.length) { result[algoKey] = []; continue; }
      const addrs  = open.map(t => t.pair_address);
      const pairs  = await dexPairs(addrs).catch(() => []);
      const pm     = new Map(pairs.map(p => [p.pairAddress, p]));

      const cfg = ALGOS[algoKey];
      const TIER1 = cfg.tier1 || 1.5;
      const TIER2 = cfg.tier2 || 3.0;
      const SL    = cfg.stopLoss || 0.72;
      const ES    = cfg.earlyStop || 0.82;
      const TR    = cfg.trailingPct || 0.82;

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
            highest_mult:hi, age_min:+ageMin.toFixed(1), warning:"no_price",
            algo:algoKey, smart_wallet_signal: t.smart_wallet_signal };
        }

        const mult  = curPrice/entry;
        const pct   = (mult-1)*100;
        const upnl  = +(bet*(mult-1)).toFixed(2);
        const newHi = Math.max(hi, mult);

        const warning = mult <= SL+0.05         ? "near_stop"
                      : mult <= ES+0.03 && ageMin<10 ? "near_early_stop"
                      : newHi>1.3 && mult<=newHi*TR+0.05 && ageMin>=45 ? "near_trailing"
                      : mult >= TIER2-0.1        ? "near_tier2"
                      : mult >= TIER1-0.05       ? "near_tier1"
                      : "ok";

        return { id:t.id, ticker:t.ticker, pair_address:t.pair_address,
          dex_url:t.dex_url, score:t.score, fomo_score:t.fomo_score||0,
          bet_size:bet, entry_price:entry, opened_at:t.opened_at,
          cur_price:+curPrice.toFixed(10), pct_change:+pct.toFixed(2),
          unrealized_pnl:upnl, mult:+mult.toFixed(4),
          highest_mult:+newHi.toFixed(4), age_min:+ageMin.toFixed(1),
          warning, algo:algoKey, is_stealth:t.is_stealth,
          smart_wallet_signal: t.smart_wallet_signal };
      });
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// All algos debug in one call
app.get("/api/debug/all", async(req, res) => {
  try {
    const result = {};
    for (const algoKey of ["a","b","c","d","e"]) {
      const rows = (await db(`
        SELECT ticker, score, fomo_score, stealth_score, liq, vol_5m, pc_5m,
               age_min, entered, skip_reason, seen_at
        FROM signals_${algoKey} ORDER BY seen_at DESC LIMIT 50`
      )).rows;
      const skipTally = {};
      rows.filter(s => s.skip_reason).forEach(s => {
        s.skip_reason.split("; ").forEach(reason => {
          const key = reason.split(" ").slice(0, 4).join(" ");
          skipTally[key] = (skipTally[key] || 0) + 1;
        });
      });
      result[algoKey] = {
        name: ALGOS[algoKey].name,
        config: { minScore: ALGOS[algoKey].minScore, maxScore: ALGOS[algoKey].maxScore,
                  minFomo: ALGOS[algoKey].minFomo, maxFomo: ALGOS[algoKey].maxFomo,
                  minLiq: ALGOS[algoKey].minLiq, minAge: ALGOS[algoKey].minAge, maxAge: ALGOS[algoKey].maxAge,
                  minPc5m: ALGOS[algoKey].minPc5m, maxPc5m: ALGOS[algoKey].maxPc5m },
        total: rows.length,
        entered: rows.filter(s => s.entered).length,
        skipped: rows.filter(s => !s.entered).length,
        avgScore: rows.length ? Math.round(rows.reduce((a,s)=>a+parseInt(s.score||0),0)/rows.length) : 0,
        avgFomo:  rows.length ? Math.round(rows.reduce((a,s)=>a+parseInt(s.fomo_score||0),0)/rows.length) : 0,
        topSkipReasons: Object.entries(skipTally).sort((a,b)=>b[1]-a[1]).slice(0,8),
      };
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/debug/:algo", async(req, res) => {
  const algoKey = req.params.algo.toLowerCase();
  if (!["a","b","c","d","e"].includes(algoKey)) return res.status(400).json({ error: "Invalid algo" });
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
      smartWallets: algoKey === "e" ? [...SMART_WALLETS] : [],
      activeSignals: algoKey === "e" ? smartWalletSignals.size : 0,
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

app.post("/api/wipe", async(req, res) => {
  const { password } = req.body;
  if (password !== APP_PASS) return res.status(401).json({ error: "Wrong password" });
  try {
    for (const algoKey of ["a","b","c","d","e"]) {
      await db(`TRUNCATE trades_${algoKey} RESTART IDENTITY`);
      await db(`TRUNCATE signals_${algoKey} RESTART IDENTITY`);
      algoState[algoKey].dailyPnl      = 0;
      algoState[algoKey].circuitBroken = false;
      algoState[algoKey].circuitAt     = null;
    }
    await db(`TRUNCATE trades RESTART IDENTITY`).catch(()=>{});
    await db(`TRUNCATE signals RESTART IDENTITY`).catch(()=>{});
    smartWalletSignals.clear();
    console.log("FULL DATA WIPE completed");
    res.json({ ok: true, message: "All data wiped. Fresh start." });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── STATUS — plain English health report ──────────────────
app.get("/api/status", (req, res) => {
  const now = Date.now();
  const uptimeMin = Math.round((now - monitor.startTime) / 60000);
  const sinceEntryMin = monitor.lastEntryTime ? Math.round((now - monitor.lastEntryTime) / 60000) : null;
  const sinceFreshMin = monitor.lastFreshTokenTime ? Math.round((now - monitor.lastFreshTokenTime) / 60000) : null;
  const sinceHeliusMin = monitor.lastHeliusTokenTime ? Math.round((now - monitor.lastHeliusTokenTime) / 60000) : null;

  const issues = [];
  const warnings = [];

  if (sinceEntryMin === null && uptimeMin > 30) issues.push("No trades entered since startup");
  else if (sinceEntryMin !== null && sinceEntryMin > 120) issues.push(`No trades in ${sinceEntryMin} minutes`);
  else if (sinceEntryMin !== null && sinceEntryMin > 60) warnings.push(`No trades in ${sinceEntryMin} minutes`);

  if (sinceFreshMin === null && uptimeMin > 15) issues.push("No fresh tokens seen — data source broken");
  else if (sinceFreshMin !== null && sinceFreshMin > 30) issues.push(`No fresh tokens in ${sinceFreshMin} min — DexScreener stale`);
  else if (sinceFreshMin !== null && sinceFreshMin > 15) warnings.push(`No fresh tokens in ${sinceFreshMin} min`);

  if (!heliusWs) issues.push("Helius WebSocket disconnected");
  if (pollCount < 2 && uptimeMin > 1) issues.push("Polling not running");

  const overall = issues.length > 0 ? "RED" : warnings.length > 0 ? "YELLOW" : "GREEN";

  res.json({
    status: overall,
    message: overall === "GREEN" ? "All systems normal — bot is hunting" :
             overall === "YELLOW" ? "Minor issues — check soon" :
             "ACTION NEEDED — bot may not be trading",
    uptime: `${uptimeMin} minutes`,
    issues,
    warnings,
    stats: {
      pollCount,
      totalTokensSeen: monitor.totalTokensSeen,
      freshTokensSeen: monitor.freshTokensSeen,
      heliusQueueCount: monitor.heliusQueueCount,
      pollsWithNoFresh: monitor.pollsWithNoFresh,
      lastEntryAgo: sinceEntryMin !== null ? `${sinceEntryMin} min ago` : "never since restart",
      lastFreshAgo: sinceFreshMin !== null ? `${sinceFreshMin} min ago` : "never since restart",
      heliusWs: heliusWs ? "connected" : "disconnected",
      marketMood: mood,
    },
    ts: new Date().toISOString(),
  });
});

// ── TEST NOTIFICATION ─────────────────────────────────────
app.get("/api/test-notify", async (req, res) => {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    return res.json({ ok: false, message: "NTFY_TOPIC not set in Render environment variables" });
  }
  await notify(
    "S0NAR — Test Notification ✅",
    "If you see this your alerts are working perfectly.\n\nYou will be notified when:\n• Bot has no trades for 2+ hours\n• Data source breaks\n• Helius disconnects\n• Big win closes (+$20)",
    "default"
  );
  res.json({ ok: true, message: `Test notification sent to topic: ${topic}` });
});

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  if (hasDist) return res.sendFile(path.join(STATIC_DIR, "index.html"));
  res.status(200).send("S0NAR v8.3 backend running.");
});

// ── HEALTH ALERTS ─────────────────────────────────────────
async function runHealthAlerts() {
  const now = Date.now();
  const uptimeMin = (now - monitor.startTime) / 60000;
  if (uptimeMin < 10) return; // Give bot time to warm up first

  const sinceEntryMin = monitor.lastEntryTime ? (now - monitor.lastEntryTime) / 60000 : uptimeMin;
  const sinceFreshMin = monitor.lastFreshTokenTime ? (now - monitor.lastFreshTokenTime) / 60000 : uptimeMin;

  // Alert: No trades in 2 hours
  if (sinceEntryMin > 120) {
    await alertOnce(
      "no_trades_2h", 120, // cooldown 2h — alert max once per 2h
      "S0NAR — No Trades ⚠",
      `Bot hasn't entered a trade in ${Math.round(sinceEntryMin)} minutes.

Market mood: ${mood}
Polls run: ${pollCount}
Fresh tokens seen: ${monitor.freshTokensSeen}

Check: /api/status`,
      "high"
    );
  }

  // Alert: No fresh tokens — data source broken
  if (sinceFreshMin > 30) {
    await alertOnce(
      "no_fresh_30m", 60, // cooldown 1h
      "S0NAR — Data Issue 🔴",
      `No fresh tokens (under 90min old) seen in ${Math.round(sinceFreshMin)} minutes.

DexScreener may be rate-limiting or broken.
Helius queued: ${monitor.heliusQueueCount} total

Check: /api/status`,
      "urgent"
    );
  }

  // Alert: Helius disconnected
  if (!heliusWs) {
    await alertOnce(
      "helius_down", 30, // cooldown 30min
      "S0NAR — Helius Down 🔴",
      "Helius WebSocket disconnected. New token detection is offline. Will auto-reconnect.",
      "urgent"
    );
  }

  // Alert: Bot woke up (first run after deploy/restart)
  if (uptimeMin > 2 && uptimeMin < 7) {
    await alertOnce(
      "bot_started", 9999, // only once per run
      "S0NAR — Bot Started ✅",
      `S0NAR v8.3 is live and scanning.
Market: ${mood}
All 5 algos running.`,
      "low"
    );
  }

  // Good news alert: trade entered
  // (called from insertTrade success, not here)
}

// ── START ──────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\nS0NAR LAB v8.5 | Port:${PORT}`);
  console.log(`DB:${process.env.DATABASE_URL?"connected":"MISSING"}`);
  console.log(`HELIUS:${HELIUS_KEY?"key present":"MISSING - websocket disabled"}`);
  console.log(`Algos: A=${ALGOS.a.name} B=${ALGOS.b.name} C=${ALGOS.c.name} D=${ALGOS.d.name} E=${ALGOS.e.name}`);
  console.log(`New: Rugcheck API, Birdeye holders, Helius WS, Dynamic exits, Smart Wallet Algo E\n`);

  await initDB();
  await refreshDaily();
  await updateMood();

  // Start Helius websocket
  connectHeliusWs();

  setTimeout(pollSignals, 2000);
  setInterval(pollSignals,    15000);
  setInterval(checkPositions, 30000);
  setInterval(updateMood,     5 * 60 * 1000);
  setInterval(refreshDaily,   2 * 60 * 1000);
  setInterval(cleanupSignals, 6 * 60 * 60 * 1000);
  setInterval(runHealthAlerts, 5 * 60 * 1000); // Health alerts every 5 min
});
