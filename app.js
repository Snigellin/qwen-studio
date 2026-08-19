const state = { history: [], mode: 'fast', profiles: {}, supervisor: {}, recoveryJobs: [], currentView: 'chat', running: false, runtimeReady: false, activeJobId: null, activeRunCard: null, queuedDirections: [], steering: false, terminalRun: null, terminalHistory: [], terminalHistoryIndex: 0, terminalTranscript: '', project: null, threadId: null, threadProjectId: null, pendingAttachments: [] };
const t = window.qwenI18n.t;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const messages = $('#messages');
const prompt = $('#prompt');
const intro = $('#intro');
const modeKeys = { fast: 'Fast', balanced: 'Balanced', deep: 'Deep' };

function showNotice(text, kind = 'error') {
  const notice = $('#app-notice'); if (!notice) return;
  notice.hidden = false; notice.className = `app-notice ${kind}`; notice.textContent = text;
  clearTimeout(showNotice.timer); showNotice.timer = setTimeout(() => { notice.hidden = true; }, 7000);
}

function renderMode() {
  const label = t(modeKeys[state.mode] || modeKeys.fast);
  const context = Number(state.profiles?.[state.mode]?.num_ctx || ({ fast: 32768, balanced: 65536, deep: 131072 }[state.mode]));
  $('#mode').textContent = t('mode.label', { label, ctx: Math.round(context / 1024) });
  $('#settings-mode').textContent = label;
  $('#settings-profile-context').textContent = `${context.toLocaleString()} ${t('tokens')}`;
}

function showView(view) {
  state.currentView = view;
  $$('.view').forEach(item => item.classList.toggle('active', item.id === `${view}-view`));
  $$('.nav-link[data-view]').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  $('#breadcrumb').textContent = view === 'mcps' ? t('MCP connections') : view === 'workspace' ? t('Projects') : view === 'settings' ? t('Settings') : t('Chats');
  if (view === 'mcps') refreshMcps();
  if (view === 'workspace') refreshProjects();
}

function setConnected(connected, label = connected ? t('Local runtime ready') : t('Local runtime offline'), status = connected ? 'ready' : 'offline') {
  $('#connection').textContent = label;
  $('#connection-dot').className = status;
}

function updateComposerAvailability() {
  const send = $('#send');
  if (!send || state.running) return;
  send.disabled = !state.runtimeReady;
  send.title = state.runtimeReady ? '' : t('Waiting for Ollama and the selected model');
}

async function loadStatus() {
  try {
    const data = await fetch('/api/status').then(r => r.json());
    renderModel(data.model);
    $('#workspace-path').textContent = data.workspace;
    $('#terminal-path').textContent = data.workspace;
    $('#mcp-badge').textContent = data.mcpCount;
    state.project = data.project || null;
    state.profiles = data.profiles || state.profiles;
    state.supervisor = data.supervisor || state.supervisor;
    renderMode();
    renderSupervisor();
    $('#active-project-name').textContent = data.project?.name || t('No project');
    const capabilityNames = { completion: t('capabilities.completion'), vision: t('capabilities.vision'), tools: t('capabilities.tools'), thinking: t('capabilities.thinking') };
    $('#settings-capabilities').textContent = (data.runtime?.capabilities || []).map(name => capabilityNames[name] || name).join(', ') || t('Not reported');
    $('#settings-native-context').textContent = data.runtime?.nativeContext ? `${Number(data.runtime.nativeContext).toLocaleString()} ${t('tokens')}` : t('Not reported');
    state.runtimeReady = Boolean(data.runtime?.available);
    const runtimeState = data.runtime?.state || (state.runtimeReady ? 'ready' : 'offline');
    const runtimeLabel = state.runtimeReady ? t('Local runtime ready') : runtimeState === 'model-missing' ? t('Model not installed') : t('Starting Ollama…');
    $('#settings-runtime').textContent = state.runtimeReady ? t('Connected') : runtimeState === 'model-missing' ? t('Model missing') : t('Starting…');
    setConnected(state.runtimeReady, runtimeLabel, state.runtimeReady ? 'ready' : runtimeState === 'model-missing' ? 'offline' : 'starting');
    updateComposerAvailability();
    if (!state.runtimeReady && !loadStatus.runtimeNoticeShown) {
      showNotice(runtimeState === 'model-missing' ? t('notice.modelMissing', { model: data.model }) : t('notice.startingModel', { model: data.model }), 'error');
      loadStatus.runtimeNoticeShown = true;
    }
    if (state.runtimeReady) loadStatus.runtimeNoticeShown = false;
    refreshRecoveryJobs();
  } catch { state.runtimeReady = false; setConnected(false, t('Starting local backend…'), 'starting'); updateComposerAvailability(); }
}

function translateEventText(text) {
  const match = text.match(/^([\s\S]*?)(\d+(?:\.\d+)?)([\s\S]*)$/);
  if (match) {
    const templated = match[1] + '{n}' + match[3];
    const base = t(templated);
    if (base !== templated) return base.split('{n}').join(match[2]);
  }
  return t(text);
}

function renderModel(model) {
  state.model = model;
  $('#model').textContent = model;
  $('#settings-model').textContent = model;
}

async function loadModelOptions() {
  try {
    const data = await fetch('/api/models').then(r => r.json());
    state.models = Array.isArray(data.models) ? data.models : [];
    renderModelMenu();
  } catch { state.models = state.models || []; }
}

function renderModelMenu() {
  const menu = $('#model-menu'); if (!menu) return;
  menu.textContent = '';
  if (!state.models.length) {
    const item = document.createElement('li'); item.textContent = t('No models available'); item.setAttribute('disabled', ''); menu.append(item);
    return;
  }
  for (const name of state.models) {
    const item = document.createElement('li');
    item.textContent = name;
    item.classList.toggle('active', name === state.model);
    item.addEventListener('click', () => switchModel(name));
    menu.append(item);
  }
}

function toggleModelMenu(trigger) {
  const menu = $('#model-menu'); if (!menu) return;
  if (!menu.hidden) { menu.hidden = true; return; }
  loadModelOptions().then(() => {
    menu.hidden = false;
    const rect = trigger.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = (rect.bottom + 6) + 'px';
  });
}

async function switchModel(model) {
  const menu = $('#model-menu'); if (menu) menu.hidden = true;
  try {
    const response = await fetch('/api/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
    const data = await response.json();
    if (!response.ok) { showNotice(data.error || t('Could not switch model.')); return; }
    renderModel(data.model);
    await loadStatus();
  } catch { showNotice(t('Could not reach the backend to switch models.')); }
}

function ensureResourceControls() {
  const list = $('.settings-list');
  if (!list || $('#idle-only')) return;
  const group = document.createElement('div'); group.className = 'settings-group';
  const title = document.createElement('span'); title.setAttribute('data-i18n', 'Idle-only continuation'); title.textContent = t('Idle-only continuation');
  const toggleLabel = document.createElement('label'); toggleLabel.className = 'switch';
  const toggle = document.createElement('input'); toggle.id = 'idle-only'; toggle.type = 'checkbox'; toggle.addEventListener('change', async event => { try { await setSupervisorSettings({ idleOnly: event.currentTarget.checked }); } catch (error) { event.currentTarget.checked = !event.currentTarget.checked; showNotice(error.message); } });
  toggleLabel.append(toggle, document.createElement('span'));
  const hint = document.createElement('small'); hint.setAttribute('data-i18n', 'Optionally wait while configured game/heavy-process names are running.'); hint.textContent = t('Optionally wait while configured game/heavy-process names are running.');
  const processes = document.createElement('input'); processes.type = 'text'; processes.id = 'busy-processes'; processes.setAttribute('data-i18n-placeholder', 'Busy process names, comma-separated'); processes.placeholder = t('Busy process names, comma-separated'); processes.addEventListener('change', async event => { try { await setSupervisorSettings({ busyProcesses: event.currentTarget.value }); } catch (error) { showNotice(error.message); } });
  group.append(title, toggleLabel, processes, hint); list.append(group);
}

function renderSupervisor() {
  ensureResourceControls();
  const data = state.supervisor || {};
  const enabled = Boolean(data.enabled);
  const available = Boolean(data.available);
  const checkbox = $('#supervisor-enabled');
  if (checkbox) { checkbox.checked = enabled; checkbox.disabled = !available; }
  const label = $('#supervisor-toggle-label'); if (label) label.textContent = enabled ? t('Autopilot on') : t('Autopilot off');
  $('#supervisor-toggle')?.classList.toggle('active', enabled);
  const status = $('#supervisor-status');
  if (status) {
    const usage = data.effectiveMethod === 'api' ? ` · ${t('reviewsToday', { count: Number(data.usageRuns || 0) })} · ${t('estimated', { amount: Number(data.usageEstimatedUsd || 0).toFixed(2) })}` : '';
    status.textContent = available ? `${data.effectiveMethod === 'api' ? t('API-key mode (metered)') : t('Codex login')} · ${enabled ? t('enabled') : t('ready to enable')} · ${t('reviewsPerJob', { count: Number(data.maxRunsPerJob || 0) })}${usage}` : t('Codex CLI unavailable; install/login before enabling.');
  }
  const mode = $('#supervisor-mode'); if (mode && data.mode) mode.value = data.mode;
  const budget = $('#supervisor-budget'); if (budget && data.dailyBudgetUsd != null) budget.value = data.dailyBudgetUsd;
  const permission = $('#permission-profile'); if (permission && data.permissionProfile) permission.value = data.permissionProfile;
  const lowResource = $('#low-resource'); if (lowResource) lowResource.checked = Boolean(data.lowResource);
  const outputTokens = $('#output-tokens'); if (outputTokens && data.outputTokens != null) outputTokens.value = data.outputTokens;
  const idleOnly = $('#idle-only'); if (idleOnly) idleOnly.checked = Boolean(data.idleOnly);
  const busyProcesses = $('#busy-processes'); if (busyProcesses && data.busyProcesses != null) busyProcesses.value = data.busyProcesses;
}

async function setSupervisorSettings(changes) {
  const response = await fetch('/api/supervisor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || t('Supervisor settings could not be saved.'));
  state.supervisor = data.status || state.supervisor; renderSupervisor();
}

async function refreshRecoveryJobs() {
  const banner = $('#recovery-banner'); if (!banner) return;
  try {
    const data = await fetch('/api/jobs').then(response => response.json());
    const jobs = (data.items || []).filter(job => !job.dismissed && ['interrupted', 'error', 'stopped', 'blocked'].includes(job.status)).slice(0, 5);
    state.recoveryJobs = jobs; banner.hidden = !jobs.length; banner.innerHTML = '';
    if (!jobs.length) return;
    const heading = document.createElement('strong'); heading.textContent = t('Work that can be resumed'); banner.append(heading);
    const copy = document.createElement('p'); copy.textContent = t('Qwen Studio saved these jobs. Resume from the latest checkpoint and current files.'); banner.append(copy);
    jobs.forEach(job => {
      const row = document.createElement('div'); row.className = 'recovery-row';
      const text = document.createElement('span'); text.textContent = `${job.activity || t('Previous job')} · ${job.status}`;
      const actions = document.createElement('div'); actions.className = 'recovery-actions';
      const button = document.createElement('button'); button.type = 'button'; button.textContent = t('Resume'); button.addEventListener('click', () => resumeJob(job));
      const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'text-button'; dismiss.textContent = t('Dismiss'); dismiss.addEventListener('click', async () => { await fetch(`/api/jobs/${job.id}/dismiss`, { method: 'POST' }); refreshRecoveryJobs(); });
      actions.append(button, dismiss); row.append(text, actions); banner.append(row);
    });
  } catch { banner.hidden = true; }
}

async function resumeJob(job) {
  if (state.running) return;
  if (job.threadId) await openThread(job.threadId);
  state.running = true; state.activeJobId = job.id; $('#send').disabled = false; $('#send').textContent = t('Steer'); $('#mode').disabled = true; $('#model').disabled = true; $('#settings-model').disabled = true;
  const card = addRunStatus(); state.activeRunCard = card;
  try {
    const response = await fetch(`/api/jobs/${job.id}/resume`, { method: 'POST' }); const data = await response.json();
    if (!response.ok) throw new Error(data.error || t('The job could not be resumed.'));
    await watchJob(data.jobId || job.id, card); await refreshThreads();
  } catch (error) { finishRunCard(card, 'Stopped', true); addMessage('assistant', t('Resume error:') + ' ' + error.message); }
  finally { state.running = false; state.activeJobId = null; state.activeRunCard = null; $('#send').disabled = false; $('#send').textContent = t('Send'); $('#mode').disabled = false; $('#model').disabled = false; $('#settings-model').disabled = false; renderSupervisor(); refreshRecoveryJobs(); }
}

function clearThreadSurface() {
  messages.querySelectorAll('.message,.run-status').forEach(item => item.remove());
}

async function openThread(threadId) {
  if (state.running) return;
  const response = await fetch(`/api/threads/${threadId}`);
  if (!response.ok) return;
  const thread = await response.json();
  const attachmentData = await fetch(`/api/attachments?threadId=${encodeURIComponent(thread.id)}`).then(item => item.json()).catch(() => ({ items: [] }));
  const attachmentMap = new Map((attachmentData.items || []).map(item => [item.id, item]));
  state.threadId = thread.id;
  state.threadProjectId = thread.projectId || null;
  state.mode = thread.mode || state.mode;
  renderMode();
  state.history = (thread.messages || []).map(item => ({ role: item.role, content: item.content, attachments: (item.attachments || []).map(id => attachmentMap.get(id)).filter(Boolean) }));
  clearThreadSurface();
  intro.hidden = state.history.length > 0;
  state.history.forEach(item => addMessage(item.role, item.content, item.attachments));
  $$('.thread-row').forEach(item => item.classList.toggle('active', item.querySelector('.thread-item')?.dataset.threadId === thread.id));
  showView('chat');
  $('#active-project-name').textContent = thread.projectId ? (state.project?.name || t('Project chat')) : t('General chat');
  prompt.focus();
}

async function activateProject(projectId, openLatest = true) {
  if (state.running) return false;
  const response = await fetch(`/api/projects/${projectId}/activate`, { method: 'POST' });
  if (!response.ok) return false;
  state.threadId = null; state.threadProjectId = null; state.history = []; clearThreadSurface(); intro.hidden = false;
  await loadStatus();
  if (state.currentView === 'workspace') refreshProjects();
  await refreshThreads(openLatest);
  return true;
}

async function openProjectThread(projectId, threadId) {
  if (state.running) return;
  if (state.project?.id !== projectId && !(await activateProject(projectId, false))) return;
  await openThread(threadId);
  await refreshThreads();
}

async function refreshThreads(openLatest = false) {
  const list = $('#thread-list');
  try {
    const [projects, data] = await Promise.all([fetch('/api/projects').then(response => response.json()), fetch('/api/threads').then(response => response.json())]);
    list.innerHTML = '';
    const generalThreads = data.items.filter(thread => !thread.projectId);
    if (generalThreads.length) {
      const general = document.createElement('section'); general.className = 'general-thread-group';
      const heading = document.createElement('div'); heading.className = 'general-thread-heading'; heading.textContent = t('GENERAL CHATS'); general.append(heading);
      const chats = document.createElement('div'); chats.className = 'project-chat-list';
      generalThreads.forEach(thread => appendThreadRow(chats, thread));
      general.append(chats); list.append(general);
    }
    if (!projects.items.length && !generalThreads.length) { list.innerHTML = '<p>' + t('No chats yet. Start a general chat or create a project.') + '</p>'; return; }
    projects.items.forEach(project => {
      const projectThreads = data.items.filter(thread => thread.projectId === project.id);
      const group = document.createElement('section'); group.className = `project-thread-group ${project.id === projects.active ? 'active' : ''}`;
      const head = document.createElement('div'); head.className = 'project-thread-head';
      const projectButton = document.createElement('button'); projectButton.type = 'button'; projectButton.className = 'project-tree-button'; projectButton.dataset.projectId = project.id;
      const icon = document.createElement('span'); icon.dataset.icon = 'folder'; const name = document.createElement('span'); name.textContent = project.name;
      const count = document.createElement('small'); count.textContent = String(projectThreads.length); projectButton.append(icon, name, count);
      projectButton.addEventListener('click', () => activateProject(project.id, true));
      const add = document.createElement('button'); add.type = 'button'; add.className = 'project-chat-add'; add.title = t('New chat') + ' — ' + project.name; add.dataset.icon = 'plus';
      add.addEventListener('click', async () => { if (state.project?.id !== project.id && !(await activateProject(project.id, false))) return; await createChat(project.id); });
      head.append(projectButton, add); group.append(head);
      const chats = document.createElement('div'); chats.className = 'project-chat-list';
      if (!projectThreads.length) { const empty = document.createElement('p'); empty.textContent = t('No chats yet'); chats.append(empty); }
      projectThreads.forEach(thread => {
        appendThreadRow(chats, thread, project.id);
      });
      group.append(chats); list.append(group); window.renderQwenIcons(group);
    });
    const activeThreads = data.items.filter(thread => thread.projectId === projects.active);
    if (openLatest && activeThreads.length) await openThread(activeThreads[0].id);
  } catch { list.innerHTML = '<p>' + t('Projects and chats could not be loaded.') + '</p>'; }
}

function appendThreadRow(container, thread, projectId = null) {
  const row = document.createElement('div'); row.className = `thread-row ${thread.id === state.threadId ? 'active' : ''}`;
  const button = document.createElement('button'); button.type = 'button'; button.className = 'thread-item'; button.dataset.threadId = thread.id;
  const title = document.createElement('span'); title.textContent = thread.title || t('New chat');
  const meta = document.createElement('small'); meta.textContent = `${thread.messageCount || 0} ${t('messages')}`;
  button.append(title, meta); button.addEventListener('click', () => projectId ? openProjectThread(projectId, thread.id) : openThread(thread.id));
  const actions = document.createElement('div'); actions.className = 'thread-actions';
  const rename = document.createElement('button'); rename.type = 'button'; rename.title = t('Rename chat'); rename.dataset.icon = 'edit';
  rename.addEventListener('click', async () => { const next = window.prompt(t('Rename chat'), thread.title || t('New chat')); if (!next?.trim()) return; await fetch(`/api/threads/${thread.id}/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: next.trim() }) }); refreshThreads(); });
  const archive = document.createElement('button'); archive.type = 'button'; archive.title = t('Archive chat'); archive.dataset.icon = 'archive';
  archive.addEventListener('click', async () => { await fetch(`/api/threads/${thread.id}/archive`, { method: 'POST' }); if (state.threadId === thread.id) await createChat(); else refreshThreads(); });
  const pin = document.createElement('button'); pin.type = 'button'; pin.title = thread.pinned ? t('Unpin chat') : t('Pin chat'); pin.dataset.icon = 'pin';
  pin.addEventListener('click', async () => { await fetch(`/api/threads/${thread.id}/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: !thread.pinned }) }); refreshThreads(); });
  const remove = document.createElement('button'); remove.type = 'button'; remove.title = t('Delete chat'); remove.dataset.icon = 'trash';
  remove.addEventListener('click', async () => { if (!window.confirm(t('Delete this chat permanently?'))) return; await fetch(`/api/threads/${thread.id}`, { method: 'DELETE' }); if (state.threadId === thread.id) await createChat(); else refreshThreads(); });
  actions.append(rename, pin, archive, remove); row.append(button, actions); container.append(row); window.renderQwenIcons(row);
}

async function createChat(projectId = state.threadProjectId) {
  if (state.running) return null;
  const response = await fetch('/api/threads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, mode: state.mode }) });
  if (!response.ok) return null;
  const thread = await response.json();
  state.threadId = thread.id; state.threadProjectId = projectId; state.history = []; state.pendingAttachments = []; renderAttachmentTray(); clearThreadSurface(); intro.hidden = false; showView('chat');
  $('#active-project-name').textContent = projectId ? (state.project?.name || t('Project chat')) : t('General chat');
  await refreshThreads(); prompt.focus(); return thread;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentVisual(attachment, removable = false) {
  const item = document.createElement('div'); item.className = `attachment-chip ${attachment.kind}`;
  if (attachment.kind === 'image' || attachment.kind === 'video') {
    const preview = document.createElement('img'); preview.alt = ''; item.append(preview);
    fetch(`/api/attachments/${attachment.id}/content`).then(response => {
      if (!response.ok) throw new Error(t('Attachment preview unavailable.'));
      return response.blob();
    }).then(blob => { preview.src = URL.createObjectURL(blob); }).catch(() => { preview.hidden = true; });
  } else {
    const mark = document.createElement('span'); mark.className = 'attachment-kind'; mark.textContent = attachment.kind === 'text' ? t('TXT') : t('FILE'); item.append(mark);
  }
  const info = document.createElement('div'); const name = document.createElement('strong'); name.textContent = attachment.name;
  const meta = document.createElement('small'); meta.textContent = attachment.guidance || (attachment.kind === 'video' ? `${attachment.frameCount || 0} sampled frames · ${formatBytes(attachment.size)}` : `${attachment.kind} · ${formatBytes(attachment.size)}`);
  info.append(name, meta); item.append(info);
  if (removable) {
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', t('Remove') + ' ' + attachment.name);
    remove.addEventListener('click', async () => { await fetch(`/api/attachments/${attachment.id}`, { method: 'DELETE' }); state.pendingAttachments = state.pendingAttachments.filter(entry => entry.id !== attachment.id); renderAttachmentTray(); }); item.append(remove);
  }
  return item;
}

function renderAttachmentTray() {
  const tray = $('#attachment-tray'); tray.innerHTML = ''; tray.hidden = !state.pendingAttachments.length;
  state.pendingAttachments.forEach(item => tray.append(attachmentVisual(item, true)));
}

async function ingestAttachmentPaths(paths) {
  if (!paths?.length) return;
  if (!state.threadId && !(await createChat())) return;
  const button = $('#attach-files'); button.disabled = true; button.lastChild.textContent = ' ' + t('Processing');
  try {
    const response = await fetch('/api/attachments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths, threadId: state.threadId }) });
    const data = await response.json();
    state.pendingAttachments.push(...(data.items || [])); renderAttachmentTray();
    if (data.errors?.length) {
      const error = document.createElement('div'); error.className = 'attachment-error'; error.textContent = data.errors.map(item => item.error).join(' '); $('#attachment-tray').append(error); $('#attachment-tray').hidden = false;
    }
  } finally { button.disabled = false; button.lastChild.textContent = t('Attach'); }
}

async function chooseAttachments() {
  const paths = await window.qwenDesktop?.chooseAttachments?.();
  await ingestAttachmentPaths(paths || []);
}

function toggleTerminal(force) {
  const panel = $('#terminal-panel');
  const open = typeof force === 'boolean' ? force : panel.hidden;
  panel.hidden = !open;
  $('.surface').classList.toggle('terminal-open', open);
  $('#terminal-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('#terminal-input').focus();
}

function setTerminalRunning(running) {
  $('#terminal-input').disabled = running;
  $('#terminal-form button').disabled = running;
  $('#terminal-stop').hidden = !running;
  $('#terminal-status').textContent = running ? t('Running') : t('Ready');
  $('#terminal-status').classList.toggle('running', running);
}

async function watchTerminal(runId, command) {
  const output = $('#terminal-output');
  while (state.terminalRun === runId) {
    await new Promise(resolve => setTimeout(resolve, 450));
    let response;
    try { response = await fetch(`/api/terminal/${runId}`); }
    catch { $('#terminal-status').textContent = t('Reconnecting'); continue; }
    if (!response.ok) throw new Error(t('The terminal process could not be loaded.'));
    const run = await response.json();
    const current = `PS ${run.workspace}> ${command}\n${run.output || ''}`;
    output.textContent = state.terminalTranscript + current;
    output.scrollTop = output.scrollHeight;
    if (run.status !== 'running') {
      const label = run.status === 'stopped' ? t('Stopped') : run.status === 'error' ? t('Failed') : t('Exited') + ' ' + run.exitCode;
      state.terminalTranscript += `${current}\n[${label}]\n`;
      output.textContent = state.terminalTranscript;
      state.terminalRun = null;
      setTerminalRunning(false);
      $('#terminal-status').textContent = label;
      $('#terminal-input').focus();
      return;
    }
  }
}

async function runTerminalCommand(command) {
  if (!command.trim() || state.terminalRun) return;
  toggleTerminal(true);
  state.terminalHistory.push(command.trim());
  state.terminalHistoryIndex = state.terminalHistory.length;
  setTerminalRunning(true);
  $('#terminal-output').textContent = `${state.terminalTranscript}PS> ${command.trim()}\n`;
  try {
    const response = await fetch('/api/terminal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: command.trim() }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || t('The command could not start.'));
    state.terminalRun = data.id;
    await watchTerminal(data.id, command.trim());
  } catch (error) {
    state.terminalRun = null;
    setTerminalRunning(false);
    $('#terminal-status').textContent = t('Failed');
    state.terminalTranscript += `PS> ${command.trim()}\n${t('Terminal error:')} ${error.message}\n`;
    $('#terminal-output').textContent = state.terminalTranscript;
  }
}

function renderAssistantContent(container, text) {
  const pattern = /```([\w.+-]*)\r?\n([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) {
      const prose = document.createElement('div'); prose.className = 'message-prose'; prose.textContent = text.slice(cursor, match.index); container.append(prose);
    }
    const block = document.createElement('section'); block.className = 'code-block';
    const head = document.createElement('header'); const language = document.createElement('span'); language.textContent = match[1] || 'code';
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = t('Copy');
    copy.addEventListener('click', async () => { await navigator.clipboard.writeText(match[2]); copy.textContent = t('Copied'); setTimeout(() => { copy.textContent = t('Copy'); }, 1400); });
    const pre = document.createElement('pre'); const code = document.createElement('code'); code.textContent = match[2].replace(/\s+$/, ''); pre.append(code);
    head.append(language, copy); block.append(head, pre); container.append(block); cursor = match.index + match[0].length;
  }
  if (cursor < text.length || !container.children.length) {
    const prose = document.createElement('div'); prose.className = 'message-prose'; prose.textContent = text.slice(cursor); container.append(prose);
  }
}

function addMessage(role, text, attachments = [], statusText = '') {
  const message = document.createElement('article');
  message.className = `message ${role}`;
  const label = document.createElement('span');
  label.className = 'message-label';
  label.textContent = role === 'user' ? t('You') : t('Qwen');
  message.append(label);
  if (role === 'assistant') renderAssistantContent(message, text);
  else message.append(document.createTextNode(text));
  if (attachments?.length) {
    const media = document.createElement('div'); media.className = 'message-attachments'; attachments.forEach(item => media.append(attachmentVisual(item))); message.append(media);
  }
  if (statusText) { const status = document.createElement('span'); status.className = 'message-status'; status.textContent = statusText; message.append(status); }
  messages.append(message);
  message.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return message;
}

function addRunStatus() {
  const card = document.createElement('section');
  card.className = 'run-status';
  card.innerHTML = '<div class="run-status-head"><span class="run-spinner"></span><strong>Qwen is working</strong><span class="run-elapsed">0:00</span><span class="run-state">Starting</span><button class="run-pause" type="button">Pause</button><button class="run-stop" type="button">Stop</button></div><div class="run-live" role="status" aria-live="polite"><span class="live-pulse"></span><div><strong>Starting the local agent</strong><small>Preparing your request…</small></div></div><div class="run-approval" hidden><strong>Qwen needs your approval</strong><p></p><small></small><div><button class="approve" type="button">Approve once</button><button class="deny" type="button">Deny</button></div></div><pre class="run-draft" aria-label="Live response preview" hidden></pre><div class="run-events"></div>';
  const artifacts = document.createElement('div'); artifacts.className = 'run-artifacts'; artifacts.hidden = true; card.querySelector('.run-events').before(artifacts);
  card.querySelector('.run-status-head > strong').textContent = t('Qwen is working'); card.querySelector('.run-status-head > strong').dataset.orig = 'Qwen is working';
  card.querySelector('.run-state').textContent = t('Starting'); card.querySelector('.run-state').dataset.orig = 'Starting';
  card.querySelector('.run-pause').textContent = t('Pause'); card.querySelector('.run-pause').dataset.orig = 'Pause';
  card.querySelector('.run-stop').textContent = t('Stop'); card.querySelector('.run-stop').dataset.orig = 'Stop';
  card.querySelector('.run-live strong').textContent = t('Starting the local agent'); card.querySelector('.run-live strong').dataset.orig = 'Starting the local agent';
  card.querySelector('.run-live small').textContent = t('Preparing your request…'); card.querySelector('.run-live small').dataset.orig = 'Preparing your request…';
  card.querySelector('.run-approval strong').textContent = t('Qwen needs your approval'); card.querySelector('.run-approval strong').dataset.orig = 'Qwen needs your approval';
  card.querySelector('.approve').textContent = t('Approve once'); card.querySelector('.approve').dataset.orig = 'Approve once';
  card.querySelector('.deny').textContent = t('Deny'); card.querySelector('.deny').dataset.orig = 'Deny';
  messages.append(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return card;
}

function finishRunCard(card, stateLabel, failed = false) {
  card.querySelector('.run-spinner').classList.add(failed ? 'failed' : 'done');
  card.querySelector('.run-state').textContent = stateLabel; card.querySelector('.run-state').setAttribute('data-orig', stateLabel);
  card.querySelector('.run-live')?.classList.add(failed ? 'failed' : 'finished');
  card.querySelector('.run-pause')?.remove();
}

function updateRunActivity(card, job) {
  const live = card.querySelector('.run-live');
  if (!live) return;
  const approval = card.querySelector('.run-approval');
  if (approval) {
    const pending = job.pendingApproval;
    approval.hidden = !pending;
    if (pending) {
      approval.querySelector('p').textContent = pending.request?.reason || t('This action needs your approval.');
      const detail = pending.request?.command || pending.request?.target || pending.request?.tool || '';
      approval.querySelector('small').textContent = detail;
      approval.querySelector('.approve').onclick = () => respondToApproval(job.id, true, approval);
      approval.querySelector('.deny').onclick = () => respondToApproval(job.id, false, approval);
    }
  }
  const labels = { queued: 'Queued', setup: 'Preparing your workspace', waiting: 'Waiting for idle time', model: 'Loading the request into Qwen', generating: 'Qwen is generating', tool: 'Using a computer tool', approval: 'Waiting for your approval', paused: 'Paused safely', blocked: 'Blocked safely', supervisor: 'Codex is reviewing the evidence', verifying: 'Checking the result', complete: 'Finished', complete_with_warnings: 'Finished with warnings' };
  const liveKey = labels[job.phase] || 'Qwen is working';
  live.querySelector('strong').textContent = t(liveKey); live.querySelector('strong').dataset.orig = liveKey;
  const metrics = job.metrics || {};
  const contextSummary = metrics.estimatedContextTokens ? `${t('Context:')} ${Number(metrics.estimatedContextTokens).toLocaleString()} / ${Number(metrics.contextLimit || 0).toLocaleString()} tokens (${Number(metrics.contextUtilization || 0).toFixed(1)}%)` : '';
  const draft = card.querySelector('.run-draft');
  if (metrics.responsePreview) { draft.hidden = false; draft.textContent = metrics.responsePreview; }
  const generated = metrics.totalGeneratedTokens ? ` · ${Number(metrics.totalGeneratedTokens).toLocaleString()} ${t('generated tokens total')}` : metrics.generatedCharacters ? ` · ${Number(metrics.generatedCharacters).toLocaleString()} ${t('characters generated')}` : '';
  const staleSeconds = Math.max(0, Math.floor(Date.now() / 1000 - (job.updatedAt || Date.now() / 1000)));
  if (['model', 'generating'].includes(job.phase) && staleSeconds >= 10) {
    const staleKey = job.phase === 'model' ? 'Ollama is processing the conversation' : 'Waiting for more model output';
    live.querySelector('strong').textContent = t(staleKey); live.querySelector('strong').dataset.orig = staleKey;
    live.querySelector('small').textContent = t('notice.staleAgent', { seconds: staleSeconds }) + generated;
  } else {
    live.querySelector('small').textContent = `${t(job.activity) || t('Waiting for the next update…')}${generated}`;
  }
  renderRunArtifacts(card, job);
  if (contextSummary) live.querySelector('small').textContent += ` · ${contextSummary}`;
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - (job.createdAt || Date.now() / 1000)));
  card.querySelector('.run-elapsed').textContent = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  const pause = card.querySelector('.run-pause');
  if (pause) { const pauseKey = job.pauseRequested ? 'Resume' : 'Pause'; pause.textContent = t(pauseKey); pause.dataset.orig = pauseKey; pause.disabled = Boolean(job.pendingApproval); pause.onclick = () => respondToPause(job.id, !job.pauseRequested, pause); }
  const stateKey = job.phase === 'paused' ? 'Paused' : job.phase === 'blocked' ? 'Blocked' : job.phase === 'generating' ? 'Generating' : job.phase === 'tool' ? 'Using tool' : job.phase === 'supervisor' ? 'Supervising' : job.phase === 'verifying' ? 'Verifying' : 'Running';
  card.querySelector('.run-state').textContent = t(stateKey); card.querySelector('.run-state').dataset.orig = stateKey;
}

function renderRunArtifacts(card, job) {
  const container = card.querySelector('.run-artifacts');
  if (!container) return;
  container.textContent = '';
  const artifacts = [...new Set((job.artifacts || []).filter(path => path && !String(path).startsWith('Files created by')))].slice(0, 24);
  if (!artifacts.length) { container.hidden = true; return; }
  container.hidden = false;
  const heading = document.createElement('strong'); heading.textContent = t('Files Qwen changed'); container.append(heading);
  const list = document.createElement('div'); list.className = 'run-artifact-list';
  artifacts.forEach(path => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'run-artifact'; button.textContent = String(path); button.title = t('Open a read-only file review');
    button.addEventListener('click', () => { showView('workspace'); reviewProjectFile(String(path)); });
    list.append(button);
  });
  container.append(list);
}

async function respondToPause(jobId, paused, button) {
  button.disabled = true;
  try {
    const response = await fetch(`/api/jobs/${jobId}/pause`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused }) });
    if (!response.ok) throw new Error((await response.json()).error || t('Pause state could not be changed.'));
  } catch (error) { showNotice(error.message); button.disabled = false; }
}

async function respondToApproval(jobId, approved, panel) {
  panel.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    const response = await fetch(`/api/jobs/${jobId}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved }) });
    if (!response.ok) throw new Error((await response.json()).error || t('Approval response could not be saved.'));
    panel.querySelector('strong').textContent = approved ? t('Approval sent') : t('Denial sent');
  } catch (error) {
    panel.querySelector('small').textContent = error.message;
    panel.querySelectorAll('button').forEach(button => { button.disabled = false; });
  }
}

function appendRunEvent(card, event) {
  const item = document.createElement('div');
  item.className = `run-event ${event.kind}`;
  const title = document.createElement('div');
  title.className = 'run-event-title';
  title.textContent = translateEventText(event.text);
  title.setAttribute('data-orig', event.text);
  item.append(title);
  if (event.detail && Object.keys(event.detail).length) {
    const details = document.createElement('div'); details.className = 'run-event-detail';
    const fields = document.createElement('dl');
    Object.entries(event.detail).forEach(([label, value]) => {
      const term = document.createElement('dt');
      const description = document.createElement('dd');
      const technical = /command|path|input|output|error/i.test(label);
      term.textContent = t(label); term.setAttribute('data-orig', label);
      description.textContent = technical ? String(value) : t(String(value)); description.setAttribute('data-orig', String(value));
      if (technical) description.className = 'technical-value';
      fields.append(term, description);
    });
    details.append(fields);
    item.append(details);
  }
  card.querySelector('.run-events').append(item);
  item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function watchJob(jobId, card) {
  let eventCount = 0;
  let connectionFailures = 0;
  card.querySelector('.run-stop').addEventListener('click', async () => {
    card.querySelector('.run-stop').disabled = true;
    card.querySelector('.run-stop').textContent = t('Stopping');
    await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
  });
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 800));
    let response;
    try {
      response = await fetch(`/api/jobs/${jobId}`);
      connectionFailures = 0;
      setConnected(true);
    } catch {
      connectionFailures += 1;
      setConnected(false);
      card.querySelector('.run-state').textContent = t('Reconnecting');
      if (connectionFailures < 20) continue;
      throw new Error(t('The local agent backend disconnected and could not restart.'));
    }
    if (response.status === 404) throw new Error(t('The agent restarted during this task. Please send the prompt again.'));
    if (!response.ok) throw new Error(t('The agent job could not be loaded.'));
    const job = await response.json();
    updateRunActivity(card, job);
    (job.events || []).slice(eventCount).forEach(event => appendRunEvent(card, event));
    eventCount = (job.events || []).length;
    if (job.status === 'complete' || job.status === 'complete_with_warnings') {
      finishRunCard(card, job.status === 'complete_with_warnings' ? t('Complete with warnings') : t('Complete'), job.status === 'complete_with_warnings');
      const answer = job.message?.content || t('Qwen returned an empty response.');
      state.history.push({ role: 'assistant', content: answer });
      addMessage('assistant', answer);
      return;
    }
    if (job.status === 'blocked') {
      finishRunCard(card, t('Blocked'), true);
      const reason = job.blockedReason || job.error || t('Repeated recovery failures stopped this run safely.');
      addMessage('assistant', t('notice.blocked', { reason }));
      return;
    }
    if (job.status === 'error' || job.status === 'stopped') {
      if (job.status === 'stopped' && state.steering) { finishRunCard(card, t('Steered')); return { steered: true }; }
      finishRunCard(card, t('Stopped'), true);
      throw new Error(job.error || t('Qwen could not complete that request.'));
    }
  }
}

async function newChat() { await createChat(null); }

async function queueDirection(text) {
  if (!text.trim() && !state.pendingAttachments.length) return;
  const attachments = [...state.pendingAttachments]; state.pendingAttachments = []; renderAttachmentTray();
  const content = text.trim() || t('Review the attached file and incorporate it into the current task.');
  const element = addMessage('user', content, attachments, t('Queued to steer the active run'));
  state.queuedDirections.push({ text: content, attachments, element });
  if (state.activeRunCard) appendRunEvent(state.activeRunCard, { kind: 'steer', text: t('New direction received:') + ' ' + content, detail: { Queue: `${state.queuedDirections.length} message${state.queuedDirections.length === 1 ? '' : 's'} waiting`, Action: t('Stopping the current model turn, then continuing with this direction') } });
  $('#send').textContent = t('Queued');
  if (!state.steering && state.activeJobId) {
    state.steering = true;
    await fetch(`/api/jobs/${state.activeJobId}`, { method: 'DELETE' });
  }
}

async function drainDirections() {
  if (state.running || !state.queuedDirections.length) return;
  const next = state.queuedDirections.shift();
  const status = next.element?.querySelector('.message-status'); if (status) status.textContent = t('Steering Qwen now');
  await sendMessage(next.text, { attachments: next.attachments, alreadyRendered: true, messageElement: next.element });
}

async function sendMessage(text, options = {}) {
  if (state.running) { await queueDirection(text); return; }
  if (!state.runtimeReady) { showNotice(t('Ollama is still starting. Qwen will be available when the local runtime indicator turns green.')); return; }
  const availableAttachments = options.attachments || state.pendingAttachments;
  if (!text.trim() && !availableAttachments.length) return;
  if (!state.threadId && !(await createChat())) return;
  const outgoingAttachments = [...availableAttachments];
  const outgoingText = text.trim() || t('Review the attached file and help me with it.');
  state.steering = false;
  state.running = true;
  intro.hidden = true;
  state.history.push({ role: 'user', content: outgoingText, attachments: outgoingAttachments });
  if (!options.alreadyRendered) addMessage('user', outgoingText, outgoingAttachments);
  $('#send').disabled = false;
  $('#send').textContent = t('Steer');
  $('#mode').disabled = true;
  $('#model').disabled = true;
  $('#settings-model').disabled = true;
  const runCard = addRunStatus();
  state.activeRunCard = runCard;
  try {
    let response; let data;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: state.threadId, message: outgoingText, attachments: outgoingAttachments.map(item => item.id), mode: state.mode, supervisor: Boolean(state.supervisor?.enabled) }) });
      data = await response.json();
      if (response.status !== 409 || !options.alreadyRendered) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!response.ok) throw new Error(data.error || t('Qwen could not start that request.'));
    const queuedStatus = options.messageElement?.querySelector('.message-status'); if (queuedStatus) queuedStatus.textContent = t('Direction sent to Qwen');
    state.threadId = data.threadId || state.threadId;
    if (!options.attachments) { state.pendingAttachments = []; renderAttachmentTray(); }
    state.activeJobId = data.jobId;
    if (state.queuedDirections.length && !state.steering) { state.steering = true; await fetch(`/api/jobs/${state.activeJobId}`, { method: 'DELETE' }); }
    await watchJob(data.jobId, runCard);
    await refreshThreads();
    setConnected(true);
  } catch (error) {
    if (!state.steering) {
      finishRunCard(runCard, t('Stopped'), true);
      const live = runCard.querySelector('.run-live');
      live.querySelector('strong').textContent = t('The run stopped');
      live.querySelector('small').textContent = error.message;
      addMessage('assistant', t('Error:') + ' ' + error.message);
    }
  }
  finally {
    state.running = false; state.activeJobId = null; state.activeRunCard = null;
    $('#send').disabled = false; $('#send').textContent = state.queuedDirections.length ? t('Queued') : t('Send'); $('#mode').disabled = false; $('#model').disabled = false; $('#settings-model').disabled = false; updateComposerAvailability(); prompt.focus();
    if (state.queuedDirections.length) setTimeout(drainDirections, 0);
  }
}

function argsToLines(args = []) { return args.join('\n'); }
function libraryItem(item) {
  const element = document.createElement('article');
  element.className = 'library-item';
  const name = document.createElement('strong'); name.textContent = t(item.name);
  const description = document.createElement('p'); description.textContent = t(item.description);
  const button = document.createElement('button'); button.type = 'button'; button.textContent = t('Use template');
  element.append(name, description, button);
  button.addEventListener('click', () => {
    $('#mcp-form').hidden = false;
    const form = $('#mcp-form');
    form.name.value = item.name;
    form.transport.value = item.transport || 'stdio';
    form.command.value = item.command || '';
    form.url.value = item.url || '';
    if (form.authMode) form.authMode.value = item.authMode || 'none';
    form.args.value = argsToLines(item.args);
    form.env.value = '';
    form.headers.value = '';
    form.transport.dispatchEvent(new Event('change'));
  });
  return element;
}

async function refreshMcps() {
  try {
    const [connections, library] = await Promise.all([fetch('/api/mcps').then(r => r.json()), fetch('/api/mcp-library').then(r => r.json())]);
    const list = $('#mcp-list'); list.innerHTML = '';
    if (!connections.connections.length) list.innerHTML = '<p class="muted">' + t('No MCP connections yet.') + '</p>';
    connections.connections.forEach(connection => {
      const card = document.createElement('article'); card.className = 'mcp-card';
      const target = connection.transport === 'streamable-http' ? connection.url : `${connection.command || ''} ${(connection.args || []).join(' ')}`;
      const letter = document.createElement('div'); letter.className = 'mcp-letter'; letter.textContent = (connection.name || 'M')[0].toUpperCase();
      const main = document.createElement('div'); main.className = 'mcp-main';
      const title = document.createElement('strong'); title.textContent = connection.name;
      const endpoint = document.createElement('span'); endpoint.textContent = `${connection.transport === 'streamable-http' ? t('Streamable HTTP') + ' · ' : ''}${target}`;
      main.append(title, endpoint);
      const actions = document.createElement('div'); actions.className = 'mcp-actions';
      const toggle = document.createElement('button'); toggle.className = 'outline toggle'; toggle.textContent = connection.enabled === false ? t('Enable') : t('Disable');
      const test = document.createElement('button'); test.className = 'outline test'; test.textContent = t('Test');
      const remove = document.createElement('button'); remove.className = 'outline danger remove'; remove.textContent = t('Remove');
      actions.append(toggle, test, remove); card.append(letter, main, actions);
      toggle.addEventListener('click', async () => { toggle.disabled = true; try { const result = await fetch(`/api/mcps/${encodeURIComponent(connection.id)}/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: connection.enabled === false }) }).then(r => r.json()); if (result.enabled !== undefined) { connection.enabled = result.enabled; toggle.textContent = result.enabled ? t('Disable') : t('Enable'); } } finally { toggle.disabled = false; } });
  card.querySelector('.test').addEventListener('click', async () => { const button = card.querySelector('.test'); button.textContent = t('Testing'); try { const response = await fetch(`/api/mcps/${encodeURIComponent(connection.id)}/test`, { method: 'POST' }); const result = await response.json(); if (!response.ok) throw new Error(result.error || result.message || t('Connection diagnostics failed.')); button.textContent = `${(result.tools || []).length} tools`; showNotice(`${(result.tools || []).length} tools · MCP connection is healthy`, 'success'); } catch (error) { button.textContent = t('Failed'); showNotice(error.message); } });
      card.querySelector('.remove').addEventListener('click', async () => { await fetch(`/api/mcps/${encodeURIComponent(connection.id)}`, { method: 'DELETE' }); refreshMcps(); loadStatus(); });
      list.append(card);
    });
    const libraryList = $('#library-list'); libraryList.innerHTML = ''; library.items.forEach(item => libraryList.append(libraryItem(item)));
  } catch { $('#mcp-list').innerHTML = '<p class="muted">' + t('Unable to load MCP connections.') + '</p>'; }
}

async function refreshProjects() {
  try {
    const [projects, tree, threads] = await Promise.all([fetch('/api/projects').then(r => r.json()), fetch('/api/project/files').then(r => r.json()), fetch('/api/threads').then(r => r.json())]);
    const list = $('#project-list'); list.innerHTML = '';
    if (!projects.items.length) list.innerHTML = '<p class="muted">' + t('No project folders linked yet. Link a folder to give Qwen a dedicated workspace.') + '</p>';
    projects.items.forEach(project => {
      const card = document.createElement('article');
      const active = projects.active === project.id;
      card.className = `project-card ${active ? 'active' : ''}`;
      const projectHead = document.createElement('div'); projectHead.className = 'project-card-head';
      const projectIcon = document.createElement('span'); projectIcon.className = 'project-icon'; projectIcon.dataset.icon = 'folder';
      const projectMain = document.createElement('div'); projectMain.className = 'project-main';
      const projectName = document.createElement('strong'); projectName.textContent = project.name;
      const projectPath = document.createElement('span'); projectPath.textContent = project.path;
      projectMain.append(projectName, projectPath);
      const projectActions = document.createElement('div'); projectActions.className = 'project-actions';
      if (active) { const activeLabel = document.createElement('span'); activeLabel.className = 'active-project'; activeLabel.textContent = t('Active'); projectActions.append(activeLabel); }
      else { const activate = document.createElement('button'); activate.className = 'outline activate'; activate.textContent = t('Open'); projectActions.append(activate); }
      const projectPermission = document.createElement('select'); projectPermission.className = 'project-permission'; projectPermission.title = t('Permission profile for this project');
      [['project-write', 'Write'], ['read-only', 'Read'], ['full-access', 'Full']].forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = t(label); projectPermission.append(option); });
      projectPermission.value = project.permissionProfile || state.supervisor?.permissionProfile || 'project-write';
      projectPermission.addEventListener('change', async () => { const response = await fetch(`/api/projects/${project.id}/permissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissionProfile: projectPermission.value }) }); if (!response.ok) showNotice(t('The project permission profile could not be saved.')); else { project.permissionProfile = projectPermission.value; showNotice(t('Project permissions set to') + ' ' + projectPermission.options[projectPermission.selectedIndex].text + '.', 'success'); } });
      projectActions.append(projectPermission);
      const removeProject = document.createElement('button'); removeProject.className = 'icon-only remove-project'; removeProject.title = t('Unlink project'); removeProject.dataset.icon = 'trash'; projectActions.append(removeProject);
      projectHead.append(projectIcon, projectMain, projectActions); card.append(projectHead);
      card.querySelector('.activate')?.addEventListener('click', async () => { await activateProject(project.id, true); });
      card.querySelector('.remove-project').addEventListener('click', async () => { await fetch(`/api/projects/${project.id}`, { method: 'DELETE' }); await Promise.all([refreshProjects(), loadStatus()]); });
      const chatArea = document.createElement('div'); chatArea.className = 'project-card-chats';
      const chatHead = document.createElement('div'); chatHead.className = 'project-card-chats-head'; const chatLabel = document.createElement('span'); chatLabel.textContent = t('Chats');
      const addChat = document.createElement('button'); addChat.type = 'button'; addChat.textContent = t('New chat');
      addChat.addEventListener('click', async () => { if (state.project?.id !== project.id && !(await activateProject(project.id, false))) return; await createChat(project.id); });
      chatHead.append(chatLabel, addChat); chatArea.append(chatHead);
      const projectThreads = threads.items.filter(thread => thread.projectId === project.id);
      if (!projectThreads.length) { const empty = document.createElement('p'); empty.textContent = t('No chats in this project yet.'); chatArea.append(empty); }
      projectThreads.slice(0, 8).forEach(thread => {
        const chat = document.createElement('button'); chat.type = 'button'; chat.className = `project-card-chat ${thread.id === state.threadId ? 'active' : ''}`;
        const title = document.createElement('span'); title.textContent = thread.title || t('New chat'); const count = document.createElement('small'); count.textContent = `${thread.messageCount || 0} ${t('messages')}`;
        chat.append(title, count); chat.addEventListener('click', () => openProjectThread(project.id, thread.id)); chatArea.append(chat);
      });
      card.append(chatArea);
      list.append(card); window.renderQwenIcons(card);
    });
    $('#workspace-path').textContent = tree.path;
    const files = $('#project-file-list'); files.innerHTML = '';
    if (!tree.files.length) files.innerHTML = '<p class="muted">' + t('This folder is empty.') + '</p>';
    tree.files.forEach(file => {
      const row = document.createElement('div'); row.className = 'file-row';
      const icon = document.createElement('span'); icon.dataset.icon = file.type === 'folder' ? 'folder' : 'file';
      const name = document.createElement('span'); name.textContent = file.name;
      const kind = document.createElement('small'); kind.textContent = file.type;
      row.append(icon, name, kind);
      if (file.type === 'file') { row.tabIndex = 0; row.title = t('Review this file'); row.addEventListener('click', () => reviewProjectFile(file.name)); row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); reviewProjectFile(file.name); } }); }
      files.append(row); window.renderQwenIcons(row);
    });
    await refreshGitReview();
  } catch { $('#project-list').innerHTML = '<p class="muted">' + t('Unable to load projects.') + '</p>'; }
}

async function reviewProjectFile(path) {
  const label = $('#file-review-path'); const content = $('#file-review-content');
  if (!label || !content) return;
  label.textContent = path; content.textContent = t('Reading the current file…');
  try {
    const response = await fetch(`/api/git/file?path=${encodeURIComponent(path)}`); const data = await response.json();
    if (!response.ok) throw new Error(data.error || t('File review failed.'));
    content.textContent = data.content || t('(empty file)');
  } catch (error) { content.textContent = t('File review unavailable:') + ' ' + error.message; }
}

async function refreshGitReview() {
  const summary = $('#git-summary');
  const diff = $('#git-diff-stat');
  if (!summary || !diff) return;
  summary.textContent = t('Checking repository state…');
  diff.textContent = '';
  try {
    const response = await fetch('/api/git');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || t('Git status unavailable'));
    if (!data.isRepository) {
      summary.textContent = t('This project folder is not a Git repository.');
      return;
    }
    const branch = data.branch ? ` ${t('on')} ${data.branch}` : '';
    const changes = Array.isArray(data.status) ? data.status.length : 0;
    summary.textContent = changes ? `${changes} ${t('uncommitted files')}${branch}` : `${t('Working tree clean')}${branch}`;
    diff.textContent = data.diffStat || t('No diff summary available.');
  } catch (error) {
    summary.textContent = t('Git review unavailable:') + ' ' + error.message;
    diff.textContent = '';
  }
}

async function linkProject() {
  if (!window.qwenDesktop?.chooseProjectFolder) { showNotice(t('Folder selection is available in the desktop app.')); return; }
  const path = await window.qwenDesktop.chooseProjectFolder();
  if (!path) return;
  const response = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
  if (!response.ok) { const error = await response.json(); showNotice(error.error || t('Could not link this folder.')); return; }
  await Promise.all([refreshProjects(), loadStatus()]);
  state.threadId = null; state.history = []; clearThreadSurface(); intro.hidden = false; await refreshThreads(true);
}

async function createProject() {
  if (!window.qwenDesktop?.chooseProjectParent) { showNotice(t('Project creation is available in the desktop app.')); return; }
  const name = window.prompt(t('Project name'));
  if (!name?.trim()) return;
  const parent = await window.qwenDesktop.chooseProjectParent();
  if (!parent) return;
  const response = await fetch('/api/projects/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent, name: name.trim() }) });
  const data = await response.json();
  if (!response.ok) { showNotice(data.error || t('Could not create this project.')); return; }
  state.threadId = null; state.history = []; clearThreadSurface(); intro.hidden = false;
  await Promise.all([refreshProjects(), loadStatus()]);
  await createChat(state.project?.id || null);
}

$$('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
$('#new-chat').addEventListener('click', newChat);
$('#sidebar-new-chat').addEventListener('click', newChat);
$('#link-project').addEventListener('click', linkProject);
$('#create-project').addEventListener('click', createProject);
$('#refresh-git')?.addEventListener('click', refreshGitReview);
$('#mode').addEventListener('click', () => { const modes = ['fast', 'balanced', 'deep']; state.mode = modes[(modes.indexOf(state.mode) + 1) % modes.length]; renderMode(); loadStatus(); });
$('#settings-mode').addEventListener('click', () => $('#mode').click());
$('#model').addEventListener('click', () => toggleModelMenu($('#model')));
$('#settings-model').addEventListener('click', () => toggleModelMenu($('#settings-model')));
document.addEventListener('click', event => {
  const menu = $('#model-menu');
  if (menu && !menu.hidden && !menu.contains(event.target) && event.target.id !== 'model' && event.target.id !== 'settings-model') menu.hidden = true;
});
$('#supervisor-toggle').addEventListener('click', async () => { try { await setSupervisorSettings({ enabled: !state.supervisor?.enabled }); } catch (error) { $('#supervisor-status').textContent = error.message; } });
$('#supervisor-enabled').addEventListener('change', async event => { try { await setSupervisorSettings({ enabled: event.currentTarget.checked }); } catch (error) { event.currentTarget.checked = !event.currentTarget.checked; $('#supervisor-status').textContent = error.message; } });
$('#supervisor-mode').addEventListener('change', async event => { try { await setSupervisorSettings({ mode: event.currentTarget.value }); } catch (error) { $('#supervisor-status').textContent = error.message; } });
$('#supervisor-budget').addEventListener('change', async event => { try { await setSupervisorSettings({ dailyBudgetUsd: Number(event.currentTarget.value) }); } catch (error) { $('#supervisor-status').textContent = error.message; } });
$('#permission-profile').addEventListener('change', async event => { try { await setSupervisorSettings({ permissionProfile: event.currentTarget.value }); } catch (error) { $('#supervisor-status').textContent = error.message; } });
$('#low-resource').addEventListener('change', async event => { try { await setSupervisorSettings({ lowResource: event.currentTarget.checked }); } catch (error) { event.currentTarget.checked = !event.currentTarget.checked; $('#supervisor-status').textContent = error.message; } });
$('#output-tokens').addEventListener('change', async event => { try { const value = Number(event.currentTarget.value); if (!Number.isInteger(value) || value < -1) throw new Error(t('Use -1 for unlimited or a positive whole-number token cap.')); await setSupervisorSettings({ outputTokens: value }); } catch (error) { $('#supervisor-status').textContent = error.message; loadStatus(); } });
$('#terminal-toggle').addEventListener('click', () => toggleTerminal());
$('#attach-files').addEventListener('click', chooseAttachments);
$('#terminal-close').addEventListener('click', () => toggleTerminal(false));
$('#terminal-clear').addEventListener('click', () => { state.terminalTranscript = ''; $('#terminal-output').textContent = ''; });
$('#terminal-stop').addEventListener('click', async () => { if (state.terminalRun) await fetch(`/api/terminal/${state.terminalRun}`, { method: 'DELETE' }); });
$('#terminal-form').addEventListener('submit', event => { event.preventDefault(); const input = $('#terminal-input'); const command = input.value; input.value = ''; runTerminalCommand(command); });
$('#terminal-input').addEventListener('keydown', event => {
  if (!['ArrowUp', 'ArrowDown'].includes(event.key) || !state.terminalHistory.length) return;
  event.preventDefault();
  state.terminalHistoryIndex = event.key === 'ArrowUp' ? Math.max(0, state.terminalHistoryIndex - 1) : Math.min(state.terminalHistory.length, state.terminalHistoryIndex + 1);
  event.currentTarget.value = state.terminalHistory[state.terminalHistoryIndex] || '';
});
$('#composer').addEventListener('dragover', event => { event.preventDefault(); event.currentTarget.classList.add('dragging'); });
$('#composer').addEventListener('dragleave', event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.classList.remove('dragging'); });
$('#composer').addEventListener('drop', event => { event.preventDefault(); event.currentTarget.classList.remove('dragging'); const paths = [...event.dataTransfer.files].map(file => window.qwenDesktop?.filePath?.(file)).filter(Boolean); ingestAttachmentPaths(paths); });
window.qwenDesktop?.onFileDrop?.(paths => ingestAttachmentPaths(paths)).catch(error => showNotice(t('File drop is unavailable:') + ' ' + error.message));
$('#composer').addEventListener('submit', event => { event.preventDefault(); const text = prompt.value; prompt.value = ''; sendMessage(text); });
prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#composer').requestSubmit(); } });
$$('.starter').forEach(button => button.addEventListener('click', () => { prompt.value = button.textContent; prompt.focus(); }));
$('#show-add').addEventListener('click', () => $('#mcp-form').hidden = false);
$('#close-add').addEventListener('click', () => $('#mcp-form').hidden = true);
$('#cancel-add').addEventListener('click', () => $('#mcp-form').hidden = true);
$('#mcp-form [name="transport"]').addEventListener('change', event => { const http = event.currentTarget.value === 'streamable-http'; $$('.mcp-stdio-field').forEach(item => item.hidden = http); $$('.mcp-http-field').forEach(item => item.hidden = !http); });
$('#mcp-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget;
  let env = {}; let headers = {}; try { env = form.env.value.trim() ? JSON.parse(form.env.value) : {}; headers = form.headers.value.trim() ? JSON.parse(form.headers.value) : {}; } catch { showNotice(t('Environment or headers JSON is not valid.')); return; }
  const body = { name: form.name.value, transport: form.transport.value, authMode: form.authMode?.value || 'none', command: form.command.value, url: form.url.value, args: form.args.value.split('\n').map(item => item.trim()).filter(Boolean), env, headers };
  const response = await fetch('/api/mcps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) { const error = await response.json(); showNotice(error.error || t('Could not save this connection.')); return; }
  form.reset(); form.hidden = true; refreshMcps(); loadStatus();
});
if ($('#language')) $('#language').value = window.qwenI18n.currentLocale();
$('#language').addEventListener('change', event => window.qwenI18n.setLocale(event.currentTarget.value));
document.addEventListener('keydown', event => {
  if (event.ctrlKey && event.key.toLowerCase() === 'k') { event.preventDefault(); newChat(); }
  if (event.ctrlKey && event.key === '`') { event.preventDefault(); toggleTerminal(); }
});
window.addEventListener('qwen:locale-changed', () => {
  renderMode();
  renderSupervisor();
  showView(state.currentView);
  refreshThreads();
  refreshRecoveryJobs();
  loadStatus();
  // Re-translate already-rendered run status cards in place. t() is idempotent:
  // a key already resolved to another language falls back to itself.
  $$('.run-status').forEach(card => {
    ['.run-status-head > strong', '.run-state', '.run-live strong', '.run-approval strong'].forEach(selector => {
      const el = card.querySelector(selector);
      if (el) el.textContent = translateEventText(el.getAttribute('data-orig') || el.textContent);
    });
    const pause = card.querySelector('.run-pause');
    if (pause) pause.textContent = t(pause.getAttribute('data-orig') || 'Pause');
    const stop = card.querySelector('.run-stop');
    if (stop) stop.textContent = t(stop.getAttribute('data-orig') || 'Stop');
    const approve = card.querySelector('.approve');
    if (approve) approve.textContent = t(approve.getAttribute('data-orig') || 'Approve once');
    const deny = card.querySelector('.deny');
    if (deny) deny.textContent = t(deny.getAttribute('data-orig') || 'Deny');
    card.querySelectorAll('.run-event-title, .run-event-detail dt, .run-event-detail dd:not(.technical-value)').forEach(el => {
      el.textContent = translateEventText(el.getAttribute('data-orig') || el.textContent);
    });
  });
});
loadModelOptions();
loadStatus().then(() => refreshThreads(true));
setInterval(loadStatus, 5000);
