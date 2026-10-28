// The days of a series, listed a page at a time from the series' `rel: "items"` link.
// A series keeps its archive, manifest and undated files; each day of its dated files is
// a day item naming the series in blatten:series. Loaded after listing.js, which supplies
// nextPageUrl, and before app.js, which supplies formatSize.

const DAY_PAGE_SIZE = 100;

// The link from a series to its days, or null when the item is not a series.
function daysLink(item) {
  return (item?.links || []).find((link) => link.rel === 'items' && link.href) || null;
}

// The first page of a series' days at `path`: the link's query, the date filter of
// `filterParams`, and no assets, since a row needs only the day's properties. The link may
// carry another origin, so only its query is used.
function daysUrl(link, path, filterParams) {
  const params = new URL(link.href, 'http://localhost').searchParams;
  const datetime = filterParams.get('datetime');
  if (datetime) params.set('datetime', datetime);
  params.set('exclude_assets', 'true');
  params.set('limit', String(DAY_PAGE_SIZE));
  params.delete('offset');
  return `${path}?${params}`;
}

// Pages through a series' days from `url` through fetchJson(url), following each page's
// next link on `path`. Concurrent calls share the request in flight.
function createDayPager(fetchJson, url, path) {
  let nextUrl = url;
  let pending = null;
  const pager = { days: [], total: null, done: false };

  async function fetchNext() {
    const page = await fetchJson(nextUrl);
    const features = page.features || [];
    pager.days.push(...features);
    if (Number.isFinite(page.numberMatched)) pager.total = page.numberMatched;
    nextUrl = features.length ? nextPageUrl(page, path) : null;
    pager.done = !nextUrl;
    if (pager.done) pager.total = pager.days.length;
  }

  pager.next = () => {
    if (pager.done) return Promise.resolve(pager);
    if (!pending) {
      pending = fetchNext().then(() => pager).finally(() => { pending = null; });
    }
    return pending;
  };

  return pager;
}

// A day's row label: its date, and the part number when a day is cut into parts.
function dayLabel(day) {
  const props = day.properties || {};
  const date = (props.start_datetime || props.datetime || '').slice(0, 10) || day.id;
  const part = (props.title || '').match(/\((\d+\/\d+)\)$/);
  return part ? `${date} (${part[1]})` : date;
}

// The loaded days as rows of date, file count and size, with Show more while pages remain.
function renderDayList(pager) {
  if (pager.done && pager.days.length === 0) {
    return '<div class="empty">No days match the current filters</div>';
  }
  const loaded = pager.days.length;
  const total = Math.max(pager.total ?? loaded, loaded);
  let html = `
    <div class="files-header">
      <span class="files-count">${pager.done ? `${loaded} days` : `${loaded} of ${total} days`}</span>
    </div>
    <div class="day-rows">
  `;
  for (const day of pager.days) {
    const props = day.properties || {};
    const count = props['blatten:file_count'];
    const size = props['blatten:total_size'];
    html += `
      <div class="day-row" data-day-id="${day.id}">
        <span class="file-meta-toggle"><span class="arrow">&#9654;</span></span>
        <span class="day-date">${dayLabel(day)}</span>
        <span class="asset-meta">
          ${count != null ? `<span class="day-count">${count} files</span>` : ''}
          ${size ? `<span class="asset-size">${formatSize(size)}</span>` : ''}
        </span>
      </div>
    `;
  }
  html += '</div>';
  if (!pager.done) {
    html += `<div class="show-more-days"><button class="show-more-btn">Show more days (${loaded} of ${total} loaded)</button></div>`;
  }
  return html;
}
