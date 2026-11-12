/* =====================================================
   LycéeTN — app.js
   Cours, Devoirs & Séries pour les élèves tunisiens

   DEUX MODES :
   - Cloud (config.js rempli)  → Supabase : tout le monde
     voit et partage les mêmes ressources + fichiers
   - Local (config.js vide)    → localStorage + IndexedDB
     (données propres à cet appareil)
===================================================== */

/* ---------- Configuration Supabase ---------- */
const SB = window.SUPABASE_CONFIG || { url: '', key: '' };
const isCloud = !!(SB.url && SB.key);
const BUCKET = 'fichiers';
const sbHeaders = { apikey: SB.key, Authorization: `Bearer ${SB.key}`, 'Content-Type': 'application/json' };

const STORE_KEY = 'lyceetn_data_v1';
const MAX_FILES = 8;
const MAX_SIZE = 15 * 1024 * 1024; // 15 Mo par fichier

/* ---------- État ---------- */
let items = [];
let selectedFiles = []; // fichiers choisis dans le formulaire
let filters = { q: '', type: 'all', niveau: 'all', section: 'all', matiere: 'all' };
let currentURL = null; // URL d'objet du visualiseur (mode local)

/* ============== MODE LOCAL (fallback) ============== */
function loadLocal() {
  try { items = JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch { items = []; }
}
function saveLocal() {
  localStorage.setItem(STORE_KEY, JSON.stringify(items));
}

/* IndexedDB : fichiers (images / PDF) en binaire */
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('lyceetn_files', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(id, blob) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(blob, id);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(id) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const rq = db.transaction('files', 'readonly').objectStore('files').get(id);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function idbDel(id) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').delete(id);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

function seedIfEmpty() {
  if (items.length > 0) return;
  const today = new Date().toISOString().slice(0, 10);
  items = [
    {
      id: crypto.randomUUID(), type: 'cours', title: 'Fonctions limites — résumé complet',
      niveau: '3ème année', section: 'Sciences expérimentales', matiere: 'Mathématiques',
      desc: "Tout le chapitre résumé : limites, comparaisons, asymptotes + exemples types du bac.",
      link: '', files: [], author: 'M. Salah', date: today
    },
    {
      id: crypto.randomUUID(), type: 'devoir', title: 'Devoir de synthèse n°1 — Sciences physiques',
      niveau: '4ème année', section: 'Mathématiques', matiere: 'Sciences physiques',
      desc: "Devoir de synthèse de novembre avec corrigé. Exercices sur l'oscillateur et la désintégration radioactive.",
      link: '', files: [], author: 'Anis', date: today
    },
    {
      id: crypto.randomUUID(), type: 'serie', title: 'Série n°3 — Structures de données (Piles & Files)',
      niveau: '4ème année', section: 'Informatique', matiere: 'Informatique',
      desc: "Série d'exercices sur les piles, files et listes chaînées avec algorithmes en Python.",
      link: '', files: [], author: 'Ines', date: today
    }
  ];
  saveLocal();
}

/* ============== MODE CLOUD (Supabase) ============== */
function rowToItem(row) {
  return {
    id: row.id, type: row.type, title: row.title,
    niveau: row.niveau, section: row.section, matiere: row.matiere,
    desc: row.description || '', link: row.link || '',
    files: row.files || [], author: row.author || 'Anonyme', date: row.date
  };
}

async function cloudList() {
  const r = await fetch(`${SB.url}/rest/v1/ressources?select=*&order=date.desc,id.desc`, { headers: sbHeaders });
  if (!r.ok) throw new Error('list: ' + (await r.text()));
  return (await r.json()).map(rowToItem);
}

async function cloudAdd(item, files, onProgress) {
  /* 1) upload des fichiers vers Supabase Storage */
  const metas = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const fid = crypto.randomUUID();
    const path = `${item.id}/${fid}-${f.name.replace(/[^\w.\-() ]+/g, '_')}`;
    const r = await fetch(`${SB.url}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: { apikey: SB.key, Authorization: `Bearer ${SB.key}`, 'Content-Type': f.type || 'application/octet-stream' },
      body: f
    });
    if (!r.ok) throw new Error(`upload ${f.name} : ${await r.text()}`);
    metas.push({
      id: fid, name: f.name, type: f.type, size: f.size, path,
      url: `${SB.url}/storage/v1/object/public/${BUCKET}/${path}`
    });
    onProgress?.(metas.length, files.length);
  }
  /* 2) insertion de la ressource */
  const row = {
    id: item.id, type: item.type, title: item.title,
    niveau: item.niveau, section: item.section, matiere: item.matiere,
    description: item.desc, link: item.link, files: metas,
    author: item.author, date: item.date
  };
  const r2 = await fetch(`${SB.url}/rest/v1/ressources`, {
    method: 'POST', headers: sbHeaders, body: JSON.stringify(row)
  });
  if (!r2.ok) throw new Error('insert: ' + (await r2.text()));
  item.files = metas;
  return item;
}

async function cloudDelete(item) {
  /* suppression des fichiers du storage */
  for (const f of item.files || []) {
    if (f.path) {
      await fetch(`${SB.url}/storage/v1/object/${BUCKET}/${f.path}`, {
        method: 'DELETE', headers: { apikey: SB.key, Authorization: `Bearer ${SB.key}` }
      });
    }
  }
  const r = await fetch(`${SB.url}/rest/v1/ressources?id=eq.${item.id}`, {
    method: 'DELETE', headers: sbHeaders
  });
  if (!r.ok) throw new Error('delete: ' + (await r.text()));
}

/* ============== COUCHE DE DONNÉES UNIFIÉE ============== */
async function loadItems() {
  if (isCloud) {
    items = await cloudList();
  } else {
    loadLocal();
    seedIfEmpty();
  }
}

/* ---------- Utilitaires ---------- */
const $ = (sel) => document.querySelector(sel);
const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const TYPE_LABEL = { cours: '📖 Cours', devoir: '📝 Devoir', serie: '✏️ Série' };
const isImage = (f) => (f.type || '').startsWith('image/');

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2600);
}
function fmtSize(bytes) {
  if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' Mo';
  return Math.max(1, Math.round(bytes / 1024)) + ' Ko';
}

/* ---------- Cache des miniatures ---------- */
const thumbCache = new Map();
async function thumbURL(file) {
  if (file.url) return file.url; // mode cloud : URL publique directe
  if (thumbCache.has(file.id)) return thumbCache.get(file.id);
  try {
    const blob = await idbGet(file.id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    thumbCache.set(file.id, url);
    return url;
  } catch { return null; }
}

/* Remplit les <img data-thumb> après le rendu */
async function hydrateThumbs() {
  const nodes = [...document.querySelectorAll('img[data-thumb]')];
  for (const img of nodes) {
    const file = (items.flatMap((it) => it.files || []).find((f) => f.id === img.dataset.thumb));
    if (!file) continue;
    const url = await thumbURL(file);
    if (url) img.src = url;
    else img.closest('.thumb-btn')?.classList.add('broken');
  }
}

/* ---------- Filtrage ---------- */
function getFiltered() {
  const q = filters.q.trim().toLowerCase();
  return items
    .filter((it) => filters.type === 'all' || it.type === filters.type)
    .filter((it) => filters.niveau === 'all' || it.niveau === filters.niveau)
    .filter((it) => filters.section === 'all' || it.section === filters.section)
    .filter((it) => filters.matiere === 'all' || it.matiere === filters.matiere)
    .filter((it) =>
      !q ||
      it.title.toLowerCase().includes(q) ||
      (it.desc || '').toLowerCase().includes(q) ||
      it.matiere.toLowerCase().includes(q) ||
      it.section.toLowerCase().includes(q))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

/* ---------- Rendu ---------- */
function render() {
  const list = $('#list');
  const data = getFiltered();
  list.innerHTML = '';

  if (data.length === 0) {
    list.innerHTML = `
      <div class="empty">
        <div class="big">📚</div>
        <h3>Aucune ressource trouvée</h3>
        <p>Sois le premier à partager un cours, un devoir ou une série !<br>
        Clique sur <strong>« + Ajouter »</strong> en haut.</p>
      </div>`;
  } else {
    for (const it of data) {
      const files = it.files || [];
      const nb = files.length;
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="card-top">
          <span class="badge ${it.type}">${TYPE_LABEL[it.type].split(' ')[1]}</span>
          <span class="tag">${escapeHTML(it.niveau)}</span>
        </div>
        <h3>${escapeHTML(it.title)}</h3>
        ${it.desc ? `<p class="desc">${escapeHTML(it.desc)}</p>` : ''}
        <div class="tags">
          <span class="tag">🏛️ ${escapeHTML(it.section)}</span>
          <span class="tag">📕 ${escapeHTML(it.matiere)}</span>
        </div>
        ${nb ? `<div class="attach">
          ${files.map((f) => isImage(f) ? `
            <button class="thumb-btn" data-view="${escapeHTML(f.id)}" title="${escapeHTML(f.name)}">
              <img data-thumb="${escapeHTML(f.id)}" alt="${escapeHTML(f.name)}">
              <span class="thumb-label">🖼️ ${escapeHTML(f.name)}</span>
            </button>` : `
            <button class="icon-btn" data-view="${escapeHTML(f.id)}">
              📄 ${escapeHTML(f.name)} <small>(${fmtSize(f.size)})</small>
            </button>`).join('')}
        </div>` : ''}
        <div class="card-foot">
          <span class="meta">👤 ${escapeHTML(it.author || 'Anonyme')} · ${it.date || ''}</span>
          <div class="card-actions">
            ${it.link ? `<a class="icon-btn" href="${escapeHTML(it.link)}" target="_blank" rel="noopener">🔗 Lien</a>` : ''}
            <button class="icon-btn danger" data-del="${it.id}">🗑️</button>
          </div>
        </div>`;
      list.appendChild(card);
    }
  }

  /* miniatures des images */
  hydrateThumbs();

  /* compteurs + stats */
  $('#stat-cours').textContent = items.filter((i) => i.type === 'cours').length;
  $('#stat-devoirs').textContent = items.filter((i) => i.type === 'devoir').length;
  $('#stat-series').textContent = items.filter((i) => i.type === 'serie').length;
}

/* ---------- Modal d'ajout ---------- */
function openModal() { $('#modal').classList.add('open'); $('#in-title').focus(); }
function closeModal() { $('#modal').classList.remove('open'); }

/* Aperçu des fichiers choisis dans le formulaire */
function renderFilesPreview() {
  const box = $('#files-preview');
  box.innerHTML = selectedFiles.map((f, i) =>
    `<span class="file-chip">${isImage(f) ? '🖼️' : '📄'} ${escapeHTML(f.name)} <small>(${fmtSize(f.size)})</small>
     <button type="button" class="close" data-rmfile="${i}" style="width:18px;height:18px;font-size:.8rem;padding:0;">×</button>
    </span>`).join('');
}

/* ---------- Visualiseur plein écran ---------- */
async function openViewer(fileId) {
  const file = items.flatMap((it) => it.files || []).find((f) => f.id === fileId);
  if (!file) { toast('⚠️ Fichier introuvable', true); return; }
  closeViewer();
  const body = $('#viewer-body');
  $('#viewer-name').textContent = file.name;
  const dl = $('#viewer-download');
  let url, revoke = false;
  if (file.url) {
    url = file.url; // hébergé sur Supabase
  } else {
    try {
      const blob = await idbGet(file.id);
      if (!blob) { toast('⚠️ Fichier introuvable', true); return; }
      url = URL.createObjectURL(blob);
      revoke = true;
    } catch { toast('⚠️ Impossible de charger le fichier', true); return; }
  }
  currentURL = revoke ? url : null;
  dl.href = url;
  dl.download = file.name;
  body.innerHTML = isImage(file)
    ? `<img src="${escapeHTML(url)}" alt="${escapeHTML(file.name)}">`
    : `<iframe src="${escapeHTML(url)}" title="${escapeHTML(file.name)}"></iframe>`;
  $('#viewer').classList.add('open');
}
function closeViewer() {
  $('#viewer').classList.remove('open');
  $('#viewer-body').innerHTML = '';
  if (currentURL) { URL.revokeObjectURL(currentURL); currentURL = null; }
}

/* ---------- Événements ---------- */
$('#btn-add').addEventListener('click', openModal);
$('#btn-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); closeViewer(); } });

/* Choix de fichiers */
$('#in-files').addEventListener('change', (e) => {
  for (const f of e.target.files) {
    if (selectedFiles.length >= MAX_FILES) { toast(`⚠️ Maximum ${MAX_FILES} fichiers`, true); break; }
    if (f.size > MAX_SIZE) { toast(`⚠️ « ${f.name} » dépasse 15 Mo`, true); continue; }
    const ok = (f.type || '').startsWith('image/') || f.type === 'application/pdf';
    if (!ok) { toast(`⚠️ Formats acceptés : images et PDF`, true); continue; }
    selectedFiles.push(f);
  }
  e.target.value = '';
  renderFilesPreview();
});

/* Retirer un fichier de l'aperçu */
$('#files-preview').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-rmfile]');
  if (!btn) return;
  selectedFiles.splice(Number(btn.dataset.rmfile), 1);
  renderFilesPreview();
});

/* Soumission du formulaire */
$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const type = document.querySelector('input[name="type"]:checked').value;
  const link = $('#in-link').value.trim();
  const btn = $('#form button[type="submit"]');
  const btnText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Publication…';

  const item = {
    id: crypto.randomUUID(),
    type,
    title: $('#in-title').value.trim(),
    niveau: $('#in-niveau').value,
    section: $('#in-section').value,
    matiere: $('#in-matiere').value,
    desc: $('#in-desc').value.trim(),
    link: link && /^https?:\/\//.test(link) ? link : '',
    files: [],
    author: $('#in-author').value.trim() || 'Anonyme',
    date: new Date().toISOString().slice(0, 10)
  };

  try {
    if (isCloud) {
      await cloudAdd(item, selectedFiles, (n, tot) => { btn.textContent = `⏳ Fichier ${n}/${tot}…`; });
    } else {
      for (const f of selectedFiles) {
        const fid = crypto.randomUUID();
        await idbPut(fid, f);
        item.files.push({ id: fid, name: f.name, type: f.type, size: f.size });
      }
    }
    items.unshift(item);
    if (!isCloud) saveLocal();

    filters.type = item.type;
    $('#f-type').value = item.type;
    render();
    closeModal();
    $('#form').reset();
    selectedFiles = [];
    renderFilesPreview();
    const nb = item.files.length;
    toast(`✅ Ressource publiée${nb ? ` avec ${nb} fichier${nb > 1 ? 's' : ''}` : ''} ! 🇹🇳`);
  } catch (err) {
    console.error(err);
    toast('⚠️ Échec de publication : ' + (err.message || err).slice(0, 80), true);
  } finally {
    btn.disabled = false;
    btn.textContent = btnText;
  }
});

/* Suppression d'une ressource (et de ses fichiers) */
$('#list').addEventListener('click', (e) => {
  const viewBtn = e.target.closest('[data-view]');
  if (viewBtn) { openViewer(viewBtn.dataset.view); return; }
  const btn = e.target.closest('[data-del]');
  if (!btn) return;
  const id = btn.dataset.del;
  const item = items.find((i) => i.id === id);
  if (!item) return;
  if (confirm(`Supprimer « ${item.title} » et ses pièces jointes ?`)) {
    (isCloud ? cloudDelete(item) : Promise.all((item.files || []).map((f) => idbDel(f.id))))
      .then(() => {
        items = items.filter((i) => i.id !== id);
        if (!isCloud) saveLocal();
        render();
        toast('🗑️ Ressource supprimée');
      })
      .catch((err) => { console.error(err); toast('⚠️ Échec de suppression', true); });
  }
});

/* Fermeture du visualiseur */
$('#viewer-close').addEventListener('click', closeViewer);
$('#viewer').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeViewer(); });

/* Recherche live */
$('#search').addEventListener('input', (e) => { filters.q = e.target.value; render(); });

/* Filtres */
for (const [id, key] of [['#f-type', 'type'], ['#f-niveau', 'niveau'], ['#f-section', 'section'], ['#f-matiere', 'matiere']]) {
  $(id).addEventListener('change', (e) => { filters[key] = e.target.value; render(); });
}
$('#btn-reset').addEventListener('click', () => {
  filters = { q: '', type: 'all', niveau: 'all', section: 'all', matiere: 'all' };
  $('#search').value = '';
  $('#f-type').value = 'all';
  $('#f-niveau').value = 'all';
  $('#f-section').value = 'all';
  $('#f-matiere').value = 'all';
  render();
});

/* Onglets de la navbar */
document.querySelectorAll('.nav-link').forEach((a) => {
  a.addEventListener('click', () => {
    document.querySelectorAll('.nav-link').forEach((x) => x.classList.remove('active'));
    a.classList.add('active');
    const tab = a.dataset.tab;
    filters.type = tab === 'all' ? 'all' : tab === 'devoirs' ? 'devoir' : tab === 'series' ? 'serie' : 'cours';
    $('#f-type').value = filters.type;
    render();
  });
});

/* Export des métadonnées */
$('#btn-export').addEventListener('click', async () => {
  let meta = items.map((i) => ({ ...i, files: (i.files || []).map((f) => ({ name: f.name, url: f.url || '' })) }));
  const blob = new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'lyceetn-donnees.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('⬇️ Données exportées');
});

/* ---------- Init ---------- */
(async () => {
  $('#mode-note').textContent = isCloud
    ? '🌐 Connecté à la base partagée — les ajouts sont visibles par tous les élèves.'
    : '💾 Mode local : les ressources restent sur cet appareil (configure config.js pour partager).';
  try {
    await loadItems();
    render();
  } catch (err) {
    console.error(err);
    $('#mode-note').textContent = '⚠️ Impossible de contacter la base — vérifie config.js / ta connexion.';
    items = [];
    render();
  }
})();
