// 분석·시각화 탭: 처리 성능 추이 + 종류/속력/위치 분포 + 종류별 통계 표.
// 데이터는 status-store 의 'nit-status' 이벤트(= /api/status + /api/detections)를 구독.
// 차트는 전역 Chart.js(index.html CDN)를 사용한다.

const $ = (id) => document.getElementById(id);
const PALETTE = ['#ff8c00', '#3b82f6', '#22c55e', '#ef4444', '#a855f7', '#14b8a6',
  '#eab308', '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#8b5cf6'];
const MAX_POINTS = 60;         // 추이 차트에 유지할 프레임 수
const FRAME_W = 640, FRAME_H = 480;   // 처리 해상도(fit_input) 기준 산점도 축

let _onStatus = null;
let perfChart = null, classChart = null, speedChart = null, posChart = null;
const perfBuf = { labels: [], fps: [], total: [] };
let _seq = 0;

function themeColor() {
  return document.documentElement.classList.contains('dark') ? '#9ca3af' : '#4b5563';
}
function gridColor() {
  return document.documentElement.classList.contains('dark') ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.08)';
}

function makeCharts() {
  const Chart = window.Chart;
  if (!Chart) return false;
  Chart.defaults.color = themeColor();
  Chart.defaults.font.family = 'Nanum Gothic, Roboto, sans-serif';
  const grid = gridColor();

  perfChart = new Chart($('an-perf-chart'), {
    type: 'line',
    data: { labels: [], datasets: [
      { label: '처리 FPS', data: [], borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,.15)',
        yAxisID: 'y', tension: 0.3, pointRadius: 0, borderWidth: 2, fill: true },
      { label: '총 지연(ms)', data: [], borderColor: '#ff8c00', backgroundColor: 'rgba(255,140,0,.1)',
        yAxisID: 'y1', tension: 0.3, pointRadius: 0, borderWidth: 2 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { intersect: false, mode: 'index' },
      scales: {
        x: { display: false, grid: { color: grid } },
        y: { position: 'left', beginAtZero: true, title: { display: true, text: 'FPS' }, grid: { color: grid } },
        y1: { position: 'right', beginAtZero: true, title: { display: true, text: 'ms' }, grid: { drawOnChartArea: false } },
      },
      plugins: { legend: { labels: { boxWidth: 12 } } },
    },
  });

  classChart = new Chart($('an-class-chart'), {
    type: 'doughnut',
    data: { labels: [], datasets: [{ data: [], backgroundColor: PALETTE, borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { position: 'right', labels: { boxWidth: 12 } } } },
  });

  speedChart = new Chart($('an-speed-chart'), {
    type: 'bar',
    data: { labels: [], datasets: [{ label: '객체 수', data: [], backgroundColor: '#3b82f6', borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      scales: { x: { grid: { display: false }, title: { display: true, text: 'px/s' } },
                y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: grid } } },
      plugins: { legend: { display: false } } },
  });

  posChart = new Chart($('an-pos-chart'), {
    type: 'scatter',
    data: { datasets: [{ label: '객체 위치', data: [], backgroundColor: 'rgba(255,140,0,.65)' }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      scales: {
        x: { min: 0, max: FRAME_W, title: { display: true, text: 'x' }, grid: { color: grid } },
        y: { min: 0, max: FRAME_H, reverse: true, title: { display: true, text: 'y' }, grid: { color: grid } },
      },
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c) => `#${c.raw.id} ${c.raw.label} (${c.raw.x}, ${c.raw.y})` } } } },
  });
  return true;
}

function destroyCharts() {
  [perfChart, classChart, speedChart, posChart].forEach((c) => { try { c && c.destroy(); } catch (e) { /* ignore */ } });
  perfChart = classChart = speedChart = posChart = null;
  perfBuf.labels.length = 0; perfBuf.fps.length = 0; perfBuf.total.length = 0;
  _seq = 0;
}

function updatePerf(status) {
  if (!perfChart) return;
  const t = (status && status.timings_ms) || {};
  perfBuf.labels.push(_seq++);
  perfBuf.fps.push(Number(status && status.proc_fps) || 0);
  perfBuf.total.push(Number(t.total) || 0);
  while (perfBuf.labels.length > MAX_POINTS) { perfBuf.labels.shift(); perfBuf.fps.shift(); perfBuf.total.shift(); }
  perfChart.data.labels = perfBuf.labels;
  perfChart.data.datasets[0].data = perfBuf.fps;
  perfChart.data.datasets[1].data = perfBuf.total;
  perfChart.update('none');
}

function updateDistributions(det, fps) {
  const tracks = (det && det.tracks) || [];
  const scale = (fps && fps > 0) ? fps : 1.0;

  // 종류별 집계
  const groups = new Map();
  let moving = 0, spdSum = 0;
  const scatter = [];
  const speeds = [];
  tracks.forEach((tk) => {
    const label = tk.label ?? '?';
    const bb = tk.bbox || [0, 0, 0, 0];
    const cx = Math.round((Number(bb[0]) + Number(bb[2])) / 2);
    const cy = Math.round((Number(bb[1]) + Number(bb[3])) / 2);
    const w = Math.abs(Number(bb[2]) - Number(bb[0])), h = Math.abs(Number(bb[3]) - Number(bb[1]));
    const vx = Number(tk.vx) || 0, vy = Number(tk.vy) || 0;
    const spdPf = Math.hypot(vx, vy);
    const spd = spdPf * scale;
    const isMoving = !tk.is_predicted && spdPf >= 0.3;
    if (isMoving) moving += 1;
    spdSum += spd;
    speeds.push(spd);
    scatter.push({ x: cx, y: cy, r: Math.max(4, Math.min(16, 4 + spd / 20)), id: tk.track_id, label });

    const g = groups.get(label) || { count: 0, moving: 0, spd: 0, w: 0, h: 0 };
    g.count += 1; if (isMoving) g.moving += 1; g.spd += spd; g.w += w; g.h += h;
    groups.set(label, g);
  });

  // 요약 스탯
  $('an-total').textContent = String(tracks.length);
  $('an-moving').textContent = String(moving);
  $('an-avgspd').innerHTML = (tracks.length ? (spdSum / tracks.length).toFixed(1) : '0.0') + '<span class="text-sm font-normal"> px/s</span>';
  let top = '--', topN = -1;
  groups.forEach((g, k) => { if (g.count > topN) { topN = g.count; top = k; } });
  $('an-topclass').textContent = tracks.length ? top : '--';

  // 도넛(종류)
  if (classChart) {
    classChart.data.labels = [...groups.keys()];
    classChart.data.datasets[0].data = [...groups.values()].map((g) => g.count);
    classChart.update('none');
  }

  // 속력 히스토그램
  if (speedChart) {
    const bins = [0, 0, 0, 0, 0, 0];  // 0-25,25-50,50-100,100-200,200-400,400+
    const edges = [25, 50, 100, 200, 400, Infinity];
    speeds.forEach((s) => { for (let i = 0; i < edges.length; i++) { if (s < edges[i]) { bins[i]++; break; } } });
    speedChart.data.labels = ['0–25', '25–50', '50–100', '100–200', '200–400', '400+'];
    speedChart.data.datasets[0].data = bins;
    speedChart.update('none');
  }

  // 산점도(위치)
  if (posChart) {
    posChart.data.datasets[0].data = scatter;
    posChart.update('none');
  }

  // 종류별 표
  const tb = $('an-class-tbody');
  if (tb) {
    const entries = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
    tb.innerHTML = entries.length ? entries.map(([label, g]) => {
      const avgSpd = (g.spd / g.count).toFixed(1);
      const aw = Math.round(g.w / g.count), ah = Math.round(g.h / g.count);
      return `<tr><td class="px-2 py-1.5 font-bold">${label}</td><td class="px-2 py-1.5 font-mono">${g.count}</td>
        <td class="px-2 py-1.5 font-mono text-green-500">${g.moving}</td><td class="px-2 py-1.5 font-mono">${g.count - g.moving}</td>
        <td class="px-2 py-1.5 font-mono">${avgSpd}</td><td class="px-2 py-1.5 font-mono text-xs">${aw}×${ah}</td></tr>`;
    }).join('') : '<tr><td colspan="6" class="py-8 text-text-light-secondary dark:text-dark-secondary">추적된 객체 없음</td></tr>';
  }
}

export function init() {
  if (!makeCharts()) {
    const c = document.getElementById('view-analytics');
    if (c) c.insertAdjacentHTML('afterbegin',
      '<div class="p-4 mb-3 rounded-lg bg-red-100 text-red-700 text-sm">차트 라이브러리(Chart.js) 로드 실패 — 네트워크 연결을 확인하세요.</div>');
  }
  _onStatus = (e) => {
    const d = e.detail;
    if (!d || !d.online) return;
    updatePerf(d.status);
    updateDistributions(d.det, d.status && d.status.fps);
  };
  window.addEventListener('nit-status', _onStatus);
}

export function destroy() {
  if (_onStatus) { window.removeEventListener('nit-status', _onStatus); _onStatus = null; }
  destroyCharts();
}
