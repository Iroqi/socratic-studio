// 端到端测试：用 pi-ai 的 faux provider 驱动完整教学回合，不需要任何 API key。
//
// 覆盖：
//   1. Learning Graph 严格校验（好/坏两种）
//   2. 拓扑排序
//   3. 状态转移守卫（一次一级 / 升级要 observed 证据 / 未验证自报降级特例）
//   4. 完整 agentic 回合：模型调 update_learning_graph → ask_user_question（阻塞）
//      → 学习者作答 → 模型继续 → set_progress_state
//   5. 提问卡真的阻塞在服务端，作答真的作为 toolResult 回到模型

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-test-'));
process.env.SOCRATIC_DATA_DIR = tmpRoot;

const { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, validateToolCall } =
  await import('@earendil-works/pi-ai');
const { validateGraph, topoSortConcepts, GraphValidationError } = await import('../server/graph.mjs');
const { checkTransition, runTurn, buildTools, TOOL_NAMES, seedArtifacts, normalizeAskOptions, unwrapStructuredArgs, historyToModelMessages, carryOverConcept, TeachingSession } =
  await import('../server/agent.mjs');
const store = await import('../server/store.mjs');
const { crc32 } = await import('../server/zip.mjs');
const { ensureDirs, NOTEBOOKS_DIR, notebookExists, safeId } = await import('../server/config.mjs');
const { jevDecide, normalizeAnswers, validateQuestions, mergeJevConfig, panelDecisionOpts, buildDecisionFetch, jevPing, DecisionError } = await import('../server/decision.mjs');

ensureDirs();

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
function section(title) {
  console.log(`\n${title}`);
}

// ─────────────────────────────────────── 1. Graph 校验

section('1. Learning Graph 严格校验');

const goodGraph = {
  meta: { topic: 'JavaScript 闭包', goal: '在项目里用对闭包', pedagogy: 'programming' },
  concepts: [
    {
      id: 'variable-scope',
      name: '作用域',
      summary: '变量可被访问的代码区域',
      depends_on: [],
      misconceptions: ['混淆词法作用域与动态作用域'],
      observable_skills: ['能解释词法作用域与动态作用域的区别'],
      assessment_items: [{ type: 'recall', prompt: '内层函数能读到外层变量，是词法还是动态作用域？' }],
    },
    {
      id: 'closures',
      name: '闭包',
      summary: '函数连同其词法环境的引用',
      depends_on: ['variable-scope'],
      misconceptions: ['闭包复制变量'],
      confused_with: ['variable-scope'],
    },
  ],
};

check('合法的 Graph 通过校验', validateGraph(goodGraph) === true);

const badCases = [
  ['缺 meta.pedagogy 必须失败', { meta: { topic: 'x' }, concepts: goodGraph.concepts }],
  ['未知字段必须失败', { ...goodGraph, extra: 1 }],
  ['悬空依赖必须失败', { meta: goodGraph.meta, concepts: [goodGraph.concepts[1]] }],
  [
    'assessment_items 形状错误必须失败',
    {
      meta: goodGraph.meta,
      concepts: [{ id: 'a', name: 'A', summary: 's', assessment_items: [{ type: 'quiz', prompt: 'p' }] }],
    },
  ],
  [
    '非法 importance 必须失败',
    { meta: goodGraph.meta, concepts: [{ id: 'a', name: 'A', summary: 's', importance: 'critical' }] },
  ],
  [
    '未知嵌套字段必须失败',
    { meta: { ...goodGraph.meta, learner_profile: { nickname: 'x' } }, concepts: goodGraph.concepts },
  ],
  [
    'known_concepts 引用不存在的 concept 必须失败',
    { meta: { ...goodGraph.meta, learner_profile: { known_concepts: ['nope'] } }, concepts: goodGraph.concepts },
  ],
];
for (const [name, graph] of badCases) {
  let threw = false;
  try {
    validateGraph(graph);
  } catch (e) {
    threw = e instanceof GraphValidationError;
  }
  check(name, threw);
}

section('2. 拓扑排序');
const ordered = topoSortConcepts(goodGraph).map((c) => c.id);
check('依赖在前', ordered.indexOf('variable-scope') < ordered.indexOf('closures'), ordered.join(' → '));
let cyclic = false;
try {
  topoSortConcepts({
    meta: goodGraph.meta,
    concepts: [
      { id: 'a', name: 'A', summary: 's', depends_on: ['b'] },
      { id: 'b', name: 'B', summary: 's', depends_on: ['a'] },
    ],
  });
} catch {
  cyclic = true;
}
check('环必须被拒绝', cyclic);

// ─────────────────────────────────────── 3. 状态转移守卫

section('3. 状态转移守卫（runtime.md §1.2）');
check('unknown → seen 允许（首次接触即转换）', checkTransition('unknown', 'seen', {}).ok);
check('seen → understood 无证据时拒绝', !checkTransition('seen', 'understood', {}).ok);
check('seen → understood 带 observed 证据时允许', checkTransition('seen', 'understood', { evidence: '说对了' }).ok);
check('unknown → applied 跨级必须拒绝', !checkTransition('unknown', 'applied', { evidence: 'x' }).ok);
check('applied → mastered 带证据允许', checkTransition('applied', 'mastered', { evidence: 'x' }).ok);
check('未验证自报 understood → seen 单次错误即降级', checkTransition('understood', 'seen', { unverified: true }).ok);
check('applied → unknown 跨两级降级拒绝', !checkTransition('applied', 'unknown', {}).ok);
check('mastered → applied 单级降级允许（mastery_challenge_failed）', checkTransition('mastered', 'applied', {}).ok);
check('非法 state 值拒绝', !checkTransition('seen', 'pretty-good', {}).ok);

// ─────────────────────────────────────── 4. 完整回合

section('4. 完整教学回合（faux provider，无 API key）');

const faux = fauxProvider({ provider: 'faux', tokensPerSecond: 0 });
const models = createModels();
models.setProvider(faux.provider);
const fauxModel = faux.getModel();

const registry = {
  models,
  resolveModel: () => fauxModel,
};

const meta = store.createNotebook({ topic: 'JavaScript 闭包', goal: '在项目里用对闭包', pace: 'normal' });
const nb = store.getNotebook(meta.id);

const events = [];
const emit = (e) => events.push(e);
let askedQuestion = null;
let sessionRef = null;

// 模型脚本：
//  第 1 步：建 Graph
//  第 2 步：提问（阻塞）
//  第 3 步：推进状态
faux.setResponses([
  fauxAssistantMessage(
    [
      fauxText('我先把这块拆成两个概念，看看顺序对不对。\n\n1. 作用域\n2. 闭包\n\n⛔ 等待你的确认'),
      fauxToolCall(TOOL_NAMES.SAVE_GRAPH, {
        topic: 'JavaScript 闭包',
        goal: '在项目里用对闭包',
        pedagogy: 'programming',
        concepts: goodGraph.concepts,
      }),
    ],
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage(
    [
      fauxText('先别查——你猜外层函数已经 return 之后，里层还能不能读到外层当时的变量？'),
      fauxToolCall(TOOL_NAMES.ASK, {
        id: 'closures:q_outer_var',
        concept_id: 'closures',
        header: '探针',
        question: '外层函数已经 return 了，里层函数还能读到外层当时的变量吗？',
        options: [
          { label: '能读到', description: '里层还握着那个变量' },
          { label: '读不到', description: '外层一结束变量就没了' },
        ],
      }),
    ],
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage(
    [
      fauxText('对，它握着的是那个绑定本身。'),
      fauxToolCall(TOOL_NAMES.SET_PROGRESS, {
        updates: [
          {
            concept_id: 'closures',
            state: 'seen',
            next_action: '讲解最小缺口→PREDICT',
            evidence: '学习者答出「能读到」，理由是对的',
          },
        ],
        events: [{ concept_id: 'closures', kind: 'observed', summary: '答对了循环外的探针' }],
        session_note: '冷启动探针一次答对',
      }),
    ],
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage([fauxText('那换个问法再确认一下。')]),
]);

// 等提问事件出现后作答——这正是即时反馈回路的验证点：
// 服务端必须真的停在 ask_user_question 上，等外部 resolve。

const stepMessages = [];
const turnPromise = runTurn({
  registry,
  notebook: nb,
  history: [{ role: 'user', content: '教我闭包', timestamp: Date.now() }],
  modelRef: { provider: 'faux', model: fauxModel.id },
  emit,
  signal: new AbortController().signal,
  systemPrompt: '（测试用）',
  onSession: (session) => {
    sessionRef = session;
  },
  // 每步正文落盘回调：刷新页面不许丢已经讲出来的内容
  onPersistMessage: (msg) => stepMessages.push(msg),
});

const answerWhenAsked = (async () => {
  for (let i = 0; i < 400; i += 1) {
    const evt = events.find((e) => e.type === 'ask');
    if (evt) {
      askedQuestion = evt;
      const ok = sessionRef.answer(evt.questionId, { selected: ['能读到'], text: '因为函数记住了它出生时的环境' });
      check('作答被会话接收', ok === true);
      return true;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
})();

const answered = await answerWhenAsked;
const result = await turnPromise;

check('提问事件到达前端', answered);
check('提问带上了教学坐标 id', askedQuestion?.questionId === 'closures:q_outer_var', JSON.stringify(askedQuestion?.questionId));
check('提问带上了可枚举选项', (askedQuestion?.options || []).length === 2);
// 取景（相机）只能靠这个把手：落盘的题记录里有 conceptId，可 SSE 没带，
// 于是刷新后知道这道题在问哪个概念、当场却不知道。
check('提问事件把教学坐标一起推给前端', askedQuestion?.conceptId === 'closures', JSON.stringify(askedQuestion?.conceptId));
check('Graph 已保存', result.graph?.concepts?.length === 2);
check('Graph 保存后走校验', result.graph.concepts[1].depends_on[0] === 'variable-scope');
check(
  '新 concept 初始化为待学',
  Object.values(nb.progress.concepts).length === 0 && result.progress.concepts['closures'] !== undefined,
);
check('状态推进为 seen', result.progress.concepts['closures'].state === 'seen', result.progress.concepts['closures'].state);
check(
  '状态来自 observed 证据',
  String(result.progress.concepts['closures'].last_evidence || '').includes('能读到'),
);
check('事件已记录', (result.events || []).some((e) => e.kind === 'observed'));
check(
  '工具结果里有学习者的作答（回传成功）',
  JSON.stringify(events.filter((e) => e.type === 'tool_end').map((e) => e.name)) !== '',
);
// 回归：正文按 step 增量落盘（"一刷新内容就没了"的根因是只在整轮结束时 append 一次）
check('每一步正文都走了落盘回调', stepMessages.length === result.messages.length,
  `落盘 ${stepMessages.length} 条 / 返回 ${result.messages.length} 条`);
check('落盘消息带 msgId（幂等 upsert 的键）', stepMessages.every((m) => typeof m.msgId === 'string' && m.msgId.length > 0),
  JSON.stringify(stepMessages.map((m) => m.msgId)));
check('落盘消息的 msgId 不重复', new Set(stepMessages.map((m) => m.msgId)).size === stepMessages.length,
  stepMessages.map((m) => m.msgId).join(','));
check('落盘内容就是返回内容', JSON.stringify(stepMessages) === JSON.stringify(result.messages));

// ─────────────────────────────────────── 5. 非法状态转移被拒

section('5. 非法状态转移被引擎拒绝');
const session = sessionRef;
// 一个全新会话的空壳：只验证 seedArtifacts 能把落盘数据搬回来。
// artifactEvidenceView 只依赖 this.liveArtifacts，所以够用了。
const fresh = { liveArtifacts: new Map() };
const viewOf = (obj, id) => session.artifactEvidenceView.call(obj, id);
const before = session.progress.concepts['closures'].state;
const rejected = await session.execSetProgress({
  updates: [{ concept_id: 'closures', state: 'mastered' }],
});
check('seen → mastered 跨级被拒', rejected.ok === false && rejected.rejected?.length === 1, JSON.stringify(rejected));
check('被拒后状态不变', session.progress.concepts['closures'].state === before);

// ─────────────────────────────────────── 6. 制品：不判分

section('6. 制品工具');
const artEvents = events.filter((e) => e.type === 'artifact');
await session.execShareArtifact({
  title: '共享一个绑定',
  html: '<html><body><p>三个背包客共用一个盒子</p></body></html>',
  kind: 'illustration',
});
check('制品事件发出', events.filter((e) => e.type === 'artifact').length === artEvents.length + 1);

// 道具是有寿命的东西：每一件都落盘、都寻得到址。以前 share_artifact 分两支——带 persist
// 才写文件，否则发一个 `inline-N` 合成号、整份 HTML 只嵌在 chat.json 里（实测那件 23,135
// 字符的「正则试错场」就是这样，artifacts/ 目录空着）。没有地址就续不了玩、也撤不下来。
// 这三条以前一条都没钉住：删掉 persist 那一支之后三套测试全绿，本身就是发现。
const noArgArtifact = events.filter((e) => e.type === 'artifact').at(-1).artifact;
check('模型什么都没带（旧的那一支）也落盘了',
  fs.existsSync(path.join(tmpRoot, 'notebooks', session.notebook.id, noArgArtifact.rel)), noArgArtifact.rel);
check('id 就是目录名，不再是 inline-N 合成号',
  noArgArtifact.id === noArgArtifact.rel.split('/')[1] && !noArgArtifact.id.startsWith('inline-'),
  `${noArgArtifact.id} | ${noArgArtifact.rel}`);
check('事件里不再带 persisted（恒真是废话，留着说明两支没合成一支）',
  !('persisted' in noArgArtifact), JSON.stringify(Object.keys(noArgArtifact)));
const manifestListed = store.getNotebook(session.notebook.id).artifacts;
check('manifest 认得这件（刷新后宿主还找得到它）',
  manifestListed.some((a) => a.id === noArgArtifact.id && a.rel === noArgArtifact.rel),
  `${manifestListed.length} 件`);
const noArgResult = await session.execShareArtifact({ title: '同样没有参数', html: '<p>x</p>' });
check('工具返回值只剩一条说法（不再"要留档就带 persist"）',
  noArgResult.note.startsWith('制品已落盘') && !noArgResult.note.includes('persist'), noArgResult.note);

// ─────────────────────────────────────── 6a. 道具的寿命：软退役

section('6a. 道具的寿命（扔掉 = 打上时间戳，绝不删文件）');

// discardable 落到工程上只有一个形状：学习者能把道具从工作集撤下来，但撤的是"在用"，
// 不是"存在"。文件、manifest 那一行、他在这件里做过的记录都得留着，因为找回的入口
// 就在「素材」页——那一页靠 manifest 里的这一行活着。
const thrown = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const nbId = session.notebook.id;
const liveArtifact = noArgArtifact;
const artCountBefore = store.getNotebook(nbId).artifacts.length;
const artFileOnDisk = path.join(tmpRoot, 'notebooks', nbId, liveArtifact.rel);

const retiredItem = store.setArtifactLifetime(nbId, liveArtifact.id, true);
check('扔掉就是在 manifest 上盖一个时间戳（别的字段一个字没动）',
  !!retiredItem.retiredAt && retiredItem.id === liveArtifact.id && retiredItem.rel === liveArtifact.rel &&
    retiredItem.title === liveArtifact.title,
  JSON.stringify(retiredItem));
check('扔掉绝不删文件（软退役要能反着走，删了就回不去）', fs.existsSync(artFileOnDisk));
check('manifest 里那一行还在（「素材」页的找回入口靠它）',
  store.getNotebook(nbId).artifacts.some((a) => a.id === liveArtifact.id),
  `${store.getNotebook(nbId).artifacts.length} 件`);

const restoredItem = store.setArtifactLifetime(nbId, liveArtifact.id, false);
check('放回是把那个时间戳抹掉——键整个消失，不是留一个 null',
  !('retiredAt' in restoredItem) && !('retiredAt' in store.getNotebook(nbId).artifacts.find((a) => a.id === liveArtifact.id)),
  JSON.stringify(restoredItem));
check('抹掉时间戳也不碰文件', fs.existsSync(artFileOnDisk));

// 两条都必须报出**状态码**：光"抛了个错"是弱钉子——去掉守门之后 path.join(null) 也抛，
// 但那是 500（TypeError），学习者点一下就看到一堵错误页，不是一句"这件道具不存在"。
check('非法制品 id 报 400（这条路由学习者点出来，输入不许当路径用）',
  thrown(() => store.setArtifactLifetime(nbId, '../evil', true))?.status === 400,
  JSON.stringify({ status: thrown(() => store.setArtifactLifetime(nbId, '../evil', true))?.status }));
check('manifest 里没有的那件报 404，不许静默造一条',
  thrown(() => store.setArtifactLifetime(nbId, 'no-such-artifact', true))?.status === 404,
  thrown(() => store.setArtifactLifetime(nbId, 'no-such-artifact', true))?.message);
check('扔掉/放回这条路不新增制品（前后同样多件）',
  store.getNotebook(nbId).artifacts.length === artCountBefore,
  `${store.getNotebook(nbId).artifacts.length} vs ${artCountBefore}`);

// ─────────────────────────────────────── 6b. 制品证据回路（原版契约移植）

section('6b. 制品证据回路（artifact.md §13.1）');

// 制品里读到的证据必须能被 record → 读回 → 去重
const evidenceBefore = session.artifactEvidenceView().artifacts.length;
await session.execShareArtifact({
  title: '背包客',
  description: '看盒子',
  kind: 'interactive',
  html: `<div data-interaction='{"options":[]}' data-interaction-type="choice"
        data-concept-id="closures" data-question-id="closures:q_box">
        <button data-choice-id="a"></button></div>`,
});
check('share_artifact 后制品进入证据视图', session.artifactEvidenceView().artifacts.length === evidenceBefore + 1);
check(
  '制品里声明的题号被识别',
  session.artifactEvidenceView().artifacts.some((a) => a.questions_declared.includes('closures:q_box')),
);

// 前端 postMessage 上来的证据
const accepted1 = session.recordArtifactEvidence({
  artifactId: 'inline-1',
  evidence: {
    concept_id: 'closures',
    question_id: 'closures:q_box',
    interaction_type: 'choice',
    response: 'a',
    result: 'incorrect',
    attempts: 1,
    completed: false,
  },
});
check('证据被接受', accepted1 === true);
const dup = session.recordArtifactEvidence({
  artifactId: 'inline-1',
  evidence: {
    concept_id: 'closures',
    question_id: 'closures:q_box',
    interaction_type: 'choice',
    response: 'a',
    result: 'incorrect',
    attempts: 1,
    completed: false,
  },
});
check('完全相同的证据被去重（不重复计数）', dup === false);

// 同一题再答一次（attempts 变了）应当算新记录
const accepted2 = session.recordArtifactEvidence({
  artifactId: 'inline-1',
  evidence: {
    concept_id: 'closures',
    question_id: 'closures:q_box',
    interaction_type: 'choice',
    response: 'b',
    result: 'correct',
    attempts: 2,
    completed: true,
    locked: true,
  },
});
check('同一题再次作答算新证据（不上 closeOut）', accepted2 === true);

const view = session.artifactEvidenceView('inline-1');
check('证据读回带答题次与结果', view.artifacts[0].evidence.some((e) => e.attempts === 2 && e.result === 'correct'));
check('证据带 concept 与 question 坐标', view.artifacts[0].evidence.every((e) => e.concept_id === 'closures' && e.question_id === 'closures:q_box'));
check(
  '证据读回带口径提醒（不是结论、不由缺记录反推）',
  /不要据此推断|不是结论|不等于/.test(view.note || ''),
  view.note,
);

// 读回视图不含数值化学习量
const evBlob = JSON.stringify(view);
check(
  '证据视图不含分数/百分比字段',
  !/score|percent|pct|progress_pct/i.test(evBlob),
);

// ─────────────────────────────────────── 6c. 制品装配：网络边界由宿主钉进文档

section('6c. 制品装配：CSP 由宿主钉进文档');
const {
  injectArtifactCsp,
  injectArtifactRuntime,
  ARTIFACT_CSP,
} = await import('../server/artifact.mjs');

// 这条字符串的每一段都是在真实沙盒 srcdoc 里对照量过的（node test/preview/csp-probe.mjs）：
// 禁 fetch 与外链图片，留内联 script / new Function / data: 图片。这里钉的是"字符串没漂"，
// 那个脚本钉的是"浏览器真按它执行"。
check('策略禁掉对外连接', /connect-src\s+'none'/.test(ARTIFACT_CSP), ARTIFACT_CSP);
check('策略仍允许内联脚本（注入的运行时靠它）', /script-src[^;]*'unsafe-inline'/.test(ARTIFACT_CSP));
check('策略仍允许 eval（"一个孔"要跑学习者写的代码）', /script-src[^;]*'unsafe-eval'/.test(ARTIFACT_CSP));
check('策略保留 data: 图片（内嵌素材不该一起禁掉）', /img-src[^;]*data:/.test(ARTIFACT_CSP));

const bare = '<!doctype html><html><head><title>T</title></head><body><p>hi</p></body></html>';
const withRuntime = injectArtifactRuntime(bare);
const assembled = injectArtifactCsp(withRuntime);
check('装配后制品文档里有 CSP meta', /http-equiv="Content-Security-Policy"/.test(assembled));
check(
  'CSP meta 落在运行时 <script> 之前（meta 在脚本之后就不约束那个脚本）',
  assembled.indexOf('Content-Security-Policy') < assembled.indexOf('data-socratic-runtime'),
);
check(
  '装配顺序反过来就失效（先 CSP 后运行时时，meta 落在脚本之后——证明上面那条顺序是真的约束）',
  injectArtifactRuntime(injectArtifactCsp(bare)).indexOf('Content-Security-Policy') >
    injectArtifactRuntime(injectArtifactCsp(bare)).indexOf('data-socratic-runtime'),
);
check('重复注入不叠第二条策略', injectArtifactCsp(assembled) === assembled);
check(
  '制品自己声明了 CSP 就不覆盖（尊重显式声明，别留两条打架）',
  injectArtifactCsp('<html><head><meta http-equiv="content-security-policy" content="default-src \'none\'">') ===
    '<html><head><meta http-equiv="content-security-policy" content="default-src \'none\'">',
);
check('没有 head 的残缺文档也能钉上', /Content-Security-Policy/.test(injectArtifactCsp('<p>裸片段</p>')));

// 端到端：真的走一次 share_artifact，落盘的那份 HTML 必须带策略（不是只测纯函数）
const e2e = await session.execShareArtifact({
  title: '一个孔探针',
  kind: 'project',
  html: '<!doctype html><html><head></head><body><textarea data-explore-input></textarea></body></html>',
});
const savedHtml = fs.readFileSync(
  path.join(tmpRoot, 'notebooks', session.notebook.id, e2e.rel),
  'utf8',
);
check('落盘的制品 HTML 带宿主注入的 CSP', /Content-Security-Policy/.test(savedHtml), e2e.rel);
check('落盘的制品 HTML 同时带运行时', /data-socratic-runtime/.test(savedHtml));
check(
  '工具返回值把"一个孔"的规格随结果交给模型（规则余量已经花光，工具层是唯一载体）',
  (e2e.contract || '').includes('一个孔') && (e2e.contract || '').includes('connect-src'),
  (e2e.contract || '').slice(0, 60),
);

// 「一个孔」的回报通道：制品只给现象（期望值 vs 实际值 + 试了几次），判对错仍留在对话里。
// 这里喂的是上面那份 fixture 真实会发出来的三种 payload。
const holeId = e2e.artifactId;
const hole1 = session.recordArtifactEvidence({
  artifactId: holeId,
  type: 'state',
  state: {
    attempts: 1,
    filled: false,
    cases: [
      { name: '新增行', expected: 'add', actual: 'unknown', ok: false },
      { name: '删除行', expected: 'del', actual: 'unknown', ok: false },
    ],
  },
});
check('孔的第一次运行被收下（state 通道）', hole1 === true);
check('跑不过时上报的是现象：期望值与实际值并存',
  JSON.stringify(session.liveArtifacts.get(holeId).state.cases).includes('"expected":"add"'));
session.recordArtifactEvidence({
  artifactId: holeId,
  type: 'state',
  state: { attempts: 2, filled: true, cases: [{ name: '新增行', expected: 'add', actual: 'add', ok: true }] },
});
const holeState = session.liveArtifacts.get(holeId).state;
check('再次上报是浅合并（attempts 覆盖成新值，不留旧副本）', holeState.attempts === 2, JSON.stringify(holeState.attempts));
check('孔被填上这件事以布尔值落进状态（不是分数）', holeState.filled === true);
// 一个 20 行的孔工具最自然的写法就是"变了什么报什么"（report({output})），
// 整替换会把 attempts / cases 全冲没——模型下一轮读回就看到一个凭空失忆的学习者。
session.recordArtifactEvidence({
  artifactId: holeId,
  type: 'state',
  state: { output: '+++ 新增行 / --- 删除行' },
});
const holeState2 = session.liveArtifacts.get(holeId).state;
check('只报变化字段也不冲掉旧状态（attempts 与 output 并存）',
  holeState2.attempts === 2 && holeState2.output === '+++ 新增行 / --- 删除行',
  JSON.stringify(holeState2));
check('运行失败与填上都是离散事件，模型读得到',
  session.recordArtifactEvidence({ artifactId: holeId, type: 'event', name: 'hole_filled', at: 't1' }) === true &&
  session.liveArtifacts.get(holeId).events.some((e) => e.name === 'hole_filled'));
check('孔的读回视图不含数值化学习量（评分是对话里的事）',
  !/score|percent|pct|mastery/i.test(JSON.stringify(session.artifactEvidenceView(holeId))));

// ─────────────────────────────────────── 6d. 导演台：场、相位、台面

section('6d. 导演台：Scene 是服务端的数据单元（相位没有时钟）');

const desk = await import('../server/scene.mjs');

// 纯状态机：台子的规则不依赖回合、依赖 HTTP，所以先把这几条钉在函数上。
const deskBare = desk.emptySceneState();
check('没开过场时快照一句都不出（空转的兜底句只会让模型去补一刀）',
  desk.renderSceneSnapshot(deskBare) === '' && desk.renderSceneSnapshot(null) === '');
let threw = null;
try { desk.openScene(deskBare, { title: '   ' }); } catch (err) { threw = err.message; }
check('开场不给场名就拒绝，不说假罪名', /场名/.test(threw || ''), threw);
threw = null;
try { desk.setPhase(deskBare, 'teach'); } catch (err) { threw = err.message; }
check('没开场就换相位被拒（相位是这一场的相位，不是全局计数器）', /还没开场/.test(threw || ''), threw);
threw = null;
try { desk.setPhase(desk.openScene(deskBare, { title: '变量的盒子' }), 'explaining'); } catch (err) { threw = err.message; }
check('未知相位被拒，并把可用的列出来', /未知相位/.test(threw || '') && /teach/.test(threw || ''), threw);

let one = desk.openScene(deskBare, { title: '变量的盒子', phase: 'teach', conceptId: 'var-scope' });
check('开场即第 1 场，id 稳定可寻', one.current.id === 'scene-01' && one.current.index === 1, JSON.stringify(one.current));
check('相位与场名都在（前端要能直接说出这一拍）',
  one.current.phase === 'teach' && one.current.title === '变量的盒子');
one = desk.placeProp(one, { id: 'box-1', title: '变量的盒子·拖拽', rel: 'artifacts/box-1/index.html' });
const phaseBefore = one.current.phase;
one = desk.placeProp(one, { id: 'box-1', title: '变量的盒子·拖拽', rel: 'artifacts/box-1/index.html' });
check('同一件道具摆两次只占一个位置（重复摆不是错误，不该长出两个台位）',
  one.current.props.length === 1, JSON.stringify(one.current.props));
check('摆道具不许顺带改相位（台子不会自己往下演）', one.current.phase === phaseBefore, one.current.phase);
// 台面只认 props 这一本账。placed / removed 是 2a 早期的废账：没有读者，还会跟 props 打脸
// （扔掉后 placed 仍说它在台上，放回后 removed 仍说它被撤下）。历史归 progress.artifact_events。
check('摆上去也不写第二本账（placed / removed 随这一刀一起退役）',
  !('placed' in one.current) && !('removed' in one.current), Object.keys(one.current).join(','));
one = desk.removeProp(one, '根本不在台上的那件');
check('撤下不在台上的道具是 no-op（不报错、也不清空台面）', one.current.props.length === 1);
// 撤下这一步单独在派生的一份上做：下面还要拿 one 验承台，不许把 box-1 提前撤走
const offDesk = desk.removeProp(one, 'box-1');
check('撤下之后记录里只剩 props 空了这一件（不在台上这件事只有一处说得出）',
  offDesk.current.props.length === 0 && !('placed' in offDesk.current) && !('removed' in offDesk.current),
  JSON.stringify(offDesk.current));

let two = desk.openScene(one, { title: '第二场：闭包' });
check('开下一场不清台：上一场的道具还在台上（跨段场景延续在数据层成立）',
  two.current.props.map((p) => p.id).join(',') === 'box-1', JSON.stringify(two.current.props));
check('新场记下是从哪一场接过来的', two.current.inheritedFrom === 'scene-01' && two.current.index === 2);
check('上一场连同它当时的台面进 log，并带上结束时刻（回看才知道接的是哪几件）',
  two.log.length === 1 && two.log[0].id === 'scene-01' && Boolean(two.log[0].endedAt));

// 照真实盘上的样子写：旧会话的 scene.json 里带着那两本废账，读进来必须被洗掉，
// 不许跟着内存漂到下一次写盘上。
const washed = desk.normaliseSceneState({ index: 7, current: { id: 'x', phase: '瞎写的', props: [{ title: '没有 id 的行' }, { id: 'ok' }], placed: '不是数组', removed: ['ok'] }, log: [{ id: 'old', placed: ['x'], removed: [] }] });
check('读回来的盘按现状洗：坏相位落回 open、没有 id 的道具行丢掉、log 只认数组',
  washed.current.phase === 'open' && washed.current.props.length === 1 && washed.log.length === 1,
  JSON.stringify(washed));
check('旧盘上那两本废账（placed / removed）读进来就洗掉，当前场和历史场都一样',
  !('placed' in washed.current) && !('removed' in washed.current) &&
    !('placed' in washed.log[0]) && !('removed' in washed.log[0]),
  `current=${Object.keys(washed.current)} log[0]=${Object.keys(washed.log[0])}`);
check('相位词表就是规则里那套教学动作（不自造第二套名字）',
  desk.PHASES.join(',') === 'open,teach,practice,assess,close', desk.PHASES.join(','));
// 无时钟是这一刀的立论本身：出现计时器就是自己打自己的脸。
// 只扫真代码——文件头部那句「不许 setTimeout」正是给这条立论用的中文说明，
// 拿注释当证据会把钉子钉在散文上（改一个字就红，红得毫无意义）。
const sceneCode = fs
  .readFileSync(new URL('../server/scene.mjs', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
check('scene.mjs 里没有任何计时器（相位只能被显式推进）',
  !/setTimeout\(|setInterval\(|Date\.now\(/.test(sceneCode),
  sceneCode.split('\n').filter((l) => /setTimeout\(|setInterval\(|Date\.now\(/.test(l)).join(' | '));
const deskSnapshot = desk.renderSceneSnapshot(two);
check('快照说清第几场、场名、中文相位、台上道具（不写"几件"这种数值，免撞 Invariant 4 的黑名单）',
  deskSnapshot.includes('第 2 场') && deskSnapshot.includes('第二场：闭包') &&
    deskSnapshot.includes('开场') && deskSnapshot.includes('「变量的盒子·拖拽」(box-1)') &&
    !/[0-9]+\s*件/.test(deskSnapshot),
  deskSnapshot);
check('快照把"没有时钟"讲给模型（学习者的沉默不是换场信号）',
  deskSnapshot.includes('相位没有时钟'));

// 承台这一句是转场条在服务端那一侧的对应物：模型说"台上道具"时得知道哪几件是接过来的、
// 它们的画面在哪才看得见。不说清去向，模型就会讲成"已经摊在你眼前"，而画面上那一场是收起来的。
check('快照点明哪几件是接过来的、从第几场接的（承台账要模型也读得到）',
  deskSnapshot.includes('承台：「变量的盒子·拖拽」(box-1)是从第 1 场接过来的'), deskSnapshot);
check('并说清它的画面在哪看得见：本场只有一行转场条，点开那一场才有画面',
  /转场条/.test(deskSnapshot) && /点开那一场/.test(deskSnapshot), deskSnapshot);
check('不许把接过来的那件说成已经摊在眼前（快照里这句话只能以否定形式出现）',
  deskSnapshot.includes('别说成"已经摊在你眼前"'), deskSnapshot);
check('第一场没得接 ⇒ 不出承台那一句（没接住东西就不许演这一出）',
  !desk.renderSceneSnapshot(one).includes('承台'), desk.renderSceneSnapshot(one));
const ownProp = desk.placeProp(two, { id: 'own-1', title: '本场新摆的那件', rel: null });
const ownSnapshot = desk.renderSceneSnapshot(ownProp);
check('本场自己摆上台的那件不进承台句（判据是"和上一场同一件"，不是"台上的每一件"）',
  /台上道具：.*本场新摆的那件/.test(ownSnapshot) && !/承台：[^。\n]*本场新摆的那件/.test(ownSnapshot), ownSnapshot);
// 认的是"接自哪一场"，不是"log 里排第一的那场"，也不是"最老那件"：三段连开、中间那场新摆一件，
// 两种偷懒的写法都会把第 3 场的承台报成第 1 场、并把第 2 场那件漏掉。
const three = desk.openScene(ownProp, { title: '第三场：作用域链' });
const threeSnapshot = desk.renderSceneSnapshot(three);
check('三段连开：承台报的是它接自的那一场（第 2 场），不是历史里最老的那场',
  threeSnapshot.includes('是从第 2 场接过来的') && !threeSnapshot.includes('是从第 1 场接过来'), threeSnapshot);
check('上一场自己新摆的那件到第三场也算承台（判据是本场 ∩ 上一场，不是"从第 1 场活下来的那件"）',
  /承台：[^。\n]*本场新摆的那件[^。\n]*是从第 2 场/.test(threeSnapshot)
  && /承台：[^。\n]*变量的盒子·拖拽/.test(threeSnapshot), threeSnapshot);

// 走真回合：台面要落盘、消息要带场 id、SSE 要推 scene——这三样少了任何一个，刷新后端面就没了。
const nbDesk = store.getNotebook(store.createNotebook({ topic: '导演台探针', goal: '看场怎么落盘', pace: 'normal' }).id);
// 两件盘上已有的道具：一件被学习者扔掉了（摆不回来），一件还在（能摆上台）。
const retiredBefore = store.saveArtifact(nbDesk.id, { title: '上一场的道具', html: '<p>old</p>', kind: 'interactive' });
store.setArtifactLifetime(nbDesk.id, retiredBefore.id, true);
const liveBefore = store.saveArtifact(nbDesk.id, { title: '还能用的旧道具', html: '<p>keep</p>', kind: 'interactive' });
const deskEvents = [];
const deskMessages = [];
let deskSessionRef = null;
faux.setResponses([
  fauxAssistantMessage([
    fauxText('先开一场。'),
    fauxToolCall(TOOL_NAMES.RUN_SCENE, { action: 'open', title: '变量的盒子', phase: 'open', concept_id: 'var-scope' }),
  ], { stopReason: 'toolUse' }),
  fauxAssistantMessage([
    fauxToolCall(TOOL_NAMES.RUN_SCENE, { action: 'place', artifact_id: retiredBefore.id }),
    fauxToolCall(TOOL_NAMES.RUN_SCENE, { action: 'place', artifact_id: 'no-such-prop' }),
    fauxToolCall(TOOL_NAMES.RUN_SCENE, { action: 'frobnicate' }),
  ], { stopReason: 'toolUse' }),
  fauxAssistantMessage([
    fauxToolCall(TOOL_NAMES.RUN_SCENE, { action: 'place', artifact_id: liveBefore.id }),
  ], { stopReason: 'toolUse' }),
  fauxAssistantMessage([
    fauxToolCall(TOOL_NAMES.SHARE_ARTIFACT, { title: '盒子里的值', kind: 'illustration', html: '<p>值放进盒子</p>' }),
  ], { stopReason: 'toolUse' }),
  fauxAssistantMessage([
    fauxToolCall(TOOL_NAMES.RUN_SCENE, { action: 'phase', phase: 'practice' }),
  ], { stopReason: 'toolUse' }),
  fauxAssistantMessage([
    fauxToolCall(TOOL_NAMES.RUN_SCENE, { action: 'place', artifact_id: liveBefore.id }),
    fauxToolCall(TOOL_NAMES.RUN_SCENE, { action: 'phase', phase: 'not-a-phase' }),
  ], { stopReason: 'toolUse' }),
  fauxAssistantMessage([
    fauxToolCall(TOOL_NAMES.RUN_SCENE, { action: 'open', title: '第二场：闭包' }),
  ], { stopReason: 'toolUse' }),
  fauxAssistantMessage([fauxText('两场之间道具没下台。')]),
]);
const deskTurn = await runTurn({
  registry,
  notebook: store.getNotebook(nbDesk.id),
  history: [{ role: 'user', content: '开一局看导演台', timestamp: Date.now() }],
  modelRef: { provider: 'faux', model: fauxModel.id },
  emit: (e) => deskEvents.push(e),
  signal: new AbortController().signal,
  systemPrompt: '（测试用）',
  // 抓的是每一次 upsert 时的快照：宿主传过来的是同一个对象引用，不克隆就看不见"打过之后有没有被改"
  onPersistMessage: (m) => deskMessages.push({ ...m }),
  onSession: (s) => { deskSessionRef = s; },
});
const deskSceneNow = store.readSceneState(nbDesk.id);
const deskProps = (deskSceneNow.current?.props || []).map((p) => p.title);
const sceneEvents = deskEvents.filter((e) => e.type === 'scene');
check('scene 事件推给前端恰好六次：开场、摆旧道具、交付自动上台、换相位、再摆一次、换场（被拒的四次不许推）',
  sceneEvents.length === 6, `实到 ${sceneEvents.length} 次`);
check('台面落到 scene.json（自己一个文件，跟 todos 同类）',
  deskSceneNow.current?.title === '第二场：闭包' && deskProps.length === 2 &&
    fs.existsSync(path.join(NOTEBOOKS_DIR, nbDesk.id, 'scene.json')),
  JSON.stringify(deskSceneNow.current));
check('progress.json 里没有被掺进台面字段',
  !JSON.stringify(store.getNotebook(nbDesk.id).progress).includes('props'));
const refused = deskEvents.filter((e) => e.type === 'tool_end' && e.ok === false);
check('被学习者扔掉的道具摆不上台（放回是他的手势，工具拒绝得明明白白）',
  refused.some((e) => /被学习者扔掉了/.test(JSON.stringify(e.result))), JSON.stringify(refused.map((e) => e.result)));
check('manifest 里没有的 id 直接拒，不退化成"凭空多出一件道具"',
  refused.some((e) => /没有这件道具/.test(JSON.stringify(e.result))));
check('未知 action 拒绝并列出可用的四种',
  refused.some((e) => /未知 action/.test(JSON.stringify(e.result)) && /remove/.test(JSON.stringify(e.result))));
check('非法相位被拒，台面不许写成一句瞎话接着演',
  refused.some((e) => /未知相位/.test(JSON.stringify(e.result))));
// 相位只能被 run_scene 那一手推进：摆道具是摆道具，不许顺手把拍子改了（那就是藏了个时钟）。
const phaseAfterPlace = sceneEvents.filter((e) => e.scene?.phase === 'practice').length;
check('摆旧道具把相位定在动手（practice）之后，再摆一次也没把相位改回讲授',
  phaseAfterPlace === 2 && sceneEvents[sceneEvents.length - 2].scene.phase === 'practice',
  JSON.stringify(sceneEvents.map((e) => e.scene?.phase)));
check('摆同一件第二次不长出台位（台面还是那两件，不是三件）',
  deskProps.length === 2 && new Set(deskProps).size === 2, JSON.stringify(deskProps));
const twoOnStage = (list) => (list || []).length === 2 &&
  list.some((t) => t === '还能用的旧道具') && list.some((t) => t === '盒子里的值');
check('跨场不清台：第二场一开始就带着第一场那两件（含这一场刚交付的那件）',
  deskSceneNow.log.length === 1 && twoOnStage(deskProps) &&
    deskSceneNow.log[0].props?.map((p) => p.id).join(',') === deskSceneNow.current.props.map((p) => p.id).join(','),
  JSON.stringify({ 本场: deskProps, 上场: deskSceneNow.log[0]?.props?.map((p) => p.title) }));
check('每一条落盘消息都带 sceneId，且落在它开始那一场里',
  deskMessages.length > 0 && deskMessages.every((m) => typeof m.sceneId === 'string') &&
    deskMessages[0].sceneId === 'scene-01' &&
    deskMessages[deskMessages.length - 1].sceneId === 'scene-02',
  JSON.stringify(deskMessages.map((m) => [m.msgId, m.sceneId])));
// 同一条消息被反复 upsert（一步没正文就挂到上一条上），场 id 只许打一次：
// 后一场把它重标，上一场的正文就从上一场的格子里消失了。
const migrated = new Map();
for (const m of deskMessages) {
  if (!migrated.has(m.msgId)) migrated.set(m.msgId, new Set());
  migrated.get(m.msgId).add(m.sceneId);
}
check('同一条消息不许换场（跨场的正文不能被后一场吃掉）',
  [...migrated.values()].every((ids) => ids.size === 1),
  JSON.stringify([...migrated].map(([k, v]) => [k, [...v]])));
// 后面第 7b 节才正名导入 buildSystemPrompt，这里用别名（同一模块、同一份缓存）。
const { buildSystemPrompt: buildPromptForDesk } = await import('../server/prompt.mjs');
const deskPrompt = buildPromptForDesk(store.getNotebook(nbDesk.id));
check('下一回合的 system prompt 里读得到当前这一场（续演不靠记忆）',
  deskPrompt.includes('## 导演台（第 2 场）') && deskPrompt.includes('第二场：闭包'));
check('run_scene 在注册给模型的清单里，且带 action 参数',
  buildTools().some((t) => t.name === TOOL_NAMES.RUN_SCENE &&
    JSON.stringify(t.parameters).includes('action')));

// 每一手都要当场落盘：只在回合末尾统一写一次的话，中断就把整个台面丢了。
// 直接调工具、紧接着读盘——中间没有第二手会替它把状态补写回去。
const assessRet = deskSessionRef.execRunScene({ action: 'phase', phase: 'assess' });
const sceneAfterAssess = store.readSceneState(nbDesk.id);
check('换相位这一次调用自己就把盘写了（不靠回合末尾统一落盘）',
  assessRet.ok === true && sceneAfterAssess.current.phase === 'assess' &&
    sceneAfterAssess.current.title === '第二场：闭包',
  JSON.stringify(sceneAfterAssess.current));
check('换相位不搬道具：台上还是那两件',
  twoOnStage(sceneAfterAssess.current.props.map((p) => p.title)),
  JSON.stringify(sceneAfterAssess.current.props));
deskSessionRef.execRunScene({ action: 'open', title: '第三场：回收' });
const sceneAfterThird = store.readSceneState(nbDesk.id);
check('第三场归档第二场：log 两条、编号连续',
  sceneAfterThird.current.index === 3 && sceneAfterThird.log.length === 2 &&
    sceneAfterThird.log.map((s) => s.index).join(',') === '1,2',
  JSON.stringify({ index: sceneAfterThird.current?.index, log: sceneAfterThird.log.length }));

// ─────────────────────────────────────── 6e. 台面只有一个写字的人
//
// 后台分身拿的是**派出那一刻**的 notebook 克隆。让它写 scene.json，就等于用一张旧台面
// 盖掉老师在这之后的每一手——实测过：第二场和它台上的道具一起消失，盘退回第一场。
// 所以：分身能交制品（文件、manifest 都要有），但上台这一手归宿主——由宿主读最新的盘再摆。

section('6e. 台面只有一个写字的人：分身不写 scene.json，宿主负责上台');

const childNotebook = store.getNotebook(nbDesk.id);
const sceneBeforeChild = JSON.stringify(store.readSceneState(nbDesk.id));
const childSession = new TeachingSession({
  registry,
  notebook: structuredClone(childNotebook),
  emit: () => {},
  systemPrompt: '',
  deskWriter: false,
});
const childDelivered = await childSession.execShareArtifact({
  title: '分身做完的大件',
  kind: 'game',
  html: '<html><head></head><body>big</body></html>',
});
check('分身交付的制品照样落盘（有地址、进得了 manifest）',
  childDelivered.ok === true && Boolean(childDelivered.rel) &&
    (store.getNotebook(nbDesk.id).artifacts || []).some((a) => a.id === childDelivered.artifactId),
  JSON.stringify(childDelivered).slice(0, 200));
check('分身不写父会话的台面：scene.json 一个字节都不动',
  JSON.stringify(store.readSceneState(nbDesk.id)) === sceneBeforeChild,
  JSON.stringify(store.readSceneState(nbDesk.id).current));
check('分身那一份返回值说清"上台归宿主"，不谎称已经摆在台上',
  /宿主/.test(String(childDelivered.desk)) && !/已摆上/.test(String(childDelivered.desk)),
  String(childDelivered.desk));

// 宿主这一手：读**最新**的盘再摆，所以它摆的是当下这一场，不是分身记忆里那一场。
const hostPlaced = store.placeOnDesk(nbDesk.id, {
  id: childDelivered.artifactId,
  title: '分身做完的大件',
  rel: childDelivered.rel,
});
const sceneAfterHost = store.readSceneState(nbDesk.id);
check('宿主把分身做好的大件摆到当前这一场的台上（跨场延续：摆进第三场，不是第一场）',
  hostPlaced.placed === true && sceneAfterHost.current.title === '第三场：回收' &&
    sceneAfterHost.current.props.some((p) => p.id === childDelivered.artifactId),
  JSON.stringify({ 场: sceneAfterHost.current.title, props: sceneAfterHost.current.props.map((p) => p.id) }));
check('摆完的台面仍是那一本账（不多开第二本）',
  !('placed' in sceneAfterHost.current) && !('removed' in sceneAfterHost.current));

const bareDesk = store.createNotebook({ topic: '没开场的台', goal: null, pace: 'normal' }).id;
const hostNoScene = store.placeOnDesk(bareDesk, { id: 'x-1', title: 'X', rel: 'artifacts/x-1/index.html' });
check('还没开过场时宿主也不替他开场：placed=false，盘上一个文件都不写',
  hostNoScene.placed === false && hostNoScene.scene.current === null &&
    !fs.existsSync(path.join(NOTEBOOKS_DIR, bareDesk, 'scene.json')),
  JSON.stringify(hostNoScene.scene));

const serveSrcForDesk = fs.readFileSync(new URL('../server/serve.mjs', import.meta.url), 'utf8');
check('task_artifact 分支接的是宿主上台这一手（不是让分身自己写盘）',
  /task_artifact[\s\S]{0,1600}placeOnDesk\(/.test(serveSrcForDesk), 'serve.mjs 的 task_artifact 分支里找不到 placeOnDesk');
check('活回合内存里那一份也跟上（跟 lifetime 那一条同纪律：不然它下一次往旧台面上摆）',
  /placeOnDesk\([\s\S]{0,600}\.scene = /.test(serveSrcForDesk), '上台后没同步活回合的 scene');

// ── 措辞：画布这一页在 2b 就删了，工具描述还承诺"做好自动出现在画布上"
//    是幻影能力（模型会等一个不会发生的动作）。返回值那一句在第 7h 节钉（那儿才有任务运行器）。
const shareToolDesc = JSON.stringify(buildTools().find((t) => t.name === TOOL_NAMES.PREPARE_ARTIFACT || {}));
check('prepare_artifact 的工具描述不再写"上画布"，改说摆上台',
  !/画布/.test(shareToolDesc), shareToolDesc.slice(0, 160));
// 整份注册清单一起扫：任何一条描述留着"画布"，模型就等一个不会发生的动作。
// 只扫工具描述与 adapter——rules/artifact.md 里那两处说的是 SVG 画布，是正当用法。
check('注册给模型的每一条工具描述里都没有"画布"这一幻影页',
  !/画布/.test(JSON.stringify(buildTools())),
  JSON.stringify(buildTools()).split('画布').length - 1);
const adapterSrcForDesk = fs.readFileSync(new URL('../server/prompt.mjs', import.meta.url), 'utf8');
check('环境适配与状态快照里也不再提"画布"（道具的去处是台面）',
  !/画布/.test(adapterSrcForDesk), adapterSrcForDesk.split('\n').filter((l) => l.includes('画布')).join(' | ').slice(0, 160));
// 分身那一侧的写权开关只在一个地方接上：tasks.mjs 调 runTurn 时传 deskWriter:false。
// 光测 TeachingSession 证不了生产路径接了线——这条正是"单元绿、组合根没连"那个老坑的形状。
const tasksSrcForDesk = fs.readFileSync(new URL('../server/tasks.mjs', import.meta.url), 'utf8');
check('分身走的那条 runTurn 调用真的关掉了台面写权（deskWriter:false 传到了）',
  /runTurn\(\{[\s\S]{0,900}deskWriter: false/.test(tasksSrcForDesk), 'tasks.mjs 里没把 deskWriter 传给 runTurn');

// ── 决策那一刻的提醒：切到动手/检验而台面是空的，工具返回值要点名（规则里的提醒太弱）
const emptyDeskNb = store.getNotebook(bareDesk);
const emptyDeskSession = new TeachingSession({
  registry, notebook: emptyDeskNb, emit: () => {}, systemPrompt: '',
});
emptyDeskSession.execRunScene({ action: 'open', title: '只有嘴的一台戏' });
const toPractice = emptyDeskSession.execRunScene({ action: 'phase', phase: 'practice' });
check('台面空着切进"动手"：工具返回值点名这一拍没有可操作的东西，并给出路',
  toPractice.ok === true && /台上.*没有|没有.*道具/.test(toPractice.note) && /share_artifact/.test(toPractice.note),
  toPractice.note);
check('提醒必须同时给出"这一拍可以不需要道具"的出口（不然模型会造装饰性道具凑台面）',
  /不需要|不用为摆而摆/.test(toPractice.note), toPractice.note);
const toAssess = emptyDeskSession.execRunScene({ action: 'phase', phase: 'assess' });
check('空台面切进"检验"同样提醒（这一拍更该有件能操作的东西）',
  /share_artifact/.test(toAssess.note), toAssess.note);
const toTeach = emptyDeskSession.execRunScene({ action: 'phase', phase: 'teach' });
check('讲授相位不唠叨（只有需要动手的拍子才提台面）',
  !/share_artifact/.test(toTeach.note), toTeach.note);
check('台上有东西就不许再唠叨（提醒是状态不是口头禅）',
  !/share_artifact/.test(assessRet.note), assessRet.note);

// ── 讲稿槽这条契约**只有工具层一个载体**（2026-10-05 规则余量已花光，一个字都没进 artifact.md）。
// 所以这条说法的兑现（有带⇒落进带里，没带⇒顺排在画面下面）必须在这里验：光在源码里搜那句话不算——模型读的是这一刻的返回值，
// 拼漏一句契约就整条丢，而页面那边照常把讲解浮在右上角（静默失效，没人报错）。
const stagedDelivery = await emptyDeskSession.execShareArtifact({
  title: '摊在台面上的这一件',
  html: '<html><body><div data-narration-slot></div></body></html>',
});
check('开了场再交制品：返回值的台面那句点名带子（怎么摆这屏的说法真随结果到手）',
  /data-narration-slot/.test(String(stagedDelivery.desk)), String(stagedDelivery.desk).slice(0, 120));
check('契约提示里【讲稿槽】那一节跟着一起到（留多宽、留几条只有这一份说明书）',
  /【讲稿槽】/.test(String(stagedDelivery.contract)), String(stagedDelivery.contract).indexOf('【讲稿槽】'));
check('分身那一份不许冒充台面：不带讲稿槽那句（它没有 current 那一场）',
  !/data-narration-slot/.test(String(childDelivered.desk)), String(childDelivered.desk).slice(0, 80));

// ─────────────────────────────────────── 7. 工具 schema 可校验

section('7. 工具 schema');
const tools = buildTools();
check('工具数量与设计一致（18 个教学工具 + jev_judge 判定外包）', tools.length === 20, String(tools.length));
check('每个工具都有 TypeBox schema', tools.every((t) => t.parameters && typeof t.parameters === 'object'));
check('工具名唯一', new Set(tools.map((t) => t.name)).size === tools.length);
check(
  '制品证据读回工具在场（页面型制品的唯一证据通道）',
  tools.some((t) => t.name === TOOL_NAMES.READ_ARTIFACT),
);

// ask 的选项：模型经常裸写字符串（`options: ["能读到","读不到"]`），而参数校验发生在
// 我们的 execAsk **之前**（pi-ai 的 validateToolCall），所以只认对象时的表现是
// "每发起一次提问组件都先红一次、第二次才对"——白烧一个来回，会话里还留一张红卡。
// 这两种写法都必须过校验，往下游统一成 {label, description}。
const askTool = tools.find((t) => t.name === TOOL_NAMES.ASK);
const validateAsk = (options) => {
  try {
    return {
      ok: true,
      args: validateToolCall([askTool], {
        name: TOOL_NAMES.ASK,
        arguments: { id: 'closures:q_validate', concept_id: 'closures', question: '外层 return 后还能读到那个变量吗？', options },
      }),
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
};
const stringOpts = validateAsk(['能读到', '读不到']);
check('字符串选项也过得了参数校验', stringOpts.ok, stringOpts.error || '');
const mixedOpts = validateAsk([{ label: '能读到', description: '握着那个变量' }, '读不到']);
check('对象写法照旧过得了校验（混着写也算）', mixedOpts.ok, mixedOpts.error || '');
// concept_id 是必填：必填由 provider 的参数校验保证，比在提示词里叮嘱一句可靠
let missingConcept = true;
try {
  validateToolCall([askTool], { name: TOOL_NAMES.ASK, arguments: { id: 'q_no_concept', question: '这一格属于哪个概念？' } });
} catch {
  missingConcept = false;
}
check('缺 concept_id 过不了参数校验', missingConcept === false);
check(
  '两种写法出去的都是 {label, description}',
  JSON.stringify(normalizeAskOptions(mixedOpts.ok ? mixedOpts.args.options : null)) ===
    '[{"label":"能读到","description":"握着那个变量"},{"label":"读不到"}]',
  JSON.stringify(normalizeAskOptions(mixedOpts.ok ? mixedOpts.args.options : null)),
);
check(
  '空标签的选项丢掉，不给前端渲染出一条空白行',
  JSON.stringify(normalizeAskOptions(['', '   ', { label: ' 甲 ' }, { label: '' }])) === '[{"label":"甲"}]',
  JSON.stringify(normalizeAskOptions(['', '   ', { label: ' 甲 ' }, { label: '' }])),
);
check('没给选项（开放式提问）归一成空数组', JSON.stringify(normalizeAskOptions(undefined)) === '[]');

// id 只是"这张卡对应哪个等待中的提问"的传输把手，答完就没用了；真正承重的是 concept_id
// （学习者一答，应用凭它把那一格从 Unknown 记成 Seen）。以前 schema 把 id 判成必填，
// 模型漏填一次就是一次红卡——而 execAsk 本来就会自己补号，等于校验层挡了代码能补的东西。
let missingIdErr = '';
let missingIdOk = true;
try {
  validateToolCall([askTool], {
    name: TOOL_NAMES.ASK,
    arguments: { concept_id: 'none', header: '学习范围', question: '学习范围确认：按这个顺序推进吗？', options: ['就按这个顺序来'] },
  });
} catch (e) {
  missingIdOk = false;
  missingIdErr = String(e.message || e);
}
check('缺 id 也过得了参数校验（不许再为它烧一张红卡）', missingIdOk === true, missingIdErr);

// 缺 id 时补出来的号必须真能用。两问同步连着发（真回合里同一毫秒连发两次完全可能）：
// 把手一旦撞车，第一张卡就永远等不到作答。
const twinA = session.execAsk({ concept_id: 'none', question: '同毫秒第一发', options: [{ label: '甲' }] });
const idA = session.askedQuestions.at(-1);
const twinB = session.execAsk({ concept_id: 'none', question: '同毫秒第二发', options: [{ label: '乙' }] });
const idB = session.askedQuestions.at(-1);
check('同一毫秒连发两问都不给 id，补出来的两个把手不撞车', idA !== idB, `${idA} / ${idB}`);
session.answer(idB, { selected: ['乙'], text: '' });
session.answer(idA, { selected: ['甲'], text: '' });
const bothSettled = await Promise.race([
  Promise.all([twinA, twinB]).then(() => 'ok'),
  new Promise((r) => setTimeout(() => r('一张卡永远等不到作答'), 1000)),
]);
check('两张卡各自收各自的作答（答错把手就卡住）', bothSettled === 'ok', bothSettled);
const held = session.execAsk({ id: 'gate1:confirm_order', concept_id: 'none', question: '给了 id 就用我给的？', options: [{ label: '用' }] });
check('模型给了稳定 id 就照用，不覆盖成自动补的号', session.askedQuestions.at(-1) === 'gate1:confirm_order', session.askedQuestions.at(-1));
session.answer('gate1:confirm_order', { selected: ['用'], text: '' });
await held;

// ─────────────────────────────────────── 7b. 证据进入 system prompt

section('7b. 制品证据进入 system prompt');
const { buildSystemPrompt, renderStateSnapshot } = await import('../server/prompt.mjs');
const promptWithEvidence = buildSystemPrompt({
  id: meta.id,
  title: 'JS 闭包',
  graph: result.graph,
  progress: {
    ...result.progress,
    artifact_evidence: [
      {
        artifact_id: 'inline-1-abc',
        concept_id: 'closures',
        question_id: 'closures:q_box_count',
        interaction_type: 'choice',
        response: 'three',
        result: 'correct',
        attempts: 2,
        completed: true,
        locked: true,
        at: new Date().toISOString(),
      },
    ],
  },
  patches: { patches: [] },
});
check('证据区块出现在 system prompt', promptWithEvidence.includes('学习者在制品（页面型交互物件）里做过的操作'));
check('题号出现在 prompt', promptWithEvidence.includes('closures:q_box_count'));
check('作答内容出现在 prompt', promptWithEvidence.includes('three'));
check('制品契约出现在 prompt', promptWithEvidence.includes('data-interaction') && promptWithEvidence.includes('SocraticStudio.report'));
check('下行契约出现在 prompt', promptWithEvidence.includes('push_artifact_command'));
check('证据口径提醒到位', promptWithEvidence.includes('不是结论') && promptWithEvidence.includes('没有记录'));

// ── 回马枪：最后一次判错、之后没判对的题要变成下一回合的重测候选 ──
const ev = (qid, result_, extra = {}) => ({
  artifact_id: 'inline-1',
  concept_id: 'closures',
  question_id: qid,
  interaction_type: 'choice',
  response: 'three',
  result: result_,
  attempts: 2,
  completed: result_ === 'correct',
  locked: false,
  ...extra,
});
const retestSnapshot = renderStateSnapshot({
  id: meta.id,
  graph: result.graph,
  progress: {
    ...result.progress,
    notes: [],
    artifact_evidence: [
      ev('closures:q_a', 'incorrect'),
      ev('closures:q_b', 'incorrect'),
      ev('closures:q_c', 'incorrect'),
      ev('closures:q_d', 'incorrect'),
      ev('closures:q_recovered', 'incorrect'),
      ev('closures:q_recovered', 'correct'),
      ev('closures:q_still_wrong', 'incorrect'),
      ev('closures:q_still_wrong', 'incorrect', { attempts: 3, response: 'two' }),
    ],
  },
  patches: { patches: [] },
});
const retestBlock = retestSnapshot.slice(retestSnapshot.indexOf('回马枪候选'));
check('回马枪候选区块出现', retestSnapshot.includes('回马枪候选'));
check('仍判错的题进候选', retestBlock.includes('closures:q_still_wrong'));
check(
  '候选写明错过几次与最后一次作答',
  /错过 3 次[^\n]*「two」/.test(retestBlock),
  retestBlock.split('\n').find((l) => l.includes('still_wrong')),
);
check('后来判对的题不在候选里', !retestBlock.includes('q_recovered'));
const retestListed = (retestBlock.match(/^- closures:/gm) || []).length;
check('候选最多 3 条', retestListed === 3, `${retestListed} 条`);
check(
  '最近判错的那条排在最前',
  retestBlock.indexOf('q_still_wrong') < retestBlock.indexOf('closures:q_d'),
);
check('重测指令要求换说法并限时', retestBlock.includes('换一种说法') && retestBlock.includes('30 秒'));
check(
  '候选区块不产出掌握式结论',
  !/已掌握|掌握度|mastery|百分比|[0-9]+\s*%/i.test(retestBlock),
);

// 新增能力的宿主映射与快照都要进 prompt
check('prompt 有点名 present_plan', promptWithEvidence.includes('present_plan'));
check('prompt 有点名 update_todo_list', promptWithEvidence.includes('update_todo_list'));
check('prompt 有点名 spawn_subagent', promptWithEvidence.includes('spawn_subagent'));
check('prompt 有点名 run_background_task', promptWithEvidence.includes('run_background_task'));
const promptWithTodos = buildSystemPrompt({
  id: meta.id,
  title: 'JS 闭包',
  graph: result.graph,
  progress: { ...result.progress, artifact_evidence: [] },
  patches: { patches: [] },
  todos: [
    { id: 'a', content: '建概念结构', status: 'completed' },
    { id: 'b', content: '出探针', status: 'in_progress' },
  ],
});
check('待办快照进 prompt', promptWithTodos.includes('本轮待办（学习者右侧可见，1/2 已完成）'));
check('待办条目进 prompt', promptWithTodos.includes('[>] 出探针'));

// 注意：不改用整份 prompt 匹配——规则原文里本来就写着这些禁令词（Invariant 4 的违规指纹）。
// 要断言的是**我们自己生成的状态快照**不产出数值化学习量。
const snapshot = renderStateSnapshot({
  id: meta.id,
  graph: result.graph,
  progress: { ...result.progress, artifact_evidence: [], notes: [] },
  patches: { patches: [] },
});
check(
  '状态快照里没有数值化学习量',
  !/(百分比|进度条|[0-9]+\s*%|score|百分制|等级认证|星星)/i.test(snapshot),
);

const promptNoEvidence = buildSystemPrompt({
  id: meta.id,
  graph: result.graph,
  progress: { ...result.progress, artifact_evidence: [], artifact_state: {}, artifact_events: [] },
  patches: { patches: [] },
});
check(
  '无证据时也明确"没有记录不等于没做"',
  promptNoEvidence.includes('没有记录不等于学习者没做'),
  'prompt 里应有三类都为空时的兜底句',
);
check(
  '没有判错证据时不出回马枪候选区块',
  !snapshot.includes('回马枪候选') && !promptNoEvidence.includes('回马枪候选'),
);

// 学习者扔掉一件道具，模型读到的应该是"工作集变了"，不是"他对这个概念撒手了"。
// 这一句只在他真撤过的快照里出现——常驻的免责声明也是噪声（同取景条那条账）。
const retiredEvents = [
  { name: 'submitted', payload: { text: '我试了三次' }, at: '2026-10-04T10:00:00.000Z' },
  { name: 'artifact_retired', payload: { title: '正则试错场', kind: 'interactive' }, at: '2026-10-04T10:05:00.000Z' },
];
const snapshotRetired = renderStateSnapshot({
  id: meta.id,
  graph: result.graph,
  progress: { ...result.progress, artifact_evidence: [], artifact_state: {}, notes: [], artifact_events: retiredEvents },
  patches: { patches: [] },
});
check('撤下道具这件事本身照旧进快照（事实不许被解释吞掉）',
  snapshotRetired.includes('- artifact_retired') && snapshotRetired.includes('正则试错场'),
  snapshotRetired.split('artifact_retired')[1]?.slice(0, 60));
check('真撤过时才解释一句：这是工作集的动作，不是去留',
  snapshotRetired.includes('不说明他对这个概念的去留') && snapshotRetired.includes('别拿去劝'));
const snapshotNoRetire = renderStateSnapshot({
  id: meta.id,
  graph: result.graph,
  progress: { ...result.progress, artifact_evidence: [], artifact_state: {}, notes: [], artifact_events: [retiredEvents[0]] },
  patches: { patches: [] },
});
check('没撤过时不许摆那句解释（没说错对象的提示比不提示更糟）',
  !snapshotNoRetire.includes('别拿去劝'), '常驻说明也是噪声');

// ─────────────────────────────────────── 7d. 教学规则本体在 server/rules/

section('7d. 教学规则在 server/rules/，运行时注入');
const { loadRulesText } = await import('../server/prompt.mjs');
const { RULES_DIR } = await import('../server/config.mjs');
check('RULES_DIR 指向 server/rules', RULES_DIR.endsWith(path.join('server', 'rules')), RULES_DIR);
const rulesBlob = loadRulesText({ force: true });
// 规则不是可独立加载的 skill：正文里不该再有宿主加载器用的 frontmatter 清单
check('注入的规则不带 frontmatter 清单',
  !rulesBlob.includes('name: socratic-studio') && !rulesBlob.includes('生成课件'),
  'frontmatter 属于 skill 包装，吸收进应用后应整体删除');
check('main.md 正文标题在场', rulesBlob.includes('# Socratic Studio'));
check(
  '回马枪的门写进规则（不是只靠快照里那句话）',
  rulesBlob.includes('回马枪') && rulesBlob.includes('一条答对不等于掌握'),
);
check('main.md 被注入（总则）', rulesBlob.includes('===== main.md —'));
for (const [rel, label] of [
  ['protocols.md', '协议 / 不变量'],
  ['runtime.md', 'Runtime'],
  ['pedagogy.md', '学科变体'],
  ['artifact.md', '制品'],
]) {
  check(`${rel} 被注入（${label}）`, rulesBlob.includes(`===== ${rel} —`));
}
// 规则本体真的在场，不是空文件
check('状态机规则在场', rulesBlob.includes('Unknown') && rulesBlob.includes('Applied'));
check('observed 证据口径在场', rulesBlob.includes('observed') && rulesBlob.includes('inferred'));
check('Invariant 1/4 在场', rulesBlob.includes('Invariant 1') && rulesBlob.includes('Invariant 4'));
check('制品回传契约在场', rulesBlob.includes('SocraticStudio.report'));

// 注入体积是**每一回合都要重付**的硬成本，不是能靠缓存省掉的东西。钉一个上限：谁把规则写胖了谁红。
// 上限按实测留一点余量；要放宽必须连同理由一起改这里，不许悄悄调数字。
// 已经无损去过重述（规则里复述 APP_ADAPTER 工具映射的段落改成指向映射表），实测 64.7k——
// 剩下的密度是教学内容本身，不是水分：再压就得删规则，那不再是"无损"。
const RULES_CHAR_BUDGET = 65000;
check(`规则注入不超过 ${RULES_CHAR_BUDGET} 字符`, rulesBlob.length <= RULES_CHAR_BUDGET,
  `实测 ${rulesBlob.length} 字符`);

// 吸收完整性：注册给模型的工具必须在 system prompt 里有映射，否则模型只能按原宿主的说法瞎猜。
// 这条就是"规则已被应用吸收"这句话的可执行版本。
const probePrompt = buildSystemPrompt({
  title: '探针', graph: { concepts: [], meta: {} }, progress: { concepts: {} },
  notes: { items: [] }, todos: { items: [] }, uploads: [],
});
for (const name of Object.values(TOOL_NAMES)) {
  check(`${name} 在 system prompt 里有映射`, probePrompt.includes(name));
}

// 幻影能力黑名单：原 skill 宿主有、本应用**没有**的东西，措辞里不许再出现。
// 出现一次就意味着模型会以为自己能执行命令 / 改文件 / 解析 PDF / 转写语音。
for (const ghost of ['命令执行工具', 'str_replace', 'pdf 技能', '语音转写', '`Skill` 工具', 'workspace 下的真实文件']) {
  check(`prompt 里不再宣称有「${ghost}」`, !rulesBlob.includes(ghost));
}

// ─────────────────────────────────────── 7c. 项目/游戏的通用回报通道

section('7c. 制品通用通道：state / event / 下行指令 / 跨轮续玩');

check('下行指令工具在场', buildTools().some((t) => t.name === 'push_artifact_command'));
check('工具数变为 20（+jev_judge）', buildTools().length === 20, String(buildTools().length));
check('异步制备制品工具在场', buildTools().some((t) => t.name === 'prepare_artifact'));
check('结构化笔记工具在场', buildTools().some((t) => t.name === 'compile_notes'));
check('present_plan 在场', buildTools().some((t) => t.name === 'present_plan'));
check('update_todo_list 在场', buildTools().some((t) => t.name === 'update_todo_list'));
check('spawn_subagent 在场', buildTools().some((t) => t.name === 'spawn_subagent'));
check('run_background_task 在场', buildTools().some((t) => t.name === 'run_background_task'));
// 少一个开关就少一次选择：落盘不再是模型要表明的意图，而是道具的默认寿命。
check('share_artifact 的 schema 里没有 persist 参数',
  !JSON.stringify(buildTools().find((t) => t.name === 'share_artifact').parameters).includes('persist'));

// state：浅合并 + 落盘后能被种子回来
await session.execShareArtifact({ title: '打地鼠', kind: 'game', html: '<p>game</p>' });
const gameId = session.liveArtifacts.keys().next().value;
check('state 上报被接受', session.recordArtifactEvidence({
  artifactId: gameId,
  type: 'state',
  state: { level: 1, attempts: 3, currentParam: 'a=0.5' },
}) === true);
check('state 浅合并保留全部 key', (() => {
  session.recordArtifactEvidence({ artifactId: gameId, type: 'state', state: { level: 2 } });
  const s = session.artifactEvidenceView(gameId).artifacts[0].state;
  return s.level === 2 && s.attempts === 3 && s.currentParam === 'a=0.5';
})());

// event：只追加 + 同 (name, at) 去重
check('event 上报被接受', session.recordArtifactEvidence({
  artifactId: gameId, type: 'event', name: 'level_cleared', payload: { level: 1 }, at: 'T1',
}) === true);
check('同一 event 重复上报被去重', session.recordArtifactEvidence({
  artifactId: gameId, type: 'event', name: 'level_cleared', payload: { level: 1 }, at: 'T1',
}) === false);
session.recordArtifactEvidence({ artifactId: gameId, type: 'event', name: 'miss', payload: { n: 2 }, at: 'T2' });
const evView = session.artifactEvidenceView(gameId).artifacts[0];
check('events 按顺序保留两条', evView.events.length === 2 && evView.events[1].name === 'miss');
check('event payload 完整保留', evView.events[0].payload.level === 1);

// 读回视图含 state + events（evidence 属于另一个制品桶，另测）
const gameView = session.artifactEvidenceView(gameId).artifacts[0];
check('读回视图含 state', gameView.state.level === 2);
check('读回视图含 events', gameView.events.length === 2);
check('制品桶之间互不串味', gameView.evidence.length === 0, String(gameView.evidence.length));
check('observed_count = events 数', gameView.observed_count === 2, String(gameView.observed_count));

// 落盘 → 新会话种子回来（跨轮续学的关键）
seedArtifacts(fresh, {
  artifact_state: { [gameId]: { level: 2, attempts: 3, currentParam: 'a=0.5' } },
  artifact_events: [{ artifact_id: gameId, name: 'level_cleared', payload: { level: 1 }, at: 'T1' }],
  artifact_evidence: [],
});
const seeded = viewOf(fresh, gameId).artifacts[0];
check('跨轮续玩：state 被种子回来', seeded.state.level === 2 && seeded.state.currentParam === 'a=0.5');
check('跨轮续玩：events 被种子回来', seeded.events.length === 1 && seeded.events[0].name === 'level_cleared');

// 下行指令
const cmd = session.pushArtifactCommand(gameId, 'inject_bug', { where: 'line 12' });
check('下行指令返回 ok', cmd.ok === true);
check('下行指令发出 artifact_command 事件', events.some((e) => e.type === 'artifact_command' && e.name === 'inject_bug'));

// 学习者那一颗「扔掉」：路由把同一件事同时交给两条轨——落盘（下一轮读得到）和
// 活回合（本回合内读得到）。HTTP 那套跑到 4c 时没有活回合，第二条轨永远走不到，
// 所以用会话本体在这里钉住。放在 7c 末尾：前面每一条都是精确条数，别拿事件去污染它们。
const retireEvent = {
  type: 'event', artifactId: liveArtifact.id, name: 'artifact_retired',
  payload: { title: liveArtifact.title, kind: liveArtifact.kind }, at: '2026-10-04T10:20:00.000Z',
};
const railBefore = session.liveArtifacts.get(liveArtifact.id)?.events?.length || 0;
check('活回合收得下扔掉事件（本回合内 read_artifact_evidence 就读得到）',
  session.recordArtifactEvidence(retireEvent) === true &&
    session.liveArtifacts.get(liveArtifact.id).events.length === railBefore + 1,
  `events ${railBefore} → ${session.liveArtifacts.get(liveArtifact.id)?.events?.length}`);
check('它作为 artifact_event 广播出去（画布那一行提示与右栏靠这条）',
  events.filter((e) => e.type === 'artifact_event' && e.name === 'artifact_retired').length === 1);
check('同一个动作重播两次只算一条（name+at 去重，别把一次点击说成两次）',
  session.recordArtifactEvidence(retireEvent) === false);

// ─────────────────────────────────────── 7d. 待办清单

section('7d. 待办清单');
check('update_todo_list 回报完成度', (() => {
  const r = session.execUpdateTodo({
    todos: [
      { id: 'a', content: '建概念结构', status: 'completed' },
      { id: 'b', content: '出探针', status: 'in_progress' },
      { id: 'c', content: '复盘', status: 'pending' },
    ],
  });
  return r.ok === true && r.note.includes('1/3');
})());
check('todo 事件发给前端', events.some((e) => e.type === 'todo' && e.todos.length === 3));
check('非法 status 归一到 pending', (() => {
  session.execUpdateTodo({ todos: [{ id: 'x', content: 'y', status: 'weird' }] });
  return session.todos[0].status === 'pending';
})());
check('空内容被丢掉', (() => {
  session.execUpdateTodo({ todos: [{ id: 'x', content: '   ', status: 'pending' }] });
  return session.todos.length === 0;
})());
check('id 冲突自动去重', (() => {
  session.execUpdateTodo({ todos: [
    { id: 'dup', content: '一', status: 'pending' },
    { id: 'dup', content: '二', status: 'pending' },
  ] });
  return session.todos.length === 2 && session.todos[0].id !== session.todos[1].id;
})());
check('整体替换不是追加', (() => {
  session.execUpdateTodo({ todos: [{ id: 'a', content: '只剩这条', status: 'pending' }] });
  return session.todos.length === 1;
})());

// ─────────────────────────────────────── 7e. 计划模式（阻塞到学习者裁决）

section('7e. 计划模式：present_plan 阻塞 + 批准/退回');
const planOutcomes = [];
{
  const p = session.execPresentPlan({ plan: '先建两个概念，再出探针' });
  const planEvt = events.filter((e) => e.type === 'plan').pop();
  check('present_plan 发出 plan 事件', Boolean(planEvt));
  check('plan 带 id', typeof planEvt?.planId === 'string' && planEvt.planId.length > 0);
  const decided = session.decidePlan(planEvt.planId, { approved: true });
  check('审批被会话接收', decided === true);
  const r = await p;
  check('批准后返回 approved', r.decision === 'approved');
  check('批准后发出 plan_decided', events.some((e) => e.type === 'plan_decided' && e.approved === true));
  check('没补意见时不塞一个空 feedback 给模型（它会被引导去找一句不存在的话）', !('feedback' in r), JSON.stringify(r));

  // 批准时顺手在同一框里补的那一句也要一起走：活数据里它被两层各丢一次（前端只发 approved、
  // 服务端这一支只读 approved），结果是模型重开一道题把方言问了回来。
  const p1b = session.execPresentPlan({ plan: '按依赖顺序讲五个概念' });
  const planEvt1b = events.filter((e) => e.type === 'plan').pop();
  session.decidePlan(planEvt1b.planId, { approved: true, feedback: '主要用 JS' });
  const r1b = await p1b;
  check('批准时带的那句意见原样交回模型',
    r1b.decision === 'approved' && r1b.feedback === '主要用 JS' && r1b.note.includes('主要用 JS'),
    JSON.stringify(r1b));

  const p2 = session.execPresentPlan({ plan: '改成先讲再问' });
  const planEvt2 = events.filter((e) => e.type === 'plan').pop();
  session.decidePlan(planEvt2.planId, { approved: false, feedback: '顺序反过来' });
  const r2 = await p2;
  check('退回时把意见带回给模型', r2.decision === 'changes_requested' && r2.feedback === '顺序反过来');
  planOutcomes.push(r.decision, r2.decision);
}
check('两种裁决都走通了', planOutcomes.join(',') === 'approved,changes_requested');
// 空 plan 直接拒，别让模型用一个空壳卡住学习者
check('空 plan 被拒绝', (await session.execPresentPlan({ plan: '   ' })).ok === false);

// ─────────────────────────────────────── 7f. 子 agent / 后台任务

section('7f. 子 agent 与后台任务');
const { TaskRunner } = await import('../server/tasks.mjs');
const runnerEvents = [];
const runner = new TaskRunner({
  registry,
  rulesText: '（测试用规则）',
  onEvent: (e) => runnerEvents.push(e),
});
const nbWithRunner = {
  ...session.notebook,
  todos: [],
};
session.taskRunner = runner;
session.modelRef = { provider: 'faux', model: fauxModel.id };

// 没有 taskRunner 时优雅失败，不抛
const noRunnerResponse = await (() => {
  const backup = session.taskRunner;
  session.taskRunner = null;
  return session.execSpawnSubagent({ instructions: '查一下' }).finally(() => {
    session.taskRunner = backup;
  });
})();
check('没配 runner 时 spawn 返回错误不抛', noRunnerResponse.ok === false);

// 派一个真分身：faux 脚本会回一段"结论"
faux.setResponses([fauxAssistantMessage([fauxText('分身结论：闭包握的是绑定。')])]);
const sub = await session.execSpawnSubagent({ title: '查闭包语义', instructions: '用一句话说清闭包捕获什么' });
check('子 agent 返回 done', sub.status === 'done', JSON.stringify(sub).slice(0, 200));
check('分身结论交回给主会话', (sub.conclusion || '').includes('绑定'));
check('分身事件推给前端', runnerEvents.some((e) => e.type === 'task_start' && e.task.kind === 'subagent'));
check('分身只被记成 subagent 一种', runner.list({ kind: 'subagent' }).length === 1);

// 后台任务：非阻塞，立刻拿到 id
faux.setResponses([fauxAssistantMessage([fauxText('后台结论：三道题草稿。')])]);
const bg = session.execRunBackground({ title: '预生成三道题', instructions: '出三道 closures 练习题' });
check('后台任务立刻返回 id', typeof bg.task_id === 'string' && bg.status === 'running');
check('后台任务一开始就是 running', runner.get(bg.task_id).status === 'running');
const waited = await new Promise((r) => {
  const tick = setInterval(() => {
    const t = runner.get(bg.task_id);
    if (t && t.status !== 'running') { clearInterval(tick); r(t); }
  }, 50);
  setTimeout(() => { clearInterval(tick); r(runner.get(bg.task_id)); }, 8000);
});
check('后台任务能跑完', waited.status === 'done', `status=${waited.status} err=${waited.error || ''}`);
check('后台结论可读回', (waited.output || '').includes('三道题'));
const read = session.execReadBackground({ task_id: bg.task_id });
check('read_background_task 拿到结论', read.status === 'done' && read.conclusion.includes('三道题'));
check('list_background_tasks 列出两种任务', (() => {
  const l = session.execListBackground();
  return l.ok && l.count === 2 && l.tasks.some((t) => t.kind === 'background');
})());
check('读不存在的任务报错不抛', session.execReadBackground({ task_id: 'nope' }).ok === false);
check('停一个不存在的任务报错不抛', session.execStopBackground({ task_id: 'nope' }).ok === false);
// 停掉一个真在跑的任务：让分身去问一个没人答的问题，它就永远卡在 running，
// 这样才能确定"停"发生在它完成之前。
faux.setResponses([
  fauxAssistantMessage(
    [fauxToolCall('ask_user_question', { id: 'q-hang', concept_id: 'none', question: '卡住了吗？', options: [{ label: '是' }, { label: '否' }] })],
    { stopReason: 'toolUse' },
  ),
]);
const hanging = session.execRunBackground({ title: '会卡住的任务', instructions: '问一个问题然后等' });
await new Promise((r) => setTimeout(r, 200));
check('卡住的任务确实还在 running', runner.get(hanging.task_id).status === 'running', runner.get(hanging.task_id).status);
check('停任务返回 ok', session.execStopBackground({ task_id: hanging.task_id }).ok === true);
await new Promise((r) => setTimeout(r, 500));
check('停掉后状态是 stopped', runner.get(hanging.task_id).status === 'stopped', runner.get(hanging.task_id).status);
check('停掉的任务再停一次会说明原因', session.execStopBackground({ task_id: hanging.task_id }).ok === false);
// 分身改动不到学习状态（隔离性）
check('分身没碰主会话的 learning 状态', session.progress.concepts['closures'].state === 'seen');

/*
 * ── 第十八轮：分身读配置必须走**那个**读取口。
 * tasks.mjs 原来自带一份局部 readJsonSafe（同名遮蔽 config.mjs 的那一份）：坏 JSON 直接兜成
 * 默认值，不留 `.corrupt-` 副本、不喊话。settings.json / credentials.json 只有走分身这条路时
 * 会经过它——于是"配置坏了"这件事在日志和盘上都不留痕迹（全仓其他 JSON 读取都有证据纪律）。
 * 这条钉子做的事：把 settings.json 写坏 → 派一个真分身（它内部要读设置取 Decision 选项）→
 * 断言证据留下了、话也喊出来了。删掉 config 里的留证据逻辑，或把它调回局部版本，这里就红。
 */
{
  const settingsProbe = path.join(process.env.SOCRATIC_DATA_DIR, 'settings.json');
  const settingsWas = fs.existsSync(settingsProbe) ? fs.readFileSync(settingsProbe) : null;
  const shout = [];
  const realErr = console.error;
  console.error = (...args) => { shout.push(args.join(' ')); };
  try {
    fs.writeFileSync(settingsProbe, '{ "decision": 半截配置 ← 分身读取口探针');
    faux.setResponses([fauxAssistantMessage([fauxText('分身结论：证据应该留下。')])]);
    const probed = await session.execSpawnSubagent({ title: '读取口探针', instructions: '说一句话' });
    check('settings 坏成分身照样跑得完（降级不炸）', probed.status === 'done', `status=${probed.status}`);
  } finally {
    console.error = realErr;
  }
  const dirOfSettings = path.dirname(settingsProbe);
  const settingsCopies = fs.readdirSync(dirOfSettings).filter((f) => f.startsWith('settings.json.corrupt-'));
  check('分身读坏 settings.json 也留证据副本（走的是统一读取口，不是局部兜底）',
    settingsCopies.length === 1, settingsCopies.join(','));
  check('损坏喊话里点名 settings.json（不静默降级）',
    shout.some((s) => s.includes('[数据损坏]') && s.includes('settings.json')), shout.join(' | ').slice(0, 200));
  if (settingsWas === null) fs.rmSync(settingsProbe, { force: true }); else fs.writeFileSync(settingsProbe, settingsWas);
  for (const f of settingsCopies) fs.rmSync(path.join(dirOfSettings, f), { force: true });
}

// ─────────────────────────── 7f-2. 落盘的回读：jobs/*.json 不是写进去就完事（第十九轮）

section('7f-2. 任务记录回读：僵尸 running 读成 interrupted + 归属这道门');

/*
 * 探针 19-A / 19-C 的单元测试版。原来 tasks.mjs 只写不读：注释写着「刷新/重启后还能翻出来」，
 * list/get 却只看内存 Map（实测：重启后 GET /tasks 0 条，盘上还有 1 条 done 记录）；
 * 服务被杀时盘上那条永远停在 running，读回来照原样喊"进行中"就是撒谎。
 * 这里用两个 TaskRunner 实例演"重启"：runnerB 内存全空，只有盘——它必须能把记录翻回来，
 * 并把这台进程没有句柄的 running 如实读成 interrupted。
 */
{
  const hydrateNb = store.createNotebook({ topic: '回读探针', goal: null, pace: 'normal' }).id;
  const jobsDirP = path.join(process.env.SOCRATIC_DATA_DIR, 'notebooks', hydrateNb, 'jobs');
  const readDisk = (id) => JSON.parse(fs.readFileSync(path.join(jobsDirP, `${id}.json`), 'utf8'));
  const runnerA = new TaskRunner({ registry, rulesText: '（回读探针）', onEvent: () => {} });
  // 直接造记录、不真跑分身：这一节验的是读回来的路，不是执行的路
  const recLive = runnerA._create({ notebookId: hydrateNb, kind: 'background', title: '这台进程还拿着的', instructions: 'x' });
  recLive.abort = new AbortController(); // 假句柄：活任务的判据是"这台进程有没有它的句柄"
  const recZombie = runnerA._create({ notebookId: hydrateNb, kind: 'background', title: '跟着旧进程没掉的', instructions: 'x' });
  delete recZombie.abort; // 服务被杀：句柄没了，盘上那条永远停在 running

  // 持句柄这一侧先验一遍：running 就该是 running，且回读不许把活任务的文件改花
  check('本机有句柄的任务读起来仍是 running', runnerA.get(recLive.id).status === 'running');
  check('回读不误伤活任务（句柄在，盘上那份保持 running）',
    runnerA.list({ notebookId: hydrateNb }).find((t) => t.id === recLive.id)?.status === 'running'
    && readDisk(recLive.id).status === 'running', readDisk(recLive.id).status);

  // 换个 runner = 重启后的新进程：内存全空，只剩盘
  const runnerB = new TaskRunner({ registry, rulesText: '（回读探针）', onEvent: () => {} });
  const listed = runnerB.list({ notebookId: hydrateNb });
  check('重启后盘上的任务翻得回来（条数对）', listed.length === 2, JSON.stringify(listed.map((t) => t.id)));
  check('两条都从盘上找回了标题', listed.every((t) => typeof t.title === 'string' && t.title.length > 0));
  const zombieView = listed.find((t) => t.id === recZombie.id);
  check('盘上写着 running、本机没句柄 → 如实读成 interrupted',
    zombieView?.status === 'interrupted', `status=${zombieView?.status}`);
  check('重启后连"还活着"那条也如实读成 interrupted（句柄确实没了）',
    listed.find((t) => t.id === recLive.id)?.status === 'interrupted');
  check('中断记录带一句为什么（不是光秃秃一个状态）',
    Boolean(zombieView?.note) && zombieView.note.includes('重启'), zombieView?.note || '(无 note)');

  // 僵尸就地治好：读回来时状态与盘上不符就补写回去一次，谎不许每刷新一次重圆一次
  check('补写回盘：僵尸那条现在写着 interrupted', readDisk(recZombie.id).status === 'interrupted', readDisk(recZombie.id).status);
  check('补写的僵尸带 finishedAt 与 note（终态就该有终态的样子）',
    Boolean(readDisk(recZombie.id).finishedAt) && Boolean(readDisk(recZombie.id).note));
  check('补写幂等：再读一遍还是 interrupted，不来回翻转',
    runnerB.list({ notebookId: hydrateNb }).find((t) => t.id === recZombie.id)?.status === 'interrupted'
    && readDisk(recZombie.id).status === 'interrupted');

  // get() 也要能凭 id 从盘上认人（重启后 read_background_task 问的就是这种来路不明的 id）
  const runnerC = new TaskRunner({ registry, rulesText: '（回读探针）', onEvent: () => {} });
  const gotZombie = runnerC.get(recZombie.id);
  check('get(id) 也能从盘上翻回来（不只看内存）',
    gotZombie?.id === recZombie.id && gotZombie.status === 'interrupted', JSON.stringify(gotZombie));
  check('形状不对的 id 不拿去拼路径（查无此任务，不抛）',
    runnerC.get('../../settings') === null && runnerC.get('job-nope-nope') === null);
  check('id 前缀与 kind 对不上就不认领（被人动过的文件）',
    (() => {
      const junkName = `sub-${Date.now().toString(36)}-f.json`;
      fs.writeFileSync(path.join(jobsDirP, junkName),
        JSON.stringify({ id: junkName.replace('.json', ''), kind: 'background', notebookId: hydrateNb, status: 'done' }));
      const denied = runnerC.get(junkName.replace('.json', '')) === null;
      fs.rmSync(path.join(jobsDirP, junkName), { force: true }); // 用完就清，别污染后面的导出计数
      return denied;
    })());

  // 归属这道门：别的本不能停这一本的任务（探针 19-D 的单元版）
  const otherNb = store.createNotebook({ topic: '隔壁本', goal: null, pace: 'normal' }).id;
  const stopCross = runnerB.stop(recZombie.id, otherNb);
  check('跨本 stop 拒绝并标 crossNotebook',
    stopCross.ok === false && stopCross.crossNotebook === true, JSON.stringify(stopCross));
  const stopInterrupted = runnerB.stop(recZombie.id, hydrateNb);
  check('停一条已中断的任务：如实说没有还在跑的东西', stopInterrupted.ok === false, JSON.stringify(stopInterrupted));
  const stopOwn = runnerA.stop(recLive.id, hydrateNb);
  check('本本内 stop 认得活任务（带句柄那条真被请求停止）', stopOwn.ok === true, JSON.stringify(stopOwn));

  // 工具这一侧：read 到中断就说中断，别让模型以为它做完了
  const probeSession = new TeachingSession({
    registry, notebook: store.getNotebook(hydrateNb), emit: () => {},
    signal: new AbortController().signal, taskRunner: runnerB,
    modelRef: { provider: 'faux', model: fauxModel.id },
  });
  const readInterrupted = probeSession.execReadBackground({ task_id: recZombie.id });
  check('read_background_task 读回中断任务：ok=false + status=interrupted',
    readInterrupted.ok === false && readInterrupted.status === 'interrupted', JSON.stringify(readInterrupted));
  check('中断时给"重新派一次"的出口，不假装完成',
    String(readInterrupted.note || '').includes('重新派'), JSON.stringify(readInterrupted));
  check('read 查无此任务还是老实地报没有', probeSession.execReadBackground({ task_id: 'sub-ffff-9' }).ok === false);
  check('execStopBackground 也带归属（别本 id 停不掉）',
    (() => {
      const s = new TeachingSession({
        registry, notebook: store.getNotebook(otherNb), emit: () => {},
        signal: new AbortController().signal, taskRunner: runnerB,
        modelRef: { provider: 'faux', model: fauxModel.id },
      });
      const r = s.execStopBackground({ task_id: recZombie.id });
      return r.ok === false && String(r.error).includes('不属于');
    })());

  // 整本导出带上任务记录（"派过什么分身、结果如何"的凭据，备份不该漏）
  const bundleJobs = store.exportNotebook(hydrateNb);
  check('整本导出带上 jobs（任务记录不再漏）',
    Array.isArray(bundleJobs.jobs) && bundleJobs.jobs.length === 2, JSON.stringify(bundleJobs.jobs?.map?.((j) => j.id)));
  check('导出的 jobs 里 id 与盘上一致',
    bundleJobs.jobs.every((j) => fs.existsSync(path.join(jobsDirP, `${j.id}.json`))));
  // 导入有意无视 jobs：旧机器上的运行日志不属于新机器，还原出来只会凭空造一堆中断历史
  const restoredJobs = store.importNotebook(bundleJobs);
  check('导入还原出的新本不带 jobs 目录（不凭空造中断历史）',
    !fs.existsSync(path.join(process.env.SOCRATIC_DATA_DIR, 'notebooks', restoredJobs.id, 'jobs')), restoredJobs.id);
}

// ─────────────────── 7f-3. 删除的学习不许被分身复活：写盘那道门 + 鬼目录要看得见（第二十轮）

section('7f-3. 落盘先看学习还在不在：鬼目录造不出来 + 体检不再把它数成一本书');

/*
 * 探针 20-A 的单元版。第十八轮的删除守卫只看 activeTurns，认不出分身：回合派完任务就收尾，
 * 任务还 running 时删除照样 200。任务一收尾 _finish 就往 jobs/ 写盘，而写盘用的是
 * `mkdirSync(dir, { recursive: true })`——它会把整个笔记本目录从无到有 mkdir 回来，
 * 只剩一份 jobs/*.json 的"鬼目录"就是这么来的。
 * 这一节验两道门：写之前先问「这一本还在吗」（notebookExists，判据与 assertExists 同源），
 * 以及体检那张嘴不再把鬼目录当一本学习。
 */
{
  const ghostNb = store.createNotebook({ topic: '删掉还活着（单元）', goal: null, pace: 'normal' }).id;
  const nbRoot = path.join(process.env.SOCRATIC_DATA_DIR, 'notebooks');
  const dirOf = (id) => path.join(nbRoot, id);
  const runnerW = new TaskRunner({ registry, rulesText: '（写盘门探针）', onEvent: () => {} });

  check('还在的学习认得（notebookExists 与 assertExists 同一个判据）',
    notebookExists(ghostNb) === true);
  check('非法 id 不算存在（不把路径穿越当"在不在"问一遍）',
    notebookExists('../../settings') === false && notebookExists('') === false);
  /*
   * 上面那条在"判据不再过 safeId"的退化版本下照样绿（`../../settings/notebook.json`
   * 本就查无此文件）——那是颗只会点头的钉子。要真把「先 safeId 再问盘」这个次序钉住，
   * 得拿一个**盘上真存在、但形状不合法**的目录来问：合法形状是判据的一部分，
   * 不是"存在性"之外的另一回事。
   */
  const weirdDir = path.join(nbRoot, 'a:b');
  fs.mkdirSync(weirdDir, { recursive: true });
  fs.writeFileSync(path.join(weirdDir, 'notebook.json'), JSON.stringify({ id: 'a:b', title: '形状不合法的那一本' }));
  check('盘上真有这么一个目录，但形状不合法就不算一本学习（判据先过 safeId，再问盘）',
    fs.existsSync(path.join(weirdDir, 'notebook.json')) && notebookExists('a:b') === false,
    'notebookExists 开始承认非合法形状的 id 了（门与 store 的口径会因此分家）');
  fs.rmSync(weirdDir, { recursive: true, force: true });

  // 正常路径先验一遍：门关着时写盘该留痕，后面才知道"没留痕"真的是门起了作用
  const recBefore = runnerW._create({ notebookId: ghostNb, kind: 'background', title: '收尾之前删掉的', instructions: 'x' });
  check('场景成立：学习还在时 _create 落了盘',
    fs.existsSync(path.join(dirOf(ghostNb), 'jobs', `${recBefore.id}.json`)));

  // 删掉整本 → 分身这时才收尾（探针 20-A 里那一步）
  store.deleteNotebook(ghostNb);
  const ghost = (() => {
    try {
      runnerW._finish(recBefore, { status: 'stopped', output: '' });
    } catch (err) {
      return { threw: err.message };
    }
    return { dirBack: fs.existsSync(dirOf(ghostNb)) };
  })();
  check('收尾写盘不再把删掉的目录 mkdir 回来（鬼目录的源头堵住了）',
    ghost.dirBack === false, JSON.stringify(ghost));
  check('这道门明说没落下去（返回 false，调用方不用猜），内存里的记录照常收尾',
    runnerW._writeJob(ghostNb, recBefore) === false && runnerW.get(recBefore.id)?.status === 'stopped',
    `门返回 ${runnerW._writeJob(ghostNb, recBefore)}，状态 ${runnerW.get(recBefore.id)?.status}`);

  // 另一头：学习不在了就不该再有新任务落盘（重启后从盘上翻出僵尸、再派一次这类路径）
  const recAfter = runnerW._create({ notebookId: `${ghostNb}-nope`, kind: 'background', title: '派给不存在的学习', instructions: 'x' });
  check('给不存在的学习派任务不落盘（也不会顺手造一个目录）',
    fs.existsSync(path.join(dirOf(`${ghostNb}-nope`))) === false);
  fs.rmSync(dirOf(recAfter.notebookId), { recursive: true, force: true });

  // 体检这一侧：手工造一个鬼目录（等价于第二十轮之前的盘），它不该被数成一本书
  const handGhost = 'ghost-probe-aaaaaa';
  fs.mkdirSync(path.join(dirOf(handGhost), 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(dirOf(handGhost), 'jobs', 'job-ghost-1.json'),
    JSON.stringify({ id: 'job-ghost-1', kind: 'background', notebookId: handGhost, status: 'done' }));
  const beforeGhost = store.healthCheck();
  check('鬼目录被体检点名（凭空冒出的目录不再是无人认领的事）',
    (beforeGhost.ghostDirs || []).some((g) => g.notebook === handGhost), JSON.stringify(beforeGhost.ghostDirs));
  check('点名的条目带目录里的东西（人不用自己翻盘就知道里面是什么）',
    (beforeGhost.ghostDirs || []).find((g) => g.notebook === handGhost)?.contents?.includes('jobs') === true,
    JSON.stringify((beforeGhost.ghostDirs || []).find((g) => g.notebook === handGhost)));
  check('鬼目录不充进 notebooks 本数', (() => {
    const real = fs.readdirSync(nbRoot).filter((n) => fs.existsSync(path.join(nbRoot, n, 'notebook.json'))).length;
    return beforeGhost.notebooks === real;
  })(), JSON.stringify({ reported: beforeGhost.notebooks }));
  check('鬼目录进 ok=false（此刻盘上真存在的一处不该存在，不是往事）',
    beforeGhost.ok === false, JSON.stringify({ ok: beforeGhost.ok, ghosts: (beforeGhost.ghostDirs || []).length }));

  // 判据同源：三处（assertExists / notebookExists / 体检）对"什么是一本学习"口径一致
  check('判据同源：鬼目录既不算存在、也不进 listNotebooks',
    notebookExists(handGhost) === false && !store.listNotebooks().some((n) => n.id === handGhost));
  fs.rmSync(dirOf(handGhost), { recursive: true, force: true });
  const afterGhost = store.healthCheck();
  check('清掉之后不再点名（报告跟着盘上事实走，不是历史清单）',
    !(afterGhost.ghostDirs || []).some((g) => g.notebook === handGhost), JSON.stringify(afterGhost.ghostDirs));
}

// ─────────────────── 7f-4. 分身交付要带户口：task_artifact 事件自带归属 + notes 补门（第二十一轮）

section('7f-4. task_artifact 必须说得出"我是谁家的分身" + notes 写盘那道门');

/*
 * 探针 21-B / 21-C 的单元版。宿主替分身交付的制品"上台 + 落账"这一段，读代码看是齐的——
 * placeOnDesk(nid) / upsertChatMessage(nid) 都写着；但 nid 取自 event.task?.notebookId，
 * 而 tasks.mjs 发这个事件时只带 taskId（不带 task），于是 nid 恒 undefined：两个 if (nid)
 * 一次都没进过，制品既不上台也不记账（实测：先开了场、manifest 有件、台面 props 仍为空、
 * chat 无账）；归属查不到，事件又落进"广播给所有订阅者"的兜底，A 本 21KB 的整份 HTML
 * 发给了每一本开着后台面板的浏览器。形状钉子（分支里有 placeOnDesk、顺序对）全绿——
 * 这一节补的是**行为**：真跑一次交付制品的分身，看事件带不带户口、门执不执行。
 */
{
  const artNb = store.createNotebook({ topic: '分身交制品', goal: null, pace: 'normal' }).id;
  const dirOfArt = path.join(process.env.SOCRATIC_DATA_DIR, 'notebooks', artNb);
  // 先把场开出来：排除"没台可上"这种解释（探针 21-C 特意验过的一格）
  store.saveSceneState(artNb, {
    version: 1, index: 1,
    current: { id: 'scene-01', index: 1, title: '第一幕', phase: 'teach', props: [], concepts: [] },
    log: [],
  });
  const artEvents = [];
  const artRunner = new TaskRunner({ registry, rulesText: '（归属探针）', onEvent: (e) => artEvents.push(e) });
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall(TOOL_NAMES.SHARE_ARTIFACT, {
        title: '躲障碍', kind: 'game',
        html: '<html><head></head><body>art21</body></html>',
      }),
    ], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('制品已交付。')]),
  ]);
  const artRec = artRunner._create({
    notebookId: artNb, kind: 'background', title: '做个大件', instructions: '做一个小游戏并交付',
    modelRef: { provider: 'faux', model: fauxModel.id },
  });
  await artRunner.run(artRec, { notebook: store.getNotebook(artNb) });
  const artEvt = artEvents.find((e) => e.type === 'task_artifact');
  check('场景成立：分身真的交付了一件（task_artifact 在场）', Boolean(artEvt), artEvents.map((e) => e.type).join(','));
  check('task_artifact 自带归属：event.task.notebookId 就是派出它的那一本（宿主那两只 if (nid) 从此有 nid）',
    artEvt?.task?.notebookId === artNb && artEvt?.task?.id === artRec.id,
    JSON.stringify({ taskId: artEvt?.taskId, task: artEvt?.task ? { id: artEvt.task.id, nb: artEvt.task.notebookId } : null }));

  // 归属在，行为就要兑现。但"上台 + 落账"是 serve.mjs 的宿主逻辑，单元测试里
  // runner 的 onEvent 只是收事件——那两件事的真钉子住在 http-smoke §23（真服务全链路）。
  // 这里钉得住的是：事件本身带户口、投递键取自它、兜底广播必须死。
  // 分身交付的这件至少真的落了盘（文件 + manifest），否则后面全无从谈起。
  const artFiles = (store.getNotebook(artNb).artifacts || []).map((a) => a.id);
  check('分身交付的这件真的落了盘（manifest 有它——宿主上台用的是这件，不是另一件）',
    Boolean(artEvt?.artifact?.id) && artFiles.includes(artEvt.artifact.id), JSON.stringify(artFiles));

  // 跨本投递这一侧（HTTP 全链路在 http-smoke §23）：这里钉住投递键的取值纪律——
  // 投递只认 event.task.notebookId；查无归属必须**不投**，旧兜底「广播给所有订阅者」不许复活。
  const serveSrcForBus = fs.readFileSync(new URL('../server/serve.mjs', import.meta.url), 'utf8');
  check('投递键直接取自事件自带的归属（不再是查不到再兜底）',
    /taskStreamWrite\(event\.task\.notebookId/.test(serveSrcForBus)
    && !/for \(const key of \[\.\.\.taskStreams\.keys\(\)\]\) taskStreamWrite/.test(serveSrcForBus),
    '广播兜底还活着，或者投递没改读自带归属');
  fs.rmSync(dirOfArt, { recursive: true, force: true });
}

/*
 * notes.mjs 的 write()（第二十轮遗留 §5.1）：全仓最后一处不先问"学习还在不在"就往
 * notebooks/<id>/ 下 mkdir 的写口。saveNote 在回合/分身里跑，删除与人手 rm 的窄竞态
 * 一旦撞上，notes.json 就把删掉的整本补回一个角——和 jobs/ 那一下同形，只是这轮之前
 * 可触达路径被两道守卫挡着。判据与 assertExists / notebookExists 同源（同一个 NOTEBOOK_FILE）。
 */
{
  const { saveNote: gateSave, updateNote: gateUpdate, deleteNote: gateDelete } = await import('../server/notes.mjs');
  const noteGateNb = store.createNotebook({ topic: '笔记门', goal: null, pace: 'normal' }).id;
  const noteDir = path.join(process.env.SOCRATIC_DATA_DIR, 'notebooks', noteGateNb);
  const n1 = gateSave(noteGateNb, { title: '还在的时候', summary: '正常落盘', key_points: [], example: '', concepts: [] });
  check('学习还在时 saveNote 照常落盘（门不许过严）',
    Boolean(n1?.id) && fs.existsSync(path.join(noteDir, 'notes.json')));
  store.deleteNotebook(noteGateNb);
  check('删干净了', !fs.existsSync(noteDir));
  // 迟到的那一下：分身/旧回合手里还攥着 id，收尾时补记一条笔记
  const late = gateSave(noteGateNb, { title: '迟到的笔记', summary: '往已删的学习上写', key_points: [], example: '', concepts: [] });
  check('学习没了就不许落盘：返回 null，一个字节都不写（鬼目录少一个来源）',
    late === null && !fs.existsSync(noteDir), `late=${JSON.stringify(late)}`);
  const upd = gateUpdate(noteGateNb, 'note-anything', { title: 'x' });
  const del = gateDelete(noteGateNb, 'note-anything');
  check('updateNote / deleteNote 在学习不在时同样查无此条（不炸盘也不造目录）',
    upd === null && del === null && !fs.existsSync(noteDir));
  // 判据不许漂成"目录在就算在"（第二十轮 m15 的同一种瞎）：手造一个只有空目录的鬼本，
  // 门若问的是目录，它就会放行并把 notes.json 写进一个根本不存在的学习里。
  fs.mkdirSync(noteDir, { recursive: true });
  const ghostDirNote = gateSave(noteGateNb, { title: '鬼目录里写一条', summary: '只有目录没有 notebook.json', key_points: [], example: '', concepts: [] });
  check('光有目录不算一本学习：门问的是 notebook.json 那一份判据，不是目录在不在',
    ghostDirNote === null && !fs.existsSync(path.join(noteDir, 'notes.json')),
    `late=${JSON.stringify(ghostDirNote)}`);
  // 门没装上时这里会留下鬼目录（红-绿期间的第一手证据就是它），无论成败都清干净，
  // 别让它拖累后面 12c「健康目录体检报告 ok」——那是另一颗钉子的地盘。
  fs.rmSync(noteDir, { recursive: true, force: true });
}

// ─────────────────── 7f-5. 一本学习的身份要只有一个来源：地址是目录名，不是盘上那行 id（第二十二轮）

section('7f-5. 身份只有一个来源：列表发的地址一定打得开，盘上的 id 只是资料');

/*
 * 探针 22-A / 22-C / 22-E / 22-H 的单元版。过去"这一本是谁"有两个来源：
 * 路由与 store 动手时用的是**目录名**（assertExists → notebooks/<目录名>），
 * 而列表、GET 整本、导出对外报的是**盘上 notebook.json 里的 meta.id**。
 * 写侧 PATCH 又把整个请求体原样并进 meta，于是 meta.id 可以被任意改掉——两边一分家，
 * 界面就拿到一个打不开的地址：
 *   - 改成别人的名字 → 列表两行同一个 id，点哪一行开的都是同一本（B 的行点开是 A）；
 *   - 改成 null → 这本从列表消失（listNotebooks 有 `if (!meta?.id) continue`），GET 整本照旧 200；
 *   - 盘上目录名形状不合法（a:b）→ 列表照样发它，点进去 400；
 *   - meta 里压根没写 id → 这本对列表隐身，按目录名却取得到。
 * 现在的口径：**目录名就是身份**，meta.id 只是资料；列表只发打得开的地址。
 */
{
  const idRoot = path.join(process.env.SOCRATIC_DATA_DIR, 'notebooks');
  const dirOfName = (name) => path.join(idRoot, name);
  const metaOf = (name) => JSON.parse(fs.readFileSync(path.join(dirOfName(name), 'notebook.json'), 'utf8'));

  const ownA = store.createNotebook({ title: '正主', topic: '甲-topic', goal: null, pace: 'normal' }).id;
  const ownB = store.createNotebook({ title: '邻居', topic: '乙-topic', goal: null, pace: 'normal' }).id;

  // ① 改掉盘上的 id：地址不许跟着漂
  const metaB = metaOf(ownB);
  metaB.id = ownA;
  fs.writeFileSync(path.join(dirOfName(ownB), 'notebook.json'), JSON.stringify(metaB, null, 2));
  const rows = store.listNotebooks();
  const rowB = rows.find((n) => n.title === '邻居');
  check('列表给的地址就是这一本自己的目录（盘上 meta.id 冒充谁都不算）',
    rowB?.id === ownB, `row.id=${rowB?.id} 目录=${ownB}`);
  check('两本不会挤成同一个地址（列表里 id 不重复——撞名时点哪行开的都不是同一本）',
    new Set(rows.map((n) => n.id)).size === rows.length,
    rows.map((n) => `${n.id}(${n.title})`).join(','));
  check('照列表给的地址取整本，取到的就是那一行（不是别人的）',
    rowB && store.getNotebook(rowB.id).title === '邻居');
  // ② GET 整本返回的 id 也要是地址：agent / serve 落盘用的就是这份 notebook.id
  const fetchedB = store.getNotebook(ownB);
  check('getNotebook 回的是地址（拿它当键写盘不会写进别人家）',
    fetchedB.id === ownB, `返回 id=${fetchedB.id}`);
  // ③ meta 里没写 id 的那本不许对列表隐身
  const metaA = metaOf(ownA);
  delete metaA.id;
  fs.writeFileSync(path.join(dirOfName(ownA), 'notebook.json'), JSON.stringify(metaA, null, 2));
  // 取证要按"哪一本"取：上面 ① 已经把 ownB 的盘上 id 写成 ownA，只查 id 在不在列表里
  // 会被那颗冒名的行顶绿——这是一颗只会点头的钉子的形状（第二十一轮 m20 的同一种病）。
  check('盘上没写 id 的学习照样在列表里（地址来自目录，不来自那行字段）',
    store.listNotebooks().some((n) => n.id === ownA && n.title === '正主'),
    store.listNotebooks().map((n) => `${n.id}(${n.title})`).join(','));
  // ④ 形状不合法的目录不可寻址，就不该出现在列表里发一张点不开的链接
  fs.mkdirSync(dirOfName('a:b'), { recursive: true });
  fs.writeFileSync(path.join(dirOfName('a:b'), 'notebook.json'), JSON.stringify({ id: 'a:b', title: '形状不合法的一本' }));
  const listed22 = store.listNotebooks();
  check('非法形状的目录不进列表（列表不许发点进去 400 的地址）',
    !listed22.some((n) => n.id === 'a:b'), listed22.map((n) => n.id).join(','));
  // ⑤ 体检要把"盘上的 id 与地址分家"点名——修好之前它就是盘上一处该看一眼的事实
  const drift = store.healthCheck().identityDrift || [];
  check('体检点名身份错位（目录名 ≠ 盘上写的 id，含缺字段那种）',
    drift.some((d) => d.notebook === ownB && d.metaId === ownA)
    && drift.some((d) => d.notebook === ownA && (d.metaId === null || d.metaId === undefined)),
    JSON.stringify(drift));
  // ⑤b 本数只数打得开的（第二十轮 ghost 那条判据的同一形状：独立从盘上算一遍真值）
  check('打不开的目录不充进本数（数成一本书=假装它打得开）',
    store.healthCheck().notebooks === fs.readdirSync(idRoot).filter((name) =>
      safeId(name) && fs.existsSync(path.join(idRoot, name, 'notebook.json'))).length,
    JSON.stringify({ reported: store.healthCheck().notebooks }));
  /*
   * ⑤c 身份这一处要真的影响 ok——变异 m10（identityDrift 不进 ok）实测抓到过这里原本只会点头：
   * 那一句 ok===false 是在 a:b 还挂着的时候打的，红的是不可寻址那笔账，错位进不进 ok 它都绿。
   * 所以先把 a:b 摘掉，让盘上只剩身份这一处不该存在，再看 ok；然后把两边都对齐，看 ok 翻回来。
   * 一红一绿两头都钉住，才是"进了 ok"，否则只是"报了但没人需要管"。
   */
  fs.rmSync(dirOfName('a:b'), { recursive: true, force: true });
  const onlyDrift = store.healthCheck();
  check('只剩身份这一处分家时 ok=false（报了却不影响 ok=白报——第二十轮的同一口径）',
    (onlyDrift.unaddressableDirs || []).length === 0 && (onlyDrift.identityDrift || []).length > 0
    && onlyDrift.ok === false,
    JSON.stringify({ ok: onlyDrift.ok, drift: (onlyDrift.identityDrift || []).length, unaddr: (onlyDrift.unaddressableDirs || []).length }));
  // ⑥ 把 meta.id 补回成地址之后：错位消失，列表与体检都说同一句话
  const fixB = metaOf(ownB); fixB.id = ownB;
  fs.writeFileSync(path.join(dirOfName(ownB), 'notebook.json'), JSON.stringify(fixB, null, 2));
  const fixA = metaOf(ownA); fixA.id = ownA;
  fs.writeFileSync(path.join(dirOfName(ownA), 'notebook.json'), JSON.stringify(fixA, null, 2));
  check('对齐之后体检不再点名（错位的判据是盘上事实，不是永远挂着）',
    !(store.healthCheck().identityDrift || []).some((d) => d.notebook === ownA || d.notebook === ownB),
    JSON.stringify(store.healthCheck().identityDrift));
  check('对齐之后 ok 翻回 true（这一处不是永远挂着，也不是只报不修）',
    store.healthCheck().ok === true, JSON.stringify(store.healthCheck(), null, 1).slice(0, 300));
  // ⑦ 三条写标题的路必须一个口径（探针 22-D：建本 5000 字照落、导入 clamp 到 120）
  const longTitle = '相'.repeat(500);
  const clampNb = store.createNotebook({ title: longTitle, topic: '口径', goal: null, pace: 'normal' });
  check('建本时标题就收口（三条路一个口径，不是导入 clamp 建本不 clamp）',
    clampNb.title.length === 120, `落盘长度=${clampNb.title.length}`);
  store.touchNotebook(clampNb.id, { title: '又一段很长很长'.repeat(40) });
  check('改名同样收口（touchNotebook 是第二条路）',
    metaOf(clampNb.id).title.length === 120, `落盘长度=${metaOf(clampNb.id).title.length}`);
  // ⑧ 盘上那行 id 不许把地址带进导出包（备份到别的机器，source.id 得是真地址）
  const metaForExport = metaOf(ownB); metaForExport.id = 'imposter';
  fs.writeFileSync(path.join(dirOfName(ownB), 'notebook.json'), JSON.stringify(metaForExport, null, 2));
  check('导出包里的 source.id 是地址（不是盘上那行可以被人改掉的字段）',
    store.exportNotebook(ownB).source.id === ownB, `source.id=${store.exportNotebook(ownB).source.id}`);
  // 收尾把 ownB 的身份补回地址：别把一处故意造的错位留给后面 12c「健康目录体检报告 ok」——
  // 那颗钉子报的是"整盘干净"，不是这一节的地盘。
  const restoreB = metaOf(ownB); restoreB.id = ownB;
  fs.writeFileSync(path.join(dirOfName(ownB), 'notebook.json'), JSON.stringify(restoreB, null, 2));

  fs.rmSync(dirOfName('a:b'), { recursive: true, force: true });
  fs.rmSync(dirOfName(clampNb.id), { recursive: true, force: true });
  // 剩下两本留给后面的套件（12c 的"健康目录体检报告 ok"会把它们清掉前先对齐——上面 ⑥ 已对齐）
}

// ─────────────────────────────────────── 7g. 结构化笔记（compile_notes）

section('7g. 结构化笔记：compile_notes 落 notes.json');

const { readNotes, exportMarkdown } = await import('../server/notes.mjs');
const beforeNotes = readNotes(meta.id).length;

const noteSaved = session.execCompileNotes({
  title: '闭包：函数带着词法环境跑',
  summary: '闭包不是复制变量，函数记住的是出生时的那个绑定本身。',
  key_points: ['inner() 捕获的是绑定，不是当时的值', 'outer 返回后绑定依然活着'],
  example: 'function outer(){ const box="…"; return ()=>box; }',
  concepts: ['closures'],
});
check('compile_notes 成功', noteSaved.ok === true, JSON.stringify(noteSaved));
check('返回 note_id', typeof noteSaved.note_id === 'string' && noteSaved.note_id.startsWith('note-'));

const saved = readNotes(meta.id);
check('笔记落盘（notes.json）', saved.length === beforeNotes + 1, `${beforeNotes} → ${saved.length}`);
const latest = saved[saved.length - 1];
check('笔记带标题与要点', latest.title.startsWith('闭包') && latest.key_points.length === 2, JSON.stringify(latest.key_points));
check('笔记带概念坐标', latest.concepts.includes('closures'));
check('笔记有时间戳', Boolean(latest.createdAt));

// 笔记进 notebook 快照（前端 renderThread 从这里回放）
check('getNotebook 带 notes', Array.isArray(store.getNotebook(meta.id).notes));

// 缺字段要拒绝，不许存半条
check('缺 summary 被拒绝', session.execCompileNotes({ title: '只给标题' }).ok === false);

// 导出：notes.json → Markdown
const md = exportMarkdown('JS 闭包', saved);
check('导出含标题与要点', md.includes('# JS 闭包') && md.includes('闭包：函数带着词法环境跑') && md.includes('- inner()'));
check('导出含例子代码块', md.includes('function outer()'));

// ─────────────────────────────────────── 7g-1b. 笔记的时机挂在状态机上

section('7g-1b. 升到 understood/applied 那一刻，工具返回值点名催收笔记');

// 时机不写进规则语料（余量只剩 80 字符），也不留给模型自觉：挂在 set_progress 的返回值上，
// 因为**工具返回值是它当场读到的最后一句话**，压过规则原文和工具描述。
const closureName = session.graph?.concepts?.find((c) => c.id === 'closures')?.name || 'closures';
const closuresBefore = structuredClone(session.progress.concepts['closures']);

const promoted = await session.execSetProgress({
  updates: [{ concept_id: 'closures', state: 'understood', evidence: '学习者说出了捕获的是绑定不是值' }],
});
check('seen → understood 写进去了', promoted.ok === true && promoted.applied.length === 1, JSON.stringify(promoted));
check('讲透一个点的那一刻催收笔记', promoted.note.includes('compile_notes'), promoted.note);
check('催的是刚升上去的那个概念（不是泛泛一句）', promoted.note.includes(closureName), promoted.note);
check('措辞是"讲透了"，让模型知道凭什么是现在', promoted.note.includes('讲透了'), promoted.note);

// 探针那一跳（unknown → seen）是"接触"，不是"讲透"：答一题就被催一次笔记，催就废了
const firstTouch = Object.entries(session.progress.concepts).find(
  ([id, e]) => id !== 'closures' && e.state === 'unknown',
);
if (firstTouch) {
  const touchBefore = structuredClone(firstTouch[1]);
  const touched = await session.execSetProgress({ updates: [{ concept_id: firstTouch[0], state: 'seen' }] });
  check('unknown → seen 不催笔记', touched.note === '状态已更新。', touched.note);
  // 这一格留给后面那节「探针一答由应用自己写 seen」——它要求的正是"开局还待学"
  session.progress.concepts[firstTouch[0]] = touchBefore;
} else {
  check('unknown → seen 不催笔记（这一局没有第二个待学概念，测不到）', false, 'skipped');
}

// 被拒绝的转移维持原样，不许顺手变成催办
const denied = await session.execSetProgress({ updates: [{ concept_id: 'closures', state: 'mastered' }] });
check('跨级被拒时不催笔记', !String(denied.note).includes('compile_notes'), denied.note);

// 工具描述不许再承诺"派分身异步做"：代码是同步落盘的，两层措辞打架时模型先读到哪句信哪句
const notesTool = buildTools().find((t) => t.name === 'compile_notes');
check('笔记工具描述不再谎称派分身', !/分身|不阻塞/.test(notesTool.description), notesTool.description.slice(0, 80));
check('笔记工具描述写明同步落盘', notesTool.description.includes('当场同步落盘'), notesTool.description.slice(0, 80));
check('笔记工具描述把时机指给 set_progress_state 的返回值', notesTool.description.includes('set_progress_state'), notesTool.description);

session.progress.concepts['closures'] = closuresBefore;

// ─────────────────────────────────────── 7g-2. 笔记人机共同编辑

section('7g-2. 学生在笔记页直接改：白名单写回 + 出处 + 删除');

const { updateNote, deleteNote, saveNote } = await import('../server/notes.mjs');
const mine = saveNote(meta.id, {
  title: '原始标题',
  summary: '原始摘要',
  key_points: ['要点一', '要点二'],
  example: '例子',
  concepts: ['closures'],
});
const sibling = saveNote(meta.id, { title: '隔壁那条', summary: '别碰我', key_points: [], example: '', concepts: [] });

const edited = updateNote(meta.id, mine.id, {
  title: '我自己改过的标题',
  key_points: ['要点一', '', '   ', '要点二改过了'],
  // 下面这三个都是越界的：白名单之外的字段必须一个字都写不进去
  concepts: ['HACKED'],
  id: 'note-evil',
  createdAt: '1999-01-01T00:00:00.000Z',
});
check('学生改标题写回', edited.title === '我自己改过的标题', edited.title);
check('要点里空白条目被丢掉、顺序保留', edited.key_points.join('|') === '要点一|要点二改过了', edited.key_points.join('|'));
check('白名单外的字段一概不认（id/createdAt/concepts 原样）',
  edited.id === mine.id && edited.createdAt === mine.createdAt && edited.concepts.join() === 'closures', JSON.stringify(edited));
check('没给的字段还是原来的', edited.summary === '原始摘要' && edited.example === '例子');
check('出处由服务端盖章，不接受客户端自报', edited.edited_by === 'user' && Boolean(edited.edited_at));
check('改一条不碰别条', JSON.stringify(readNotes(meta.id).find((x) => x.id === sibling.id)) === JSON.stringify(sibling));

const stamp = edited.edited_at;
const noop = updateNote(meta.id, mine.id, { concepts: ['HACKED'], id: 'note-evil' });
check('只塞非法字段等于什么都没改（出处时间不刷新）', noop.edited_at === stamp && noop.concepts.join() === 'closures', JSON.stringify(noop));
check('超长照样截：手动编辑不是绕过上限的后门', updateNote(meta.id, mine.id, { title: '很'.repeat(500) }).title.length === 120);
check('标题清空了兜一个名字，别让卡片没头', updateNote(meta.id, mine.id, { title: '   ' }).title === '未命名笔记');
check('改一条不存在的笔记返回 null（路由去给 404）', updateNote(meta.id, 'note-nope', { title: 'x' }) === null);
check('学习不存在也不炸盘', updateNote('nb-nope', 'note-nope', { title: 'x' }) === null);

const notesBeforeDelete = readNotes(meta.id).length;
const removed = deleteNote(meta.id, mine.id);
check('删除生效', removed?.ok === true && !readNotes(meta.id).some((x) => x.id === mine.id), JSON.stringify(removed));
check('删一条正好少一条，别条都在',
  readNotes(meta.id).length === notesBeforeDelete - 1 && readNotes(meta.id).some((x) => x.id === sibling.id),
  `${notesBeforeDelete} → ${readNotes(meta.id).length}`);
check('删一条不存在的返回 null', deleteNote(meta.id, 'note-nope') === null);

// 学生改过的版本必须进得了下一回合的上下文，否则老师会按自己记忆里的旧版再讲一遍
const handout = Array.from({ length: 12 }, (_, i) => ({
  title: `n-${String(i + 1).padStart(2, '0')}`,
  summary: `第 ${i + 1} 条`,
  edited_by: i === 11 ? 'user' : undefined,
}));
const handoutSnapshot = renderStateSnapshot({ graph: null, progress: { notes: [] }, notes: handout });
check('讲义进了状态快照', handoutSnapshot.includes('n-12') && handoutSnapshot.includes('第 12 条'));
check('学生改过的那条标出来，并写明以他的版本为准',
  handoutSnapshot.includes('〔学生改过〕') && handoutSnapshot.includes('以学生的版本为准'));
check('只带最近十条（别把整本讲义塞进每一回合）', !handoutSnapshot.includes('n-01') && handoutSnapshot.includes('n-03'));
check('没有讲义时快照里不多这一段',
  !renderStateSnapshot({ graph: null, progress: { notes: [] } }).includes('学生「笔记」页上已有的讲义'));

// 清掉测试笔记，别污染后续断言
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { DATA_DIR } = await import('../server/config.mjs');
  fs.rmSync(path.join(DATA_DIR, 'notebooks', meta.id, 'notes.json'), { force: true });
}

// ─────────────────────────────────────── 7h. 异步制品（prepare_artifact）

section('7h. 异步制备大件制品：prepare_artifact 立刻返回');

const pending = session.execPrepareArtifact({
  title: '躲障碍',
  kind: 'game',
  description: '一个 canvas 小游戏',
  spec: '学生控制方块上下移动躲开红色柱子，撞到重来；记录尝试次数并 SocraticStudio.emit("miss")。',
});
check('prepare_artifact 立刻返回', pending.ok === true && pending.status === 'preparing', JSON.stringify(pending));
check('返回 job_id', typeof pending.job_id === 'string' && pending.job_id.length > 0);
check('说明写明做好由宿主摆进当前这一场的台上（画布那一页在 2b 就删了，不许再承诺它）',
  /台上|台面/.test(pending.note || '') && !/画布/.test(pending.note || ''), pending.note);
check('不阻塞：返回即结束，没有 await 到任务完成', pending.status === 'preparing');

// 制品类分身的占位事件已经推给前端了
check('发出 artifact_pending 事件', events.some((e) => e.type === 'artifact_pending' && e.artifact?.title === '躲障碍'));
// 分身会以 purpose=artifact 派出，helper 规则要禁止它提问/改状态
const pendingTask = runner.get(pending.job_id);
check('任务已创建', Boolean(pendingTask), JSON.stringify(pendingTask).slice(0, 160));
check('任务标题可读', String(pendingTask.title || '').includes('躲障碍'), pendingTask.title);
runner.stop(pending.job_id);

// spec 为空要拒绝——分身看不到主会话的思路，必须写施工单
check('空 spec 被拒绝', session.execPrepareArtifact({ title: 'x', spec: '   ' }).ok === false);

// ─────────────────────────────────────── 7i. 探针作答 → 应用自己写 Unknown→Seen

section('7i. 探针一答，应用自己写 Unknown→Seen（不等老师记得调工具）');

// 现场：variable-scope 仍是 unknown（第 4 节只让老师推进了 closures）。
// 这一节全程不调 set_progress_state——状态还动不动，就是这条改动的全部。
const askOnce = async ({ conceptId, answer, question = '作用域链往上找的是哪一层？' }) => {
  const qid = `q-auto-${Math.random().toString(36).slice(2, 8)}`;
  const p = session.execAsk({ id: qid, concept_id: conceptId, question, options: [{ label: '最近的同名绑定' }] });
  await new Promise((r) => setTimeout(r, 10));
  session.answer(qid, answer);
  return p;
};

check('开局 variable-scope 还是待学', session.progress.concepts['variable-scope'].state === 'unknown');
const eventsBefore = session.pendingEvents.length;
const autoResult = await askOnce({ conceptId: 'variable-scope', answer: { selected: ['最近的同名绑定'], text: '' } });
check(
  '答完探针，应用自己把它写成 seen',
  session.progress.concepts['variable-scope'].state === 'seen',
  session.progress.concepts['variable-scope'].state,
);
check('自动那一步也记了 observed 事件', session.pendingEvents.length === eventsBefore + 1, `${session.pendingEvents.length - eventsBefore} 条`);
check('事件挂在正确的 concept 上', session.pendingEvents.at(-1).concept_id === 'variable-scope' && session.pendingEvents.at(-1).kind === 'observed');
check('证据就是学习者的作答', String(session.progress.concepts['variable-scope'].last_evidence || '').includes('最近的同名绑定'));
check('交回老师的结果里说清了这一步是谁写的', autoResult.includes('由应用记为 Seen'), autoResult.slice(-90));

// 已经 seen 的概念再答，不该重复写、更不该自己往上跳一级
session.progress.concepts['variable-scope'].last_evidence = null;
const dupEvents = session.pendingEvents.length;
const dupResult = await askOnce({ conceptId: 'variable-scope', answer: { selected: ['最近的同名绑定'], text: '' } });
check('已接触的概念不会被重复记账', session.pendingEvents.length === dupEvents && !dupResult.includes('由应用记为 Seen'));
check('应用绝不越级：seen 不会自己升成 understood', session.progress.concepts['variable-scope'].state === 'seen');

// 三种"不该写"的情况：不属于任何概念 / 跳过 / concept id 根本不存在
session.progress.concepts['variable-scope'].state = 'unknown';
session.progress.concepts['variable-scope'].last_evidence = null;
const noneEvents = session.pendingEvents.length;
await askOnce({ conceptId: 'none', answer: { selected: ['最近的同名绑定'], text: '' } });
check('事务性提问（none）不动任何状态', session.progress.concepts['variable-scope'].state === 'unknown' && session.pendingEvents.length === noneEvents);
await askOnce({ conceptId: 'variable-scope', answer: { selected: [], text: '', skipped: true } });
check('跳过不算首次接触', session.progress.concepts['variable-scope'].state === 'unknown' && session.pendingEvents.length === noneEvents);
const bogus = await askOnce({ conceptId: 'no-such-concept', answer: { selected: ['最近的同名绑定'], text: '' } });
check('乱填的 concept id 写不动状态，也不抛', session.progress.concepts['variable-scope'].state === 'unknown' && !bogus.includes('由应用记为 Seen'));

// schema 层面为什么可靠：concept_id 是必填字段，缺它连参数校验都过不去（见第 7 节）

// ─────────────────────────────────────── 7j. 跨轮历史：题卡要还原成工具调用

section('7j. 下一轮看历史：题卡必须还原成 toolCall，作答必须在上下文里');

// 现场照 data/notebooks/*/chat.json 的真实形状抄：题卡挂在 assistant 消息的
// questions 上，作答在 questions[i].answer。以前重建历史只抄 content，于是
// 历史里每一条 assistant 都是"纯文本、没用过工具"——模型讲十几轮就学着它的样子
// 把问题写进正文（题面以冒号收尾、卡片再也不出现），学习者的答语更是彻底消失。
const histFixture = [
  { role: 'user', content: '教我闭包', timestamp: 1_700_000_000_001 },
  {
    role: 'assistant',
    content: '先探一下——外层 return 之后还能读到那个变量吗？',
    timestamp: 1_700_000_000_002,
    usage: { input: 10, output: 20 },
    questions: [
      {
        questionId: 'closures:q_outer_var',
        header: '探针',
        question: '外层 return 后还能读到那个变量吗？',
        conceptId: 'closures',
        options: [
          { label: '能读到', description: '握着那个变量' },
          { label: '读不到' },
        ],
        multiSelect: false,
        allowText: true,
        askedAt: 1_700_000_000_002,
        answer: {
          selected: ['能读到'],
          text: '函数记住了它出生时的环境',
          skipped: false,
          answeredAt: 1_700_000_000_003,
        },
      },
    ],
  },
  {
    role: 'assistant',
    content: '这一回合被打断了，题还开着。',
    timestamp: 1_700_000_000_004,
    questions: [{ questionId: 'q-orphan', question: '跳过这题会怎样？', options: [], answer: null }],
  },
  { role: 'assistant', content: '', timestamp: 1_700_000_000_005 },
];
const rebuilt = historyToModelMessages(histFixture, { provider: 'custom-endpoint', id: 'agnes-3.0-flash' });
const kinds = rebuilt.map((m) => `${m.role}:${Array.isArray(m.content) ? (m.content[0]?.type ?? 'empty') : 'text'}`);
check(
  '顺序是 user → assistant → toolResult → assistant → toolResult',
  JSON.stringify(kinds) ===
    '["user:text","assistant:text","toolResult:text","assistant:text","toolResult:text"]',
  JSON.stringify(kinds),
);
check('空壳 assistant（没正文没题）不进上下文', !rebuilt.some((m) => m.timestamp === 1_700_000_000_005));
const asked = rebuilt[1];
check('出过题的那条 assistant 记成 toolUse，不是 stop', asked.stopReason === 'toolUse', asked.stopReason);
const askedCall = asked.content.find((b) => b.type === 'toolCall');
check('题卡还原成了 ask_user_question 调用', Boolean(askedCall) && askedCall.name === TOOL_NAMES.ASK);
check('调用带回题面、选项与 concept_id', askedCall?.arguments?.question === '外层 return 后还能读到那个变量吗？' &&
  JSON.stringify(askedCall?.arguments?.options) === '["能读到","读不到"]' && askedCall?.arguments?.concept_id === 'closures',
  JSON.stringify(askedCall?.arguments));
const answerMsg = rebuilt[2];
check('toolResult 挂在正确的调用上', answerMsg.role === 'toolResult' && answerMsg.toolCallId === askedCall?.id && answerMsg.toolName === TOOL_NAMES.ASK);
const answerTextOut = answerMsg?.content?.[0]?.text || '';
check(
  '学习者的作答回到了上下文里',
  answerTextOut.includes('能读到') && answerTextOut.includes('函数记住了它出生时的环境'),
  answerTextOut,
);
// 上游对"有 tool_calls 却没有对应 tool 响应"是直接 400 的，所以每条都要配对。
const allCalls = rebuilt.flatMap((m) => (Array.isArray(m.content) ? m.content : []).filter((b) => b?.type === 'toolCall'))
  .map((c) => c.id);
const allResults = rebuilt.filter((m) => m.role === 'toolResult').map((m) => m.toolCallId);
check('每个 toolCall 都有配对的 toolResult', allCalls.length === 2 && allCalls.every((id) => allResults.includes(id)),
  `${allCalls.length} 调用 / ${allResults.length} 结果`);
check('没答的题按"未作答"补全，不留断头调用',
  rebuilt[4]?.content?.[0]?.text === '（学习者未作答）', rebuilt[4]?.content?.[0]?.text);
check('没用过工具的回合照旧是纯文本 stop', (() => {
  const plain = historyToModelMessages([{ role: 'assistant', content: '纯讲解', timestamp: 1 }], { provider: 'p', id: 'm' });
  return plain.length === 1 && plain[0].stopReason === 'stop' && plain[0].content[0].type === 'text';
})());

// ─────────────────────────────────────── 7k. 整张图重存：漏写的字段沿用上一版

section('7k. 重存 Graph：漏字段不该白烧一个来回（红卡 + 第二次才对）');

const prevGraph = {
  concepts: [
    {
      id: 'chest-compressions',
      name: '胸外按压核心参数',
      summary: '位置、深度、频率、回弹四件事',
      examples: ['两乳头连线中点'],
      depends_on: ['call-for-help'],
    },
  ],
};
check(
  '同一 id 没写的字段沿用上一版',
  (() => {
    const c = carryOverConcept(prevGraph, { id: 'chest-compressions', depends_on: ['call-for-help'] });
    return c.name === '胸外按压核心参数' && c.summary === '位置、深度、频率、回弹四件事';
  })(),
);
check(
  '显式写成空数组算"就是要清空"，不会被上一版盖回来',
  JSON.stringify(carryOverConcept(prevGraph, { id: 'chest-compressions', examples: [] }).examples) === '[]',
);
check(
  'null / 空串当没写，照旧沿用',
  carryOverConcept(prevGraph, { id: 'chest-compressions', name: null, summary: '   ' }).name === '胸外按压核心参数',
);
check(
  '没写过的字段不会凭空造出来：宁可让校验器点名，也不留 null',
  (() => {
    const c = carryOverConcept(null, { id: 'brand-new', explanation: '第一句就是定义。\n第二句是补充' });
    return c.summary === '第一句就是定义' && !('name' in c) && !('misconceptions' in c);
  })(),
  JSON.stringify(carryOverConcept(null, { id: 'brand-new', explanation: '第一句就是定义。\n第二句是补充' })),
);
check('陌生 id 不会串到别的概念上', carryOverConcept(prevGraph, { id: 'other' }).summary === undefined);

// 参数校验层：漏写 summary/name 必须过得了（真正的严格性留在 validateGraph，它一次报全）
const graphTool = buildTools().find((t) => t.name === TOOL_NAMES.SAVE_GRAPH);
const saveArgs = (concepts) => ({
  topic: '基础心肺复苏',
  pedagogy: 'general',
  concepts,
});
let graphValidation = null;
try {
  validateToolCall([graphTool], { name: TOOL_NAMES.SAVE_GRAPH, arguments: saveArgs([{ id: 'a', depends_on: [] }]) });
  graphValidation = { ok: true };
} catch (e) {
  graphValidation = { ok: false, error: String(e.message || e) };
}
check('只写 id 的概念也过得了参数校验', graphValidation.ok, graphValidation.error || '');
check(
  '但 Graph 校验照旧拦得住，并且一次把缺的都点名',
  (() => {
    try {
      validateGraph({
        meta: { topic: 't', pedagogy: 'general' },
        concepts: [{ id: 'a', depends_on: [] }],
      });
      return false;
    } catch (err) {
      return err.issues.some((s) => s.includes('concepts[0].name')) && err.issues.some((s) => s.includes('concepts[0].summary'));
    }
  })(),
);

// 端到端：拿活数据里那种"只补依赖、漏了 summary"的重存，一次就该存成
{
  const snapshot = JSON.parse(JSON.stringify(session.graph));
  const partial = session.execTool(TOOL_NAMES.SAVE_GRAPH, saveArgs([
    { id: 'closures', depends_on: ['variable-scope'] },
    { id: 'variable-scope', depends_on: [] },
  ]));
  const saved = await partial;
  check('漏写 summary/name 的重存一次就过（不再要两回）', saved.ok === true, JSON.stringify(saved).slice(0, 200));
  check(
    '沿用下来的正是它上一版自己写的内容',
    session.graph.concepts.find((c) => c.id === 'closures')?.name === snapshot.concepts.find((c) => c.id === 'closures')?.name,
    session.graph.concepts.find((c) => c.id === 'closures')?.name,
  );
  session.graph = snapshot;
}


// ─────────────────────────────────────── 7l. 门禁确认必须走题卡，不是正文里的一句话

section('7l. GATE-1：确认要触发 ask_user_question，不能让学习者自己打字');

// 活数据（data/notebooks/topic-i3b-dd36be）里三连击：模型连着三轮把同一份概念清单
// +「⛔ 等待你的确认」当正文发出去，学习者每次都得手打「可以」。根因不是模型偷懒——
// 是存图成功那一刻它读到的最后一条指令（工具结果）就叫它"以正文收束"。
{
  const snapshot = JSON.parse(JSON.stringify(session.graph));
  const res = await session.execTool(TOOL_NAMES.SAVE_GRAPH, saveArgs([
    { id: 'variable-scope', name: '变量作用域', summary: '名字在哪儿可见', depends_on: [] },
    { id: 'closures', name: '闭包', summary: '函数带着环境走', depends_on: ['variable-scope'] },
  ]));
  check('存图确实成功（下面几条才有意义）', res.ok === true, JSON.stringify(res).slice(0, 160));
  check(
    '成功的 note 点名要调 ask_user_question 收确认',
    String(res.note).includes('ask_user_question'),
    res.note,
  );
  check(
    'note 里把"正文等待确认"明确否掉，并说清代价（不阻塞 / 下一轮无痕迹）',
    String(res.note).includes('等待你的确认') && /不阻塞/.test(String(res.note)),
    res.note,
  );
  check(
    '门禁确认算事务性提问：不许把 Seen 记到某个概念头上',
    /concept_id 填 none/.test(String(res.note)),
    res.note,
  );
  session.graph = snapshot;
}

// 规则与适配器措辞：同一个降级指令不能在三处里只改一处
const gateRow = rulesBlob.split('\n').find((l) => l.includes('GATE-1 Graph 确认')) || '';
check('GATE-1 那行要求用 ask_user_question 收口', gateRow.includes('ask_user_question'), gateRow);
check(
  'GATE-1 不再把「末尾追加 ⛔」当首选动作',
  !gateRow.includes('末尾追加') && gateRow.includes('无组件才降级'),
  gateRow,
);
check(
  '适配器措辞：任何"停下来等回答"都指向题卡，正文提问只是降级',
  /要停下来等学习者回答[\s\S]{0,400}ask_user_question/.test(probePrompt),
);
check(
  '适配器不再单独教 GATE-1 的正文标记格式',
  !probePrompt.includes('GATE-1 的确认标记单独成行'),
);


// ─────────────────────────────────────── 7m. PATCH：提议要么合得上，要么根本不打扰学习者

// 活数据（topic-i3b-dd36be）里那条真实记录：模型记下学习者反复踩的误解，动作选了
// MODIFY，value 还是 Python 式的单引号列表字面量。旧实现在这里抛
// 「字段 misconceptions 不可修改（immutable）」——一个假罪名（该字段本就 mutable-append），
// 而卡片已经落在右栏，学习者点两次「接受」只拿到两条一模一样的红字。
const LIVE_MISCONCEPTION =
  "['把「先固定颈椎/先查四肢骨折/先摸脉搏」当成心肺骤停的第一动作——诊断(无反应+无正常呼吸)已下，下一步就该直接 CPR，评估之前不再插其他工序']";
const patchGraph = () =>
  structuredClone({
    meta: { topic: '基础心肺复苏', pedagogy: 'general' },
    concepts: [
      {
        id: 'special-cases',
        name: '特殊情况',
        summary: '创伤、孕妇、溺水等例外',
        depends_on: ['cpr-sequence'],
        misconceptions: ['旧的一条'],
      },
      { id: 'cpr-sequence', name: '按压通气顺序', summary: '先按压', depends_on: [] },
    ],
  });

{
  const g = patchGraph();
  let thrown = null;
  try {
    store.applyPatchToGraph(g, {
      operation: 'MODIFY',
      target: 'concepts.special-cases.misconceptions',
      value: LIVE_MISCONCEPTION,
    });
  } catch (err) {
    thrown = err.message;
  }
  const list = g.concepts.find((c) => c.id === 'special-cases').misconceptions;
  check('活数据里那条 MODIFY 现在合得上（不再要模型换动词）', thrown === null, thrown || list.join(' | '));
  const added = list[1] || '';
  check(
    '单引号列表字面量被拆成干净的一条，不带方括号和引号',
    added.startsWith('把「先固定颈椎') && !/[\[\]']/.test(added),
    added,
  );
  check('原有的那条误解还在（追加不是替换）', list[0] === '旧的一条', list[0]);
}
{
  const g = patchGraph();
  store.applyPatchToGraph(g, {
    operation: 'ADD',
    target: 'concepts.special-cases.examples',
    value: '["孕妇左倾体位", "溺水先给氧"]',
  });
  check('JSON 数组字符串能一次追加两条', (g.concepts.find((c) => c.id === 'special-cases').examples || []).length === 2,
    JSON.stringify(g.concepts.find((c) => c.id === 'special-cases').examples));
  const dup = store.patchError(g, { operation: 'ADD', target: 'concepts.special-cases.examples', value: '["孕妇左倾体位"]' });
  check('重复追加不报错也不产生第二条一样的', dup === null && g.concepts.find((c) => c.id === 'special-cases').examples.length === 2);
}
{
  const g = patchGraph();
  const err = store.patchError(g, { operation: 'MODIFY', target: 'concepts.special-cases.depends_on', value: '[]' });
  check('真·结构字段仍然拒绝', Boolean(err), err);
  check('罪名说的是实话，并给出出路（重走分解）', /结构定义/.test(err) && err.includes('update_learning_graph'), err);
  check('不再谎称追加字段 immutable（那句假话会把模型引到死路上）', !/不可修改（immutable）/.test(err), err);
  const err2 = store.patchError(g, { operation: 'ADD', target: 'concepts.special-cases.name', value: 'x' });
  check('ADD 到非追加字段也说清允许哪些', /mutable-append/.test(err2 || ''), err2);
}

// 关键的那道闸：合不上的提议不该落到学习者面前。
{
  const beforePatches = (store.getNotebook(session.notebook.id).patches?.patches || []).length;
  const bad = await session.execTool(TOOL_NAMES.PROPOSE_PATCH, {
    patch: { operation: 'MODIFY', target: 'concepts.nope-does-not-exist.misconceptions', value: '一条', confidence: 'medium' },
  });
  check('目标 concept 不存在时，提议当场退回给模型', bad.ok === false, JSON.stringify(bad).slice(0, 160));
  check('退回来的就是那句实话（模型据此换字段/换动词，不用猜）', /concept 不存在/.test(String(bad.error)), bad.error);
  check('不合用的提议不落改动记录，右栏因而不会长出一张点不动的卡',
    (store.getNotebook(session.notebook.id).patches?.patches || []).length === beforePatches);

  const okRes = await session.execTool(TOOL_NAMES.PROPOSE_PATCH, {
    patch: { operation: 'MODIFY', target: 'concepts.closures.misconceptions', value: LIVE_MISCONCEPTION, reason: '反复踩', confidence: 'medium' },
  });
  check('活数据那种提议现在能通过空跑，落成待确认卡', okRes.ok === true && okRes.applied === false, JSON.stringify(okRes).slice(0, 160));
  const rec = store.getNotebook(session.notebook.id).patches.patches.slice(-1)[0];
  const applyErr = store.patchError(structuredClone(session.graph), { ...rec });
  check('学习者点「接受」走的就是这条：存下来的记录合得上', applyErr === null, applyErr);
  const split = await session.execTool(TOOL_NAMES.PROPOSE_PATCH, {
    patch: { operation: 'SPLIT', target: 'concepts.closures.misconceptions', value: 'x', reason: '太大', confidence: 'high' },
  });
  check('SPLIT 不被空跑误伤（它本来就要走重新分解，不该被拒之门外）', split.ok === true && split.applied === false,
    JSON.stringify(split).slice(0, 160));
}

{
  const desc = buildTools().find((t) => t.name === TOOL_NAMES.PROPOSE_PATCH).description;
  check('工具说明不再承诺"学习者确认后才写入"（high 是当场合并的）', desc.includes('high 当场合并'), desc);
  check('工具说明把空跑闸门的后果讲在前面', desc.includes('不留待确认卡'), desc);
  check('规则与代码同一套说法（MODIFY 落到追加字段按 ADD 合并）', rulesBlob.includes('按 `ADD` 合并'), '');
}


// ─────────────────────────────────────── 7n. 整份清单被写成 JSON 字符串：不算教学错误，不该烧来回

section('7n. 清单被塞成字符串也走得通');

// 活数据里「整理概念结构」那一次：十来个概念挤进一串四千字里的字符串，
// 校验层回的是 concepts.0: must be object，模型读完以为自己缺字段。
{
  const beforeGraph = JSON.parse(JSON.stringify(session.graph));
  const beforeProgress = JSON.parse(JSON.stringify(session.progress));
  const stringified = {
    topic: 'Git 排错与补救',
    pedagogy: 'programming',
    concepts: JSON.stringify([
      { id: 'git-object-model', name: 'Git 的底层对象模型', summary: 'Git 存的是快照', depends_on: [] },
      { id: 'git-reflog', name: 'reflog：找回被"删掉"的东西', summary: 'HEAD 的移动日记', depends_on: ['git-object-model'] },
    ]),
  };
  const tools = buildTools();
  let before = null;
  try {
    validateToolCall(tools, { id: 'c1', name: TOOL_NAMES.SAVE_GRAPH, arguments: stringified });
  } catch (err) {
    before = String(err.message || err);
  }
  check('不拆的话，校验层确实只看得见"must be object"（所以旧代码必红一次）', /must be object/.test(before || ''), before);
  const unwrapped = unwrapStructuredArgs(TOOL_NAMES.SAVE_GRAPH, stringified);
  check('拆开的是数组，不是把整份清单改了', Array.isArray(unwrapped.concepts) && unwrapped.concepts.length === 2,
    typeof unwrapped.concepts);
  check('其余字段原样还在（topic 没被顺手解析掉）', unwrapped.topic === 'Git 排错与补救');
  let after = null;
  try {
    after = validateToolCall(tools, { id: 'c2', name: TOOL_NAMES.SAVE_GRAPH, arguments: unwrapped });
  } catch (err) {
    after = `THREW: ${err.message}`;
  }
  check('拆完过得了参数校验（这一次不用先红）', after && Array.isArray(after.concepts), JSON.stringify(after).slice(0, 120));
  const saved = await session.execTool(TOOL_NAMES.SAVE_GRAPH, after);
  check('拆完真的存得进去，不是过了校验就烂在下游', saved.ok === true, JSON.stringify(saved).slice(0, 160));
  check('概念按拆出来的内容进图', session.graph.concepts.some((c) => c.id === 'git-reflog'),
    session.graph.concepts.map((c) => c.id).join(','));
  session.graph = beforeGraph;
  session.progress = beforeProgress;
}
{
  // 不是合法 JSON 的（Python 式单引号）不许半解析：宁可是原样报错，也不偷偷造内容
  const py = { concepts: "[{'id': 'a', 'name': '甲', 'summary': '乙'}]" };
  const out = unwrapStructuredArgs(TOOL_NAMES.SAVE_GRAPH, py);
  check('单引号那种不猜、原样交给校验层说实话', out.concepts === py.concepts, typeof out.concepts);
}
{
  // 正文类字段合法地可能以 [ 或 { 开头，动它们就是把内容改了
  const plan = { plan: '[先接地] 再出探针' };
  check('present_plan 的正文不碰', unwrapStructuredArgs(TOOL_NAMES.PRESENT_PLAN, plan) === plan);
  const html = { html: '[不是 JSON 的一段正文]', title: 't' };
  check('share_artifact 的 html 不碰', unwrapStructuredArgs(TOOL_NAMES.SHARE_ARTIFACT, html) === html);
  const patchArgs = { patch: { operation: 'ADD', target: 'concepts.closures.misconceptions', value: "['一条']", reason: '反复踩' } };
  check('PATCH 的 value 不预解析（留给 store.toList 按字段语义拆）',
    unwrapStructuredArgs(TOOL_NAMES.PROPOSE_PATCH, patchArgs).patch.value === "['一条']");
  const askOpts = { id: 'q', concept_id: 'closures', question: '读得到吗？', options: '[{"label":"能"},{"label":"不能"}]' };
  const asked = unwrapStructuredArgs(TOOL_NAMES.ASK, askOpts);
  check('提问的选项被塞成字符串也拆得开', Array.isArray(asked.options) && asked.options.length === 2, typeof asked.options);
  check('拆开之后 normalizeAskOptions 拿得到标签', normalizeAskOptions(asked.options).map((o) => o.label).join('/') === '能/不能');
  const agentSrc = fs.readFileSync(new URL('../server/agent.mjs', import.meta.url), 'utf8');
  check('校验失败时补的那行把两种因都说清（缺字段 / 整份写成了字符串）',
    agentSrc.includes('若是把清单写成了字符串，改成数组本身再发'), '');
}


// ─────────────────────────────────────── 8. 不变量：可见面上没有数值化学习量

section('8. 不变量（Invariant 4）');
section('8. 不变量（Invariant 4）');
const lv = store.summariseLearnerView(session.progress);
const blob = JSON.stringify(lv);
const forbidden = ['percent', 'score', 'pct', 'star', 'grade', 'level'];
check(
  '学习者视图不含数值化字段',
  !forbidden.some((f) => blob.toLowerCase().includes(f)),
  blob.slice(0, 200),
);
check(
  '学习者视图只给文字词',
  Object.keys(lv.counts).every((k) => ['待学', '正在学习', '已学懂', '正在练习', '已掌握'].includes(k)),
  JSON.stringify(lv.counts),
);

// 五个状态五个词。以前 Seen 和 Understood 共用「正在学习」，一局里四五个概念挂同一个词，
// 学习者看不出上一步到底过没过（活会话截图报的）。这里钉的是"不许再合并"。
const STATE_LADDER = ['unknown', 'seen', 'understood', 'applied', 'mastered'];
const WORDS = STATE_LADDER.map((s) => store.stateWord(s));
check('五个状态五个词，谁也不跟谁重合', new Set(WORDS).size === 5, WORDS.join(' / '));
check(
  'Understood 有独立对外词（讲通了 ≠ 还在学，也 ≠ 练过了）',
  store.stateWord('understood') === '已学懂',
  store.stateWord('understood'),
);
// 词表一共抄在四处（后端 / 前端 / 规则表 / 给模型的适配器），漏一处就是又一轮"措辞三层"漂移
const appSrc = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
check('前端词表与后端同一批', WORDS.every((w) => appSrc.includes(w)), WORDS.join(' / '));
check(
  'runtime.md §1.5 的译写表跟代码同一批',
  rulesBlob.includes('| Seen | 正在学习 |') && rulesBlob.includes('| Understood | 已学懂 |'),
);
check('适配器报给模型的对外词是同一批', WORDS.every((w) => probePrompt.includes(w)));

// ─────────────────────────────────────── 9. 落盘往返

section('9. 落盘与恢复');
store.saveGraph(meta.id, result.graph);
store.saveProgress(meta.id, result.progress);
store.appendChat(meta.id, result.messages);
const reloaded = store.getNotebook(meta.id);
check('Graph 落盘后可读回', reloaded.graph.concepts.length === 2);
check('Progress 落盘后可读回', reloaded.progress.concepts['closures'].state === 'seen');
check('对话落盘后可读回', reloaded.chat.messages.length === result.messages.length);
check('列表页能看到这个学习', store.listNotebooks().some((n) => n.id === meta.id));

// 「上次聊到」的数据出口：lastAt 必须是**最后一条消息**的时间，不是 meta.updatedAt。
// 区别在改名：改名走 touchNotebook，会刷 updatedAt，但一个字也没聊——
// 用 updatedAt 冒充的话，"上次聊到：今天"就在改名那一刻说谎。
{
  const listed = store.listNotebooks().find((n) => n.id === meta.id);
  const lastMsgTs = Math.max(...store.getNotebook(meta.id).chat.messages.map((m) => Number(m.timestamp) || 0));
  check('lastAt = 最后一条消息的时间戳', listed.lastAt === lastMsgTs, `lastAt=${listed.lastAt} lastMsg=${lastMsgTs}`);
  const before = listed.lastAt;
  const updatedBefore = listed.updatedAt;
  store.touchNotebook(meta.id, { title: '只是改了个名' });
  const after = store.listNotebooks().find((n) => n.id === meta.id);
  check('改名会刷 updatedAt（前提成立）', after.updatedAt !== updatedBefore, `${updatedBefore} → ${after.updatedAt}`);
  check('改名不刷 lastAt（没聊就是没聊，上次聊到不许跟着改名走）',
    after.lastAt === before, `before=${before} after=${after.lastAt}`);
  // 空本：一条消息都没有 → null，前端据此显示「还没聊过」，不许是 0 或当前时间。
  const bareId = store.createNotebook({ title: '空本', topic: '', goal: null, pace: 'normal' }).id;
  const bare = store.listNotebooks().find((n) => n.id === bareId);
  check('没聊过的本 lastAt 为 null（不是 0、不是现在）', bare.lastAt === null, String(bare.lastAt));
}

section('10. 列表摘要不泄漏数值');
// 按 id 取，不拿 [0]：列表按 updatedAt 排序，上面「上次聊到」那节又新建了本子，
// 谁排第一取决于建本时序——断言不该依赖这个。
const summary = store.listNotebooks().find((n) => n.id === meta.id);
check('摘要含文字视图', Boolean(summary.learnerView?.counts));

section('11. 开局引导：现编的候选、缓存与兜底');
const { parseStarters, readStarterCache, writeStarterCache, studiedFingerprint, generateStarters } =
  await import('../server/starters.mjs');

const fourJson = JSON.stringify([
  { title: '为什么闰年这么麻烦', sub: '从一张日历开始' },
  { title: '怎样让一段代码自己变快', sub: '先量再改' },
  { title: '一首歌为什么抓耳', sub: '拆开听结构' },
  { title: '合同里哪几句最贵', sub: '非法律岗' },
]);
const parsedStarters = parseStarters(`好的，这是候选：\n\`\`\`json\n${fourJson}\n\`\`\``);
check(
  '裹了代码块和寒暄也照样解析',
  parsedStarters.length === 4 && parsedStarters[0].title === '为什么闰年这么麻烦',
  JSON.stringify(parsedStarters),
);
check(
  '条数封顶 4（超出会把"开局"撑成列表）',
  parseStarters(JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ title: `主题${i}`, sub: 'x' }))))
    .length === 4,
);
check('同标题去重', parseStarters(JSON.stringify([{ title: 'A', sub: 'x' }, { title: 'A', sub: 'y' }])).length === 1);
check('title 超长被裁到 24', parseStarters(JSON.stringify([{ title: '很'.repeat(40), sub: 'x' }]))[0].title.length === 24);
check('模型胡答就交白卷', parseStarters('抱歉，我想不到好主题').length === 0);
check('坏 JSON 也交白卷', parseStarters('[{title: 缺引号}]').length === 0);

const fp = studiedFingerprint(['闭包', '财务报表']);
check('已学清单顺序不同算同一指纹', fp === studiedFingerprint(['财务报表', '闭包']));
writeStarterCache(fp, parsedStarters);
check('同指纹命中缓存', readStarterCache(fp)?.length === 4);
check('学了新主题（指纹变了）就重编', readStarterCache(studiedFingerprint(['闭包'])) === null);

const okRegistry = (text) => ({
  resolveModel: () => ({}),
  models: { complete: async () => ({ content: [{ type: 'text', text }] }) },
});
check(
  '配了模型就现编得出候选',
  (await generateStarters({ registry: okRegistry(fourJson), modelRef: { provider: 'p', model: 'm' } })).length === 4,
);
check('没配模型就交白卷（前端留静态四条）', (await generateStarters({ registry: okRegistry(fourJson), modelRef: null })).length === 0);
const brokenRegistry = {
  resolveModel: () => {
    throw new Error('没这个模型');
  },
  models: { complete: async () => { throw new Error('端点炸了'); } },
};
check(
  '端点炸了也交白卷，引导不该有故障路径',
  (await generateStarters({ registry: brokenRegistry, modelRef: { provider: 'p', model: 'm' } })).length === 0,
);
let askedPrompt = '';
await generateStarters({
  registry: {
    resolveModel: () => ({}),
    models: {
      complete: async (_m, req) => {
        askedPrompt = req.messages[0].content;
        return { content: [{ type: 'text', text: fourJson }] };
      },
    },
  },
  modelRef: { provider: 'p', model: 'm' },
  studied: ['闭包', 'React Hooks'],
});
check('提示词里点名已学主题（这才叫不重复出现）', askedPrompt.includes('闭包') && askedPrompt.includes('React Hooks'));

// ─────────────────────────────────────── 12. 整本导出 / 导入（备份与迁移）+ 数据抗摔

section('12. 整本导出 / 导入：学习记录是可带走的资产');

// 专用一本，不碰前面各节用过的 meta.id / nbDesk
const srcId = store.createNotebook({ topic: '导出往返', goal: '验证备份格式', pace: 'normal' }).id;

// 造内容：Graph、进度、对话、笔记、待办、场、道具、素材、制品（含退役一件）
const srcGraph = {
  meta: { topic: '导出往返', goal: '验证备份格式', pedagogy: 'general' },
  concepts: [
    {
      id: 'first',
      name: '第一个概念',
      summary: '一句话定义',
      depends_on: [],
      misconceptions: ['容易踩的坑'],
    },
    {
      id: 'second',
      name: '第二个概念',
      summary: '依赖第一个',
      depends_on: ['first'],
    },
  ],
};
store.saveGraph(srcId, srcGraph);
store.saveProgress(srcId, {
  version: 1,
  session_open: true,
  concepts: { first: { concept_id: 'first', state: 'understood', next_action: null }, second: { concept_id: 'second', state: 'seen', next_action: null } },
  notes: [{ at: new Date().toISOString(), text: '第一次接触闭包' }],
  updated_at: new Date().toISOString(),
});
store.appendChat(srcId, [
  { role: 'user', content: '我想学导出', timestamp: Date.now() },
  { role: 'assistant', content: '好的，先拆结构。', timestamp: Date.now() },
]);
store.saveTodos(srcId, [{ id: 't1', content: '拆结构', status: 'completed' }]);
store.saveSceneState(srcId, {
  version: 1,
  index: 1,
  current: {
    id: 'scene-01',
    index: 1,
    title: '第一场：结构',
    phase: 'open',
    conceptId: 'first',
    props: [{ id: 'src-art-1', title: '对照卡', rel: 'artifacts/src-art-1/index.html' }],
    inheritedFrom: null,
    openedAt: new Date().toISOString(),
  },
  log: [],
});
store.appendPatch(srcId, { operation: 'ADD', target: 'concepts.first.misconceptions', value: '新误解', confidence: 'high' });
const uploadRec = store.saveUpload(srcId, '素材说明.md', Buffer.from('# 素材说明\n\n要点一二三。', 'utf8'));
const imgRec = store.saveUpload(srcId, '示意.png', Buffer.from('fake-png-bytes', 'utf8'));
const artRec = store.saveArtifact(srcId, { title: '对照卡', html: '<h1>现象</h1>', kind: 'interactive' });
store.setArtifactLifetime(srcId, artRec.id, true);
saveNote(srcId, { title: '备份笔记', summary: '要点', key_points: ['一条'], example: '例子' });

const bundle = store.exportNotebook(srcId);
check('导出包带格式标记与版本', bundle.format === 'socratic-studio-notebook' && bundle.version === 1);
check('导出包带着八份 JSON（files 键齐全）', ['notebook.json', 'learning-graph.json', 'progress.json', 'patches.json', 'chat.json', 'todos.json', 'scene.json', 'notes.json'].every((k) => k in bundle.files));
check('Graph 原样在包里', bundle.files['learning-graph.json'].concepts.length === 2);
check('素材带 rel / 字节数 / 内容', bundle.uploads.some((u) => u.rel === uploadRec.rel && u.bytes > 0 && u.data.includes('要点')));
check('二进制素材走 base64', bundle.uploads.find((u) => u.kind === 'image').encoding === 'base64');
check('制品带 HTML 与寿命标记', bundle.artifacts.some((a) => a.id === artRec.id && a.html.includes('现象') && a.retiredAt));
check('导出不改源（只读盘）', store.getNotebook(srcId).graph.concepts.length === 2);

const imported = store.importNotebook(bundle);
// 中文主题的 id 走短哈希（topic-xxx），不含原词——这里验的是"新 id、不撞源"两件事
check('导入生成新的学习（id 不冲突）', imported.id !== srcId && /^topic-[0-9a-z]{3}-[0-9a-z]{6}$/.test(imported.id), imported.id);
check('导入后 Graph 内容等价', imported.graph.concepts.length === 2 && imported.graph.concepts[1].depends_on[0] === 'first');
check('导入后进度等价', imported.progress.concepts.first.state === 'understood');
check('导入后对话等价', imported.chat.messages.length === 2);
check('导入后笔记等价', imported.notes.length === 1 && imported.notes[0].title === '备份笔记');
check('导入后备注也在（progress.notes）', imported.progress.notes.length === 1);
check('导入后待办等价', imported.todos.length === 1 && imported.todos[0].id === 't1');
check('导入后场与台上道具原样（道具 id 是交叉引用的承重墙）', imported.scene.current.props[0].id === 'src-art-1');
check('导入后 PATCH 记录等价', imported.patches.patches.length === 1 && imported.patches.patches[0].confidence === 'high');
check('导入后制品 id 原样保留', imported.artifacts.some((a) => a.id === artRec.id));
check('导入后制品寿命标记原样保留', imported.artifacts.find((a) => a.id === artRec.id).retiredAt);
check('导入后素材按原 rel 可读（文本）', store.readUpload(imported.id, uploadRec.rel).text.includes('要点'));
check('导入后素材按原 rel 可读（图片）', store.readUpload(imported.id, imgRec.rel).kind === 'image');
check('导入后列表能看到新学习', store.listNotebooks().some((n) => n.id === imported.id));

/*
 * ────────────────────────────── 12a. 备份要经得起坏的时候（第二十三轮）
 *
 * 探针 23-B / 23-C / 23-D 实测的四件事，逐条钉住。修复前的形状：
 *   - 二进制素材（.pdf / .mp3）导出走 utf8 分支 → 内容变成一串 U+FFFD，声明的字节数与实际解出的
 *     对不上，导入侧那道正确的守卫把**整本备份**判成非法包（一个附件 = 整本导不回去）；
 *   - 0 字节的素材在导入时被 `if (buffer.length)` 静默跳过 → 备份里有记录、新机盘上查无此件；
 *   - learning-graph.json 坏了 → 导出**安静地**少了这一份、照样 200，拿去导入 201、
 *     新本概念数 0（源机本来有 1 个概念）——最坏的形状：整本结构没了还报成功；
 *   - manifest 有记录但 index.html 丢了（空壳）→ 导出给 html:''，导入端写出空 index.html，
 *     源机体检点名过的损坏到新机变成 ok=true（备份洗白）。
 */
section('12a. 备份的保真：坏的时候不许出货，好的时候不许走样');

const fidNb = store.createNotebook({ topic: '保真测试', goal: null, pace: 'normal' }).id;
const fidDir = path.join(process.env.SOCRATIC_DATA_DIR, 'notebooks', fidNb);
// 一段真实的二进制头（含非法 UTF-8 字节）：以前它进包会被读成 U+FFFD
const PDF_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x42, 0x49, 0x4e, 0x41, 0x52, 0x59]);
const pdfRec = store.saveUpload(fidNb, 'paper.pdf', PDF_BYTES);
check('写侧认得出二进制（不再只有图片/文本两档）', pdfRec.kind === 'binary', `kind=${pdfRec.kind}`);
check('读侧与写侧同一口径（binary 三档都有）', store.readUpload(fidNb, pdfRec.rel).kind === 'binary');
const emptyRec = store.saveUpload(fidNb, '空文件.md', Buffer.alloc(0));
const fidBundle = store.exportNotebook(fidNb);
const pdfInBundle = fidBundle.uploads.find((u) => u.rel === pdfRec.rel);
check('二进制素材进包走 base64（编码跟着 kind 走，不是"image 才 base64"）',
  pdfInBundle.encoding === 'base64' && pdfInBundle.bytes === PDF_BYTES.length,
  `encoding=${pdfInBundle.encoding} bytes=${pdfInBundle.bytes}`);
check('包里那串解回来与源字节逐字节相同（不重写）',
  Buffer.from(pdfInBundle.data, 'base64').equals(PDF_BYTES), Buffer.from(pdfInBundle.data, 'base64').toString('hex'));
check('0 字节素材也在备份的清单里', fidBundle.uploads.some((u) => u.rel === emptyRec.rel && u.bytes === 0));
/*
 * 修复前这一步在源机器上就抛 400「素材「paper.pdf」数据与声明的字节数不符」——
 * 用 try 接住，是为了让下面每一条各报各的失败，而不是把整套撞成 CRASH：
 * 红要红得能读出"哪一处坏了"。
 */
let fidImported = null;
let fidImportErr = null;
try {
  fidImported = store.importNotebook(fidBundle);
} catch (e) {
  fidImportErr = e;
}
check('一个 PDF 附件不再让整本备份导不回去（字节数相符就该收下）',
  !fidImportErr, `导入抛了：${fidImportErr?.message}`);
const fidImportedDir = fidImported ? path.join(process.env.SOCRATIC_DATA_DIR, 'notebooks', fidImported.id) : null;
check('导入后二进制素材逐字节还原（盘上那份与源相同）',
  Boolean(fidImportedDir) && fs.readFileSync(path.join(fidImportedDir, pdfRec.rel)).equals(PDF_BYTES));
/*
 * 0 字节这一件单独造一份包验：让它红的时候只因"空文件被跳过"这一件事红，
 * 不跟着上面那条 PDF 的失败一起红（否则这条钉子看不出自己管的那处）。
 */
const zeroOnly = structuredClone(fidBundle);
zeroOnly.uploads = [{ rel: emptyRec.rel, name: emptyRec.name, kind: 'text', bytes: 0, data: '', encoding: 'utf8' }];
const zeroImported = store.importNotebook(zeroOnly);
const zeroDir = path.join(process.env.SOCRATIC_DATA_DIR, 'notebooks', zeroImported.id);
check('导入后 0 字节素材真的落了盘（备份里有记录，新机上就该有文件）',
  fs.existsSync(path.join(zeroDir, emptyRec.rel)) && fs.readFileSync(path.join(zeroDir, emptyRec.rel)).length === 0,
  `新机 uploads/ = ${fs.readdirSync(path.join(zeroDir, 'uploads')).join(',') || '(空)'}`);

// 反向：手写包里的 base64 不规范化 / encoding 缺失 / 声明与数据不符，都得当场拒绝
const sloppy = structuredClone(fidBundle);
sloppy.uploads = [{ rel: 'uploads/x.pdf', name: 'x.pdf', bytes: 1, data: 'A', encoding: 'base64' }];
let sloppyMsg = '';
try {
  store.importNotebook(sloppy);
} catch (e) {
  sloppyMsg = e.message;
}
check('不规范的 base64 被拒绝（解出来编回去不是原来那串）', sloppyMsg.includes('base64'), sloppyMsg);

const noEnc = structuredClone(fidBundle);
noEnc.uploads = [{ rel: 'uploads/x.md', name: 'x.md', bytes: 1, data: 'x' }];
let noEncMsg = '';
try {
  store.importNotebook(noEnc);
} catch (e) {
  noEncMsg = e.message;
}
check('encoding 缺失不再"按 utf8 兜"（判据只有一份）', noEncMsg.includes('encoding'), noEncMsg);

const lyingZero = structuredClone(fidBundle);
lyingZero.uploads = [{ rel: 'uploads/x.md', name: 'x.md', bytes: 0, data: '有内容', encoding: 'utf8' }];
let lyingZeroMsg = '';
try {
  store.importNotebook(lyingZero);
} catch (e) {
  lyingZeroMsg = e.message;
}
check('0 字节的声明不再跳过校验（说 0 字节却带内容 = 不符）',
  lyingZeroMsg.includes('字节数不符'), lyingZeroMsg);

// 坏的时候不许出货：逐份写坏，导出必须拒绝并点名，且不产出任何包
const nbBlock = store.createNotebook({ topic: '坏的时候', goal: null, pace: 'normal' }).id;
const nbBlockDir = path.join(process.env.SOCRATIC_DATA_DIR, 'notebooks', nbBlock);
store.saveGraph(nbBlock, {
  meta: { topic: '坏的时候', pedagogy: 'general' },
  concepts: [{ id: 'c1', name: '唯一的那个概念', summary: '一条', status: 'unknown', mastery: 'unknown', evidence: [], misconceptions: [], depends_on: [] }],
  cross_edges: [],
});
const graphGood = fs.readFileSync(path.join(nbBlockDir, 'learning-graph.json'), 'utf8');
fs.writeFileSync(path.join(nbBlockDir, 'learning-graph.json'), '{ 半截 JSON');
check('体检点名这处损坏（导出拒绝之前，家底的事实先看得见）',
  store.healthCheck().corruptFiles.some((f) => f === `${nbBlock}/learning-graph.json`),
  store.healthCheck().corruptFiles.join(','));
let blockErr = null;
let blockStatus = 0;
try {
  store.exportNotebook(nbBlock);
} catch (e) {
  blockErr = e;
  blockStatus = e.status;
}
check('Graph 坏了 → 导出拒绝出货（不再安静地少一份还报成功）',
  Boolean(blockErr) && String(blockErr.message).includes('learning-graph.json'), String(blockErr?.message));
check('拒绝的理由是"数据有缺口"，并指向体检取证（不是含糊的 500）',
  blockStatus === 409 && String(blockErr?.message).includes('体检'), `status=${blockStatus}`);
check('缺口清单进错误对象（界面要逐行念出来）',
  Array.isArray(blockErr?.blockers) && blockErr.blockers.some((b) => b.includes('learning-graph.json')),
  JSON.stringify(blockErr?.blockers));
fs.writeFileSync(path.join(nbBlockDir, 'learning-graph.json'), graphGood);
check('修好之后导出恢复正常（拒绝针对的是状态，不是这本学习本身）',
  store.exportNotebook(nbBlock).files['learning-graph.json'].concepts.length === 1);

// 空壳制品同样不许洗白
const nbShell = store.createNotebook({ topic: '空壳洗白', goal: null, pace: 'normal' }).id;
const nbShellDir = path.join(process.env.SOCRATIC_DATA_DIR, 'notebooks', nbShell);
const shellArt = store.saveArtifact(nbShell, { title: '会掉文件的那件', html: '<h1>原本有内容</h1>', kind: 'interactive' });
fs.rmSync(path.join(nbShellDir, 'artifacts', shellArt.id, 'index.html'));
let shellErr = null;
try {
  store.exportNotebook(nbShell);
} catch (e) {
  shellErr = e;
}
check('制品 index.html 丢了 → 导出拒绝（不再给 html:"" 让新机把损坏读成正常）',
  Boolean(shellErr) && String(shellErr.message).includes(shellArt.id), String(shellErr?.message));
// 对话也一并：坏与不缺在包里必须说得出区别（旧形状：少了文件照样 200）
const chatGood = fs.readFileSync(path.join(nbShellDir, 'chat.json'), 'utf8');
fs.writeFileSync(path.join(nbShellDir, 'chat.json'), '[ 坏了');
let chatErr = null;
try {
  store.exportNotebook(nbShell);
} catch (e) {
  chatErr = e;
}
check('chat.json 坏了也拒绝（过去它少了文件、靠导入侧 400 才响）',
  Boolean(chatErr) && String(chatErr.message).includes('chat.json'), String(chatErr?.message));
fs.writeFileSync(path.join(nbShellDir, 'chat.json'), chatGood);
fs.writeFileSync(path.join(nbShellDir, 'artifacts', shellArt.id, 'index.html'), '<h1>放回来了</h1>');
check('两件都归位后导出通过（清单随盘上事实变化）', (() => {
  const b = store.exportNotebook(nbShell);
  return b.artifacts[0].html.includes('放回来了') && 'chat.json' in b.files;
})());

// manifest.json 自己坏了：readJsonSafe 兜成空清单 → 整本制品一份都不进包、照样 200（同一形状）
const manifestPath23 = path.join(nbShellDir, 'artifacts', 'manifest.json');
const manifestGood23 = fs.readFileSync(manifestPath23, 'utf8');
fs.writeFileSync(manifestPath23, '{ 半截 manifest');
let manifestErr = null;
try {
  store.exportNotebook(nbShell);
} catch (e) {
  manifestErr = e;
}
check('manifest 坏了也拒绝（制品整批漏掉与少一份 JSON 是同一条形状）',
  Boolean(manifestErr) && String(manifestErr.message).includes('manifest.json'), String(manifestErr?.message));
fs.writeFileSync(manifestPath23, manifestGood23);
check('manifest 归位后制品回到包里', store.exportNotebook(nbShell).artifacts.length === 1);

// 导入校验：白名单 / Graph 严格校验 / 空图放行 / 大小与路径上限
const evil = structuredClone(bundle);
evil.files['evil.json'] = { x: 1 };
let evilMsg = '';
try {
  store.importNotebook(evil);
} catch (e) {
  evilMsg = e.message;
}
check('包里的未知文件键被拒绝（白名单）', evilMsg.includes('evil.json') && evilMsg.includes('白名单'), evilMsg);

const badGraph = structuredClone(bundle);
badGraph.files['learning-graph.json'] = {
  meta: { topic: '坏图', pedagogy: 'general' },
  concepts: [{ id: 'orphan' }], // 缺 name / summary
};
let badGraphMsg = '';
try {
  store.importNotebook(badGraph);
} catch (e) {
  badGraphMsg = e.message;
}
check('非法 Graph 被严格校验拒绝', badGraphMsg.includes('校验失败') && badGraphMsg.includes('name'), badGraphMsg);

const emptyGraph = structuredClone(bundle);
emptyGraph.files['learning-graph.json'] = { meta: { topic: '还没拆', pedagogy: 'general' }, concepts: [] };
check('空图（还没 DECOMPOSE）是合法状态，放行', store.importNotebook(emptyGraph).graph.concepts.length === 0);

const bigArtifact = structuredClone(bundle);
bigArtifact.artifacts = [{ id: 'huge-art', title: '巨大', html: 'x'.repeat(8 * 1024 * 1024 + 1) }];
let bigMsg = '';
try {
  store.importNotebook(bigArtifact);
} catch (e) {
  bigMsg = e.message;
}
check('超大制品 HTML 被拒绝', bigMsg.includes('8MB'), bigMsg);

const evilRel = structuredClone(bundle);
evilRel.uploads = [{ rel: 'uploads/../../etc/passwd', name: 'p', bytes: 0, data: '' }];
let evilRelMsg = '';
try {
  store.importNotebook(evilRel);
} catch (e) {
  evilRelMsg = e.message;
}
check('越界素材路径被拒绝（只认 uploads/<文件名>）', evilRelMsg.includes('路径形状非法'), evilRelMsg);

const notBundle = { hello: 'world' };
let notBundleMsg = '';
try {
  store.importNotebook(notBundle);
} catch (e) {
  notBundleMsg = e.message;
}
check('不认识的包被拒绝', notBundleMsg.includes('不认识的导出格式'), notBundleMsg);

// 数据抗摔：notes.json 损坏时保留副本 + 以默认值继续（跟 store.mjs 同一条纪律）
section('12b. 数据抗摔：notes.json 损坏不静默丢');
const crashId = store.createNotebook({ topic: '抗摔测试', goal: null, pace: 'normal' }).id;
saveNote(crashId, { title: '会救回来', summary: '这条不该丢', key_points: [] });
const notesFile = path.join(process.env.SOCRATIC_DATA_DIR, 'notebooks', crashId, 'notes.json');
fs.writeFileSync(notesFile, '{ 半截 JSON');
const readBack = readNotes(crashId);
check('损坏的 notes.json 读回空默认（不抛）', Array.isArray(readBack) && readBack.length === 0);
const backupList = () => fs.readdirSync(path.dirname(notesFile)).filter((f) => f.startsWith('notes.json.corrupt-'));
check('损坏文件留了副本（不静默覆盖可抢救数据）', backupList().length === 1, backupList().join(','));
// 同一份坏内容被反复读时，副本不许增殖：坏文件每刷新一次、每回合落盘都被读一遍，
// 过去每读一次就写一份 *.corrupt-<毫秒>（实测坏一个 chat.json 读 6 次堆 4 份相同副本）——
// "留证据"变成造垃圾山。同一份坏内容只留一份、只喊一次。
readNotes(crashId); readNotes(crashId); readNotes(crashId);
check('同一份坏内容再读三次不增殖（证据只留一份）', backupList().length === 1, backupList().join(','));
// 反向边界：坏法换了一种，旧证据顶不了新损坏，必须再留一份。
fs.writeFileSync(notesFile, '[ 另一种坏法');
readNotes(crashId);
check('换一种坏法必须再留一份（旧证据不顶新损坏）', backupList().length === 2, backupList().join(','));
// 副本必须是逐字节原件（不是 utf8 往返重写）：损坏取证的意义就在"字节不重写"。
{
  const dir = path.dirname(notesFile);
  const same = backupList().some((n) => fs.readFileSync(path.join(dir, n), 'utf8') === '[ 另一种坏法');
  check('留下的副本内容与原件一致（取证不重写）', same, backupList().join(','));
}
// 撞名钉子（把偶发压成必然）：过去副本名只有 `${file}.corrupt-${Date.now()}`，毫秒不是计数器。
// 同一毫秒里坏出两种**不同**内容时，第二份 copyFileSync 直接把第一份覆盖掉——前一种坏法查无实据。
// 实测这个碰撞约每 5 次跑撞中 1 次（上面那条 ==2 时红时绿），所以这里钉死 Date.now 逼它必然撞。
{
  const collideId = store.createNotebook({ topic: '撞名测试', goal: null, pace: 'normal' }).id;
  const collideNotes = path.join(process.env.SOCRATIC_DATA_DIR, 'notebooks', collideId, 'notes.json');
  fs.writeFileSync(collideNotes, JSON.stringify([{ title: '本来好的', summary: '', key_points: [] }]));
  const realNow = Date.now;
  Date.now = () => 1700000000000; // 冻结：两次损坏落在同一毫秒
  try {
    fs.writeFileSync(collideNotes, '[ 第一种坏法');
    readNotes(collideId);
    fs.writeFileSync(collideNotes, '{ 第二种坏法');
    readNotes(collideId);
  } finally {
    Date.now = realNow;
  }
  const collideDir = path.dirname(collideNotes);
  const collideBackups = fs.readdirSync(collideDir).filter((f) => f.startsWith('notes.json.corrupt-'));
  check('同一毫秒坏出两种坏法：两份证据都留下（撞名不覆盖）',
    collideBackups.length === 2, collideBackups.join(','));
  const bothContents = ['[ 第一种坏法', '{ 第二种坏法'].every((bad) =>
    collideBackups.some((n) => fs.readFileSync(path.join(collideDir, n), 'utf8') === bad));
  check('两种坏法各有一份字节一致的副本（谁都没被顶掉）', bothContents, collideBackups.join(','));
  // 把它修回合法，别拖累后面 12c 的「健康目录体检报告 ok」前提（副本留着无妨，体检不点名副本）
  saveNote(collideId, { title: '撞名测试恢复', summary: '', key_points: [] });
  // ── 第十八轮：治好了，证据不许跟着变孤儿。
  // 上面的场景就是那条死路的标本：notes.json 坏过两种、副本都在盘上，现在原件已经好了——
  // 旧口径里 corruptFiles 清空、取证下载口只认当下清单，这两份副本从此查无实据。
  {
    const evList = () => store.healthCheck().corruptEvidence || [];
    const evRels = () => evList()
      .filter((e) => e.rel.startsWith(`notebooks/${collideId}/notes.json.corrupt-`))
      .map((e) => e.rel)
      .sort();
    const evItems = () => evList()
      .filter((e) => e.rel.startsWith(`notebooks/${collideId}/notes.json.corrupt-`));
    check('修好之后证据台账还在案（两份副本都列得出）', evRels().length === 2, evRels().join(','));
    check('台账说清原件已康复（sourceCorrupt=false 才叫"已修复的存证"）',
      evItems().length === 2 && evItems().every((e) => e.sourceCorrupt === false),
      JSON.stringify(evItems()));
    check('台账的 rel 相对 DATA_DIR（取证口认得这个基准）',
      evRels().every((r) => r.startsWith('notebooks/')), evRels().join(','));
    // 真正要钉的是"拿得到"：以前这条路 400「这个文件不在体检报告的损坏清单里」
    // （用 try 包住：取证口退回旧行为时这条钉子要报 FAIL，不能把整套撞成 CRASH）
    const oneEv = evRels()[0];
    let evGot = null, evErr = null;
    try { evGot = store.readCorruptFile(oneEv); } catch (err) { evErr = err; }
    check('治好了的副本照样能取证（字节原样，不重写）',
      !evErr && ['[ 第一种坏法', '{ 第二种坏法'].includes(evGot.buffer.toString('utf8')),
      evErr ? `抛了 ${evErr.reason || evErr.message}` : `${oneEv} → ${evGot.buffer.toString('utf8')}`);
    // 台账不是任意读取口的口子：原件（此刻是好的）依旧不在任何白名单里
    let evReject = null;
    try { store.readCorruptFile(`notebooks/${collideId}/notes.json`); } catch (err) { evReject = err; }
    try { store.readCorruptFile(`notebooks/${collideId}/notebook.json`); } catch (err) { evReject = evReject || err; }
    check('扩展白名单只认台账里的名字：好的原件仍被拒', evReject?.reason === 'not-in-report', evReject?.message);
  }
}
const afterCrash = saveNote(crashId, { title: '恢复后新增', summary: '写入正常', key_points: [] });
check('损坏后写入正常（原子写）', afterCrash.title === '恢复后新增');
const tmpLeft = fs.readdirSync(path.dirname(notesFile)).filter((f) => f.endsWith('.tmp'));
check('原子写不留半截 .tmp 文件', tmpLeft.length === 0, tmpLeft.join(','));

// ─────────────────────────────────────── 12c. 数据体检：只报告，不修

section('12c. 数据体检：损坏 / 孤儿 / 空壳都要被看见');

const cleanCheck = store.healthCheck();
check('健康目录体检报告 ok', cleanCheck.ok === true, JSON.stringify(cleanCheck));
check('体检报告带学习数（≥1）', cleanCheck.notebooks >= 1, String(cleanCheck.notebooks));

// 造一处损坏：把 crashId 的 notes.json 写坏（12b 里已经坏过一次并留了副本，这里再坏一次新文件）
const crashNotes = path.join(process.env.SOCRATIC_DATA_DIR, 'notebooks', crashId, 'notes.json');
fs.rmSync(crashNotes, { force: true });
fs.writeFileSync(crashNotes, 'not json at all');
const dirtyCheck = store.healthCheck();
check('损坏的 JSON 被体检点名', dirtyCheck.corruptFiles.some((f) => f.includes(crashId) && f.endsWith('notes.json')), dirtyCheck.corruptFiles.join(','));

// 孤儿制品：目录不在 manifest 里 → 点名；manifest 有记录但缺 index.html → 点名
const orphanDir = path.join(process.env.SOCRATIC_DATA_DIR, 'notebooks', crashId, 'artifacts', 'orphan-art');
fs.mkdirSync(orphanDir, { recursive: true });
const manifestPath = path.join(process.env.SOCRATIC_DATA_DIR, 'notebooks', crashId, 'artifacts', 'manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, items: [{ id: 'ghost-art', title: '空壳', kind: 'artifact', rel: 'artifacts/ghost-art/index.html', createdAt: 'x' }] }));
const orphanCheck = store.healthCheck();
check('manifest 外的制品目录被点名（孤儿）', orphanCheck.orphanArtifacts.some((a) => a.notebook === crashId && a.id === 'orphan-art'), JSON.stringify(orphanCheck.orphanArtifacts));
check('有记录但缺 HTML 的制品被点名（空壳）', orphanCheck.missingHtml.some((a) => a.notebook === crashId && a.id === 'ghost-art'), JSON.stringify(orphanCheck.missingHtml));
check('体检有问题时 ok=false', orphanCheck.ok === false);

// ─────────────────────────────────────── 12d. 处置台：隔离区（只搬走，不删除，可放回）

section('12d. 处置台：孤儿制品送进隔离区，随时可放回');

const qr = store.quarantineOrphans();
check('隔离区搬走了那件孤儿制品', qr.moved.some((m) => m.notebook === crashId && m.id === 'orphan-art'), JSON.stringify(qr.moved));
check('搬走就是搬走，原地不再有该目录', !fs.existsSync(orphanDir));
const orphanCheck2 = store.healthCheck();
check('隔离后体检不再点名孤儿（报告回到只报真问题）', !orphanCheck2.orphanArtifacts.some((a) => a.id === 'orphan-art'), JSON.stringify(orphanCheck2.orphanArtifacts));
check('体检报告带隔离区件数（处置台被看见）', orphanCheck2.quarantined >= 1, String(orphanCheck2.quarantined));
const rr = store.restoreQuarantined();
check('放回后目录回到原位', rr.restored.some((m) => m.notebook === crashId && m.id === 'orphan-art') && fs.existsSync(orphanDir), JSON.stringify(rr.restored));
const orphanCheck3 = store.healthCheck();
check('放回后体检恢复点名（处置台可逆）', orphanCheck3.orphanArtifacts.some((a) => a.id === 'orphan-art'), JSON.stringify(orphanCheck3.orphanArtifacts));
// 原位被占：放回必须让路，不覆盖新文件
store.quarantineOrphans();
fs.mkdirSync(orphanDir, { recursive: true });
fs.writeFileSync(path.join(orphanDir, 'index.html'), '<html><body>新东西</body></html>');
const rr2 = store.restoreQuarantined();
check('原位已有新文件时放回让路（不覆盖，留在隔离区）', rr2.kept.some((m) => m.id === 'orphan-art' && m.reason?.includes('让路')), JSON.stringify(rr2.kept));
check('让路后新文件原样还在', fs.existsSync(path.join(orphanDir, 'index.html')));

// ─────────────────────────────────────── 12e. 对话治理：模型输入的上下文窗口

section('12e. 对话治理：模型输入只保留开头 + 最近一段，落盘一字不少');

const { windowHistory } = await import('../server/agent.mjs');
const { MAX_DIALOGUE_MESSAGES } = await import('../server/config.mjs');
// buildSystemPrompt 已在第 7b 节正名导入（同一模块同一份缓存），这里直接用

// 窗口只在历史超长时启用
const shortHistory = [
  { role: 'user', content: '我要学闭包', timestamp: 1 },
  { role: 'assistant', content: '好，先讲作用域', timestamp: 2 },
  { role: 'user', content: '懂', timestamp: 3 },
];
check('短历史原样通过（窗口不动它）', windowHistory(shortHistory) === shortHistory, 'window 返回了别的对象');

// 超长历史：保留开头第一条用户消息（锚点）+ 最近一段
const longHistory = [];
for (let i = 0; i < 60; i += 1) {
  longHistory.push(i % 2 === 0 ? { role: 'user', content: `第 ${i} 句`, timestamp: i } : { role: 'assistant', content: `答 ${i}`, timestamp: i });
}
const windowed = windowHistory(longHistory);
check('超长历史被收到窗口上限', windowed.length === MAX_DIALOGUE_MESSAGES, `${windowed.length}/${MAX_DIALOGUE_MESSAGES}`);
check('锚点保留：开头那条用户消息一定在窗口里', windowed[0] === longHistory[0], windowed[0]?.content);
check('最近的对话在窗口里', windowed[windowed.length - 1] === longHistory[longHistory.length - 1], windowed[windowed.length - 1]?.content);
check('锚点不重复（窗口里没有两条"第 0 句"）', windowed.filter((m) => m === longHistory[0]).length === 1, '重复了');
check('窗口里没有中间那些旧轮', !windowed.some((m) => m === longHistory[10]), '中间轮溜进来了');

// 锚点恰好也在最近一段里时不重复
const overlapHistory = [];
for (let i = 0; i < 45; i += 1) {
  overlapHistory.push({ role: i === 0 ? 'user' : (i % 2 ? 'assistant' : 'user'), content: `m${i}`, timestamp: i });
}
const w2 = windowHistory(overlapHistory);
check('锚点与最近段重叠时不重复计', w2.length === MAX_DIALOGUE_MESSAGES && w2.filter((m) => m === overlapHistory[0]).length === 1, String(w2.length));

// 窗口化是模型输入侧的事：buildSystemPrompt 只在窗口启用时明说，模型不会假装记得窗口外的旧轮
const slimPrompt = buildSystemPrompt({ topic: 't', chat: { messages: shortHistory } });
check('短对话时 prompt 不出现窗口说明（不吓模型）', !slimPrompt.includes('对话窗口说明'), '短对话也带了窗口说明');
const fatPrompt = buildSystemPrompt({ topic: 't', chat: { messages: longHistory } });
check('窗口启用时 prompt 明说旧轮不在上下文（报告诚实）', fatPrompt.includes('对话窗口说明') && fatPrompt.includes('不要凭印象编造'), '没说明');
check('窗口说明是"去笔记/图谱找"，不是让模型硬想', fatPrompt.includes('笔记') && fatPrompt.includes('图谱'), '没指向持久记忆');

// ─────────────────────────────────────── 13. JEV 判定外包

section('13. JEV 判定外包（决策模型做判定，状态机不做法官）');

// —— 13a. 请求校验（镜像官方 CLI：choice 2–255、score 2–10、noul 只能缺省或 {true,false}）
const choiceOk = validateQuestions([{ id: 'next', type: 'choice', instructions: '选一个', criteria: { a: '甲', b: '乙' } }]);
check('choice 问题通过校验', choiceOk.next.type === 'choice');
const noulOk = validateQuestions([{ id: 'ok', type: 'noul', instructions: '判一下' }]);
check('noul 问题（无 criteria）通过校验', noulOk.ok.type === 'noul');
const scoreOk = validateQuestions([{ id: 's', type: 'score', instructions: '打分', criteria: ['差', '中', '好'] }]);
check('score 问题（2–10 级）通过校验', scoreOk.s.type === 'score');
const multiOk = validateQuestions([
  { id: 'a', type: 'noul', instructions: 'x' },
  { id: 'b', type: 'choice', instructions: 'y', criteria: { a: '1', b: '2' } },
]);
check('数组形状归一成 id→问题 对象', Object.keys(multiOk).sort().join(',') === 'a,b');
const rejectIds = (qs) => {
  try { validateQuestions(qs); return false; }
  catch (e) { return e instanceof DecisionError && e.kind === 'validation'; }
};
check('重复 id 必须拒绝', rejectIds([
  { id: 'a', type: 'noul', instructions: 'x' },
  { id: 'a', type: 'noul', instructions: 'y' },
]));
check('空 questions 必须拒绝', rejectIds([]));
check('choice 少于 2 个候选必须拒绝', rejectIds([{ id: 'c', type: 'choice', instructions: 'x', criteria: { a: '1' } }]));
check('未知 type 必须拒绝', rejectIds([{ id: 'z', type: 'maybe', instructions: 'x' }]));
check('noul 带非 true/false criteria 必须拒绝', rejectIds([{ id: 'n', type: 'noul', instructions: 'x', criteria: { yes: '对', no: '错' } }]));
check('score 少于 2 级必须拒绝', rejectIds([{ id: 's', type: 'score', instructions: 'x', criteria: ['一'] }]));
check('空 instructions 必须拒绝', rejectIds([{ id: 'i', type: 'noul', instructions: '  ' }]));

// —— 13b. 响应归一化：概率只当门槛，低概率 / 低边际 / 让位标签进 needs_review
const normPayload = {
  model: 'jev-1.13.0',
  state: { goal: '判定这条作答', observations: '作答：闭包是复制变量' },
  questions: validateQuestions([
    { id: 'verdict', type: 'noul', instructions: '作答是否展示了对闭包的理解' },
    { id: 'pick', type: 'choice', instructions: '下一步', criteria: { review_again: '再问一次', teach: '重新讲' } },
    { id: 'grade', type: 'score', instructions: '把握度', criteria: ['低', '中', '高'] },
  ]),
};
const goodAnswers = normalizeAnswers(normPayload, {
  answers: {
    verdict: { type: 'noul', noul: 0.88 },
    pick: { type: 'choice', choice: 'review_again', probabilities: { review_again: 0.85, teach: 0.15 }, confidence: 0.9 },
    grade: { type: 'score', score: 1, legend: { 0: '低', 1: '中', 2: '高' }, probabilities: { 0: 0.1, 1: 0.7, 2: 0.2 } },
  },
});
check('noul 高置信 → selected，value=true，概率即 P(true)',
  goodAnswers.verdict.status === 'selected' && goodAnswers.verdict.value === true && goodAnswers.verdict.probability === 0.88);
check('choice 顶选概率够 → selected 且带 margin',
  goodAnswers.pick.status === 'selected' && goodAnswers.pick.value === 'review_again' && goodAnswers.pick.margin === 0.7);
check('score → scored 且带等级', goodAnswers.grade.status === 'scored' && goodAnswers.grade.value === 1 && goodAnswers.grade.levels.length === 3);
const lowAnswers = normalizeAnswers(normPayload, {
  answers: {
    verdict: { type: 'noul', noul: 0.55 },
    pick: { type: 'choice', choice: 'review_again', probabilities: { review_again: 0.6, teach: 0.4 }, confidence: 0.6 },
    grade: { type: 'score', score: 0, legend: { 0: '低', 1: '中', 2: '高' }, probabilities: { 0: 0.9, 1: 0.05, 2: 0.05 } },
  },
});
check('noul 置信不足 → needs_review（不硬判）', lowAnswers.verdict.status === 'needs_review');
check('choice 顶选概率不足 → needs_review', lowAnswers.pick.status === 'needs_review');
const unknownPayload = {
  model: 'jev-1.13.0',
  state: normPayload.state,
  questions: validateQuestions([
    { id: 'verdict', type: 'noul', instructions: '作答是否展示了对闭包的理解' },
    { id: 'pick', type: 'choice', instructions: '下一步', criteria: { review_again: '再问一次', teach: '重新讲', unknown: '证据不足' } },
    { id: 'grade', type: 'score', instructions: '把握度', criteria: ['低', '中', '高'] },
  ]),
};
const unknownAnswers = normalizeAnswers(unknownPayload, {
  answers: {
    verdict: { type: 'noul', noul: 0.92 },
    pick: { type: 'choice', choice: 'unknown', probabilities: { unknown: 0.95, teach: 0.03, review_again: 0.02 }, confidence: 0.9 },
    grade: { type: 'score', score: 2, legend: { 0: '低', 1: '中', 2: '高' }, probabilities: { 0: 0.05, 1: 0.05, 2: 0.9 } },
  },
});
check('choice 选中让位标签（unknown）→ needs_review（缺失证据=unknown）',
  unknownAnswers.pick.status === 'needs_review' && unknownAnswers.pick.value === 'unknown');
const rejectAnswers = (raw) => {
  try { normalizeAnswers(normPayload, raw); return false; }
  catch (e) { return e instanceof DecisionError && e.kind === 'parse'; }
};
check('响应缺题 → parse 错误', rejectAnswers({ answers: { verdict: { type: 'noul', noul: 0.9 } } }));
check('choice 返回非最高概率候选 → parse 错误', rejectAnswers({
  answers: {
    verdict: { type: 'noul', noul: 0.9 },
    pick: { type: 'choice', choice: 'teach', probabilities: { review_again: 0.9, teach: 0.1 }, confidence: 0.9 },
    grade: { type: 'score', score: 0, legend: { 0: 'a', 1: 'b', 2: 'c' }, probabilities: { 0: 0.9, 1: 0.05, 2: 0.05 } },
  },
}));
check('probabilities 未归一 → parse 错误', rejectAnswers({
  answers: {
    verdict: { type: 'noul', noul: 0.9 },
    pick: { type: 'choice', choice: 'teach', probabilities: { review_again: 0.7, teach: 0.1 }, confidence: 0.9 },
    grade: { type: 'score', score: 0, legend: { 0: 'a', 1: 'b', 2: 'c' }, probabilities: { 0: 0.9, 1: 0.05, 2: 0.05 } },
  },
}));

// —— 13c. faux 模式：确定性桩，jev_called=false（不联网、不花钱、不假装真判过）
const fauxResult = await jevDecide(
  { state: { goal: 'g', observations: 'o' }, questions: [
    { id: 'v', type: 'noul', instructions: '判' },
    { id: 'c', type: 'choice', instructions: '选', criteria: { a: '甲', b: '乙' } },
  ] },
  { faux: true },
);
check('faux 模式返回确定性判定（choice 取首个候选）',
  fauxResult.mode === 'faux' && fauxResult.jev_called === false &&
    fauxResult.decisions.v.value === true && fauxResult.decisions.c.value === 'a' && fauxResult.decisions.c.margin === 0.4);
const fauxInjected = await jevDecide(
  { state: { goal: 'g' }, questions: [{ id: 'v', type: 'noul', instructions: '判' }] },
  { faux: true, fauxAnswers: { v: { status: 'needs_review', value: false, probability: 0.5 } } },
);
check('fauxAnswers 可注入（测试用例可控）',
  fauxInjected.decisions.v.status === 'needs_review' && fauxInjected.decisions.v.value === false);

// —— 13d. 无 key 不假装：config 错误明说（点名环境变量），绝不静默降级
let cfgErr = null;
try {
  await jevDecide(
    { state: { goal: 'g' }, questions: [{ id: 'v', type: 'noul', instructions: '判' }] },
    { faux: false, apiKey: '' },
  );
} catch (e) { cfgErr = e; }
check('无 key 且非 faux → config 错误（点名环境变量）',
  cfgErr instanceof DecisionError && cfgErr.kind === 'config' && /TYPESAFE_API_KEY/.test(cfgErr.message));

// —— 13f. 面板配置压过环境变量（第十五轮：Decision 面板显式可配）
const envForMerge = {
  SOCRATIC_JEV_PROVIDER: 'openrouter',
  SOCRATIC_JEV_API_KEY: 'env-key',
  SOCRATIC_JEV_MODEL: 'env-model',
  SOCRATIC_ENABLE_FAUX: '1',
};
const envOnly = mergeJevConfig({}, envForMerge);
check('面板没配时整份回退环境变量（provider/key/model/faux）',
  envOnly.provider === 'openrouter' && envOnly.apiKey === 'env-key' && envOnly.model === 'env-model' && envOnly.faux === true,
  JSON.stringify(envOnly));
const panelWins = mergeJevConfig({ provider: 'typesafe', apiKey: 'panel-key', faux: false }, envForMerge);
check('面板配了的字段压过环境变量（provider/key/faux），没配的仍回退（model）',
  panelWins.provider === 'typesafe' && panelWins.apiKey === 'panel-key' && panelWins.faux === false && panelWins.model === 'env-model',
  JSON.stringify(panelWins));
const storedOpts = panelDecisionOpts({
  settings: { decision: { provider: 'openrouter', model: 'typesafe/jev-1.13', faux: true } },
  credentials: { key: 'c-key' },
});
check('panelDecisionOpts 从落盘配置生成 opts（provider/model/faux/apiKey）',
  storedOpts.provider === 'openrouter' && storedOpts.model === 'typesafe/jev-1.13' && storedOpts.faux === true && storedOpts.apiKey === 'c-key',
  JSON.stringify(storedOpts));
check('panelDecisionOpts 全空回 null（没碰过面板 → 判定走环境变量）', panelDecisionOpts({}) === null);
check('panelDecisionOpts 只配 provider 也生效', panelDecisionOpts({ settings: { decision: { provider: 'typesafe' } } })?.provider === 'typesafe');

// —— 13g. 判定模型「测试连接」（第十六轮）：三分支确定性可测，请求构造可逐字段断言
const pingNoKey = await jevPing({ provider: 'typesafe', faux: false });
check('测试连接：无 key → auth 分支（不抛、不假装）', pingNoKey.ok === false && pingNoKey.stage === 'auth', JSON.stringify(pingNoKey));
const pingFaux = await jevPing({ provider: 'typesafe', faux: true });
check('测试连接：faux → 明说桩不联网（不验证 key）', pingFaux.ok === true && pingFaux.mode === 'faux', JSON.stringify(pingFaux));
const specTs = buildDecisionFetch(
  { provider: 'typesafe', apiKey: 'k-1', model: 'jev-1.13.0' },
  { model: 'jev-1.13.0', state: 's', questions: { ping: { type: 'noul', instructions: 'x' } } },
);
check('请求构造：typesafe 端点 + Bearer key + JSON 载荷',
  specTs.url === 'https://api.typesafe.ai/v1/systemone'
    && specTs.headers.Authorization === 'Bearer k-1'
    && specTs.headers['Content-Type'] === 'application/json'
    && JSON.parse(specTs.body).model === 'jev-1.13.0',
  JSON.stringify(specTs).slice(0, 140));
const specOr = buildDecisionFetch(
  { provider: 'openrouter', apiKey: 'k-2', model: 'typesafe/jev-1.13' },
  { model: 'typesafe/jev-1.13', state: 's', questions: { ping: { type: 'noul', instructions: 'x' } } },
);
check('请求构造：openrouter 端点（alpha/decisions）+ 同一把 Bearer key',
  specOr.url === 'https://openrouter.ai/api/alpha/decisions' && specOr.headers.Authorization === 'Bearer k-2',
  JSON.stringify(specOr).slice(0, 120));

// —— 13e. 工具接线：buildTools 注册、execJevJudge 判定留痕、无 key 明说、坏输入报 validation
const jevTool = buildTools().find((t) => t.name === TOOL_NAMES.JEV_JUDGE);
check('buildTools 注册了 jev_judge', Boolean(jevTool));
check('jev_judge 参数是 state + questions 数组',
  /state/.test(JSON.stringify(jevTool.parameters)) && /questions/.test(JSON.stringify(jevTool.parameters)));

const jevNb = store.getNotebook(store.createNotebook({ topic: '判定外包探针', goal: '看判定怎么留痕', pace: 'normal' }).id);
const jevSession = new TeachingSession({
  registry,
  notebook: jevNb,
  emit: () => {},
  systemPrompt: '',
  deskWriter: false,
  decision: { faux: true },
});
const judged = await jevSession.execTool(TOOL_NAMES.JEV_JUDGE, {
  state: { goal: '判断这条作答是否展示理解', observations: '作答：闭包是返回的函数带着词法环境' },
  questions: [{ id: 'verdict', type: 'noul', instructions: '作答是否展示了闭包概念的理解' }],
});
check('execJevJudge 在 faux 下 ok 且 jev_called=false',
  judged.ok === true && judged.mode === 'faux' && judged.jev_called === false && judged.decisions.verdict.value === true);
const journalPath = path.join(NOTEBOOKS_DIR, jevNb.id, 'decision-journal.json');
const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
check('判定写进 notebook 的 decision-journal（判定全留痕）',
  journal.length === 1 && journal[0].kind === 'decision' && journal[0].mode === 'faux' && journal[0].decisions.verdict);
check('留痕含完整输入（state/questions）与输出（decisions）',
  journal[0].state.goal && Array.isArray(journal[0].questions) && journal[0].jev_called === false);
check('key 不进留痕', !JSON.stringify(journal).includes('TYPESAFE') && !JSON.stringify(journal).includes('Bearer'));

const noKeyNb = store.getNotebook(store.createNotebook({ topic: '无 key 探针', goal: '看明说跳过', pace: 'normal' }).id);
const noKeySession = new TeachingSession({
  registry,
  notebook: noKeyNb,
  emit: () => {},
  systemPrompt: '',
  deskWriter: false,
  decision: { faux: false, apiKey: '' },
});
const jevRefused = await noKeySession.execTool(TOOL_NAMES.JEV_JUDGE, {
  state: { goal: 'g', observations: 'o' },
  questions: [{ id: 'v', type: 'noul', instructions: '判' }],
});
check('无 key 时工具明说跳过（ok:false + config 错误）',
  jevRefused.ok === false && jevRefused.decision_error === 'config' && /TYPESAFE_API_KEY/.test(jevRefused.error));
const errJournal = JSON.parse(fs.readFileSync(path.join(NOTEBOOKS_DIR, noKeyNb.id, 'decision-journal.json'), 'utf8'));
check('失败的判定也留痕（error 条目带 kind）',
  errJournal.length === 1 && errJournal[0].kind === 'error' && errJournal[0].error.kind === 'config');
const badJudge = await noKeySession.execTool(TOOL_NAMES.JEV_JUDGE, {
  state: { goal: 'g' },
  questions: [{ id: 'v', type: 'noul', instructions: '   ' }],
});
check('坏输入（空 instructions）→ ok:false + kind=validation',
  badJudge.ok === false && badJudge.decision_error === 'validation');

// —— 13f. 使用指引接线：判对/判错 与 制品证据支撑 两个典型场合点名
const jevDesc = jevTool.description;
check('工具描述点名两个典型场合（判对/判错 + 证据支撑 + read_artifact_evidence 原料）',
  /判对\/判错/.test(jevDesc) && /证据支撑/.test(jevDesc) && /read_artifact_evidence/.test(jevDesc));
check('工具描述提醒别过度外包（其余判定照旧自己来）', /别把每个步骤都外包/.test(jevDesc));
const jevPrompt = buildSystemPrompt({ topic: 't', chat: { messages: shortHistory } });
check('system prompt 点名 jev_judge 两个场合（判对/判错、证据支撑）',
  jevPrompt.includes('jev_judge') && jevPrompt.includes('判对/判错') && jevPrompt.includes('证据支撑'));
check('prompt 判定指引要求「先 read_artifact_evidence 再判、缺证据判 unknown」',
  jevPrompt.includes('read_artifact_evidence') && jevPrompt.includes('缺证据就判 unknown'));

// ─────────────────────────────────────── 12g. 学习小结（人可读的整本总结）
{
  const sumId = store.createNotebook({ title: '正则表达式', topic: '正则表达式', goal: null, pace: 'normal' }).id;
  store.saveGraph(sumId, {
    meta: {
      topic: '正则表达式',
      goal: '能读懂并写出工作中的正则',
      pedagogy: 'programming',
      learner_profile: { background: '有编程基础', known_concepts: [], pace: 'normal' },
    },
    concepts: [
      {
        id: 'char-class', name: '字符类', summary: '用 […] 匹配一组字符中的一个',
        depends_on: [], importance: 'core', misconceptions: ['把 [abc] 当成顺序匹配'], assessment_items: [],
      },
      {
        id: 'quantifier', name: '量词', summary: '控制前面元素的重复次数',
        depends_on: ['char-class'], importance: 'core', misconceptions: ['贪婪与非贪婪分不清'], assessment_items: [],
      },
    ],
  });
  store.saveProgress(sumId, {
    version: 1,
    session_open: false,
    concepts: {
      'char-class': { concept_id: 'char-class', state: 'understood', next_action: null, unverified_self_report: false, note: null },
      'quantifier': { concept_id: 'quantifier', state: 'seen', next_action: '接地→探针', unverified_self_report: false, note: null },
    },
    notes: [],
    updated_at: new Date().toISOString(),
  });
  const { saveNote } = await import('../server/notes.mjs');
  saveNote(sumId, {
    title: '字符类',
    summary: '方括号里是字符集合',
    key_points: ['[a-z] 匹配一个小写字母', '^ 在括号内表示取反'],
    example: '[0-9] 匹配任意数字',
    concepts: ['char-class'],
  });
  store.saveArtifact(sumId, { title: '正则试错场', html: '<p>x</p>', kind: 'interactive' });
  const retiredArt = store.saveArtifact(sumId, { title: '旧练习卡', html: '<p>y</p>', kind: 'page' });
  store.setArtifactLifetime(sumId, retiredArt.id, true);

  const md = store.summaryMarkdown(sumId);
  check('小结优先用编译后的目标（graph.meta.goal），建会话时的原始 goal 为空也能顶上',
    md.includes('## 目标') && md.includes('能读懂并写出工作中的正则'), md.split('\n').slice(0, 6).join(' / '));
  check('概念按依赖顺序出现（量词排在字符类之后）',
    md.indexOf('字符类') < md.indexOf('量词'), md.split('\n').filter((l) => l.startsWith('-')).join(' / '));
  check('状态是词不是数字，且整份小结没有比率 / 百分比 / 分数指纹',
    md.includes('—— 已学懂') && md.includes('—— 正在学习') && !/%|掌握率|进度条|分数|星级|\d+\s*\/\s*\d+|\d+\s*个里/.test(md), md);
  check('误解点写进小结（容易踩的坑）',
    md.includes('容易踩的坑') && md.includes('贪婪与非贪婪分不清'), md);
  check('依赖引用的是概念名而不是 id（前置：字符类）', md.includes('前置：字符类'), md);
  check('笔记段落完整（### 标题 / 要点 / 例子代码块）',
    md.includes('### 字符类') && md.includes('[a-z] 匹配一个小写字母') && md.includes('[0-9] 匹配任意数字'), md);
  check('制品清单区分软退役：在台上 / 已收起',
    md.includes('正则试错场（交互物件）—— 在台上') && md.includes('旧练习卡（讲解页）—— 已收起'), md);
  check('背景写进小结（learner_profile.background）', md.includes('背景：有编程基础'), md);

  // 退化形状：没有目标也没有主题时，目标/主题节整体不出现，但标题仍在（小结不是空文件）
  const bareSumId = store.createNotebook({ title: '空白本', topic: '', goal: null, pace: 'normal' }).id;
  const bareMd = store.summaryMarkdown(bareSumId);
  check('无目标无主题：小结只有标题，不摆空的「目标」节',
    bareMd.startsWith('# 空白本') && !bareMd.includes('## 目标') && !bareMd.includes('## 主题') && !bareMd.includes('## 概念结构'), bareMd);
}

// ─────────────────────────────────────── 12h. 小结网页版（同一份数据源的 HTML 出口）
{
  // 与 12g 同一套夹具：小结的两种格式必须从同一份数据源长出同一套事实
  const sumId = store.createNotebook({ title: '正则表达式', topic: '正则表达式', goal: null, pace: 'normal' }).id;
  store.saveGraph(sumId, {
    meta: {
      topic: '正则表达式',
      goal: '能读懂并写出工作中的正则',
      pedagogy: 'programming',
      learner_profile: { background: '有编程基础', known_concepts: [], pace: 'normal' },
    },
    concepts: [
      { id: 'char-class', name: '字符类', summary: '用 […] 匹配一组字符中的一个', depends_on: [], importance: 'core', misconceptions: ['把 [abc] 当成顺序匹配'], assessment_items: [] },
      { id: 'quantifier', name: '量词', summary: '控制前面元素的重复次数', depends_on: ['char-class'], importance: 'core', misconceptions: ['贪婪与非贪婪分不清'], assessment_items: [] },
    ],
  });
  store.saveProgress(sumId, {
    version: 1,
    session_open: false,
    concepts: {
      'char-class': { concept_id: 'char-class', state: 'understood', next_action: null, unverified_self_report: false, note: null },
      'quantifier': { concept_id: 'quantifier', state: 'seen', next_action: '接地→探针', unverified_self_report: false, note: null },
    },
    notes: [],
    updated_at: new Date().toISOString(),
  });
  const { saveNote } = await import('../server/notes.mjs');
  saveNote(sumId, { title: '字符类', summary: '方括号里是字符集合', key_points: ['[a-z] 匹配一个小写字母'], example: '[0-9] 匹配任意数字', concepts: ['char-class'] });
  store.saveArtifact(sumId, { title: '正则试错场', html: '<p>x</p>', kind: 'interactive' });
  const retiredArt = store.saveArtifact(sumId, { title: '旧练习卡', html: '<p>y</p>', kind: 'page' });
  store.setArtifactLifetime(sumId, retiredArt.id, true);

  const h = store.summaryHtml(sumId);
  check('小结网页版是自包含页面（<!doctype html>，无外部脚本 / 样式 / 图片资源）',
    h.startsWith('<!doctype html>') && !/<(link|script|img)[^>]+src=/.test(h) && !/@import|url\(https?:/.test(h),
    h.slice(0, 180));
  check('网页版包含目标与状态词，且没有比率 / 百分比 / 分数指纹',
    h.includes('<h2>目标</h2>') && h.includes('已学懂') && h.includes('正在学习') &&
    !/%|掌握率|进度条|分数|星级|\d+\s*个里/.test(h), h.split('\n').filter((l) => l.includes('strong')).join(' / '));
  check('网页版概念按依赖序、误解点与依赖都在',
    h.indexOf('字符类') < h.indexOf('量词') && h.includes('容易踩的坑：贪婪与非贪婪分不清') && h.includes('前置：字符类'),
    '');
  check('网页版笔记与制品齐全（在台上 / 已收起）',
    h.includes('正则试错场（交互物件）—— 在台上') && h.includes('旧练习卡（讲解页）—— 已收起'), h.split('\n').filter((l) => l.includes('<li>')).join(' / '));
  check('网页版对模型 / 学习者内容做 HTML 转义（< 不被当成标签）',
    (() => {
      const escId = store.createNotebook({ title: '转义测试', topic: '', goal: null, pace: 'normal' }).id;
      saveNote(escId, { title: 'a<b>', summary: 'x<y>', key_points: ['<script>alert(1)</script>'], concepts: [] });
      const eh = store.summaryHtml(escId);
      return eh.includes('a&lt;b&gt;') && eh.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !eh.includes('<b>');
    })(), '');
  check('无目标无主题：网页版也不摆空的「目标 / 主题」节',
    (() => {
      const bareH = store.summaryHtml(store.createNotebook({ title: '空白本', topic: '', goal: null, pace: 'normal' }).id);
      return !bareH.includes('<h2>目标</h2>') && !bareH.includes('<h2>主题</h2>');
    })(), '');
}

// ─────────────────────────────────────── 12i. 对话记录导出（带走过程）
{
  // 与小结的分工：小结是结论，对话是过程。过程 = 消息 + 题卡（题干/选项/作答）+ 制品 + 笔记，
  // 按时间线还原，场头在 sceneId 变化处插入。
  const convId = store.createNotebook({ title: '闭包学习', topic: '闭包', goal: null, pace: 'normal' }).id;
  // fixture 必须和断言**同一个坐标系**：下面断言的是导出里的本地墙钟字符串（fmtDateTime 走
  // getHours 那一族），所以时刻也得按本地墙钟构造。写死 '...T12:00:00+08:00' 是绝对时刻，
  // 只有在 UTC+8 才和断言相遇——换个时区（UTC / 纽约 / 加尔各答）这条必红，而红的是测试的
  // 坐标系对不上，不是应用坏。用本地分量构造，任何时区都是 12:00。
  // 时分都取个位数（09:05 / 09:06）：这样补零丢了对不上——12:00 那种整十位
  // 把 padStart 删了断言照样绿，等于没钉。
  const t0 = new Date(2026, 9, 6, 9, 5, 0).getTime();
  // 开场：场景带场名（openScene 来自 scene.mjs，store.saveSceneState 落盘）
  const { openScene } = await import('../server/scene.mjs');
  store.saveSceneState(convId, openScene(store.readSceneState(convId), { title: '作用域实战', conceptId: null }));
  store.appendChat(convId, [{ role: 'user', content: '我想弄明白闭包', timestamp: t0, attachments: [] }]);
  store.appendChat(convId, [{
    role: 'assistant',
    content: '先看作用域：函数记得它出生的环境。',
    timestamp: t0 + 60000,
    sceneId: 'scene-01',
    attachments: [],
    questions: [{
      questionId: 'q1', header: '探针', question: '外层函数 return 之后，里层还能读到它当时的变量吗？',
      options: [{ label: '能读到', description: '里层握着绑定' }, { label: '读不到' }],
      answer: { selected: ['能读到'], text: '函数记住了环境', skipped: false },
    }],
    artifacts: [{ id: 'art-x', title: '闭包小剧场', kind: 'interactive', rel: 'artifacts/art-x/index.html' }],
  }]);
  // saveNote 强制 createdAt=now（会排到对话末尾），这里直接写盘控制时间戳：
  // 笔记落在第 1 拍与第 2 拍之间，验证"按时间线插入，不单独堆到末尾"。
  fs.writeFileSync(path.join(tmpRoot, 'notebooks', convId, 'notes.json'),
    JSON.stringify({ version: 1, notes: [{ id: 'note-1', title: '闭包', summary: '函数带着词法环境跑', key_points: [], example: '', concepts: [], createdAt: new Date(t0 + 45000).toISOString() }], updated_at: new Date().toISOString() }));
  const convMd = store.exportConversationMarkdown(convId);
  check('对话导出带标题与导出时间、按场分节',
    convMd.includes('# 闭包学习 — 对话记录') && convMd.includes('> 导出于 ') && convMd.includes('## 第 1 场：作用域实战'),
    convMd.split('\n').filter((l) => l.startsWith('#')).join(' | '));
  check('角色标签：我 / 老师，消息按拍号排、带时间',
    convMd.includes('**我**：我想弄明白闭包') && convMd.includes('**老师**：先看作用域') &&
    convMd.includes('### 第 1 拍（2026-10-06 09:05') && convMd.includes('### 第 2 拍（2026-10-06 09:06'),
    convMd.split('\n').filter((l) => l.includes('拍')).join(' | '));
  // 钉住"这是本地墙钟不是 UTC"这条语义（与 contract-consistency 那节配对）：
  // 用独立算法（UTC getter）算出同一时刻的 UTC 字符串——只有当本机就在 UTC 时，两者才相等；
  // 非 UTC 时区必须能在导出里找到本地那串、找不到 UTC 那串。谁把 fmtDateTime 改成 UTC 口径，
  // 这台机器上就红（UTC 机器上两者天然相等，所以另一头由 contract-consistency 钉住 getUTC 不许出现）。
  {
    const d = new Date(t0);
    const pu = (n) => String(n).padStart(2, '0');
    const utcStr = `${d.getUTCFullYear()}-${pu(d.getUTCMonth() + 1)}-${pu(d.getUTCDate())} ${pu(d.getUTCHours())}:${pu(d.getUTCMinutes())}`;
    const localStr = `${d.getFullYear()}-${pu(d.getMonth() + 1)}-${pu(d.getDate())} ${pu(d.getHours())}:${pu(d.getMinutes())}`;
    if (utcStr === localStr) {
      check('本地墙钟恰等于 UTC（本机在 UTC 时区）时导出仍取该串',
        convMd.includes(`### 第 1 拍（${localStr}`), 'UTC 机器上这条与上一条同串，检查 fixture 是否还在今天历');
    } else {
      check('导出的时间戳是本地墙钟而不是 UTC（两个坐标系不许混用）',
        convMd.includes(`### 第 1 拍（${localStr}`) && !convMd.includes(`### 第 1 拍（${utcStr}`),
        `local=${localStr} utc=${utcStr}`);
    }
  }
  check('题卡还原题干 / 选项 / 作答（含补充文字），未作答要如实说',
    convMd.includes('> 题卡（探针）：外层函数 return 之后，里层还能读到它当时的变量吗？') &&
    convMd.includes('> 选项：能读到 · 读不到') &&
    convMd.includes('> 你的回答：能读到 —— 函数记住了环境'),
    convMd.split('\n').filter((l) => l.includes('题卡') || l.includes('选项') || l.includes('回答')).join(' | '));
  check('制品按在台上/已收起标注（软退役语义不变）',
    convMd.includes('> 制品：闭包小剧场（交互物件）—— 在台上'),
    convMd.split('\n').filter((l) => l.includes('制品')).join(' | '));
  check('笔记落在时间线上（与对话同序，不单独堆到末尾）',
    (() => {
      const noteLine = convMd.indexOf('> 笔记：闭包');
      const beat1 = convMd.indexOf('### 第 1 拍');
      const beat2 = convMd.indexOf('### 第 2 拍');
      return noteLine > beat1 && noteLine < beat2;
    })(), '');
  check('对话导出没有进度数字 / 比率 / 百分比指纹（Invariant 4）',
    !/%|掌握率|进度条|分数|星级|\d+\s*个里/.test(convMd), convMd.split('\n').filter((l) => l.includes('拍')).join(' / '));
  check('空对话只给标题与一句说明，不摆空架子',
    (() => {
      const bareMd = store.exportConversationMarkdown(
        store.createNotebook({ title: '空白本', topic: '', goal: null, pace: 'normal' }).id);
      return bareMd.includes('（这一本还没有对话。）') && !bareMd.includes('### 第 ');
    })(), '');
}

// ─────────────────────────────────────── 12j. 看不见的看得见：判定账本 / 损坏取证 / 回马枪候选

{
  // 12j-1 判定账本可读：JEV 留痕从盘上睡觉变成右栏审计视图。
  // 红线是"判定全留痕"，readDecisions 是它的可读出口；但可见面只出词、不出数字——
  // value / probability 是判定置信度不是学习量（Invariant 4 边界，见 store 注释）。
  const decId = store.createNotebook({ topic: '判定账本', goal: null, pace: 'normal' }).id;
  check('空账本读回空列表（没有判定就不摆节）', JSON.stringify(store.readDecisions(decId)) === '[]');
  store.appendDecisionJournal(decId, {
    at: '2026-10-07T01:00:00.000Z', kind: 'decision', mode: 'real', jev_called: true,
    provider: 'typesafe', model: 'jev-1.13.0',
    state: { goal: 'x', permissions: [], recent_steps: [], observations: ['作答原文'] },
    questions: { q1: { type: 'noul', instructions: '判是否展示理解', criteria: '…' } },
    decisions: [{ id: 'q1', status: 'selected', value: true, probability: 0.91, margin: 0.4 }],
  });
  store.appendDecisionJournal(decId, {
    at: '2026-10-07T02:00:00.000Z', kind: 'decision', mode: 'faux', jev_called: false,
    state: { goal: 'x', permissions: [], recent_steps: [], observations: [] },
    questions: { q2: { type: 'noul', instructions: '…', criteria: '…' } },
    decisions: [{ id: 'q2', status: 'needs_review', value: false, probability: 0.28 }],
  });
  store.appendDecisionJournal(decId, {
    at: '2026-10-07T03:00:00.000Z', kind: 'error',
    state: { goal: 'x', permissions: [], recent_steps: [], observations: [] },
    questions: { q3: { type: 'noul', instructions: '…', criteria: '…' } },
    error: { kind: 'timeout', message: '上游超时' },
  });
  const decs = store.readDecisions(decId);
  check('判定账本按最近优先回摘要（error 在后、先出）', decs[0]?.kind === 'error' && decs[0]?.error === 'timeout', JSON.stringify(decs[0]));
  check('真实判定摘要：模式 + 结论 + 题数', decs[1]?.kind === 'decision' && decs[1]?.mode === 'faux' && decs[1]?.verdict === 'needs_review' && decs[1]?.n === 1, JSON.stringify(decs[1]));
  check('通过判定摘要：verdict=selected', decs[2]?.kind === 'decision' && decs[2]?.verdict === 'selected' && decs[2]?.mode === 'real', JSON.stringify(decs[2]));
  check('摘要里没有判定置信度数字（value/probability 不进可见面）',
    !JSON.stringify(decs).includes('probability') && !JSON.stringify(decs).includes('"value"') && !JSON.stringify(decs).includes('0.91'),
    JSON.stringify(decs));
  check('getNotebook 带判定摘要（前端渲染用它）', Array.isArray(store.getNotebook(decId).decisions) && store.getNotebook(decId).decisions.length === 3);

  // 12j-2 损坏文件取证：体检点名之后原件拿得到；只允许报告里的路径。
  const corruptId = store.createNotebook({ topic: '取证', goal: null, pace: 'normal' }).id;
  const corruptGraph = path.join(tmpRoot, 'notebooks', corruptId, 'learning-graph.json');
  const brokenBytes = Buffer.from('{ 这 是 半 截 JSON ← 原样取证');
  fs.writeFileSync(corruptGraph, brokenBytes);
  const corruptRel = `${corruptId}/learning-graph.json`;
  check('损坏文件进了体检报告', store.healthCheck().corruptFiles.includes(corruptRel), store.healthCheck().corruptFiles.join(','));
  const got = store.readCorruptFile(corruptRel);
  check('取证下载返回原件字节（不重写）', got.buffer.equals(brokenBytes), got.buffer.toString('utf8'));
  let rejected = null;
  try { store.readCorruptFile(`${corruptId}/notebook.json`); } catch (err) { rejected = err; }
  check('没损坏的文件不在取证白名单（拒绝，不是任意读取口）', rejected?.reason === 'not-in-report', rejected?.message);
  let traversed = null;
  try { store.readCorruptFile('../../credentials.json'); } catch (err) { traversed = err; }
  check('路径越界/不在报告一律拒绝（防任意文件读取）', traversed?.reason === 'not-in-report', traversed?.message);
  // 超大损坏文件：取证先拒绝，让人直接翻 data/ 目录（不把大块内存拖进下载）
  const corruptChat = path.join(tmpRoot, 'notebooks', corruptId, 'chat.json');
  fs.writeFileSync(corruptChat, 'x'.repeat(6 * 1024 * 1024));
  let tooBig = null;
  try { store.readCorruptFile(`${corruptId}/chat.json`); } catch (err) { tooBig = err; }
  check('超过 5MB 的损坏文件取证被拒绝（说明直接翻目录）', tooBig?.reason === 'too-large', tooBig?.message);

  // 12j-2b 数据根目录的存证（第十八轮）：settings.json 坏过之后，过去体检根本不扫这一层
  // （HEALTH_FILES 只遍历 notebooks/），证据副本躺在 data/ 根上没人认领。台账把它捞回来，
  // 并且**哪怕原件已经治好了**也还能取证——这正是旧取证口做不到的那一段。
  {
    const settingsFile = path.join(tmpRoot, 'settings.json');
    const settingsBackup = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;
    const badSettings = '{ "activeModel": 半截设置 ← 根目录取证';
    fs.writeFileSync(settingsFile, badSettings);
    const { readJsonSafe: configRead } = await import('../server/config.mjs');
    check('根目录 settings.json 读坏时降级不抛（留证据由 config 的统一读取口负责）',
      JSON.stringify(configRead(settingsFile, {})) === '{}');
    let rootRep = store.healthCheck();
    const rootRel = () => (rootRep.corruptEvidence || []).find((e) => e.rel.startsWith('settings.json.corrupt-'))?.rel;
    check('坏着的 settings 副本进了证据台账（体检扫得到 data/ 根了）',
      Boolean(rootRel()), JSON.stringify(rootRep.corruptEvidence || []));
    check('原件还坏着时台账如实标 sourceCorrupt=true',
      rootRep.corruptEvidence && rootRep.corruptEvidence.find((e) => e.rel === rootRel())?.sourceCorrupt === true, rootRel());
    // 治它：写回一份合法设置（模拟下一次正常保存）
    fs.writeFileSync(settingsFile, JSON.stringify({ activeModel: { provider: 'faux', model: '钉' }, version: 1 }, null, 2));
    rootRep = store.healthCheck();
    const healedRel = rootRel();
    check('settings 治好之后根目录副本仍在案（台账不看当下坏不坏）', Boolean(healedRel), healedRel);
    check('治好后台账改口 sourceCorrupt=false',
      rootRep.corruptEvidence && rootRep.corruptEvidence.find((e) => e.rel === healedRel)?.sourceCorrupt === false, healedRel);
    let healedGot = null, healedErr = null;
    try { healedGot = store.readCorruptFile(healedRel); } catch (err) { healedErr = err; }
    check('治好了的 settings 副本照样能取证（字节原样）',
      !healedErr && healedGot.buffer.toString('utf8') === badSettings,
      healedErr ? `抛了 ${healedErr.reason || healedErr.message}` : healedGot.buffer.toString('utf8').slice(0, 40));
    // 台账不是后门：data/ 根上没登记的凭据文件，即使名字撞形状也不认领
    const creds = path.join(tmpRoot, 'credentials.json');
    const credsBackup = fs.existsSync(creds) ? fs.readFileSync(creds, 'utf8') : null;
    fs.writeFileSync(creds, 'sk-别把凭据经这条路漏出去');
    let shapeSneak = null;
    try { shapeSneak = store.readCorruptFile('credentials.json'); } catch (err) { shapeSneak = err; }
    check('台账不认领没登记的原件（好的/坏的凭据原件都不在口上）', shapeSneak?.reason === 'not-in-report', String(shapeSneak?.reason));
    fs.writeFileSync(creds, 'x'.repeat(9) + '\n'); // 非法 JSON，但证据副本名要撞台账形状
    const { readJsonSafe: peekRead } = await import('../server/config.mjs');
    peekRead(creds, {}); // 让它自己留一份 credentials.json.corrupt-<ms>
    rootRep = store.healthCheck();
    check('credentials 的证据也被台账认领（登记过的文件名才认）',
      rootRep.corruptEvidence && rootRep.corruptEvidence.some((e) => e.rel.startsWith('credentials.json.corrupt-')),
      (rootRep.corruptEvidence || []).map((e) => e.rel).join(','));
    // 收尾：把这两个根文件恢复成探针前的样子，别拖累后面的套件
    if (settingsBackup === null) fs.rmSync(settingsFile, { force: true }); else fs.writeFileSync(settingsFile, settingsBackup);
    if (credsBackup === null) fs.rmSync(creds, { force: true }); else fs.writeFileSync(creds, credsBackup);
    // 探针留下的根副本也扫掉：后面的套件不该被一次测试探针的痕迹扰动
    for (const f of fs.readdirSync(tmpRoot)) {
      if (/^(settings|credentials)\.json\.corrupt-/.test(f)) fs.rmSync(path.join(tmpRoot, f), { force: true });
    }
    const after = store.healthCheck();
    check('探针撤干净后根目录台账归零（测试不给自己留赃）',
      !(after.corruptEvidence || []).some((e) => e.rel === 'settings.json.corrupt-x' || /^(settings|credentials)\.json\.corrupt-/.test(e.rel)),
      (after.corruptEvidence || []).map((e) => e.rel).join(','));
  }

  // 12j-3 回马枪候选可见：同一份候选（prompt 快照与前端续学卡）从数据层出。
  const retestId = store.createNotebook({ topic: '回马枪', goal: null, pace: 'normal' }).id;
  const progress = {
    version: 1, session_open: true, concepts: {},
    artifact_evidence: [
      { question_id: 'q-a', concept_id: 'closures', result: 'incorrect', attempts: 2, response: '答错了' },
      { question_id: 'q-a', concept_id: 'closures', result: 'incorrect', attempts: 3, response: '又答错了' },
      { question_id: 'q-b', concept_id: 'scope', result: 'correct', attempts: 1, response: '答对了' },
    ],
  };
  fs.writeFileSync(path.join(tmpRoot, 'notebooks', retestId, 'progress.json'), JSON.stringify(progress));
  const retests = store.getNotebook(retestId).retests;
  check('getNotebook 带回马枪候选（前端续学卡的数据源）',
    retests.length === 1 && retests[0].qid === 'q-a' && retests[0].concept === 'closures' && retests[0].attempts === 3,
    JSON.stringify(retests));
  check('最后一次判对的题不进候选（只留"最后仍判错、之后没判对"）',
    !retests.some((r) => r.qid === 'q-b'), JSON.stringify(retests));
  check('无判错证据时候选为空', store.getNotebook(store.createNotebook({ topic: '干净本', goal: null, pace: 'normal' }).id).retests.length === 0);
}

// ─────────────────────────────────────── 12k. 跨本搜索（找得到：哪本学习里说过 X）
{
  const nbA = store.createNotebook({ topic: 'JavaScript 闭包', goal: '在项目里用对闭包', pace: 'normal' }).id;
  const nbB = store.createNotebook({ topic: 'Git 版本控制', goal: null, pace: 'normal' }).id;
  const t0 = Date.now() - 60_000;
  store.appendChat(nbA, [
    { role: 'user', content: '我想弄明白闭包', timestamp: t0, attachments: [] },
    { role: 'assistant', content: '循环里共享同一个变量，是闭包最常见的坑。', timestamp: t0 + 1000, attachments: [] },
    { role: 'user', content: '那怎么避免循环里的坑？', timestamp: t0 + 2000, attachments: [] },
  ]);
  store.appendChat(nbB, [
    { role: 'user', content: 'rebase 和 merge 有什么区别', timestamp: t0 + 3000, attachments: [] },
  ]);
  const notesFileA = path.join(tmpRoot, 'notebooks', nbA, 'notes.json');
  const notesFileB = path.join(tmpRoot, 'notebooks', nbB, 'notes.json');
  fs.mkdirSync(path.dirname(notesFileA), { recursive: true });
  fs.writeFileSync(notesFileA, JSON.stringify({ version: 1, notes: [{ id: 'n1', at: new Date(t0 + 4000).toISOString(), text: '闭包演示：计数器工厂，注意内存泄漏' }] }));
  fs.writeFileSync(notesFileB, JSON.stringify({ version: 1, notes: [{ id: 'n1', at: new Date(t0 + 4000).toISOString(), text: 'rebase 会重写历史' }] }));
  const manifest = path.join(tmpRoot, 'notebooks', nbA, 'artifacts', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, items: [{ id: 'art-1', title: '闭包演示卡片', kind: 'artifact', rel: 'artifacts/art-1/index.html', createdAt: new Date().toISOString() }] }));

  check('12k-1 空词不给结果', store.searchAllNotebooks('  ').length === 0);
  check('12k-2 无命中回空数组', store.searchAllNotebooks('量子计算').length === 0);
  const chatHit = store.searchAllNotebooks('循环');
  check('12k-3 对话命中带本/种类/摘要（找得到在哪个本、哪一段）',
    chatHit.some((h) => h.kind === 'chat' && h.notebookId === nbA && h.snippet.includes('循环') && h.notebookTitle.includes('闭包')),
    JSON.stringify(chatHit.slice(0, 3)));
  const noteHit = store.searchAllNotebooks('泄漏');
  check('12k-4 笔记命中', noteHit.some((h) => h.kind === 'note' && h.notebookId === nbA && h.snippet.includes('泄漏')));
  const titleHit = store.searchAllNotebooks('javascript');
  check('12k-5 标题命中且大小写不敏感', titleHit.some((h) => h.kind === 'notebook' && h.notebookId === nbA));
  const artHit = store.searchAllNotebooks('演示卡片');
  check('12k-6 制品标题命中', artHit.some((h) => h.kind === 'artifact' && h.notebookId === nbA && h.snippet.includes('演示卡片')));
  // perNotebook 上限：一页对话全是同一个词，不该把整个列表占满
  store.appendChat(nbA, Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: `还是循环问题第 ${i} 条`, timestamp: t0 + 10_000 + i, attachments: [] })));
  const flood = store.searchAllNotebooks('循环问题');
  const perNb = flood.filter((h) => h.notebookId === nbA).length;
  check('12k-7 每本最多 perNotebook 条（一个词占满一页也压得住）', perNb <= 5, `nbA 命中 ${perNb} 条`);
  const capped = store.searchAllNotebooks('循环问题', { cap: 2 });
  check('12k-8 总量 cap 生效', capped.length <= 2, `cap=2 实际 ${capped.length}`);
  check('12k-9 命中都带本标题（前端结果行可以直接显示是哪本）',
    chatHit.every((h) => h.notebookId && h.notebookTitle), JSON.stringify(chatHit.slice(0, 2)));
}

// ─────────────────────────────────────── 12l. 制品打包（zip）：全部作品一个包带走
{
  // 迷你 zip 读取器：只走中央目录 + 本地头，够验"条目全、CRC 对、字节可解"
  function readZip(buf) {
    let off = buf.length - 22;
    while (off >= 0 && buf.readUInt32LE(off) !== 0x06054b50) off -= 1;
    if (off < 0) throw new Error('no EOCD');
    const count = buf.readUInt16LE(off + 10);
    const cdOff = buf.readUInt32LE(off + 16);
    const entries = [];
    let p = cdOff;
    for (let i = 0; i < count; i += 1) {
      if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad CD signature');
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const localOff = buf.readUInt32LE(p + 42);
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
      const lnameLen = buf.readUInt16LE(localOff + 26);
      const lextraLen = buf.readUInt16LE(localOff + 28);
      const crc = buf.readUInt32LE(localOff + 14);
      const size = buf.readUInt32LE(localOff + 18);
      const start = localOff + 30 + lnameLen + lextraLen;
      entries.push({ name, data: Buffer.from(buf.subarray(start, start + size)), crc });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }
  const zipId = store.createNotebook({ topic: '打包探针', goal: null, pace: 'normal' }).id;
  const artDir = path.join(tmpRoot, 'notebooks', zipId, 'artifacts');
  fs.mkdirSync(path.join(artDir, 'art-1', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(artDir, 'art-2'), { recursive: true });
  fs.writeFileSync(path.join(artDir, 'art-1', 'index.html'), '<html>制品一</html>');
  fs.writeFileSync(path.join(artDir, 'art-1', 'assets', 'x.js'), 'const a=1;');
  fs.writeFileSync(path.join(artDir, 'art-2', 'index.html'), '<html>已收起的二</html>');
  fs.writeFileSync(path.join(artDir, 'manifest.json'), JSON.stringify({
    version: 1,
    items: [
      { id: 'art-1', title: '制品一', kind: 'artifact', rel: 'artifacts/art-1/index.html', createdAt: new Date().toISOString() },
      { id: 'art-2', title: '制品二', kind: 'artifact', rel: 'artifacts/art-2/index.html', createdAt: new Date().toISOString(), retiredAt: '2026-10-01T00:00:00.000Z' },
      { id: 'art-ghost', title: '文件夹丢了', kind: 'artifact', rel: 'artifacts/art-ghost/index.html', createdAt: new Date().toISOString() },
    ],
  }));
  const zip1 = store.exportNotebookArtifactsZip(zipId);
  const zip2 = store.exportNotebookArtifactsZip(zipId);
  check('12l-1 zip 以 PK 本地头开头（真 zip，不是文本）', zip1[0] === 0x50 && zip1[1] === 0x4b && zip1[2] === 0x03 && zip1[3] === 0x04, zip1.slice(0, 4).toString('hex'));
  check('12l-2 同一本两次打包字节一致（确定性输出）', zip1.equals(zip2));
  const zipEntries = readZip(zip1);
  const names = zipEntries.map((e) => e.name);
  check('12l-3 制品 index.html 和它的素材都进包', names.includes('socratic-artifacts/art-1/index.html') && names.includes('socratic-artifacts/art-1/assets/x.js'), names.join(' | '));
  check('12l-4 已收起的制品也在包里（软退役=文件还在，打包不丢）', names.includes('socratic-artifacts/art-2/index.html'), names.join(' | '));
  check('12l-5 manifest 有记录但文件夹丢了的不假装有（art-ghost 不进包）', !names.includes('socratic-artifacts/art-ghost/index.html'), names.join(' | '));
  check('12l-6 根上有 README.txt（说明这是什么包、谁收起来过）',
    names.includes('socratic-artifacts/README.txt') && zipEntries.find((e) => e.name.endsWith('README.txt')).data.toString('utf8').includes('制品二'),
    names.join(' | '));
  check('12l-7 每个条目的 CRC32 与数据对得上（字节没写歪）',
    zipEntries.every((e) => e.crc === crc32(e.data)), zipEntries.map((e) => `${e.name}:${e.crc.toString(16)}`).join(' '));
}

// ─────────────────────────────────────── 收尾

console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
fs.rmSync(tmpRoot, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
