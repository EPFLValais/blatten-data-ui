// Checks that catalog text reaches the collection, item, file and day rows as text: markup in a
// title or description is escaped, an attribute value cannot be broken out of, and a link is
// followed only when it is http or https.

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
    formatDateParts: (start, end) => ({ start: start || '-', sep: end ? '→' : '', end: end || '' }),
  };
  for (const name of ['listing.js', 'days.js', 'assets.js', 'rows.js']) vm.runInNewContext(src(name), ctx);
  return ctx;
}

const MARKUP = '<img src=x onerror=alert(1)>';
const QUOTE_BREAK = 'x" onmouseover="alert(1)';
const SINGLE_BREAK = "x' onmouseover='alert(1)";

// Every tag in `html` as its name and attributes, read the way a browser tokenises a tag:
// a quoted value runs to its closing quote, so text escaped inside it stays inside it.
function tags(html) {
  return [...html.matchAll(/<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g)]
    .map(([, name, body]) => ({
      name: name.toLowerCase(),
      attrs: [...body.matchAll(/([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)]
        .map(([, key, dq, sq, bare]) => ({ key: key.toLowerCase(), value: dq ?? sq ?? bare ?? '' })),
    }));
}

const attributeValues = (html) => tags(html).flatMap((t) => t.attrs.map((a) => a.value));

function assertInert(html) {
  const parsed = tags(html);
  assert.ok(!parsed.some((t) => t.name === 'img' || t.name === 'script'), `raw markup in:\n${html}`);
  assert.ok(!parsed.some((t) => t.attrs.some((a) => a.key.startsWith('on'))), `attribute break-out in:\n${html}`);
  assert.ok(!parsed.some((t) => t.attrs.some((a) => a.key === 'href' && /^\s*javascript:/i.test(a.value))), `javascript: link in:\n${html}`);
}

test('safeHref keeps http, https and relative links and replaces any other scheme', () => {
  const { safeHref } = load();
  assert.equal(safeHref('/s3/file.csv'), '/s3/file.csv');
  assert.equal(safeHref('https://host.test/file.csv'), 'https://host.test/file.csv');
  assert.equal(safeHref('http://host.test/a b.csv'), 'http://host.test/a b.csv');
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<b>', 'vbscript:x']) {
    assert.equal(safeHref(bad), '#', bad);
  }
  assert.equal(safeHref(undefined), '#');
  assert.equal(safeHref(''), '#');
});

test('a file row escapes its title and refuses a javascript: link', () => {
  const { renderAssetRow } = load();
  const html = renderAssetRow({ key: 'k', title: MARKUP, href: 'javascript:alert(1)' });
  assertInert(html);
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('href="#"'));
  assert.ok(renderAssetRow({ key: 'k', title: 'a', href: '/s3/a.csv' }).includes('href="/s3/a.csv"'));
});

test('the file list escapes the archive link and size and refuses a javascript: archive', () => {
  const { createAssetPager, renderItemAssets } = load();
  const pager = createAssetPager(async () => ({}));
  pager.assets = { [QUOTE_BREAK]: { title: MARKUP, href: `/s3/${QUOTE_BREAK}.csv` } };
  pager.done = true;
  const html = renderItemAssets(pager, { archive: { href: 'javascript:alert(1)', size: MARKUP } });
  assertInert(html);
  const safe = renderItemAssets(pager, { archive: { href: `/zip/${QUOTE_BREAK}.zip`, size: '1 B' } });
  assertInert(safe);
  assert.ok(attributeValues(safe).includes('/zip/x&quot; onmouseover=&quot;alert(1).zip'));
});

test('a day row escapes its id and label', () => {
  const { renderDayList } = load();
  const html = renderDayList({
    days: [{ id: QUOTE_BREAK, properties: { title: MARKUP } }],
    total: 1,
    done: true,
  });
  assertInert(html);
});

test('a collection row escapes its id and title', () => {
  const { collectionRowHtml } = load();
  const html = collectionRowHtml({ id: QUOTE_BREAK, title: MARKUP });
  assertInert(html);
  assert.ok(html.includes('&lt;img'));
  assertInert(collectionRowHtml({ id: MARKUP }));
});

test('an item row escapes every catalog field, its geometry and its archive link', () => {
  const { itemRowHtml } = load();
  const item = {
    id: QUOTE_BREAK,
    bbox: [7.8, 46.4, 7.9, 46.5],
    geometry: { type: 'Point', coordinates: [7.85, 46.45], name: SINGLE_BREAK },
    properties: {
      title: MARKUP,
      description: MARKUP,
      'blatten:source': MARKUP,
      'blatten:processing_level': MARKUP,
      'blatten:phase': MARKUP,
      'blatten:frequency': MARKUP,
      'blatten:additional_info': MARKUP,
      'blatten:format': MARKUP,
    },
    assets: { archive: { href: 'javascript:alert(1)', 'file:size': 3 } },
    links: [{ rel: 'items', href: `/stac/x?${QUOTE_BREAK}` }],
  };
  const html = itemRowHtml(item, SINGLE_BREAK);
  assertInert(html);
  assert.equal(html.split('&lt;img').length - 1, 8);
});

test('an item row geometry survives escaping and reads back as the same JSON', () => {
  const { itemRowHtml } = load();
  const geometry = { type: 'Point', coordinates: [7.85, 46.45], name: `${SINGLE_BREAK} & "q" <b>` };
  const html = itemRowHtml({ id: 'a', bbox: [7.8, 46.4, 7.9, 46.5], geometry, properties: {} }, 'c');
  const raw = html.match(/data-geometry="([^"]*)"/)[1];
  const decoded = raw.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.deepEqual(JSON.parse(decoded), geometry);
});

test('filter options escape their values and labels and mark the selected one', () => {
  const { filterOptionsHtml } = load();
  const html = filterOptionsHtml([QUOTE_BREAK, MARKUP, 'radar'], 'radar');
  assertInert(html);
  assert.ok(html.includes('<option value="radar" selected>radar</option>'));
  assert.ok(filterOptionsHtml(['2'], null, (v) => `Level ${v}`).includes('>Level 2<'));
});
