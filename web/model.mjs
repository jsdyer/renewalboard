// Pure logic for Renewal Board: input parsing, RDAP and crt.sh summaries, risk flags,
// sorting, and CSV / iCalendar export. No DOM, no network — unit-tested directly.

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function normalizeDomain(input) {
  let text = String(input ?? '').trim().toLowerCase();
  if (!text) throw new Error('empty');
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = `http://${text}`;
  let host;
  try { host = new URL(text).hostname.replace(/\.$/, ''); } catch { throw new Error('not a domain'); }
  if (/^\d+(\.\d+){3}$/.test(host) || host.includes(':') || host.startsWith('[')) throw new Error('an IP address');
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || host.length > 253) throw new Error('not a domain');
  return host;
}

/** Visitor list (lines, commas or semicolons) → unique domains, invalid entries, and how many were cut. */
export function parseList(text, max) {
  const domains = [], invalid = [];
  for (const raw of String(text).split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)) {
    try { const d = normalizeDomain(raw); if (!domains.includes(d)) domains.push(d); } catch { invalid.push(raw); }
  }
  return { domains: domains.slice(0, max), invalid, truncated: Math.max(0, domains.length - max) };
}

export function registrationCandidates(domain) {
  const labels = domain.split('.');
  return labels.slice(0, -1).map((_, i) => labels.slice(i).join('.'));
}

export function registryFor(domain, services) {
  let best = { length: -1, base: '' };
  for (const entry of Array.isArray(services) ? services : []) {
    const base = Array.isArray(entry?.[1]) ? entry[1].find((u) => typeof u === 'string' && u.startsWith('https://')) : null;
    if (!base || !Array.isArray(entry[0])) continue;
    for (const tld of entry[0]) {
      const t = String(tld).toLowerCase();
      if ((domain === t || domain.endsWith(`.${t}`)) && t.length > best.length) best = { length: t.length, base };
    }
  }
  return best.base ? best.base.replace(/\/?$/, '/') : '';
}

const iso = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? null : new Date(t).toISOString(); };

export function parseRdap(payload) {
  if (!payload || payload.objectClassName !== 'domain') throw new Error('not a domain record');
  const registrar = (payload.entities || []).find((e) => (e.roles || []).includes('registrar'));
  const card = registrar?.vcardArray?.[1];
  const fn = Array.isArray(card) ? (card.find((p) => p[0] === 'fn') || card.find((p) => p[0] === 'org'))?.[3] : null;
  const ev = (a) => iso((payload.events || []).find((e) => String(e.eventAction).toLowerCase() === a)?.eventDate);
  return {
    name: String(payload.ldhName || '').toLowerCase(),
    registrar: (fn && String(fn).trim()) || registrar?.handle || null,
    status: (payload.status || []).map((s) => String(s).toLowerCase()),
    nameservers: (payload.nameservers || []).map((n) => String(n.ldhName || '').toLowerCase()).filter(Boolean).sort(),
    dnssec: payload.secureDNS ? Boolean(payload.secureDNS.delegationSigned) : null,
    registered: ev('registration'),
    expires: ev('expiration'),
    changed: ev('last changed'),
  };
}

/**
 * From crt.sh rows for the exact name (unexpired only), the certificate that expires last —
 * i.e. how long the site is covered if nothing renews.
 */
export function latestCertificate(rows, now = new Date()) {
  if (!Array.isArray(rows)) throw new Error('Expected a crt.sh JSON array.');
  let best = null;
  for (const r of rows) {
    const until = iso(r.not_after);
    if (!until || Date.parse(until) < +now) continue;
    if (!best || until > best.expires) best = { expires: until, issued: iso(r.not_before), issuer: issuerName(r.issuer_name), id: r.id ?? null };
  }
  return best;
}

export function issuerName(dn = '') {
  const m = String(dn).match(/(?:^|,\s*)O=("([^"]*)"|[^,]*)/);
  const cn = String(dn).match(/(?:^|,\s*)CN=([^,]*)/);
  return ((m && (m[2] ?? m[1])) || (cn && cn[1]) || 'Unknown issuer').trim();
}

export const daysUntil = (isoDate, now = new Date()) => (isoDate ? Math.trunc((Date.parse(isoDate) - +now) / 864e5) : null);

const SEVERITY = { critical: 3, warning: 2, notice: 1, ok: 0 };

/** Risk flags for one domain's results. */
export function assess(row, { warnDays = [30, 60, 90], now = new Date() } = {}) {
  const flags = [];
  const r = row.rdap;
  if (row.error) flags.push({ level: 'warning', text: `Registry lookup failed (${row.error})` });
  if (r) {
    const d = daysUntil(r.expires, now);
    if (d === null) flags.push({ level: 'notice', text: 'Registry publishes no expiry date' });
    else if (d < 0) flags.push({ level: 'critical', text: `Registration expired ${-d} day${d === -1 ? '' : 's'} ago` });
    else if (d <= warnDays[0]) flags.push({ level: 'critical', text: `Registration expires in ${d} day${d === 1 ? '' : 's'}` });
    else if (d <= warnDays.at(-1)) flags.push({ level: 'warning', text: `Registration expires in ${d} days` });
    const st = r.status.join(' ');
    if (/redemption|pending ?delete/.test(st)) flags.push({ level: 'critical', text: 'In redemption or pending delete' });
    if (/(client|server) ?hold/.test(st)) flags.push({ level: 'critical', text: 'On hold: the domain does not resolve' });
    if (!/client ?transfer ?prohibited|server ?transfer ?prohibited/.test(st)) flags.push({ level: 'notice', text: 'No transfer lock' });
    if (r.dnssec === false) flags.push({ level: 'notice', text: 'DNSSEC not signed' });
  }
  if (row.cert === null && row.certChecked) flags.push({ level: 'warning', text: 'No unexpired certificate found in CT logs' });
  if (row.cert) {
    const c = daysUntil(row.cert.expires, now);
    if (c <= 7) flags.push({ level: 'critical', text: `Certificate expires in ${c} day${c === 1 ? '' : 's'}` });
    else if (c <= 21) flags.push({ level: 'warning', text: `Certificate expires in ${c} days` });
  }
  const level = flags.reduce((a, f) => (SEVERITY[f.level] > SEVERITY[a] ? f.level : a), 'ok');
  return { level, flags };
}

/** Most urgent first: severity, then soonest registration expiry, then name. */
export function sortRows(rows) {
  return [...rows].sort((a, b) =>
    SEVERITY[b.assessment.level] - SEVERITY[a.assessment.level]
    || (Date.parse(a.rdap?.expires ?? '9999') - Date.parse(b.rdap?.expires ?? '9999'))
    || a.domain.localeCompare(b.domain));
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // keep spreadsheet formulas inert
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(rows) {
  const head = ['domain', 'registrar', 'registered', 'registration_expires', 'days_left', 'status', 'transfer_lock', 'dnssec', 'nameservers', 'certificate_expires', 'certificate_issuer', 'flags'];
  const lines = [head.join(',')];
  for (const r of rows) {
    const st = r.rdap?.status.join('; ') ?? '';
    lines.push([r.domain, r.rdap?.registrar, r.rdap?.registered?.slice(0, 10), r.rdap?.expires?.slice(0, 10), daysUntil(r.rdap?.expires), st,
      r.rdap ? /transfer ?prohibited/.test(st) : '', r.rdap?.dnssec ?? '', r.rdap?.nameservers.join(' '), r.cert?.expires?.slice(0, 10), r.cert?.issuer,
      r.assessment.flags.map((f) => f.text).join('; ')].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (isoDate) => isoDate.slice(0, 10).replace(/-/g, '');
const fold = (line) => { const out = []; let s = line; while (s.length > 74) { out.push(s.slice(0, 74)); s = ` ${s.slice(74)}`; } out.push(s); return out.join('\r\n'); };

/** iCalendar (RFC 5545) with an all-day event per registration and certificate expiry, plus alarms. */
export function toIcs(rows, { alarms = [30, 7], now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//coolcode.ca//Renewal Board//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Domain renewals'];
  const event = (uid, date, summary, description) => {
    const next = new Date(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) + 864e5).toISOString();
    lines.push('BEGIN:VEVENT', `UID:${uid}@renewalboard.coolcode.ca`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${icsDate(date)}`, `DTEND;VALUE=DATE:${icsDate(next)}`,
      `SUMMARY:${icsText(summary)}`, `DESCRIPTION:${icsText(description)}`, 'TRANSP:TRANSPARENT');
    for (const d of alarms) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(summary)}`, `TRIGGER:-P${d}D`, 'END:VALARM');
    lines.push('END:VEVENT');
  };
  for (const r of rows) {
    if (r.rdap?.expires) event(`reg-${r.domain}-${icsDate(r.rdap.expires)}`, r.rdap.expires, `Renew ${r.domain}`, `Registration expires. Registrar: ${r.rdap.registrar || 'unknown'}.`);
    if (r.cert?.expires) event(`tls-${r.domain}-${icsDate(r.cert.expires)}`, r.cert.expires, `TLS certificate expires: ${r.domain}`, `Latest logged certificate from ${r.cert.issuer}. Usually renews automatically; check if it doesn't.`);
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
