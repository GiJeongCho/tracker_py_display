@echo off
:: ──────────────────────────────────────────────────────────────────────────────
:: NIT Streamlit 프론트엔드 실행 (포트 8887)
::
:: 사용:
::   run.bat
::   set BACKEND_URL=http://192.168.0.10:8886 && run.bat
::
:: streamlit 미설치 시 자동 설치 (현재 활성 파이썬 환경 기준).
:: ──────────────────────────────────────────────────────────────────────────────

if not defined BACKEND_URL set BACKEND_URL=http://localhost:8886
if not defined PORT set PORT=8887
if not defined MAX_UPLOAD_MB set MAX_UPLOAD_MB=5120

python -c "import streamlit" >nul 2>&1
if errorlevel 1 (
    echo [run] streamlit 미설치 → 설치합니다...
    python -m pip install -r "%~dp0requirements.txt"
)

echo [run] 백엔드: %BACKEND_URL%  ^|  Streamlit 포트: %PORT% (외부 접근 허용)

streamlit run "%~dp0app.py" ^
  --server.port %PORT% ^
  --server.address 0.0.0.0 ^
  --server.headless true ^
  --server.runOnSave true ^
  --server.maxUploadSize %MAX_UPLOAD_MB% ^
  --server.enableCORS false ^
  --server.enableXsrfProtection false ^
  --browser.gatherUsageStats false
