(() => {
  const STORAGE_KEY = 'codex_relay_auth_token';

  const authOverlay = document.getElementById('auth-overlay');
  const authForm = document.getElementById('auth-form');
  const authTokenInput = document.getElementById('auth-token-input');
  const authError = document.getElementById('auth-error');
  const btnLock = document.getElementById('btn-lock');

  const wsDot = document.getElementById('ws-dot');
  const cwdLabel = document.getElementById('cwd-label');
  const gitBranch = document.getElementById('git-branch');
  const diffCountBadge = document.getElementById('diff-count-badge');
  const terminalContainer = document.getElementById('terminal-container');
  const diffContainer = document.getElementById('diff-container');
  const fileChipsContainer = document.getElementById('file-chips');
  const promptForm = document.getElementById('prompt-form');
  const promptInput = document.getElementById('prompt-input');
  const btnRestart = document.getElementById('btn-restart');
  const btnRefreshDiff = document.getElementById('btn-refresh-diff');
  const promptStatus = document.getElementById('prompt-status');
  const btnSend = document.getElementById('btn-send');
  const btnQr = document.getElementById('btn-qr');
  const terminalState = document.getElementById('terminal-state');
  const connectionStatus = document.getElementById('connection-status');
  const actionStatus = document.getElementById('action-status');
  const actionButtons = [...document.querySelectorAll('[data-action]')];
  const languageSelects = [...document.querySelectorAll('[data-language-select]')];
  const fontSizeSelect = document.getElementById('font-size');
  const workspacePath = document.getElementById('workspace-path');
  const restartDialog = document.getElementById('restart-dialog');
  const restartConfirm = document.getElementById('restart-confirm');
  const localizedMessages = new Map();
  const languageKey = 'codex_relay_language';
  const fontSizeKey = 'codex_relay_font_size';
  function readPreference(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function savePreference(key, value) { try { localStorage.setItem(key, value); } catch {} }
  const savedLanguage = readPreference(languageKey);
  let language = ['zh-CN', 'en'].includes(savedLanguage) ? savedLanguage
    : (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  const savedFontSize = Number(readPreference(fontSizeKey));
  const fontSize = [12, 13, 15, 17].includes(savedFontSize) ? savedFontSize : 13;
  const t = (key, params) => window.RelayI18n.translate(language, key, params);
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname)) btnQr.hidden = true;

  let activeTab = 'terminal';
  let selectedFile = '';
  let ws = null;
  let reconnectTimer = null;
  let pollTimer = null;
  let authToken = '';
  let isAuthenticated = false;
  let pendingPrompt = null;
  let pendingTimer = null;
  let terminalRunning = null;
  let pendingAction = null;
  let actionTimer = null;
  let restartPending = false;
  let restartTimer = null;
  let lastViewportSize = '';
  let gitStatusRequest = null;
  let gitDiffRequest = null;
  let gitFiles = [];
  let fileChipsKey = null;
  let diffView = null;
  const renderQueue = [];
  let rendering = false;

  function setMessage(element, key, params = {}) {
    if (key) localizedMessages.set(element, { key, params });
    else localizedMessages.delete(element);
    element.textContent = key ? t(key, params) : '';
  }

  function applyLanguage() {
    document.documentElement.lang = language;
    for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.getAttribute('data-i18n'));
    for (const attribute of ['placeholder', 'title', 'aria-label']) {
      for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
        element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
      }
    }
    for (const [element, message] of localizedMessages) element.textContent = t(message.key, message.params);
    for (const select of languageSelects) select.value = language;
    wsDot.title = t(ws?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected');
  }

  function setWorkspace(cwd) {
    const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
    cwdLabel.textContent = parts.at(-1) || cwd;
    workspacePath.textContent = cwd;
  }

  function renderDiffView(view) {
    // Timestamps from the server do not change the visible preview.
    const key = JSON.stringify([selectedFile, language, view.state, view.omitted || []]);
    if (diffView?.key === key && diffView.html === view.html) return;
    const sameFile = diffView?.file === selectedFile;
    const top = sameFile ? diffContainer.scrollTop : 0;
    const left = sameFile ? diffContainer.scrollLeft : 0;
    // diff2html puts wide lines in a separate scroller for each file.
    const fileScrolls = new Map();
    if (sameFile) {
      for (const wrapper of diffContainer.querySelectorAll('.d2h-file-wrapper')) {
        fileScrolls.set(wrapper.id, [...wrapper.querySelectorAll('.d2h-file-diff')]
          .map(panel => ({ top: panel.scrollTop, left: panel.scrollLeft })));
      }
    }
    diffContainer.innerHTML = view.html || '';
    if (view.state) {
      const message = document.createElement('div');
      message.className = 'empty-state';
      message.textContent = t(view.state);
      diffContainer.appendChild(message);
    }
    if (view.omitted?.length) {
      const notice = document.createElement('p');
      notice.className = 'preview-notice';
      notice.textContent = t('omitted', { files: view.omitted.map(item => `${item.file} (${item.reason})`).join(', ') });
      diffContainer.prepend(notice);
    }
    diffView = { key, file: selectedFile, html: view.html };
    diffContainer.scrollTop = top;
    diffContainer.scrollLeft = left;
    for (const wrapper of diffContainer.querySelectorAll('.d2h-file-wrapper')) {
      const positions = fileScrolls.get(wrapper.id);
      if (!positions) continue;
      [...wrapper.querySelectorAll('.d2h-file-diff')].forEach((panel, index) => {
        if (!positions[index]) return;
        panel.scrollTop = positions[index].top;
        panel.scrollLeft = positions[index].left;
      });
    }
  }

  function cancelGitRequest(request) {
    if (!request) return;
    clearTimeout(request.timer);
    request.controller.abort();
  }

  function cancelDiffRequest() {
    const previous = gitDiffRequest;
    gitDiffRequest = null;
    cancelGitRequest(previous);
  }

  function createGitRequest() {
    const request = { controller: new AbortController(), language, file: selectedFile };
    request.timer = setTimeout(() => request.controller.abort(), 12000);
    return request;
  }

  function setPromptStatus(message, sending = false) {
    setMessage(promptStatus, message);
    btnSend.disabled = sending;
  }

  function preservePendingPrompt(message) {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    if (pendingPrompt) pendingPrompt.waiting = false;
    setPromptStatus(message);
  }

  function updateActionButtons() {
    const connected = isAuthenticated && ws?.readyState === WebSocket.OPEN;
    for (const button of actionButtons) {
      button.disabled = !connected || Boolean(pendingAction) || restartPending ||
        (terminalRunning === false && button.getAttribute('data-action') !== 'start_codex');
    }
    btnRestart.disabled = !connected || Boolean(pendingAction) || restartPending;
    restartConfirm.disabled = btnRestart.disabled;
  }

  function finishAction(message) {
    if (actionTimer) clearTimeout(actionTimer);
    actionTimer = null;
    pendingAction = null;
    setMessage(actionStatus, message);
    updateActionButtons();
  }

  function finishRestart(key) {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    restartPending = false;
    setMessage(actionStatus, key);
    updateActionButtons();
  }

  // Initialize xterm.js terminal
  const term = new window.Terminal({
    cursorBlink: true,
    fontSize,
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    theme: {
      background: '#090d12',
      foreground: '#e6edf3',
      cursor: '#58a6ff',
      selectionBackground: 'rgba(88, 166, 255, 0.3)',
    },
    scrollback: 5000,
    convertEol: true,
  });

  const fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(terminalContainer);
  fontSizeSelect.value = String(fontSize);
  applyLanguage();
  for (const select of languageSelects) select.addEventListener('change', () => {
    if (!['zh-CN', 'en'].includes(select.value)) return;
    language = select.value;
    savePreference(languageKey, language);
    applyLanguage();
    fitTerminal();
    if (isAuthenticated) {
      renderFileChips(gitFiles);
      if (activeTab === 'diff') loadDiffHtml(selectedFile);
      refreshGitStatusAndDiff();
    }
  });
  fontSizeSelect.addEventListener('change', () => {
    const next = Number(fontSizeSelect.value);
    if (![12, 13, 15, 17].includes(next)) return;
    term.options.fontSize = next;
    savePreference(fontSizeKey, String(next));
    fitTerminal();
  });

  function renderTerminal(operation) {
    renderQueue.push(operation);
    drainTerminal();
  }

  function drainTerminal() {
    if (rendering || !renderQueue.length) return;
    rendering = true;
    const operation = renderQueue.shift();
    const finish = () => { rendering = false; drainTerminal(); };
    try {
      if (operation.type === 'history' || operation.type === 'session-reset') {
        term.reset();
        if (Number.isInteger(operation.cols) && Number.isInteger(operation.rows)) {
          term.resize(operation.cols, operation.rows);
        }
      }
      // A reset/resize must wait for preceding asynchronous terminal writes.
      if (typeof operation.data === 'string' && operation.data.length) term.write(operation.data, finish);
      else finish();
    } catch { finish(); }
  }

  function fitTerminal() {
    if (activeTab !== 'terminal' || !isAuthenticated) return;
    try {
      // Measure without resizing independently: every browser uses one grid.
      const dimensions = fitAddon.proposeDimensions();
      if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const sizeKey = `${dimensions.cols}:${dimensions.rows}`;
        if (sizeKey === lastViewportSize) return;
        lastViewportSize = sizeKey;
        ws.send(
          JSON.stringify({
            type: 'resize',
            cols: dimensions.cols,
            rows: dimensions.rows,
          })
        );
      }
    } catch {
      // ignore fit errors when hidden
    }
  }

  window.addEventListener('resize', () => {
    fitTerminal();
  });
  window.visualViewport?.addEventListener('resize', fitTerminal);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fitTerminal).observe(terminalContainer);

  // Forward direct terminal keystrokes to PTY over WebSocket
  term.onData((data) => {
    if (isAuthenticated && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  function hapticFeedback(pattern = 25) {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(pattern);
      } catch {
        // ignore on unsupported browsers
      }
    }
  }

  function showLockScreen(errorMsg = '') {
    isAuthenticated = false;
    cancelGitRequest(gitStatusRequest);
    gitStatusRequest = null;
    cancelDiffRequest();
    gitFiles = [];
    selectedFile = '';
    fileChipsKey = null;
    diffView = null;
    fileChipsContainer.innerHTML = '';
    renderDiffView({ state: 'loadingDiff' });
    authOverlay.classList.remove('hidden');
    setMessage(authError, errorMsg);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (ws) {
      const previous = ws;
      ws = null;
      try {
        previous.close();
      } catch {}
    }
    preservePendingPrompt('');
    finishAction('');
    if (restartDialog.open) restartDialog.close();
    if (restartPending) finishRestart('');
    setMessage(connectionStatus, 'disconnected');
    wsDot.classList.remove('connected');
    setTimeout(() => authTokenInput.focus(), 80);
  }

  async function verifyAndUnlock(candidateToken) {
    const cleaned = (candidateToken || '').trim();
    if (!cleaned) {
      showLockScreen('credentialRequired');
      return false;
    }

    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: cleaned }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        localStorage.removeItem(STORAGE_KEY);
        showLockScreen(res.status === 429 ? 'loginLimited' : 'loginInvalid');
        return false;
      }

      authToken = cleaned;
      isAuthenticated = true;
      localStorage.setItem(STORAGE_KEY, authToken);
      setMessage(authError, '');
      authOverlay.classList.add('hidden');

      if (data.cwd) {
        setWorkspace(data.cwd);
      }

      connectWebSocket();
      setTimeout(fitTerminal, 100);
      refreshGitStatusAndDiff();
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(refreshGitStatusAndDiff, 4000);
      return true;
    } catch {
      showLockScreen('loginNetwork');
      return false;
    }
  }

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hapticFeedback(20);
    await verifyAndUnlock(authTokenInput.value);
  });

  btnLock.addEventListener('click', () => {
    hapticFeedback(30);
    localStorage.removeItem(STORAGE_KEY);
    authToken = '';
    authTokenInput.value = '';
    renderQueue.length = 0;
    renderTerminal({ type: 'session-reset' });
    showLockScreen('locked');
  });

  function authFetch(url, options = {}) {
    const requestToken = authToken;
    const headers = Object.assign({}, options.headers || {}, {
      'x-relay-token': authToken,
    });
    return fetch(url, Object.assign({}, options, { headers })).then((res) => {
      if (res.status === 401 && requestToken === authToken && !options.signal?.aborted) {
        localStorage.removeItem(STORAGE_KEY);
        showLockScreen('loginExpired');
      }
      return res;
    });
  }

  function connectWebSocket() {
    if (!isAuthenticated || !authToken) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(authToken)}`;
    if (ws) {
      const previous = ws;
      ws = null;
      previous.close();
    }
    const connection = new WebSocket(wsUrl);
    ws = connection;
    setMessage(connectionStatus, 'connecting');
    updateActionButtons();
    lastViewportSize = '';

    connection.addEventListener('open', () => {
      if (ws !== connection) return;
      wsDot.classList.add('connected');
      wsDot.title = t('connected');
      setMessage(connectionStatus, 'connected');
      updateActionButtons();
      setTimeout(fitTerminal, 80);
    });

    connection.addEventListener('message', (event) => {
      if (ws !== connection) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'history' && typeof msg.data === 'string') {
          renderTerminal(msg);
        } else if (msg.type === 'output' && typeof msg.data === 'string') {
          renderTerminal(msg);
        } else if (msg.type === 'session-reset') {
          renderTerminal(msg);
          if (restartPending) finishRestart('restarted');
          if (pendingAction && pendingAction.action !== 'start_codex') finishAction('actionReset');
          if (pendingPrompt) {
            pendingPrompt = null;
            preservePendingPrompt('draftRestarted');
          }
        } else if (msg.type === 'input-ack' && pendingPrompt && msg.id === pendingPrompt.id) {
          if (promptInput.value === pendingPrompt.text) promptInput.value = '';
          pendingPrompt = null;
          preservePendingPrompt('promptAccepted');
        } else if (msg.type === 'input-error' && pendingPrompt && msg.id === pendingPrompt.id) {
          preservePendingPrompt('promptFailed');
        } else if (msg.type === 'action-ack' && pendingAction && msg.id === pendingAction.id) {
          finishAction('actionAccepted');
        } else if (msg.type === 'action-error' && pendingAction && msg.id === pendingAction.id) {
          finishAction('actionFailed');
        } else if (msg.type === 'status') {
          if (typeof msg.running === 'boolean') {
            terminalRunning = msg.running;
            terminalState.hidden = msg.running;
            setMessage(terminalState, msg.running ? '' : msg.kind === 'normal'
              ? 'terminalNormal' : msg.kind === 'error' ? 'terminalError' : 'terminalUnknown');
          }
          if (msg.cwd) {
            setWorkspace(msg.cwd);
          }
          updateActionButtons();
        }
      } catch {
        // ignore invalid frames
      }
    });

    connection.addEventListener('close', () => {
      if (ws !== connection) return;
      ws = null;
      if (restartDialog.open) restartDialog.close();
      if (restartPending) finishRestart('restartUncertain');
      if (pendingAction) finishAction('actionDisconnected');
      updateActionButtons();
      setMessage(connectionStatus, 'reconnecting');
      if (pendingPrompt) preservePendingPrompt('draftDisconnected');
      wsDot.classList.remove('connected');
      wsDot.title = t('reconnecting');
      if (isAuthenticated) {
        reconnectTimer = setTimeout(connectWebSocket, 2000);
      }
    });

    connection.addEventListener('error', () => {
      connection.close();
    });
  }

  function sendAction(action) {
    if (!isAuthenticated) return;
    if (pendingAction || restartPending) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setMessage(actionStatus, 'actionOffline');
      return;
    }
    if (terminalRunning === false && action !== 'start_codex') {
      setMessage(actionStatus, 'actionEnded');
      return;
    }
    hapticFeedback(action === 'approve' || action === 'reject' ? [30, 40, 30] : 20);
    const id = `action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    pendingAction = { id, action };
    setMessage(actionStatus, 'actionSending');
    updateActionButtons();
    try {
      ws.send(JSON.stringify({ type: 'action', action, id }));
      actionTimer = setTimeout(() => finishAction('actionUncertain'), 7000);
    } catch {
      finishAction('actionUnavailable');
    }
  }

  // Bind all buttons with data-action (Approve, Reject, Enter, Esc, Ctrl+C, Run codex)
  actionButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-action');
      if (action) sendAction(action);
    });
  });

  // Prompt bar submission
  promptForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!isAuthenticated) return;
    const text = promptInput.value;
    if (!text.trim()) return;
    if (terminalRunning === false) {
      setPromptStatus('promptEnded');
      return;
    }
    if (pendingPrompt?.waiting) return;
    hapticFeedback(20);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setPromptStatus('promptOffline');
      return;
    }
    if (text.length >= 16 * 1024) {
      setPromptStatus('promptTooLong');
      return;
    }
    const id = pendingPrompt?.text === text ? pendingPrompt.id : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    pendingPrompt = { id, text, waiting: true };
    setPromptStatus('promptSending', true);
    try {
      ws.send(JSON.stringify({ type: 'input', id, data: `${text}\r` }));
      pendingTimer = setTimeout(() => preservePendingPrompt('promptUncertain'), 7000);
    } catch {
      preservePendingPrompt('promptUnavailable');
    }
    if (activeTab !== 'terminal') {
      switchTab('terminal');
    }
  });

  // Restart PTY session
  btnRestart.addEventListener('click', () => {
    if (!isAuthenticated || !ws || ws.readyState !== WebSocket.OPEN || pendingAction || restartPending) return;
    hapticFeedback(35);
    if (!restartDialog.open) restartDialog.showModal();
  });
  document.getElementById('restart-cancel').addEventListener('click', () => restartDialog.close());
  restartConfirm.addEventListener('click', () => {
    if (!restartDialog.open) return;
    restartDialog.close();
    if (!isAuthenticated || !ws || ws.readyState !== WebSocket.OPEN || pendingAction || restartPending) return;
    restartPending = true;
    setMessage(actionStatus, 'restarting');
    updateActionButtons();
    try {
      ws.send(
        JSON.stringify({
          type: 'restart',
          cols: term.cols || 80,
          rows: term.rows || 24,
        })
      );
      restartTimer = setTimeout(() => finishRestart('restartUncertain'), 7000);
    } catch {
      finishRestart('restartUncertain');
    }
  });

  // Tab switching logic
  function switchTab(tabName) {
    activeTab = tabName;
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      const isMatch = btn.getAttribute('data-tab') === tabName;
      btn.classList.toggle('active', isMatch);
      btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    });

    document.getElementById('panel-terminal').classList.toggle('active', tabName === 'terminal');
    document.getElementById('panel-diff').classList.toggle('active', tabName === 'diff');

    if (tabName === 'terminal') {
      cancelDiffRequest();
      setTimeout(fitTerminal, 50);
    } else if (tabName === 'diff') {
      loadDiffHtml(selectedFile);
      refreshGitStatusAndDiff();
    }
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      if (targetTab) switchTab(targetTab);
    });
  });

  // Git Status & Diff fetching
  async function refreshGitStatusAndDiff() {
    if (!isAuthenticated || gitStatusRequest) return;
    const request = createGitRequest();
    gitStatusRequest = request;
    try {
      const statusRes = await authFetch('/api/git/status', { signal: request.controller.signal });
      if (!statusRes.ok) throw new Error('Git status unavailable');
      const statusData = await statusRes.json();
      if (!isAuthenticated || gitStatusRequest !== request || request.controller.signal.aborted) return;

      if (statusData.ok) {
        gitBranch.textContent = statusData.branch || 'HEAD';
        if (statusData.cwd) {
          setWorkspace(statusData.cwd);
        }

        const files = Array.isArray(statusData.files) ? statusData.files : [];
        diffCountBadge.textContent = String(files.length);
        diffCountBadge.classList.toggle('has-changes', files.length > 0);

        gitFiles = files;
        renderFileChips(gitFiles);
      }
    } catch {
      // A status failure must not replace a newer, independently loaded diff.
      // The preview request reports its own current-file failure below.
    } finally {
      clearTimeout(request.timer);
      if (gitStatusRequest === request) {
        gitStatusRequest = null;
        if (isAuthenticated && activeTab === 'diff') loadDiffHtml(selectedFile);
      }
    }
  }

  function renderFileChips(files) {
    if (selectedFile && !files.some(item => item.file === selectedFile)) {
      selectedFile = '';
      cancelDiffRequest();
      if (activeTab === 'diff') renderDiffView({ state: 'loadingDiff' });
    }
    const key = JSON.stringify([language, selectedFile, files.map(item => [item.code, item.file])]);
    if (fileChipsKey === key) return;
    fileChipsKey = key;
    const scrollLeft = fileChipsContainer.scrollLeft;
    fileChipsContainer.innerHTML = '';

    const allChip = document.createElement('button');
    allChip.className = `file-chip ${selectedFile === '' ? 'active' : ''}`;
    allChip.textContent = t('allFiles', { count: files.length });
    allChip.addEventListener('click', () => {
      selectDiffFile('');
    });
    fileChipsContainer.appendChild(allChip);

    files.forEach((item) => {
      const chip = document.createElement('button');
      chip.className = `file-chip ${selectedFile === item.file ? 'active' : ''}`;
      chip.textContent = `${item.code} ${item.file}`;
      chip.addEventListener('click', () => {
        selectDiffFile(item.file);
      });
      fileChipsContainer.appendChild(chip);
    });
    fileChipsContainer.scrollLeft = scrollLeft;
  }

  function selectDiffFile(file) {
    if (selectedFile === file) return;
    selectedFile = file;
    cancelDiffRequest();
    renderFileChips(gitFiles);
    renderDiffView({ state: 'loadingDiff' });
    loadDiffHtml(file);
  }

  async function loadDiffHtml(fileFilter) {
    if (!isAuthenticated || activeTab !== 'diff') return;
    if (gitDiffRequest?.file === fileFilter && gitDiffRequest.language === language) return;
    cancelDiffRequest();
    const request = createGitRequest();
    gitDiffRequest = request;
    const current = () => isAuthenticated && activeTab === 'diff' && selectedFile === fileFilter &&
      gitDiffRequest === request && language === request.language;
    if (diffView?.file !== fileFilter) renderDiffView({ state: 'loadingDiff' });
    try {
      const query = fileFilter ? `?file=${encodeURIComponent(fileFilter)}` : '';
      const res = await authFetch(`/api/git/diff${query}`, { signal: request.controller.signal });
      if (!res.ok) throw new Error('Git preview unavailable');
      const data = await res.json();
      if (!current() || request.controller.signal.aborted) return;

      if (!data.ok) {
        renderDiffView({ state: 'diffError' });
        return;
      }

      if (!data.hasChanges) {
        renderDiffView({ state: 'treeClean' });
        return;
      }

      if (!data.html) {
        renderDiffView({ state: 'noTextPreview' });
        return;
      }

      renderDiffView({ html: data.html, omitted: data.omittedFiles || [] });
    } catch {
      if (current()) renderDiffView({ state: 'diffUnavailable' });
    } finally {
      clearTimeout(request.timer);
      if (gitDiffRequest === request) gitDiffRequest = null;
    }
  }

  btnRefreshDiff.addEventListener('click', () => {
    hapticFeedback(15);
    loadDiffHtml(selectedFile);
    refreshGitStatusAndDiff();
  });

  // Boot: Check URL ?token=... (from QR scan) or saved token in localStorage
  (async function initAuth() {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      // Strip ?token= from address bar immediately for security
      const cleanUrl = window.location.pathname + window.location.hash;
      window.history.replaceState({}, document.title, cleanUrl);
      const ok = await verifyAndUnlock(urlToken);
      if (ok) return;
    }

    const savedToken = localStorage.getItem(STORAGE_KEY);
    if (savedToken) {
      const ok = await verifyAndUnlock(savedToken);
      if (ok) return;
    }

    showLockScreen();
  })();
})();
