// .ctl-slider (data-key/min/max/step/int) 요소를 슬라이더 UI 로 렌더/읽기.
export const SLIDER_LABELS = {
  dark_gain: 'dark_gain — 저조도 밝기 게인',
  conf: 'conf — 탐지 신뢰도 임계',
  iou: 'iou — NMS 중복 제거',
  max_det: 'max_det — 최대 탐지 수',
  max_age: 'max_age — 고스트 유지(프레임)',
  vel_damping: 'vel_damping — 고스트 예측 이동률',
  vel_alpha: 'vel_alpha — 속도 부드러움(EMA)',
  arrow_scale: 'arrow_scale — 화살표 길이(표시)',
  base_gate: 'base_gate — 매칭 게이트',
  min_hits: 'min_hits — 표시까지 연속 탐지',
  max_speed: 'max_speed — 예측 속도 상한(px/f)',
  iou_merge_gate: 'iou_merge_gate — 겹침 병합',
  label_lock_min_count: '라벨 고정까지 누적 수',
};

export function renderSliders(root) {
  (root || document).querySelectorAll('.ctl-slider').forEach((box) => {
    const key = box.dataset.key;
    const label = SLIDER_LABELS[key] || key;
    box.innerHTML = `
      <div class="flex justify-between items-center mb-1 mt-2">
        <span class="text-xs font-medium">${label}</span>
        <span class="text-xs font-mono text-primary" id="val-${key}">--</span>
      </div>
      <input type="range" id="ctl-${key}" min="${box.dataset.min}" max="${box.dataset.max}"
             step="${box.dataset.step}" class="w-full h-1.5 rounded-lg cursor-pointer">`;
    const input = box.querySelector('input');
    const disp = box.querySelector('#val-' + key);
    input.addEventListener('input', () => { disp.textContent = input.value; });
  });
}

export function setSlider(key, v) {
  const input = document.getElementById('ctl-' + key);
  const disp = document.getElementById('val-' + key);
  if (!input || v == null) return;
  input.value = v; if (disp) disp.textContent = input.value;
}

export function readSlider(box) {
  const key = box.dataset.key;
  const input = document.getElementById('ctl-' + key);
  if (!input) return [key, null];
  const num = box.dataset.int ? parseInt(input.value, 10) : parseFloat(input.value);
  return [key, Number.isFinite(num) ? num : null];
}

export function setStatus(id, text, ok) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'text-xs mt-1 font-medium ' + (ok ? 'text-green-500' : 'text-red-500');
  if (ok) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 4000);
}
