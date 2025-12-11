// STAC API-based file browser
const STAC_API = '/stac';
const INITIAL_ITEMS_LIMIT = 10;
let collections = [];
let currentCollection = null;
let items = [];
let totalItemCount = 0;
let allSensors = [];
let sensorsByCollection = {}; // Maps collection ID to list of sensors in that collection
let currentFilters = { search: '', sensor: '' };
let filterDebounceTimer = null;

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

// Get collection icon
function getCollectionIcon(collectionId) {
  const icons = {
    'webcam-image': '📷',
    'deformation-analysis': '📈',
    'orthophoto': '🗺️',
    'radar-velocity': '📡',
    'dsm': '⛰️',
    'point-cloud': '☁️',
    '3d-model': '🎨',
    'gnss-data': '📍',
    'thermal-image': '🌡️',
    'hydrology': '💧',
  };
  return icons[collectionId] || '📁';
}

// Update breadcrumb and filters
function updateBreadcrumb() {
  const breadcrumb = document.getElementById('fileBreadcrumb');
  breadcrumb.style.display = 'flex';

  // Build sensor options
  const sensorOptions = allSensors.map(s =>
    `<option value="${s}" ${currentFilters.sensor === s ? 'selected' : ''}>${s}</option>`
  ).join('');

  if (!currentCollection) {
    // Show just filters on collections view
    breadcrumb.innerHTML = `
      <span>All Collections</span>
      <div class="file-filters">
        <input type="text" id="searchFilter" placeholder="Search..." value="${currentFilters.search}">
        <select id="sensorFilter">
          <option value="">All Sensors</option>
          ${sensorOptions}
        </select>
      </div>
    `;
  } else {
    const collection = collections.find(c => c.id === currentCollection);
    const title = collection?.title || currentCollection;

    breadcrumb.innerHTML = `
      <a href="#" id="backToCollections">&larr; All Collections</a>
      <span>/</span>
      <span>${title}</span>
      <div class="file-filters">
        <input type="text" id="searchFilter" placeholder="Search..." value="${currentFilters.search}">
        <select id="sensorFilter">
          <option value="">All Sensors</option>
          ${sensorOptions}
        </select>
      </div>
    `;

    document.getElementById('backToCollections').addEventListener('click', (e) => {
      e.preventDefault();
      currentCollection = null;
      currentFilters = { search: '', sensor: '' };
      renderCollections();
    });
  }

  // Attach filter event listeners
  document.getElementById('searchFilter').addEventListener('input', (e) => {
    currentFilters.search = e.target.value;
    applyFilters(); // Debounced
  });

  document.getElementById('sensorFilter').addEventListener('change', (e) => {
    currentFilters.sensor = e.target.value;
    applyFilters(true); // Immediate for dropdown
  });
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

// Render collections list
function renderCollections() {
  currentCollection = null;
  updateBreadcrumb();

  const container = document.getElementById('fileList');

  // Filter collections based on sensor filter
  let filteredCollections = collections;
  if (currentFilters.sensor) {
    filteredCollections = collections.filter(c => {
      const collectionSensors = sensorsByCollection[c.id] || [];
      return collectionSensors.includes(currentFilters.sensor);
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
    const icon = getCollectionIcon(collection.id);
    const itemCount = collection._itemCount || '';
    const temporal = collection.extent?.temporal?.interval?.[0];
    const dateRange = temporal ? formatDateRange(temporal[0], temporal[1]) : '';

    return `
      <div class="file-item folder collection-item" data-collection="${collection.id}">
        <div class="file-row">
          <span style="width:0.8rem"></span>
          <div class="file-name">
            <span class="icon">${icon}</span>
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
async function loadCollection(collectionId, loadAll = false) {
  currentCollection = collectionId;
  updateBreadcrumb();

  const container = document.getElementById('fileList');
  container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading items...</div>';

  try {
    const limit = loadAll ? 10000 : INITIAL_ITEMS_LIMIT;
    // Use exclude_assets=true for lightweight listing (keeps only archive asset)
    const response = await fetch(`${STAC_API}/collections/${collectionId}/items?limit=${limit}&exclude_assets=true`);
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

// Render assets list for an item
function renderAssetsList(assets) {
  // Separate archive from other assets
  const archive = assets.archive;
  const fileAssets = Object.entries(assets).filter(([key]) => key !== 'archive');

  // Group by extension
  const byExtension = {};
  fileAssets.forEach(([key, asset]) => {
    const ext = getExtension(asset.href, asset.title) || 'OTHER';
    if (!byExtension[ext]) byExtension[ext] = [];
    byExtension[ext].push({ key, ...asset });
  });

  // Sort extensions by count
  const sortedExtensions = Object.entries(byExtension)
    .sort((a, b) => b[1].length - a[1].length);

  let html = '';

  // Show file count summary
  const totalFiles = fileAssets.length;
  const totalSize = fileAssets.reduce((sum, [, a]) => sum + (a['file:size'] || 0), 0);
  html += `<div class="assets-summary">${totalFiles} files (${formatSize(totalSize)} total)</div>`;

  // Show each extension group
  sortedExtensions.forEach(([ext, files]) => {
    html += `<div class="assets-group">`;
    html += `<div class="assets-group-header">${getIcon(ext)} ${ext} (${files.length} files)</div>`;
    html += `<div class="assets-list">`;

    // Show all files in the group (pagination happens at asset-fetch level now)
    files.forEach(asset => {
      const fileName = asset.title || asset.key;
      html += `
        <div class="asset-item">
          <a href="${asset.href}" class="asset-link" target="_blank" rel="noopener">${fileName}</a>
          <span class="asset-size">${formatSize(asset['file:size'])}</span>
        </div>
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

    // Search filter - check title, description, sensor
    if (searchLower) {
      const title = (props.title || item.id || '').toLowerCase();
      const description = (props.description || '').toLowerCase();
      const sensor = (props['blatten:sensor'] || '').toLowerCase();
      if (!title.includes(searchLower) && !description.includes(searchLower) && !sensor.includes(searchLower)) {
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
              ${item.bbox ? `<div class="meta-row"><span class="meta-label">Bounding Box</span><span class="meta-value bbox">[${item.bbox.map(n => n?.toFixed(4)).join(', ')}]</span></div>` : '<div class="meta-row"><span class="meta-label">Geometry</span><span class="meta-value meta-warning">⚠️ Coordinates not yet available</span></div>'}
            </div>
            ${item.bbox ? `<div class="meta-mini-map" id="minimap-${metaId}" data-bbox="${item.bbox.join(',')}" data-geometry='${JSON.stringify(item.geometry)}'></div>` : ''}
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
        const offset = items.length;
        const response = await fetch(`${STAC_API}/collections/${currentCollection}/items?limit=10000&offset=${offset}&exclude_assets=true`);
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

  // Row click to expand/collapse (but not on download button, map, or assets)
  container.querySelectorAll('.file-item.file').forEach(row => {
    row.addEventListener('click', async (e) => {
      // Don't toggle if clicking interactive elements
      if (e.target.closest('.download-btn') ||
          e.target.closest('.meta-download-btn') ||
          e.target.closest('.meta-mini-map') ||
          e.target.closest('.meta-assets') ||
          e.target.closest('.asset-link')) {
        return;
      }
      const targetId = row.dataset.metaTarget;
      const itemId = row.dataset.itemId;
      const toggle = row.querySelector('.file-meta-toggle');
      const metaEl = document.getElementById(targetId);
      if (metaEl && toggle) {
        const isExpanding = !metaEl.classList.contains('expanded');
        toggle.classList.toggle('expanded');
        metaEl.classList.toggle('expanded');

        // When expanding, load full item data and initialize map
        if (isExpanding) {
          // Initialize mini map
          const miniMapEl = metaEl.querySelector('.meta-mini-map');
          if (miniMapEl && !miniMapEl._mapInitialized) {
            initMiniMap(miniMapEl);
          }

          // Lazy load assets if not already loaded
          const assetsContainer = metaEl.querySelector('.meta-assets-content');
          if (assetsContainer && !assetsContainer._assetsLoaded) {
            assetsContainer.innerHTML = '<div class="loading-assets"><div class="spinner"></div>Loading files...</div>';
            try {
              const ASSET_PAGE_SIZE = 20;
              const itemData = await fetchItemAssets(currentCollection, itemId, ASSET_PAGE_SIZE, 0);
              const assetsMeta = itemData._assetsMeta || { total: 0, offset: 0, returned: 0 };

              assetsContainer.innerHTML = renderAssetsList(itemData.assets || {});
              assetsContainer._assetsLoaded = true;
              assetsContainer._loadedCount = assetsMeta.returned;
              assetsContainer._totalCount = assetsMeta.total;

              // Add "Show more" link if there are more assets
              if (assetsMeta.total > assetsMeta.returned) {
                const remaining = assetsMeta.total - assetsMeta.returned;
                const loadMoreLink = document.createElement('div');
                loadMoreLink.className = 'assets-more';
                loadMoreLink.textContent = `Show ${remaining} more file${remaining !== 1 ? 's' : ''}...`;
                assetsContainer.appendChild(loadMoreLink);

                loadMoreLink.addEventListener('click', async (e) => {
                  e.stopPropagation();
                  loadMoreLink.textContent = 'Loading...';
                  loadMoreLink.style.pointerEvents = 'none';

                  try {
                    // Fetch ALL assets (no limit)
                    const response = await fetch(`${STAC_API}/collections/${currentCollection}/items/${itemId}`);
                    if (!response.ok) throw new Error('Failed to load files');
                    const fullItem = await response.json();

                    loadMoreLink.remove();
                    assetsContainer.innerHTML = renderAssetsList(fullItem.assets || {});
                  } catch (err) {
                    loadMoreLink.textContent = `Error: ${err.message}`;
                  }
                });
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

  // Add tile layer
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19
  }).addTo(miniMap);

  // Draw the geometry
  let fitBounds;
  if (geometry && geometry.type === 'Polygon') {
    const coords = geometry.coordinates[0].map(c => [c[1], c[0]]);
    const polygon = L.polygon(coords, {
      color: '#0066cc',
      weight: 2,
      fillOpacity: 0.3
    }).addTo(miniMap);
    fitBounds = polygon.getBounds();
    miniMap.fitBounds(fitBounds, { padding: [10, 10] });
  } else if (geometry && geometry.type === 'Point') {
    const [lon, lat] = geometry.coordinates;
    L.circleMarker([lat, lon], {
      radius: 6,
      color: '#0066cc',
      fillColor: '#0066cc',
      fillOpacity: 0.5
    }).addTo(miniMap);
    miniMap.setView([lat, lon], 14);
  } else {
    // Just use bbox
    fitBounds = [[bbox[1], bbox[0]], [bbox[3], bbox[2]]];
    L.rectangle(fitBounds, {
      color: '#0066cc',
      weight: 2,
      fillOpacity: 0.2
    }).addTo(miniMap);
    miniMap.fitBounds(fitBounds, { padding: [10, 10] });
  }

  // Add "Open in OSM" button
  const openOsmBtn = document.createElement('a');
  openOsmBtn.className = 'mini-map-osm-btn';
  openOsmBtn.href = `https://www.openstreetmap.org/?mlat=${centerLat}&mlon=${centerLng}#map=15/${centerLat}/${centerLng}`;
  openOsmBtn.target = '_blank';
  openOsmBtn.rel = 'noopener';
  openOsmBtn.title = 'Open in OpenStreetMap';
  openOsmBtn.innerHTML = '↗';
  el.appendChild(openOsmBtn);

  el._mapInitialized = true;
}

// Load all collections and sensors
async function loadCollections() {
  const container = document.getElementById('fileList');
  container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading collections...</div>';
  document.getElementById('error').style.display = 'none';

  try {
    // Fetch collections and all items (for sensor list) in parallel
    const [collectionsRes, itemsRes] = await Promise.all([
      fetch(`${STAC_API}/collections`),
      fetch(`${STAC_API}/search?limit=1000&exclude_assets=true`)
    ]);

    if (!collectionsRes.ok) throw new Error('Failed to load STAC collections');

    const collectionsData = await collectionsRes.json();
    collections = collectionsData.collections || [];

    // Extract unique sensors from all items and map to collections
    if (itemsRes.ok) {
      const itemsData = await itemsRes.json();
      const sensors = new Set();
      sensorsByCollection = {}; // Reset mapping

      (itemsData.features || []).forEach(item => {
        const sensor = item.properties?.['blatten:sensor'];
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
      });
      allSensors = [...sensors].sort();
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
loadCollections();
