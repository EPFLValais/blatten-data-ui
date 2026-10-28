// Checks that an opened series lists its days a page at a time within the date filter, and that
// opening a day shows exactly its files.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = (name) => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');

function load() {
  const ctx = {
    URL,
    URLSearchParams,
    formatSize: (bytes) => (bytes ? `${bytes} B` : '-'),
    formatDate: (d) => d || '-',
  };
  for (const name of ['listing.js', 'days.js', 'assets.js']) vm.runInNewContext(src(name), ctx);
  return ctx;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDay = (n) => new Date(Date.UTC(2031, 0, 1) + n * DAY_MS).toISOString().slice(0, 10);

// A fake API over one series of `count` days, each day three files. The items endpoint applies
// the series filter and a datetime interval against each day's span, caps limit at 1000 and
// links the next page with an absolute href; the item endpoint pages a day's assets.
function fakeSeries(count) {
  const days = Array.from({ length: count }, (_, n) => {
    const date = isoDay(n);
    const id = `apiary_${date}`;
    const assets = {};
    for (let f = 0; f < 3; f++) {
      const key = `frame-${date}-${f}.jpg`;
      assets[key] = { href: `/files/apiary/${key}`, title: key, 'file:size': 7, datetime: `${date}T0${f}:00:00Z` };
    }
    return {
      id,
      collection: 'hives',
      properties: {
        datetime: null, start_datetime: `${date}T00:00:00Z`, end_datetime: `${date}T02:00:00Z`,
        'blatten:series': 'apiary', 'blatten:file_count': 3,
      },
      assets,
    };
  });
  const seriesItem = {
    id: 'apiary',
    collection: 'hives',
    properties: { 'blatten:file_count': 3 * count + 1 },
    links: [{ rel: 'items', href: "https://elsewhere.invalid/stac/collections/hives/items?filter=blatten:series='apiary'", title: 'Days' }],
  };
  const requests = [];
  const fetchJson = async (url) => {
    const u = new URL(url, 'http://test.invalid');
    requests.push(u);
    const item = u.pathname.match(/\/items\/([^/]+)$/);
    if (item) {
      const d = days.find((x) => x.id === decodeURIComponent(item[1]));
      const keys = Object.keys(d.assets);
      const limit = Number(u.searchParams.get('asset_limit'));
      const offset = Number(u.searchParams.get('asset_offset'));
      const assets = Object.fromEntries(keys.slice(offset, offset + limit).map((k) => [k, d.assets[k]]));
      return { ...d, assets, _assetsMeta: { total: keys.length, offset, returned: Object.keys(assets).length } };
    }
    assert.equal(u.searchParams.get('filter'), "blatten:series='apiary'");
    let matched = days;
    const datetime = u.searchParams.get('datetime');
    if (datetime) {
      const [from, to] = datetime.split('/');
      matched = matched.filter((d) => (from === '..' || d.properties.end_datetime >= from)
        && (to === '..' || d.properties.start_datetime <= to));
    }
    const limit = Math.min(Number(u.searchParams.get('limit') || 10), 1000);
    const offset = Number(u.searchParams.get('offset') || 0);
    const links = [];
    if (offset + limit < matched.length) {
      const next = new URLSearchParams(u.searchParams);
      next.set('offset', String(offset + limit));
      links.push({ rel: 'next', href: `https://elsewhere.invalid${u.pathname}?${next}` });
    }
    const page = matched.slice(offset, offset + limit);
    const features = u.searchParams.get('exclude_assets') === 'true' ? page.map((d) => ({ ...d, assets: {} })) : page;
    return { features, numberMatched: matched.length, links };
  };
  return { days, seriesItem, requests, fetchJson };
}

const dayRows = (html) => [...html.matchAll(/class="day-row" data-day-id="([^"]+)"/g)].map((m) => m[1]);
const fileHrefs = (html) => [...html.matchAll(/class="file-item asset-row" href="([^"]+)"/g)].map((m) => m[1]);

test('an opened series with 230 days shows 100, then 200, then 230 after Show more twice', async () => {
  const d = load();
  const api = fakeSeries(230);
  const url = d.daysUrl(d.daysLink(api.seriesItem), '/stac/collections/hives/items', new URLSearchParams());
  const pager = d.createDayPager(api.fetchJson, url, '/stac/collections/hives/items');

  const shown = [];
  await pager.next();
  let html = d.renderDayList(pager);
  shown.push(dayRows(html).length);
  while (html.includes('show-more-days')) {
    await pager.next();
    html = d.renderDayList(pager);
    shown.push(dayRows(html).length);
    assert.ok(shown.length < 10, 'Show more never finished');
  }

  assert.deepEqual(shown, [100, 200, 230]);
  assert.deepEqual(dayRows(html), api.days.map((x) => x.id));
  assert.equal(api.requests.length, 3);
  for (const u of api.requests) {
    assert.equal(u.pathname, '/stac/collections/hives/items');
    assert.equal(u.origin, 'http://test.invalid');
    assert.equal(u.searchParams.get('exclude_assets'), 'true');
    assert.ok(Number(u.searchParams.get('limit')) <= 1000, `a request asked for ${u.searchParams.get('limit')}`);
  }
  assert.match(html, new RegExp(`${isoDay(0)}[\\s\\S]*3 files`));
});

test('with a date filter set, the days requests carry the same datetime', async () => {
  const d = load();
  const api = fakeSeries(230);
  const filter = new URLSearchParams({ exclude_assets: 'true', datetime: '2031-02-01T00:00:00.000Z/2031-02-10T23:59:59.000Z', q: 'apiary' });
  const url = d.daysUrl(d.daysLink(api.seriesItem), '/stac/collections/hives/items', filter);
  const pager = d.createDayPager(api.fetchJson, url, '/stac/collections/hives/items');
  await pager.next();

  assert.equal(pager.done, true);
  assert.deepEqual([...pager.days.map((x) => x.id)], Array.from({ length: 10 }, (_, n) => `apiary_${isoDay(31 + n)}`));
  for (const u of api.requests) {
    assert.equal(u.searchParams.get('datetime'), filter.get('datetime'));
    assert.equal(u.searchParams.get('q'), null);
  }
});

test('opening a day shows exactly its files', async () => {
  const d = load();
  const api = fakeSeries(5);
  const day = api.days[2];
  const pager = d.createAssetPager(
    (limit, offset) => api.fetchJson(`/stac/collections/hives/items/${day.id}?asset_limit=${limit}&asset_offset=${offset}`),
    { total: 3 });
  await pager.next();
  const hrefs = fileHrefs(d.renderItemAssets(pager));
  assert.deepEqual([...hrefs].sort(), Object.values(day.assets).map((a) => a.href).sort());
});

test('an item without a days link has no day list', () => {
  const d = load();
  assert.equal(d.daysLink({ id: 'comb', links: [{ rel: 'self', href: '/x' }] }), null);
  assert.equal(d.daysLink({ id: 'comb' }), null);
});

test('the page loads the day list before the file list and app script', () => {
  assert.match(src('index.html'), /<script src="listing\.js"><\/script>\s*<script src="days\.js"><\/script>\s*<script src="assets\.js"><\/script>/);
  assert.match(src('app.js'), /createDayPager\(/);
});
