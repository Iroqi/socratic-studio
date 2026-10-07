"""Measure the rendered geometry of the real stage (web/index.html) in a headless browser.

img-input 不可用时，用真实渲染出来的度量替代肉眼看图：把每个关键区块的实际高度、
是否纵向/横向溢出视口、输入框在不在视口内导出来，断言"不挤、不溢出、题长在流里"。

以前量的是 build-*-mock.py 拼出来的静态假页面——假页面会和真页面漂移，
量出来的通过不算数。现在直接量 web/index.html：摘掉 app.js、内联真 styles.css，
只在探测脚本里往会话流（#deskStream / #deskInner）塞一道样题，其余全是线上那套 HTML/CSS/JS。

浏览器发现与 test/preview/browser.mjs 同一套顺序（BROWSER_PATH / EDGE_PATH → 平台已知安装位 →
PATH 轮询），不写死某台机器的安装路径；这里是 Python 侧的对应实现。
跑法：python3 test/preview/measure-layout.py [1912x920 900x800 ...]
"""
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
WEB = HERE.parent.parent / "web"

# 浏览器不再写死一台机器的安装路径（第十七轮）。以前这里是
# C:\Program Files (x86)\Microsoft\Edge\...\msedge.exe：换到 Linux / macOS 就整条量不到，
# 而且失败得很难读——脚本只会说"量不到"，不说为什么。现在按
# BROWSER_PATH / EDGE_PATH → 平台已知安装位 → PATH 轮询 的顺序发现。
WINDOWS_EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]
MACOS_CANDIDATES = [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
]
PATH_NAMES = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
              "microsoft-edge", "microsoft-edge-stable", "msedge", "brave-browser"]


def find_browser():
    forced = os.environ.get("BROWSER_PATH") or os.environ.get("EDGE_PATH")
    if forced:
        if os.path.isfile(forced) and os.access(forced, os.X_OK):
            return forced
        print(f"⚠ BROWSER_PATH/EDGE_PATH 指的路径不可用：{forced}，改用自动发现")
    if os.name == "nt":
        known = WINDOWS_EDGE_CANDIDATES
    elif sys.platform == "darwin":
        known = MACOS_CANDIDATES
    else:
        known = []
    for p in known:
        if os.path.isfile(p):
            return p
    for name in PATH_NAMES:
        found = shutil.which(name)
        if found:
            return found
    return None


BROWSER = find_browser()
if not BROWSER:
    print("找不到可用的浏览器（chromium / chrome / edge 都不在 PATH 或已知安装位置）。")
    print("用 BROWSER_PATH 指路，例如：BROWSER_PATH=/usr/bin/chromium python3 test/preview/measure-layout.py")
    raise SystemExit(2)

# 容器里 /dev/shm 常常只有 64MB（实测：不加这条 chromium 跑几次就崩，还会留下吃 shm 的僵尸进程）。
# --no-sandbox 只在 root 下加：普通机器上浏览器沙箱是安全边界，不该替所有人拆掉。
BASE_ARGS = ["--headless=new", "--disable-gpu", "--disable-dev-shm-usage",
             "--disable-crashpad", "--disable-crash-reporter", "--no-first-run"]
if hasattr(os, "getuid") and os.getuid() == 0:
    BASE_ARGS.append("--no-sandbox")

# 单次浏览器调用给多少秒（可用 BROWSER_TIMEOUT 覆盖）。
BROWSER_TIMEOUT = float(os.environ.get("BROWSER_TIMEOUT", "60"))


# 探测前先布置好这一页：会话流里放一道样题。
# ⚠ 第十七轮重修过这一整段。改版前这里切的是 stage-chat / stage-notes / stage-canvas 三个页签，
# 会话流叫 #chatInner——这些 id 在「会话单列」改版后**全都不存在了**（现在只有 #deskStream
# 一条流 + #deskInner 内层）。后果不是报错而是静默失效：document.getElementById(...) 返回 null，
# 注入的脚本第一行就抛，dump 里连探针都长不出来。当时按"dump 里搜得到标记字样"判"跑过了"，
# 命中的其实是注入进 body 的那段**源码本身**——一条假绿在文档里挂了好久。现在标记由两段拼成
# （只有真执行才凑得出），而且断言的 id / 类名全部对着今天的 web/index.html 抄，指错就红。
SETUP = r"""
const inner = document.getElementById('deskInner');
if (!inner) throw new Error('探针失效：#deskInner 不在了（改版了，去对 web/index.html）');
const turn = document.createElement('div');
turn.className = 'msg msg-teacher';
turn.innerHTML = '<div class="prose"><p>先把这块拆成两个概念：作用域、闭包。讲完这一段才出那道题。</p></div>';
inner.append(turn);
// 题就长在正文下面：作答控件是题面的一部分，不是另一块面板
const card = document.createElement('div');
card.className = 'ask-card';
card.innerHTML = '<div class="ask-header">探针</div>' +
  '<div class="ask-question">外层函数 return 之后，里层还能读到它当时的变量吗？' +
  '再补一句稍微长一点的说明，让这道题真的需要一点高度才能看全，顺便把作答组件也画出来。</div>' +
  '<div class="ask-options"><button class="ask-option single"><span class="mark">✓</span><span class="label">能读到</span></button>' +
  '<button class="ask-option single"><span class="mark">✓</span><span class="label">读不到</span></button></div>' +
  '<textarea class="ask-textarea" placeholder="补充你的理由…"></textarea>' +
  '<div class="ask-actions"><button class="btn btn-primary">提交</button></div>';
inner.append(card);
"""

# 同步量，别等帧：--dump-dom 在 headless 里根本不发 rAF 回调（试过 load / DOMContentLoaded /
# 直接调用，注入的 <pre> 一次都没进 dump）。几何不依赖帧，getBoundingClientRect 自己会强制布局。
PROBE = r"""
<script>
(function () {
__SETUP__
  const box = (sel) => {
    const n = document.querySelector(sel);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { h: Math.round(r.height), w: Math.round(r.width), top: Math.round(r.top), bottom: Math.round(r.bottom), scrollH: n.scrollHeight };
  };
  const out = {
    viewport: innerHeight,
    bodyScroll: document.body.scrollHeight,
    // 横向溢出以前没量：窄屏抽屉一开、右栏一浮，页面就能左右晃，肉眼在无头里看不出来
    docWidth: document.documentElement.scrollWidth,
    rail: box('.rail'),
    stage: box('.stage'),
    thread: box('#deskStream'),
    ask: box('#deskStream .ask-card'),
    composer: box('.composer-wrap'),
    composerInput: box('.composer textarea'),
    panel: box('.panel'),
    tabsBar: box('.stage-bar'),
  };
  const pre = document.createElement('pre');
  pre.id = 'layout-probe';
  // 标记分两段拼出来：注入的源码里永远不许出现"完整的标记字样"。以前这里直接把标记写成
  // 两个字面量夹住 JSON，而 --dump-dom 会把这段**源码本身**一并吐出来，于是"在 dump 里
  // grep 到标记"根本证明不了脚本真跑过——这条臂就是这样静默失效好几天没人发现。
  // 现在标记由两段拼成，只有真执行才凑得出来；注释里也不许出现拼好的标记。
  const M = 'PR' + 'OBE';
  pre.textContent = M + '#' + JSON.stringify(out) + M + '#';
  document.body.append(pre);
})();
</script>
"""


def measure(width: int, height: int):
    html = (WEB / "index.html").read_text(encoding="utf-8")
    probe = PROBE.replace("__SETUP__", SETUP)
    # 临时副本里没有 styles.css（相对路径会指到临时目录，CSS 静默失效、量出来全是块级流），
    # 所以把真 CSS 内联进来；app.js 也摘掉——量几何不需要它跑通，接口在 file:// 下必然失败。
    html = re.sub(r'<script type="module"[^>]*src="/?app\.js"[^>]*></script>', "", html)
    css = (WEB / "styles.css").read_text(encoding="utf-8")
    html = re.sub(r'<link rel="stylesheet"[^>]*href="/?styles\.css"[^>]*/?>', lambda _: f"<style>{css}</style>", html)
    html = html.replace("</body>", probe + "</body>")
    tmp = pathlib.Path(tempfile.mkdtemp()) / f"probe-{width}.html"
    tmp.write_text(html, encoding="utf-8")
    args = [
        BROWSER, *BASE_ARGS,
        "--hide-scrollbars",
        f"--window-size={width},{height}",
        "--virtual-time-budget=2000",
        "--dump-dom",
        tmp.as_uri(),
    ]

    def run(extra):
        return subprocess.run(
            args + extra,
            capture_output=True, timeout=BROWSER_TIMEOUT, encoding="utf-8", errors="replace",
        )

    # 本沙箱实测（第十七轮）：--user-data-dir 指一份**新**目录时，headless 首启挂在网络组件
    # 初始化上，几十秒不返回；不给这个参数时同一页面 0.4–0.7 秒就 dump 完。所以先按常规走
    # 一份独立 profile（普通机器上这样不污染用户配置），超时了就退回"不带 profile"再试一次，
    # 而不是把整条量几何的臂判死。两次都不回来才叫量不到。
    profile = pathlib.Path(tempfile.mkdtemp())
    try:
        r = run([f"--user-data-dir={profile}"])
    except subprocess.TimeoutExpired:
        print(f"[{width}] ⚠ 独立 profile 起不来（容器里常见），退回默认 profile 重试")
        try:
            r = run([])
        except subprocess.TimeoutExpired:
            return None, f"浏览器两次都不答话（{BROWSER_TIMEOUT}s ×2）"
    finally:
        shutil.rmtree(profile, ignore_errors=True)
        tmp.unlink(missing_ok=True)
    if r.returncode != 0:
        return None, (r.stderr or r.stdout)[:400]
    # 只认"拼出来才凑得出"的读数标记：源码里的字面量永远凑不出它，抓到就证明脚本真跑过。
    m = re.search(r"PROBE#(\{.*?\})PROBE#", r.stdout, re.S)
    if not m:
        return None, "dom 里没有探针读数（脚本没跑成，或页面里的 id 变了——别再当量过了）"
    return json.loads(m.group(1)), None


# 四档窗口宽，跟 README 那批观感实测同一口径（宽→窄：桌面 / 常见笔记本 / 右栏浮层档 / 抽屉档）
WIDTHS = [(1912, 920), (1440, 1000), (1180, 900), (900, 800)]


def main():
    argv = sys.argv[1:]
    widths = [(int(w), int(h)) for w, h in (a.split("x") for a in argv)] if argv else WIDTHS
    failures = 0
    for width, height in widths:
        data, err = measure(width, height)
        if not data:
            print(f"[{width}x{height}] FAIL 量不到：{err}")
            return 1
        ok = True
        notes = []

        # 1) 页面总高度不许超过视口（不出现第二屏）
        if data["bodyScroll"] > data["viewport"] + 1:
            ok = False
            notes.append(f"整体溢出视口 {data['bodyScroll']}>{data['viewport']}")
        # 2) 不许横向溢出（窄屏抽屉一开就能左右晃，这一条以前根本没量）
        if data.get("docWidth", 0) > width + 1:
            ok = False
            notes.append(f"横向溢出 {data['docWidth']}>{width}")
        # 3) 输入框必须在视口内可见
        comp = data.get("composer")
        if not comp:
            ok = False
            notes.append("找不到输入框那一截（.composer-wrap 不在了？）")
        elif comp["top"] + comp["h"] > data["viewport"] + 1:
            ok = False
            notes.append(f"输入框被推出视口 top+{comp['top']}+{comp['h']}>{data['viewport']}")
        # 4) 会话流要有足够高度（不挤成一条缝）
        thread = data.get("thread") or {}
        if thread.get("h", 0) < 240:
            ok = False
            notes.append(f"讲解流只剩 {thread.get('h')}px")
        # 5) 题就在讲解流里（作答控件长在题面上），且不许被正文挤没
        ask = data.get("ask")
        if not ask:
            ok = False
            notes.append("会话流里找不到那道题（#deskStream .ask-card 选不到）")
        elif ask["h"] < 120:
            ok = False
            notes.append(f"题面被压成 {ask['h']}px")
        # 读数全部打印出来，肉眼复核用——PASS 不等于看过
        print(f"[{width}x{height}] {'PASS' if ok else 'FAIL'} viewport={data['viewport']} "
              f"docWidth={data.get('docWidth')} thread={(thread or {}).get('h')} "
              f"ask={(ask or {}).get('h')} composer_top={(comp or {}).get('top')} "
              f"rail={(data.get('rail') or {}).get('w')} panel={(data.get('panel') or {}).get('w')}")
        for n in notes:
            print(f"       - {n}")
        if not ok:
            failures += 1
    return failures


if __name__ == "__main__":
    raise SystemExit(1 if main() else 0)
