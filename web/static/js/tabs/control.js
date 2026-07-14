// 성능·제어 탭: 처리 성능/지연 + 물체·속도벡터 표 + 실시간 파라미터 조정.
// 데이터는 status-store 의 'nit-status' 이벤트(= /api/status + /api/detections)를 구독.
import { api } from '../common/api.js';
import { renderSliders, setSlider, readSlider, setStatus } from '../common/sliders.js';

const STAGE_KEYS = ['stage1', 'stage2', 'stage3', 'det', 'track', 'enc'];
const STAGE_LABELS = {
  stage1: 'Stage1 (저조도/안개)', stage2: 'Stage2 화질향상', stage3: 'Stage3 표적강조',
  det: 'YOLO 탐지', track: '트래킹', enc: 'JPEG 인코딩',
};
const DETECTOR_KEYS = new Set(['conf', 'iou', 'max_det']);
const TRACKER_KEYS = ['max_age', 'vel_damping', 'vel_alpha', 'arrow_scale', 'base_gate',
  'iou_merge_gate', 'max_speed', 'min_hits', 'label_lock_min_count'];

let _speedThresh = 0.3;
let _totalEma = null;
let _onStatus = null;
const $ = (id) => document.getElementById(id);
const fmt = (n, d = 1) => (Number.isFinite(n) ? n : 0).toFixed(d);

// ── 설정 로드/적용 (Streamlit _controls_panel 과 동일한 엔드포인트) ──────────
async function loadConfig() {
  try {
    const t = await api.get('/api/tracker/config');
    if (Number.isFinite(Number(t.speed_thresh))) _speedThresh = Number(t.speed_thresh);
    TRACKER_KEYS.forEach((k) => { if (t[k] != null) setSlider(k, t[k]); });
    if ($('ctl-label_lock')) $('ctl-label_lock').checked = Boolean(t.label_lock);
  } catch (e) { /* idle */ }
  try {
    const d = await api.get('/api/detector/config');
    ['conf', 'iou', 'max_det'].forEach((k) => { if (d[k] != null) setSlider(k, d[k]); });
  } catch (e) { /* idle */ }
}

async function applyConfig() {
  const det = {}, trk = {};
  document.querySelectorAll('#view-control .ctl-slider').forEach((box) => {
    const [key, val] = readSlider(box);
    if (val == null) return;
    (DETECTOR_KEYS.has(key) ? det : trk)[key] = val;
  });
  if ($('ctl-label_lock')) trk.label_lock = $('ctl-label_lock').checked;
  const r1 = await api.post('/api/detector/config', det);
  const r2 = await api.post('/api/tracker/config', trk);
  setStatus('ctl-status', (r1.ok && r2.ok) ? '적용 완료 — 다음 프레임부터 반영' : '일부 적용 실패', r1.ok && r2.ok);
}

// ── 성능/지연 (Streamlit _render 의 timing 파트와 동일) ──────────────────────
function renderPerf(status) {
  const t = (status && status.timings_ms) || {};
  const total = Number(t.total) || 0;
  _totalEma = _totalEma == null ? total : _totalEma * 0.9 + total * 0.1;
  $('m-procfps').textContent = status && status.proc_fps ? fmt(status.proc_fps, 2) : '--';
  $('m-total').innerHTML = _totalEma > 0 ? `${fmt(_totalEma, 1)} <span class="text-sm">ms</span>` : '--';
  $('m-fps').textContent = status && status.fps ? fmt(status.fps, 2) : '--';
  $('m-frames').textContent = status ? (status.frame_idx || 0).toLocaleString() : '--';

  const avg = {};
  STAGE_KEYS.forEach((k) => { avg[k] = Number(t[k]) || 0; });
  const sum = STAGE_KEYS.reduce((s, k) => s + avg[k], 0);
  let bneck = null, bmax = -1;
  STAGE_KEYS.forEach((k) => { if (avg[k] > bmax) { bmax = avg[k]; bneck = k; } });
  const denom = sum || 1;
  const wrap = $('perf-stages');
  if (sum <= 0) {
    wrap.innerHTML = '<div class="text-sm text-text-light-secondary dark:text-dark-secondary py-4 text-center">처리 대기 중…</div>';
  } else {
    wrap.innerHTML = STAGE_KEYS.map((k) => {
      const pct = Math.min(100, (avg[k] / denom) * 100);
      const mark = k === bneck ? ' <span class="text-primary font-bold">⬅ 병목</span>' : '';
      const c = k === bneck ? 'bg-primary' : 'bg-blue-400 dark:bg-blue-500';
      return `<div>
        <div class="flex justify-between text-xs mb-0.5"><span>${STAGE_LABELS[k]}${mark}</span>
          <span class="font-mono text-text-light-secondary dark:text-dark-secondary">${fmt(avg[k], 1)} ms (${Math.round(pct)}%)</span></div>
        <div class="w-full h-2 rounded bg-gray-200 dark:bg-gray-700 overflow-hidden"><div class="h-full ${c} rounded" style="width:${pct}%"></div></div>
      </div>`;
    }).join('');
  }
  $('perf-summary').textContent = sum > 0 ? `파이프라인 합계 ≈ ${fmt(sum, 1)} ms/프레임 → 이론 최대 ≈ ${fmt(1000 / sum, 1)} FPS` : '';
}

// ── 물체·속도벡터 표 (Streamlit _render_objects 와 동일: fps 로 px/s 환산) ────
function dirArrow(vx, vy) {
  if (Math.abs(vx) < 1e-6 && Math.abs(vy) < 1e-6) return '·';
  const deg = Math.atan2(vy, vx) * 180 / Math.PI;
  return ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'][Math.floor((((deg + 360 + 22.5) % 360) / 45))];
}
const headingDeg = (vx, vy) => ((Math.atan2(vx, -vy) * 180 / Math.PI) % 360 + 360) % 360;

function renderObjects(det, fps) {
  const tracks = (det && det.tracks) || [];
  const usePs = Boolean(fps && fps > 0);
  const scale = usePs ? fps : 1.0;
  const otb = $('obj-tbody');
  if (!otb) return;
  let moving = 0;
  const rows = tracks.map((tk) => {
    const bb = tk.bbox || [0, 0, 0, 0];
    const cx = (Number(bb[0]) + Number(bb[2])) / 2, cy = (Number(bb[1]) + Number(bb[3])) / 2;
    const vx = Number(tk.vx) || 0, vy = Number(tk.vy) || 0;
    const svx = vx * scale, svy = vy * scale;
    const spdPf = Math.hypot(vx, vy);     // px/frame (정지 판정용)
    const spd = Math.hypot(svx, svy);     // 표시 속력
    let state, cls;
    if (tk.is_predicted) { state = '예측(가려짐)'; cls = 'text-yellow-500'; }
    else if (spdPf < _speedThresh) { state = '정지'; cls = 'text-text-light-secondary dark:text-dark-secondary'; }
    else { state = '이동'; cls = 'text-green-500'; moving += 1; }
    return { tk, cx, cy, vx, vy, svx, svy, spd, spdPf, state, cls };
  });
  rows.sort((a, b) => (a.state !== '이동') - (b.state !== '이동') || b.spd - a.spd);
  otb.innerHTML = rows.length ? rows.map((r) => {
    const h = r.spdPf >= _speedThresh ? Math.round(headingDeg(r.vx, r.vy)) : '·';
    return `<tr class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
      <td class="px-2 py-1.5 font-mono font-bold">#${r.tk.track_id}</td><td class="px-2 py-1.5 font-bold">${r.tk.label ?? '?'}</td>
      <td class="px-2 py-1.5 font-mono text-xs">(${r.cx.toFixed(0)}, ${r.cy.toFixed(0)})</td><td class="px-2 py-1.5 font-mono">${r.spd.toFixed(1)}</td>
      <td class="px-2 py-1.5 font-mono text-xs">(${r.svx >= 0 ? '+' : ''}${r.svx.toFixed(1)}, ${r.svy >= 0 ? '+' : ''}${r.svy.toFixed(1)})</td>
      <td class="px-2 py-1.5 font-mono">${h}</td><td class="px-2 py-1.5 text-lg">${dirArrow(r.vx, r.vy)}</td>
      <td class="px-2 py-1.5 font-medium ${r.cls}">${r.state}</td></tr>`;
  }).join('') : '<tr><td colspan="8" class="py-8 text-text-light-secondary dark:text-dark-secondary">표시할 트랙이 없습니다.</td></tr>';
  $('o-total').textContent = String(tracks.length);
  $('o-moving').textContent = String(moving);
  const unit = usePs ? 'px/s (소스 fps 환산)' : 'px/frame (fps 미상)';
  $('obj-caption').textContent = tracks.length
    ? `좌표·벡터: 처리 해상도 화면좌표(좌상단 원점, y 아래로+) · 단위 ${unit} · 방위: 위=0° 시계방향 · '정지' 속도<${_speedThresh}px/f`
    : '';
}

export function init() {
  renderSliders(document.getElementById('view-control'));
  loadConfig();
  $('ctl-apply').addEventListener('click', applyConfig);
  $('ctl-reload').addEventListener('click', () => { loadConfig(); setStatus('ctl-status', '현재값 불러옴', true); });

  _onStatus = (e) => {
    const d = e.detail;
    if (!d || !d.online) return;
    renderPerf(d.status);
    renderObjects(d.det, d.status && d.status.fps);
  };
  window.addEventListener('nit-status', _onStatus);
}

export function destroy() {
  if (_onStatus) { window.removeEventListener('nit-status', _onStatus); _onStatus = null; }
}
