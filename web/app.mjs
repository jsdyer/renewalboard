import * as M from './model.mjs';

const STORE = 'coolcode:renewalboard:list';
const $ = (s) => document.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false));
  return el;
}
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—');
const LABEL = { critical: 'Act now', warning: 'Soon', notice: 'Check', ok: 'OK', pending: 'Checking' };

let config, rows = [], bootstrap = null;

async function getJson(url, timeout, accept = 'application/json') {
  const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', headers: { Accept: accept }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}
const why = (e) => (e.name === 'TimeoutError' ? 'timed out' : e instanceof TypeError ? 'not reachable from this browser' : e.message);

async function registry(domain) {
  const cfg = config.sources.rdap;
  bootstrap ??= getJson(cfg.bootstrap, cfg.timeout_ms).then((b) => b.services);
  const base = M.registryFor(domain, await bootstrap);
  if (!base) throw new Error('no RDAP service for this TLD');
  for (const name of M.registrationCandidates(domain)) {
    try { return M.parseRdap(await getJson(`${base}domain/${encodeURIComponent(name)}`, cfg.timeout_ms, 'application/rdap+json, application/json')); }
    catch (e) { if (e.status !== 404) throw e; }
  }
  throw new Error('not registered');
}

async function certificate(domain) {
  const cfg = config.sources.certificates;
  const url = new URL(cfg.endpoint);
  url.searchParams.set('q', domain); url.searchParams.set('output', 'json'); url.searchParams.set('exclude', 'expired');
  return M.latestCertificate(await getJson(url.href, cfg.timeout_ms));
}

function render() {
  const counts = { critical: 0, warning: 0, notice: 0, ok: 0 };
  rows.forEach((r) => { if (r.assessment) counts[r.assessment.level]++; });
  $('#counts').replaceChildren(...Object.entries(counts).map(([k, v]) => h('span', {}, h('span', { class: `badge ${k}` }, LABEL[k]), ` ${v}`)));
  const shown = M.sortRows(rows.map((r) => ({ ...r, assessment: r.assessment || { level: 'ok', flags: [] }, pending: !r.assessment })));
  $('#board').replaceChildren(
    h('thead', {}, h('tr', {}, ...['Domain', 'Registration', 'Certificate', 'Safeguards', 'Notes'].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, ...shown.map((r) => {
      const st = r.rdap?.status.join(' ') || '';
      const left = M.daysUntil(r.rdap?.expires);
      const cleft = M.daysUntil(r.cert?.expires);
      return h('tr', {},
        h('td', {}, h('span', { class: `badge ${r.pending ? 'pending' : r.assessment.level}` }, r.pending ? LABEL.pending : LABEL[r.assessment.level]), h('div', { class: 'dom' }, r.domain),
          r.rdap && r.rdap.name && r.rdap.name !== r.domain ? h('div', { class: 'days' }, `registered as ${r.rdap.name}`) : null),
        h('td', {}, day(r.rdap?.expires), left !== null ? h('div', { class: 'days' }, left < 0 ? `expired ${-left} days ago` : `${left} days left`) : null,
          r.rdap?.registrar ? h('div', { class: 'days' }, r.rdap.registrar) : null),
        h('td', {}, r.certChecked ? day(r.cert?.expires) : r.certError ? 'Unavailable' : '—',
          cleft !== null ? h('div', { class: 'days' }, `${cleft} days left · ${r.cert.issuer}`) : r.certError ? h('div', { class: 'days' }, r.certError) : null),
        h('td', {}, r.rdap ? [h('div', {}, /transfer ?prohibited/.test(st) ? 'Transfer locked' : 'Transfer unlocked'),
          h('div', { class: 'days' }, r.rdap.dnssec === null ? 'DNSSEC not stated' : r.rdap.dnssec ? 'DNSSEC signed' : 'DNSSEC unsigned')] : '—'),
        h('td', { class: 'flags' }, r.assessment.flags.length ? h('ul', {}, ...r.assessment.flags.map((f) => h('li', {}, f.text))) : (r.pending ? '' : 'Nothing to flag')));
    })));
}

async function check(text) {
  const { domains, invalid, truncated } = M.parseList(text, config.max_domains);
  const status = $('#status');
  if (!domains.length) { status.textContent = 'Enter at least one domain.'; return; }
  if ($('#remember').checked) { try { localStorage.setItem(STORE, domains.join('\n')); } catch { /* storage unavailable */ } }
  $('#results').hidden = false;
  const withCerts = $('#certs').checked && config.sources.certificates.enabled;
  rows = domains.map((domain) => ({ domain }));
  render();
  let done = 0;
  status.textContent = `Checking ${domains.length} domain${domains.length === 1 ? '' : 's'}…`;
  let next = 0;
  await Promise.all(Array.from({ length: config.concurrency }, async () => {
    while (next < rows.length) {
      const row = rows[next++];
      const [reg, cert] = await Promise.allSettled([registry(row.domain), withCerts ? certificate(row.domain) : Promise.resolve(undefined)]);
      if (reg.status === 'fulfilled') row.rdap = reg.value; else row.error = why(reg.reason);
      if (withCerts) { if (cert.status === 'fulfilled') { row.cert = cert.value; row.certChecked = true; } else row.certError = why(cert.reason); }
      row.assessment = M.assess(row, { warnDays: config.warn_days });
      done++;
      status.textContent = `Checked ${done} of ${rows.length}…`;
      render();
    }
  }));
  status.textContent = [`Checked ${rows.length} domain${rows.length === 1 ? '' : 's'} on ${new Date().toLocaleString('en-CA').replace(/\.$/, '')}.`,
    invalid.length ? `Skipped: ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''} (not domain names).` : '',
    truncated ? `Only the first ${config.max_domains} were checked.` : ''].filter(Boolean).join(' ');
}

function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#form').addEventListener('submit', (e) => { e.preventDefault(); check($('#domains').value); });
$('#examples').addEventListener('click', () => { $('#domains').value = config.examples.join('\n'); });
$('#remember').addEventListener('change', (e) => {
  try { if (e.target.checked) localStorage.setItem(STORE, $('#domains').value); else localStorage.removeItem(STORE); } catch { /* storage unavailable */ }
});
const finished = () => rows.filter((r) => r.assessment);
$('#dl-ics').addEventListener('click', () => download('domain-renewals.ics', 'text/calendar', M.toIcs(finished(), { alarms: config.calendar_alarms_days })));
$('#dl-csv').addEventListener('click', () => download('domain-renewals.csv', 'text/csv', M.toCsv(M.sortRows(finished()))));

try {
  config = await (await fetch('./config.json')).json();
  $('#max').textContent = config.max_domains;
  let saved = null;
  try { saved = localStorage.getItem(STORE); } catch { /* storage unavailable */ }
  if (saved) { $('#domains').value = saved; $('#remember').checked = true; }
  const fromUrl = new URL(location.href).searchParams.get('domains');
  if (fromUrl) { $('#domains').value = fromUrl.split(',').join('\n'); check(fromUrl); }
} catch (e) { $('#status').textContent = 'Configuration failed to load.'; console.error(e); }
