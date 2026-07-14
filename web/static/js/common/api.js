// 백엔드(src/v1 FastAPI, 기본 :8886) 통신 헬퍼.
// 우선순위: localStorage('nit_backend') > window.NIT_BACKEND(config.js) > 같은 오리진
function base() {
  const saved = localStorage.getItem('nit_backend');
  const def = (typeof window !== 'undefined' && window.NIT_BACKEND) || '';
  return ((saved && saved.trim()) ? saved.trim() : def).replace(/\/$/, '');
}

export const api = {
  base,
  url: (p) => base() + p,
  mjpeg: (feed) => base() + '/video_feed/' + feed + '?t=' + Date.now(),

  async get(p) {
    const r = await fetch(base() + p, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  },
  async post(p, body) {
    try {
      const r = await fetch(base() + p, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      return { ok: r.ok, data: await r.json().catch(() => ({})) };
    } catch (e) { return { ok: false, data: { error: String(e) } }; }
  },
  async upload(p, file) {
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await fetch(base() + p, { method: 'POST', body: fd });
      return { ok: r.ok, data: await r.json().catch(() => ({})) };
    } catch (e) { return { ok: false, data: { error: String(e) } }; }
  },
};
