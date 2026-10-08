import {
  App,
  PostMessageTransport,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
} from '@modelcontextprotocol/ext-apps';

type Workspace = { id: string; name: string };
type Skill = { id: string; name: string; policy: string };
type Session = {
  state: string;
  workspaceName: string;
  ready: boolean;
  active: number;
  queued: boolean;
};
type Snapshot = {
  kind: 'dwb-companion-v1';
  updatedAt: string;
  version: string;
  broker: {
    workerCap: number;
    activeWorkers: number;
    sessions: number;
    queueDepth: number;
    inFlightCalls: number;
    persistenceHealthy: boolean;
  };
  currentWorkspace: Workspace | null;
  workspaces: Workspace[];
  skills: Skill[];
  sessions: Session[];
};

const get = (id: string) => document.getElementById(id)!;
const setText = (id: string, value: string) => {
  get(id).textContent = value;
};
const feedback = (message: string) => setText('feedback', message);
const refresh = get('refresh') as HTMLButtonElement;
const ask = get('ask') as HTMLButtonElement;
const manual = get('manual') as HTMLTextAreaElement;
let snapshot: Snapshot | null = null;
let selectedId = '';
let app: App | null = null;
let connected = false;

function snapshotFromResult(result: unknown): Snapshot | null {
  if (!result || typeof result !== 'object') return null;
  const value = result as {
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  let raw: unknown = value.structuredContent;
  if (!raw && Array.isArray(value.content)) {
    const text = value.content.find((c) => c.type === 'text')?.text;
    if (text) {
      try {
        raw = JSON.parse(text);
      } catch {
        return null;
      }
    }
  }
  if (!raw || typeof raw !== 'object' || (raw as { kind?: string }).kind !== 'dwb-companion-v1')
    return null;
  return raw as Snapshot;
}

function renderList(
  targetId: string,
  entries: Array<{ name: string; meta: string; active?: boolean }>,
) {
  const el = get(targetId);
  el.replaceChildren();
  if (!entries.length) {
    const span = document.createElement('span');
    span.className = 'small';
    span.textContent = 'None';
    el.append(span);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'mini-row';
    const title = document.createElement('span');
    title.className = 'name';
    title.textContent = entry.name;
    const meta = document.createElement('span');
    meta.className = 'pill' + (entry.active ? ' active' : '');
    meta.textContent = entry.meta;
    row.append(title, meta);
    el.append(row);
  }
}

function render() {
  if (!snapshot) return;
  const s = snapshot;
  setText('version', s.version);
  setText('workers', String(s.broker.activeWorkers) + ' / ' + String(s.broker.workerCap));
  setText('sessions', String(s.broker.sessions));
  setText('queue', String(s.broker.queueDepth));
  setText('projects-count', String(s.workspaces.length) + ' registered');
  setText('skills-count', String(s.skills.length) + ' installed');
  setText('session-count', String(s.sessions.length) + ' shown');
  setText('updated', 'Updated ' + new Date(s.updatedAt).toLocaleTimeString());
  const list = get('project-list');
  list.replaceChildren();
  const isKnown = s.workspaces.some((w) => w.id === selectedId);
  if (!isKnown) selectedId = s.currentWorkspace?.id ?? s.workspaces[0]?.id ?? '';
  if (!s.workspaces.length) {
    const hint = document.createElement('span');
    hint.className = 'small';
    hint.textContent = 'No registered workspace. Bind a project folder in ChatGPT first.';
    list.append(hint);
  }
  for (const workspace of s.workspaces) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'project';
    row.setAttribute('aria-pressed', String(selectedId === workspace.id));
    const name = document.createElement('span');
    name.className = 'project-name';
    name.textContent = workspace.name;
    const label = document.createElement('span');
    label.className = 'pill' + (workspace.id === s.currentWorkspace?.id ? ' active' : '');
    label.textContent = workspace.id === s.currentWorkspace?.id ? 'Bound' : 'Select';
    row.append(name, label);
    row.addEventListener('click', () => {
      selectedId = workspace.id;
      feedback('');
      manual.style.display = 'none';
      render();
    });
    list.append(row);
  }
  ask.disabled = !connected || !selectedId;
  renderList(
    'skills-list',
    s.skills.map((item) => ({ name: item.name, meta: item.policy.toUpperCase() })),
  );
  renderList(
    'session-list',
    s.sessions.map((item) => ({
      name: item.workspaceName,
      meta: item.queued ? 'Queued' : item.ready ? 'Running' : item.state,
      active: item.ready,
    })),
  );
}

async function load() {
  if (!app || !connected) return;
  refresh.disabled = true;
  feedback('Reading DWB broker…');
  try {
    const result = await app.callServerTool({ name: 'dwb_companion_snapshot', arguments: {} });
    const next = snapshotFromResult(result);
    if (!next) throw new Error('Invalid response from DWB broker');
    snapshot = next;
    feedback('');
    render();
  } catch (error) {
    feedback('Cannot refresh: ' + String(error));
  } finally {
    refresh.disabled = false;
  }
}

async function askChatGPT() {
  if (!app || !selectedId || !snapshot) return;
  const target = snapshot.workspaces.find((w) => w.id === selectedId);
  if (!target) return;
  const prompt =
    'ใช้ DWB MCP Studio ผูก Workspace โดยเรียก workspace action=bind กับ workspace_id "' +
    target.id +
    '" (ชื่อ ' +
    target.name +
    ') แล้วตรวจสอบ README.md และ package.json ถ้ามี สรุปโครงสร้างโปรเจกต์ สิ่งที่ทำได้ และรายการงานต่อไปอย่างกระชับ โดยอ่านข้อมูลเท่านั้น ไม่แก้ไขไฟล์หรือรันคำสั่งที่เปลี่ยนระบบ';
  ask.disabled = true;
  feedback('Sending your request to ChatGPT…');
  try {
    const response = await app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    });
    if (response?.isError) throw new Error('Host declined the message');
    feedback('Sent to ChatGPT — continue in the conversation.');
  } catch {
    feedback('This ChatGPT host cannot send from the panel. Copy the prompt below into chat.');
    manual.value = prompt;
    manual.style.display = 'block';
    manual.focus();
    manual.select();
  } finally {
    ask.disabled = false;
  }
}

refresh.addEventListener('click', () => void load());
ask.addEventListener('click', () => void askChatGPT());

const client = new App({ name: 'DWB Companion', version: '0.1.0' });
app = client;
client.ontoolresult = (result) => {
  const next = snapshotFromResult(result);
  if (next) {
    snapshot = next;
    feedback('');
    render();
  }
};
client.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  if (ctx.safeAreaInsets) {
    const v = ctx.safeAreaInsets;
    document.body.style.padding =
      v.top + 'px ' + v.right + 'px ' + v.bottom + 'px ' + v.left + 'px';
  }
};
client.onteardown = async () => ({});
void (async () => {
  try {
    await client.connect(new PostMessageTransport(window.parent, window.parent));
    connected = true;
    refresh.disabled = false;
    await load();
  } catch (error) {
    feedback('MCP Apps host connection unavailable: ' + String(error));
  }
})();
