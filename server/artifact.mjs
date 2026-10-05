// 制品装配：把交互运行时注入到制品 HTML 里。
//
// 为什么必须注入而不是让 Agent 自己引 <script src>：制品是用 iframe `srcdoc` 内联渲染的，
// `./socratic-runtime.js` 这种相对引用在 srcdoc 里没有可解析的基地址。注入之后 Agent
// 只需要按契约写 `data-interaction` / `data-choice-id`，不必操心脚本从哪来。

import fs from 'node:fs';
import path from 'node:path';
import { WEB_DIR } from './config.mjs';

let cached = null;

function artifactRuntimeSource() {
  if (cached === null) {
    cached = fs.readFileSync(path.join(WEB_DIR, 'socratic-runtime.js'), 'utf8');
  }
  return cached;
}

/**
 * 三处注入共用的落点：<head> 之后，没有 head 就退回 doctype 之后，再没有就文档开头。
 */
function insertAtHeadStart(body, tag) {
  const headOpen = /<head[^>]*>/i.exec(body);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return body.slice(0, at) + '\n' + tag + body.slice(at);
  }
  const docType = /^\s*<!doctype[^>]*>/i.exec(body);
  if (docType) {
    const at = docType.index + docType[0].length;
    return body.slice(0, at) + '\n' + tag + body.slice(at);
  }
  return tag + body;
}

/**
 * 宿主替制品钉死的网络边界。
 *
 * 为什么从"叮嘱"升级成"物理"：硬要求 #3 一直写着不引 CDN、不 fetch，但那只是话；
 * "一个孔"这手开始跑**学习者写的、不经模型审查的**代码，沙盒不给 allow-same-origin
 * 却不拦网络，光靠话就没有 enforcement。
 *
 * 这条字符串是在真实投递路径（sandbox srcdoc）里量过的，不是猜的 ——
 * `node test/preview/csp-probe.mjs`：内联脚本照跑（注入的运行时靠它）、`new Function` 照用
 * （孔要 eval 学习者的代码）、`data:` 图片照收（内嵌素材）；被禁的两条以页面异常的形式露出来
 * （fetch 抛 TypeError、外链图片 decode 失败），两臂对照证明差别只可能来自策略本身。
 * 制品按契约本来就 self-contained，所以对既有制品是纯 no-op（`legacy-artifact-csp.mjs <html>` 量过）。
 */
export const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'";

/** 自己已经写了 CSP meta 的制品不覆盖（尊重显式声明，别叠两条互相打架的策略）。 */
export function injectArtifactCsp(html) {
  const body = String(html ?? '');
  if (/http-equiv\s*=\s*["']?\s*content-security-policy/i.test(body)) return body;
  return insertAtHeadStart(
    body,
    `<meta data-socratic-csp="1" http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`,
  );
}

/**
 * 把运行时注入一份制品 HTML。
 * 已经自己引了 socratic-runtime.js 的不重复注入（避免挂两层监听 —— 运行时有
 * data-wired 幂等标记兜着，但重复注入本身也是浪费）。
 */
export function injectArtifactRuntime(html) {
  const body = String(html ?? '');
  if (/socratic-runtime\.js/i.test(body)) return body;
  const tag = `<script data-socratic-runtime="1">\n${artifactRuntimeSource()}\n</script>\n`;
  return insertAtHeadStart(body, tag);
}

/**
 * 把初始状态注入制品（供 report/getState 续玩读取）。
 * 用 <script type="application/json"> 而不是字符串拼接，避免转义问题。
 */
export function injectInitialState(html, state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return String(html ?? '');
  if (Object.keys(state).length === 0) return String(html ?? '');
  const body = String(html ?? '');
  const tag = `<script type="application/json" id="socratic-initial-state">\n${JSON.stringify(
    state,
  )}\n</script>\n`;
  return insertAtHeadStart(body, tag);
}

/**
 * 制品契约提示：随制品一起告诉 Agent，好让它写对属性、也知道下一轮该读什么。
 * 属性名与 rules/artifact.md §13.1 保持一致——改名就等于毁掉既有页面。
 */
export const ARTIFACT_CONTRACT_NOTE = `
制品交互契约（写 HTML 时按它标注，运行时由宿主自动注入，不要自己写 script 标签引用它）：

【答卷型交互】——适合提问、预测、判断
  容器：  data-interaction='<JSON 配置>'  +  data-interaction-type='choice|predict|compare|toggle|explore|reflection|sequence'
          data-concept-id / data-question-id   把这次交互映射回概念与题目
  选项：  每个选项按钮 data-choice-id="<id>"，id 与配置里 options[].id 对应
  反馈：  .interaction-feedback（运行时写反馈文案）、.interaction-badge（答对时去掉 hidden）
  提示：  [data-hint-action] + .interaction-hint
  其它：  toggle 用 [data-toggle-action]；explore 用 [data-explore-input]/[data-explore-output]；
          reflection 用 [data-reflection-input]+[data-reflection-submit]；
          sequence 用 .sequence-list / .sequence-item[data-sequence-id] / [data-sequence-submit]
  判定口径照抄运行时：只有声明了 correct:true 的选项集才要求答对；没有任何 correct 时选出即完成
  （"参与 ≠ 正确"）；明确答错一律 data-completed='0'。

【项目 / 游戏 / 模拟器】——适合实战项目、关卡挑战、可探索系统
  运行时额外暴露 window.SocraticStudio，四条：
    SocraticStudio.report(state)     上报状态快照（浅合并）。宿主会持久化，下一回合注入给 Agent
    SocraticStudio.emit(name, payload)  上报离散事件，如 'level_cleared' / 'bug_found' / 'run_failed'
    SocraticStudio.getState()        读回当前状态（续玩、重进时用）
    SocraticStudio.onCommand(cb)     订阅 Agent 的下行指令，callback(name, payload)
    SocraticStudio.submit(text)      把制品里做出的产出**交回会话**：宿主把它作为学习者发言
                                     发起一回合，老师当场接着讲。制品里有"汇总 / 生成 / 交给老师"
                                     这类收尾按钮就调它——**不要写"复制到别处即可"**，那等于把
                                     反馈回路丢给学习者手动搬运。
  续玩：share_artifact 可以带 initial_state，运行时启动时用它填充 getState()。
  状态里放客观事实（关卡、尝试次数、当前参数、走过的路径），**不放任何评分**——
  算不算概念错误、算不算掌握，是 Agent 的事。

【讲稿槽】——摊在台面上的那件用；留了它，这一屏就是"画面 + 批注"一张整课
  在这一屏**留一条空带**给老师的讲解，标一个属性就行：
    <div data-narration-slot></div>   放右侧栏、图的下面、两栏之间都行
  三个要求：带子自己要有盒子（量得出宽高，别 display:none、别零高）；带里什么都不要放
  （那些字是宿主落的，你写进去只会被压在下面）；容得下 4–6 行字（约 30–40% 宽 × 200px 高）。
  宿主读不到帧里的 DOM，所以只有你自己报得出坐标——运行时量好这条带，宿主把讲解摆进这里，
  整屏缩放时跟着走。留了带，图、控件、讲解就在同一张画面上；没留或太矮，讲解顺排到你这张
  画面的下面（图和批注就不再是同一屏，学习者要多滚一下）。**两种都不会把讲解搬回消息流**——那条路已经拆了。

【一个孔（建构型）】——程序/技能 与 结构/系统 类内容优先用它，而不是出题
  交一个 20–60 行、**能跑但缺一个关键函数体**的小工具：真实数据 + 真渲染，学习者填的那个孔
  是唯一让它跑起来的东西。它走上面【项目/游戏】那条通道——页面给的是**现象**（Invariant 4 照旧）：
  跑一条用例就把"期望什么、实际得到什么"打在页面上，**不许写"你答错了 / 正确答案是…"**，
  判对错仍然是对话里的事。上报照这个形状写：
    运行 → SocraticStudio.report({ attempts, cases: [{name, expected, actual, ok}], output })
           再 emit('run_failed') / emit('hole_filled')；收尾按钮调 submit(产出) 交回会话。
  四条纪律：
    · **同一个回合里不许把答案也写进正文**——那把"建构"换成了"观看"，学习者只剩围观。
      他填错就让他自己在现象里看见跑不过，下一轮拿 read_artifact_evidence 的 attempts 说话。
    · **≤120 行**。大不等于建构；超了就是你在表演写代码，不是他在学。
    · 用例要**容错**：跑不过必须打出期望值与实际值；静默什么都不发生是最坏的结果。
    · 孔要**真跑**：用 innerText/JSON 喂真实数据，不许做成"填对关键词就变绿"的暗号题。

三条硬要求：
  1. **答完必须有明确的「下一步」**——未作答时就写明继续条件，完成后给「继续 →」入口并说明还有多远。
     学习者做完却不知道下一步该干什么，这个制品就废了（artifact.md §13）。
  2. **不要引入自动播放 / 阻塞式时间轴**：在这份应用里"阻塞式收答"由 ask_user_question
     承担，页面里再放一套门禁会出现两个时钟打架。需要问就问，不要用页面卡住人。
  3. **不引 CDN、不 fetch 外部文件——这条现在由宿主物理拦住**：注入的运行时之前还钉了一条
     CSP（connect-src 'none'，外链图片同禁；内联 script / style、new Function、data: 资源照常可用）。
     所以**不要在制品里许诺任何联网功能**（取天气、拉接口、外部字体），写了也只会是一条控制台报错。
     公式用原生 MathML。动态生成交互块后调一次 window.__socraticStudioWire()。
`.trim();
