// 탭 HTML 부분을 /static/tabs/{tab}.html 에서 fetch 해 #main-content 에 주입한다.
class TabLoader {
  constructor() {
    this.cache = new Map();
    this.loading = new Set();
    this.preloadQueue = ['dashboard'];
  }

  async preload() {
    for (const tabName of this.preloadQueue) {
      try { await this.load(tabName, false); }
      catch (e) { console.warn(`Tab preload failed: ${tabName}`, e); }
    }
  }

  async load(tabName, insertToDOM = true) {
    if (this.cache.has(tabName)) {
      const html = this.cache.get(tabName);
      if (insertToDOM) this.insertToDOM(html, tabName);
      return html;
    }
    if (this.loading.has(tabName)) {
      await this.waitForLoad(tabName);
      if (insertToDOM) this.insertToDOM(this.cache.get(tabName), tabName);
      return this.cache.get(tabName);
    }
    this.loading.add(tabName);
    try {
      const res = await fetch(`/static/tabs/${tabName}.html`);
      if (!res.ok) throw new Error(`Failed to load tab: ${tabName}`);
      const html = await res.text();
      this.cache.set(tabName, html);
      if (insertToDOM) this.insertToDOM(html, tabName);
      return html;
    } finally {
      this.loading.delete(tabName);
    }
  }

  insertToDOM(html, tabName) {
    const container = document.getElementById('main-content');
    if (!container) return;
    container.querySelectorAll('[id^="view-"]').forEach((v) => { v.style.display = 'none'; });
    let view = document.getElementById(`view-${tabName}`);
    if (!view) {
      view = document.createElement('div');
      view.id = `view-${tabName}`;
      view.className = 'w-full h-full overflow-y-auto custom-scrollbar';
      container.appendChild(view);
    }
    view.innerHTML = html;
    view.style.display = 'block';
  }

  waitForLoad(tabName) {
    return new Promise((resolve) => {
      const iv = setInterval(() => {
        if (this.cache.has(tabName) && !this.loading.has(tabName)) { clearInterval(iv); resolve(); }
      }, 10);
    });
  }
}

export const tabLoader = new TabLoader();
