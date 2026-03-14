// ============================================================
//  S0NAR — IRON DOME v4.0 — PRINT MONEY EDITION
//  Fresh launch hunter + Volume spike detection + Smart scoring
// ============================================================

const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

// ── DATABASE ───────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function query(sql, params=[]) {
  const c = await pool.connect();
  try { return await c.query(sql, params); } finally { c.release(); }
}

async function initDB() {
  await query(`CREATE TABLE IF NOT EXISTS signals (
    id SERIAL PRIMARY KEY, ticker TEXT, pair_address TEXT, dex_url TEXT,
    score INTEGER, price NUMERIC, vol_5m NUMERIC, liq NUMERIC, pc_5m NUMERIC,
    boosted BOOLEAN DEFAULT FALSE, entered BOOLEAN DEFAULT FALSE,
    skip_reason TEXT, market_mood TEXT,
    seen_at TIMESTAMPTZ DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS trades (
    id SERIAL PRIMARY KEY, ticker TEXT, name TEXT,
    pair_address TEXT UNIQUE, dex_url TEXT, score INTEGER,
    entry_price NUMERIC, bet_size NUMERIC DEFAULT 50, status TEXT DEFAULT 'OPEN',
    exit_mult NUMERIC, highest_mult NUMERIC DEFAULT 1.0, pnl NUMERIC, exit_reason TEXT,
    vol_5m NUMERIC, vol_1h NUMERIC, liq NUMERIC, pc_5m NUMERIC,
    buys_5m INTEGER, sells_5m INTEGER, boosted BOOLEAN DEFAULT FALSE,
    market_mood TEXT,
    opened_at TIMESTAMPTZ DEFAULT NOW(), closed_at TIMESTAMPTZ)`);
  await query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS age_min NUMERIC DEFAULT 0`);
  await query(`ALTER TABLE trades  ADD COLUMN IF NOT EXISTS age_min NUMERIC DEFAULT 0`);
  await query(`CREATE INDEX IF NOT EXISTS trades_status_idx ON trades(status)`);
  await query(`CREATE INDEX IF NOT EXISTS signals_seen_idx ON signals(seen_at DESC)`);
  console.log('✅ DB ready');
}

// ── ENV ────────────────────────────────────────────────────
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const PORT       = process.env.PORT || 3000;

// ── IRON DOME SETTINGS ─────────────────────────────────────
const MIN_SCORE      = 70;
const MIN_LIQ        = 5000;
const MIN_VOL_5M     = 1000;
const MIN_BUY_PCT    = 55;
const MIN_AGE_MIN    = 5;    // token must be at least 5 min old
const MAX_AGE_MIN    = 120;  // ignore tokens older than 2 hours
const STOP_LOSS      = 0.70;
const TIER1_MULT     = 2.0;
const TIER2_MULT     = 5.0;
const MAX_HOLD_MIN   = 240;
const DAILY_LIMIT    = 150;
const FETCH_MS       = 25000; // slightly faster polling
const CHECK_MS       = 60000;
const MOOD_MS        = 3600000;

let marketMood      = "normal";
let dynScore        = MIN_SCORE;
let circuitBroken   = false;
let circuitAt       = null;
let dailyPnl        = 0;
let tuneCount       = 0;

// Volume history for Z-score spike detection
// pairAddress -> [vol_5m readings]
const volHistory = new Map();

const SEARCH_QUERIES = [
  "pump.fun","solana meme","pepe sol","dog sol",
  "cat sol","based sol","ai sol","frog sol",
  "moon sol","wagmi sol","bonk sol","sol token",
  "new sol","launch sol","gem sol","100x sol",
];
let qi = 0;

// ── NTFY ───────────────────────────────────────────────────
async function notify(title, body, priority="default") {
  if (!NTFY_TOPIC) return;
  const t = title.replace(/[^\x20-\x7E]/g,"").trim();
  const b = (body||"").replace(/[^\x20-\x7E]/g,"").trim();
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method:"POST",
      headers:{"Title":t,"Priority":priority,"Tags":"chart_with_upwards_trend"},
      body:b,
    });
  } catch(e) { console.error("ntfy:",e.message); }
}

// ── DEXSCREENER ────────────────────────────────────────────
async function dexSearch(q) {
  const r = await fetch(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
    { timeout:10000 }
  );
  if (!r.ok) throw new Error(`search ${r.status}`);
  const d = await r.json();
  return (d?.pairs||[]).filter(p=>p.chainId==="solana"&&parseFloat(p.priceUsd||0)>0);
}

async function dexBoosted() {
  const r = await fetch(`https://api.dexscreener.com/token-boosts/latest/v1`,{timeout:10000});
  if (!r.ok) throw new Error(`boosts ${r.status}`);
  const d = await r.json();
  return (d||[]).filter(t=>t.chainId==="solana").slice(0,10);
}

async function dexNewPairs() {
  // Search specifically for brand new pump.fun launches
  const queries = ["pump.fun new","solana new token","sol launch","pump fun"];
  const results = [];
  for (const q of queries) {
    try {
      const pairs = await dexSearch(q);
      // Filter for genuinely new tokens (5-120 min old)
      const fresh = pairs.filter(p => {
        if (!p.pairCreatedAt) return false;
        const ageMin = (Date.now() - p.pairCreatedAt) / 60000;
        return ageMin >= MIN_AGE_MIN && ageMin <= MAX_AGE_MIN;
      });
      results.push(...fresh);
    } catch(e) { /* skip */ }
    await new Promise(r=>setTimeout(r,300));
  }
  return results;
}

async function dexPairs(addresses) {
  if (!addresses.length) return [];
  const r = await fetch(
    `https://api.dexscreener.com/latest/dex/pairs/solana/${addresses.slice(0,10).join(",")}`,
    {timeout:10000}
  );
  if (!r.ok) throw new Error(`pairs ${r.status}`);
  const d = await r.json();
  return (d?.pairs||[]).filter(p=>parseFloat(p.priceUsd||0)>0);
}

async function dexPair(address) {
  const p = await dexPairs([address]);
  return p[0]||null;
}

// ── VOLUME SPIKE DETECTION (Z-SCORE) ──────────────────────
// Returns how many standard deviations above normal this vol spike is
function getVolZScore(pairAddress, currentVol5m) {
  if (!volHistory.has(pairAddress)) {
    volHistory.set(pairAddress, []);
  }
  const history = volHistory.get(pairAddress);
  history.push(currentVol5m);
  // Keep last 20 readings
  if (history.length > 20) history.shift();
  if (history.length < 3) return 0;

  const mean = history.reduce((a,b)=>a+b,0) / history.length;
  const variance = history.reduce((a,b)=>a+(b-mean)**2,0) / history.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (currentVol5m - mean) / std;
}

// ── ENHANCED SCORING ENGINE v4 ─────────────────────────────
function scorePair(p) {
  const vol5m   = p.volume?.m5  || 0;
  const vol1h   = p.volume?.h1  || 1;
  const pc5m    = parseFloat(p.priceChange?.m5  || 0);
  const pc1h    = parseFloat(p.priceChange?.h1  || 0);
  const liq     = p.liquidity?.usd || 0;
  const buys    = p.txns?.m5?.buys  || 0;
  const sells   = p.txns?.m5?.sells || 1;
  const boosted = (p.boosts?.active || 0) > 0;
  const ageMin  = p.pairCreatedAt
    ? (Date.now() - p.pairCreatedAt) / 60000
    : 999;

  // Volume momentum: 5m vs expected rate (higher = more spike)
  const volMom = Math.min(100, (vol5m / Math.max(vol1h / 12, 1)) * 100);

  // Price momentum: maps -30% to +200% → 0-100
  const priceMom = Math.min(100, Math.max(0, (pc5m + 30) / 1.3));

  // Liquidity score
  const liqScore = liq>100000?100:liq>50000?85:liq>20000?65:liq>5000?45:liq>1000?25:5;

  // Buy pressure
  const buyPress = Math.min(100, (buys / (buys + sells)) * 100);

  // Age bonus — sweet spot is 5-60 min old (fresh launch FOMO window)
  let ageBon = 0;
  if (ageMin >= 5  && ageMin < 15)  ageBon = 15; // very fresh
  if (ageMin >= 15 && ageMin < 30)  ageBon = 10; // fresh
  if (ageMin >= 30 && ageMin < 60)  ageBon = 5;  // getting there
  if (ageMin >= 60 && ageMin < 120) ageBon = 0;  // normal
  if (ageMin >= 120)                 ageBon = -10; // stale

  // Volume Z-score bonus — spike above normal = strong signal
  const zScore  = getVolZScore(p.pairAddress, vol5m);
  const zBonus  = Math.min(15, Math.max(0, zScore * 5));

  // 1h momentum confirmation
  const h1Bonus = pc1h > 50 ? 10 : pc1h > 20 ? 5 : pc1h < -20 ? -10 : 0;

  let s = 0;
  s += volMom   * 0.30;
  s += priceMom * 0.20;
  s += liqScore * 0.15;
  s += buyPress * 0.15;
  s += ageBon;
  s += zBonus;
  s += h1Bonus;
  if (boosted)     s += 5;
  if (liq < 2000)  s -= 25;
  if (vol5m < 200) s -= 10;

  return Math.round(Math.max(0, Math.min(99, s)));
}

// ── IRON DOME LAYERS ───────────────────────────────────────
function l1Gate(pair, sc) {
  const liq   = pair.liquidity?.usd || 0;
  const vol5m = pair.volume?.m5 || 0;
  const buys  = pair.txns?.m5?.buys  || 0;
  const sells = pair.txns?.m5?.sells || 0;
  const bp    = buys+sells > 0 ? (buys/(buys+sells))*100 : 0;
  const pc5m  = parseFloat(pair.priceChange?.m5 || 0);
  const ageMin = pair.pairCreatedAt
    ? (Date.now() - pair.pairCreatedAt) / 60000
    : 0;

  const checks = {
    score:      { pass: sc >= dynScore,           reason: `score ${sc}<${dynScore}` },
    liq:        { pass: liq >= MIN_LIQ,           reason: `liq $${Math.round(liq)}<$${MIN_LIQ}` },
    vol:        { pass: vol5m >= MIN_VOL_5M,      reason: `vol $${Math.round(vol5m)}<$${MIN_VOL_5M}` },
    buys:       { pass: bp >= MIN_BUY_PCT,        reason: `buys ${Math.round(bp)}%<${MIN_BUY_PCT}%` },
    notDumping: { pass: pc5m > -20,               reason: `dumping ${pc5m.toFixed(0)}%` },
    notStale:   { pass: ageMin <= MAX_AGE_MIN || ageMin === 0, reason: `too old (${Math.round(ageMin)}min)` },
    price:      { pass: parseFloat(pair.priceUsd||0) > 0, reason: "no price" },
  };
  const failed = Object.values(checks).filter(c=>!c.pass).map(c=>c.reason);
  return { pass: failed.length===0, failed };
}

function l2Rug(pair) {
  const liq   = pair.liquidity?.usd || 0;
  const vol5m = pair.volume?.m5 || 0;
  const vol1h = pair.volume?.h1 || 0;
  const buys  = pair.txns?.m5?.buys  || 0;
  const sells = pair.txns?.m5?.sells || 0;
  const ageMin = pair.pairCreatedAt
    ? (Date.now() - pair.pairCreatedAt) / 60000
    : 999;

  const w = [];
  if (ageMin < MIN_AGE_MIN)           w.push(`too new (${ageMin.toFixed(1)}min — bots still fighting)`);
  if (vol5m > 50000 && liq < 5000)    w.push("vol/liq mismatch — wash trade");
  if (sells > buys * 2.0)             w.push("heavy sell pressure");
  if (vol1h > 500000 && liq < 10000)  w.push("late pump — missed window");
  return { pass: w.length===0, warnings: w };
}

function getBetSize(sc) {
  if (sc >= 85) return 100;
  if (sc >= 80) return 75;
  if (sc >= 75) return 50;
  return 25;
}

function calcPnL(trade, cur) {
  const mult    = cur / trade.entry_price;
  const bet     = trade.bet_size;
  const ageMin  = (Date.now() - new Date(trade.opened_at).getTime()) / 60000;
  const hi      = Math.max(trade.highest_mult || 1, mult);

  // Adaptive stop loss
  let stop;
  if (ageMin >= 60 && hi > 1.5) stop = hi * 0.85; // trailing
  else if (ageMin < 15)          stop = 0.80;       // tight early
  else                           stop = STOP_LOSS;   // normal

  if (mult <= stop) {
    const ex = ageMin >= 60 ? "TRAILING STOP 📉" : ageMin < 15 ? "EARLY STOP 🛑" : "STOP LOSS 🛑";
    return { status:"CLOSED", exit:ex, mult, pnl:bet*(mult-1), highMult:hi };
  }
  if (mult >= TIER2_MULT) {
    const pnl = (bet*.30*(TIER1_MULT-1)) + (bet*.40*(TIER2_MULT-1)) + (bet*.30*(mult-1));
    return { status:"CLOSED", exit:"TIER 2 🚀", mult, pnl, highMult:hi };
  }
  if (mult >= TIER1_MULT && ageMin >= 30) {
    const pnl = (bet*.30*(TIER1_MULT-1)) + (bet*.70*(mult-1));
    return { status:"CLOSED", exit:"TIER 1 ✓", mult, pnl, highMult:hi };
  }
  if (ageMin >= MAX_HOLD_MIN) {
    return { status:"CLOSED", exit:mult>=1?"TIME EXIT ▲":"TIME EXIT ▼", mult, pnl:bet*(mult-1), highMult:hi };
  }
  return { status:"OPEN", exit:null, mult, pnl:null, highMult:hi };
}

function checkCircuit() {
  const now = new Date();
  if (circuitAt && new Date(circuitAt).getDate() !== now.getDate()) {
    circuitBroken=false; circuitAt=null; dailyPnl=0;
    console.log("[CIRCUIT] Reset — new day");
  }
  if (dailyPnl <= -DAILY_LIMIT && !circuitBroken) {
    circuitBroken=true; circuitAt=now.toISOString();
    console.log(`[CIRCUIT] TRIGGERED — down $${Math.abs(dailyPnl).toFixed(2)}`);
    notify("CIRCUIT BREAKER",`Down $${Math.abs(dailyPnl).toFixed(2)} today. Trading paused until midnight.`,"urgent");
  }
}

async function updateMood() {
  try {
    const pairs = await dexSearch("solana").catch(()=>[]);
    if (!pairs.length) return;
    const s = pairs.slice(0,20);
    const avg = s.reduce((a,p)=>a+parseFloat(p.priceChange?.m5||0),0)/s.length;
    const hot = s.filter(p=>parseFloat(p.priceChange?.m5||0)>10).length;
    if (avg>5&&hot>=8)       { marketMood="hot";    dynScore=68; }
    else if (avg<-5)          { marketMood="cold";   dynScore=78; }
    else                      { marketMood="normal"; dynScore=MIN_SCORE; }
    console.log(`[MOOD] ${marketMood} avg:${avg.toFixed(1)}% hot:${hot}/20 min:${dynScore}`);
  } catch(e) { console.error("mood:",e.message); }
}

async function selfTune() {
  try {
    const r = await query(`SELECT score,pnl FROM trades WHERE status='CLOSED' ORDER BY closed_at DESC LIMIT 50`);
    const low = r.rows.filter(t=>t.score<75);
    if (low.length >= 10) {
      const wr = low.filter(t=>parseFloat(t.pnl||0)>0).length / low.length;
      if (wr<0.40 && dynScore<75)            dynScore = Math.min(dynScore+2, 80);
      else if (wr>0.60 && dynScore>MIN_SCORE) dynScore = Math.max(dynScore-1, MIN_SCORE);
    }
    tuneCount++;
    console.log(`[TUNE] #${tuneCount} minScore:${dynScore}`);
  } catch(e) { console.error("tune:",e.message); }
}

// ── WEEKLY REPORT ──────────────────────────────────────────
async function weeklyReport() {
  try {
    const r = await query(`
      SELECT pnl, exit_reason, score, bet_size
      FROM trades WHERE status='CLOSED'
      AND closed_at >= NOW() - INTERVAL '7 days'
    `);
    const trades = r.rows;
    if (!trades.length) return;
    const wins = trades.filter(t=>parseFloat(t.pnl||0)>0);
    const totalPnl = trades.reduce((a,t)=>a+parseFloat(t.pnl||0),0);
    const wr = Math.round((wins.length/trades.length)*100);
    await notify(
      "S0NAR Weekly Report",
      `7-day summary: ${trades.length} trades | ${wr}% WR | ${totalPnl>=0?"+":""}$${totalPnl.toFixed(2)} P&L | Bankroll: $${(1000+totalPnl).toFixed(0)}`,
      "default"
    );
  } catch(e) { console.error("weekly:",e.message); }
}

// ── DB HELPERS ─────────────────────────────────────────────
async function getOpen() {
  return (await query(`SELECT * FROM trades WHERE status='OPEN' ORDER BY opened_at DESC`)).rows;
}
async function hadTrade(addr) {
  return (await query(`SELECT id FROM trades WHERE pair_address=$1 LIMIT 1`,[addr])).rows.length > 0;
}
async function enterTrade(pair, sc) {
  const bet    = getBetSize(sc);
  const ageMin = pair.pairCreatedAt ? (Date.now()-pair.pairCreatedAt)/60000 : 0;
  const r = await query(`
    INSERT INTO trades
      (ticker,name,pair_address,dex_url,score,entry_price,bet_size,status,
       highest_mult,vol_5m,vol_1h,liq,pc_5m,buys_5m,sells_5m,boosted,market_mood,age_min,opened_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'OPEN',1.0,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
    RETURNING *`,
    [
      pair.baseToken?.symbol||"???", pair.baseToken?.name||"",
      pair.pairAddress, pair.url, sc, parseFloat(pair.priceUsd),
      bet, pair.volume?.m5||0, pair.volume?.h1||0,
      pair.liquidity?.usd||0, parseFloat(pair.priceChange?.m5||0),
      pair.txns?.m5?.buys||0, pair.txns?.m5?.sells||0,
      (pair.boosts?.active||0)>0, marketMood,
      parseFloat(ageMin.toFixed(1)),
    ]
  );
  return r.rows[0];
}
async function closeTrade(id, res) {
  await query(`
    UPDATE trades SET status='CLOSED',exit_mult=$1,highest_mult=$2,
    pnl=$3,exit_reason=$4,closed_at=NOW() WHERE id=$5`,
    [res.mult, res.highMult, res.pnl, res.exit, id]
  );
}
async function logSig(pair, sc, l1, l2) {
  const ageMin = pair.pairCreatedAt ? (Date.now()-pair.pairCreatedAt)/60000 : 0;
  await query(`
    INSERT INTO signals
      (ticker,pair_address,dex_url,score,price,vol_5m,liq,pc_5m,boosted,
       entered,skip_reason,market_mood,age_min,seen_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())`,
    [
      pair.baseToken?.symbol||"???", pair.pairAddress, pair.url, sc,
      parseFloat(pair.priceUsd||0), pair.volume?.m5||0,
      pair.liquidity?.usd||0, parseFloat(pair.priceChange?.m5||0),
      (pair.boosts?.active||0)>0, l1.pass&&l2.pass,
      [...l1.failed,...l2.warnings].join("; ")||null,
      marketMood, parseFloat(ageMin.toFixed(1)),
    ]
  ).catch(()=>{});
}
async function refreshDaily() {
  try {
    const today = new Date().toISOString().slice(0,10);
    const r = await query(
      `SELECT COALESCE(SUM(pnl),0) as t FROM trades WHERE status='CLOSED' AND closed_at>=$1`,
      [`${today}T00:00:00Z`]
    );
    dailyPnl = parseFloat(r.rows[0].t);
  } catch(e) { console.error("daily:",e.message); }
}

// ── MAIN POLL LOOP ─────────────────────────────────────────
async function pollSignals() {
  checkCircuit();
  if (circuitBroken) { console.log("Circuit active — skip"); return; }
  console.log(`[${new Date().toISOString()}] Poll mood:${marketMood} min:${dynScore}`);

  try {
    const q = SEARCH_QUERIES[qi % SEARCH_QUERIES.length]; qi++;

    // Run standard search + fresh launch hunt in parallel
    const [sr, br, freshPairs] = await Promise.allSettled([
      dexSearch(q),
      dexBoosted(),
      dexNewPairs(),
    ]);

    const searchPairs   = sr.status==="fulfilled" ? sr.value : [];
    const boostedTokens = br.status==="fulfilled" ? br.value : [];
    const newPairs      = freshPairs.status==="fulfilled" ? freshPairs.value : [];

    // Fetch boosted pair details
    let boostedPairs = [];
    if (boostedTokens.length) {
      const addrs = boostedTokens.map(t=>t.tokenAddress).filter(Boolean);
      boostedPairs = await dexPairs(addrs).catch(()=>[]);
    }

    // Merge and dedupe — prioritize fresh launches
    const seen = new Set(), all = [];
    // Fresh launches first (highest priority)
    for (const p of newPairs) {
      if (!p.pairAddress||seen.has(p.pairAddress)) continue;
      seen.add(p.pairAddress); all.push(p);
    }
    // Then standard + boosted
    for (const p of [...searchPairs,...boostedPairs]) {
      if (!p.pairAddress||seen.has(p.pairAddress)) continue;
      seen.add(p.pairAddress); all.push(p);
    }

    const freshCount = all.filter(p=>{
      if (!p.pairCreatedAt) return false;
      const age = (Date.now()-p.pairCreatedAt)/60000;
      return age >= MIN_AGE_MIN && age <= MAX_AGE_MIN;
    }).length;

    console.log(`  ${all.length} pairs | ${freshCount} fresh launches | "${q}"`);
    let entered=0, skipped=0;

    for (const pair of all) {
      const sc = scorePair(pair);
      const l1 = l1Gate(pair, sc);
      const l2 = l2Rug(pair);

      await logSig(pair, sc, l1, l2);

      if (!l1.pass || !l2.pass) { skipped++; continue; }
      if (await hadTrade(pair.pairAddress)) continue;

      const trade = await enterTrade(pair, sc).catch(e=>{
        console.error("insert:",e.message); return null;
      });

      if (trade) {
        entered++;
        const liq   = pair.liquidity?.usd || 0;
        const bsPct = Math.round((pair.txns?.m5?.buys||0)/
          Math.max((pair.txns?.m5?.buys||0)+(pair.txns?.m5?.sells||0),1)*100);
        const ageMin = pair.pairCreatedAt
          ? ((Date.now()-pair.pairCreatedAt)/60000).toFixed(0)
          : "?";
        const zScore = getVolZScore(pair.pairAddress, pair.volume?.m5||0);

        console.log(`  ENTERED ${pair.baseToken?.symbol} sc:${sc} bet:$${trade.bet_size} age:${ageMin}min z:${zScore.toFixed(1)}`);
        await notify(
          `ENTERED: ${pair.baseToken?.symbol}`,
          `Score:${sc} | Bet:$${trade.bet_size} | Age:${ageMin}min | Liq:$${Math.round(liq).toLocaleString()} | Buys:${bsPct}% | Z:${zScore.toFixed(1)} | ${marketMood}`,
          "high"
        );
      }
    }

    console.log(`  Entered:${entered} | Skipped:${skipped}`);

    // Self-tune check
    const cnt = parseInt((await query(`SELECT COUNT(*) FROM trades WHERE status='CLOSED'`)).rows[0].count);
    if (cnt > 0 && cnt % 50 === 0 && cnt/50 > tuneCount) await selfTune();

  } catch(e) { console.error("poll:",e.message); }
}

// ── POSITION CHECK LOOP ────────────────────────────────────
async function checkPositions() {
  console.log(`[${new Date().toISOString()}] Checking positions...`);
  try {
    const open = await getOpen();
    if (!open.length) { console.log("  No open trades"); return; }

    for (const t of open) {
      try {
        const pair = await dexPair(t.pair_address);
        if (!pair) {
          const age = (Date.now()-new Date(t.opened_at).getTime())/60000;
          if (age > 60) {
            const res = { mult:0.5, pnl:t.bet_size*-0.5, exit:"DELISTED", highMult:t.highest_mult||1 };
            await closeTrade(t.id, res);
            dailyPnl += res.pnl;
            await notify(`DELISTED: ${t.ticker}`,"Pair gone. Closed -50%.");
          }
          continue;
        }

        const cur = parseFloat(pair.priceUsd);
        const res = calcPnL(t, cur);
        const pct = ((cur/t.entry_price)-1)*100;
        console.log(`  ${t.ticker}: ${pct>=0?"+":""}${pct.toFixed(0)}% (hi:${(res.highMult).toFixed(2)}x) -> ${res.status}`);

        if (res.highMult > (t.highest_mult||1)) {
          await query(`UPDATE trades SET highest_mult=$1 WHERE id=$2`,[res.highMult,t.id]);
        }

        if (res.status==="CLOSED") {
          await closeTrade(t.id, res);
          dailyPnl += res.pnl;
          checkCircuit();
          const ps = res.pnl>=0 ? `+$${res.pnl.toFixed(2)}` : `-$${Math.abs(res.pnl).toFixed(2)}`;
          console.log(`  CLOSED ${t.ticker} ${res.exit} ${ps}`);
          await notify(
            `${res.pnl>=0?"WIN":"LOSS"} ${t.ticker}: ${res.exit}`,
            `${ps} | ${res.mult.toFixed(2)}x | $${t.bet_size} bet | Score:${t.score} | Age:${t.age_min}min | Today:${dailyPnl>=0?"+":""}$${dailyPnl.toFixed(2)}`,
            res.pnl>=0?"high":"default"
          );
        }
      } catch(e) { console.error(`  ${t.ticker}:`,e.message); }
      await new Promise(r=>setTimeout(r,2000));
    }
  } catch(e) { console.error("check:",e.message); }
}

// ── API ────────────────────────────────────────────────────
app.get("/health",(req,res)=>res.json({
  status:"ok", ts:new Date().toISOString(), version:"4.0-print-money",
  marketMood, dynamicMinScore:dynScore, circuitBroken,
  dailyPnl:parseFloat(dailyPnl.toFixed(2)), selfTuneCount:tuneCount,
}));

app.get("/test-ntfy",async(req,res)=>{
  await notify("S0NAR Test","ntfy is working! S0NAR Iron Dome v4 is live.","high");
  res.json({sent:true,topic:NTFY_TOPIC||"not set"});
});

app.get("/api/signals",async(req,res)=>{
  try {
    res.json((await query(`SELECT * FROM signals ORDER BY seen_at DESC LIMIT 100`)).rows);
  } catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/trades",async(req,res)=>{
  try {
    res.json((await query(`SELECT * FROM trades ORDER BY opened_at DESC LIMIT 200`)).rows);
  } catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/stats",async(req,res)=>{
  try {
    const all  = (await query(`SELECT * FROM trades`)).rows;
    const closed = all.filter(t=>t.status==="CLOSED");
    const open   = all.filter(t=>t.status==="OPEN");
    const wins   = closed.filter(t=>parseFloat(t.pnl||0)>0);
    const losses = closed.filter(t=>parseFloat(t.pnl||0)<=0);
    const tp  = closed.reduce((a,t)=>a+parseFloat(t.pnl||0),0);
    const wr  = closed.length ? (wins.length/closed.length)*100 : 0;
    const aw  = wins.length   ? wins.reduce((a,t)=>a+parseFloat(t.pnl||0),0)/wins.length   : 0;
    const al  = losses.length ? losses.reduce((a,t)=>a+parseFloat(t.pnl||0),0)/losses.length : 0;
    const best = closed.length ? closed.reduce((a,b)=>parseFloat(a.pnl||0)>parseFloat(b.pnl||0)?a:b,closed[0]) : null;
    const pf   = losses.length&&Math.abs(al)>0 ? Math.abs(aw*wins.length)/Math.abs(al*losses.length) : null;

    const bkts = {"70-74":[],"75-79":[],"80-84":[],"85+":[]};
    closed.forEach(t=>{
      const k=t.score>=85?"85+":t.score>=80?"80-84":t.score>=75?"75-79":"70-74";
      bkts[k].push(parseFloat(t.pnl||0));
    });
    const bs={};
    for (const[k,p]of Object.entries(bkts)){
      const w=p.filter(x=>x>0).length;
      bs[k]={trades:p.length,winRate:p.length?Math.round((w/p.length)*100):null,
        avgPnl:p.length?parseFloat((p.reduce((a,b)=>a+b,0)/p.length).toFixed(2)):null,
        totalPnl:parseFloat(p.reduce((a,b)=>a+b,0).toFixed(2))};
    }

    const ord = [...closed].sort((a,b)=>new Date(a.closed_at)-new Date(b.closed_at));
    let run=1000;
    const eq=[1000,...ord.map(t=>{run+=parseFloat(t.pnl||0);return parseFloat(run.toFixed(2));})];

    const daily={};
    closed.forEach(t=>{
      if(!t.closed_at)return;
      const d=new Date(t.closed_at).toISOString().slice(0,10);
      daily[d]=parseFloat(((daily[d]||0)+parseFloat(t.pnl||0)).toFixed(2));
    });

    const exits={};
    closed.forEach(t=>{exits[t.exit_reason||"unknown"]=(exits[t.exit_reason||"unknown"]||0)+1;});

    // Age performance
    const ageBkts={"0-15min":[],"15-30min":[],"30-60min":[],"60min+":[]};
    closed.forEach(t=>{
      const age=parseFloat(t.age_min||0);
      const k=age<15?"0-15min":age<30?"15-30min":age<60?"30-60min":"60min+";
      ageBkts[k].push(parseFloat(t.pnl||0));
    });
    const ageSt={};
    for(const[k,p]of Object.entries(ageBkts)){
      const w=p.filter(x=>x>0).length;
      ageSt[k]={trades:p.length,winRate:p.length?Math.round((w/p.length)*100):null,
        avgPnl:p.length?parseFloat((p.reduce((a,b)=>a+b,0)/p.length).toFixed(2)):null};
    }

    res.json({
      bankroll:parseFloat((1000+tp).toFixed(2)),totalPnl:parseFloat(tp.toFixed(2)),
      winRate:parseFloat(wr.toFixed(1)),avgWin:parseFloat(aw.toFixed(2)),
      avgLoss:parseFloat(al.toFixed(2)),profitFactor:pf?parseFloat(pf.toFixed(2)):null,
      totalTrades:closed.length,openTrades:open.length,
      best:best?{ticker:best.ticker,pnl:parseFloat(best.pnl||0),mult:best.exit_mult}:null,
      buckets:bs,equity:eq,daily,exits,agePerformance:ageSt,
      ironDome:{marketMood,dynamicMinScore:dynScore,circuitBroken,
        dailyPnl:parseFloat(dailyPnl.toFixed(2)),selfTuneCount:tuneCount},
    });
  } catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/backtest",async(req,res)=>{
  console.log("[BACKTEST] Starting...");
  const results=[];
  const queries=["pump.fun","solana meme","pepe sol","dog sol","cat sol","based sol","ai sol","bonk sol"];
  try {
    const allPairs=[];
    for(const q of queries){
      try{
        const r=await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,{timeout:10000});
        if(!r.ok)continue;
        const d=await r.json();
        allPairs.push(...(d?.pairs||[]).filter(p=>p.chainId==="solana"&&parseFloat(p.priceUsd||0)>0&&(p.liquidity?.usd||0)>1000&&(p.volume?.h24||0)>1000));
        await new Promise(r=>setTimeout(r,400));
      }catch(e){continue;}
    }
    try{
      const br=await fetch("https://api.dexscreener.com/token-boosts/latest/v1",{timeout:10000});
      if(br.ok){
        const bd=await br.json();
        const ba=(bd||[]).filter(t=>t.chainId==="solana").slice(0,15).map(t=>t.tokenAddress).filter(Boolean);
        if(ba.length){
          const pr=await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${ba.slice(0,10).join(",")}`,{timeout:10000});
          if(pr.ok){const pd=await pr.json();allPairs.push(...(pd?.pairs||[]).filter(p=>parseFloat(p.priceUsd||0)>0));}
        }
      }
    }catch(e){}

    const seen=new Set(),pairs=[];
    for(const p of allPairs){if(!p.pairAddress||seen.has(p.pairAddress))continue;seen.add(p.pairAddress);pairs.push(p);}
    console.log(`[BACKTEST] ${pairs.length} pairs`);

    for(const p of pairs){
      const sc=scorePair(p);
      const liq=p.liquidity?.usd||0,v5=p.volume?.m5||0,v1=p.volume?.h1||0;
      const pc5m=parseFloat(p.priceChange?.m5||0),pc1h=parseFloat(p.priceChange?.h1||0);
      const pc24h=parseFloat(p.priceChange?.h24||0);
      const buys=p.txns?.m5?.buys||0,sells=p.txns?.m5?.sells||0;
      const bsPct=buys+sells>0?Math.round((buys/(buys+sells))*100):50;
      const boosted=(p.boosts?.active||0)>0;
      const ageMin=p.pairCreatedAt?(Date.now()-p.pairCreatedAt)/60000:999;
      if(sc<60||liq<1000)continue;
      const betSize=getBetSize(sc);
      let mult,exit,pnl;
      if(pc1h<=-30){mult=0.70;exit="STOP LOSS";pnl=betSize*-0.30;}
      else if(pc1h<=-20&&v5<v1/6){mult=0.80;exit="EARLY STOP";pnl=betSize*-0.20;}
      else if(pc1h>=400){mult=5.0;exit="TIER 2";pnl=(betSize*.30*(2-1))+(betSize*.40*(5-1))+(betSize*.30*(5-1));}
      else if(pc1h>=100){mult=2.0;exit="TIER 1";pnl=(betSize*.30*(2-1))+(betSize*.70*((1+pc1h/100)-1));}
      else if(pc1h>=0){mult=1+pc1h/100;exit="TIME EXIT +";pnl=betSize*(pc1h/100);}
      else{mult=1+pc1h/100;exit=pc1h<=-30?"STOP LOSS":"TIME EXIT -";pnl=betSize*(pc1h/100);if(pc1h<=-30){mult=0.70;pnl=betSize*-0.30;}}
      const wouldEnter=sc>=dynScore&&liq>=MIN_LIQ&&v5>=MIN_VOL_5M&&bsPct>=MIN_BUY_PCT&&pc5m>-20&&ageMin<=MAX_AGE_MIN;
      results.push({ticker:p.baseToken?.symbol||"???",pairAddr:p.pairAddress,dexUrl:p.url,
        score:sc,betSize,liq:Math.round(liq),vol5m:Math.round(v5),vol1h:Math.round(v1),
        pc5m:parseFloat(pc5m.toFixed(1)),pc1h:parseFloat(pc1h.toFixed(1)),pc24h:parseFloat(pc24h.toFixed(1)),
        bsPct,boosted,ageMin:parseFloat(ageMin.toFixed(0)),
        mult:parseFloat(mult.toFixed(2)),pnl:parseFloat(pnl.toFixed(2)),exit,wouldEnter});
    }
    results.sort((a,b)=>b.score-a.score);
    const qual=results.filter(r=>r.wouldEnter);
    const qw=qual.filter(r=>r.pnl>0),ql=qual.filter(r=>r.pnl<=0);
    const qtp=qual.reduce((a,r)=>a+r.pnl,0);
    const qwr=qual.length?(qw.length/qual.length)*100:0;
    const qaw=qw.length?qw.reduce((a,r)=>a+r.pnl,0)/qw.length:0;
    const qal=ql.length?ql.reduce((a,r)=>a+r.pnl,0)/ql.length:0;
    const bkts2={"70-74":[],"75-79":[],"80-84":[],"85+":[]};
    qual.forEach(r=>{const k=r.score>=85?"85+":r.score>=80?"80-84":r.score>=75?"75-79":"70-74";bkts2[k].push(r.pnl);});
    const bs2={};
    for(const[k,p]of Object.entries(bkts2)){const w=p.filter(x=>x>0).length;bs2[k]={trades:p.length,winRate:p.length?Math.round((w/p.length)*100):null,avgPnl:p.length?parseFloat((p.reduce((a,b)=>a+b,0)/p.length).toFixed(2)):null,totalPnl:parseFloat(p.reduce((a,b)=>a+b,0).toFixed(2))};}
    console.log(`[BACKTEST] Done. ${qual.length} qualifying. WR:${qwr.toFixed(0)}%`);
    res.json({scanned:results.length,qualifying:qual.length,winRate:parseFloat(qwr.toFixed(1)),
      totalPnl:parseFloat(qtp.toFixed(2)),avgWin:parseFloat(qaw.toFixed(2)),avgLoss:parseFloat(qal.toFixed(2)),
      buckets:bs2,trades:results,
      disclaimer:"Real DexScreener data. 1h price change = outcome proxy. Apply 20% haircut for live estimate.",
      ts:new Date().toISOString()});
  }catch(e){console.error("[BACKTEST]",e.message);res.status(500).json({error:e.message});}
});

// ── START ──────────────────────────────────────────────────
app.listen(PORT,async()=>{
  console.log(`
+==========================================+
|   S0NAR  IRON DOME v4.0                  |
|   PRINT MONEY EDITION                    |
+==========================================+
Port:  ${PORT}
DB:    ${process.env.DATABASE_URL?"connected":"MISSING DATABASE_URL"}
ntfy:  ${NTFY_TOPIC?NTFY_TOPIC:"not set"}

NEW in v4:
  + Fresh launch hunter (5-120min tokens)
  + Volume Z-score spike detection
  + Age bonus scoring (sweet spot 5-30min)
  + Momentum confirmation (1h price check)
  + Weekly performance report
  + Age performance analytics
  `);

  await initDB();
  await refreshDaily();
  await updateMood();

  pollSignals();
  setInterval(pollSignals,  FETCH_MS);
  setInterval(checkPositions, CHECK_MS);
  setInterval(updateMood,   MOOD_MS);
  setInterval(refreshDaily, 300000);

  // Weekly report every Sunday at 9am
  setInterval(()=>{
    const now=new Date();
    if(now.getDay()===0&&now.getHours()===9&&now.getMinutes()<1) weeklyReport();
  }, 60000);
});
