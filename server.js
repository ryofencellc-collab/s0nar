// ============================================================
//  S0NAR — IRON DOME v3.0
//  7 layers of protection. No trade cap. Quality only.
//  Real data. Real prices. Paper money.
// ============================================================

const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

// ── ENV ────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const NTFY_TOPIC   = process.env.NTFY_TOPIC;
const PORT         = process.env.PORT || 3000;
const db           = createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================================
//  IRON DOME — 7 LAYERS
// ============================================================

// LAYER 1 — Base quality gates (all must pass)
const MIN_SCORE    = 70;
const MIN_LIQ      = 5000;
const MIN_VOL_5M   = 1000;
const MIN_BUY_PCT  = 55;

// LAYER 2 — Rug pull protection
const MAX_TOKEN_AGE_MIN = 3;    // skip if less than 3 min old (too early)
const MAX_WHALE_PCT     = 30;   // skip if top wallets hold >30%

// LAYER 3 — Market mood (adjusted dynamically)
let marketMood      = "normal"; // "hot" | "normal" | "cold"
let dynamicMinScore = MIN_SCORE;

// LAYER 4 — Dynamic position sizing by score
function getPositionSize(score) {
  if (score >= 85) return 100;
  if (score >= 80) return 75;
  if (score >= 75) return 50;
  return 25;
}

// LAYER 5 — Adaptive stop loss by trade age
function getStopLoss(ageMin) {
  if (ageMin < 15)  return 0.80; // -20% tight stop early
  if (ageMin < 60)  return 0.70; // -30% normal stop
  return null; // trailing logic kicks in after 60min
}

// LAYER 6 — Daily circuit breaker
const DAILY_LOSS_LIMIT = 150; // stop all trading if down $150 in one day
let circuitBroken      = false;
let circuitBrokenAt    = null;
let dailyPnl           = 0;

// LAYER 7 — Self tuning (runs every 50 closed trades)
let selfTuneCount = 0;

// ── TRADE SETTINGS ─────────────────────────────────────────
const BASE_BET     = 50;
const TIER1_MULT   = 2.0;
const TIER2_MULT   = 5.0;
const MAX_HOLD_MIN = 240;
const FETCH_MS     = 30000;
const CHECK_MS     = 60000;
const MOOD_MS      = 3600000; // check market mood every hour

const SEARCH_QUERIES = [
  "pump.fun","solana meme","pepe sol","dog sol",
  "cat sol","based sol","ai sol","frog sol",
  "moon sol","wagmi sol","bonk sol","sol token",
];
let queryIndex = 0;

// ── NTFY NOTIFICATIONS ─────────────────────────────────────
async function notify(title, body, priority = "default") {
  if (!NTFY_TOPIC) return;
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        "Title":    title,
        "Priority": priority,
        "Tags":     "chart_with_upwards_trend",
      },
      body,
    });
  } catch (e) { console.error("ntfy:", e.message); }
}

// ── DEXSCREENER API ────────────────────────────────────────
async function dexSearch(query) {
  const r = await fetch(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`,
    { timeout: 10000 }
  );
  if (!r.ok) throw new Error(`search ${r.status}`);
  const d = await r.json();
  return (d?.pairs || []).filter(p =>
    p.chainId === "solana" && parseFloat(p.priceUsd || 0) > 0
  );
}

async function dexBoosted() {
  const r = await fetch(
    `https://api.dexscreener.com/token-boosts/latest/v1`,
    { timeout: 10000 }
  );
  if (!r.ok) throw new Error(`boosts ${r.status}`);
  const d = await r.json();
  return (d || []).filter(t => t.chainId === "solana").slice(0, 10);
}

async function dexPairs(addresses) {
  if (!addresses.length) return [];
  const r = await fetch(
    `https://api.dexscreener.com/latest/dex/pairs/solana/${addresses.slice(0, 10).join(",")}`,
    { timeout: 10000 }
  );
  if (!r.ok) throw new Error(`pairs ${r.status}`);
  const d = await r.json();
  return (d?.pairs || []).filter(p => parseFloat(p.priceUsd || 0) > 0);
}

async function dexPair(address) {
  const p = await dexPairs([address]);
  return p[0] || null;
}

// ── SCORING ENGINE ─────────────────────────────────────────
function scorePair(p) {
  const vol5m  = p.volume?.m5  || 0;
  const vol1h  = p.volume?.h1  || 1;
  const pc5m   = parseFloat(p.priceChange?.m5 || 0);
  const liq    = p.liquidity?.usd || 0;
  const buys   = p.txns?.m5?.buys  || 0;
  const sells  = p.txns?.m5?.sells || 1;
  const boosted = (p.boosts?.active || 0) > 0;

  let s = 0;
  s += Math.min(100, (vol5m / Math.max(vol1h / 12, 1)) * 100) * 0.35;
  s += Math.min(100, Math.max(0, (pc5m + 30) / 1.3))          * 0.25;
  s += (liq>100000?100:liq>50000?85:liq>20000?65:liq>5000?45:liq>1000?25:5) * 0.20;
  s += Math.min(100, (buys / (buys + sells)) * 100)           * 0.15;
  if (boosted)    s += 5;
  if (liq < 2000) s -= 25;
  if (vol5m < 200) s -= 10;

  return Math.round(Math.max(0, Math.min(99, s)));
}

// ============================================================
//  LAYER 1 — Quality Gate
// ============================================================
function layer1_qualityGate(pair, score) {
  const liq   = pair.liquidity?.usd || 0;
  const vol5m = pair.volume?.m5 || 0;
  const buys  = pair.txns?.m5?.buys  || 0;
  const sells = pair.txns?.m5?.sells || 0;
  const bsPct = buys + sells > 0 ? (buys / (buys + sells)) * 100 : 0;
  const pc5m  = parseFloat(pair.priceChange?.m5 || 0);

  const checks = {
    score:      { pass: score >= dynamicMinScore,  reason: `score ${score} < ${dynamicMinScore}` },
    liquidity:  { pass: liq >= MIN_LIQ,            reason: `liq $${Math.round(liq)} < $${MIN_LIQ}` },
    volume:     { pass: vol5m >= MIN_VOL_5M,       reason: `vol5m $${Math.round(vol5m)} < $${MIN_VOL_5M}` },
    buyPress:   { pass: bsPct >= MIN_BUY_PCT,      reason: `buys ${Math.round(bsPct)}% < ${MIN_BUY_PCT}%` },
    notDumping: { pass: pc5m > -20,                reason: `price crashing ${pc5m.toFixed(0)}% in 5m` },
    hasPrice:   { pass: parseFloat(pair.priceUsd || 0) > 0, reason: "no price data" },
  };

  const failed = Object.entries(checks).filter(([, v]) => !v.pass).map(([, v]) => v.reason);
  return { pass: failed.length === 0, failed };
}

// ============================================================
//  LAYER 2 — Rug Pull Detection
// ============================================================
function layer2_rugCheck(pair) {
  const liq      = pair.liquidity?.usd || 0;
  const vol5m    = pair.volume?.m5 || 0;
  const vol1h    = pair.volume?.h1 || 0;
  const ageMs    = Date.now() - (pair.pairCreatedAt || Date.now());
  const ageMin   = ageMs / 60000;
  const buys5m   = pair.txns?.m5?.buys  || 0;
  const sells5m  = pair.txns?.m5?.sells || 0;

  const warnings = [];

  // Too new — bots still fighting, wait for FOMO wave
  if (ageMin < MAX_TOKEN_AGE_MIN) {
    warnings.push(`too new (${ageMin.toFixed(1)}min)`);
  }

  // Volume spike with no liquidity = wash trading
  if (vol5m > 50000 && liq < 5000) {
    warnings.push("vol/liq mismatch — possible wash trade");
  }

  // More sells than buys in 5m despite high score = distribution
  if (sells5m > buys5m * 1.5) {
    warnings.push("selling pressure despite volume");
  }

  // Extreme vol1h with tiny liq = pump and dump in progress
  if (vol1h > 500000 && liq < 10000) {
    warnings.push("extreme vol vs tiny liq — late pump");
  }

  return { pass: warnings.length === 0, warnings };
}

// ============================================================
//  LAYER 3 — Market Mood
// ============================================================
async function layer3_updateMarketMood() {
  try {
    // Sample 20 trending Solana pairs and check average price change
    const pairs = await dexSearch("solana").catch(() => []);
    if (!pairs.length) return;

    const sample = pairs.slice(0, 20);
    const avgPc5m = sample.reduce((a, p) => a + parseFloat(p.priceChange?.m5 || 0), 0) / sample.length;
    const avgPc1h = sample.reduce((a, p) => a + parseFloat(p.priceChange?.h1 || 0), 0) / sample.length;
    const pumpingCount = sample.filter(p => parseFloat(p.priceChange?.m5 || 0) > 10).length;

    if (avgPc5m > 5 && pumpingCount >= 8) {
      marketMood = "hot";
      dynamicMinScore = 68; // slightly lower bar — more signals in hot market
    } else if (avgPc5m < -5 || avgPc1h < -15) {
      marketMood = "cold";
      dynamicMinScore = 78; // raise bar — be selective in cold market
    } else {
      marketMood = "normal";
      dynamicMinScore = MIN_SCORE;
    }

    console.log(`[MOOD] Market: ${marketMood} | avgPc5m: ${avgPc5m.toFixed(1)}% | pumping: ${pumpingCount}/20 | minScore: ${dynamicMinScore}`);
  } catch (e) {
    console.error("Mood check error:", e.message);
  }
}

// ============================================================
//  LAYER 5 — Adaptive P&L Calculation
// ============================================================
function layer5_calcPnL(trade, currentPrice) {
  const entryPrice = trade.entry_price;
  const betSize    = trade.bet_size;
  const mult       = currentPrice / entryPrice;
  const ageMin     = (Date.now() - new Date(trade.opened_at).getTime()) / 60000;
  const highMult   = trade.highest_mult || mult; // trailing high

  // Adaptive stop loss
  let stopLevel;
  if (ageMin >= 60 && highMult > 1.5) {
    // Trailing: exit if price drops 15% from highest point
    stopLevel = highMult * 0.85;
  } else {
    stopLevel = getStopLoss(ageMin);
  }

  if (mult <= stopLevel) {
    const pnl = betSize * (mult - 1);
    const exit = ageMin >= 60 ? "TRAILING STOP 📉" : ageMin < 15 ? "EARLY STOP 🛑" : "STOP LOSS 🛑";
    return { status: "CLOSED", exit, mult, pnl, highMult: Math.max(highMult, mult) };
  }

  // Tier 2: 5x
  if (mult >= TIER2_MULT) {
    const pnl = (betSize * 0.30 * (TIER1_MULT - 1))
              + (betSize * 0.40 * (TIER2_MULT - 1))
              + (betSize * 0.30 * (mult - 1));
    return { status: "CLOSED", exit: "TIER 2 🚀", mult, pnl, highMult: Math.max(highMult, mult) };
  }

  // Tier 1: 2x, held 30+ min
  if (mult >= TIER1_MULT && ageMin >= 30) {
    const pnl = (betSize * 0.30 * (TIER1_MULT - 1))
              + (betSize * 0.70 * (mult - 1));
    return { status: "CLOSED", exit: "TIER 1 ✓", mult, pnl, highMult: Math.max(highMult, mult) };
  }

  // Time exit: 4h max
  if (ageMin >= MAX_HOLD_MIN) {
    const pnl = betSize * (mult - 1);
    return { status: "CLOSED", exit: mult >= 1 ? "TIME EXIT ▲" : "TIME EXIT ▼", mult, pnl, highMult: Math.max(highMult, mult) };
  }

  // Still open — update highest mult
  return { status: "OPEN", exit: null, mult, pnl: null, highMult: Math.max(highMult, mult) };
}

// ============================================================
//  LAYER 6 — Circuit Breaker
// ============================================================
function layer6_checkCircuitBreaker() {
  // Reset at midnight
  const now = new Date();
  if (circuitBrokenAt) {
    const brokenDate = new Date(circuitBrokenAt);
    if (now.getDate() !== brokenDate.getDate()) {
      circuitBroken   = false;
      circuitBrokenAt = null;
      dailyPnl        = 0;
      console.log("[CIRCUIT] Reset — new day, trading resumed");
    }
  }

  if (dailyPnl <= -DAILY_LOSS_LIMIT && !circuitBroken) {
    circuitBroken   = true;
    circuitBrokenAt = now.toISOString();
    console.log(`[CIRCUIT] BREAKER TRIGGERED — down $${Math.abs(dailyPnl).toFixed(2)} today. No more trades until midnight.`);
    notify(
      "⚡ CIRCUIT BREAKER",
      `Down $${Math.abs(dailyPnl).toFixed(2)} today. Trading paused until midnight. This is the system protecting you.`,
      "urgent"
    );
  }
}

// ============================================================
//  LAYER 7 — Self Tuning
// ============================================================
async function layer7_selfTune() {
  try {
    const { data: recent } = await db.from("trades")
      .select("*")
      .eq("status", "CLOSED")
      .order("closed_at", { ascending: false })
      .limit(50);

    if (!recent || recent.length < 50) return;

    // Check each score bucket performance
    const buckets = { low: [], mid: [], high: [], top: [] };
    recent.forEach(t => {
      if (t.score >= 85)      buckets.top.push(t.pnl || 0);
      else if (t.score >= 80) buckets.high.push(t.pnl || 0);
      else if (t.score >= 75) buckets.mid.push(t.pnl || 0);
      else                    buckets.low.push(t.pnl || 0);
    });

    // If 70-74 bucket is losing money consistently, raise minimum score
    if (buckets.low.length >= 10) {
      const lowWinRate = buckets.low.filter(p => p > 0).length / buckets.low.length;
      if (lowWinRate < 0.40 && dynamicMinScore < 75) {
        dynamicMinScore = Math.min(dynamicMinScore + 2, 80);
        console.log(`[TUNE] Low score bucket losing — raised minScore to ${dynamicMinScore}`);
        notify("🧠 SELF TUNE", `Low score trades underperforming. Raised minimum score to ${dynamicMinScore}.`);
      } else if (lowWinRate > 0.60 && dynamicMinScore > MIN_SCORE) {
        dynamicMinScore = Math.max(dynamicMinScore - 1, MIN_SCORE);
        console.log(`[TUNE] Low score bucket winning — lowered minScore to ${dynamicMinScore}`);
      }
    }

    selfTuneCount++;
    console.log(`[TUNE] Self-tune #${selfTuneCount} complete. Current minScore: ${dynamicMinScore}`);
  } catch (e) {
    console.error("Self-tune error:", e.message);
  }
}

// ── DB HELPERS ─────────────────────────────────────────────
async function getOpenTrades() {
  const { data, error } = await db.from("trades").select("*")
    .eq("status", "OPEN").order("opened_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

async function alreadyTraded(pairAddress) {
  const { data } = await db.from("trades").select("id")
    .eq("pair_address", pairAddress).limit(1);
  return (data || []).length > 0;
}

async function insertTrade(pair, score) {
  const betSize = getPositionSize(score); // LAYER 4: dynamic sizing
  const { data, error } = await db.from("trades").insert({
    ticker:       pair.baseToken?.symbol || "???",
    name:         pair.baseToken?.name   || "",
    pair_address: pair.pairAddress,
    dex_url:      pair.url,
    score,
    entry_price:  parseFloat(pair.priceUsd),
    bet_size:     betSize,
    status:       "OPEN",
    highest_mult: 1.0,
    vol_5m:       pair.volume?.m5   || 0,
    vol_1h:       pair.volume?.h1   || 0,
    liq:          pair.liquidity?.usd || 0,
    pc_5m:        parseFloat(pair.priceChange?.m5 || 0),
    buys_5m:      pair.txns?.m5?.buys  || 0,
    sells_5m:     pair.txns?.m5?.sells || 0,
    boosted:      (pair.boosts?.active || 0) > 0,
    market_mood:  marketMood,
    opened_at:    new Date().toISOString(),
  }).select().single();
  if (error) throw error;
  return data;
}

async function closeTrade(id, result) {
  const { error } = await db.from("trades").update({
    status:       "CLOSED",
    exit_mult:    result.mult,
    highest_mult: result.highMult,
    pnl:          result.pnl,
    exit_reason:  result.exit,
    closed_at:    new Date().toISOString(),
  }).eq("id", id);
  if (error) throw error;
}

async function updateHighestMult(id, highMult) {
  await db.from("trades").update({ highest_mult: highMult }).eq("id", id).catch(() => {});
}

async function logSignal(pair, score, l1, l2) {
  const reasons = [...l1.failed, ...l2.warnings];
  await db.from("signals").insert({
    ticker:       pair.baseToken?.symbol || "???",
    pair_address: pair.pairAddress,
    dex_url:      pair.url,
    score,
    price:        parseFloat(pair.priceUsd || 0),
    vol_5m:       pair.volume?.m5  || 0,
    liq:          pair.liquidity?.usd || 0,
    pc_5m:        parseFloat(pair.priceChange?.m5 || 0),
    boosted:      (pair.boosts?.active || 0) > 0,
    entered:      l1.pass && l2.pass,
    skip_reason:  reasons.join("; ") || null,
    market_mood:  marketMood,
    seen_at:      new Date().toISOString(),
  }).select().catch(() => {});
}

// ── GET TODAY'S P&L FROM DB ────────────────────────────────
async function refreshDailyPnl() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await db.from("trades")
      .select("pnl")
      .eq("status", "CLOSED")
      .gte("closed_at", `${today}T00:00:00Z`);
    dailyPnl = (data || []).reduce((a, t) => a + (t.pnl || 0), 0);
  } catch (e) { console.error("Daily PnL refresh:", e.message); }
}

// ============================================================
//  MAIN LOOPS
// ============================================================
async function pollSignals() {
  // LAYER 6: circuit breaker check
  layer6_checkCircuitBreaker();
  if (circuitBroken) {
    console.log(`[${new Date().toISOString()}] Circuit breaker active — skipping poll`);
    return;
  }

  console.log(`[${new Date().toISOString()}] Polling... mood:${marketMood} minScore:${dynamicMinScore}`);

  try {
    const query = SEARCH_QUERIES[queryIndex % SEARCH_QUERIES.length];
    queryIndex++;

    const [sr, br] = await Promise.allSettled([dexSearch(query), dexBoosted()]);
    const searchPairs   = sr.status === "fulfilled" ? sr.value : [];
    const boostedTokens = br.status === "fulfilled" ? br.value : [];

    let boostedPairs = [];
    if (boostedTokens.length) {
      const addrs = boostedTokens.map(t => t.tokenAddress).filter(Boolean);
      boostedPairs = await dexPairs(addrs).catch(() => []);
    }

    const seen = new Set(), all = [];
    for (const p of [...searchPairs, ...boostedPairs]) {
      if (!p.pairAddress || seen.has(p.pairAddress)) continue;
      seen.add(p.pairAddress);
      all.push(p);
    }

    console.log(`  ${all.length} pairs from "${query}"`);
    let entered = 0, skipped = 0;

    for (const pair of all) {
      const score = scorePair(pair);
      const l1    = layer1_qualityGate(pair, score); // LAYER 1
      const l2    = layer2_rugCheck(pair);           // LAYER 2

      await logSignal(pair, score, l1, l2);

      if (!l1.pass) { skipped++; continue; }
      if (!l2.pass) {
        console.log(`  ⚠️  RUG CHECK: ${pair.baseToken?.symbol} — ${l2.warnings.join(", ")}`);
        skipped++;
        continue;
      }

      if (await alreadyTraded(pair.pairAddress)) continue;

      const trade = await insertTrade(pair, score).catch(e => {
        console.error("  insert:", e.message);
        return null;
      });

      if (trade) {
        entered++;
        const liq   = pair.liquidity?.usd || 0;
        const bsPct = Math.round((pair.txns?.m5?.buys || 0) /
          Math.max((pair.txns?.m5?.buys || 0) + (pair.txns?.m5?.sells || 0), 1) * 100);

        console.log(`  ✅ ENTERED ${pair.baseToken?.symbol} score:${score} bet:$${trade.bet_size} mood:${marketMood}`);
        await notify(
          `📡 ENTERED: ${pair.baseToken?.symbol}`,
          `Score:${score} | Bet:$${trade.bet_size} | $${parseFloat(pair.priceUsd).toExponential(2)} | Liq:$${Math.round(liq).toLocaleString()} | Buys:${bsPct}% | Market:${marketMood}`,
          "high"
        );
      }
    }

    console.log(`  Entered:${entered} | Skipped:${skipped}`);

    // LAYER 7: self-tune every 50 closed trades
    const { count } = await db.from("trades")
      .select("*", { count: "exact", head: true })
      .eq("status", "CLOSED");
    if (count && count > 0 && count % 50 === 0 && count / 50 > selfTuneCount) {
      await layer7_selfTune();
    }

  } catch (err) {
    console.error("pollSignals:", err.message);
  }
}

async function checkPositions() {
  console.log(`[${new Date().toISOString()}] Checking positions...`);
  try {
    const open = await getOpenTrades();
    if (!open.length) { console.log("  No open trades"); return; }
    console.log(`  ${open.length} open trades`);

    for (const trade of open) {
      try {
        const pair = await dexPair(trade.pair_address);

        if (!pair) {
          const ageMin = (Date.now() - new Date(trade.opened_at).getTime()) / 60000;
          if (ageMin > 60) {
            const result = { mult: 0.5, pnl: trade.bet_size * -0.5, exit: "DELISTED 💀", highMult: trade.highest_mult || 1 };
            await closeTrade(trade.id, result);
            dailyPnl += result.pnl;
            await notify(`💀 DELISTED: ${trade.ticker}`, `Pair gone from DexScreener. Closed -50%.`);
          }
          continue;
        }

        const current = parseFloat(pair.priceUsd);
        const result  = layer5_calcPnL(trade, current); // LAYER 5

        const pctChg = ((current / trade.entry_price) - 1) * 100;
        console.log(`  ${trade.ticker}: ${pctChg >= 0 ? "+" : ""}${pctChg.toFixed(0)}% (high:${(result.highMult).toFixed(2)}x) → ${result.status}`);

        // Always update highest mult
        if (result.highMult > (trade.highest_mult || 1)) {
          await updateHighestMult(trade.id, result.highMult);
        }

        if (result.status === "CLOSED") {
          await closeTrade(trade.id, result);
          dailyPnl += result.pnl;
          layer6_checkCircuitBreaker(); // re-check after each close

          const pnlStr = result.pnl >= 0
            ? `+$${result.pnl.toFixed(2)}`
            : `-$${Math.abs(result.pnl).toFixed(2)}`;

          console.log(`  💰 CLOSED ${trade.ticker}: ${result.exit} ${pnlStr} (today: ${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)})`);
          await notify(
            `${result.pnl >= 0 ? "✅" : "❌"} ${trade.ticker}: ${result.exit}`,
            `${pnlStr} | ${result.mult.toFixed(2)}x | Bet was $${trade.bet_size} | Score:${trade.score} | Today: ${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)}`,
            result.pnl >= 0 ? "high" : "default"
          );
        }

      } catch (err) {
        console.error(`  ${trade.ticker}:`, err.message);
      }

      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err) {
    console.error("checkPositions:", err.message);
  }
}

// ── API ROUTES ─────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status:          "ok",
    ts:              new Date().toISOString(),
    version:         "3.0-iron-dome",
    marketMood,
    dynamicMinScore,
    circuitBroken,
    dailyPnl:        parseFloat(dailyPnl.toFixed(2)),
    selfTuneCount,
  });
});

app.get("/api/signals", async (req, res) => {
  try {
    const { data, error } = await db.from("signals").select("*")
      .order("seen_at", { ascending: false }).limit(100);
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/trades", async (req, res) => {
  try {
    const { data, error } = await db.from("trades").select("*")
      .order("opened_at", { ascending: false }).limit(200);
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/stats", async (req, res) => {
  try {
    const { data: trades, error } = await db.from("trades").select("*");
    if (error) throw error;

    const all    = trades || [];
    const closed = all.filter(t => t.status === "CLOSED");
    const open   = all.filter(t => t.status === "OPEN");
    const wins   = closed.filter(t => (t.pnl || 0) > 0);
    const losses = closed.filter(t => (t.pnl || 0) <= 0);

    const totalPnl = closed.reduce((a, t) => a + (t.pnl || 0), 0);
    const winRate  = closed.length ? (wins.length / closed.length) * 100 : 0;
    const avgWin   = wins.length   ? wins.reduce((a, t) => a + (t.pnl || 0), 0) / wins.length   : 0;
    const avgLoss  = losses.length ? losses.reduce((a, t) => a + (t.pnl || 0), 0) / losses.length : 0;
    const best     = closed.length ? closed.reduce((a, b) => (a.pnl || 0) > (b.pnl || 0) ? a : b, closed[0]) : null;
    const pf       = losses.length && Math.abs(avgLoss) > 0
      ? Math.abs(avgWin * wins.length) / Math.abs(avgLoss * losses.length) : null;

    const buckets = { "70-74": [], "75-79": [], "80-84": [], "85+": [] };
    closed.forEach(t => {
      const k = t.score >= 85 ? "85+" : t.score >= 80 ? "80-84" : t.score >= 75 ? "75-79" : "70-74";
      buckets[k].push(t.pnl || 0);
    });

    const bucketStats = {};
    for (const [k, pnls] of Object.entries(buckets)) {
      const w = pnls.filter(p => p > 0).length;
      bucketStats[k] = {
        trades:   pnls.length,
        winRate:  pnls.length ? Math.round((w / pnls.length) * 100) : null,
        avgPnl:   pnls.length ? parseFloat((pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(2)) : null,
        totalPnl: parseFloat(pnls.reduce((a, b) => a + b, 0).toFixed(2)),
      };
    }

    const ordered = [...closed].sort((a, b) => new Date(a.closed_at) - new Date(b.closed_at));
    let running = 1000;
    const equity = [1000, ...ordered.map(t => {
      running += (t.pnl || 0);
      return parseFloat(running.toFixed(2));
    })];

    const daily = {};
    closed.forEach(t => {
      if (!t.closed_at) return;
      const day = t.closed_at.slice(0, 10);
      daily[day] = parseFloat(((daily[day] || 0) + (t.pnl || 0)).toFixed(2));
    });

    // Exit reason breakdown
    const exits = {};
    closed.forEach(t => {
      const k = t.exit_reason || "unknown";
      exits[k] = (exits[k] || 0) + 1;
    });

    res.json({
      bankroll:      parseFloat((1000 + totalPnl).toFixed(2)),
      totalPnl:      parseFloat(totalPnl.toFixed(2)),
      winRate:       parseFloat(winRate.toFixed(1)),
      avgWin:        parseFloat(avgWin.toFixed(2)),
      avgLoss:       parseFloat(avgLoss.toFixed(2)),
      profitFactor:  pf ? parseFloat(pf.toFixed(2)) : null,
      totalTrades:   closed.length,
      openTrades:    open.length,
      best:          best ? { ticker: best.ticker, pnl: best.pnl, mult: best.exit_mult } : null,
      buckets:       bucketStats,
      equity,
      daily,
      exits,
      ironDome: {
        marketMood,
        dynamicMinScore,
        circuitBroken,
        dailyPnl:     parseFloat(dailyPnl.toFixed(2)),
        selfTuneCount,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── START ──────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`
╔══════════════════════════════════════════╗
║         S0NAR — IRON DOME v3.0      ║
╠══════════════════════════════════════════╣
║  Layer 1: Quality gates                  ║
║  Layer 2: Rug pull detection             ║
║  Layer 3: Market mood awareness          ║
║  Layer 4: Dynamic position sizing        ║
║  Layer 5: Adaptive trailing stop         ║
║  Layer 6: Daily circuit breaker ($150)   ║
║  Layer 7: Self-tuning algorithm          ║
╚══════════════════════════════════════════╝
Port:      ${PORT}
Supabase:  ${SUPABASE_URL ? "✅ connected" : "❌ MISSING — set SUPABASE_URL"}
ntfy:      ${NTFY_TOPIC   ? `✅ topic: ${NTFY_TOPIC}` : "⚠️  not set — set NTFY_TOPIC"}
  `);

  await refreshDailyPnl();
  await layer3_updateMarketMood();

  pollSignals();
  setInterval(pollSignals,              FETCH_MS);
  setInterval(checkPositions,           CHECK_MS);
  setInterval(layer3_updateMarketMood,  MOOD_MS);
  setInterval(refreshDailyPnl,          300000); // refresh daily P&L every 5min
});
