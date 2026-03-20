// S0NAR App.jsx v10.0 — 5 Sources × 10 Variants = 50 Slots
import React, { useState, useEffect, useRef } from "react";

const API = "";

// ── COLORS ─────────────────────────────────────────────────
const BG="#060a0d", CARD="#0b1016", BORDER="#12202c", DIM="#2d4a5e";
const G="#00e676", R="#ff1744", Y="#ffd740", B="#40c4ff", O="#ff9100";

const SRC_COLORS = { a:"#ce93d8", b:"#40c4ff", c:"#00e676", d:"#ffd740", e:"#ff9100" };
const SRC_NAMES  = { a:"PUMPPORTAL", b:"HELIUS", c:"DEXSCREENER", d:"JUPITER", e:"HYBRID" };
const VAR_COLORS = { "1":"#ef9a9a","2":"#80cbc4","3":"#ffcc02","4":"#a5d6a7","5":"#ef5350","6":"#26c6da","7":"#ab47bc","8":"#ff7043","9":"#66bb6a","10":"#78909c" };
const VAR_NAMES  = { "1":"ULTRA_SAFE","2":"WAVE","3":"SURGE","4":"STEADY","5":"ROCKET","6":"SNIPER","7":"WHALE","8":"FOMO_RIDER","9":"QUIET","10":"MICRO" };
const SOURCE_KEYS  = ["a","b","c","d","e"];
const VARIANT_KEYS = ["1","2","3","4","5","6","7","8","9","10"];
const ALL_SLOTS    = SOURCE_KEYS.flatMap(s=>VARIANT_KEYS.map(v=>s+v));

// ── UTILS ───────────────────────────────────────────────────
const num  = v => { const n=parseFloat(v); return isNaN(n)?0:n; };
const fix2 = v => num(v).toFixed(2);
const fix1 = v => num(v).toFixed(1);
const fix0 = v => Math.round(num(v)).toString();
const fmt$ = (v,sign=true) => { const n=num(v); return (sign&&n>0?"+":n<0?"-":"")+"$"+Math.abs(n).toFixed(2); };
const fmtK = v => num(v)>=1e6?(num(v)/1e6).toFixed(1)+"M":num(v)>=1e3?(num(v)/1e3).toFixed(1)+"K":Math.round(num(v)).toString();
const sc2c   = s => num(s)>=85?G:num(s)>=75?Y:num(s)>=65?O:R;
const fomo2c = f => num(f)>=75?R:num(f)>=55?O:num(f)>=35?Y:num(f)>=20?"#64ffda":DIM;

// ── BAR ─────────────────────────────────────────────────────
function Bar({ v=0, c=G, max=100 }) {
  return (
    <div style={{background:"#0c1820",height:4,borderRadius:2,overflow:"hidden"}}>
      <div style={{width:`${Math.min(100,(num(v)/Math.max(num(max),1))*100)}%`,height:"100%",background:c,transition:"width .5s"}}/>
    </div>
  );
}

// ── EQUITY CHART ────────────────────────────────────────────
function EqChart({ data=[], color=G, id="" }) {
  const safe=(data||[]).map(v=>num(v));
  if (safe.length<2) return <div style={{height:40,display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,color:DIM}}>No trades yet</div>;
  const min=Math.min(...safe), max=Math.max(...safe), range=max-min||1;
  const W=280, H=40;
  const gid=`eg${color.replace("#","")}${id}`;
  const pts=safe.map((v,i)=>`${(i/(safe.length-1))*W},${H-((v-min)/range)*(H-6)-3}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:H}} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity=".3"/>
          <stop offset="100%" stopColor={color} stopOpacity=".02"/>
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${pts} ${W},${H}`} fill={`url(#${gid})`}/>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5}/>
    </svg>
  );
}

// ── SLOT CARD ───────────────────────────────────────────────
function SlotCard({ stat, isSelected, onClick }) {
  if (!stat) return null;
  const sc=SRC_COLORS[stat.slot[0]]||DIM;
  const vc=VAR_COLORS[stat.slot.slice(1)]||DIM;
  const profit=num(stat.totalPnl)>=0;
  const hasActivity=(stat.totalTrades||0)+(stat.openTrades||0)>0;
  return (
    <div onClick={onClick} style={{background:CARD,border:`1px solid ${isSelected?sc+"88":BORDER}`,borderRadius:8,padding:"8px",cursor:"pointer",borderLeft:`3px solid ${sc}`,transition:"all .2s",opacity:hasActivity?1:0.6}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
        <div style={{minWidth:0}}>
          <div style={{fontSize:6,color:sc,letterSpacing:1}}>{SRC_NAMES[stat.slot[0]]}</div>
          <div style={{fontSize:8,fontWeight:700,color:vc}}>{VAR_NAMES[stat.slot.slice(1)]||stat.slot.slice(1)}</div>
          <div style={{fontSize:6,color:DIM}}>{stat.slot.toUpperCase()}</div>
        </div>
        <div style={{textAlign:"right",flexShrink:0,paddingLeft:4}}>
          <div style={{fontSize:12,fontWeight:900,color:profit?G:R}}>{hasActivity?fmt$(stat.totalPnl):"--"}</div>
        </div>
      </div>
      <EqChart data={stat.equity||[]} color={sc} id={stat.slot}/>
      <div style={{display:"flex",justifyContent:"space-between",marginTop:4,fontSize:7,color:DIM}}>
        <span style={{color:num(stat.winRate)>=50?G:Y}}>{stat.totalTrades>0?`${fix0(stat.winRate)}%WR`:"--"}</span>
        <span>{stat.totalTrades}t·{stat.openTrades}↗</span>
      </div>
    </div>
  );
}

// ── LOGIN ───────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [pw,setPw]=useState(""); const [err,setErr]=useState(""); const [loading,setLoading]=useState(false);
  async function go() {
    if (!pw.trim()) return; setLoading(true); setErr("");
    try {
      const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pw})});
      const d=await r.json();
      if (d.ok&&d.token) { localStorage.setItem("sonar_token",d.token); onLogin(d.token); }
      else setErr("Wrong password");
    } catch { setErr("Server error — try again"); }
    setLoading(false);
  }
  return (
    <div style={{background:BG,minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Courier New',monospace"}}>
      <div style={{width:300,textAlign:"center",padding:"0 20px"}}>
        <div style={{fontSize:26,fontWeight:900,letterSpacing:4,color:G,marginBottom:6}}>◉ S0NAR</div>
        <div style={{fontSize:9,color:DIM,letterSpacing:3,marginBottom:4}}>WAVE RIDER v10.0</div>
        <div style={{fontSize:8,color:SRC_COLORS.a,marginBottom:30}}>5 SOURCES · 50 SLOTS</div>
        <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,padding:"20px"}}>
          <div style={{fontSize:8,color:DIM,letterSpacing:2,marginBottom:12}}>ACCESS CODE</div>
          <input type="password" value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()} placeholder="Enter password" autoFocus
            style={{width:"100%",padding:"12px",background:"#060a0d",border:`1px solid ${err?R:BORDER}`,borderRadius:8,color:"#b0c8d8",fontFamily:"monospace",fontSize:14,outline:"none",marginBottom:8,textAlign:"center",letterSpacing:4}}/>
          {err&&<div style={{fontSize:9,color:R,marginBottom:8}}>{err}</div>}
          <button onClick={go} disabled={loading||!pw.trim()} style={{width:"100%",padding:"12px",background:loading?"#0b1016":G,color:loading?DIM:"#000",border:"none",borderRadius:8,fontFamily:"monospace",fontSize:11,fontWeight:900,letterSpacing:2,cursor:loading?"not-allowed":"pointer"}}>
            {loading?"VERIFYING...":"ENTER"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ROOT ────────────────────────────────────────────────────
export default function App() {
  const [token,setToken]=useState(()=>localStorage.getItem("sonar_token")||"");
  if (!token) return <LoginScreen onLogin={t=>setToken(t)}/>;
  return <AppInner token={token} headers={{"X-Auth-Token":token}} onLogout={()=>{localStorage.removeItem("sonar_token");setToken("");}} />;
}

// ── MAIN ────────────────────────────────────────────────────
function AppInner({ token, headers, onLogout }) {
  const [view,      setView]     = useState("lab");
  const [stats,     setStats]    = useState([]);
  const [trades,    setTrades]   = useState({});
  const [openPnl,   setOpenPnl]  = useState({});
  const [health,    setHealth]   = useState(null);
  const [online,    setOnline]   = useState(false);
  const [lastUp,    setLastUp]   = useState(null);
  const [selSlot,   setSelSlot]  = useState("c7");
  const [wipeModal, setWipeModal]= useState(false);
  const [wipePw,    setWipePw]   = useState("");
  const [wipeMsg,   setWipeMsg]  = useState("");
  const [debugData, setDebugData]= useState(null);
  const [srcFilter, setSrcFilter]= useState("all");
  const selSlotRef=useRef(selSlot); selSlotRef.current=selSlot;

  async function fetchAll() {
    try {
      const [h,s]=await Promise.all([
        fetch(`${API}/health`,    {headers}).then(r=>r.json()),
        fetch(`${API}/api/stats`, {headers}).then(r=>r.json()),
      ]);
      if (h?.error==="Unauthorized") { onLogout(); return; }
      setHealth(h||{}); setStats(Array.isArray(s)?s:[]); setOnline(true); setLastUp(new Date());
    } catch { setOnline(false); }
  }

  async function fetchTrades(slot) {
    if (!slot) return;
    try {
      const t=await fetch(`${API}/api/trades/${slot}?limit=100`,{headers}).then(r=>r.json());
      setTrades(prev=>({...prev,[slot]:Array.isArray(t)?t:[]}));
    } catch {}
  }

  async function fetchOpenPnl() {
    try {
      const p=await fetch(`${API}/api/open-pnl`,{headers}).then(r=>r.json());
      if (p&&typeof p==="object") setOpenPnl(p);
    } catch {}
  }

  async function fetchDebug(slot) {
    try {
      const d=await fetch(`${API}/api/debug/${slot}`,{headers}).then(r=>r.json());
      setDebugData(d);
    } catch {}
  }

  async function doWipe() {
    try {
      const r=await fetch(`${API}/api/wipe`,{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({password:wipePw})});
      const d=await r.json();
      if (d.ok) {
        setWipeMsg("Wiped. Fresh start.");
        setStats([]); setTrades({}); setOpenPnl({});
        setTimeout(()=>{setWipeModal(false);setWipeMsg("");setWipePw("");fetchAll();},2000);
      } else setWipeMsg(d.error||"Failed");
    } catch { setWipeMsg("Server error"); }
  }

  useEffect(()=>{
    fetchAll(); fetchTrades(selSlot); fetchOpenPnl();
    const i1=setInterval(fetchAll,15000);
    const i2=setInterval(fetchOpenPnl,8000);
    const i3=setInterval(()=>fetchTrades(selSlotRef.current),15000);
    return ()=>{ clearInterval(i1); clearInterval(i2); clearInterval(i3); };
  },[]);

  useEffect(()=>{ fetchTrades(selSlot); setDebugData(null); },[selSlot]);

  // Derived state
  const selStat      = stats.find(s=>s.slot===selSlot);
  const selSrc       = selSlot[0];
  const selVar       = selSlot.slice(1);
  const selSrcC      = SRC_COLORS[selSrc]||DIM;
  const selVarC      = VAR_COLORS[selVar]||DIM;
  const selTrades    = trades[selSlot]||[];
  const selPnl       = openPnl[selSlot]||[];
  const selPnlMap    = new Map(selPnl.map(p=>[p.pair_address,p]));
  const openTrades   = selTrades.filter(t=>t.status==="OPEN").sort((a,b)=>num(b.fomo_score)-num(a.fomo_score));
  const closedTrades = selTrades.filter(t=>t.status==="CLOSED");
  const totalUnrealized = selPnl.reduce((a,p)=>a+num(p.upnl||0),0);
  const withTrades   = stats.filter(s=>s.totalTrades>0);
  const bestSlot     = withTrades.length?[...withTrades].sort((a,b)=>num(b.totalPnl)-num(a.totalPnl))[0]:null;
  const totalPnlAll  = stats.reduce((a,s)=>a+num(s.totalPnl),0);
  const totalTradesAll=stats.reduce((a,s)=>a+s.totalTrades,0);
  const totalOpenAll = stats.reduce((a,s)=>a+s.openTrades,0);
  const visibleStats = srcFilter==="all"?stats:stats.filter(s=>s.slot[0]===srcFilter);

  const srcSummary=SOURCE_KEYS.map(k=>({
    key:k, color:SRC_COLORS[k],
    pnl:   stats.filter(s=>s.slot[0]===k).reduce((a,s)=>a+num(s.totalPnl),0),
    trades:stats.filter(s=>s.slot[0]===k).reduce((a,s)=>a+s.totalTrades,0),
    open:  stats.filter(s=>s.slot[0]===k).reduce((a,s)=>a+s.openTrades,0),
    ok:    health?.sources?.[k]?.ok,
    connected:health?.sources?.[k]?.connected||null,
    tokens:health?.sources?.[k]?.tokens||0,
  }));

  return (
    <div style={{background:BG,minHeight:"100vh",color:"#b0c8d8",fontFamily:"'Courier New',monospace",maxWidth:430,width:"100%",margin:"0 auto",display:"flex",flexDirection:"column",overflowX:"hidden",WebkitTextSizeAdjust:"100%"}}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        html,body{overflow-x:hidden;width:100%;-webkit-text-size-adjust:100%}
        ::-webkit-scrollbar{width:2px}
        ::-webkit-scrollbar-thumb{background:${BORDER}}
        @keyframes glow{0%,100%{opacity:1}50%{opacity:.45}}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:.1}}
        .btn{cursor:pointer;border:none;font-family:monospace;transition:all .15s;-webkit-tap-highlight-color:transparent}
        a{color:inherit;text-decoration:none;-webkit-tap-highlight-color:transparent}
      `}</style>

      {/* HEADER */}
      <div style={{padding:"10px 12px 8px",borderBottom:`1px solid ${BORDER}`,background:CARD,position:"sticky",top:0,zIndex:10}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div style={{minWidth:0,flex:1}}>
            <div style={{fontSize:15,fontWeight:900,letterSpacing:3,color:G,animation:"glow 4s ease-in-out infinite"}}>◉ S0NAR</div>
            <div style={{display:"flex",alignItems:"center",gap:5,marginTop:2,flexWrap:"wrap"}}>
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <div style={{width:6,height:6,borderRadius:"50%",background:online?G:R,animation:"blink 1.8s infinite",flexShrink:0}}/>
                <span style={{fontSize:7,color:DIM}}>{online?`LIVE · ${lastUp?.toLocaleTimeString()}`:"OFFLINE"}</span>
              </div>
              {health?.marketMood&&<span style={{fontSize:7,padding:"1px 5px",borderRadius:6,background:"#ffd74018",color:Y,border:"1px solid #ffd74044"}}>{health.marketMood.toUpperCase()}</span>}
              {SOURCE_KEYS.map(k=>(
                <div key={k} title={SRC_NAMES[k]} style={{width:5,height:5,borderRadius:"50%",background:health?.sources?.[k]?.ok?SRC_COLORS[k]:DIM,opacity:health?.sources?.[k]?.ok?1:0.3}}/>
              ))}
            </div>
          </div>
          <div style={{textAlign:"right",flexShrink:0,paddingLeft:8}}>
            <div style={{fontSize:7,color:DIM}}>50 SLOTS</div>
            <div style={{fontSize:10,fontWeight:900,color:G}}>v10.0</div>
            <button onClick={onLogout} style={{fontSize:6,color:DIM,background:"transparent",border:"none",cursor:"pointer",letterSpacing:1}}>LOCK</button>
          </div>
        </div>
      </div>

      {/* TABS */}
      <div style={{display:"flex",background:CARD,borderBottom:`1px solid ${BORDER}`,overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
        {[["lab","LAB"],["trades","TRADES"],["sources","SOURCES"],["debug","DEBUG"],["settings","⚙"]].map(([v,l])=>(
          <button key={v} className="btn" onClick={()=>{setView(v);if(v==="debug")fetchDebug(selSlot);}}
            style={{flex:"0 0 auto",padding:"8px 10px",fontSize:8,color:view===v?G:DIM,borderBottom:`2px solid ${view===v?G:"transparent"}`,background:"transparent",whiteSpace:"nowrap"}}>
            {l}
          </button>
        ))}
      </div>

      {/* SLOT SELECTOR */}
      <div style={{borderBottom:`1px solid ${BORDER}`,background:CARD}}>
        <div style={{display:"flex",gap:4,padding:"5px 10px 0",overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
          <button className="btn" onClick={()=>setSrcFilter("all")} style={{flex:"0 0 auto",padding:"3px 7px",fontSize:7,borderRadius:10,background:srcFilter==="all"?"#ffffff22":CARD,color:srcFilter==="all"?"white":DIM,border:`1px solid ${srcFilter==="all"?"#ffffff44":BORDER}`}}>ALL</button>
          {SOURCE_KEYS.map(k=>(
            <button key={k} className="btn" onClick={()=>setSrcFilter(k)} style={{flex:"0 0 auto",padding:"3px 7px",fontSize:7,borderRadius:10,background:srcFilter===k?`${SRC_COLORS[k]}22`:CARD,color:srcFilter===k?SRC_COLORS[k]:DIM,border:`1px solid ${srcFilter===k?SRC_COLORS[k]+"66":BORDER}`}}>
              {SRC_NAMES[k].slice(0,4)}
            </button>
          ))}
        </div>
        <div style={{display:"flex",gap:3,padding:"4px 10px 6px",overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
          {(srcFilter==="all"?ALL_SLOTS:ALL_SLOTS.filter(s=>s[0]===srcFilter)).map(slot=>{
            const sc=SRC_COLORS[slot[0]]||DIM;
            const isSel=selSlot===slot;
            const s=stats.find(st=>st.slot===slot);
            const hasData=(s?.totalTrades||0)+(s?.openTrades||0)>0;
            return (
              <button key={slot} className="btn" onClick={()=>setSelSlot(slot)}
                style={{flex:"0 0 auto",padding:"3px 5px",fontSize:7,borderRadius:5,background:isSel?`${sc}22`:CARD,color:isSel?sc:hasData?"#b0c8d8":DIM,border:`1px solid ${isSel?sc+"66":hasData?BORDER+"88":BORDER}`,fontWeight:isSel?900:400}}>
                {slot.toUpperCase()}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── LAB ── */}
      {view==="lab"&&(
        <div style={{flex:1,padding:"10px 12px",overflowY:"auto"}}>
          {bestSlot&&num(bestSlot.totalPnl)>0&&(
            <div style={{background:`${SRC_COLORS[bestSlot.slot[0]]}0c`,border:`1px solid ${SRC_COLORS[bestSlot.slot[0]]}44`,borderRadius:10,padding:"8px 12px",marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontSize:7,color:SRC_COLORS[bestSlot.slot[0]],letterSpacing:2}}>LEADING</div>
                <div style={{fontSize:12,fontWeight:900,color:"white"}}>{bestSlot.slot.toUpperCase()} · {SRC_NAMES[bestSlot.slot[0]]} · {VAR_NAMES[bestSlot.slot.slice(1)]}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:18,fontWeight:900,color:G}}>{fmt$(bestSlot.totalPnl)}</div>
                <div style={{fontSize:8,color:DIM}}>{bestSlot.totalTrades>0?`${fix0(bestSlot.winRate)}% WR · ${bestSlot.totalTrades}t`:"--"}</div>
              </div>
            </div>
          )}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginBottom:10}}>
            {[
              {l:"TOTAL P&L",   v:fmt$(totalPnlAll),   c:totalPnlAll>=0?G:R},
              {l:"TOTAL TRADES",v:totalTradesAll,       c:"white"},
              {l:"OPEN NOW",    v:totalOpenAll,         c:Y},
            ].map(item=>(
              <div key={item.l} style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:8,padding:"8px",textAlign:"center"}}>
                <div style={{fontSize:6,color:DIM,marginBottom:2}}>{item.l}</div>
                <div style={{fontSize:14,fontWeight:900,color:item.c}}>{item.v}</div>
              </div>
            ))}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:10}}>
            {visibleStats.map(s=>(
              <SlotCard key={s.slot} stat={s} isSelected={selSlot===s.slot}
                onClick={()=>{setSelSlot(s.slot);setView("trades");fetchTrades(s.slot);}}/>
            ))}
          </div>
          {visibleStats.length===0&&<div style={{textAlign:"center",padding:"40px",color:DIM,fontSize:9}}>{online?"Waiting for first trades...":"Server offline"}</div>}
          <button className="btn" onClick={fetchAll} style={{width:"100%",padding:"8px",background:"transparent",border:`1px solid ${BORDER}`,color:DIM,borderRadius:8,fontSize:9,letterSpacing:2}}>↻ REFRESH</button>
        </div>
      )}

      {/* ── TRADES ── */}
      {view==="trades"&&(
        <div style={{flex:1,padding:"10px 12px",overflowY:"auto"}}>
          {selStat&&(
            <div style={{background:CARD,border:`1px solid ${selSrcC}33`,borderRadius:10,padding:"10px",marginBottom:10,borderLeft:`3px solid ${selSrcC}`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
                <div>
                  <div style={{fontSize:7,color:selSrcC,letterSpacing:2}}>{SRC_NAMES[selSrc]} · {VAR_NAMES[selVar]||selVar}</div>
                  <div style={{fontSize:6,color:DIM,marginTop:1}}>slot {selSlot.toUpperCase()}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:20,fontWeight:900,color:num(selStat.totalPnl)>=0?G:R}}>{fmt$(selStat.totalPnl)}</div>
                  <div style={{fontSize:8,color:DIM}}>{selStat.totalTrades>0?`${fix0(selStat.winRate)}% WR · ${selStat.totalTrades}t · ${selStat.openTrades} open`:"no trades yet"}</div>
                </div>
              </div>
              <EqChart data={selStat.equity||[]} color={selSrcC} id={`sel${selSlot}`}/>
              <div style={{display:"flex",justifyContent:"space-between",marginTop:6,fontSize:7,color:DIM}}>
                <span>$1,000 start</span>
                <span style={{color:selVarC}}>{VAR_NAMES[selVar]}</span>
                <span style={{color:num(selStat.profitFactor)>=2?G:Y}}>{selStat.profitFactor?`${fix2(selStat.profitFactor)}x PF`:"--"}</span>
              </div>
            </div>
          )}

          {openTrades.length>0&&(
            <>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{fontSize:8,color:G,letterSpacing:2}}>OPEN · {openTrades.length}</div>
                {totalUnrealized!==0&&<div style={{fontSize:11,fontWeight:900,color:totalUnrealized>=0?G:R}}>{totalUnrealized>=0?"+":""}{fmt$(totalUnrealized,false)} unreal.</div>}
              </div>
              {openTrades.map(t=>{
                const live=selPnlMap.get(t.pair_address);
                const hasPnl=live&&live.upnl!=null;
                const pct=hasPnl?num(live.pct):null;
                const upnl=hasPnl?num(live.upnl):null;
                const hiMult=hasPnl?num(live.highest_mult):num(t.highest_mult||1);
                const ageMin=hasPnl?num(live.age_min):(Date.now()-new Date(t.opened_at).getTime())/60000;
                return (
                  <div key={t.id} style={{background:CARD,border:`1px solid ${selSrcC}33`,borderRadius:10,padding:"10px",marginBottom:8,borderLeft:`3px solid ${selSrcC}`}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                      <div>
                        <span style={{fontSize:13,fontWeight:900,color:"white"}}>{t.ticker}</span>
                        {t.dex_url&&<a href={t.dex_url} target="_blank" rel="noopener" style={{fontSize:8,color:B,marginLeft:8}}>↗</a>}
                      </div>
                      <span style={{fontSize:8,color:G,animation:"blink 1.2s infinite"}}>● LIVE</span>
                    </div>
                    {hasPnl?(
                      <div style={{background:"#090f17",borderRadius:8,padding:"8px",marginBottom:6}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <div><div style={{fontSize:6,color:DIM,marginBottom:2}}>UNREALIZED</div><div style={{fontSize:16,fontWeight:900,color:upnl>=0?G:R}}>{upnl>=0?"+":""}{fmt$(upnl,false)}</div></div>
                          <div style={{textAlign:"center"}}><div style={{fontSize:6,color:DIM,marginBottom:2}}>NOW</div><div style={{fontSize:13,fontWeight:900,color:pct>=0?G:R}}>{pct>=0?"+":""}{fix1(pct)}%</div></div>
                          <div style={{textAlign:"right"}}><div style={{fontSize:6,color:DIM,marginBottom:2}}>PEAK</div><div style={{fontSize:13,fontWeight:900,color:G}}>{fix2(hiMult)}x</div></div>
                        </div>
                      </div>
                    ):(
                      <div style={{background:"#090f17",borderRadius:8,padding:"6px",marginBottom:6,fontSize:8,color:DIM,textAlign:"center"}}>Fetching price...</div>
                    )}
                    <div style={{display:"flex",gap:8,fontSize:7,color:DIM,flexWrap:"wrap"}}>
                      <span>sc:<span style={{color:sc2c(t.score)}}>{t.score}</span></span>
                      <span>fomo:<span style={{color:fomo2c(t.fomo_score)}}>{t.fomo_score||0}</span></span>
                      <span>bet:${parseFloat(t.bet_size||0).toFixed(0)}</span>
                      <span>age:{ageMin.toFixed(0)}m</span>
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {closedTrades.length>0&&(
            <>
              <div style={{fontSize:8,color:DIM,letterSpacing:2,margin:"10px 0 8px"}}>CLOSED · {closedTrades.length}</div>
              {[...closedTrades].reverse().map(t=>(
                <div key={t.id} style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,padding:"10px",marginBottom:6,borderLeft:`3px solid ${num(t.pnl)>0?G:R}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <span style={{fontSize:12,fontWeight:900,color:"white"}}>{t.ticker}</span>
                      {t.dex_url&&<a href={t.dex_url} target="_blank" rel="noopener" style={{fontSize:8,color:B,marginLeft:6}}>↗</a>}
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:14,fontWeight:900,color:num(t.pnl)>0?G:R}}>{fmt$(t.pnl)}</div>
                      <div style={{fontSize:7,color:DIM}}>{fix2(t.exit_mult)}x · {t.exit_reason}</div>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:8,marginTop:4,fontSize:7,color:DIM,flexWrap:"wrap"}}>
                    <span>sc:<span style={{color:sc2c(t.score)}}>{t.score}</span></span>
                    <span>fomo:<span style={{color:fomo2c(t.fomo_score)}}>{t.fomo_score||0}</span></span>
                    <span>bet:${parseFloat(t.bet_size||0).toFixed(0)}</span>
                    <span>hi:{fix2(t.highest_mult)}x</span>
                  </div>
                  <div style={{fontSize:6,color:DIM,marginTop:3}}>
                    {t.opened_at?new Date(t.opened_at).toLocaleTimeString():""} → {t.closed_at?new Date(t.closed_at).toLocaleTimeString():"—"}
                  </div>
                </div>
              ))}
            </>
          )}

          {selTrades.length===0&&<div style={{textAlign:"center",padding:"40px 20px",color:DIM,fontSize:9}}>{online?`${selSlot.toUpperCase()} scanning...`:"Server offline"}</div>}
        </div>
      )}

      {/* ── SOURCES ── */}
      {view==="sources"&&(
        <div style={{flex:1,padding:"10px 12px",overflowY:"auto"}}>
          <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:12}}>SOURCE COMPARISON</div>
          {srcSummary.map(src=>(
            <div key={src.key} style={{background:CARD,border:`1px solid ${src.color}33`,borderRadius:10,padding:"12px",marginBottom:10,borderLeft:`3px solid ${src.color}`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div>
                  <div style={{fontSize:10,fontWeight:900,color:src.color}}>{SRC_NAMES[src.key]}</div>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginTop:3}}>
                    {src.connected!==null&&(
                      <span style={{fontSize:7,padding:"1px 5px",borderRadius:4,background:src.connected?`${G}18`:`${R}18`,color:src.connected?G:R,border:`1px solid ${src.connected?G:R}44`}}>
                        {src.connected?"WS LIVE":"WS OFFLINE"}
                      </span>
                    )}
                    {src.ok===false&&<span style={{fontSize:7,color:R}}>429/ERR</span>}
                    {src.tokens>0&&<span style={{fontSize:7,color:DIM}}>{src.tokens} rcvd</span>}
                  </div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:16,fontWeight:900,color:src.pnl>=0?G:R}}>{fmt$(src.pnl)}</div>
                  <div style={{fontSize:8,color:DIM}}>{src.trades}t · {src.open} open</div>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:4}}>
                {VARIANT_KEYS.map(vk=>{
                  const slot=src.key+vk;
                  const s=stats.find(st=>st.slot===slot);
                  const vc=VAR_COLORS[vk]||DIM;
                  const pnl=s?num(s.totalPnl):0;
                  const hasData=(s?.totalTrades||0)+(s?.openTrades||0)>0;
                  return (
                    <div key={vk} onClick={()=>{setSelSlot(slot);setView("trades");fetchTrades(slot);}}
                      style={{background:"#090f17",borderRadius:6,padding:"5px 3px",textAlign:"center",cursor:"pointer",border:`1px solid ${selSlot===slot?vc+"66":BORDER}`}}>
                      <div style={{fontSize:6,color:vc,marginBottom:2}}>{VAR_NAMES[vk].slice(0,4)}</div>
                      <div style={{fontSize:9,fontWeight:900,color:pnl>0?G:pnl<0?R:DIM}}>{hasData?fmt$(pnl):"--"}</div>
                      <div style={{fontSize:6,color:DIM}}>{s?.totalTrades||0}t</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,padding:"12px"}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:10}}>VARIANT LEADERBOARD</div>
            {VARIANT_KEYS.map(vk=>{
              const vSlots=stats.filter(s=>s.slot.slice(1)===vk);
              const tp=vSlots.reduce((a,s)=>a+num(s.totalPnl),0);
              const tt=vSlots.reduce((a,s)=>a+s.totalTrades,0);
              const vc=VAR_COLORS[vk]||DIM;
              const maxPnl=Math.max(...VARIANT_KEYS.map(v=>Math.abs(stats.filter(s=>s.slot.slice(1)===v).reduce((a,s)=>a+num(s.totalPnl),0))),1);
              return (
                <div key={vk} style={{display:"flex",alignItems:"center",gap:8,marginBottom:7}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:vc,flexShrink:0}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:8,fontWeight:700,color:vc,marginBottom:2}}>{VAR_NAMES[vk]}</div>
                    <Bar v={Math.max(0,tp)} c={vc} max={maxPnl}/>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <div style={{fontSize:12,fontWeight:900,color:tp>=0?G:R}}>{fmt$(tp)}</div>
                    <div style={{fontSize:7,color:DIM}}>{tt}t</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── DEBUG ── */}
      {view==="debug"&&(
        <div style={{flex:1,padding:"10px 12px",overflowY:"auto"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2}}>DEBUG — {selSlot.toUpperCase()}</div>
            <button className="btn" onClick={()=>fetchDebug(selSlot)} style={{fontSize:8,color:B,background:"transparent",border:`1px solid ${B}44`,padding:"3px 8px",borderRadius:4}}>↻</button>
          </div>
          {!debugData&&<div style={{textAlign:"center",padding:"40px",color:DIM,fontSize:9}}>Tap refresh to load</div>}
          {debugData&&(
            <>
              <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,padding:"12px",marginBottom:10}}>
                <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:8}}>ACTIVE RULES — {debugData.variant||selSlot}</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  {[
                    {l:"SCORE",  v:`${debugData.config?.minScore??'?'}-${debugData.config?.maxScore??'?'}`,         c:selSrcC},
                    {l:"FOMO",   v:`${debugData.config?.minFomo??'?'}-${debugData.config?.maxFomo??'?'}`,           c:O},
                    {l:"MIN LIQ",v:`$${fmtK(debugData.config?.minLiq||0)}`,                                         c:B},
                    {l:"MIN VOL",v:`$${fmtK(debugData.config?.minVol5m||0)}`,                                       c:B},
                    {l:"AGE",    v:`${debugData.config?.minAge??'?'}-${debugData.config?.maxAge??'?'}m`,            c:Y},
                    {l:"PC5M",   v:`${debugData.config?.minPc5m??'?'}% to ${debugData.config?.maxPc5m??'?'}%`,     c:Y},
                  ].map(s=>(
                    <div key={s.l} style={{textAlign:"center"}}>
                      <div style={{fontSize:6,color:DIM}}>{s.l}</div>
                      <div style={{fontSize:11,fontWeight:900,color:s.c}}>{s.v}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,padding:"12px"}}>
                <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:8}}>LAST HOUR SIGNALS</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:10}}>
                  {[
                    {l:"SEEN",    v:debugData.total||0,   c:"white"},
                    {l:"ENTERED", v:debugData.entered||0, c:G},
                    {l:"SKIPPED", v:(debugData.total||0)-(debugData.entered||0), c:R},
                  ].map(s=>(
                    <div key={s.l} style={{textAlign:"center"}}>
                      <div style={{fontSize:6,color:DIM}}>{s.l}</div>
                      <div style={{fontSize:14,fontWeight:900,color:s.c}}>{s.v}</div>
                    </div>
                  ))}
                </div>
                <div style={{fontSize:7,color:DIM,marginBottom:6}}>TOP SKIP REASONS</div>
                {(debugData.top3||[]).map(([reason,count])=>(
                  <div key={reason} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                    <span style={{fontSize:8,color:R,flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{reason}</span>
                    <span style={{fontSize:8,color:DIM,flexShrink:0,marginLeft:8}}>{count}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── SETTINGS ── */}
      {view==="settings"&&(
        <div style={{flex:1,padding:"10px 12px",overflowY:"auto"}}>
          <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:12}}>SETTINGS</div>
          <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,padding:"12px",marginBottom:10}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:10}}>SOURCES</div>
            {SOURCE_KEYS.map(k=>(
              <div key={k} style={{display:"flex",gap:8,alignItems:"center",marginBottom:8}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:SRC_COLORS[k],flexShrink:0}}/>
                <div style={{flex:1}}>
                  <div style={{fontSize:9,fontWeight:700,color:SRC_COLORS[k]}}>{SRC_NAMES[k]}</div>
                  <div style={{fontSize:7,color:DIM}}>
                    {k==="a"&&"PumpPortal WS — push, no 429s"}
                    {k==="b"&&"Helius WS — Solana native push"}
                    {k==="c"&&"DexScreener polling — control"}
                    {k==="d"&&"Jupiter API — alt REST"}
                    {k==="e"&&"DexScreener Boosted — premium"}
                  </div>
                </div>
                <span style={{fontSize:7,padding:"2px 5px",borderRadius:4,background:health?.sources?.[k]?.ok?`${G}18`:`${R}18`,color:health?.sources?.[k]?.ok?G:R}}>{health?.sources?.[k]?.ok?"OK":"ERR"}</span>
              </div>
            ))}
          </div>
          <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,padding:"12px",marginBottom:10}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:8}}>VARIANTS</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4}}>
              {VARIANT_KEYS.map(vk=>(
                <div key={vk} style={{display:"flex",gap:6,alignItems:"center"}}>
                  <div style={{width:6,height:6,borderRadius:"50%",background:VAR_COLORS[vk],flexShrink:0}}/>
                  <span style={{fontSize:8,color:VAR_COLORS[vk]}}>{VAR_NAMES[vk]}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{background:CARD,border:`1px solid ${R}33`,borderRadius:10,padding:"12px",marginBottom:10}}>
            <div style={{fontSize:7,color:R,letterSpacing:2,marginBottom:6}}>DANGER ZONE</div>
            <button className="btn" onClick={()=>setWipeModal(true)} style={{width:"100%",padding:"10px",background:`${R}18`,color:R,borderRadius:8,fontSize:10,fontWeight:900,letterSpacing:2,border:`1px solid ${R}44`}}>WIPE ALL DATA</button>
            <div style={{fontSize:8,color:DIM,marginTop:6,textAlign:"center"}}>Clears all 50 slot trade histories. Cannot be undone.</div>
          </div>
          <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,padding:"12px"}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:6}}>VERSION</div>
            <div style={{fontSize:9,color:"white"}}>S0NAR Wave Rider v10.0</div>
            <div style={{fontSize:8,color:DIM,marginTop:4}}>5 sources · 10 variants · 50 slots</div>
            <div style={{fontSize:8,color:DIM,marginTop:2}}>Poll:20s · Check:25s · WS:live</div>
          </div>
        </div>
      )}

      {/* WIPE MODAL */}
      {wipeModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,padding:"20px"}}>
          <div style={{background:CARD,border:`1px solid ${R}44`,borderRadius:12,padding:"20px",width:"100%",maxWidth:320}}>
            <div style={{fontSize:12,fontWeight:900,color:R,marginBottom:8,textAlign:"center"}}>WIPE ALL DATA</div>
            <div style={{fontSize:9,color:DIM,marginBottom:16,textAlign:"center"}}>Deletes all 50 slot histories. Enter password to confirm.</div>
            <input type="password" value={wipePw} onChange={e=>setWipePw(e.target.value)} placeholder="Confirm password"
              style={{width:"100%",padding:"10px",background:"#060a0d",border:`1px solid ${BORDER}`,borderRadius:8,color:"#b0c8d8",fontFamily:"monospace",fontSize:12,outline:"none",marginBottom:8,textAlign:"center",letterSpacing:4}}/>
            {wipeMsg&&<div style={{fontSize:9,color:wipeMsg.includes("Wiped")?G:R,marginBottom:8,textAlign:"center"}}>{wipeMsg}</div>}
            <div style={{display:"flex",gap:8}}>
              <button className="btn" onClick={()=>{setWipeModal(false);setWipePw("");setWipeMsg("");}} style={{flex:1,padding:"10px",background:"transparent",color:DIM,border:`1px solid ${BORDER}`,borderRadius:8,fontSize:10}}>CANCEL</button>
              <button className="btn" onClick={doWipe} disabled={!wipePw.trim()} style={{flex:1,padding:"10px",background:`${R}22`,color:R,border:`1px solid ${R}44`,borderRadius:8,fontSize:10,fontWeight:900}}>WIPE</button>
            </div>
          </div>
        </div>
      )}

      <div style={{padding:"5px",borderTop:`1px solid ${BORDER}`,background:CARD,fontSize:6,color:"#0c1820",textAlign:"center"}}>
        S0NAR v10.0 · 5 SOURCES · 50 SLOTS · PAPER TRADING · NOT FINANCIAL ADVICE
      </div>
    </div>
  );
}

// end of App.jsx v10.0
