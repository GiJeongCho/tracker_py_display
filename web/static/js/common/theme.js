// 다크/라이트 테마 토글 (nit_v25 계승)
export function initTheme() {
  const themeToggle = document.getElementById('theme-toggle');
  if (!themeToggle) return;
  const themeIcon = themeToggle.querySelector('.material-icons');
  const themeText = document.getElementById('theme-toggle-text');

  function update() {
    const dark = document.documentElement.classList.contains('dark');
    if (themeIcon) themeIcon.textContent = dark ? 'dark_mode' : 'wb_sunny';
    if (themeText) themeText.textContent = dark ? '다크 모드' : '라이트 모드';
  }
  update();
  themeToggle.addEventListener('click', () => {
    document.documentElement.classList.toggle('dark');
    update();
  });
}
