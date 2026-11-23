// Checks that item lists are read at the series level a page at a time, that filter options come
// from the collection summaries, and that a text match counts once for its series.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const ctx = { URL, URLSearchParams };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/listing.js'), 'utf8'), ctx);
  return ctx;
}

// A fake items endpoint over `features`, filtered and paged like the API: it applies
// `blatten:series IS NULL` and `q` against the id, caps limit at 1000 and links the next page
// with an absolute href.
function fakeApi(features) {
  const requests = [];
  const fetchJson = async (url) => {
    const u = new URL(url, 'http://test.invalid');
    requests.push(u);
    let matched = features;
    const filter = u.searchParams.get('filter');
    if (filter === 'blatten:series IS NULL') matched = matched.filter((f) => !f.properties['blatten:series']);
    else if (filter) throw new Error(`unexpected filter ${filter}`);
    const q = u.searchParams.get('q');
    if (q) matched = matched.filter((f) => f.id.includes(q) || (f.properties.files || []).some((n) => n.includes(q)));
    const limit = Math.min(Number(u.searchParams.get('limit') || 10), 1000);
    const offset = Number(u.searchParams.get('offset') || 0);
    const links = [];
    if (offset + limit < matched.length) {
      const next = new URLSearchParams(u.searchParams);
      next.set('offset', String(offset + limit));
      links.push({ rel: 'next', href: `https://elsewhere.invalid${u.pathname}?${next}` });
    }
    return { features: matched.slice(offset, offset + limit), numberMatched: matched.length, links };
  };
  return { requests, fetchJson };
}

const series = (id, collection, files = []) => ({ id, collection, properties: { files } });
const day = (id, collection, seriesId, files = []) => ({ id, collection, properties: { 'blatten:series': seriesId, files } });

test('a collection with 450 series and their days lists all 450 series and no day, in three requests of limit 200', async () => {
  const l = load();
  const features = [];
  for (let i = 0; i < 450; i++) {
    const id = `hive-${String(i).padStart(3, '0')}`;
    features.push(series(id, 'hives'));
    features.push(day(`${id}_2031-04-01`, 'hives', id), day(`${id}_2031-04-02`, 'hives', id));
  }
  const api = fakeApi(features);
  const pages = [];
  const listed = await l.fetchAllPages(api.fetchJson, '/stac/collections/hives/items',
    l.seriesLevel(new URLSearchParams({ exclude_assets: 'true' })), (page) => pages.push(page.length));

  assert.equal(listed.length, 450);
  assert.ok(listed.every((f) => !f.properties['blatten:series']));
  assert.deepEqual(pages, [200, 200, 50]);
  assert.equal(api.requests.length, 3);
  for (const u of api.requests) {
    assert.equal(u.pathname, '/stac/collections/hives/items');
    assert.equal(u.searchParams.get('filter'), 'blatten:series IS NULL');
    assert.equal(u.searchParams.get('exclude_assets'), 'true');
    assert.ok(Number(u.searchParams.get('limit')) <= 1000);
  }
});

test('a page loader stops when told to', async () => {
  const l = load();
  const api = fakeApi(Array.from({ length: 450 }, (_, i) => series(`comb-${i}`, 'combs')));
  const listed = await l.fetchAllPages(api.fetchJson, '/stac/search', new URLSearchParams(), () => false);
  assert.equal(listed, null);
  assert.equal(api.requests.length, 1);
});

test('filter options are the union of the collection summaries', () => {
  const l = load();
  const options = l.filterOptionsFromSummaries([
    { id: 'hives', summaries: { 'blatten:sensor': ['Hive Scale'], 'blatten:source': ['Apiary Office'], 'blatten:processing_level': [2, 1] } },
    { id: 'meadows', summaries: { 'blatten:sensor': ['Pollen Trap', 'Hive Scale'], 'blatten:processing_level': [3] } },
    { id: 'empty' },
  ]);
  assert.deepEqual([...options.sensors], ['Hive Scale', 'Pollen Trap']);
  assert.deepEqual([...options.sources], ['Apiary Office']);
  assert.deepEqual([...options.processingLevels], ['1', '2', '3']);
  assert.deepEqual([...options.sensorsByCollection.meadows], ['Pollen Trap', 'Hive Scale']);
  assert.deepEqual([...options.processingLevelsByCollection.hives], ['2', '1']);
  assert.deepEqual([...options.sourcesByCollection.empty], []);
});

test('a text match on two days of one series counts that series once', async () => {
  const l = load();
  const api = fakeApi([
    series('hive-a', 'hives'),
    day('hive-a_2031-04-01', 'hives', 'hive-a', ['swarm-0900.jpg']),
    day('hive-a_2031-04-02', 'hives', 'hive-a', ['swarm-1400.jpg']),
    series('hive-b', 'hives', ['swarm-notes.txt']),
    series('meadow-a', 'meadows'),
  ]);
  const matches = await l.fetchAllPages(api.fetchJson, '/stac/search', new URLSearchParams({ q: 'swarm' }));
  assert.equal(api.requests[0].searchParams.get('filter'), null);
  const counts = l.countSeriesMatches(matches);
  assert.equal(counts.hives, 2);
  assert.equal(counts.meadows, undefined);
  assert.deepEqual([...l.seriesKeys(matches)].sort(), ['hive-a', 'hive-b']);
});

test('no request in the website sets a limit over 1000', () => {
  for (const name of ['app.js', 'listing.js', 'assets.js']) {
    const code = fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');
    const limits = [...code.matchAll(/(?:set\(\s*'limit',\s*'?|limit=|_SIZE\s*=\s*)(\d+)/g)].map((m) => Number(m[1]));
    for (const limit of limits) assert.ok(limit <= 1000, `${name} asks for limit ${limit}`);
  }
});

test('escapeHtml leaves no markup characters in text', () => {
  const { escapeHtml } = load();
  const escaped = escapeHtml('<img src=x onerror=alert(1)>');
  assert.ok(!escaped.includes('<') && !escaped.includes('>'));
  assert.equal(escapeHtml('a"b\'c&d'), 'a&quot;b&#39;c&amp;d');
  assert.equal(escapeHtml(12), '12');
});

test('the breadcrumb title shows an unknown collection id as text', () => {
  const { breadcrumbTitleHtml } = load();
  const html = breadcrumbTitleHtml([], '<img src=x onerror=1>');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=1&gt;'));
});

test('the breadcrumb title escapes a collection title from the catalog', () => {
  const { breadcrumbTitleHtml } = load();
  const html = breadcrumbTitleHtml([{ id: 'c1', title: '<b onclick=1>t</b>' }], 'c1');
  assert.ok(!html.includes('<b '));
});

test('the breadcrumb title of a known collection links back and names the collection', () => {
  const { breadcrumbTitleHtml } = load();
  const html = breadcrumbTitleHtml([{ id: 'radar-2025', title: 'Radar & Camera' }], 'radar-2025');
  assert.ok(html.includes('<a href="#" id="backToCollections">'));
  assert.ok(html.includes('<span class="file-nav-collection">Radar &amp; Camera</span>'));
});

test('the breadcrumb title falls back to the id and shows All Collections when none is open', () => {
  const { breadcrumbTitleHtml } = load();
  assert.ok(breadcrumbTitleHtml([], 'radar-2025').includes('>radar-2025</span>'));
  assert.equal(breadcrumbTitleHtml([], null), '<span>All Collections</span>');
});

test('request paths encode collection and item ids', () => {
  const { collectionItemsPath } = load();
  assert.equal(collectionItemsPath('radar-2025'), '/stac/collections/radar-2025/items');
  assert.equal(collectionItemsPath('radar-2025', 'a.b_1'), '/stac/collections/radar-2025/items/a.b_1');
  for (const id of ['../x', '..', '.', 'a/b', 'a?b#c']) {
    const path = collectionItemsPath(id, id);
    assert.ok(!path.includes('../') && !path.includes('/./') && !path.includes('/../'), path);
    assert.equal(path.split('/').length, 6, path);
  }
  assert.equal(collectionItemsPath('../x'), '/stac/collections/..%2Fx/items');
  assert.equal(collectionItemsPath('..'), '/stac/collections/%2E%2E/items');
});
