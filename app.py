"""국내 신용카드사 비교 대시보드용 로컬 Python 서버.

외부 패키지 없이 Python 3 표준 라이브러리만 사용합니다.
"""

from __future__ import annotations

import json
import mimetypes
import os
import sys
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urlencode, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "4180"))
API_BASE = "https://apis.data.go.kr/1160100/service/GetCredCardCompInfoService/"
BUSINESS_TITLE = "신용카드_주요영업활동_신용카드이용실적"
ALLOWED_TITLES = {
    "getCredCardCompFinaInfo": "신용카드_재무현황_요약재무상태표(자산)(07.12월이전)",
    "getCredCardCompKeyManaIndi": "신용카드_주요경영지표_자본적정성",
    "getCredCardCompMajoBusiActi": BUSINESS_TITLE,
}
history_cache: list[dict] | None = None


def api_request(endpoint: str, parameters: dict[str, str]) -> tuple[int, bytes]:
    """일시적인 게이트웨이 오류만 재시도합니다."""
    url = f"{API_BASE}{endpoint}?{urlencode(parameters, quote_via=quote)}"
    last_status, last_body = 502, b""
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers={"Accept": "application/json"}), timeout=30) as response:
                last_status, last_body = response.status, response.read()
        except HTTPError as error:
            last_status, last_body = error.code, error.read()
        except URLError as error:
            raise RuntimeError(f"공공데이터 API 연결 오류: {error.reason}") from error
        if last_status not in (502, 503, 504) or attempt == 2:
            return last_status, last_body
        time.sleep(0.5 * (attempt + 1))
    return last_status, last_body


def get_history(service_key: str) -> list[dict]:
    global history_cache
    if history_cache is not None:
        return history_cache

    def page(page_no: int) -> tuple[int, list[dict]]:
        status, body = api_request("getCredCardCompMajoBusiActi", {
            "pageNo": str(page_no), "numOfRows": "1000", "resultType": "json",
            "serviceKey": service_key, "title": BUSINESS_TITLE,
        })
        if status != 200:
            raise RuntimeError(f"공공데이터 API 응답 오류 ({status})")
        table = json.loads(body).get("response", {}).get("body", {}).get("tableList", [None])[0]
        if not table:
            raise RuntimeError("공공데이터 API의 응답 형식을 해석할 수 없습니다.")
        items = table.get("items", {}).get("item", [])
        return int(table.get("totalCount", 0)), items if isinstance(items, list) else [items]

    total, all_items = page(1)
    pages = list(range(2, (total + 999) // 1000 + 1))
    if pages:
        with ThreadPoolExecutor(max_workers=3) as executor:
            for _, items in executor.map(page, pages):
                all_items.extend(items)
    history_cache = [
        item for item in all_items
        if item.get("crcdUzAtrsItemCdNm") == "총계_이용실적" and item.get("fncoNm") != "신용카드사"
    ]
    return history_cache


class DashboardHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        print(format % args)

    def send_json(self, status: int, payload: object) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_api_response(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/cards":
            self.cards(parse_qs(parsed.query))
        elif parsed.path == "/api/history":
            self.history(parse_qs(parsed.query))
        else:
            self.static_file(parsed.path)

    def cards(self, query: dict[str, list[str]]) -> None:
        endpoint = query.get("endpoint", [""])[0]
        title = query.get("title", [""])[0]
        key = query.get("key", [""])[0]
        bas_ym = query.get("basYm", [""])[0]
        if ALLOWED_TITLES.get(endpoint) != title or not key or not (len(bas_ym) == 6 and bas_ym.isdigit()):
            self.send_json(400, {"error": "허용된 endpoint, title, key, basYm(YYYYMM)이 필요합니다."})
            return
        try:
            # 브라우저가 보낸 Encoding 키를 한 번만 풀어 API 요청에서 재인코딩합니다.
            status, body = api_request(endpoint, {
                "pageNo": "1", "numOfRows": "1000", "resultType": "json",
                "serviceKey": unquote(key), "title": title, "basYm": bas_ym,
            })
            self.send_api_response(status, body)
        except RuntimeError as error:
            self.send_json(502, {"error": str(error)})

    def history(self, query: dict[str, list[str]]) -> None:
        key = query.get("key", [""])[0]
        start = query.get("start", [""])[0]
        end = query.get("end", [""])[0]
        if not key or not (len(start) == len(end) == 6 and start.isdigit() and end.isdigit() and start <= end):
            self.send_json(400, {"error": "key, start(YYYYMM), end(YYYYMM)이 필요합니다."})
            return
        try:
            items = [item for item in get_history(unquote(key)) if start <= item.get("basYm", "") <= end]
            self.send_json(200, {"items": items})
        except RuntimeError as error:
            self.send_json(502, {"error": str(error)})

    def static_file(self, pathname: str) -> None:
        filename = "index.html" if pathname == "/" else pathname.lstrip("/")
        target = (ROOT / filename).resolve()
        if ROOT not in target.parents and target != ROOT or not target.is_file():
            self.send_json(404, {"error": "Not found"})
            return
        content = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(target.name)[0] or "application/octet-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), DashboardHandler)
    url = f"http://localhost:{PORT}"
    print(f"Dashboard: {url}")
    if "--open" in sys.argv:
        webbrowser.open(url)
    server.serve_forever()
