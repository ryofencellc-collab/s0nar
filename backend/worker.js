require('dotenv').config();
const { Pool } = require('pg');
const fetch = require('node-fetch');

const db = new Pool({ connectionString: process.env.DATABASE_URL });

const PAPER_TRADING = process.env.PAPER_TRADING === 'true';
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL_MS) || 10000;

const STOP_LOSS = 0.72;
const EARLY_STOP = 0.82;
const TRAILING_PCT = 0.82;
const TIER1 = 1.5;
const TIER2 = 3.0;
const TIER3 = 6.0;
const MAX_HOLD = 120;

console.log('S0NAR Worker starting...');
console.log('Check interval:', CHECK_INTERVAL + 'ms');
console.log('Paper trading:', PAPER_TRADING);

async function checkPositions() {
  try {
    const positions = await db.query(`
      SELECT * FROM trades 
      WHERE status = 'OPEN'
      AND entered_at > NOW() - INTERVAL '3 hours'
      ORDER BY entered_at ASC
    `);

    if (positions.rows.length === 0) return;

    console.log(`Checking ${positions.rows.length} open positions`);

    for (const pos of positions.rows) {
      await evaluatePosition(pos);
      await new Promise(r => setTimeout(r, 500));
    }

  } catch (err) {
    console.error('Worker error:', err.message);
  }
}

async function evaluatePosition(pos) {
  try {
    const current = await getCurrentPrice(pos.pool_address);
    
    if (!current || current <= 0) {
      const ageMin = (Date.now() - new Date(pos.entered_at).getTime()) / 60000;
      if (ageMin > 10) {
        await closePosition(pos, 'DELISTED', 0, -parseFloat(pos.position_size));
      }
      return;
    }

    const entry = parseFloat(pos.entry_price);
    const mult = current / entry;
    const ageMin = (Date.now() - new Date(pos.entered_at).getTime()) / 60000;
    
    const highest = Math.max(parseFloat(pos.highest_mult || 1), mult);
    if (highest > parseFloat(pos.highest_mult || 1)) {
      await db.query("UPDATE trades SET highest_mult = $1 WHERE id = $2", [highest, pos.id]);
    }

    if (mult <= STOP_LOSS) {
      const pnl = calculatePnL(pos, mult);
      await closePosition(pos, 'STOP_LOSS', current, pnl);
      return;
    }

    if (mult <= EARLY_STOP && ageMin < 10) {
      const pnl = calculatePnL(pos, mult);
      await closePosition(pos, 'EARLY_STOP', current, pnl);
      return;
    }

    if (ageMin >= 45 && highest > 1.3 && mult <= highest * TRAILING_PCT) {
      const pnl = calculatePnL(pos, mult);
      await closePosition(pos, 'TRAILING_STOP', current, pnl);
      return;
    }

    if (mult >= TIER3) {
      const pnl = calculateTieredPnL(pos, mult, 'TIER3');
      await closePosition(pos, 'TIER_3_MOON', current, pnl);
      return;
    }

    if (mult >= TIER2 && !pos.tier2_hit) {
      await db.query("UPDATE trades SET tier2_hit = TRUE WHERE id = $1", [pos.id]);
      console.log(`${pos.ticker} hit TIER 2 (${mult.toFixed(2)}x)`);
      return;
    }

    if (mult >= TIER1 && ageMin >= 8 && !pos.tier1_hit) {
      await db.query("UPDATE trades SET tier1_hit = TRUE WHERE id = $1", [pos.id]);
      console.log(`${pos.ticker} hit TIER 1 (${mult.toFixed(2)}x)`);
      return;
    }

    if (ageMin >= MAX_HOLD) {
      const pnl = calculatePnL(pos, mult);
      const reason = mult >= 1 ? 'TIME_EXIT_UP' : 'TIME_EXIT_DOWN';
      await closePosition(pos, reason, current, pnl);
      return;
    }

  } catch (err) {
    console.error(`Position ${pos.id} error:`, err.message);
  }
}

async function getCurrentPrice(poolAddress) {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/pairs/solana/${poolAddress}`,
      { timeout: 10000 }
    );
    
    if (!res.ok) return null;
    
    const data = await res.json();
    const pair = data.pairs?.[0];
    
    if (!pair) return null;
    
    return parseFloat(pair.priceUsd);

  } catch (err) {
    return null;
  }
}

function calculatePnL(pos, mult) {
  const size = parseFloat(pos.position_size);
  return size * (mult - 1);
}

function calculateTieredPnL(pos, mult, tier) {
  const size = parseFloat(pos.position_size);
  
  if (tier === 'TIER3') {
    const t1 = size * 0.40 * (TIER1 - 1);
    const t2 = size * 0.35 * (TIER2 - 1);
    const t3 = size * 0.25 * (mult - 1);
    return t1 + t2 + t3;
  }
  
  return size * (mult - 1);
}

async function closePosition(pos, reason, exitPrice, pnl) {
  try {
    await db.query(`
      UPDATE trades 
      SET status = 'CLOSED',
          exit_reason = $1,
          exit_price = $2,
          pnl = $3,
          pnl_percent = $4,
          closed_at = NOW()
      WHERE id = $5
    `, [reason, exitPrice, pnl, (pnl / parseFloat(pos.position_size)) * 100, pos.id]);

    const emoji = pnl >= 0 ? '✅' : '❌';
    console.log(`${emoji} CLOSED: ${pos.ticker} | ${reason} | P&L: $${pnl.toFixed(2)}`);

  } catch (err) {
    console.error('Close position failed:', err.message);
  }
}

setInterval(checkPositions, CHECK_INTERVAL);
setTimeout(checkPositions, 5000);

console.log('Worker running...');
