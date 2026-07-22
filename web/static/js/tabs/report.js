// 보고서 탭: 세션 기록(시작/중지) + 실시간 현황(한글) + 집계 리포트 + CSV/JSON 다운로드.
// 실시간 현황은 status-store 의 'nit-status'(= /api/status + /api/detections) 구독.
// 집계는 백엔드 세션 레코더(/api/report)에서 가져온다.
import { api } from '../common/api.js';

const $ = (id) => document.getElementById(id);
let _onStatus = null;
let _statusTimer = null;
let _recording = false;
let _lastReport = null;

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m > 0 ? `${m}분 ${s}초` : `${s}초`;
}

// ── 실시간 현황(한글) ────────────────────────────────────────────
function updateLive(detail) {
  const online = detail && detail.online;
  const status = (detail && detail.status) || {};
  const tracks = (detail && detail.det && detail.det.tracks) || [];
  if (!online) {
    $('rep-live').textContent = '백엔드 연결 대기 중 — 소스가 연결되면 현재 상황이 표시됩니다.';
    return;
  }
  const fps = Number(status.fps) || 0;
  const procFps = Number(status.proc_fps) || 0;
  const lat = (status.timings_ms && Number(status.timings_ms.total)) || 0;
  const connected = status.source_opened;
  const scale = fps > 0 ? fps : 1.0;

  const groups = new Map();
  let moving = 0, spdSum = 0;
  tracks.forEach((tk) => {
    const label = tk.label ?? '?';
    const spdPf = Math.hypot(Number(tk.vx) || 0, Number(tk.vy) || 0);
    if (!tk.is_predicted && spdPf >= 0.3) moving += 1;
    spdSum += spdPf * scale;
    groups.set(label, (groups.get(label) || 0) + 1);
  });
  const n = tracks.length;
  const avgSpd = n ? (spdSum / n) : 0;

  $('rep-live-tracks').textContent = String(n);
  $('rep-live-moving').textContent = String(moving);
  $('rep-live-fps').textContent = procFps.toFixed(1);
  $('rep-live-lat').textContent = lat.toFixed(0);

  let sentence;
  if (!connected) {
    sentence = `소스 연결이 끊겼습니다. 처리 ${procFps.toFixed(1)} FPS 대기 중입니다.`;
  } else if (n === 0) {
    sentence = `현재 탐지된 객체가 없습니다. 처리 ${procFps.toFixed(1)} FPS · 지연 ${lat.toFixed(0)} ms 로 감시 중입니다.`;
  } else {
    const breakdown = [...groups.entries()].sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}대`).join(', ');
    sentence = `현재 ${n}개 객체를 추적 중입니다 (${breakdown}). `
      + `이동 중 ${moving}대, 평균 속력 ${avgSpd.toFixed(1)} px/s. `
      + `처리 ${procFps.toFixed(1)} FPS · 지연 ${lat.toFixed(0)} ms · 소스 연결됨.`;
  }
  if (_recording) sentence = '● 기록 중 — ' + sentence;
  $('rep-live').textContent = sentence;
}

// ── 기록 상태 표시등 ──────────────────────────────────────────────
async function pollRecStatus() {
  try {
    const s = await api.get('/api/report/status');
    setRecordingUI(Boolean(s.recording));
    if (s.recording) {
      $('rep-recinfo').textContent =
        `● 기록 중 · 경과 ${fmtDuration(s.elapsed_sec)} · 프레임 ${s.frames} · 고유 트랙 ${s.unique_tracks} · 최대 동시 ${s.concurrent_max}`;
    } else if (s.frames > 0) {
      $('rep-recinfo').textContent =
        `정지 · 마지막 세션 프레임 ${s.frames} · 고유 트랙 ${s.unique_tracks} — "새로고침"으로 보고서를 확인하세요.`;
    }
  } catch (e) { /* idle */ }
}

function setRecordingUI(on) {
  _recording = on;
  const dot = $('rep-dot'), state = $('rep-state');
  if (dot) dot.className = 'w-2.5 h-2.5 rounded-full ' + (on ? 'bg-red-500 animate-pulse' : 'bg-gray-400');
  if (state) state.textContent = on ? '기록 중' : '정지';
  if ($('rep-start')) $('rep-start').disabled = on;
  if ($('rep-stop')) $('rep-stop').disabled = !on;
}

async function startRec() {
  const r = await api.post('/api/report/start', {});
  if (r && r.ok) {
    setRecordingUI(true);
    $('rep-recinfo').textContent = '● 기록을 시작했습니다.';
  } else {
    $('rep-recinfo').textContent = '기록 시작 실패 — 백엔드 연결을 확인하세요.';
  }
}

async function stopRec() {
  const r = await api.post('/api/report/stop', {});
  setRecordingUI(false);
  const report = r && r.ok && r.data ? r.data.report : null;
  if (report) { _lastReport = report; renderReport(report); }
  $('rep-recinfo').textContent = r && r.ok
    ? '기록을 중지했습니다. 아래에 세션 보고서를 표시합니다.'
    : '기록 중지 응답 오류 — 백엔드 연결을 확인하세요.';
}

async function refreshReport() {
  try {
    const rep = await api.get('/api/report');
    _lastReport = rep;
    renderReport(rep);
  } catch (e) { /* idle */ }
}

// ── 렌더링 ────────────────────────────────────────────────────────
function card(title, value) {
  return `<div class="rounded-lg border border-border-light dark:border-border-dark p-2">
    <div class="text-xs text-text-light-secondary dark:text-dark-secondary">${title}</div>
    <div class="text-lg font-bold">${value}</div></div>`;
}

function renderReport(rep) {
  if (!rep) return;
  const ov = $('rep-overview');
  if (ov) {
    ov.innerHTML = [
      card('기록 시간', fmtDuration(rep.elapsed_sec)),
      card('처리 프레임', rep.frames),
      card('고유 트랙', rep.unique_tracks),
      card('최대 동시 추적', rep.concurrent_max),
      card('평균 FPS', rep.fps_avg),
      card('최저 FPS', rep.fps_min),
      card('평균 지연', rep.latency_avg_ms + ' ms'),
      card('드롭 프레임', rep.dropped_frames),
    ].join('');
  }

  const ctb = $('rep-class-tbody');
  if (ctb) {
    const cs = rep.classes || [];
    ctb.innerHTML = cs.length ? cs.map((c) =>
      `<tr><td class="px-2 py-1.5 font-bold">${c.label}</td><td class="px-2 py-1.5 font-mono">${c.count}</td>
       <td class="px-2 py-1.5 font-mono">${c.avg_speed}</td><td class="px-2 py-1.5 font-mono">${c.max_speed}</td>
       <td class="px-2 py-1.5 font-mono text-xs">${c.avg_w}×${c.avg_h}</td></tr>`).join('')
      : '<tr><td colspan="5" class="py-6 text-text-light-secondary dark:text-dark-secondary">데이터 없음</td></tr>';
  }

  const ttb = $('rep-track-tbody');
  if (ttb) {
    const ts = rep.tracks || [];
    ttb.innerHTML = ts.length ? ts.map((t) => {
      const fp = t.first_pos || [0, 0], lp = t.last_pos || [0, 0];
      return `<tr><td class="px-2 py-1.5 font-mono font-bold">#${t.track_id}</td><td class="px-2 py-1.5 font-bold">${t.label}</td>
        <td class="px-2 py-1.5 font-mono">${t.frames}</td><td class="px-2 py-1.5 font-mono">${t.avg_speed}</td>
        <td class="px-2 py-1.5 font-mono">${t.max_speed}</td><td class="px-2 py-1.5 font-mono">${t.distance}</td>
        <td class="px-2 py-1.5 font-mono text-xs">(${fp[0]},${fp[1]})→(${lp[0]},${lp[1]})</td></tr>`;
    }).join('')
      : '<tr><td colspan="7" class="py-8 text-text-light-secondary dark:text-dark-secondary">데이터 없음</td></tr>';
  }
}

// ── 다운로드 ──────────────────────────────────────────────────────
function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function downloadCSV() {
  if (!_lastReport) { refreshReport().then(() => _lastReport && buildCSV()); return; }
  buildCSV();
}
function buildCSV() {
  const rep = _lastReport;
  const lines = [];
  lines.push('# 세션 개요');
  lines.push(['기록시간(초)', '처리프레임', '고유트랙', '최대동시', '평균FPS', '최저FPS', '평균지연ms', '드롭'].join(','));
  lines.push([rep.elapsed_sec, rep.frames, rep.unique_tracks, rep.concurrent_max, rep.fps_avg, rep.fps_min, rep.latency_avg_ms, rep.dropped_frames].join(','));
  lines.push('');
  lines.push('# 클래스별 통계 (속력 px/s)');
  lines.push(['종류', '등장수', '평균속력', '최대속력', '평균폭', '평균높이'].join(','));
  (rep.classes || []).forEach((c) => lines.push([c.label, c.count, c.avg_speed, c.max_speed, c.avg_w, c.avg_h].map(csvEscape).join(',')));
  lines.push('');
  lines.push('# 트랙별 상세 (속력 px/s)');
  lines.push(['ID', '종류', '최초프레임', '최종프레임', '지속프레임', '평균속력', '최대속력', '이동거리', '평균폭', '평균높이', '시작x', '시작y', '끝x', '끝y'].join(','));
  (rep.tracks || []).forEach((t) => {
    const fp = t.first_pos || [0, 0], lp = t.last_pos || [0, 0];
    lines.push([t.track_id, t.label, t.first_frame, t.last_frame, t.frames, t.avg_speed, t.max_speed, t.distance, t.avg_w, t.avg_h, fp[0], fp[1], lp[0], lp[1]].map(csvEscape).join(','));
  });
  download(`tracking_report_${stamp()}.csv`, '\uFEFF' + lines.join('\n'), 'text/csv;charset=utf-8');
}

function downloadJSON() {
  if (!_lastReport) { refreshReport().then(() => _lastReport && download(`tracking_report_${stamp()}.json`, JSON.stringify(_lastReport, null, 2), 'application/json')); return; }
  download(`tracking_report_${stamp()}.json`, JSON.stringify(_lastReport, null, 2), 'application/json');
}

// ── 라이프사이클 ──────────────────────────────────────────────────
export function init() {
  $('rep-start').addEventListener('click', startRec);
  $('rep-stop').addEventListener('click', stopRec);
  $('rep-refresh').addEventListener('click', refreshReport);
  $('rep-csv').addEventListener('click', downloadCSV);
  $('rep-json').addEventListener('click', downloadJSON);

  _onStatus = (e) => updateLive(e.detail);
  window.addEventListener('nit-status', _onStatus);

  pollRecStatus();
  _statusTimer = setInterval(pollRecStatus, 1500);
  refreshReport();
}

export function destroy() {
  if (_onStatus) { window.removeEventListener('nit-status', _onStatus); _onStatus = null; }
  if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; }
}
