const $ = (id) => document.getElementById(id);
const token = location.hash.slice(1) || sessionStorage.getItem('dwb-token');
if (token) sessionStorage.setItem('dwb-token', token);
history.replaceState(null, '', '/');
let initialized = false,
  acting = false;
let syncPreferences = true;
const preferenceKeys = ['startAtLogin', 'connectOnStartup', 'closeToMenuBar', 'minimizeToMenuBar'];
function native(action) {
  window.webkit?.messageHandlers?.dwb?.postMessage(action);
}
async function api(path, body) {
  const response = await fetch('/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'ดำเนินการไม่สำเร็จ');
  return result;
}
async function refresh() {
  try {
    const state = await api('status');
    $('connection').textContent = {
      ready: '● Ready',
      starting: '◌ กำลังเชื่อมต่อ',
      stopped: '○ ยังไม่เชื่อมต่อ',
    }[state.tunnel];
    $('connection').className = 'connection ' + state.tunnel;
    $('broker').textContent = 'Broker: ' + state.runtime.state;
    $('machine').textContent = `macOS · ${state.arch} · Node ${state.node}`;
    if (!initialized) {
      $('workspace').value = state.workspace;
      $('worker-cap').value = state.workerCap;
      $('tunnel-id').value = state.tunnelId;
      $('remember').checked = state.rememberKey;
      initialized = true;
    }
    if (syncPreferences) {
      for (const key of preferenceKeys) $(key).checked = state.preferences[key];
      syncPreferences = false;
    }
    const broker = state.runtime.broker || {};
    $('metrics').replaceChildren();
    for (const [label, value] of [
      ['Workers', `${broker.activeWorkers || 0} / ${state.workerCap}`],
      ['รอคิว', broker.queueDepth || 0],
      ['กำลังทำงาน', broker.inFlightCalls || 0],
    ]) {
      const metric = document.createElement('div');
      metric.textContent = `${label} · ${value}`;
      $('metrics').append(metric);
    }
    $('events').replaceChildren();
    for (const event of state.events || []) {
      const row = document.createElement('li');
      row.textContent = [event.time, event.event, event.detail].filter(Boolean).join(' · ');
      $('events').append(row);
    }
    if (!$('events').children.length) {
      const row = document.createElement('li');
      row.textContent = 'ยังไม่มีเหตุการณ์';
      $('events').append(row);
    }
    native({ action: 'preferences', ...state.preferences });
    $('start').disabled = acting || state.busy || !state.configured || state.tunnel !== 'stopped';
    $('stop').disabled =
      acting || state.busy || (state.tunnel === 'stopped' && state.runtime.state === 'stopped');
    $('setup').disabled = acting || state.busy || state.tunnel !== 'stopped';
    $('sessions').replaceChildren();
    for (const session of state.runtime.sessions || []) {
      const row = document.createElement('tr');
      for (const value of [
        session.sessionId,
        session.workspaceName || session.workingDirectory,
        session.state,
        session.workerPid || '—',
      ]) {
        const cell = document.createElement('td');
        cell.textContent = value || '—';
        row.append(cell);
      }
      $('sessions').append(row);
    }
    if (!$('sessions').children.length) {
      const row = document.createElement('tr'),
        cell = document.createElement('td');
      cell.colSpan = 4;
      cell.textContent = 'ยังไม่มี session — เริ่มจากแชทที่เชื่อมกับ MCP นี้';
      row.append(cell);
      $('sessions').append(row);
    }
    if (state.progress || state.error || state.runtimeMismatch)
      $('notice').textContent =
        state.progress || state.error || 'Broker อีกชุดกำลังทำงาน กรุณาหยุดจากแอปเดิมก่อน';
  } catch (error) {
    $('notice').textContent = error.message;
  }
}
async function action(name, values = {}) {
  if (acting) return;
  acting = true;
  $('notice').textContent = 'กำลังดำเนินการ…';
  try {
    await api(name, values);
    if (['preferences', 'start', 'forget'].includes(name)) syncPreferences = true;
    $('notice').textContent = 'เรียบร้อย';
  } catch (error) {
    $('notice').textContent = error.message;
  } finally {
    acting = false;
    await refresh();
  }
}
$('tunnel-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const key = $('api-key').value;
  $('api-key').value = '';
  void action('start', {
    tunnelId: $('tunnel-id').value.trim(),
    apiKey: key,
    rememberKey: $('remember').checked,
  });
});
$('setup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void action('setup', {
    workspace: $('workspace').value,
    workerCap: Number($('worker-cap').value),
  });
});
$('preferences-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void action(
    'preferences',
    Object.fromEntries(preferenceKeys.map((key) => [key, $(key).checked])),
  );
});
$('stop').onclick = () => action('stop');
$('forget').onclick = async () => {
  await action('forget');
  initialized = false;
  await refresh();
};
$('choose').onclick = () => native({ action: 'chooseFolder' });
$('quit').onclick = () => native({ action: 'quit' });
window.dwbChooseFolder = (path) => {
  $('workspace').value = path;
};
void refresh();
setInterval(() => void refresh(), 3000);
