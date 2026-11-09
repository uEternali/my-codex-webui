import { codexIcon } from './codex-icons.js';
import { copyReplyText } from './reply-actions.js';
import { fileIcon, fileType } from './file-types.js';
import { createFileHighlighter } from './file-highlighter-client.js';

const nameOf = path => path.split('/').filter(Boolean).at(-1) || path;
const fileSize = size => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;

export function createFileBrowser({ panel, getCwd, t = text => text, fetcher = fetch, refreshInterval = 3000 }) {
  const doc = panel.ownerDocument;
  const highlighter = createFileHighlighter(doc.defaultView);
  panel.classList.add('side-panel-files'); panel.dataset.i18nIgnore = '';
  panel.innerHTML = `<div class="file-browser-empty" data-files-empty></div>
    <div class="file-browser-layout" data-files-layout hidden>
      <div class="file-preview-column">
        <div class="file-preview-tabs-bar"><div class="file-preview-tabs" role="tablist" data-file-tabs></div><button type="button" class="icon-button small" data-toggle-file-tree>${codexIcon('panelRight')}</button></div>
        <div class="file-preview-views" data-file-views><div class="file-browser-empty" data-file-placeholder></div></div>
      </div>
      <aside class="file-tree-column">
        <div class="file-tree-heading">${codexIcon('folderOpen')}<strong data-file-root></strong><button type="button" class="icon-button small" data-refresh-files>${codexIcon('refreshCw')}</button></div>
        <label class="file-tree-filter">${codexIcon('search')}<input type="search" data-file-filter autocomplete="off" spellcheck="false"></label>
        <div class="file-tree-list" role="tree" data-file-tree></div>
      </aside>
    </div>`;
  const $ = selector => panel.querySelector(selector);
  const layout = $('[data-files-layout]'), tree = $('[data-file-tree]'), filter = $('[data-file-filter]');
  const tabList = $('[data-file-tabs]'), views = $('[data-file-views]'), placeholder = $('[data-file-placeholder]');
  const tabs = new Map(), directories = new Map(), expanded = new Set(['']), pending = new Set();
  let cwd = null, active = null, sequence = 0, generation = 0, disposed = false, treeFocus = null;
  let query = '', search = null, searchTimer = null, searchController = null, searchVersion = 0;
  let rowButtons = new Map();
  let visible = !panel.hidden, refreshTimer = null, refreshing = false, lastSearch = 0;

  function iconButton(icon, label, onClick) {
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'icon-button small';
    button.innerHTML = codexIcon(icon); button.dataset.fileLabel = label;
    button.title = t(label); button.setAttribute('aria-label', button.title); button.onclick = onClick;
    return button;
  }
  function message(container, text, retry) {
    const state = doc.createElement('div'); state.className = 'file-browser-message';
    const copy = doc.createElement('span'); copy.textContent = t(text); state.append(copy);
    if (retry) { const button = doc.createElement('button'); button.type = 'button'; button.textContent = t('Retry'); button.onclick = retry; state.append(button); }
    container.append(state);
  }
  async function request(endpoint, params, controller) {
    const response = await fetcher(`/api/files/${endpoint}?${new URLSearchParams({ cwd, ...params })}`, { cache: 'no-store', signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `${t('Could not load project files')} (${response.status})`);
    return data;
  }
  async function loadDirectory(path, force = false, quiet = false) {
    if (!cwd || disposed || directories.has(path) && !force) return;
    const previous = directories.get(path);
    if (quiet && pending.has(previous?.controller)) return;
    previous?.controller?.abort();
    const controller = new AbortController(), token = generation, node = { ...previous, loading: !quiet || !previous?.entries, controller };
    pending.add(controller); directories.set(path, node); if (node.loading) renderTree();
    try {
      const data = await request('tree', { path, ...(quiet && previous?.revision ? { revision: previous.revision } : {}) }, controller);
      if (disposed || token !== generation || directories.get(path) !== node) return;
      if (data.unchanged) { node.loading = false; if (node.error) { node.error = null; renderTree(); } return; }
      const changed = !quiet || node.error || JSON.stringify(previous?.entries) !== JSON.stringify(data.entries) || previous?.truncated !== data.truncated;
      Object.assign(node, { loading: false, error: null, entries: data.entries, truncated: data.truncated, revision: data.revision });
      if (changed) renderTree();
    } catch (error) {
      if (controller.signal.aborted || disposed || token !== generation || directories.get(path) !== node) return;
      Object.assign(node, { loading: false, error: error.message }); renderTree();
    } finally { pending.delete(controller); }
  }
  function focusRow(path) {
    treeFocus = path;
    for (const [key, button] of rowButtons) button.tabIndex = key === path ? 0 : -1;
    rowButtons.get(path)?.focus({ preventScroll: true });
  }
  function revealFolder(path) {
    clearTimeout(searchTimer); searchController?.abort(); searchVersion++;
    query = ''; filter.value = ''; search = null;
    let parent = '';
    for (const part of path.split('/')) { parent = [parent, part].filter(Boolean).join('/'); expanded.add(parent); }
    treeFocus = path; renderTree();
  }
  function treeRow(item, container, depth, searching = false) {
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'file-tree-row';
    button.dataset.filePath = item.path; button.dataset.fileKind = item.kind; button.setAttribute('role', 'treeitem');
    button.setAttribute('aria-level', String(depth + 1)); button.setAttribute('aria-label', item.path);
    button.style.paddingLeft = `${8 + depth * 14}px`; button.title = item.path;
    const chevron = doc.createElement('span'); chevron.className = 'file-tree-chevron';
    if (item.kind === 'folder') {
      const open = !searching && expanded.has(item.path);
      button.setAttribute('aria-expanded', String(open)); chevron.innerHTML = codexIcon(open ? 'chevronDown' : 'chevronRight');
    } else button.setAttribute('aria-selected', String(active === item.path));
    const icon = doc.createElement('span'); icon.className = 'file-tree-icon'; icon.innerHTML = fileIcon(item.path, item.kind, !searching && expanded.has(item.path));
    const label = doc.createElement('span'); label.className = 'file-tree-name'; label.textContent = searching ? item.path : item.name;
    button.append(chevron, icon, label);
    if (item.kind === 'link') { button.setAttribute('aria-disabled', 'true'); button.title = `${item.path} · ${t('Symbolic links are not previewed')}`; }
    button.classList.toggle('active', item.kind === 'file' && active === item.path);
    button.tabIndex = treeFocus === item.path ? 0 : -1;
    button.onfocus = () => { treeFocus = item.path; for (const [path, row] of rowButtons) row.tabIndex = path === treeFocus ? 0 : -1; };
    button.onclick = () => {
      treeFocus = item.path;
      if (item.kind === 'folder') {
        if (searching) revealFolder(item.path);
        else { if (expanded.has(item.path)) expanded.delete(item.path); else expanded.add(item.path); renderTree(); }
      } else if (item.kind === 'file') openFile(item.path);
    };
    container.append(button); rowButtons.set(item.path, button);
    if (item.kind === 'folder' && !searching && expanded.has(item.path)) {
      const group = doc.createElement('div'); group.setAttribute('role', 'group'); container.append(group);
      renderDirectory(item.path, group, depth + 1);
    }
  }
  function renderDirectory(path, container, depth) {
    const node = directories.get(path);
    if (!node) { const token = generation; message(container, 'Loading files…'); queueMicrotask(() => { if (!disposed && cwd && token === generation) void loadDirectory(path); }); return; }
    if (node.loading) { message(container, 'Loading files…'); return; }
    if (node.error) { message(container, node.error, () => void loadDirectory(path, true)); return; }
    if (!node.entries?.length) message(container, 'Empty folder');
    for (const item of node.entries || []) treeRow(item, container, depth);
    if (node.truncated) message(container, 'Only the first 1,000 entries are shown.');
  }
  function renderTree() {
    const hadFocus = tree.contains(doc.activeElement), scroll = tree.scrollTop;
    rowButtons = new Map(); tree.replaceChildren();
    if (query) {
      if (!search || search.loading) message(tree, 'Searching files…');
      else if (search.error) message(tree, search.error, () => void runSearch());
      else if (!search.items?.length) message(tree, 'No matching files');
      else for (const item of search.items) treeRow(item, tree, 0, true);
    } else if (cwd) renderDirectory('', tree, 0);
    if (!rowButtons.has(treeFocus)) treeFocus = rowButtons.keys().next().value ?? null;
    if (treeFocus !== null) rowButtons.get(treeFocus).tabIndex = 0;
    tree.scrollTop = scroll;
    if (hadFocus && treeFocus !== null) focusRow(treeFocus);
  }
  async function runSearch(quiet = false) {
    searchController?.abort(); const value = query, version = ++searchVersion, token = generation;
    if (!value || !cwd || disposed) { search = null; renderTree(); return; }
    const controller = new AbortController(); searchController = controller; pending.add(controller);
    const previous = search; if (!quiet) { search = { loading: true }; renderTree(); }
    try {
      const data = await request('search', { query: value }, controller);
      if (disposed || token !== generation || version !== searchVersion) return;
      search = { items: data.items }; lastSearch = Date.now();
      if (!quiet || previous?.error || JSON.stringify(previous?.items) !== JSON.stringify(data.items)) renderTree();
    } catch (error) {
      if (controller.signal.aborted || disposed || token !== generation || version !== searchVersion) return;
      search = { error: error.message }; renderTree();
    } finally { pending.delete(controller); }
  }
  function setTreeVisible(visible) {
    layout.classList.toggle('file-tree-hidden', !visible);
    const button = $('[data-toggle-file-tree]'); button.setAttribute('aria-expanded', String(visible));
    button.title = t(visible ? 'Hide file tree' : 'Show file tree'); button.setAttribute('aria-label', button.title);
  }
  function selectFile(path, focus = false) {
    const entry = tabs.get(path); if (!entry) return;
    active = path; placeholder.hidden = true;
    for (const file of tabs.values()) {
      const selected = file === entry; file.wrapper.classList.toggle('active', selected); file.view.hidden = !selected;
      file.tab.setAttribute('aria-selected', String(selected)); file.tab.tabIndex = selected ? 0 : -1;
    }
    entry.wrapper.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (focus) entry.tab.focus(); renderTree();
    if (!entry.loading && entry.data) void loadFile(entry, true);
  }
  function closeFile(path) {
    const entry = tabs.get(path); if (!entry) return;
    const paths = [...tabs.keys()], index = paths.indexOf(path), selected = active === path, hadFocus = entry.wrapper.contains(doc.activeElement);
    entry.controller?.abort(); clearTimeout(entry.noticeTimer); tabs.delete(path); entry.wrapper.remove(); entry.view.remove();
    if (!tabs.size) { active = null; placeholder.hidden = false; renderTree(); if (hadFocus) $('[data-toggle-file-tree]').focus(); }
    else if (selected) selectFile(paths[index + 1] || paths[index - 1], true);
    else if (hadFocus) tabs.get(active)?.tab.focus();
  }
  function renderFile(entry) {
    const { data, body, status, toolbar } = entry;
    body.replaceChildren(); status.textContent = ''; toolbar.hidden = !data;
    if (entry.loading) { message(body, 'Loading file…'); return; }
    if (entry.error) { message(body, entry.error, () => void loadFile(entry)); return; }
    if (!data) return;
    entry.download.href = `/api/files/download?${new URLSearchParams({ cwd, path: data.fileUrl })}`; entry.download.download = data.name;
    entry.copy.hidden = data.kind !== 'text'; entry.wrap.hidden = data.kind !== 'text';
    updateFileStatus(entry);
    if (data.kind === 'text') {
      const code = doc.createElement('div'); code.className = 'file-preview-code'; code.classList.toggle('wrap', entry.wrapped);
      code.style.setProperty('--file-gutter-w', `${Math.max(3, String(data.lineCount).length + 2)}ch`);
      const fragment = doc.createDocumentFragment();
      data.text.split(/\r\n|\n|\r/).forEach((text, index) => {
        const line = doc.createElement('div'); line.className = 'file-code-line';
        const number = doc.createElement('span'); number.className = 'file-line-number'; number.setAttribute('aria-hidden', 'true'); number.textContent = String(index + 1);
        const content = doc.createElement('code'); content.textContent = text || '\u200b'; line.append(number, content); fragment.append(line);
      });
      code.append(fragment); body.append(code);
      code.dataset.language = fileType(data.path).language || 'plaintext';
      void highlighter.highlight(data.path, data.text).then(lines => {
        if (!lines || disposed || tabs.get(entry.path) !== entry || entry.data !== data || !body.contains(code)) return;
        const contents = code.querySelectorAll('.file-code-line>code');
        if (contents.length !== lines.length) return;
        contents.forEach((content, index) => { content.innerHTML = lines[index] || '\u200b'; });
        code.dataset.highlighted = 'true';
      });
    } else if (data.kind === 'image') {
      const image = doc.createElement('img'); image.className = 'file-preview-image'; image.alt = data.name;
      image.src = `/api/images/local?${new URLSearchParams({ cwd, path: data.fileUrl, revision: data.revision || '' })}`;
      image.dataset.imageSrc = image.src; image.dataset.imageTitle = data.name;
      image.onerror = () => { if (body.contains(image)) { body.replaceChildren(); message(body, 'Image preview is unavailable', () => void loadFile(entry)); } };
      body.append(image);
    } else message(body, data.reason === 'too-large' || data.reason === 'too-many-lines' ? 'This file is too large to preview. Download it to view the full contents.' : 'Preview is unavailable for this file type. You can download the file.');
  }
  async function loadFile(entry, quiet = false) {
    if (quiet && pending.has(entry.controller)) return;
    entry.controller?.abort(); const controller = new AbortController(), token = generation;
    const previous = entry.data;
    entry.controller = controller; pending.add(controller);
    if (!quiet) { entry.loading = true; entry.error = null; entry.data = null; renderFile(entry); }
    try {
      const data = await request('preview', { path: entry.path, ...(quiet && previous?.revision ? { revision: previous.revision } : {}) }, controller);
      if (disposed || token !== generation || tabs.get(entry.path) !== entry || entry.controller !== controller) return;
      entry.loading = false; entry.error = null;
      if (data.unchanged) { updateFileStatus(entry); return; }
      if (quiet && previous?.kind === 'text' && data.kind === 'text' && previous.text === data.text && previous.encoding === data.encoding) {
        Object.assign(previous, data); updateFileStatus(entry); return;
      }
      const scroll = { top: entry.body.scrollTop, left: entry.body.scrollLeft };
      entry.data = data; renderFile(entry);
      if (quiet) { entry.body.scrollTop = scroll.top; entry.body.scrollLeft = scroll.left; }
    } catch (error) {
      if (controller.signal.aborted || disposed || token !== generation || tabs.get(entry.path) !== entry || entry.controller !== controller) return;
      entry.loading = false; entry.error = error.message;
      if (quiet && previous) entry.status.textContent = error.message;
      else renderFile(entry);
    } finally { pending.delete(controller); }
  }
  function openFile(path) {
    if (!cwd || disposed) return;
    if (tabs.has(path)) { selectFile(path); return; }
    const id = `${panel.id}-file-${++sequence}`, wrapper = doc.createElement('div'), tab = doc.createElement('button');
    wrapper.className = 'side-panel-tab-wrapper file-preview-tab-wrapper'; wrapper.title = path; wrapper.dataset.openFile = path;
    tab.type = 'button'; tab.className = 'side-panel-tab'; tab.id = id; tab.setAttribute('role', 'tab');
    tab.innerHTML = fileIcon(path); const label = doc.createElement('span'); label.textContent = nameOf(path); tab.append(label);
    const close = iconButton('x', 'Close file', () => closeFile(path)); close.classList.add('side-panel-tab-close'); close.dataset.closeFile = path;
    wrapper.append(tab, close); tabList.append(wrapper);
    const view = doc.createElement('section'); view.className = 'file-preview-pane'; view.id = `${id}-view`; view.setAttribute('role', 'tabpanel'); view.setAttribute('aria-labelledby', id);
    tab.setAttribute('aria-controls', view.id);
    const toolbar = doc.createElement('div'); toolbar.className = 'file-preview-toolbar';
    const filename = doc.createElement('span'); filename.className = 'file-preview-path'; filename.title = path; filename.textContent = path;
    const entry = { path, wrapper, tab, close, view, toolbar, wrapped: true };
    entry.copy = iconButton('copy', 'Copy file contents', async () => {
      if (entry.data?.kind !== 'text') return;
      const data = entry.data;
      try { await copyReplyText(data.text); if (disposed || tabs.get(path) !== entry || entry.data !== data) return; entry.status.textContent = t('Copied'); }
      catch { if (disposed || tabs.get(path) !== entry || entry.data !== data) return; entry.status.textContent = t('Could not copy file contents'); }
      clearTimeout(entry.noticeTimer); entry.noticeTimer = setTimeout(() => { if (tabs.get(path) === entry) updateFileStatus(entry); }, 1800);
    });
    entry.wrap = iconButton('wrapText', 'Toggle word wrap', () => { entry.wrapped = !entry.wrapped; entry.body.querySelector('.file-preview-code')?.classList.toggle('wrap', entry.wrapped); entry.wrap.setAttribute('aria-pressed', String(entry.wrapped)); });
    entry.wrap.setAttribute('aria-pressed', 'true');
    entry.reload = iconButton('refreshCw', 'Reload file', () => void loadFile(entry));
    entry.download = doc.createElement('a'); entry.download.className = 'file-preview-download'; entry.download.dataset.fileDownload = path; entry.download.dataset.fileLabel = 'Download file'; entry.download.title = t('Download file'); entry.download.setAttribute('aria-label', entry.download.title); entry.download.innerHTML = codexIcon('arrowUp');
    toolbar.append(filename, entry.copy, entry.wrap, entry.reload, entry.download);
    entry.body = doc.createElement('div'); entry.body.className = 'file-preview-body'; entry.body.tabIndex = 0; entry.body.setAttribute('aria-label', t('File contents'));
    entry.status = doc.createElement('div'); entry.status.className = 'file-preview-status'; entry.status.setAttribute('role', 'status');
    view.append(toolbar, entry.body, entry.status); views.append(view); tabs.set(path, entry); tab.onclick = () => selectFile(path);
    selectFile(path); void loadFile(entry);
    if (doc.documentElement.classList.contains('mobile-device') || doc.defaultView.matchMedia?.('(max-width:720px)').matches) setTreeVisible(false);
  }
  function updateFileStatus(entry) {
    if (!entry.data) return;
    const data = entry.data;
    entry.status.textContent = data.kind === 'text' ? `${fileType(data.path).label} · ${data.encoding} · ${t('{count} lines', { count: data.lineCount })} · ${fileSize(data.size)} · ${t('Read-only')}` : `${fileSize(data.size)} · ${t('Read-only')}`;
  }
  const canRefresh = () => !disposed && cwd && visible && doc.visibilityState !== 'hidden';
  function scheduleRefresh(delay = refreshInterval) {
    clearTimeout(refreshTimer);
    if (canRefresh()) refreshTimer = setTimeout(async () => {
      if (!canRefresh()) return;
      await refresh({ background: true }); scheduleRefresh();
    }, delay);
  }
  async function refresh({ background = false } = {}) {
    if (!cwd || disposed || refreshing || background && !canRefresh()) return;
    refreshing = true; const token = generation;
    try {
      // Check only expanded, visible directories; unchanged revisions need stat() only.
      const paths = [...expanded].filter(path => {
        let parent = path;
        while (parent.includes('/')) { parent = parent.slice(0, parent.lastIndexOf('/')); if (!expanded.has(parent)) return false; }
        return !path || rowButtons.has(path);
      });
      for (let i = 0; i < paths.length; i += 4) {
        if (token !== generation || disposed || background && !canRefresh()) return;
        await Promise.all(paths.slice(i, i + 4).map(path => loadDirectory(path, true, background)));
      }
      if (token !== generation || disposed) return;
      const work = [];
      if (query && (!background || Date.now() - lastSearch >= 10000) && !pending.has(searchController)) work.push(runSearch(background));
      if (tabs.has(active)) work.push(loadFile(tabs.get(active), background));
      await Promise.all(work);
    } finally { refreshing = false; }
  }
  function setVisible(value) {
    if (visible === Boolean(value)) return;
    visible = Boolean(value); scheduleRefresh(0);
  }
  function onVisibilityChange() { scheduleRefresh(0); }
  function onFocus() { if (canRefresh()) scheduleRefresh(0); }
  doc.addEventListener('visibilitychange', onVisibilityChange);
  doc.defaultView.addEventListener('focus', onFocus);
  function localize() {
    $('[data-files-empty]').textContent = t('Choose a project or open a chat to browse its files.');
    placeholder.textContent = t('Select a file from the tree to preview it.');
    filter.placeholder = t('Filter files…'); filter.setAttribute('aria-label', t('Filter files'));
    tree.setAttribute('aria-label', t('Project files')); tabList.setAttribute('aria-label', t('Open files'));
    const refreshButton = $('[data-refresh-files]'); refreshButton.title = t('Refresh files'); refreshButton.setAttribute('aria-label', refreshButton.title);
    for (const button of panel.querySelectorAll('[data-file-label]')) { button.title = t(button.dataset.fileLabel); button.setAttribute('aria-label', button.title); }
    for (const entry of tabs.values()) { entry.body.setAttribute('aria-label', t('File contents')); if (['text', 'image'].includes(entry.data?.kind)) updateFileStatus(entry); else renderFile(entry); }
    setTreeVisible(!layout.classList.contains('file-tree-hidden')); renderTree();
  }
  function setCwd(value = getCwd()) {
    value = value || null; if (disposed || value === cwd) return;
    generation++; for (const controller of pending) controller.abort(); pending.clear();
    clearTimeout(searchTimer); searchVersion++; searchController = null; query = ''; filter.value = ''; search = null;
    for (const entry of tabs.values()) { clearTimeout(entry.noticeTimer); entry.wrapper.remove(); entry.view.remove(); }
    tabs.clear(); directories.clear(); expanded.clear(); expanded.add(''); active = null; treeFocus = null; cwd = value;
    $('[data-files-empty]').hidden = Boolean(cwd); layout.hidden = !cwd; placeholder.hidden = false;
    $('[data-file-root]').textContent = cwd ? nameOf(cwd) : ''; $('[data-file-root]').title = cwd || '';
    setTreeVisible(true); renderTree(); if (cwd) void loadDirectory(''); scheduleRefresh();
  }
  filter.oninput = () => {
    clearTimeout(searchTimer); searchController?.abort(); searchVersion++;
    query = filter.value.trim(); search = null; renderTree();
    if (query) searchTimer = setTimeout(() => void runSearch(), 180);
  };
  filter.onkeydown = event => { if (event.key === 'Escape' && filter.value) { event.preventDefault(); event.stopPropagation(); filter.value = ''; filter.oninput(); } };
  $('[data-refresh-files]').onclick = () => void refresh();
  $('[data-toggle-file-tree]').onclick = () => setTreeVisible(layout.classList.contains('file-tree-hidden'));
  tree.addEventListener('keydown', event => {
    const row = event.target.closest('[data-file-path]'); if (!row || !tree.contains(row)) return;
    const paths = [...rowButtons.keys()], index = paths.indexOf(row.dataset.filePath), path = paths[index];
    if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); focusRow(paths[event.key === 'Home' ? 0 : event.key === 'End' ? paths.length - 1 : Math.max(0, Math.min(paths.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]);
    } else if (event.key === 'ArrowRight' && row.dataset.fileKind === 'folder') {
      event.preventDefault(); if (query || !expanded.has(path)) row.click(); else if (paths[index + 1]?.startsWith(path + '/')) focusRow(paths[index + 1]);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault(); if (row.dataset.fileKind === 'folder' && expanded.has(path)) row.click(); else { const parent = path.split('/').slice(0, -1).join('/'); if (rowButtons.has(parent)) focusRow(parent); }
    }
  });
  tabList.addEventListener('keydown', event => {
    if (event.target.getAttribute('role') !== 'tab') return;
    const paths = [...tabs.keys()], index = paths.indexOf(active);
    if (event.key === 'Delete') { event.preventDefault(); closeFile(active); }
    else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); selectFile(paths[event.key === 'Home' ? 0 : event.key === 'End' ? paths.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + paths.length) % paths.length], true);
    }
  });
  localize(); setCwd();
  return { setCwd, setVisible, localize, refresh, openFile, dispose() { disposed = true; generation++; clearTimeout(searchTimer); clearTimeout(refreshTimer); highlighter.dispose(); doc.removeEventListener('visibilitychange', onVisibilityChange); doc.defaultView.removeEventListener('focus', onFocus); for (const entry of tabs.values()) clearTimeout(entry.noticeTimer); for (const controller of pending) controller.abort(); pending.clear(); panel.remove(); } };
}
