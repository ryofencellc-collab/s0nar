// S0NAR App.jsx v6.0 — 4-Algorithm A/B Testing Lab
import { useState, useEffect } from "react";

// ── CONSTANTS ──────────────────────────────────────────────
const TIER1 = 1.5, TIER2 = 3.0, TIER3 = 6.0, MAX_HOLD = 120;
const API   = "";

// Colors
const BG="#060a0d", CARD="#0b1016", BORDER="#12202c", DIM="#2d4a5e";
const G="#00e676", R="#ff1744", Y="#ffd740", B="#40c4ff", O="#ff9100";

// Algo colors
const ALGO_COLORS = {
  a: "#ce93d8", // purple  — BGOLD Hunter
  b: "#40c4ff", // blue    — Momentum
  c: "#ffd740", // yellow  — Early Mover
  d: "#00e676", // green   — Control
};
const ALGO_NAMES = {
  a: "BGOLD HUNTER",
  b: "MOMENTUM",
  c: "EARLY MOVER",
  d: "CONTROL",
};

// ── UTILS ──────────────────────────────────────────────────
const num   = v => { const n=parseFloat(v); return isNaN(n)?0:n; };
const fix2  = v => num(v).toFixed(2);
const fix1  = v => num(v).toFixed(1);
const fix0  = v => Math.round(num(v)).toString();
const fmt$  = (v,sign=true) => (sign&&num(v)>0?"+":"")+"$"+Math.abs(num(v)).toFixed(2);
const fmtK  = v => num(v)>=1e6?(num(v)/1e6).toFixed(1)+"M":num(v)>=1e3?(num(v)/1e3).toFixed(1)+"K":Math.round(num(v)).toString();
const sc2c  = s => num(s)>=85?G:num(s)>=75?Y:num(s)>=65?O:R;
const fomo2c = f => num(f)>=75?R:num(f)>=55?O:num(f)>=35?Y:num(f)>=20?"#64ffda":DIM;

// ── COMPONENTS ─────────────────────────────────────────────
function Bar({ v=0, c=G, max=100 }) {
  return (
    <div style={{background:"#0c1820",height:4,borderRadius:2,overflow:"hidden"}}>
      <div style={{width:`${Math.min(100,(num(v)/Math.max(num(max),1))*100)}%`,height:"100%",background:c,transition:"width .5s"}}/>
    </div>
  );
}

function EqChart({ data=[], color=G }) {
  const safe = (data||[]).map(v=>num(v));
  if (safe.length < 2) return (
    <div style={{height:50,display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,color:DIM}}>
      No trades yet
    </div>
  );
  const min=Math.min(...safe), max=Math.max(...safe), range=max-min||1;
  const W=280, H=50;
  const pts = safe.map((v,i)=>`${(i/(safe.length-1))*W},${H-((v-min)/range)*(H-6)-3}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:H}} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`eg-${color.replace("#","")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity=".3"/>
          <stop offset="100%" stopColor={color} stopOpacity=".02"/>
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${pts} ${W},${H}`} fill={`url(#eg-${color.replace("#","")})`}/>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5}/>
    </svg>
  );
}

function MiniRing({ s=0, size=36 }) {
  const sc=Math.round(num(s)), c=sc2c(sc), r=size/2-4;
  const circ=2*Math.PI*r, fill=(sc/100)*circ;
  return (
    <div style={{position:"relative",width:size,height:size,flexShrink:0}}>
      <svg width={size} height={size} style={{transform:"rotate(-90deg)",position:"absolute"}}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#0c1820" strokeWidth={3}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={c} strokeWidth={3}
          strokeDasharray={`${fill} ${circ}`} strokeLinecap="round"/>
      </svg>
      <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
        <span style={{color:c,fontSize:size/3.5,fontWeight:900,fontFamily:"monospace"}}>{sc}</span>
      </div>
    </div>
  );
}

// ── LOGIN SCREEN ───────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [pw, setPw]       = useState("");
  const [err, setErr]     = useState("");
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
    } catch { setErr("Server error — try again"); }
    setLoading(false);
  }

  return (
    <div style={{background:BG,minHeight:"100vh",display:"flex",alignItems:"center",
      justifyContent:"center",fontFamily:"'Courier New',monospace"}}>
      <div style={{width:300,textAlign:"center",padding:"0 20px"}}>
        <div style={{fontSize:26,fontWeight:900,letterSpacing:4,color:G,marginBottom:6}}>◉ S0NAR</div>
        <div style={{fontSize:9,color:DIM,letterSpacing:3,marginBottom:8}}>IRON DOME v6.0</div>
        <div style={{fontSize:8,color:ALGO_COLORS.a,marginBottom:30}}>4-ALGORITHM LAB</div>

        <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,padding:"20px"}}>
          <div style={{fontSize:8,color:DIM,letterSpacing:2,marginBottom:12}}>ACCESS CODE</div>
          <input type="password" value={pw}
            onChange={e=>setPw(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&handleLogin()}
            placeholder="Enter password" autoFocus
            style={{width:"100%",padding:"12px",background:"#060a0d",
              border:`1px solid ${err?"#ff1744":"#12202c"}`,
              borderRadius:8,color:"#b0c8d8",fontFamily:"monospace",
              fontSize:14,outline:"none",marginBottom:8,textAlign:"center",letterSpacing:4}}
          />
          {err && <div style={{fontSize:9,color:R,marginBottom:8}}>{err}</div>}
          <button onClick={handleLogin} disabled={loading||!pw.trim()}
            style={{width:"100%",padding:"12px",background:loading?"#0b1016":G,
              color:loading?DIM:"#000",border:"none",borderRadius:8,
              fontFamily:"monospace",fontSize:11,fontWeight:900,letterSpacing:2,
              cursor:loading?"not-allowed":"pointer"}}>
            {loading?"VERIFYING...":"ENTER"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ALGO CARD — compact summary ────────────────────────────
function AlgoCard({ stat, isSelected, onClick }) {
  if (!stat) return null;
  const c      = ALGO_COLORS[stat.algo];
  const profit = num(stat.totalPnl) >= 0;

  return (
    <div onClick={onClick} style={{
      background:CARD,
      border:`1px solid ${isSelected?c+"88":BORDER}`,
      borderRadius:10,padding:"10px",cursor:"pointer",
      borderLeft:`3px solid ${c}`,
      transition:"all .2s",
    }}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
        <div>
          <div style={{fontSize:7,color:c,letterSpacing:1,marginBottom:1}}>{ALGO_NAMES[stat.algo]}</div>
          <div style={{fontSize:8,color:DIM}}>{stat.desc?.slice(0,35)}...</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:16,fontWeight:900,color:profit?G:R}}>{fmt$(stat.totalPnl)}</div>
          <div style={{fontSize:7,color:DIM}}>${Math.round(stat.bankroll)}</div>
        </div>
      </div>

      <EqChart data={stat.equity||[]} color={c}/>

      <div style={{display:"flex",justifyContent:"space-between",marginTop:6,fontSize:7,color:DIM}}>
        <span style={{color:num(stat.winRate)>=50?G:Y}}>{stat.winRate!=null?`${fix0(stat.winRate)}% WR`:"--"}</span>
        <span>{stat.totalTrades}t · {stat.openTrades} open</span>
        <span style={{color:num(stat.profitFactor)>=2?G:Y}}>{stat.profitFactor?`${fix2(stat.profitFactor)}x PF`:"--"}</span>
      </div>
    </div>
  );
}

// ── MAIN APP ───────────────────────────────────────────────
export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem("sonar_token") || "");

  function handleLogin(t) { setToken(t); }
  function handleLogout() { localStorage.removeItem("sonar_token"); setToken(""); }

  if (!token) return <LoginScreen onLogin={handleLogin}/>;
  return <AppInner token={token} headers={{"X-Auth-Token":token}} onLogout={handleLogout}/>;
}

function AppInner({ token, headers, onLogout }) {
  const [view,      setView]     = useState("lab");
  const [stats,     setStats]    = useState([]);   // array of 4 algo stats
  const [trades,    setTrades]   = useState({});   // {a:[],b:[],c:[],d:[]}
  const [openPnl,   setOpenPnl]  = useState({});   // {a:[],b:[],c:[],d:[]}
  const [health,    setHealth]   = useState(null);
  const [online,    setOnline]   = useState(false);
  const [lastUp,    setLastUp]   = useState(null);
  const [selAlgo,   setSelAlgo]  = useState("a");  // selected algo for detail view
  const [wipeModal, setWipeModal]= useState(false);
  const [wipePw,    setWipePw]   = useState("");
  const [wipeMsg,   setWipeMsg]  = useState("");
  const [debugData, setDebugData]= useState(null);

  async function fetchAll() {
    try {
      const [h, s] = await Promise.all([
        fetch(`${API}/health`,     { headers }).then(r=>r.json()),
        fetch(`${API}/api/stats`,  { headers }).then(r=>r.json()),
      ]);
      if (h?.error==="Unauthorized") { onLogout(); return; }
      setHealth(h||{});
      setStats(Array.isArray(s)?s:[]);
      setOnline(true);
      setLastUp(new Date());
    } catch { setOnline(false); }
  }

  async function fetchTrades(algoKey) {
    try {
      const t = await fetch(`${API}/api/trades/${algoKey}?limit=200`, { headers }).then(r=>r.json());
      setTrades(prev => ({ ...prev, [algoKey]: Array.isArray(t)?t:[] }));
    } catch {}
  }

  async function fetchOpenPnl() {
    try {
      const p = await fetch(`${API}/api/open-pnl`, { headers }).then(r=>r.json());
      if (p && typeof p === "object") setOpenPnl(p);
    } catch {}
  }

  async function fetchDebug(algoKey) {
    try {
      const d = await fetch(`${API}/api/debug/${algoKey}`, { headers }).then(r=>r.json());
      setDebugData(d);
    } catch {}
  }

  async function doWipe() {
    try {
      const r = await fetch(`${API}/api/wipe`, {
        method: "POST",
        headers: { ...headers, "Content-Type":"application/json" },
        body: JSON.stringify({ password: wipePw }),
      });
      const d = await r.json();
      if (d.ok) {
        setWipeMsg("Wiped. Fresh start.");
        setStats([]); setTrades({}); setOpenPnl({});
        setTimeout(()=>{ setWipeModal(false); setWipeMsg(""); setWipePw(""); fetchAll(); }, 2000);
      } else {
        setWipeMsg(d.error || "Failed");
      }
    } catch { setWipeMsg("Server error"); }
  }

  useEffect(() => {
    fetchAll();
    const id1 = setInterval(fetchAll,    15000);
    const id2 = setInterval(fetchOpenPnl, 8000);
    return () => { clearInterval(id1); clearInterval(id2); };
  }, []);

  useEffect(() => {
    fetchTrades(selAlgo);
    fetchOpenPnl();
  }, [selAlgo]);

  // Derived
  const selStat   = stats.find(s => s.algo === selAlgo);
  const selTrades = trades[selAlgo] || [];
  const selPnl    = openPnl[selAlgo] || [];
  const selPnlMap = new Map(selPnl.map(p => [p.pair_address, p]));
  const openTrades = selTrades.filter(t => t.status==="OPEN").sort((a,b)=>num(b.fomo_score)-num(a.fomo_score));
  const closedTrades = selTrades.filter(t => t.status==="CLOSED");
  const totalUnrealized = selPnl.filter(p=>p.unrealized_pnl!=null).reduce((a,p)=>a+num(p.unrealized_pnl),0);

  // Best algo by P&L
  const bestAlgo = stats.length ? stats.reduce((a,b)=>num(a.totalPnl)>num(b.totalPnl)?a:b,stats[0]) : null;

  return (
    <div style={{background:BG,minHeight:"100vh",color:"#b0c8d8",
      fontFamily:"'Courier New',monospace",maxWidth:430,width:"100%",
      margin:"0 auto",display:"flex",flexDirection:"column",overflowX:"hidden",
      WebkitTextSizeAdjust:"100%"}}>
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
      `}</style>

      {/* ── HEADER ── */}
      <div style={{padding:"10px 12px 8px",borderBottom:`1px solid ${BORDER}`,background:CARD,
        position:"sticky",top:0,zIndex:10,width:"100%"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",width:"100%",minWidth:0}}>
          <div style={{minWidth:0,flex:1}}>
            <div style={{fontSize:15,fontWeight:900,letterSpacing:3,color:G,animation:"glow 4s ease-in-out infinite"}}>◉ S0NAR LAB</div>
            <div style={{display:"flex",alignItems:"center",gap:5,marginTop:2,flexWrap:"wrap"}}>
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <div style={{width:6,height:6,borderRadius:"50%",background:online?G:R,animation:"blink 1.8s infinite",flexShrink:0}}/>
                <span style={{fontSize:7,color:DIM}}>{online?`LIVE · ${lastUp?.toLocaleTimeString()}`:"OFFLINE"}</span>
              </div>
              {health?.marketMood && (
                <span style={{fontSize:7,padding:"1px 5px",borderRadius:6,
                  background:"#ffd74018",color:Y,border:"1px solid #ffd74044"}}>
                  {String(health.marketMood).toUpperCase()}
                </span>
              )}
              <span style={{fontSize:7,color:DIM}}>#{health?.pollCount||0}</span>
            </div>
          </div>
          <div style={{textAlign:"right",flexShrink:0,paddingLeft:8}}>
            <div style={{fontSize:7,color:DIM}}>4-ALGO TEST</div>
            <div style={{fontSize:10,fontWeight:900,color:G}}>v6.0</div>
            <button onClick={onLogout}
              style={{fontSize:6,color:DIM,background:"transparent",border:"none",cursor:"pointer",letterSpacing:1}}>
              LOCK
            </button>
          </div>
        </div>
      </div>

      {/* ── TABS ── */}
      <div style={{display:"flex",background:CARD,borderBottom:`1px solid ${BORDER}`,
        overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
        {[["lab","LAB"],["trades","TRADES"],["compare","COMPARE"],["debug","DEBUG"],["settings","⚙"]].map(([v,l]) => (
          <button key={v} className="btn" onClick={()=>{setView(v);if(v==="debug")fetchDebug(selAlgo);}}
            style={{flex:"0 0 auto",padding:"8px 10px",fontSize:8,
              color:view===v?G:DIM,borderBottom:`2px solid ${view===v?G:"transparent"}`,
              background:"transparent",whiteSpace:"nowrap"}}>
            {l}
          </button>
        ))}
      </div>

      {/* ── ALGO SELECTOR ── */}
      <div style={{display:"flex",gap:4,padding:"8px 10px",background:CARD,
        borderBottom:`1px solid ${BORDER}`,overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
        {["a","b","c","d"].map(k => (
          <button key={k} className="btn" onClick={()=>setSelAlgo(k)}
            style={{flex:"0 0 auto",padding:"5px 10px",fontSize:8,borderRadius:20,
              background:selAlgo===k?`${ALGO_COLORS[k]}22`:CARD,
              color:selAlgo===k?ALGO_COLORS[k]:DIM,
              border:`1px solid ${selAlgo===k?ALGO_COLORS[k]+"66":BORDER}`}}>
            {ALGO_NAMES[k]}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════
          LAB — all 4 algorithm overview
         ══════════════════════════════════════════════════════ */}
      {view==="lab" && (
        <div style={{flex:1,padding:"10px 12px",overflowY:"auto"}}>

          {/* Best algo highlight */}
          {bestAlgo && num(bestAlgo.totalPnl) > 0 && (
            <div style={{background:`${ALGO_COLORS[bestAlgo.algo]}0c`,
              border:`1px solid ${ALGO_COLORS[bestAlgo.algo]}44`,
              borderRadius:10,padding:"8px 12px",marginBottom:10,
              display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontSize:7,color:ALGO_COLORS[bestAlgo.algo],letterSpacing:2}}>LEADING</div>
                <div style={{fontSize:14,fontWeight:900,color:"white"}}>{ALGO_NAMES[bestAlgo.algo]}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:18,fontWeight:900,color:G}}>{fmt$(bestAlgo.totalPnl)}</div>
                <div style={{fontSize:8,color:DIM}}>{fix0(bestAlgo.winRate)}% WR · {bestAlgo.totalTrades}t</div>
              </div>
            </div>
          )}

          {/* 4 algo cards */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
            {["a","b","c","d"].map(k => {
              const s = stats.find(st=>st.algo===k);
              return (
                <AlgoCard key={k} stat={s}
                  isSelected={selAlgo===k}
                  onClick={()=>{ setSelAlgo(k); setView("trades"); fetchTrades(k); }}
                />
              );
            })}
          </div>

          {/* Combined stats */}
          {stats.length === 4 && (
            <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,padding:"12px",marginBottom:10}}>
              <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:10}}>COMBINED STATS</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                {[
                  {l:"TOTAL TRADES", v:stats.reduce((a,s)=>a+s.totalTrades,0), c:"white"},
                  {l:"TOTAL P&L",    v:fmt$(stats.reduce((a,s)=>a+num(s.totalPnl),0)), c:G},
                  {l:"OPEN NOW",     v:stats.reduce((a,s)=>a+s.openTrades,0), c:Y},
                ].map(s=>(
                  <div key={s.l} style={{textAlign:"center"}}>
                    <div style={{fontSize:6,color:DIM,marginBottom:2}}>{s.l}</div>
                    <div style={{fontSize:14,fontWeight:900,color:s.c}}>{s.v}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <button className="btn" onClick={fetchAll}
            style={{width:"100%",padding:"8px",background:"transparent",
              border:`1px solid ${BORDER}`,color:DIM,borderRadius:8,fontSize:9,letterSpacing:2}}>
            ↻ REFRESH
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          TRADES — selected algo detail
         ══════════════════════════════════════════════════════ */}
      {view==="trades" && (
        <div style={{flex:1,padding:"10px 12px",overflowY:"auto"}}>
          {/* Selected algo header */}
          {selStat && (
            <div style={{background:CARD,border:`1px solid ${ALGO_COLORS[selAlgo]}33`,
              borderRadius:10,padding:"10px",marginBottom:10,borderLeft:`3px solid ${ALGO_COLORS[selAlgo]}`}}>
              <div style={{fontSize:7,color:ALGO_COLORS[selAlgo],letterSpacing:2,marginBottom:4}}>
                {ALGO_NAMES[selAlgo]}
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <div style={{fontSize:20,fontWeight:900,color:num(selStat.totalPnl)>=0?G:R}}>
                  {fmt$(selStat.totalPnl)}
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:14,fontWeight:900,color:num(selStat.winRate)>=50?G:Y}}>
                    {selStat.winRate!=null?`${fix0(selStat.winRate)}%`:"--"} WR
                  </div>
                  <div style={{fontSize:8,color:DIM}}>{selStat.totalTrades}t · {selStat.openTrades} open</div>
                </div>
              </div>
              <EqChart data={selStat.equity||[]} color={ALGO_COLORS[selAlgo]}/>
              <div style={{display:"flex",justifyContent:"space-between",marginTop:6,fontSize:7,color:DIM}}>
                <span>$1,000 start</span>
                <span style={{color:ALGO_COLORS[selAlgo]}}>
                  avg win: {selStat.avgWin?fmt$(selStat.avgWin):"--"}
                </span>
                <span style={{color:num(selStat.profitFactor)>=2?G:Y}}>
                  PF: {selStat.profitFactor?`${fix2(selStat.profitFactor)}x`:"--"}
                </span>
              </div>
            </div>
          )}

          {/* Open trades */}
          {openTrades.length>0 && (
            <>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{fontSize:8,color:G,letterSpacing:2}}>OPEN · {openTrades.length}</div>
                {selPnl.length>0 && (
                  <div style={{fontSize:12,fontWeight:900,color:totalUnrealized>=0?G:R}}>
                    {totalUnrealized>=0?"+":""}{fmt$(totalUnrealized,false)} unrealized
                  </div>
                )}
              </div>
              {openTrades.map(t => {
                const live   = selPnlMap.get(t.pair_address);
                const hasPnl = live && live.unrealized_pnl !== null;
                const pct    = hasPnl ? num(live.pct_change) : null;
                const upnl   = hasPnl ? num(live.unrealized_pnl) : null;
                const curMult = hasPnl ? num(live.mult) : null;
                const hiMult = hasPnl ? num(live.highest_mult) : num(t.highest_mult||1);
                const ageMin = hasPnl ? num(live.age_min) : (Date.now()-new Date(t.opened_at).getTime())/60000;
                const warning = live?.warning || "ok";
                const ac = ALGO_COLORS[selAlgo];

                return (
                  <div key={t.id} style={{background:CARD,
                    border:`1px solid ${warning.includes("stop")?R+"44":ac+"33"}`,
                    borderRadius:10,padding:"10px",marginBottom:8,
                    borderLeft:`3px solid ${ac}`}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                      <div>
                        <span style={{fontSize:13,fontWeight:900,color:"white"}}>{t.ticker}</span>
                        {t.is_stealth&&<span style={{fontSize:7,marginLeft:6,padding:"1px 4px",borderRadius:4,background:"#ce93d822",color:"#ce93d8",border:"1px solid #ce93d844"}}>STEALTH</span>}
                        {t.dex_url&&<a href={t.dex_url} target="_blank" rel="noopener" style={{fontSize:8,color:B,marginLeft:8}}>↗</a>}
                      </div>
                      <span style={{fontSize:8,color:G,animation:"blink 1.2s infinite"}}>● LIVE</span>
                    </div>

                    {hasPnl ? (
                      <div style={{background:"#090f17",borderRadius:8,padding:"8px",marginBottom:6}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <div style={{minWidth:0,flex:1}}>
                            <div style={{fontSize:6,color:DIM,marginBottom:2}}>UNREALIZED</div>
                            <div style={{fontSize:16,fontWeight:900,color:upnl>=0?G:R,fontFamily:"monospace"}}>
                              {upnl>=0?"+":""}{fmt$(upnl,false)}
                            </div>
                          </div>
                          <div style={{textAlign:"center",flexShrink:0,padding:"0 8px"}}>
                            <div style={{fontSize:6,color:DIM,marginBottom:2}}>NOW</div>
                            <div style={{fontSize:13,fontWeight:900,color:pct>=0?G:R,fontFamily:"monospace"}}>
                              {pct>=0?"+":""}{fix1(pct)}%
                            </div>
                          </div>
                          <div style={{textAlign:"right",flexShrink:0}}>
                            <div style={{fontSize:6,color:DIM,marginBottom:2}}>PEAK</div>
                            <div style={{fontSize:13,fontWeight:900,color:G,fontFamily:"monospace"}}>
                              {fix2(hiMult)}x
                            </div>
                          </div>
                        </div>
                        {/* Tier progress */}
                        {(() => {
                          const next = curMult<TIER1?TIER1:curMult<TIER2?TIER2:TIER3;
                          const prev = curMult<TIER1?1.0:curMult<TIER2?TIER1:TIER2;
                          const prog = Math.min(100,Math.max(0,((curMult-prev)/(next-prev))*100));
                          const tc   = curMult>=TIER2?"#ce93d8":curMult>=TIER1?G:Y;
                          return (
                            <div style={{marginTop:6}}>
                              <div style={{display:"flex",justifyContent:"space-between",fontSize:6,color:DIM,marginBottom:2}}>
                                <span>{fix2(prev)}x</span>
                                <span style={{color:tc}}>→ {fix2(next)}x</span>
                              </div>
                              <div style={{background:"#0c1820",height:3,borderRadius:2,overflow:"hidden"}}>
                                <div style={{width:`${prog}%`,height:"100%",background:tc,transition:"width .5s"}}/>
                              </div>
                            </div>
                          );
                        })()}
                        {warning!=="ok" && (
                          <div style={{marginTop:5,padding:"3px 8px",borderRadius:4,fontSize:7,
                            textAlign:"center",fontWeight:700,
                            background:warning.includes("stop")||warning==="near_trailing"?`${R}18`:`${G}18`,
                            color:warning.includes("stop")||warning==="near_trailing"?R:G}}>
                            {warning==="near_stop"?"⚠ NEAR STOP LOSS":
                             warning==="near_trailing"?"⚠ NEAR TRAILING":
                             warning==="near_tier2"?"APPROACHING TIER 2":
                             warning==="near_tier1"?"APPROACHING TIER 1":""}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{background:"#090f17",borderRadius:8,padding:"6px",marginBottom:6,
                        fontSize:8,color:DIM,textAlign:"center"}}>Fetching price...</div>
                    )}

                    <div style={{display:"flex",gap:8,fontSize:7,color:DIM,flexWrap:"wrap"}}>
                      <span>sc:<span style={{color:sc2c(t.score)}}>{t.score}</span></span>
                      <span>fomo:<span style={{color:fomo2c(t.fomo_score)}}>{t.fomo_score||0}</span></span>
                      <span>bet:${t.bet_size}</span>
                      <span>age:{ageMin.toFixed(0)}m</span>
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {/* Closed trades */}
          {closedTrades.length>0 && (
            <>
              <div style={{fontSize:8,color:DIM,letterSpacing:2,margin:"10px 0 8px"}}>
                CLOSED · {closedTrades.length}
              </div>
              {[...closedTrades].reverse().map(t => (
                <div key={t.id} style={{background:CARD,
                  border:`1px solid ${t.is_stealth?"#ce93d844":BORDER}`,
                  borderRadius:10,padding:"10px",marginBottom:6,
                  borderLeft:`3px solid ${num(t.pnl)>0?G:R}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <span style={{fontSize:12,fontWeight:900,color:"white"}}>{t.ticker}</span>
                      {t.is_stealth&&<span style={{fontSize:7,marginLeft:5,padding:"1px 4px",borderRadius:4,background:"#ce93d822",color:"#ce93d8"}}>S</span>}
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
                    <span>bet:${t.bet_size}</span>
                    <span>hi:{fix2(t.highest_mult)}x</span>
                  </div>
                  <div style={{fontSize:6,color:DIM,marginTop:3}}>
                    {t.opened_at?new Date(t.opened_at).toLocaleTimeString():""} → {t.closed_at?new Date(t.closed_at).toLocaleTimeString():"—"}
                  </div>
                </div>
              ))}
            </>
          )}

          {selTrades.length===0 && (
            <div style={{textAlign:"center",padding:"40px 20px",color:DIM,fontSize:9}}>
              {online?`${ALGO_NAMES[selAlgo]} scanning...`:"Server offline"}
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          COMPARE — side by side stats
         ══════════════════════════════════════════════════════ */}
      {view==="compare" && (
        <div style={{flex:1,padding:"10px 12px",overflowY:"auto"}}>
          <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:12}}>HEAD TO HEAD COMPARISON</div>

          {/* Leaderboard */}
          <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,padding:"12px",marginBottom:10}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:10}}>LEADERBOARD</div>
            {[...stats].sort((a,b)=>num(b.totalPnl)-num(a.totalPnl)).map((s,i) => (
              <div key={s.algo} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                <div style={{fontSize:14,fontWeight:900,color:DIM,minWidth:16}}>#{i+1}</div>
                <div style={{width:8,height:8,borderRadius:"50%",background:ALGO_COLORS[s.algo],flexShrink:0}}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:9,fontWeight:700,color:ALGO_COLORS[s.algo]}}>{ALGO_NAMES[s.algo]}</div>
                  <div style={{marginTop:2}}><Bar v={s.winRate||0} c={ALGO_COLORS[s.algo]}/></div>
                </div>
                <div style={{textAlign:"right",flexShrink:0}}>
                  <div style={{fontSize:13,fontWeight:900,color:num(s.totalPnl)>=0?G:R}}>{fmt$(s.totalPnl)}</div>
                  <div style={{fontSize:7,color:DIM}}>{s.winRate!=null?`${fix0(s.winRate)}% WR`:"no data"}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Stats table */}
          <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,padding:"12px",marginBottom:10}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:10}}>DETAILED COMPARISON</div>

            {/* Headers */}
            <div style={{display:"grid",gridTemplateColumns:"80px 1fr 1fr 1fr 1fr",gap:4,marginBottom:8}}>
              <div style={{fontSize:7,color:DIM}}></div>
              {["a","b","c","d"].map(k=>(
                <div key={k} style={{fontSize:7,color:ALGO_COLORS[k],textAlign:"center",fontWeight:700}}>
                  {k.toUpperCase()}
                </div>
              ))}
            </div>

            {[
              { label:"P&L",     fn: s => fmt$(s.totalPnl),                          best:"max" },
              { label:"WIN RATE", fn: s => s.winRate!=null?`${fix0(s.winRate)}%`:"--", best:"max" },
              { label:"TRADES",  fn: s => s.totalTrades,                              best:"max" },
              { label:"AVG WIN", fn: s => s.avgWin?fmt$(s.avgWin):"--",              best:"max" },
              { label:"AVG LOSS",fn: s => s.avgLoss?fmt$(s.avgLoss):"--",            best:"min" },
              { label:"PROF FAC",fn: s => s.profitFactor?`${fix2(s.profitFactor)}x`:"--", best:"max" },
            ].map(row => {
              const vals = ["a","b","c","d"].map(k => stats.find(s=>s.algo===k));
              return (
                <div key={row.label} style={{display:"grid",gridTemplateColumns:"80px 1fr 1fr 1fr 1fr",gap:4,marginBottom:6}}>
                  <div style={{fontSize:7,color:DIM,display:"flex",alignItems:"center"}}>{row.label}</div>
                  {vals.map((s,i) => {
                    const k = ["a","b","c","d"][i];
                    return (
                      <div key={k} style={{textAlign:"center"}}>
                        <div style={{fontSize:9,fontWeight:700,color:ALGO_COLORS[k]}}>
                          {s ? row.fn(s) : "--"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* Algo config comparison */}
          <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,padding:"12px"}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:10}}>ALGORITHM RULES</div>
            {["a","b","c","d"].map(k => (
              <div key={k} style={{marginBottom:12,paddingBottom:12,borderBottom:k!=="d"?`1px solid ${BORDER}`:"none"}}>
                <div style={{fontSize:9,fontWeight:700,color:ALGO_COLORS[k],marginBottom:4}}>{ALGO_NAMES[k]}</div>
                <div style={{fontSize:7,color:DIM,marginBottom:4}}>{ALGOS_DESC[k]}</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"2px 8px",fontSize:7,color:DIM}}>
                  <span>Score: <span style={{color:"white"}}>{stats.find(s=>s.algo===k)?.config?.minScore||"?"}-{stats.find(s=>s.algo===k)?.config?.maxScore||"?"}</span></span>
                  <span>FOMO: <span style={{color:"white"}}>{stats.find(s=>s.algo===k)?.config?.minFomo||"?"}-{stats.find(s=>s.algo===k)?.config?.maxFomo||"?"}</span></span>
                  <span>Min liq: <span style={{color:"white"}}>${fmtK(stats.find(s=>s.algo===k)?.config?.minLiq||0)}</span></span>
                  <span>Age: <span style={{color:"white"}}>{stats.find(s=>s.algo===k)?.config?.minAge||"?"}-{stats.find(s=>s.algo===k)?.config?.maxAge||"?"}m</span></span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          DEBUG
         ══════════════════════════════════════════════════════ */}
      {view==="debug" && (
        <div style={{flex:1,padding:"10px 12px",overflowY:"auto"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2}}>DEBUG — {ALGO_NAMES[selAlgo]}</div>
            <button className="btn" onClick={()=>fetchDebug(selAlgo)}
              style={{fontSize:8,color:B,background:"transparent",border:`1px solid ${B}44`,padding:"3px 8px",borderRadius:4}}>↻</button>
          </div>

          {!debugData && (
            <div style={{textAlign:"center",padding:"40px",color:DIM,fontSize:9}}>Tap refresh to load</div>
          )}

          {debugData && (
            <>
              <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,padding:"12px",marginBottom:10}}>
                <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:8}}>ACTIVE RULES — {ALGO_NAMES[selAlgo]}</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  {[
                    {l:"SCORE RANGE", v:`${debugData.config?.minScore}-${debugData.config?.maxScore}`, c:ALGO_COLORS[selAlgo]},
                    {l:"FOMO RANGE",  v:`${debugData.config?.minFomo}-${debugData.config?.maxFomo}`,   c:O},
                    {l:"MIN LIQ",     v:`$${fmtK(debugData.config?.minLiq||0)}`,                       c:B},
                    {l:"MIN VOL",     v:`$${fmtK(debugData.config?.minVol5m||0)}`,                     c:B},
                    {l:"AGE RANGE",   v:`${debugData.config?.minAge}-${debugData.config?.maxAge}m`,    c:Y},
                    {l:"PC5M RANGE",  v:`${debugData.config?.minPc5m}% to ${debugData.config?.maxPc5m}%`, c:Y},
                  ].map(s=>(
                    <div key={s.l} style={{textAlign:"center"}}>
                      <div style={{fontSize:6,color:DIM}}>{s.l}</div>
                      <div style={{fontSize:11,fontWeight:900,color:s.c}}>{s.v}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,padding:"12px",marginBottom:10}}>
                <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:8}}>LAST 50 SIGNALS</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:10}}>
                  {[
                    {l:"SEEN",    v:debugData.summary?.total||0,   c:"white"},
                    {l:"ENTERED", v:debugData.summary?.entered||0, c:G},
                    {l:"SKIPPED", v:debugData.summary?.skipped||0, c:R},
                    {l:"AVG SC",  v:debugData.summary?.avgScore||0,c:ALGO_COLORS[selAlgo]},
                    {l:"AVG FOMO",v:debugData.summary?.avgFomo||0, c:O},
                  ].map(s=>(
                    <div key={s.l} style={{textAlign:"center"}}>
                      <div style={{fontSize:6,color:DIM}}>{s.l}</div>
                      <div style={{fontSize:14,fontWeight:900,color:s.c}}>{s.v}</div>
                    </div>
                  ))}
                </div>

                <div style={{fontSize:7,color:DIM,marginBottom:6}}>TOP SKIP REASONS</div>
                {(debugData.summary?.skipReasons||[]).map(([reason,count])=>(
                  <div key={reason} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                    <span style={{fontSize:8,color:R,flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{reason}</span>
                    <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0,marginLeft:8}}>
                      <div style={{width:50}}><Bar v={count} c={R} max={Math.max(...(debugData.summary?.skipReasons||[]).map(([,c])=>c),1)}/></div>
                      <span style={{fontSize:8,color:DIM,minWidth:16,textAlign:"right"}}>{count}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          SETTINGS
         ══════════════════════════════════════════════════════ */}
      {view==="settings" && (
        <div style={{flex:1,padding:"10px 12px",overflowY:"auto"}}>
          <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:12}}>SETTINGS</div>

          {/* Algo info */}
          <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,padding:"12px",marginBottom:10}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:10}}>ALGORITHMS RUNNING</div>
            {["a","b","c","d"].map(k=>(
              <div key={k} style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:10}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:ALGO_COLORS[k],marginTop:3,flexShrink:0}}/>
                <div>
                  <div style={{fontSize:10,fontWeight:700,color:ALGO_COLORS[k]}}>{ALGO_NAMES[k]}</div>
                  <div style={{fontSize:8,color:DIM,marginTop:2}}>{ALGOS_DESC[k]}</div>
                </div>
              </div>
            ))}
          </div>

          {/* NTFY status */}
          <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,padding:"12px",marginBottom:10}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:6}}>NOTIFICATIONS</div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontSize:9,color:"white"}}>NTFY Alerts</div>
              <div style={{fontSize:9,padding:"3px 10px",borderRadius:6,background:`${R}18`,color:R,border:`1px solid ${R}44`}}>
                DISABLED
              </div>
            </div>
            <div style={{fontSize:8,color:DIM,marginTop:6}}>
              Disabled during A/B test. 4 algos would create too many notifications. Re-enable when winner is picked.
            </div>
          </div>

          {/* Data wipe */}
          <div style={{background:CARD,border:`1px solid ${R}33`,borderRadius:10,padding:"12px",marginBottom:10}}>
            <div style={{fontSize:7,color:R,letterSpacing:2,marginBottom:6}}>DANGER ZONE</div>
            <button className="btn" onClick={()=>setWipeModal(true)}
              style={{width:"100%",padding:"10px",background:`${R}18`,color:R,
                borderRadius:8,fontSize:10,fontWeight:900,letterSpacing:2,
                border:`1px solid ${R}44`}}>
              WIPE ALL DATA
            </button>
            <div style={{fontSize:8,color:DIM,marginTop:6,textAlign:"center"}}>
              Clears all 4 algorithm trade histories. Cannot be undone.
            </div>
          </div>

          {/* Version info */}
          <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,padding:"12px"}}>
            <div style={{fontSize:7,color:DIM,letterSpacing:2,marginBottom:6}}>VERSION</div>
            <div style={{fontSize:9,color:"white"}}>S0NAR Iron Dome v6.0 — LAB</div>
            <div style={{fontSize:8,color:DIM,marginTop:4}}>Poll: 15s · Check: 30s · 42 queries</div>
            <div style={{fontSize:8,color:DIM,marginTop:2}}>Exit: T1:{TIER1}x T2:{TIER2}x T3:{TIER3}x · Max {MAX_HOLD}m</div>
          </div>
        </div>
      )}

      {/* ── WIPE MODAL ── */}
      {wipeModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",
          alignItems:"center",justifyContent:"center",zIndex:100,padding:"20px"}}>
          <div style={{background:CARD,border:`1px solid ${R}44`,borderRadius:12,
            padding:"20px",width:"100%",maxWidth:320}}>
            <div style={{fontSize:12,fontWeight:900,color:R,marginBottom:8,textAlign:"center"}}>
              WIPE ALL DATA
            </div>
            <div style={{fontSize:9,color:DIM,marginBottom:16,textAlign:"center"}}>
              This will delete all trades and signals from all 4 algorithms. Enter your password to confirm.
            </div>
            <input type="password" value={wipePw}
              onChange={e=>setWipePw(e.target.value)}
              placeholder="Confirm password"
              style={{width:"100%",padding:"10px",background:"#060a0d",
                border:`1px solid ${BORDER}`,borderRadius:8,color:"#b0c8d8",
                fontFamily:"monospace",fontSize:12,outline:"none",marginBottom:8,
                textAlign:"center",letterSpacing:4}}
            />
            {wipeMsg && <div style={{fontSize:9,color:wipeMsg.includes("Wiped")?G:R,marginBottom:8,textAlign:"center"}}>{wipeMsg}</div>}
            <div style={{display:"flex",gap:8}}>
              <button className="btn" onClick={()=>{setWipeModal(false);setWipePw("");setWipeMsg("");}}
                style={{flex:1,padding:"10px",background:"transparent",color:DIM,
                  border:`1px solid ${BORDER}`,borderRadius:8,fontSize:10}}>
                CANCEL
              </button>
              <button className="btn" onClick={doWipe} disabled={!wipePw.trim()}
                style={{flex:1,padding:"10px",background:`${R}22`,color:R,
                  border:`1px solid ${R}44`,borderRadius:8,fontSize:10,fontWeight:900}}>
                WIPE
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{padding:"5px",borderTop:`1px solid ${BORDER}`,background:CARD,
        fontSize:6,color:"#0c1820",textAlign:"center"}}>
        S0NAR v6.0 · 4-ALGO LAB · PAPER TRADING · NOT FINANCIAL ADVICE
      </div>
    </div>
  );
}

// Algo descriptions for compare/settings views
const ALGOS_DESC = {
  a: "Low FOMO (15-45) + high liq ($50k+) + quiet price (-5% to +15%). The BGOLD pattern.",
  b: "Confirms move starting. FOMO 40-70, price +10-40%, moderate liq. Enter on confirmation.",
  c: "Ultra early — first 15 minutes only. Higher risk, potentially much higher reward.",
  d: "Current v5.5 system unchanged. Control group for comparison.",
};
