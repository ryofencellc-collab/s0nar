const API_BASE = '';
const UPDATE_MS = 5000;

async function init() {
  await updateAll();
  setInterval(updateAll, UPDATE_MS);
}

async function updateAll() {
  await Promise.all([
    updateHealth(),
    updateStats(),
    updateSignals(),
    updatePositions(),
    updateTrades(),
  ]);
}

async function updateHealth() {
  try {
    const res = await fetch('/health');
    const data = await res.json();
    
    const statusEl = document.getElementById('system-status');
    const detectionEl = document.getElementById('detection-status');
    const detectionDot = document.getElementById('detection-dot');
    const modeBadge = document.getElementById('mode-badge');
    
    if (data.status === 'ok') {
      statusEl.textContent = '✅ System Online';
      statusEl.className = 'status connected';
      
      detectionEl.textContent = `Active (${Math.floor(data.uptime / 60)}m)`;
      detectionDot.textContent = '🟢';
      
      modeBadge.textContent = data.paperTrading ? 'PAPER' : 'LIVE';
      modeBadge.className = data.paperTrading ? 'mode-badge' : 'mode-badge live';
      
      document.getElementById('uptime').textContent = formatDuration(data.uptime);
      document.getElementById('polls').textContent = data.stats?.polls || 0;
    } else {
      statusEl.textContent = '❌ System Error';
      statusEl.className = 'status error';
    }
  } catch (err) {
    document.getElementById('system-status').textContent = '❌ Disconnected';
    document.getElementById('system-status').className = 'status error';
  }
}

async function updateStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    
    document.getElementById('signals-count').textContent = data.signals24h || 0;
    document.getElementById('trades-count').textContent = data.trades?.total || 0;
    document.getElementById('open-count').textContent = data.trades?.open || 0;
    
    const pnl = parseFloat(data.trades?.total_pnl) || 0;
    const pnlEl = document.getElementById('pnl-total');
    pnlEl.textContent = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2);
    
    const pnlCard = document.getElementById('pnl-card');
    pnlCard.className = 'stat-card profit' + (pnl < 0 ? ' negative' : '');
  } catch (err) {}
}

async function updateSignals() {
  try {
    const res = await fetch('/api/signals');
    const signals = await res.json();
    
    const tbody = document.querySelector('#signals-table tbody');
    tbody.innerHTML = signals.slice(0, 20).map(s => {
      const time = new Date(s.detected_at).toLocaleTimeString();
      const liq = formatNumber(s.liquidity);
      const age = s.age_minutes ? s.age_minutes.toFixed(1) + 'm' : '-';
      const score = s.score || '-';
      const action = s.entered ? 
        '<span class="entered">ENTERED</span>' : 
        `<span class="skipped">${s.skip_reason || 'SKIPPED'}</span>`;
      
      return `
        <tr>
          <td>${time}</td>
          <td>${s.ticker || s.token_address?.slice(0, 8) + '...'}</td>
          <td>$${liq}</td>
          <td>${age}</td>
          <td>${score}</td>
          <td>${action}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {}
}

async function updatePositions() {
  try {
    const res = await fetch('/api/positions');
    const positions = await res.json();
    
    const container = document.getElementById('positions-container');
    
    if (positions.length === 0) {
      container.innerHTML = '<div class="empty-state">No open positions</div>';
      return;
    }
    
    container.innerHTML = positions.map(p => {
      const ageMin = Math.floor((Date.now() - new Date(p.entered_at).getTime()) / 60000);
      const mult = parseFloat(p.highest_mult || 1).toFixed(2);
      
      let statusClass = '';
      if (ageMin > 60) statusClass = 'danger';
      else if (ageMin > 30) statusClass = 'aging';
      
      return `
        <div class="position-card ${statusClass}">
          <div class="position-info">
            <h4>${p.ticker || 'Unknown'}</h4>
            <span>Entry: $${parseFloat(p.entry_price).toExponential(4)} • Size: $${parseFloat(p.position_size).toFixed(2)}</span>
          </div>
          <div class="position-metrics">
            <div class="value">${mult}x</div>
            <div class="label">Best</div>
          </div>
          <div class="position-metrics">
            <div class="value">${ageMin}m</div>
            <div class="label">Age</div>
          </div>
          <div class="position-metrics">
            <div class="value">${p.score}</div>
            <div class="label">Score</div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {}
}

async function updateTrades() {
  try {
    const res = await fetch('/api/trades');
    const trades = await res.json();
    
    const tbody = document.querySelector('#trades-table tbody');
    tbody.innerHTML = trades.slice(0, 10).map(t => {
      const time = new Date(t.entered_at).toLocaleTimeString();
      const entry = parseFloat(t.entry_price).toExponential(3);
      const size = '$' + parseFloat(t.position_size).toFixed(2);
      const exit = t.exit_reason || 'OPEN';
      const pnl = t.pnl ? 
        (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2) : 
        '-';
      const pnlClass = (t.pnl || 0) >= 0 ? 'positive' : 'negative';
      
      return `
        <tr>
          <td>${time}</td>
          <td>${t.ticker || t.token_address?.slice(0, 8) + '...'}</td>
          <td>${entry}</td>
          <td>${size}</td>
          <td>${exit}</td>
          <td class="${pnlClass}">${pnl}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {}
}

function formatNumber(num) {
  if (!num) return '0';
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return num.toFixed(0);
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (
