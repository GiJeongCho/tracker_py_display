"""
streamlit_jo / app.py
=====================

NIT 추론 백엔드(FastAPI, 기본 :8886) **처리 성능 / 지연 분석** 대시보드.

목적
----
- 영상을 업로드(또는 경로/RTSP 지정)하면 백엔드가 실시간 처리한다.
- **처리 전(원본) / 처리 후(트래킹) 화면을 나란히 실시간 표시**하고,
  **처리 속도(FPS·프레임당 처리시간)** 와 **단계별 처리시간(병목)** 을 함께 보여준다.
- 영상은 백엔드의 MJPEG(`/video_feed/{feed}`)를 브라우저 <img> 로 직접 받는다.

지연 분석
--------
백엔드는 프레임마다 단계별 소요시간(ms)을 보고한다:
  stage1(저조도/안개 보정) · stage2(CLAHE) · stage3(웨이블릿,GPU)
  · det(YOLO) · track(트래킹) · enc(JPEG 인코딩) · total
이 값들의 평균과 비율을 보여줘 병목 단계를 한눈에 파악한다.

실행: streamlit run app.py --server.port 8887 --server.address 0.0.0.0
백엔드 주소: 환경변수 BACKEND_URL (기본 http://localhost:8886)
"""

from __future__ import annotations

import math
import os
import threading
import time

import requests
import streamlit as st
import streamlit.components.v1 as components

DEFAULT_BACKEND = os.getenv("BACKEND_URL", "http://localhost:8886")
# 영상(<img> MJPEG)은 사용자의 "브라우저"가 직접 받는다. 브라우저가 접속한 호스트를
# 자동 감지해 :STREAM_PORT 로 영상을 받으므로 보통 별도 설정이 필요 없다.
DEFAULT_STREAM_PORT = int(os.getenv("STREAM_PORT", "8886"))
DEFAULT_STREAM_HOST = os.getenv("STREAM_HOST", "")  # 비우면 자동 감지

# 처리 후(after) 비교에 쓸 수 있는 피드 종류
STREAM_FEEDS = {
    "tracked": "트래킹 결과",
    "detect": "탐지(박스)",
    "stage3": "전처리 Stage3",
    "stage2": "전처리 Stage2",
    "stage1": "전처리 Stage1",
}

# 파이프라인 단계 (표시 순서) 및 한글 라벨
STAGES = ["stage1", "stage2", "stage3", "det", "track", "enc"]
STAGE_LABELS = {
    "stage1": "Stage1 전처리 (저조도/안개 보정)",
    "stage2": "Stage2 전처리 (CLAHE)",
    "stage3": "Stage3 전처리 (웨이블릿, GPU)",
    "det": "YOLO 탐지",
    "track": "트래킹",
    "enc": "JPEG 인코딩",
}

st.set_page_config(page_title="NIT 처리 성능 분석", page_icon="📊", layout="wide")

# 업로드 작업 상태(백그라운드 스레드와 공유하는 단순 dict)
if "upload_job" not in st.session_state:
    st.session_state.upload_job = None

# 소스/업로드가 바뀔 때마다 +1 → 라이브 <img> 를 새 연결로 강제 재로딩한다.
# (MJPEG <img> 는 한 번 연결되면 끊지 않으면 이전 소스 화면을 계속 들고 있을 수 있다)
if "stream_nonce" not in st.session_state:
    st.session_state.stream_nonce = 0


def _upload_in_background(backend: str, name: str, data: bytes, ctype: str, holder: dict) -> None:
    """별도 스레드에서 파일을 백엔드로 업로드(측정 폴링을 막지 않도록)."""
    t0 = time.time()
    try:
        files = {"file": (name, data, ctype or "video/mp4")}
        r = requests.post(f"{backend}/api/upload", files=files, timeout=3600)
        elapsed = time.time() - t0
        if r.ok:
            holder["status"] = "done"
            holder["elapsed"] = elapsed
            holder["msg"] = f"업로드 완료: {r.json().get('filename')} ({elapsed:.1f}s)"
        else:
            holder["status"] = "error"
            holder["msg"] = f"업로드 실패: {r.status_code} {r.text[:200]}"
    except Exception as e:  # noqa: BLE001
        holder["status"] = "error"
        holder["msg"] = f"업로드 요청 실패: {e}"


def _get_status(backend: str, timeout: float = 3.0) -> dict | None:
    try:
        return requests.get(f"{backend}/api/status", timeout=timeout).json()
    except Exception:
        return None


def _get_json(backend: str, path: str, timeout: float = 3.0) -> dict | None:
    try:
        r = requests.get(f"{backend}{path}", timeout=timeout)
        if r.ok:
            return r.json()
    except Exception:
        return None
    return None


def _post_json(backend: str, path: str, payload: dict, timeout: float = 5.0):
    try:
        r = requests.post(f"{backend}{path}", json=payload, timeout=timeout)
        body = r.json() if "application/json" in r.headers.get("content-type", "") else r.text
        return r.ok, body
    except Exception as e:  # noqa: BLE001
        return False, str(e)


# 슬라이더 위젯 키(현재값 다시 불러오기 시 초기화 대상)
_CTL_KEYS = [
    "ctl_conf", "ctl_iou", "ctl_maxdet",
    "ctl_maxage", "ctl_damp", "ctl_alpha", "ctl_arrow", "ctl_gate", "ctl_hits", "ctl_vmax",
    "ctl_ioumerge", "ctl_lbllock", "ctl_lblcnt",
    "ctl_fogmode", "ctl_fogband",
    "ctl_darkon", "ctl_darkgain",
]


def _controls_panel(backend: str) -> None:
    """영상 바로 아래 표시되는 실시간 파라미터 조정 패널."""
    # 최초 1회(또는 '다시 불러오기' 후) 백엔드 현재값을 받아 슬라이더 기본값으로 사용.
    if "init_tcfg" not in st.session_state:
        st.session_state.init_tcfg = _get_json(backend, "/api/tracker/config") or {}
    if "init_dcfg" not in st.session_state:
        st.session_state.init_dcfg = _get_json(backend, "/api/detector/config") or {}
    if "init_fcfg" not in st.session_state:
        st.session_state.init_fcfg = _get_json(backend, "/api/preprocess/stage1") or {}
    t = st.session_state.init_tcfg
    d = st.session_state.init_dcfg
    f = st.session_state.init_fcfg

    with st.expander("🎛️ 실시간 파라미터 조정 (적용 시 재시작 없이 즉시 반영)", expanded=True):
        st.caption(
            "각 항목의 ⓘ(물음표) 아이콘에 마우스를 올리면 자세한 설명이 나옵니다. "
            "값을 바꾸고 **적용**을 누르면 다음 프레임부터 결과에 반영됩니다."
        )
        cols = st.columns(2)
        with cols[0]:
            st.markdown("**탐지(YOLO) 민감도**")
            conf = st.slider(
                "conf — 탐지 신뢰도 임계", 0.05, 0.90,
                float(d.get("conf", 0.30)), 0.01, key="ctl_conf",
                help=(
                    "YOLO가 '객체'로 인정하는 최소 신뢰도(0~1).\n\n"
                    "• **낮추면** 약하고 흐릿한 표적도 잡음 → 탐지율↑, 그러나 오탐(false positive)도 늘어남.\n"
                    "• **높이면** 확실한 것만 잡음 → 오탐↓, 그러나 어두운/멀리 있는 표적을 놓칠 수 있음.\n\n"
                    "권장: 0.20~0.35. 표적이 자주 끊기면 먼저 이 값을 낮춰보세요."
                ),
            )
            iou = st.slider(
                "iou — NMS 중복 제거 임계", 0.10, 0.95,
                float(d.get("iou", 0.70)), 0.05, key="ctl_iou",
                help=(
                    "겹치는 박스를 하나로 합치는 기준(NMS, 0~1). "
                    "두 박스의 겹침(IoU)이 이 값 이상이면 같은 객체로 보고 하나만 남깁니다.\n\n"
                    "• **낮추면** 겹친 박스를 더 적극적으로 제거 → 가까이 붙은 표적이 하나로 합쳐질 수 있음.\n"
                    "• **높이면** 겹쳐도 따로 유지 → 밀집한 표적 분리에 유리하나 중복 박스가 늘 수 있음.\n\n"
                    "권장: 0.5~0.7."
                ),
            )
            max_det = st.slider(
                "max_det — 프레임당 최대 탐지 수", 10, 1000,
                int(d.get("max_det", 300)), 10, key="ctl_maxdet",
                help=(
                    "한 프레임에서 검출할 수 있는 객체 최대 개수.\n\n"
                    "표적 수가 많지 않으면 기본(300)으로 충분합니다. "
                    "아주 많은 객체(수백 개)를 동시에 다뤄야 할 때만 올리세요. "
                    "값이 크다고 정확도가 오르진 않습니다."
                ),
            )
        with cols[1]:
            st.markdown("**트래킹 (칼만 / 매칭 / 시각화)**")
            max_age = st.slider(
                "max_age — 고스트 유지 프레임", 1, 300,
                int(t.get("max_age", 100)), 1, key="ctl_maxage",
                help=(
                    "탐지가 끊겼을 때(가려짐 등) 칼만 '예측값'만으로 트랙을 유지하는 프레임 수.\n\n"
                    "• **늘리면** 오래 가려져도 같은 ID로 버팀 → 깜빡임/ID 끊김↓, "
                    "그러나 사라진 표적의 잔상(유령 박스)이 오래 남을 수 있음.\n"
                    "• **줄이면** 미탐지 시 빨리 트랙을 내림 → 잔상↓, 그러나 ID가 자주 새로 생김.\n\n"
                    "30fps 기준 90 ≈ 3초. 화면에 `[G]` 태그로 표시되는 게 고스트 트랙입니다."
                ),
            )
            vel_damping = st.slider(
                "vel_damping — 고스트 예측 속도(이동률)", 0.0, 1.0,
                float(t.get("vel_damping", 0.45)), 0.05, key="ctl_damp",
                help=(
                    "고스트(미탐지) 상태에서 예측 위치를 얼마나 '속도 방향'으로 밀지 결정.\n"
                    "예측 위치 = 마지막 위치 + (이 값) × 추정 속도.\n\n"
                    "• **1.0** = 등속 외삽: 가려지기 전 속도 그대로 계속 날아감"
                    "(표적이 방향을 바꾸면 옛 방향으로 튀어 ID가 끊기기 쉬움).\n"
                    "• **0.45**(기본) = 추정 속도의 45%만 반영, 마지막 위치 근처에 더 머묾.\n"
                    "• **0.0** = 고스트가 그 자리에 정지(가장 안전, 빠른 표적은 놓칠 수 있음).\n\n"
                    "방향 전환 시 ID가 바뀌면 이 값을 낮추세요."
                ),
            )
            vel_alpha = st.slider(
                "vel_alpha — 속도 추정 부드러움(EMA)", 0.01, 1.0,
                float(t.get("vel_alpha", 0.02)), 0.01, key="ctl_alpha",
                help=(
                    "속도 추정의 지수이동평균 계수(0~1). 속도 화살표의 떨림/반응성을 좌우.\n\n"
                    "• **낮추면**(예 0.05) 속도가 부드럽고 안정적 → 화살표가 천천히 변함, 방향 안정.\n"
                    "• **높이면**(예 0.5) 최근 움직임에 민감 → 화살표가 빠르게 반응하나 출렁임/노이즈↑.\n\n"
                    "화살표가 '미친 듯' 흔들리면 이 값을 낮추세요."
                ),
            )
            arrow_scale = st.slider(
                "arrow_scale — 속도 화살표 길이", 0.0, 1.0,
                float(t.get("arrow_scale", 0.20)), 0.05, key="ctl_arrow",
                help=(
                    "화면에 그리는 속도 화살표의 길이 배율. **표시 전용**이라 실제 트래킹/이동에는 영향 없음.\n\n"
                    "• 화살표가 너무 길면 줄이고(예 0.1~0.2), 거의 안 보이면 키우세요.\n"
                    "• 0 으로 두면 화살표를 사실상 안 그립니다."
                ),
            )
            base_gate = st.slider(
                "base_gate — 매칭 허용 범위(게이트)", 1.0, 80.0,
                float(t.get("base_gate", 24.0)), 1.0, key="ctl_gate",
                help=(
                    "예측 위치와 새 탐지를 같은 객체로 이을 때 허용하는 거리(마할라노비스 게이트).\n\n"
                    "• **키우면** 멀리 떨어진 탐지도 같은 트랙으로 연결 → 빠른/튀는 움직임에도 ID 유지↑, "
                    "그러나 다른 표적끼리 잘못 이어질(ID 스왑) 위험↑.\n"
                    "• **줄이면** 가까운 탐지만 연결 → 오매칭↓, 그러나 움직임이 크면 ID가 끊기기 쉬움.\n\n"
                    "권장: 12~20. 방향 전환·고속 표적에서 ID가 끊기면 키우세요."
                ),
            )
            iou_merge_gate = st.slider(
                "iou_merge_gate — 겹침 시 중복 병합", 0.0, 0.9,
                float(t.get("iou_merge_gate", 0.75)), 0.05, key="ctl_ioumerge",
                help=(
                    "고스트(예측) 트랙 위에 실제 YOLO 탐지가 겹칠 때, 박스 겹침(IoU)이 "
                    "이 값 이상이면 같은 객체로 보고 **그 탐지로 트랙을 갱신**합니다. "
                    "→ 중복 박스/ID/글자 겹침이 사라지고 기존 ID가 실제 탐지 위치로 되돌아갑니다.\n\n"
                    "• **낮추면** 조금만 겹쳐도 병합(중복 제거 강함, 다른 객체를 합칠 위험↑).\n"
                    "• **높이면** 많이 겹쳐야 병합(보수적).\n"
                    "• 0 = 비활성.\n\n"
                    "권장: 0.2~0.4."
                ),
            )
            max_speed = st.slider(
                "max_speed — 예측 속도 상한(px/프레임)", 0.0, 60.0,
                float(t.get("max_speed", 0.5)), 0.5, key="ctl_vmax",
                help=(
                    "트랙이 한 프레임에 이동했다고 인정하는 최대 속도. 예측(고스트)이 이 속도를 "
                    "넘지 못하도록 제한합니다.\n\n"
                    "• **줄이면** 한 번의 오탐으로 트랙이 '퓽' 멀리 날아가는 현상↓(안정적), "
                    "그러나 실제로 매우 빠른 표적은 따라가지 못할 수 있음.\n"
                    "• **키우면** 빠른 표적도 추종, 그러나 튀는 오탐에 끌려갈 위험↑.\n"
                    "• 0 = 제한 없음.\n\n"
                    "속도는 최근 몇 프레임 '평균 이동속도'로 스무딩되어 급가속이 억제됩니다."
                ),
            )
            min_hits = st.slider(
                "min_hits — 표시까지 연속 탐지 수", 1, 10,
                int(t.get("min_hits", 2)), 1, key="ctl_hits",
                help=(
                    "새 트랙을 화면에 표시하기 전에 필요한 연속 탐지 횟수.\n\n"
                    "• **키우면** 잠깐 나타난 노이즈성 박스를 무시 → 깜빡이는 오탐↓, "
                    "그러나 진짜 표적도 조금 늦게 나타남.\n"
                    "• **줄이면**(1) 한 번만 잡혀도 즉시 표시 → 반응 빠름, 그러나 오탐도 바로 보임.\n\n"
                    "권장: 2~3."
                ),
            )

        st.markdown("**전처리 — 안개 제거(Stage1)**")
        _last_br = f.get("last_brightness")
        _last_ch = f.get("last_choice")
        st.caption(
            "auto 모드는 프레임 **밝기**로 안개 제거 여부를 정합니다. "
            "밝기 < 하한 → 저조도 보정 / 하한 ≤ 밝기 < 상한 → **안개 제거** / "
            "밝기 ≥ 상한 → **안개 제거 생략**(너무 밝음/맑음). "
            f"최근 프레임: 밝기={_last_br if _last_br is not None else '—'}, "
            f"선택={_last_ch or '—'}"
        )
        st.caption(
            "⚠️ **안개를 끄려면** `mode=none`(전처리 전체 off) 또는 `mode=dark`(저조도만), "
            "혹은 auto 유지 시 **상한(foggy_th_high)=0**. "
            "주의: 하한(foggy_th)=0 은 끄는 게 아니라 **항상 안개 제거**가 됩니다."
        )
        fc0, fc1 = st.columns([1, 2])
        _modes = ["auto", "fog", "dark", "none"]
        _cur_mode = str(f.get("mode", "auto"))
        fog_mode = fc0.selectbox(
            "mode — 동작 모드", _modes,
            index=_modes.index(_cur_mode) if _cur_mode in _modes else 0,
            key="ctl_fogmode",
            help=(
                "• **auto**: 밝기 임계로 안개 제거/저조도/생략을 자동 선택.\n"
                "• **fog**: 항상 안개 제거.\n"
                "• **dark**: 항상 저조도 보정.\n"
                "• **none**: Stage1 전처리 끔(원본 그대로)."
            ),
        )
        # 하한(foggy_th)·상한(foggy_th_high)을 한 슬라이더의 양끝 두 점으로 조정.
        _band_lo = float(f.get("foggy_th", 90.0))
        _band_hi = float(f.get("foggy_th_high", 255.0))
        if _band_hi < _band_lo:
            _band_hi = _band_lo
        fog_th, fog_th_high = fc1.slider(
            "안개 제거 밝기 구간 [하한 · 상한]", 0.0, 255.0,
            (_band_lo, _band_hi), 1.0, key="ctl_fogband",
            help=(
                "auto 모드에서 **하한 ≤ 밝기 < 상한** 구간만 안개 제거를 적용합니다.\n\n"
                "• 밝기 < **하한** → 저조도(dark) 보정\n"
                "• **하한 ≤ 밝기 < 상한** → 안개 제거(fog)\n"
                "• 밝기 ≥ **상한** → 생략(너무 밝음/맑음)\n\n"
                "⚠️ 두 점을 **붙이면**(하한=상한) 안개 제거 구간이 사라져 사실상 off 입니다. "
                "안개를 완전히 끄려면 mode=none/dark 를 쓰세요."
            ),
        )

        st.markdown("**전처리 — 암흑/저조도 보정(Stage1 dark)**")
        dc1, dc2 = st.columns([1, 2])
        dark_enabled = dc1.checkbox(
            "암흑 보정 사용", value=bool(f.get("dark_enabled", True)), key="ctl_darkon",
            help=(
                "어두운 장면(auto: 밝기 < 하한, 또는 mode=dark)에 적용되는 저조도 보정(Zero-DCE++).\n\n"
                "• **끄면** 어두운 장면도 **원본 그대로** 둡니다(밝아지지 않음).\n"
                "• 영상이 인위적으로 밝아져 보이면 이걸 꺼서 확인하세요."
            ),
        )
        dark_gain = dc2.slider(
            "dark_gain — 저조도 밝기 게인", 0.1, 3.0,
            float(f.get("dark_gain", 1.0)), 0.05, key="ctl_darkgain",
            help=(
                "저조도 보정 결과의 밝기 배율(brightness_gain). 1.0=모델 기본.\n\n"
                "• **낮추면**(<1.0) 덜 밝게(과보정/노이즈 억제), **높이면**(>1.0) 더 밝게.\n"
                "• '암흑 보정 사용'이 켜져 있을 때만 효과가 있습니다."
            ),
        )

        st.markdown("**라벨(이름) 고정**")
        lc1, lc2 = st.columns([1, 1])
        label_lock = lc1.checkbox(
            "라벨 고정", value=bool(t.get("label_lock", True)), key="ctl_lbllock",
            help=(
                "켜면 트랙이 일정 표를 모은 뒤 그 시점 다수결 라벨로 이름을 **고정**합니다. "
                "이후 YOLO가 라벨을 다르게 추정(오탐)해도 트랙의 이름은 바뀌지 않습니다. "
                "ID뿐 아니라 표시되는 클래스명까지 안정적으로 유지하려면 켜두세요."
            ),
        )
        label_lock_min_count = lc2.slider(
            "고정까지 누적 탐지 수", 1, 20,
            int(t.get("label_lock_min_count", 6)), 1, key="ctl_lblcnt",
            help=(
                "라벨을 고정하기 전에 모을 라벨 샘플 수.\n\n"
                "• **키우면** 더 많은 관측 후 고정 → 초기 오탐에 덜 휘둘림(고정은 늦음).\n"
                "• **줄이면** 빨리 고정 → 반응 빠르나 초기 오탐을 굳힐 위험."
            ),
        )

        b1, b2 = st.columns(2)
        if b1.button("✅ 적용", width="stretch", key="ctl_apply"):
            ok_d, res_d = _post_json(backend, "/api/detector/config",
                                     {"conf": conf, "iou": iou, "max_det": max_det})
            ok_t, res_t = _post_json(backend, "/api/tracker/config",
                                     {"max_age": max_age, "vel_damping": vel_damping,
                                      "vel_alpha": vel_alpha, "arrow_scale": arrow_scale,
                                      "base_gate": base_gate, "min_hits": min_hits,
                                      "max_speed": max_speed, "label_lock": label_lock,
                                      "label_lock_min_count": label_lock_min_count,
                                      "iou_merge_gate": iou_merge_gate})
            ok_f, res_f = _post_json(backend, "/api/preprocess/stage1",
                                     {"mode": fog_mode, "foggy_th": fog_th,
                                      "foggy_th_high": fog_th_high,
                                      "dark_enabled": dark_enabled, "dark_gain": dark_gain})
            if ok_d and ok_t and ok_f:
                st.success("적용 완료 — 다음 프레임부터 반영됩니다.")
            else:
                st.error(f"적용 실패 (탐지={res_d} / 트래커={res_t} / 안개={res_f})")
        if b2.button("↺ 현재값 다시 불러오기", width="stretch", key="ctl_reload"):
            for k in ("init_tcfg", "init_dcfg", "init_fcfg", *_CTL_KEYS):
                st.session_state.pop(k, None)
            st.rerun()


# ── 사이드바: 설정 / 입력 / 측정 제어 ────────────────────────────────────────
with st.sidebar:
    st.header("⚙️ 설정")
    backend = st.text_input(
        "백엔드 주소 (FastAPI)",
        value=DEFAULT_BACKEND,
        help="이 Streamlit 서버에서 접근 가능한 주소면 됩니다(localhost 가능).",
    ).rstrip("/")

    try:
        healthy = requests.get(f"{backend}/healthz", timeout=3).ok
    except Exception:
        healthy = False
    if healthy:
        st.success("백엔드 연결됨")
    else:
        st.error("백엔드에 연결할 수 없음")

    st.divider()
    st.subheader("📥 입력 영상")
    tab_upload, tab_url = st.tabs(["파일 업로드", "URL / 경로 / 카메라"])

    with tab_upload:
        up = st.file_uploader(
            "영상 파일",
            type=["mp4", "avi", "mov", "mkv", "webm", "m4v", "mpg", "mpeg"],
        )
        if up is not None and st.button("⬆️ 업로드 후 처리 시작", width="stretch"):
            holder = {"status": "uploading", "msg": f"업로드 중: {up.name}", "elapsed": None}
            st.session_state.upload_job = holder
            st.session_state.stream_nonce += 1  # 새 소스 → 라이브 재연결
            threading.Thread(
                target=_upload_in_background,
                args=(backend, up.name, up.getvalue(), up.type or "video/mp4", holder),
                daemon=True,
            ).start()
            st.rerun()

        job = st.session_state.get("upload_job")
        if job:
            if job["status"] == "uploading":
                st.info("⏳ " + job["msg"] + " (백그라운드 업로드 중)")
            elif job["status"] == "done":
                st.success("✅ " + job["msg"])
            else:
                st.error(job["msg"])

    with tab_url:
        src = st.text_input(
            "RTSP / HTTP / 서버 파일경로 / 카메라 인덱스",
            placeholder="/home/.../video.mp4  또는  rtsp://...  또는  0",
            help="서버에 있는 파일/스트림은 업로드(복사) 없이 즉시 처리됩니다.",
        )
        if st.button("▶️ 소스 적용", width="stretch") and src.strip():
            new_src = src.strip()
            # 같은 주소를 다시 넣어도 '새로 파싱'되도록 항상 reset 후 적용한다.
            try:
                requests.post(f"{backend}/api/reset", timeout=10)
            except Exception:
                pass
            try:
                resp = requests.post(f"{backend}/api/source", json={"source": new_src}, timeout=10)
                if resp.ok:
                    st.session_state.stream_nonce += 1  # 새 소스 → 라이브 재연결
                    st.session_state.pop("upload_job", None)
                    st.success(f"소스 적용(새로 파싱): {resp.json().get('source')}")
                    st.rerun()
                else:
                    st.error(f"적용 실패: {resp.status_code} {resp.text}")
            except Exception as e:
                st.error(f"요청 실패: {e}")

    # 처리 중지/초기화 — 현재 소스를 해제하고 대기(idle) 상태로 되돌린다.
    if st.button("⏹️ 처리 중지 / 초기화", width="stretch",
                 help="현재 영상 처리를 멈추고 소스를 해제합니다. "
                      "(파일은 끝나면 자동 반복되므로 멈추려면 이 버튼을 누르세요)"):
        try:
            resp = requests.post(f"{backend}/api/reset", timeout=10)
            if resp.ok:
                st.session_state.stream_nonce += 1
                st.session_state.pop("upload_job", None)
                st.success("처리 중지 — 소스 해제됨 (대기 중)")
                st.rerun()
            else:
                st.error(f"초기화 실패: {resp.status_code} {resp.text}")
        except Exception as e:
            st.error(f"요청 실패: {e}")

    st.divider()
    st.subheader("🖥️ 실시간 화면")
    show_live = st.toggle("영상 표시 (처리 전/후)", value=True)
    after_feed = st.selectbox(
        "처리 후 피드",
        list(STREAM_FEEDS.keys()),
        format_func=lambda k: STREAM_FEEDS[k],
    )
    view_w = st.slider("확대 크기(px)", 320, 1920, 960, 40,
                       help="평소엔 좌우로 절반씩, 영상을 클릭하면 이 크기로 확대됩니다.")
    with st.expander("스트림 주소 설정 (보통 자동)"):
        stream_host = st.text_input(
            "스트림 호스트 (비우면 자동 감지)",
            value=DEFAULT_STREAM_HOST,
            placeholder="자동 (지금 접속한 주소 사용)",
            help="비우면 지금 브라우저로 접속한 호스트를 그대로 사용합니다. "
                 "예외 시에만 직접 입력(예: ppsystem.kro.kr 또는 http://ppsystem.kro.kr:8886).",
        ).strip()
        stream_port = st.number_input(
            "스트림 포트", value=DEFAULT_STREAM_PORT, min_value=1, max_value=65535, step=1,
            help="백엔드(FastAPI) 포트. 기본 8886.",
        )

    st.divider()
    st.subheader("📈 측정")
    auto = st.toggle("자동 새로고침", value=True, help="끄면 1회만 측정합니다.")
    interval = st.slider("새로고침 간격(초)", 0.5, 5.0, 1.0, 0.5)
    if st.button("🔄 누적 통계 초기화", width="stretch"):
        st.session_state.pop("samples", None)
        st.rerun()


# ── 측정 누적 통계 (세션 유지) ───────────────────────────────────────────────
if "samples" not in st.session_state:
    st.session_state.samples = {k: [] for k in STAGES}
    st.session_state.total_samples = []
    st.session_state.last_frame = -1


def _accumulate(status: dict) -> None:
    """새 프레임이면 단계별 시간을 누적."""
    t = status.get("timings_ms") or {}
    fidx = status.get("frame_idx", -1)
    if not t or fidx == st.session_state.last_frame:
        return
    st.session_state.last_frame = fidx
    for k in STAGES:
        st.session_state.samples[k].append(float(t.get(k, 0.0)))
    st.session_state.total_samples.append(float(t.get("total", 0.0)))
    # 최근 300 프레임만 유지
    for k in STAGES:
        st.session_state.samples[k] = st.session_state.samples[k][-300:]
    st.session_state.total_samples = st.session_state.total_samples[-300:]


def _avg(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def _dir_arrow(vx: float, vy: float) -> str:
    """속도 벡터 → 8방향 화살표(화면 기준, 이미지 y는 아래로 증가)."""
    if abs(vx) < 1e-6 and abs(vy) < 1e-6:
        return "·"
    deg = math.degrees(math.atan2(vy, vx))  # 0=→, 90=↓(아래), -90=↑(위)
    arrows = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"]
    return arrows[int(((deg + 360 + 22.5) % 360) // 45)]


def _heading_deg(vx: float, vy: float) -> float:
    """화면 기준 방위각(도). 위쪽=0°, 시계방향 증가(오른쪽=90°, 아래=180°, 왼쪽=270°)."""
    # 화면 좌표는 y가 아래로 증가 → 위(-vy)를 기준 0°로 두고 시계방향으로 잰다.
    return math.degrees(math.atan2(vx, -vy)) % 360.0


def _render_objects(backend: str, fps: float) -> None:
    """탐지된 물체 목록과 화면좌표·속도벡터·방위를 표로 표시한다(매 새로고침 갱신)."""
    data = _get_json(backend, "/api/detections") or {}
    tracks = data.get("tracks", []) or []
    # 정지 판정 임계(px/frame). 트래커 config 의 speed_thresh 를 그대로 사용.
    thr = float((st.session_state.get("init_tcfg") or {}).get("speed_thresh", 0.3))
    use_ps = bool(fps and fps > 0)

    with objects_ph.container():
        st.markdown("#### 🎯 탐지된 물체 · 위치 · 속도벡터")
        if not tracks:
            st.info("표시할 트랙이 없습니다. 영상을 처리 중이면 잠시 후 나타납니다.")
            return

        rows = []
        moving = 0
        for tk in tracks:
            # 화면 좌표(처리 해상도 px): bbox 중심을 물체 위치로 사용. y는 아래로 증가.
            bb = tk.get("bbox") or [0, 0, 0, 0]
            cx = (float(bb[0]) + float(bb[2])) / 2.0
            cy = (float(bb[1]) + float(bb[3])) / 2.0

            # 속도벡터(화면 좌표). 트래커는 px/frame → fps 알면 px/s 로 환산.
            vx = float(tk.get("vx", 0.0))
            vy = float(tk.get("vy", 0.0))
            scale = fps if use_ps else 1.0
            svx, svy = vx * scale, vy * scale
            spd_pf = math.hypot(vx, vy)            # px/frame (정지 판정용)
            spd = math.hypot(svx, svy)             # 표시 속력

            is_pred = bool(tk.get("is_predicted"))
            if is_pred:
                state = "예측(가려짐)"
            elif spd_pf < thr:
                state = "정지"
            else:
                state = "이동"
                moving += 1

            rows.append({
                "ID": tk.get("track_id"),
                "종류": tk.get("label", "?"),
                "위치(x,y)": f"({cx:.0f}, {cy:.0f})",
                "속력": round(spd, 1),
                "벡터(vx,vy)": f"({svx:+.1f}, {svy:+.1f})",
                "방위(°)": round(_heading_deg(vx, vy), 0) if spd_pf >= thr else None,
                "방향": _dir_arrow(vx, vy),
                "상태": state,
            })
        # 이동 중인 물체를 위로, 속력 큰 순으로 정렬
        rows.sort(key=lambda r: (r["상태"] != "이동", -r["속력"]))

        m1, m2 = st.columns(2)
        m1.metric("총 물체 수", len(tracks))
        m2.metric("이동 중", moving)
        st.dataframe(rows, width="stretch", hide_index=True)
        unit = "px/s (소스 fps 환산)" if use_ps else "px/frame (fps 미상)"
        st.caption(
            f"좌표·벡터는 처리 해상도 화면좌표(원점 좌상단, y는 아래로 증가) 기준  ·  "
            f"속력/벡터 단위: {unit}  ·  방위: 위쪽=0°, 시계방향(오른쪽 90°, 아래 180°)  ·  "
            f"'정지'는 속도<{thr:g}px/f, '예측'은 가려져 칼만 예측으로 유지 중인 트랙."
        )


# ── 메인: 실시간 화면 + 성능/지연 대시보드 ───────────────────────────────────
st.title("📊 NIT 실시간 화면 · 처리 성능 분석")
st.caption("업로드/지정한 영상을 백엔드가 처리하며, 처리 전/후 화면과 처리 속도·단계별 지연(병목)을 함께 보여줍니다.")

# ── 실시간 비교 화면 (처리 전 / 처리 후) ─────────────────────────────────────
# MJPEG <img> 는 브라우저가 직접 스트리밍하므로 아래 측정 루프와 무관하게 계속 갱신된다.
# 브라우저가 접속한 호스트를 JS 로 감지해 :stream_port 로 영상을 받으므로 보통 설정 불필요.
if show_live:
    st.subheader("🎞️ 실시간 비교 (처리 전 / 처리 후)")
    # 줌(단일 확대) 시 4:3 이미지가 잘리지 않도록 높이를 넉넉히 잡는다.
    comp_h = int(view_w * 0.75) + 90
    # 소스가 바뀌면 nonce 가 올라가 HTML 문자열이 달라지고 → iframe 이 새로 그려져
    # <img> 가 새 MJPEG 연결을 맺는다(이전 소스 화면 잔류 방지).
    stream_nonce = st.session_state.stream_nonce
    _live_html = f"""
<style>
  /* iframe 본문 기본 흰 배경 제거(영상 가림 방지) */
  html,body{{margin:0;padding:0;background:transparent}}
  .nit-wrap{{font-family:system-ui,sans-serif;color:#e5e7eb}}
  .nit-row{{display:flex;gap:12px;align-items:flex-start}}
  .nit-cell{{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center}}
  .nit-cell .cap{{font-weight:600;margin-bottom:4px;font-size:14px}}
  /* aspect-ratio 로 프레임 도착 전에도 자리를 잡아 흰 공백/가림 방지 */
  .nit-cell img{{width:100%;max-width:100%;aspect-ratio:4/3;object-fit:contain;display:block;
                 border:1px solid #374151;border-radius:8px;background:#0b0f14;cursor:zoom-in}}
  .nit-row.zoomed .nit-cell.hidden{{display:none}}
  .nit-row.zoomed .nit-cell.big{{flex:1 1 100%}}
  .nit-row.zoomed .nit-cell.big img{{max-width:{view_w}px;cursor:zoom-out}}
</style>
<div class="nit-wrap">
  <div class="nit-row" id="row">
    <div class="nit-cell" id="cellA">
      <div class="cap">처리 전 (원본)</div>
      <img id="a" alt="원본 스트림 로딩 중… (백엔드에 처리 중인 영상이 있어야 표시)">
    </div>
    <div class="nit-cell" id="cellB">
      <div class="cap">처리 후 ({STREAM_FEEDS[after_feed]})</div>
      <img id="b" alt="처리 결과 스트림 로딩 중…">
    </div>
  </div>
  <div id="info" style="color:#9ca3af;font-size:12px;margin-top:6px"></div>
</div>
<script>
(function() {{
  var override = "{stream_host}".trim();
  var base;
  if (override) {{
    base = override.indexOf("://") >= 0 ? override : ("http://" + override);
    if (base.charAt(base.length - 1) === "/") base = base.slice(0, -1);
  }} else {{
    var host = "";
    try {{ host = new URL(document.referrer).hostname; }} catch (e) {{}}
    if (!host) host = window.location.hostname;
    base = "http://" + host + ":{stream_port}";
  }}
  var bust = Date.now() + "_{stream_nonce}";
  document.getElementById('a').src = base + "/video_feed/original?t=" + bust;
  document.getElementById('b').src = base + "/video_feed/{after_feed}?t=" + bust;
  document.getElementById('info').textContent = "스트림: " + base + "  ·  영상을 클릭하면 확대/축소";

  var row = document.getElementById('row');
  var cA = document.getElementById('cellA'), cB = document.getElementById('cellB');
  function toggle(big, other) {{
    if (row.classList.contains('zoomed') && big.classList.contains('big')) {{
      row.classList.remove('zoomed');
      big.classList.remove('big'); other.classList.remove('hidden');
    }} else {{
      row.classList.add('zoomed');
      big.classList.add('big'); big.classList.remove('hidden');
      other.classList.add('hidden'); other.classList.remove('big');
    }}
  }}
  document.getElementById('a').addEventListener('click', function() {{ toggle(cA, cB); }});
  document.getElementById('b').addEventListener('click', function() {{ toggle(cB, cA); }});
}})();
</script>
"""
    components.html(_live_html, height=comp_h)

# 영상 바로 아래: 실시간 파라미터 조정 패널
if healthy:
    _controls_panel(backend)
st.divider()

objects_ph = st.empty()
metrics_ph = st.empty()
timing_ph = st.empty()
note_ph = st.empty()


def _render(status: dict | None) -> None:
    if status is None:
        metrics_ph.error("백엔드 상태를 가져올 수 없습니다. 주소/실행 여부를 확인하세요.")
        return

    _accumulate(status)

    fps = status.get("fps", 0.0)            # 소스 영상 fps(표시 기준, minkyu 동일)
    proc_fps = status.get("proc_fps", 0.0)  # 실제 처리 throughput(측정값)
    frame_idx = status.get("frame_idx", 0)
    opened = status.get("source_opened", False)
    avg_total = _avg(st.session_state.total_samples)
    n = len(st.session_state.total_samples)

    # 탐지된 물체 + 속도벡터 표 (영상 바로 아래, 매 새로고침 갱신)
    _render_objects(backend, fps)

    with metrics_ph.container():
        c1, c2, c3, c4 = st.columns(4)
        c1.metric("실제 처리 FPS", f"{proc_fps:.2f}", help="프레임당 실제 연산 throughput")
        c2.metric("평균 처리시간 / 프레임", f"{avg_total:.1f} ms")
        c3.metric("처리 프레임", frame_idx)
        c4.metric("소스 연결", "🟢 연결됨" if opened else "🔴 끊김")
        st.caption(
            f"소스 fps(표시 기준): {fps:.2f}  ·  소스: `{status.get('source')}`  ·  누적 샘플 {n} 프레임"
        )
        if status.get("last_error"):
            st.warning(status["last_error"])

    # 단계별 평균 시간 + 비율(병목)
    avgs = {k: _avg(st.session_state.samples[k]) for k in STAGES}
    denom = sum(avgs.values()) or 1.0
    bottleneck = max(avgs, key=avgs.get) if any(avgs.values()) else None

    with timing_ph.container():
        st.markdown("#### ⏱️ 단계별 처리시간 (평균) — 막대가 길수록 지연 큼")
        if not any(avgs.values()):
            st.info("아직 처리된 프레임이 없습니다. 영상을 업로드하거나 소스를 지정하세요.")
        else:
            for k in STAGES:
                ms = avgs[k]
                pct = ms / denom
                mark = "  ⬅️ **병목**" if k == bottleneck else ""
                st.write(f"**{STAGE_LABELS[k]}** — {ms:.1f} ms  ({pct * 100:.0f}%){mark}")
                st.progress(min(pct, 1.0))
            st.caption(
                f"파이프라인 합계 ≈ {sum(avgs.values()):.1f} ms/프레임  →  "
                f"이론 최대 처리속도 ≈ {1000.0 / (sum(avgs.values()) or 1):.1f} FPS"
            )

    with note_ph.container():
        with st.expander("ℹ️ 지연(딜레이)은 어디서 생기나?"):
            st.markdown(
                "- **단계별 처리시간(위 막대)**: 한 프레임을 처리하는 실제 연산 시간. "
                "보통 `Stage1/Stage2` 전처리가 가장 무겁습니다(GPU 미사용 부분).\n"
                "- **업로드 전송 시간**: 내 PC 파일 업로드는 전송이 끝나야 처리가 시작됩니다"
                "(MP4는 전체 필요). 서버 파일/RTSP 는 즉시 시작 → 이 지연 없음.\n"
                "- **인코딩/네트워크(enc)**: 결과를 JPEG 로 만들고 내보내는 비용. "
                "스트리밍을 보지 않으면 이 비용은 처리량에 영향만 주고 화면 지연과는 무관합니다.\n"
                "- **FPS vs 합계**: 위 '이론 최대 FPS'(합계 기반)보다 실제 FPS 가 낮으면 "
                "캡처/스레드 대기 등 파이프라인 외 요인이 있는 것입니다."
            )


# 측정 실행
if not healthy:
    metrics_ph.error("백엔드에 연결할 수 없습니다.")
elif auto:
    # 자동 새로고침: 끄거나 위젯을 조작하면 루프가 중단되고 rerun 됨
    while True:
        _render(_get_status(backend))
        time.sleep(interval)
else:
    _render(_get_status(backend))
