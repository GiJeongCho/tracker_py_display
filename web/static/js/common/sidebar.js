// 사이드바 접기/펼치기 (nit_v25 계승)
export function initSidebar() {
  let wide = true;
  const btn = document.getElementById('btn-sidebar-mode');
  const icon = btn && btn.querySelector('.material-icons');
  if (!btn) return;
  btn.title = '사이드바 닫기';
  btn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const sidebar = document.getElementById('sidebar');
    const texts = sidebar.querySelectorAll('.sidebar-text');
    wide = !wide;
    if (!wide) {
      sidebar.classList.remove('w-64'); sidebar.classList.add('w-20');
      texts.forEach((t) => { t.classList.remove('opacity-100'); t.classList.add('opacity-0'); });
      if (icon) icon.textContent = 'chevron_right';
      btn.title = '사이드바 열기';
    } else {
      sidebar.classList.remove('w-20'); sidebar.classList.add('w-64');
      texts.forEach((t) => { t.classList.remove('opacity-0'); t.classList.add('opacity-100'); });
      if (icon) icon.textContent = 'chevron_left';
      btn.title = '사이드바 닫기';
    }
  });
}
