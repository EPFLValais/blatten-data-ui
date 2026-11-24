// The collection rows, item rows and filter options of the file browser. Every value read from
// the catalog is escaped and every catalog link passes safeHref. Loaded after listing.js, which
// supplies escapeHtml and safeHref, and days.js, which supplies daysLink, and before app.js,
// which supplies formatSize and formatDateParts.

// <option> elements for `values`, the one equal to `selected` marked; label(value) is the text.
function filterOptionsHtml(values, selected, label = (value) => value) {
  return values.map((value) =>
    `<option value="${escapeHtml(value)}"${selected === value ? ' selected' : ''}>${escapeHtml(label(value))}</option>`
  ).join('');
}

function collectionRowHtml(collection) {
  const itemCount = collection._itemCount || 0;
  const searchMatchCount = collection._searchMatchCount || 0;
  const temporal = collection.extent?.temporal?.interval?.[0];
  const dateParts = temporal ? formatDateParts(temporal[0], temporal[1]) : { start: '-', sep: '', end: '' };
  const badgeText = searchMatchCount > 0
    ? `${searchMatchCount} match${searchMatchCount !== 1 ? 'es' : ''}`
    : (itemCount > 0 ? `${itemCount} item${itemCount !== 1 ? 's' : ''}` : '');

  return `
      <div class="file-item folder collection-item" data-collection="${escapeHtml(collection.id)}">
        <div class="file-row">
          <span class="collection-nav-arrow">&#x203A;</span>
          <div class="file-name">
            <span class="name">${escapeHtml(collection.title || collection.id)}</span>
          </div>
          <span class="file-count-badge">${badgeText}</span>
          <div class="file-info">
            <span class="info-size"></span>
            <span class="info-date-start">${escapeHtml(dateParts.start)}</span>
            <span class="info-date-sep">${escapeHtml(dateParts.sep)}</span>
            <span class="info-date-end">${escapeHtml(dateParts.end)}</span>
          </div>
        </div>
      </div>
    `;
}

// A metadata row, or nothing when the value is empty.
function metaRowHtml(label, value) {
  return value ? `<div class="meta-row"><span class="meta-label">${label}</span><span class="meta-value">${escapeHtml(value)}</span></div>` : '';
}

// An item's row in the open collection `collectionId`, with its metadata, mini map, file list
// placeholder and, for a series, its days.
function itemRowHtml(item, collectionId) {
  const props = item.properties || {};
  const assets = item.assets || {};
  const archiveAsset = assets.archive;
  const fileAssets = Object.entries(assets).filter(([key]) => key !== 'archive');
  const totalSize = props['blatten:total_size'] || fileAssets.reduce((sum, [, a]) => sum + (a['file:size'] || 0), 0);
  const dateParts = formatDateParts(props.start_datetime || props.datetime, props.end_datetime);
  const fileCount = props['blatten:file_count'] || fileAssets.length;
  const metaId = 'meta-' + String(item.id).replace(/[^a-zA-Z0-9]/g, '-');
  const days = daysLink(item);
  const bbox = item.bbox;

  const bboxText = !bbox ? '' : bbox.length === 6
    ? `[${bbox[0]?.toFixed(4)}, ${bbox[1]?.toFixed(4)}, ${bbox[3]?.toFixed(4)}, ${bbox[4]?.toFixed(4)}]`
    : `[${bbox[0]?.toFixed(4)}, ${bbox[1]?.toFixed(4)}, ${bbox[2]?.toFixed(4)}, ${bbox[3]?.toFixed(4)}]`;
  const elevationText = bbox?.length !== 6 ? '' : bbox[2] === bbox[5]
    ? `${Math.round(bbox[2])} m`
    : `${Math.round(bbox[2])}–${Math.round(bbox[5])} m`;

  return `
      <div class="file-item file" data-meta-target="${metaId}" data-item-id="${escapeHtml(item.id)}">
        <div class="file-row">
          <span class="file-meta-toggle" data-target="${metaId}">
            <span class="arrow">&#9654;</span>
          </span>
          <div class="file-name">
            <span class="name">${escapeHtml(props.title || item.id)}</span>
          </div>
          <span class="file-count-badge">${escapeHtml(fileCount)} files</span>
          <div class="file-info">
            <span class="info-size">${escapeHtml(formatSize(totalSize))}</span>
            <span class="info-date-start">${escapeHtml(dateParts.start)}</span>
            <span class="info-date-sep">${escapeHtml(dateParts.sep)}</span>
            <span class="info-date-end">${escapeHtml(dateParts.end)}</span>
          </div>
        </div>
        <div class="file-meta" id="${metaId}">
          <div class="meta-content-wrapper">
            <div class="meta-grid">
              ${metaRowHtml('Description', props.description)}
              ${metaRowHtml('Source', props['blatten:source'])}
              ${metaRowHtml('Processing Level', props['blatten:processing_level'])}
              ${metaRowHtml('Phase', props['blatten:phase'])}
              ${metaRowHtml('Frequency', props['blatten:frequency'])}
              ${metaRowHtml('Additional Info', props['blatten:additional_info'])}
              ${metaRowHtml('Format', props['blatten:format'])}
              ${bbox ? `<div class="meta-row"><span class="meta-label">BBox</span><span class="meta-value bbox">${escapeHtml(bboxText)}</span></div>` : ''}
              ${elevationText ? `<div class="meta-row"><span class="meta-label">Elevation</span><span class="meta-value elevation">${escapeHtml(elevationText)}</span></div>` : ''}
            </div>
            ${bbox ? `
            <div class="meta-map-section">
              <div class="meta-mini-map" id="minimap-${metaId}" data-bbox="${escapeHtml(bbox.join(','))}" data-geometry="${escapeHtml(JSON.stringify(item.geometry ?? null))}" data-item-id="${escapeHtml(item.id)}" data-collection-id="${escapeHtml(collectionId)}"></div>
            </div>
            ` : ''}
          </div>
          <div class="meta-assets">
            <div class="meta-assets-content" data-file-count="${escapeHtml(props['blatten:file_count'] || '')}" data-archive-href="${archiveAsset ? escapeHtml(safeHref(archiveAsset.href)) : ''}" data-archive-size="${archiveAsset ? escapeHtml(formatSize(archiveAsset['file:size'])) : ''}" data-archive-zip64="${archiveAsset?.['blatten:zip64'] ? '1' : ''}">
              <div class="assets-placeholder">Loading files...</div>
            </div>
            ${days ? `
            <div class="meta-days">
              <div class="meta-days-title">Days</div>
              <div class="meta-days-content" data-days-href="${escapeHtml(days.href)}">
                <div class="assets-placeholder">Loading days...</div>
              </div>
            </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;
}
