export type ManagedWorkspace = {
  id: string;
  name: string;
  path: string;
  parent: string;
  status: 'ready' | 'outside' | 'missing' | 'archived';
  usage: { bindings: number; references: number };
  archivedAt: string | null;
};
export type ManagerReview = {
  token: string;
  title: string;
  target: string;
  path: string;
  operation: string;
  description: string;
  impact: {
    bindings?: number;
    references?: number;
    affectedWorkspaces?: { id: string; name: string }[];
  };
};
export type ManagerData = {
  workspaces: ManagedWorkspace[];
  currentWorkspace: { id: string; name: string; path: string } | null;
  selectionLocked?: boolean;
  allowedDirectories: string[];
  policyError: string | null;
  broker?: { activeWorkers: number };
  review?: ManagerReview;
};
export type ManagerAction = {
  action: 'switch' | 'review_workspace' | 'review_root' | 'apply_review';
  workspace_id?: string;
  path?: string;
  operation?: string;
  review_token?: string;
};
const byId = (id: string) => document.getElementById(id)!;
function label(text: string, className: string): HTMLElement {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}
export function createWorkspaceManager(
  execute: (args: ManagerAction) => Promise<void>,
  isBusy: () => boolean,
) {
  let data: ManagerData | null = null;
  let selectedId: string | null = null;
  let filter = 'attention';
  let review: ManagerReview | null = null;

  function updateCurrent() {
    const current = data?.currentWorkspace;
    const locked = data?.selectionLocked === true || Boolean(current);
    byId('current-name').textContent =
      current?.name ||
      (locked ? 'Previously selected workspace unavailable' : 'No workspace selected');
    byId('current-path').textContent =
      current?.path ||
      (locked
        ? 'Your chat is still locked. Start a new chat to select another project.'
        : 'Choose one workspace to begin this chat.');
    byId('current-status').textContent = locked ? '🔒 Locked for this chat' : 'Select once';
    byId('workspace-lock-hint').textContent = locked
      ? 'Locked to this workspace. Open a new ChatGPT chat to work on another project.'
      : 'Your first selection will be locked to this chat. You cannot change it later.';
    byId('workspace-picker').classList.toggle('hidden', locked);
    byId('project-creation-actions').classList.toggle('hidden', locked);
    if (locked) {
      byId('create-form').classList.add('hidden');
      byId('add-form').classList.add('hidden');
    }
  }

  function renderPicker() {
    const container = byId('project-results');
    container.replaceChildren();
    if (!data) return;
    const locked = data.selectionLocked === true || Boolean(data.currentWorkspace);
    (byId('project-search') as HTMLInputElement).disabled = locked;
    if (locked) {
      selectedId = null;
      (byId('switch-submit') as HTMLButtonElement).disabled = true;
      return;
    }
    const query = (byId('project-search') as HTMLInputElement).value.trim().toLowerCase();
    const candidates = data.workspaces.filter(
      (w) =>
        w.status === 'ready' &&
        w.id !== data?.currentWorkspace?.id &&
        (w.name.toLowerCase().includes(query) || w.path.toLowerCase().includes(query)),
    );
    for (const w of candidates.slice(0, query ? 12 : 6)) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'workspace-choice' + (w.id === selectedId ? ' chosen' : '');
      item.disabled = isBusy();
      const info = document.createElement('div');
      info.append(label(w.name, 'choice-name'), label(w.parent + ' / ' + w.name, 'choice-path'));
      item.append(info, label(w.id === selectedId ? '✓' : '→', 'choice-arrow'));
      item.addEventListener('click', () => {
        selectedId = w.id;
        renderPicker();
      });
      container.append(item);
    }
    if (!candidates.length) container.append(label('No matching accessible projects.', 'meta'));
    (byId('switch-submit') as HTMLButtonElement).disabled =
      isBusy() ||
      !selectedId ||
      !data.workspaces.some((w) => w.id === selectedId && w.status === 'ready');
    const selected = data.workspaces.find((w) => w.id === selectedId);
    byId('selected-location').textContent = selected
      ? selected.path
      : 'Choose a project above. Your selection will be permanent in this chat.';
  }
  function renderRegistry() {
    const container = byId('registry-list');
    container.replaceChildren();
    if (!data) return;
    const ws = data.workspaces.filter((w) =>
      filter === 'all'
        ? true
        : filter === 'attention'
          ? w.status === 'outside' || w.status === 'missing'
          : w.status === filter,
    );
    byId('registry-count').textContent = String(ws.length) + ' projects';
    for (const w of ws) {
      const row = document.createElement('div');
      row.className = 'registry-row';
      const head = document.createElement('div');
      head.className = 'registry-head';
      const statusNames = {
        ready: 'Ready',
        outside: 'Outside allowed roots',
        missing: 'Folder missing',
        archived: 'Archived',
      };
      const state = label(statusNames[w.status], 'status-tag');
      state.dataset.status = w.status;
      head.append(label(w.name, 'choice-name'), state);
      row.append(head, label(w.path, 'choice-path'));
      const controls = document.createElement('div');
      controls.className = 'registry-controls';
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Action for ' + w.name);
      const actions =
        w.status === 'archived'
          ? [
              ['restore', 'Restore'],
              ['unregister', 'Unregister (registry only)'],
              ['relink', 'Relink'],
            ]
          : [
              ['archive', 'Archive'],
              ['relink', 'Relink'],
            ];
      for (const [value, title] of actions) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = title;
        select.append(option);
      }
      const newPath = document.createElement('input');
      newPath.placeholder = 'New existing absolute folder path';
      newPath.setAttribute('aria-label', 'New path for ' + w.name);
      newPath.className = 'hidden';
      const used = Boolean(w.usage.bindings || w.usage.references);
      select.addEventListener('change', () => {
        newPath.classList.toggle('hidden', select.value !== 'relink');
        reviewButton.disabled = isBusy() || (used && select.value !== 'restore');
      });
      const reviewButton = document.createElement('button');
      reviewButton.className = 'subtle';
      reviewButton.type = 'button';
      reviewButton.textContent = 'Review';
      reviewButton.disabled = isBusy() || (used && select.value !== 'restore');
      reviewButton.addEventListener(
        'click',
        () =>
          void execute({
            action: 'review_workspace',
            workspace_id: w.id,
            operation: select.value,
            ...(select.value === 'relink' ? { path: newPath.value.trim() } : {}),
          }),
      );
      controls.append(select, reviewButton, newPath);
      row.append(controls);
      if (w.usage.bindings || w.usage.references)
        row.append(
          label(
            'In use: ' +
              w.usage.bindings +
              ' bindings, ' +
              w.usage.references +
              ' references. Unbind and remove references before managing.',
            'meta',
          ),
        );
      container.append(row);
    }
    if (!ws.length) container.append(label('No registered workspaces in this category.', 'meta'));
  }
  function renderRoots() {
    const container = byId('allowed-list');
    container.replaceChildren();
    if (!data) return;
    byId('allowed-count').textContent = String(data.allowedDirectories.length) + ' roots';
    byId('policy-error').textContent = data.policyError || '';
    byId('allowed-warning').textContent = data.broker?.activeWorkers
      ? 'Currently ' +
        data.broker.activeWorkers +
        ' active worker(s). Finish work and let workers retire before applying a permission change.'
      : 'No active workers detected. Changes still require review and confirmation.';
    for (const path of data.allowedDirectories) {
      const row = document.createElement('div');
      row.className = 'root-row';
      row.append(label(path, 'choice-path'));
      const reviewButton = document.createElement('button');
      reviewButton.type = 'button';
      reviewButton.className = 'subtle';
      reviewButton.textContent = 'Review removal';
      reviewButton.disabled = isBusy();
      reviewButton.addEventListener(
        'click',
        () =>
          void execute({
            action: 'review_root',
            operation: 'root_remove',
            path,
          }),
      );
      row.append(reviewButton);
      container.append(row);
    }
  }

  function renderReview() {
    const panel = byId('review-panel');
    panel.classList.toggle('hidden', !review);
    if (!review) return;
    byId('review-title').textContent = review.title;
    byId('review-path').textContent = review.path;
    const impacted = review.impact?.affectedWorkspaces?.length ?? 0;
    const usage =
      review.impact?.bindings || review.impact?.references
        ? ' In use: ' +
          review.impact.bindings +
          ' bindings and ' +
          review.impact.references +
          ' references.'
        : '';
    const policyBusy = review.operation.startsWith('root_') && Boolean(data?.broker?.activeWorkers);
    byId('review-detail').textContent =
      review.description +
      (impacted ? ' Workspaces affected: ' + impacted + '.' : '') +
      usage +
      (policyBusy ? ' Stop active workers, refresh, and preview again before confirming.' : '');
    (byId('review-confirm') as HTMLButtonElement).disabled = isBusy() || policyBusy;
  }

  function render(next: ManagerData) {
    data = next;
    review = next.review ?? null;
    if (selectedId && !next.workspaces.some((w) => w.id === selectedId && w.status === 'ready'))
      selectedId = null;
    if (next.selectionLocked || selectedId === next.currentWorkspace?.id) selectedId = null;
    updateCurrent();
    renderPicker();
    renderRegistry();
    renderRoots();
    renderReview();
  }
  byId('project-search').addEventListener('input', renderPicker);
  byId('switch-submit').addEventListener('click', () => {
    if (selectedId) void execute({ action: 'switch', workspace_id: selectedId });
  });
  byId('registry-filter').addEventListener('change', () => {
    filter = (byId('registry-filter') as HTMLSelectElement).value;
    renderRegistry();
  });
  byId('allowed-add').addEventListener('click', () => {
    const path = (byId('allowed-input') as HTMLInputElement).value.trim();
    if (path) void execute({ action: 'review_root', operation: 'root_add', path });
  });
  byId('review-cancel').addEventListener('click', () => {
    review = null;
    renderReview();
  });
  byId('review-confirm').addEventListener('click', () => {
    if (review) void execute({ action: 'apply_review', review_token: review.token });
  });
  return { render };
}
