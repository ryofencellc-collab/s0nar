// ============================================================
//  S0NAR — WAVE RIDER v10.0
//  THE BIG TEST — 5 Data Sources × 10 Algo Variants = 50 Trading Slots
//
//  DATA SOURCES:
//  SRC-A: PumpPortal WebSocket (push, zero polling, zero 429s)
//  SRC-B: Helius Standard WebSocket (push, Solana native)
//  SRC-C: DexScreener polling (control group, current system)
//  SRC-D: Jupiter Price API (no rate limits, REST polling)
//  SRC-E: DexScreener + Helius hybrid (best of both)
//
//  10 ALGO VARIANTS PER SOURCE:
//  1-ULTRA_SAFE:  liq>$20k, fomo 10-40, age 20-120m, score>45
//  2-WAVE:        liq>$10k, fomo 5-80,  age 5-180m,  score>38
//  3-SURGE:       liq>$5k,  fomo 15-85, age 3-480m,  score>38
//  4-STEADY:      liq>$15k, fomo 0-60,  age 10-300m, score>38
//  5-ROCKET:      liq>$5k,  fomo 8-88,  age 3-150m,  score>38
//  6-SNIPER:      liq>$8k,  fomo 20-70, age 3-20m,   score>40
//  7-WHALE:       liq>$50k, fomo 0-99,  age 5-999m,  score>35
//  8-FOMO_RIDER:  liq>$5k,  fomo 50-90, age 5-60m,   score>38
//  9-QUIET:       liq>$15k, fomo 0-25,  age 20-200m, score>40
//  10-MICRO:      liq>$3k,  fomo 5-99,  age 3-999m,  score>35
//
//  Each slot tagged with source+variant for morning analysis
// ============================================================

const express   = require("express");
const cors      = require("cors");
const fetch     = require("node-fetch");
const WebSocket = require("ws");
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
  try {
    const c = await pool.connect();
    try {
      const r = await c.query(sql, params);
      if (typeof sysStatus !== "undefined") {
        sysStatus.database.ok     = true;
        sysStatus.database.lastAt = new Date().toISOString();
        sysStatus.database.err    = null;
      }
      return r;
    } finally { c.release(); }
  } catch (e) {
    if (typeof sysStatus !== "undefined") {
      sysStatus.database.ok  = false;
      sysStatus.database.err = e.message;
      sysErr("database", e.message);
    }
    throw e;
  }
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
  data_source TEXT DEFAULT 'unknown',
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
  data_source TEXT DEFAULT 'unknown',
  seen_at TIMESTAMPTZ DEFAULT NOW()
`;

// Slot keys: source letter (a-e) + variant number (1-10)
// a1=PumpPortal+ULTRA_SAFE, a2=PumpPortal+WAVE, etc.
const SOURCE_KEYS  = ["a","b","c","d","e"];
const VARIANT_KEYS = ["1","2","3","4","5","6","7","8","9","10"];

// All 50 slot keys
const ALL_SLOTS = SOURCE_KEYS.flatMap(s => VARIANT_KEYS.map(v => s+v));

async function initDB() {
  for (const slot of ALL_SLOTS) {
    await db(`CREATE TABLE IF NOT EXISTS trades_${slot} (${TRADE_COLS})`);
    await db(`CREATE TABLE IF NOT EXISTS signals_${slot} (${SIGNAL_COLS})`);
    await db(`CREATE INDEX IF NOT EXISTS idx_tr_${slot}_status ON trades_${slot}(status)`);
    await db(`CREATE INDEX IF NOT EXISTS idx_tr_${slot}_opened ON trades_${slot}(opened_at DESC)`);
    await db(`CREATE INDEX IF NOT EXISTS idx_sig_${slot}_seen ON signals_${slot}(seen_at DESC)`);
    await pool.query(`ALTER TABLE trades_${slot} ADD COLUMN IF NOT EXISTS data_source TEXT DEFAULT 'unknown'`).catch(()=>{});
    await pool.query(`ALTER TABLE trades_${slot} ADD COLUMN IF NOT EXISTS rug_score INTEGER DEFAULT 0`).catch(()=>{});
  }
  console.log(`DB ready — v10.0 (${ALL_SLOTS.length} slots initialized)`);
}

// ── AUTH ───────────────────────────────────────────────────
const PORT     = process.env.PORT || 3000;
const APP_PASS = process.env.APP_PASSWORD || "sonar2024";
const SECRET   = process.env.SESSION_SECRET || "sonar-secret-key";
const HELIUS_KEY = process.env.HELIUS_API_KEY || "";

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

// ── DATA SOURCE NAMES ─────────────────────────────────────
const SOURCE_NAMES = {
  a: "PumpPortal-WebSocket",
  b: "Helius-WebSocket",
  c: "DexScreener-Poll",
  d: "Jupiter-API",
  e: "DexScreen+Helius-Hybrid",
};

// ── ALGO VARIANT CONFIGS ──────────────────────────────────
const VARIANTS = {
  "1": { name:"ULTRA_SAFE",  minScore:43, maxScore:99, minFomo:5,   maxFomo:55,  minLiq:15000, minVol5m:200, minBuyPct:51, minAge:10,  maxAge:180,  minPc5m:-3,  maxPc5m:50,  baseBet:30, stopLoss:0.85, earlyStop:0.90, earlyStopMinutes:5,  trailingPct:0.87, trailingActivateMin:25, tier1:1.4,  tier1Sell:0.60, tier2:2.0,  tier2Sell:0.25, tier3:4.0,  maxHold:60  },
  "2": { name:"WAVE",        minScore:38, maxScore:99, minFomo:5,   maxFomo:80,  minLiq:10000, minVol5m:150, minBuyPct:50, minAge:5,   maxAge:180,  minPc5m:-5,  maxPc5m:80,  baseBet:25, stopLoss:0.84, earlyStop:0.88, earlyStopMinutes:5,  trailingPct:0.85, trailingActivateMin:20, tier1:1.35, tier1Sell:0.60, tier2:1.80, tier2Sell:0.30, tier3:3.0,  maxHold:45  },
  "3": { name:"SURGE",       minScore:38, maxScore:99, minFomo:15,  maxFomo:85,  minLiq:5000,  minVol5m:150, minBuyPct:50, minAge:3,   maxAge:480,  minPc5m:-5,  maxPc5m:85,  baseBet:20, stopLoss:0.82, earlyStop:0.86, earlyStopMinutes:5,  trailingPct:0.84, trailingActivateMin:15, tier1:1.30, tier1Sell:0.65, tier2:1.70, tier2Sell:0.25, tier3:2.5,  maxHold:30  },
  "4": { name:"STEADY",      minScore:38, maxScore:88, minFomo:0,   maxFomo:60,  minLiq:15000, minVol5m:100, minBuyPct:48, minAge:10,  maxAge:300,  minPc5m:-10, maxPc5m:30,  baseBet:30, stopLoss:0.74, earlyStop:0.82, earlyStopMinutes:10, trailingPct:0.82, trailingActivateMin:30, tier1:1.50, tier1Sell:0.40, tier2:3.0,  tier2Sell:0.35, tier3:6.0,  maxHold:120 },
  "5": { name:"ROCKET",      minScore:38, maxScore:99, minFomo:8,   maxFomo:88,  minLiq:5000,  minVol5m:150, minBuyPct:50, minAge:3,   maxAge:150,  minPc5m:-5,  maxPc5m:100, baseBet:20, stopLoss:0.80, earlyStop:0.85, earlyStopMinutes:3,  trailingPct:0.83, trailingActivateMin:10, tier1:1.25, tier1Sell:0.70, tier2:1.60, tier2Sell:0.20, tier3:2.5,  maxHold:25  },
  "6": { name:"SNIPER",      minScore:40, maxScore:99, minFomo:20,  maxFomo:70,  minLiq:8000,  minVol5m:200, minBuyPct:55, minAge:3,   maxAge:20,   minPc5m:0,   maxPc5m:60,  baseBet:20, stopLoss:0.82, earlyStop:0.87, earlyStopMinutes:3,  trailingPct:0.84, trailingActivateMin:10, tier1:1.30, tier1Sell:0.65, tier2:2.0,  tier2Sell:0.25, tier3:4.0,  maxHold:20  },
  "7": { name:"WHALE",       minScore:38, maxScore:99, minFomo:0,   maxFomo:99,  minLiq:20000, minVol5m:200, minBuyPct:45, minAge:5,   maxAge:9999, minPc5m:-20, maxPc5m:200, baseBet:35, stopLoss:0.80, earlyStop:0.88, earlyStopMinutes:10, trailingPct:0.85, trailingActivateMin:30, tier1:1.40, tier1Sell:0.50, tier2:2.5,  tier2Sell:0.30, tier3:5.0,  maxHold:180 },
  "8": { name:"FOMO_RIDER",  minScore:38, maxScore:99, minFomo:30,  maxFomo:90,  minLiq:5000,  minVol5m:150, minBuyPct:52, minAge:5,   maxAge:60,   minPc5m:5,   maxPc5m:80,  baseBet:20, stopLoss:0.82, earlyStop:0.87, earlyStopMinutes:3,  trailingPct:0.83, trailingActivateMin:8,  tier1:1.25, tier1Sell:0.70, tier2:1.60, tier2Sell:0.20, tier3:2.5,  maxHold:20  },
  "9": { name:"QUIET",       minScore:38, maxScore:88, minFomo:0,   maxFomo:35,  minLiq:10000, minVol5m:100, minBuyPct:50, minAge:10,  maxAge:200,  minPc5m:-5,  maxPc5m:15,  baseBet:30, stopLoss:0.76, earlyStop:0.84, earlyStopMinutes:10, trailingPct:0.83, trailingActivateMin:30, tier1:1.50, tier1Sell:0.45, tier2:3.0,  tier2Sell:0.35, tier3:7.0,  maxHold:120 },
  "10":{ name:"MICRO",       minScore:35, maxScore:99, minFomo:5,   maxFomo:99,  minLiq:3000,  minVol5m:50,  minBuyPct:48, minAge:3,   maxAge:9999, minPc5m:-20, maxPc5m:999, baseBet:15, stopLoss:0.78, earlyStop:0.85, earlyStopMinutes:3,  trailingPct:0.82, trailingActivateMin:8,  tier1:1.20, tier1Sell:0.70, tier2:1.50, tier2Sell:0.20, tier3:2.0,  maxHold:15  },
};

const DAILY_LIMIT = 50;   // $50/day per slot before circuit breaks
const FETCH_MS    = 20000; // DexScreener poll interval (longer = fewer 429s)
const CHECK_MS    = 25000; // Position check interval

// ── RUNTIME STATE ──────────────────────────────────────────
let mood      = "normal";
let pollCount = 0;
let qi        = 0;

// Per-slot state
const slotState = {};
for (const slot of ALL_SLOTS) {
  slotState[slot] = { dailyPnl:0, circuitBroken:false, circuitAt:null };
}

class LRUMap {
  constructor(max) { this.max=max; this.map=new Map(); }
  has(k) { return this.map.has(k); }
  get(k) { const v=this.map.get(k); if(v!==undefined){this.map.delete(k);this.map.set(k,v);} return v; }
  set(k,v) { if(this.map.has(k))this.map.delete(k); else if(this.map.size>=this.max)this.map.delete(this.map.keys().next().value); this.map.set(k,v); }
}

const volHistory        = new LRUMap(5000);
const fomoHistory       = new LRUMap(5000);
const rugCache          = new LRUMap(2000);
const fomoFadeCounter   = new Map();
const delistMissCounter = new Map();
const crossSlotExposure = new Map();

// ── SYSTEM STATUS ─────────────────────────────────────────
const sysStatus = {
  sources: {
    a: { name:"PumpPortal-WS",    ok:null, connected:false, lastMsg:null, tokensReceived:0, err:null },
    b: { name:"Helius-WS",        ok:null, connected:false, lastMsg:null, tokensReceived:0, err:null },
    c: { name:"DexScreener-Poll", ok:null, lastMs:null,     lastAt:null,  tokensReceived:0, err:null },
    d: { name:"Jupiter-API",      ok:null, lastMs:null,     lastAt:null,  tokensReceived:0, err:null },
    e: { name:"Hybrid",           ok:null, lastMs:null,     lastAt:null,  tokensReceived:0, err:null },
  },
  database:   { ok:null, lastAt:null, err:null },
  rugcheck:   { ok:null, lastMs:null, lastAt:null, err:null, passRate:null },
  lastErrors: [],
  rugLog:     [],
  funnel:     {},
};

// Initialize funnel for all 50 slots
for (const slot of ALL_SLOTS) {
  sysStatus.funnel[slot] = { seen:0, gate:0, rugPass:0, entered:0 };
}

function sysErr(source, msg) {
  const entry = { source, msg, at:new Date().toISOString() };
  sysStatus.lastErrors.unshift(entry);
  if (sysStatus.lastErrors.length>20) sysStatus.lastErrors.pop();
}

// ── SEARCH QUERIES (for DexScreener polling) ──────────────
const QUERIES = [
  "pump.fun","pumpfun","pump fun sol",
  "dog sol","cat sol","frog sol","pepe sol","doge sol",
  "hamster sol","bear sol","bull sol","wolf sol","ape sol",
  "based sol","wagmi sol","moon sol","gem sol",
  "ai sol","robot sol","solana meme","sol token",
  "raydium new","jupiter new","sol gem","100x sol",
];

// ── DEXSCREENER ────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));

async function dexSearch(q) {
  const t0 = Date.now();
  try {
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
      { timeout:10000 }
    );
    sysStatus.sources.c.lastMs = Date.now()-t0;
    sysStatus.sources.c.lastAt = new Date().toISOString();
    if (!r.ok) {
      sysStatus.sources.c.ok  = false;
      sysStatus.sources.c.err = `HTTP ${r.status}`;
      sysErr("dexscreener", `HTTP ${r.status}`);
      throw new Error(`dexSearch HTTP ${r.status}`);
    }
    const d = await r.json();
    sysStatus.sources.c.ok  = true;
    sysStatus.sources.c.err = null;
    return (d?.pairs||[]).filter(p=>p.chainId==="solana"&&parseFloat(p.priceUsd||0)>0);
  } catch(e) {
    if (!sysStatus.sources.c.err) {
      sysStatus.sources.c.ok  = false;
      sysStatus.sources.c.err = e.message;
      sysErr("dexscreener", e.message);
    }
    throw e;
  }
}

async function dexPairs(addresses) {
  if (!addresses.length) return [];
  const results = [];
  for (let i=0; i<addresses.length; i+=10) {
    const chunk = addresses.slice(i,i+10);
    try {
      const r = await fetch(
        `https://api.dexscreener.com/latest/dex/pairs/solana/${chunk.join(",")}`,
        { timeout:10000 }
      );
      if (!r.ok) continue;
      const d = await r.json();
      results.push(...(d?.pairs||[]).filter(p=>parseFloat(p.priceUsd||0)>0));
    } catch(e) { continue; }
  }
  return results;
}

async function dexPair(address) {
  const ps = await dexPairs([address]);
  return ps[0]||null;
}

// ── JUPITER PRICE API ─────────────────────────────────────
async function jupiterGetPrice(mintAddress) {
  try {
    const t0 = Date.now();
    const r = await fetch(
      `https://price.jup.ag/v6/price?ids=${mintAddress}`,
      { timeout:8000 }
    );
    sysStatus.sources.d.lastMs = Date.now()-t0;
    sysStatus.sources.d.lastAt = new Date().toISOString();
    if (!r.ok) {
      sysStatus.sources.d.ok  = false;
      sysStatus.sources.d.err = `HTTP ${r.status}`;
      return null;
    }
    const d = await r.json();
    const price = d?.data?.[mintAddress]?.price;
    sysStatus.sources.d.ok  = true;
    sysStatus.sources.d.err = null;
    return price ? parseFloat(price) : null;
  } catch(e) {
    sysStatus.sources.d.ok  = false;
    sysStatus.sources.d.err = e.message;
    return null;
  }
}

// ── HELIUS TOKEN DATA ─────────────────────────────────────
async function heliusGetTokenInfo(mintAddress) {
  if (!HELIUS_KEY) return null;
  try {
    const r = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`,
      {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          jsonrpc:"2.0", id:1,
          method:"getAsset",
          params:{ id:mintAddress }
        }),
        timeout:8000
      }
    );
    if (!r.ok) return null;
    const d = await r.json();
    return d?.result || null;
  } catch(e) { return null; }
}

// ── RUGCHECK ──────────────────────────────────────────────
async function checkRugcheck(tokenAddress) {
  if (!tokenAddress) return { score:0, flags:[], pass:true, apiStatus:"no_address" };
  if (rugCache.has(tokenAddress)) return rugCache.get(tokenAddress);

  const t0 = Date.now();
  try {
    const r = await fetch(
      `https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report/summary`,
      { timeout:6000 }
    );
    sysStatus.rugcheck.lastMs = Date.now()-t0;
    sysStatus.rugcheck.lastAt = new Date().toISOString();

    if (!r.ok) {
      sysStatus.rugcheck.ok  = false;
      sysStatus.rugcheck.err = `HTTP ${r.status}`;
      sysErr("rugcheck", `HTTP ${r.status}`);
      return { score:0, flags:[], pass:true, apiStatus:`http_${r.status}` };
    }

    const d     = await r.json();
    const score = d?.score||0;

    if (score===0 && !d?.topHolders?.length && !d?.markets?.length) {
      sysStatus.rugcheck.ok  = false;
      sysStatus.rugcheck.err = "empty_response";
      return { score:0, flags:[], pass:true, apiStatus:"empty" };
    }

    sysStatus.rugcheck.ok  = true;
    sysStatus.rugcheck.err = null;

    const flags = [];
    if (d?.mintAuthority)   flags.push("mint_authority");
    if (d?.freezeAuthority) flags.push("freeze_authority");
    if (d?.mutable)         flags.push("mutable_metadata");

    const markets = d?.markets||[];
    let anyLocked=false, anyUnlocked=false;
    for (const m of markets) {
      const lp = m?.lp||{};
      if (lp.lpBurned||(lp.lpLockedPct||0)>=80) anyLocked=true;
      else anyUnlocked=true;
    }
    if (markets.length>0 && anyUnlocked && !anyLocked) flags.push("lp_unlocked");

    const top1  = d?.topHolders?.[0]?.pct||0;
    const top10 = (d?.topHolders||[]).slice(0,10).reduce((s,h)=>s+(h.pct||0),0);
    if (top1 >30) flags.push(`top1_${Math.round(top1)}pct`);
    if (top10>80) flags.push(`top10_${Math.round(top10)}pct`);

    const hardFlags = ["mint_authority","freeze_authority","lp_unlocked"];
    const pass      = !flags.some(f=>hardFlags.includes(f));

    const result = { score, flags, pass, top10:Math.round(top10), apiStatus:"ok" };
    rugCache.set(tokenAddress, result);

    sysStatus.rugLog.unshift({ addr:tokenAddress.slice(0,12), pass, flags, score, at:new Date().toISOString() });
    if (sysStatus.rugLog.length>20) sysStatus.rugLog.pop();

    return result;
  } catch(e) {
    sysStatus.rugcheck.ok  = false;
    sysStatus.rugcheck.err = e.message;
    sysStatus.rugcheck.lastMs = Date.now()-t0;
    sysErr("rugcheck", e.message);
    return { score:0, flags:[], pass:true, apiStatus:"timeout" };
  }
}

// ── SCORING ────────────────────────────────────────────────
function getZScore(addr, vol) {
  if (!volHistory.has(addr)) volHistory.set(addr, []);
  const h = volHistory.get(addr);
  h.push(vol);
  if (h.length>20) h.shift();
  if (h.length<3) return 0;
  const mean = h.reduce((a,b)=>a+b,0)/h.length;
  const std  = Math.sqrt(h.reduce((a,b)=>a+(b-mean)**2,0)/h.length);
  return std===0?0:(vol-mean)/std;
}

function calcFomoScore(p) {
  const liq = p.liquidity?.usd||0;
  const raw = calcRawFomo(p);
  return liq<500?Math.min(30,raw):raw;
}

function calcRawFomo(p) {
  const v5  = p.volume?.m5   ||0;
  const v1  = p.volume?.h1   ||0.001;
  const pc5 = parseFloat(p.priceChange?.m5||0);
  const pc1 = parseFloat(p.priceChange?.h1||0);
  const b   = p.txns?.m5?.buys  ||0;
  const s   = p.txns?.m5?.sells ||0;
  const liq = p.liquidity?.usd  ||0;
  const age = p.pairCreatedAt?(Date.now()-p.pairCreatedAt)/60000:999;
  const bst = (p.boosts?.active||0)>0;
  const addr = p.pairAddress;
  let fomo = 0;
  const expected = v1/12;
  fomo += Math.min(35, expected>0?(v5/expected)*10:0);
  if (pc5> 5&&pc5<=15) fomo+=20;
  if (pc5>15&&pc5<=30) fomo+=12;
  if (pc5>30&&pc5<=60) fomo+= 5;
  if (pc5>60)          fomo-=10;
  if (pc5< 0)          fomo-= 5;
  const total = b+s;
  if (total>10) {
    const br = b/total;
    if      (br>0.75) fomo+=18;
    else if (br>0.65) fomo+=12;
    else if (br>0.55) fomo+= 6;
  }
  if (age>= 3&&age< 10) fomo+=15;
  if (age>=10&&age< 30) fomo+=20;
  if (age>=30&&age< 60) fomo+=10;
  if (age>=60&&age<120) fomo+= 3;
  if (age>=120)         fomo-=10;
  if (pc1>  0&&pc1<100) fomo+= 8;
  if (pc1>=100)         fomo+= 3;
  if (pc1< -10)         fomo-= 8;
  if (liq>=500&&v5>0) {
    const vlr = v5/liq;
    if (vlr>0.5&&vlr<5) fomo+=8;
    if (vlr>=5)         fomo+=3;
  }
  const z = getZScore(addr,v5);
  if      (z>2) fomo+=15;
  else if (z>1) fomo+= 8;
  else if (z>0) fomo+= 3;
  if (bst) fomo+=10;
  if (fomoHistory.has(addr)) {
    const prev  = fomoHistory.get(addr);
    const delta = fomo-prev;
    if (delta> 10) fomo+=8;
    if (delta<-15) fomo-=5;
  }
  const result = Math.round(Math.max(0,Math.min(99,fomo)));
  fomoHistory.set(addr,result);
  return result;
}

function calcQualityScore(p) {
  const v5  = p.volume?.m5 ||0;
  const v1  = p.volume?.h1 ||1;
  const pc5 = parseFloat(p.priceChange?.m5||0);
  const pc1 = parseFloat(p.priceChange?.h1||0);
  const liq = p.liquidity?.usd||0;
  const b   = p.txns?.m5?.buys  ||0;
  const s   = p.txns?.m5?.sells ||1;
  const bst = (p.boosts?.active||0)>0;
  const age = p.pairCreatedAt?(Date.now()-p.pairCreatedAt)/60000:999;
  const z   = getZScore(p.pairAddress,v5);
  let sc = 0;
  sc += Math.min(100,(v5/Math.max(v1/12,1))*100)*0.28;
  sc += Math.min(100,Math.max(0,(pc5+30)/1.3))*0.18;
  sc += (liq>100000?100:liq>50000?85:liq>20000?65:liq>5000?45:liq>1000?25:5)*0.14;
  sc += Math.min(100,(b/(b+s))*100)*0.15;
  sc += Math.min(15,Math.max(0,z*5));
  sc += age< 10? 18:age< 20? 14:age< 40? 10:age< 60?  5:age>=120? -8:0;
  sc += pc1>30?10:pc1>10?6:pc1<-20?-10:0;
  if (bst)       sc+=5;
  if (liq<1500)  sc-=20;
  if (v5<100)    sc-= 8;
  return Math.round(Math.max(0,Math.min(99,sc)));
}

// ── INTERNAL RUG FILTER ───────────────────────────────────
function rugCheck(p) {
  const liq = p.liquidity?.usd||0;
  const v5  = p.volume?.m5   ||0;
  const b   = p.txns?.m5?.buys  ||0;
  const s   = p.txns?.m5?.sells ||0;
  const pc5 = parseFloat(p.priceChange?.m5||0);
  const pc1 = parseFloat(p.priceChange?.h1||0);
  const age = (Date.now()-(p.pairCreatedAt||Date.now()))/60000;
  const w   = [];
  if (age<3)                         w.push(`too_new_${age.toFixed(1)}min`);
  if (v5>80000&&liq<4000)            w.push("vol_liq_mismatch");
  if (s>b*3)                         w.push("heavy_sell_wall");
  if (liq<500)                       w.push("thin_liq");
  if (liq<25000&&pc5>30)             w.push("low_liq_high_velocity");
  if (pc5>100&&liq<50000)            w.push("100pct_spike_thin_liq");
  if (pc1>300&&liq<30000)            w.push("already_pumped_300pct");
  if (b>0&&s>b*2&&v5>1000)          w.push("sells_doubling_buys");
  return { pass:w.length===0, warnings:w };
}

// ── ALGO GATE ─────────────────────────────────────────────
function algoGate(p, sc, fomo, z, variantKey) {
  const cfg = VARIANTS[variantKey];
  const liq = p.liquidity?.usd||0;
  const v5  = p.volume?.m5   ||0;
  const b   = p.txns?.m5?.buys  ||0;
  const s   = p.txns?.m5?.sells ||0;
  const bp  = (b+s)>0?(b/(b+s))*100:0;
  const pc5 = parseFloat(p.priceChange?.m5||0);
  const age = p.pairCreatedAt?(Date.now()-p.pairCreatedAt)/60000:-1;
  const ageUnknown = age<0;
  const checks = {
    score:  { pass:sc>=cfg.minScore&&sc<=cfg.maxScore,    why:`score_${sc}_not_in_[${cfg.minScore}-${cfg.maxScore}]` },
    fomo:   { pass:fomo>=cfg.minFomo&&fomo<=cfg.maxFomo,  why:`fomo_${fomo}_not_in_[${cfg.minFomo}-${cfg.maxFomo}]` },
    liq:    { pass:liq>=cfg.minLiq,                       why:`liq_$${Math.round(liq)}_<_$${cfg.minLiq}` },
    vol:    { pass:v5>=cfg.minVol5m,                      why:`vol5m_$${Math.round(v5)}_<_$${cfg.minVol5m}` },
    buys:   { pass:bp>=cfg.minBuyPct,                     why:`buys_${Math.round(bp)}pct_<_${cfg.minBuyPct}pct` },
    pc5min: { pass:pc5>=cfg.minPc5m,                      why:`pc5_${pc5.toFixed(0)}pct_<_${cfg.minPc5m}pct` },
    pc5max: { pass:pc5<=cfg.maxPc5m,                      why:`pc5_${pc5.toFixed(0)}pct_>_${cfg.maxPc5m}pct` },
    ageMin: { pass:ageUnknown||age>=cfg.minAge,           why:`age_${age.toFixed(1)}m_<_${cfg.minAge}m` },
    ageMax: { pass:ageUnknown||age<=cfg.maxAge,           why:`age_${Math.round(age)}m_>_${cfg.maxAge}m` },
    price:  { pass:parseFloat(p.priceUsd||0)>0,           why:"no_price" },
  };
  const failed = Object.values(checks).filter(c=>!c.pass).map(c=>c.why);
  return { pass:failed.length===0, failed };
}

// ── BET SIZING ────────────────────────────────────────────
function betSize(sc, variantKey, liq) {
  const cfg   = VARIANTS[variantKey];
  const base  = cfg.baseBet;
  const range = cfg.maxScore-cfg.minScore;
  const pct   = range>0?(sc-cfg.minScore)/range:0.5;
  const mult  = 0.8+pct*0.4;
  const liqCap = liq>0?Math.max(5,liq*0.001):100;
  return Math.min(liqCap,Math.min(100,Math.max(5,Math.round((base*mult)/5)*5)));
}

// ── P&L CALCULATION ───────────────────────────────────────
function calcPnL(trade, curPrice) {
  const variantKey = trade.algo.slice(1); // e.g. "a2" -> "2"
  const cfg    = VARIANTS[variantKey];
  if (!cfg) return { status:"OPEN", exit:null, mult:1, pnl:null, highMult:1 };
  const mult   = curPrice/parseFloat(trade.entry_price);
  const bet    = parseFloat(trade.bet_size);
  const ageMin = (Date.now()-new Date(trade.opened_at).getTime())/60000;
  const hi     = Math.max(parseFloat(trade.highest_mult||1),mult);

  if (mult<=cfg.earlyStop&&ageMin<cfg.earlyStopMinutes) {
    return { status:"CLOSED", exit:"EARLY_STOP", mult, pnl:+(bet*(mult-1)).toFixed(2), highMult:hi };
  }
  if (mult<=cfg.stopLoss) {
    return { status:"CLOSED", exit:"STOP_LOSS", mult, pnl:+(bet*(mult-1)).toFixed(2), highMult:hi };
  }
  if (ageMin>=cfg.trailingActivateMin&&hi>1.2&&mult<=hi*cfg.trailingPct) {
    return { status:"CLOSED", exit:"TRAILING_STOP", mult, pnl:+(bet*(mult-1)).toFixed(2), highMult:hi };
  }
  if (mult>=cfg.tier3) {
    const sold1=cfg.tier1Sell; const sold2=cfg.tier2Sell; const sold3=1-sold1-sold2;
    const pnl=(bet*sold1*(cfg.tier1-1))+(bet*sold2*(cfg.tier2-1))+(bet*sold3*(mult-1));
    return { status:"CLOSED", exit:"TIER3", mult, pnl:+pnl.toFixed(2), highMult:hi };
  }
  if (mult>=cfg.tier2) {
    const sold1=cfg.tier1Sell; const sold2=cfg.tier2Sell; const remaining=1-sold1-sold2;
    const pnl=(bet*sold1*(cfg.tier1-1))+(bet*sold2*(mult-1))+(bet*remaining*(mult-1));
    return { status:"CLOSED", exit:"TIER2", mult, pnl:+pnl.toFixed(2), highMult:hi };
  }
  if (mult>=cfg.tier1&&ageMin>=5) {
    return { status:"OPEN", exit:null, mult, pnl:null, highMult:hi };
  }
  if (ageMin>=cfg.maxHold) {
    const reason = mult>=1?"TIME_UP":"TIME_DOWN";
    return { status:"CLOSED", exit:reason, mult, pnl:+(bet*(mult-1)).toFixed(2), highMult:hi };
  }
  return { status:"OPEN", exit:null, mult, pnl:null, highMult:hi };
}

// ── CIRCUIT BREAKER ───────────────────────────────────────
function checkCircuit(slot) {
  const st = slotState[slot];
  if (st.circuitAt) {
    const then = new Date(st.circuitAt);
    if (then.toDateString()!==new Date().toDateString()) {
      st.circuitBroken=false; st.circuitAt=null; st.dailyPnl=0;
    }
  }
  if (st.dailyPnl<=-DAILY_LIMIT&&!st.circuitBroken) {
    st.circuitBroken=true; st.circuitAt=new Date().toISOString();
    console.log(`[CIRCUIT] ${slot} down $${Math.abs(st.dailyPnl).toFixed(2)} — pausing`);
  }
}

// ── DB HELPERS ────────────────────────────────────────────
async function getOpen(slot) {
  const r = await db(`SELECT * FROM trades_${slot} WHERE status='OPEN' ORDER BY opened_at DESC`);
  return r.rows;
}

async function hadTrade(slot, pairAddr, ticker, name) {
  const byAddr = await db(
    `SELECT id FROM trades_${slot} WHERE pair_address=$1 AND status='OPEN' LIMIT 1`,
    [pairAddr]
  );
  if (byAddr.rows.length) return true;
  const byTicker = await db(
    `SELECT id FROM trades_${slot} WHERE LOWER(ticker)=LOWER($1) AND opened_at>NOW()-INTERVAL '90 minutes' LIMIT 1`,
    [ticker]
  );
  if (byTicker.rows.length) return true;
  if (name&&name.length>3) {
    const byName = await db(
      `SELECT id FROM trades_${slot} WHERE LOWER(name)=LOWER($1) AND opened_at>NOW()-INTERVAL '90 minutes' LIMIT 1`,
      [name]
    );
    if (byName.rows.length) return true;
  }
  return false;
}

async function insertTrade(slot, p, sc, fomo, rugScore, dataSource) {
  const variantKey = slot.slice(1);
  const liq        = p.liquidity?.usd||0;
  const bet        = betSize(sc, variantKey, liq);
  const age        = p.pairCreatedAt?(Date.now()-p.pairCreatedAt)/60000:0;
  const tokenAddr  = p.baseToken?.address||p.pairAddress;

  const r = await db(
    `INSERT INTO trades_${slot}
       (ticker,name,pair_address,dex_url,score,entry_price,bet_size,
        status,highest_mult,
        vol_5m,vol_1h,liq,pc_5m,buys_5m,sells_5m,
        boosted,market_mood,age_min,fomo_score,
        stealth_score,is_stealth,rug_score,algo,data_source,opened_at)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7,
        'OPEN',1.0,
        $8,$9,$10,$11,$12,$13,
        $14,$15,$16,$17,
        0,false,$18,$19,$20,NOW())
     RETURNING *`,
    [
      p.baseToken?.symbol||"???",       // $1
      p.baseToken?.name  ||"",          // $2
      p.pairAddress,                    // $3
      p.url||p.dexUrl||"",             // $4
      sc,                               // $5
      parseFloat(p.priceUsd),           // $6
      bet,                              // $7
      p.volume?.m5     ||0,             // $8
      p.volume?.h1     ||0,             // $9
      liq,                              // $10
      parseFloat(p.priceChange?.m5||0), // $11
      p.txns?.m5?.buys  ||0,           // $12
      p.txns?.m5?.sells ||0,           // $13
      (p.boosts?.active||0)>0,         // $14
      mood,                             // $15
      parseFloat(age.toFixed(1)),       // $16
      fomo,                             // $17
      rugScore||0,                      // $18
      slot,                             // $19
      dataSource||"unknown",            // $20
    ]
  );

  if (r.rows[0]) {
    if (!crossSlotExposure.has(tokenAddr)) crossSlotExposure.set(tokenAddr,new Set());
    crossSlotExposure.get(tokenAddr).add(slot);
  }
  return r.rows[0];
}

async function closeTrade(slot, id, res) {
  await db(
    `UPDATE trades_${slot} SET status='CLOSED',exit_mult=$1,highest_mult=$2,pnl=$3,exit_reason=$4,closed_at=NOW() WHERE id=$5`,
    [res.mult,res.highMult,res.pnl,res.exit,id]
  );
  try {
    const row = (await db(`SELECT pair_address FROM trades_${slot} WHERE id=$1`,[id])).rows[0];
    if (row) {
      const key = row.pair_address;
      if (crossSlotExposure.has(key)) {
        crossSlotExposure.get(key).delete(slot);
        if (crossSlotExposure.get(key).size===0) crossSlotExposure.delete(key);
      }
    }
  } catch(e) {}
}

async function logSig(slot, p, sc, fomo, entered, skipReason, dataSource) {
  const age = p.pairCreatedAt?(Date.now()-p.pairCreatedAt)/60000:0;
  await db(
    `INSERT INTO signals_${slot}
       (ticker,pair_address,dex_url,score,price,vol_5m,liq,pc_5m,boosted,
        entered,skip_reason,market_mood,age_min,fomo_score,algo,data_source,seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())`,
    [
      p.baseToken?.symbol||"???",
      p.pairAddress, p.url||"", sc,
      parseFloat(p.priceUsd||0),
      p.volume?.m5||0, p.liquidity?.usd||0,
      parseFloat(p.priceChange?.m5||0),
      (p.boosts?.active||0)>0,
      entered, skipReason||null, mood,
      parseFloat(age.toFixed(1)), fomo,
      slot, dataSource||"unknown",
    ]
  ).catch(()=>{});
}

// ── PROCESS TOKEN (shared by all sources) ─────────────────
// Takes a normalized token object and runs it through all 10 variants
// for a given source letter
async function processToken(p, sourceKey) {
  if (!p?.pairAddress||!p?.priceUsd) return;
  const sc   = calcQualityScore(p);
  const fomo = calcFomoScore(p);
  const z    = getZScore(p.pairAddress, p.volume?.m5||0);
  const rug  = rugCheck(p);

  if (sc<35||(p.liquidity?.usd||0)<500) return; // Skip obvious junk

  sysStatus.sources[sourceKey].tokensReceived++;

  for (const variantKey of VARIANT_KEYS) {
    const slot = sourceKey+variantKey;
    checkCircuit(slot);
    if (slotState[slot].circuitBroken) continue;

    sysStatus.funnel[slot].seen++;

    const gate = algoGate(p, sc, fomo, z, variantKey);

    if (!gate.pass||!rug.pass) {
      const skipReason = !gate.pass?gate.failed.join("; "):rug.warnings.join("; ");
      logSig(slot, p, sc, fomo, false, skipReason, SOURCE_NAMES[sourceKey]);
      continue;
    }

    sysStatus.funnel[slot].gate++;

    const already = await hadTrade(slot, p.pairAddress, p.baseToken?.symbol||"???", p.baseToken?.name||"");
    if (already) { logSig(slot, p, sc, fomo, false, "already_traded", SOURCE_NAMES[sourceKey]); continue; }

    // Max 3 slots per token (across all sources and variants)
    const tokenKey  = p.baseToken?.address||p.pairAddress;
    const existing  = crossSlotExposure.get(tokenKey);
    if (existing&&existing.size>=3&&!existing.has(slot)) {
      logSig(slot, p, sc, fomo, false, "cross_slot_limit", SOURCE_NAMES[sourceKey]);
      continue;
    }

    const tokenMint = p.baseToken?.address;
    const rugResult = tokenMint
      ? await checkRugcheck(tokenMint)
      : { score:0, flags:[], pass:true, apiStatus:"no_mint" };

    if (!rugResult.pass) {
      logSig(slot, p, sc, fomo, false, `rug:[${rugResult.flags.join(",")}]`, SOURCE_NAMES[sourceKey]);
      continue;
    }

    sysStatus.funnel[slot].rugPass++;

    const trade = await insertTrade(slot, p, sc, fomo, rugResult.score, SOURCE_NAMES[sourceKey])
      .catch(e=>{
        const msg = e.message.toLowerCase();
        if (!msg.includes("unique")&&!msg.includes("duplicate")) {
          console.error(`insertTrade-${slot}:`, e.message);
        }
        return null;
      });

    if (trade) {
      logSig(slot, p, sc, fomo, true, null, SOURCE_NAMES[sourceKey]);
      sysStatus.funnel[slot].entered++;
      console.log(`  [${slot.toUpperCase()}] ENTERED ${p.baseToken?.symbol} sc:${sc} fomo:${fomo} bet:$${trade.bet_size} src:${SOURCE_NAMES[sourceKey]}`);
    }
  }
}

// ── SOURCE A: PUMPPORTAL WEBSOCKET ────────────────────────
let ppWs = null;
let ppReconnectTimer = null;

function connectPumpPortal() {
  if (ppWs) { try { ppWs.terminate(); } catch(e){} }

  console.log("[SRC-A] Connecting to PumpPortal WebSocket...");
  ppWs = new WebSocket("wss://pumpportal.fun/api/data");

  ppWs.on("open", () => {
    console.log("[SRC-A] PumpPortal connected");
    sysStatus.sources.a.connected = true;
    sysStatus.sources.a.ok        = true;
    sysStatus.sources.a.err       = null;

    // Subscribe to new token launches
    ppWs.send(JSON.stringify({ method:"subscribeNewToken" }));
    // Subscribe to migrations (tokens graduating to Raydium — more liquid)
    ppWs.send(JSON.stringify({ method:"subscribeMigration" }));

    // Ping every 30s to keep alive
    ppWs._pingInterval = setInterval(()=>{
      if (ppWs.readyState===WebSocket.OPEN) ppWs.ping();
    }, 30000);
  });

  ppWs.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      sysStatus.sources.a.lastMsg = new Date().toISOString();

      if (!msg.mint) return; // Not a token event

      // Build a normalized token object from PumpPortal data
      const ageMin = msg.timestamp
        ? (Date.now()-msg.timestamp*1000)/60000
        : 0;

      // Fetch full pair data from DexScreener for scoring
      // Only one call per new token — not polling
      const pairs = await dexPairs([msg.mint]).catch(()=>[]);
      if (pairs.length>0) {
        await processToken(pairs[0], "a");
      } else {
        // Build minimal token object from PumpPortal data alone
        const minimal = {
          pairAddress: msg.mint,
          priceUsd:    msg.marketCapSol?(msg.marketCapSol*10).toString():"0",
          baseToken:   { symbol:msg.symbol||"???", name:msg.name||"", address:msg.mint },
          liquidity:   { usd:(msg.vSolInBondingCurve||0)*150 },
          volume:      { m5:msg.initialBuy||0, h1:msg.initialBuy||0 },
          priceChange: { m5:"0", h1:"0" },
          txns:        { m5:{ buys:1, sells:0 } },
          pairCreatedAt: Date.now()-(ageMin*60000),
          url:         `https://dexscreener.com/solana/${msg.mint}`,
          boosts:      { active:0 },
        };
        await processToken(minimal, "a");
      }
    } catch(e) {
      sysErr("pumpportal", e.message);
    }
  });

  ppWs.on("close", (code) => {
    console.log(`[SRC-A] PumpPortal disconnected (${code}) — reconnecting in 5s`);
    sysStatus.sources.a.connected = false;
    sysStatus.sources.a.ok        = false;
    sysStatus.sources.a.err       = `Disconnected: ${code}`;
    if (ppWs._pingInterval) clearInterval(ppWs._pingInterval);
    ppReconnectTimer = setTimeout(connectPumpPortal, 5000);
  });

  ppWs.on("error", (err) => {
    console.error("[SRC-A] PumpPortal error:", err.message);
    sysStatus.sources.a.ok  = false;
    sysStatus.sources.a.err = err.message;
    sysErr("pumpportal", err.message);
  });
}

// ── SOURCE B: HELIUS STANDARD WEBSOCKET ───────────────────
let heliusWs = null;
let heliusReconnectTimer = null;

// Pump.fun program address on Solana
const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

function connectHelIUS() {
  if (!HELIUS_KEY) {
    console.log("[SRC-B] No HELIUS_API_KEY — skipping Helius WebSocket");
    sysStatus.sources.b.err = "No API key";
    return;
  }
  if (heliusWs) { try { heliusWs.terminate(); } catch(e){} }

  console.log("[SRC-B] Connecting to Helius WebSocket...");
  heliusWs = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`);

  heliusWs.on("open", () => {
    console.log("[SRC-B] Helius WebSocket connected");
    sysStatus.sources.b.connected = true;
    sysStatus.sources.b.ok        = true;
    sysStatus.sources.b.err       = null;

    // Subscribe to Pump.fun program transactions
    heliusWs.send(JSON.stringify({
      jsonrpc:"2.0", id:1,
      method:"logsSubscribe",
      params:[
        { mentions:[PUMPFUN_PROGRAM] },
        { commitment:"processed" }
      ]
    }));

    // Ping every 30s
    heliusWs._pingInterval = setInterval(()=>{
      if (heliusWs.readyState===WebSocket.OPEN) heliusWs.ping();
    }, 30000);
  });

  heliusWs.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      sysStatus.sources.b.lastMsg = new Date().toISOString();

      // Extract token mint from log messages
      const logs = msg?.params?.result?.value?.logs||[];
      const sig  = msg?.params?.result?.value?.signature;

      // Look for "create" instructions (new token launches)
      const isCreate = logs.some(l=>l.includes("Program log: Instruction: Create")||l.includes("initialize_account"));
      if (!isCreate) return;

      // Extract token address from logs
      const mintLog = logs.find(l=>l.includes("mint:"));
      if (!mintLog) return;

      const mintMatch = mintLog.match(/mint:\s*([A-Za-z0-9]{32,50})/);
      if (!mintMatch) return;
      const mint = mintMatch[1];

      // Fetch pair data from DexScreener
      await delay(2000); // Wait 2s for DexScreener to index it
      const pairs = await dexPairs([mint]).catch(()=>[]);
      if (pairs.length>0) {
        await processToken(pairs[0], "b");
      }
    } catch(e) {
      sysErr("helius", e.message);
    }
  });

  heliusWs.on("close", (code) => {
    console.log(`[SRC-B] Helius disconnected (${code}) — reconnecting in 10s`);
    sysStatus.sources.b.connected = false;
    sysStatus.sources.b.ok        = false;
    sysStatus.sources.b.err       = `Disconnected: ${code}`;
    if (heliusWs._pingInterval) clearInterval(heliusWs._pingInterval);
    heliusReconnectTimer = setTimeout(connectHelIUS, 10000);
  });

  heliusWs.on("error", (err) => {
    console.error("[SRC-B] Helius error:", err.message);
    sysStatus.sources.b.ok  = false;
    sysStatus.sources.b.err = err.message;
    sysErr("helius", err.message);
  });
}

// ── SOURCE C: DEXSCREENER POLLING ─────────────────────────
async function pollDexScreener() {
  pollCount++;
  try {
    const q0 = QUERIES[qi%QUERIES.length];
    const q1 = QUERIES[(qi+1)%QUERIES.length];
    qi+=2;

    const r1 = await dexSearch(q0).catch(()=>[]);
    await delay(800);
    const r2 = await dexSearch(q1).catch(()=>[]);

    const seenAddrs = new Set();
    const all = [];
    for (const p of [...r1,...r2]) {
      if (!p.pairAddress||seenAddrs.has(p.pairAddress)) continue;
      seenAddrs.add(p.pairAddress);
      all.push(p);
    }

    console.log(`[SRC-C] Poll #${pollCount}: ${all.length} tokens`);
    for (const p of all) {
      await processToken(p, "c");
    }
  } catch(e) { console.error("[SRC-C] pollDexScreener:", e.message); }
}

// ── SOURCE D: JUPITER API ─────────────────────────────────
// Jupiter doesn't have a "new tokens" feed — it's used for price checks on open positions
// For discovery we use DexScreener new-tokens endpoint (less rate limited)
async function pollJupiter() {
  try {
    const t0 = Date.now();
    // Fetch new Solana tokens from DexScreener new endpoint (different from search)
    const r = await fetch(
      "https://api.dexscreener.com/latest/dex/search?q=solana+new",
      { timeout:10000 }
    );
    sysStatus.sources.d.lastMs = Date.now()-t0;
    sysStatus.sources.d.lastAt = new Date().toISOString();

    if (!r.ok) {
      sysStatus.sources.d.ok  = false;
      sysStatus.sources.d.err = `HTTP ${r.status}`;
      return;
    }
    const d = await r.json();
    sysStatus.sources.d.ok  = true;
    sysStatus.sources.d.err = null;

    const pairs = (d?.pairs||[])
      .filter(p=>p.chainId==="solana"&&parseFloat(p.priceUsd||0)>0)
      .filter(p=>p.pairCreatedAt&&(Date.now()-p.pairCreatedAt)<60*60000); // Last hour only

    console.log(`[SRC-D] Jupiter poll: ${pairs.length} recent tokens`);
    for (const p of pairs) {
      await processToken(p, "d");
    }
  } catch(e) {
    sysStatus.sources.d.ok  = false;
    sysStatus.sources.d.err = e.message;
  }
}

// ── SOURCE E: HYBRID (DexScreener + Helius verification) ──
async function pollHybrid() {
  try {
    // Use DexScreener boosted endpoint — higher quality tokens
    const r = await fetch(
      "https://api.dexscreener.com/token-boosts/latest/v1",
      { timeout:10000 }
    );
    if (!r.ok) return;
    const d = await r.json();
    const boosted = (d||[]).filter(t=>t.chainId==="solana").slice(0,20);
    if (!boosted.length) return;

    await delay(500);
    const addrs = boosted.map(t=>t.tokenAddress).filter(Boolean);
    const pairs = await dexPairs(addrs).catch(()=>[]);

    sysStatus.sources.e.ok    = true;
    sysStatus.sources.e.lastAt = new Date().toISOString();

    console.log(`[SRC-E] Hybrid: ${pairs.length} boosted tokens`);
    for (const p of pairs) {
      await processToken(p, "e");
    }
  } catch(e) {
    sysStatus.sources.e.ok  = false;
    sysStatus.sources.e.err = e.message;
  }
}

// ── CHECK POSITIONS (all 50 slots) ────────────────────────
async function checkPositions() {
  for (const slot of ALL_SLOTS) {
    try {
      const open = await getOpen(slot);
      if (!open.length) continue;

      const addrs   = open.map(t=>t.pair_address);
      const pairs   = await dexPairs(addrs).catch(()=>[]);
      const pairMap = new Map(pairs.map(p=>[p.pairAddress,p]));

      for (const trade of open) {
        try {
          const st   = slotState[slot];
          const pair = pairMap.get(trade.pair_address)||await dexPair(trade.pair_address).catch(()=>null);

          if (!pair) {
            const ageMin = (Date.now()-new Date(trade.opened_at).getTime())/60000;
            if (ageMin>3) {
              const missKey = `${slot}_${trade.id}`;
              const misses  = (delistMissCounter.get(missKey)||0)+1;
              delistMissCounter.set(missKey,misses);
              if (misses>=3) {
                delistMissCounter.delete(missKey);
                const pnl = +(parseFloat(trade.bet_size)*-1.0).toFixed(2);
                await closeTrade(slot, trade.id, { mult:0, pnl, exit:"DELISTED", highMult:parseFloat(trade.highest_mult||1) });
                st.dailyPnl += pnl;
                console.log(`  [${slot}] DELISTED ${trade.ticker} pnl:$${pnl} entryLiq:$${Math.round(parseFloat(trade.liq||0))}`);
              }
            }
            continue;
          }

          delistMissCounter.delete(`${slot}_${trade.id}`);
          const curPrice  = parseFloat(pair.priceUsd);
          if (!curPrice||curPrice<=0) continue;

          const res      = calcPnL(trade, curPrice);
          const pct      = ((curPrice/parseFloat(trade.entry_price))-1)*100;
          const curLiq   = pair.liquidity?.usd||0;
          const entryLiq = parseFloat(trade.liq||0);
          const curFomo  = calcFomoScore(pair);

          const liqCollapse = entryLiq>5000&&curLiq<entryLiq*0.35;
          const hardDump    = pct<-25;

          if ((liqCollapse||hardDump)&&res.status==="OPEN") {
            const mult   = curPrice/parseFloat(trade.entry_price);
            const rugPnl = +(parseFloat(trade.bet_size)*(mult-1)).toFixed(2);
            const reason = liqCollapse?"LIQ_PULLED":"HARD_DUMP";
            await closeTrade(slot, trade.id, { mult, pnl:rugPnl, exit:reason, highMult:Math.max(parseFloat(trade.highest_mult||1),mult) });
            st.dailyPnl += rugPnl;
            continue;
          }

          if (res.highMult>parseFloat(trade.highest_mult||1)) {
            await db(`UPDATE trades_${slot} SET highest_mult=$1 WHERE id=$2`,[res.highMult,trade.id]);
          }

          if (curFomo<12&&pct>5&&res.status==="OPEN") {
            const fadeKey   = `${slot}_${trade.id}`;
            const fadeCount = (fomoFadeCounter.get(fadeKey)||0)+1;
            fomoFadeCounter.set(fadeKey, fadeCount);
            if (fadeCount>=2) {
              fomoFadeCounter.delete(fadeKey);
              const mult    = curPrice/parseFloat(trade.entry_price);
              const fadePnl = +(parseFloat(trade.bet_size)*(mult-1)).toFixed(2);
              await closeTrade(slot, trade.id, { mult, pnl:fadePnl, exit:"FOMO_FADE", highMult:res.highMult });
              st.dailyPnl += fadePnl;
            }
            continue;
          } else {
            fomoFadeCounter.delete(`${slot}_${trade.id}`);
          }

          if (res.status==="CLOSED") {
            await closeTrade(slot, trade.id, res);
            st.dailyPnl += res.pnl;
            checkCircuit(slot);
            console.log(`  [${slot}] CLOSED ${trade.ticker} ${res.exit} $${res.pnl?.toFixed(2)}`);
          }
        } catch(e) { console.error(`  checkPos [${slot}] ${trade.ticker}:`, e.message); }
        await delay(100);
      }
    } catch(e) { console.error(`checkPositions-${slot}:`, e.message); }
  }
}

// ── MARKET MOOD ───────────────────────────────────────────
async function updateMood() {
  try {
    // Use already-fetched data from source C instead of new API calls
    // Just check the last known DexScreener state
    const pairs = await dexSearch("solana meme").catch(()=>[]);
    if (!pairs.length) return;
    const avg = pairs.reduce((a,p)=>a+parseFloat(p.priceChange?.m5||0),0)/pairs.length;
    const hot = pairs.filter(p=>parseFloat(p.priceChange?.m5||0)>8).length;
    const pct = (hot/pairs.length)*100;
    if      (avg> 8&&pct>=60) mood="frenzy";
    else if (avg> 4&&pct>=40) mood="hot";
    else if (avg> 1&&pct>=25) mood="warm";
    else if (avg<-8&&pct< 10) mood="dead";
    else if (avg<-5&&pct< 15) mood="cold";
    else                       mood="normal";
    console.log(`[MOOD] ${mood} avg:${avg.toFixed(1)}%`);
  } catch(e) {}
}

// ── DAILY PNL REFRESH ─────────────────────────────────────
async function refreshDaily() {
  try {
    const now    = new Date();
    const nyDate = new Date(now.toLocaleString("en-US",{timeZone:"America/New_York"}));
    nyDate.setHours(0,0,0,0);
    const startOfDay = new Date(now.getTime()-(now-nyDate));
    for (const slot of ALL_SLOTS) {
      const r = await db(
        `SELECT COALESCE(SUM(pnl),0) AS t FROM trades_${slot} WHERE status='CLOSED' AND closed_at>=$1`,
        [startOfDay.toISOString()]
      );
      slotState[slot].dailyPnl = parseFloat(r.rows[0].t);
    }
  } catch(e) { console.error("refreshDaily:", e.message); }
}

// ── CLEANUP ───────────────────────────────────────────────
async function cleanupSignals() {
  try {
    for (const slot of ALL_SLOTS) {
      const r = await db(`DELETE FROM signals_${slot} WHERE seen_at<NOW()-INTERVAL '24 hours'`);
      if (r.rowCount>0) console.log(`[CLEANUP] signals_${slot}: removed ${r.rowCount}`);
    }
  } catch(e) {}
}

// ── STATS HELPER ──────────────────────────────────────────
async function getSlotStats(slot) {
  const sourceKey  = slot[0];
  const variantKey = slot.slice(1);
  const [closedRes,openRes] = await Promise.all([
    db(`SELECT pnl,exit_reason,closed_at,ticker FROM trades_${slot} WHERE status='CLOSED' ORDER BY closed_at ASC`),
    db(`SELECT id FROM trades_${slot} WHERE status='OPEN'`),
  ]);
  const closed = closedRes.rows;
  const open   = openRes.rows;
  const wins   = closed.filter(t=>parseFloat(t.pnl||0)>0);
  const losses = closed.filter(t=>parseFloat(t.pnl||0)<=0);
  const tp     = closed.reduce((a,t)=>a+parseFloat(t.pnl||0),0);
  const wr     = closed.length?(wins.length/closed.length)*100:0;
  const aw     = wins.length?wins.reduce((a,t)=>a+parseFloat(t.pnl||0),0)/wins.length:0;
  const al     = losses.length?losses.reduce((a,t)=>a+parseFloat(t.pnl||0),0)/losses.length:0;
  const pf     = losses.length&&Math.abs(al)>0?Math.abs(aw*wins.length)/Math.abs(al*losses.length):null;
  let run=1000;
  const equity=[1000,...closed.map(t=>{run+=parseFloat(t.pnl||0);return +run.toFixed(2);})];
  const exits={};
  closed.forEach(t=>{const k=t.exit_reason||"unknown";exits[k]=(exits[k]||0)+1;});
  const cfg = VARIANTS[variantKey];
  return {
    slot, sourceKey, variantKey,
    sourceName:  SOURCE_NAMES[sourceKey],
    variantName: cfg?.name||variantKey,
    bankroll:    +(1000+tp).toFixed(2),
    totalPnl:    +tp.toFixed(2),
    winRate:     +wr.toFixed(1),
    avgWin:      +aw.toFixed(2),
    avgLoss:     +al.toFixed(2),
    profitFactor:pf?+pf.toFixed(2):null,
    totalTrades: closed.length,
    openTrades:  open.length,
    dailyPnl:    +slotState[slot].dailyPnl.toFixed(2),
    circuitBroken:slotState[slot].circuitBroken,
    exits, equity,
    config: cfg,
  };
}

// ── API ROUTES ────────────────────────────────────────────
app.get("/health", (req,res)=>res.json({
  status:"ok", ts:new Date().toISOString(), version:"10.0",
  marketMood:mood, pollCount,
  sources: Object.fromEntries(
    SOURCE_KEYS.map(k=>[k,{
      name:    SOURCE_NAMES[k],
      ok:      sysStatus.sources[k].ok,
      connected:sysStatus.sources[k].connected||null,
      tokens:  sysStatus.sources[k].tokensReceived,
    }])
  ),
}));

app.get("/api/stats", async(req,res)=>{
  try {
    const stats = await Promise.all(ALL_SLOTS.map(s=>getSlotStats(s)));
    res.json(stats);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get("/api/trades/:slot", async(req,res)=>{
  const slot = req.params.slot.toLowerCase();
  if (!ALL_SLOTS.includes(slot)) return res.status(400).json({error:"Invalid slot"});
  try {
    const limit = Math.min(parseInt(req.query.limit)||100,500);
    const r = await db(`SELECT * FROM trades_${slot} ORDER BY opened_at DESC LIMIT $1`,[limit]);
    res.json(r.rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get("/api/open-pnl", async(req,res)=>{
  try {
    const result={};
    for (const slot of ALL_SLOTS) {
      const open = await getOpen(slot);
      if (!open.length){result[slot]=[];continue;}
      const addrs = open.map(t=>t.pair_address);
      const pairs = await dexPairs(addrs).catch(()=>[]);
      const pm    = new Map(pairs.map(p=>[p.pairAddress,p]));
      result[slot] = open.map(t=>{
        const pair = pm.get(t.pair_address);
        const cur  = pair?parseFloat(pair.priceUsd):null;
        const entry= parseFloat(t.entry_price);
        const bet  = parseFloat(t.bet_size);
        if (!cur||!entry) return {id:t.id,ticker:t.ticker,upnl:null,pct:null};
        const mult = cur/entry;
        return {
          id:t.id, ticker:t.ticker, slot,
          pct:+((mult-1)*100).toFixed(2),
          upnl:+(bet*(mult-1)).toFixed(2),
          mult:+mult.toFixed(4),
          highest_mult:parseFloat(t.highest_mult||1),
          age_min:+((Date.now()-new Date(t.opened_at).getTime())/60000).toFixed(1),
        };
      });
    }
    res.json(result);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get("/api/debug/all", async(req,res)=>{
  try {
    const out={};
    for (const slot of ALL_SLOTS) {
      const rows = (await db(
        `SELECT entered,skip_reason FROM signals_${slot} WHERE seen_at>NOW()-INTERVAL '1 hour'`
      )).rows;
      const tally={};
      rows.filter(s=>s.skip_reason).forEach(s=>{
        s.skip_reason.split("; ").forEach(r=>{
          const key=r.split("_").slice(0,3).join("_");
          tally[key]=(tally[key]||0)+1;
        });
      });
      out[slot]={
        source:  SOURCE_NAMES[slot[0]],
        variant: VARIANTS[slot.slice(1)]?.name||slot.slice(1),
        total:   rows.length,
        entered: rows.filter(s=>s.entered).length,
        top3:    Object.entries(tally).sort((a,b)=>b[1]-a[1]).slice(0,3),
      };
    }
    res.json(out);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post("/api/wipe", async(req,res)=>{
  const { password }=req.body;
  if (password!==APP_PASS) return res.status(401).json({error:"Wrong password"});
  try {
    for (const slot of ALL_SLOTS) {
      await db(`TRUNCATE trades_${slot} RESTART IDENTITY`);
      await db(`TRUNCATE signals_${slot} RESTART IDENTITY`);
      slotState[slot].dailyPnl=0;
      slotState[slot].circuitBroken=false;
      slotState[slot].circuitAt=null;
    }
    // Clear old tables
    for (const ok of ["wave","surge","steady","rocket","a","b","c","d","e"]) {
      await pool.query(`TRUNCATE trades_${ok} RESTART IDENTITY`).catch(()=>{});
      await pool.query(`TRUNCATE signals_${ok} RESTART IDENTITY`).catch(()=>{});
    }
    res.json({ok:true,message:"All 50 slots wiped."});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get("/api/system", async(req,res)=>{
  try {
    await db("SELECT 1").then(()=>sysStatus.database.ok=true).catch(()=>sysStatus.database.ok=false);
    const openCounts={};
    for (const slot of ALL_SLOTS) {
      const r = await db(`SELECT COUNT(*) AS n FROM trades_${slot} WHERE status='OPEN'`).catch(()=>null);
      openCounts[slot] = r?parseInt(r.rows[0].n):"?";
    }
    res.json({
      ts:new Date().toISOString(), version:"10.0",
      uptime:Math.round(process.uptime()), pollCount, marketMood:mood,
      sources: sysStatus.sources,
      database:sysStatus.database,
      rugcheck:{ ...sysStatus.rugcheck, recentResults:sysStatus.rugLog.slice(0,10) },
      funnel:sysStatus.funnel,
      openTrades:openCounts,
      lastErrors:sysStatus.lastErrors.slice(0,10),
      slots:ALL_SLOTS.length,
    });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── MORNING REPORT (the one URL to paste) ─────────────────
app.get("/api/report", async(req,res)=>{
  try {
    const stats = await Promise.all(ALL_SLOTS.map(s=>getSlotStats(s)));

    // Best performers
    const byPnl    = [...stats].sort((a,b)=>b.totalPnl-a.totalPnl);
    const byWinRate= [...stats].filter(s=>s.totalTrades>=3).sort((a,b)=>b.winRate-a.winRate);

    // Source comparison
    const sourceStats={};
    for (const src of SOURCE_KEYS) {
      const srcSlots = stats.filter(s=>s.sourceKey===src);
      sourceStats[src]={
        name:       SOURCE_NAMES[src],
        totalPnl:   +srcSlots.reduce((a,s)=>a+s.totalPnl,0).toFixed(2),
        totalTrades:srcSlots.reduce((a,s)=>a+s.totalTrades,0),
        openTrades: srcSlots.reduce((a,s)=>a+s.openTrades,0),
        connected:  sysStatus.sources[src].connected||null,
        tokens:     sysStatus.sources[src].tokensReceived,
        ok:         sysStatus.sources[src].ok,
        err:        sysStatus.sources[src].err,
      };
    }

    // Variant comparison
    const variantStats={};
    for (const v of VARIANT_KEYS) {
      const vSlots = stats.filter(s=>s.variantKey===v);
      variantStats[v]={
        name:       VARIANTS[v]?.name||v,
        totalPnl:   +vSlots.reduce((a,s)=>a+s.totalPnl,0).toFixed(2),
        totalTrades:vSlots.reduce((a,s)=>a+s.totalTrades,0),
        avgWinRate: vSlots.filter(s=>s.totalTrades>0).length>0
          ?+(vSlots.filter(s=>s.totalTrades>0).reduce((a,s)=>a+s.winRate,0)/vSlots.filter(s=>s.totalTrades>0).length).toFixed(1)
          :0,
      };
    }

    res.json({
      ts:          new Date().toISOString(),
      version:     "10.0",
      uptime:      `${Math.round(process.uptime()/3600)}h ${Math.round((process.uptime()%3600)/60)}m`,
      totalSlots:  ALL_SLOTS.length,
      totalTrades: stats.reduce((a,s)=>a+s.totalTrades,0),
      totalPnl:    +stats.reduce((a,s)=>a+s.totalPnl,0).toFixed(2),
      marketMood:  mood,
      sourceComparison: sourceStats,
      variantComparison:variantStats,
      top10ByPnl:  byPnl.slice(0,10).map(s=>({slot:s.slot,source:s.sourceName,variant:s.variantName,pnl:s.totalPnl,trades:s.totalTrades,wr:s.winRate})),
      top10ByWinRate:byWinRate.slice(0,10).map(s=>({slot:s.slot,source:s.sourceName,variant:s.variantName,wr:s.winRate,pnl:s.totalPnl,trades:s.totalTrades})),
      allSlots:    stats.map(s=>({slot:s.slot,source:s.sourceName,variant:s.variantName,pnl:s.totalPnl,trades:s.totalTrades,wr:s.winRate,open:s.openTrades})),
      systemHealth:{
        sources:   sourceStats,
        database:  sysStatus.database,
        lastErrors:sysStatus.lastErrors.slice(0,5),
      },
      instructions:"Paste this to Claude — I will tell you which source and variant won",
    });
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get("*",(req,res)=>{
  if (req.path.startsWith("/api/")) return res.status(404).json({error:"Not found"});
  if (hasDist) return res.sendFile(path.join(STATIC_DIR,"index.html"));
  res.status(200).send("S0NAR v10.0 backend running.");
});

// ── START ─────────────────────────────────────────────────
app.listen(PORT, async()=>{
  console.log(`\nS0NAR v10.0 | Port:${PORT}`);
  console.log(`5 Sources × 10 Variants = ${ALL_SLOTS.length} trading slots`);
  console.log(`Sources: PumpPortal-WS | Helius-WS | DexScreener | Jupiter | Hybrid`);
  console.log(`Variants: ULTRA_SAFE | WAVE | SURGE | STEADY | ROCKET | SNIPER | WHALE | FOMO_RIDER | QUIET | MICRO\n`);

  await initDB();
  await refreshDaily();
  await updateMood();

  // Connect WebSocket sources
  connectPumpPortal();
  connectHelIUS();

  // Start polling sources
  setTimeout(pollDexScreener, 3000);
  setTimeout(pollJupiter,     6000);
  setTimeout(pollHybrid,      9000);

  // Intervals
  setInterval(pollDexScreener, FETCH_MS);
  setInterval(pollJupiter,     FETCH_MS+5000);
  setInterval(pollHybrid,      FETCH_MS+10000);
  setInterval(checkPositions,  CHECK_MS);
  setInterval(updateMood,      5*60*1000);
  setInterval(refreshDaily,    2*60*1000);
  setInterval(cleanupSignals,  6*60*60*1000);
});
