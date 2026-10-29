"""Verifies that the companion server serves many requests over ONE TCP connection
(HTTP keep-alive), including the new /api/status route.

Usage: python tools/keepalive-test.py <ServerHarness.exe> [port]
"""
import json
import socket
import subprocess
import sys
import time

TOKEN = "test-companion-token"
GAME = "11111111-1111-4111-8111-111111111111"


def request_text(method, path, body=None):
    data = b"" if body is None else body.encode()
    return (
        "%s %s HTTP/1.1\r\n"
        "Host: 127.0.0.1\r\n"
        "Authorization: Bearer %s\r\n"
        "Connection: keep-alive\r\n"
        "Content-Length: %d\r\n\r\n" % (method, path, TOKEN, len(data))
    ).encode() + data


def read_one_response(sock):
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise RuntimeError("connection closed early; buffer=%r" % buf[:200])
        buf += chunk
    head, rest = buf.split(b"\r\n\r\n", 1)
    text = head.decode(errors="replace")
    status = text.split("\r\n")[0]
    length = 0
    conn = ""
    for line in text.split("\r\n")[1:]:
        low = line.lower()
        if low.startswith("content-length:"):
            length = int(line.split(":", 1)[1].strip())
        elif low.startswith("connection:"):
            conn = line.split(":", 1)[1].strip()
    while len(rest) < length:
        chunk = sock.recv(4096)
        if not chunk:
            break
        rest += chunk
    return status, rest[:length], conn


def wait_ready(port, deadline=15):
    end = time.time() + deadline
    while time.time() < end:
        try:
            probe = socket.create_connection(("127.0.0.1", port), timeout=1)
            probe.close()
            return True
        except OSError:
            time.sleep(0.2)
    return False


def main():
    exe = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 19899
    failures = []
    proc = subprocess.Popen(
        [exe, str(port)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        if not wait_ready(port):
            print("FAIL: server never became ready")
            return 1

        sock = socket.create_connection(("127.0.0.1", port), timeout=5)

        sock.sendall(request_text("GET", "/api/catalog"))
        status, payload, conn = read_one_response(sock)
        if "200" not in status:
            failures.append("catalog status: %s" % status)
        if conn != "keep-alive":
            failures.append("catalog did not advertise keep-alive: %r" % conn)
        if b"games" not in payload:
            failures.append("catalog body missing games")

        sock.sendall(request_text("GET", "/api/artwork/" + GAME + "/cover"))
        status, payload, conn = read_one_response(sock)
        if "200" not in status:
            failures.append("artwork status: %s" % status)

        sock.sendall(request_text("GET", "/api/status"))
        status, payload, conn = read_one_response(sock)
        if "200" not in status:
            failures.append("status route missing/bad: %s" % status)
        else:
            try:
                data = json.loads(payload.decode())
                if "gameCount" not in data or "online" not in data:
                    failures.append("status payload shape: %s" % str(data)[:120])
            except Exception as exc:
                failures.append("status not JSON: %s" % exc)

        body = json.dumps({"id": GAME, "requestId": "22222222-2222-4222-8222-222222222222"})
        sock.sendall(request_text("POST", "/api/launch", body))
        status, payload, conn = read_one_response(sock)
        if "200" not in status:
            failures.append("launch status: %s" % status)

        sock.close()

        if failures:
            print("FAIL:")
            for f in failures:
                print("  -", f)
            return 1
        print("PASS: 4 requests (catalog, artwork, status, launch) served on ONE TCP connection")
        return 0
    finally:
        try:
            proc.kill()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
