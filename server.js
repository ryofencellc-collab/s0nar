// ============================================================
//  S0NAR — IRON DOME v5.0  "FOMO HUNTER"
//  Strategy: enter before the crowd, exit into their buying
//  Max velocity. Max data. No position limits.
//  Real data. Real prices. Paper money. No simulation. Ever.
// ============================================================
const express  = require("express");
const cors     = require("cors");
const fetch    = require("node-fetch");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

// ── DATABASE ───────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function db(sql, params=[]) {
  const c = await pool.connect();
  try { return await c.query(sql, params); } finally { c.release(); }
}

async function initDB() {
  await db(`CREATE TABLE IF NOT EXISTS signals (
    id SERIAL PRIMARY KEY, ticker TEXT, pair_address TEXT, dex_url TEXT,
    score INTEGER, price NUMERIC, vol_5m NUMERIC, liq NUMERIC, pc_5m NUMERIC,
    boosted BOOLEAN DEFAULT FALSE, entered BOOLEAN DEFAULT FALSE,
    skip_reason TEXT, market_mood TEXT, age_min NUMERIC DEFAULT 0,
    fomo_score INTEGER DEFAULT 0,
    seen_at TIMESTAMPTZ DEFAULT NOW())`);

  await db(`CREATE TABLE IF NOT EXISTS trades (
    id SERIAL PRIMARY KEY, ticker TEXT, name TEXT,
    pair_address TEXT UNIQUE, dex_url TEXT, score INTEGER,
    entry_price NUMERIC, bet_size NUMERIC DEFAULT 50, status TEXT DEFAULT 'OPEN',
    exit_mult NUMERIC, highest_mult NUMERIC DEFAULT 1.0,
    pnl NUMERIC, exit_reason TEXT,
    vol_5m NUMERIC, vol_1h NUMERIC, liq NUMERIC, pc_5m NUMERIC,
    buys_5m INTEGER, sells_5m INTEGER, boosted BOOLEAN DEFAULT FALSE,
    market_mood TEXT, age_min NUMERIC DEFAULT 0,
    fomo_score INTEGER DEFAULT 0,
    opened_at TIMESTAMPTZ DEFAULT NOW(), closed_at TIMESTAMPTZ)`);

  // Safe migrations
  for (const col of [
    `ALTER TABLE signals ADD COLUMN IF NOT EXISTS age_min NUMERIC DEFAULT 0`,
    `ALTER TABLE signals ADD COLUMN IF NOT EXISTS fomo_score INTEGER DEFAULT 0`,
    `ALTER TABLE trades  ADD COLUMN IF NOT EXISTS age_min NUMERIC DEFAULT 0`,
    `ALTER TABLE trades  ADD COLUMN IF NOT EXISTS fomo_score INTEGER DEFAULT 0`,
  ]) await db(col).catch(()=>{});

  await db(`CREATE INDEX IF NOT EXISTS trades_status_idx ON trades(status)`);
  await db(`CREATE INDEX IF NOT EXISTS signals_seen_idx  ON signals(seen_at DESC)`);
  console.log("✅ DB ready — v5 FOMO Hunter");
}

// ── CONFIG ─────────────────────────────────────────────────
const NTFY  = process.env.NTFY_TOPIC;
const PORT  = process.env.PORT || 3000;

// Entry thresholds — tuned for max velocity
const MIN_SCORE    = 62;   // Lower floor = more trades, let FOMO score filter quality
const MIN_LIQ      = 3000; // Accept thinner liq for newer gems
const MIN_VOL_5M   = 500;  // Lower vol floor to catch early movers
const MIN_BUY_PCT  = 52;   // Slight majority buys is enough
const MIN_AGE_MIN  = 3;    // Enter earlier — 3 min old tokens
const MAX_AGE_MIN  = 180;  // Extended window — FOMO can last longer
const MIN_FOMO     = 20;   // Minimum FOMO score to enter

// Exit strategy — fast profits, cut losers quickly
const STOP_LOSS    = 0.72; // -28% stop
const EARLY_STOP   = 0.82; // -18% in first 10 min (tighter early cut)
const TIER1        = 1.5;  // First take at 1.5x (quick wins)
const TIER1_SELL   = 0.40; // Sell 40% at TIER1
const TIER2        = 3.0;  // Second take at 3x
const TIER2_SELL   = 0.35; // Sell 35% at TIER2
const TIER3        = 6.0;  // Let 25% ride to moon
const MAX_HOLD     = 120;  // 2h max — memes die fast
const TRAILING_PCT = 0.82; // -18% trailing after 45 min

// Timing
const FETCH_MS     = 15000; // Poll every 15s (was 25s)
const CHECK_MS     = 30000; // Check positions every 30s (was 60s)
const DAILY_LIMIT  = 300;   // Higher circuit breaker for testing

// State
let mood          = "normal";
let dynScore      = MIN_SCORE;
let circuitBroken = false;
let circuitAt     = null;
let dailyPnl      = 0;
let tuneCount     = 0;
let totalTrades   = 0;
let pollCount     = 0;

const volHistory   = new Map(); // Z-score per pair
const priceHistory = new Map(); // Price momentum tracking
const fomoHistory  = new Map(); // FOMO score history

// ── EXPANDED QUERY LIST — more vectors = more signals ──────
// Rotates through all, hitting every angle of Solana meme
const QUERIES = [
  // Pump.fun direct
  "pump.fun", "pumpfun", "pump fun sol",
  // Animal meta
  "dog sol", "cat sol", "frog sol", "fish sol", "pepe sol", "doge sol",
  "hamster sol", "bear sol", "bull sol", "wolf sol", "ape sol", "crab sol",
  // Vibe meta
  "based sol", "wagmi sol", "ngmi sol", "moon sol", "gem sol",
  "chad sol", "sigma sol", "alpha sol", "giga sol", "chad coin",
  // AI meta
  "ai sol", "gpt sol", "robot sol", "neural sol",
  // Meme phrases
  "solana meme", "sol token", "new sol", "launch sol", "bonk sol",
  "raydium new", "jupiter new", "sol gem", "100x sol", "1000x sol",
  // General launchers
  "sol launch", "presale sol", "fair launch sol", "stealth sol",
];
let qi = 0;

// ── NTFY ───────────────────────────────────────────────────
async function notify(title, body, priority="default") {
  if (!NTFY) return;
  try {
    await fetch(`https://ntfy.sh/${NTFY}`, {
      method: "POST",
      headers: {
        "Title":    title.replace(/[^\x20-\x7E]/g,"").trim().slice(0,100),
        "Priority": priority,
        "Tags":     "chart_with_upwards_trend",
      },
      body: (body||"").replace(/[^\x20-\x7E]/g,"").trim(),
    });
  } catch(e) { console.error("ntfy:", e.message); }
}

// ── DEXSCREENER ────────────────────────────────────────────
async function dexSearch(q) {
  const r = await fetch(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
    { timeout: 10000 }
  );
  if (!r.ok) throw new Error(`search ${r.status}`);
  const d = await r.json();
  return (d?.pairs||[]).filter(p => p.chainId==="solana" && parseFloat(p.priceUsd||0)>0);
}

async function dexBoosted() {
  const r = await fetch(
    `https://api.dexscreener.com/token-boosts/latest/v1`,
    { timeout: 10000 }
  );
  if (!r.ok) throw new Error(`boosts ${r.status}`);
  const d = await r.json();
  return (d||[]).filter(t => t.chainId==="solana").slice(0,20);
}

async function dexNewTokens() {
  // Fetch latest Solana pairs sorted by newest
  const r = await fetch(
    `https://api.dexscreener.com/latest/dex/search?q=solana`,
    { timeout: 10000 }
  );
  if (!r.ok) return [];
  const d = await r.json();
  const pairs = (d?.pairs||[]).filter(p =>
    p.chainId==="solana" &&
    parseFloat(p.priceUsd||0) > 0 &&
    p.pairCreatedAt &&
    (Date.now() - p.pairCreatedAt) < 30 * 60000 // Only last 30 min
  );
  return pairs.sort((a,b) => b.pairCreatedAt - a.pairCreatedAt);
}

async function dexPairs(addresses) {
  if (!addresses.length) return [];
  // Batch up to 30 addresses (DexScreener allows comma-separated)
  const chunks = [];
  for (let i=0; i<addresses.length; i+=10) chunks.push(addresses.slice(i,i+10));
  const results = [];
  for (const chunk of chunks) {
    try {
      const r = await fetch(
        `https://api.dexscreener.com/latest/dex/pairs/solana/${chunk.join(",")}`,
        { timeout: 10000 }
      );
      if (!r.ok) continue;
      const d = await r.json();
      results.push(...(d?.pairs||[]).filter(p => parseFloat(p.priceUsd||0)>0));
    } catch(e) { continue; }
  }
  return results;
}

async function dexPair(address) {
  const p = await dexPairs([address]);
  return p[0]||null;
}

// ── FOMO SCORE — the core of v5 ────────────────────────────
// Measures how much FOMO pressure is building in a token.
// High FOMO = crowd about to pile in = we want to be ahead of them.
function calcFomoScore(p) {
  const v5  = p.volume?.m5  || 0;
  const v1  = p.volume?.h1  || 0.001;
  const v6  = p.volume?.h6  || 0.001;
  const pc5 = parseFloat(p.priceChange?.m5  || 0);
  const pc1 = parseFloat(p.priceChange?.h1  || 0);
  const pc6 = parseFloat(p.priceChange?.h6  || 0);
  const b   = p.txns?.m5?.buys  || 0;
  const s   = p.txns?.m5?.sells || 0;
  const liq = p.liquidity?.usd || 0;
  const age = p.pairCreatedAt ? (Date.now()-p.pairCreatedAt)/60000 : 999;
  const bst = (p.boosts?.active||0) > 0;
  const addr = p.pairAddress;

  let fomo = 0;

  // 1. Volume acceleration — 5m vol vs expected 5m slice of 1h vol
  //    If 5m vol is 3x the expected rate, FOMO is building fast
  const expected5m = v1 / 12;
  const volAccel = expected5m > 0 ? v5 / expected5m : 0;
  fomo += Math.min(35, volAccel * 10); // Up to 35 pts

  // 2. Price velocity — rapid 5m move signals FOMO entry
  //    But we want early (5-15% move), not late (>50% already pumped)
  if (pc5 > 5  && pc5 <= 15) fomo += 20;  // Sweet spot — just starting
  if (pc5 > 15 && pc5 <= 30) fomo += 12;  // Already moving, still ok
  if (pc5 > 30 && pc5 <= 60) fomo += 5;   // Running hot, riskier
  if (pc5 > 60)               fomo -= 10; // Already pumped, late entry
  if (pc5 < 0)                fomo -= 5;

  // 3. Buy pressure surge — buyers overwhelming sellers
  const total = b + s;
  if (total > 10) {
    const buyRatio = b / total;
    if (buyRatio > 0.75) fomo += 18;
    else if (buyRatio > 0.65) fomo += 12;
    else if (buyRatio > 0.55) fomo += 6;
  }

  // 4. Age sweet spot — 5-30 min is prime FOMO window
  //    Token new enough to still be unknown, old enough to have survived
  if (age >= 3  && age < 10)  fomo += 15; // Very early
  if (age >= 10 && age < 30)  fomo += 20; // Prime FOMO window
  if (age >= 30 && age < 60)  fomo += 10; // Still early
  if (age >= 60 && age < 120) fomo += 3;  // Getting late
  if (age >= 120)             fomo -= 10; // Old news

  // 5. Price momentum direction — trending up over 1h means sustained interest
  if (pc1 > 0 && pc1 < 100)  fomo += 8;
  if (pc1 >= 100)             fomo += 3;  // Big move, diminishing returns
  if (pc1 < -10)              fomo -= 8;

  // 6. Liquidity growth signal — liq relative to vol suggests real trading
  if (liq > 0 && v5 > 0) {
    const volLiqRatio = v5 / liq;
    if (volLiqRatio > 0.5 && volLiqRatio < 5) fomo += 8; // Healthy
    if (volLiqRatio >= 5)                      fomo += 3; // Vol >> liq, FOMO
  }

  // 7. Z-score spike — sudden volume vs this token's own history
  const z = getZScore(addr, v5);
  if (z > 2)  fomo += 15;
  else if (z > 1) fomo += 8;
  else if (z > 0) fomo += 3;

  // 8. Boost amplifier — paid promotions drive FOMO
  if (bst) fomo += 10;

  // 9. FOMO momentum — compare to last seen fomo score for this token
  if (fomoHistory.has(addr)) {
    const prev = fomoHistory.get(addr);
    const delta = fomo - prev;
    if (delta > 10) fomo += 8;  // FOMO is accelerating
    if (delta < -15) fomo -= 5; // FOMO fading
  }
  fomoHistory.set(addr, Math.round(Math.max(0, Math.min(99, fomo))));

  return Math.round(Math.max(0, Math.min(99, fomo)));
}

// ── VELOCITY SCORE — classic scoring adapted for speed ─────
function getZScore(addr, vol) {
  if (!volHistory.has(addr)) volHistory.set(addr, []);
  const h = volHistory.get(addr);
  h.push(vol);
  if (h.length > 20) h.shift();
  if (h.length < 3) return 0;
  const mean = h.reduce((a,b)=>a+b,0)/h.length;
  const std  = Math.sqrt(h.reduce((a,b)=>a+(b-mean)**2,0)/h.length);
  return std===0 ? 0 : (vol-mean)/std;
}

function score(p) {
  const v5  = p.volume?.m5  || 0;
  const v1  = p.volume?.h1  || 1;
  const pc5 = parseFloat(p.priceChange?.m5 || 0);
  const pc1 = parseFloat(p.priceChange?.h1 || 0);
  const liq = p.liquidity?.usd || 0;
  const b   = p.txns?.m5?.buys  || 0;
  const s   = p.txns?.m5?.sells || 1;
  const bst = (p.boosts?.active||0) > 0;
  const age = p.pairCreatedAt ? (Date.now()-p.pairCreatedAt)/60000 : 999;
  const z   = getZScore(p.pairAddress, v5);

  let sc = 0;
  sc += Math.min(100, (v5/Math.max(v1/12,1))*100) * 0.28;
  sc += Math.min(100, Math.max(0,(pc5+30)/1.3))    * 0.18;
  sc += (liq>100000?100:liq>50000?85:liq>20000?65:liq>5000?45:liq>1000?25:5) * 0.14;
  sc += Math.min(100, (b/(b+s))*100)                * 0.15;
  sc += Math.min(15, Math.max(0, z*5));             // Z-score bonus
  sc += age<10?18:age<20?14:age<40?10:age<60?5:age>=120?-8:0; // Fresher = better
  sc += pc1>30?10:pc1>10?6:pc1<-20?-10:0;          // 1h momentum
  if (bst)      sc += 5;
  if (liq<1500) sc -= 20;
  if (v5<100)   sc -= 8;
  return Math.round(Math.max(0, Math.min(99, sc)));
}

// ── GATE — entry filter ────────────────────────────────────
function gate(p, sc, fomo) {
  const liq = p.liquidity?.usd || 0;
  const v5  = p.volume?.m5 || 0;
  const b   = p.txns?.m5?.buys  || 0;
  const s   = p.txns?.m5?.sells || 0;
  const bp  = b+s>0 ? (b/(b+s))*100 : 0;
  const pc5 = parseFloat(p.priceChange?.m5 || 0);
  const age = p.pairCreatedAt ? (Date.now()-p.pairCreatedAt)/60000 : 0;

  const checks = {
    score:      { pass: sc>=dynScore,              why: `score ${sc}<${dynScore}` },
    fomo:       { pass: fomo>=MIN_FOMO,            why: `fomo ${fomo}<${MIN_FOMO}` },
    liq:        { pass: liq>=MIN_LIQ,              why: `liq $${Math.round(liq)}<$${MIN_LIQ}` },
    vol:        { pass: v5>=MIN_VOL_5M,            why: `vol $${Math.round(v5)}<$${MIN_VOL_5M}` },
    buys:       { pass: bp>=MIN_BUY_PCT,           why: `buys ${Math.round(bp)}%<${MIN_BUY_PCT}%` },
    notDumping: { pass: pc5>-25,                   why: `dumping ${pc5.toFixed(0)}%` },
    notTooNew:  { pass: age<1||age>=MIN_AGE_MIN,   why: `too new ${age.toFixed(1)}min` },
    notStale:   { pass: age<=MAX_AGE_MIN||age<1,   why: `stale ${Math.round(age)}min` },
    hasPrice:   { pass: parseFloat(p.priceUsd||0)>0, why: "no price" },
  };
  const failed = Object.values(checks).filter(c=>!c.pass).map(c=>c.why);
  return { pass: failed.length===0, failed };
}

// ── RUG CHECK — fast safety filter ────────────────────────
function rugCheck(p) {
  const liq = p.liquidity?.usd||0;
  const v5  = p.volume?.m5||0;
  const v1  = p.volume?.h1||0;
  const b   = p.txns?.m5?.buys||0;
  const s   = p.txns?.m5?.sells||0;
  const age = (Date.now()-(p.pairCreatedAt||Date.now()))/60000;
  const w   = [];
  if (age < MIN_AGE_MIN)       w.push(`too new (${age.toFixed(1)}min)`);
  if (v5 > 80000 && liq<4000)  w.push("vol/liq mismatch — likely wash");
  if (s > b*3)                 w.push("heavy sell wall");
  if (v1 > 800000 && liq<8000) w.push("late pump — liq too thin");
  if (liq < 500)               w.push("dangerously thin liq");
  return { pass: w.length===0, warnings: w };
}

// ── BET SIZING — FOMO-adjusted ─────────────────────────────
// Higher FOMO score = bigger bet (crowd is coming)
function betSize(sc, fomo) {
  const base = sc>=85?100 : sc>=80?75 : sc>=75?60 : sc>=70?40 : 25;
  // FOMO multiplier: 0.8x to 1.4x
  const fomoMult = fomo>=80?1.4 : fomo>=65?1.2 : fomo>=50?1.1 : fomo>=35?1.0 : 0.8;
  return Math.round(Math.min(150, base * fomoMult / 5) * 5); // Round to $5
}

// ── PNL CALC — 3-tier exit with trailing stop ──────────────
function calcPnL(trade, curPrice) {
  const mult   = curPrice / parseFloat(trade.entry_price);
  const bet    = parseFloat(trade.bet_size);
  const ageMin = (Date.now()-new Date(trade.opened_at).getTime())/60000;
  const hi     = Math.max(parseFloat(trade.highest_mult||1), mult);

  // Trailing stop — kicks in after 45 min if we've had a good run
  const trailingActive = ageMin >= 45 && hi > 1.3;
  const trailingStop   = hi * TRAILING_PCT;

  // Early stop — tighter in first 10 min
  if (mult <= EARLY_STOP && ageMin < 10) {
    return { status:"CLOSED", exit:"EARLY STOP 🔴", mult, pnl:+(bet*(mult-1)).toFixed(2), highMult:hi };
  }
  // Trailing stop
  if (trailingActive && mult <= trailingStop) {
    return { status:"CLOSED", exit:"TRAILING STOP 📐", mult, pnl:+(bet*(mult-1)).toFixed(2), highMult:hi };
  }
  // Normal stop loss
  if (mult <= STOP_LOSS) {
    return { status:"CLOSED", exit:"STOP LOSS 🔴", mult, pnl:+(bet*(mult-1)).toFixed(2), highMult:hi };
  }
  // Tier 3 — the moon bag (25% rides)
  if (mult >= TIER3) {
    const pnl = +((bet*TIER1_SELL*(TIER1-1)) + (bet*TIER2_SELL*(TIER2-1)) + (bet*0.25*(mult-1))).toFixed(2);
    return { status:"CLOSED", exit:"TIER 3 🌙", mult, pnl, highMult:hi };
  }
  // Tier 2 — 3x target
  if (mult >= TIER2) {
    const pnl = +((bet*TIER1_SELL*(TIER1-1)) + (bet*TIER2_SELL*(mult-1))).toFixed(2);
    return { status:"CLOSED", exit:"TIER 2 🚀", mult, pnl, highMult:hi };
  }
  // Tier 1 — 1.5x quick flip (40% out)
  if (mult >= TIER1 && ageMin >= 8) {
    const pnl = +((bet*TIER1_SELL*(mult-1))).toFixed(2);
    // Don't close — partial exit, keep riding
    // We close fully at TIER2 or stop, but log TIER1 crossing
    return { status:"OPEN", exit:null, mult, pnl:null, highMult:hi, crossedTier1: true };
  }
  // Time exit
  if (ageMin >= MAX_HOLD) {
    return { status:"CLOSED", exit:mult>=1?"TIME EXIT ▲":"TIME EXIT ▼", mult, pnl:+(bet*(mult-1)).toFixed(2), highMult:hi };
  }
  return { status:"OPEN", exit:null, mult, pnl:null, highMult:hi };
}

// ── CIRCUIT BREAKER ────────────────────────────────────────
function checkCircuit() {
  const now = new Date();
  if (circuitAt && new Date(circuitAt).getDate()!==now.getDate()) {
    circuitBroken=false; circuitAt=null; dailyPnl=0;
  }
  if (dailyPnl<=-DAILY_LIMIT && !circuitBroken) {
    circuitBroken=true; circuitAt=now.toISOString();
    notify("CIRCUIT BREAKER", `Down $${Math.abs(dailyPnl).toFixed(2)} today. Paused until midnight.`, "urgent");
  }
}

// ── MARKET MOOD — broader + faster ────────────────────────
async function updateMood() {
  try {
    const [r1, r2] = await Promise.allSettled([
      dexSearch("solana meme"),
      dexSearch("pump.fun"),
    ]);
    const pairs = [
      ...(r1.status==="fulfilled"?r1.value:[]),
      ...(r2.status==="fulfilled"?r2.value:[]),
    ].slice(0,40);
    if (!pairs.length) return;

    const avg = pairs.reduce((a,p)=>a+parseFloat(p.priceChange?.m5||0),0)/pairs.length;
    const hot = pairs.filter(p=>parseFloat(p.priceChange?.m5||0)>8).length;
    const pct = (hot/pairs.length)*100;

    // New mood levels: dead / cold / normal / warm / hot / frenzy
    if      (avg>8  && pct>=60) { mood="frenzy"; dynScore=MIN_SCORE-4; }
    else if (avg>4  && pct>=40) { mood="hot";    dynScore=MIN_SCORE-2; }
    else if (avg>1  && pct>=25) { mood="warm";   dynScore=MIN_SCORE;   }
    else if (avg<-5 && pct< 15) { mood="cold";   dynScore=MIN_SCORE+5; }
    else if (avg<-8 && pct< 10) { mood="dead";   dynScore=MIN_SCORE+8; }
    else                         { mood="normal"; dynScore=MIN_SCORE;   }

    console.log(`[MOOD] ${mood} avg:${avg.toFixed(1)}% hot:${hot}/${pairs.length} min:${dynScore}`);
  } catch(e) { console.error("mood:", e.message); }
}

// ── SELF-TUNE — adjusts score weights from outcomes ────────
async function selfTune() {
  try {
    const r = await db(`SELECT score, fomo_score, pnl, exit_reason FROM trades WHERE status='CLOSED' ORDER BY closed_at DESC LIMIT 100`);
    const trades = r.rows;
    if (trades.length < 20) return;

    // Analyze which score ranges are profitable
    const byScore = { low:[], mid:[], high:[] };
    trades.forEach(t => {
      const p = parseFloat(t.pnl||0);
      if (t.score < 70) byScore.low.push(p);
      else if (t.score < 80) byScore.mid.push(p);
      else byScore.high.push(p);
    });

    const wr = (arr) => arr.length ? arr.filter(x=>x>0).length/arr.length : 0;

    // Adjust dynScore based on performance
    const lowWR  = wr(byScore.low);
    const midWR  = wr(byScore.mid);

    if (lowWR < 0.40 && byScore.low.length >= 10) {
      dynScore = Math.min(dynScore + 3, MIN_SCORE + 10);
    } else if (midWR > 0.65 && byScore.mid.length >= 10) {
      dynScore = Math.max(dynScore - 2, MIN_SCORE - 5);
    }

    // FOMO analysis — are high-FOMO trades performing?
    const highFomo = trades.filter(t => t.fomo_score >= 60);
    const lowFomo  = trades.filter(t => t.fomo_score < 40);
    if (highFomo.length >= 5 && lowFomo.length >= 5) {
      const hfWR = wr(highFomo.map(t=>parseFloat(t.pnl||0)));
      const lfWR = wr(lowFomo.map(t=>parseFloat(t.pnl||0)));
      console.log(`[TUNE] HighFOMO WR:${(hfWR*100).toFixed(0)}% LowFOMO WR:${(lfWR*100).toFixed(0)}%`);
    }

    tuneCount++;
    console.log(`[TUNE] #${tuneCount} minScore:${dynScore} trades:${trades.length}`);
  } catch(e) { console.error("tune:", e.message); }
}

async function refreshDaily() {
  try {
    const today = new Date().toISOString().slice(0,10);
    const r = await db(
      `SELECT COALESCE(SUM(pnl),0) as t FROM trades WHERE status='CLOSED' AND closed_at>=$1`,
      [`${today}T00:00:00Z`]
    );
    dailyPnl = parseFloat(r.rows[0].t);
    const ct = await db(`SELECT COUNT(*) FROM trades WHERE status='OPEN'`);
    totalTrades = parseInt(ct.rows[0].count);
  } catch(e) { console.error("daily:", e.message); }
}

async function weeklyReport() {
  try {
    const r = await db(`SELECT pnl FROM trades WHERE status='CLOSED' AND closed_at>=NOW()-INTERVAL '7 days'`);
    const t = r.rows, wins = t.filter(x=>parseFloat(x.pnl||0)>0);
    const tp = t.reduce((a,x)=>a+parseFloat(x.pnl||0),0);
    const wr = t.length ? Math.round((wins.length/t.length)*100) : 0;
    await notify("S0NAR Weekly", `${t.length} trades | ${wr}% WR | ${tp>=0?"+":""}$${tp.toFixed(2)} | Bankroll:$${(1000+tp).toFixed(0)}`);
  } catch(e) { console.error("weekly:", e.message); }
}

// ── DB HELPERS ─────────────────────────────────────────────
async function getOpen() {
  return (await db(`SELECT * FROM trades WHERE status='OPEN' ORDER BY opened_at DESC`)).rows;
}
async function hadTrade(addr) {
  return (await db(`SELECT id FROM trades WHERE pair_address=$1 LIMIT 1`,[addr])).rows.length > 0;
}
async function insertTrade(p, sc, fomo) {
  const bet = betSize(sc, fomo);
  const age = p.pairCreatedAt ? (Date.now()-p.pairCreatedAt)/60000 : 0;
  const r = await db(`
    INSERT INTO trades (ticker,name,pair_address,dex_url,score,entry_price,bet_size,
      status,highest_mult,vol_5m,vol_1h,liq,pc_5m,buys_5m,sells_5m,boosted,
      market_mood,age_min,fomo_score,opened_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'OPEN',1.0,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
    RETURNING *`,
    [p.baseToken?.symbol||"???", p.baseToken?.name||"", p.pairAddress, p.url, sc,
     parseFloat(p.priceUsd), bet,
     p.volume?.m5||0, p.volume?.h1||0, p.liquidity?.usd||0,
     parseFloat(p.priceChange?.m5||0),
     p.txns?.m5?.buys||0, p.txns?.m5?.sells||0,
     (p.boosts?.active||0)>0, mood,
     parseFloat(age.toFixed(1)), fomo]);
  return r.rows[0];
}
async function closeTrade(id, res) {
  await db(
    `UPDATE trades SET status='CLOSED',exit_mult=$1,highest_mult=$2,pnl=$3,exit_reason=$4,closed_at=NOW() WHERE id=$5`,
    [res.mult, res.highMult, res.pnl, res.exit, id]
  );
}
async function logSig(p, sc, fomo, g1, g2) {
  const age = p.pairCreatedAt ? (Date.now()-p.pairCreatedAt)/60000 : 0;
  await db(`
    INSERT INTO signals (ticker,pair_address,dex_url,score,price,vol_5m,liq,pc_5m,
      boosted,entered,skip_reason,market_mood,age_min,fomo_score,seen_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())`,
    [p.baseToken?.symbol||"???", p.pairAddress, p.url, sc,
     parseFloat(p.priceUsd||0), p.volume?.m5||0, p.liquidity?.usd||0,
     parseFloat(p.priceChange?.m5||0), (p.boosts?.active||0)>0,
     g1.pass&&g2.pass,
     [...g1.failed,...g2.warnings].join("; ")||null,
     mood, parseFloat(age.toFixed(1)), fomo]
  ).catch(()=>{});
}

// ── POLL SIGNALS — v5: multi-source parallel sweep ─────────
async function pollSignals() {
  checkCircuit();
  if (circuitBroken) { console.log("Circuit active — skip"); return; }

  pollCount++;
  const ts = new Date().toISOString();
  console.log(`[POLL #${pollCount}] ${ts} mood:${mood} min:${dynScore}`);

  try {
    // Run 3 queries in parallel every poll + always fetch boosted + new tokens
    const qBatch = [
      QUERIES[qi % QUERIES.length],
      QUERIES[(qi+1) % QUERIES.length],
      QUERIES[(qi+2) % QUERIES.length],
    ];
    qi += 3;

    const [r1, r2, r3, r4, r5] = await Promise.allSettled([
      dexSearch(qBatch[0]),
      dexSearch(qBatch[1]),
      dexSearch(qBatch[2]),
      dexBoosted(),
      dexNewTokens(),
    ]);

    const searchPairs = [
      ...(r1.status==="fulfilled"?r1.value:[]),
      ...(r2.status==="fulfilled"?r2.value:[]),
      ...(r3.status==="fulfilled"?r3.value:[]),
    ];
    const boostedTokens = r4.status==="fulfilled" ? r4.value : [];
    const newTokens     = r5.status==="fulfilled" ? r5.value : [];

    // Fetch boosted pair data
    let boostedPairs = [];
    if (boostedTokens.length) {
      const addrs = boostedTokens.map(t=>t.tokenAddress).filter(Boolean);
      boostedPairs = await dexPairs(addrs).catch(()=>[]);
    }

    // Combine + dedupe all sources
    const seen = new Set(), all = [];
    for (const p of [...searchPairs, ...boostedPairs, ...newTokens]) {
      if (!p.pairAddress || seen.has(p.pairAddress)) continue;
      seen.add(p.pairAddress);
      all.push(p);
    }

    console.log(`  Sources: search:${searchPairs.length} boosted:${boostedPairs.length} new:${newTokens.length} total:${all.length}`);

    let entered = 0, skipped = 0;
    for (const p of all) {
      const sc   = score(p);
      const fomo = calcFomoScore(p);
      const g1   = gate(p, sc, fomo);
      const g2   = rugCheck(p);

      await logSig(p, sc, fomo, g1, g2);

      if (!g1.pass || !g2.pass) { skipped++; continue; }
      if (await hadTrade(p.pairAddress)) continue;

      const trade = await insertTrade(p, sc, fomo).catch(e=>{
        if (!e.message.includes("unique")) console.error("insert:", e.message);
        return null;
      });

      if (trade) {
        entered++;
        const liq   = p.liquidity?.usd||0;
        const bp    = Math.round((p.txns?.m5?.buys||0)/Math.max((p.txns?.m5?.buys||0)+(p.txns?.m5?.sells||0),1)*100);
        const age   = p.pairCreatedAt ? ((Date.now()-p.pairCreatedAt)/60000).toFixed(0) : "?";
        const pc5   = parseFloat(p.priceChange?.m5||0).toFixed(0);
        console.log(`  ✅ ENTERED ${p.baseToken?.symbol} sc:${sc} fomo:${fomo} bet:$${trade.bet_size} age:${age}m +${pc5}%`);
        await notify(
          `FOMO ENTRY: ${p.baseToken?.symbol}`,
          `Score:${sc} FOMO:${fomo} | Bet:$${trade.bet_size} | Age:${age}min | +${pc5}% 5m | Liq:$${Math.round(liq).toLocaleString()} | Buys:${bp}%`,
          "high"
        );
      }
    }

    console.log(`  Entered:${entered} | Skipped:${skipped} | Seen:${all.length}`);

    // Self-tune every 30 closed trades
    const cnt = parseInt((await db(`SELECT COUNT(*) FROM trades WHERE status='CLOSED'`)).rows[0].count);
    if (cnt > 0 && cnt % 30 === 0 && Math.floor(cnt/30) > tuneCount) await selfTune();

  } catch(e) { console.error("poll:", e.message); }
}

// ── CHECK POSITIONS — faster + FOMO-aware exits ────────────
async function checkPositions() {
  try {
    const open = await getOpen();
    if (!open.length) return;

    // Batch fetch all open positions at once for speed
    const addrs = open.map(t=>t.pair_address);
    const pairs = await dexPairs(addrs).catch(()=>[]);
    const pairMap = new Map(pairs.map(p=>[p.pairAddress, p]));

    const ts = new Date().toISOString();
    console.log(`[CHECK] ${ts} open:${open.length}`);

    for (const t of open) {
      try {
        const pair = pairMap.get(t.pair_address) || await dexPair(t.pair_address).catch(()=>null);

        if (!pair) {
          const ageMin = (Date.now()-new Date(t.opened_at).getTime())/60000;
          if (ageMin > 30) {
            const pnl = +(parseFloat(t.bet_size)*-0.50).toFixed(2);
            await closeTrade(t.id, {mult:0.50, pnl, exit:"DELISTED 💀", highMult:parseFloat(t.highest_mult||1)});
            dailyPnl += pnl;
            await notify(`DELISTED: ${t.ticker}`, "Pair vanished. -50%.");
          }
          continue;
        }

        const cur = parseFloat(pair.priceUsd);
        if (!cur || cur <= 0) continue;

        const res = calcPnL(t, cur);
        const pct = ((cur/parseFloat(t.entry_price))-1)*100;
        const fomo = calcFomoScore(pair);

        // Update highest mult
        if (res.highMult > parseFloat(t.highest_mult||1)) {
          await db(`UPDATE trades SET highest_mult=$1 WHERE id=$2`,[res.highMult, t.id]);
        }

        // FOMO fade exit — if FOMO score collapses below 15 and we're in profit, take it
        const fomoFade = fomo < 15 && pct > 5;
        if (fomoFade && res.status === "OPEN") {
          const pnl = +(parseFloat(t.bet_size)*(cur/parseFloat(t.entry_price)-1)).toFixed(2);
          await closeTrade(t.id, {mult:cur/parseFloat(t.entry_price), pnl, exit:"FOMO FADE ✓", highMult:res.highMult});
          dailyPnl += pnl;
          console.log(`  FOMO FADE ${t.ticker} +${pct.toFixed(0)}% $+${pnl}`);
          await notify(`FOMO FADE: ${t.ticker}`, `+${pct.toFixed(0)}% | $+${pnl} | FOMO dropped to ${fomo}`, "default");
          continue;
        }

        console.log(`  ${t.ticker}: ${pct>=0?"+":""}${pct.toFixed(0)}% FOMO:${fomo} hi:${res.highMult.toFixed(2)}x → ${res.status}`);

        if (res.status === "CLOSED") {
          await closeTrade(t.id, res);
          dailyPnl += res.pnl;
          checkCircuit();
          const ps = res.pnl>=0 ? `+$${res.pnl.toFixed(2)}` : `-$${Math.abs(res.pnl).toFixed(2)}`;
          console.log(`  CLOSED ${t.ticker} ${res.exit} ${ps}`);
          await notify(
            `${res.pnl>=0?"WIN 🟢":"LOSS 🔴"} ${t.ticker}: ${res.exit}`,
            `${ps} | ${res.mult.toFixed(2)}x | $${t.bet_size} bet | Score:${t.score} FOMO:${t.fomo_score} | Today:${dailyPnl>=0?"+":""}$${dailyPnl.toFixed(2)}`,
            res.pnl>=0?"high":"default"
          );
        }
      } catch(e) { console.error(`  ${t.ticker}:`, e.message); }
    }
  } catch(e) { console.error("check:", e.message); }
}

// ── API ────────────────────────────────────────────────────
app.get("/health", (req,res) => res.json({
  status:"ok", ts:new Date().toISOString(), version:"5.0-FOMO-HUNTER",
  marketMood:mood, dynamicMinScore:dynScore, circuitBroken,
  dailyPnl:+dailyPnl.toFixed(2), selfTuneCount:tuneCount,
  pollCount, openPositions:totalTrades,
  config:{ MIN_SCORE, MIN_FOMO, MIN_LIQ, MIN_VOL_5M, FETCH_MS, CHECK_MS, MAX_HOLD,
           TIER1, TIER2, TIER3, STOP_LOSS, QUERIES:QUERIES.length }
}));

app.get("/test-ntfy", async(req,res) => {
  await notify("S0NAR Test", "FOMO Hunter v5 is live. Let's get it.", "high");
  res.json({sent:true, topic:NTFY||"not set"});
});

app.get("/api/signals", async(req,res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit)||200, 500);
    res.json((await db(`SELECT * FROM signals ORDER BY seen_at DESC LIMIT $1`,[limit])).rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/trades", async(req,res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit)||500, 2000);
    res.json((await db(`SELECT * FROM trades ORDER BY opened_at DESC LIMIT $1`,[limit])).rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/stats", async(req,res) => {
  try {
    const all    = (await db(`SELECT * FROM trades`)).rows;
    const closed = all.filter(t=>t.status==="CLOSED");
    const open   = all.filter(t=>t.status==="OPEN");
    const wins   = closed.filter(t=>parseFloat(t.pnl||0)>0);
    const losses = closed.filter(t=>parseFloat(t.pnl||0)<=0);
    const tp     = closed.reduce((a,t)=>a+parseFloat(t.pnl||0),0);
    const wr     = closed.length ? (wins.length/closed.length)*100 : 0;
    const aw     = wins.length   ? wins.reduce((a,t)=>a+parseFloat(t.pnl||0),0)/wins.length : 0;
    const al     = losses.length ? losses.reduce((a,t)=>a+parseFloat(t.pnl||0),0)/losses.length : 0;
    const best   = closed.length ? closed.reduce((a,b)=>parseFloat(a.pnl||0)>parseFloat(b.pnl||0)?a:b, closed[0]) : null;
    const pf     = losses.length && Math.abs(al)>0 ? Math.abs(aw*wins.length)/Math.abs(al*losses.length) : null;

    // Score buckets
    const bkts = {"<65":[],"65-69":[],"70-74":[],"75-79":[],"80-84":[],"85+":[]};
    closed.forEach(t => {
      const k = t.score>=85?"85+":t.score>=80?"80-84":t.score>=75?"75-79":t.score>=70?"70-74":t.score>=65?"65-69":"<65";
      bkts[k].push(parseFloat(t.pnl||0));
    });

    // FOMO buckets
    const fbkts = {"0-19":[],"20-39":[],"40-59":[],"60-79":[],"80+":[]};
    closed.forEach(t => {
      const f = parseInt(t.fomo_score||0);
      const k = f>=80?"80+":f>=60?"60-79":f>=40?"40-59":f>=20?"20-39":"0-19";
      fbkts[k].push(parseFloat(t.pnl||0));
    });

    const makeBuckets = (obj) => {
      const out = {};
      for (const [k,p] of Object.entries(obj)) {
        const w = p.filter(x=>x>0).length;
        out[k] = {
          trades: p.length,
          winRate: p.length ? Math.round((w/p.length)*100) : null,
          avgPnl: p.length ? +(p.reduce((a,b)=>a+b,0)/p.length).toFixed(2) : null,
          totalPnl: +p.reduce((a,b)=>a+b,0).toFixed(2),
        };
      }
      return out;
    };

    const ord = [...closed].sort((a,b)=>new Date(a.closed_at)-new Date(b.closed_at));
    let run = 1000;
    const equity = [1000, ...ord.map(t=>{run+=parseFloat(t.pnl||0);return +run.toFixed(2);})];

    const daily = {};
    closed.forEach(t=>{
      if(!t.closed_at) return;
      const d = new Date(t.closed_at).toISOString().slice(0,10);
      daily[d] = +((daily[d]||0)+parseFloat(t.pnl||0)).toFixed(2);
    });

    const exits = {};
    closed.forEach(t=>{ exits[t.exit_reason||"unknown"]=(exits[t.exit_reason||"unknown"]||0)+1; });

    res.json({
      bankroll:+(1000+tp).toFixed(2), totalPnl:+tp.toFixed(2),
      winRate:+wr.toFixed(1), avgWin:+aw.toFixed(2), avgLoss:+al.toFixed(2),
      profitFactor:pf?+pf.toFixed(2):null,
      totalTrades:closed.length, openTrades:open.length,
      best:best?{ticker:best.ticker,pnl:+parseFloat(best.pnl||0).toFixed(2),mult:+parseFloat(best.exit_mult||0).toFixed(2)}:null,
      buckets:makeBuckets(bkts), fomoBuckets:makeBuckets(fbkts),
      equity, daily, exits,
      ironDome:{
        marketMood:mood, dynamicMinScore:dynScore, circuitBroken,
        dailyPnl:+dailyPnl.toFixed(2), selfTuneCount:tuneCount,
        pollCount, version:"5.0-FOMO-HUNTER",
        config:{ MIN_SCORE, MIN_FOMO, TIER1, TIER2, TIER3, MAX_HOLD }
      },
    });
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/backtest", async(req,res) => {
  console.log("[BACKTEST] Starting v5...");
  try {
    const allPairs = [];
    // Run all queries in parallel batches
    const batchSize = 5;
    for (let i=0; i<QUERIES.length; i+=batchSize) {
      const batch = QUERIES.slice(i, i+batchSize);
      const results = await Promise.allSettled(batch.map(q =>
        fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,{timeout:10000})
          .then(r=>r.ok?r.json():null)
          .then(d=>(d?.pairs||[]).filter(p=>p.chainId==="solana"&&parseFloat(p.priceUsd||0)>0&&(p.liquidity?.usd||0)>500))
      ));
      for (const r of results) if (r.status==="fulfilled"&&r.value) allPairs.push(...r.value);
      await new Promise(r=>setTimeout(r,200));
    }

    // Boosted
    try {
      const br = await fetch("https://api.dexscreener.com/token-boosts/latest/v1",{timeout:10000});
      if (br.ok) {
        const bd = await br.json();
        const addrs = (bd||[]).filter(t=>t.chainId==="solana").slice(0,20).map(t=>t.tokenAddress).filter(Boolean);
        if (addrs.length) {
          const bp = await dexPairs(addrs).catch(()=>[]);
          allPairs.push(...bp);
        }
      }
    } catch(e){}

    // Dedupe
    const seen = new Set(), pairs = [];
    for (const p of allPairs) { if(!p.pairAddress||seen.has(p.pairAddress))continue; seen.add(p.pairAddress); pairs.push(p); }
    console.log(`[BACKTEST] ${pairs.length} pairs`);

    const results = [];
    for (const p of pairs) {
      const sc   = score(p);
      const fomo = calcFomoScore(p);
      const liq  = p.liquidity?.usd||0;
      const v5   = p.volume?.m5||0;
      const v1   = p.volume?.h1||0;
      const pc5  = parseFloat(p.priceChange?.m5||0);
      const pc1  = parseFloat(p.priceChange?.h1||0);
      const pc24 = parseFloat(p.priceChange?.h24||0);
      const b    = p.txns?.m5?.buys||0;
      const s    = p.txns?.m5?.sells||0;
      const bsPct = b+s>0 ? Math.round((b/(b+s))*100) : 50;
      const boosted = (p.boosts?.active||0)>0;
      if (sc<45||liq<300) continue;

      const bet = betSize(sc, fomo);
      let mult, exit, pnl;
      if      (pc1<=-28)          { mult=0.72; exit="STOP LOSS";   pnl=+(bet*-0.28).toFixed(2); }
      else if (pc1<=-15&&v5<v1/8) { mult=0.82; exit="EARLY STOP";  pnl=+(bet*-0.18).toFixed(2); }
      else if (pc1>=400)          { mult=6.0;  exit="TIER 3 🌙";   pnl=+((bet*.40*(TIER1-1))+(bet*.35*(TIER2-1))+(bet*.25*5)).toFixed(2); }
      else if (pc1>=100)          { mult=3.0;  exit="TIER 2 🚀";   pnl=+((bet*.40*(TIER1-1))+(bet*.35*(pc1/100))).toFixed(2); }
      else if (pc1>=50)           { mult=1.5;  exit="TIER 1 ✓";    pnl=+(bet*.40*(pc1/100)).toFixed(2); }
      else if (pc1>=0)            { mult=+(1+pc1/100).toFixed(2); exit="TIME EXIT ▲"; pnl=+(bet*(pc1/100)).toFixed(2); }
      else                        { mult=+(1+pc1/100).toFixed(2); exit="TIME EXIT ▼"; pnl=+(bet*(pc1/100)).toFixed(2); }

      const wouldEnter = sc>=dynScore && fomo>=MIN_FOMO && liq>=MIN_LIQ && v5>=MIN_VOL_5M && bsPct>=MIN_BUY_PCT && pc5>-25;
      results.push({
        ticker:p.baseToken?.symbol||"???", pairAddr:p.pairAddress, dexUrl:p.url,
        score:sc, fomo, betSize:bet, liq:Math.round(liq), vol5m:Math.round(v5),
        pc5m:+pc5.toFixed(1), pc1h:+pc1.toFixed(1), pc24h:+pc24.toFixed(1),
        bsPct, boosted, mult, pnl, exit, wouldEnter,
      });
    }

    results.sort((a,b)=>b.fomo-a.fomo); // Sort by FOMO desc
    const qual = results.filter(r=>r.wouldEnter);
    const qw   = qual.filter(r=>r.pnl>0), ql=qual.filter(r=>r.pnl<=0);
    const qtp  = +qual.reduce((a,r)=>a+r.pnl,0).toFixed(2);
    const qwr  = qual.length ? (qw.length/qual.length)*100 : 0;
    const qaw  = qw.length ? +(qw.reduce((a,r)=>a+r.pnl,0)/qw.length).toFixed(2) : 0;
    const qal  = ql.length ? +(ql.reduce((a,r)=>a+r.pnl,0)/ql.length).toFixed(2) : 0;

    const fomoBkts = {"0-19":[],"20-39":[],"40-59":[],"60-79":[],"80+":[]};
    qual.forEach(r=>{
      const k = r.fomo>=80?"80+":r.fomo>=60?"60-79":r.fomo>=40?"40-59":r.fomo>=20?"20-39":"0-19";
      fomoBkts[k].push(r.pnl);
    });
    const fb = {};
    for(const[k,p]of Object.entries(fomoBkts)){
      const w=p.filter(x=>x>0).length;
      fb[k]={trades:p.length,winRate:p.length?Math.round((w/p.length)*100):null,avgPnl:p.length?+(p.reduce((a,b)=>a+b,0)/p.length).toFixed(2):null,totalPnl:+p.reduce((a,b)=>a+b,0).toFixed(2)};
    }

    console.log(`[BACKTEST] Done. ${qual.length} qualifying. WR:${qwr.toFixed(0)}% FOMO-sorted`);
    res.json({
      scanned:results.length, qualifying:qual.length,
      winRate:+qwr.toFixed(1), totalPnl:qtp, avgWin:qaw, avgLoss:qal,
      fomoBuckets:fb, trades:results,
      disclaimer:"Real DexScreener data sorted by FOMO score. 1h price change = outcome proxy. Apply 20% haircut for live estimate.",
      ts:new Date().toISOString(),
    });
  } catch(e) { console.error("[BACKTEST]",e.message); res.status(500).json({error:e.message}); }
});

// Live FOMO feed — top tokens by FOMO score right now
app.get("/api/fomo-feed", async(req,res) => {
  try {
    const r = await db(`
      SELECT ticker, pair_address, dex_url, score, fomo_score, price, vol_5m, liq, pc_5m, age_min, market_mood, seen_at
      FROM signals
      WHERE seen_at > NOW() - INTERVAL '10 minutes'
        AND fomo_score >= 30
      ORDER BY fomo_score DESC
      LIMIT 50`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── START ──────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🎯 S0NAR FOMO HUNTER v5.0 | Port:${PORT}`);
  console.log(`   DB: ${process.env.DATABASE_URL?"connected":"MISSING"} | ntfy: ${NTFY||"not set"}`);
  console.log(`   Queries: ${QUERIES.length} | Poll: ${FETCH_MS}ms | Check: ${CHECK_MS}ms`);
  console.log(`   Min score: ${MIN_SCORE} | Min FOMO: ${MIN_FOMO} | Tiers: ${TIER1}x/${TIER2}x/${TIER3}x\n`);

  await initDB();
  await refreshDaily();
  await updateMood();

  // Stagger startup to avoid hammering DexScreener
  setTimeout(pollSignals, 2000);

  setInterval(pollSignals,    FETCH_MS);   // Every 15s
  setInterval(checkPositions, CHECK_MS);   // Every 30s
  setInterval(updateMood,     5*60*1000);  // Every 5 min (was 1h)
  setInterval(refreshDaily,   2*60*1000);  // Every 2 min

  // Weekly report on Sunday 9am
  setInterval(()=>{
    const n=new Date();
    if(n.getDay()===0&&n.getHours()===9&&n.getMinutes()<1) weeklyReport();
  }, 60000);
});
