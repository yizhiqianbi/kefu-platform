"""本机的无界面浏览器（Playwright Chromium），给没有可用接口的个人号用：Messenger 登录、TikTok 私信。

每个号一个独立的浏览器资料目录（data/personal/{id}/ 下，700），cookie 只在这台机器上。
平台都经 PERSONAL_PROXY 访问；浏览器标识固定成 Linux 上的普通 Chrome，和本机内核版本一致。
"""
import asyncio
import base64
from urllib.parse import urlparse

import settings

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"

_pw = None
_lock = asyncio.Lock()


class BrowserError(RuntimeError):
    pass


async def playwright():
    global _pw
    async with _lock:
        if _pw is None:
            try:
                from playwright.async_api import async_playwright
            except ImportError as e:
                raise BrowserError("要先装 playwright：pip install playwright && playwright install chromium") from e
            _pw = await async_playwright().start()
        return _pw


def _proxy():
    url = settings.PERSONAL_PROXY
    if not url:
        return None
    u = urlparse(url)
    p = {"server": f"{u.scheme or 'http'}://{u.hostname}:{u.port or 80}"}
    if u.username:
        p.update(username=u.username, password=u.password or "")
    return p


async def open_profile(user_dir):
    """A persistent browser profile; close the returned context when done."""
    p = await playwright()
    user_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        ctx = await p.chromium.launch_persistent_context(
            str(user_dir), headless=True, channel="chromium", proxy=_proxy(), user_agent=USER_AGENT, locale="en-US",
            viewport={"width": 1280, "height": 860}, args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
    except Exception as e:  # noqa: BLE001 - missing binary, locked profile, ...
        raise BrowserError(f"浏览器起不来：{str(e)[:200]}") from e
    ctx.set_default_timeout(30000)
    return ctx


async def page_of(ctx):
    return ctx.pages[0] if ctx.pages else await ctx.new_page()


async def shot(target, photo=False):
    """Data URL of an element (PNG, sharp enough to scan a QR code) or, with photo=True, of a whole page as a small JPEG,
    for showing the user what the platform is asking."""
    if photo:
        return "data:image/jpeg;base64," + base64.b64encode(await target.screenshot(type="jpeg", quality=55)).decode()
    return "data:image/png;base64," + base64.b64encode(await target.screenshot(type="png")).decode()
