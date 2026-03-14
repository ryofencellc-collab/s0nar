// ============================================================
//  S0NAR — IRON DOME v5.5  “FOMO HUNTER”
//  Strategy: enter before the crowd, exit into their buying
//  v5.5 fixes: Stealth Score — detects high-liq quiet setups
//             before coordinated pumps. Data-proven after 100t.
// ============================================================
const express  = require(“express”);
const cors     = require(“cors”);
const fetch    = require(“node-fetch”);
const { Pool } = require(“pg”);
const path     = require(“path”);
const crypto   = require(“crypto”);

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

async function initDB() {
await db(`CREATE TABLE IF NOT EXISTS signals ( id SERIAL PRIMARY KEY, ticker TEXT, pair_address TEXT, dex_url TEXT, score INTEGER, price NUMERIC, vol_5m NUMERIC, liq NUMERIC, pc_5m NUMERIC, boosted BOOLEAN DEFAULT FALSE, entered BOOLEAN DEFAULT FALSE, skip_reason TEXT, market_mood TEXT, age_min NUMERIC DEFAULT 0, fomo_score INTEGER DEFAULT 0, seen_at TIMESTAMPTZ DEFAULT NOW())`);

await db(`CREATE TABLE IF NOT EXISTS trades ( id SERIAL PRIMARY KEY, ticker TEXT, name TEXT, pair_address TEXT UNIQUE, dex_url TEXT, score INTEGER, entry_price NUMERIC, bet_size NUMERIC DEFAULT 50, status TEXT DEFAULT 'OPEN', exit_mult NUMERIC, highest_mult NUMERIC DEFAULT 1.0, pnl NUMERIC, exit_reason TEXT, vol_5m NUMERIC, vol_1h NUMERIC, liq NUMERIC, pc_5m NUMERIC, buys_5m INTEGER, sells_5m INTEGER, boosted BOOLEAN DEFAULT FALSE, market_mood TEXT, age_min NUMERIC DEFAULT 0, fomo_score INTEGER DEFAULT 0, opened_at TIMESTAMPTZ DEFAULT NOW(), closed_at TIMESTAMPTZ)`);

const migrations = [
`ALTER TABLE signals ADD COLUMN IF NOT EXISTS age_min    NUMERIC DEFAULT 0`,
`ALTER TABLE signals ADD COLUMN IF NOT EXISTS fomo_score INTEGER DEFAULT 0`,
`ALTER TABLE trades  ADD COLUMN IF NOT EXISTS age_min    NUMERIC DEFAULT 0`,
`ALTER TABLE trades  ADD COLUMN IF NOT EXISTS fomo_score INTEGER DEFAULT 0`,
`ALTER TABLE trades  ADD COLUMN IF NOT EXISTS stealth_score INTEGER DEFAULT 0`,
`ALTER TABLE trades  ADD COLUMN IF NOT EXISTS is_stealth BOOLEAN DEFAULT FALSE`,
`CREATE INDEX IF NOT EXISTS trades_status_idx  ON trades(status)`,
`CREATE INDEX IF NOT EXISTS trades_opened_idx  ON trades(opened_at DESC)`,
`CREATE INDEX IF NOT EXISTS trades_stealth_idx ON trades(is_stealth)`,
`CREATE INDEX IF NOT EXISTS signals_seen_idx   ON signals(seen_at DESC)`,
`CREATE INDEX IF NOT EXISTS signals_fomo_idx   ON signals(fomo_score DESC)`,
];
for (const m of migrations) await db(m).catch(e => console.warn(“migration:”, e.message));
console.log(“DB ready v5.1”);
}

// ── CONFIG ─────────────────────────────────────────────────
const NTFY     = process.env.NTFY_TOPIC;
const PORT     = process.env.PORT || 3000;
const APP_PASS = process.env.APP_PASSWORD || “sonar2024”; // Set APP_PASSWORD in Render env vars

// ── AUTH ───────────────────────────────────────────────────
// Simple token-based auth. Token = sha256(password + secret).
// Frontend sends token in X-Auth-Token header or as ?token= query param.
// /api/login exchanges password for token.
// /health is public (for Render health checks).
// All other routes require valid token.

const SECRET = process.env.SESSION_SECRET || “sonar-secret-key-change-me”;

function makeToken(password) {
return crypto.createHmac(“sha256”, SECRET).update(password).digest(“hex”);
}

const VALID_TOKEN = makeToken(APP_PASS);

function authMiddleware(req, res, next) {
// Allow health check and login without auth
if (req.path === “/health” || req.path === “/api/login”) return next();
// Allow static assets without auth
if (!req.path.startsWith(”/api/”) && req.path !== “/”) return next();

const token = req.headers[“x-auth-token”] || req.query.token;
if (token && token === VALID_TOKEN) return next();

// For API routes return 401
if (req.path.startsWith(”/api/”)) {
return res.status(401).json({ error: “Unauthorized” });
}
// For the root page, serve the app (login handled client-side)
next();
}

app.use(authMiddleware);

// Login endpoint — exchange password for token
app.post(”/api/login”, (req, res) => {
const { password } = req.body;
if (!password) return res.status(400).json({ error: “Password required” });
if (password !== APP_PASS) return res.status(401).json({ error: “Wrong password” });
res.json({ token: VALID_TOKEN, ok: true });
});

// Serve built React app from /public (Render will build it here)
const STATIC_DIR = path.join(__dirname, “dist”);
const fs = require(“fs”);
const hasDist = fs.existsSync(path.join(STATIC_DIR, “index.html”));
if (hasDist) {
app.use(express.static(STATIC_DIR));
console.log(“Serving frontend from dist/”);
} else {
console.log(“No dist/ folder — frontend served separately (Netlify/Vercel)”);
}

const MIN_SCORE   = 60;
const MIN_LIQ     = 2000;
const MIN_VOL_5M  = 300;
const MIN_BUY_PCT = 52;
const MIN_AGE_MIN = 3;
const MAX_AGE_MIN = 180;
const MIN_FOMO    = 20;

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

let mood          = “normal”;
let dynScore      = MIN_SCORE;
let circuitBroken = false;
let circuitAt     = null;
let dailyPnl      = 0;
let tuneCount     = 0;
let pollCount     = 0;
let lastWeeklyTs  = 0;
let backtestRunning = false;
let backtestLastRun = 0;

const volHistory  = new Map();
const fomoHistory = new Map();

const QUERIES = [
“pump.fun”,“pumpfun”,“pump fun sol”,
“dog sol”,“cat sol”,“frog sol”,“fish sol”,“pepe sol”,“doge sol”,
“hamster sol”,“bear sol”,“bull sol”,“wolf sol”,“ape sol”,“crab sol”,
“based sol”,“wagmi sol”,“ngmi sol”,“moon sol”,“gem sol”,
“chad sol”,“sigma sol”,“alpha sol”,“giga sol”,“chad coin”,
“ai sol”,“gpt sol”,“robot sol”,“neural sol”,
“solana meme”,“sol token”,“new sol”,“launch sol”,“bonk sol”,
“raydium new”,“jupiter new”,“sol gem”,“100x sol”,“1000x sol”,
“sol launch”,“fair launch sol”,“stealth sol”,
];
let qi = 0;

// ── NOTIFY ─────────────────────────────────────────────────
async function notify(title, body, priority = “default”) {
if (!NTFY) return;
try {
await fetch(`https://ntfy.sh/${NTFY}`, {
method: “POST”,
headers: {
“Title”:    title.replace(/[^\x20-\x7E]/g, “”).trim().slice(0, 100),
“Priority”: priority,
“Tags”:     “chart_with_upwards_trend”,
},
body: (body || “”).replace(/[^\x20-\x7E]/g, “”).trim(),
});
} catch(e) { console.error(“ntfy:”, e.message); }
}

// ── DEXSCREENER ────────────────────────────────────────────
async function dexSearch(q) {
const r = await fetch(
`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
{ timeout: 10000 }
);
if (!r.ok) throw new Error(`dexSearch ${r.status}`);
const d = await r.json();
return (d?.pairs || []).filter(p => p.chainId === “solana” && parseFloat(p.priceUsd || 0) > 0);
}

async function dexBoosted() {
const r = await fetch(`https://api.dexscreener.com/token-boosts/latest/v1`, { timeout: 10000 });
if (!r.ok) throw new Error(`dexBoosted ${r.status}`);
const d = await r.json();
return (d || []).filter(t => t.chainId === “solana”).slice(0, 20);
}

async function dexNewTokens() {
const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=solana`, { timeout: 10000 });
if (!r.ok) return [];
const d = await r.json();
return (d?.pairs || [])
.filter(p =>
p.chainId === “solana” &&
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
results.push(…(d?.pairs || []).filter(p => parseFloat(p.priceUsd || 0) > 0));
} catch(e) { continue; }
}
return results;
}

async function dexPair(address) {
const p = await dexPairs([address]);
return p[0] || null;
}

// ── Z-SCORE ────────────────────────────────────────────────
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

// ── FOMO SCORE ─────────────────────────────────────────────
// FIX: zero-liq tokens hard-capped at 30 — no real FOMO without real liquidity
function calcFomoScore(p) {
const liq = p.liquidity?.usd || 0;
const raw = calcRawFomo(p);
return liq < 500 ? Math.min(30, raw) : raw;
}

function calcRawFomo(p) {
const v5   = p.volume?.m5 || 0;
const v1   = p.volume?.h1 || 0.001;
const pc5  = parseFloat(p.priceChange?.m5 || 0);
const pc1  = parseFloat(p.priceChange?.h1 || 0);
const b    = p.txns?.m5?.buys  || 0;
const s    = p.txns?.m5?.sells || 0;
const liq  = p.liquidity?.usd  || 0;
const age  = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : 999;
const bst  = (p.boosts?.active || 0) > 0;
const addr = p.pairAddress;

let fomo = 0;

// 1. Volume acceleration vs expected hourly rate (up to 35pts)
const expected5m = v1 / 12;
fomo += Math.min(35, expected5m > 0 ? (v5 / expected5m) * 10 : 0);

// 2. Price velocity — sweet spot 5-15% (just starting)
if (pc5 >  5 && pc5 <= 15) fomo += 20;
if (pc5 > 15 && pc5 <= 30) fomo += 12;
if (pc5 > 30 && pc5 <= 60) fomo +=  5;
if (pc5 > 60)               fomo -= 10;
if (pc5 <  0)               fomo -=  5;

// 3. Buy pressure surge
const total = b + s;
if (total > 10) {
const br = b / total;
if      (br > 0.75) fomo += 18;
else if (br > 0.65) fomo += 12;
else if (br > 0.55) fomo +=  6;
}

// 4. Age sweet spot — 10-30 min is prime FOMO window
if (age >=  3 && age <  10) fomo += 15;
if (age >= 10 && age <  30) fomo += 20;
if (age >= 30 && age <  60) fomo += 10;
if (age >= 60 && age < 120) fomo +=  3;
if (age >= 120)             fomo -= 10;

// 5. Sustained 1h momentum
if (pc1 >   0 && pc1 < 100) fomo +=  8;
if (pc1 >= 100)              fomo +=  3;
if (pc1 <  -10)              fomo -=  8;

// 6. Vol/liq ratio (only when liq is real)
if (liq >= 500 && v5 > 0) {
const vlr = v5 / liq;
if (vlr > 0.5 && vlr < 5) fomo += 8;
if (vlr >= 5)              fomo += 3;
}

// 7. Z-score volume spike vs token’s own history
const z = getZScore(addr, v5);
if      (z > 2) fomo += 15;
else if (z > 1) fomo +=  8;
else if (z > 0) fomo +=  3;

// 8. Paid boost
if (bst) fomo += 10;

// 9. FOMO momentum — is score rising or falling?
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

// ── QUALITY SCORE ──────────────────────────────────────────
function score(p) {
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

// ── GATE ───────────────────────────────────────────────────
function gate(p, sc, fomo) {
const liq = p.liquidity?.usd || 0;
const v5  = p.volume?.m5    || 0;
const b   = p.txns?.m5?.buys  || 0;
const s   = p.txns?.m5?.sells || 0;
const bp  = b + s > 0 ? (b / (b + s)) * 100 : 0;
const pc5 = parseFloat(p.priceChange?.m5 || 0);
const age = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : -1;
const ageUnknown = age < 0;

// High FOMO + low liq = crowd pump with no foundation
// If FOMO > 70, require at least $30k liq to enter
// TRUMP was FOMO:88 with $23k liq — this blocks that pattern
const fomoLiqOk = fomo < 70 || liq >= 30000;

const checks = {
score:      { pass: sc >= dynScore,                        why: `score ${sc}<${dynScore}` },
fomo:       { pass: fomo >= MIN_FOMO,                      why: `fomo ${fomo}<${MIN_FOMO}` },
liq:        { pass: liq >= MIN_LIQ,                        why: `liq $${Math.round(liq)}<$${MIN_LIQ}` },
fomoLiq:    { pass: fomoLiqOk,                             why: `high fomo ${fomo} needs liq>$30k (got $${Math.round(liq)})` },
vol:        { pass: v5 >= MIN_VOL_5M,                      why: `vol $${Math.round(v5)}<$${MIN_VOL_5M}` },
buys:       { pass: bp >= MIN_BUY_PCT,                     why: `buys ${Math.round(bp)}%<${MIN_BUY_PCT}%` },
notDumping: { pass: pc5 > -25,                             why: `dumping ${pc5.toFixed(0)}%` },
notTooNew:  { pass: ageUnknown || age >= MIN_AGE_MIN,      why: `too new ${age.toFixed(1)}min` },
notStale:   { pass: ageUnknown || age <= MAX_AGE_MIN,      why: `stale ${Math.round(age)}min` },
hasPrice:   { pass: parseFloat(p.priceUsd || 0) > 0,      why: “no price” },
};

const failed = Object.values(checks).filter(c => !c.pass).map(c => c.why);
return { pass: failed.length === 0, failed };
}

// ── RUG CHECK ──────────────────────────────────────────────
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

// Core rug signals
if (age < MIN_AGE_MIN)          w.push(`too new (${age.toFixed(1)}min)`);
if (v5 > 80000 && liq < 4000)   w.push(“vol/liq mismatch”);
if (s > b * 3)                  w.push(“heavy sell wall”);
if (v1 > 800000 && liq < 8000)  w.push(“late pump thin liq”);
if (liq < 500)                  w.push(“dangerously thin liq”);

// New: high FOMO + low liq = crowd pump with no support
// TRUMP was FOMO:88 with only $23k liq — this is the pattern
if (liq < 25000 && parseFloat(p.priceChange?.m5 || 0) > 30) {
w.push(“low liq high velocity — likely rug”);
}

// New: extreme price spike with thin liq = coordinated dump incoming
if (pc5 > 100 && liq < 50000) w.push(“100%+ spike thin liq”);

// New: 1h already up massively + low liq = we’re at the top
if (pc1 > 300 && liq < 30000) w.push(“already pumped 300%+ thin liq”);

// New: sell pressure building fast
if (b > 0 && s > b * 2 && v5 > 1000) w.push(“sells doubling buys”);

return { pass: w.length === 0, warnings: w };
}

// ── BET SIZING ─────────────────────────────────────────────
// FIX: minimum floor raised. sc<70 = $25 base * 0.9 min = $25 (rounds up)
function betSize(sc, fomo, isstealth = false) {
const base = sc >= 85 ? 100
: sc >= 80 ?  75
: sc >= 75 ?  60
: sc >= 70 ?  40
:              25;

const fomoMult = fomo >= 80 ? 1.5
: fomo >= 65 ? 1.3
: fomo >= 50 ? 1.1
: fomo >= 35 ? 1.0
:              0.9;

// Stealth multiplier — 1.5x for high-liq quiet setups
// Based on BGOLD pattern: high liq + flat price = coordinated pump setup
const stealthMult = isstealth ? 1.5 : 1.0;

return Math.min(150, Math.max(25, Math.round((base * fomoMult * stealthMult) / 5) * 5));
}

// ── STEALTH SCORE ──────────────────────────────────────────
// Detects high-liquidity quiet setups before coordinated pumps.
// Pattern discovered from BGOLD: $133k liq, flat price, low FOMO
// = someone loaded the gun, we want to be in before they fire.
// Score 0-100. is_stealth = true when score >= 60.
function calcStealthScore(p) {
const liq  = p.liquidity?.usd || 0;
const pc5  = parseFloat(p.priceChange?.m5 || 0);
const pc1  = parseFloat(p.priceChange?.h1 || 0);
const age  = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : 999;
const b    = p.txns?.m5?.buys  || 0;
const s    = p.txns?.m5?.sells || 0;
const v5   = p.volume?.m5 || 0;
const v1   = p.volume?.h1 || 0.001;
const fomo = calcFomoScore(p);
const bst  = (p.boosts?.active || 0) > 0;

let st = 0;

// 1. High liquidity — the core signal (up to 40pts)
// Real money behind the token = someone serious is in this
if      (liq >= 200000) st += 40;
else if (liq >= 100000) st += 35;
else if (liq >= 50000)  st += 25;
else if (liq >= 20000)  st += 12;
else if (liq >= 10000)  st +=  5;
else                    st -=  10; // Low liq = not stealth

// 2. Price is quiet — not pumping yet (up to 20pts)
// We want flat-to-slightly-up, NOT already running
if      (pc5 >= -3  && pc5 <= 5)  st += 20; // Dead quiet — best
else if (pc5 >= -5  && pc5 <= 10) st += 12; // Slight move
else if (pc5 >= -10 && pc5 <= 20) st +=  5; // Moving but ok
else if (pc5 >  20)               st -= 15; // Already pumping — too late
else if (pc5 < -10)               st -= 10; // Dumping

// 3. FOMO is LOW — crowd not there yet (up to 20pts)
// If FOMO is high, crowd is already there = not stealth
if      (fomo >= 15 && fomo <= 35) st += 20; // Sweet spot
else if (fomo >= 35 && fomo <= 50) st += 10; // Still ok
else if (fomo >  50 && fomo <= 65) st +=  3; // Getting crowded
else if (fomo >  65)               st -= 15; // Too crowded = not stealth
else if (fomo <  15)               st +=  5; // Very quiet

// 4. Survived the rug window — age matters (up to 15pts)
if      (age >= 20  && age <= 60)  st += 15; // Prime stealth window
else if (age >= 60  && age <= 120) st += 10; // Still valid
else if (age >= 120 && age <= 180) st +=  5; // Getting older
else if (age <  20)                st -=  5; // Too new
else if (age >  180)               st -= 10; // Too old

// 5. Steady buy pressure — accumulation pattern (up to 10pts)
const total = b + s;
if (total > 5) {
const br = b / total;
if      (br >= 0.52 && br <= 0.68) st += 10; // Steady — not explosive
else if (br >= 0.68 && br <= 0.80) st +=  5; // Strong but ok
else if (br >  0.80)               st -=  5; // Too one-sided = wash
else if (br <  0.52)               st -=  5; // Sell pressure
}

// 6. Volume is LOW relative to liquidity — quiet accumulation
// High vol/liq ratio = already being traded heavily = not stealth
if (liq > 0 && v5 > 0) {
const vlr = v5 / liq;
if      (vlr < 0.1)               st += 5;  // Very quiet
else if (vlr < 0.3)               st += 2;  // Quiet
else if (vlr > 1.0)               st -= 5;  // Too active
}

// 7. No boost — organic, not paid promotion
// Boosted tokens are already being promoted = crowd incoming
if (bst) st -= 8;

return Math.round(Math.max(0, Math.min(100, st)));
}

// ── PNL CALC ───────────────────────────────────────────────
function calcPnL(trade, curPrice) {
const mult   = curPrice / parseFloat(trade.entry_price);
const bet    = parseFloat(trade.bet_size);
const ageMin = (Date.now() - new Date(trade.opened_at).getTime()) / 60000;
const hi     = Math.max(parseFloat(trade.highest_mult || 1), mult);

if (mult <= EARLY_STOP && ageMin < 10) {
return { status:“CLOSED”, exit:“EARLY STOP”, mult, pnl:+(bet*(mult-1)).toFixed(2), highMult:hi };
}
if (ageMin >= 45 && hi > 1.3 && mult <= hi * TRAILING_PCT) {
return { status:“CLOSED”, exit:“TRAILING STOP”, mult, pnl:+(bet*(mult-1)).toFixed(2), highMult:hi };
}
if (mult <= STOP_LOSS) {
return { status:“CLOSED”, exit:“STOP LOSS”, mult, pnl:+(bet*(mult-1)).toFixed(2), highMult:hi };
}
if (mult >= TIER3) {
const pnl = +((bet*TIER1_SELL*(TIER1-1))+(bet*TIER2_SELL*(TIER2-1))+(bet*0.25*(mult-1))).toFixed(2);
return { status:“CLOSED”, exit:“TIER 3 MOON”, mult, pnl, highMult:hi };
}
if (mult >= TIER2) {
const pnl = +((bet*TIER1_SELL*(TIER1-1))+(bet*TIER2_SELL*(mult-1))).toFixed(2);
return { status:“CLOSED”, exit:“TIER 2”, mult, pnl, highMult:hi };
}
if (mult >= TIER1 && ageMin >= 8) {
return { status:“OPEN”, exit:null, mult, pnl:null, highMult:hi };
}
if (ageMin >= MAX_HOLD) {
return { status:“CLOSED”, exit:mult>=1?“TIME EXIT UP”:“TIME EXIT DOWN”, mult, pnl:+(bet*(mult-1)).toFixed(2), highMult:hi };
}
return { status:“OPEN”, exit:null, mult, pnl:null, highMult:hi };
}

// ── CIRCUIT BREAKER ────────────────────────────────────────
function checkCircuit() {
const now = new Date();
if (circuitAt && new Date(circuitAt).getDate() !== now.getDate()) {
circuitBroken = false; circuitAt = null; dailyPnl = 0;
}
if (dailyPnl <= -DAILY_LIMIT && !circuitBroken) {
circuitBroken = true;
circuitAt     = now.toISOString();
notify(“CIRCUIT BREAKER”, `Down $${Math.abs(dailyPnl).toFixed(2)} today. Paused until midnight.`, “urgent”);
}
}

// ── MARKET MOOD ────────────────────────────────────────────
async function updateMood() {
try {
const [r1, r2] = await Promise.allSettled([
dexSearch(“solana meme”),
dexSearch(“pump.fun”),
]);
const pairs = [
…(r1.status === “fulfilled” ? r1.value : []),
…(r2.status === “fulfilled” ? r2.value : []),
].slice(0, 40);
if (!pairs.length) return;

```
const avg = pairs.reduce((a, p) => a + parseFloat(p.priceChange?.m5 || 0), 0) / pairs.length;
const hot = pairs.filter(p => parseFloat(p.priceChange?.m5 || 0) > 8).length;
const pct = (hot / pairs.length) * 100;

if      (avg >  8 && pct >= 60) { mood = "frenzy"; dynScore = MIN_SCORE - 4; }
else if (avg >  4 && pct >= 40) { mood = "hot";    dynScore = MIN_SCORE - 2; }
else if (avg >  1 && pct >= 25) { mood = "warm";   dynScore = MIN_SCORE;     }
else if (avg < -8 && pct <  10) { mood = "dead";   dynScore = MIN_SCORE + 8; }
else if (avg < -5 && pct <  15) { mood = "cold";   dynScore = MIN_SCORE + 5; }
else                             { mood = "normal"; dynScore = MIN_SCORE;     }

console.log(`[MOOD] ${mood} avg:${avg.toFixed(1)}% hot:${hot}/${pairs.length} minScore:${dynScore}`);
```

} catch(e) { console.error(“updateMood:”, e.message); }
}

// ── SELF-TUNE ──────────────────────────────────────────────
async function selfTune() {
try {
const r = await db(
`SELECT score, fomo_score, pnl FROM trades WHERE status='CLOSED' ORDER BY closed_at DESC LIMIT 100`
);
const trades = r.rows;
if (trades.length < 20) return;

```
const wr  = arr => arr.length ? arr.filter(x => x > 0).length / arr.length : 0;
const low = trades.filter(t => t.score < 70).map(t => parseFloat(t.pnl || 0));
const mid = trades.filter(t => t.score >= 70 && t.score < 80).map(t => parseFloat(t.pnl || 0));

if (wr(low) < 0.40 && low.length >= 10) dynScore = Math.min(dynScore + 3, MIN_SCORE + 12);
else if (wr(mid) > 0.65 && mid.length >= 10) dynScore = Math.max(dynScore - 2, MIN_SCORE - 5);

const hf = trades.filter(t => parseInt(t.fomo_score || 0) >= 60).map(t => parseFloat(t.pnl || 0));
const lf = trades.filter(t => parseInt(t.fomo_score || 0) <  40).map(t => parseFloat(t.pnl || 0));
if (hf.length >= 5 && lf.length >= 5) {
  console.log(`[TUNE] HighFOMO(${hf.length}):${(wr(hf)*100).toFixed(0)}% LowFOMO(${lf.length}):${(wr(lf)*100).toFixed(0)}%`);
}

tuneCount++;
console.log(`[TUNE] #${tuneCount} minScore:${dynScore}`);
```

} catch(e) { console.error(“selfTune:”, e.message); }
}

async function refreshDaily() {
try {
const today = new Date().toISOString().slice(0, 10);
const r = await db(
`SELECT COALESCE(SUM(pnl),0) AS t FROM trades WHERE status='CLOSED' AND closed_at >= $1`,
[`${today}T00:00:00Z`]
);
dailyPnl = parseFloat(r.rows[0].t);
} catch(e) { console.error(“refreshDaily:”, e.message); }
}

// FIX: timestamp guard prevents duplicate weekly reports
async function weeklyReport() {
if (Date.now() - lastWeeklyTs < 60 * 60 * 1000) return;
lastWeeklyTs = Date.now();
try {
const r = await db(
`SELECT pnl FROM trades WHERE status='CLOSED' AND closed_at >= NOW() - INTERVAL '7 days'`
);
const t   = r.rows;
const tp  = t.reduce((a, x) => a + parseFloat(x.pnl || 0), 0);
const wr  = t.length ? Math.round(t.filter(x => parseFloat(x.pnl || 0) > 0).length / t.length * 100) : 0;
await notify(“S0NAR Weekly”, `${t.length} trades | ${wr}% WR | ${tp>=0?"+":""}$${tp.toFixed(2)} | Bank:$${(1000+tp).toFixed(0)}`);
} catch(e) { console.error(“weeklyReport:”, e.message); }
}

// ── DB HELPERS ─────────────────────────────────────────────
async function getOpen() {
return (await db(`SELECT * FROM trades WHERE status='OPEN' ORDER BY opened_at DESC`)).rows;
}

async function hadTrade(addr) {
return (await db(`SELECT id FROM trades WHERE pair_address=$1 LIMIT 1`, [addr])).rows.length > 0;
}

async function insertTrade(p, sc, fomo) {
const stealthSc = calcStealthScore(p);
const isStealth = stealthSc >= 60;
const bet       = betSize(sc, fomo, isStealth);
const age       = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : 0;

// Columns: 22 total — verified below
const r = await db(` INSERT INTO trades (ticker, name, pair_address, dex_url, score, entry_price, bet_size, status, highest_mult, vol_5m, vol_1h, liq, pc_5m, buys_5m, sells_5m, boosted, market_mood, age_min, fomo_score, stealth_score, is_stealth, opened_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', 1.0, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW()) RETURNING *`,
[
p.baseToken?.symbol || “???”,        // $1
p.baseToken?.name   || “”,           // $2
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
]
);
return r.rows[0];
}

async function closeTrade(id, res) {
await db(
`UPDATE trades SET status='CLOSED', exit_mult=$1, highest_mult=$2, pnl=$3, exit_reason=$4, closed_at=NOW() WHERE id=$5`,
[res.mult, res.highMult, res.pnl, res.exit, id]
);
}

async function logSig(p, sc, fomo, g1, g2) {
const age = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : 0;
await db(` INSERT INTO signals (ticker, pair_address, dex_url, score, price, vol_5m, liq, pc_5m, boosted, entered, skip_reason, market_mood, age_min, fomo_score, seen_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())`,
[
p.baseToken?.symbol || “???”,
p.pairAddress,
p.url,
sc,
parseFloat(p.priceUsd  || 0),
p.volume?.m5     || 0,
p.liquidity?.usd || 0,
parseFloat(p.priceChange?.m5 || 0),
(p.boosts?.active || 0) > 0,
g1.pass && g2.pass,
[…g1.failed, …g2.warnings].join(”; “) || null,
mood,
parseFloat(age.toFixed(1)),
fomo,
]
).catch(() => {});
}

// ── POLL SIGNALS ───────────────────────────────────────────
async function pollSignals() {
checkCircuit();
if (circuitBroken) { console.log(“Circuit active — skipping poll”); return; }

pollCount++;
console.log(`[POLL #${pollCount}] ${new Date().toISOString()} mood:${mood} minScore:${dynScore}`);

try {
const q0 = QUERIES[qi       % QUERIES.length];
const q1 = QUERIES[(qi + 1) % QUERIES.length];
const q2 = QUERIES[(qi + 2) % QUERIES.length];
qi += 3;

```
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

const seen = new Set();
const all  = [];
for (const p of [...searchPairs, ...boostedPairs, ...newTokens]) {
  if (!p.pairAddress || seen.has(p.pairAddress)) continue;
  seen.add(p.pairAddress);
  all.push(p);
}

console.log(`  search:${searchPairs.length} boosted:${boostedPairs.length} new:${newTokens.length} total:${all.length}`);

let entered = 0, skipped = 0;
for (const p of all) {
  const sc   = score(p);
  const fomo = calcFomoScore(p);
  const g1   = gate(p, sc, fomo);
  const g2   = rugCheck(p);

  await logSig(p, sc, fomo, g1, g2);

  if (!g1.pass || !g2.pass) { skipped++; continue; }
  if (await hadTrade(p.pairAddress)) continue;

  const trade = await insertTrade(p, sc, fomo).catch(e => {
    const msg = e.message.toLowerCase();
    if (!msg.includes("unique") && !msg.includes("duplicate")) {
      console.error("insertTrade:", e.message);
    }
    return null;
  });

  if (trade) {
    entered++;
    const liq       = p.liquidity?.usd || 0;
    const bp        = Math.round(
      (p.txns?.m5?.buys || 0) /
      Math.max((p.txns?.m5?.buys || 0) + (p.txns?.m5?.sells || 0), 1) * 100
    );
    const age       = p.pairCreatedAt
      ? ((Date.now() - p.pairCreatedAt) / 60000).toFixed(0)
      : "?";
    const pc5       = parseFloat(p.priceChange?.m5 || 0).toFixed(0);
    const stTag     = trade.is_stealth ? " [STEALTH]" : "";
    console.log(`  ENTERED${stTag} ${p.baseToken?.symbol} sc:${sc} fomo:${fomo} stealth:${trade.stealth_score} bet:$${trade.bet_size} age:${age}m pc5:${pc5}%`);
    await notify(
      `${trade.is_stealth ? "STEALTH" : "ENTRY"}: ${p.baseToken?.symbol}`,
      `Score:${sc} FOMO:${fomo} Stealth:${trade.stealth_score} | Bet:$${trade.bet_size} | Age:${age}m | ${pc5}% 5m | Liq:$${Math.round(liq).toLocaleString()} | Buys:${bp}%`,
      trade.is_stealth ? "urgent" : "high"
    );
  }
}

console.log(`  entered:${entered} skipped:${skipped}`);

const cnt = parseInt(
  (await db(`SELECT COUNT(*) FROM trades WHERE status='CLOSED'`)).rows[0].count
);
if (cnt > 0 && cnt % 30 === 0 && Math.floor(cnt / 30) > tuneCount) await selfTune();
```

} catch(e) { console.error(“pollSignals:”, e.message); }
}

// ── CHECK POSITIONS ────────────────────────────────────────
async function checkPositions() {
try {
const open = await getOpen();
if (!open.length) return;

```
const addrs   = open.map(t => t.pair_address);
const pairs   = await dexPairs(addrs).catch(() => []);
const pairMap = new Map(pairs.map(p => [p.pairAddress, p]));

console.log(`[CHECK] ${new Date().toISOString()} open:${open.length}`);

for (const t of open) {
  try {
    const pair = pairMap.get(t.pair_address)
      || await dexPair(t.pair_address).catch(() => null);

    if (!pair) {
      const ageMin = (Date.now() - new Date(t.opened_at).getTime()) / 60000;
      // Close delisted trades much faster:
      // - Under 5 min: close at -30% (likely instant rug)
      // - 5-15 min: close at -40%
      // - Over 15 min: close at -50%
      // Don't wait 30 min — pairs that vanish are rugs
      if (ageMin > 3) {
        const lossPct = ageMin < 5 ? 0.30 : ageMin < 15 ? 0.40 : 0.50;
        const mult    = 1 - lossPct;
        const pnl     = +(parseFloat(t.bet_size) * -lossPct).toFixed(2);
        await closeTrade(t.id, { mult, pnl, exit:"DELISTED", highMult:parseFloat(t.highest_mult||1) });
        dailyPnl += pnl;
        console.log(`  DELISTED ${t.ticker} age:${ageMin.toFixed(0)}m loss:${(lossPct*100).toFixed(0)}%`);
        await notify(`DELISTED: ${t.ticker}`, `Pair vanished after ${ageMin.toFixed(0)}m. Closed -${(lossPct*100).toFixed(0)}%.`);
      }
      continue;
    }

    const cur = parseFloat(pair.priceUsd);
    if (!cur || cur <= 0) continue;

    const res     = calcPnL(t, cur);
    const pct     = ((cur / parseFloat(t.entry_price)) - 1) * 100;
    const fomo    = calcFomoScore(pair);
    const curLiq  = pair.liquidity?.usd || 0;
    const entryLiq = parseFloat(t.liq || 0);

    // Live rug detection — exit immediately if:
    // 1. Liquidity has collapsed >70% since entry (someone pulled liquidity)
    // 2. Price is down >40% (hard dump, worse than stop loss)
    const liqCollapse = entryLiq > 5000 && curLiq < entryLiq * 0.30;
    const hardDump    = pct < -40;

    if ((liqCollapse || hardDump) && res.status === "OPEN") {
      const rugPnl = +(parseFloat(t.bet_size) * (cur / parseFloat(t.entry_price) - 1)).toFixed(2);
      const reason = liqCollapse ? "LIQ PULLED" : "HARD DUMP";
      await closeTrade(t.id, { mult: cur/parseFloat(t.entry_price), pnl: rugPnl, exit: reason, highMult: res.highMult });
      dailyPnl += rugPnl;
      console.log(`  ${reason} ${t.ticker} ${pct.toFixed(0)}% pnl:$${rugPnl}`);
      await notify(
        `RUG DETECTED: ${t.ticker}`,
        `${reason} | ${pct.toFixed(0)}% | $${rugPnl} | liq was $${Math.round(entryLiq).toLocaleString()} now $${Math.round(curLiq).toLocaleString()}`,
        "urgent"
      );
      continue;
    }

    if (res.highMult > parseFloat(t.highest_mult || 1)) {
      await db(`UPDATE trades SET highest_mult=$1 WHERE id=$2`, [res.highMult, t.id]);
    }

    // FOMO Fade — crowd left while we're still in profit
    if (fomo < 15 && pct > 5 && res.status === "OPEN") {
      const fadePnl = +(parseFloat(t.bet_size) * (cur / parseFloat(t.entry_price) - 1)).toFixed(2);
      await closeTrade(t.id, {
        mult: cur / parseFloat(t.entry_price),
        pnl: fadePnl,
        exit: "FOMO FADE",
        highMult: res.highMult,
      });
      dailyPnl += fadePnl;
      console.log(`  FOMO FADE ${t.ticker} +${pct.toFixed(0)}% +$${fadePnl}`);
      await notify(`FOMO FADE: ${t.ticker}`, `+${pct.toFixed(0)}% | +$${fadePnl} | FOMO:${fomo}`, "default");
      continue;
    }

    console.log(`  ${t.ticker}: ${pct>=0?"+":""}${pct.toFixed(0)}% fomo:${fomo} hi:${res.highMult.toFixed(2)}x → ${res.status}`);

    if (res.status === "CLOSED") {
      await closeTrade(t.id, res);
      dailyPnl += res.pnl;
      checkCircuit();
      const ps = res.pnl >= 0 ? `+$${res.pnl.toFixed(2)}` : `-$${Math.abs(res.pnl).toFixed(2)}`;
      console.log(`  CLOSED ${t.ticker} ${res.exit} ${ps}`);
      await notify(
        `${res.pnl >= 0 ? "WIN" : "LOSS"} ${t.ticker}: ${res.exit}`,
        `${ps} | ${res.mult.toFixed(2)}x | $${t.bet_size} bet | sc:${t.score} fomo:${t.fomo_score||0} | Today:${dailyPnl>=0?"+":""}$${dailyPnl.toFixed(2)}`,
        res.pnl >= 0 ? "high" : "default"
      );
    }
  } catch(e) { console.error(`  ${t.ticker}:`, e.message); }

  // FIX: 500ms delay between checks — prevents API hammering with many open trades
  await new Promise(r => setTimeout(r, 500));
}
```

} catch(e) { console.error(“checkPositions:”, e.message); }
}

// ── API ────────────────────────────────────────────────────
app.get(”/health”, (req, res) => res.json({
status: “ok”, ts: new Date().toISOString(), version: “5.5”,
marketMood: mood, dynamicMinScore: dynScore, circuitBroken,
dailyPnl: +dailyPnl.toFixed(2), selfTuneCount: tuneCount, pollCount,
config: {
MIN_SCORE, MIN_FOMO, MIN_LIQ, MIN_VOL_5M, MIN_BUY_PCT,
MIN_AGE_MIN, MAX_AGE_MIN, FETCH_MS, CHECK_MS, MAX_HOLD,
TIER1, TIER2, TIER3, STOP_LOSS, QUERIES: QUERIES.length,
},
}));

// NEW: Debug endpoint — see exactly why tokens are being rejected
app.get(”/api/debug”, async(req, res) => {
try {
const rows = (await db(` SELECT ticker, score, fomo_score, liq, vol_5m, pc_5m, age_min, entered, skip_reason, seen_at FROM signals ORDER BY seen_at DESC LIMIT 50`
)).rows;

```
const skipTally = {};
rows.filter(s => s.skip_reason).forEach(s => {
  s.skip_reason.split("; ").forEach(reason => {
    // First two words as key e.g. "liq $450<$2000" -> "liq $450"
    const key = reason.split(" ").slice(0, 2).join(" ");
    skipTally[key] = (skipTally[key] || 0) + 1;
  });
});

res.json({
  thresholds: { dynScore, MIN_FOMO, MIN_LIQ, MIN_VOL_5M, MIN_BUY_PCT, mood },
  summary: {
    total:         rows.length,
    entered:       rows.filter(s => s.entered).length,
    skipped:       rows.filter(s => !s.entered).length,
    zeroLiq:       rows.filter(s => parseFloat(s.liq || 0) < 100).length,
    avgScore:      rows.length ? Math.round(rows.reduce((a,s)=>a+parseInt(s.score||0),0)/rows.length) : 0,
    avgFomo:       rows.length ? Math.round(rows.reduce((a,s)=>a+parseInt(s.fomo_score||0),0)/rows.length) : 0,
    skipReasons:   Object.entries(skipTally).sort((a,b)=>b[1]-a[1]).slice(0, 10),
  },
  recent: rows,
});
```

} catch(e) { res.status(500).json({ error: e.message }); }
});

app.get(”/test-ntfy”, async(req, res) => {
await notify(“S0NAR v5.1”, “FOMO Hunter live. All bugs fixed.”, “high”);
res.json({ sent: true, topic: NTFY || “not set” });
});

app.get(”/api/signals”, async(req, res) => {
try {
const limit = Math.min(parseInt(req.query.limit) || 200, 500);
res.json((await db(`SELECT * FROM signals ORDER BY seen_at DESC LIMIT $1`, [limit])).rows);
} catch(e) { res.status(500).json({ error: e.message }); }
});

app.get(”/api/trades”, async(req, res) => {
try {
const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
res.json((await db(`SELECT * FROM trades ORDER BY opened_at DESC LIMIT $1`, [limit])).rows);
} catch(e) { res.status(500).json({ error: e.message }); }
});

app.get(”/api/stats”, async(req, res) => {
try {
const all    = (await db(`SELECT * FROM trades`)).rows;
const closed = all.filter(t => t.status === “CLOSED”);
const open   = all.filter(t => t.status === “OPEN”);
const wins   = closed.filter(t => parseFloat(t.pnl || 0) > 0);
const losses = closed.filter(t => parseFloat(t.pnl || 0) <= 0);
const tp     = closed.reduce((a, t) => a + parseFloat(t.pnl || 0), 0);
const wr     = closed.length ? (wins.length / closed.length) * 100 : 0;
const aw     = wins.length   ? wins.reduce((a,t)=>a+parseFloat(t.pnl||0),0)/wins.length : 0;
const al     = losses.length ? losses.reduce((a,t)=>a+parseFloat(t.pnl||0),0)/losses.length : 0;
const pf     = losses.length && Math.abs(al) > 0 ? Math.abs(aw*wins.length)/Math.abs(al*losses.length) : null;
const best   = closed.length ? closed.reduce((a,b)=>parseFloat(a.pnl||0)>parseFloat(b.pnl||0)?a:b, closed[0]) : null;

```
const mkBkt = obj => {
  const out = {};
  for (const [k, arr] of Object.entries(obj)) {
    const w = arr.filter(x => x > 0).length;
    out[k] = {
      trades:   arr.length,
      winRate:  arr.length ? Math.round(w/arr.length*100) : null,
      avgPnl:   arr.length ? +(arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(2) : null,
      totalPnl: +arr.reduce((a,b)=>a+b,0).toFixed(2),
    };
  }
  return out;
};

const scoreBkts   = {"<65":[],"65-69":[],"70-74":[],"75-79":[],"80-84":[],"85+":[]};
const fomoBkts    = {"0-19":[],"20-39":[],"40-59":[],"60-79":[],"80+":[]};
const stealthBkts = {"stealth":[],"non-stealth":[]};

closed.forEach(t => {
  const pnl = parseFloat(t.pnl || 0);
  const sk  = t.score>=85?"85+":t.score>=80?"80-84":t.score>=75?"75-79":t.score>=70?"70-74":t.score>=65?"65-69":"<65";
  const fk  = parseInt(t.fomo_score||0)>=80?"80+":parseInt(t.fomo_score||0)>=60?"60-79":parseInt(t.fomo_score||0)>=40?"40-59":parseInt(t.fomo_score||0)>=20?"20-39":"0-19";
  scoreBkts[sk].push(pnl);
  fomoBkts[fk].push(pnl);
  stealthBkts[t.is_stealth?"stealth":"non-stealth"].push(pnl);
});

// Stealth summary stats
const stealthTrades    = closed.filter(t => t.is_stealth);
const nonStealthTrades = closed.filter(t => !t.is_stealth);
const stealthWins      = stealthTrades.filter(t => parseFloat(t.pnl||0) > 0);
const stealthWR        = stealthTrades.length ? (stealthWins.length/stealthTrades.length)*100 : 0;
const stealthAvgPnl    = stealthTrades.length ? stealthTrades.reduce((a,t)=>a+parseFloat(t.pnl||0),0)/stealthTrades.length : 0;
const stealthTotalPnl  = stealthTrades.reduce((a,t)=>a+parseFloat(t.pnl||0),0);
const bestStealth      = stealthTrades.length
  ? stealthTrades.reduce((a,b)=>parseFloat(a.pnl||0)>parseFloat(b.pnl||0)?a:b, stealthTrades[0])
  : null;

const ord = [...closed].sort((a,b)=>new Date(a.closed_at)-new Date(b.closed_at));
let run = 1000;
const equity = [1000, ...ord.map(t=>{run+=parseFloat(t.pnl||0);return +run.toFixed(2);})];

const daily = {};
closed.forEach(t => {
  if (!t.closed_at) return;
  const d = new Date(t.closed_at).toISOString().slice(0,10);
  daily[d] = +((daily[d]||0)+parseFloat(t.pnl||0)).toFixed(2);
});

const exits = {};
closed.forEach(t => { const k=t.exit_reason||"unknown"; exits[k]=(exits[k]||0)+1; });

res.json({
  bankroll:+(1000+tp).toFixed(2), totalPnl:+tp.toFixed(2),
  winRate:+wr.toFixed(1), avgWin:+aw.toFixed(2), avgLoss:+al.toFixed(2),
  profitFactor:pf?+pf.toFixed(2):null,
  totalTrades:closed.length, openTrades:open.length,
  best:best?{ticker:best.ticker,pnl:+parseFloat(best.pnl||0).toFixed(2),mult:+parseFloat(best.exit_mult||0).toFixed(2)}:null,
  buckets:mkBkt(scoreBkts), fomoBuckets:mkBkt(fomoBkts),
  stealthBuckets:mkBkt(stealthBkts),
  stealthStats:{
    trades:   stealthTrades.length,
    winRate:  stealthTrades.length ? +stealthWR.toFixed(1) : null,
    avgPnl:   stealthTrades.length ? +stealthAvgPnl.toFixed(2) : null,
    totalPnl: +stealthTotalPnl.toFixed(2),
    best:     bestStealth ? {ticker:bestStealth.ticker,pnl:+parseFloat(bestStealth.pnl||0).toFixed(2),mult:+parseFloat(bestStealth.exit_mult||0).toFixed(2)} : null,
    vsNormal: nonStealthTrades.length && stealthTrades.length ? {
      stealthWR:  +stealthWR.toFixed(1),
      normalWR:   +(nonStealthTrades.filter(t=>parseFloat(t.pnl||0)>0).length/nonStealthTrades.length*100).toFixed(1),
      stealthAvg: +stealthAvgPnl.toFixed(2),
      normalAvg:  +(nonStealthTrades.reduce((a,t)=>a+parseFloat(t.pnl||0),0)/nonStealthTrades.length).toFixed(2),
    } : null,
  },
  equity, daily, exits,
  ironDome:{
    marketMood:mood, dynamicMinScore:dynScore, circuitBroken,
    dailyPnl:+dailyPnl.toFixed(2), selfTuneCount:tuneCount, pollCount,
    version:"5.5",
    config:{ MIN_SCORE,MIN_FOMO,MIN_LIQ,TIER1,TIER2,TIER3,MAX_HOLD },
  },
});
```

} catch(e) { res.status(500).json({ error: e.message }); }
});

// FOMO feed — near-misses included so you can see what’s close to entering
app.get(”/api/fomo-feed”, async(req, res) => {
try {
const threshold = Math.max(0, MIN_FOMO - 5); // Show near-misses too
const r = await db(` SELECT ticker, pair_address, dex_url, score, fomo_score, price, vol_5m, liq, pc_5m, age_min, market_mood, entered, skip_reason, seen_at FROM signals WHERE seen_at > NOW() - INTERVAL '10 minutes' AND fomo_score >= ${threshold} ORDER BY fomo_score DESC LIMIT 60`);
res.json(r.rows);
} catch(e) { res.status(500).json({ error: e.message }); }
});

// Live unrealized P&L for all open positions
app.get(”/api/open-pnl”, async(req, res) => {
try {
const open = await getOpen();
if (!open.length) return res.json([]);

```
// Batch fetch all current prices at once
const addrs = open.map(t => t.pair_address);
const pairs = await dexPairs(addrs).catch(() => []);
const pairMap = new Map(pairs.map(p => [p.pairAddress, p]));

const result = open.map(t => {
  const pair    = pairMap.get(t.pair_address);
  const curPrice = pair ? parseFloat(pair.priceUsd) : null;
  const entry    = parseFloat(t.entry_price);
  const bet      = parseFloat(t.bet_size);
  const ageMin   = (Date.now() - new Date(t.opened_at).getTime()) / 60000;
  const hi       = parseFloat(t.highest_mult || 1);

  if (!curPrice || curPrice <= 0 || !entry || entry <= 0) {
    return {
      id: t.id, ticker: t.ticker, pair_address: t.pair_address,
      dex_url: t.dex_url, score: t.score, fomo_score: t.fomo_score||0,
      bet_size: bet, entry_price: entry, opened_at: t.opened_at,
      cur_price: null, pct_change: null, unrealized_pnl: null,
      highest_mult: hi, age_min: +ageMin.toFixed(1),
      status: "no_price",
    };
  }

  const mult          = curPrice / entry;
  const pct           = (mult - 1) * 100;
  const unrealizedPnl = +(bet * (mult - 1)).toFixed(2);
  const newHi         = Math.max(hi, mult);

  // Warning levels for UI
  const warning = mult <= STOP_LOSS + 0.05   ? "near_stop"
                : mult <= EARLY_STOP + 0.03 && ageMin < 10 ? "near_early_stop"
                : newHi > 1.3 && mult <= newHi * TRAILING_PCT + 0.05 && ageMin >= 45 ? "near_trailing"
                : mult >= TIER2 - 0.1        ? "near_tier2"
                : mult >= TIER1 - 0.05       ? "near_tier1"
                : "ok";

  return {
    id: t.id, ticker: t.ticker, pair_address: t.pair_address,
    dex_url: t.dex_url, score: t.score, fomo_score: t.fomo_score||0,
    bet_size: bet, entry_price: entry, opened_at: t.opened_at,
    cur_price: +curPrice.toFixed(10),
    pct_change: +pct.toFixed(2),
    unrealized_pnl: unrealizedPnl,
    mult: +mult.toFixed(4),
    highest_mult: +newHi.toFixed(4),
    age_min: +ageMin.toFixed(1),
    warning,
    status: "ok",
  };
});

res.json(result);
```

} catch(e) { res.status(500).json({ error: e.message }); }
});

// Backtest — rate limited: one run at a time, 2 min cooldown
app.get(”/api/backtest”, async(req, res) => {
if (backtestRunning) return res.status(429).json({ error: “Backtest already running” });
if (Date.now() - backtestLastRun < 120000) {
const wait = Math.ceil((120000-(Date.now()-backtestLastRun))/1000);
return res.status(429).json({ error: `Cooldown — wait ${wait}s` });
}

backtestRunning = true;
backtestLastRun = Date.now();
console.log(”[BACKTEST] Starting…”);

try {
const allPairs = [];
for (let i = 0; i < QUERIES.length; i += 5) {
const batch = QUERIES.slice(i, i + 5);
const results = await Promise.allSettled(
batch.map(q =>
fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, { timeout:10000 })
.then(r => r.ok ? r.json() : null)
.then(d => (d?.pairs||[]).filter(p =>
p.chainId===“solana” && parseFloat(p.priceUsd||0)>0 && (p.liquidity?.usd||0)>500
))
)
);
for (const r of results) if (r.status===“fulfilled” && r.value) allPairs.push(…r.value);
await new Promise(r => setTimeout(r, 300));
}

```
try {
  const br = await fetch("https://api.dexscreener.com/token-boosts/latest/v1", { timeout:10000 });
  if (br.ok) {
    const bd    = await br.json();
    const addrs = (bd||[]).filter(t=>t.chainId==="solana").slice(0,20).map(t=>t.tokenAddress).filter(Boolean);
    if (addrs.length) allPairs.push(...await dexPairs(addrs).catch(()=>[]));
  }
} catch(e) {}

const seen = new Set(), pairs = [];
for (const p of allPairs) {
  if (!p.pairAddress || seen.has(p.pairAddress)) continue;
  seen.add(p.pairAddress); pairs.push(p);
}
console.log(`[BACKTEST] ${pairs.length} pairs`);

const results = [];
for (const p of pairs) {
  const sc   = score(p);
  const fomo = calcFomoScore(p);
  const liq  = p.liquidity?.usd||0, v5=p.volume?.m5||0, v1=p.volume?.h1||0;
  const pc5  = parseFloat(p.priceChange?.m5||0);
  const pc1  = parseFloat(p.priceChange?.h1||0);
  const pc24 = parseFloat(p.priceChange?.h24||0);
  const b    = p.txns?.m5?.buys||0, s=p.txns?.m5?.sells||0;
  const bsPct = b+s>0 ? Math.round(b/(b+s)*100) : 50;
  if (sc<45||liq<300) continue;

  const bet = betSize(sc, fomo);
  let mult, exit, pnl;
  if      (pc1<=-28)            { mult=0.72; exit="STOP LOSS";    pnl=+(bet*-0.28).toFixed(2); }
  else if (pc1<=-15&&v5<v1/8)   { mult=0.82; exit="EARLY STOP";   pnl=+(bet*-0.18).toFixed(2); }
  else if (pc1>=400)            { mult=6.0;  exit="TIER 3 MOON";  pnl=+((bet*TIER1_SELL*(TIER1-1))+(bet*TIER2_SELL*(TIER2-1))+(bet*0.25*5)).toFixed(2); }
  else if (pc1>=100)            { mult=3.0;  exit="TIER 2";       pnl=+((bet*TIER1_SELL*(TIER1-1))+(bet*TIER2_SELL*(pc1/100))).toFixed(2); }
  else if (pc1>=50)             { mult=1.5;  exit="TIER 1";       pnl=+(bet*TIER1_SELL*(pc1/100)).toFixed(2); }
  else if (pc1>=0)              { mult=+(1+pc1/100).toFixed(2); exit="TIME EXIT UP";   pnl=+(bet*(pc1/100)).toFixed(2); }
  else                          { mult=+(1+pc1/100).toFixed(2); exit="TIME EXIT DOWN"; pnl=+(bet*(pc1/100)).toFixed(2); }

  const wouldEnter = sc>=dynScore && fomo>=MIN_FOMO && liq>=MIN_LIQ && v5>=MIN_VOL_5M && bsPct>=MIN_BUY_PCT && pc5>-25;
  results.push({ ticker:p.baseToken?.symbol||"???",pairAddr:p.pairAddress,dexUrl:p.url,
    score:sc,fomo,betSize:bet,liq:Math.round(liq),vol5m:Math.round(v5),
    pc5m:+pc5.toFixed(1),pc1h:+pc1.toFixed(1),pc24h:+pc24.toFixed(1),
    bsPct,boosted:(p.boosts?.active||0)>0,mult,pnl,exit,wouldEnter });
}

results.sort((a,b)=>b.fomo-a.fomo);
const qual=results.filter(r=>r.wouldEnter);
const qw=qual.filter(r=>r.pnl>0), ql=qual.filter(r=>r.pnl<=0);
const qtp=+qual.reduce((a,r)=>a+r.pnl,0).toFixed(2);
const qwr=qual.length?(qw.length/qual.length)*100:0;
const qaw=qw.length?+(qw.reduce((a,r)=>a+r.pnl,0)/qw.length).toFixed(2):0;
const qal=ql.length?+(ql.reduce((a,r)=>a+r.pnl,0)/ql.length).toFixed(2):0;

const fbkts={"0-19":[],"20-39":[],"40-59":[],"60-79":[],"80+":[]};
qual.forEach(r=>{const k=r.fomo>=80?"80+":r.fomo>=60?"60-79":r.fomo>=40?"40-59":r.fomo>=20?"20-39":"0-19";fbkts[k].push(r.pnl);});
const fb={};
for(const[k,arr]of Object.entries(fbkts)){const w=arr.filter(x=>x>0).length;fb[k]={trades:arr.length,winRate:arr.length?Math.round(w/arr.length*100):null,avgPnl:arr.length?+(arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(2):null,totalPnl:+arr.reduce((a,b)=>a+b,0).toFixed(2)};}

console.log(`[BACKTEST] ${qual.length} qualifying WR:${qwr.toFixed(0)}%`);
res.json({ scanned:results.length,qualifying:qual.length,winRate:+qwr.toFixed(1),totalPnl:qtp,avgWin:qaw,avgLoss:qal,fomoBuckets:fb,trades:results,disclaimer:"Real data. 1h price = outcome proxy. -20% haircut for live.",ts:new Date().toISOString() });
```

} catch(e) {
console.error(”[BACKTEST]”, e.message);
res.status(500).json({ error: e.message });
} finally {
backtestRunning = false;
}
});

// Catch-all — only serve index.html if dist exists
app.get(”*”, (req, res) => {
if (req.path.startsWith(”/api/”)) {
return res.status(404).json({ error: “Not found” });
}
if (hasDist) {
return res.sendFile(path.join(STATIC_DIR, “index.html”));
}
res.status(200).send(“S0NAR backend running. Frontend served separately.”);
});

// ── START ──────────────────────────────────────────────────
app.listen(PORT, async () => {
console.log(`\nS0NAR FOMO HUNTER v5.1 | Port:${PORT}`);
console.log(`DB:${process.env.DATABASE_URL?"connected":"MISSING"} ntfy:${NTFY||"not set"}`);
console.log(`minScore:${MIN_SCORE} minFOMO:${MIN_FOMO} minLiq:$${MIN_LIQ} minVol:$${MIN_VOL_5M}`);
console.log(`Tiers:${TIER1}x/${TIER2}x/${TIER3}x maxHold:${MAX_HOLD}m queries:${QUERIES.length}\n`);

await initDB();
await refreshDaily();
await updateMood();

setTimeout(pollSignals, 2000);
setInterval(pollSignals,    FETCH_MS);
setInterval(checkPositions, CHECK_MS);
setInterval(updateMood,     5 * 60 * 1000);
setInterval(refreshDaily,   2 * 60 * 1000);
setInterval(() => {
const n = new Date();
if (n.getDay()===0 && n.getHours()===9 && n.getMinutes()<1) weeklyReport();
}, 60000);
});
