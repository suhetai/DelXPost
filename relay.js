// 运行在插件隔离环境，把 hook.js 截到的数据转发给 background。
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.__xtc !== 'userData') return;
  try {
    chrome.runtime.sendMessage({ type: 'userData', url: e.data.url, data: e.data.data });
  } catch (_) { /* 插件重新加载后旧页面会失效，忽略 */ }
});
