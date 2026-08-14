#!/usr/bin/env python3
"""The whole server side of Quote Tree: one integer per cast.

The page rebuilds a cast's quote tree in the browser from public Farcaster hubs. The hubs
carry every cast but not the one number the page audits itself against: how many casts
quote a given cast. That lives in Farcaster's client API, which sends no CORS header and
allows 500 requests an hour per address. So this relays exactly that one field, caches it
on disk, and spends the upstream budget deliberately rather than letting every visitor's
browser burn it.

Callers get back only the hashes it actually knows. The page is built to say "expected
counts unavailable" for the rest rather than to guess, so this being down degrades the
audit and nothing else.

    python3 counts-relay.py 8080
    curl 'localhost:8080/api/quotecounts?hashes=0x3db99055...,0xad26514c...'

Stdlib only. Put it behind a reverse proxy that sets X-Real-IP, or don't — the per-address
limits just get less useful.
"""
import json, os, re, sys, time, threading, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

QC_FILE = os.environ.get("QC_FILE", "quotecounts.json")
QC_TTL = 6 * 3600                       # how long a count stays fresh
QC_BUDGET, QC_WINDOW = 400, 3600        # upstream calls per hour, under Farcaster's 500
PER_IP, PER_IP_WINDOW = 60, 3600        # requests per address per hour
MAX_HASHES = 40                         # per request
HASH_RE = re.compile(r"^0x[0-9a-f]{40}$")

QC_SPEND: list[float] = []
QC_RATE: dict[str, list[float]] = {}
QC_LOCK = threading.Lock()
try:
    with open(QC_FILE) as _fh:
        QC_CACHE = {k: (v[0], v[1]) for k, v in json.load(_fh).items()}
except Exception:
    QC_CACHE = {}


def _save() -> None:
    tmp = QC_FILE + ".tmp"
    with open(tmp, "w") as fh:
        json.dump({k: [v[0], v[1]] for k, v in QC_CACHE.items()}, fh)
    os.replace(tmp, QC_FILE)


def _fetch(h: str) -> int | None:
    req = urllib.request.Request(
        f"https://api.farcaster.xyz/v2/thread-casts?castHash={h}&limit=1",
        headers={"User-Agent": "quote-tree counts relay"})
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            casts = json.load(r).get("result", {}).get("casts", [])
    except Exception:
        return None
    for c in casts:
        if c.get("hash", "").lower() == h:
            n = c.get("quoteCount")
            return int(n) if isinstance(n, int) else None
    return None


def quote_counts(hashes: list[str]) -> bytes:
    now = time.time()
    out: dict[str, int] = {}
    misses = []
    for h in hashes:
        hit = QC_CACHE.get(h)
        if hit and hit[0] > now:
            out[h] = hit[1]
        else:
            misses.append(h)

    if misses:
        with QC_LOCK:
            QC_SPEND[:] = [t for t in QC_SPEND if now - t < QC_WINDOW]
            room = max(0, QC_BUDGET - len(QC_SPEND))
            for h in misses[:room]:
                QC_SPEND.append(time.time())
                n = _fetch(h)
                if n is not None:
                    QC_CACHE[h] = (time.time() + QC_TTL, n)
                    out[h] = n
            for k, (exp, _) in list(QC_CACHE.items()):
                if exp < now - QC_TTL:
                    QC_CACHE.pop(k, None)
            try:
                _save()
            except OSError:
                pass
    return json.dumps(out).encode()


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "quotetree-counts"

    def _send(self, code: int, body: bytes):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != "/api/quotecounts":
            return self._send(404, b'{"error":"not found"}')

        ip = self.headers.get("X-Real-IP", self.client_address[0])
        now = time.time()
        hits = [t for t in QC_RATE.get(ip, []) if now - t < PER_IP_WINDOW]
        QC_RATE[ip] = hits
        if len(hits) >= PER_IP:
            return self._send(429, b'{}')
        hits.append(now)

        raw = (urllib.parse.parse_qs(u.query).get("hashes") or [""])[0]
        hashes = [h.strip().lower() for h in raw.split(",") if h.strip()][:MAX_HASHES]
        hashes = [h for h in hashes if HASH_RE.match(h)]
        if not hashes:
            return self._send(400, b'{}')
        self._send(200, quote_counts(hashes))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
