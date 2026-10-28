// An item's files, fetched a page at a time and rendered as file groups by extension.
// Loaded before app.js, which supplies formatSize and formatDate.

const ASSET_PAGE_SIZE = 500;

// Pages through an item's assets with fetchPage(limit, offset), which resolves to the
// item JSON for that page. The API returns assets in a stable order, so the next
// offset is the number of assets received so far. `total` is the item's file count
// when known before the first page; the API's _assetsMeta.total replaces it.
function createAssetPager(fetchPage, { pageSize = ASSET_PAGE_SIZE, total = null } = {}) {
  let received = 0;
  let pending = null;
  const pager = { assets: {}, archive: null, total, done: false };

  async function fetchNext() {
    const page = await fetchPage(pageSize, received);
    const assets = page?.assets || {};
    if (assets.archive && !pager.archive) pager.archive = assets.archive;
    const files = Object.entries(assets).filter(([key]) => key !== 'archive');
    for (const [key, asset] of files) pager.assets[key] = asset;
    received += files.length;
    const metaTotal = page?._assetsMeta?.total;
    if (Number.isFinite(metaTotal)) pager.total = metaTotal;
    // A short page ends the paging even when it disagrees with the total, so a
    // shrunken item cannot leave Show more asking forever.
    pager.done = files.length < pageSize || (pager.total != null && received >= pager.total);
    if (pager.done) pager.total = Object.keys(pager.assets).length;
  }

  // Concurrent calls share the request in flight.
  pager.next = () => {
    if (pager.done) return Promise.resolve(pager);
    if (!pending) {
      pending = fetchNext().then(() => pager).finally(() => { pending = null; });
    }
    return pending;
  };

  return pager;
}

// Get file extension from href or title
function getExtension(href, title) {
  const str = href || title || '';
  const match = str.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  return match ? match[1].toUpperCase() : '';
}

function renderAssetRow(asset) {
  const title = asset.title || asset.key;
  const size = asset['file:size'];
  const href = asset.href || '#';
  // proj:bbox marks per-asset LV95 geometry
  const hasGeo = asset['proj:bbox'] != null;
  const dateStr = asset.datetime ? formatDate(asset.datetime) : '';
  return `
        <a class="file-item asset-row" href="${href}" target="_blank" rel="noopener">
          <span class="file-name">${title}</span>
          <span class="asset-meta">
            ${hasGeo ? '<span class="asset-geo" title="Has LV95 coordinates">LV95</span>' : ''}
            ${size ? `<span class="asset-size">${formatSize(size)}</span>` : ''}
            ${dateStr ? `<span class="asset-date">${dateStr}</span>` : ''}
          </span>
        </a>
      `;
}

// Render a pager's loaded assets as collapsible file groups. While the item is not
// complete, counts read as loaded of total and a Show more button follows the groups.
// `info` carries the archive link ({ href, size, zip64 }) and a prefix for group ids.
function renderItemAssets(pager, info = {}) {
  const { archive = null, idPrefix = 'file-group' } = info;
  const fileAssets = Object.entries(pager.assets).map(([key, asset]) => ({ key, ...asset }));

  if (fileAssets.length === 0) {
    return '<div class="empty">No individual files found</div>';
  }

  const loaded = fileAssets.length;
  const total = pager.done ? loaded : Math.max(pager.total ?? loaded, loaded);
  const complete = pager.done || loaded >= total;

  const byExtension = {};
  fileAssets.forEach(asset => {
    const ext = getExtension(asset.href, asset.title) || 'OTHER';
    if (!byExtension[ext]) byExtension[ext] = [];
    byExtension[ext].push(asset);
  });

  // Groups by count (largest first); files by name with numbers compared as numbers,
  // the order the API pages in, so a new page appends rather than reshuffles.
  const sortedGroups = Object.entries(byExtension)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([ext, assets]) => [ext, assets.sort((a, b) =>
      (a.title || a.key).localeCompare(b.title || b.key, undefined, { numeric: true }))]);

  const totalSize = fileAssets.reduce((sum, asset) => sum + (asset['file:size'] || 0), 0);
  const withGeo = fileAssets.filter(asset => asset['proj:bbox'] != null).length;

  let html = `
    <div class="files-header">
      <span class="files-count">${complete ? `${loaded} files` : `${loaded} of ${total} files`}</span>
      ${totalSize > 0 ? `<span class="files-size">${formatSize(totalSize)}${complete ? '' : ' loaded'}</span>` : ''}
      ${withGeo > 0 ? `<span class="files-geo" title="${withGeo} files with LV95 coordinates">${withGeo} with coordinates</span>` : ''}
      ${archive ? `<a href="${archive.href}" class="meta-download-btn" target="_blank" rel="noopener">Download Archive (${archive.size})</a>${archive.zip64 ? '<span class="archive-note" title="This archive uses ZIP64 extensions. The built-in Archive Utility on macOS may not extract it correctly — use The Unarchiver, 7-Zip, or the command-line unzip tool instead.">ZIP64</span>' : ''}` : ''}
    </div>
  `;

  sortedGroups.forEach(([ext, assets]) => {
    const groupSize = assets.reduce((sum, asset) => sum + (asset['file:size'] || 0), 0);
    const groupId = `${idPrefix}-${ext.replace(/[^a-zA-Z0-9]/g, '-')}`;
    // Per-extension totals are not known until every page is in: a lone group's
    // total is the item's, and any other group is marked as possibly growing.
    let badge = `${assets.length}`;
    if (!complete) badge = sortedGroups.length === 1 ? `${assets.length} of ${total} loaded` : `${assets.length}+`;

    html += `
      <div class="file-group">
        <div class="file-group-header" data-target="${groupId}" data-ext="${ext}">
          <span class="file-group-toggle">▶</span>
          <span class="file-group-ext">${ext}</span>
          <span class="file-group-badge"${complete ? '' : ' title="More files may load"'}>${badge}</span>
          <span class="file-group-size">${formatSize(groupSize)}</span>
        </div>
        <div class="file-group-content" id="${groupId}">
    `;
    assets.forEach(asset => { html += renderAssetRow(asset); });
    html += `</div></div>`;
  });

  if (!complete) {
    html += `<div class="show-more-assets"><button class="show-more-btn">Show more files (${loaded} of ${total} loaded)</button></div>`;
  }

  return html;
}
