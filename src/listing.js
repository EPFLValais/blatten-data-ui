// Item lists read from the STAC API a page at a time, and the filter options read from the
// collection summaries. A long series is one series item and a day item per day, each day naming
// its series in blatten:series; the lists show the series level only.

const LIST_PAGE_SIZE = 200;
const SERIES_LEVEL_FILTER = 'blatten:series IS NULL';

// Restricts an item query to the series level: items that are not a day of a series.
function seriesLevel(params) {
  params.set('filter-lang', 'cql2-text');
  params.set('filter', SERIES_LEVEL_FILTER);
  return params;
}

// The next page of `path` named by a page's next link, or null on the last page. Only the
// link's query is used, so pages are read from the same origin and path as the first.
function nextPageUrl(page, path) {
  const next = (page.links || []).find((link) => link.rel === 'next');
  if (!next?.href) return null;
  return `${path}${new URL(next.href, 'http://localhost').search}`;
}

// Reads every page of the item list at `path` with `params`, LIST_PAGE_SIZE at a time, through
// fetchJson(url). onPage(features, page) is called as each page arrives; returning false from it
// stops the reading and resolves to null. Otherwise resolves to every feature in order.
async function fetchAllPages(fetchJson, path, params, onPage) {
  params.set('limit', String(LIST_PAGE_SIZE));
  params.delete('offset');
  const all = [];
  let url = `${path}?${params}`;
  while (url) {
    const page = await fetchJson(url);
    const features = page.features || [];
    all.push(...features);
    if (onPage && onPage(features, page) === false) return null;
    url = features.length ? nextPageUrl(page, path) : null;
  }
  return all;
}

// The series an item belongs to: its blatten:series, or its own id when it is not a day.
function seriesKey(item) {
  return item.properties?.['blatten:series'] || item.id;
}

function seriesKeys(items) {
  return new Set(items.map(seriesKey));
}

// The number of distinct series matched in each collection, a series counted once however many
// of its days matched.
function countSeriesMatches(items) {
  const byCollection = {};
  for (const item of items) {
    if (!item.collection) continue;
    (byCollection[item.collection] ||= new Set()).add(seriesKey(item));
  }
  const counts = {};
  for (const [id, keys] of Object.entries(byCollection)) counts[id] = keys.size;
  return counts;
}

// Sensor, source and processing-level options, overall and per collection, from the
// blatten:sensor, blatten:source and blatten:processing_level summaries of the collections.
// Processing levels are strings, as the filter's option values are.
function filterOptionsFromSummaries(collections) {
  const summary = (c, key) => (c.summaries?.[key] || []).map(String);
  const options = {
    sensors: new Set(), sources: new Set(), processingLevels: new Set(),
    sensorsByCollection: {}, sourcesByCollection: {}, processingLevelsByCollection: {},
  };
  for (const c of collections) {
    const sensors = summary(c, 'blatten:sensor');
    const sources = summary(c, 'blatten:source');
    const levels = summary(c, 'blatten:processing_level');
    options.sensorsByCollection[c.id] = sensors;
    options.sourcesByCollection[c.id] = sources;
    options.processingLevelsByCollection[c.id] = levels;
    sensors.forEach((s) => options.sensors.add(s));
    sources.forEach((s) => options.sources.add(s));
    levels.forEach((l) => options.processingLevels.add(l));
  }
  const sorted = (set) => [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  options.sensors = sorted(options.sensors);
  options.sources = sorted(options.sources);
  options.processingLevels = sorted(options.processingLevels);
  return options;
}
