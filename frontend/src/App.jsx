// S0NAR App.jsx v5.4 — Stealth Score detection + iOS optimized
import { useState, useEffect } from "react";

// ── CONSTANTS (declared first — used throughout) ───────────
const TIER1 = 1.5, TIER2 = 3.0, TIER3 = 6.0, MAX_HOLD = 120;

// API points to Render backend
const API = "https://s0nar-backend.onrender.com";

// Colors
const G="#00e676", R="#ff1744", Y="#ffd740", B="#40c4ff";
const P="#ce93d8", O="#ff9100", T="#64ffda";
const BG="#060a0d", CARD="#0b1016", BORDER="#12202c", DIM="#2d4a5e";

// ── UTILS ──────────────────────────────────────────────────
const num   = v => { const n=parseFloat(v); return isNaN(n)?0:n; };
const fix2  = v => num(v).toFixed(2);
const fix1  = v => num(v).toFixed(1);
const fix0  = v => Math.round(num(v)).toString();
const fmt$  = (v,sign=true) => (sign&&num(v)>0?"+":"")+"$"+Math.abs(num(v)).toFixed(2);
const fmtK  = v => num(v)>=1e6?(num(v)/1e6).toFixed(1)+"M":num(v)>=1e3?(num(v)/1e3).toFixed(1)+"K":Math.round(num(v)).toString();
const sc2c  = s => num(s)>=85?G:num(s)>=75?Y:num(s)>=65?O:R;
const mood2c = m => m==="frenzy"?P:m==="hot"?G:m==="warm"?T:m==="cold"?B:m==="dead"?R:Y;
const fomo2c = f => num(f)>=75?R:num(f)>=55?O:num(f)>=35?Y:num(f)>=20?T:DIM;
const fomo2lbl = f => num(f)>=75?"FRENZY":num(f)>=55?"HIGH":num(f)>=35?"BUILDING":num(f)>=20?"LOW":"COLD";

// ── COMPONENTS ─────────────────────────────────────────────
function Bar({ v=0, c=G, max=100 }) {
  return (
    <div style={{background:"#0c1820",height:4,borderRadius:2,overflow:"hidden"}}>
      <div style={{width:`${Math.min(100,(num(v)/Math.max(num(max),1))*100)}%`,height:"100%",background:c,transition:"width .5s"}}/>
    </div>
  );
}

function FomoBar({ v=0 }) {
  const c = fomo2c(v);
  return (
    <div style={{background:"#0c1820",height:5,borderRadius:3,overflow:"hidden"}}>
      <div style={{width:`${Math.min(100,num(v))}%`,height:"100%",background:c,transition:"width .4s"}}/>
    </div>
  );
}

function Ring({ s=0, size=48 }) {
  const sc=Math.round(num(s)), c=sc2c(sc), r=size/2-5;
  const circ=2*Math.PI*r, fill=(sc/100)*circ;
  return (
    <div style={{position:"relative",width:size,height:size,flexShrink:0}}>
      <svg width={size} height={size} style={{transform:"rotate(-90deg)",position:"absolute"}}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#0c1820" strokeWidth={4}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={c} strokeWidth={4}
          strokeDasharray={`${fill} ${circ}`} strokeLinecap="round"/>
      </svg>
      <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
        <span style={{color:c,fontSize:size/3.5,fontWeight:900,fontFamily:"monospace"}}>{sc}</span>
      </div>
    </div>
  );
}

function FomoRing({ f=0, size=40 }) {
  const fc=Math.round(num(f)), c=fomo2c(fc), r=size/2-4;
  const circ=2*Math.PI*r, fill=(fc/100)*circ;
  return (
    <div style={{position:"relative",width:size,height:size,flexShrink:0}}>
      <svg width={size} height={size} style={{transform:"rotate(-90deg)",position:"absolute"}}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#0c1820" strokeWidth={3}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={c} strokeWidth={3}
          strokeDasharray={`${fill} ${circ}`} strokeLinecap="round"/>
      </svg>
      <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column"}}>
        <span style={{color:c,fontSize:size/3.8,fontWeight:900,fontFamily:"monospace",lineHeight:1}}>{fc}</span>
        <span style={{color:c,fontSize:6,opacity:.8}}>FOMO</span>
      </div>
    </div>
  );
}

function Tag({ on, label, c }) {
  return (
    <span style={{fontSize:8,padding:"2px 6px",borderRadius:8,whiteSpace:"nowrap",
      background:on?`${c}18`:"#0c1820",color:on?c:DIM,border:`1px solid ${on?c+"44":BORDER}`}}>
      {label}
    </span>
  );
}

function EqChart({ data=[], color=G }) {
  const safe = (data||[]).map(v=>num(v));
  if (safe.length < 2) return (
    <div style={{height:64,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:DIM}}>
      Building equity curve...
    </div>
  );
  const min=Math.min(...safe), max=Math.max(...safe), range=max-min||1;
  const W=300, H=64;
  const pts = safe.map((v,i)=>`${(i/(safe.length-1))*W},${H-((v-min)/range)*(H-8)-4}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:H}} preserveAspectRatio="none">
      <defs>
        <linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity=".3"/>
          <stop offset="100%" stopColor={color} stopOpacity=".02"/>
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${pts} ${W},${H}`} fill="url(#eg)"/>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2}/>
    </svg>
  );
}

function StatCard({ label, value, color="white" }) {
  return (
    <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,padding:"10px 6px",textAlign:"center"}}>
      <div style={{fontSize:6,color:DIM,marginBottom:3}}>{label}</div>
      <div style={{fontSize:14,fontWeight:900,color,fontFamily:"monospace"}}>{value}</div>
    </div>
  );
}

// ── LOGIN SCREEN ───────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [pw,  setPw]  = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    if (!pw.trim()) return;
    setLoading(true); setErr("");
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const d = await r.json();
      if (d.ok && d.token) {
        localStorage.setItem("sonar_token", d.token);
        onLogin(d.token);
      } else {
        setErr("Wrong password");
      }
    } catch {
      setErr("Server error — try again");
    }
    setLoading(false);
  }

  return (
    <div style={{background:"#060a0d",minHeight:"100vh",display:"flex",alignItems:"center",
      justifyContent:"center",fontFamily:"'Courier New',monospace"}}>
      <div style={{width:300,textAlign:"center"}}>
        <div style={{fontSize:28,fontWeight:900,letterSpacing:4,color:"#00e676",marginBottom:8}}>◉ S0NAR</div>
        <div style={{fontSize:10,color:"#2d4a5e",letterSpacing:3,marginBottom:40}}>IRON DOME v5.3</div>

        <div style={{background:"#0b1016",border:"1px solid #12202c",borderRadius:12,padding:"24px"}}>
          <div style={{fontSize:9,color:"#2d4a5e",letterSpacing:2,marginBottom:16}}>ACCESS CODE</div>
          <input
            type="password"
            value={pw}
            onChange={e=>setPw(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&handleLogin()}
            placeholder="Enter password"
            autoFocus
            style={{
              width:"100%",padding:"12px",background:"#060a0d",
              border:`1px solid ${err?"#ff1744":"#12202c"}`,
              borderRadius:8,color:"#b0c8d8",fontFamily:"monospace",
              fontSize:14,outline:"none",marginBottom:8,textAlign:"center",
              letterSpacing:4,
            }}
          />
          {err && <div style={{fontSize:9,color:"#ff1744",marginBottom:8}}>{err}</div>}
          <button
            onClick={handleLogin}
            disabled={loading||!pw.trim()}
            style={{
              width:"100%",padding:"12px",background:loading?"#0b1016":"#00e676",
              color:loading?"#2d4a5e":"#000",border:"none",borderRadius:8,
              fontFamily:"monospace",fontSize:11,fontWeight:900,letterSpacing:2,
              cursor:loading?"not-allowed":"pointer",transition:"all .15s",
            }}
          >
            {loading ? "VERIFYING..." : "ENTER"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── APP ────────────────────────────────────────────────────
export default function App() {
  // Check for stored token on load
  const [token, setToken] = useState(() => localStorage.getItem("sonar_token") || "");

  function handleLogin(t) { setToken(t); }
  function handleLogout() { localStorage.removeItem("sonar_token"); setToken(""); }

  // Auth headers for every API call
  const headers = { "X-Auth-Token": token };

  // Show login if no token
  if (!token) return <LoginScreen onLogin={handleLogin}/>;

  return <AppInner token={token} headers={headers} onLogout={handleLogout}/>;
}

function AppInner({ token, headers, onLogout }) {
  const [view,   setView]   = useState("home");
  const [stats,  setStats]  = useState(null);
  const [trades, setTrades] = useState([]);
  const [signals,setSigs]   = useState([]);
  const [feed,   setFeed]   = useState([]);
  const [debug,  setDebug]  = useState(null);
  const [health, setHealth] = useState(null);
  const [online, setOnline] = useState(false);
  const [lastUp, setLastUp] = useState(null);
  const [openPnl,setOpenPnl]= useState([]); // Live unrealized P&L
  const [btRun,  setBtRun]  = useState(false);
  const [btRes,  setBtRes]  = useState(null);
  const [btErr,  setBtErr]  = useState(null);
  const [btFilt, setBtFilt] = useState("all");
  const [btSort, setBtSort] = useState("fomo");

  async function fetchAll() {
    try {
      const [h, s, t, si, ff] = await Promise.all([
        fetch(`${API}/health`,                  { headers }).then(r=>r.json()),
        fetch(`${API}/api/stats`,               { headers }).then(r=>r.json()),
        fetch(`${API}/api/trades?limit=500`,    { headers }).then(r=>r.json()),
        fetch(`${API}/api/signals?limit=200`,   { headers }).then(r=>r.json()),
        fetch(`${API}/api/fomo-feed`,           { headers }).then(r=>r.json()).catch(()=>[]),
      ]);
      // If any call returns 401, token is invalid — log out
      if (h?.error === "Unauthorized") { onLogout(); return; }
      setHealth(h||{});
      setStats(s||{});
      setTrades(Array.isArray(t)?t:[]);
      setSigs(Array.isArray(si)?si:[]);
      setFeed(Array.isArray(ff)?ff:[]);
      setOnline(true);
      setLastUp(new Date());
    } catch { setOnline(false); }
  }

  // Fetch live P&L separately — more frequent, lightweight
  async function fetchOpenPnl() {
    try {
      const pnl = await fetch(`${API}/api/open-pnl`, { headers }).then(r=>r.json()).catch(()=>[]);
      setOpenPnl(Array.isArray(pnl)?pnl:[]);
    } catch {}
  }

  async function fetchDebug() {
    try {
      const d = await fetch(`${API}/api/debug`, { headers }).then(r=>r.json());
      setDebug(d);
    } catch(e) { console.error(e); }
  }

  async function runBacktest() {
    setBtRun(true); setBtErr(null); setBtRes(null);
    try {
      const r = await fetch(`${API}/api/backtest`, {
        headers,
        signal: AbortSignal.timeout(180000),
      });
      if (!r.ok) {
        const e = await r.json();
        throw new Error(e.error || `Server error ${r.status}`);
      }
      setBtRes(await r.json());
    } catch(e) { setBtErr(e.message||"Unknown error"); }
    finally { setBtRun(false); }
  }

  useEffect(() => {
    fetchAll();
    fetchOpenPnl();
    const id1 = setInterval(fetchAll,    15000); // Full refresh every 15s
    const id2 = setInterval(fetchOpenPnl, 8000); // Live P&L every 8s
    return () => { clearInterval(id1); clearInterval(id2); };
  }, []);

  // Derived state
  const open   = (trades||[]).filter(t => t&&t.status==="OPEN");
  const closed = (trades||[]).filter(t => t&&t.status==="CLOSED");
  const bankroll = num(stats?.bankroll) || 1000;
  const roi      = num(((bankroll-1000)/1000)*100).toFixed(1);
  const dome     = stats?.ironDome || health || {};
  const openSorted = [...open].sort((a,b) => num(b.fomo_score)-num(a.fomo_score));

  // Live P&L lookup map — pair_address -> live data
  const openPnlMap = new Map((openPnl||[]).map(p => [p.pair_address, p]));

  // Total unrealized P&L across all open positions
  const totalUnrealized = (openPnl||[])
    .filter(p => p.unrealized_pnl !== null)
    .reduce((a, p) => a + num(p.unrealized_pnl), 0);

  const btTrades = ((btRes?.trades)||[])
    .filter(t => btFilt==="qualifying" ? t.wouldEnter : true)
    .sort((a,b) => btSort==="fomo" ? num(b.fomo)-num(a.fomo) : num(b.score)-num(a.score));

  return (
    <div style={{
      background:BG, minHeight:"100vh", color:"#b0c8d8",
      fontFamily:"'Courier New',monospace",
      maxWidth:430, width:"100%", margin:"0 auto",
      display:"flex", flexDirection:"column",
      overflowX:"hidden", // prevent horizontal scroll
      WebkitTextSizeAdjust:"100%", // prevent iOS font scaling
    }}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        html,body{overflow-x:hidden;width:100%;-webkit-text-size-adjust:100%}
        ::-webkit-scrollbar{width:2px}
        ::-webkit-scrollbar-thumb{background:${BORDER}}
        @keyframes glow{0%,100%{opacity:1}50%{opacity:.45}}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:.1}}
        @keyframes slide{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        .btn{cursor:pointer;border:none;font-family:monospace;transition:all .15s;-webkit-tap-highlight-color:transparent}
        a{color:inherit;text-decoration:none;-webkit-tap-highlight-color:transparent}
        input,button{-webkit-appearance:none}
      `}</style>

      {/* Circuit breaker banner */}
      {dome.circuitBroken && (
        <div style={{background:`${R}18`,border:`1px solid ${R}`,padding:"10px 16px",textAlign:"center",fontSize:10,color:R}}>
          CIRCUIT BREAKER — Down ${Math.abs(num(dome.dailyPnl)).toFixed(2)} today. Paused until midnight.
        </div>
      )}

      {/* ── HEADER ── */}
      <div style={{padding:"10px 12px 8px",borderBottom:`1px solid ${BORDER}`,background:CARD,position:"sticky",top:0,zIndex:10,width:"100%"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",width:"100%",minWidth:0}}>
          <div style={{minWidth:0,flex:1}}>
            <div style={{fontSize:16,fontWeight:900,letterSpacing:3,color:G,animation:"glow 4s ease-in-out infinite"}}>◉ S0NAR</div>
            <div style={{display:"flex",alignItems:"center",gap:5,marginTop:2,flexWrap:"wrap"}}>
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <div style={{width:6,height:6,borderRadius:"50%",background:online?G:R,animation:"blink 1.8s infinite",flexShrink:0}}/>
                <span style={{fontSize:7,color:DIM}}>{online?`LIVE · ${lastUp?.toLocaleTimeString()}`:"OFFLINE"}</span>
              </div>
              {dome.marketMood && (
                <span style={{fontSize:7,padding:"1px 5px",borderRadius:6,background:`${mood2c(dome.marketMood)}18`,color:mood2c(dome.marketMood),border:`1px solid ${mood2c(dome.marketMood)}44`}}>
                  {String(dome.marketMood).toUpperCase()}
                </span>
              )}
              {dome.dynamicMinScore && <span style={{fontSize:7,color:DIM}}>MIN:{dome.dynamicMinScore}</span>}
              {dome.pollCount>0 && <span style={{fontSize:7,color:DIM}}>#{dome.pollCount}</span>}
            </div>
          </div>
          <div style={{textAlign:"right",flexShrink:0,paddingLeft:8}}>
            <div style={{fontSize:7,color:DIM}}>BANKROLL</div>
            <div style={{fontSize:20,fontWeight:900,color:bankroll>=1000?G:R}}>${Math.round(bankroll)}</div>
            <div style={{fontSize:8,color:num(roi)>=0?G:R}}>{num(roi)>=0?"▲":"▼"} {Math.abs(num(roi)).toFixed(1)}% ROI</div>
            <button onClick={onLogout}
              style={{fontSize:6,color:DIM,background:"transparent",border:"none",cursor:"pointer",letterSpacing:1,marginTop:2}}>
              LOCK
            </button>
          </div>
        </div>
      </div>

      {/* ── TABS ── */}
      <div style={{display:"flex",background:CARD,borderBottom:`1px solid ${BORDER}`,overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
        {[
          ["home","HOME"],["fomo","FOMO"],["dome","DOME"],
          ["backtest","TEST"],["signals","SIGS"],["trades","TRADES"],
          ["record","RECORD"],["debug","DEBUG"],
        ].map(([v,l]) => (
          <button key={v} className="btn" onClick={()=>{ setView(v); if(v==="debug") fetchDebug(); }}
            style={{flex:"0 0 auto",padding:"8px 8px",fontSize:8,color:view===v?G:DIM,
              borderBottom:`2px solid ${view===v?G:"transparent"}`,background:"transparent",whiteSpace:"nowrap"}}>
            {l}
            {v==="trades"  && open.length>0  ? <span style={{color:Y}}> ({open.length})</span>  : ""}
            {v==="fomo"    && feed.filter(f=>f.entered).length>0 ? <span style={{color:O}}> ●</span> : ""}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════
          HOME
         ══════════════════════════════════════════════════════ */}
      {view==="home" && (
        <div style={{flex:1,padding:"10px 12px",overflowY:"auto"}}>
          {/* P&L + equity curve */}
          <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,padding:"14px",marginBottom:10}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
              <div>
                <div style={{fontSize:7,color:DIM,letterSpacing:2}}>ALL TIME P&L</div>
                <div style={{fontSize:22,fontWeight:900,marginTop:2,color:num(stats?.totalPnl)>=0?G:R}}>{fmt$(stats?.totalPnl)}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:7,color:DIM}}>WIN RATE</div>
                <div style={{fontSize:22,fontWeight:900,color:num(stats?.winRate)>=50?G:Y}}>
                  {stats?.winRate!=null?`${fix0(stats.winRate)}%`:"--"}
                </div>
              </div>
            </div>
            <EqChart data={stats?.equity||[]} color={num(stats?.totalPnl)>=0?G:R}/>
            <div style={{display:"flex",justifyContent:"space-between",marginTop:6,fontSize:8,color:DIM}}>
              <span>$1,000 start</span>
              <span>{stats?.totalTrades||0} trades · {stats?.openTrades||0} open</span>
              <span style={{color:num(stats?.totalPnl)>=0?G:R,fontWeight:700}}>${Math.round(bankroll)} now</span>
            </div>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:10}}>
            <StatCard label="AVG WIN"       value={stats?.avgWin?fmt$(stats.avgWin):"--"}                        color={G}/>
            <StatCard label="AVG LOSS"      value={stats?.avgLoss?fmt$(stats.avgLoss):"--"}                      color={R}/>
            <StatCard label="PROFIT FACTOR" value={stats?.profitFactor?`${fix2(stats.profitFactor)}x`:"--"}      color={Y}/>
          </div>

          {/* Score performance */}
          <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,padding:"13px",marginBottom:10}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:10}}>SCORE BUCKETS</div>
            {Object.entries(stats?.buckets||{}).map(([label,b]) => (
              <div key={label} style={{marginBottom:9}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                  <span style={{fontSize:10,color:"white",fontWeight:700}}>{label}</span>
                  <span style={{fontSize:9,color:num(b.winRate)>=50?G:b.winRate!=null?R:DIM}}>
                    {b.winRate!=null?`${fix0(b.winRate)}% · avg ${fmt$(b.avgPnl)} · ${b.trades}t`:"no data"}
                  </span>
                </div>
                <Bar v={b.winRate||0} c={num(b.winRate)>=50?G:b.winRate!=null?R:DIM}/>
              </div>
            ))}
          </div>

          {/* FOMO performance */}
          {stats?.fomoBuckets && (
            <div style={{background:CARD,border:`1px solid ${O}22`,borderRadius:12,padding:"13px",marginBottom:10}}>
              <div style={{fontSize:7,color:O,letterSpacing:2,marginBottom:10}}>FOMO BUCKETS</div>
              {Object.entries(stats.fomoBuckets).map(([label,b]) => (
                <div key={label} style={{marginBottom:9}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                    <span style={{fontSize:10,color:"white",fontWeight:700}}>{label}</span>
                    <span style={{fontSize:9,color:num(b.winRate)>=50?G:b.winRate!=null?R:DIM}}>
                      {b.winRate!=null?`${fix0(b.winRate)}% · avg ${fmt$(b.avgPnl)} · ${b.trades}t`:"no data"}
                    </span>
                  </div>
                  <Bar v={b.winRate||0} c={fomo2c(label==="80+"?85:label==="60-79"?70:label==="40-59"?50:label==="20-39"?30:10)}/>
                </div>
              ))}
              <div style={{fontSize:8,color:DIM,borderTop:`1px solid ${BORDER}`,paddingTop:8,marginTop:4}}>
                High FOMO = crowd piling in = we exit into them.
              </div>
            </div>
          )}

          {/* Stealth performance card */}
          {stats?.stealthStats && stats.stealthStats.trades > 0 && (
            <div style={{background:CARD,border:`1px solid ${P}33`,borderRadius:12,padding:"10px 12px",marginBottom:10}}>
              <div style={{fontSize:7,color:P,letterSpacing:2,marginBottom:8}}>STEALTH PERFORMANCE</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:8}}>
                <div style={{textAlign:"center"}}>
                  <div style={{fontSize:7,color:DIM}}>TRADES</div>
                  <div style={{fontSize:16,fontWeight:900,color:P}}>{stats.stealthStats.trades}</div>
                </div>
                <div style={{textAlign:"center"}}>
                  <div style={{fontSize:7,color:DIM}}>WIN RATE</div>
                  <div style={{fontSize:16,fontWeight:900,color:stats.stealthStats.winRate>=50?G:R}}>
                    {stats.stealthStats.winRate!=null?`${fix0(stats.stealthStats.winRate)}%`:"--"}
                  </div>
                </div>
                <div style={{textAlign:"center"}}>
                  <div style={{fontSize:7,color:DIM}}>AVG P&L</div>
                  <div style={{fontSize:16,fontWeight:900,color:num(stats.stealthStats.avgPnl)>=0?G:R}}>
                    {stats.stealthStats.avgPnl!=null?fmt$(stats.stealthStats.avgPnl):"--"}
                  </div>
                </div>
              </div>

              {/* vs Normal comparison */}
              {stats.stealthStats.vsNormal && (
                <div style={{background:"#090f17",borderRadius:8,padding:"8px",fontSize:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                    <span style={{color:P,fontWeight:700}}>STEALTH</span>
                    <span style={{color:DIM}}>NORMAL</span>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                    <span style={{color:num(stats.stealthStats.vsNormal.stealthWR)>=50?G:R}}>
                      {fix1(stats.stealthStats.vsNormal.stealthWR)}% WR
                    </span>
                    <span style={{color:num(stats.stealthStats.vsNormal.normalWR)>=50?G:R}}>
                      {fix1(stats.stealthStats.vsNormal.normalWR)}% WR
                    </span>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between"}}>
                    <span style={{color:num(stats.stealthStats.vsNormal.stealthAvg)>=0?G:R}}>
                      avg {fmt$(stats.stealthStats.vsNormal.stealthAvg)}
                    </span>
                    <span style={{color:num(stats.stealthStats.vsNormal.normalAvg)>=0?G:R}}>
                      avg {fmt$(stats.stealthStats.vsNormal.normalAvg)}
                    </span>
                  </div>
                </div>
              )}

              {stats.stealthStats.best && (
                <div style={{marginTop:8,fontSize:8,color:DIM}}>
                  Best stealth: <span style={{color:P,fontWeight:700}}>{stats.stealthStats.best.ticker}</span>
                  <span style={{color:G,marginLeft:6}}>{fmt$(stats.stealthStats.best.pnl)}</span>
                  <span style={{color:DIM,marginLeft:4}}>{fix2(stats.stealthStats.best.mult)}x</span>
                </div>
              )}
            </div>
          )}

          {stats?.best && (
            <div style={{background:`${G}0c`,border:`1px solid ${G}28`,borderRadius:12,padding:"10px 12px",marginBottom:10}}>
              <div style={{fontSize:7,color:G,letterSpacing:2,marginBottom:6}}>BEST TRADE</div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontSize:15,fontWeight:900,color:"white"}}>{stats.best.ticker}</div>
                  <div style={{fontSize:8,color:DIM,marginTop:2}}>{fix2(stats.best.mult)}x</div>
                </div>
                <div style={{fontSize:19,fontWeight:900,color:G}}>{fmt$(stats.best.pnl)}</div>
              </div>
            </div>
          )}

          <button className="btn" onClick={fetchAll}
            style={{width:"100%",padding:"9px",background:"transparent",border:`1px solid ${BORDER}`,color:DIM,borderRadius:8,fontSize:9,letterSpacing:2}}>
            ↻ REFRESH
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          FOMO FEED
         ══════════════════════════════════════════════════════ */}
      {view==="fomo" && (
        <div style={{flex:1,padding:"10px 12px",overflowY:"auto"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div>
              <div style={{fontSize:7,color:O,letterSpacing:2}}>LIVE FOMO RADAR · 10 MIN</div>
              <div style={{fontSize:7,color:DIM,marginTop:2}}>Enter early. Exit into the crowd.</div>
            </div>
            <button className="btn" onClick={fetchAll}
              style={{fontSize:8,color:O,background:"transparent",border:`1px solid ${O}44`,padding:"3px 10px",borderRadius:4}}>↻</button>
          </div>

          {feed.length===0 && (
            <div style={{textAlign:"center",padding:"50px 20px",color:DIM,fontSize:10}}>
              {online?"Scanning for FOMO signals...":"Server offline"}
            </div>
          )}

          {feed.map((sig,i) => {
            const fc  = fomo2c(sig.fomo_score);
            const hot = num(sig.fomo_score) >= 55;
            const blocked = !sig.entered && sig.skip_reason;
            return (
              <div key={sig.id||i} style={{
                background:CARD,
                border:`1px solid ${hot ? fc+"44" : BORDER}`,
                borderRadius:12,padding:"10px 12px",marginBottom:8,
                borderLeft:`3px solid ${sig.entered?G:fc}`,
                animation:i<3?"slide .3s ease":"none",
              }}>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
                  <FomoRing f={sig.fomo_score} size={44}/>
                  <div style={{flex:1}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                      <span style={{fontSize:14,fontWeight:900,color:"white"}}>{sig.ticker}</span>
                      <span style={{fontSize:8,padding:"1px 6px",borderRadius:6,background:`${fc}18`,color:fc,border:`1px solid ${fc}33`}}>
                        {fomo2lbl(sig.fomo_score)}
                      </span>
                      {sig.entered && <Tag on label="ENTERED" c={G}/>}
                      {sig.dex_url && (
                        <a href={sig.dex_url} target="_blank" rel="noopener"
                          style={{fontSize:8,color:B,background:`${B}18`,padding:"1px 5px",borderRadius:4}}>↗</a>
                      )}
                    </div>
                    <div style={{marginTop:4}}><FomoBar v={sig.fomo_score}/></div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:14,fontWeight:900,color:num(sig.pc_5m)>=0?G:R}}>
                      {num(sig.pc_5m)>=0?"+":""}{fix1(sig.pc_5m)}%
                    </div>
                    <div style={{fontSize:7,color:DIM}}>5m</div>
                  </div>
                </div>

                {/* Skip reason — why it didn't enter */}
                {blocked && (
                  <div style={{background:"#090f17",borderRadius:6,padding:"4px 8px",fontSize:7,color:R,marginBottom:5}}>
                    BLOCKED: {sig.skip_reason}
                  </div>
                )}

                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"3px 8px",fontSize:7,color:DIM}}>
                  <span>sc: <span style={{color:sc2c(sig.score)}}>{sig.score}</span></span>
                  <span>liq: <span style={{color:num(sig.liq)>=2000?Y:R}}>${fmtK(sig.liq)}</span></span>
                  <span>vol: <span style={{color:B}}>${fmtK(sig.vol_5m)}</span></span>
                  <span>age: {fix1(sig.age_min)}m</span>
                  <span style={{color:mood2c(sig.market_mood)}}>{sig.market_mood}</span>
                  <span>{sig.seen_at?new Date(sig.seen_at).toLocaleTimeString():""}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          DOME
         ══════════════════════════════════════════════════════ */}
      {view==="dome" && (
        <div style={{flex:1,padding:"10px 12px",overflowY:"auto"}}>
          <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:12}}>IRON DOME v5.1 — 8 LAYERS</div>
          {[
            { n:1, label:"Quality Gate",    color:G,
              status:online?"ACTIVE":"?",
              details:`minScore:${dome.dynamicMinScore||60} | liq:$${dome.config?.MIN_LIQ||2000} | vol5m:$${dome.config?.MIN_VOL_5M||300} | buys:52%+` },
            { n:2, label:"FOMO Filter",     color:O,
              status:online?"ACTIVE":"?",
              details:"minFOMO:20 | detects crowd pressure | zero-liq tokens capped at 30" },
            { n:3, label:"Rug Detection",   color:G,
              status:online?"ACTIVE":"?",
              details:"blocks <3min tokens, vol/liq mismatch, heavy sell walls, thin liq" },
            { n:4, label:"Market Mood",     color:mood2c(dome.marketMood||"normal"),
              status:dome.marketMood?String(dome.marketMood).toUpperCase():"?",
              details:dome.marketMood==="frenzy"?"FRENZY — floor -4":dome.marketMood==="hot"?"Hot — floor -2":dome.marketMood==="cold"?"Cold — floor +5":dome.marketMood==="dead"?"DEAD — floor +8":"Normal thresholds" },
            { n:5, label:"Dynamic Sizing",  color:B,
              status:online?"ACTIVE":"?",
              details:"base × FOMO mult (0.9×–1.5×) | floor $25 | cap $150" },
            { n:6, label:"3-Tier Exit",     color:T,
              status:online?"ACTIVE":"?",
              details:`T1:${TIER1}x | T2:${TIER2}x | T3:${TIER3}x | FOMO Fade | max ${MAX_HOLD}m` },
            { n:7, label:"Circuit Breaker", color:dome.circuitBroken?R:G,
              status:dome.circuitBroken?"TRIGGERED":"STANDING",
              details:dome.circuitBroken?`PAUSED — down $${Math.abs(num(dome.dailyPnl)).toFixed(2)}`:`Today:${num(dome.dailyPnl)>=0?"+":""}$${num(dome.dailyPnl).toFixed(2)} | limit:-$300` },
            { n:8, label:"Self-Tuning",     color:P,
              status:`TUNE #${dome.selfTuneCount||0}`,
              details:"adjusts minScore every 30 closed trades | analyzes FOMO WR" },
          ].map(layer => (
            <div key={layer.n} style={{background:CARD,border:`1px solid ${layer.color}33`,borderRadius:12,padding:"13px",marginBottom:8,borderLeft:`3px solid ${layer.color}`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:11,fontWeight:900,color:layer.color,minWidth:20}}>L{layer.n}</span>
                  <span style={{fontSize:11,fontWeight:700,color:"white"}}>{layer.label}</span>
                </div>
                <span style={{fontSize:8,padding:"2px 8px",borderRadius:6,background:`${layer.color}18`,color:layer.color,border:`1px solid ${layer.color}44`}}>
                  {layer.status}
                </span>
              </div>
              <div style={{fontSize:8,color:DIM}}>{layer.details}</div>
            </div>
          ))}

          {/* Velocity stats */}
          <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,padding:"13px",marginBottom:8}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:8}}>VELOCITY</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
              {[
                {l:"POLLS",v:dome.pollCount||0,c:G},
                {l:"POLL/s",v:"15s",c:B},
                {l:"CHECK/s",v:"30s",c:T},
                {l:"OPEN",v:open.length,c:Y},
                {l:"QUERIES",v:dome.config?.QUERIES||42,c:P},
                {l:"MAX HOLD",v:`${MAX_HOLD}m`,c:O},
              ].map(s => (
                <div key={s.l} style={{textAlign:"center"}}>
                  <div style={{fontSize:7,color:DIM}}>{s.l}</div>
                  <div style={{fontSize:15,fontWeight:900,color:s.c}}>{s.v}</div>
                </div>
              ))}
            </div>
          </div>

          {stats?.exits && Object.keys(stats.exits).length>0 && (
            <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,padding:"13px"}}>
              <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:10}}>EXIT BREAKDOWN</div>
              {Object.entries(stats.exits).sort((a,b)=>b[1]-a[1]).map(([reason,count]) => (
                <div key={reason} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7}}>
                  <span style={{fontSize:9,color:"white"}}>{reason}</span>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <div style={{width:80}}>
                      <Bar v={count} c={reason.includes("TIER")||reason.includes("UP")||reason.includes("FADE")?G:R} max={Math.max(...Object.values(stats.exits))}/>
                    </div>
                    <span style={{fontSize:9,color:DIM,minWidth:20,textAlign:"right"}}>{count}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          BACKTEST
         ══════════════════════════════════════════════════════ */}
      {view==="backtest" && (
        <div style={{flex:1,padding:"10px 12px",overflowY:"auto"}}>
          <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,padding:"14px",marginBottom:10}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:6}}>FOMO BACKTEST v5.1</div>
            <div style={{fontSize:9,color:DIM,marginBottom:10,lineHeight:1.6}}>
              Scans 42 queries in parallel. Scores by FOMO pressure. Rate limited: 2 min cooldown between runs.
            </div>
            <button className="btn" onClick={runBacktest} disabled={btRun}
              style={{width:"100%",padding:"12px",background:btRun?CARD:O,color:btRun?DIM:"#000",
                borderRadius:8,fontSize:10,fontWeight:900,letterSpacing:2,border:`1px solid ${btRun?BORDER:O}`,opacity:btRun?0.7:1}}>
              {btRun
                ? <span style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                    <span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>◉</span>
                    SCANNING...
                  </span>
                : "▶ RUN FOMO BACKTEST"
              }
            </button>
          </div>

          {btErr && (
            <div style={{background:`${R}10`,border:`1px solid ${R}44`,borderRadius:10,padding:"12px",marginBottom:10,fontSize:9,color:R}}>
              {btErr}
            </div>
          )}

          {btRes && (
            <>
              <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,padding:"14px",marginBottom:10}}>
                <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:10}}>
                  RESULTS · {new Date(btRes.ts).toLocaleTimeString()}
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                  <StatCard label="SCANNED"    value={btRes.scanned}                                     color="white"/>
                  <StatCard label="QUALIFYING" value={btRes.qualifying}                                  color={B}/>
                  <StatCard label="WIN RATE"   value={`${fix1(btRes.winRate)}%`}                        color={num(btRes.winRate)>=50?G:R}/>
                  <StatCard label="TOTAL P&L"  value={fmt$(btRes.totalPnl)}                             color={num(btRes.totalPnl)>=0?G:R}/>
                  <StatCard label="AVG WIN"    value={btRes.avgWin?fmt$(btRes.avgWin):"--"}             color={G}/>
                  <StatCard label="AVG LOSS"   value={btRes.avgLoss?fmt$(btRes.avgLoss):"--"}           color={R}/>
                </div>
                <div style={{fontSize:7,color:O,marginBottom:6}}>FOMO BUCKETS</div>
                {Object.entries(btRes.fomoBuckets||{}).map(([label,b]) => (
                  <div key={label} style={{marginBottom:8}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                      <span style={{fontSize:10,color:"white",fontWeight:700}}>{label}</span>
                      <span style={{fontSize:9,color:num(b.winRate)>=50?G:b.winRate!=null?R:DIM}}>
                        {b.winRate!=null?`${fix0(b.winRate)}% · avg ${fmt$(b.avgPnl)} · ${b.trades}t`:"no data"}
                      </span>
                    </div>
                    <Bar v={b.winRate||0} c={fomo2c(label==="80+"?85:label==="60-79"?70:label==="40-59"?50:label==="20-39"?30:10)}/>
                  </div>
                ))}
              </div>

              <div style={{display:"flex",gap:6,marginBottom:8,flexWrap:"wrap"}}>
                {[["all","ALL"],["qualifying","DOME ONLY"]].map(([f,l]) => (
                  <button key={f} className="btn" onClick={()=>setBtFilt(f)}
                    style={{flex:1,padding:"7px",fontSize:8,background:btFilt===f?`${G}18`:CARD,
                      color:btFilt===f?G:DIM,border:`1px solid ${btFilt===f?G:BORDER}`,borderRadius:8}}>
                    {l}
                  </button>
                ))}
                {[["fomo","FOMO↓"],["score","SCORE↓"]].map(([s,l]) => (
                  <button key={s} className="btn" onClick={()=>setBtSort(s)}
                    style={{flex:1,padding:"7px",fontSize:8,background:btSort===s?`${O}18`:CARD,
                      color:btSort===s?O:DIM,border:`1px solid ${btSort===s?O:BORDER}`,borderRadius:8}}>
                    {l}
                  </button>
                ))}
              </div>

              {btTrades.slice(0,40).map((t,i) => (
                <div key={i} style={{background:CARD,
                  border:`1px solid ${t.wouldEnter?(num(t.pnl)>=0?G+"44":R+"44"):BORDER}`,
                  borderRadius:10,padding:"10px 12px",marginBottom:7,
                  borderLeft:`3px solid ${t.wouldEnter?(num(t.pnl)>=0?G:R):BORDER}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <Ring s={t.score} size={36}/>
                      <FomoRing f={t.fomo} size={36}/>
                      <div>
                        <div style={{fontSize:12,fontWeight:900,color:"white"}}>{t.ticker}</div>
                        <div style={{display:"flex",gap:3,marginTop:2,flexWrap:"wrap"}}>
                          <Tag on={t.wouldEnter} label={t.wouldEnter?"ENTERS":"SKIP"} c={t.wouldEnter?G:DIM}/>
                          <Tag on={t.boosted}    label="BOOST"                        c={B}/>
                          {t.dexUrl && <a href={t.dexUrl} target="_blank" rel="noopener"
                            style={{fontSize:8,color:B,background:`${B}18`,padding:"2px 5px",borderRadius:4}}>↗</a>}
                        </div>
                      </div>
                    </div>
                    {t.wouldEnter && (
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:14,fontWeight:900,color:num(t.pnl)>=0?G:R}}>{fmt$(t.pnl)}</div>
                        <div style={{fontSize:8,color:DIM}}>{fix2(t.mult)}x · {t.exit}</div>
                      </div>
                    )}
                  </div>
                  <div style={{display:"flex",gap:8,marginTop:6,fontSize:7,color:DIM,flexWrap:"wrap"}}>
                    <span>1h: <span style={{color:num(t.pc1h)>=0?G:R}}>{fix1(t.pc1h)}%</span></span>
                    <span>5m: <span style={{color:num(t.pc5m)>=0?G:R}}>{fix1(t.pc5m)}%</span></span>
                    <span>liq:${fmtK(t.liq)}</span>
                    <span>buys:{t.bsPct}%</span>
                    {t.wouldEnter && <span style={{color:Y}}>bet:${t.betSize}</span>}
                  </div>
                </div>
              ))}
              {btTrades.length>40 && <div style={{textAlign:"center",padding:"10px",fontSize:8,color:DIM}}>Showing top 40 of {btTrades.length}</div>}
            </>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          SIGNALS
         ══════════════════════════════════════════════════════ */}
      {view==="signals" && (
        <div style={{flex:1,padding:"10px 12px",overflowY:"auto"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2}}>ALL SIGNALS · EVERY 15s</div>
            <button className="btn" onClick={fetchAll}
              style={{fontSize:8,color:B,background:"transparent",border:`1px solid ${B}44`,padding:"3px 10px",borderRadius:4}}>↻</button>
          </div>
          {(signals||[]).length===0 && (
            <div style={{textAlign:"center",padding:"50px 20px",color:DIM,fontSize:10}}>
              {online?"Waiting for signals...":"Server offline"}
            </div>
          )}
          {(signals||[]).map((sig,i) => (
            <div key={sig.id||i} style={{background:CARD,border:`1px solid ${sig.entered?G+"44":BORDER}`,
              borderRadius:12,padding:"12px",marginBottom:9,animation:i===0?"slide .3s ease":"none"}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:7}}>
                <Ring s={sig.score}/>
                <FomoRing f={sig.fomo_score||0} size={40}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                    <span style={{fontSize:14,fontWeight:900,color:"white"}}>{sig.ticker}</span>
                    {sig.dex_url && <a href={sig.dex_url} target="_blank" rel="noopener"
                      style={{fontSize:8,color:B,background:`${B}18`,padding:"1px 5px",borderRadius:4}}>↗</a>}
                  </div>
                  <div style={{display:"flex",gap:4,marginTop:4,flexWrap:"wrap"}}>
                    <Tag on={sig.entered}             label={sig.entered?"ENTERED":"SKIPPED"} c={sig.entered?G:R}/>
                    <Tag on={num(sig.fomo_score)>=35}  label={fomo2lbl(sig.fomo_score)}        c={fomo2c(sig.fomo_score)}/>
                  </div>
                </div>
              </div>
              {sig.skip_reason && (
                <div style={{background:"#090f17",borderRadius:6,padding:"4px 8px",fontSize:7,color:R,marginBottom:5}}>
                  BLOCKED: {sig.skip_reason}
                </div>
              )}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 12px"}}>
                {[
                  {l:"Vol 5m",v:`$${fmtK(sig.vol_5m)}`,bar:Math.min(100,(num(sig.vol_5m)/10000)*100),c:B},
                  {l:"Liq",   v:`$${fmtK(sig.liq)}`,   bar:Math.min(100,(num(sig.liq)/100000)*100),  c:Y},
                ].map(s => (
                  <div key={s.l}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                      <span style={{fontSize:7,color:DIM}}>{s.l}</span>
                      <span style={{fontSize:7,color:s.c}}>{s.v}</span>
                    </div>
                    <Bar v={s.bar} c={s.c}/>
                  </div>
                ))}
              </div>
              <div style={{fontSize:7,color:DIM,marginTop:5}}>
                {sig.seen_at?new Date(sig.seen_at).toLocaleTimeString():""} · age:{fix1(sig.age_min)}m
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          TRADES
         ══════════════════════════════════════════════════════ */}
      {view==="trades" && (
        <div style={{flex:1,padding:"10px 12px",overflowY:"auto"}}>
          {openSorted.length>0 && (
            <>
              {/* Open positions header with total unrealized P&L */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{fontSize:8,color:G,letterSpacing:2}}>OPEN · {openSorted.length} LIVE</div>
                {openPnl.length>0 && (
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:7,color:DIM}}>UNREALIZED</div>
                    <div style={{fontSize:13,fontWeight:900,color:totalUnrealized>=0?G:R}}>
                      {totalUnrealized>=0?"+":""}{fmt$(totalUnrealized,false)}
                    </div>
                  </div>
                )}
              </div>

              {openSorted.map(t => {
                // Get live P&L data for this trade
                const live    = openPnlMap.get(t.pair_address);
                const hasPnl  = live && live.unrealized_pnl !== null;
                const pct     = hasPnl ? num(live.pct_change)     : null;
                const upnl    = hasPnl ? num(live.unrealized_pnl) : null;
                const curMult = hasPnl ? num(live.mult)           : null;
                const hiMult  = hasPnl ? num(live.highest_mult)   : num(t.highest_mult||1);
                const ageMin  = hasPnl ? num(live.age_min)        : (Date.now()-new Date(t.opened_at).getTime())/60000;
                const warning = live?.warning || "ok";

                // Border color based on warning level
                const borderC = warning==="near_stop"     ? R
                              : warning==="near_early_stop"? R
                              : warning==="near_trailing"  ? O
                              : warning==="near_tier2"     ? P
                              : warning==="near_tier1"     ? G
                              : hasPnl && pct>0            ? G+"55"
                              : hasPnl && pct<0            ? R+"33"
                              : G+"2a";

                return (
                  <div key={t.id} style={{background:CARD,border:`1px solid ${borderC}`,borderRadius:10,
                    padding:"10px 12px",marginBottom:8,borderLeft:`3px solid ${fomo2c(t.fomo_score)}`}}>

                    {/* Top row: identity + live status */}
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <FomoRing f={t.fomo_score||0} size={38}/>
                        <div>
                          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                            <span style={{fontSize:13,fontWeight:900,color:"white"}}>{t.ticker}</span>
                            {t.is_stealth && (
                              <span style={{fontSize:7,padding:"1px 5px",borderRadius:4,
                                background:`${P}22`,color:P,border:`1px solid ${P}44`}}>STEALTH</span>
                            )}
                            {t.dex_url && <a href={t.dex_url} target="_blank" rel="noopener"
                              style={{fontSize:8,color:B,marginLeft:4}}>↗</a>}
                          </div>
                        </div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <span style={{fontSize:8,color:G,animation:"blink 1.2s infinite"}}>● LIVE</span>
                        {hasPnl && (
                          <div style={{fontSize:7,color:DIM,marginTop:1}}>
                            updated {new Date().toLocaleTimeString()}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Live P&L display — the main new feature */}
                    {hasPnl ? (
                      <div style={{background:"#090f17",borderRadius:8,padding:"10px",marginBottom:8}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",width:"100%"}}>
                          {/* Current P&L */}
                          <div style={{minWidth:0,flex:1}}>
                            <div style={{fontSize:7,color:DIM,marginBottom:2}}>UNREALIZED</div>
                            <div style={{fontSize:16,fontWeight:900,color:upnl>=0?G:R,fontFamily:"monospace"}}>
                              {upnl>=0?"+":""}{fmt$(upnl,false)}
                            </div>
                          </div>
                          {/* Current multiplier */}
                          <div style={{textAlign:"center",flexShrink:0,padding:"0 8px"}}>
                            <div style={{fontSize:7,color:DIM,marginBottom:2}}>NOW</div>
                            <div style={{fontSize:14,fontWeight:900,color:pct>=0?G:R,fontFamily:"monospace"}}>
                              {pct>=0?"+":""}{fix1(pct)}%
                            </div>
                            <div style={{fontSize:8,color:DIM}}>{fix2(curMult)}x</div>
                          </div>
                          {/* Peak */}
                          <div style={{textAlign:"right",flexShrink:0}}>
                            <div style={{fontSize:7,color:DIM,marginBottom:2}}>PEAK</div>
                            <div style={{fontSize:14,fontWeight:900,color:G,fontFamily:"monospace"}}>
                              {fix2(hiMult)}x
                            </div>
                          </div>
                        </div>

                        {/* Progress bar toward next tier */}
                        {(() => {
                          const nextTier  = curMult < TIER1 ? TIER1 : curMult < TIER2 ? TIER2 : TIER3;
                          const prevTier  = curMult < TIER1 ? 1.0  : curMult < TIER2 ? TIER1 : TIER2;
                          const progress  = Math.min(100, Math.max(0, ((curMult-prevTier)/(nextTier-prevTier))*100));
                          const tierColor = curMult >= TIER2 ? P : curMult >= TIER1 ? G : Y;
                          return (
                            <div style={{marginTop:8}}>
                              <div style={{display:"flex",justifyContent:"space-between",fontSize:7,color:DIM,marginBottom:3}}>
                                <span>{fix2(prevTier)}x</span>
                                <span style={{color:tierColor}}>next: {fix2(nextTier)}x</span>
                              </div>
                              <div style={{background:"#0c1820",height:4,borderRadius:2,overflow:"hidden"}}>
                                <div style={{width:`${progress}%`,height:"100%",background:tierColor,transition:"width .5s"}}/>
                              </div>
                            </div>
                          );
                        })()}

                        {/* Warning banner */}
                        {warning!=="ok" && (
                          <div style={{marginTop:6,padding:"4px 8px",borderRadius:4,fontSize:7,fontWeight:700,textAlign:"center",
                            background: warning.includes("stop")||warning==="near_trailing" ? `${R}18` : `${G}18`,
                            color:      warning.includes("stop")||warning==="near_trailing" ? R : G,
                          }}>
                            {warning==="near_stop"      ? "⚠ APPROACHING STOP LOSS -28%"   :
                             warning==="near_early_stop"? "⚠ APPROACHING EARLY STOP -18%"  :
                             warning==="near_trailing"  ? "⚠ APPROACHING TRAILING STOP"    :
                             warning==="near_tier2"     ? "TARGET TIER 2 IN RANGE"          :
                             warning==="near_tier1"     ? "APPROACHING TIER 1"              : ""}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{background:"#090f17",borderRadius:8,padding:"8px 12px",marginBottom:8,fontSize:8,color:DIM,textAlign:"center"}}>
                        Fetching live price...
                      </div>
                    )}

                    {/* Meta row */}
                    <div style={{display:"flex",gap:10,fontSize:8,color:DIM,flexWrap:"wrap"}}>
                      <span>sc:<span style={{color:sc2c(t.score)}}>{t.score}</span></span>
                      <span>fomo:<span style={{color:fomo2c(t.fomo_score)}}>{t.fomo_score||0}</span></span>
                      <span>bet:<span style={{color:Y}}>${t.bet_size}</span></span>
                      <span>age:{ageMin.toFixed(0)}m</span>
                      <span style={{color:mood2c(t.market_mood)}}>{t.market_mood}</span>
                    </div>
                  </div>
                );
              })}
            </>
          )}
          {closed.length>0 && (
            <>
              <div style={{fontSize:8,color:DIM,letterSpacing:2,margin:"10px 0 8px"}}>CLOSED · {closed.length}</div>
              {[...closed].reverse().map(t => (
                <div key={t.id} style={{background:CARD,
                  border:`1px solid ${t.is_stealth?P+"44":BORDER}`,borderRadius:10,
                  padding:"10px 12px",marginBottom:7,
                  borderLeft:`3px solid ${t.is_stealth?P:num(t.pnl)>0?G:R}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <span style={{fontSize:13,fontWeight:900,color:"white"}}>{t.ticker}</span>
                      {t.is_stealth && (
                        <span style={{fontSize:7,marginLeft:6,padding:"1px 5px",borderRadius:4,
                          background:`${P}22`,color:P,border:`1px solid ${P}44`}}>STEALTH</span>
                      )}
                      {t.dex_url && <a href={t.dex_url} target="_blank" rel="noopener"
                        style={{fontSize:8,color:B,marginLeft:8}}>↗</a>}
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:15,fontWeight:900,color:num(t.pnl)>0?G:R}}>{fmt$(t.pnl)}</div>
                      <div style={{fontSize:8,color:DIM}}>{fix2(t.exit_mult)}x · {t.exit_reason}</div>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:10,marginTop:5,fontSize:8,color:DIM,flexWrap:"wrap"}}>
                    <span>sc:<span style={{color:sc2c(t.score)}}>{t.score}</span></span>
                    <span>fomo:<span style={{color:fomo2c(t.fomo_score)}}>{t.fomo_score||0}</span></span>
                    {t.stealth_score>0&&<span>st:<span style={{color:P}}>{t.stealth_score}</span></span>}
                    <span>bet:${t.bet_size}</span>
                    <span>hi:{fix2(t.highest_mult)}x</span>
                    {t.market_mood && <span style={{color:mood2c(t.market_mood)}}>{t.market_mood}</span>}
                  </div>
                  <div style={{fontSize:7,color:DIM,marginTop:4}}>
                    {t.opened_at?new Date(t.opened_at).toLocaleTimeString():""} → {t.closed_at?new Date(t.closed_at).toLocaleTimeString():"—"}
                  </div>
                </div>
              ))}
            </>
          )}
          {trades.length===0 && (
            <div style={{textAlign:"center",padding:"60px 20px",color:DIM,fontSize:9}}>
              {online?"Scanning for FOMO entries...":"Server offline"}
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          RECORD
         ══════════════════════════════════════════════════════ */}
      {view==="record" && (
        <div style={{flex:1,padding:"10px 12px",overflowY:"auto"}}>
          <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,padding:"14px",marginBottom:10}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:8}}>EQUITY CURVE</div>
            <EqChart data={stats?.equity||[]} color={num(stats?.totalPnl)>=0?G:R}/>
            <div style={{display:"flex",justifyContent:"space-between",marginTop:6,fontSize:8,color:DIM}}>
              <span>$1,000 start</span>
              <span style={{color:num(roi)>=0?G:R,fontWeight:700}}>${Math.round(bankroll)} · {roi}% ROI</span>
            </div>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
            <StatCard label="TOTAL P&L"    value={fmt$(stats?.totalPnl)}                              color={num(stats?.totalPnl)>=0?G:R}/>
            <StatCard label="WIN RATE"     value={stats?.winRate!=null?`${fix0(stats.winRate)}%`:"--"} color={num(stats?.winRate)>=50?G:Y}/>
            <StatCard label="PROFIT FACTOR" value={stats?.profitFactor?`${fix2(stats.profitFactor)}x`:"--"} color={Y}/>
            <StatCard label="TOTAL TRADES"  value={stats?.totalTrades||0}                             color="white"/>
            <StatCard label="AVG WIN"       value={stats?.avgWin?fmt$(stats.avgWin):"--"}             color={G}/>
            <StatCard label="AVG LOSS"      value={stats?.avgLoss?fmt$(stats.avgLoss):"--"}           color={R}/>
          </div>

          {stats?.daily && Object.keys(stats.daily).length>0 && (
            <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,padding:"13px",marginBottom:10}}>
              <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:10}}>DAILY P&L</div>
              {Object.entries(stats.daily).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,14).map(([day,pnl]) => (
                <div key={day} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7}}>
                  <span style={{fontSize:9,color:DIM}}>{day}</span>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <div style={{width:80}}><Bar v={Math.abs(num(pnl))} c={num(pnl)>=0?G:R} max={500}/></div>
                    <span style={{fontSize:10,fontWeight:700,color:num(pnl)>=0?G:R,minWidth:60,textAlign:"right"}}>{fmt$(pnl)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,padding:"13px",marginBottom:10}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:10}}>SCORE PERFORMANCE</div>
            {Object.entries(stats?.buckets||{}).map(([label,b]) => (
              <div key={label} style={{display:"flex",gap:10,alignItems:"center",marginBottom:8}}>
                <span style={{fontSize:10,color:"white",fontWeight:700,minWidth:48}}>{label}</span>
                <div style={{flex:1}}><Bar v={b.winRate||0} c={num(b.winRate)>=50?G:b.winRate!=null?R:DIM}/></div>
                <span style={{fontSize:10,minWidth:32,textAlign:"right",color:num(b.winRate)>=50?G:b.winRate!=null?R:DIM}}>
                  {b.winRate!=null?`${fix0(b.winRate)}%`:"—"}
                </span>
                <span style={{fontSize:8,color:DIM,minWidth:18}}>{b.trades}t</span>
              </div>
            ))}
          </div>

          <div style={{background:CARD,border:`1px solid ${O}22`,borderRadius:12,padding:"13px",marginBottom:10}}>
            <div style={{fontSize:7,color:O,letterSpacing:2,marginBottom:10}}>FOMO PERFORMANCE</div>
            {Object.entries(stats?.fomoBuckets||{}).map(([label,b]) => (
              <div key={label} style={{display:"flex",gap:10,alignItems:"center",marginBottom:8}}>
                <span style={{fontSize:10,color:"white",fontWeight:700,minWidth:48}}>{label}</span>
                <div style={{flex:1}}><Bar v={b.winRate||0} c={fomo2c(label==="80+"?85:label==="60-79"?70:label==="40-59"?50:label==="20-39"?30:10)}/></div>
                <span style={{fontSize:10,minWidth:32,textAlign:"right",color:num(b.winRate)>=50?G:b.winRate!=null?R:DIM}}>
                  {b.winRate!=null?`${fix0(b.winRate)}%`:"—"}
                </span>
                <span style={{fontSize:8,color:DIM,minWidth:18}}>{b.trades}t</span>
              </div>
            ))}
          </div>

          {/* Stealth vs Normal comparison in record */}
          {stats?.stealthStats && stats.stealthStats.trades > 0 && (
            <div style={{background:CARD,border:`1px solid ${P}33`,borderRadius:12,padding:"13px",marginBottom:10}}>
              <div style={{fontSize:7,color:P,letterSpacing:2,marginBottom:10}}>STEALTH vs NORMAL</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
                <div style={{background:`${P}0c`,borderRadius:8,padding:"8px",textAlign:"center"}}>
                  <div style={{fontSize:7,color:P,marginBottom:4}}>STEALTH ({stats.stealthStats.trades}t)</div>
                  <div style={{fontSize:16,fontWeight:900,color:num(stats.stealthStats.winRate)>=50?G:R}}>
                    {stats.stealthStats.winRate!=null?`${fix0(stats.stealthStats.winRate)}% WR`:"--"}
                  </div>
                  <div style={{fontSize:10,color:num(stats.stealthStats.avgPnl)>=0?G:R,marginTop:2}}>
                    avg {stats.stealthStats.avgPnl!=null?fmt$(stats.stealthStats.avgPnl):"--"}
                  </div>
                </div>
                <div style={{background:"#090f17",borderRadius:8,padding:"8px",textAlign:"center"}}>
                  <div style={{fontSize:7,color:DIM,marginBottom:4}}>
                    NORMAL ({(stats.totalTrades||0)-(stats.stealthStats.trades)}t)
                  </div>
                  <div style={{fontSize:16,fontWeight:900,color:num(stats.stealthStats.vsNormal?.normalWR)>=50?G:R}}>
                    {stats.stealthStats.vsNormal?`${fix0(stats.stealthStats.vsNormal.normalWR)}% WR`:"--"}
                  </div>
                  <div style={{fontSize:10,color:num(stats.stealthStats.vsNormal?.normalAvg)>=0?G:R,marginTop:2}}>
                    avg {stats.stealthStats.vsNormal?fmt$(stats.stealthStats.vsNormal.normalAvg):"--"}
                  </div>
                </div>
              </div>
              <div style={{fontSize:8,color:DIM,textAlign:"center"}}>
                Need 20+ stealth trades for statistical significance
              </div>
            </div>
          )}

          <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,padding:"13px"}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:10}}>EXIT PLAYBOOK</div>
            {[
              {t:`EARLY STOP — -18% in first 10m`,      c:R, d:"Fastest exit. Get out before it gets worse."},
              {t:`STOP LOSS — -28% hard stop`,           c:R, d:"No mercy. Next trade."},
              {t:`TRAILING STOP — -18% from peak`,       c:O, d:"After 45m. Locks gains tightly."},
              {t:`FOMO FADE — crowd lost interest`,      c:T, d:"FOMO <15 while in profit. Take it. They're leaving."},
              {t:`TIER 1 — 40% out at ${TIER1}x`,       c:G, d:"Quick partial. Rides rest toward tier 2."},
              {t:`TIER 2 — 35% out at ${TIER2}x`,       c:G, d:"Bulk profit locked."},
              {t:`TIER 3 — 25% moon bag at ${TIER3}x`,  c:P, d:"Let the winner run."},
              {t:`TIME EXIT — ${MAX_HOLD}m max hold`,    c:B, d:"Meme coins die. Don't overstay."},
            ].map(e => (
              <div key={e.t} style={{display:"flex",gap:10,marginBottom:8,alignItems:"flex-start"}}>
                <div style={{width:4,height:4,borderRadius:"50%",background:e.c,marginTop:5,flexShrink:0}}/>
                <div>
                  <div style={{fontSize:10,color:e.c,fontWeight:700}}>{e.t}</div>
                  <div style={{fontSize:8,color:DIM}}>{e.d}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          DEBUG — new in v5.1
         ══════════════════════════════════════════════════════ */}
      {view==="debug" && (
        <div style={{flex:1,padding:"10px 12px",overflowY:"auto"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2}}>DEBUG — WHY TOKENS ARE REJECTED</div>
            <button className="btn" onClick={fetchDebug}
              style={{fontSize:8,color:B,background:"transparent",border:`1px solid ${B}44`,padding:"3px 10px",borderRadius:4}}>↻</button>
          </div>

          {!debug && (
            <div style={{textAlign:"center",padding:"40px",color:DIM,fontSize:9}}>
              Tap refresh to load debug data
            </div>
          )}

          {debug && (
            <>
              {/* Active thresholds */}
              <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,padding:"13px",marginBottom:10}}>
                <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:8}}>ACTIVE THRESHOLDS</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                  {[
                    {l:"MIN SCORE",v:debug.thresholds.dynScore,    c:Y},
                    {l:"MIN FOMO", v:debug.thresholds.MIN_FOMO,    c:O},
                    {l:"MIN LIQ",  v:`$${fmtK(debug.thresholds.MIN_LIQ)}`,  c:B},
                    {l:"MIN VOL",  v:`$${fmtK(debug.thresholds.MIN_VOL_5M)}`,c:B},
                    {l:"MIN BUYS", v:`${debug.thresholds.MIN_BUY_PCT}%`,     c:G},
                    {l:"MOOD",     v:debug.thresholds.mood,         c:mood2c(debug.thresholds.mood)},
                  ].map(s => (
                    <div key={s.l} style={{textAlign:"center"}}>
                      <div style={{fontSize:7,color:DIM}}>{s.l}</div>
                      <div style={{fontSize:13,fontWeight:900,color:s.c}}>{s.v}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Summary */}
              <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,padding:"13px",marginBottom:10}}>
                <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:8}}>LAST 50 SIGNALS</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                  <StatCard label="SEEN"      value={debug.summary.total}   color="white"/>
                  <StatCard label="ENTERED"   value={debug.summary.entered} color={G}/>
                  <StatCard label="SKIPPED"   value={debug.summary.skipped} color={R}/>
                  <StatCard label="ZERO LIQ"  value={debug.summary.zeroLiq} color={R}/>
                  <StatCard label="AVG SCORE" value={debug.summary.avgScore} color={Y}/>
                  <StatCard label="AVG FOMO"  value={debug.summary.avgFomo}  color={O}/>
                </div>

                {/* Top skip reasons */}
                <div style={{fontSize:7,color:DIM,marginBottom:8}}>TOP SKIP REASONS</div>
                {(debug.summary.skipReasons||[]).map(([reason, count]) => (
                  <div key={reason} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    <span style={{fontSize:9,color:R}}>{reason}</span>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <div style={{width:60}}><Bar v={count} c={R} max={Math.max(...(debug.summary.skipReasons||[]).map(([,c])=>c),1)}/></div>
                      <span style={{fontSize:9,color:DIM,minWidth:16,textAlign:"right"}}>{count}</span>
                    </div>
                  </div>
                ))}
                {(debug.summary.skipReasons||[]).length===0 && (
                  <div style={{fontSize:9,color:G,textAlign:"center",padding:"8px"}}>No skips — everything is entering!</div>
                )}
              </div>

              {/* Recent signals detail */}
              <div style={{fontSize:7,color:DIM,marginBottom:8}}>RECENT SIGNALS DETAIL</div>
              {(debug.recent||[]).map((sig,i) => (
                <div key={i} style={{background:CARD,border:`1px solid ${sig.entered?G+"33":BORDER}`,
                  borderRadius:10,padding:"10px 12px",marginBottom:6}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                    <span style={{fontSize:12,fontWeight:900,color:"white"}}>{sig.ticker}</span>
                    <div style={{display:"flex",gap:6}}>
                      <span style={{fontSize:8,color:sc2c(sig.score)}}>sc:{sig.score}</span>
                      <span style={{fontSize:8,color:fomo2c(sig.fomo_score)}}>fomo:{sig.fomo_score}</span>
                      <Tag on={sig.entered} label={sig.entered?"IN":"OUT"} c={sig.entered?G:R}/>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:8,fontSize:7,color:DIM,marginBottom:sig.skip_reason?4:0}}>
                    <span>liq:<span style={{color:num(sig.liq)>=2000?Y:R}}>${fmtK(sig.liq)}</span></span>
                    <span>vol:${fmtK(sig.vol_5m)}</span>
                    <span>age:{fix1(sig.age_min)}m</span>
                    <span>pc5:{fix1(sig.pc_5m)}%</span>
                  </div>
                  {sig.skip_reason && (
                    <div style={{fontSize:7,color:R,background:"#090f17",padding:"3px 6px",borderRadius:4}}>
                      {sig.skip_reason}
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      <div style={{padding:"6px",borderTop:`1px solid ${BORDER}`,background:CARD,fontSize:7,color:"#0c1820",textAlign:"center"}}>
        PAPER TRADES · FOMO HUNTER v5.1 · NOT FINANCIAL ADVICE
      </div>
    </div>
  );
}
