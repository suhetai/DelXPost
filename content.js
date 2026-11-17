// X Tweet Cleaner - content script
// 在 x.com 页面中查找包含关键字的推文，并通过模拟点击 "..." -> "删除" -> "确认" 来删除。

(() => {
  if (window.__xTweetCleanerLoaded) return;
  window.__xTweetCleanerLoaded = true;

  const DEFAULTS = {
    keyword: 'http://ccs0919.pixnet.net',
    intervalSec: 2,      // 每删一条间隔（秒）
    batchSize: 200,      // 每批删除数量
    pauseMin: 10,        // 每批之后暂停（分钟）
    maxTotal: 0,         // 总共最多删除多少，0 = 不限
    maxEmptyScrolls: 15  // 连续多少次滚动都没找到匹配推文就结束
  };

  // 各语言界面里菜单 "删除" 项的文字
  const DELETE_WORDS = ['Delete', '删除', '刪除', '削除', '삭제', 'Supprimer', 'Eliminar', 'Löschen', 'Excluir', 'Удалить'];
  const SESSION_FLAG = 'xTweetCleanerActive';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let running = false;
  let skipped = new WeakSet();
  let stats = { total: 0, batch: 0, skipped: 0, status: '空闲', resumeAt: 0 };

  // ---------- 工具函数 ----------
  async function waitFor(fn, timeout = 5000, step = 100) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function normalize(s) {
    return (s || '').toLowerCase().replace(/https?:\/\//g, '').replace(/\s+/g, ' ').trim();
  }

  async function getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return { ...DEFAULTS, ...(settings || {}) };
  }

  async function saveStats(patch) {
    Object.assign(stats, patch);
    renderPanel();
    try { await chrome.storage.local.set({ stats }); } catch (_) { /* 扩展被重新加载时可能失败 */ }
  }

  function pressEscape() {
    const opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true };
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.body.dispatchEvent(new KeyboardEvent('keydown', opts));
  }

  // ---------- 查找匹配推文 ----------
  function tweetMatches(article, kw) {
    // 只看推文本身的正文（第一个 tweetText），不看引用推文
    const textEl = article.querySelector('[data-testid="tweetText"]');
    let text = textEl ? textEl.innerText : '';
    // 链接有时会被截断显示，把链接的 href / title 也加进去
    if (textEl) {
      textEl.querySelectorAll('a').forEach((a) => {
        text += ' ' + (a.title || '') + ' ' + (a.getAttribute('href') || '');
      });
    }
    return normalize(text).includes(kw);
  }

  function findCandidate(kw) {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const a of articles) {
      if (skipped.has(a)) continue;
      if (tweetMatches(a, kw)) return a;
    }
    return null;
  }

  // ---------- 删除单条推文 ----------
  async function deleteTweet(article) {
    article.scrollIntoView({ block: 'center' });
    await sleep(300);

    const caret = article.querySelector('[data-testid="caret"]');
    if (!caret) return 'skip';
    caret.click();

    const menuItem = await waitFor(() => {
      const items = document.querySelectorAll('[role="menu"] [role="menuitem"]');
      for (const el of items) {
        const t = el.innerText.trim();
        if (DELETE_WORDS.some((w) => t === w || t.startsWith(w))) return el;
      }
      return null;
    }, 3000);

    if (!menuItem) {
      // 没有删除选项：不是自己的推文（例如转推），跳过
      pressEscape();
      await sleep(300);
      return 'skip';
    }
    menuItem.click();

    const confirmBtn = await waitFor(
      () => document.querySelector('[data-testid="confirmationSheetConfirm"]'),
      3000
    );
    if (!confirmBtn) {
      pressEscape();
      return 'error';
    }
    confirmBtn.click();

    // 等待推文从页面消失，确认删除成功
    const gone = await waitFor(() => !article.isConnected || !article.offsetParent, 6000);
    return gone ? 'ok' : 'error';
  }

  // ---------- 暂停（带倒计时） ----------
  async function pauseFor(ms, reason) {
    const resumeAt = Date.now() + ms;
    await saveStats({ resumeAt, status: reason });
    while (running && Date.now() < resumeAt) {
      renderPanel();
      await sleep(1000);
    }
    await saveStats({ resumeAt: 0 });
  }

  // ---------- 主循环 ----------
  async function run() {
    if (running) return;
    running = true;
    sessionStorage.setItem(SESSION_FLAG, '1');
    skipped = new WeakSet();

    const s = await getSettings();
    const kw = normalize(s.keyword);
    if (!kw) {
      await saveStats({ status: '关键字为空，已停止' });
      return stop();
    }

    const saved = (await chrome.storage.local.get('stats')).stats || {};
    stats = { total: saved.total || 0, batch: saved.batch || 0, skipped: 0, status: '运行中', resumeAt: 0 };

    // 如果是刷新页面后继续，且之前处于暂停期，则继续等待
    if (saved.resumeAt && saved.resumeAt > Date.now()) {
      await pauseFor(saved.resumeAt - Date.now(), '批次暂停中（刷新后继续）');
      stats.batch = 0;
    }
    await saveStats({ status: '运行中' });

    let emptyScrolls = 0;
    let consecutiveErrors = 0;

    while (running) {
      if (s.maxTotal > 0 && stats.total >= s.maxTotal) {
        await saveStats({ status: `已达到总上限 ${s.maxTotal}，完成` });
        break;
      }

      if (stats.batch >= s.batchSize) {
        await pauseFor(s.pauseMin * 60 * 1000, `本批已删 ${stats.batch} 条，暂停中`);
        if (!running) break;
        await saveStats({ batch: 0, status: '运行中（新一批）' });
      }

      const article = findCandidate(kw);
      if (!article) {
        emptyScrolls++;
        if (emptyScrolls > s.maxEmptyScrolls) {
          await saveStats({ status: '页面上没有更多匹配的推文，已完成（可刷新/换搜索条件后再开始）' });
          break;
        }
        await saveStats({ status: `未找到匹配推文，向下滚动加载… (${emptyScrolls}/${s.maxEmptyScrolls})` });
        window.scrollBy(0, window.innerHeight * 2);
        await sleep(2500);
        continue;
      }
      emptyScrolls = 0;

      const result = await deleteTweet(article);
      if (result === 'ok') {
        consecutiveErrors = 0;
        await saveStats({ total: stats.total + 1, batch: stats.batch + 1, status: '运行中' });
        await sleep(Math.max(0.5, s.intervalSec) * 1000);
      } else if (result === 'skip') {
        skipped.add(article);
        await saveStats({ skipped: stats.skipped + 1 });
      } else {
        consecutiveErrors++;
        skipped.add(article); // 本轮先跳过，避免卡在同一条
        await saveStats({ status: `删除失败 (${consecutiveErrors} 次连续)` });
        if (consecutiveErrors >= 5) {
          // 很可能被限流，暂停一段时间再继续
          skipped = new WeakSet();
          consecutiveErrors = 0;
          await pauseFor(s.pauseMin * 60 * 1000, '连续失败，疑似限流，暂停中');
        } else {
          await sleep(3000);
        }
      }
    }

    stop();
  }

  function stop() {
    running = false;
    sessionStorage.removeItem(SESSION_FLAG);
    if (!/完成|停止/.test(stats.status)) stats.status = '已停止';
    saveStats({ resumeAt: 0 });
  }

  // ---------- 页面悬浮面板 ----------
  let panel;
  function renderPanel() {
    if (!panel) {
      panel = document.createElement('div');
      panel.style.cssText =
        'position:fixed;top:12px;right:12px;z-index:2147483647;background:#111;color:#fff;' +
        'font:13px/1.5 system-ui,sans-serif;padding:10px 12px;border-radius:10px;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.4);min-width:220px;max-width:300px;opacity:.92';
      panel.innerHTML =
        '<div style="font-weight:600;margin-bottom:4px">🧹 X Tweet Cleaner</div>' +
        '<div data-k="body"></div>' +
        '<button data-k="btn" style="margin-top:6px;padding:3px 10px;border-radius:6px;border:0;cursor:pointer"></button>';
      panel.querySelector('[data-k="btn"]').onclick = () => (running ? stop() : run());
      document.documentElement.appendChild(panel);
    }
    let countdown = '';
    if (stats.resumeAt && stats.resumeAt > Date.now()) {
      const sec = Math.ceil((stats.resumeAt - Date.now()) / 1000);
      countdown = `<br>恢复倒计时：${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, '0')}秒`;
    }
    panel.querySelector('[data-k="body"]').innerHTML =
      `状态：${stats.status}${countdown}<br>累计删除：${stats.total}　本批：${stats.batch}<br>跳过：${stats.skipped}`;
    const btn = panel.querySelector('[data-k="btn"]');
    btn.textContent = running ? '停止' : '开始';
    btn.style.background = running ? '#f4212e' : '#1d9bf0';
    btn.style.color = '#fff';
  }

  // ---------- 与 popup 通信 ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'start') {
      run();
      sendResponse({ ok: true });
    } else if (msg.type === 'stop') {
      stop();
      sendResponse({ ok: true });
    } else if (msg.type === 'ping') {
      sendResponse({ ok: true, running });
    }
  });

  // 同一个标签页刷新后自动继续
  if (sessionStorage.getItem(SESSION_FLAG) === '1') {
    setTimeout(run, 4000);
  }
})();
