// 단일 폴러: /api/status + /api/detections 를 주기적으로 읽어
// (1) 사이드바 연결 배지 갱신 (2) 'nit-status' 이벤트로 각 탭에 브로드캐스트.
import { api } from './api.js';

class StatusStore {
  constructor() {
    this.timer = null;
    this.intervalMs = 800;
    this.last = { online: false, status: null, det: null };
  }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  async poll() {
    let online = false, status = null, det = null;
    try { status = await api.get('/api/status'); online = true; } catch (e) { online = false; }
    if (online) { try { det = await api.get('/api/detections'); } catch (e) { /* idle */ } }
    this.last = { online, status, det };
    this._updateBadge(online, status);
    window.dispatchEvent(new CustomEvent('nit-status', { detail: this.last }));
  }

  _updateBadge(online, status) {
    const dot = document.getElementById('conn-dot');
    const txt = document.getElementById('conn-text');
    if (!dot || !txt) return;
    if (!online) { dot.className = 'w-2.5 h-2.5 rounded-full bg-red-500 flex-shrink-0'; txt.textContent = '백엔드 연결 안됨'; return; }
    const opened = status && status.source_opened;
    dot.className = 'w-2.5 h-2.5 rounded-full flex-shrink-0 ' + (opened ? 'bg-green-500' : 'bg-yellow-500');
    txt.textContent = opened ? '연결됨 · 처리 중' : '연결됨 · 소스 대기';
    // 배지는 사이드바 접힘 시 텍스트가 숨겨지므로 sidebar-text 클래스 유지
    txt.classList.add('sidebar-text');
  }
}

export const statusStore = new StatusStore();
