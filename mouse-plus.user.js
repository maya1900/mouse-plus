// ==UserScript==
// @name         Mouse Plus
// @name:zh-CN  Mouse Plus 鼠标手势
// @namespace    https://github.com/maya1900/mouse-plus
// @version      1.0.2
// @description  Ctrl + right-click mouse gestures for basic webpage navigation.
// @description:zh-CN  使用 Ctrl + 右键鼠标手势执行网页后退、前进、刷新、滚动等基础操作。
// @author       mayang
// @match        *://*/*
// @homepageURL  https://github.com/maya1900/mouse-plus
// @supportURL   https://github.com/maya1900/mouse-plus/issues
// @updateURL    https://raw.githubusercontent.com/maya1900/mouse-plus/main/mouse-plus.user.js
// @downloadURL  https://raw.githubusercontent.com/maya1900/mouse-plus/main/mouse-plus.user.js
// @license      MIT
// @compatible   chrome
// @compatible   edge
// @compatible   firefox
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.openInTab
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const SETTINGS = {
    button: 2,
    startGestureDistance: 10,
    minMoveDistance: 10,
    minDirectionDistance: 24,
    overlayZIndex: 2147483647,
    lineColor: '#2f80ed',
    lineWidth: 3,
    pointColor: 'rgba(47, 128, 237, 0.16)',
    hintDuration: 950,
    hintOffset: 18,
  };

  const GESTURES = new Map([
    ['L', { label: '后退', action: () => window.history.back() }],
    ['R', { label: '前进', action: () => window.history.forward() }],
    ['U', { label: '回到顶部', action: () => window.scrollTo({ top: 0, behavior: 'smooth' }) }],
    ['D', { label: '滚到底部', action: () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }) }],
    ['UD', { label: '刷新', action: () => window.location.reload() }],
    ['DU', { label: '硬性重新加载', action: () => hardReload() }],
    ['UL', { label: '清空缓存刷新', action: () => clearCacheAndReload() }],
    ['LDR', { label: '打开刚才关闭的网页', action: (point) => openRecentlyClosedPage(point) }],
    ['LR', { label: '重新打开当前页', action: () => window.location.reload() }],
    ['RL', { label: '停止加载', action: () => window.stop() }],
    ['DR', { label: '跳转空白页', action: () => openBlankPage() }],
    ['DL', { label: '最小化滚动到左侧', action: () => window.scrollTo({ left: 0, behavior: 'smooth' }) }],
    ['RD', { label: '向下翻页', action: () => window.scrollBy({ top: window.innerHeight * 0.9, behavior: 'smooth' }) }],
    ['RU', { label: '向上翻页', action: () => window.scrollBy({ top: -window.innerHeight * 0.9, behavior: 'smooth' }) }],
  ]);

  const DIRECTIONS = {
    L: '←',
    R: '→',
    U: '↑',
    D: '↓',
  };

  const RECENT_CLOSED_KEY = 'mouse-plus:recent-closed-page';
  const CACHE_BUSTER_PARAM = '__mouse_plus_cache_reload';

  let state = null;
  let canvas = null;
  let context = null;
  let hint = null;
  let hintTimer = 0;
  let suppressContextMenuUntil = 0;

  function gmGetValue(key, fallbackValue) {
    if (typeof GM_getValue === 'function') {
      return Promise.resolve(GM_getValue(key, fallbackValue));
    }

    if (typeof GM !== 'undefined' && typeof GM.getValue === 'function') {
      return GM.getValue(key, fallbackValue);
    }

    return Promise.resolve(fallbackValue);
  }

  function gmSetValue(key, value) {
    if (typeof GM_setValue === 'function') {
      GM_setValue(key, value);
      return Promise.resolve();
    }

    if (typeof GM !== 'undefined' && typeof GM.setValue === 'function') {
      return GM.setValue(key, value);
    }

    return Promise.resolve();
  }

  function gmOpenInTab(url) {
    if (typeof GM_openInTab === 'function') {
      GM_openInTab(url, { active: true, insert: true });
      return;
    }

    if (typeof GM !== 'undefined' && typeof GM.openInTab === 'function') {
      GM.openInTab(url, { active: true, insert: true });
      return;
    }

    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function canStoreCurrentPage() {
    return window.location.protocol === 'http:' || window.location.protocol === 'https:';
  }

  function storeCurrentPage() {
    if (!canStoreCurrentPage()) {
      return;
    }

    gmSetValue(RECENT_CLOSED_KEY, {
      title: document.title || window.location.href,
      url: window.location.href,
      storedAt: Date.now(),
    });
  }

  function makeCacheBustedUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set(CACHE_BUSTER_PARAM, String(Date.now()));
    return url.toString();
  }

  function hardReload() {
    window.location.replace(makeCacheBustedUrl());
  }

  async function clearCacheAndReload() {
    if ('caches' in window) {
      const names = await window.caches.keys();
      await Promise.all(names.map((name) => window.caches.delete(name)));
    }

    window.location.replace(makeCacheBustedUrl());
  }

  async function openRecentlyClosedPage(point) {
    const recentPage = await gmGetValue(RECENT_CLOSED_KEY, null);

    if (!recentPage || !recentPage.url) {
      showHint('没有记录到刚才关闭的网页', point.x, point.y, 'error');
      return;
    }

    gmOpenInTab(recentPage.url);
  }

  function openBlankPage() {
    window.location.href = 'about:blank';
  }

  function runGestureAction(gesture, point) {
    try {
      const result = gesture.action(point);

      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          showHint('操作执行失败', point.x, point.y, 'error');
        });
      }
    } catch (error) {
      showHint('操作执行失败', point.x, point.y, 'error');
    }
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) {
      return false;
    }

    const editable = target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
    return Boolean(editable);
  }

  function createOverlay() {
    if (canvas && context && hint) {
      return;
    }

    canvas = document.createElement('canvas');
    canvas.style.cssText = [
      'position:fixed',
      'inset:0',
      'width:100vw',
      'height:100vh',
      'pointer-events:none',
      `z-index:${SETTINGS.overlayZIndex}`,
    ].join(';');

    hint = document.createElement('div');
    hint.style.cssText = [
      'position:fixed',
      'left:0',
      'top:0',
      'transform:translate3d(-9999px,-9999px,0)',
      'pointer-events:none',
      `z-index:${SETTINGS.overlayZIndex}`,
      'box-sizing:border-box',
      'max-width:min(360px,calc(100vw - 32px))',
      'padding:8px 11px',
      'border-radius:8px',
      'background:rgba(18,22,30,0.92)',
      'color:#fff',
      'font:13px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'box-shadow:0 8px 22px rgba(0,0,0,0.22)',
      'white-space:nowrap',
      'user-select:none',
    ].join(';');

    const root = document.documentElement;
    root.appendChild(canvas);
    root.appendChild(hint);
    context = canvas.getContext('2d');
    resizeCanvas();
  }

  function resizeCanvas() {
    if (!canvas || !context) {
      return;
    }

    const ratio = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;

    canvas.width = Math.max(1, Math.floor(width * ratio));
    canvas.height = Math.max(1, Math.floor(height * ratio));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function clearCanvas() {
    if (!context) {
      return;
    }

    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  function showHint(text, x, y, type = 'normal') {
    createOverlay();
    clearTimeout(hintTimer);

    hint.textContent = text;
    hint.style.background = type === 'error' ? 'rgba(168, 44, 44, 0.94)' : 'rgba(18,22,30,0.92)';

    const maxX = Math.max(12, window.innerWidth - hint.offsetWidth - 12);
    const maxY = Math.max(12, window.innerHeight - hint.offsetHeight - 12);
    hint.style.transform = `translate3d(${clamp(x + SETTINGS.hintOffset, 12, maxX)}px, ${clamp(y + SETTINGS.hintOffset, 12, maxY)}px, 0)`;

    hintTimer = window.setTimeout(() => {
      if (hint) {
        hint.style.transform = 'translate3d(-9999px,-9999px,0)';
      }
    }, SETTINGS.hintDuration);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  }

  function formatGesture(sequence) {
    if (!sequence) {
      return '无';
    }

    return Array.from(sequence, (direction) => DIRECTIONS[direction] || direction).join('');
  }

  function drawPath(points) {
    clearCanvas();

    if (!context || points.length < 2) {
      return;
    }

    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = SETTINGS.lineWidth;
    context.strokeStyle = SETTINGS.lineColor;
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);

    for (let index = 1; index < points.length; index += 1) {
      context.lineTo(points[index].x, points[index].y);
    }

    context.stroke();

    const last = points[points.length - 1];
    context.fillStyle = SETTINGS.pointColor;
    context.beginPath();
    context.arc(last.x, last.y, 9, 0, Math.PI * 2);
    context.fill();
  }

  function resolveDirection(fromPoint, toPoint) {
    const dx = toPoint.x - fromPoint.x;
    const dy = toPoint.y - fromPoint.y;
    const distance = Math.hypot(dx, dy);

    if (distance < SETTINGS.minDirectionDistance) {
      return '';
    }

    if (Math.abs(dx) > Math.abs(dy)) {
      return dx > 0 ? 'R' : 'L';
    }

    return dy > 0 ? 'D' : 'U';
  }

  function updateGesture(event) {
    if (!state) {
      return;
    }

    const point = { x: event.clientX, y: event.clientY };
    const lastPoint = state.points[state.points.length - 1];
    const moveDistance = Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y);
    const startDistance = Math.hypot(point.x - state.startPoint.x, point.y - state.startPoint.y);

    if (!state.active && startDistance < SETTINGS.startGestureDistance) {
      return;
    }

    if (!state.active) {
      state.active = true;
      suppressContextMenuUntil = Date.now() + 800;
      createOverlay();
      resizeCanvas();
      clearCanvas();
      showHint('开始手势', state.startPoint.x, state.startPoint.y);
    }

    if (moveDistance < SETTINGS.minMoveDistance) {
      return;
    }

    state.points.push(point);
    const direction = resolveDirection(state.directionAnchor, point);

    if (direction) {
      if (direction !== state.sequence.charAt(state.sequence.length - 1)) {
        state.sequence += direction;
      }

      state.directionAnchor = point;
    }

    drawPath(state.points);
    const gesture = GESTURES.get(state.sequence);
    const label = gesture ? gesture.label : '识别中';
    showHint(`${formatGesture(state.sequence)} ${label}`, point.x, point.y);
  }

  function startGesture(event) {
    if (event.button !== SETTINGS.button || !event.ctrlKey || isEditableTarget(event.target)) {
      return;
    }

    const startPoint = { x: event.clientX, y: event.clientY };
    state = {
      active: false,
      startPoint,
      points: [startPoint],
      sequence: '',
      directionAnchor: startPoint,
      startedAt: Date.now(),
      target: event.target,
    };

    event.preventDefault();
    event.stopPropagation();
    suppressContextMenuUntil = Date.now() + 1200;
  }

  function executeGesture(currentState, point) {
    clearCanvas();

    if (!currentState.sequence) {
      showHint('未检测到手势', point.x, point.y, 'error');
      return;
    }

    const gesture = GESTURES.get(currentState.sequence);
    if (!gesture) {
      showHint(`无效手势 ${formatGesture(currentState.sequence)}`, point.x, point.y, 'error');
      return;
    }

    showHint(`${formatGesture(currentState.sequence)} ${gesture.label}`, point.x, point.y);
    window.setTimeout(() => {
      runGestureAction(gesture, point);
    }, 80);
  }

  function finishGesture(event) {
    if (!state || event.button !== SETTINGS.button) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    suppressContextMenuUntil = Date.now() + 800;

    const currentState = state;
    const point = { x: event.clientX, y: event.clientY };
    state = null;

    if (!currentState.active) {
      clearCanvas();
      return;
    }

    executeGesture(currentState, point);
  }

  function cancelGesture(event) {
    if (!state) {
      return;
    }

    const wasActive = state.active;

    if (wasActive) {
      event.preventDefault();
      event.stopPropagation();
      suppressContextMenuUntil = Date.now() + 800;
    }

    state = null;
    clearCanvas();

    if (!wasActive) {
      return;
    }

    showHint('手势已取消', event.clientX || 20, event.clientY || 20, 'error');
  }

  function blockContextMenu(event) {
    if (!state && Date.now() > suppressContextMenuUntil) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    suppressContextMenuUntil = Date.now() + 800;
  }

  function onMouseMove(event) {
    if (!state) {
      return;
    }

    updateGesture(event);

    if (state && state.active) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  window.addEventListener('resize', resizeCanvas, true);
  window.addEventListener('blur', cancelGesture, true);
  window.addEventListener('pagehide', storeCurrentPage, true);
  window.addEventListener('beforeunload', storeCurrentPage, true);
  document.addEventListener('mousedown', startGesture, true);
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mouseup', finishGesture, true);
  document.addEventListener('contextmenu', blockContextMenu, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      cancelGesture(event);
    }
  }, true);
})();
