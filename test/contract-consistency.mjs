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

// ──────────────────────────────────────────────── 两份本地墙钟格式化不许漂移
//
// 同一个"年-月-日 时:分"在两个文件里各写了一遍：server/store.mjs 的 fmtDateTime
// （导出 Markdown 的拍号时间、"导出于"那行）与 web/app.js 的 formatTime
// （会话流分隔线的时间戳、笔记"你改过 · 时间"、判定记录那行时间）。
// 两边都用本地 getter（本机工具渲本地墙钟是对的），但没有任何钉子说它们必须一致——
// 改其中一份（换个分隔符、少个补零、或"顺手改成 UTC"），同一件事在页面上和导出里
// 就是两个时间，而没人会当场发现。这一节把"必须逐字符同格式"变成可失败的。
const storeSrc = fs.readFileSync(path.join(app, 'server', 'store.mjs'), 'utf8');

/**
 * 取出一个格式化函数的"模板"：把补零助手的名字归一掉（一份叫 p、一份叫 pad），
 * 只留结构本身。这样改分隔符、改字段顺序、丢补零、换 UTC getter 都会让两份模板对不上。
 */
function clockTemplate(src, fnName) {
  const start = src.indexOf(`function ${fnName}(`);
  if (start < 0) return null;
  const body = src.slice(start, src.indexOf('\n}', start));
  const ret = /\n\s*return `([^`]*)`;/.exec(body);
  if (!ret) return null;
  const helper = /const (\w+) = \(n\) => String\(n\)\.padStart\(2, '0'\);/.exec(body);
  let tpl = ret[1];
  if (helper) tpl = tpl.split(`${helper[1]}(`).join('PAD(');
  return { tpl, hasPad: !!helper };
}

const serverClock = clockTemplate(storeSrc, 'fmtDateTime');
const hostClock = clockTemplate(hostSrc, 'formatTime');
check('两份墙钟格式化都在（服务端 fmtDateTime / 前端 formatTime）',
  !!serverClock && !!hostClock, `server=${!!serverClock} host=${!!hostClock}`);
check('两份墙钟格式逐字符一致（改一份忘另一份，页面与导出就是两个时间）',
  serverClock?.tpl === hostClock?.tpl,
  `server="${serverClock?.tpl}" host="${hostClock?.tpl}"`);
check('两份都带补零助手（少一处 padStart 就出现 2026-3-4 这种对不齐的日期）',
  serverClock?.hasPad && hostClock?.hasPad, `server=${serverClock?.hasPad} host=${hostClock?.hasPad}`);
// 本地墙钟这条语义也要钉：谁"顺手改成 UTC"就会让同一时刻在导出与页面上差几个小时。
const clockFields = (tpl) => ['getFullYear', 'getMonth', 'getDate', 'getHours', 'getMinutes']
  .every((g) => tpl.includes(`${g}()`));
check('两份都用本地 getter 取年月日时分（不许出现 getUTC*——那是另一个坐标系）',
  clockFields(serverClock?.tpl || '') && clockFields(hostClock?.tpl || '')
  && !/getUTC/.test(serverClock?.tpl || '') && !/getUTC/.test(hostClock?.tpl || ''),
  `server="${serverClock?.tpl}" host="${hostClock?.tpl}"`);

// ──────────────────────────────────────────────── 预览脚本的浏览器发现不许再写死一台机器
//
// test/preview/* 这三条臂过去各自写着 `C:/Program Files (x86)/Microsoft/Edge/...msedge.exe`
// ——那是一台 Windows 机器的安装目录。换到 Linux / macOS / Edge 装在 Program Files 的机器上，
// 脚本第一句就"找不到 Edge"，整条浏览器臂静默消失，探针退化成"什么都没量过"却看着像跑完了。
// 现在发现逻辑收在 test/preview/browser.mjs 一处，脚本只许通过它拿浏览器。这一节钉三件事：
// 写死的机器路径不许回来、三个脚本都得走公共发现、容器里必须的 shm 参数不许被删。
{
  const previewDir = path.join(app, 'test', 'preview');
  const browserSrc = fs.readFileSync(path.join(previewDir, 'browser.mjs'), 'utf8');
  check('公共发现模块在（findBrowser / browserBaseArgs 两个出口）',
    /export function findBrowser\(/.test(browserSrc) && /export function browserBaseArgs\(/.test(browserSrc));
  check('它按 PATH 轮询 chromium / chrome / edge 家族（不认某一个发行版的叫法）',
    ['chromium', 'chromium-browser', 'google-chrome', 'msedge'].every((n) => browserSrc.includes(n)));
  check('EDGE_PATH / BROWSER_PATH 显式指路仍是第一优先（探针要能手工换浏览器）',
    browserSrc.includes('BROWSER_PATH') && browserSrc.includes('EDGE_PATH'));
  // 容器里 /dev/shm 常常只有 64MB（本沙箱实测），缺这条 chromium 跑几次就崩——这是环境事实不是玄学
  check('公共参数带 --disable-dev-shm-usage（容器里没这条浏览器随机崩）',
    browserSrc.includes("'--disable-dev-shm-usage'"));
  // --no-sandbox 只许"root 才加"，不许无条件加：普通机器上浏览器沙箱是安全边界，不能替所有人拆
  check('--no-sandbox 只在 uid=0 时加（不无条件拆掉浏览器沙箱）',
    /getuid\(\) === 0/.test(browserSrc) && !/args = \[[\s\S]*'--no-sandbox'[\s\S]*\];/.test(
      browserSrc.split('function browserBaseArgs')[1]?.split('*/')?.[0] || ''),
    '要么丢了 root 判定，要么把它写进了无条件参数');
  const probeScripts = ['csp-probe.mjs', 'legacy-artifact-csp.mjs', 'slot-cut-probe.mjs'];
  for (const name of probeScripts) {
    const src = fs.readFileSync(path.join(previewDir, name), 'utf8');
    check(`${name} 不再写死某台机器的安装路径`,
      !/(^|["'(\s])[A-Za-z]:[\\/]/.test(src) && !/Program Files|msedge\.exe/.test(src),
      '源码里还有 Windows 盘符路径或 Edge 安装目录');
    check(`${name} 走公共发现（import ./browser.mjs）`, src.includes("from './browser.mjs'"));
  }

  // measure-layout.py 这一条本轮抓到的是**假绿**：它量的靶子（#stage-chat / #chatInner /
  // .stage-tabs）在「会话单列」改版后就不存在了，注入的脚本第一行就抛，dump 里从来没有读数；
  // 而"脚本跑过了"的判据是"dump 里搜得到标记字样"——搜到的是注入的源码本身。三条一起钉：
  // 靶子必须对得上今天的页面、读数标记必须"不执行就凑不出"、浏览器路径不许再写死。
  const pySrc = fs.readFileSync(path.join(previewDir, 'measure-layout.py'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(app, 'web', 'index.html'), 'utf8');
  const probeBlock = pySrc.slice(pySrc.indexOf('SETUP = r"""'), pySrc.indexOf('def measure('));
  // 探针自己造的节点不算锚点（样题是脚本 append 进 #deskInner 的）
  const SELF_MADE = new Set(['deskInner']);
  const anchors = [...new Set([
    ...[...probeBlock.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...probeBlock.matchAll(/box\('#([A-Za-z][\w-]*)/g)].map((m) => m[1]),
  ])];
  const missingAnchors = anchors.filter((id) => !SELF_MADE.has(id) && !indexHtml.includes(`id="${id}"`));
  check('量几何探针的锚点 id 都在今天的 index.html 里（改版了这条会红，不会再静默量空）',
    anchors.length >= 2 && missingAnchors.length === 0,
    `锚点=${anchors.join(',')} 缺=${missingAnchors.join(',') || '（无）'}`);
  // 读数标记不许以"成品"形式出现在探针源码里：那样"搜到标记"就只是搜到了源码本身
  const codeLines = probeBlock.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  check('量几何的读数标记由两段拼出（源码里不许出现成品标记：否则"搜到标记"=搜到源码，就是那条假绿）',
    !codeLines.includes('PROBE#') && /const M = 'PR' \+ 'OBE';/.test(codeLines)
    && pySrc.includes('re.search(r"PROBE#(\\{.*?\\})PROBE#"'),
    `源码含成品标记=${codeLines.includes('PROBE#')} 拼装式=${/const M = 'PR' \+ 'OBE';/.test(codeLines)}`);
  // 钉的不是"文件里不许出现 Program Files 这几个字"（Windows 那档候选路径本来就得写着），
  // 而是"不许把它当成唯一的浏览器直接赋给一个常量"——必须走发现流程。
  check('量几何不再写死某台机器的安装路径，且带容器 shm 参数',
    !/^EDGE\s*=/m.test(pySrc) && /BROWSER = find_browser\(\)/.test(pySrc)
    && pySrc.includes('--disable-dev-shm-usage'));
}

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
  t = t.replace(/\\\./g, '.'); // serve 正则的转义点（\.zip 之类）摊平——README 里写的就是字面点
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

// ──────────────────────────────────────────────── 承诺的兑现位置：文档说的守卫必须在删数据那一侧
//
// 第十八轮的元教训：README「删除会话」写着"会话有进行中的回合时拒绝删除"，这句**只在浏览器里**兑
// （前端看当前标签页有没有 state.turn）。服务端 DELETE 路由不看 activeTurns，实测回合进行中照删 200，
// 于是"文档有这句话"与"真在服务端兑"被文档测试当成同一件事放过了。这一节把文档那句话与
// serve.mjs 里 DELETE 分支的真实守卫绑死：谁把守卫从服务端摘掉，这条就红。
{
  const delSectionMatch = /### 删除会话[\s\S]{0,900}?###/.exec(readmeDoc);
  check('README「删除会话」一节仍在承诺回合中不许删（并写明兑在哪一侧）',
    Boolean(delSectionMatch) && /进行中的回合/.test(delSectionMatch[0])
    && /409/.test(delSectionMatch[0]) && /turn-active/.test(delSectionMatch[0]),
    delSectionMatch ? delSectionMatch[0].replace(/\n+/g, ' ').slice(0, 200) : '找不到该节');
  // serve.mjs 里有好几条 DELETE 分支（providers / endpoints / notes / notebook），
  // 要盯的是删整本那一条——用 store.deleteNotebook 认出它，再检查守卫在不在它身体里。
  const delBranches = [...serveSrc.matchAll(/if \(m && method === 'DELETE'\) \{[\s\S]*?\n {4}\}/g)]
    .map((mm) => mm[0]);
  const notebookDel = delBranches.find((b) => b.includes('store.deleteNotebook'));
  check('DELETE /api/notebooks/:id 的路由分支里真的有 activeTurns 守卫（承诺兑在服务端）',
    Boolean(notebookDel) && /activeTurns\.get\(/.test(notebookDel) && /turn\.done/.test(notebookDel)
    && /sendJson\(res, 409/.test(notebookDel),
    notebookDel ? notebookDel.replace(/\n\s*/g, ' ').slice(0, 260) : `找不到删整本的分支（共 ${delBranches.length} 条 DELETE 分支）`);
  check('守卫给的错误带 reason=turn-active（前端能分流，不靠猜文案）',
    Boolean(notebookDel) && notebookDel.includes('turn-active'), notebookDel ? notebookDel.slice(0, 200) : '');
}

// ──────────────────────────────────────────────── 唯一的 JSON 读取口：不许有第二份 readJsonSafe
//
// config.mjs 那份 readJsonSafe 带着第十一轮起的证据纪律（坏 JSON 留 `.corrupt-` 副本 + 喊话）。
// 第十八轮抓到 tasks.mjs 自带一份**同名的局部函数**遮蔽它：settings.json / credentials.json
// 走分身这条路读坏时静默兜成默认值，盘上没证据、日志没喊话。局部遮蔽这种东西改一次就复发，
// 所以钉住形状：server/ 下除 config.mjs 自己，任何模块都不许再定义 readJsonSafe。
{
  const serverDir = path.join(app, 'server');
  const offenders = [];
  for (const name of fs.readdirSync(serverDir)) {
    if (!name.endsWith('.mjs') || name === 'config.mjs') continue;
    const src = fs.readFileSync(path.join(serverDir, name), 'utf8');
    if (/function readJsonSafe\s*\(/.test(src) || /const readJsonSafe\s*=/.test(src)) offenders.push(name);
  }
  check('server/ 里没有第二份 readJsonSafe（读取口唯一，证据纪律不可绕）',
    offenders.length === 0, offenders.join(','));
  // tasks.mjs 用得着 settings/credentials，必须从 config.mjs 把它 import 进来
  const tasksSrc = fs.readFileSync(path.join(serverDir, 'tasks.mjs'), 'utf8');
  check('tasks.mjs 用 config.mjs 的读取口（import 里带 readJsonSafe）',
    /import \{[^}]*readJsonSafe[^}]*\} from '\.\/config\.mjs'/.test(tasksSrc),
    tasksSrc.split('\n').filter((l) => l.includes('config.mjs')).join(' | '));
}

// ──────────────────────────────────────────────── 体检报告字段：文档、服务端、前端三处口径一致
//
// corruptEvidence 是第十八轮加的台账（治好的文件副本仍在案）。三份文件都得认它：
// store 产出它、README 描述它、前端读它——任何一处漂移都会让取证出口静默变瞎。
{
  const storeSrc = fs.readFileSync(path.join(app, 'server', 'store.mjs'), 'utf8');
  check('store 的体检报告产出 corruptEvidence 台账',
    /corruptEvidence/.test(storeSrc) && /sourceCorrupt/.test(storeSrc), '报告里没有台账字段');
  {
    // 文档守护要钉"那句话"而不是那个字段名：光 includes('corruptEvidence') 时，
    // 把台账一节的实质内容全删、只在别处留一次词，照样绿（M15 实测撞出的弱钉子）。
    const ledgerDoc = /治好了也要查得着[\s\S]{0,900}/.exec(readmeDoc);
    check('README 写清台账的实质：治好了仍在案 + rel 相对 DATA_DIR + sourceCorrupt',
      Boolean(ledgerDoc) && ledgerDoc[0].includes('corruptEvidence')
      && /查无实据|仍在案|治好/.test(ledgerDoc[0]) && /DATA_DIR/.test(ledgerDoc[0])
      && ledgerDoc[0].includes('sourceCorrupt'),
      ledgerDoc ? ledgerDoc[0].replace(/\n+/g, ' ').slice(0, 200) : '找不到台账一节');
  }
  check('README 写到取证口两条清单都认（原件与副本）',
    /取证下载两条清单都认|两条清单都认/.test(readmeDoc), 'README 没跟上第十八轮口径');
  const webAppSrc = fs.readFileSync(path.join(app, 'web', 'app.js'), 'utf8');
  check('前端渲染 corruptEvidence 并给"已修复"存证下载口',
    webAppSrc.includes('corruptEvidence') && webAppSrc.includes('下载存证副本'), '面板没有台账出口');
  check('前端读取台账带兜底（老服务没这字段不许炸面板）',
    /Array\.isArray\(report\.corruptEvidence\)/.test(webAppSrc), '直接当数组用了');
  // 台账的 rel 基准必须和 corruptFiles 不同且被 readCorruptFile 认得——两处基准搞混就是 404 现场
  check('readCorruptFile 明确分辨两份清单（原件走 NOTEBOOKS_DIR，副本走 DATA_DIR）',
    /report\.corruptFiles\.includes/.test(storeSrc) && /corruptEvidence\.find/.test(storeSrc)
    && /serveWhitelisted\(NOTEBOOKS_DIR/.test(storeSrc) && /serveWhitelisted\(DATA_DIR/.test(storeSrc),
    '白名单没分基准');
}


// ──────────────────────────────────────────────── 落盘的东西必须有人读回来：注释/文档/代码三方对齐
//
// 第十九轮的病灶：tasks.mjs 给每条任务落一份 jobs/<id>.json，注释写着「刷新/重启后还能翻出来」，
// 可 list/get/stop 只看内存 Map——没有任何一行代码去读那个目录（探针 19-A 实测：重启后
// GET /tasks 0 条，盘上还有 1 条）。前端同样只写不读：openNotebook 清 state.tasks，
// 全文件没人调用 GET /tasks。这一节把**注释里那句承诺**与**真去读盘的那段代码**绑死：
// 摘掉回读，那句注释不许独自绿着。
{
  const tasksSrc = fs.readFileSync(path.join(app, 'server', 'tasks.mjs'), 'utf8');
  const promiseHits = [...tasksSrc.matchAll(/还能翻出来/g)];
  check('tasks.mjs 对 jobs 落盘的承诺在案（不许悄悄删掉这句话躲测试）',
    promiseHits.length >= 1, '找不到「还能翻出来」这句承诺');
  const hydrateDef = /_hydrate\(notebookId\) \{[\s\S]*?\n  \}/.exec(tasksSrc);
  check('_hydrate 真的在扫这一本的 jobs 目录（承诺不是空话）',
    Boolean(hydrateDef) && hydrateDef[0].includes('this.jobsDir(')
    && /fs\.readdirSync/.test(hydrateDef[0]) && /readJsonSafe/.test(hydrateDef[0]),
    hydrateDef ? hydrateDef[0].replace(/\n+\s*/g, ' ').slice(0, 200) : '没有 _hydrate 或它不读盘');
  const listBody = /list\(\{ notebookId, kind \} = \{\}\) \{[\s\S]*?\n  \}/.exec(tasksSrc);
  check('list() 开口第一件事就是回读盘（不回读就还是只看内存）',
    Boolean(listBody) && /this\._hydrate\(notebookId\)/.test(listBody[0]),
    listBody ? listBody[0].replace(/\n+\s*/g, ' ').slice(0, 160) : 'list() 找不到了');
  const getBody = /get\(id\) \{[\s\S]*?\n  \}/.exec(tasksSrc);
  check('get(id) 内存查不到时按 id 找回盘上那一份',
    Boolean(getBody) && /_findById\(id\)/.test(getBody[0]),
    getBody ? getBody[0].replace(/\n+\s*/g, ' ').slice(0, 160) : '找不到 get() 本体');

  // running 的判据必须是"这台进程还有句柄"——盘上那个字段不算数（探针 19-C 的僵尸）
  const statusFor = /statusFor\(record\) \{[\s\S]*?\n  \}/.exec(tasksSrc);
  check('statusFor 的 running 判据是句柄在手（live?.abort），不是盘上写的字段',
    Boolean(statusFor) && /live\?\.abort/.test(statusFor[0]),
    statusFor ? statusFor[0].replace(/\n+\s*/g, ' ').slice(0, 200) : '没有 statusFor');
  check('没句柄的 running 读成 interrupted（如实，不改判就是撒谎）',
    Boolean(statusFor) && /status: 'interrupted'/.test(statusFor[0]), '僵尸又被原样读成 running 了');
  check('interrupted 在状态口径注释里挂了号（不许留一份没人认领的状态）',
    /running \| done \| failed \| stopped[\s\S]{0,80}interrupted/.test(tasksSrc), '状态口径没跟上');

  // 前端这一侧：接口有、承诺有，就得有人真的去打它
  const webApp = fs.readFileSync(path.join(app, 'web', 'app.js'), 'utf8');
  check('前端打开学习时补水任务记录（GET /tasks 终于有人调用）',
    /hydrateTasks\(/.test(webApp) && /api\/notebooks\/\$\{notebookId\}\/tasks/.test(webApp)
    && /openNotebook[\s\S]{0,2600}hydrateTasks\(id\)/.test(webApp),
    'GET /tasks 又没人来取了');
  check('补水不许拖慢或弄红打开学习（异步出去 + catch 静默）',
    /function hydrateTasks[\s\S]{0,900}\.catch\(/.test(webApp), '补水没有静默失败出口');
  check('前端有"已中断"徽章词（服务端改判的状态在界面上有名字）',
    /interrupted: '已中断'/.test(webApp), 'TASK_LABEL 没带 interrupted');
  check('中断卡片给一句为什么（note 一路带到面板）',
    /status === 'interrupted'[\s\S]{0,240}task-note/.test(webApp), '面板只显示状态不显示原因');

  // stop 的归属门：路由不许把 URL 里的 :id 当装饰
  check('serve.mjs 的 stop 分支把 :id 真的交给 stop 做归属校验',
    /taskRunner\.stop\(taskId, id\)/.test(serveSrc), '路由又开始无视 notebook id 了');
  check('跨本 stop 如实翻成 404（这一本下面查无此任务）',
    /crossNotebook/.test(serveSrc) && /sendJson\(res, 404/.test(serveSrc), '404 翻译没在路由侧');
  check('TaskRunner.stop 本体做归属校验（守卫长在动手那一侧，不只靠路由）',
    /stop\(id, notebookId = null\)[\s\S]{0,700}r\.notebookId !== notebookId/.test(tasksSrc),
    '归属校验没落在 stop 自己身上');
  check('stop_background_task 工具带同一道门（模型侧不停别本）',
    /this\.taskRunner\.stop\(String\(args\.task_id \|\| ''\)\.trim\(\), this\.notebook\.id\)/.test(agentSrc),
    '工具侧还是裸 stop(id)');
  check('read_background_task 读到 interrupted 如实说并给重派的出口',
    /status: 'interrupted'[\s\S]{0,300}重新派/.test(agentSrc), '工具又开始把中断任务当活着或当完成');

  // README 那一节：钉语义而不是关键词（第十八轮 §4.1 的教训——M15 撞出来的）
  const jobsDoc = /### 后台任务记录[\s\S]{0,2200}?\n###/.exec(readmeDoc);
  check('README 有「落盘要有回读」一节并写明三件事（回读 / 如实 / 归属）',
    Boolean(jobsDoc) && /只写不读/.test(jobsDoc[0]) && /句柄/.test(jobsDoc[0])
    && /interrupted/.test(jobsDoc[0]) && /守卫要站在动手那一侧/.test(jobsDoc[0]),
    jobsDoc ? jobsDoc[0].replace(/\n+/g, ' ').slice(0, 220) : '找不到这一节');
  check('README 写明导出带 jobs、导入有意无视（这条"不做"要有名分）',
    /导入.{0,16}有意无视/.test(readmeDoc), 'jobs 的导出/导入口径没进文档');
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exitCode = failed === 0 ? 0 : 1;
