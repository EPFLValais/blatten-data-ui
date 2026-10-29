// STAC API-based file browser
const STAC_API = '/stac';
let collections = [];
let currentCollection = null;
let items = [];
let totalItemCount = 0;
let allSensors = [];
let sensorsByCollection = {}; // Maps collection ID to list of sensors in that collection
let allSources = [];
let sourcesByCollection = {}; // Maps collection ID to list of sources in that collection
let processingLevelsByCollection = {}; // Maps collection ID to list of processing levels
let allProcessingLevels = [];
let currentFilters = {
  search: '',           // client-side text filter
  sensor: '',           // existing
  source: '',           // maps to ?source=
  processingLevel: '',  // maps to ?processing_level=
  dateFrom: '',         // combined into ?datetime=
  dateTo: '',
  bbox: null            // [minLon, minLat, maxLon, maxLat] or null
};
let dataDateMin = null;
let dataDateMax = null;
let dataBboxExtent = null; // [west, south, east, north] from all collections
let bboxFilterMap = null;  // Leaflet map instance for bbox filter
let bboxFilterRect = null; // Current bbox rectangle on the map
let filterDebounceTimer = null;
let serverFilterDebounceTimer = null;
let currentExpandedItem = null; // Track currently expanded item for history
let currentOpenDay = null;      // The day opened within the expanded series, for history
let bboxOverlayLayers = {};    // Maps collection/item id → Leaflet rectangle for cross-highlighting
let bboxOverlayGroup = null;   // Leaflet layer group for overlays (rendered below filter rect)
let bboxCornerMarkers = null;  // { sw, ne, nw, se } draggable corner markers
let bboxMapRight = null;       // Persistent right-column DOM element (survives re-renders)
let bboxEdgeDragging = false;  // True while edge-dragging the filter rect
let cornerDragging = false;    // True while corner-marker dragging the filter rect
let visibleCollections = [];   // Filtered collections currently shown in the list (used by map overlays)
let loadSeq = 0;               // Latest list load; responses from older loads are dropped

// History API integration for back button navigation. The hash names the collection, the
// expanded item and, within a series, the opened day.
function historyUrl(collectionId, expandedItem, openDay) {
  if (!collectionId) return '#';
  let url = `#collection=${collectionId}`;
  if (expandedItem) {
    url += `&item=${expandedItem}`;
    if (openDay) url += `&day=${openDay}`;
  }
  return url;
}

function pushHistoryState(collectionId = null, expandedItem = null, openDay = null) {
  const state = { collection: collectionId, expandedItem: expandedItem, openDay: openDay };
  history.pushState(state, '', historyUrl(collectionId, expandedItem, openDay));
}

function replaceHistoryState(collectionId = null, expandedItem = null, openDay = null) {
  const state = { collection: collectionId, expandedItem: expandedItem, openDay: openDay };
  history.replaceState(state, '', historyUrl(collectionId, expandedItem, openDay));
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
    currentOpenDay = null;
  }
}

// Expand an item by ID, and open one of its days (used by popstate handler and initial load)
async function expandItemById(itemId, dayId = null) {
  const row = document.querySelector(`.file-item.file[data-item-id="${itemId}"]`);
  if (!row) return;
  const targetId = row.dataset.metaTarget;
  const toggle = row.querySelector('.file-meta-toggle');
  const metaEl = document.getElementById(targetId);
  if (!metaEl) return;

  if (!metaEl.classList.contains('expanded')) {
    toggle?.classList.add('expanded');
    metaEl.classList.add('expanded');
    currentExpandedItem = itemId;
  }

  // Load map and assets (same logic as click handler)
  await loadExpandedItemContent(metaEl, itemId);
  syncOpenDay(metaEl, dayId);
}

// Load mini map and file assets for an expanded item
async function loadExpandedItemContent(metaEl, itemId) {
  // Initialize mini map
  const miniMapEl = metaEl.querySelector('.meta-mini-map');
  if (miniMapEl && !miniMapEl._mapInitialized) {
    initMiniMap(miniMapEl);
  }

  // Lazy load file assets, a page at a time
  const assetsContainer = metaEl.querySelector('.meta-assets-content');
  if (assetsContainer && !assetsContainer._pager) {
    const collectionId = currentCollection;
    const fileCount = Number(assetsContainer.dataset.fileCount);
    const pager = createAssetPager(
      (limit, offset) => fetchItemAssets(collectionId, itemId, limit, offset),
      { total: fileCount > 0 ? fileCount : null }
    );
    assetsContainer._pager = pager;
    assetsContainer.innerHTML = '<div class="loading-assets"><div class="spinner"></div>Loading files...</div>';
    try {
      await pager.next();
      renderAssetPages(assetsContainer, itemId);
    } catch (err) {
      assetsContainer._pager = null;
      assetsContainer.innerHTML = `<div class="error-msg">Failed to load files: ${err.message}</div>`;
    }
  }

  const daysContainer = metaEl.querySelector('.meta-days-content');
  if (daysContainer && !daysContainer._pager) {
    await loadDayList(daysContainer, itemId);
  }
}

// List a series' days a page at a time, within the current date filter
async function loadDayList(daysContainer, itemId) {
  const itemsPath = `${STAC_API}/collections/${currentCollection}/items`;
  const url = daysUrl({ href: daysContainer.dataset.daysHref }, itemsPath, buildFilterParams());
  const pager = createDayPager(fetchJson, url, itemsPath);
  daysContainer._pager = pager;
  daysContainer.innerHTML = '<div class="loading-assets"><div class="spinner"></div>Loading days...</div>';
  try {
    await pager.next();
    renderDayPages(daysContainer, itemId);
  } catch (err) {
    daysContainer._pager = null;
    daysContainer.innerHTML = `<div class="error-msg">Failed to load days: ${err.message}</div>`;
  }
}

// Render the days loaded so far, keeping the opened day's files under its row
function renderDayPages(daysContainer, itemId) {
  const pager = daysContainer._pager;
  const openPanel = daysContainer.querySelector('.day-files');
  daysContainer.innerHTML = renderDayList(pager);

  daysContainer.querySelectorAll('.day-row').forEach(row => {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      const dayId = row.dataset.dayId;
      if (currentOpenDay === dayId) {
        closeDay(daysContainer);
        pushHistoryState(currentCollection, itemId, null);
      } else {
        openDay(daysContainer, dayId);
        pushHistoryState(currentCollection, itemId, dayId);
      }
    });
  });
  if (openPanel) placeDayPanel(daysContainer, openPanel);

  const more = daysContainer.querySelector('.show-more-days');
  if (more) {
    const btn = more.querySelector('button');
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = 'Loading days...';
      try {
        await pager.next();
        renderDayPages(daysContainer, itemId);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = `Failed to load days: ${err.message}. Try again`;
      }
    });
  }
}

// Put a day's file panel under its row, or above the rows when the row is not loaded
function placeDayPanel(daysContainer, panel) {
  const row = daysContainer.querySelector(`.day-row[data-day-id="${panel.dataset.dayId}"]`);
  daysContainer.querySelectorAll('.day-row.expanded').forEach(r => r.classList.remove('expanded'));
  if (row) {
    row.classList.add('expanded');
    row.after(panel);
  } else {
    (daysContainer.querySelector('.day-rows') || daysContainer).prepend(panel);
  }
}

// Open a day of the expanded series and list its files
async function openDay(daysContainer, dayId) {
  closeDay(daysContainer);
  currentOpenDay = dayId;
  const panel = document.createElement('div');
  panel.className = 'day-files';
  panel.dataset.dayId = dayId;
  placeDayPanel(daysContainer, panel);

  const collectionId = currentCollection;
  const day = daysContainer._pager?.days.find(d => d.id === dayId);
  const fileCount = Number(day?.properties?.['blatten:file_count']);
  panel._pager = createAssetPager(
    (limit, offset) => fetchItemAssets(collectionId, dayId, limit, offset),
    { total: fileCount > 0 ? fileCount : null }
  );
  panel.innerHTML = '<div class="loading-assets"><div class="spinner"></div>Loading files...</div>';
  try {
    await panel._pager.next();
    if (panel.isConnected) renderAssetPages(panel, dayId);
  } catch (err) {
    panel.innerHTML = `<div class="error-msg">Failed to load files: ${err.message}</div>`;
  }
}

function closeDay(daysContainer) {
  daysContainer.querySelectorAll('.day-files').forEach(panel => panel.remove());
  daysContainer.querySelectorAll('.day-row.expanded').forEach(r => r.classList.remove('expanded'));
  currentOpenDay = null;
}

// Open or close days so the expanded series shows `dayId`, or no day when null
function syncOpenDay(metaEl, dayId) {
  const daysContainer = metaEl?.querySelector('.meta-days-content');
  if (!daysContainer || dayId === currentOpenDay) return;
  if (dayId) openDay(daysContainer, dayId);
  else closeDay(daysContainer);
}

// Render the pages loaded so far into an item's file list, keeping open groups open
function renderAssetPages(assetsContainer, itemId) {
  const pager = assetsContainer._pager;
  if (Object.keys(pager.assets).length === 0) {
    assetsContainer.innerHTML = '<div class="empty">No files found</div>';
    return;
  }
  const archive = assetsContainer.dataset.archiveHref ? {
    href: assetsContainer.dataset.archiveHref,
    size: assetsContainer.dataset.archiveSize,
    zip64: assetsContainer.dataset.archiveZip64 === '1'
  } : null;
  const openGroups = new Set(
    [...assetsContainer.querySelectorAll('.file-group-header.expanded')].map(h => h.dataset.ext)
  );
  assetsContainer.innerHTML = renderItemAssets(pager, {
    archive,
    idPrefix: 'file-group-' + itemId.replace(/[^a-zA-Z0-9]/g, '-')
  });

  assetsContainer.querySelectorAll('.file-group-header').forEach(header => {
    const content = document.getElementById(header.dataset.target);
    if (openGroups.has(header.dataset.ext) && content) {
      header.classList.add('expanded');
      content.classList.add('expanded');
    }
    header.addEventListener('click', (e) => {
      e.stopPropagation();
      if (content) {
        header.classList.toggle('expanded');
        content.classList.toggle('expanded');
      }
    });
  });

  const more = assetsContainer.querySelector('.show-more-assets');
  if (more) {
    const btn = more.querySelector('button');
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = 'Loading files...';
      try {
        await pager.next();
        renderAssetPages(assetsContainer, itemId);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = `Failed to load files: ${err.message}. Try again`;
      }
    });
  }
}

// Handle browser back/forward buttons
window.addEventListener('popstate', (event) => {
  const collectionId = event.state?.collection || null;
  const expandedItem = event.state?.expandedItem || null;
  const openDayId = event.state?.openDay || null;

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
      expandItemById(expandedItem, openDayId);
    } else if (expandedItem) {
      // Same series - open or close a day
      const row = document.querySelector(`.file-item.file[data-item-id="${expandedItem}"]`);
      syncOpenDay(row && document.getElementById(row.dataset.metaTarget), openDayId);
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
    currentOpenDay = null;
    // Preserve current filters when navigating back
    loadCollections(false);
  }
});

// Parse initial URL hash on page load
function parseHash() {
  const hash = window.location.hash;
  const result = { collection: null, item: null, day: null };

  const collectionMatch = hash.match(/collection=([^&]+)/);
  if (collectionMatch) {
    result.collection = decodeURIComponent(collectionMatch[1]);
  }

  const itemMatch = hash.match(/item=([^&]+)/);
  if (itemMatch) {
    result.item = decodeURIComponent(itemMatch[1]);
  }

  const dayMatch = hash.match(/day=([^&]+)/);
  if (dayMatch) {
    result.day = decodeURIComponent(dayMatch[1]);
  }

  return result;
}

// Initialize with proper history state
async function initializeApp() {
  const { collection: initialCollection, item: initialItem, day: initialDay } = parseHash();

  // Set initial history state (replace, don't push)
  replaceHistoryState(initialCollection, initialItem, initialDay);

  if (initialCollection) {
    // Load collections first (to populate filters), then load the specific collection
    await loadCollections(false);
    await loadCollection(initialCollection, false, false);

    // If there's an initial item to expand, expand it now (DOM is ready after loadCollection)
    if (initialItem) {
      await expandItemById(initialItem, initialDay);
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

// Format date range as separate parts for aligned columns
function formatDateParts(start, end) {
  if (!start && !end) return { start: '-', sep: '', end: '' };
  const startStr = start ? formatDate(start) : '...';
  const endStr = end ? formatDate(end) : 'ongoing';
  if (start === end || !end) return { start: startStr, sep: '', end: '' };
  return { start: startStr, sep: '\u2192', end: endStr };
}

// Get file icon based on format
function getIcon(format) {
  return '';
}

// Get icon for a collection based on its ID
function getCollectionIcon(collectionId) {
  return '';
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Focus, text and cursor of the search box, read from the live element
function captureSearchState() {
  const input = document.getElementById('searchFilter');
  if (!input || document.activeElement !== input) return null;
  return { value: input.value, start: input.selectionStart, end: input.selectionEnd };
}

function restoreSearchState(state) {
  const input = document.getElementById('searchFilter');
  if (!state || !input) return;
  input.value = state.value;
  input.focus();
  input.setSelectionRange(state.start, state.end);
}

// Update breadcrumb and filters
function updateBreadcrumb() {
  const breadcrumb = document.getElementById('fileBreadcrumb');
  breadcrumb.style.display = 'flex';
  const searchState = captureSearchState();

  // Build dropdown options
  const sensorOptions = allSensors.map(s =>
    `<option value="${s}" ${currentFilters.sensor === s ? 'selected' : ''}>${s}</option>`
  ).join('');

  const sourceOptions = allSources.map(s =>
    `<option value="${s}" ${currentFilters.source === s ? 'selected' : ''}>${s}</option>`
  ).join('');

  const processingLevelOptions = allProcessingLevels.map(level =>
    `<option value="${level}" ${currentFilters.processingLevel === level ? 'selected' : ''}>Level ${level}</option>`
  ).join('');

  // Check if any advanced filters (date/bbox) are active
  const hasAdvancedFilters = currentFilters.dateFrom || currentFilters.dateTo || currentFilters.bbox;
  const hasAnyFilter = currentFilters.search || currentFilters.sensor || currentFilters.source || currentFilters.processingLevel || hasAdvancedFilters;

  const titleHtml = !currentCollection
    ? `<span>All Collections</span>`
    : `<a href="#" id="backToCollections">&larr; All Collections</a>
       <span class="file-nav-sep">/</span>
       <span class="file-nav-collection">${(collections.find(c => c.id === currentCollection)?.title) || currentCollection}</span>`;

  // Current bbox display values
  const bboxDisplay = currentFilters.bbox || dataBboxExtent;
  const bboxIsFiltered = !!currentFilters.bbox;

  breadcrumb.innerHTML = `
    <div class="filter-layout">
      <div class="filter-layout-left">
        <div class="file-nav-title">
          ${titleHtml}
          <button id="clearAllFilters" class="clear-all-filters-btn ${hasAnyFilter ? 'active' : ''}" ${hasAnyFilter ? '' : 'disabled'}>Clear</button>
        </div>
        <div class="filter-row">
          <div class="search-input-wrapper">
            <input type="text" id="searchFilter" placeholder="Search..." value="${escapeAttr(currentFilters.search)}">
            <button class="search-clear-btn" id="searchClearBtn" style="display: ${currentFilters.search ? 'flex' : 'none'};" title="Clear search">&times;</button>
          </div>
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
        </div>
        ${dataDateMin && dataDateMax ? `
        <div class="filter-group filter-group-date-range">
          <label>Date Range</label>
          <div class="date-range-container">
            <div class="date-range-labels">
              <span id="dateFromLabel">${currentFilters.dateFrom ? new Date(currentFilters.dateFrom).toISOString().slice(0, 10) : dataDateMin.toISOString().slice(0, 10)}</span>
              <span id="dateToLabel">${currentFilters.dateTo ? new Date(currentFilters.dateTo).toISOString().slice(0, 10) : dataDateMax.toISOString().slice(0, 10)}</span>
            </div>
            <div class="date-range-slider">
              <input type="range" id="dateFromSlider" min="0" max="1000" value="${currentFilters.dateFrom ? Math.round((new Date(currentFilters.dateFrom) - dataDateMin) / (dataDateMax - dataDateMin) * 1000) : 0}">
              <input type="range" id="dateToSlider" min="0" max="1000" value="${currentFilters.dateTo ? Math.round((new Date(currentFilters.dateTo) - dataDateMin) / (dataDateMax - dataDateMin) * 1000) : 1000}">
            </div>
          </div>
        </div>
        ` : ''}
      </div>
    </div>
  `;

  // Create the persistent right column (map + coords) once, reuse on re-renders
  if (!bboxMapRight) {
    bboxMapRight = document.createElement('div');
    bboxMapRight.className = 'filter-controls-right';
    bboxMapRight.innerHTML = `
      <div id="bboxMapContainer" class="bbox-map-container"></div>
      <div class="bbox-coords-display" id="bboxCoordsDisplay">
        <span class="bbox-coord-label">SW</span>
        <span id="bboxSW" class="bbox-coord-val">-</span>
        <span class="bbox-coord-label">NE</span>
        <span id="bboxNE" class="bbox-coord-val">-</span>
        <button id="bboxEditToggle" class="bbox-edit-toggle-btn" title="Edit coordinates">&#9998;</button>
        <button id="bboxReset" class="bbox-reset-btn" title="Reset to full extent" style="display:none">&times;</button>
      </div>
      <div class="bbox-coords-edit" id="bboxCoordsEdit" style="display: none;">
        <div class="bbox-edit-grid">
          <label>W</label><input type="number" id="bboxEditW" class="bbox-coord-input" step="0.0001"><span></span><label>S</label><input type="number" id="bboxEditS" class="bbox-coord-input" step="0.0001">
          <label>E</label><input type="number" id="bboxEditE" class="bbox-coord-input" step="0.0001"><span></span><label>N</label><input type="number" id="bboxEditN" class="bbox-coord-input" step="0.0001">
        </div>
        <div class="bbox-edit-actions">
          <button id="bboxEditClose" class="bbox-edit-close-btn" title="Back">&#8617;</button>
        </div>
      </div>
    `;
  }

  // Append persistent right column into the filter layout
  const filterLayout = breadcrumb.querySelector('.filter-layout');
  if (filterLayout) filterLayout.appendChild(bboxMapRight);

  // Update coord display and reset button visibility
  updateBboxCoordsDisplay();
  const resetBtn = document.getElementById('bboxReset');
  if (resetBtn) resetBtn.style.display = bboxIsFiltered ? '' : 'none';

  // Back button (only exists in collection view)
  const backBtn = document.getElementById('backToCollections');
  if (backBtn) {
    backBtn.addEventListener('click', (e) => {
      e.preventDefault();
      pushHistoryState(null, null);
      currentCollection = null;
      currentExpandedItem = null;
      currentOpenDay = null;
      loadCollections(false);
    });
  }

  // Attach filter event listeners
  // Search clear button (x inside search input)
  document.getElementById('searchClearBtn').addEventListener('click', () => {
    currentFilters.search = '';
    const searchInput = document.getElementById('searchFilter');
    if (searchInput) {
      searchInput.value = '';
      searchInput.focus();
    }
    document.getElementById('searchClearBtn').style.display = 'none';
    applyServerFiltersDebounced(true);
  });

  // Text search - server-side, debounced
  document.getElementById('searchFilter').addEventListener('input', (e) => {
    currentFilters.search = e.target.value;
    // Show/hide the clear button
    document.getElementById('searchClearBtn').style.display = e.target.value ? 'flex' : 'none';
    applyServerFiltersDebounced();
  });

  // Sensor - server-side, immediate
  document.getElementById('sensorFilter').addEventListener('change', (e) => {
    currentFilters.sensor = e.target.value;
    applyServerFiltersDebounced(true);
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

  // Inline clear all filters button
  document.getElementById('clearAllFilters').addEventListener('click', () => {
    currentFilters = {
      search: '', sensor: '', source: '', processingLevel: '',
      dateFrom: '', dateTo: '', bbox: null
    };
    applyServerFiltersDebounced(true);
  });

  // Date range slider - server-side, debounced
  const dateFromSlider = document.getElementById('dateFromSlider');
  const dateToSlider = document.getElementById('dateToSlider');
  if (dateFromSlider && dateToSlider && dataDateMin && dataDateMax) {
    const totalMs = dataDateMax.getTime() - dataDateMin.getTime();

    const sliderToDate = (val) => {
      return new Date(dataDateMin.getTime() + (val / 1000) * totalMs);
    };

    const updateDateLabels = () => {
      const fromDate = sliderToDate(parseInt(dateFromSlider.value));
      const toDate = sliderToDate(parseInt(dateToSlider.value));
      const fromLabel = document.getElementById('dateFromLabel');
      const toLabel = document.getElementById('dateToLabel');
      if (fromLabel) fromLabel.textContent = fromDate.toISOString().slice(0, 10);
      if (toLabel) toLabel.textContent = toDate.toISOString().slice(0, 10);
    };

    const onSliderInput = () => {
      // Ensure from <= to
      if (parseInt(dateFromSlider.value) > parseInt(dateToSlider.value)) {
        dateFromSlider.value = dateToSlider.value;
      }
      updateDateLabels();

      const fromVal = parseInt(dateFromSlider.value);
      const toVal = parseInt(dateToSlider.value);
      // Only set filters if not at extremes
      currentFilters.dateFrom = fromVal > 0 ? sliderToDate(fromVal).toISOString() : '';
      currentFilters.dateTo = toVal < 1000 ? sliderToDate(toVal).toISOString() : '';
      clearTimeout(serverFilterDebounceTimer);
      serverFilterDebounceTimer = setTimeout(() => applyServerFilters(), 100);
    };

    dateFromSlider.addEventListener('input', onSliderInput);
    dateToSlider.addEventListener('input', onSliderInput);
  }

  // Initialize the bbox map if it doesn't exist yet; otherwise just refresh overlays
  if (!bboxFilterMap) {
    initBboxFilterMap();
    initBboxControls();
  } else {
    // Don't zoom here when loading a collection - loadCollection will zoom after items are loaded
    if (!currentCollection) {
      updateBboxOverlays();
    }
  }

  restoreSearchState(searchState);
}

// Update the bbox coordinate display and edit inputs from current filter state
function updateBboxCoordsDisplay(viewExtent) {
  const bbox = currentFilters.bbox || viewExtent || dataBboxExtent;
  if (!bbox) return;
  const swEl = document.getElementById('bboxSW');
  const neEl = document.getElementById('bboxNE');
  if (swEl) swEl.textContent = `${bbox[0].toFixed(4)}, ${bbox[1].toFixed(4)}`;
  if (neEl) neEl.textContent = `${bbox[2].toFixed(4)}, ${bbox[3].toFixed(4)}`;
  const wEl = document.getElementById('bboxEditW');
  const sEl = document.getElementById('bboxEditS');
  const eEl = document.getElementById('bboxEditE');
  const nEl = document.getElementById('bboxEditN');
  if (wEl) wEl.value = bbox[0].toFixed(4);
  if (sEl) sEl.value = bbox[1].toFixed(4);
  if (eEl) eEl.value = bbox[2].toFixed(4);
  if (nEl) nEl.value = bbox[3].toFixed(4);
}

// Attach event listeners to persistent bbox controls (called once)
function initBboxControls() {
  document.getElementById('bboxReset')?.addEventListener('click', () => {
    currentFilters.bbox = null;
    applyServerFiltersDebounced(true);
  });

  const bboxCoordsDisplay = document.getElementById('bboxCoordsDisplay');
  const bboxCoordsEdit = document.getElementById('bboxCoordsEdit');

  document.getElementById('bboxEditToggle')?.addEventListener('click', () => {
    if (bboxCoordsDisplay) bboxCoordsDisplay.style.display = 'none';
    if (bboxCoordsEdit) bboxCoordsEdit.style.display = 'flex';
  });

  document.getElementById('bboxEditClose')?.addEventListener('click', () => {
    if (bboxCoordsDisplay) bboxCoordsDisplay.style.display = 'flex';
    if (bboxCoordsEdit) bboxCoordsEdit.style.display = 'none';
  });

  let bboxInputTimer = null;
  function updateMapFromInputs() {
    const w = parseFloat(document.getElementById('bboxEditW')?.value);
    const s = parseFloat(document.getElementById('bboxEditS')?.value);
    const e = parseFloat(document.getElementById('bboxEditE')?.value);
    const n = parseFloat(document.getElementById('bboxEditN')?.value);
    if (isNaN(w) || isNaN(s) || isNaN(e) || isNaN(n) || w >= e || s >= n) return;
    if (bboxFilterRect) {
      bboxFilterRect.setBounds([[s, w], [n, e]]);
      bboxFilterRect.setStyle({ color: '#0066cc', fillOpacity: 0.15, dashArray: '5, 5' });
    }
    const swEl = document.getElementById('bboxSW');
    const neEl = document.getElementById('bboxNE');
    if (swEl) swEl.textContent = `${w.toFixed(4)}, ${s.toFixed(4)}`;
    if (neEl) neEl.textContent = `${e.toFixed(4)}, ${n.toFixed(4)}`;
    clearTimeout(bboxInputTimer);
    bboxInputTimer = setTimeout(() => {
      currentFilters.bbox = [w, s, e, n];
      applyServerFiltersDebounced(true);
    }, 500);
  }

  ['bboxEditW', 'bboxEditS', 'bboxEditE', 'bboxEditN'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateMapFromInputs);
  });
}

// Initialize the bbox filter map (called once)
function initBboxFilterMap() {
  const container = document.getElementById('bboxMapContainer');
  if (!container || !dataBboxExtent) return;

  const [west, south, east, north] = dataBboxExtent;
  const paddedInit = padBbox(dataBboxExtent);

  const activeBbox = currentFilters.bbox || paddedInit;
  const [aw, as, ae, an] = activeBbox;

  const map = L.map(container, {
    zoomControl: false,
    attributionControl: false,
    scrollWheelZoom: true,
    doubleClickZoom: true
  });

  L.tileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg', {
    maxZoom: 19,
    opacity: 0.65
  }).addTo(map);

  map.fitBounds([[paddedInit[1], paddedInit[0]], [paddedInit[3], paddedInit[2]]], { padding: [5, 5] });

  // Overlay group added after filter rect (below) so item overlays render on top
  bboxOverlayGroup = L.layerGroup();

  // Zoom-to-extent control
  const ZoomExtentControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const btn = L.DomUtil.create('button', 'bbox-map-zoom-extent-btn');
      btn.innerHTML = '<svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 5.5L1 1m0 0h3m-3 0v3m7.5 1.5L13 1m0 0h-3m3 0v3M5.5 8.5L1 13m0 0h3m-3 0v-3m7.5-1.5L13 13m0 0h-3m3 0v-3"/></svg>';
      btn.title = 'Zoom to extent';
      btn.setAttribute('aria-label', btn.title);
      L.DomEvent.disableClickPropagation(btn);
      btn.addEventListener('click', () => {
        const extent = padBbox(computeOverlayExtent() || dataBboxExtent);
        if (extent) {
          const [w, s, e, n] = extent;
          map.fitBounds([[s, w], [n, e]], { padding: [5, 5], animate: true });
        }
      });
      return btn;
    }
  });
  map.addControl(new ZoomExtentControl());

  // Expand/collapse map height control
  const ExpandHeightControl = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd() {
      const btn = L.DomUtil.create('button', 'bbox-map-expand-height-btn');
      const chevDown = '<svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5l4 4 4-4"/></svg>';
      const chevUp = '<svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l4-4 4 4"/></svg>';
      btn.innerHTML = chevDown;
      btn.title = 'Expand map';
      btn.setAttribute('aria-label', btn.title);
      L.DomEvent.disableClickPropagation(btn);
      btn.addEventListener('click', () => {
        const tall = container.classList.toggle('bbox-map-tall');
        btn.innerHTML = tall ? chevUp : chevDown;
        btn.title = tall ? 'Collapse map' : 'Expand map';
        btn.setAttribute('aria-label', btn.title);
        // Invalidate map size after CSS transition, then fit to extent on collapse
        setTimeout(() => {
          map.invalidateSize();
          if (!tall) {
            const extent = padBbox(computeOverlayExtent() || dataBboxExtent);
            if (extent) {
              const [w, s, e, n] = extent;
              map.fitBounds([[s, w], [n, e]], { padding: [5, 5], animate: true });
            }
          }
        }, 220);
      });
      return btn;
    }
  });
  map.addControl(new ExpandHeightControl());

  // Filter rect — always visible, non-interactive (events pass through to overlays/map)
  bboxFilterRect = L.rectangle([[as, aw], [an, ae]], {
    color: '#0066cc',
    weight: 2,
    fillOpacity: 0.12,
    dashArray: '5, 5',
    interactive: false
  }).addTo(map);

  // Add overlay group on top of filter rect so item overlays intercept clicks first
  bboxOverlayGroup.addTo(map);
  addBboxOverlays(map);

  // Click outside the filter rect clears an active bbox filter
  map.on('click', (e) => {
    // Don't clear if we're in the middle of a drag operation
    if (bboxEdgeDragging || cornerDragging) return;
    if (!currentFilters.bbox) return;
    if (!bboxFilterRect.getBounds().contains(e.latlng)) {
      currentFilters.bbox = null;
      applyServerFiltersDebounced(true);
    }
  });

  // Create 4 draggable corner markers
  const mkIcon = (dir) => L.divIcon({ className: `bbox-corner-marker bbox-corner-marker-${dir}`, iconSize: [12, 12], iconAnchor: [6, 6] });
  const sw = L.marker([as, aw], { icon: mkIcon('sw'), draggable: true, zIndexOffset: 1000 }).addTo(map);
  const ne = L.marker([an, ae], { icon: mkIcon('ne'), draggable: true, zIndexOffset: 1000 }).addTo(map);
  const nw = L.marker([an, aw], { icon: mkIcon('nw'), draggable: true, zIndexOffset: 1000 }).addTo(map);
  const se = L.marker([as, ae], { icon: mkIcon('se'), draggable: true, zIndexOffset: 1000 }).addTo(map);
  bboxCornerMarkers = { sw, ne, nw, se };

  function updateRectFromCorners() {
    const swll = sw.getLatLng();
    const nell = ne.getLatLng();
    const bounds = L.latLngBounds(swll, nell);
    bboxFilterRect.setBounds(bounds);
    // Sync the other two corners
    nw.setLatLng([nell.lat, swll.lng]);
    se.setLatLng([swll.lat, nell.lng]);
    // Update coordinate display
    updateBboxDisplay(swll.lng, swll.lat, nell.lng, nell.lat);
  }

  function updateBboxDisplay(w, s, e, n) {
    const swEl = document.getElementById('bboxSW');
    const neEl = document.getElementById('bboxNE');
    if (swEl) swEl.textContent = `${w.toFixed(4)}, ${s.toFixed(4)}`;
    if (neEl) neEl.textContent = `${e.toFixed(4)}, ${n.toFixed(4)}`;
    // Also update edit inputs if they exist
    const wEl = document.getElementById('bboxEditW');
    const sEl = document.getElementById('bboxEditS');
    const eEl = document.getElementById('bboxEditE');
    const nEl = document.getElementById('bboxEditN');
    if (wEl) wEl.value = w.toFixed(4);
    if (sEl) sEl.value = s.toFixed(4);
    if (eEl) eEl.value = e.toFixed(4);
    if (nEl) nEl.value = n.toFixed(4);
  }

  function applyBboxFromCorners() {
    const swll = sw.getLatLng();
    const nell = ne.getLatLng();
    const newBbox = [
      Math.round(swll.lng * 10000) / 10000,
      Math.round(swll.lat * 10000) / 10000,
      Math.round(nell.lng * 10000) / 10000,
      Math.round(nell.lat * 10000) / 10000
    ];
    // Check if bbox matches full extent (no filter needed)
    const tolerance = 0.001;
    const isFullExtent = Math.abs(newBbox[0] - west) < tolerance &&
      Math.abs(newBbox[1] - south) < tolerance &&
      Math.abs(newBbox[2] - east) < tolerance &&
      Math.abs(newBbox[3] - north) < tolerance;
    currentFilters.bbox = isFullExtent ? null : newBbox;
    applyServerFiltersDebounced(true);
  }

  // Drag handlers for SW corner
  sw.on('drag', () => {
    const swll = sw.getLatLng();
    const nell = ne.getLatLng();
    // Clamp: SW must stay south-west of NE
    if (swll.lat >= nell.lat) sw.setLatLng([nell.lat - 0.001, swll.lng]);
    if (swll.lng >= nell.lng) sw.setLatLng([swll.lat, nell.lng - 0.001]);
    updateRectFromCorners();
  });
  sw.on('dragend', applyBboxFromCorners);

  // Drag handlers for NE corner
  ne.on('drag', () => {
    const swll = sw.getLatLng();
    const nell = ne.getLatLng();
    if (nell.lat <= swll.lat) ne.setLatLng([swll.lat + 0.001, nell.lng]);
    if (nell.lng <= swll.lng) ne.setLatLng([nell.lat, swll.lng + 0.001]);
    updateRectFromCorners();
  });
  ne.on('dragend', applyBboxFromCorners);

  // Drag handlers for NW corner (moves N of SW and W of NE)
  nw.on('drag', () => {
    const nwll = nw.getLatLng();
    const sell = se.getLatLng();
    const nell = ne.getLatLng();
    sw.setLatLng([sw.getLatLng().lat, nwll.lng]);
    ne.setLatLng([nwll.lat, nell.lng]);
    updateRectFromCorners();
  });
  nw.on('dragend', applyBboxFromCorners);

  // Drag handlers for SE corner
  se.on('drag', () => {
    const sell = se.getLatLng();
    const nwll = nw.getLatLng();
    sw.setLatLng([sell.lat, sw.getLatLng().lng]);
    ne.setLatLng([ne.getLatLng().lat, sell.lng]);
    updateRectFromCorners();
  });
  se.on('dragend', applyBboxFromCorners);

  // Edge-proximity detection: returns true if latlng is within thresholdPx of any filter rect edge
  function isNearBboxEdge(latlng, thresholdPx = 5) {
    if (!bboxFilterRect) return false;
    const bounds = bboxFilterRect.getBounds();
    const point = map.latLngToContainerPoint(latlng);
    const swPx = map.latLngToContainerPoint(bounds.getSouthWest());
    const nePx = map.latLngToContainerPoint(bounds.getNorthEast());
    // In screen coords: ne.y < sw.y (y increases downward)
    const left = swPx.x, right = nePx.x, top = nePx.y, bottom = swPx.y;
    const x = point.x, y = point.y;
    // Must be within expanded rect (rect + threshold margin)
    if (x < left - thresholdPx || x > right + thresholdPx ||
        y < top - thresholdPx || y > bottom + thresholdPx) return false;
    // Near any of the 4 edges?
    return Math.abs(x - left) <= thresholdPx ||
           Math.abs(x - right) <= thresholdPx ||
           Math.abs(y - top) <= thresholdPx ||
           Math.abs(y - bottom) <= thresholdPx;
  }

  // Edge-only dragging: filter rect can be moved by grabbing its edges at any time
  let rectDragStart = null;
  const mapContainer = map.getContainer();

  [sw, ne, nw, se].forEach(m => {
    m.on('dragstart', () => { cornerDragging = true; });
    m.on('dragend', () => { setTimeout(() => { cornerDragging = false; }, 50); });
  });

  // Capture-phase mousedown: intercepts before Leaflet when near a filter rect edge
  mapContainer.addEventListener('mousedown', (e) => {
    if (cornerDragging) return;
    // Let corner marker clicks pass through — corners sit on edges
    if (e.target.closest('.bbox-corner-marker')) return;
    // Let overlay clicks pass through — they should trigger zoom-to-bbox
    if (e.target.closest('.bbox-overlay-clickable')) return;
    const rect = mapContainer.getBoundingClientRect();
    const containerPoint = L.point(e.clientX - rect.left, e.clientY - rect.top);
    const latlng = map.containerPointToLatLng(containerPoint);
    if (isNearBboxEdge(latlng)) {
      e.stopPropagation();
      e.preventDefault();
      bboxEdgeDragging = true;
      rectDragStart = latlng;
      map.dragging.disable();
      mapContainer.classList.add('bbox-edge-dragging');
    }
  }, true);

  // DOM-level mousemove for cursor changes (fires even over interactive overlays)
  let edgeHoverActive = false;
  mapContainer.addEventListener('mousemove', (e) => {
    if (bboxEdgeDragging || cornerDragging) return;
    // Don't override cursor when hovering corner markers
    if (e.target.closest('.bbox-corner-marker')) {
      if (edgeHoverActive) {
        edgeHoverActive = false;
        mapContainer.classList.remove('bbox-edge-hover');
        for (const r of Object.values(bboxOverlayLayers)) {
          if (r._path) r._path.style.cursor = '';
        }
      }
      return;
    }
    const rect = mapContainer.getBoundingClientRect();
    const containerPoint = L.point(e.clientX - rect.left, e.clientY - rect.top);
    const latlng = map.containerPointToLatLng(containerPoint);
    const nearEdge = isNearBboxEdge(latlng);
    if (nearEdge !== edgeHoverActive) {
      edgeHoverActive = nearEdge;
      mapContainer.classList.toggle('bbox-edge-hover', nearEdge);
      // Set inline cursor on overlay paths to guarantee override of their CSS
      for (const r of Object.values(bboxOverlayLayers)) {
        if (r._path) r._path.style.cursor = nearEdge ? 'move' : '';
      }
    }
  });

  // Leaflet-level mousemove for drag movement (not blocked by bubblingMouseEvents)
  map.on('mousemove', (e) => {
    if (!bboxEdgeDragging || !rectDragStart) return;
    const dlat = e.latlng.lat - rectDragStart.lat;
    const dlng = e.latlng.lng - rectDragStart.lng;
    rectDragStart = e.latlng;
    const swll = sw.getLatLng();
    const nell = ne.getLatLng();
    sw.setLatLng([swll.lat + dlat, swll.lng + dlng]);
    ne.setLatLng([nell.lat + dlat, nell.lng + dlng]);
    updateRectFromCorners();
  });

  // End edge drag on mouseup
  map.on('mouseup', () => {
    if (bboxEdgeDragging) {
      rectDragStart = null;
      map.dragging.enable();
      mapContainer.classList.remove('bbox-edge-dragging');
      applyBboxFromCorners();
      setTimeout(() => { bboxEdgeDragging = false; }, 150);
    }
  });

  // Backup: end drag if mouse leaves map container
  document.addEventListener('mouseup', () => {
    if (bboxEdgeDragging) {
      rectDragStart = null;
      map.dragging.enable();
      mapContainer.classList.remove('bbox-edge-dragging');
      applyBboxFromCorners();
      setTimeout(() => { bboxEdgeDragging = false; }, 150);
    }
  });

  bboxFilterMap = map;
}

// Normalize a STAC bbox to 4-element [west, south, east, north].
// Handles both 4-element (2D) and 6-element (3D with elevation) formats.
function normalizeBbox(bbox) {
  if (!bbox || bbox.length < 4) return null;
  if (bbox.length === 6) return [bbox[0], bbox[1], bbox[3], bbox[4]];
  return bbox;
}

// Pad a bbox [w, s, e, n] by a fraction of its size on each side (default 5%)
function padBbox(bbox, fraction = 0.15) {
  const [w, s, e, n] = bbox;
  const dw = (e - w) * fraction;
  const dh = (n - s) * fraction;
  return [w - dw, s - dh, e + dw, n + dh];
}

// Compute the combined extent [w, s, e, n] of all current overlay bboxes
function computeOverlayExtent() {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  let count = 0;
  if (!currentCollection) {
    for (const col of visibleCollections) {
      const bbox = col.extent?.spatial?.bbox?.[0];
      if (!bbox || bbox.length < 4) continue;
      w = Math.min(w, bbox[0]); s = Math.min(s, bbox[1]);
      e = Math.max(e, bbox[2]); n = Math.max(n, bbox[3]);
      count++;
    }
  } else {
    for (const item of items) {
      const bbox = normalizeBbox(item.bbox);
      if (!bbox) continue;
      w = Math.min(w, bbox[0]); s = Math.min(s, bbox[1]);
      e = Math.max(e, bbox[2]); n = Math.max(n, bbox[3]);
      count++;
    }
  }
  return count > 0 ? [w, s, e, n] : null;
}

// Reset the filter rect bounds and corner marker positions to match current state.
// viewExtent is the default extent when no bbox filter is active (e.g. item-level extent).
function resetBboxRect(viewExtent) {
  if (!bboxFilterRect || !bboxCornerMarkers || !dataBboxExtent) return;
  if (bboxEdgeDragging || cornerDragging) return;
  const fallback = padBbox(viewExtent || dataBboxExtent);
  const bbox = currentFilters.bbox || fallback;
  const [w, s, e, n] = bbox;
  bboxFilterRect.setBounds([[s, w], [n, e]]);
  bboxFilterRect.setStyle({
    color: '#0066cc',
    fillOpacity: 0.12,
    dashArray: '5, 5'
  });
  bboxCornerMarkers.sw.setLatLng([s, w]);
  bboxCornerMarkers.ne.setLatLng([n, e]);
  bboxCornerMarkers.nw.setLatLng([n, w]);
  bboxCornerMarkers.se.setLatLng([s, e]);
}

// Refresh overlays on the existing map (called when data changes but map persists)
function updateBboxOverlays() {
  if (!bboxFilterMap) return;
  if (bboxEdgeDragging || cornerDragging) return;
  // Clear old overlays from the dedicated layer group
  if (bboxOverlayGroup) bboxOverlayGroup.clearLayers();
  addBboxOverlays(bboxFilterMap);

  const viewExtent = computeOverlayExtent() || dataBboxExtent;
  const paddedExtent = viewExtent ? padBbox(viewExtent) : null;
  
  if (currentFilters.bbox) {
    // Filter active — zoom to fit items but keep rect at user's filter position
    if (paddedExtent) {
      const [pw, ps, pe, pn] = paddedExtent;
      bboxFilterMap.fitBounds([[ps, pw], [pn, pe]], { padding: [5, 5], animate: true });
    }
    // Don't reset rect; it stays where the user placed it
  } else {
    // No filter — zoom to fit all overlays and reset rect to full extent
    if (paddedExtent) {
      const [pw, ps, pe, pn] = paddedExtent;
      // Invalidate size first to ensure map is ready
      bboxFilterMap.invalidateSize();
      setTimeout(() => {
        bboxFilterMap.fitBounds([[ps, pw], [pn, pe]], { padding: [5, 5], animate: true });
      }, 50);
    }
    resetBboxRect(viewExtent);
  }

  // Update reset button and coords display
  const resetBtn = document.getElementById('bboxReset');
  if (resetBtn) resetBtn.style.display = currentFilters.bbox ? '' : 'none';
  updateBboxCoordsDisplay(viewExtent);
}

// Draw bbox overlays for collections or items on the filter map
function addBboxOverlays(map) {
  bboxOverlayLayers = {};

  const overlayStyle = {
    color: '#9333ea',
    fillColor: '#a855f7',
    fillOpacity: 0.15,
    weight: 2,
    interactive: true,
    bubblingMouseEvents: false,
    className: 'bbox-overlay-clickable'
  };

  const highlightStyle = {
    color: '#7e22ce',
    fillColor: '#9333ea',
    fillOpacity: 0.25,
    weight: 3
  };

  function addOverlay(id, bbox, label) {
    const [w, s, e, n] = bbox;
    if (w == null || s == null || e == null || n == null) return;
    const targetLayer = bboxOverlayGroup || map;
    const rect = L.rectangle([[s, w], [n, e]], overlayStyle)
      .bindTooltip(label, { sticky: true, direction: 'top', opacity: 0.85 })
      .addTo(targetLayer);
    bboxOverlayLayers[id] = rect;
    rect._overlayId = id;
    rect.on('mouseover', () => {
      rect.setStyle(highlightStyle);
      highlightRow(id, true);
    });
    rect.on('mouseout', () => {
      rect.setStyle(overlayStyle);
      highlightRow(id, false);
    });
    rect.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (!currentCollection) {
        loadCollection(id);
      } else {
        const row = document.querySelector(`.file-item.file[data-item-id="${id}"] .file-row`);
        if (row) row.click();
      }
    });
  }

  if (!currentCollection) {
    for (const col of visibleCollections) {
      const bbox = col.extent?.spatial?.bbox?.[0];
      if (!bbox || bbox.length < 4) continue;
      addOverlay(col.id, bbox, col.title || col.id);
    }
  } else {
    for (const item of items) {
      const bbox = normalizeBbox(item.bbox);
      if (!bbox) continue;
      addOverlay(item.id, bbox, item.properties?.title || item.id);
    }
  }
}

function highlightRow(id, highlight) {
  const selector = currentCollection
    ? `.file-item[data-item-id="${id}"]`
    : `.collection-item[data-collection="${id}"]`;
  const row = document.querySelector(selector);
  if (row) {
    row.classList.toggle('map-highlight', highlight);
  }
}

function highlightOverlay(id, highlight) {
  const rect = bboxOverlayLayers[id];
  if (!rect) return;
  if (highlight) {
    rect.setStyle({ color: '#7e22ce', fillColor: '#9333ea', fillOpacity: 0.25, weight: 3 });
    rect.bringToFront();
  } else {
    rect.setStyle({ color: '#9333ea', fillColor: '#a855f7', fillOpacity: 0.15, weight: 2 });
  }
}

// Apply server-side filters with debounce
function applyServerFiltersDebounced(immediate = false) {
  clearTimeout(serverFilterDebounceTimer);
  serverFilterDebounceTimer = null;

  const doFilter = async () => {
    await applyServerFilters();
  };

  if (immediate) {
    doFilter();
  } else {
    serverFilterDebounceTimer = setTimeout(doFilter, 300);
  }
}

// Apply filters to current view (with debounce for search)
function applyFilters(immediate = false) {
  const doFilter = () => {
    if (currentCollection) {
      renderItems();
    } else {
      renderCollections();
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
  if (currentFilters.sensor) params.set('sensor', currentFilters.sensor);
  if (currentFilters.search) params.set('q', currentFilters.search);

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
    await loadCollection(currentCollection, true);
  } else {
    await loadCollections(false);
  }
}

// Render collections list
function renderCollections() {
  currentCollection = null;

  // Compute filtered collections BEFORE updateBreadcrumb so map overlays match the list
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

  // Filter by date range (check overlap with collection temporal extent)
  if (currentFilters.dateFrom || currentFilters.dateTo) {
    const filterFrom = currentFilters.dateFrom ? new Date(currentFilters.dateFrom) : null;
    const filterTo = currentFilters.dateTo ? new Date(currentFilters.dateTo) : null;
    filteredCollections = filteredCollections.filter(c => {
      const interval = c.extent?.temporal?.interval?.[0];
      if (!interval) return false;
      const collStart = interval[0] ? new Date(interval[0]) : null;
      const collEnd = interval[1] ? new Date(interval[1]) : null;
      // Overlap check: exclude if filter ends before collection starts, or collection ends before filter starts
      if (filterTo && collStart && filterTo < collStart) return false;
      if (filterFrom && collEnd && collEnd < filterFrom) return false;
      return true;
    });
  }

  // Filter by bbox (check overlap with collection spatial extent)
  if (currentFilters.bbox?.length === 4) {
    const [fWest, fSouth, fEast, fNorth] = currentFilters.bbox;
    filteredCollections = filteredCollections.filter(c => {
      const spatial = c.extent?.spatial?.bbox?.[0];
      if (!spatial || spatial.length < 4) return false;
      const [cWest, cSouth, cEast, cNorth] = spatial;
      // No overlap if filter is entirely outside collection
      return !(cEast < fWest || cWest > fEast || cNorth < fSouth || cSouth > fNorth);
    });
  }

  // Filter by search text (title/description match + cross-collection item search)
  if (currentFilters.search) {
    const words = currentFilters.search.toLowerCase().split(/\s+/).filter(Boolean);
    filteredCollections = filteredCollections.filter(c => {
      const title = (c.title || c.id || '').toLowerCase();
      const description = (c.description || '').toLowerCase();
      const text = title + ' ' + description;
      const titleMatch = words.every(w => text.includes(w));
      // Also include collections that have matching items (from search results)
      const itemMatch = (c._searchMatchCount || 0) > 0;
      return titleMatch || itemMatch;
    });
  }

  // Store filtered list for map overlays, then update UI
  visibleCollections = filteredCollections;
  updateBreadcrumb();

  const container = document.getElementById('fileList');
  document.getElementById('fileCount').textContent = `(${filteredCollections.length} collection${filteredCollections.length !== 1 ? 's' : ''})`;

  if (filteredCollections.length === 0) {
    container.innerHTML = '<div class="empty">No collections match the current filters</div>';
    return;
  }

  container.innerHTML = filteredCollections.map(collection => {
    const itemCount = collection._itemCount || 0;
    const searchMatchCount = collection._searchMatchCount || 0;
    const temporal = collection.extent?.temporal?.interval?.[0];
    const dateParts = temporal ? formatDateParts(temporal[0], temporal[1]) : { start: '-', sep: '', end: '' };
    const badgeText = searchMatchCount > 0
      ? `${searchMatchCount} match${searchMatchCount !== 1 ? 'es' : ''}`
      : (itemCount > 0 ? `${itemCount} item${itemCount !== 1 ? 's' : ''}` : '');

    return `
      <div class="file-item folder collection-item" data-collection="${collection.id}">
        <div class="file-row">
          <span class="collection-nav-arrow">&#x203A;</span>
          <div class="file-name">
            <span class="name">${collection.title || collection.id}</span>
          </div>
          ${badgeText ? `<span class="file-count-badge">${badgeText}</span>` : '<span class="file-count-badge"></span>'}
          <div class="file-info">
            <span class="info-size"></span>
            <span class="info-date-start">${dateParts.start}</span>
            <span class="info-date-sep">${dateParts.sep}</span>
            <span class="info-date-end">${dateParts.end}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Add click and hover handlers
  container.querySelectorAll('.collection-item').forEach(el => {
    el.addEventListener('click', () => {
      loadCollection(el.dataset.collection);
    });
    el.addEventListener('mouseenter', () => highlightOverlay(el.dataset.collection, true));
    el.addEventListener('mouseleave', () => highlightOverlay(el.dataset.collection, false));
  });
}

// Load items for a collection
async function loadCollection(collectionId, pushHistory = true) {
  currentCollection = collectionId;
  currentExpandedItem = null; // Reset expanded item when changing collections
  currentOpenDay = null;
  if (pushHistory) {
    pushHistoryState(collectionId, null);
  }
  updateBreadcrumb();

  const container = document.getElementById('fileList');
  container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading items...</div>';

  const seq = ++loadSeq;
  const itemsPath = `${STAC_API}/collections/${collectionId}/items`;
  try {
    // A text match on a day lists its series: the matches are read across all levels first,
    // then the series level is kept to the series they belong to.
    let matchedSeries = null;
    const params = buildFilterParams();
    if (currentFilters.search) {
      const matches = await fetchAllPages(fetchJson, itemsPath, buildFilterParams(), () => seq === loadSeq);
      if (matches === null) return;
      matchedSeries = seriesKeys(matches);
      params.delete('q');
    }

    items = [];
    const listed = await fetchAllPages(fetchJson, itemsPath, seriesLevel(params), (features, page) => {
      if (seq !== loadSeq) return false;
      items.push(...(matchedSeries ? features.filter(f => matchedSeries.has(f.id)) : features));
      totalItemCount = matchedSeries ? items.length : (page.numberMatched ?? items.length);
      document.getElementById('fileCount').textContent = `(${totalItemCount} item${totalItemCount !== 1 ? 's' : ''})`;
      renderItems();
    });
    if (listed === null) return;

    // Refresh bbox overlays now that items are loaded
    updateBboxOverlays();
  } catch (err) {
    if (seq !== loadSeq) return;
    console.error('Failed to load items:', err);
    container.innerHTML = '<div class="error-msg">Unable to load items. Please try again later.</div>';
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}`);
  return response.json();
}

// Fetch item details with paginated assets
async function fetchItemAssets(collectionId, itemId, limit = 20, offset = 0) {
  const response = await fetch(`${STAC_API}/collections/${collectionId}/items/${itemId}?asset_limit=${limit}&asset_offset=${offset}`);
  if (!response.ok) throw new Error('Failed to load item details');
  return response.json();
}

// Render items list
function renderItems() {
  const container = document.getElementById('fileList');

  // Items are already filtered server-side (search, sensor, source, etc.)
  const filteredItems = items;

  if (filteredItems.length === 0) {
    container.innerHTML = '<div class="empty">No items match the current filters</div>';
    return;
  }

  container.innerHTML = filteredItems.map(item => {
    const props = item.properties || {};
    const format = props['blatten:format'] || '';

    // Get assets info
    const assets = item.assets || {};
    const assetCount = Object.keys(assets).length;
    const archiveAsset = assets.archive;
    const fileAssets = Object.entries(assets).filter(([key]) => key !== 'archive');
    const totalSize = props['blatten:total_size'] || fileAssets.reduce((sum, [, a]) => sum + (a['file:size'] || 0), 0);

    // Date range
    const startDate = props.start_datetime || props.datetime;
    const endDate = props.end_datetime;
    const dateParts = formatDateParts(startDate, endDate);

    // Metadata
    const source = props['blatten:source'] || '';
    const processingLevel = props['blatten:processing_level'];
    const frequency = props['blatten:frequency'] || '';
    const description = props.description || '';
    const additionalInfo = props['blatten:additional_info'] || '';
    const phase = props['blatten:phase'] || '';
    const fileCount = props['blatten:file_count'] || fileAssets.length;

    const metaId = 'meta-' + item.id.replace(/[^a-zA-Z0-9]/g, '-');

    // Archive download link
    const archiveHref = archiveAsset?.href || '#';

    // A series lists its days beside its own files
    const days = daysLink(item);

    return `
      <div class="file-item file" data-meta-target="${metaId}" data-item-id="${item.id}">
        <div class="file-row">
          <span class="file-meta-toggle" data-target="${metaId}">
            <span class="arrow">&#9654;</span>
          </span>
          <div class="file-name">
            <span class="name">${props.title || item.id}</span>
          </div>
          <span class="file-count-badge">${fileCount} files</span>
          <div class="file-info">
            <span class="info-size">${formatSize(totalSize)}</span>
            <span class="info-date-start">${dateParts.start}</span>
            <span class="info-date-sep">${dateParts.sep}</span>
            <span class="info-date-end">${dateParts.end}</span>
          </div>
        </div>
        <div class="file-meta" id="${metaId}">
          <div class="meta-content-wrapper">
            <div class="meta-grid">
              ${description ? `<div class="meta-row"><span class="meta-label">Description</span><span class="meta-value">${description}</span></div>` : ''}
              ${source ? `<div class="meta-row"><span class="meta-label">Source</span><span class="meta-value">${source}</span></div>` : ''}
              ${processingLevel ? `<div class="meta-row"><span class="meta-label">Processing Level</span><span class="meta-value">${processingLevel}</span></div>` : ''}
              ${phase ? `<div class="meta-row"><span class="meta-label">Phase</span><span class="meta-value">${phase}</span></div>` : ''}
              ${frequency ? `<div class="meta-row"><span class="meta-label">Frequency</span><span class="meta-value">${frequency}</span></div>` : ''}
              ${additionalInfo ? `<div class="meta-row"><span class="meta-label">Additional Info</span><span class="meta-value">${additionalInfo}</span></div>` : ''}
              ${format ? `<div class="meta-row"><span class="meta-label">Format</span><span class="meta-value">${format}</span></div>` : ''}
              ${item.bbox ? `<div class="meta-row"><span class="meta-label">BBox</span><span class="meta-value bbox">${
                item.bbox.length === 6
                  ? `[${item.bbox[0]?.toFixed(4)}, ${item.bbox[1]?.toFixed(4)}, ${item.bbox[3]?.toFixed(4)}, ${item.bbox[4]?.toFixed(4)}]`
                  : `[${item.bbox[0]?.toFixed(4)}, ${item.bbox[1]?.toFixed(4)}, ${item.bbox[2]?.toFixed(4)}, ${item.bbox[3]?.toFixed(4)}]`
              }</span></div>` : ''}
              ${item.bbox?.length === 6 ? `<div class="meta-row"><span class="meta-label">Elevation</span><span class="meta-value elevation">${
                item.bbox[2] === item.bbox[5]
                  ? `${Math.round(item.bbox[2])} m`
                  : `${Math.round(item.bbox[2])}\u2013${Math.round(item.bbox[5])} m`
              }</span></div>` : ''}
            </div>
            ${item.bbox ? `
            <div class="meta-map-section">
              <div class="meta-mini-map" id="minimap-${metaId}" data-bbox="${item.bbox.join(',')}" data-geometry='${JSON.stringify(item.geometry)}' data-item-id="${item.id}" data-collection-id="${currentCollection}"></div>
            </div>
            ` : ''}
          </div>
          <div class="meta-assets">
            <div class="meta-assets-content" data-file-count="${props['blatten:file_count'] || ''}" data-archive-href="${archiveAsset ? archiveHref : ''}" data-archive-size="${archiveAsset ? formatSize(archiveAsset['file:size']) : ''}" data-archive-zip64="${archiveAsset?.['blatten:zip64'] ? '1' : ''}">
              <div class="assets-placeholder">Loading files...</div>
            </div>
            ${days ? `
            <div class="meta-days">
              <div class="meta-days-title">Days</div>
              <div class="meta-days-content" data-days-href="${escapeAttr(days.href)}">
                <div class="assets-placeholder">Loading days...</div>
              </div>
            </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Header row click to expand/collapse (only the top bar, not the expanded content)
  container.querySelectorAll('.file-item.file .file-row').forEach(rowHeader => {
    rowHeader.addEventListener('click', async (e) => {
      // Don't toggle if clicking download button
      if (e.target.closest('.download-btn') || e.target.closest('.meta-download-btn')) {
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
          currentOpenDay = null;
          pushHistoryState(currentCollection, itemId);
        } else {
          currentExpandedItem = null;
          currentOpenDay = null;
          pushHistoryState(currentCollection, null);
        }

        // When expanding, load full item data and initialize map
        if (isExpanding) {
          await loadExpandedItemContent(metaEl, itemId);
          row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
    });
  });

  // Add hover cross-highlighting for item rows ↔ map overlays
  container.querySelectorAll('.file-item.file').forEach(el => {
    const itemId = el.dataset.itemId;
    if (itemId) {
      el.addEventListener('mouseenter', () => highlightOverlay(itemId, true));
      el.addEventListener('mouseleave', () => highlightOverlay(itemId, false));
    }
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

  // Parse raw bbox and normalize to 4-element [w,s,e,n] for map operations
  const bboxRaw = bboxStr.split(',').map(Number);
  const bbox = normalizeBbox(bboxRaw) || bboxRaw;
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

  // Draw the geometry: a dark magenta line over a white halo stays visible on the coloured
  // basemap for every kind of colour vision, which red on green and brown does not.
  const GEOMETRY_COLOR = '#b0006a';
  const HALO = { color: '#ffffff', weight: 5, fill: false, interactive: false };
  let fitBounds;
  if (geometry && geometry.type === 'Polygon') {
    const coords = geometry.coordinates[0].map(c => [c[1], c[0]]);
    L.polygon(coords, HALO).addTo(miniMap);
    const polygon = L.polygon(coords, {
      color: GEOMETRY_COLOR,
      weight: 2,
      fillOpacity: 0.3
    }).addTo(miniMap);
    fitBounds = polygon.getBounds();
    miniMap.fitBounds(fitBounds, { padding: [10, 10] });
  } else if (geometry && geometry.type === 'Point') {
    const [lon, lat] = geometry.coordinates;
    L.circleMarker([lat, lon], {
      radius: 6,
      color: '#ffffff',
      weight: 2,
      fillColor: GEOMETRY_COLOR,
      fillOpacity: 0.9
    }).addTo(miniMap);
    miniMap.setView([lat, lon], 14);
  } else {
    // Just use bbox
    fitBounds = [[bbox[1], bbox[0]], [bbox[3], bbox[2]]];
    L.rectangle(fitBounds, HALO).addTo(miniMap);
    L.rectangle(fitBounds, {
      color: GEOMETRY_COLOR,
      weight: 2,
      fillOpacity: 0.2
    }).addTo(miniMap);
    miniMap.fitBounds(fitBounds, { padding: [10, 10] });
  }

  // Build SwissTopo map.geo.admin.ch URL with KML layer from our API
  // Calculate appropriate zoom based on extent
  const extentSize = Math.max(bboxWidth, bboxHeight);
  let zoom = 8;
  if (extentSize > 0.1) zoom = 6;
  else if (extentSize > 0.05) zoom = 7;
  else if (extentSize > 0.01) zoom = 9;
  else if (extentSize > 0.005) zoom = 10;
  else zoom = 11;

  // Convert center to LV95 coordinates (required by new map.geo.admin.ch URL format)
  const lv95 = wgs84ToLv95(centerLng, centerLat);

  // Get item and collection IDs for KML endpoint
  const itemId = el.dataset.itemId;
  const collectionId = el.dataset.collectionId;

  // Build KML URL using path-based route (no query params — avoids URL encoding
  // issues in SwissTopo's hash fragment where &item_id gets split off as a hash param)
  const kmlUrl = `${window.location.origin}${STAC_API}/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemId)}/kml`;

  // Build SwissTopo URL with new 2024 format:
  // - Hash-based URL: #/map?...
  // - center=E,N in LV95 coordinates
  // - z= instead of zoom=
  // - layers=KML%7C<url> where %7C is URL-encoded pipe
  const swisstopoUrl = `https://map.geo.admin.ch/#/map?lang=en&bgLayer=ch.swisstopo.pixelkarte-farbe&z=${zoom}&center=${lv95.E},${lv95.N}&layers=KML%7C${encodeURIComponent(kmlUrl)}`;

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

  const seq = ++loadSeq;
  try {
    const collectionsRes = await fetch(`${STAC_API}/collections`);
    if (!collectionsRes.ok) throw new Error('Failed to load STAC collections');

    const collectionsData = await collectionsRes.json();
    if (seq !== loadSeq) return;
    collections = collectionsData.collections || [];

    // Compute overall date range and spatial extent from collection extents
    if (!dataDateMin || !dataDateMax) {
      let minDate = null, maxDate = null;
      let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
      collections.forEach(c => {
        const interval = c.extent?.temporal?.interval?.[0];
        if (interval) {
          const start = interval[0] ? new Date(interval[0]) : null;
          const end = interval[1] ? new Date(interval[1]) : null;
          if (start && (!minDate || start < minDate)) minDate = start;
          if (end && (!maxDate || end > maxDate)) maxDate = end;
        }
        const spatial = c.extent?.spatial?.bbox?.[0];
        if (spatial && spatial.length >= 4) {
          if (spatial[0] < west) west = spatial[0];
          if (spatial[1] < south) south = spatial[1];
          if (spatial[2] > east) east = spatial[2];
          if (spatial[3] > north) north = spatial[3];
        }
      });
      dataDateMin = minDate;
      dataDateMax = maxDate;
      if (west !== Infinity) {
        dataBboxExtent = [west, south, east, north];
      }
    }

    // Filter options and each collection's sensors, sources and levels, from the summaries
    const options = filterOptionsFromSummaries(collections);
    allSensors = options.sensors;
    allSources = options.sources;
    allProcessingLevels = options.processingLevels;
    sensorsByCollection = options.sensorsByCollection;
    sourcesByCollection = options.sourcesByCollection;
    processingLevelsByCollection = options.processingLevelsByCollection;

    // Series-level items per collection under the current filters
    const params = seriesLevel(buildFilterParams());
    params.set('fields', 'collection,-geometry,-links,-bbox');
    const listed = await fetchAllPages(fetchJson, `${STAC_API}/search`, params, () => seq === loadSeq);
    if (listed === null) return;
    const itemCountByCollection = {};
    listed.forEach(item => {
      if (item.collection) itemCountByCollection[item.collection] = (itemCountByCollection[item.collection] || 0) + 1;
    });
    collections.forEach(c => {
      c._itemCount = itemCountByCollection[c.id] || 0;
    });

    // Cross-collection item search across all levels: a match on a day counts for its series,
    // and a series counts once however many of its days match
    collections.forEach(c => { c._searchMatchCount = 0; });
    if (currentFilters.search) {
      try {
        const searchParams = new URLSearchParams();
        searchParams.set('q', currentFilters.search);
        searchParams.set('exclude_assets', 'true');
        searchParams.set('fields', 'collection,properties.blatten:series,-geometry,-links,-bbox');
        const matches = await fetchAllPages(fetchJson, `${STAC_API}/search`, searchParams, () => seq === loadSeq);
        if (matches === null) return;
        const matchCounts = countSeriesMatches(matches);
        collections.forEach(c => {
          c._searchMatchCount = matchCounts[c.id] || 0;
        });
      } catch (_) { /* ignore search errors */ }
    }
    if (seq !== loadSeq) return;

    // Sort collections by title
    collections.sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id));

    renderCollections();
  } catch (err) {
    console.error('Failed to load collections:', err);
    document.getElementById('error').textContent = 'Unable to connect to the data server. Please try again later.';
    document.getElementById('error').style.display = 'block';
    container.innerHTML = '<div class="empty">Failed to load collections</div>';
  }
}

// Initial load
initializeApp();
