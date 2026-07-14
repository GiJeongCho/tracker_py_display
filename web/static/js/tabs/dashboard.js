// 대시보드 탭: 라이브(MJPEG) + 입력/모델 + 전처리 제어 + 탐지·추적 표.
import { api } from '../common/api.js';
import { renderSliders, setStatus } from '../common/sliders.js';

const FEEDS = [
  ['tracked', '추적 결과'], ['detect', '탐지(박스)'], ['stage3', '표적강조'],
  ['stage2', '화질향상'], ['stage1', '노이즈제거'], ['original', '원본'],
];

let _feed = 'tracked';
let _speedThresh = 0.3;
let _onStatus = null;
const $ = (id) => document.getElementById(id);

function reloadFeeds() {
  const after = $('img-after');
  if (after) after.src = api.mjpeg(_feed);
  const compare = $('compare-toggle') && $('compare-toggle').checked;
  const before = $('img-before');
  if ($('cell-before')) $('cell-before').style.display = compare ? 'flex' : 'none';
  if ($('live-wrap')) $('live-wrap').className = compare ? 'grid grid-cols-1 md:grid-cols-2 gap-3' : 'grid grid-cols-1 gap-3';
  if (before) before.src = compare ? api.mjpeg('original') : '';
  const label = (FEEDS.find((f) => f[0] === _feed) || [, _feed])[1];
  if ($('after-cap')) $('after-cap').textContent = label;
  if ($('live-info')) $('live-info').textContent = '스트림: ' + (api.base() || location.origin) + '/video_feed/' + _feed;
}

function buildFeedButtons() {
  const wrap = $('feed-buttons');
  if (!wrap) return;
  wrap.innerHTML = FEEDS.map(([id, label]) =>
    `<button class="feed-btn px-2 py-1 rounded text-xs font-medium bg-gray-100 dark:bg-gray-800 ${id === _feed ? 'active' : ''}" data-feed="${id}">${label}</button>`).join('');
  wrap.querySelectorAll('.feed-btn').forEach((b) => b.addEventListener('click', () => {
    _feed = b.dataset.feed;
    wrap.querySelectorAll('.feed-btn').forEach((x) => x.classList.toggle('active', x === b));
    reloadFeeds();
  }));
}

function fillSelect(sel, options, current) {
  if (!sel) return;
  sel.innerHTML = (options || []).map((o) =>
    `<option value="${o.id}" ${o.id === current ? 'selected' : ''}>${o.label || o.id}</option>`).join('');
}

function updateThLabel() {
  let lo = parseFloat($('pp-th-lo').value), hi = parseFloat($('pp-th-hi').value);
  if (hi < lo) hi = lo;
  $('pp-th-val').textContent = `[${lo.toFixed(0)} · ${hi.toFixed(0)}]`;
}

async function loadPreprocess() {
  try {
    const s1 = await api.get('/api/preprocess/stage1');
    if ($('pp-fog')) $('pp-fog').checked = s1.fog_enabled !== false;
    if ($('pp-dark')) $('pp-dark').checked = s1.dark_enabled !== false;
    if ($('pp-stage2')) $('pp-stage2').checked = Boolean(s1.stage2_enabled);
    if ($('pp-stage3')) $('pp-stage3').checked = Boolean(s1.stage3_enabled);
    if ($('pp-mode') && s1.mode) $('pp-mode').value = s1.mode;
    const gain = $('ctl-dark_gain'); if (gain) gain.value = s1.dark_gain != null ? s1.dark_gain : 1.0;
    const gd = $('val-dark_gain'); if (gd && gain) gd.textContent = gain.value;
    const lo = s1.foggy_th != null ? s1.foggy_th : 90;
    const hi = s1.foggy_th_high != null ? s1.foggy_th_high : 200;
    $('pp-th-lo').value = lo; $('pp-th-hi').value = Math.max(lo, hi); updateThLabel();
  } catch (e) { /* idle */ }
  try {
    const algos = await api.get('/api/preprocess/algorithms');
    fillSelect($('pp-qalgo'), algos.quality && algos.quality.options, algos.quality && algos.quality.current);
    fillSelect($('pp-ealgo'), algos.emphasis && algos.emphasis.options, algos.emphasis && algos.emphasis.current);
  } catch (e) { /* idle */ }
}

async function applyPreprocess() {
  let lo = parseFloat($('pp-th-lo').value), hi = parseFloat($('pp-th-hi').value);
  if (hi < lo) { const t = lo; lo = hi; hi = t; }
  const gain = $('ctl-dark_gain');
  const r1 = await api.post('/api/preprocess/stage1', {
    mode: $('pp-mode').value, foggy_th: lo, foggy_th_high: hi,
    fog_enabled: $('pp-fog').checked, dark_enabled: $('pp-dark').checked,
    dark_gain: gain ? parseFloat(gain.value) : 1.0,
    stage2_enabled: $('pp-stage2').checked, stage3_enabled: $('pp-stage3').checked,
  });
  const r2 = await api.post('/api/preprocess/algorithms', {
    quality_id: $('pp-qalgo').value || undefined,
    emphasis_id: $('pp-ealgo').value || undefined,
  });
  setStatus('pp-status', (r1.ok && r2.ok) ? '전처리 적용 완료' : '일부 적용 실패', r1.ok && r2.ok);
}

async function loadModels() {
  try {
    const m = await api.get('/api/detector/models');
    fillSelect2($('dash-model'), m.models || []);
  } catch (e) { /* idle */ }
}
function fillSelect2(sel, models) {
  if (!sel) return;
  sel.innerHTML = models.map((x) =>
    `<option value="${x.path}" ${x.current ? 'selected' : ''}>${x.name} · ${x.task || '?'} · ${x.size_mb || '?'}MB</option>`).join('');
}
async function switchModel() {
  const path = $('dash-model').value;
  if (!path) return;
  setStatus('dash-io-status', '모델 로드 중…', true);
  const r = await api.post('/api/detector/model', { path });
  if (r.ok) { setStatus('dash-io-status', '모델 교체됨: ' + path, true); reloadFeeds(); }
  else setStatus('dash-io-status', '모델 교체 실패: ' + (r.data.detail || r.data.error || ''), false);
}

async function applySource() {
  const src = $('dash-src').value.trim();
  if (!src) return;
  await api.post('/api/reset', {});
  const r = await api.post('/api/source', { source: src });
  if (r.ok) { setStatus('dash-io-status', '소스 적용: ' + (r.data.source || src), true); setTimeout(reloadFeeds, 400); }
  else setStatus('dash-io-status', '소스 적용 실패', false);
}
async function resetStream() {
  await api.post('/api/reset', {});
  setStatus('dash-io-status', '처리 중지 — 소스 해제됨', true);
  setTimeout(reloadFeeds, 300);
}
async function uploadFile(file) {
  if (!file) return;
  setStatus('dash-io-status', '업로드 중: ' + file.name, true);
  const r = await api.upload('/api/upload', file);
  if (r.ok) { setStatus('dash-io-status', '업로드 완료: ' + (r.data.filename || ''), true); setTimeout(reloadFeeds, 500); }
  else setStatus('dash-io-status', '업로드 실패: ' + (r.data.detail || r.data.error || ''), false);
}

function nowString() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function renderRight(det) {
  const now = $('dash-now'); if (now) now.textContent = nowString();
  const tracks = (det && det.tracks) || [];

  // 요약: 전차 종류별 개수 + 평균 크기(가로×세로 px)
  const sb = $('dash-summary');
  if (sb) {
    const groups = new Map();
    tracks.forEach((tk) => {
      const label = tk.label ?? '?';
      const bb = tk.bbox || [0, 0, 0, 0];
      const w = Math.abs(Number(bb[2]) - Number(bb[0])), h = Math.abs(Number(bb[3]) - Number(bb[1]));
      const g = groups.get(label) || { count: 0, w: 0, h: 0 };
      g.count += 1; g.w += w; g.h += h; groups.set(label, g);
    });
    sb.innerHTML = groups.size ? [...groups.entries()].map(([label, g]) => {
      const aw = Math.round(g.w / g.count), ah = Math.round(g.h / g.count);
      return `<tr><td class="px-2 py-1.5 font-mono text-xs">${aw}×${ah}</td><td class="px-2 py-1.5 font-bold">${label}</td><td class="px-2 py-1.5 font-mono">${g.count}</td></tr>`;
    }).join('') : '<tr><td colspan="3" class="py-4 text-text-light-secondary dark:text-dark-secondary">추적된 객체 없음</td></tr>';
  }

  // 상세표: 추적 ID / 전차 종류 / 좌표 / 속도(px/f)
  const tb = $('dash-tbody');
  if (tb) {
    tb.innerHTML = tracks.length ? tracks.map((tk) => {
      const bb = tk.bbox || [0, 0, 0, 0];
      const cx = Math.round((Number(bb[0]) + Number(bb[2])) / 2), cy = Math.round((Number(bb[1]) + Number(bb[3])) / 2);
      const spd = Math.hypot(Number(tk.vx) || 0, Number(tk.vy) || 0);
      return `<tr><td class="px-2 py-1.5 font-mono font-bold">#${tk.track_id}</td><td class="px-2 py-1.5 font-bold">${tk.label ?? '?'}</td>
        <td class="px-2 py-1.5 font-mono text-xs">(${cx}, ${cy})</td><td class="px-2 py-1.5 font-mono">${spd.toFixed(1)}</td></tr>`;
    }).join('') : '<tr><td colspan="4" class="py-8 text-text-light-secondary dark:text-dark-secondary">추적된 객체 없음</td></tr>';
  }
}

export function init() {
  renderSliders(document.getElementById('view-dashboard'));
  buildFeedButtons();
  reloadFeeds();
  loadPreprocess();
  loadModels();

  $('dash-upload').addEventListener('click', () => $('dash-file').click());
  $('dash-file').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) uploadFile(f); e.target.value = ''; });
  $('dash-source').addEventListener('click', applySource);
  $('dash-reset').addEventListener('click', resetStream);
  $('dash-model-apply').addEventListener('click', switchModel);

  $('compare-toggle').addEventListener('change', reloadFeeds);
  $('pp-apply').addEventListener('click', applyPreprocess);
  $('pp-reload').addEventListener('click', () => { loadPreprocess(); setStatus('pp-status', '현재값 불러옴', true); });
  $('pp-th-lo').addEventListener('input', updateThLabel);
  $('pp-th-hi').addEventListener('input', updateThLabel);

  _onStatus = (e) => { const d = e.detail; if (d && d.online) renderRight(d.det); };
  window.addEventListener('nit-status', _onStatus);
}

export function destroy() {
  if (_onStatus) { window.removeEventListener('nit-status', _onStatus); _onStatus = null; }
}
