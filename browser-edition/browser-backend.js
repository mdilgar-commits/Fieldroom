// Fieldroom browser edition: replaces the Node server with storage in this browser
// (IndexedDB), and replaces blocked browser dialogs with on-page dialogs.
(() => {
  const realFetch = window.fetch.bind(window);
  const initialState = () => ({ project: { id: 'project-main', name: 'New construction project', site: '', drawingVersion: '', updatedAt: '', rooms: [], mapConfig: { documentId: '', page: 1 } }, documents: [], suggestions: [], roomSuggestions: [] });
  const MAX_FILE = 8 * 1024 * 1024;
  const MIME_BY_EXT = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  const safeName = n => String(n || 'upload').split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'upload';
  const extOf = n => { const i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i).toLowerCase(); };
  const newId = () => crypto.randomUUID();

  // ---- Storage: IndexedDB, with an in-memory fallback when storage is blocked ----
  const memory = new Map();
  let dbPromise;
  function openDb() {
    if (!dbPromise) dbPromise = new Promise(resolve => {
      try {
        const req = indexedDB.open('fieldroom', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
    return dbPromise;
  }
  async function get(key) {
    const db = await openDb();
    if (!db) return memory.get(key);
    return new Promise(resolve => { try { const r = db.transaction('kv').objectStore('kv').get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(memory.get(key)); } catch { resolve(memory.get(key)); } });
  }
  async function put(key, value) {
    memory.set(key, value);
    const db = await openDb();
    if (!db) return;
    await new Promise(resolve => { try { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(value, key); tx.oncomplete = tx.onerror = tx.onabort = () => resolve(); } catch { resolve(); } });
  }
  async function del(key) {
    memory.delete(key);
    const db = await openDb();
    if (!db) return;
    await new Promise(resolve => { try { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(key); tx.oncomplete = tx.onerror = tx.onabort = () => resolve(); } catch { resolve(); } });
  }
  const readState = async () => (await get('state')) || initialState();
  const writeState = s => put('state', structuredClone(s));

  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const base64ToBlob = (b64, type) => { const bin = atob(String(b64 || '')); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return new Blob([bytes], { type }); };

  async function handle(path, method, body) {
    if (method === 'GET' && path === '/api/config') return json(200, { drawingMap: true, authRequired: false, firebaseApiKey: '', firebaseAuthDomain: '' });
    if (method === 'GET' && path === '/api/health') return json(200, { ok: true, geminiConfigured: true, cloudMode: false, authRequired: false });
    if (method === 'GET' && path === '/api/account') return json(200, { ok: true, email: 'local@fieldroom.dev', role: 'project_manager', accountType: 'project_manager' });
    let state = await readState();
    if (method === 'GET' && path === '/api/state') return json(200, state);
    if (method === 'PUT' && path === '/api/state') {
      const incoming = JSON.parse(body || 'null');
      if (!incoming || typeof incoming !== 'object' || !incoming.project || !Array.isArray(incoming.project.rooms)) return json(400, { error: 'Project state is not valid.' });
      const storageById = new Map((state.documents || []).map(d => [d.id, d.storageName]));
      state = { ...state, ...incoming, documents: (incoming.documents || []).map(d => ({ ...d, storageName: d.storageName || storageById.get(d.id) })) };
      await writeState(state);
      return json(200, { ok: true, revision: 0 });
    }
    if (method === 'POST' && path === '/api/upload') {
      const b = JSON.parse(body || '{}'), name = safeName(b.name), ext = extOf(name);
      if (!MIME_BY_EXT[ext]) return json(415, { error: 'Supported files: PDF, DOCX, TXT, MD, CSV, PNG, JPG, and WEBP.' });
      const mimeType = b.mimeType || MIME_BY_EXT[ext], blob = base64ToBlob(b.data, mimeType);
      if (!blob.size || blob.size > MAX_FILE) return json(413, { error: 'File is empty or exceeds the 8 MB limit.' });
      const doc = { id: newId(), name, mimeType, category: b.category === 'floorplan' ? 'floorplan' : 'supporting', size: blob.size, uploadedAt: new Date().toISOString(), status: 'uploaded', storageName: `${newId()}${ext}` };
      await put('file:uploads/' + doc.storageName, blob);
      state.documents.push(doc); state.project.updatedAt = new Date().toISOString(); await writeState(state);
      return json(201, { document: { ...doc, storageName: undefined }, state });
    }
    if (method === 'POST' && path === '/api/extract') {
      const b = JSON.parse(body || '{}'), docs = state.documents.filter(d => (b.documentIds || []).includes(d.id));
      if (!docs.length) return json(400, { error: 'Choose at least one uploaded document.' });
      const mapDoc = state.documents.find(d => d.id === b.mapDocumentId);
      if (!mapDoc || (mapDoc.category !== 'floorplan' && state.project.mapConfig?.documentId !== mapDoc.id) || !['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(mapDoc.mimeType)) return json(400, { error: 'Upload and select a full floor plan before extracting room requirements.' });
      const withFiles = [];
      for (const d of docs) { const blob = await get('file:uploads/' + d.storageName); if (blob) withFiles.push({ doc: d, blob }); }
      let extracted;
      try { extracted = await window.frExtractWithClaude(withFiles, { mapDocumentId: b.mapDocumentId, mapPage: b.mapPage, knownRooms: state.project.rooms || [], projectProfile: state.project || {} }); }
      catch (e) { return json(502, { error: e.message }); }
      finally { window.frProgress(null); }
      const sourceNames = docs.map(d => d.name);
      const newRoomSuggestions = (extracted.rooms || []).map(room => ({ id: newId(), roomNumber: String(room.number || '').trim(), roomName: String(room.name || '').trim(), level: String(room.level || '').trim(), planPage: Number(room.planPage || b.mapPage || 1), mapBox: room.mapBox && typeof room.mapBox === 'object' ? room.mapBox : null, mapDocumentId: b.mapDocumentId || null, sources: sourceNames, status: 'pending' })).filter(room => room.roomNumber || room.roomName);
      state.roomSuggestions = state.roomSuggestions || []; state.roomSuggestions.push(...newRoomSuggestions);
      const makeSuggestion = (item, room = null, scope = 'room') => ({ id: newId(), scope, roomNumber: String(room?.number || '').trim(), roomName: String(room?.name || '').trim(), level: String(room?.level || '').trim(), title: String(item.title || '').trim(), trade: String(item.trade || '').trim(), sourceDocument: String(item.sourceDocument || '').trim(), sourcePage: Number(item.sourcePage) || null, sourceReference: String(item.sourceReference || '').trim(), notes: String(item.notes || '').trim(), sources: sourceNames, status: 'pending', planPage: Number(room?.planPage || b.mapPage || 1), mapBox: room?.mapBox && typeof room.mapBox === 'object' ? room.mapBox : null, mapDocumentId: scope === 'room' ? b.mapDocumentId || null : null });
      const roomItems = (extracted.rooms || []).flatMap(room => (room.deliverables || []).map(item => makeSuggestion(item, room, 'room'))).filter(s => s.title);
      const generalItems = (extracted.generalDeliverables || []).map(item => makeSuggestion(item, null, 'general')).filter(s => s.title);
      const newSuggestions = [...generalItems, ...roomItems];
      state.suggestions.push(...newSuggestions);
      for (const d of docs) d.status = 'extracted';
      state.project.updatedAt = new Date().toISOString(); await writeState(state);
      return json(200, { suggestions: newSuggestions, roomSuggestions: newRoomSuggestions, warnings: extracted.warnings || [], projectInformation: extracted.projectInformation || {}, subcontractors: Array.isArray(extracted.subcontractors) ? extracted.subcontractors : [], state });
    }
    if (method === 'POST' && path === '/api/project/reset') {
      const current = state.project || {}, project = { id: current.id || newId(), name: current.name || 'New project', updatedAt: new Date().toISOString(), rooms: [], mapConfig: { documentId: '', page: 1 } };
      const media = new Set();
      for (const d of [...(current.generalDeliverables || []), ...(current.rooms || []).flatMap(r => r.deliverables || [])]) for (const p of d.photos || []) if (String(p.url || '').startsWith('/media/')) media.add(p.url.slice(7));
      const docs = state.documents || [];
      const next = { project, documents: [], suggestions: [], roomSuggestions: [], revision: 0 };
      if (state.projectLibrary?.projects) { const lib = state.projectLibrary; next.projectLibrary = { ...lib, activeId: project.id, projects: lib.projects.map(e => e.id === project.id ? { id: project.id, name: project.name, data: { ...next, project, revision: 0 } } : e) }; }
      await writeState(next);
      for (const d of docs) if (d.storageName) await del('file:uploads/' + d.storageName);
      for (const m of media) await del('file:media/' + m);
      return json(200, { ok: true, state: next });
    }
    if (path.startsWith('/api/document/')) {
      const docId = decodeURIComponent(path.slice('/api/document/'.length)), doc = state.documents.find(d => d.id === docId);
      if (!doc) return json(404, { error: 'Document not found.' });
      if (method === 'GET') {
        const blob = await get('file:uploads/' + doc.storageName);
        if (!blob) return json(404, { error: 'The stored file for this document is missing in this browser.' });
        return new Response(blob, { status: 200, headers: { 'content-type': doc.mimeType || 'application/octet-stream' } });
      }
      if (method === 'DELETE') {
        const next = { ...state, documents: state.documents.filter(d => d.id !== docId), project: { ...state.project, updatedAt: new Date().toISOString() } };
        if (next.project.mapConfig?.documentId === docId) next.project.mapConfig = { documentId: '', page: 1 };
        for (const room of next.project.rooms || []) if (room.mapDocumentId === docId) room.mapDocumentId = null;
        await writeState(next); await del('file:uploads/' + doc.storageName);
        return json(200, { ok: true, documentId: docId, warning: '', state: next });
      }
    }
    if (method === 'POST' && path === '/api/photo') {
      const b = JSON.parse(body || '{}'), type = String(b.mimeType || 'image/jpeg'), ext = type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : '.jpg';
      const blob = base64ToBlob(b.data, type);
      if (!blob.size || blob.size > MAX_FILE) return json(413, { error: 'Photo is empty or exceeds the upload limit.' });
      const mediaId = newId(); await put('file:media/' + mediaId + ext, blob);
      return json(201, { id: mediaId, url: `/media/${mediaId}${ext}` });
    }
    if (method === 'GET' && path.startsWith('/media/')) {
      const blob = await get('file:media/' + path.slice(7));
      return blob ? new Response(blob, { status: 200, headers: { 'content-type': blob.type || 'image/jpeg' } }) : json(404, { error: 'Not found' });
    }
    return json(404, { error: 'Not found' });
  }

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (typeof url === 'string' && (url.startsWith('/api/') || url.startsWith('/media/'))) {
      try { return await handle(url.split('?')[0], (init.method || 'GET').toUpperCase(), init.body); }
      catch (e) { return json(500, { error: e.message || 'Unexpected error.' }); }
    }
    return realFetch(input, init);
  };

  // ---- On-page dialogs (the viewer blocks alert/confirm/prompt) ----
  function dialog({ message, input = false, value = '', cancel = true }) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'fr-dialog-overlay';
      overlay.innerHTML = `<form class="fr-dialog" role="dialog" aria-modal="true"><p class="fr-dialog-msg"></p>${input ? '<input class="fr-dialog-input" id="fr-dialog-input" type="text">' : ''}<div class="fr-dialog-actions">${cancel ? '<button type="button" class="btn secondary" data-cancel>Cancel</button>' : ''}<button type="submit" class="btn">OK</button></div></form>`;
      overlay.querySelector('.fr-dialog-msg').textContent = message;
      const field = overlay.querySelector('input');
      if (field) field.value = value;
      const done = result => { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(result); };
      const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done(input ? null : false); } };
      overlay.querySelector('form').onsubmit = e => { e.preventDefault(); done(input ? field.value : true); };
      overlay.querySelector('[data-cancel]')?.addEventListener('click', () => done(input ? null : false));
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
      (field || overlay.querySelector('button[type=submit]')).focus();
      if (field) field.select();
    });
  }
  // PDF.js worker, shipped as base64 text and started from a blob: URL.
  let workerUrlPromise;
  window.frWorkerUrl = () => workerUrlPromise ||= realFetch(new URL('vendor/pdfjs/pdf.worker.b64.txt', document.baseURI).href)
    .then(r => { if (!r.ok) throw new Error('Could not load the PDF viewer.'); return r.text(); })
    .then(b64 => URL.createObjectURL(base64ToBlob(b64.trim(), 'text/javascript')));
  // File downloads go through the claude.ai viewer's download permission.
  window.frSaveFile = async (filename, data) => {
    const downloads = await window.claude?.use?.('downloads');
    if (!downloads) { window.frAlert('Downloading files is not available in this view.'); return; }
    try { await downloads.save({ filename, data }); }
    catch (e) { if (e?.code !== 'declined') window.frAlert('The file could not be saved: ' + (e?.message || 'unknown error')); }
  };
  // A progress box that stays on screen during long steps. frProgress(null) closes it.
  window.frProgress = text => {
    let box = document.getElementById('fr-progress');
    if (text == null) { box?.remove(); return; }
    if (!box) {
      box = document.createElement('div'); box.id = 'fr-progress'; box.className = 'fr-dialog-overlay';
      box.innerHTML = '<div class="fr-dialog" role="status" aria-live="polite"><p class="fr-dialog-msg" style="font-weight:700">Reading your documents</p><p class="fr-dialog-msg" id="fr-progress-text"></p><div class="fr-spinner" aria-hidden="true"></div></div>';
      document.body.appendChild(box);
    }
    box.querySelector('#fr-progress-text').textContent = text;
  };
  window.frAsk = (message, value = '') => dialog({ message, input: true, value });
  window.frConfirm = message => dialog({ message });
  window.frAlert = message => dialog({ message, cancel: false });
})();
