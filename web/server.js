/*
 * tracker_py_display 프런트 정적 서버 (Node.js, 의존성 없음)
 * =========================================================
 * JS+HTML 대시보드(tracker_py_display/web)를 서빙하는 전용 프런트 서버.
 * 백엔드(src/v1 FastAPI, :8886)와는 완전히 별개 프로세스로 동작한다.
 *
 *   - `/`         → index.html (SPA 셸)
 *   - `/static/*` → 정적 자산(css/js/tabs)  ← index.html 이 절대경로 `/static/...` 로 참조
 *
 * 프런트는 브라우저에서 window.NIT_BACKEND(static/config.js, 기본 접속호스트:8886)로
 * 백엔드 API/MJPEG 를 호출한다(교차 출처 → 백엔드 CORS 필요, src/v1/app.py 에서 허용).
 *
 * 실행:
 *   cd tracker_py_display/web
 *   node server.js                 // → http://localhost:8887
 *   // 포트 변경: FRONT_PORT=9000 node server.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = parseInt(process.env.FRONT_PORT || '8887', 10);
const HOST = process.env.FRONT_HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',   // ESM 모듈은 올바른 MIME 이 필수
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const filePath = path.join(ROOT, urlPath);
  // 경로 탈출(../) 차단: ROOT 밖 파일 접근 금지
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found: ' + urlPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[front] 대시보드 서빙: http://localhost:${PORT}  (백엔드는 static/config.js 의 NIT_BACKEND)`);
});
