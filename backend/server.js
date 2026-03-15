require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const db = new Pool({ connectionString: process.env.DATABASE_URL });

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const PAPER_TRADING = process.env.PAPER_TRADING === 'true';
const BANKROLL = parseFloat(process.env.BANKROLL) || 5000;
const DETECTION_INTERVAL = parseInt(process.env.DETECTION_INTERVAL_MS) || 15000;

const seenPools = new Map();
const detectionStats = {
  polls: 0,
  poolsFound: 0,
  signals: 0,
  entered: 0,
  errors: 0,
  startTime: Date.now(),
};

if (!HELIUS_KEY) {
  console.error('Missing HELIUS_API_KEY');
  process.exit(1);
}

console.log('S0NAR Web Server starting...');
console.log('Paper trading:', PAPER_TRADING);
console.log('Detection interval:', DETECTION_INTERVAL + 'ms');

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT NOW()');
    res.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - detectionStats.startTime) / 1000),
      stats: detectionStats,
      paperTrading: PAPER_TRADING,
      bankroll: BANKROLL,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', database: err.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    const [signalsRes, tradesRes] = await Promise.all([
      db.query("SELECT COUNT(*) FROM signals WHERE DATE(detected_at) = $1", [today]),
      db.query(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as open,
          SUM(CASE WHEN status = 'CLOSED' AND pnl > 0 THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN status = 'CLOSED' AND pnl <= 0 THEN 1 ELSE 0 END) as losses,
          SUM(pnl) as total_pnl
        FROM trades 
        WHERE DATE(entered_at) = $1
      `, [today]),
    ]);
    
    res.json({
      signals24h: parseInt(signalsRes.rows[0].count),
      trades: tradesRes.rows[0],
      detection: detectionStats,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/signals', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM signals 
      ORDER BY detected_at DESC 
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trades', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM trades 
      ORDER BY entered_at DESC 
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/positions', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM trades 
      WHERE status = 'OPEN'
      ORDER BY entered_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const QUERIES = [
  'pump.fun', 'pumpfun', 'solana new',
  'raydium', 'meteora', 'orca',
  'solana meme', 'sol token', 'new sol',
  'dog sol', 'cat sol', 'pepe sol',
  'ai sol', 'gpt sol', 'moon sol',
];

let queryIndex = 0;

async function detectPools() {
  detectionStats.polls++;
  
  try {
    const batch = [
      QUERIES[queryIndex % QUERIES.length],
      QUERIES[(queryIndex + 1) % QUERIES.length],
      QUERIES[(queryIndex + 2) % QUERIES.length],
    ];
    queryIndex += 3;

    const results = await Promise.allSettled(
      batch.map(q => searchDexScreener(q))
    );

    const newPools = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const pool of result.value) {
          if (!seenPools.has(pool.pairAddress)) {
            seenPools.set(pool.pairAddress, Date.now());
            newPools.push(pool);
          }
        }
      }
    }

    detectionStats.poolsFound += newPools.length;

    for (const pool of newPools) {
      await processPool(pool);
    }

    const cutoff = Date.now() - 1800000;
    for (const [addr, time] of seenPools.entries()) {
      if (time < cutoff) seenPools.delete(addr);
    }

    if (detectionStats.polls % 10 === 0) {
      console.log(`[Poll #${detectionStats.polls}] Found ${newPools.length} new, total seen: ${seenPools.size}`);
    }

  } catch (err) {
    detectionStats.errors++;
    console.error('Detection error:', err.message);
  }
}

async function searchDexScreener(query) {
  const res = await fetch(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`,
    { timeout: 10000 }
  );
  
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  
  const data = await res.json();
  
  return (data.pairs || []).filter(p => 
    p.chainId === 'solana' &&
    parseFloat(p.priceUsd) > 0 &&
    p.liquidity?.usd > 5000
  );
}

async function processPool(pool) {
  try {
    const normalized = {
      poolAddress: pool.pairAddress,
      tokenAddress: pool.baseToken?.address,
      baseToken: pool.quoteToken?.address,
      ticker: pool.baseToken?.symbol,
      name: pool.baseToken?.name,
      price: parseFloat(pool.priceUsd),
      liquidity: pool.liquidity?.usd || 0,
      volume5m: pool.volume?.m5 || 0,
      volume1h: pool.volume?.h1 || 0,
      priceChange5m: parseFloat(pool.priceChange?.m5 || 0),
      priceChange1h: parseFloat(pool.priceChange?.h1 || 0),
      buys5m: pool.txns?.m5?.buys || 0,
      sells5m: pool.txns?.m5?.sells || 0,
      ageMinutes: pool.pairCreatedAt ? 
        (Date.now() - pool.pairCreatedAt) / 60000 : 999,
      dexUrl: pool.url,
    };

    if (normalized.ageMinutes > 30 || normalized.ageMinutes < 2) {
      return;
    }

    const analysis = await analyzePool(normalized);
    
    const signalResult = await db.query(`
      INSERT INTO signals (
        pool_address, token_address, base_token, ticker, name,
        price, liquidity, volume_5m, volume_1h,
        price_change_5m, price_change_1h, buys_5m, sells_5m,
        age_minutes, dex_url, score, analysis, entered, skip_reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      RETURNING id
    `, [
      normalized.poolAddress,
      normalized.tokenAddress,
      normalized.baseToken,
      normalized.ticker,
      normalized.name,
      normalized.price,
      normalized.liquidity,
      normalized.volume5m,
      normalized.volume1h,
      normalized.priceChange5m,
      normalized.priceChange1h,
      normalized.buys5m,
      normalized.sells5m,
      normalized.ageMinutes,
      normalized.dexUrl,
      analysis.score,
      JSON.stringify(analysis),
      false,
      analysis.skipReason,
    ]);

    detectionStats.signals++;

    if (analysis.score >= 80 && await canEnter()) {
      await enterPosition(signalResult.rows[0].id, normalized, analysis);
    }

  } catch (err) {}
}

async function analyzePool(pool) {
  let score = 50;
  let skipReason = null;

  if (pool.liquidity > 50000) score += 25;
  else if (pool.liquidity > 30000) score += 20;
  else if (pool.liquidity > 15000) score += 15;
  else if (pool.liquidity > 5000) score += 10;
  else { score -= 20; skipReason = 'low_liquidity'; }

  const vlr = pool.volume5m / pool.liquidity;
  if (vlr > 0.1 && vlr < 0.5) score += 15;
  else if (vlr > 0.05) score += 10;

  if (pool.priceChange5m > 5 && pool.priceChange5m < 50) score += 15;
  else if (pool.priceChange5m > 0) score += 10;
  else if (pool.priceChange5m < -10) { score -= 10; skipReason = skipReason || 'negative_price'; }

  if (pool.ageMinutes >= 5 && pool.ageMinutes <= 15) score += 10;
  else if (pool.ageMinutes <= 25) score += 5;

  const totalTrades = pool.buys5m + pool.sells5m;
  if (totalTrades > 0) {
    const buyRatio = pool.buys5m / totalTrades;
    if (buyRatio > 0.6) score += 10;
    else if (buyRatio > 0.5) score += 5;
  }

  let onChainData = null;
  try {
    onChainData = await getOnChainData(pool.tokenAddress);
    if (onChainData.topHolders < 40) score += 15;
    else if (onChainData.topHolders < 60) score += 5;
    else { score -= 15; skipReason = skipReason || 'concentrated_holders'; }
    if (onChainData.creatorAge > 30) score += 10;
  } catch (err) {
    score -= 5;
  }

  return {
    score: Math.min(100, Math.max(0, score)),
    skipReason: score < 80 ? (skipReason || 'low_score') : null,
    onChainData,
    timestamp: Date.now(),
  };
}

async function getOnChainData(tokenAddress) {
  if (!tokenAddress) return { topHolders: 100, creatorAge: 0 };
  
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenLargestAccounts',
      params: [tokenAddress],
    }),
  });

  if (!res.ok) throw new Error('Helius failed');
  
  const data = await res.json();
  const holders = data.result?.value || [];
  const top5 = holders.slice(0, 5);
  
  return {
    topHolders: top5.length > 0 ? 50 : 100,
    holderCount: holders.length,
    creatorAge: 0,
  };
}

async function canEnter() {
  const res = await db.query("SELECT COUNT(*) FROM trades WHERE status = 'OPEN'");
  return parseInt(res.rows[0].count) < 3;
}

async function enterPosition(signalId, pool, analysis) {
  const positionSize = Math.min(BANKROLL * 0.02, 100);
  
  try {
    await db.query(`
      INSERT INTO trades (
        signal_id, pool_address, token_address, ticker, name,
        entry_price, position_size, score, analysis, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPEN')
    `, [
      signalId,
      pool.poolAddress,
      pool.tokenAddress,
      pool.ticker,
      pool.name,
      pool.price,
      positionSize,
      analysis.score,
      JSON.stringify(analysis),
    ]);

    await db.query("UPDATE signals SET entered = TRUE WHERE id = $1", [signalId]);

    detectionStats.entered++;
    console.log(`ENTERED: ${pool.ticker} Score: ${analysis.score} Size: $${positionSize}`);

  } catch (err) {
    console.error('Enter position failed:', err.message);
  }
}

setInterval(detectPools, DETECTION_INTERVAL);
setTimeout(detectPools, 5000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
