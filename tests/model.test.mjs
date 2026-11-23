import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../web/model.mjs';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const NOW = new Date('2026-11-23T12:00:00Z');
const config = JSON.parse(readFileSync(new URL('../web/config.json', import.meta.url), 'utf8'));

test('list parsing: URLs, separators, duplicates, invalid entries and the cap', () => {
  const r = M.parseList('https://WWW.Cira.ca/x, cira.ca\ncoolcode.ca; 192.0.2.1\nnot a domain\ndal.ca\n smu.ca ', 4);
  assert.deepEqual(r.domains, ['www.cira.ca', 'cira.ca', 'coolcode.ca', 'dal.ca']);
  assert.deepEqual(r.invalid, ['192.0.2.1', 'not a domain']);
  assert.equal(r.truncated, 1);
  // Beyond the starter examples: any number of domains up to the configured maximum.
  const many = Array.from({ length: config.max_domains + 5 }, (_, i) => `site${i}.example.ca`).join('\n');
  assert.equal(M.parseList(many, config.max_domains).domains.length, config.max_domains);
  for (const d of config.examples) assert.equal(M.normalizeDomain(d), d);
});

test('RDAP summary: registrar, dates, status, DNSSEC', () => {
  const r = M.parseRdap(fx('rdap-ca.json'));
  assert.equal(r.registrar, '<b>Maple</b> Registrar Inc.');
  assert.equal(r.expires, '2030-03-11T15:02:00.000Z');
  assert.equal(r.registered, '2004-03-11T15:02:00.000Z');
  assert.equal(r.dnssec, true);
  assert.ok(r.status.includes('client transfer prohibited'));
  assert.equal(M.registryFor('a.b.example.ca', fx('iana-dns.json').services), 'https://rdap.ca.fury.ca/rdap/');
  assert.deepEqual(M.registrationCandidates('a.b.ca'), ['a.b.ca', 'b.ca']);
});

test('latest unexpired certificate wins; expired ones are ignored', () => {
  const c = M.latestCertificate(fx('crt-live.json'), NOW);
  assert.equal(c.issuer, 'Google Trust Services');
  assert.equal(c.expires.slice(0, 10), '2027-02-08');
  assert.equal(M.latestCertificate([{ not_after: '2020-01-01' }], NOW), null);
});

test('assessment levels and flags', () => {
  const ok = M.assess({ domain: 'x', rdap: M.parseRdap(fx('rdap-ca.json')), cert: M.latestCertificate(fx('crt-live.json'), NOW), certChecked: true }, { now: NOW });
  assert.equal(ok.level, 'ok');
  const soon = M.assess({ domain: 'y', rdap: M.parseRdap(fx('rdap-soon.json')), cert: M.latestCertificate(fx('crt-soon.json'), NOW), certChecked: true }, { now: NOW });
  assert.equal(soon.level, 'critical');
  assert.deepEqual(soon.flags.map((f) => f.text), ['Registration expires in 11 days', 'No transfer lock', 'DNSSEC not signed', 'Certificate expires in 3 days']);
  const lapsed = M.assess({ domain: 'z', rdap: M.parseRdap(fx('rdap-redemption.json')) }, { now: NOW });
  assert.ok(lapsed.flags.some((f) => /expired 53 days ago/.test(f.text)));
  assert.ok(lapsed.flags.some((f) => /redemption/.test(f.text)));
  const mid = M.assess({ domain: 'm', rdap: { ...M.parseRdap(fx('rdap-ca.json')), expires: '2027-01-20T00:00:00Z' } }, { now: NOW });
  assert.equal(mid.level, 'warning');
  const failed = M.assess({ domain: 'f', error: 'timed out' }, { now: NOW });
  assert.equal(failed.level, 'warning');
  const nocert = M.assess({ domain: 'n', rdap: M.parseRdap(fx('rdap-ca.json')), cert: null, certChecked: true }, { now: NOW });
  assert.ok(nocert.flags.some((f) => /No unexpired certificate/.test(f.text)));
});

test('sorting puts the most urgent and soonest first', () => {
  const rows = [
    { domain: 'b.ca', rdap: { expires: '2030-01-01' }, assessment: { level: 'ok' } },
    { domain: 'a.ca', rdap: { expires: '2027-01-01' }, assessment: { level: 'ok' } },
    { domain: 'c.ca', rdap: { expires: '2026-12-01' }, assessment: { level: 'critical' } },
  ];
  assert.deepEqual(M.sortRows(rows).map((r) => r.domain), ['c.ca', 'a.ca', 'b.ca']);
});

test('CSV neutralises spreadsheet formulas and quotes properly', () => {
  const rdap = M.parseRdap(fx('rdap-soon.json'));
  const row = { domain: 'expiring-soon.ca', rdap, assessment: M.assess({ rdap }, { now: NOW }) };
  const csv = M.toCsv([row]);
  assert.match(csv, /^domain,registrar,/);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.ok(csv.endsWith('\r\n'));
});

test('iCalendar: all-day events, alarms, escaping, folding', () => {
  const rdap = M.parseRdap(fx('rdap-ca.json'));
  const cert = M.latestCertificate(fx('crt-live.json'), NOW);
  const ics = M.toIcs([{ domain: 'example-history.ca', rdap, cert }], { alarms: [30, 7], now: NOW });
  assert.match(ics, /^BEGIN:VCALENDAR\r\nVERSION:2.0\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20300311\r\nDTEND;VALUE=DATE:20300312/);
  assert.match(ics, /SUMMARY:Renew example-history.ca/);
  assert.match(ics, /TRIGGER:-P30D/);
  assert.match(ics, /TRIGGER:-P7D/);
  assert.match(ics, /Registrar: <b>Maple<\/b> Registrar Inc\./);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.ok(ics.split('\r\n').every((l) => l.length <= 75));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});
