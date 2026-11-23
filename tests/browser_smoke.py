"""Exercise the built tool at a project subpath in Chromium, with registry and crt.sh answers from fixtures."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import tempfile
import threading
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "tests" / "fixtures"
RDAP = {"example-history.ca": "rdap-ca.json", "expiring-soon.ca": "rdap-soon.json", "lapsed.ca": "rdap-redemption.json"}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def fake_network(page):
    def handle(route):
        url = route.request.url
        if "127.0.0.1" in url:
            return route.continue_()
        cors = {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"}
        if url.startswith("https://data.iana.org/rdap/dns.json"):
            return route.fulfill(status=200, body=(FIX / "iana-dns.json").read_text(), headers=cors)
        if url.startswith("https://rdap.ca.fury.ca/rdap/domain/"):
            name = url.rsplit("/", 1)[1]
            if name == "timeout-test.ca":
                return route.abort("timedout")
            if name in RDAP:
                return route.fulfill(status=200, body=(FIX / RDAP[name]).read_text(), headers=cors)
            return route.fulfill(status=404, body="{}", headers=cors)
        if url.startswith("https://crt.sh/"):
            body = (FIX / ("crt-soon.json" if "expiring-soon" in url else "crt-live.json")).read_text()
            return route.fulfill(status=200, body=body, headers=cors)
        return route.abort()
    page.route("**/*", handle)


def main():
    screenshots = ROOT / "browser-checks"
    screenshots.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        shutil.copytree(ROOT / "dist", Path(temporary) / "renewalboard")
        server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=temporary))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_port}/renewalboard/"
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch()
                context = browser.new_context(viewport={"width": 1280, "height": 1000}, accept_downloads=True)
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                fake_network(page)
                page.goto(base)
                page.fill("#domains", "example-history.ca\nwww.expiring-soon.ca\nlapsed.ca\ntimeout-test.ca\nnot a domain\nexample-history.ca")
                page.click("#form button[type=submit]")
                page.wait_for_function("document.querySelector('#status').textContent.startsWith('Checked 4 domains on')")
                rows = page.locator("#board tbody tr")
                assert rows.count() == 4
                first = rows.nth(0).inner_text()
                assert "act now" in first.lower(), first
                texts = [rows.nth(i).inner_text() for i in range(4)]
                assert any("registered as expiring-soon.ca" in t and "Certificate expires in" in t for t in texts), texts
                assert any("redemption" in t for t in texts)
                assert any("Registry lookup failed" in t for t in texts)
                assert any("Transfer locked" in t and t.startswith("OK") for t in texts), texts
                assert "Skipped: not a domain" in page.locator("#status").inner_text()
                # Registrar names containing markup stay text.
                assert page.locator("#board b").count() == 0

                page.screenshot(path=str(screenshots / "board.png"), full_page=True)
                with page.expect_download() as ics:
                    page.click("#dl-ics")
                ics_text = Path(ics.value.path()).read_text()
                assert ics.value.suggested_filename == "domain-renewals.ics" and "Renew example-history.ca" in ics_text
                with page.expect_download() as csv:
                    page.click("#dl-csv")
                assert "expiring-soon.ca" in Path(csv.value.path()).read_text()

                # Nothing is stored unless asked; "remember" keeps the list across reloads.
                assert page.evaluate("localStorage.getItem('coolcode:renewalboard:list')") is None
                page.check("#remember")
                page.reload()
                assert "lapsed.ca" in page.locator("#domains").input_value()
                page.uncheck("#remember")
                assert page.evaluate("localStorage.getItem('coolcode:renewalboard:list')") is None

                page.screenshot(path=str(screenshots / "desktop.png"), full_page=True)
                page.set_viewport_size({"width": 390, "height": 844})
                page.screenshot(path=str(screenshots / "mobile.png"), full_page=True)
                assert page.evaluate("document.body.scrollWidth <= window.innerWidth + 1"), "page overflows"
                assert not errors, errors
                browser.close()
            print("Browser checks passed: subpath, board, flags, safe text, ICS/CSV export, opt-in storage and mobile")
        finally:
            server.shutdown()


if __name__ == "__main__":
    main()
