# tracker_py_display 프런트 (JS+HTML)

`src/v1` FastAPI 백엔드(기본 `:8886`)를 호출하는 순수 JS+HTML 대시보드입니다.
Streamlit(`tracker_py_display/app.py`)이 하던 기능을 **동일한 API 호출**로 그대로 구현했습니다.
(Streamlit 은 참고용으로 남겨둠 — 더 이상 업데이트하지 않음)

## 실행

```bash
# 1) 백엔드 (별도 프로세스, Python)  — src/v1
cd src/v1 && python main.py                 # http://localhost:8886  (API + MJPEG)

# 2) 프런트 (별도 프로세스, Node.js)  — 이 폴더
cd tracker_py_display/web && node server.js     # http://localhost:8887
```
> 프런트 서버는 Node 내장 모듈만 사용(설치 불필요). 포트 변경: `FRONT_PORT=9000 node server.js`

브라우저에서 **http://localhost:8887** 접속. 프런트↔백엔드는 **완전히 분리**된 두 서버입니다.
백엔드 주소는 `static/config.js`(`window.NIT_BACKEND`) 또는 화면 사이드바 **백엔드 설정**에서 바꿉니다.

## 구조 (nit_v25 스타일 SPA)

```
web/
  server.js                  전용 프런트 서버(Node.js, :8887, 의존성 없음)
  index.html                 SPA 셸(사이드바 + #main-content)
  static/
    config.js                window.NIT_BACKEND (백엔드 주소)
    css/styles.css
    js/
      app.js                 진입점: 공통 초기화 → tab-loader → 탭 모듈 동적 import
      utils/tab-loader.js    /static/tabs/{tab}.html 을 fetch 해 주입
      common/
        api.js               ★ 백엔드 통신 단일 창구(get/post/upload/mjpeg)
        status-store.js      단일 폴러(/api/status + /api/detections) → 'nit-status' 이벤트
        theme.js, sidebar.js, sliders.js
      tabs/
        dashboard.js         라이브 + 입력/모델 + 전처리 + 탐지·추적 표
        control.js           성능·지연 + 물체·속도벡터 + 파라미터 조정
        analytics.js         분석·시각화(Chart.js): 성능 추이/종류·속력·위치 분포 + 종류별 통계
    tabs/
      dashboard.html, control.html, analytics.html
```

> 분석·시각화 탭은 `index.html` 의 Chart.js CDN(`chart.umd.min.js`)을 사용한다.

## API 사용법 (다른 프런트에서도 이대로 쓰면 됩니다)

모든 호출은 `static/js/common/api.js` 한 곳을 거칩니다. 백엔드 주소만 바꾸면 재사용 가능합니다.

```js
import { api } from './common/api.js';
// api.base()  → 'http://<host>:8886'
// api.get(path) / api.post(path, body) / api.upload(path, file) / api.mjpeg(feed)
```

### 1) 헬스체크 · 상태
| 목적 | 메서드 · 경로 | 예시 |
|---|---|---|
| 백엔드 생존 | `GET /healthz` | `await api.get('/healthz')` → `{status:"ok"}` |
| 처리 상태 | `GET /api/status` | 아래 참고 |
| 최신 탐지/트랙 | `GET /api/detections` | `{frame_idx, detections:[], tracks:[]}` |

`GET /api/status` 응답 예:
```json
{ "frame_idx": 123, "fps": 30.0, "proc_fps": 28.4, "dropped_frames": 5,
  "source_opened": true, "last_error": null, "n_detections": 4, "n_tracks": 4,
  "timings_ms": { "stage1": 8.1, "stage2": 2.3, "stage3": 0.0,
                  "det": 3.2, "track": 0.4, "enc": 1.5, "total": 15.5 },
  "available_feeds": ["original","detect","tracked"] }
```
`tracks[]` 항목: `{track_id, label, score, bbox:[x1,y1,x2,y2], vx, vy, is_predicted, age, hit_streak, ...}`

### 2) 실시간 영상 (MJPEG)
`<img>` 로 바로 표시. feed: `original|stage1|stage2|stage3|detect|tracked`
```js
document.getElementById('img').src = api.mjpeg('tracked');
// = http://<host>:8886/video_feed/tracked?t=<bust>
```

### 3) 입력 소스 / 업로드 / 초기화
| 목적 | 메서드 · 경로 | body |
|---|---|---|
| 파일 업로드→처리 | `POST /api/upload` (multipart) | `file` |
| 소스 교체 | `POST /api/source` | `{ "source": "rtsp://…" \| "0" \| "경로" }` |
| 처리 중지/해제 | `POST /api/reset` | `{}` |
```js
await api.post('/api/reset');
await api.post('/api/source', { source: 'rtsp://...' });
await api.upload('/api/upload', fileObject);
```

### 4) 탐지(YOLO) 파라미터
| 목적 | 메서드 · 경로 | body |
|---|---|---|
| 조회 | `GET /api/detector/config` | — (`{conf,iou,max_det,imgsz,...}`) |
| 조정 | `POST /api/detector/config` | `{ "conf":0.25, "iou":0.7, "max_det":300 }` |

### 5) 트래커 파라미터
| 목적 | 메서드 · 경로 | body(보낸 필드만 반영) |
|---|---|---|
| 조회 | `GET /api/tracker/config` | — |
| 조정 | `POST /api/tracker/config` | `{ max_age, vel_damping, vel_alpha, arrow_scale, base_gate, min_hits, max_speed, iou_merge_gate, label_lock, label_lock_min_count }` |

### 6) 전처리 Stage1 (안개/저조도) · 단계 on/off
| 목적 | 메서드 · 경로 | body |
|---|---|---|
| 조회 | `GET /api/preprocess/stage1` | — |
| 조정 | `POST /api/preprocess/stage1` | `{ mode:"auto\|fog\|dark\|none", fog_enabled, dark_enabled, dark_gain, stage2_enabled, stage3_enabled }` (안개 판정은 대비/채도/선명도 기반 auto — 밝기 구간 `foggy_th` 는 미사용) |

### 7) 전처리 알고리즘 선택 (안개 2 / 화질향상 2 / 표적강조 3)
| 목적 | 메서드 · 경로 | body |
|---|---|---|
| 조회 | `GET /api/preprocess/algorithms` | — (`{fog:{options,current}, quality:{...}, emphasis:{...}}`) |
| 선택 | `POST /api/preprocess/algorithms` | `{ fog_id:"dcp_dehaze\|aod_net", quality_id:"clahe_lab\|ssr", emphasis_id:"wavelet_gpu\|dog_gpu\|unsharp_mask" }` |

### 8) 탐지 모델 교체
| 목적 | 메서드 · 경로 | body |
|---|---|---|
| 목록 | `GET /api/detector/models` | — (`{current, task, models:[{name,path,task,size_mb,current}]}`) |
| 교체 | `POST /api/detector/model` | `{ "path": "models/…/best.pt" }` |

### 9) 추적 세션 보고서 (보고서 탭)
백엔드가 기록 중 매 프레임 트랙별 생애주기·속력·이동거리와 성능을 누적한다.
| 목적 | 메서드 · 경로 | 반환 |
|---|---|---|
| 시작 | `POST /api/report/start` | `{ ok, recording:true }` (기존 세션 초기화) |
| 중지 | `POST /api/report/stop` | `{ ok, recording:false, report:{…} }` |
| 조회 | `GET /api/report` | `{ 세션개요, classes:[…], tracks:[…] }` (px/s) |
| 상태 | `GET /api/report/status` | `{ recording, frames, elapsed_sec, unique_tracks, concurrent_max }` |

- 프런트(`tabs/report.js`): 기록 시작/중지 · 실시간 현황(한글, `nit-status` 구독) · 세션 요약 표 · CSV/JSON 다운로드(클라이언트 생성).

## Streamlit ↔ 새 프런트 매핑
| Streamlit(app.py) | 새 프런트 |
|---|---|
| `_get_status` / `_render` timing | `common/status-store.js` + `tabs/control.js` `renderPerf` |
| `_render_objects` (fps→px/s 환산) | `tabs/control.js` `renderObjects` (동일 로직) |
| `_controls_panel` (detector/tracker) | `tabs/control.js` `loadConfig`/`applyConfig` |
| 전처리 체크/알고리즘/mode/밴드 | `tabs/dashboard.js` `loadPreprocess`/`applyPreprocess` |
| 사이드바 모델 교체 | `tabs/dashboard.js` `loadModels`/`switchModel` |
| 업로드/소스/리셋 | `tabs/dashboard.js` `uploadFile`/`applySource`/`resetStream` |
| MJPEG 비교(원본/피드) | `tabs/dashboard.js` `reloadFeeds` + 비교 토글 |
