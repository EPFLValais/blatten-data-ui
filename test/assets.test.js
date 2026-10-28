// Checks that an item's files are fetched a page at a time and all reached through "Show more".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = (name) => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');

function load() {
  const ctx = {
    formatSize: (bytes) => (bytes ? `${bytes} B` : '-'),
    formatDate: (d) => d || '-',
  };
  vm.runInNewContext(src('assets.js'), ctx);
  return ctx;
}

// A fake item of `count` files, served like the API: assets in key order,
// the archive on every page, and the total in _assetsMeta.
function fakeItem(count, { meta = true } = {}) {
  const keys = Array.from({ length: count }, (_, i) => `hive-${i}.${i % 3 ? 'csv' : 'png'}`)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const requests = [];
  const fetchPage = async (limit, offset) => {
    requests.push({ limit, offset });
    const assets = { archive: { href: '/zip/hives.zip' } };
    for (const key of keys.slice(offset, offset + limit)) {
      assets[key] = { href: `/files/${key}`, title: key, 'file:size': 10 };
    }
    const page = { assets };
    if (meta) page._assetsMeta = { total: count, offset, returned: Math.max(0, Math.min(limit, count - offset)) };
    return page;
  };
  return { keys, requests, fetchPage };
}

const rowHrefs = (html) => [...html.matchAll(/class="file-item asset-row" href="([^"]+)"/g)].map((m) => m[1]);

test('an item with more files than one page shows all of them once Show more is pressed until done', async () => {
  const a = load();
  const item = fakeItem(1234);
  const pager = a.createAssetPager(item.fetchPage, { total: 1234 });
  await pager.next();
  let html = a.renderItemAssets(pager);
  assert.match(html, /500 of 1234 files/);
  let presses = 0;
  while (html.includes('show-more-assets')) {
    await pager.next();
    html = a.renderItemAssets(pager);
    presses += 1;
    assert.ok(presses < 10, 'Show more never finished');
  }
  const hrefs = rowHrefs(html);
  assert.equal(hrefs.length, 1234);
  assert.equal(new Set(hrefs).size, 1234);
  assert.deepEqual([...hrefs].sort(), item.keys.map((k) => `/files/${k}`).sort());
  assert.match(html, /1234 files/);
  assert.doesNotMatch(html, / of 1234/);
  assert.equal(item.requests.length, 3);
  for (const r of item.requests) assert.ok(r.limit <= 500, `a request asked for ${r.limit}`);
  assert.deepEqual(item.requests.map((r) => r.offset), [0, 500, 1000]);
});

test('a group count reads loaded-of-total until the item is complete', async () => {
  const a = load();
  const item = fakeItem(1234);
  const pager = a.createAssetPager(item.fetchPage);
  await pager.next();
  const html = a.renderItemAssets(pager);
  const badges = [...html.matchAll(/class="file-group-badge"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.equal(badges.length, 2);
  for (const b of badges) assert.match(b, /^\d+ of \d+ loaded$|^\d+\+$/);
});

test('an item that fits in one page is complete after one request and has no Show more', async () => {
  const a = load();
  const item = fakeItem(42);
  const pager = a.createAssetPager(item.fetchPage, { total: 42 });
  await pager.next();
  const html = a.renderItemAssets(pager);
  assert.equal(pager.done, true);
  assert.doesNotMatch(html, /show-more-assets/);
  assert.equal(rowHrefs(html).length, 42);
  assert.equal(item.requests.length, 1);
});

test('without a total from the API, a short page ends the paging', async () => {
  const a = load();
  const item = fakeItem(700, { meta: false });
  const pager = a.createAssetPager(item.fetchPage);
  await pager.next();
  assert.equal(pager.done, false);
  await pager.next();
  assert.equal(pager.done, true);
  await pager.next();
  assert.equal(item.requests.length, 2);
  assert.equal(rowHrefs(a.renderItemAssets(pager)).length, 700);
});

test('pressing Show more twice at once asks for the next page only once', async () => {
  const a = load();
  const item = fakeItem(1234);
  const pager = a.createAssetPager(item.fetchPage);
  await pager.next();
  await Promise.all([pager.next(), pager.next()]);
  assert.deepEqual(item.requests.map((r) => r.offset), [0, 500]);
});

test('the page asks for an item\'s files only through the pager, never in one large request', () => {
  const app = src('app.js');
  assert.doesNotMatch(app, /fetchItemAssets\([^)]*\b\d{4,}\b/);
  assert.match(app, /createAssetPager\(/);
  assert.match(src('index.html'), /<script src="assets\.js"><\/script>\s*<script src="app\.js"><\/script>/);
});
