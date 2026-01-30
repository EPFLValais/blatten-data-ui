// STAC API-based file browser
const STAC_API = '/stac';
const INITIAL_ITEMS_LIMIT = 10;
let collections = [];
let currentCollection = null;
let items = [];
let totalItemCount = 0;
let allSensors = [];
let sensorsByCollection = {}; // Maps collection ID to list of sensors in that collection
let allSources = [];
let sourcesByCollection = {}; // Maps collection ID to list of sources in that collection
let processingLevelsByCollection = {}; // Maps collection ID to list of processing levels
let currentFilters = {
  search: '',           // client-side text filter
  sensor: '',           // existing
  source: '',           // maps to ?source=
  processingLevel: '',  // maps to ?processing_level=
  dateFrom: '',         // combined into ?datetime=
  dateTo: '',
  bbox: null            // [minLon, minLat, maxLon, maxLat] or null
};
let filterDebounceTimer = null;
let serverFilterDebounceTimer = null;
let currentExpandedItem = null; // Track currently expanded item for history

// History API integration for back button navigation
function pushHistoryState(collectionId = null, expandedItem = null) {
  const state = { collection: collectionId, expandedItem: expandedItem };
  let url = '#';
  if (collectionId) {
    url = `#collection=${collectionId}`;
    if (expandedItem) {
      url += `&item=${expandedItem}`;
    }
  }
  history.pushState(state, '', url);
}

function replaceHistoryState(collectionId = null, expandedItem = null) {
  const state = { collection: collectionId, expandedItem: expandedItem };
  let url = '#';
  if (collectionId) {
    url = `#collection=${collectionId}`;
    if (expandedItem) {
      url += `&item=${expandedItem}`;
    }
  }
  history.replaceState(state, '', url);
}

// Collapse an item by ID (used by popstate handler)
function collapseItem(itemId) {
  const row = document.querySelector(`.file-item.file[data-item-id="${itemId}"]`);
  if (row) {
    const targetId = row.dataset.metaTarget;
    const toggle = row.querySelector('.file-meta-toggle');
    const metaEl = document.getElementById(targetId);
    if (metaEl && metaEl.classList.contains('expanded')) {
      toggle?.classList.remove('expanded');
      metaEl.classList.remove('expanded');
    }
  }
  if (currentExpandedItem === itemId) {
    currentExpandedItem = null;
  }
}

// Expand an item by ID (used by popstate handler)
function expandItemById(itemId) {
  const row = document.querySelector(`.file-item.file[data-item-id="${itemId}"]`);
  if (row) {
    const targetId = row.dataset.metaTarget;
    const toggle = row.querySelector('.file-meta-toggle');
    const metaEl = document.getElementById(targetId);
    if (metaEl && !metaEl.classList.contains('expanded')) {
      toggle?.classList.add('expanded');
      metaEl.classList.add('expanded');
      currentExpandedItem = itemId;
    }
  }
}

// Handle browser back/forward buttons
window.addEventListener('popstate', (event) => {
  const collectionId = event.state?.collection || null;
  const expandedItem = event.state?.expandedItem || null;

  // Same collection - handle item expansion/collapse
  if (collectionId === currentCollection && collectionId !== null) {
    if (currentExpandedItem && !expandedItem) {
      // Back from expanded item to collection view
      collapseItem(currentExpandedItem);
    } else if (expandedItem && expandedItem !== currentExpandedItem) {
      // Forward to a different expanded item
      if (currentExpandedItem) {
        collapseItem(currentExpandedItem);
      }
      expandItemById(expandedItem);
    }
    return;
  }

  // Different collection or going to collections list
  if (collectionId && collectionId !== currentCollection) {
    // Navigate to collection without pushing new history
    loadCollection(collectionId, false, false);
  } else if (!collectionId && currentCollection) {
    // Go back to collections list without pushing new history
    currentCollection = null;
    currentExpandedItem = null;
    currentFilters = {
      search: '', sensor: '', source: '', processingLevel: '',
      dateFrom: '', dateTo: '', bbox: null
    };
    loadCollections(false);
  }
});

// Parse initial URL hash on page load
function parseHash() {
  const hash = window.location.hash;
  const result = { collection: null, item: null };

  const collectionMatch = hash.match(/collection=([^&]+)/);
  if (collectionMatch) {
    result.collection = decodeURIComponent(collectionMatch[1]);
  }

  const itemMatch = hash.match(/item=([^&]+)/);
  if (itemMatch) {
    result.item = decodeURIComponent(itemMatch[1]);
  }

  return result;
}

// Initialize with proper history state
async function initializeApp() {
  const { collection: initialCollection, item: initialItem } = parseHash();

  // Set initial history state (replace, don't push)
  replaceHistoryState(initialCollection, initialItem);

  if (initialCollection) {
    // Load collections first (to populate filters), then load the specific collection
    await loadCollections(false);
    await loadCollection(initialCollection, false, false);

    // If there's an initial item to expand, expand it after a short delay for DOM to be ready
    if (initialItem) {
      setTimeout(() => {
        expandItemById(initialItem);
        currentExpandedItem = initialItem;
      }, 100);
    }
  } else {
    await loadCollections(false);
  }
}

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

// Format date range
function formatDateRange(start, end) {
  if (!start && !end) return '-';
  const startStr = start ? formatDate(start) : '...';
  const endStr = end ? formatDate(end) : 'ongoing';
  if (start === end || !end) return startStr;
  return `${startStr} → ${endStr}`;
}

// Get file icon based on format
function getIcon(format) {
  const icons = {
    'JPG': '📷', 'JPEG': '📷', 'PNG': '📷', 'GIF': '📷', 'TIF': '📷', 'TIFF': '📷',
    'CSV': '📊', 'XLS': '📊', 'XLSX': '📊',
    'PDF': '📄', 'DOC': '📄', 'DOCX': '📄',
    'LAZ': '☁️', 'LAS': '☁️',
    'OBJ': '🎨', 'GLB': '🎨', 'GLTF': '🎨',
    'ZIP': '📦', '7Z': '📦', 'TAR': '📦', 'GZ': '📦',
  };
  return icons[format?.toUpperCase()] || '📄';
}


// Update breadcrumb and filters
function updateBreadcrumb() {
  const breadcrumb = document.getElementById('fileBreadcrumb');
  breadcrumb.style.display = 'flex';

  // Build dropdown options
  const sensorOptions = allSensors.map(s =>
    `<option value="${s}" ${currentFilters.sensor === s ? 'selected' : ''}>${s}</option>`
  ).join('');

  const sourceOptions = allSources.map(s =>
    `<option value="${s}" ${currentFilters.source === s ? 'selected' : ''}>${s}</option>`
  ).join('');

  const processingLevelOptions = ['1', '2', '3', '4'].map(level =>
    `<option value="${level}" ${currentFilters.processingLevel === level ? 'selected' : ''}>Level ${level}</option>`
  ).join('');

  // Check if any advanced filters (date/bbox) are active
  const hasAdvancedFilters = currentFilters.dateFrom || currentFilters.dateTo || currentFilters.bbox;

  const filtersHtml = `
    <div class="filter-container">
      <div class="filter-row">
        <input type="text" id="searchFilter" placeholder="Search..." value="${currentFilters.search}">
        <select id="sensorFilter">
          <option value="">All Sensors</option>
          ${sensorOptions}
        </select>
        <select id="sourceFilter">
          <option value="">All Sources</option>
          ${sourceOptions}
        </select>
        <select id="processingLevelFilter">
          <option value="">All Levels</option>
          ${processingLevelOptions}
        </select>
        <button id="toggleAdvancedFilters" class="filter-toggle-btn ${hasAdvancedFilters ? 'active' : ''}" title="Date & Location Filters">
          <span class="filter-icon">⚙</span>
        </button>
        ${hasAdvancedFilters ? '<button id="clearFilters" class="filter-clear-btn" title="Clear all filters">✕</button>' : ''}
      </div>
      <div class="filter-row-advanced" id="advancedFilters" style="display: ${hasAdvancedFilters ? 'flex' : 'none'};">
        <div class="filter-group">
          <label for="dateFromFilter">From</label>
          <input type="datetime-local" id="dateFromFilter" value="${currentFilters.dateFrom}">
        </div>
        <div class="filter-group">
          <label for="dateToFilter">To</label>
          <input type="datetime-local" id="dateToFilter" value="${currentFilters.dateTo}">
        </div>
        <div class="filter-group filter-group-bbox">
          <label>Bbox</label>
          <div class="bbox-inputs">
            <input type="number" id="bboxMinLon" placeholder="Min Lon" step="any" value="${currentFilters.bbox?.[0] ?? ''}">
            <input type="number" id="bboxMinLat" placeholder="Min Lat" step="any" value="${currentFilters.bbox?.[1] ?? ''}">
            <input type="number" id="bboxMaxLon" placeholder="Max Lon" step="any" value="${currentFilters.bbox?.[2] ?? ''}">
            <input type="number" id="bboxMaxLat" placeholder="Max Lat" step="any" value="${currentFilters.bbox?.[3] ?? ''}">
          </div>
        </div>
      </div>
    </div>
  `;

  if (!currentCollection) {
    // Show just filters on collections view
    breadcrumb.innerHTML = `
      <span>All Collections</span>
      <div class="file-filters">${filtersHtml}</div>
    `;
  } else {
    const collection = collections.find(c => c.id === currentCollection);
    const title = collection?.title || currentCollection;

    breadcrumb.innerHTML = `
      <a href="#" id="backToCollections">&larr; All Collections</a>
      <span>/</span>
      <span>${title}</span>
      <div class="file-filters">${filtersHtml}</div>
    `;

    document.getElementById('backToCollections').addEventListener('click', (e) => {
      e.preventDefault();
      // Push history state before changing currentCollection
      pushHistoryState(null, null);
      currentCollection = null;
      currentExpandedItem = null;
      currentFilters = {
        search: '', sensor: '', source: '', processingLevel: '',
        dateFrom: '', dateTo: '', bbox: null
      };
      loadCollections(false); // Don't push history again
    });
  }

  // Attach filter event listeners
  // Text search - client-side only, debounced
  document.getElementById('searchFilter').addEventListener('input', (e) => {
    currentFilters.search = e.target.value;
    applyFilters(); // Debounced client-side filter
  });

  // Sensor - server-side, immediate
  document.getElementById('sensorFilter').addEventListener('change', (e) => {
    currentFilters.sensor = e.target.value;
    applyFilters(true); // Immediate client-side filter
  });

  // Source - server-side, immediate
  document.getElementById('sourceFilter').addEventListener('change', (e) => {
    currentFilters.source = e.target.value;
    applyServerFiltersDebounced(true);
  });

  // Processing Level - server-side, immediate
  document.getElementById('processingLevelFilter').addEventListener('change', (e) => {
    currentFilters.processingLevel = e.target.value;
    applyServerFiltersDebounced(true);
  });

  // Toggle advanced filters
  document.getElementById('toggleAdvancedFilters').addEventListener('click', () => {
    const advanced = document.getElementById('advancedFilters');
    const btn = document.getElementById('toggleAdvancedFilters');
    if (advanced.style.display === 'none') {
      advanced.style.display = 'flex';
      btn.classList.add('active');
    } else {
      advanced.style.display = 'none';
      btn.classList.remove('active');
    }
  });

  // Clear filters button
  const clearBtn = document.getElementById('clearFilters');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      currentFilters = {
        search: '', sensor: '', source: '', processingLevel: '',
        dateFrom: '', dateTo: '', bbox: null
      };
      applyServerFiltersDebounced(true);
    });
  }

  // Date filters - server-side, debounced
  document.getElementById('dateFromFilter').addEventListener('change', (e) => {
    currentFilters.dateFrom = e.target.value;
    applyServerFiltersDebounced();
  });

  document.getElementById('dateToFilter').addEventListener('change', (e) => {
    currentFilters.dateTo = e.target.value;
    applyServerFiltersDebounced();
  });

  // Bbox inputs - server-side, debounced
  const bboxInputs = ['bboxMinLon', 'bboxMinLat', 'bboxMaxLon', 'bboxMaxLat'];
  bboxInputs.forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      const minLon = parseFloat(document.getElementById('bboxMinLon').value);
      const minLat = parseFloat(document.getElementById('bboxMinLat').value);
      const maxLon = parseFloat(document.getElementById('bboxMaxLon').value);
      const maxLat = parseFloat(document.getElementById('bboxMaxLat').value);

      if (!isNaN(minLon) && !isNaN(minLat) && !isNaN(maxLon) && !isNaN(maxLat)) {
        currentFilters.bbox = [minLon, minLat, maxLon, maxLat];
      } else if (isNaN(minLon) && isNaN(minLat) && isNaN(maxLon) && isNaN(maxLat)) {
        currentFilters.bbox = null;
      }
      applyServerFiltersDebounced();
    });
  });
}

// Apply server-side filters with debounce
function applyServerFiltersDebounced(immediate = false) {
  const doFilter = async () => {
    await applyServerFilters();
  };

  if (immediate) {
    doFilter();
  } else {
    clearTimeout(serverFilterDebounceTimer);
    serverFilterDebounceTimer = setTimeout(doFilter, 300);
  }
}

// Apply filters to current view (with debounce for search)
function applyFilters(immediate = false) {
  const doFilter = () => {
    // Save focus state right before re-render
    const searchInput = document.getElementById('searchFilter');
    const wasSearchFocused = searchInput && document.activeElement === searchInput;
    const cursorPosition = searchInput ? searchInput.selectionStart : 0;
    const searchValue = currentFilters.search;

    if (currentCollection) {
      renderItems();
    } else {
      renderCollections();
    }

    // Restore focus after re-render
    if (wasSearchFocused) {
      const newSearchInput = document.getElementById('searchFilter');
      if (newSearchInput) {
        newSearchInput.value = searchValue; // Ensure value is preserved
        newSearchInput.focus();
        newSearchInput.setSelectionRange(cursorPosition, cursorPosition);
      }
    }
  };

  if (immediate) {
    doFilter();
  } else {
    // Debounce search input
    clearTimeout(filterDebounceTimer);
    filterDebounceTimer = setTimeout(doFilter, 200);
  }
}

// Build query parameters for server-side filtering
function buildFilterParams() {
  const params = new URLSearchParams();
  params.set('exclude_assets', 'true');

  if (currentFilters.source) params.set('source', currentFilters.source);
  if (currentFilters.processingLevel) params.set('processing_level', currentFilters.processingLevel);

  if (currentFilters.dateFrom || currentFilters.dateTo) {
    const from = currentFilters.dateFrom ? new Date(currentFilters.dateFrom).toISOString() : '..';
    const to = currentFilters.dateTo ? new Date(currentFilters.dateTo).toISOString() : '..';
    params.set('datetime', `${from}/${to}`);
  }

  if (currentFilters.bbox?.length === 4) {
    params.set('bbox', currentFilters.bbox.join(','));
  }

  return params;
}

// Apply server-side filters (re-fetches data)
async function applyServerFilters() {
  if (currentCollection) {
    await loadCollection(currentCollection);
  } else {
    await loadCollections();
  }
}

// Render collections list
function renderCollections() {
  currentCollection = null;
  updateBreadcrumb();

  const container = document.getElementById('fileList');

  // Filter collections based on sensor, source, and processing level filters
  let filteredCollections = collections;
  if (currentFilters.sensor) {
    filteredCollections = filteredCollections.filter(c => {
      const collectionSensors = sensorsByCollection[c.id] || [];
      return collectionSensors.includes(currentFilters.sensor);
    });
  }
  if (currentFilters.source) {
    filteredCollections = filteredCollections.filter(c => {
      const collectionSources = sourcesByCollection[c.id] || [];
      return collectionSources.includes(currentFilters.source);
    });
  }
  if (currentFilters.processingLevel) {
    filteredCollections = filteredCollections.filter(c => {
      const collectionLevels = processingLevelsByCollection[c.id] || [];
      return collectionLevels.includes(currentFilters.processingLevel);
    });
  }

  // Filter by search text
  if (currentFilters.search) {
    const searchLower = currentFilters.search.toLowerCase();
    filteredCollections = filteredCollections.filter(c => {
      const title = (c.title || c.id || '').toLowerCase();
      const description = (c.description || '').toLowerCase();
      return title.includes(searchLower) || description.includes(searchLower);
    });
  }

  document.getElementById('fileCount').textContent = `(${filteredCollections.length} collection${filteredCollections.length !== 1 ? 's' : ''})`;

  if (filteredCollections.length === 0) {
    container.innerHTML = '<div class="empty">No collections match the current filters</div>';
    return;
  }

  container.innerHTML = filteredCollections.map(collection => {
    const itemCount = collection._itemCount || '';
    const temporal = collection.extent?.temporal?.interval?.[0];
    const dateRange = temporal ? formatDateRange(temporal[0], temporal[1]) : '';

    return `
      <div class="file-item folder collection-item" data-collection="${collection.id}">
        <div class="file-row">
          <div class="file-name">
            <span class="name">${collection.title || collection.id}</span>
          </div>
          <div class="file-info">
            <span class="collection-date">${dateRange}</span>
          </div>
        </div>
        <div class="collection-description">${collection.description || ''}</div>
      </div>
    `;
  }).join('');

  // Add click handlers
  container.querySelectorAll('.collection-item').forEach(el => {
    el.addEventListener('click', () => {
      loadCollection(el.dataset.collection);
    });
  });
}

// Load items for a collection
async function loadCollection(collectionId, loadAll = false, pushHistory = true) {
  currentCollection = collectionId;
  currentExpandedItem = null; // Reset expanded item when changing collections
  if (pushHistory) {
    pushHistoryState(collectionId, null);
  }
  updateBreadcrumb();

  const container = document.getElementById('fileList');
  container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading items...</div>';

  try {
    const params = buildFilterParams();
    params.set('limit', loadAll ? '10000' : String(INITIAL_ITEMS_LIMIT));
    const response = await fetch(`${STAC_API}/collections/${collectionId}/items?${params}`);
    if (!response.ok) throw new Error('Failed to load items');

    const data = await response.json();
    items = data.features || [];
    totalItemCount = data.numberMatched || items.length;

    document.getElementById('fileCount').textContent = `(${totalItemCount} item${totalItemCount !== 1 ? 's' : ''})`;

    renderItems();
  } catch (err) {
    container.innerHTML = `<div class="error-msg">${err.message}</div>`;
  }
}

// Fetch item details with paginated assets
async function fetchItemAssets(collectionId, itemId, limit = 20, offset = 0) {
  const response = await fetch(`${STAC_API}/collections/${collectionId}/items/${itemId}?asset_limit=${limit}&asset_offset=${offset}`);
  if (!response.ok) throw new Error('Failed to load item details');
  return response.json();
}

// Get file extension from href or title
function getExtension(href, title) {
  const str = href || title || '';
  const match = str.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  return match ? match[1].toUpperCase() : '';
}

// Render assets list as collapsible file groups
// Takes item.assets object (new STAC structure where files are assets, not child items)
function renderItemAssets(assets) {
  if (!assets) {
    return '<div class="empty">No files found</div>';
  }

  // Separate archive from file assets
  const fileAssets = Object.entries(assets)
    .filter(([key]) => key !== 'archive')
    .map(([key, asset]) => ({ key, ...asset }));

  if (fileAssets.length === 0) {
    return '<div class="empty">No individual files found</div>';
  }

  // Group by extension
  const byExtension = {};
  fileAssets.forEach(asset => {
    const ext = getExtension(asset.href, asset.title) || 'OTHER';
    if (!byExtension[ext]) byExtension[ext] = [];
    byExtension[ext].push(asset);
  });

  // Sort groups by count (largest first), then sort files within each group
  const sortedGroups = Object.entries(byExtension)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([ext, assets]) => [ext, assets.sort((a, b) => {
      const titleA = a.title || a.key;
      const titleB = b.title || b.key;
      return titleA.localeCompare(titleB);
    })]);

  // Calculate totals
  const totalSize = fileAssets.reduce((sum, asset) => sum + (asset['file:size'] || 0), 0);
  // Count assets with LV95 projection data (proj:bbox indicates per-asset geometry)
  const withGeo = fileAssets.filter(asset => asset['proj:bbox'] != null).length;

  let html = `
    <div class="files-header">
      <span class="files-count">${fileAssets.length} files</span>
      ${totalSize > 0 ? `<span class="files-size">${formatSize(totalSize)}</span>` : ''}
      ${withGeo > 0 ? `<span class="files-geo" title="${withGeo} files with LV95 coordinates">📍 ${withGeo}</span>` : ''}
    </div>
  `;

  // Render collapsible groups
  sortedGroups.forEach(([ext, assets], groupIndex) => {
    const icon = getIcon(ext);
    const groupSize = assets.reduce((sum, asset) => sum + (asset['file:size'] || 0), 0);
    const groupId = `file-group-${Date.now()}-${groupIndex}`;

    html += `
      <div class="file-group">
        <div class="file-group-header" data-target="${groupId}">
          <span class="file-group-toggle">▶</span>
          <span class="file-group-icon">${icon}</span>
          <span class="file-group-ext">${ext}</span>
          <span class="file-group-badge">${assets.length}</span>
          <span class="file-group-size">${formatSize(groupSize)}</span>
        </div>
        <div class="file-group-content" id="${groupId}">
    `;

    assets.forEach(asset => {
      const title = asset.title || asset.key;
      const size = asset['file:size'];
      const datetime = asset.datetime;
      const href = asset.href || '#';
      // Check for projection extension (per-asset LV95 geometry)
      const hasGeo = asset['proj:bbox'] != null;

      // Format date if available
      const dateStr = datetime ? formatDate(datetime) : '';

      html += `
        <a href="${href}" class="file-item asset-row" target="_blank" rel="noopener">
          <span class="file-name">${title}</span>
          <span class="asset-meta">
            ${hasGeo ? '<span class="asset-geo" title="Has LV95 coordinates">📍</span>' : ''}
            ${size ? `<span class="asset-size">${formatSize(size)}</span>` : ''}
            ${dateStr ? `<span class="asset-date">${dateStr}</span>` : ''}
          </span>
        </a>
      `;
    });

    html += `</div></div>`;
  });

  return html;
}

// Render items list
function renderItems() {
  const container = document.getElementById('fileList');

  // Apply filters
  const filteredItems = items.filter(item => {
    const props = item.properties || {};
    const searchLower = currentFilters.search.toLowerCase();

    // Search filter - check title, description, sensor, source
    if (searchLower) {
      const title = (props.title || item.id || '').toLowerCase();
      const description = (props.description || '').toLowerCase();
      const sensor = (props['blatten:sensor'] || '').toLowerCase();
      const source = (props['blatten:source'] || '').toLowerCase();
      if (!title.includes(searchLower) && !description.includes(searchLower) &&
          !sensor.includes(searchLower) && !source.includes(searchLower)) {
        return false;
      }
    }

    // Sensor filter
    if (currentFilters.sensor && props['blatten:sensor'] !== currentFilters.sensor) {
      return false;
    }

    return true;
  });

  if (filteredItems.length === 0) {
    container.innerHTML = '<div class="empty">No items match the current filters</div>';
    return;
  }

  const remainingItems = totalItemCount - items.length;
  const showMoreHtml = remainingItems > 0 ? `
    <div class="show-more-items" id="showMoreItems">
      <button class="show-more-btn">Show ${remainingItems} more item${remainingItems !== 1 ? 's' : ''}...</button>
    </div>
  ` : '';

  container.innerHTML = filteredItems.map(item => {
    const props = item.properties || {};
    const format = props['blatten:format'] || '';

    // Get assets info
    const assets = item.assets || {};
    const assetCount = Object.keys(assets).length;
    const archiveAsset = assets.archive;
    const fileAssets = Object.entries(assets).filter(([key]) => key !== 'archive');
    const totalSize = props['blatten:total_size'] || fileAssets.reduce((sum, [, a]) => sum + (a['file:size'] || 0), 0);

    // Determine icon from first non-archive asset
    const firstAsset = fileAssets[0];
    const firstExt = firstAsset ? getExtension(firstAsset[1].href, firstAsset[1].title) : format;
    const icon = getIcon(firstExt);

    // Date range
    const startDate = props.start_datetime || props.datetime;
    const endDate = props.end_datetime;
    const dateDisplay = formatDateRange(startDate, endDate);

    // Metadata
    const source = props['blatten:source'] || '';
    const processingLevel = props['blatten:processing_level'];
    const frequency = props['blatten:frequency'] || '';
    const description = props.description || '';
    const continued = props['blatten:continued'];
    const phase = props['blatten:phase'] || '';
    const fileCount = props['blatten:file_count'] || fileAssets.length;

    const metaId = 'meta-' + item.id.replace(/[^a-zA-Z0-9]/g, '-');

    // Archive download link
    const archiveHref = archiveAsset?.href || '#';

    return `
      <div class="file-item file" data-meta-target="${metaId}" data-item-id="${item.id}">
        <div class="file-row">
          <span class="file-meta-toggle" data-target="${metaId}">
            <span class="arrow">&#9654;</span>
          </span>
          <div class="file-name">
            <span class="icon">${icon}</span>
            <span class="name">${props.title || item.id}</span>
            <span class="file-count-badge">${fileCount} files</span>
          </div>
          <div class="file-info">
            <span>${formatSize(totalSize)}</span>
            <span>${dateDisplay}</span>
          </div>
          ${archiveAsset ? `<a href="${archiveHref}" class="download-btn" target="_blank" rel="noopener" title="Download Archive">⬇</a>` : ''}
        </div>
        <div class="file-meta" id="${metaId}">
          <div class="meta-content-wrapper">
            <div class="meta-grid">
              ${description ? `<div class="meta-row"><span class="meta-label">Description</span><span class="meta-value">${description}</span></div>` : ''}
              ${source ? `<div class="meta-row"><span class="meta-label">Source</span><span class="meta-value">${source}</span></div>` : ''}
              ${processingLevel ? `<div class="meta-row"><span class="meta-label">Processing Level</span><span class="meta-value">${processingLevel}</span></div>` : ''}
              ${phase ? `<div class="meta-row"><span class="meta-label">Phase</span><span class="meta-value">${phase}</span></div>` : ''}
              ${frequency ? `<div class="meta-row"><span class="meta-label">Frequency</span><span class="meta-value">${frequency}</span></div>` : ''}
              ${continued !== undefined ? `<div class="meta-row"><span class="meta-label">Status</span><span class="meta-value">${continued ? 'Ongoing' : 'Completed'}</span></div>` : ''}
              ${format ? `<div class="meta-row"><span class="meta-label">Format</span><span class="meta-value">${format}</span></div>` : ''}
            </div>
            ${item.bbox ? `
            <div class="meta-map-section">
              <div class="meta-mini-map" id="minimap-${metaId}" data-bbox="${item.bbox.join(',')}" data-geometry='${JSON.stringify(item.geometry)}' data-item-id="${item.id}" data-collection-id="${currentCollection}"></div>
              <div class="meta-bbox">
                <div class="bbox-row"><span class="bbox-corner">SW</span><span class="bbox-coords">${item.bbox[0]?.toFixed(4)}°, ${item.bbox[1]?.toFixed(4)}°</span></div>
                <div class="bbox-row"><span class="bbox-corner">NE</span><span class="bbox-coords">${item.bbox[2]?.toFixed(4)}°, ${item.bbox[3]?.toFixed(4)}°</span></div>
              </div>
            </div>
            ` : ''}
          </div>
          ${archiveAsset ? `
          <div class="meta-actions">
            <a href="${archiveHref}" class="meta-download-btn" target="_blank" rel="noopener">Download Archive (${formatSize(archiveAsset['file:size'])})</a>
          </div>
          ` : ''}
          <div class="meta-assets">
            <div class="meta-assets-header">Individual Files</div>
            <div class="meta-assets-content">
              <div class="assets-placeholder">Expand to load file list...</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('') + showMoreHtml;

  // Handle "Show more items" click
  const showMoreBtn = container.querySelector('#showMoreItems');
  if (showMoreBtn) {
    showMoreBtn.addEventListener('click', async () => {
      const btn = showMoreBtn.querySelector('button');
      btn.textContent = 'Loading...';
      btn.disabled = true;

      try {
        // Fetch remaining items starting from current offset
        const params = buildFilterParams();
        params.set('limit', '10000');
        params.set('offset', String(items.length));
        const response = await fetch(`${STAC_API}/collections/${currentCollection}/items?${params}`);
        if (!response.ok) throw new Error('Failed to load items');

        const data = await response.json();
        const newItems = data.features || [];

        // Append new items to existing array
        items = [...items, ...newItems];

        // Re-render with all items
        renderItems();
      } catch (err) {
        btn.textContent = `Error: ${err.message}`;
      }
    });
  }

  // Header row click to expand/collapse (only the top bar, not the expanded content)
  container.querySelectorAll('.file-item.file .file-row').forEach(rowHeader => {
    rowHeader.addEventListener('click', async (e) => {
      // Don't toggle if clicking download button
      if (e.target.closest('.download-btn')) {
        return;
      }
      const row = rowHeader.closest('.file-item.file');
      const targetId = row.dataset.metaTarget;
      const itemId = row.dataset.itemId;
      const toggle = row.querySelector('.file-meta-toggle');
      const metaEl = document.getElementById(targetId);
      if (metaEl && toggle) {
        const isExpanding = !metaEl.classList.contains('expanded');
        toggle.classList.toggle('expanded');
        metaEl.classList.toggle('expanded');

        // Update history state for back button navigation
        if (isExpanding) {
          // Collapse any previously expanded item first
          if (currentExpandedItem && currentExpandedItem !== itemId) {
            collapseItem(currentExpandedItem);
          }
          currentExpandedItem = itemId;
          pushHistoryState(currentCollection, itemId);
        } else {
          currentExpandedItem = null;
          pushHistoryState(currentCollection, null);
        }

        // When expanding, load full item data and initialize map
        if (isExpanding) {
          // Initialize mini map
          const miniMapEl = metaEl.querySelector('.meta-mini-map');
          if (miniMapEl && !miniMapEl._mapInitialized) {
            initMiniMap(miniMapEl);
          }

          // Lazy load file assets (files are now assets within the item, not child items)
          // Items are fetched with exclude_assets=true, so we need to fetch full item details
          const assetsContainer = metaEl.querySelector('.meta-assets-content');
          if (assetsContainer && !assetsContainer._assetsLoaded) {
            assetsContainer.innerHTML = '<div class="loading-assets"><div class="spinner"></div>Loading files...</div>';
            try {
              // Fetch full item with all assets (use high limit to get all files)
              const fullItem = await fetchItemAssets(currentCollection, itemId, 10000, 0);
              if (fullItem && fullItem.assets) {
                assetsContainer.innerHTML = renderItemAssets(fullItem.assets);
                assetsContainer._assetsLoaded = true;

                // Set up file group toggle handlers
                assetsContainer.querySelectorAll('.file-group-header').forEach(header => {
                  header.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const targetId = header.dataset.target;
                    const content = document.getElementById(targetId);
                    if (content) {
                      header.classList.toggle('expanded');
                      content.classList.toggle('expanded');
                    }
                  });
                });
              } else {
                assetsContainer.innerHTML = '<div class="empty">No files found</div>';
                assetsContainer._assetsLoaded = true;
              }
            } catch (err) {
              assetsContainer.innerHTML = `<div class="error-msg">Failed to load files: ${err.message}</div>`;
            }
          }
        }
      }
    });
  });

}

// Convert WGS84 (lon, lat) to Swiss LV95 (E, N)
// Approximate formula from swisstopo documentation
function wgs84ToLv95(lon, lat) {
  // Convert to sexagesimal seconds and shift origin to Bern
  const phi = (lat * 3600 - 169028.66) / 10000;
  const lambda = (lon * 3600 - 26782.5) / 10000;

  // Calculate easting (E)
  const E = 2600072.37
    + 211455.93 * lambda
    - 10938.51 * lambda * phi
    - 0.36 * lambda * phi * phi
    - 44.54 * lambda * lambda * lambda;

  // Calculate northing (N)
  const N = 1200147.07
    + 308807.95 * phi
    + 3745.25 * lambda * lambda
    + 76.63 * phi * phi
    - 194.56 * lambda * lambda * phi
    + 119.79 * phi * phi * phi;

  return { E: Math.round(E), N: Math.round(N) };
}

// Initialize a mini map for an item
function initMiniMap(el) {
  const bboxStr = el.dataset.bbox;
  const geometryStr = el.dataset.geometry;

  if (!bboxStr) return;

  const bbox = bboxStr.split(',').map(Number);
  const geometry = geometryStr ? JSON.parse(geometryStr) : null;

  // Calculate center from bbox [minX, minY, maxX, maxY]
  const centerLat = (bbox[1] + bbox[3]) / 2;
  const centerLng = (bbox[0] + bbox[2]) / 2;

  // Check if bbox is essentially a point (very small extent)
  const bboxWidth = Math.abs(bbox[2] - bbox[0]);
  const bboxHeight = Math.abs(bbox[3] - bbox[1]);
  const isPoint = bboxWidth < 0.001 && bboxHeight < 0.001;

  // Create map container and controls wrapper
  const mapContainer = document.createElement('div');
  mapContainer.className = 'mini-map-container';
  el.appendChild(mapContainer);

  // Create mini map - interactive but compact
  const miniMap = L.map(mapContainer, {
    zoomControl: false,
    attributionControl: false,
    scrollWheelZoom: true,
    doubleClickZoom: true
  });

  // Add SwissTopo tile layer (WMTS in Web Mercator projection)
  L.tileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.swisstopo.admin.ch/">swisstopo</a>'
  }).addTo(miniMap);

  // Draw the geometry
  let fitBounds;
  if (geometry && geometry.type === 'Polygon') {
    const coords = geometry.coordinates[0].map(c => [c[1], c[0]]);
    const polygon = L.polygon(coords, {
      color: '#ff0000',
      weight: 2,
      fillOpacity: 0.3
    }).addTo(miniMap);
    fitBounds = polygon.getBounds();
    miniMap.fitBounds(fitBounds, { padding: [10, 10] });
  } else if (geometry && geometry.type === 'Point') {
    const [lon, lat] = geometry.coordinates;
    L.circleMarker([lat, lon], {
      radius: 6,
      color: '#ff0000',
      fillColor: '#ff0000',
      fillOpacity: 0.5
    }).addTo(miniMap);
    miniMap.setView([lat, lon], 14);
  } else {
    // Just use bbox
    fitBounds = [[bbox[1], bbox[0]], [bbox[3], bbox[2]]];
    L.rectangle(fitBounds, {
      color: '#ff0000',
      weight: 2,
      fillOpacity: 0.2
    }).addTo(miniMap);
    miniMap.fitBounds(fitBounds, { padding: [10, 10] });
  }

  // Build SwissTopo map.geo.admin.ch URL with KML layer from our API
  // Calculate appropriate zoom based on extent
  const extentSize = Math.max(bboxWidth, bboxHeight);
  let zoom = 10;
  if (extentSize > 0.1) zoom = 8;
  else if (extentSize > 0.05) zoom = 9;
  else if (extentSize > 0.01) zoom = 11;
  else if (extentSize > 0.005) zoom = 12;
  else zoom = 13;

  // Convert center to LV95 coordinates (required by new map.geo.admin.ch URL format)
  const lv95 = wgs84ToLv95(centerLng, centerLat);

  // Get item and collection IDs for KML endpoint
  const itemId = el.dataset.itemId;
  const collectionId = el.dataset.collectionId;

  // Build KML URL from our API (publicly accessible URL for map.geo.admin.ch to fetch)
  // Note: This requires the API to be publicly accessible with CORS enabled
  const kmlUrl = `${window.location.origin}${STAC_API}/kml?collection_id=${encodeURIComponent(collectionId)}&item_id=${encodeURIComponent(itemId)}`;

  // Build SwissTopo URL with new 2024 format:
  // - Hash-based URL: #/map?...
  // - center=E,N in LV95 coordinates
  // - z= instead of zoom=
  // - layers=KML%7C<url> where %7C is URL-encoded pipe
  const swisstopoUrl = `https://map.geo.admin.ch/#/map?lang=en&bgLayer=ch.swisstopo.pixelkarte-farbe&z=${zoom}&center=${lv95.E},${lv95.N}&layers=KML%7C${kmlUrl}`;

  // Add "Open in SwissTopo" button
  const openSwisstopoBtn = document.createElement('a');
  openSwisstopoBtn.className = 'mini-map-osm-btn';
  openSwisstopoBtn.href = swisstopoUrl;
  openSwisstopoBtn.target = '_blank';
  openSwisstopoBtn.rel = 'noopener';
  openSwisstopoBtn.title = 'Open in SwissTopo';
  openSwisstopoBtn.innerHTML = '↗';
  el.appendChild(openSwisstopoBtn);

  el._mapInitialized = true;
}

// Load all collections and sensors
async function loadCollections(pushHistory = false) {
  currentCollection = null;
  const container = document.getElementById('fileList');
  container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading collections...</div>';
  document.getElementById('error').style.display = 'none';

  try {
    // Fetch collections and all items (for sensor/source lists) in parallel
    const params = buildFilterParams();
    params.set('limit', '1000');
    const [collectionsRes, itemsRes] = await Promise.all([
      fetch(`${STAC_API}/collections`),
      fetch(`${STAC_API}/search?${params}`)
    ]);

    if (!collectionsRes.ok) throw new Error('Failed to load STAC collections');

    const collectionsData = await collectionsRes.json();
    collections = collectionsData.collections || [];

    // Extract unique sensors, sources, and processing levels from all items and map to collections
    if (itemsRes.ok) {
      const itemsData = await itemsRes.json();
      const sensors = new Set();
      const sources = new Set();
      sensorsByCollection = {}; // Reset mapping
      sourcesByCollection = {}; // Reset mapping
      processingLevelsByCollection = {}; // Reset mapping

      (itemsData.features || []).forEach(item => {
        const sensor = item.properties?.['blatten:sensor'];
        const source = item.properties?.['blatten:source'];
        const processingLevel = item.properties?.['blatten:processing_level'];
        const collectionId = item.collection;

        if (sensor) {
          sensors.add(sensor);
          // Track which sensors belong to which collections
          if (collectionId) {
            if (!sensorsByCollection[collectionId]) {
              sensorsByCollection[collectionId] = [];
            }
            if (!sensorsByCollection[collectionId].includes(sensor)) {
              sensorsByCollection[collectionId].push(sensor);
            }
          }
        }

        if (source) {
          sources.add(source);
          // Track which sources belong to which collections
          if (collectionId) {
            if (!sourcesByCollection[collectionId]) {
              sourcesByCollection[collectionId] = [];
            }
            if (!sourcesByCollection[collectionId].includes(source)) {
              sourcesByCollection[collectionId].push(source);
            }
          }
        }

        if (processingLevel) {
          // Track which processing levels belong to which collections
          if (collectionId) {
            const levelStr = String(processingLevel);
            if (!processingLevelsByCollection[collectionId]) {
              processingLevelsByCollection[collectionId] = [];
            }
            if (!processingLevelsByCollection[collectionId].includes(levelStr)) {
              processingLevelsByCollection[collectionId].push(levelStr);
            }
          }
        }
      });
      allSensors = [...sensors].sort();
      allSources = [...sources].sort();
    }

    // Sort collections by title
    collections.sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id));

    renderCollections();
  } catch (err) {
    document.getElementById('error').textContent = `Error loading data: ${err.message}. Make sure the STAC API is running.`;
    document.getElementById('error').style.display = 'block';
    container.innerHTML = '<div class="empty">Failed to load collections</div>';
  }
}

// Initial load
initializeApp();
