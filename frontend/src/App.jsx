// S0NAR App.jsx v8.0 — 5-Algorithm Lab | iOS Optimized
import React, { useState, useEffect, useRef, useCallback } from "react";

// ── CONSTANTS ──────────────────────────────────────────────
const API = "";

const ALGO_COLORS = {
  a: "#ce93d8",
  b: "#40c4ff",
  c: "#ffd740",
  d: "#00e676",
  e: "#ff6b6b",
};
const ALGO_NAMES = {
  a: "BGOLD",
  b: "MOMENTUM",
  c: "EARLY",
  d: "CONTROL",
  e: "SMART $",
};
const ALGO_FULL_NAMES = {
  a: "BGOLD HUNTER",
  b: "MOMENTUM",
  c: "EARLY MOVER",
  d: "CONTROL",
  e: "SMART WALLET",
};
const ALGOS_DESC = {
  a: "Low FOMO (15-45) + liq $30k+ + quiet price. Proven winner profile.",
  b: "Confirms move starting. FOMO 40-70, price +10-40%. Enter on confirmation.",
  c: "Ultra early — first 15 minutes only. Higher risk, higher reward.",
  d: "v5.5 system unchanged. Control group for comparison.",
  e: "Follows wallets with proven 60%+ win rates. Copies smart money.",
};

// Colors
const BG     = "#060a0d";
const CARD   = "#0b1016";
const BORDER = "#12202c";
const DIM    = "#2d4a5e";
const G      = "#00e676";
const R      = "#ff1744";
const Y      = "#ffd740";
const B      = "#40c4ff";

// ── UTILS ──────────────────────────────────────────────────
const num   = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const fix2  = v => num(v).toFixed(2);
const fix1  = v => num(v).toFixed(1);
const fix0  = v => Math.round(num(v)).toString();
const fmt$  = (v, sign = true) => {
  const n = num(v);
  const prefix = sign && n > 0 ? "+" : n < 0 ? "-" : "";
  return prefix + "$" + Math.abs(n).toFixed(2);
};
const fmtK  = v => num(v) >= 1e6 ? (num(v)/1e6).toFixed(1)+"M" : num(v) >= 1e3 ? (num(v)/1e3).toFixed(1)+"K" : Math.round(num(v)).toString();
const sc2c  = s => num(s) >= 85 ? G : num(s) >= 75 ? Y : num(s) >= 65 ? "#ff9100" : R;
const fomo2c = f => num(f) >= 75 ? R : num(f) >= 55 ? "#ff9100" : num(f) >= 35 ? Y : num(f) >= 20 ? "#64ffda" : DIM;

// ── EQUITY CHART ───────────────────────────────────────────
function EqChart({ data = [], color = G, id = "" }) {
  const safe = (data || []).map(v => num(v));
  if (safe.length < 2) return (
    <div style={{ height: 44, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: DIM }}>
      No trades yet
    </div>
  );
  const min = Math.min(...safe), max = Math.max(...safe), range = max - min || 1;
  const W = 300, H = 44;
  const gradId = `eg-${id}`;
  const pts = safe.map((v, i) => `${(i / (safe.length - 1)) * W},${H - ((v - min) / range) * (H - 6) - 3}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H }} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity=".25" />
          <stop offset="100%" stopColor={color} stopOpacity=".02" />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${pts} ${W},${H}`} fill={`url(#${gradId})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

// ── BAR ────────────────────────────────────────────────────
function Bar({ v = 0, c = G, max = 100 }) {
  return (
    <div style={{ background: "#0c1820", height: 3, borderRadius: 2, overflow: "hidden" }}>
      <div style={{ width: `${Math.min(100, (num(v) / Math.max(num(max), 1)) * 100)}%`, height: "100%", background: c, transition: "width .4s" }} />
    </div>
  );
}

// ── LOGIN ──────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [pw, setPw]         = useState("");
  const [err, setErr]       = useState("");
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
    <div style={{
      background: BG, minHeight: "100dvh", display: "flex", alignItems: "center",
      justifyContent: "center", fontFamily: "'Courier New',monospace",
      padding: "env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)",
    }}>
      <div style={{ width: "100%", maxWidth: 320, padding: "0 24px", textAlign: "center" }}>
        <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: 4, color: G, marginBottom: 4 }}>◉ S0NAR</div>
        <div style={{ fontSize: 9, color: DIM, letterSpacing: 3, marginBottom: 6 }}>IRON DOME v8.0</div>
        <div style={{ fontSize: 8, color: ALGO_COLORS.e, marginBottom: 32 }}>5-ALGORITHM LAB</div>

        <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 16, padding: "24px 20px" }}>
          <div style={{ fontSize: 8, color: DIM, letterSpacing: 2, marginBottom: 14 }}>ACCESS CODE</div>
          <input
            type="password" value={pw}
            onChange={e => setPw(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleLogin()}
            placeholder="Enter password"
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
            style={{
              width: "100%", padding: "14px", background: "#060a0d",
              border: `1px solid ${err ? R : BORDER}`,
              borderRadius: 10, color: "#b0c8d8", fontFamily: "monospace",
              fontSize: 16, outline: "none", marginBottom: 10,
              textAlign: "center", letterSpacing: 4,
              WebkitAppearance: "none",
            }}
          />
          {err && <div style={{ fontSize: 10, color: R, marginBottom: 10 }}>{err}</div>}
          <button
            onClick={handleLogin}
            disabled={loading || !pw.trim()}
            style={{
              width: "100%", padding: "14px",
              background: loading ? CARD : G,
              color: loading ? DIM : "#000",
              border: "none", borderRadius: 10,
              fontFamily: "monospace", fontSize: 12, fontWeight: 900, letterSpacing: 2,
              cursor: loading ? "not-allowed" : "pointer",
              WebkitTapHighlightColor: "transparent",
              minHeight: 48,
            }}
          >
            {loading ? "VERIFYING..." : "ENTER"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ALGO CARD ──────────────────────────────────────────────
function AlgoCard({ stat, isSelected, onClick }) {
  if (!stat) {
    // Placeholder card
    return (
      <div style={{
        background: CARD, border: `1px solid ${BORDER}`,
        borderRadius: 12, padding: "12px", minHeight: 120,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <div style={{ fontSize: 8, color: DIM }}>LOADING...</div>
      </div>
    );
  }
  const c      = ALGO_COLORS[stat.algo];
  const profit = num(stat.totalPnl) >= 0;

  return (
    <div
      onClick={onClick}
      style={{
        background: CARD,
        border: `1px solid ${isSelected ? c + "88" : BORDER}`,
        borderRadius: 12, padding: "12px", cursor: "pointer",
        borderLeft: `3px solid ${c}`,
        WebkitTapHighlightColor: "transparent",
        userSelect: "none",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <div style={{ minWidth: 0, flex: 1, paddingRight: 8 }}>
          <div style={{ fontSize: 7, color: c, letterSpacing: 1, marginBottom: 1, fontWeight: 700 }}>{ALGO_FULL_NAMES[stat.algo]}</div>
          {stat.algo === "e" && (
            <div style={{ fontSize: 7, color: ALGO_COLORS.e, marginBottom: 1 }}>⚡ SMART MONEY</div>
          )}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 900, color: profit ? G : R }}>{fmt$(stat.totalPnl)}</div>
          <div style={{ fontSize: 7, color: DIM }}>${Math.round(stat.bankroll)}</div>
        </div>
      </div>

      <EqChart data={stat.equity || []} color={c} id={stat.algo} />

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 7, color: DIM }}>
        <span style={{ color: num(stat.winRate) >= 50 ? G : Y }}>{stat.winRate != null ? `${fix0(stat.winRate)}% WR` : "--"}</span>
        <span>{stat.totalTrades}t · {stat.openTrades} open</span>
        <span style={{ color: num(stat.profitFactor) >= 2 ? G : Y }}>{stat.profitFactor ? `${fix2(stat.profitFactor)}x PF` : "--"}</span>
      </div>
    </div>
  );
}

// ── MAIN APP ───────────────────────────────────────────────
export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem("sonar_token") || "");
  function handleLogin(t) { setToken(t); }
  function handleLogout() { localStorage.removeItem("sonar_token"); setToken(""); }
  if (!token) return <LoginScreen onLogin={handleLogin} />;
  return <AppInner token={token} headers={{ "X-Auth-Token": token }} onLogout={handleLogout} />;
}

function AppInner({ token, headers, onLogout }) {
  const [view,       setView]      = useState("lab");
  const [stats,      setStats]     = useState([]);
  const [trades,     setTrades]    = useState({});
  const [openPnl,    setOpenPnl]   = useState({});
  const [health,     setHealth]    = useState(null);
  const [online,     setOnline]    = useState(false);
  const [lastUp,     setLastUp]    = useState(null);
  const [selAlgo,    setSelAlgo]   = useState("a");
  const [wipeModal,  setWipeModal] = useState(false);
  const [wipePw,     setWipePw]    = useState("");
  const [wipeMsg,    setWipeMsg]   = useState("");
  const [debugData,  setDebugData] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const selAlgoRef = useRef(selAlgo);
  selAlgoRef.current = selAlgo;

  const fetchAll = useCallback(async () => {
    try {
      const [h, s] = await Promise.all([
        fetch(`${API}/health`, { headers }).then(r => r.json()),
        fetch(`${API}/api/stats`, { headers }).then(r => r.json()),
      ]);
      if (h?.error === "Unauthorized") { onLogout(); return; }
      setHealth(h || {});
      setStats(Array.isArray(s) ? s : []);
      setOnline(true);
      setLastUp(new Date());
    } catch { setOnline(false); }
  }, [headers, onLogout]);

  const fetchTrades = useCallback(async (algoKey) => {
    try {
      const t = await fetch(`${API}/api/trades/${algoKey}?limit=200`, { headers }).then(r => r.json());
      setTrades(prev => ({ ...prev, [algoKey]: Array.isArray(t) ? t : [] }));
    } catch {}
  }, [headers]);

  const fetchOpenPnl = useCallback(async () => {
    try {
      const p = await fetch(`${API}/api/open-pnl`, { headers }).then(r => r.json());
      if (p && typeof p === "object") setOpenPnl(p);
    } catch {}
  }, [headers]);

  const fetchDebug = useCallback(async (algoKey) => {
    try {
      const d = await fetch(`${API}/api/debug/${algoKey}`, { headers }).then(r => r.json());
      setDebugData(d);
    } catch {}
  }, [headers]);

  const doWipe = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/wipe`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ password: wipePw }),
      });
      const d = await r.json();
      if (d.ok) {
        setWipeMsg("Wiped. Fresh start.");
        setStats([]); setTrades({}); setOpenPnl({});
        setTimeout(() => { setWipeModal(false); setWipeMsg(""); setWipePw(""); fetchAll(); }, 2000);
      } else {
        setWipeMsg(d.error || "Failed");
      }
    } catch { setWipeMsg("Server error"); }
  }, [headers, wipePw, fetchAll]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([fetchAll(), fetchOpenPnl(), fetchTrades(selAlgoRef.current)]);
    setRefreshing(false);
  }, [fetchAll, fetchOpenPnl, fetchTrades]);

  useEffect(() => {
    fetchAll();
    fetchTrades(selAlgo);
    fetchOpenPnl();
    const id1 = setInterval(fetchAll,     15000);
    const id2 = setInterval(fetchOpenPnl,  8000);
    const id3 = setInterval(() => fetchTrades(selAlgoRef.current), 15000);
    return () => { clearInterval(id1); clearInterval(id2); clearInterval(id3); };
  }, []);

  useEffect(() => {
    fetchTrades(selAlgo);
    setDebugData(null);
  }, [selAlgo]);

  // Derived
  const selStat    = stats.find(s => s.algo === selAlgo);
  const selTrades  = trades[selAlgo] || [];
  const selPnl     = openPnl[selAlgo] || [];
  const selPnlMap  = new Map(selPnl.map(p => [p.pair_address, p]));
  const openTrades = selTrades.filter(t => t.status === "OPEN").sort((a, b) => num(b.fomo_score) - num(a.fomo_score));
  const closedTrades = selTrades.filter(t => t.status === "CLOSED");
  const totalUnrealized = selPnl.filter(p => p.unrealized_pnl != null).reduce((a, p) => a + num(p.unrealized_pnl), 0);
  const bestAlgo = stats.length ? stats.reduce((a, b) => num(a.totalPnl) > num(b.totalPnl) ? a : b, stats[0]) : null;
  const allAlgos = ["a","b","c","d","e"];
  const cfg = selStat?.config || {};
  const TIER1 = cfg.tier1 || 1.5;
  const TIER2 = cfg.tier2 || 3.0;
  const TIER3 = cfg.tier3 || 6.0;

  return (
    <div style={{
      background: BG, minHeight: "100dvh", color: "#b0c8d8",
      fontFamily: "'Courier New',monospace",
      maxWidth: 430, width: "100%", margin: "0 auto",
      display: "flex", flexDirection: "column",
      overflowX: "hidden",
      // iOS safe areas
      paddingBottom: "env(safe-area-inset-bottom)",
    }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body {
          overflow-x: hidden; width: 100%;
          -webkit-text-size-adjust: 100%;
          overscroll-behavior: none;
        }
        /* iOS tap highlight off everywhere */
        * { -webkit-tap-highlight-color: transparent; }
        /* Remove tap delay on iOS */
        button, a, [role="button"] { touch-action: manipulation; }
        ::-webkit-scrollbar { width: 2px; }
        ::-webkit-scrollbar-thumb { background: ${BORDER}; }
        /* Prevent content jumping on iOS when keyboard opens */
        input, textarea, select { font-size: 16px !important; }
        @keyframes glow { 0%,100%{opacity:1} 50%{opacity:.45} }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.1} }
        @keyframes spin { to{transform:rotate(360deg)} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(-4px)} to{opacity:1;transform:translateY(0)} }
        .btn { cursor: pointer; border: none; font-family: monospace; touch-action: manipulation; }
        a { color: inherit; text-decoration: none; }
        /* iOS momentum scrolling */
        .scroll-area { overflow-y: auto; -webkit-overflow-scrolling: touch; }
      `}</style>

      {/* ── HEADER ── */}
      <div style={{
        padding: `calc(env(safe-area-inset-top) + 10px) 14px 8px`,
        borderBottom: `1px solid ${BORDER}`,
        background: CARD,
        position: "sticky", top: 0, zIndex: 20, width: "100%",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: 3, color: G, animation: "glow 4s ease-in-out infinite" }}>
              ◉ S0NAR
              <span style={{ fontSize: 8, color: ALGO_COLORS.e, marginLeft: 8, letterSpacing: 1 }}>v8</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: online ? G : R, animation: "blink 1.8s infinite", flexShrink: 0 }} />
                <span style={{ fontSize: 8, color: DIM }}>{online ? `LIVE · ${lastUp?.toLocaleTimeString()}` : "OFFLINE"}</span>
              </div>
              {health?.marketMood && (
                <span style={{ fontSize: 7, padding: "1px 6px", borderRadius: 6, background: "#ffd74018", color: Y, border: "1px solid #ffd74044" }}>
                  {String(health.marketMood).toUpperCase()}
                </span>
              )}
              {health?.heliusWs === "connected" && (
                <span style={{ fontSize: 7, padding: "1px 6px", borderRadius: 6, background: `${ALGO_COLORS.e}18`, color: ALGO_COLORS.e, border: `1px solid ${ALGO_COLORS.e}44` }}>
                  WS LIVE
                </span>
              )}
              <span style={{ fontSize: 7, color: DIM }}>#{health?.pollCount || 0}</span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            <button
              onClick={handleRefresh}
              className="btn"
              style={{ fontSize: 16, color: DIM, background: "transparent", padding: "4px 8px", minWidth: 44, minHeight: 44, display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              <span style={{ display: "inline-block", animation: refreshing ? "spin 1s linear infinite" : "none" }}>↻</span>
            </button>
            <button
              onClick={onLogout}
              className="btn"
              style={{ fontSize: 8, color: DIM, background: "transparent", padding: "4px 8px", minHeight: 44 }}
            >
              LOCK
            </button>
          </div>
        </div>
      </div>

      {/* ── TABS ── */}
      <div style={{
        display: "flex", background: CARD,
        borderBottom: `1px solid ${BORDER}`,
        overflowX: "auto", WebkitOverflowScrolling: "touch",
        scrollbarWidth: "none",
      }}>
        {[["lab","LAB"],["trades","TRADES"],["compare","VS"],["debug","DEBUG"],["settings","⚙"]].map(([v, l]) => (
          <button
            key={v}
            className="btn"
            onClick={() => { setView(v); if (v === "debug") fetchDebug(selAlgo); }}
            style={{
              flex: "0 0 auto", padding: "10px 14px", fontSize: 9,
              color: view === v ? G : DIM,
              borderBottom: `2px solid ${view === v ? G : "transparent"}`,
              background: "transparent", whiteSpace: "nowrap",
              minHeight: 44,
            }}
          >
            {l}
          </button>
        ))}
      </div>

      {/* ── ALGO SELECTOR ── */}
      <div style={{
        display: "flex", gap: 6, padding: "8px 12px",
        background: CARD, borderBottom: `1px solid ${BORDER}`,
        overflowX: "auto", WebkitOverflowScrolling: "touch",
        scrollbarWidth: "none",
      }}>
        {allAlgos.map(k => (
          <button
            key={k}
            className="btn"
            onClick={() => setSelAlgo(k)}
            style={{
              flex: "0 0 auto", padding: "6px 12px", fontSize: 8, borderRadius: 20,
              background: selAlgo === k ? `${ALGO_COLORS[k]}22` : CARD,
              color: selAlgo === k ? ALGO_COLORS[k] : DIM,
              border: `1px solid ${selAlgo === k ? ALGO_COLORS[k] + "66" : BORDER}`,
              minHeight: 36,
            }}
          >
            {ALGO_NAMES[k]}
          </button>
        ))}
      </div>

      {/* ══════════════════════ LAB ══════════════════════════ */}
      {view === "lab" && (
        <div className="scroll-area" style={{ flex: 1, padding: "10px 12px", paddingBottom: 20 }}>

          {/* Best algo highlight */}
          {bestAlgo && num(bestAlgo.totalPnl) > 0 && (
            <div style={{
              background: `${ALGO_COLORS[bestAlgo.algo]}0c`,
              border: `1px solid ${ALGO_COLORS[bestAlgo.algo]}44`,
              borderRadius: 12, padding: "10px 14px", marginBottom: 10,
              display: "flex", justifyContent: "space-between", alignItems: "center",
              animation: "fadeIn .4s ease",
            }}>
              <div>
                <div style={{ fontSize: 7, color: ALGO_COLORS[bestAlgo.algo], letterSpacing: 2 }}>LEADING</div>
                <div style={{ fontSize: 15, fontWeight: 900, color: "white" }}>{ALGO_FULL_NAMES[bestAlgo.algo]}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 20, fontWeight: 900, color: G }}>{fmt$(bestAlgo.totalPnl)}</div>
                <div style={{ fontSize: 8, color: DIM }}>{fix0(bestAlgo.winRate)}% WR · {bestAlgo.totalTrades}t</div>
              </div>
            </div>
          )}

          {/* 5 algo cards — 2 col grid, E spans full width */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
            {["a","b","c","d"].map(k => {
              const s = stats.find(st => st.algo === k);
              return (
                <AlgoCard key={k} stat={s}
                  isSelected={selAlgo === k}
                  onClick={() => { setSelAlgo(k); setView("trades"); fetchTrades(k); }}
                />
              );
            })}
          </div>

          {/* Algo E — full width (special) */}
          {(() => {
            const s = stats.find(st => st.algo === "e");
            return (
              <div style={{ marginBottom: 10 }}>
                <AlgoCard stat={s}
                  isSelected={selAlgo === "e"}
                  onClick={() => { setSelAlgo("e"); setView("trades"); fetchTrades("e"); }}
                />
                {health?.smartWalletSignals > 0 && (
                  <div style={{ marginTop: 4, fontSize: 8, color: ALGO_COLORS.e, textAlign: "center", animation: "blink 1.5s infinite" }}>
                    ⚡ {health.smartWalletSignals} active smart wallet signal{health.smartWalletSignals > 1 ? "s" : ""}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Combined stats */}
          {stats.length === 5 && (
            <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "12px", marginBottom: 10 }}>
              <div style={{ fontSize: 7, color: DIM, letterSpacing: 2, marginBottom: 10 }}>COMBINED</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                {[
                  { l: "TOTAL TRADES", v: stats.reduce((a, s) => a + s.totalTrades, 0), c: "white" },
                  { l: "TOTAL P&L",    v: fmt$(stats.reduce((a, s) => a + num(s.totalPnl), 0)), c: stats.reduce((a, s) => a + num(s.totalPnl), 0) >= 0 ? G : R },
                  { l: "OPEN NOW",     v: stats.reduce((a, s) => a + s.openTrades, 0), c: Y },
                ].map(s => (
                  <div key={s.l} style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 7, color: DIM, marginBottom: 2 }}>{s.l}</div>
                    <div style={{ fontSize: 16, fontWeight: 900, color: s.c }}>{s.v}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {stats.length === 0 && (
            <div style={{ textAlign: "center", padding: "40px 20px", color: DIM, fontSize: 9 }}>
              {online ? "Loading algo data..." : "Server offline — tap ↻ to retry"}
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════ TRADES ═══════════════════════ */}
      {view === "trades" && (
        <div className="scroll-area" style={{ flex: 1, padding: "10px 12px", paddingBottom: 20 }}>

          {/* Algo header */}
          {selStat && (
            <div style={{
              background: CARD,
              border: `1px solid ${ALGO_COLORS[selAlgo]}33`,
              borderRadius: 12, padding: "12px", marginBottom: 10,
              borderLeft: `3px solid ${ALGO_COLORS[selAlgo]}`,
            }}>
              <div style={{ fontSize: 7, color: ALGO_COLORS[selAlgo], letterSpacing: 2, marginBottom: 4 }}>
                {ALGO_FULL_NAMES[selAlgo]}
                {selAlgo === "e" && <span style={{ marginLeft: 6 }}>⚡ SMART MONEY</span>}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div style={{ fontSize: 22, fontWeight: 900, color: num(selStat.totalPnl) >= 0 ? G : R }}>
                  {fmt$(selStat.totalPnl)}
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 15, fontWeight: 900, color: num(selStat.winRate) >= 50 ? G : Y }}>
                    {selStat.winRate != null ? `${fix0(selStat.winRate)}%` : "--"} WR
                  </div>
                  <div style={{ fontSize: 8, color: DIM }}>{selStat.totalTrades}t · {selStat.openTrades} open</div>
                </div>
              </div>
              <EqChart data={selStat.equity || []} color={ALGO_COLORS[selAlgo]} id={`sel-${selAlgo}`} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 7, color: DIM }}>
                <span>$1,000 start</span>
                <span style={{ color: ALGO_COLORS[selAlgo] }}>
                  avg win: {selStat.avgWin ? fmt$(selStat.avgWin) : "--"}
                </span>
                <span style={{ color: num(selStat.profitFactor) >= 2 ? G : Y }}>
                  PF: {selStat.profitFactor ? `${fix2(selStat.profitFactor)}x` : "--"}
                </span>
              </div>
            </div>
          )}

          {/* Open trades */}
          {openTrades.length > 0 && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontSize: 8, color: G, letterSpacing: 2 }}>OPEN · {openTrades.length}</div>
                {selPnl.length > 0 && (
                  <div style={{ fontSize: 13, fontWeight: 900, color: totalUnrealized >= 0 ? G : R }}>
                    {totalUnrealized >= 0 ? "+" : ""}{fmt$(totalUnrealized, false)} unrealized
                  </div>
                )}
              </div>

              {openTrades.map(t => {
                const live    = selPnlMap.get(t.pair_address);
                const hasPnl  = live && live.unrealized_pnl !== null;
                const pct     = hasPnl ? num(live.pct_change) : null;
                const upnl    = hasPnl ? num(live.unrealized_pnl) : null;
                const curMult = hasPnl ? num(live.mult) : null;
                const hiMult  = hasPnl ? num(live.highest_mult) : num(t.highest_mult || 1);
                const ageMin  = hasPnl ? num(live.age_min) : (Date.now() - new Date(t.opened_at).getTime()) / 60000;
                const warning = live?.warning || "ok";
                const ac      = ALGO_COLORS[selAlgo];
                const isSmart = t.smart_wallet_signal;

                return (
                  <div key={t.id} style={{
                    background: CARD,
                    border: `1px solid ${warning.includes("stop") ? R + "44" : ac + "33"}`,
                    borderRadius: 12, padding: "12px", marginBottom: 8,
                    borderLeft: `3px solid ${isSmart ? ALGO_COLORS.e : ac}`,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 15, fontWeight: 900, color: "white" }}>{t.ticker}</span>
                        {isSmart && <span style={{ fontSize: 7, padding: "1px 5px", borderRadius: 4, background: `${ALGO_COLORS.e}22`, color: ALGO_COLORS.e, border: `1px solid ${ALGO_COLORS.e}44` }}>⚡SMART</span>}
                        {t.is_stealth && <span style={{ fontSize: 7, padding: "1px 5px", borderRadius: 4, background: "#ce93d822", color: "#ce93d8", border: "1px solid #ce93d844" }}>STEALTH</span>}
                        {t.dex_url && <a href={t.dex_url} target="_blank" rel="noopener" style={{ fontSize: 10, color: B, minWidth: 44, minHeight: 44, display: "flex", alignItems: "center" }}>↗</a>}
                      </div>
                      <span style={{ fontSize: 8, color: G, animation: "blink 1.2s infinite" }}>● LIVE</span>
                    </div>

                    {hasPnl ? (
                      <div style={{ background: "#090f17", borderRadius: 10, padding: "10px", marginBottom: 6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div>
                            <div style={{ fontSize: 7, color: DIM, marginBottom: 2 }}>UNREALIZED</div>
                            <div style={{ fontSize: 18, fontWeight: 900, color: upnl >= 0 ? G : R }}>
                              {upnl >= 0 ? "+" : ""}{fmt$(upnl, false)}
                            </div>
                          </div>
                          <div style={{ textAlign: "center" }}>
                            <div style={{ fontSize: 7, color: DIM, marginBottom: 2 }}>NOW</div>
                            <div style={{ fontSize: 15, fontWeight: 900, color: pct >= 0 ? G : R }}>
                              {pct >= 0 ? "+" : ""}{fix1(pct)}%
                            </div>
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <div style={{ fontSize: 7, color: DIM, marginBottom: 2 }}>PEAK</div>
                            <div style={{ fontSize: 15, fontWeight: 900, color: G }}>{fix2(hiMult)}x</div>
                          </div>
                        </div>

                        {/* Tier progress */}
                        {curMult && curMult > 0 && (() => {
                          const next = curMult < TIER1 ? TIER1 : curMult < TIER2 ? TIER2 : TIER3;
                          const prev = curMult < TIER1 ? 1.0 : curMult < TIER2 ? TIER1 : TIER2;
                          const prog = Math.min(100, Math.max(0, ((curMult - prev) / (next - prev)) * 100));
                          const tc   = curMult >= TIER2 ? "#ce93d8" : curMult >= TIER1 ? G : Y;
                          return (
                            <div style={{ marginTop: 8 }}>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 7, color: DIM, marginBottom: 3 }}>
                                <span>{fix2(prev)}x</span>
                                <span style={{ color: tc }}>→ {fix2(next)}x</span>
                              </div>
                              <div style={{ background: "#0c1820", height: 4, borderRadius: 2, overflow: "hidden" }}>
                                <div style={{ width: `${prog}%`, height: "100%", background: tc, transition: "width .5s" }} />
                              </div>
                            </div>
                          );
                        })()}

                        {warning !== "ok" && (
                          <div style={{
                            marginTop: 6, padding: "4px 10px", borderRadius: 6, fontSize: 8,
                            textAlign: "center", fontWeight: 700,
                            background: warning.includes("stop") || warning === "near_trailing" ? `${R}18` : `${G}18`,
                            color: warning.includes("stop") || warning === "near_trailing" ? R : G,
                          }}>
                            {warning === "near_stop" ? "⚠ NEAR STOP LOSS" :
                             warning === "near_trailing" ? "⚠ NEAR TRAILING" :
                             warning === "near_tier2" ? "→ APPROACHING TIER 2" :
                             warning === "near_tier1" ? "→ APPROACHING TIER 1" : ""}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ background: "#090f17", borderRadius: 10, padding: "8px", marginBottom: 6, fontSize: 9, color: DIM, textAlign: "center" }}>
                        Fetching price...
                      </div>
                    )}

                    <div style={{ display: "flex", gap: 10, fontSize: 8, color: DIM, flexWrap: "wrap" }}>
                      <span>sc:<span style={{ color: sc2c(t.score) }}>{t.score}</span></span>
                      <span>fomo:<span style={{ color: fomo2c(t.fomo_score) }}>{t.fomo_score || 0}</span></span>
                      <span>bet:${t.bet_size}</span>
                      <span>age:{ageMin.toFixed(0)}m</span>
                      {t.rug_score > 0 && <span>rug:<span style={{ color: t.rug_score > 300 ? R : G }}>{t.rug_score}</span></span>}
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {/* Closed trades */}
          {closedTrades.length > 0 && (
            <>
              <div style={{ fontSize: 8, color: DIM, letterSpacing: 2, margin: "12px 0 8px" }}>
                CLOSED · {closedTrades.length}
              </div>
              {[...closedTrades].reverse().map(t => (
                <div key={t.id} style={{
                  background: CARD,
                  border: `1px solid ${t.is_stealth ? "#ce93d844" : BORDER}`,
                  borderRadius: 12, padding: "12px", marginBottom: 6,
                  borderLeft: `3px solid ${num(t.pnl) > 0 ? G : R}`,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 900, color: "white" }}>{t.ticker}</span>
                      {t.smart_wallet_signal && <span style={{ fontSize: 7, color: ALGO_COLORS.e }}>⚡</span>}
                      {t.is_stealth && <span style={{ fontSize: 7, padding: "1px 4px", borderRadius: 4, background: "#ce93d822", color: "#ce93d8" }}>S</span>}
                      {t.dex_url && <a href={t.dex_url} target="_blank" rel="noopener" style={{ fontSize: 10, color: B, minWidth: 44, minHeight: 44, display: "flex", alignItems: "center" }}>↗</a>}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 15, fontWeight: 900, color: num(t.pnl) > 0 ? G : R }}>{fmt$(t.pnl)}</div>
                      <div style={{ fontSize: 8, color: DIM }}>{fix2(t.exit_mult)}x · {t.exit_reason}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 10, marginTop: 4, fontSize: 8, color: DIM, flexWrap: "wrap" }}>
                    <span>sc:<span style={{ color: sc2c(t.score) }}>{t.score}</span></span>
                    <span>fomo:<span style={{ color: fomo2c(t.fomo_score) }}>{t.fomo_score || 0}</span></span>
                    <span>bet:${t.bet_size}</span>
                    <span>hi:{fix2(t.highest_mult)}x</span>
                  </div>
                  <div style={{ fontSize: 7, color: DIM, marginTop: 3 }}>
                    {t.opened_at ? new Date(t.opened_at).toLocaleTimeString() : ""} → {t.closed_at ? new Date(t.closed_at).toLocaleTimeString() : "—"}
                  </div>
                </div>
              ))}
            </>
          )}

          {selTrades.length === 0 && (
            <div style={{ textAlign: "center", padding: "40px 20px", color: DIM, fontSize: 9 }}>
              {online ? `${ALGO_FULL_NAMES[selAlgo]} scanning...` : "Server offline"}
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════ COMPARE ══════════════════════ */}
      {view === "compare" && (
        <div className="scroll-area" style={{ flex: 1, padding: "10px 12px", paddingBottom: 20 }}>
          <div style={{ fontSize: 7, color: DIM, letterSpacing: 2, marginBottom: 12 }}>HEAD TO HEAD</div>

          {/* Leaderboard */}
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "14px", marginBottom: 10 }}>
            <div style={{ fontSize: 7, color: DIM, letterSpacing: 2, marginBottom: 12 }}>LEADERBOARD</div>
            {[...stats].sort((a, b) => num(b.totalPnl) - num(a.totalPnl)).map((s, i) => (
              <div key={s.algo} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 15, fontWeight: 900, color: DIM, minWidth: 20 }}>#{i + 1}</div>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: ALGO_COLORS[s.algo], flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: ALGO_COLORS[s.algo] }}>{ALGO_FULL_NAMES[s.algo]}</div>
                  <div style={{ marginTop: 3 }}><Bar v={Math.max(0, s.winRate || 0)} c={ALGO_COLORS[s.algo]} /></div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 900, color: num(s.totalPnl) >= 0 ? G : R }}>{fmt$(s.totalPnl)}</div>
                  <div style={{ fontSize: 7, color: DIM }}>{s.winRate != null ? `${fix0(s.winRate)}% WR` : "no data"}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Stats table */}
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "14px", marginBottom: 10, overflowX: "auto" }}>
            <div style={{ fontSize: 7, color: DIM, letterSpacing: 2, marginBottom: 12 }}>STATS</div>
            <div style={{ minWidth: 340 }}>
              <div style={{ display: "grid", gridTemplateColumns: "72px repeat(5, 1fr)", gap: 4, marginBottom: 8 }}>
                <div />
                {allAlgos.map(k => (
                  <div key={k} style={{ fontSize: 7, color: ALGO_COLORS[k], textAlign: "center", fontWeight: 700 }}>{k.toUpperCase()}</div>
                ))}
              </div>
              {[
                { label: "P&L",      fn: s => fmt$(s.totalPnl) },
                { label: "WIN %",    fn: s => s.winRate != null ? `${fix0(s.winRate)}%` : "--" },
                { label: "TRADES",   fn: s => s.totalTrades },
                { label: "AVG WIN",  fn: s => s.avgWin ? fmt$(s.avgWin) : "--" },
                { label: "PF",       fn: s => s.profitFactor ? `${fix2(s.profitFactor)}x` : "--" },
              ].map(row => (
                <div key={row.label} style={{ display: "grid", gridTemplateColumns: "72px repeat(5, 1fr)", gap: 4, marginBottom: 6 }}>
                  <div style={{ fontSize: 7, color: DIM, display: "flex", alignItems: "center" }}>{row.label}</div>
                  {allAlgos.map(k => {
                    const s = stats.find(st => st.algo === k);
                    return (
                      <div key={k} style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 9, fontWeight: 700, color: ALGO_COLORS[k] }}>
                          {s ? row.fn(s) : "--"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* Algo rules */}
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "14px" }}>
            <div style={{ fontSize: 7, color: DIM, letterSpacing: 2, marginBottom: 12 }}>ALGORITHM RULES</div>
            {allAlgos.map(k => (
              <div key={k} style={{ marginBottom: 14, paddingBottom: 14, borderBottom: k !== "e" ? `1px solid ${BORDER}` : "none" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: ALGO_COLORS[k], marginBottom: 4 }}>
                  {ALGO_FULL_NAMES[k]}
                  {k === "e" && <span style={{ fontSize: 8, marginLeft: 6, color: ALGO_COLORS.e }}>⚡ NEW</span>}
                </div>
                <div style={{ fontSize: 8, color: DIM, marginBottom: 6 }}>{ALGOS_DESC[k]}</div>
                {k === "e" ? (
                  <div style={{ fontSize: 8, color: ALGO_COLORS.e }}>
                    Tracking {stats.find(s => s.algo === "e")?.smartWalletCount || 8} known profitable wallets via Helius websocket
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 10px", fontSize: 8, color: DIM }}>
                    <span>Score: <span style={{ color: "white" }}>{stats.find(s => s.algo === k)?.config?.minScore || "?"}–{stats.find(s => s.algo === k)?.config?.maxScore || "?"}</span></span>
                    <span>FOMO: <span style={{ color: "white" }}>{stats.find(s => s.algo === k)?.config?.minFomo || "?"}–{stats.find(s => s.algo === k)?.config?.maxFomo || "?"}</span></span>
                    <span>Liq: <span style={{ color: "white" }}>${fmtK(stats.find(s => s.algo === k)?.config?.minLiq || 0)}</span></span>
                    <span>Age: <span style={{ color: "white" }}>{stats.find(s => s.algo === k)?.config?.minAge || "?"}–{stats.find(s => s.algo === k)?.config?.maxAge || "?"}m</span></span>
                    <span>T1: <span style={{ color: "white" }}>{stats.find(s => s.algo === k)?.config?.tier1 || 1.5}x</span></span>
                    <span>T3: <span style={{ color: "white" }}>{stats.find(s => s.algo === k)?.config?.tier3 || 6}x</span></span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══════════════════════ DEBUG ════════════════════════ */}
      {view === "debug" && (
        <div className="scroll-area" style={{ flex: 1, padding: "10px 12px", paddingBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 7, color: DIM, letterSpacing: 2 }}>DEBUG — {ALGO_FULL_NAMES[selAlgo]}</div>
            <button
              className="btn"
              onClick={() => fetchDebug(selAlgo)}
              style={{ fontSize: 9, color: B, background: "transparent", border: `1px solid ${B}44`, padding: "6px 12px", borderRadius: 6, minHeight: 44 }}
            >
              ↻ REFRESH
            </button>
          </div>

          {selAlgo === "e" && debugData && (
            <div style={{ background: CARD, border: `1px solid ${ALGO_COLORS.e}33`, borderRadius: 12, padding: "12px", marginBottom: 10 }}>
              <div style={{ fontSize: 7, color: ALGO_COLORS.e, letterSpacing: 2, marginBottom: 8 }}>SMART WALLET STATUS</div>
              <div style={{ fontSize: 9, color: "white", marginBottom: 4 }}>
                Tracking {debugData.smartWallets?.length || 8} wallets · {debugData.activeSignals || 0} active signals
              </div>
              <div style={{ fontSize: 8, color: DIM }}>Helius websocket monitors these wallets in real-time. When 2+ wallets buy the same token within 5 minutes, Algo E enters.</div>
              {(debugData.smartWallets || []).slice(0, 3).map((w, i) => (
                <div key={i} style={{ fontSize: 7, color: DIM, marginTop: 4, fontFamily: "monospace" }}>
                  {w.slice(0, 20)}...
                </div>
              ))}
            </div>
          )}

          {!debugData && (
            <div style={{ textAlign: "center", padding: "40px", color: DIM, fontSize: 9 }}>
              Tap refresh to load debug data
            </div>
          )}

          {debugData && (
            <>
              <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "12px", marginBottom: 10 }}>
                <div style={{ fontSize: 7, color: DIM, letterSpacing: 2, marginBottom: 8 }}>ACTIVE RULES</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {[
                    { l: "SCORE", v: `${debugData.config?.minScore}–${debugData.config?.maxScore}`, c: ALGO_COLORS[selAlgo] },
                    { l: "FOMO",  v: `${debugData.config?.minFomo}–${debugData.config?.maxFomo}`,   c: "#ff9100" },
                    { l: "MIN LIQ", v: `$${fmtK(debugData.config?.minLiq || 0)}`,                  c: B },
                    { l: "AGE",   v: `${debugData.config?.minAge}–${debugData.config?.maxAge}m`,    c: Y },
                    { l: "TIER1", v: `${debugData.config?.tier1 || 1.5}x`,                         c: G },
                    { l: "TIER3", v: `${debugData.config?.tier3 || 6}x`,                           c: ALGO_COLORS.e },
                  ].map(s => (
                    <div key={s.l} style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 7, color: DIM }}>{s.l}</div>
                      <div style={{ fontSize: 12, fontWeight: 900, color: s.c }}>{s.v}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "12px" }}>
                <div style={{ fontSize: 7, color: DIM, letterSpacing: 2, marginBottom: 8 }}>LAST 50 SIGNALS</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
                  {[
                    { l: "SEEN",    v: debugData.summary?.total || 0,   c: "white" },
                    { l: "ENTERED", v: debugData.summary?.entered || 0, c: G },
                    { l: "SKIPPED", v: debugData.summary?.skipped || 0, c: R },
                    { l: "AVG SC",  v: debugData.summary?.avgScore || 0, c: ALGO_COLORS[selAlgo] },
                    { l: "AVG FOMO", v: debugData.summary?.avgFomo || 0, c: "#ff9100" },
                  ].map(s => (
                    <div key={s.l} style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 7, color: DIM }}>{s.l}</div>
                      <div style={{ fontSize: 16, fontWeight: 900, color: s.c }}>{s.v}</div>
                    </div>
                  ))}
                </div>

                <div style={{ fontSize: 7, color: DIM, marginBottom: 8 }}>TOP SKIP REASONS</div>
                {(debugData.summary?.skipReasons || []).map(([reason, count]) => (
                  <div key={reason} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 9, color: R, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{reason}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, marginLeft: 8 }}>
                      <div style={{ width: 50 }}>
                        <Bar v={count} c={R} max={Math.max(...(debugData.summary?.skipReasons || []).map(([, c]) => c), 1)} />
                      </div>
                      <span style={{ fontSize: 9, color: DIM, minWidth: 20, textAlign: "right" }}>{count}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ══════════════════════ SETTINGS ═════════════════════ */}
      {view === "settings" && (
        <div className="scroll-area" style={{ flex: 1, padding: "10px 12px", paddingBottom: 20 }}>
          <div style={{ fontSize: 7, color: DIM, letterSpacing: 2, marginBottom: 12 }}>SETTINGS</div>

          {/* Upgrades status */}
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "14px", marginBottom: 10 }}>
            <div style={{ fontSize: 7, color: DIM, letterSpacing: 2, marginBottom: 10 }}>v8.0 UPGRADES ACTIVE</div>
            {[
              { label: "Rugcheck API", desc: "Filters mint authority, LP unlock, honey pots", ok: true },
              { label: "Birdeye Holders", desc: "Blocks tokens with >70% top-10 concentration", ok: true },
              { label: "Helius Websocket", desc: "Monitors pump.fun + smart wallets in real-time", ok: !!health?.heliusWs && health.heliusWs === "connected" },
              { label: "Smart Wallet (Algo E)", desc: "Follows 8 proven profitable wallets", ok: true },
              { label: "Dynamic Exits", desc: "Each algo has optimized take-profit levels", ok: true },
            ].map(u => (
              <div key={u.label} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 10 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: u.ok ? G : R, marginTop: 4, flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: u.ok ? "white" : DIM }}>{u.label}</div>
                  <div style={{ fontSize: 8, color: DIM, marginTop: 1 }}>{u.desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Algo overview */}
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "14px", marginBottom: 10 }}>
            <div style={{ fontSize: 7, color: DIM, letterSpacing: 2, marginBottom: 10 }}>5 ALGORITHMS RUNNING</div>
            {allAlgos.map(k => (
              <div key={k} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 10 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: ALGO_COLORS[k], marginTop: 3, flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: ALGO_COLORS[k] }}>
                    {ALGO_FULL_NAMES[k]}
                    {k === "e" && <span style={{ fontSize: 8, marginLeft: 4 }}>⚡ NEW</span>}
                  </div>
                  <div style={{ fontSize: 8, color: DIM, marginTop: 2 }}>{ALGOS_DESC[k]}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Notifications */}
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "14px", marginBottom: 10 }}>
            <div style={{ fontSize: 7, color: DIM, letterSpacing: 2, marginBottom: 6 }}>NOTIFICATIONS</div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 10, color: "white" }}>NTFY Alerts</div>
              <div style={{ fontSize: 9, padding: "4px 12px", borderRadius: 6, background: `${R}18`, color: R, border: `1px solid ${R}44` }}>DISABLED</div>
            </div>
            <div style={{ fontSize: 8, color: DIM, marginTop: 6 }}>Disabled during A/B test. Re-enable when winner is picked.</div>
          </div>

          {/* Danger zone */}
          <div style={{ background: CARD, border: `1px solid ${R}33`, borderRadius: 12, padding: "14px", marginBottom: 10 }}>
            <div style={{ fontSize: 7, color: R, letterSpacing: 2, marginBottom: 8 }}>DANGER ZONE</div>
            <button
              className="btn"
              onClick={() => setWipeModal(true)}
              style={{
                width: "100%", padding: "14px",
                background: `${R}18`, color: R,
                borderRadius: 10, fontSize: 11, fontWeight: 900, letterSpacing: 2,
                border: `1px solid ${R}44`, minHeight: 48,
              }}
            >
              WIPE ALL DATA
            </button>
            <div style={{ fontSize: 8, color: DIM, marginTop: 6, textAlign: "center" }}>
              Clears all 5 algorithm histories. Cannot be undone.
            </div>
          </div>

          {/* Version */}
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "14px" }}>
            <div style={{ fontSize: 7, color: DIM, letterSpacing: 2, marginBottom: 6 }}>VERSION</div>
            <div style={{ fontSize: 10, color: "white" }}>S0NAR Iron Dome v8.0</div>
            <div style={{ fontSize: 8, color: DIM, marginTop: 3 }}>Poll: 15s · Check: 30s · 5 algos</div>
            <div style={{ fontSize: 8, color: DIM, marginTop: 2 }}>Helius WS · Rugcheck · Birdeye · Smart Wallets</div>
          </div>
        </div>
      )}

      {/* ── WIPE MODAL ── */}
      {wipeModal && (
        <div style={{
          position: "fixed", inset: 0,
          background: "rgba(0,0,0,0.85)",
          display: "flex", alignItems: "center", justifyContent: "center",
          zIndex: 100, padding: "20px",
          paddingBottom: "calc(20px + env(safe-area-inset-bottom))",
        }}>
          <div style={{
            background: CARD, border: `1px solid ${R}44`,
            borderRadius: 16, padding: "24px",
            width: "100%", maxWidth: 320,
          }}>
            <div style={{ fontSize: 13, fontWeight: 900, color: R, marginBottom: 10, textAlign: "center" }}>
              WIPE ALL DATA
            </div>
            <div style={{ fontSize: 10, color: DIM, marginBottom: 18, textAlign: "center" }}>
              Deletes all trades and signals from all 5 algorithms. Enter your password to confirm.
            </div>
            <input
              type="password" value={wipePw}
              onChange={e => setWipePw(e.target.value)}
              placeholder="Confirm password"
              autoCapitalize="none"
              style={{
                width: "100%", padding: "12px",
                background: "#060a0d",
                border: `1px solid ${BORDER}`,
                borderRadius: 10, color: "#b0c8d8",
                fontFamily: "monospace", fontSize: 16,
                outline: "none", marginBottom: 10,
                textAlign: "center", letterSpacing: 4,
                WebkitAppearance: "none",
              }}
            />
            {wipeMsg && <div style={{ fontSize: 10, color: wipeMsg.includes("Wiped") ? G : R, marginBottom: 10, textAlign: "center" }}>{wipeMsg}</div>}
            <div style={{ display: "flex", gap: 10 }}>
              <button
                className="btn"
                onClick={() => { setWipeModal(false); setWipePw(""); setWipeMsg(""); }}
                style={{
                  flex: 1, padding: "14px",
                  background: "transparent", color: DIM,
                  border: `1px solid ${BORDER}`,
                  borderRadius: 10, fontSize: 11, minHeight: 48,
                }}
              >
                CANCEL
              </button>
              <button
                className="btn"
                onClick={doWipe}
                disabled={!wipePw.trim()}
                style={{
                  flex: 1, padding: "14px",
                  background: `${R}22`, color: R,
                  border: `1px solid ${R}44`,
                  borderRadius: 10, fontSize: 11, fontWeight: 900, minHeight: 48,
                }}
              >
                WIPE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{
        padding: "6px",
        borderTop: `1px solid ${BORDER}`,
        background: CARD,
        fontSize: 7, color: "#0c1820", textAlign: "center",
      }}>
        S0NAR v8.0 · 5-ALGO LAB · PAPER TRADING · NOT FINANCIAL ADVICE
      </div>
    </div>
  );
}
