"""
pages/1_영상_처리결과.py
=======================

영상을 업로드하면 백엔드가 app.py 와 **동일한 처리(전처리 + YOLO 객체탐지 + 트래킹)**
를 전체 프레임에 적용한 결과 영상을 만들고, 그 결과를 **다운로드**할 수 있는 페이지.

흐름:
  1) 영상 업로드 → POST /api/process (job_id 반환)
  2) GET /api/process/{job_id} 폴링 (진행률)
  3) 완료 시 GET /api/output/{job_id} 로 결과 영상 받아 미리보기 + 다운로드
"""

from __future__ import annotations

import json
import os
import time

import requests
import streamlit as st

DEFAULT_BACKEND = os.getenv("BACKEND_URL", "http://localhost:8886")

st.set_page_config(page_title="영상 처리 결과", page_icon="🎬", layout="centered")
st.title("🎬 영상 업로드 → 객체탐지 처리 → 다운로드")
st.caption("영상을 올리면 메인 화면과 동일하게 전처리·객체탐지·트래킹을 적용한 결과 영상을 만들어 다운로드할 수 있습니다.")

backend = st.text_input("백엔드 주소 (FastAPI)", value=DEFAULT_BACKEND).rstrip("/")

try:
    healthy = requests.get(f"{backend}/healthz", timeout=3).ok
except Exception:
    healthy = False
if not healthy:
    st.error("백엔드에 연결할 수 없음 — 주소/실행 여부를 확인하세요.")


def _get_json(path: str):
    try:
        r = requests.get(f"{backend}{path}", timeout=3)
        if r.ok:
            return r.json()
    except Exception:
        return {}
    return {}


# ── 처리 파라미터 (이 값으로 결과 영상을 만든다) ─────────────────────────────
# 백엔드 현재값을 한 번 받아 슬라이더 기본값으로 사용.
if healthy and "dl_tcfg" not in st.session_state:
    st.session_state.dl_tcfg = _get_json("/api/tracker/config")
    st.session_state.dl_dcfg = _get_json("/api/detector/config")
    st.session_state.dl_fcfg = _get_json("/api/preprocess/stage1")
t = st.session_state.get("dl_tcfg", {}) or {}
d = st.session_state.get("dl_dcfg", {}) or {}
f = st.session_state.get("dl_fcfg", {}) or {}

with st.expander("⚙️ 처리 파라미터 (이 값으로 영상을 만듭니다)", expanded=True):
    st.caption("각 항목의 ⓘ 에 마우스를 올리면 설명이 나옵니다. 여기서 정한 값으로 결과 영상이 생성됩니다.")
    c1, c2 = st.columns(2)
    with c1:
        st.markdown("**탐지(YOLO) 민감도**")
        conf = st.slider("conf — 낮을수록 민감(오탐↑)", 0.05, 0.90,
                         float(d.get("conf", 0.30)), 0.01,
                         help="신뢰도 임계. 낮추면 약한 탐지도 통과(탐지율↑·오탐↑), 높이면 보수적.")
        iou = st.slider("iou — NMS 중복 제거", 0.10, 0.95,
                        float(d.get("iou", 0.70)), 0.05,
                        help="겹치는 박스를 합치는 기준. 낮추면 적극 병합, 높이면 분리 유지.")
        max_det = st.slider("max_det — 프레임당 최대 탐지 수", 10, 1000,
                            int(d.get("max_det", 300)), 10,
                            help="한 프레임에서 검출할 최대 객체 수.")
    with c2:
        st.markdown("**트래킹**")
        max_age = st.slider("max_age — 고스트 유지 프레임", 1, 300,
                            int(t.get("max_age", 100)), 1,
                            help="미탐지 시 예측으로 트랙을 유지할 프레임 수(↑ 오래 유지).")
        base_gate = st.slider("base_gate — 매칭 허용 범위", 1.0, 80.0,
                              float(t.get("base_gate", 24.0)), 1.0,
                              help="예측↔탐지 매칭 허용 거리(↑ ID 유지↑, 스왑 위험↑).")
        vel_damping = st.slider("vel_damping — 고스트 예측 속도", 0.0, 1.0,
                                float(t.get("vel_damping", 0.45)), 0.05,
                                help="고스트가 속도 방향으로 밀리는 비율(↓ 방향전환 ID 유지).")
        max_speed = st.slider("max_speed — 예측 속도 상한(px/프레임)", 0.0, 60.0,
                              float(t.get("max_speed", 0.5)), 0.5,
                              help="예측 속도 상한. 낮추면 '퓽' 날아감↓, 빠른 표적은 놓칠 수 있음.")
        iou_merge_gate = st.slider("iou_merge_gate — 겹침 시 중복 병합", 0.0, 0.9,
                                   float(t.get("iou_merge_gate", 0.75)), 0.05,
                                   help="고스트 위에 탐지가 이 IoU 이상 겹치면 같은 객체로 병합(중복 제거).")
        arrow_scale = st.slider("arrow_scale — 속도 화살표 길이", 0.0, 1.0,
                                float(t.get("arrow_scale", 0.2)), 0.05,
                                help="속도 화살표 길이(표시 전용).")
    label_lock = st.checkbox(
        "라벨(이름) 고정", value=bool(t.get("label_lock", True)),
        help="켜면 일정 표를 모은 뒤 라벨을 고정해 YOLO 오탐에도 이름이 바뀌지 않습니다.",
    )

    st.markdown("**전처리 — 안개 제거(Stage1)**")
    fc0, fc1 = st.columns([1, 2])
    _modes = ["auto", "fog", "dark", "none"]
    _cur = str(f.get("mode", "auto"))
    fog_mode = fc0.selectbox(
        "mode", _modes, index=_modes.index(_cur) if _cur in _modes else 0,
        help="auto=밝기로 자동 / fog=항상 제거 / dark=저조도 보정 / none=끔.",
    )
    _band_lo = float(f.get("foggy_th", 90.0))
    _band_hi = float(f.get("foggy_th_high", 255.0))
    if _band_hi < _band_lo:
        _band_hi = _band_lo
    fog_th, fog_th_high = fc1.slider(
        "안개 제거 밝기 구간 [하한 · 상한]", 0.0, 255.0,
        (_band_lo, _band_hi), 1.0,
        help="auto에서 '하한 ≤ 밝기 < 상한' 구간만 안개 제거. "
             "밝기<하한=저조도(dark), 밝기≥상한=생략. 두 점을 붙이면 안개 제거 off.",
    )
    dk1, dk2 = st.columns([1, 2])
    dark_enabled = dk1.checkbox(
        "암흑 보정 사용", value=bool(f.get("dark_enabled", True)),
        help="끄면 어두운 장면도 원본 그대로(밝아지지 않음).",
    )
    dark_gain = dk2.slider(
        "dark_gain — 저조도 밝기 게인", 0.1, 3.0,
        float(f.get("dark_gain", 1.0)), 0.05,
        help="저조도 보정 밝기 배율(1.0=기본). 낮추면 덜 밝게, 높이면 더 밝게.",
    )


def _build_config() -> dict:
    return {
        "tracker": {
            "max_age": max_age, "base_gate": base_gate, "vel_damping": vel_damping,
            "max_speed": max_speed, "iou_merge_gate": iou_merge_gate,
            "arrow_scale": arrow_scale, "label_lock": label_lock,
        },
        "detector": {"conf": conf, "iou": iou, "max_det": max_det},
        "fog": {"mode": fog_mode, "foggy_th": fog_th, "foggy_th_high": fog_th_high,
                "dark_enabled": dark_enabled, "dark_gain": dark_gain},
    }


# ── 입력: 영상 업로드 ────────────────────────────────────────────────────────
up = st.file_uploader(
    "영상 파일",
    type=["mp4", "avi", "mov", "mkv", "webm", "m4v", "mpg", "mpeg"],
)
if up is not None and st.button("▶️ 처리 시작", type="primary", width="stretch", disabled=not healthy):
    with st.spinner(f"업로드 중: {up.name} …"):
        try:
            files = {"file": (up.name, up.getvalue(), up.type or "video/mp4")}
            form = {"config": json.dumps(_build_config())}
            r = requests.post(f"{backend}/api/process", files=files, data=form, timeout=3600)
            if r.ok:
                st.session_state.batch_job_id = r.json()["job_id"]
                st.session_state.pop("batch_video", None)
                st.rerun()
            else:
                st.error(f"처리 시작 실패: {r.status_code} {r.text[:300]}")
        except Exception as e:
            st.error(f"요청 실패: {e}")


# ── 진행 상황 폴링 ───────────────────────────────────────────────────────────
job_id = st.session_state.get("batch_job_id")
if not job_id:
    st.info("영상을 업로드하고 ‘처리 시작’을 누르세요.")
    st.stop()

st.divider()
prog = st.progress(0.0)
line = st.empty()

status = "running"
data: dict = {}
while True:
    try:
        data = requests.get(f"{backend}/api/process/{job_id}", timeout=5).json()
    except Exception as e:
        line.error(f"상태 조회 실패: {e}")
        break
    status = data.get("status", "running")
    prog.progress(float(data.get("progress", 0.0)))
    line.caption(
        f"처리 중 … {data.get('done_frames', 0)} / {data.get('total_frames', 0)} 프레임 "
        f"· {float(data.get('progress', 0.0)) * 100:.0f}%"
    )
    if status in ("done", "error"):
        break
    time.sleep(0.7)

if status == "error":
    st.error(f"처리 오류: {data.get('error')}")
    if st.button("🆕 다시 시도", width="stretch"):
        st.session_state.pop("batch_job_id", None)
        st.session_state.pop("batch_video", None)
        st.rerun()
    st.stop()

if status != "done":
    st.stop()


# ── 완료: 결과 영상 미리보기 + 다운로드 ──────────────────────────────────────
prog.progress(1.0)
st.success("처리 완료")

if "batch_video" not in st.session_state:
    try:
        with st.spinner("결과 영상 받는 중 …"):
            vr = requests.get(f"{backend}/api/output/{job_id}", timeout=300)
        if vr.ok:
            st.session_state.batch_video = vr.content
        else:
            st.error(f"결과 영상 수신 실패: {vr.status_code}")
    except Exception as e:
        st.error(f"결과 영상 요청 실패: {e}")

video_bytes = st.session_state.get("batch_video")
if video_bytes:
    st.video(video_bytes)
    st.download_button(
        "⬇️ 결과 영상 다운로드",
        data=video_bytes,
        file_name=f"processed_{job_id}.mp4",
        mime="video/mp4",
        type="primary",
        width="stretch",
    )
    st.caption("영상이 재생되지 않으면 코덱 문제일 수 있습니다 → 다운로드해서 재생하세요.")

if st.button("🆕 새 영상 처리", width="stretch"):
    st.session_state.pop("batch_job_id", None)
    st.session_state.pop("batch_video", None)
    st.rerun()
