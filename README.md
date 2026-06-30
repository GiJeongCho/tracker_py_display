# streamlit_jo — NIT 실시간 처리 뷰어 · 파라미터 튜닝 UI

`jo` FastAPI 백엔드(기본 `:8886`)에 영상을 주고, **처리 전/후 영상을 라이브로 보면서**
탐지·트래킹·안개 제거 파라미터를 **실시간으로 조정**하는 Streamlit UI.
**포트 8887** 에서 열린다(외부 접근 허용 설정 포함).

## 구성
```
[브라우저] ⇄ [Streamlit :8887] ⇄ [FastAPI 백엔드 :8886]
   └ 라이브 영상: 브라우저가 백엔드 /video_feed/{feed} (MJPEG) 에 직접 연결
```
- **영상 입력**: 파일 업로드(`POST /api/upload`, 백그라운드 스레드) 또는
  서버 파일경로/RTSP/HTTP/카메라 지정(`POST /api/source`, 복사 없이 즉시 시작)
- **라이브 표시**: 처리 전(original) / 처리 후(tracked 등) 영상을 좌우로 동시 표시
  (클릭하면 확대). 소스 변경/업로드 시 자동 재연결(`stream_nonce` 캐시버스팅).
- **실시간 파라미터 조정**(영상 아래 패널, 적용 시 재시작 없이 즉시 반영):
  - 탐지(YOLO): `conf`/`iou`/`max_det` → `POST /api/detector/config`
  - 트래킹: `max_age`/`base_gate`/`vel_damping`/`max_speed`/`iou_merge_gate`/라벨 고정 등
    → `POST /api/tracker/config`
  - 전처리 안개 제거(Stage1): `mode`/`foggy_th`(하한)/`foggy_th_high`(상한)
    → `POST /api/preprocess/stage1` (최근 프레임 밝기·선택 표시)
- **처리 중지 / 초기화**: `POST /api/reset` → 소스 해제(idle). 파일은 끝나면 자동
  반복되므로 멈추려면 이 버튼을 누른다. "소스 적용" 도 reset 후 적용해 **항상 새로 파싱**.
- 상태 폴링(`GET /api/status`): 처리 FPS, 처리 프레임 수, 소스 연결 상태 등.

## 페이지 (멀티페이지)
- **app** (기본): 라이브 처리 뷰어 + 실시간 파라미터 조정
- **영상 처리결과** (`pages/1_영상_처리결과.py`): 영상 업로드 → **전체 배치 처리** →
  완료되면 **결과 영상 재생 + 다운로드**. 처리 파라미터(탐지/트래킹/안개)를 지정해
  그 값으로 결과 영상을 생성한다.
  - 백엔드 엔드포인트: `POST /api/process`(업로드, `config` JSON 으로 파라미터 전달) →
    `GET /api/process/{job_id}`(진행률) → `GET /api/output/{job_id}`(결과 mp4)

## 실행

### 1) 백엔드(jo) 먼저 실행
```bash
conda activate NIT
cd /home/pps-nipa/NIT/jo/src/v1
NIT_STREAM_SOURCE=0 uvicorn app:app --host 0.0.0.0 --port 8886
```

### 2) Streamlit 실행 (포트 8887)
```bash
cd /home/pps-nipa/NIT/streamlit_jo
./run.sh                                   # 기본 백엔드 http://localhost:8886, 업로드 5GB
# BACKEND_URL=http://192.168.0.10:8886 ./run.sh   # 원격 백엔드
# MAX_UPLOAD_MB=10240 ./run.sh                     # 업로드 제한 10GB로
```
> 업로드 제한 기본 5GB(`--server.maxUploadSize`). `MAX_UPLOAD_MB` 로 조정.
브라우저에서 `http://localhost:8887` (또는 `http://<서버IP>:8887`) 접속.

> `streamlit` 미설치면 `run.sh` 가 현재 파이썬 환경에 자동 설치한다.
> 직접 설치: `pip install -r requirements.txt`

## 주의
- 업로드/소스 변경/상태조회는 Streamlit 서버를 거쳐 백엔드로 간다 → `BACKEND_URL` 은
  **Streamlit 서버에서** 접근 가능하면 된다(localhost 가능).
- 한 번에 하나의 소스만 처리한다(백엔드 단일 스트림). 새 영상을 주면 이전 처리는 교체된다.
- 파일 소스는 끝까지 재생되면 자동으로 다시 열려(무한 반복) 계속 처리된다 →
  멈추려면 사이드바 **"⏹️ 처리 중지 / 초기화"**(또는 `POST /api/reset`).
- 도메인/리버스 프록시로 접속 시 `Failed to fetch dynamically imported module ... index.*.js`
  에러가 보이면, 보통 **브라우저 캐시(이전 빌드)** 문제다 → **강력 새로고침(Ctrl+Shift+R)**.
  그래도면 프록시가 `/static` 와 websocket(`/_stcore/stream`)을 그대로 포워딩하는지 확인.
