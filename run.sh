#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# NIT Streamlit 프론트엔드 실행 (포트 8887)
#
# 사용:
#   ./run.sh
#   BACKEND_URL=http://192.168.0.10:8886 ./run.sh
#
# streamlit 미설치 시 자동 설치 (현재 활성 파이썬 환경 기준).
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BACKEND_URL="${BACKEND_URL:-http://localhost:8886}"
PORT="${PORT:-8887}"
# 업로드 용량 제한(MB). 기본 5GB. 환경변수 MAX_UPLOAD_MB 로 조정.
MAX_UPLOAD_MB="${MAX_UPLOAD_MB:-5120}"

if ! python -c "import streamlit" >/dev/null 2>&1; then
  echo "[run] streamlit 미설치 → 설치합니다..."
  python -m pip install -r "$SCRIPT_DIR/requirements.txt"
fi

echo "[run] 백엔드: $BACKEND_URL  |  Streamlit 포트: $PORT (외부 접근 허용)"
# 외부/원격 접근 허용: 모든 인터페이스 바인딩 + CORS/XSRF 보호 해제
exec streamlit run "$SCRIPT_DIR/app.py" \
  --server.port "$PORT" \
  --server.address 0.0.0.0 \
  --server.headless true \
  --server.runOnSave true \
  --server.maxUploadSize "$MAX_UPLOAD_MB" \
  --server.enableCORS false \
  --server.enableXsrfProtection false \
  --browser.gatherUsageStats false
