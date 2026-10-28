// Checks on the local stack's identity provider realm and Traefik routing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const realm = JSON.parse(readFileSync(new URL('keycloak-realm-dev.json', root), 'utf8'));
const compose = readFileSync(new URL('docker-compose.yml', root), 'utf8');

const routerRules = [...compose.matchAll(/traefik\.http\.routers\.([\w-]+)\.rule=(.+?)"/g)]
  .map(([, name, rule]) => ({ name, rule }));

const statsClient = realm.clients.find((c) => c.clientId === 'epfl-vs-blatten-data');
const clientRoles = (user) => user?.clientRoles?.['epfl-vs-blatten-data'] ?? [];

test('realm is EPFL and stats-viewer is a client role of epfl-vs-blatten-data, not a realm role', () => {
  assert.equal(realm.realm, 'EPFL');
  assert.ok(realm.roles.client?.['epfl-vs-blatten-data']?.some((r) => r.name === 'stats-viewer'));
  assert.ok(!(realm.roles.realm ?? []).some((r) => r.name === 'stats-viewer'));
});

test('blatten-admin holds stats-viewer as a client role and blatten-guest does not', () => {
  const admin = realm.users.find((u) => u.username === 'blatten-admin');
  const guest = realm.users.find((u) => u.username === 'blatten-guest');
  assert.ok(clientRoles(admin).includes('stats-viewer'));
  assert.ok(!(admin.realmRoles ?? []).includes('stats-viewer'));
  assert.ok(guest);
  assert.ok(!clientRoles(guest).includes('stats-viewer'));
  assert.ok(!(guest.realmRoles ?? []).includes('stats-viewer'));
});

test('epfl-vs-blatten-data access tokens carry epfl-vs-blatten-data in their audience', () => {
  const mapper = (statsClient?.protocolMappers ?? [])
    .find((m) => m.protocolMapper === 'oidc-audience-mapper');
  assert.ok(mapper, 'no audience mapper on epfl-vs-blatten-data');
  assert.equal(mapper.config['included.client.audience'], 'epfl-vs-blatten-data');
  assert.equal(mapper.config['access.token.claim'], 'true');
});

test('the API is configured for realm EPFL and client epfl-vs-blatten-data', () => {
  assert.match(compose, /^\s*- KEYCLOAK_REALM=EPFL$/m);
  assert.match(compose, /^\s*- KEYCLOAK_CLIENT_ID=epfl-vs-blatten-data$/m);
});

test('the stats client is public and redirects only to local origins', () => {
  const client = statsClient;
  assert.ok(client?.publicClient);
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;
  for (const uri of [...client.redirectUris, ...client.webOrigins]) {
    assert.match(uri, local);
  }
});

test('Traefik routes /stats to the API', () => {
  const stats = routerRules.find((r) => r.rule.includes('PathPrefix(`/stats`)'));
  assert.ok(stats, 'no /stats router');
  assert.match(compose, new RegExp(`traefik\\.http\\.routers\\.${stats.name}\\.service=stac\\b`));
});

test('no Traefik router matches /internal', () => {
  for (const { name, rule } of routerRules) {
    if (/PathPrefix\(`\/internal/.test(rule)) {
      assert.match(rule, /!\s*PathPrefix\(`\/internal`\)/, `${name} routes /internal`);
    }
    if (/PathPrefix\(`\/`\)/.test(rule)) {
      assert.match(rule, /!\s*PathPrefix\(`\/internal`\)/, `${name} catches /internal`);
    }
  }
});

test('the API reads the proxy metrics itself and nothing posts them to it', () => {
  assert.doesNotMatch(compose, /^\s{2}stats-scrape:/m);
  assert.doesNotMatch(compose, /STATS_INGEST_KEY/);
  assert.doesNotMatch(compose, /\/internal\/stats\/ingest/);
  const api = compose.match(/^  stac-api:\n([\s\S]*?)(?=^  \S)/m)?.[1] ?? '';
  assert.match(api, /^\s*- STATS_SCRAPE_URL=http:\/\/s3proxy:9090\/metrics$/m);
  assert.match(api, /^\s*- STATS_SCRAPE_INTERVAL=60$/m);
  assert.match(compose, /^\s*internalServer:\n\s*port: 9090$/m);
});
