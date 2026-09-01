<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, reactive, computed, nextTick, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// ========== 类型 ==========
interface Pane { id: number }
interface Window { id: number; name: string; panes: Pane[] }
interface Session { name: string; windows: Window[] }
interface Slot {
  id: number
  target: string
  title: string
  ws: WebSocket | null
  term: Terminal | null
  fit: FitAddon | null
  ro: ResizeObserver | null
  el: HTMLElement | null
  connected: boolean
  retryTimer: ReturnType<typeof setTimeout> | null
  reconnectOnClose: boolean
}
interface Tab { id: number; pane: Slot; title: string }

// ========== 配置 ==========
const WS_PORT = 38090;
const API_BASE = '/api';
const HOST = location.hostname || 'localhost';

// ========== 状态 ==========
const sessions = ref<Session[]>([]);
const expanded = reactive(new Set<string>());
const loading = ref(false);
const lastSlotId = ref(1);
const lastTabId = ref(1);
const tabs = reactive<Tab[]>([{ id: 1, pane: createSlot(1), title: '' }]);
const activeTabId = ref(1);

// 侧栏搜索
const searchQuery = ref('');
const filteredSessions = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return sessions.value;
  return sessions.value
    .map((s) => {
      const win = s.windows.filter(
        (w) => w.name.toLowerCase().includes(q) || String(w.id).includes(q),
      );
      return { ...s, windows: win };
    })
    .filter((s) => s.name.toLowerCase().includes(q) || s.windows.length > 0);
});

// 弹窗
const modal = reactive<{
  show: boolean
  mode: 'prompt' | 'confirm'
  title: string
  value: string
  text: string
  okText: string
  danger: boolean
  hint: string
}>({
  show: false,
  mode: 'prompt',
  title: '',
  value: '',
  text: '',
  okText: '确定',
  danger: false,
  hint: '',
});
const modalInput = ref<HTMLInputElement | null>(null);
let modalResolve: ((v: any) => void) | null = null;

function showPrompt(title: string, value = '', hint = ''): Promise<string | null> {
  modal.show = true;
  modal.mode = 'prompt';
  modal.title = title;
  modal.value = value;
  modal.hint = hint;
  modal.okText = '确定';
  modal.danger = false;
  nextTick(() => modalInput.value?.focus());
  return new Promise((res) => {
    modalResolve = res;
  });
}
function showConfirm(title: string, text = '', okText = '确认', danger = true): Promise<boolean> {
  modal.show = true;
  modal.mode = 'confirm';
  modal.title = title;
  modal.text = text;
  modal.okText = okText;
  modal.danger = danger;
  return new Promise((res) => {
    modalResolve = res;
  });
}
function modalOk() {
  const r = modalResolve;
  modalResolve = null;
  modal.show = false;
  if (r) r(modal.mode === 'prompt' ? modal.value : true);
}
function modalCancel() {
  const r = modalResolve;
  modalResolve = null;
  modal.show = false;
  if (r) r(modal.mode === 'prompt' ? null : false);
}

// Toast
interface ToastItem { id: number; msg: string; kind: 'error' | 'info' | 'ok' }
const toasts = ref<ToastItem[]>([]);
let lastToastId = 0;
function toast(msg: string, kind: 'error' | 'info' | 'ok' = 'info') {
  const id = ++lastToastId;
  toasts.value.push({ id, msg, kind });
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, 3200);
}

// ========== Slot / Tab 工厂 ==========
function createSlot(id: number): Slot {
  return {
    id,
    target: '',
    title: '',
    ws: null,
    term: null,
    fit: null,
    ro: null,
    el: null,
    connected: false,
    retryTimer: null,
    reconnectOnClose: true,
  };
}

function newTab(): Tab {
  lastTabId.value++;
  lastSlotId.value++;
  const tab: Tab = { id: lastTabId.value, pane: createSlot(lastSlotId.value), title: '' };
  tabs.push(tab);
  activeTabId.value = tab.id;
  return tab;
}

const activeTab = computed(() => tabs.find((t) => t.id === activeTabId.value) || tabs[0]);

// ========== API ==========
async function api(path: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function loadSessions() {
  try {
    sessions.value = await api('/sessions');
  } catch {
    sessions.value = [];
  }
}

// ========== Session 操作 ==========
async function addSession() {
  const name = await showPrompt('新建 Session', '', '仅支持字母、数字、点、-、_（≤63位）');
  if (!name || !/^[\w.-]{1,63}$/.test(name)) return;
  try {
    await api('/sessions', { method: 'POST', body: JSON.stringify({ name }) });
    await loadSessions();
    toast('Session 已创建', 'ok');
  } catch (e: any) {
    toast(e.message, 'error');
  }
}

async function delSession(s: Session) {
  const ok = await showConfirm('删除 Session', `确定要删除 "${s.name}" 及其所有窗口吗？`, '删除', true);
  if (!ok) return;
  try {
    await api(`/sessions/${s.name}`, { method: 'DELETE' });
    tabs.forEach((t) => {
      if (t.pane.target && t.pane.target.startsWith(s.name + ':')) closeSlot(t.pane);
    });
    await loadSessions();
    toast('Session 已删除', 'ok');
  } catch (e: any) {
    toast(e.message, 'error');
  }
}

function toggleSession(name: string) {
  if (expanded.has(name)) expanded.delete(name);
  else expanded.add(name);
}

// ========== Window 操作 ==========
async function addWindow(session: string) {
  try {
    await api(`/sessions/${session}/windows`, { method: 'POST', body: JSON.stringify({}) });
    await loadSessions();
    toast('窗口已创建', 'ok');
  } catch (e: any) {
    toast(e.message, 'error');
  }
}

async function delWindow(session: string, win: Window) {
  const ok = await showConfirm('删除窗口', `确定要删除窗口 ${win.id} (${win.name}) 吗？`, '删除', true);
  if (!ok) return;
  try {
    await api(`/sessions/${session}/windows/${win.id}`, { method: 'DELETE' });
    tabs.forEach((t) => {
      if (t.pane.target === `${session}:${win.id}`) closeSlot(t.pane);
    });
    await loadSessions();
    toast('窗口已删除', 'ok');
  } catch (e: any) {
    toast(e.message, 'error');
  }
}

async function renameWindow(session: string, win: Window) {
  const name = await showPrompt(`重命名窗口 ${win.id}`, win.name, '');
  if (!name || !name.trim()) return;
  try {
    await api(`/sessions/${session}/windows/${win.id}/rename`, {
      method: 'POST',
      body: JSON.stringify({ name: name.trim() }),
    });
    await loadSessions();
  } catch (e: any) {
    toast(e.message, 'error');
  }
}

// ========== Terminal Tab 管理 ==========
function openWindow(session: string, win: Window) {
  const target = `${session}:${win.id}`;
  const existing = tabs.find((t) => t.pane.target === target);
  if (existing) {
    activeTabId.value = existing.id;
  } else {
    let tab = activeTab.value;
    if (tab.pane.target) tab = newTab();
    tab.pane.target = target;
    tab.pane.title = `${session}:${win.id} / ${win.name}`;
    tab.title = tab.pane.title;
    nextTick(() => openTerminal(tab.pane));
  }
}

function closeTab(tab: Tab) {
  closeSlot(tab.pane);
  const idx = tabs.indexOf(tab);
  if (idx >= 0) tabs.splice(idx, 1);
  if (tabs.length === 0) {
    lastTabId.value++;
    lastSlotId.value++;
    tabs.push({ id: lastTabId.value, pane: createSlot(lastSlotId.value), title: '' });
  }
  if (activeTabId.value === tab.id) {
    activeTabId.value = tabs[tabs.length - 1].id;
  }
}

async function renameTab(tab: Tab) {
  const name = await showPrompt('重命名标签', tab.title, '');
  if (!name || !name.trim()) return;
  tab.title = name.trim();
  tab.pane.title = name.trim();
}

function openTerminal(slot: Slot) {
  if (!slot.el) return;

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    lineHeight: 1,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  slot.el.innerHTML = '';
  term.open(slot.el);
  fit.fit();
  send(slot, { type: 'resize', cols: term.cols, rows: term.rows });

  // 终端首次打开时，容器/字体的尺寸可能尚未稳定，
  // 单个 fit 或单次 rAF 容易过早，导致只会撑满 4 个格子那样的小窗口。
  // 这里做多阶段补 fit：rAF → 字体加载完成 → 150ms 兜底，
  // 每次都重新发送 resize，确保首次打开就能铺满。
  const refit = () => {
    try {
      fit.fit();
      send(slot, { type: 'resize', cols: term.cols, rows: term.rows });
    } catch { /* ignore */ }
  };
  requestAnimationFrame(refit);
  if (document.fonts?.ready) {
    document.fonts.ready.then(refit).catch(() => { /* ignore */ });
  }
  setTimeout(refit, 150);

  slot.term = term;
  slot.fit = fit;

  // 观察 slot-body 容器，确保终端始终适配
  const ro = new ResizeObserver(() => {
    try {
      fit.fit();
      send(slot, { type: 'resize', cols: term.cols, rows: term.rows });
    } catch { /* ignore */ }
  });
  ro.observe(slot.el.parentElement!);
  slot.ro = ro;

  term.onData((data) => send(slot, { type: 'input', data }));

  connectSlot(slot);
}

function connectSlot(slot: Slot) {
  if (slot.retryTimer) {
    clearTimeout(slot.retryTimer);
    slot.retryTimer = null;
  }
  if (!slot.target) return;

  const ws = new WebSocket(`ws://${HOST}:${WS_PORT}`);
  slot.ws = ws;

  ws.onopen = () => {
    slot.connected = true;
    send(slot, { type: 'open', target: slot.target, slotId: slot.id });
    const t = slot.term;
    if (t) send(slot, { type: 'resize', cols: t.cols, rows: t.rows });
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch { return; }
    if (msg.type === 'output' && slot.term) {
      slot.term.write(msg.data);
    }
    if (msg.type === 'exit') {
      slot.connected = false;
      slot.reconnectOnClose = false;
    }
    if (msg.type === 'status') {
      slot.connected = !!msg.connected;
    }
    if (msg.type === 'error') {
      console.warn('WS error for', slot.target, ':', msg.message);
    }
  };

  ws.onclose = () => {
    slot.connected = false;
    if (slot.target && slot.reconnectOnClose) {
      slot.retryTimer = setTimeout(() => connectSlot(slot), 3000);
    }
  };

  ws.onerror = () => ws.close();
}

function send(slot: Slot, obj: unknown) {
  if (slot.ws?.readyState === WebSocket.OPEN) {
    slot.ws.send(JSON.stringify(obj));
  }
}

function closeSlot(slot: Slot) {
  slot.target = '';
  slot.title = '';
  slot.reconnectOnClose = true;
  if (slot.retryTimer) { clearTimeout(slot.retryTimer); slot.retryTimer = null; }
  if (slot.ws) { slot.ws.onclose = null; slot.ws.close(); slot.ws = null; }
  if (slot.ro) { slot.ro.disconnect(); slot.ro = null; }
  if (slot.term) { slot.term.dispose(); slot.term = null; slot.fit = null; }
  if (slot.el) slot.el.innerHTML = '';
  slot.connected = false;
}

// 切换 Tab 时重新 fit 终端
watch(activeTabId, () => {
  const t = activeTab.value;
  if (t.pane.fit && t.pane.el) {
    nextTick(() => {
      try { t.pane.fit!.fit(); } catch { /* ignore */ }
    });
  }
});

// ========== 生命周期 ==========
onMounted(async () => {
  await loadSessions();
});

onBeforeUnmount(() => {
  tabs.forEach((t) => closeSlot(t.pane));
});
</script>

<template>
  <div class="layout">
    <!-- 侧栏 -->
    <aside
      class="sidebar"
    >
      <div class="sidebar-header">
        <span class="sidebar-title">Sessions</span>
        <button class="btn btn-sm" @click="loadSessions()" title="刷新">&#x21bb;</button>
        <button class="btn btn-sm btn-accent" @click="addSession()" title="新建 Session">+ Session</button>
      </div>

      <!-- 搜索框 -->
      <div class="sidebar-search">
        <input
          v-model="searchQuery"
          type="text"
          class="search-input"
          placeholder="搜索会话/窗口…"
          @keydown.esc="searchQuery = ''"
        />
        <button v-if="searchQuery" class="btn-icon search-clear" @click="searchQuery = ''" title="清除">&#x2715;</button>
      </div>

      <div class="session-list" v-if="filteredSessions.length">
        <div v-for="s in filteredSessions" :key="s.name" class="session-item">
          <div class="session-head" @click="toggleSession(s.name)">
            <span class="arrow" :class="{ open: expanded.has(s.name) }">&#x25B6;</span>
            <span class="sname">{{ s.name }}</span>
            <span class="win-count">{{ s.windows.length }}</span>
            <button class="btn-icon" @click.stop="delSession(s)" title="删除 Session">&#x2715;</button>
          </div>
          <div v-if="expanded.has(s.name)" class="window-list">
            <div
              v-for="w in s.windows"
              :key="w.id"
              class="window-item"
              :class="{ active: tabs.some((t) => t.pane.target === `${s.name}:${w.id}`) }"
              @click="openWindow(s.name, w)"
            >
              <span class="wid">{{ w.id }}</span>
              <span class="wname">{{ w.name }}</span>
              <button class="btn-icon" @click.stop="renameWindow(s.name, w)" title="重命名">&#x270E;</button>
              <button class="btn-icon" @click.stop="delWindow(s.name, w)" title="删除窗口">&#x2715;</button>
            </div>
            <button class="btn btn-sm btn-addwin" @click="addWindow(s.name)">+ Window</button>
          </div>
        </div>
      </div>
      <div v-else class="empty-hint">
        <span v-if="loading">加载中…</span>
        <span v-else-if="searchQuery">无匹配结果</span>
        <span v-else>暂无 Session</span>
      </div>
    </aside>

    <!-- 终端区域 -->
    <main class="grid-area">
      <!-- Tab 栏 -->
      <div class="tab-bar">
        <div
          v-for="tab in tabs"
          :key="tab.id"
          class="tab-item"
          :class="{ active: tab.id === activeTabId }"
          @click="activeTabId = tab.id"
        >
          <span class="tab-title" @dblclick.stop="renameTab(tab)">{{ tab.title || '新终端' }}</span>
          <button class="btn-icon tab-close" @click.stop="closeTab(tab)" title="关闭标签">&#x2715;</button>
        </div>
        <button class="btn btn-sm btn-accent" @click="newTab()" title="新建标签">+ Tab</button>
        <span class="tab-spacer"></span>
      </div>

      <!-- 当前 Tab 的终端 -->
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tab-body"
        v-show="tab.id === activeTabId"
      >
        <div class="slot" @click="activeTabId = tab.id">
          <div v-if="tab.pane.target" class="slot-bar">
            <span class="slot-title">{{ tab.pane.title }}</span>
            <span class="slot-status" :class="{ on: tab.pane.connected }">{{ tab.pane.connected ? '已连接' : '未连接' }}</span>
            <button class="btn-icon" @click.stop="closeTab(tab)" title="关闭终端">&#x2715;</button>
          </div>
          <div v-else class="slot-bar">
            <span class="slot-title dim">点击左侧窗口打开终端</span>
          </div>
          <div class="slot-body">
              <div
                class="xterm-wrap"
                :ref="(el: any) => { if (el) tab.pane.el = el as HTMLElement; }"
              ></div>
            <div v-if="!tab.pane.target" class="slot-empty">
              <span class="empty-icon">▦</span>
              <span class="empty-label">点击左侧窗口打开终端</span>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- Toast 提示 -->
    <div class="toasts">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">
        {{ t.msg }}
      </div>
    </div>

    <!-- 模态弹窗 -->
    <teleport to="body">
      <div v-if="modal.show" class="modal-overlay" @mousedown.self="modalCancel">
        <div class="modal-card">
          <div class="modal-title">{{ modal.title }}</div>
          <div v-if="modal.mode === 'prompt'">
            <input
              ref="modalInput"
              v-model="modal.value"
              class="modal-input"
              @keydown.enter="modalOk"
              @keydown.esc="modalCancel"
            />
            <div v-if="modal.hint" class="modal-hint">{{ modal.hint }}</div>
          </div>
          <div v-else class="modal-text">{{ modal.text }}</div>
          <div class="modal-actions">
            <button class="btn" @click="modalCancel">取消</button>
            <button class="btn" :class="{ danger: modal.danger }" @click="modalOk">{{ modal.okText }}</button>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style>
/* ========== 全局主题变量 & 重置 ========== */
:root {
  --bg: #1e1e2e;
  --bg-deep: #11111b;
  --bg-panel: #181825;
  --surface: #313244;
  --surface-2: #45475a;
  --border: #313244;
  --border-2: #45475a;
  --text: #cdd6f4;
  --text-dim: #6c7086;
  --text-faint: #585b70;
  --accent: #89b4fa;
  --accent-soft: rgba(137, 180, 250, 0.15);
  --danger: #f38ba8;
  --ok: #a6e3a1;
  --warn: #f9e2af;
  --radius: 6px;
  --radius-sm: 4px;
  --gap: 8px;
  --fs-base: 13px;
  --fs-sm: 12px;
  --fs-xs: 11px;
  --shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  --transition: 0.2s ease;
}
html, body, #app {
  height: 100%;
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: var(--fs-base) / 1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
#app { overflow: hidden; }
* { box-sizing: border-box; }
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--surface); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--surface-2); }
</style>

<style scoped>
/* ========== 布局 ========== */
.layout {
  display: flex;
  height: 100%;
  overflow: hidden;
  position: relative;
}

/* ========== 侧边栏 ========== */
.sidebar {
  width: 240px;
  min-width: 240px;
  background: var(--bg-deep);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  user-select: none;
  transition: box-shadow var(--transition);
  z-index: 20;
}

/* 侧边栏头部 */
.sidebar-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 12px 8px;
  flex-wrap: wrap;
}
.sidebar-title {
  font-weight: 700;
  font-size: 14px;
  margin-right: auto;
  letter-spacing: 0.3px;
}

/* 搜索框 */
.sidebar-search {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 12px 8px;
}
.search-input {
  flex: 1;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: var(--fs-sm);
  padding: 4px 8px;
  outline: none;
  transition: border-color var(--transition);
}
.search-input:focus { border-color: var(--accent); }
.search-input::placeholder { color: var(--text-faint); }
.search-clear { opacity: 0.6; }
.search-clear:hover { opacity: 1; color: var(--text); }

/* 按钮 */
.btn {
  background: var(--surface);
  color: var(--text);
  border: none;
  border-radius: var(--radius-sm);
  padding: 3px 8px;
  cursor: pointer;
  font-size: var(--fs-sm);
  white-space: nowrap;
  transition: background var(--transition);
}
.btn:hover { background: var(--surface-2); }
.btn-sm { padding: 2px 6px; font-size: var(--fs-xs); }
.btn-accent { background: var(--surface-2); }
.btn-accent:hover { background: var(--border-2); }
.btn.danger { background: rgba(243, 139, 168, 0.18); color: var(--danger); }
.btn.danger:hover { background: rgba(243, 139, 168, 0.3); }
.btn-icon {
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: var(--fs-xs);
  padding: 0 3px;
  opacity: 0.5;
  line-height: 1;
  transition: opacity var(--transition), color var(--transition);
}
.btn-icon:hover { opacity: 1; color: var(--danger); }
.btn-addwin {
  width: calc(100% - 12px);
  margin: 4px 6px;
  text-align: center;
  background: var(--surface);
  border: 1px dashed var(--border-2);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  transition: background var(--transition), color var(--transition);
}
.btn-addwin:hover { background: var(--surface-2); color: var(--text); }

/* 会话列表 */
.session-list { flex: 1; overflow-y: auto; padding: 0 0 8px; }
.session-item { }
.session-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  margin: 0 4px;
}
.session-head:hover { background: var(--surface); }
.arrow {
  font-size: 8px;
  transition: transform 0.15s;
  display: inline-block;
  width: 12px;
  color: var(--text-dim);
}
.arrow.open { transform: rotate(90deg); color: var(--accent); }
.sname { flex: 1; font-weight: 600; font-size: var(--fs-sm); }
.win-count { color: var(--text-dim); font-size: var(--fs-xs); margin-right: 4px; }

/* 窗口列表 */
.window-list { }
.window-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px 4px 28px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  margin: 1px 4px;
  position: relative;
  transition: background var(--transition);
}
.window-item:hover { background: var(--surface); }
.window-item.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.window-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 4px;
  bottom: 4px;
  width: 3px;
  background: var(--accent);
  border-radius: 0 2px 2px 0;
}
.wid { color: var(--text-dim); font-size: var(--fs-xs); min-width: 18px; font-variant-numeric: tabular-nums; }
.wid.active { color: var(--accent); }
.wname { flex: 1; }
.empty-hint { padding: 24px 16px; text-align: center; color: var(--text-dim); font-size: var(--fs-sm); }

/* ========== Tab 栏 ========== */
.tab-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px 0;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  overflow-y: hidden;
  flex-shrink: 0;
  scrollbar-width: thin;
}
.tab-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 12px;
  background: var(--bg-deep);
  border: 1px solid var(--border);
  border-bottom: none;
  border-radius: var(--radius) var(--radius) 0 0;
  cursor: pointer;
  user-select: none;
  max-width: 200px;
  white-space: nowrap;
  transition: background var(--transition), border-color var(--transition);
  flex-shrink: 0;
}
.tab-item:hover { background: var(--surface); }
.tab-item.active {
  background: var(--surface);
  border-color: var(--border-2);
}
.tab-title {
  font-size: var(--fs-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: default;
}
.tab-close {
  opacity: 0.4;
  transition: opacity var(--transition), color var(--transition);
}
.tab-close:hover { opacity: 1; color: var(--danger); }
.tab-spacer { flex: 1; }

/* ========== 终端区域 ========== */
.grid-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.tab-body {
  flex: 1;
  display: flex;
  min-height: 0;
  min-width: 0;
}
.slot {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
.slot-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: var(--bg-panel);
  color: var(--text);
  font-size: var(--fs-sm);
  font-family: Menlo, Monaco, monospace;
  border-bottom: 1px solid var(--border);
  user-select: none;
  min-height: 28px;
  flex-shrink: 0;
}
.slot-title { flex: 1; }
.slot-title.dim { color: var(--text-dim); font-style: italic; }
.slot-status {
  font-size: var(--fs-xs);
  color: var(--text-dim);
  position: relative;
  padding-left: 12px;
}
.slot-status::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--danger);
}
.slot-status.on::before { background: var(--ok); }
.slot-status.on { color: var(--ok); }

/* 终端主体 */
.slot-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  position: relative;
  background: var(--bg-deep);
}
.xterm-wrap {
  position: absolute;
  inset: 4px 6px 6px;
  background: #000;
  border-radius: var(--radius-sm);
  overflow: hidden;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);
}

/* 空白 Tab 引导 */
.slot-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-faint);
  pointer-events: none;
}
.slot-empty .empty-icon {
  font-size: 36px;
  opacity: 0.3;
}
.slot-empty .empty-label {
  font-size: 14px;
  opacity: 0.5;
}

/* ========== Toast 提示 ========== */
.toasts {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.toast {
  padding: 8px 16px;
  border-radius: var(--radius);
  background: var(--bg-deep);
  border: 1px solid var(--border);
  color: var(--text);
  font-size: var(--fs-sm);
  box-shadow: var(--shadow);
  pointer-events: auto;
  animation: toast-in 0.25s ease;
  max-width: 360px;
}
.toast.error { border-color: var(--danger); color: var(--danger); }
.toast.ok { border-color: var(--ok); color: var(--ok); }
.toast.info { border-color: var(--accent); color: var(--text); }

@keyframes toast-in {
  from { opacity: 0; transform: translateX(20px); }
  to { opacity: 1; transform: translateX(0); }
}

/* ========== 模态弹窗 ========== */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
  animation: overlay-in 0.15s ease;
}
.modal-card {
  background: var(--bg-deep);
  border: 1px solid var(--border-2);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 20px 24px;
  min-width: 320px;
  max-width: 440px;
  animation: modal-in 0.2s ease;
}
.modal-title {
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 16px;
}
.modal-input {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: var(--fs-base);
  padding: 8px 10px;
  outline: none;
  transition: border-color var(--transition);
}
.modal-input:focus { border-color: var(--accent); }
.modal-hint {
  margin-top: 6px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.modal-text {
  font-size: var(--fs-base);
  margin-bottom: 4px;
  line-height: 1.6;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}

@keyframes overlay-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes modal-in {
  from { opacity: 0; transform: scale(0.95) translateY(-8px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
</style>