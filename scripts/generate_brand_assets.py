#!/usr/bin/env python3
"""Regenerate static site icons and share card with Playwright and Pillow.

Run: python3 scripts/generate_brand_assets.py
Requires: Pillow, playwright, and Playwright's Chromium browser.
The favicon uses only SVG paths; the share card uses system sans-serif text
and the existing portrait. The generated assets need no fonts or runtime code.
"""

import asyncio
import base64
from pathlib import Path

from PIL import Image
from playwright.async_api import async_playwright

PUBLIC = Path(__file__).resolve().parents[1] / "public"
ICON = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="13" fill="#f6f5f1"/>
  <g fill="none" stroke="#181c19" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M26 27c-3-4-10-4-14 0s-4 11 0 15 11 4 14 0"/>
    <path d="M37 45V22c0-7 4-10 10-8M31 25h15"/>
  </g>
  <circle cx="51" cy="43" r="3.5" fill="#ba4927"/>
</svg>
'''

CARD = '''<!doctype html>
<html lang="en"><meta charset="utf-8">
<style>
* { box-sizing: border-box; }
html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
body { position: relative; background: #f6f5f1; color: #252620; font-family: Arial, Helvetica, sans-serif; -webkit-font-smoothing: antialiased; }
header { position: absolute; top: 48px; left: 70px; right: 70px; display: flex; justify-content: space-between; align-items: center; padding-bottom: 26px; border-bottom: 1px solid #ddded5; }
.wordmark { font-size: 36px; font-weight: 700; letter-spacing: -2.5px; }
.wordmark span { color: #ba4927; }
.domain { color: #72736a; font-size: 18px; letter-spacing: .2px; }
.copy { position: absolute; top: 182px; left: 70px; z-index: 1; }
h1, p { margin: 0; }
h1 { font-size: 75px; line-height: 1.13; font-weight: 400; letter-spacing: -3.4px; }
.role { margin-top: 13px; color: #84877a; font-size: 60px; line-height: 1.12; font-weight: 400; letter-spacing: -2.6px; }
.portrait { position: absolute; top: 165px; right: 54px; width: 370px; height: 370px; object-fit: contain; }
footer { position: absolute; left: 74px; right: 70px; bottom: 49px; display: flex; align-items: center; gap: 11px; color: #686a60; font-size: 21px; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: #ba4927; }
.network { position: absolute; inset: 0; width: 1200px; height: 630px; }
</style>
<svg class="network" viewBox="0 0 1200 630" fill="none" aria-hidden="true">
  <g stroke="#78856c" stroke-width="1" opacity=".16">
    <path d="M1010 107l130 116-34 232M32 451l96 57 110-37"/>
  </g>
  <g fill="#78856c" opacity=".34">
    <circle cx="1010" cy="107" r="2.5"/><circle cx="1140" cy="223" r="3"/>
    <circle cx="1106" cy="455" r="2.5"/><circle cx="32" cy="451" r="2.5"/>
    <circle cx="128" cy="508" r="3"/><circle cx="238" cy="471" r="2.5"/>
  </g>
</svg>
<header><div class="wordmark">cf<span>.</span></div><div class="domain">cashel.dev</div></header>
<div class="copy"><h1>Hi, I’m Cash.</h1><p class="role">A machine learning<br>engineer.</p></div>
<img class="portrait" src="__PORTRAIT__" alt="Caricature of Cash">
<footer><span class="dot"></span><p>Building Zomma.</p></footer>
</html>
'''


def optimize_png(path):
    with Image.open(path) as image:
        image.save(path, optimize=True)


async def main():
    PUBLIC.mkdir(parents=True, exist_ok=True)
    (PUBLIC / "favicon.svg").write_text(ICON)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, args=["--no-sandbox"])
        page = await browser.new_page(device_scale_factor=1)
        for size, filename in [
            (16, "favicon-16x16.png"),
            (32, "favicon-32x32.png"),
            (180, "apple-touch-icon.png"),
            (192, "android-chrome-192x192.png"),
            (512, "android-chrome-512x512.png"),
        ]:
            await page.set_viewport_size({"width": size, "height": size})
            await page.set_content(
                '<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>'
                + ICON
            )
            target = PUBLIC / filename
            await page.screenshot(path=str(target), omit_background=True)
            optimize_png(target)
        with Image.open(PUBLIC / "android-chrome-512x512.png") as icon:
            icon.save(PUBLIC / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
        portrait = "data:image/png;base64," + base64.b64encode((PUBLIC / "cashel_animated.png").read_bytes()).decode()
        await page.set_viewport_size({"width": 1200, "height": 630})
        await page.set_content(CARD.replace("__PORTRAIT__", portrait))
        await page.evaluate("document.fonts.ready")
        await page.locator(".portrait").evaluate("image => image.decode()")
        target = PUBLIC / "social-card.png"
        await page.screenshot(path=str(target))
        optimize_png(target)
        await browser.close()
    for filename in ["favicon.svg", "favicon.ico", "favicon-16x16.png", "favicon-32x32.png", "apple-touch-icon.png", "android-chrome-192x192.png", "android-chrome-512x512.png", "social-card.png"]:
        target = PUBLIC / filename
        print(f"{target.relative_to(PUBLIC.parent)}: {target.stat().st_size:,} bytes")


if __name__ == "__main__":
    asyncio.run(main())
