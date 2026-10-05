"""Measure the rendered geometry of the real stage (web/index.html) in headless Edge.

img-input 不可用时，用真实渲染出来的度量替代肉眼看图：把每个关键区块的实际高度、
是否溢出视口、输入框在不在视口内导出来，断言"不挤、不溢出、当页可见"。

以前量的是 build-*-mock.py 拼出来的静态假页面——假页面会和真页面漂移，
量出来的通过不算数。现在直接量 web/index.html，只在探测脚本里把要看的页签切过去、
往会话流里塞一道样题（题目就落在讲解下面，不再另开一块坞），其余全是线上那套 HTML/CSS/JS。
"""
import json
import pathlib
import re
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
WEB = HERE.parent.parent / "web"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

# 探测前先布置好这一页：切到目标页签，会话流里放一道样题（只有会话页需要）
SETUP = r"""
const want = '__PAGE__';
for (const key of ['chat', 'notes', 'canvas']) {
  const pane = document.getElementById('stage-' + key);
  if (!pane) continue;
  pane.classList.toggle('hidden', key !== want);
  const btn = document.getElementById('tab-' + key);
  if (btn) { btn.classList.toggle('active', key === want); btn.setAttribute('aria-selected', String(key === want)); }
}
if (want === 'chat') {
  const inner = document.getElementById('chatInner');
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
}
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
    return { h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom), scrollH: n.scrollHeight };
  };
  const out = {
    page: '__PAGE__',
    viewport: innerHeight,
    bodyScroll: document.body.scrollHeight,
    stageBody: box('.stage-body'),
    tabs: box('.stage-tabs'),
    composer: box('.composer-wrap'),
    thread: box('#stage-' + '__PAGE__' + ' .thread'),
    ask: box('#stage-' + '__PAGE__' + ' .thread .ask-card'),
    paneVisible: !document.getElementById('stage-' + '__PAGE__').classList.contains('hidden'),
    rail: box('.rail'),
  };
  const pre = document.createElement('pre');
  pre.id = 'layout-probe';
  pre.textContent = 'PROBE' + JSON.stringify(out) + 'PROBE';
  document.body.append(pre);
})();
</script>
"""


def measure(page: str):
    html = (WEB / "index.html").read_text(encoding="utf-8")
    probe = PROBE.replace("__SETUP__", SETUP.replace("__PAGE__", page)).replace("__PAGE__", page)
    # 临时副本里没有 styles.css（相对路径会指到临时目录，CSS 静默失效、量出来全是块级流），
    # 所以把真 CSS 内联进来；app.js 也摘掉——量几何不需要它跑通，接口在 file:// 下必然失败。
    html = re.sub(r'<script type="module"[^>]*src="/?app\.js"[^>]*></script>', "", html)
    css = (WEB / "styles.css").read_text(encoding="utf-8")
    html = re.sub(r'<link rel="stylesheet"[^>]*href="/?styles\.css"[^>]*/?>', lambda _: f"<style>{css}</style>", html)
    html = html.replace("</body>", probe + "</body>")
    tmp = pathlib.Path(tempfile.mkdtemp()) / f"probe-{page}.html"
    tmp.write_text(html, encoding="utf-8")
    r = subprocess.run(
        [
            EDGE, "--headless=new", "--disable-gpu", "--no-sandbox",
            "--disable-crashpad", "--disable-crash-reporter",
            "--hide-scrollbars", "--no-first-run",
            f"--user-data-dir={tempfile.mkdtemp()}",
            "--window-size=1912,920",
            "--virtual-time-budget=2000",
            "--dump-dom",
            tmp.as_uri(),
        ],
        capture_output=True, timeout=60, encoding="utf-8", errors="replace",
    )
    if r.returncode != 0:
        return None, (r.stderr or r.stdout)[:400]
    m = re.search(r"PROBE(\{.*?\})PROBE", r.stdout, re.S)
    if not m:
        return None, "no probe in dom"
    return json.loads(m.group(1)), None


def main():
    pages = sys.argv[1:] or ["chat", "notes", "canvas"]
    failures = 0
    for page in pages:
        data, err = measure(page)
        if not data:
            print(f"[{page}] FAIL 量不到：{err}")
            return 1
        ok = True
        notes = []

        # 1) 页面总高度不许超过视口（不出现第二屏）
        if data["bodyScroll"] > data["viewport"] + 1:
            ok = False
            notes.append(f"整体溢出视口 {data['bodyScroll']}>{data['viewport']}")
        # 2) 输入框必须在视口内可见
        comp = data.get("composer")
        if not comp:
            ok = False
            notes.append("找不到输入框")
        elif comp["top"] + comp["h"] > data["viewport"] + 1:
            ok = False
            notes.append(f"输入框被推出视口 top+{comp['top']}+{comp['h']}>{data['viewport']}")
        # 3) 舞台区要有足够高度（不挤成一条缝）
        sb = data.get("stageBody") or {}
        if sb.get("h", 0) < 400:
            ok = False
            notes.append(f"舞台区太矮 {sb.get('h')}px")
        # 4) 当页必须可见
        if not data.get("paneVisible"):
            ok = False
            notes.append("当页没显示")
        # 5) 会话页：题就在讲解流里（作答控件长在题面上），且不许被正文挤没
        ask, thread = data.get("ask"), data.get("thread")
        if page == "chat":
            if not ask:
                ok = False
                notes.append("会话流里找不到那道题（作答控件该长在流里）")
            elif thread and thread["h"] < 240:
                ok = False
                notes.append(f"讲解流只剩 {thread['h']}px")
            elif ask["h"] < 120:
                ok = False
                notes.append(f"题面被压成 {ask['h']}px")
        # 正文区高度是量出来的，别只断言下限——顺手打印出来，肉眼复核用
        print(f"[{page}] {'PASS' if ok else 'FAIL'} viewport={data['viewport']} stage={sb.get('h')} "
              f"thread={(thread or {}).get('h')} ask={(ask or {}).get('h')} "
              f"composer_top={(comp or {}).get('top')} tabs={(data.get('tabs') or {}).get('h')}")
        for n in notes:
            print(f"       - {n}")
        if not ok:
            failures += 1
    return failures


if __name__ == "__main__":
    raise SystemExit(1 if main() else 0)
