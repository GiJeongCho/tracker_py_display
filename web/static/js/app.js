// 앱 진입점 (module). nit_v25 구조 계승: 공통 초기화 → tab-loader → 탭 모듈 동적 import.
import { initTheme } from './common/theme.js';
import { initSidebar } from './common/sidebar.js';
import { statusStore } from './common/status-store.js';
import { tabLoader } from './utils/tab-loader.js';

class App {
  constructor() {
    this.currentTab = null;
    this.tabs = { dashboard: null, control: null, analytics: null, report: null };
    this.tabButtonMap = {
      dashboard: 'btn-dashboard', control: 'btn-control',
      analytics: 'btn-analytics', report: 'btn-report',
    };
  }

  async init() {
    initTheme();
    initSidebar();
    this._wireBackendSetting();

    // 단일 상태 폴러 시작(사이드바 배지 + nit-status 이벤트)
    statusStore.start();

    try { await tabLoader.preload(); } catch (e) { /* best-effort */ }
    try { await this.switchTab('dashboard'); }
    catch (e) { setTimeout(() => this.switchTab('dashboard').catch(() => {}), 500); }

    this.setupNavigation();
  }

  _wireBackendSetting() {
    const be = document.getElementById('backend-input');
    const btn = document.getElementById('btn-backend');
    if (be) be.value = localStorage.getItem('nit_backend') || '';
    if (btn && be) btn.addEventListener('click', () => {
      const v = be.value.trim();
      if (v) localStorage.setItem('nit_backend', v); else localStorage.removeItem('nit_backend');
      location.reload();
    });
  }

  setupNavigation() {
    Object.entries(this.tabButtonMap).forEach(([tab, btnId]) => {
      const b = document.getElementById(btnId);
      if (b) b.addEventListener('click', () => this.switchTab(tab));
    });
  }

  resetAllTabButtons() {
    Object.values(this.tabButtonMap).forEach((id) => {
      const b = document.getElementById(id);
      if (!b) return;
      b.classList.remove('bg-primary', 'text-white');
      b.classList.add('text-text-light-secondary', 'dark:text-dark-secondary', 'hover:bg-gray-200', 'dark:hover:bg-gray-700');
    });
  }
  activateTabButton(tab) {
    const b = document.getElementById(this.tabButtonMap[tab]);
    if (!b) return;
    b.classList.remove('text-text-light-secondary', 'dark:text-dark-secondary', 'hover:bg-gray-200', 'dark:hover:bg-gray-700');
    b.classList.add('bg-primary', 'text-white');
  }

  async switchTab(tabName) {
    if (this.currentTab && this.tabs[this.currentTab] && this.tabs[this.currentTab].destroy) {
      try { this.tabs[this.currentTab].destroy(); } catch (e) { /* ignore */ }
    }
    this.resetAllTabButtons();
    await tabLoader.load(tabName);
    try {
      const module = await import(`./tabs/${tabName}.js`);
      this.tabs[tabName] = module;
      if (module.init) module.init();
      this.currentTab = tabName;
      this.activateTabButton(tabName);
    } catch (error) {
      console.error(`Error initializing tab ${tabName}:`, error);
    }
  }
}

const app = new App();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => app.init());
else app.init();
