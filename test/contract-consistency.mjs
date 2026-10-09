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
//
// 第二十轮同一类病换了个主语：守卫认得回合、认不出分身。回合派完后台任务就收尾，任务还 running
// 时删除照旧 200，任务一收尾就往 jobs/ 写盘（mkdirSync recursive）把删掉的学习复活成鬼目录。
// 所以这一节现在钉两笔账：文档与代码都得同时认「回合」和「后台任务」，摘掉任何一边都红。
{
  // 窗口按整节取（到下一个 ### 为止）：这段历史越写越长，窗口收窄会把钉子本身弄断
  const delSectionMatch = /### 删除会话[\s\S]*?\n###/.exec(readmeDoc);
  check('README「删除会话」一节仍在承诺回合中不许删（并写明兑在哪一侧）',
    Boolean(delSectionMatch) && /进行中的回合/.test(delSectionMatch[0])
    && /409/.test(delSectionMatch[0]) && /turn-active/.test(delSectionMatch[0]),
    delSectionMatch ? delSectionMatch[0].replace(/\n+/g, ' ').slice(0, 200) : '找不到该节');
  check('README 同样承诺"还有后台任务在跑也不许删"（第二笔账不能只在代码里兑）',
    Boolean(delSectionMatch) && /task-active/.test(delSectionMatch[0])
    && /后台任务/.test(delSectionMatch[0]),
    delSectionMatch ? delSectionMatch[0].replace(/\n+/g, ' ').slice(0, 240) : '找不到该节');
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
  /*
   * 分身那一笔账同样要在删数据那一侧兑，并且**只认真还在跑的**：判据走 statusFor 之后的
   * publicView（第十八、十九轮同一条纪律——僵尸 running 不许挡删除，否则重启后每一本
   * 带僵尸任务的学习都再也删不掉）。把 filter 的 'running' 摘掉、或整段守卫删掉，这里就红。
   */
  check('DELETE 分支真的问过 taskRunner 这一本还有没有在跑的任务（守卫认得出分身）',
    Boolean(notebookDel) && /taskRunner\.list\(\{ notebookId: id \}\)/.test(notebookDel)
    && /t\.status === 'running'/.test(notebookDel) && notebookDel.includes('task-active'),
    notebookDel ? notebookDel.replace(/\n\s*/g, ' ').slice(0, 300) : '找不到删整本的分支');
  check('拒绝时带在跑任务清单（人不用自己猜是哪几个挡着）',
    Boolean(notebookDel) && /liveTasks\.map\(/.test(notebookDel), '只回了一句人话、没给清单');
  // 任务路由的 :id 不许只当装饰：鬼目录那一侧 404（与第十九轮 stop 同一条纪律的延伸）。
  // 第二十一轮起这道门不再一条条边各写一遍——探针 21-A 实测逐边补门永远慢于探针，
  // 28 条边只有碰巧被打中的两条有门。现在钉总门：所有带 :id 的路由共用一处存在性检查，
  // 且它必须排在创建/导入之后、任何按 id 分发的分支之前（否则 DELETE 会把不存在的学习删成 200）。
  const tasksBlocks = [...serveSrc.matchAll(/if \(m && method === '(GET|POST)'\) \{[\s\S]*?\n {4}\}/g)]
    .map((mm) => mm[0]).filter((b) => b.includes('taskRunner.'));
  check('任务相关路由不再自带一份存在性门（总门起了作用，重复门必须拆掉）',
    tasksBlocks.length >= 2 && tasksBlocks.every((b) => !b.includes('notebookExists(id)')),
    '任务路由里还留着自己的那份门——两道门迟早各说各的话');
  {
    const gateIdx = serveSrc.indexOf('const nbIdMatch = ');
    const idxImport = serveSrc.indexOf("'/api/notebooks/import' && method === 'POST'");
    const idxFirstIdRoute = serveSrc.indexOf('m = /^\\/api\\/notebooks\\/([^/]+)$/');
    check('serve.mjs 有一道带 :id 路由的总存在性门，且位置正确（创建/导入在前，删整本在后）',
      gateIdx > -1 && idxImport > -1 && gateIdx > idxImport && idxFirstIdRoute > gateIdx,
      `gate=${gateIdx} import=${idxImport} firstIdRoute=${idxFirstIdRoute}`);
    const gateBody = /const nbIdMatch =[\s\S]*?\n {4}\}/.exec(serveSrc);
    check('总门对非法 id 给 400、对不存在的学习给 404 学习不存在（口径唯一，不再一边走 409 一边挂 SSE）',
      Boolean(gateBody) && /sendJson\(res, 400/.test(gateBody[0]) && /safeId\(id\)/.test(gateBody[0])
      && /sendJson\(res, 404, \{ error: '学习不存在'/.test(gateBody[0]) && /notebookExists\(id\)/.test(gateBody[0]),
      gateBody ? gateBody[0].replace(/\n+\s*/g, ' ').slice(0, 240) : '找不到总门本体');
  }
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

// ──────────────────────────────────────────────── 写盘那道门：学习不在了就不许 mkdir 回来（第二十轮）
//
// 探针 20-A 的根因是一段看起来无害的代码：`fs.mkdirSync(dir, { recursive: true })` 在写 jobs/
// 之前把目录"顺手补上"。笔记本被删掉之后这一补就把整本复活成鬼目录。修法是把两条写盘路径
// 都收进同一个口子，口子上先问一句「这一本还在吗」。这一节钉三件事：口子存在、两条路径都走它、
// 判据与 assertExists 同源（不是另起一套"目录在不在"）。
{
  const tasksSrc = fs.readFileSync(path.join(app, 'server', 'tasks.mjs'), 'utf8');
  const storeSrc = fs.readFileSync(path.join(app, 'server', 'store.mjs'), 'utf8');
  const configSrc = fs.readFileSync(path.join(app, 'server', 'config.mjs'), 'utf8');
  const writeJob = /_writeJob\(notebookId, record\) \{[\s\S]*?\n  \}/.exec(tasksSrc);
  check('_writeJob 是唯一的 jobs 写盘口，且开口先过 notebookExists（门不在就别谈两条路径）',
    Boolean(writeJob) && /if \(!notebookExists\(notebookId\)\) return false/.test(writeJob[0]),
    writeJob ? writeJob[0].replace(/\n+\s*/g, ' ').slice(0, 200) : '找不到 _writeJob 或它没问存在性');
  check('这道门的判据来自地基 config（与 assertExists 同源，不在 tasks 里另长一套）',
    /import \{[^}]*notebookExists[^}]*\} from '\.\/config\.mjs'/.test(tasksSrc)
    && /export function notebookExists\(id\)/.test(configSrc),
    'notebookExists 没从 config 导给 tasks');
  /*
   * "同源"不能只在注释里说：判据必须与 assertExists 用同一个常量（NOTEBOOK_FILE），
   * 也不许退化成"目录在就算在"。m15 演的正是这种退化——门与路由一起变瞎，而
   * `if (!notebookExists(...)) return false` 这一行形状一个字都没动，形状钉子照样绿。
   * 第二十一轮判据搬进 config.mjs（notes/tasks/serve 都能引、不成环），NOTEBOOK_FILE
   * 跟着搬：store 不再自己定义"一本学习叫什么"，它从 config 引——这一条也要钉住。
   */
  const nbExistsBody = /export function notebookExists\(id\) \{[\s\S]*?\n\}/.exec(configSrc);
  const assertBody = /function assertExists\(id\) \{[\s\S]*?\n\}/.exec(storeSrc);
  const joinsNotebookFile = (body) => /fs\.existsSync\(path\.join\([^)]*NOTEBOOK_FILE\)\)/.test(body);
  check('notebookExists 的判据就是 assertExists 那一句（有 notebook.json 才算一本学习）',
    Boolean(nbExistsBody) && /safeId\(id\)/.test(nbExistsBody[0]) && joinsNotebookFile(nbExistsBody[0])
    && Boolean(assertBody) && joinsNotebookFile(assertBody[0]),
    nbExistsBody ? nbExistsBody[0].replace(/\n+\s*/g, ' ').slice(0, 200) : '找不到 notebookExists 本体');
  check('NOTEBOOK_FILE 全仓只定义一次（在 config），store 从 config 引（判据没有第二种写法）',
    /export const NOTEBOOK_FILE = 'notebook\.json'/.test(configSrc)
    && !/const NOTEBOOK_FILE = 'notebook\.json'/.test(storeSrc)
    && /import \{[\s\S]*?NOTEBOOK_FILE[\s\S]*?\} from '\.\/config\.mjs'/.test(storeSrc),
    'store 里还有第二份 NOTEBOOK_FILE 定义，或没从 config 引');
  // 两条写盘路径必须都走这个口子：_create（开局落一份）与 _finish（收尾落终态）
  const createBody = /_create\(\{ notebookId, kind, title, instructions, parentId = null, modelRef, helper = null \}\) \{[\s\S]*?\n  \}/.exec(tasksSrc);
  const finishBody = /_finish\(record, \{ status, output, error \}\) \{[\s\S]*?\n  \}/.exec(tasksSrc);
  check('_create 落盘走这道门（不再直接 mkdirSync 造目录）',
    Boolean(createBody) && /this\._writeJob\(notebookId, record\)/.test(createBody[0])
    && !/fs\.mkdirSync/.test(createBody[0]),
    createBody ? createBody[0].replace(/\n+\s*/g, ' ').slice(0, 200) : '找不到 _create 本体');
  check('_finish 落盘走这道门（探针 20-A 里那一下复活就是它）',
    Boolean(finishBody) && /this\._writeJob\(record\.notebookId, record\)/.test(finishBody[0])
    && !/fs\.mkdirSync/.test(finishBody[0]),
    finishBody ? finishBody[0].replace(/\n+\s*/g, ' ').slice(0, 200) : '找不到 _finish 本体');

  // 体检这一侧：鬼目录既进清单也进 ok，本数不再被它充
  const healthBody = /export function healthCheck\(\) \{[\s\S]*?\n\}/.exec(storeSrc);
  check('体检把没有 notebook.json 的目录单列为 ghostDirs（判据同 assertExists）',
    Boolean(healthBody) && /ghostDirs/.test(healthBody[0])
    && /NOTEBOOK_FILE/.test(healthBody[0]) && /ghostDirs\.push\(/.test(healthBody[0]),
    healthBody ? healthBody[0].replace(/\n+\s*/g, ' ').slice(0, 200) : '找不到 healthCheck 本体');
  check('本数只数真学习（ghost 目录 continue，不再 notebooks += 1）',
    Boolean(healthBody) && /notebooks \+= 1/.test(healthBody[0])
    && /ghostDirs\.push\([\s\S]{0,200}\n\s*continue;/.test(healthBody[0]),
    '鬼目录又开始充本数了');
  check('ghostDirs 进 ok 判定（此刻盘上真存在的一处不该存在，不是往事）',
    Boolean(healthBody) && /ghostDirs\.length === 0/.test(healthBody[0]), '报告了但没人需要管');

  // 前端这一侧：读新字段要兜住老服务，而且只点名、不给一键删除
  const webApp = fs.readFileSync(path.join(app, 'web', 'app.js'), 'utf8');
  check('前端读 ghostDirs 带兜底（老服务没这个字段不许炸面板）',
    /Array\.isArray\(report\.ghostDirs\)/.test(webApp), '直接当数组用了');
  check('前端点名鬼目录并说明要人自己确认（不给一键删除的键）',
    /鬼目录/.test(webApp) && /手动删掉这个目录/.test(webApp), '面板没有鬼目录出口');
  // 删除弹层这一侧：回合与分身两笔账都要提，客户端那句不再是唯一的一道闸
  check('删除弹层也提"后台任务还在跑"这一笔（与 state.turn 那句并列）',
    /个后台任务在跑/.test(webApp), '弹层还只认回合');

  // README：鬼目录进体检清单这件事得写在文档里（钉语义，不只钉词）
  const healthDoc = /- \*\*体检数据\*\*[\s\S]{0,700}/.exec(readmeDoc);
  check('README 体检一节写了第四件该修的事（鬼目录）与本数只数真学习',
    Boolean(healthDoc) && /鬼目录/.test(healthDoc[0]) && /notebook\.json/.test(healthDoc[0])
    && /只数\*\*真学习\*\*|只数真学习/.test(healthDoc[0]),
    healthDoc ? healthDoc[0].replace(/\n+/g, ' ').slice(0, 240) : '找不到体检那一节');
}

// ──────────────────────────────── 分身交付要带户口 + 一道门统口径（第二十一轮）
//
// 这一轮的账不是"少了一条守卫"，是**一条从来没执行过的代码路径**：宿主替分身交付时用
// event.task?.notebookId 找归属，而 task_artifact 只带 taskId —— 归属恒 undefined，
// 那两个 if (nid) 一次都没进过（探针 21-C 实测：先开了场、manifest 有件、props 仍为空、
// chat 无账）。功能之所以还看得见，靠的是"查不到就广播给所有订阅者"的兜底把整份 HTML
// 发给了每一本（探针 21-B）。形状钉子全绿，行为全错。所以这一节的钉子全部对着**行为与归属**，
// 而不是对着分支里有没有某个函数名。
{
  const tasksSrc21 = fs.readFileSync(path.join(app, 'server', 'tasks.mjs'), 'utf8');
  const notesSrc21 = fs.readFileSync(path.join(app, 'server', 'notes.mjs'), 'utf8');
  const webSrc21 = fs.readFileSync(path.join(app, 'web', 'app.js'), 'utf8');
  const configSrc21 = fs.readFileSync(path.join(app, 'server', 'config.mjs'), 'utf8');

  // 源头：事件必须自带归属
  const emitLine = /this\.onEvent\(\{ type: 'task_artifact'[^;]*;/.exec(tasksSrc21);
  check('task_artifact 事件自带户口（task 与 task_start/task_end 同形，publicView 那一份）',
    Boolean(emitLine) && /task: publicView\(record\)/.test(emitLine[0]),
    emitLine ? emitLine[0].replace(/\s+/g, ' ').slice(0, 180) : '找不到 task_artifact 的发射点');

  // 宿主：按归属投递，兜底广播必须死
  const branch21 = /if \(event\.type === 'task_artifact'\) \{([\s\S]*?)\n    \}\n/.exec(serveSrc)?.[1] || '';
  check('投递只认事件自带的归属（广播给所有订阅者那条兜底不许复活——串台就是这么来的）',
    /taskStreamWrite\(event\.task\.notebookId/.test(serveSrc)
    && !/for \(const key of \[\.\.\.taskStreams\.keys\(\)\]\) taskStreamWrite/.test(serveSrc),
    '兜底广播还活着，或者投递没改读自带归属');
  /*
   * 「查无归属」那一支单独抠出来钉：它只许喊话，不许投递。上一轮的兜底就是把这一支
   * 写成"那就广播给所有人"，于是 A 的整份 HTML 发给了每一本。
   */
  const noOwner = /if \(!nid\) \{([\s\S]*?)\n      \}/.exec(branch21)?.[1] || '';
  check('查无归属就不投，并且喊出来（那是编程错误，不是运行状态）',
    /console\.error\(`\[task_artifact\] 事件不带归属/.test(noOwner) && !/taskStreamWrite/.test(noOwner),
    noOwner ? noOwner.replace(/\s+/g, ' ').slice(0, 160) : '找不到查无归属那一支');
  /*
   * 关键的一条：那两个 if (nid) 的**空壳**形状与"真的执行"在源码上只差一层缩进。
   * 上一轮的病灶就是 placeOnDesk / upsertChatMessage 各被一只恒假的 if (nid) 罩着。
   * 所以这里钉的是：归属拿到之后交付直接执行（不再各自套一层 if (nid)）。
   */
  check('归属在就真的交付：上台与落账不再各自套一层恒假的 if (nid)',
    /store\.placeOnDesk\(nid, event\.artifact\)/.test(branch21)
    && /store\.upsertChatMessage\(nid, \{/.test(branch21)
    && !/if \(nid\) \{/.test(branch21),
    branch21 ? `placeOnDesk@${branch21.indexOf('placeOnDesk')} upsert@${branch21.indexOf('upsertChatMessage')}` : '没找到分支');
  // 台面那本账要跟着交付走到浏览器（回合早结束时常驻流是唯一收件人）
  check('task_scene 在 task_artifact 之前递到常驻流（props 闸门认这本账，账晚到这件就上不了台）',
    branch21.indexOf("'task_scene'") >= 0
    && branch21.indexOf('task_scene') < branch21.indexOf("type: 'artifact'")
    && /taskStreamWrite\(nid, JSON\.stringify\(\{ type: 'task_scene'/.test(branch21),
    branch21 ? `scene@${branch21.indexOf('task_scene')} artifact@${branch21.indexOf("type: 'artifact'")}` : '没找到分支');
  check('前端认这份账，也认 job id 与 art id 的两个名字（占位卡那次替换是假的）',
    webSrc21.includes("type === 'task_scene'")
    && /completeArtifactPlaceholder\(evt\.artifact, evt\.taskId \?\? evt\.task\?\.id\)/.test(webSrc21)
    && /artifactNodeEl\(String\(artifact\.id\)\) \|\| \(taskId \? artifactNodeEl\(String\(taskId\)\) : null\)/.test(webSrc21),
    '没接 task_scene，或占位卡仍只按真 id 找');

  // notes.mjs 那道门（第二十轮遗留 §5.1）：形状 + 判据同源，两样都要
  const noteWrite21 = /function write\(id, data\) \{[\s\S]*?\n\}/.exec(notesSrc21);
  check('notes 的 write() 开口先问学习还在不在（全仓最后一处裸 mkdir 补上了）',
    Boolean(noteWrite21) && /if \(!notebookExists\(id\)\) return null;/.test(noteWrite21[0])
    && noteWrite21[0].indexOf('notebookExists') < noteWrite21[0].indexOf('fs.mkdirSync'),
    noteWrite21 ? noteWrite21[0].replace(/\s+/g, ' ').slice(0, 180) : '找不到 write() 本体');
  check('saveNote 不许拿一条没落盘的记录当"已存入"',
    /if \(!write\(id, data\)\) return null;/.test(notesSrc21), notesSrc21.slice(0, 0) || '写失败还在返回那条记录');
  check('notes 的判据来自地基 config（不另长一套"在不在"）',
    /import \{[^}]*notebookExists[^}]*\} from '\.\/config\.mjs'/.test(notesSrc21),
    'notes.mjs 没从 config 引 notebookExists');

  // 判据全仓只有一份：config 之外不许有人定义它，store 也不再导出一个同名影子
  check('notebookExists 只在 config.mjs 定义一次（谁都不许再写一份，包括 store）',
    (configSrc21.match(/export function notebookExists/g) || []).length === 1
    && !/function notebookExists/.test(fs.readFileSync(path.join(app, 'server', 'store.mjs'), 'utf8'))
    && !/function notebookExists/.test(notesSrc21)
    && !/function notebookExists/.test(tasksSrc21)
    && !/function notebookExists/.test(serveSrc),
    '有第二个地方自己定义了一本学习存不存在');

  // README 那两节：钉语义，不钉关键词
  const deliverDoc = /分界线的判据是\*\*生成延迟\*\*[\s\S]{0,2400}?\n### /.exec(readmeDoc);
  check('README 写明这句话以前是假的，并给出现在的三句口径（自带户口 / 宿主真的动手 / 占位卡认 job id）',
    Boolean(deliverDoc) && /一次都没执行过/.test(deliverDoc[0])
    && /task: publicView\(record\)/.test(deliverDoc[0]) && /task_scene/.test(deliverDoc[0])
    && /job id/.test(deliverDoc[0]),
    deliverDoc ? deliverDoc[0].replace(/\n+/g, ' ').slice(0, 200) : '找不到这一节');
  const gateDoc = /### 一道门统口径[\s\S]{0,2000}?(?=\n### |\n## )/.exec(readmeDoc);
  check('README 写明门长在总处（400 与 404 两句话），并说明创建/导入走在门前面',
    Boolean(gateDoc) && /safeId/.test(gateDoc[0]) && /400/.test(gateDoc[0])
    && /学习不存在/.test(gateDoc[0])
    && /走在门前面/.test(gateDoc[0]) && /排在门后面/.test(gateDoc[0]),
    gateDoc ? gateDoc[0].replace(/\n+/g, ' ').slice(0, 200) : '找不到这一节');
}

// ──────────────────────────────── 身份只有一个来源：地址是目录名（第二十二轮）
//
// 上一轮那道门管的是"这本还在不在"，没人管"这一本是谁"：动手的一侧用目录名
// （assertExists → notebooks/<URL 那个 id>），报身份的一侧用盘上那行 meta.id
// （列表每行 / GET 整本 / 导出 source.id），而写侧 PATCH 把整个请求体原样并进 meta。
// 探针 22-C 实测：一条 PATCH 让列表出现两行同一个 id，点哪行开的都是同一本；
// 22-A 实测：id:null 让这本从列表消失而 GET 照旧 200；垃圾键随导出旅行。
// 这一节的钉子全部对着**读侧取哪一个、写侧认哪几个键**，不认注释。
{
  const storeSrc22 = fs.readFileSync(path.join(app, 'server', 'store.mjs'), 'utf8');
  const webSrc22 = fs.readFileSync(path.join(app, 'web', 'app.js'), 'utf8');

  // 读侧：三处出口都必须说目录名那一个地址
  const listFn22 = /export function listNotebooks\(\) \{[\s\S]*?\n\}/.exec(storeSrc22)?.[0] || '';
  check('列表每行的 id 取自目录名（不是 meta.id——它是前端下一步要打的地址）',
    /id: name,/.test(listFn22) && !/id: meta\.id,/.test(listFn22),
    listFn22 ? listFn22.split('\n').filter((l) => /id: /.test(l)).join(' / ').slice(0, 160) : '找不到 listNotebooks');
  const getFn22 = /export function getNotebook\(id\) \{[\s\S]*?\n\}/.exec(storeSrc22)?.[0] || '';
  check('getNotebook 的返回体里地址覆盖盘上那行（agent 与 serve 拿 notebook.id 当落盘键，键必须是这一本自己）',
    /\.\.\.meta,\n\s*\/\/[\s\S]{0,400}?id,/.test(getFn22) || /\.\.\.meta,[\s\S]{0,600}?\n    id,/.test(getFn22),
    getFn22 ? getFn22.slice(getFn22.indexOf('return {'), getFn22.indexOf('return {') + 120).replace(/\s+/g, ' ') : '找不到 getNotebook');
  const exportFn22 = /export function exportNotebook\(id\) \{[\s\S]*?\n\}/.exec(storeSrc22)?.[0] || '';
  check('导出包的 source.id 是地址（备份带去别的机器，那边只有目录名对得上）',
    /source: \{ id,/.test(exportFn22) && !/source: \{ id: meta\.id/.test(exportFn22),
    exportFn22 ? (exportFn22.match(/source: \{[^}]*\}/) || [''])[0] : '找不到 exportNotebook');

  // 写侧：白名单 + 地址回填，守卫站在动手那一侧
  check('元数据写口只认 title（id/topic/goal/learner 与任意键一概不认——同族门口径，这条不许是例外）',
    /function sanitiseMetaPatch\([\s\S]*?patch\.title[\s\S]*?\n\}/.test(storeSrc22)
    && !/patch\.id|patch\.topic|patch\.goal|patch\.learner/.test(storeSrc22),
    '写侧没有清洗，或者开始认 id/topic 了');
  const touchFn22 = /export function touchNotebook\(id, patch = \{\}\) \{[\s\S]*?\n\}/.exec(storeSrc22)?.[0] || '';
  check('touchNotebook 落的是清洗后的那一份，并把 id 补回地址（漂了的旧数据下一次写入自己对齐）',
    /sanitiseMetaPatch\(patch\)/.test(touchFn22) && /\.\.\.sanitiseMetaPatch\(patch\), id,/.test(touchFn22)
    && !/\.\.\.meta, \.\.\.patch/.test(touchFn22),
    touchFn22 ? touchFn22.replace(/\s+/g, ' ').slice(0, 200) : '找不到 touchNotebook');
  // 白名单本体逐条扫：判据要对着"清洗后的那一份"，不能整库里任意一处 clamp 过就算。
  // 变异 m6（把 sanitiseMetaPatch 里的 slice 摘掉）原先被建本那一行的同类写法顶绿了——
  // 那是另一条路的收口，替不了这一条。
  const cleanBody22 = /function sanitiseMetaPatch\(patch\) \{[\s\S]*?\n\}/.exec(storeSrc22)?.[0] || '';
  check('清洗本体里 title 既 trim 又限长（改名这条路的口径与建本/导入同一）',
    /patch\.title\.trim\(\)\.slice\(0, META_TITLE_MAX\)/.test(cleanBody22),
    cleanBody22 ? cleanBody22.replace(/\s+/g, ' ').slice(0, 200) : '找不到 sanitiseMetaPatch 本体');
  check('建本时标题就收口（三条路一个口径：建本/改名/导入；前端 maxLength 挡不住接口）',
    /String\(title \|\| topic \|\| '新学习'\)\.trim\(\)\.slice\(0, META_TITLE_MAX\)/.test(storeSrc22),
    '建本这条路不再按同一个长度收口');
  check('META_TITLE_MAX 与导入侧是同一个数（120），不各写各的',
    /const META_TITLE_MAX = 120;/.test(storeSrc22) && /\.slice\(0, 120\)/.test(storeSrc22),
    '两处标题上限不是同一个来源');

  // 读口收体：18 个调用点各补一句 = 第 21 轮批评过的"门长在逐条边上"
  check('请求体必须是 JSON 对象，收口在唯一的 readBody（不在各条边重复）',
    /if \(!parsed \|\| typeof parsed !== 'object' \|\| Array\.isArray\(parsed\)\)/.test(serveSrc)
    && /请求体必须是 JSON 对象/.test(serveSrc),
    'readBody 没做对象收口');
  check('除 readBody 外不许有第二条"是不是对象"的判断散在各条边上（一处兑现，18 条边自动受管）',
    (serveSrc.match(/typeof parsed !== 'object'|typeof body !== 'object'/g) || []).length === 1,
    '有路由自己补了一份，两处迟早分家');

  // 不可寻址的目录：不进列表、不进本数，但必须在体检里看得见
  const healthFn22 = /export function healthCheck\(\) \{[\s\S]*?\n\}/.exec(storeSrc22)?.[0] || '';
  // 体检产出两笔新账：返回清单里有它们（第十九轮"只写不读"那个洞的形状），
  // 并且两个长度都进了 ok 的判据——报了却不影响 ok 就是"报了但没人需要管"。
  {
    const returnList = /return \{\n[\s\S]{0,900}?\n  \};\n\}/.exec(healthFn22)?.[0] || '';
    const okLine = /\n    ok:[\s\S]*?dataDir:/.exec(healthFn22)?.[0] || '';
    check('体检的返回清单里有这两笔账（写了就得有人读得着）',
      /unaddressableDirs,/.test(returnList) && /identityDrift,/.test(returnList),
      returnList ? returnList.replace(/\s+/g, ' ').slice(0, 220) : '找不到 healthCheck 的 return');
    check('两笔账都进 ok（报了却不影响 ok = 白报，与第二十轮鬼目录同一条口径）',
      /ghostDirs\.length === 0 && unaddressableDirs\.length === 0 && identityDrift\.length === 0/.test(okLine),
      okLine ? okLine.replace(/\s+/g, ' ').slice(0, 200) : '找不到 ok 那一句');
  }
  check('列表不发点不开的行：不可寻址的目录不进列表（safeId 不过就 continue）',
    /if \(!safeId\(name\)\) continue;/.test(listFn22), '列表开始发打不开的地址了');
  check('体检把不可寻址的目录排除在本数之外（数成一本书=假装它打得开）',
    /if \(!safeId\(id\)\) \{[\s\S]{0,300}?unaddressableDirs\.push[\s\S]{0,60}?continue;\s*\}\s*notebooks \+= 1;/.test(healthFn22)
    || /if \(!safeId\(id\)\)[\s\S]*?continue;[\s\S]*?notebooks \+= 1;/.test(healthFn22),
    '本数开始把打不开的目录数进去了');
  // 这一条对着"汇总行"那一处的形状，不对着全文里出现过这个词：明细行也写着同一句话，
  // 只钉词的话汇总行被改掉照样绿（变异 m15 抓到的就是这个）。
  check('前端把这两笔账接进汇总行（写了没人读=没写：第十九轮 jobs 那个洞的反面）',
    /Array\.isArray\(report\.unaddressableDirs\)/.test(webSrc22) && /Array\.isArray\(report\.identityDrift\)/.test(webSrc22)
    && /issues\.push\(`打不开的目录 \$\{unaddressable\.length\} 处/.test(webSrc22)
    && /issues\.push\(`盘上写的 id 与目录名对不上 \$\{drift\.length\} 处/.test(webSrc22),
    '汇总行没渲染这两笔账');
  // 这一条否定的是"代码里长出一个会动盘的键"，不是"文档里出现这个词"——
  // 注释里本来就要说明为什么不给这个键，连着注释一起禁就是自己钉自己。
  // 面板上真的没有这种按钮由 web-smoke §38 从行为那一侧钉（读渲染出来的按钮文本）。
  const webCode22 = webSrc22.split('\n')
    .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')); })
    .join('\n');
  check('不给"一键修"的键（改盘上那行与删目录都是动数据，由人拍板）',
    !/一键修|修好身份|自动对齐/.test(webCode22), '面板长出了会动盘的键');

  // README：钉语义不钉关键词（第十八轮 §4.1 与第二十一轮 m24 的同一类病）
  const idDoc = /### 身份只有一个来源[\s\S]{0,3200}?(?=\n### |\n## )/.exec(readmeDoc);
  check('README 写明两个来源各是谁、四个实测后果、以及"地址是目录名"这一句口径',
    Boolean(idDoc) && /目录名/.test(idDoc[0]) && /meta\.id/.test(idDoc[0])
    && /两行同一个 id/.test(idDoc[0]) && /从列表消失/.test(idDoc[0]) && /随导出旅行/.test(idDoc[0]),
    idDoc ? idDoc[0].replace(/\n+/g, ' ').slice(0, 200) : '找不到这一节');
  check('README 写明守卫站在动手那一侧（touchNotebook/sanitiseMetaPatch），不是"路由清洗过了"',
    Boolean(idDoc) && /sanitiseMetaPatch/.test(idDoc[0]) && /守卫站在动手那一侧/.test(idDoc[0]),
    idDoc ? '那一节没写守卫的位置' : '找不到这一节');
  check('README 写明漂了的旧数据由下一次写入自己对齐 + 体检点名（不需要人手工修盘）',
    Boolean(idDoc) && /identityDrift/.test(idDoc[0]) && /unaddressableDirs/.test(idDoc[0])
    && /下一次写入/.test(idDoc[0]),
    idDoc ? '那一节没写这两笔账' : '找不到这一节');
  check('README 写明请求体收口在唯一读口（不逐条边补）',
    Boolean(idDoc) && /readBody/.test(idDoc[0]) && /必须是 JSON 对象/.test(idDoc[0]),
    idDoc ? '那一节没写这条收口' : '找不到这一节');
}

// ──────────────────────────────── 备份要经得起坏的时候（第二十三轮）
//
// 这一节全部对着**结构与口径**，不对着注释：素材"是什么"这个概念全仓只许有一处定义；
// 导出前那道检查用的必须与体检同一份清单；缺口清单要从 store 一路走到界面。
// 行为本身由 run.mjs §12a（单元）、http-smoke §26（真服务）、web-smoke（前端）三处钉。
{
  const storeSrc23 = fs.readFileSync(path.join(app, 'server', 'store.mjs'), 'utf8');
  const webSrc23 = fs.readFileSync(path.join(app, 'web', 'app.js'), 'utf8');

  // 1) kind 只有一处认扩展名
  const classify23 = /function classifyUpload\(name\) \{[\s\S]*?\n\}/.exec(storeSrc23)?.[0] || '';
  check('认扩展名只有一处（写侧/读侧/导出侧共用 classifyUpload）',
    (storeSrc23.match(/IMAGE_EXT\.has\(/g) || []).length === 1
    && (storeSrc23.match(/TEXT_EXT\.has\(/g) || []).length === 1
    && /IMAGE_EXT\.has\(ext\)/.test(classify23) && /TEXT_EXT\.has\(ext\)/.test(classify23)
    && /return 'image'/.test(classify23) && /return 'text'/.test(classify23) && /return 'binary'/.test(classify23),
    `IMAGE_EXT.has=${(storeSrc23.match(/IMAGE_EXT\.has\(/g) || []).length} TEXT_EXT.has=${(storeSrc23.match(/TEXT_EXT\.has\(/g) || []).length}`);
  // 三处调用点必须真的走它，而不是留着各自的 ternary（"定义收成一份、判断还散着"是最常见的一次也没改干净）
  const saveFn23 = /export function saveUpload\(id, filename, buffer\) \{[\s\S]*?\n\}/.exec(storeSrc23)?.[0] || '';
  const listFnU23 = /export function listUploads\(id\) \{[\s\S]*?\n\}/.exec(storeSrc23)?.[0] || '';
  const readFn23 = /export function readUpload\(id, relOrName\) \{[\s\S]*?\n\}/.exec(storeSrc23)?.[0] || '';
  check('写侧 / 列表 / 读侧三处都调它（旧的两档 ternary 一处不许留在原地）',
    /classifyUpload\(safeName\)/.test(saveFn23) && /classifyUpload\(name\)/.test(listFnU23) && /classifyUpload\(name\)/.test(readFn23)
    && !/kind: IMAGE_EXT\.has/.test(saveFn23) && !/kind: IMAGE_EXT\.has/.test(listFnU23),
    `${saveFn23.includes('classifyUpload') ? 'save✓' : 'save✗'}${listFnU23.includes('classifyUpload') ? 'list✓' : 'list✗'}${readFn23.includes('classifyUpload') ? 'read✓' : 'read✗'}`);

  // 2) 编码只有一处推导，包体与解码说同一句话
  const encFn23 = /function encodingFor\(kind\) \{[\s\S]*?\n\}/.exec(storeSrc23)?.[0] || '';
  const exportFn23 = /export function exportNotebook\(id\) \{[\s\S]*?\n\}/.exec(storeSrc23)?.[0] || '';
  const importFn23 = /export function importNotebook\(bundle\) \{[\s\S]*?\n\}/.exec(storeSrc23)?.[0] || '';
  const decodeFn23 = /function decodeUploadBuffer\(u\) \{[\s\S]*?\n\}/.exec(storeSrc23)?.[0] || '';
  check('进包一侧的编码出自 encodingFor（不许再按 kind 自己 ternary 一次）',
    /encoding: encodingFor\(kind\)/.test(exportFn23) && /data: dataFor\(kind, buffer\)/.test(exportFn23)
    && !/encoding: u\.kind === 'image'/.test(exportFn23),
    exportFn23 ? (exportFn23.match(/encoding:[^\n]*/) || [''])[0] : '找不到 exportNotebook');
  check('全仓只有一处把 kind 映射到编码（写侧、导出侧、导入侧共用一份规则）',
    (storeSrc23.match(/=== 'text' \? 'utf8' : 'base64'/g) || []).length === 1
    && /'utf8'/.test(encFn23) && /'base64'/.test(encFn23),
    `utf8/base64 映射出现 ${(storeSrc23.match(/=== 'text' \? 'utf8' : 'base64'/g) || []).length} 次`);
  // 唯一收口（第二十一/二十二轮同一条纪律）：解码不许在校验和落盘两处各写一遍
  check('素材解码收在唯一的 decodeUploadBuffer（校验那遍就是落盘那份）',
    /decodeUploadBuffer\(u\)/.test(importFn23) && !/Buffer\.from\(String\(u\.data/.test(importFn23)
    && (importFn23.match(/decodeUploadBuffer\(u\)/g) || []).length === 1,
    `import 内调用=${(importFn23.match(/decodeUploadBuffer\(u\)/g) || []).length} 处，直接 Buffer.from=${(importFn23.match(/Buffer\.from/g) || []).length} 处`);
  check('编码不认识时拒绝，不"按 utf8 兜"（兜一次就等于替包主人重新发明编码）',
    /encoding !== 'utf8' && u\.encoding !== 'base64'/.test(decodeFn23),
    decodeFn23 ? decodeFn23.replace(/\s+/g, ' ').slice(0, 160) : '找不到 decodeUploadBuffer 本体');
  check('字节数校验不再看 bytes > 0 的脸色（0 字节也要逐项对得上）',
    /if \(buffer\.length !== Number\(u\.bytes\)\)/.test(importFn23)
    && !/if \(String\(u\.bytes \|\| 0\) > 0\)/.test(importFn23),
    importFn23 ? (importFn23.match(/if \(.*bytes.*/) || [''])[0] : '找不到 importNotebook');
  check('落盘不再"没内容就不写"（空文件也要在新区存在）',
    /fs\.writeFileSync\(path\.join\(dir, String\(u\.rel\)\), uploadBuffers\[i\]\)/.test(importFn23)
    && !/if \(buffer\.length\) fs\.writeFileSync/.test(importFn23),
    importFn23 ? (importFn23.match(/.*writeFileSync\(path\.join\(dir, String\(u\.rel.*/) || [''])[0] : '找不到落盘那一段');

  // 3) 坏的时候不许出货：判据必须与体检同一份清单
  const blockFn23 = /function backupBlockers\(id\) \{[\s\S]*?\n\}/.exec(storeSrc23)?.[0] || '';
  const healthFn23 = /export function healthCheck\(\) \{[\s\S]*?\n\}/.exec(storeSrc23)?.[0] || '';
  check('「该有哪些 JSON」全仓只有一份清单（体检与导出前检查共用，不各自数一遍）',
    (storeSrc23.match(/const HEALTH_FILES = \[/g) || []).length === 1
    && /for \(const name of HEALTH_FILES\)/.test(blockFn23)
    && /for \(const name of HEALTH_FILES\)/.test(healthFn23),
    `定义 ${(storeSrc23.match(/const HEALTH_FILES = \[/g) || []).length} 处；backupBlockers 用它=${/HEALTH_FILES/.test(blockFn23)}`);
  check('缺口检查只认"存在但坏了"（缺文件是正常状态，不许把它当损坏拒绝）',
    /fs\.existsSync\(file\) && corruptNow\(file\)/.test(blockFn23),
    blockFn23 ? (blockFn23.match(/if \(fs\.existsSync.*/) || [''])[0] : '找不到 backupBlockers 本体');
  check('空壳制品也在拒绝的判据里（manifest 有记录、index.html 不在）',
    /index\.html/.test(blockFn23) && /existsSync\(path\.join\(artifactsDir, aid, 'index\.html'\)\)/.test(blockFn23),
    blockFn23 ? (blockFn23.match(/.*index\.html.*/) || [''])[0] : '找不到空壳那一段');
  check('manifest 自己坏了也要停下来（制品整批漏掉与少一份 JSON 同一条形状）',
    /corruptNow\(manifestFile\)/.test(blockFn23),
    blockFn23 ? (blockFn23.match(/.*manifestFile.*/) || [''])[0] : '找不到 manifest 那一段');
  check('导出真的问了这道门（拒绝在出货之前，不是包好了再补一句警告）',
    /const blockers = backupBlockers\(id\);\n    if \(blockers\.length\)|const blockers = backupBlockers\(id\);\n  if \(blockers\.length\)/.test(exportFn23)
    && /throw new BackupBlockedError/.test(exportFn23),
    exportFn23 ? exportFn23.replace(/\s+/g, ' ').slice(0, 160) : '找不到 exportNotebook');
  check('拒绝的状态是 409（请求本身没错，是资源此刻的状态不允许——与"回合进行中不许删"同一类）',
    /class BackupBlockedError extends Error \{[\s\S]*?this\.status = 409;/.test(storeSrc23),
    'BackupBlockedError 不是 409');

  // 4) 清单要一路走到界面（写了没人读 = 没写）
  check('sendError 把 blockers 发给前端（错误对象上带着清单，接口层不许丢）',
    /blockers: err\?\.blockers \?\? undefined/.test(serveSrc), 'serve 的 sendError 不带 blockers');
  check('前端读的是结构化清单，不是从 error 那句话里抠文件名',
    /Array\.isArray\(err\.data\?\.blockers\)/.test(webSrc23) && /没能备份：\$\{blockers\.slice\(0, 3\)/.test(webSrc23),
    webSrc23 ? (webSrc23.match(/const blockers = [^\n]*/) || [''])[0] : '找不到 app.js');
  check('受阻的提示说清下一步去哪（点名 + 指向体检取证）',
    /没能备份/.test(webSrc23) && /体检/.test(webSrc23),
    '前端只念了一句失败');
  const webCode23 = webSrc23.split('\n')
    .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')); })
    .join('\n');
  check('素材图标由一处按三档给（image/text/binary 各一个，不许再写两档 ternary）',
    /const UPLOAD_ICON = \{ image: '🖼', text: '📄', binary: '📦' \};/.test(webSrc23)
    && !/kind === 'image' \? '🖼' : '📄'/.test(webCode23),
    `残留两档写法 ${(webCode23.match(/kind === 'image' \? '🖼' : '📄'/g) || []).length} 处`);

  // 5) 文档不许写旧口径：这一节只钉语义，关键词由 README 那节负责
  const backupDoc23 = /### 备份要经得起坏的时候[\s\S]{0,4000}?(?=\n### |\n## )/.exec(readmeDoc);
  check('README 写明三条实测后果（PDF 毁整本、空文件蒸发、坏了还少一份报成功）',
    Boolean(backupDoc23) && /U\+FFFD/.test(backupDoc23[0]) && /概念数 0/.test(backupDoc23[0])
    && /新机|查无此件/.test(backupDoc23[0]),
    backupDoc23 ? backupDoc23[0].replace(/\n+/g, ' ').slice(0, 160) : '找不到这一节');
  check('README 写明守卫站在动手那一侧（导出前拒绝，不是导入时补救）',
    Boolean(backupDoc23) && /backupBlockers/.test(backupDoc23[0]) && /blockers/.test(backupDoc23[0])
    && /409/.test(backupDoc23[0]),
    backupDoc23 ? '那一节没写守卫位置' : '找不到这一节');
  check('README 写明"缺文件不是损坏"这条边界（否则正常的新本会被自己的守卫拦死）',
    Boolean(backupDoc23) && /缺文件不是损坏/.test(backupDoc23[0]),
    backupDoc23 ? '那一节没写这条边界' : '找不到这一节');
  check('README 的备份一节写了口径只有一份（classifyUpload / encodingFor 有名分）',
    Boolean(backupDoc23) && /classifyUpload/.test(backupDoc23[0]) && /encodingFor|同一处定义|一处/.test(backupDoc23[0]),
    backupDoc23 ? '那一节没写单一定义' : '找不到这一节');

  // 6) "七份"这个数字以前是错的（白名单实际八项）。这一条把数字钉在数组上，不让人再抄一遍错的。
  const keysFn23 = /const IMPORT_FILE_KEYS = new Set\(\[([\s\S]*?)\]\);/.exec(storeSrc23)?.[1] || '';
  const keyCount23 = keysFn23.split(',').map((s) => s.trim()).filter(Boolean).length;
  const exportList23 = /for \(const name of \[NOTEBOOK_FILE,[\s\S]*?\]\)/.exec(storeSrc23)?.[0] || '';
  check('白名单项数与导出遍历项数一致（两份清单不各自长）',
    keyCount23 === 8 && /NOTES_FILE/.test(keysFn23) && exportList23.length > 0,
    `IMPORT_FILE_KEYS=${keyCount23} 项`);
  const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  check('文档与报错里的份数就是数组的真实长度（"七份"是抄来的，抄错一次就永远错下去）',
    (storeSrc23.match(/只认这(\S)份已知 JSON 文件/) || [])[1] === CN_NUM[keyCount23]
    && (storeSrc23.match(/白名单内的(\S)份 JSON/) || [])[1] === CN_NUM[keyCount23]
    && (storeSrc23.match(/扫描范围两处：每本学习的(\S)份 JSON/) || [])[1] === CN_NUM[keyCount23]
    && /(\S)份 JSON 解析失败/.test(storeSrc23) && (storeSrc23.match(/(\S)份 JSON 解析失败/) || [])[1] === CN_NUM[keyCount23]
    && /八份 JSON \+ 素材/.test(readmeDoc) && /只认八份已知 JSON 键/.test(readmeDoc)
    && /(\S)份 JSON 里解析失败/.test(readmeDoc) && (readmeDoc.match(/(\S)份 JSON 里解析失败/) || [])[1] === CN_NUM[keyCount23]
    && !/七份/.test(storeSrc23) && !/七份/.test(readmeDoc),
    `数组 ${keyCount23} 项；store 注释=${(storeSrc23.match(/只认这(\S)份/) || [])[1]}；报错=${(storeSrc23.match(/白名单内的(\S)份/) || [])[1]}；README=${(readmeDoc.match(/(\S)份 JSON \+ 素材/) || [])[1]}`);
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exitCode = failed === 0 ? 0 : 1;
