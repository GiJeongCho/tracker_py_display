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
  // 비교 모드에서만 '처리 후' 제목을 보여 '처리 전' 제목과 Y축을 맞춘다.
  if ($('after-title')) $('after-title').style.display = compare ? 'block' : 'none';
  if ($('live-wrap')) $('live-wrap').className = compare ? 'grid grid-cols-1 md:grid-cols-2 gap-3' : 'grid grid-cols-1 gap-3';
  if (before) before.src = compare ? api.mjpeg('original') : '';
  const label = (FEEDS.find((f) => f[0] === _feed) || [, _feed])[1];
  if ($('after-cap')) $('after-cap').textContent = label;
}

function buildFeedButtons() {
  const wrap = $('feed-buttons');
  if (!wrap) return;
  wrap.innerHTML = FEEDS.map(([id, label]) =>
    `<button class="feed-btn ${id === _feed ? 'active' : ''}" data-feed="${id}">${label}</button>`).join('');
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
  } catch (e) { /* idle */ }
  try {
    const algos = await api.get('/api/preprocess/algorithms');
    fillSelect($('pp-falgo'), algos.fog && algos.fog.options, algos.fog && algos.fog.current);
    fillSelect($('pp-qalgo'), algos.quality && algos.quality.options, algos.quality && algos.quality.current);
    fillSelect($('pp-ealgo'), algos.emphasis && algos.emphasis.options, algos.emphasis && algos.emphasis.current);
  } catch (e) { /* idle */ }
}

async function applyPreprocess() {
  const gain = $('ctl-dark_gain');
  const r1 = await api.post('/api/preprocess/stage1', {
    mode: $('pp-mode').value,
    fog_enabled: $('pp-fog').checked, dark_enabled: $('pp-dark').checked,
    dark_gain: gain ? parseFloat(gain.value) : 1.0,
    stage2_enabled: $('pp-stage2').checked, stage3_enabled: $('pp-stage3').checked,
  });
  const r2 = await api.post('/api/preprocess/algorithms', {
    fog_id: $('pp-falgo').value || undefined,
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
let _trailOn = true;   // 마지막으로 켜졌을 때 복원할 두께 기억용
async function loadTrailState() {
  try {
    const t = await api.get('/api/tracker/config');
    const on = Number(t.trail_thickness) > 0;
    const el = $('trail-toggle'); if (el) el.checked = on;
    _trailOn = on;
  } catch (e) { /* idle */ }
}
async function applyTrail() {
  const on = $('trail-toggle').checked;
  _trailOn = on;
  // 켜짐=두께 2, 꺼짐=0. draw_tracks 가 trail_thickness>0 일 때만 경로를 그린다.
  const r = await api.post('/api/tracker/config', { trail_thickness: on ? 2 : 0 });
  setStatus('dash-io-status', on ? '이동 경로 표시 켬' : '이동 경로 표시 끔', r.ok);
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

// ── 실시간 정찰 보고(자연어 요약) ────────────────────────────────
const FRAME_W = 640, FRAME_H = 480;  // pipeline.fit_input 기준 해상도
// 이동/정차 판정 임계(px/s). px/frame 은 fps 에 따라 값이 요동쳐(저fps 스트림에서
// 정지도 이동으로 오판) 부적절 → 물리량인 px/s 로 판정한다. 이 값 미만은 정차.
const MOVE_THRESH_PXS = 8;

// 속도벡터(px/frame)의 방향을 화면 기준 상/하/좌/우(+대각)로. 크기 임계 없이
// 성분비로만 결정. (화면 y는 아래로 증가 → +y=하)
function _dirLRUD(vx, vy) {
  const ax = Math.abs(vx), ay = Math.abs(vy);
  if (ax < 1e-9 && ay < 1e-9) return '';
  const ew = ax >= ay * 0.4 ? (vx > 0 ? '우측' : '좌측') : '';
  const ns = ay >= ax * 0.4 ? (vy > 0 ? '하단' : '상단') : '';
  return [ew, ns].filter(Boolean).join(' ')
    || (ax > ay ? (vx > 0 ? '우측' : '좌측') : (vy > 0 ? '하단' : '상단'));
}

function _echelon(n) {
  if (n <= 0) return '미식별';
  if (n <= 2) return '소규모(단독~2대)';
  if (n <= 5) return '소대급';
  if (n <= 10) return '중대(-)급';
  return '중대급 이상';
}
function _region(cx, cy) {
  const col = cx < FRAME_W / 3 ? '좌측' : (cx < 2 * FRAME_W / 3 ? '중앙' : '우측');
  const row = cy < FRAME_H / 3 ? '상단' : (cy < 2 * FRAME_H / 3 ? '중앙' : '하단');
  return row === '중앙' && col === '중앙' ? '중앙' : `${col} ${row}`;
}

// 실시간 추적 결과 위 '정찰 보고'(자연어). 헤드라인(총계·규모) + 종류별 서술.
function renderReport(det, status) {
  const box = $('dash-report');
  if (!box) return;
  const tEl = $('report-time');
  if (tEl) tEl.textContent = nowString().slice(11);
  const tracks = (det && det.tracks) || [];
  if (!tracks.length) {
    box.innerHTML = '<p class="text-text-light-secondary dark:text-dark-secondary">표적 미식별 — 접촉 없음</p>';
    return;
  }
  const fps = (status && Number(status.fps)) || 25;
  const g = new Map();
  const kindCount = new Map();
  let movingTotal = 0;
  tracks.forEach((tk) => {
    const label = tk.label ?? '?';
    kindCount.set(label, (kindCount.get(label) || 0) + 1);
    const bb = tk.bbox || [0, 0, 0, 0];
    const cx = (Number(bb[0]) + Number(bb[2])) / 2, cy = (Number(bb[1]) + Number(bb[3])) / 2;
    const vx = Number(tk.vx) || 0, vy = Number(tk.vy) || 0;
    const spdPs = Math.hypot(vx, vy) * fps;   // px/s (물리량, fps 무관 판정)
    const o = g.get(label) || { n: 0, cx: 0, cy: 0, vx: 0, vy: 0, sp: 0, mv: 0, st: 0 };
    o.n += 1; o.cx += cx; o.cy += cy;
    if (spdPs > MOVE_THRESH_PXS) { o.vx += vx; o.vy += vy; o.sp += spdPs; o.mv += 1; movingTotal += 1; }
    else { o.st += 1; }
    g.set(label, o);
  });
  const total = tracks.length;
  const mixed = kindCount.size > 1 ? ' 혼성' : '';
  const head = `<p class="font-bold text-primary">■ 총 ${total}대 식별 (이동 ${movingTotal}·정차 ${total - movingTotal}) · 추정 규모 ${_echelon(total)}${mixed}</p>`;

  // 이동분 방향 텍스트: 평균 벡터가 상쇄돼 크기가 작으면 '여러 방향'으로.
  const dirText = (o) => {
    const avx = o.vx / o.mv, avy = o.vy / o.mv;
    const meanSpdPf = (o.sp / o.mv) / fps;       // 평균 개별 속력(px/frame)
    const avgMag = Math.hypot(avx, avy);          // 평균 벡터 크기(px/frame)
    if (o.mv > 1 && avgMag < 0.35 * meanSpdPf) return '여러 방향으로';  // 상쇄 → 방향 혼재
    const d = _dirLRUD(avx, avy);
    return d ? `${d}으로` : '여러 방향으로';
  };

  const lines = [...g.entries()].sort((a, b) => b[1].n - a[1].n).map(([label, o]) => {
    const cx = Math.round(o.cx / o.n), cy = Math.round(o.cy / o.n);
    const reg = _region(cx, cy);
    if (o.mv && o.st) {
      const sp = Math.round(o.sp / o.mv);
      return `<p>· 화면 <b>${reg}</b> 일대(${cx}, ${cy})에 <b>${label} ${o.n}대</b> — 이동 ${o.mv}대(평균 <b>${sp} px/s</b>, ${dirText(o)})·정차 ${o.st}대입니다.</p>`;
    }
    if (o.mv) {
      const sp = Math.round(o.sp / o.mv);
      return `<p>· 화면 <b>${reg}</b> 일대(${cx}, ${cy})에 <b>${label} ${o.n}대</b>, 평균 <b>${sp} px/s</b>로 ${dirText(o)} <b>이동 중</b>입니다.</p>`;
    }
    return `<p>· 화면 <b>${reg}</b> 일대(${cx}, ${cy})에 <b>${label} ${o.n}대</b> <b>정차 중</b>입니다.</p>`;
  });
  box.innerHTML = head + lines.join('');
}

// 라벨색 점(칩) — 비디오 박스색과 동일(백엔드 tk.color, hex). 없으면 생략.
function _dot(c) {
  return c ? `<span class="color-dot" style="background:${c}"></span>` : '';
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
    // 요약은 '종류별' 집계이므로 색 점을 붙이지 않는다(색은 ID별이라 대표색이 무의미).
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
      return `<tr><td class="px-2 py-1.5 font-mono font-bold">#${tk.track_id}</td><td class="px-2 py-1.5 font-bold">${_dot(tk.color)}${tk.label ?? '?'}</td>
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
  loadTrailState();

  $('dash-upload').addEventListener('click', () => $('dash-file').click());
  $('dash-file').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) uploadFile(f); e.target.value = ''; });
  $('dash-source').addEventListener('click', applySource);
  $('dash-reset').addEventListener('click', resetStream);
  $('dash-model-apply').addEventListener('click', switchModel);

  $('compare-toggle').addEventListener('change', reloadFeeds);
  $('trail-toggle').addEventListener('change', applyTrail);
  $('pp-apply').addEventListener('click', applyPreprocess);
  $('pp-reload').addEventListener('click', () => { loadPreprocess(); setStatus('pp-status', '현재값 불러옴', true); });

  _onStatus = (e) => {
    const d = e.detail;
    if (d && d.online) { renderRight(d.det); renderReport(d.det, d.status); }
  };
  window.addEventListener('nit-status', _onStatus);
}

export function destroy() {
  if (_onStatus) { window.removeEventListener('nit-status', _onStatus); _onStatus = null; }
}
