# Renewal Board

Keep a list of domains and see, in one table, when each registration and TLS certificate expires, whether the registry shows a transfer lock and DNSSEC, and what needs attention first. Download the dates as a calendar with reminders. Published at **https://coolcode.ca/renewalboard/**.

| Check | Source |
|---|---|
| Registration and expiry dates, registrar, status (transfer lock, redemption, hold), DNSSEC | The domain's registry through RDAP, found with IANA's bootstrap list (CIRA for .ca) |
| The unexpired certificate that runs longest | crt.sh certificate transparency search for the exact name |

## Reading the results

<!-- coolcode:guide -->
Paste your domains, one per line, and choose "Check renewals". Rows are sorted by urgency. "Act now" means a registration expires within 30 days (or already has), the domain is in redemption or on hold, or its certificate expires within a week. "Soon" means a registration within 90 days or a certificate within three weeks. "Check" covers a missing transfer lock or unsigned DNSSEC. Download the .ics file to put every expiry in your calendar with reminders 30 and 7 days before. The list is kept only if you tick "Remember this list".
<!-- /coolcode:guide -->

- A subdomain such as `www.example.ca` is looked up under its registered name.
- Some registries publish no expiry date over RDAP; the board says so instead of guessing.
- The certificate column shows the latest unexpired certificate logged for the exact name. A site behind a CDN may serve a different certificate. Automatic renewals (such as Let's Encrypt) usually replace a certificate about 30 days before it expires.

## Expand or customize

Settings live in **`web/config.json`**:

| Key | Meaning |
|---|---|
| `examples` | The list that "Load examples" fills in. Any domains work; this is only a shortcut. |
| `max_domains` | How many domains one check accepts (default 50). |
| `concurrency` | Lookups in flight at once. Lower it if a registry rate-limits you. |
| `warn_days` | Registration thresholds: the first is "Act now" and the last is "Soon" (default 30, 60, 90). |
| `calendar_alarms_days` | Reminder offsets in the .ics file (default 30 and 7 days). |
| `sources.*.timeout_ms`, `sources.certificates.enabled` | Per-source time limits, and whether certificates can be checked at all. |

To share a ready-made board, link to `https://coolcode.ca/renewalboard/?domains=example.ca,example.com`. Every lookup is live, so there's no data refresh: a push to `main` (tests, build, deploy) publishes changes.

## Develop and test

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -v
python3 scripts/build.py
python3 -m http.server 8000 --directory dist
```

`tests/browser_smoke.py` serves the build at `/renewalboard/` and answers registry and crt.sh requests from `tests/fixtures/`. It covers urgency sorting, a subdomain, a redemption-period domain, a failed lookup, registrar text containing markup, the .ics and .csv downloads, opt-in storage, and the mobile layout.

Sources: [IANA RDAP bootstrap](https://data.iana.org/rdap/dns.json), [crt.sh](https://crt.sh/).
