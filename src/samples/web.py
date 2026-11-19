# -*- coding: utf-8 -*-
"""示例：本地网页服务。启动后会把访问地址打到日志里，CLI Dock 会自动识别为快捷入口。"""
import argparse
import datetime
import http.server
import socketserver


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        body = (
            "<!doctype html><meta charset='utf-8'>"
            "<title>CLI Dock 演示服务</title>"
            "<body style='font-family:system-ui;background:#0b0e14;color:#e6e9ef;"
            "display:grid;place-items:center;height:100vh;margin:0'>"
            "<div style='text-align:center'>"
            "<h1 style='font-weight:600;margin:0 0 8px'>服务已在运行</h1>"
            f"<p style='color:#8b95a7;margin:0'>{datetime.datetime.now():%Y-%m-%d %H:%M:%S}</p>"
            "<p style='color:#6b7484;margin-top:24px;font-size:13px'>由 CLI Dock 托管的示例进程</p>"
            "</div></body>"
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"[web] {fmt % args}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", args.port), Handler) as httpd:
        print(f"[web] 服务已启动: http://127.0.0.1:{args.port}", flush=True)
        httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
