"""极简 bench 收集器：页面把帧时 JSON POST 过来，追加到 shots/bench.jsonl。

用法：
    python tools/bench-server.py          # 监听 127.0.0.1:8790
页面侧：打开 index.html?bench=40&quality=1&report=1
"""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG = os.path.join(ROOT, "shots", "bench.jsonl")


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        raw = self.rfile.read(length).decode("utf-8", "replace").strip()
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(raw + "\n")
        self.send_response(204)
        self._cors()
        self.end_headers()

    def log_message(self, *args):  # 静默
        pass


if __name__ == "__main__":
    print(f"bench collector on http://127.0.0.1:8790 -> {LOG}")
    HTTPServer(("127.0.0.1", 8790), Handler).serve_forever()
