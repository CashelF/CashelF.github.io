"""Check the deployable HTML without executing JavaScript."""
import json
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, unquote
import xml.etree.ElementTree as ET

BUILD = Path(__file__).resolve().parents[1] / "build"
ORIGIN = "https://cashel.dev"


class Page(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.tags = []
        self.text = []
        self.ids = []
        self.h1 = []
        self.links = []
        self.assets = []
        self.meta = {}
        self.canonical = []
        self.schema_text = ""
        self.in_schema = False
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("script", "style", "h1"):
            self.tags.append(tag)
        if a.get("id"):
            self.ids.append(a["id"])
        if tag == "a":
            self.links.append(a.get("href", ""))
        if tag in ("script", "img") and a.get("src"):
            self.assets.append(a["src"])
        if tag == "link" and a.get("rel") == "stylesheet":
            self.assets.append(a["href"])
        if tag == "link" and a.get("rel") == "canonical":
            self.canonical.append(a["href"])
        if tag == "meta":
            self.meta[a.get("name", a.get("property"))] = a.get("content", "")
        if tag == "script" and a.get("type") == "application/ld+json":
            self.in_schema = True

    def handle_endtag(self, tag):
        if tag in ("script", "style", "h1") and self.tags:
            self.tags.pop()
        if tag == "script":
            self.in_schema = False

    def handle_data(self, data):
        if self.in_schema:
            self.schema_text += data
        if "script" not in self.tags and "style" not in self.tags:
            self.text.append(data)
        if "h1" in self.tags:
            self.h1.append(data)


tree = ET.parse(BUILD / "sitemap.xml")
urls = [element.text for element in tree.findall(".//{*}loc")]
expected = {"/", "/about/", "/projects/marvin/", "/projects/speaker-adaptation/", "/projects/minecraft-rl/"}
assert {url.removeprefix(ORIGIN) for url in urls} == expected
parsed = {}
for url in urls + [ORIGIN + "/404.html"]:
    route = url.removeprefix(ORIGIN)
    target = BUILD / (route.lstrip("/") + "index.html" if route.endswith("/") else route.lstrip("/"))
    page = Page(target.read_text())
    parsed[route] = page
    text = " ".join(page.text)
    assert page.canonical == [url], (route, page.canonical)
    assert page.meta["og:url"] == url
    assert page.meta["og:title"] == page.meta["twitter:title"]
    assert "Cash" not in page.meta["og:title"].replace("Cashel", "")
    assert len(page.ids) == len(set(page.ids)), (route, "duplicate IDs")
    assert page.h1, (route, "missing heading")
    graph = json.loads(page.schema_text)["@graph"]
    person = next(item for item in graph if item["@type"] == "Person")
    assert person["name"] == "Cashel Fitzgerald"
    if route == "/404.html":
        assert "noindex" in page.meta["robots"]
    else:
        assert "noindex" not in page.meta["robots"]
        assert len(text.split()) > 150, (route, "missing readable content")
    for asset in page.assets:
        if not urlsplit(asset).scheme:
            assert (BUILD / unquote(urlsplit(asset).path).lstrip("/")).is_file(), (route, asset)

for route, page in parsed.items():
    for href in page.links:
        link = urlsplit(href)
        if link.scheme or link.netloc or not href:
            continue
        target_route = link.path or route
        if target_route in parsed:
            if link.fragment:
                assert link.fragment in parsed[target_route].ids, (route, href)
        else:
            target = BUILD / unquote(target_route).lstrip("/")
            assert target.is_file(), (route, "broken local link", href)

assert "49.4%" in " ".join(parsed["/projects/speaker-adaptation/"].text)
assert "scripted opponent" in " ".join(parsed["/projects/minecraft-rl/"].text)
assert "/projects/marvin/" in parsed["/"].links
assert "/projects/speaker-adaptation/" in parsed["/"].links
assert "/projects/minecraft-rl/" in parsed["/"].links
print(f"Verified {len(parsed)} static pages: readable content, metadata, schema, sitemap, assets, and local links.")
