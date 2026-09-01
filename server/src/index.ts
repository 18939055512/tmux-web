import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import { execFile } from 'child_process';

// ========== 配置 ==========
const PORT = Number(process.env.PORT || 38090);

// ========== tmux 命令封装（统一数组参数，防注入）==========
function tmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || 'tmux error').trim()));
      else resolve(stdout);
    });
  });
}

// ========== Session / Window / Pane 查询 ==========
interface Pane { id: number }
interface Win { id: number; name: string; panes: Pane[] }
interface Session { name: string; windows: Win[] }

// 内部槽位 session 前缀（过滤掉，不显示在 API 中）
const SLOT_SESSION_PREFIX = '__tmuxui_';

async function listSessions(): Promise<Session[]> {
  const out = await tmux(['list-sessions', '-F', '#{session_name}']).catch(() => '');
  const names = out.split('\n').map((l) => l.trim()).filter(Boolean).filter((n) => !n.startsWith(SLOT_SESSION_PREFIX));
  return Promise.all(names.map(async (name) => {
    const wins = await tmux(['list-windows', '-t', name, '-F', '#{window_index}\t#{window_name}'])
      .catch(() => '');
    const windows: Win[] = await Promise.all(
      wins.split('\n').map((l) => l.trim()).filter(Boolean).map(async (line) => {
        const [idx, wname] = line.split('\t');
        const id = Number(idx);
        const panes = await tmux(['list-panes', '-t', `${name}:${id}`, '-F', '#{pane_index}'])
          .then((p) => p.split('\n').map((x) => x.trim()).filter(Boolean).map((x) => ({ id: Number(x) })))
          .catch(() => []);
        return { id, name: wname, panes };
      }),
    );
    return { name, windows };
  }));
}

// ========== Express 服务 ==========
const app = express();
const server = createServer(app);
app.use(express.json());
app.get('/health', (_req, res) => res.json({ ok: true }));

// GET /api/sessions —— session + window + pane 树
app.get('/api/sessions', async (_req, res) => {
  try {
    res.json(await listSessions());
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// POST /api/sessions —— 新建 session（后台 detached，不影响页面）
app.post('/api/sessions', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!/^[\w.-]{1,63}$/.test(name)) {
    return res.status(400).json({ error: 'invalid session name' });
  }
  try {
    // -d detached；-s name；新 session 默认带编号 0 的 window
    await tmux(['new-session', '-d', '-s', name]);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});

// DELETE /api/sessions/:name —— 删除 session
app.delete('/api/sessions/:name', async (req, res) => {
  try {
    await tmux(['kill-session', '-t', req.params.name]);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});

// POST /api/sessions/:session/windows —— 新建 window（可选命名）
app.post('/api/sessions/:session/windows', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  try {
    if (name) {
      await tmux(['new-window', '-t', req.params.session, '-n', name]);
    } else {
      await tmux(['new-window', '-t', req.params.session]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});

// DELETE /api/sessions/:session/windows/:window —— 删除 window
app.delete('/api/sessions/:session/windows/:window', async (req, res) => {
  const target = `${req.params.session}:${req.params.window}`;
  try {
    await tmux(['kill-window', '-t', target]);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});

// POST /api/sessions/:session/windows/:window/rename —— 重命名 window
app.post('/api/sessions/:session/windows/:window/rename', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'empty name' });
  try {
    await tmux(['rename-window', '-t', `${req.params.session}:${req.params.window}`, name]);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});

// ========== 槽位 session 管理（link-window 方案）==========
// tmux 的 session 所有客户端共享同一个 current-window：
// 多个终端各自 attach 同一 session 的不同 window 时，后 attach 的会移动
// session 的 current-window，导致所有终端显示同一个窗口。
// 解法：每个槽位建一个独立 session（__tmuxui_<slotId>），把目标 window
// link 进去，再 attach 到该槽位 session。不同槽位互不影响。
function slotSessionName(slotId: number | string): string {
  return `${SLOT_SESSION_PREFIX}${slotId}`;
}

async function linkWindow(slotId: number | string, session: string, win: string, pane?: string): Promise<void> {
  const name = slotSessionName(slotId);
  // 上次残留（如浏览器强退）先清掉
  await tmux(['kill-session', '-t', name]).catch(() => {});
  await tmux(['new-session', '-d', '-s', name]);
  await tmux(['set', '-t', name, 'mouse', 'on']);
  await tmux(['link-window', '-s', `${session}:${win}`, '-t', `${name}:0`, '-k']);
  if (pane) {
    await tmux(['select-pane', '-t', `${name}:0.${pane}`]).catch(() => {});
  }
}

async function unlinkWindow(slotId: number | string): Promise<void> {
  const name = slotSessionName(slotId);
  await tmux(['unlink-window', '-t', `${name}:0`]).catch(() => {});
  await tmux(['kill-session', '-t', name]).catch(() => {});
}

// ========== WebSocket：每个终端 = 一个 node-pty 客户端 attach 到指定 target ==========
// 浏览器先发 { type:'open', target:'cb:2' }，服务端再 spawn tmux attach -t <target>
const wss = new WebSocketServer({ server });

const TARGET_RE = /^[A-Za-z0-9_.-]+:\d+(\.\d+)?$/;

wss.on('connection', (ws: WebSocket) => {
  let term: pty.IPty | null = null;
  let target: string | null = null;
  let activeSlotId: number | null = null;

  ws.on('message', (raw: Buffer) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // open：创建 PTY 并 attach 到目标 window/pane
    if (msg.type === 'open' && !term) {
      target = String(msg.target || '');
      const slotId = Number(msg.slotId) || 0;
      if (!TARGET_RE.test(target)) {
        ws.send(JSON.stringify({ type: 'error', message: `invalid target: ${target}` }));
        return;
      }
      // 解析 session:window[.pane]
      const [sess, rest] = target.split(':');
      const [win, pane] = (rest || '').split('.');

      // 先创建槽位 session 并 link 目标 window，再 spawn pty attach
      activeSlotId = slotId;
      (async () => {
        try {
          await linkWindow(slotId, sess, win, pane || undefined);
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: `link failed: ${(err as Error).message}` }));
          activeSlotId = null;
          return;
        }
        // 链接期间 WS 已断开的情况由 close 处理器统一清理
        if (ws.readyState !== WebSocket.OPEN) return;

        const slotSess = slotSessionName(slotId);

        term = pty.spawn('tmux', ['attach', '-t', slotSess], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: process.env.HOME,
          env: { ...process.env as Record<string, string>, TERM: 'xterm-256color' },
        });

        term.onData((data: string) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'output', data }));
          }
        });

        // tmux attach 失败（如 window 已被删）时通知前端
        term.onExit(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'exit', target }));
            ws.send(JSON.stringify({ type: 'status', connected: false }));
            ws.terminate();
          }
        });
      })();
    } else if (term) {
      if (msg.type === 'input' && typeof msg.data === 'string') {
        term.write(msg.data);
      } else if (msg.type === 'resize') {
        term.resize(Number(msg.cols), Number(msg.rows));
      }
    }
  });

  // 浏览器断开/关闭标签 → 只杀 PTY 并清理槽位 session
  ws.on('close', () => {
    term?.kill();
    if (activeSlotId !== null) {
      unlinkWindow(activeSlotId).catch(() => {});
    }
  });
});

// ========== 启动 ==========
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  tmux-web server listening on http://0.0.0.0:${PORT}`);
});