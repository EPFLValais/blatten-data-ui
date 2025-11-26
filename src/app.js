const API_BASE = '/s3';
let currentPath = '/';
let files = [];

// Toggle downloads section
function toggleDownloads() {
  const header = document.getElementById('downloadsHeader');
  const content = document.getElementById('downloadsContent');
  header.classList.toggle('expanded');
  content.classList.toggle('expanded');
}

// Format file size
function formatSize(bytes) {
  if (bytes === 0 || !bytes) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

// Format date
function formatDate(dateStr) {
  if (!dateStr || dateStr.startsWith('0001')) return '-';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Get file icon
function getIcon(item) {
  if (item.type === 'FOLDER') return '&#128193;';
  const ext = item.name.split('.').pop().toLowerCase();
  const icons = {
    pdf: '&#128196;', doc: '&#128196;', docx: '&#128196;', txt: '&#128196;',
    jpg: '&#128247;', jpeg: '&#128247;', png: '&#128247;', gif: '&#128247;', svg: '&#128247;', tif: '&#128247;', tiff: '&#128247;',
    mp4: '&#127909;', mov: '&#127909;', avi: '&#127909;', mkv: '&#127909;',
    zip: '&#128230;', tar: '&#128230;', gz: '&#128230;', rar: '&#128230;', '7z': '&#128230;',
    csv: '&#128202;', xls: '&#128202;', xlsx: '&#128202;',
    json: '&#128203;', xml: '&#128203;', yml: '&#128203;', yaml: '&#128203;',
    md5: '&#128274;', sha256: '&#128274;', hash: '&#128274;',
  };
  return icons[ext] || '&#128196;';
}

// Update breadcrumb
function updateBreadcrumb() {
  const parts = currentPath.split('/').filter(Boolean);
  const breadcrumb = document.getElementById('fileBreadcrumb');
  if (parts.length === 0) {
    breadcrumb.style.display = 'none';
    return;
  }
  breadcrumb.style.display = 'flex';
  let html = '<a href="#" data-path="/">&larr; Back</a>';
  let path = '';
  for (const part of parts) {
    path += '/' + part;
    html += ' <span>/</span> <a href="#" data-path="' + path + '/">' + part + '</a>';
  }
  document.getElementById('fileBreadcrumb').innerHTML = html;

  document.querySelectorAll('#fileBreadcrumb a').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      navigateTo(a.dataset.path);
    });
  });
}

// Sort files (folders first, then by name)
function getSortedFiles() {
  return [...files].sort((a, b) => {
    if (a.type === 'FOLDER' && b.type !== 'FOLDER') return -1;
    if (a.type !== 'FOLDER' && b.type === 'FOLDER') return 1;
    return a.name.localeCompare(b.name);
  });
}

// Render file list
function renderFiles() {
  const container = document.getElementById('fileList');

  if (files.length === 0) {
    container.innerHTML = '<div class="empty">This folder is empty</div>';
    return;
  }

  const sorted = getSortedFiles();

  container.innerHTML = sorted.map((item) => {
    const isFolder = item.type === 'FOLDER';
    const displayName = item.name.replace(/\/$/, '');

    // Generate unique ID for this file's metadata toggle
    const metaId = 'meta-' + item.path.replace(/[^a-zA-Z0-9]/g, '-');

    // Metadata toggle (arrow on left) and inline info
    const metaToggle = isFolder ? '<span style="width:0.8rem"></span>' : `<span class="file-meta-toggle" data-target="${metaId}"><span class="arrow">&#9654;</span></span>`;

    const fileInfo = isFolder ? '' : `
      <div class="file-info">
        <span>${formatSize(item.size)}</span>
        <span>${formatDate(item.lastModified)}</span>
      </div>
    `;

    const metaContent = isFolder ? '' : `
      <div class="file-meta" id="${metaId}">
        Lorem ipsum dolor sit amet, consectetur adipiscing elit.
      </div>
    `;

    return `
      <div class="file-item ${isFolder ? 'folder' : 'file'}">
        <div class="file-row">
          ${metaToggle}
          <div class="file-name" ${isFolder ? 'data-path="' + item.path + '"' : ''}>
            <span class="icon">${getIcon(item)}</span>
            <span class="name">${isFolder ? displayName : '<a href="' + API_BASE + item.path + '" target="_blank" rel="noopener">' + displayName + '</a>'}</span>
          </div>
          ${fileInfo}
        </div>
        ${metaContent}
      </div>
    `;
  }).join('');

  // Folder click handlers
  container.querySelectorAll('.folder .file-name').forEach(el => {
    el.addEventListener('click', () => navigateTo(el.dataset.path));
  });

  // Metadata toggle handlers
  container.querySelectorAll('.file-meta-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const targetId = toggle.dataset.target;
      const metaEl = document.getElementById(targetId);
      if (metaEl) {
        toggle.classList.toggle('expanded');
        metaEl.classList.toggle('expanded');
      }
    });
  });
}

// Navigation
async function loadPath(path) {
  currentPath = path;
  updateBreadcrumb();

  document.getElementById('fileList').innerHTML = '<div class="loading"><div class="spinner"></div>Loading files...</div>';
  document.getElementById('error').style.display = 'none';

  try {
    const response = await fetch(API_BASE + path, {
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) throw new Error('Failed to load directory');

    files = await response.json();

    // Update file count in header
    const totalFiles = files.filter(f => f.type !== 'FOLDER').length;
    const totalFolders = files.filter(f => f.type === 'FOLDER').length;
    let countText = '';
    if (totalFiles > 0 || totalFolders > 0) {
      const parts = [];
      if (totalFiles > 0) parts.push(totalFiles + ' file' + (totalFiles !== 1 ? 's' : ''));
      if (totalFolders > 0) parts.push(totalFolders + ' folder' + (totalFolders !== 1 ? 's' : ''));
      countText = '(' + parts.join(', ') + ')';
    }
    document.getElementById('fileCount').textContent = countText;

    renderFiles();
  } catch (err) {
    document.getElementById('error').textContent = err.message;
    document.getElementById('error').style.display = 'block';
    document.getElementById('fileList').innerHTML = '<div class="empty">Failed to load files</div>';
  }
}

function navigateTo(path) {
  loadPath(path);
}

// Initial load
loadPath('/');
