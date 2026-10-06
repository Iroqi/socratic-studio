// 契约一致性检查：server/rules/artifact.md §13.1 定义的 data-* 契约，
// 是否与 web/socratic-runtime.js 的真实实现、以及 agent 侧的
// extractQuestionIds / ARTIFACT_CONTRACT_NOTE 一一对得上。
//
// 目的：文档与代码漂移是这类契约最容易坏掉的方式。这条检查把它变成可失败的。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rulesDoc = fs.readFileSync(
  path.join(app, 'server', 'rules', 'artifact.md'), 'utf8');
const runtime = fs.readFileSync(path.join(app, 'web', 'socratic-runtime.js'), 'utf8');
const agentSrc = fs.readFileSync(path.join(app, 'server', 'agent.mjs'), 'utf8');
const artifactSrc = fs.readFileSync(path.join(app, 'server', 'artifact.mjs'), 'utf8');
const pedagogyDoc = fs.readFileSync(path.join(app, 'server', 'rules', 'pedagogy.md'), 'utf8');
const markdownSrc = fs.readFileSync(path.join(app, 'web', 'markdown.js'), 'utf8');
const hostSrc = fs.readFileSync(path.join(app, 'web', 'app.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

// 契约里点名的属性，实现的 DOM 写入/读取里必须都有
const CONTRACT_ATTRS = [
  'data-concept-id',
  'data-question-id',
  'data-interaction-type',
  'data-attempts',
  'data-result',
  'data-response',
  'data-completed',
  'data-locked',
];

/**
 * data-xxx → dataset.xxx 的访问名。
 * 实现侧读的是 dataset 驼峰形式，所以必须先剥掉 data- 前缀再转驼峰。
 */
const datasetKey = (attr) =>
  attr
    .replace(/^data-/, '')
    .replace(/-([a-z])/g, (_, c) => c.toUpperCase());

console.log('\n1. 契约属性：文档有 → 实现有');
for (const attr of CONTRACT_ATTRS) {
  const key = datasetKey(attr);
  const inDoc = rulesDoc.includes(attr);
  const inImpl = runtime.includes(`dataset.${key}`) || runtime.includes(attr);
  check(`${attr} 两边都在`, inDoc && inImpl, `文档=${inDoc} 实现=${inImpl}`);
}

console.log('\n2. 内部选择器契约');
const SELECTORS = [
  '.interaction-feedback',
  '.interaction-badge',
  'data-toggle-action',
  'data-choice-id',
  'data-explore-input',
  'data-explore-output',
  'data-explore-initial',
  'data-reflection-input',
  'data-reflection-submit',
  'sequence-list',
  'sequence-item',
  'data-sequence-submit',
  'data-hint-action',
  'data-interaction',
];
for (const sel of SELECTORS) {
  const inDoc = rulesDoc.includes(sel);
  const key = sel.startsWith('.') ? sel.slice(1) : datasetKey(sel.replace(/^\[/, '').replace(/=["'].*$/, ''));
  const inImpl = runtime.includes(key) || runtime.includes(sel);
  check(`${sel} 两边都在`, inDoc && inImpl, `文档=${inDoc} 实现=${inImpl}`);
}

console.log('\n3. 交互类型枚举一致');
const TYPES = ['choice', 'self_check', 'predict', 'compare', 'toggle', 'explore', 'reflection', 'sequence'];
for (const t of TYPES) {
  const inDoc = rulesDoc.includes(`\`${t}\``) || rulesDoc.includes(t);
  const inImpl = runtime.includes(`'${t}'`) || runtime.includes(t);
  check(`type=${t}`, inDoc && inImpl, `文档=${inDoc} 实现=${inImpl}`);
}

console.log('\n4. 判定口径原文对齐');
check('文档写「明确答错一律 0」', rulesDoc.includes("明确答错一律 `'0'`"));
check('文档写「只有答案被锁定的完成才置位」', rulesDoc.includes('只有答案被锁定的完成才置位'));
check('文档写「不要等 data-locked」', rulesDoc.includes('不要等 `data-locked`'));
check('文档写「不要轮询」', rulesDoc.includes('不要轮询'));
check('文档写「缺 correct_order 拒绝提交」', rulesDoc.includes('必须提供 `correct_order`') || rulesDoc.includes('必须提供'));
check('文档写「无 correct 时选出即完成」', rulesDoc.includes('没有任何选项带 `correct` 字段时，选出即算完成'));
check('实现里 completed 由"非答错"决定', /opts\.correct === false \? '0' : '1'/.test(runtime));
check(
  '实现里 locked 只在答对时写',
  /if \(opts\.correct === true\) \{[\s\S]{0,200}el\.dataset\.locked = '1';/.test(runtime),
);
check('实现有 wired 幂等标记', runtime.includes('dataset.wired'));
// parseConfig 的坏 JSON 策略：捕获 → console.error 指明 → 按无配置继续（不炸页面）
const parseConfigBody = (() => {
  const start = runtime.indexOf('function parseConfig');
  if (start < 0) return '';
  const end = runtime.indexOf('\n  }', runtime.indexOf('return {};', start));
  return runtime.slice(start, end > 0 ? end : start + 600);
})();
check('实现有 parseConfig 且解析失败有 catch', parseConfigBody.includes('JSON.parse') && parseConfigBody.includes('catch'));
check('实现里坏 JSON 走 console.error 并指明是哪个块', parseConfigBody.includes('console.error'));
check('实现里坏 JSON fallback 返回空配置（页面不白屏）', parseConfigBody.includes('return {}'));

console.log('\n5. 项目 / 游戏：通用回报通道');
// 文档必须把通道函数的下行接口写清楚，实现必须真的挂到 window.SocraticStudio 上
const CHANNEL = ['report', 'emit', 'getState', 'onCommand', 'submit'];
for (const name of CHANNEL) {
  const inDoc = new RegExp(`SocraticStudio\\.${name}\\s*\\(`).test(rulesDoc)
    || new RegExp(`${name}\\s*\\(`).test(rulesDoc);
  const inImpl = new RegExp(`${name}\\s*[:(]`).test(runtime);
  check(`SocraticStudio.${name}() 两边都在`, inDoc && inImpl, `文档=${inDoc} 实现=${inImpl}`);
}
check('文档写「state 里只放客观事实」', rulesDoc.includes('客观事实'));
check('文档写「state 里不放评分」', rulesDoc.includes('不放任何评分') || rulesDoc.includes('mastery'));
check('实现里禁止评分字段（且不把任何 ratio/百分比写回 DOM）',
  runtime.includes('score / mastery_percent') && !/dataset\.(score|mastery|percent)\b/i.test(runtime));
check('文档声明 onCommand 在制品关闭后失效', rulesDoc.includes('已关闭') || rulesDoc.includes('关掉'));
check('文档要求宿主必须把消息读回（不读回等于白玩）', rulesDoc.includes('不读回等于白玩'));
check('agent 提示点名 SocraticStudio.report', agentSrc.includes('SocraticStudio.report'));
check('制品契约提示点名 SocraticStudio.submit（产出交回会话）', artifactSrc.includes('SocraticStudio.submit'));
check('文档写「不许写复制到别处即可」', rulesDoc.includes('复制到别处即可'));
check('agent 提示点名 push_artifact_command', agentSrc.includes('push_artifact_command'));
check('share_artifact 支持 initial_state', /initial_state/.test(agentSrc));
check('artifact.mjs 真的注入了 initial_state', /injectInitialState/.test(artifactSrc));
// 曾经的 bug：新加的 emit(name,payload) 覆盖了旧的 emit(el,kind)，证据通道静默失效
check('证据函数已改名 emitEvidence（不再与 emit 撞名）', /function emitEvidence\(/.test(runtime));
check('emit 不再被证据函数占用', !/function emit\(\s*el/.test(runtime));

console.log('\n6. agent 侧契约提示与文档不冲突');
check('agent 提示点名同一批属性', ['data-interaction', 'data-choice-id', 'data-concept-id', 'data-question-id']
  .every((a) => agentSrc.includes(a) && rulesDoc.includes(a)));
check('agent 提示写了"不要引 CDN"', agentSrc.includes('CDN'));
check('文档有对应禁令（CDN）', rulesDoc.includes('CDN'));

console.log('\n7. ```dialogue 对手戏：规则点名 ↔ 宿主渲染器真的认这个围栏');
// 这条是双向的：规则里教了词汇而渲染器不认，模型演了也只是灰底代码块（静默失效）；
// 渲染器认而规则不点名，模型根本不知道该用它（这条功能等于没上线）。两边都必须有。
check('规则里点名 ```dialogue 词汇', pedagogyDoc.includes('```dialogue'), 'pedagogy.md 那句提示被删了');
check('渲染器按围栏语言分流（不是靠内容猜）', /renderScene\(buf\)/.test(markdownSrc)
  && /test\(lang\)/.test(markdownSrc));
// 规则说"至少两个角色"，实现里就得真有一条退路；否则提示写了没人兜
check('规则写「至少两个角色」', pedagogyDoc.includes('至少两个角色'));
check('实现里不足两名角色就不演（退回代码块）', /size < 2\) return null/.test(markdownSrc));
check('退路把围栏语言留在 class 上（原文看得见，不静默吞）', markdownSrc.includes('class="lang-'));

console.log('\n8. 一个孔：给模型的规格 ↔ 宿主真的做到的事');
// 这一节钉的全是"话说在前、代码没跟上"那一类漂移：提示里承诺给学习者的每一条能力，
// 必须能在装配代码或策略字符串里找到实物。
// 按整句/小标题匹配：mutation 测试发现只搜"一个孔"时，删掉整段规范仍绿（注释里也有这三个字）。
check('契约提示点名「一个孔」（按小标题认，注释不算）',
  artifactSrc.includes('【一个孔（建构型）】'));
check('工具描述也点名（模型在选型那一步就看得见这个形状）',
  /还有一种形状是.一个孔/.test(agentSrc));
check('提示说"宿主物理拦住"↔ 装配真的注入 CSP', /injectArtifactCsp\(html\)/.test(agentSrc)
  && /export function injectArtifactCsp/.test(artifactSrc));
check('提示说 CSP 在最后注入（meta 必须在运行时脚本之前）',
  agentSrc.indexOf('injectArtifactCsp(html)') > agentSrc.indexOf('injectArtifactRuntime(args.html)'),
  'execShareArtifact 里的调用顺序变了，策略会管不住注入的运行时');
check('承诺禁网 ↔ 策略里真有 connect-src 阻断', /connect-src 'none'/.test(artifactSrc));
check('承诺内联脚本照跑 ↔ 策略里真有 unsafe-inline', /script-src[^;]*'unsafe-inline'/.test(artifactSrc));
check('承诺孔要能 eval 学习者的代码 ↔ 策略里真有 unsafe-eval', /script-src[^;]*'unsafe-eval'/.test(artifactSrc));
check('承诺 data: 素材可用 ↔ 策略里 img-src 含 data:', /img-src[^;]*data:/.test(artifactSrc));
// 回报通道不许自造：一个孔只能用【项目/游戏】那三条
check('一个孔的回报写成 report({attempts…})（复用既有通道，没有新造词汇）',
  /report\(\{ attempts/.test(artifactSrc) && /emit\('run_failed'/.test(artifactSrc));
check('纪律里钉住"答案不许同回合出现在正文"（作者权那条）',
  artifactSrc.includes('不许把答案也写进正文'));
check('纪律里钉住"页面只给现象、判对错留在对话"（Invariant 4 没被这手撬松）',
  artifactSrc.includes('期望什么、实际得到什么') || artifactSrc.includes('期望值 vs 实际值'));

console.log('\n9. 讲稿槽：作者标的属性 → 帧里量的带 → 宿主落的位（三个文件、三处字符串）');
// 这条链上没有编译期约束，全靠字符串对上：属性名（作者写的 ↔ 运行时量的）、消息 type
// （运行时报的 ↔ 宿主分流的）、字段名（运行时算得出的 ↔ 宿主读得到的）。任一处单独改名都是
// 静默失效——制品留了带、讲解照样落不进带里（顺排到画面下面），页面不报错、没人发现。

/** 取源码里两个记号之间的一段（找不到起点返回空串，让检查红而不是误绿）。 */
function sliceBetween(src, start, end) {
  const a = src.indexOf(start);
  if (a < 0) return '';
  const b = src.indexOf(end, a + start.length);
  return src.slice(a, b > 0 ? b : a + 6000);
}

const measureBody = sliceBetween(runtime, 'function measureSlot', 'function reportSlot');
const hostSlotBody = sliceBetween(hostSrc, 'function slotOf', 'window.addEventListener');
const apiBlock = sliceBetween(runtime, 'var api = {', 'window.__socraticStudioWire');

check('作者标的属性名 = 运行时量的那一个（任何一侧单独改名都红）',
  artifactSrc.includes('data-narration-slot') && measureBody.includes('[data-narration-slot]'),
  `契约提示=${artifactSrc.includes('data-narration-slot')} 运行时=${measureBody.includes('[data-narration-slot]')}`);
check('运行时报的消息 type = 宿主分流的那一个',
  /postToHost\(\{ type: 'slot'/.test(runtime) && /data\.type === 'slot'/.test(hostSrc));
// 少读一个数就是"顶边对了但带子按整屏宽铺开"那一类毛病，所以逐个点名，不查总量
for (const f of ['top', 'left', 'width', 'height', 'docWidth']) {
  const inRuntime = new RegExp(`\\b${f}:`).test(measureBody);
  const inHost = new RegExp(`\\b(band|slot|s)\\.${f}\\b`).test(hostSlotBody);
  check(`带子的读数 ${f}：运行时算得出、宿主读得到`, inRuntime && inHost, `运行时=${inRuntime} 宿主=${inHost}`);
}
check('提示承诺"整屏缩放时跟着走" ↔ 宿主两条缩放分支都重算落点',
  (sliceBetween(hostSrc, 'function fitCanvasFrame', '\n}').match(/applyNarrationSlots\(card\)/g) || []).length === 2,
  'fitCanvasFrame 里少了一支：带子会停在上一条比例上');
check('带子只有"标属性"这一条入口：运行时没把 reportSlot 挂上公开 API',
  !apiBlock.includes('reportSlot'),
  '公开了就得同时改契约提示，否则模型面对两条路（一条写着、一条没写）');

// 载体层次：这件事全走工具层。规则语料的字符预算只剩几十，往里塞一段就把别的规定挤掉了。
check('工具返回值那一层也点名带子（措辞三层里优先级最高的载体不能缺）',
  agentSrc.includes('data-narration-slot'));
check('带子协议没挤进 artifact.md：规则余量一条没花', !rulesDoc.includes('data-narration-slot'));
check('契约提示里带子是一条小标题（跟【一个孔】同一路，扫选型时看得见）',
  artifactSrc.includes('【讲稿槽】'));
check('提示把退路说死：没留 / 太矮就浮着，两种都不回消息流',
  artifactSrc.includes('两种都不会把讲解搬回消息流'));

console.log('\n10. 转场条：服务端那句「承台」↔ 画面上那颗可点的键');
// 跨段延续在服务端早就有了（openScene 克隆 props + 记 inheritedFrom），缺的是读者。
// 这一刀两头各说一句：快照对模型说"这几件是接过来的、点开才看得见"，画面对学习者真给一个可点的入口。
// 两头都靠字符串认，谁单独改词都会把对方留在原地，所以钉在同一本账（inheritedFrom）和同一批字面上。
const sceneSrc = fs.readFileSync(path.join(app, 'server', 'scene.mjs'), 'utf8');
const carryBody = sliceBetween(hostSrc, 'function carriedProps', 'function jumpToCarried');
const jumpBody = sliceBetween(hostSrc, 'function jumpToCarried', 'function renderSceneCut(');
const cutBody = sliceBetween(hostSrc, 'function renderSceneCut(', 'function renderSceneCuts');
check('承台判据两侧同名（inheritedFrom）：一边改名，另一边就永远"没东西可接"（静默失效，不报错）',
  sceneSrc.includes('inheritedFrom') && carryBody.includes('inheritedFrom'),
  `服务端=${sceneSrc.includes('inheritedFrom')} 宿主=${carryBody.includes('inheritedFrom')}`);
check('宿主认的是那本账不是画面（不许从 DOM 反查"台上有几件"）',
  /state\.notebook|sceneOfId/.test(carryBody) && !/querySelector|children/.test(carryBody), carryBody.slice(0, 200));
check('快照里那句和画面上的东西同名：整句从字符串字面量里认（注释里也写着"转场条"，认三个字会假绿）',
  /一行转场条——要点开那一场才看得见/.test(sceneSrc) && cutBody.includes("'scene-cut'"),
  sceneSrc.split('\n').filter((l) => l.includes('转场条')).join(' | ').slice(0, 200));
check('快照承诺"点开那一场才看得见" ↔ 那颗键真把镜头交给 A-2 那只手（watchBeat），不自造滚动',
  sceneSrc.includes('点开那一场') && /watchBeat\(beat\)/.test(jumpBody)
  && !/scrollIntoView|scrollTop =/.test(jumpBody), jumpBody.slice(0, 240));
check('先摊开那一幕、再钉住那一拍（顺序反了 watchBeat 会当场松开，点了等于没点）',
  jumpBody.indexOf('openScenes.add') > -1 && jumpBody.indexOf('openScenes.add') < jumpBody.indexOf('applyCollapse')
  && jumpBody.indexOf('applyCollapse') < jumpBody.indexOf('watchBeat'), jumpBody.slice(0, 240));
check('转场条不写"几件"这种数（可见面上不许多出一个数，和快照那条同规矩）',
  !/props\.length/.test(cutBody) && !/[0-9]\s*件/.test(cutBody), cutBody.slice(0, 200));

console.log('\n11. 道具的地址：台账那一份 ↔ 消息里那一份（刷新不许收回「扔掉」）');
// 服务端发两份不同形状：SSE 那件带 rel，落进 chat.json 的那件不带（agent.mjs 的 roundArtifacts）。
// 于是刷新回放出来的道具没有 rel → 卡片头上那两颗键（新窗口打开 / 扔掉）一起消失，
// 1b 那个手势只剩实播那一次。这是活模型探针在真浏览器里抓到的，不是推演。
// 补的一侧读台账（notebook.artifacts），不猜路径；台账没行的旧内联制品仍旧不给按钮。
const hydrateBody = sliceBetween(hostSrc, 'function hydrateArtifact', 'function pushArtifact');
const pushLine = (hostSrc.match(/for \(const a of msg\.artifacts[^\n]*/g) || []).join('\n');
check('补的来源是台账那本账（state.notebook.artifacts），不是拼出来的路径',
  /state\.notebook\?\.artifacts/.test(hydrateBody) && !/`artifacts\/\$\{/.test(hydrateBody),
  hydrateBody.replace(/\s+/g, ' ').slice(0, 200));
check('只补 rel 这一个键，且消息里带了就不动（不许顺手盖掉 SSE 那份的任何字段）',
  /if \(!a\?\.id \|\| a\.rel\) return a;/.test(hydrateBody) && /\{ \.\.\.a, rel: row\.rel \}/.test(hydrateBody)
  && !/title:|kind:/.test(hydrateBody), hydrateBody.replace(/\s+/g, ' ').slice(0, 200));
check('回放那一圈真的过了一遍补地址（写了函数却没人调 = 缺陷还在线上）',
  /pushArtifact\(hydrateArtifact\(a\)/.test(pushLine), pushLine.slice(0, 160));
check('根因这一侧仍然成立：落盘那份不带 rel、SSE 那份带（哪天服务端补上了，宿主这一步就该撤）',
  !/rel/.test(sliceBetween(agentSrc, 'this.roundArtifacts.push(', 'this.emit({'))
  && /rel: stored\.rel/.test(sliceBetween(agentSrc, "type: 'artifact',", 'return {')),
  sliceBetween(agentSrc, 'this.roundArtifacts.push(', 'this.emit({').replace(/\s+/g, ' ').slice(0, 160));

console.log('\n12. 旁白浮不浮：一条判据（JS）↔ 顺排是默认档（CSS）');
// 两件事故叠在这一层上：
// ① markStagedProps 的设计是"换件不搬家"——不再摊开的那件保留身上已贴的旁白。可 `.stage-notes`
//    以前是 position:absolute，立足点只有 `.artifact.staged` 那一条：一摘摊开整层就改挂 BODY。
//    真浏览器实测（活模型会话 topic-42r-964c7b）293 字讲稿被钉在整页右上角（视口 y=52→292）盖页头。
// ② 没留讲稿带的那件退到"角落层"，实测 213 字讲稿盖掉自己画面的 31.3%——那块地方本来是制品画东西用的。
// 两条合起来的修法：顺排是默认档（CSS 底座 static），浮着只有制品自己报了带才发生（JS 挂内联 absolute）。
const cssSrc = fs.readFileSync(path.join(app, 'web', 'styles.css'), 'utf8');
const flowBody = sliceBetween(hostSrc, 'function narrationFlows', 'function applyNarrationSlots');
const slotBody = sliceBetween(hostSrc, 'function applyNarrationSlots', 'function rememberNarrationSlot');
const fitBody = sliceBetween(hostSrc, 'function fitCanvasFrame', '\n}');
const stageBody = sliceBetween(hostSrc, 'function markStagedProps', 'function adoptBeatProse');
check('CSS 的底座是顺排（浮起来完全由 JS 那几条内联给，撤了就回到画面下面）',
  /^\.stage-notes \{[^}]*position: static/m.test(cssSrc) && !/^\.stage-notes \{[^}]*position: absolute/m.test(cssSrc),
  (/^\.stage-notes \{([^}]*)\}/m.exec(cssSrc)?.[1] || '（CSS 里没这条）').replace(/\s+/g, ' ').trim().slice(0, 160));
check('浮起来这个动作只由带子点（position 在那份要清空的账里，也在落进带里那一条上）',
  /const SLOT_PROPS = \['position'/.test(hostSrc) && /layer\.style\.position = 'absolute'/.test(slotBody),
  hostSrc.includes("'position'") ? '源码实测' : 'SLOT_PROPS 里没有 position');
check('判据只有一份：fitCanvasFrame 与 applyNarrationSlots 都问 narrationFlows（两处各写一遍迟早算出两个答案）',
  /narrationFlows\(card, k\)/.test(fitBody) && /narrationFlows\(card, k\)/.test(slotBody)
  && (hostSrc.match(/function narrationFlows/g) || []).length === 1,
  `fit=${/narrationFlows/.test(fitBody)} slot=${/narrationFlows/.test(slotBody)}`);
check('四条退路都在这份判据里（少一条就有一档重新盖在画面上）：没带 / 窄屏 / 没摊开 / 带太矮',
  /if \(!band\) return true/.test(flowBody) && flowBody.includes('STAGE_NARROW_QUERY')
  && /contains\('staged'\)/.test(flowBody) && /CANVAS_SLOT_MIN_BAND_PX/.test(flowBody),
  flowBody.replace(/\s+/g, ' ').slice(0, 200));
check('JS 与 CSS 认的是同一个类名（改名任何一头都会把另一头留在原地：这层又会挂到 BODY 上）',
  hostSrc.includes("'stage-notes'") && cssSrc.includes('.stage-notes') && cssSrc.includes('.artifact.staged')
  && flowBody.includes("'staged'"), `css=.artifact.staged / js=${/contains\('staged'\)/.test(flowBody)}`);
// 顺排能落在画面下沿，靠的是收掉缩放空档那一手：以前卡片按视觉高裁一刀，顺排的旁白排在帧的
// 布局盒底下，连裁掉的区域一起看不见（窄屏那一档就是这条静默失效了好几天）。
check('缩放中的帧用负 margin 收空档，不再裁卡片高度（裁的那一刀会把顺排的旁白裁在卡片外面）',
  fitBody.includes("frame.style.marginBottom = `${-Math.round(natural * (1 - k))}px`;")
  && /card\.style\.height = '';/.test(fitBody),
  fitBody.replace(/\s+/g, ' ').slice(-160));
check('顺排时可视区先扣掉旁白那一截（"一屏看全"包括讲它的那段话）',
  /narrationFlows\(card, k\)\) k = scaleFor\(avail - \(stageNotesOf\(card\)\?\.offsetHeight \|\| 0\)\)/.test(fitBody),
  fitBody.replace(/\s+/g, ' ').slice(0, 220));
check('摘掉摊开不许顺手把讲稿删了（服务端说过的话，落哪儿都不能消失）',
  !/releaseStageNotes\(/.test(stageBody), stageBody.replace(/\s+/g, ' ').slice(0, 200));

// ──────────────────────────────────────────────── README 排查命令的 API 路由守护
//
// README「排查"卡住不回话"」手写了一条 curl 排查流程，README 自己承认过这段债务：
// "这三条 curl 里的路由和字段名是抄现在的 serve.mjs，没有测试盯着它们——改了路由，
// 这段文档就静默过期，下次排查的人照抄会 404"。这一节让 README 里出现的每一个
// /api/ 引用都有 serve.mjs 里的真实路由兜底——文档与代码不许漂移（跟 artifact.md
// 契约同一句口号），排查照抄不会 404。

const readmeDoc = fs.readFileSync(path.join(app, 'README.md'), 'utf8');
const serveSrc = fs.readFileSync(path.join(app, 'server', 'serve.mjs'), 'utf8');

// 参数段统一写成 :id：README 里 $ID / <id> / <nb> / <制品id> / <任意串> / :noteId，
// serve.mjs 正则里 ([^/]+) / (.+)，是同一个东西在不同文档里的写法。
// 注意 ([^/]+) 这类段**里面含 /（字符类里的斜杠）**，所以不能先 split('/') 再归一，
// 只能整串替换。
function normalizeRouteTemplate(p) {
  let t = p.replace(/\?.*$/, ''); // 查询串不是路由的一部分（/api/health/corrupt?path=<rel>）
  t = t.replace(/<[^/]*>|\$[A-Za-z0-9]+|:[A-Za-z0-9]+|\([^)]+\)/g, ':id');
  t = t.replace(/\\\//g, '/'); // serve 正则的转义斜杠（\/）摊平
  return t.replace(/\/+$/, ''); // 末尾斜杠（`GET /api/notebooks 里有` 那种）不算数
}

// serve.mjs 路由清单：字面路径（pathname === '/api/...'）＋ 正则路径（/^\/api\/...$/）。
// 正则的 (…)+ 捕获段就是参数位，跟 README 的 <…> 一样按位置对位。
function serveRoutes(src) {
  const routes = new Set();
  for (const m of src.matchAll(/pathname === '(\/api\/[^']+)' && method === '[A-Z]+'/g)) {
    routes.add(normalizeRouteTemplate(m[1]));
  }
  for (const m of src.matchAll(/\^\\\/api\\\/(.+?)\$\/\.exec\(pathname\)/g)) {
    const raw = m[1].replace(/\\\//g, '/');
    routes.add(normalizeRouteTemplate(`/api/${raw}`));
  }
  return routes;
}

const routeSet = serveRoutes(serveSrc);
const seen = new Set();
let readmeApiRefs = 0;
for (const m of readmeDoc.matchAll(/\/api\/[^\s"'，。；）】、`]+/g)) {
  const ref = m[0];
  const tpl = normalizeRouteTemplate(ref);
  if (seen.has(tpl)) continue; // 同一个路径在 README 里出现多次（导出/制品各讲一遍）只钉一次
  seen.add(tpl);
  readmeApiRefs += 1;
  check(`README 里写到的 ${ref} 在 serve.mjs 有真路由（排查照抄不 404）`,
    routeSet.has(tpl), `模板 ${tpl} 不在 serve.mjs 路由清单里`);
}
check(`README 排查命令的 /api/ 引用有测试盯着（不再"改了路由文档静默过期"）`,
  readmeApiRefs >= 20, `只找到 ${readmeApiRefs} 处 /api/ 引用，排查节的那几条应该在`);

console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exitCode = failed === 0 ? 0 : 1;
