// S0NAR — IRON DOME v3.0 — uses Render PostgreSQL (no Supabase)
const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");
const { Pool } = require("pg");

const app  = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function query(sql, params=[]) {
  const c = await pool.connect();
  try { return await c.query(sql, params); } finally { c.release(); }
}

async function initDB() {
  await query(`CREATE TABLE IF NOT EXISTS signals (
    id SERIAL PRIMARY KEY, ticker TEXT, pair_address TEXT, dex_url TEXT,
    score INTEGER, price NUMERIC, vol_5m NUMERIC, liq NUMERIC, pc_5m NUMERIC,
    boosted BOOLEAN DEFAULT FALSE, entered BOOLEAN DEFAULT FALSE,
    skip_reason TEXT, market_mood TEXT, seen_at TIMESTAMPTZ DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS trades (
    id SERIAL PRIMARY KEY, ticker TEXT, name TEXT,
    pair_address TEXT UNIQUE, dex_url TEXT, score INTEGER,
    entry_price NUMERIC, bet_size NUMERIC DEFAULT 50, status TEXT DEFAULT 'OPEN',
    exit_mult NUMERIC, highest_mult NUMERIC DEFAULT 1.0, pnl NUMERIC, exit_reason TEXT,
    vol_5m NUMERIC, vol_1h NUMERIC, liq NUMERIC, pc_5m NUMERIC,
    buys_5m INTEGER, sells_5m INTEGER, boosted BOOLEAN DEFAULT FALSE,
    market_mood TEXT, opened_at TIMESTAMPTZ DEFAULT NOW(), closed_at TIMESTAMPTZ)`);
  await query(`CREATE INDEX IF NOT EXISTS trades_status_idx ON trades(status)`);
  await query(`CREATE INDEX IF NOT EXISTS signals_seen_idx ON signals(seen_at DESC)`);
  console.log("✅ DB ready");
}

const NTFY_TOPIC = process.env.NTFY_TOPIC;
const PORT       = process.env.PORT || 3000;

const BET_SIZE=50, MIN_SCORE=70, MIN_LIQ=5000, MIN_VOL_5M=1000, MIN_BUY_PCT=55;
const STOP_LOSS=0.70, TIER1=2.0, TIER2=5.0, MAX_HOLD=240, DAILY_LIMIT=150;
const FETCH_MS=30000, CHECK_MS=60000, MOOD_MS=3600000;

let marketMood="normal", dynScore=MIN_SCORE;
let circuitBroken=false, circuitAt=null, dailyPnl=0, tuneCount=0;

const QUERIES=["pump.fun","solana meme","pepe sol","dog sol","cat sol","based sol","ai sol","frog sol","moon sol","wagmi sol","bonk sol","sol token"];
let qi=0;

async function notify(title, body, priority="default") {
  if (!NTFY_TOPIC) return;
  try { await fetch(`https://ntfy.sh/${NTFY_TOPIC}`,{method:"POST",headers:{"Title":title,"Priority":priority,"Tags":"chart_with_upwards_trend"},body}); }
  catch(e){console.error("ntfy:",e.message);}
}

async function dexSearch(q) {
  const r=await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,{timeout:10000});
  if(!r.ok) throw new Error(`search ${r.status}`);
  const d=await r.json();
  return (d?.pairs||[]).filter(p=>p.chainId==="solana"&&parseFloat(p.priceUsd||0)>0);
}
async function dexBoosted() {
  const r=await fetch(`https://api.dexscreener.com/token-boosts/latest/v1`,{timeout:10000});
  if(!r.ok) throw new Error(`boosts ${r.status}`);
  const d=await r.json();
  return (d||[]).filter(t=>t.chainId==="solana").slice(0,10);
}
async function dexPairs(addrs) {
  if(!addrs.length) return [];
  const r=await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${addrs.slice(0,10).join(",")}`,{timeout:10000});
  if(!r.ok) throw new Error(`pairs ${r.status}`);
  const d=await r.json();
  return (d?.pairs||[]).filter(p=>parseFloat(p.priceUsd||0)>0);
}
async function dexPair(addr) { const p=await dexPairs([addr]); return p[0]||null; }

function score(p) {
  const v5=p.volume?.m5||0,v1=p.volume?.h1||1,pc=parseFloat(p.priceChange?.m5||0);
  const liq=p.liquidity?.usd||0,b=p.txns?.m5?.buys||0,s=p.txns?.m5?.sells||1;
  const boost=(p.boosts?.active||0)>0;
  let sc=0;
  sc+=Math.min(100,(v5/Math.max(v1/12,1))*100)*0.35;
  sc+=Math.min(100,Math.max(0,(pc+30)/1.3))*0.25;
  sc+=(liq>100000?100:liq>50000?85:liq>20000?65:liq>5000?45:liq>1000?25:5)*0.20;
  sc+=Math.min(100,(b/(b+s))*100)*0.15;
  if(boost)sc+=5; if(liq<2000)sc-=25; if(v5<200)sc-=10;
  return Math.round(Math.max(0,Math.min(99,sc)));
}

function l1Gate(pair, sc) {
  const liq=pair.liquidity?.usd||0, v5=pair.volume?.m5||0;
  const b=pair.txns?.m5?.buys||0, s=pair.txns?.m5?.sells||0;
  const bp=b+s>0?(b/(b+s))*100:0, pc=parseFloat(pair.priceChange?.m5||0);
  const checks={
    score:{pass:sc>=dynScore,reason:`score ${sc}<${dynScore}`},
    liq:{pass:liq>=MIN_LIQ,reason:`liq $${Math.round(liq)}<$${MIN_LIQ}`},
    vol:{pass:v5>=MIN_VOL_5M,reason:`vol $${Math.round(v5)}<$${MIN_VOL_5M}`},
    buys:{pass:bp>=MIN_BUY_PCT,reason:`buys ${Math.round(bp)}%<${MIN_BUY_PCT}%`},
    notdump:{pass:pc>-20,reason:`dumping ${pc.toFixed(0)}%`},
    price:{pass:parseFloat(pair.priceUsd||0)>0,reason:"no price"},
  };
  const failed=Object.values(checks).filter(c=>!c.pass).map(c=>c.reason);
  return {pass:failed.length===0,failed};
}

function l2Rug(pair) {
  const liq=pair.liquidity?.usd||0,v5=pair.volume?.m5||0,v1=pair.volume?.h1||0;
  const b=pair.txns?.m5?.buys||0,s=pair.txns?.m5?.sells||0;
  const age=(Date.now()-(pair.pairCreatedAt||Date.now()))/60000;
  const w=[];
  if(age<3)w.push(`too new ${age.toFixed(1)}min`);
  if(v5>50000&&liq<5000)w.push("vol/liq mismatch");
  if(s>b*1.5)w.push("sell pressure");
  if(v1>500000&&liq<10000)w.push("late pump");
  return {pass:w.length===0,warnings:w};
}

function betSize(sc) { return sc>=85?100:sc>=80?75:sc>=75?50:25; }

function calcPnL(trade, cur) {
  const mult=cur/trade.entry_price, bet=trade.bet_size;
  const age=(Date.now()-new Date(trade.opened_at).getTime())/60000;
  const hi=Math.max(trade.highest_mult||1,mult);
  let stop=age>=60&&hi>1.5?hi*0.85:age<15?0.80:STOP_LOSS;
  if(mult<=stop){
    const ex=age>=60?"TRAILING STOP 📉":age<15?"EARLY STOP 🛑":"STOP LOSS 🛑";
    return {status:"CLOSED",exit:ex,mult,pnl:bet*(mult-1),highMult:hi};
  }
  if(mult>=TIER2){
    const pnl=(bet*.30*(TIER1-1))+(bet*.40*(TIER2-1))+(bet*.30*(mult-1));
    return {status:"CLOSED",exit:"TIER 2 🚀",mult,pnl,highMult:hi};
  }
  if(mult>=TIER1&&age>=30){
    const pnl=(bet*.30*(TIER1-1))+(bet*.70*(mult-1));
    return {status:"CLOSED",exit:"TIER 1 ✓",mult,pnl,highMult:hi};
  }
  if(age>=MAX_HOLD) return {status:"CLOSED",exit:mult>=1?"TIME EXIT ▲":"TIME EXIT ▼",mult,pnl:bet*(mult-1),highMult:hi};
  return {status:"OPEN",exit:null,mult,pnl:null,highMult:hi};
}

function checkCircuit() {
  const now=new Date();
  if(circuitAt&&new Date(circuitAt).getDate()!==now.getDate()){circuitBroken=false;circuitAt=null;dailyPnl=0;}
  if(dailyPnl<=-DAILY_LIMIT&&!circuitBroken){
    circuitBroken=true;circuitAt=now.toISOString();
    console.log(`[CIRCUIT] TRIGGERED — down $${Math.abs(dailyPnl).toFixed(2)}`);
    notify("⚡ CIRCUIT BREAKER",`Down $${Math.abs(dailyPnl).toFixed(2)} today. Paused until midnight.`,"urgent");
  }
}

async function updateMood() {
  try {
    const pairs=await dexSearch("solana").catch(()=>[]);
    if(!pairs.length)return;
    const s=pairs.slice(0,20);
    const avg=s.reduce((a,p)=>a+parseFloat(p.priceChange?.m5||0),0)/s.length;
    const hot=s.filter(p=>parseFloat(p.priceChange?.m5||0)>10).length;
    if(avg>5&&hot>=8){marketMood="hot";dynScore=68;}
    else if(avg<-5){marketMood="cold";dynScore=78;}
    else{marketMood="normal";dynScore=MIN_SCORE;}
    console.log(`[MOOD] ${marketMood} avg:${avg.toFixed(1)}% hot:${hot}/20 minScore:${dynScore}`);
  }catch(e){console.error("mood:",e.message);}
}

async function selfTune() {
  try {
    const r=await query(`SELECT score,pnl FROM trades WHERE status='CLOSED' ORDER BY closed_at DESC LIMIT 50`);
    const low=r.rows.filter(t=>t.score<75);
    if(low.length>=10){
      const wr=low.filter(t=>parseFloat(t.pnl||0)>0).length/low.length;
      if(wr<0.40&&dynScore<75)dynScore=Math.min(dynScore+2,80);
      else if(wr>0.60&&dynScore>MIN_SCORE)dynScore=Math.max(dynScore-1,MIN_SCORE);
    }
    tuneCount++;
    console.log(`[TUNE] #${tuneCount} minScore:${dynScore}`);
  }catch(e){console.error("tune:",e.message);}
}

async function getOpen() { return (await query(`SELECT * FROM trades WHERE status='OPEN' ORDER BY opened_at DESC`)).rows; }
async function hadTrade(addr) { return (await query(`SELECT id FROM trades WHERE pair_address=$1 LIMIT 1`,[addr])).rows.length>0; }

async function enterTrade(pair, sc) {
  const bet=betSize(sc);
  const r=await query(`INSERT INTO trades (ticker,name,pair_address,dex_url,score,entry_price,bet_size,status,highest_mult,vol_5m,vol_1h,liq,pc_5m,buys_5m,sells_5m,boosted,market_mood,opened_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'OPEN',1.0,$8,$9,$10,$11,$12,$13,$14,$15,NOW()) RETURNING *`,
    [pair.baseToken?.symbol||"???",pair.baseToken?.name||"",pair.pairAddress,pair.url,sc,parseFloat(pair.priceUsd),bet,pair.volume?.m5||0,pair.volume?.h1||0,pair.liquidity?.usd||0,parseFloat(pair.priceChange?.m5||0),pair.txns?.m5?.buys||0,pair.txns?.m5?.sells||0,(pair.boosts?.active||0)>0,marketMood]);
  return r.rows[0];
}

async function closeTrade(id, res) {
  await query(`UPDATE trades SET status='CLOSED',exit_mult=$1,highest_mult=$2,pnl=$3,exit_reason=$4,closed_at=NOW() WHERE id=$5`,
    [res.mult,res.highMult,res.pnl,res.exit,id]);
}

async function logSig(pair, sc, l1, l2) {
  await query(`INSERT INTO signals (ticker,pair_address,dex_url,score,price,vol_5m,liq,pc_5m,boosted,entered,skip_reason,market_mood,seen_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())`,
    [pair.baseToken?.symbol||"???",pair.pairAddress,pair.url,sc,parseFloat(pair.priceUsd||0),pair.volume?.m5||0,pair.liquidity?.usd||0,parseFloat(pair.priceChange?.m5||0),(pair.boosts?.active||0)>0,l1.pass&&l2.pass,[...l1.failed,...l2.warnings].join("; ")||null,marketMood]).catch(()=>{});
}

async function refreshDaily() {
  try {
    const today=new Date().toISOString().slice(0,10);
    const r=await query(`SELECT COALESCE(SUM(pnl),0) as t FROM trades WHERE status='CLOSED' AND closed_at>=$1`,[`${today}T00:00:00Z`]);
    dailyPnl=parseFloat(r.rows[0].t);
  }catch(e){console.error("daily:",e.message);}
}

// ── LOOPS ──────────────────────────────────────────────────
async function pollSignals() {
  checkCircuit();
  if(circuitBroken){console.log("Circuit active — skip");return;}
  console.log(`[${new Date().toISOString()}] Poll mood:${marketMood} min:${dynScore}`);
  try {
    const q=QUERIES[qi%QUERIES.length]; qi++;
    const [sr,br]=await Promise.allSettled([dexSearch(q),dexBoosted()]);
    const sp=sr.status==="fulfilled"?sr.value:[];
    const bt=br.status==="fulfilled"?br.value:[];
    let bp=[];
    if(bt.length){const a=bt.map(t=>t.tokenAddress).filter(Boolean);bp=await dexPairs(a).catch(()=>[]);}
    const seen=new Set(),all=[];
    for(const p of [...sp,...bp]){if(!p.pairAddress||seen.has(p.pairAddress))continue;seen.add(p.pairAddress);all.push(p);}
    console.log(`  ${all.length} pairs "${q}"`);
    let entered=0,skipped=0;
    for(const pair of all){
      const sc=score(pair),l1=l1Gate(pair,sc),l2=l2Rug(pair);
      await logSig(pair,sc,l1,l2);
      if(!l1.pass||!l2.pass){skipped++;continue;}
      if(await hadTrade(pair.pairAddress))continue;
      const trade=await enterTrade(pair,sc).catch(e=>{console.error("insert:",e.message);return null;});
      if(trade){
        entered++;
        const liq=pair.liquidity?.usd||0;
        const bp2=Math.round((pair.txns?.m5?.buys||0)/Math.max((pair.txns?.m5?.buys||0)+(pair.txns?.m5?.sells||0),1)*100);
        console.log(`  ✅ ${pair.baseToken?.symbol} sc:${sc} bet:$${trade.bet_size}`);
        await notify(`📡 ENTERED: ${pair.baseToken?.symbol}`,`Score:${sc} | Bet:$${trade.bet_size} | Liq:$${Math.round(liq).toLocaleString()} | Buys:${bp2}% | ${marketMood}`,"high");
      }
    }
    console.log(`  In:${entered} Skip:${skipped}`);
    const cnt=parseInt((await query(`SELECT COUNT(*) FROM trades WHERE status='CLOSED'`)).rows[0].count);
    if(cnt>0&&cnt%50===0&&cnt/50>tuneCount)await selfTune();
  }catch(e){console.error("poll:",e.message);}
}

async function checkPositions() {
  console.log(`[${new Date().toISOString()}] Check positions...`);
  try {
    const open=await getOpen();
    if(!open.length){console.log("  none");return;}
    for(const t of open){
      try {
        const pair=await dexPair(t.pair_address);
        if(!pair){
          const age=(Date.now()-new Date(t.opened_at).getTime())/60000;
          if(age>60){
            await closeTrade(t.id,{mult:0.5,pnl:t.bet_size*-0.5,exit:"DELISTED 💀",highMult:t.highest_mult||1});
            dailyPnl+=t.bet_size*-0.5;
            await notify(`💀 DELISTED: ${t.ticker}`,"Pair gone. Closed -50%.");
          }
          continue;
        }
        const cur=parseFloat(pair.priceUsd),res=calcPnL(t,cur);
        const pct=((cur/t.entry_price)-1)*100;
        console.log(`  ${t.ticker}: ${pct>=0?"+":""}${pct.toFixed(0)}% → ${res.status}`);
        if(res.highMult>(t.highest_mult||1))await query(`UPDATE trades SET highest_mult=$1 WHERE id=$2`,[res.highMult,t.id]);
        if(res.status==="CLOSED"){
          await closeTrade(t.id,res);dailyPnl+=res.pnl;checkCircuit();
          const ps=res.pnl>=0?`+$${res.pnl.toFixed(2)}`:`-$${Math.abs(res.pnl).toFixed(2)}`;
          console.log(`  💰 ${t.ticker} ${res.exit} ${ps}`);
          await notify(`${res.pnl>=0?"✅":"❌"} ${t.ticker}: ${res.exit}`,`${ps} | ${res.mult.toFixed(2)}x | $${t.bet_size} bet | Score:${t.score}`,res.pnl>=0?"high":"default");
        }
      }catch(e){console.error(`  ${t.ticker}:`,e.message);}
      await new Promise(r=>setTimeout(r,2000));
    }
  }catch(e){console.error("check:",e.message);}
}

// ── API ────────────────────────────────────────────────────
app.get("/health",(req,res)=>res.json({status:"ok",ts:new Date().toISOString(),version:"3.0-iron-dome",marketMood,dynamicMinScore:dynScore,circuitBroken,dailyPnl:parseFloat(dailyPnl.toFixed(2)),selfTuneCount:tuneCount}));

app.get("/api/signals",async(req,res)=>{
  try{res.json((await query(`SELECT * FROM signals ORDER BY seen_at DESC LIMIT 100`)).rows);}
  catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/trades",async(req,res)=>{
  try{res.json((await query(`SELECT * FROM trades ORDER BY opened_at DESC LIMIT 200`)).rows);}
  catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/stats",async(req,res)=>{
  try{
    const all=(await query(`SELECT * FROM trades`)).rows;
    const closed=all.filter(t=>t.status==="CLOSED"),open=all.filter(t=>t.status==="OPEN");
    const wins=closed.filter(t=>parseFloat(t.pnl||0)>0),losses=closed.filter(t=>parseFloat(t.pnl||0)<=0);
    const tp=closed.reduce((a,t)=>a+parseFloat(t.pnl||0),0);
    const wr=closed.length?(wins.length/closed.length)*100:0;
    const aw=wins.length?wins.reduce((a,t)=>a+parseFloat(t.pnl||0),0)/wins.length:0;
    const al=losses.length?losses.reduce((a,t)=>a+parseFloat(t.pnl||0),0)/losses.length:0;
    const best=closed.length?closed.reduce((a,b)=>parseFloat(a.pnl||0)>parseFloat(b.pnl||0)?a:b,closed[0]):null;
    const pf=losses.length&&Math.abs(al)>0?Math.abs(aw*wins.length)/Math.abs(al*losses.length):null;
    const bkts={"70-74":[],"75-79":[],"80-84":[],"85+":[]};
    closed.forEach(t=>{const k=t.score>=85?"85+":t.score>=80?"80-84":t.score>=75?"75-79":"70-74";bkts[k].push(parseFloat(t.pnl||0));});
    const bs={};
    for(const[k,p]of Object.entries(bkts)){const w=p.filter(x=>x>0).length;bs[k]={trades:p.length,winRate:p.length?Math.round((w/p.length)*100):null,avgPnl:p.length?parseFloat((p.reduce((a,b)=>a+b,0)/p.length).toFixed(2)):null,totalPnl:parseFloat(p.reduce((a,b)=>a+b,0).toFixed(2))};}
    const ord=[...closed].sort((a,b)=>new Date(a.closed_at)-new Date(b.closed_at));
    let run=1000;const eq=[1000,...ord.map(t=>{run+=parseFloat(t.pnl||0);return parseFloat(run.toFixed(2));})];
    const daily={};closed.forEach(t=>{if(!t.closed_at)return;const d=new Date(t.closed_at).toISOString().slice(0,10);daily[d]=parseFloat(((daily[d]||0)+parseFloat(t.pnl||0)).toFixed(2));});
    const exits={};closed.forEach(t=>{exits[t.exit_reason||"unknown"]=(exits[t.exit_reason||"unknown"]||0)+1;});
    res.json({bankroll:parseFloat((1000+tp).toFixed(2)),totalPnl:parseFloat(tp.toFixed(2)),winRate:parseFloat(wr.toFixed(1)),avgWin:parseFloat(aw.toFixed(2)),avgLoss:parseFloat(al.toFixed(2)),profitFactor:pf?parseFloat(pf.toFixed(2)):null,totalTrades:closed.length,openTrades:open.length,best:best?{ticker:best.ticker,pnl:parseFloat(best.pnl||0),mult:best.exit_mult}:null,buckets:bs,equity:eq,daily,exits,ironDome:{marketMood,dynamicMinScore:dynScore,circuitBroken,dailyPnl:parseFloat(dailyPnl.toFixed(2)),selfTuneCount:tuneCount}});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── START ──────────────────────────────────────────────────
app.listen(PORT,async()=>{
  console.log(`
╔══════════════════════════════════════╗
║       S0NAR — IRON DOME v3.0         ║
╚══════════════════════════════════════╝
Port: ${PORT}
DB:   ${process.env.DATABASE_URL?"✅":"❌ MISSING DATABASE_URL"}
ntfy: ${NTFY_TOPIC?`✅ ${NTFY_TOPIC}`:"⚠️  not set"}
  `);
  await initDB();
  await refreshDaily();
  await updateMood();
  pollSignals();
  setInterval(pollSignals,FETCH_MS);
  setInterval(checkPositions,CHECK_MS);
  setInterval(updateMood,MOOD_MS);
  setInterval(refreshDaily,300000);
});
