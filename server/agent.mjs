// 教学 Agent：agentic 循环 + 工具 + 事件流。
//
// 设计要点：
//   - 教学只发生在对话里。这个模块把「对话」做成真正的读-写-阻塞-回传回路：
//     agent 调 ask_user_question → 服务端 emit 事件到前端 → 阻塞本回合 →
//     学习者的作答 resolve → 作为 toolResult 回到模型。这就是即时反馈回路。
//   - 渲染根因：text 是流式文本，artifact 是制品。制品只给现象，不判对错。

import { validateToolCall, Type } from '@earendil-works/pi-ai';
import { topoSortConcepts, GraphValidationError, validateGraph } from './graph.mjs';
import { appendPatch, applyPatchToGraph, patchError, stateWord, saveSceneState, appendDecisionJournal } from './store.mjs';
import { MAX_DIALOGUE_MESSAGES } from './config.mjs';
import { saveNote } from './notes.mjs';
import { jevDecide, DecisionError } from './decision.mjs';
import {
  PHASE_LABELS,
  normaliseSceneState,
  openScene,
  setPhase,
  placeProp,
  removeProp,
} from './scene.mjs';
import { injectArtifactRuntime, injectArtifactCsp, ARTIFACT_CONTRACT_NOTE } from './artifact.mjs';

/**
 * 从制品 HTML 里抽出题目坐标，供证据读回时对账。
 * 只做正则扫描——它不解析 DOM，也不需要精确：用途是"这个制品声明了哪些题"。
 * 导出是为了可测：这条抽取是证据链的第一环，抽不到就等于制品白写了。
 */
export function extractQuestionIds(html) {
  const ids = new Set();
  const re = /data-question-id\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(String(html ?? '')))) ids.add(m[1]);
  return [...ids];
}

/**
 * 把上一轮落盘的制品回报种子进会话的 liveArtifacts。
 * 按 artifactId 分组：同一件制品的 state 合并、events/evidence 按原顺序回填。
 */
export function seedArtifacts(session, progress) {
  if (!progress) return;
  const ensure = (artifactId) => {
    let bucket = session.liveArtifacts.get(artifactId);
    if (!bucket) {
      bucket = {
        id: artifactId,
        title: null,
        kind: null,
        questions: [],
        evidence: [],
        state: {},
        events: [],
        createdAt: null,
      };
      session.liveArtifacts.set(artifactId, bucket);
    }
    return bucket;
  };
  for (const e of progress.artifact_evidence || []) {
    ensure(e.artifact_id || 'unknown').evidence.push({ ...e });
  }
  for (const e of progress.artifact_events || []) {
    ensure(e.artifact_id || 'unknown').events.push({ ...e });
  }
  for (const [artifactId, state] of Object.entries(progress.artifact_state || {})) {
    ensure(artifactId).state = { ...state };
  }
}

/** 读回证据时给模型的一句口径提醒。 */
function evidenceNote(items) {  const total = items.reduce((n, a) => n + a.evidence.length, 0);
  if (!total) {
    return (
      '没有观测到任何操作。这不等于学习者没看、更不等于他没做——只是没读到可记录的动作，' +
      '不要据此推断，也不要拿"没记录"当作判定依据。'
    );
  }
  const wrong = items.some((a) => a.evidence.some((e) => e.result === 'incorrect'));
  return (
    '这些是机械记录的 DOM 快照，不是第二套 Progress State，也不是结论。判对错、归类错误、决定下一步都由你做：' +
    '先校验题目是否属于当前 concept、去掉过期重复的操作，再走 EVALUATE / UPDATE MASTERY。' +
    '反过来也一样——观测到的只是动作，不等于其语境的真实发生，别把没有读到的部分补全成"他一定做了什么"。' +
    (wrong ? '其中出现过明确答错，注意区分是概念错误还是操作失误。' : '')
  );
}

// ---------------------------------------------------------------- 工具定义

const ASK_OPTION = Type.Object({
  label: Type.String({ description: '选项上显示的短标签' }),
  description: Type.Optional(Type.String({ description: '一句话说明这个选项的含义或影响' })),
});

/**
 * 选项两种写法都收：`{"label":"能读到"}` 或直接 `"能读到"`。
 * 只认对象的话，模型每次裸写字符串就会被 pi-ai 的参数校验打回
 * （`options.0 must be object`），表现是"每道 ask 都要先红一次才成功"——
 * 白烧一个来回，还在会话里留一张红卡。校验发生在 execTool 之前，所以宽在 schema 里，
 * 归一在下面 `normalizeAskOptions()`，往下游（前端 / chat.json）出去的永远是 `{label}`。
 */
const ASK_OPTION_INPUT = Type.Union([
  Type.String({ description: '选项标签，等价于 {"label": "…"}' }),
  ASK_OPTION,
]);

/** 把模型给的选项归一成 `{label, description}`；空标签的那条直接丢。 */
export function normalizeAskOptions(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((o) => (typeof o === 'string'
      ? { label: o.trim(), description: undefined }
      : { label: String(o?.label ?? '').trim(), description: o?.description }))
    .filter((o) => o.label);
}

/**
 * 模型偶尔把整份清单塞成一个 JSON 字符串再发出来（活数据里那次「整理概念结构」：十来个概念
 * 挤在一串四千字里的字符串 → `concepts.0: must be object`）。这是序列化习惯，不是教学错误，
 * 也不是缺字段——校验层只看得见"形状不对"，模型收到那句英文还会以为要补字段。替它拆开，
 * 让该走的路走通；拆不动的原样交给校验层报错。
 */
export function unwrapStructuredArgs(name, rawArgs) {
  const keys = STRUCTURED_ARGS[name];
  if (!keys || !rawArgs || typeof rawArgs !== 'object') return rawArgs;
  let out = rawArgs;
  for (const key of keys) {
    const v = rawArgs[key];
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (!t.startsWith('[') && !t.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed !== 'string') {
        if (out === rawArgs) out = { ...rawArgs };
        out[key] = parsed;
      }
    } catch {
      // 不是合法 JSON（比如单引号那种），原样留着，让校验层说实话
    }
  }
  return out;
}

const ASK_QUESTION = Type.Object({
  id: Type.Optional(Type.String({
    description:
      '可选的稳定 id，把教学坐标编进来，例如 "closures:q_var_capture"。不填应用自己补一个。',
  })),
  concept_id: Type.String({
    description:
      '这道题在探哪个概念，填 Learning Graph 里的 concept id。不属于任何概念的事务性提问（门禁确认、"先讲哪个"）填 "none"。',
  }),
  header: Type.Optional(Type.String({ description: '短标题，如「确认」「探针」「判据」' })),
  question: Type.String({ description: '要问学习者的问题本身' }),
  options: Type.Optional(
    Type.Array(ASK_OPTION_INPUT, {
      description: '可枚举时给选项；每项写成 {"label": "…", "description": "…"}，也可以直接给一个字符串标签。开放式提问就不要给',
    }),
  ),
  multi_select: Type.Optional(Type.Boolean({ description: 'true 表示可多选。默认 false' })),
  allow_text: Type.Optional(Type.Boolean({ description: 'true 表示另附一个自由文本输入框。默认 true' })),
});

const PROGRESS_UPDATE = Type.Object({
  concept_id: Type.String({ description: 'Learning Graph 里的 concept id' }),
  state: Type.String({
    description: 'unknown | seen | understood | applied | mastered（小写）',
  }),
  next_action: Type.Optional(Type.String({ description: '下一轮打算做什么，例如「接地→探针」' })),
  note: Type.Optional(Type.String({ description: '一句自然语言的观察记录' })),
  evidence: Type.Optional(
    Type.String({
      description: '这次推进所依据的 observed 证据（学习者实际说了/做了什么）',
    }),
  ),
  unverified_self_report: Type.Optional(
    Type.Boolean({ description: 'true 表示该状态来自学习者自报、尚无 observed 证据背书' }),
  ),
});

const PATCH_OP = Type.Object({
  operation: Type.String({
    description:
      'ADD | REMOVE | MODIFY | SPLIT。给 misconceptions / examples / counterexamples / observable_skills / confused_with / assessment_items 这类字段写内容就用 ADD（MODIFY 也按追加合并）；改 explanation / importance 用 MODIFY；确认某条误解不成立才用 REMOVE；概念要拆开才用 SPLIT。',
  }),
  target: Type.String({ description: 'concepts.<concept_id>.<field>' }),
  value: Type.Optional(
    Type.String({
      description:
        '新内容。只有一条就直接写那条文字；多条写成 JSON 数组字符串 ["第一项","第二项"]（不要 Python 式单引号，也不要给单条加方括号）。',
    }),
  ),
  reason: Type.String({ description: '触发原因' }),
  confidence: Type.Optional(Type.String({ description: 'high | medium | low，默认 medium' })),
});

export const TOOL_NAMES = {
  ASK: 'ask_user_question',
  SAVE_GRAPH: 'update_learning_graph',
  SET_PROGRESS: 'set_progress_state',
  SHARE_ARTIFACT: 'share_artifact',
  GET_GRAPH: 'get_learning_graph',
  PROPOSE_PATCH: 'propose_graph_patch',
  RECORD_EVENT: 'record_learning_event',
  READ_ARTIFACT: 'read_artifact_evidence',
  PUSH_ARTIFACT: 'push_artifact_command',
  PRESENT_PLAN: 'present_plan',
  UPDATE_TODO: 'update_todo_list',
  SPAWN_SUBAGENT: 'spawn_subagent',
  RUN_BACKGROUND: 'run_background_task',
  READ_BACKGROUND: 'read_background_task',
  LIST_BACKGROUND: 'list_background_tasks',
  STOP_BACKGROUND: 'stop_background_task',
  PREPARE_ARTIFACT: 'prepare_artifact',
  COMPILE_NOTES: 'compile_notes',
  RUN_SCENE: 'run_scene',
  JEV_JUDGE: 'jev_judge',
};

// 待办状态机：待办 → 进行中 → 已完成。模型只给自己排步骤，不涉及学习状态。
const TODO_STATUS = ['pending', 'in_progress', 'completed'];

/**
 * 哪些参数本该是数组。只点名，不做通用尝试解析——正文类字段（plan / html / reason /
 * instructions）合法地可能以 `[` 或 `{` 开头，动它们就是把内容改了。
 */
const STRUCTURED_ARGS = {
  [TOOL_NAMES.SAVE_GRAPH]: ['concepts'],
  [TOOL_NAMES.SET_PROGRESS]: ['updates'],
  [TOOL_NAMES.UPDATE_TODO]: ['todos'],
  [TOOL_NAMES.ASK]: ['options'],
};

/** 把模型给的 todos 规整成 [{id, content, status}]，丢掉空项与非法状态。 */
function normaliseTodos(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const content = String(raw.content ?? raw.text ?? '').trim().slice(0, 200);
    if (!content) continue;
    let status = String(raw.status ?? 'pending').toLowerCase();
    if (!TODO_STATUS.includes(status)) status = 'pending';
    let id = String(raw.id ?? content).trim().slice(0, 80);
    while (seen.has(id)) id = `${id}-x`;
    seen.add(id);
    out.push({ id, content, status });
  }
  return out.slice(0, 30);
}

// 整张图重存时可能被漏写的字段。`update_learning_graph` 是"替换整张"，可模型手写到
// 第七个概念就会把 summary / name 这类字段省掉——以前这既过不了参数校验（白烧一个来回、
// 页面上多一张红卡），也过不了 Graph 校验。同一 id 没写的字段沿用上一版：那是它自己
// 以前写下的内容，不是应用替它编的。要清空就把字段显式写成 []，空数组算意图明确。
const CONCEPT_CARRY_FIELDS = [
  'name',
  'summary',
  'explanation',
  'importance',
  'depends_on',
  'misconceptions',
  'confused_with',
  'examples',
  'counterexamples',
  'observable_skills',
  'assessment_items',
];

/** 用上一版 Graph 补齐这次没写的字段；只在"没写"时补，写了的一律以这次为准。 */
export function carryOverConcept(prevGraph, concept) {
  if (!concept || typeof concept !== 'object' || Array.isArray(concept)) return concept;
  const prev = (prevGraph?.concepts || []).find((c) => c?.id === concept.id);
  const out = { ...concept };
  for (const key of CONCEPT_CARRY_FIELDS) {
    const given = out[key];
    const empty = given === undefined || given === null || given === '' ||
      (typeof given === 'string' && !given.trim());
    if (!empty) continue;
    if (prev?.[key] !== undefined && prev?.[key] !== null && prev?.[key] !== '') out[key] = prev[key];
    else delete out[key]; // 别把 null/'' 留给校验器：它按"若存在必须是…"判，删掉才是"没写"
  }
  if (!out.summary && typeof out.explanation === 'string' && out.explanation.trim()) {
    out.summary = out.explanation.split(/[\n。；;]/).find((s) => s.trim()).trim().slice(0, 120);
  }
  return out;
}

export function buildTools() {
  return [
    {
      name: TOOL_NAMES.ASK,
      description:
        '向学习者提一个需要他回答的问题，并等待他作答。答案可枚举的提问（探针/预测/练习/门禁确认）用它收答，不要在正文里写 A/B/C。开放式提问（要他说出推理过程）给 question、不给 options。表达不了的结构（排序、分桶、拖拽建构）不要硬塞成选项——退回让他用自己的话产出。你会阻塞到学习者作答为止。',
      parameters: ASK_QUESTION,
    },
    {
      name: TOOL_NAMES.SAVE_GRAPH,
      description:
        '保存/替换这个学习主题的 Learning Graph（概念结构）。DECOMPOSE 之后调用。只会存知识结构：概念、依赖、误解、examples、observable_skills 等；绝不写 state、分数或任何复习排程字段。',
      parameters: Type.Object({
        topic: Type.String({ description: '主题名称' }),
        goal: Type.Optional(Type.String({ description: '学习者来时的目标' })),
        pedagogy: Type.String({
          description:
            '教学策略标签：general | programming | math | science | humanities | arts | language | business | law | medicine',
        }),
        concepts: Type.Array(
          Type.Object({
            id: Type.String({ description: '英文小写+连字符的唯一 id' }),
            name: Type.Optional(Type.String({ description: '人类可读名称。同一 id 重存时不写就沿用上一版' })),
            summary: Type.Optional(
              Type.String({
                description: '一句话定义。不写就沿用上一版；没有上一版就从 explanation 首句取',
              }),
            ),
            explanation: Type.Optional(Type.String({ description: '主要讲解内容' })),
            depends_on: Type.Optional(Type.Array(Type.String())),
            misconceptions: Type.Optional(Type.Array(Type.String())),
            confused_with: Type.Optional(Type.Array(Type.String())),
            examples: Type.Optional(Type.Array(Type.String())),
            counterexamples: Type.Optional(Type.Array(Type.String())),
            importance: Type.Optional(Type.String({ description: 'core | supporting | optional' })),
            observable_skills: Type.Optional(Type.Array(Type.String())),
            assessment_items: Type.Optional(
              Type.Array(
                Type.Object({
                  type: Type.String({ description: 'recall | apply | transfer' }),
                  prompt: Type.String({ description: '题面' }),
                }),
              ),
            ),
          }),
        ),
      }),
    },
    {
      name: TOOL_NAMES.SET_PROGRESS,
      description:
        '更新学习状态。只有它有权推进状态。规则：每次只升一级；升级必须由 observed 证据支撑（学习者真实作答/操作/产物），学习者自评不算；自报未验证的 concept 出现单次概念错误即降一级。写 note 记观察，不写分数、百分比或任何数值化的学习量。',
      parameters: Type.Object({
        updates: Type.Array(PROGRESS_UPDATE),
        events: Type.Optional(
          Type.Array(
            Type.Object({
              concept_id: Type.String(),
              kind: Type.String({ description: 'observed | inferred' }),
              summary: Type.String({ description: '一句话记录真实发生了什么' }),
            }),
          ),
        ),
        session_note: Type.Optional(Type.String({ description: '本轮 session 的自由备注' })),
      }),
    },
    {
      name: TOOL_NAMES.SHARE_ARTIFACT,
      description:
        '把一份 HTML 制品内联渲染到当前这一轮（讲解页 / 交互物件 / 模拟器 / 实战项目 / 游戏）。制品只给现象，不解释原因、不判对错、不藏答案键——判对错和解释留在对话里。交互运行时由宿主自动注入，不要自己写 script 标签引用它。**两条回报通道**：① 答卷型交互用 data-interaction / data-choice-id / data-concept-id / data-question-id 标注；② 项目、游戏、模拟器用 window.SocraticStudio.report(state) 与 .emit(name, payload) 上报状态与事件。两种都会被收集，下一轮用 read_artifact_evidence 读回。跨轮续玩用 initial_state 传回上轮状态。**还有一种形状是"一个孔"**：交一个能跑但缺一个函数体的小工具，让学习者把那段代码写出来——页面只给现象（期望值 vs 实际值），答案不许在同一回合的正文里出现。' +
        '（这一手的规格在制品契约提示里，随本工具结果一起给。）',
      parameters: Type.Object({
        title: Type.String({ description: '制品标题' }),
        description: Type.Optional(Type.String({ description: '一句话说明这份制品用来呈现什么' })),
        html: Type.String({
          description:
            '完整的单文件 HTML（含内联 <style> 与 <script>）。**不引 CDN**（沙箱里取不到，公式用原生 MathML），不 fetch 外部文件。canvas / WebGL / 任意 JS 都可以用。答完必须有明确的「下一步」入口。',
        }),
        kind: Type.Optional(
          Type.String({ description: 'illustration | interactive | diagram | page | game，默认 illustration' }),
        ),
        initial_state: Type.Optional(
          Type.Object({}, { additionalProperties: true }),
          { description: '跨轮续玩的初始状态；制品内 window.SocraticStudio.getState() 读它' },
        ),
      }),
    },
    {
      name: TOOL_NAMES.READ_ARTIFACT,
      description:
        '读回学习者在制品里做了什么。**这是页面型制品唯一的证据通道**——没有它就不能说学习者"在制品里试过了"。返回三类内容：① 答卷型交互的 evidence（作答次数/结果/作答内容/完成状态）；② 项目或游戏的 state 快照（关卡、尝试次数、当前参数这类客观事实）；③ 离散 events（level_cleared / bug_found 等）。这些只是机械记录不是结论：题目是否属于当前 concept、有没有过期重复、算不算概念错误、下一步怎么走，都由你判断。**反过来也成立——没有记录不等于学习者没做。**',
      parameters: Type.Object({
        artifact_id: Type.Optional(
          Type.String({ description: '只看某一份制品；省略则返回这一轮所有制品的回报' }),
        ),
      }),
    },
    {
      name: TOOL_NAMES.PUSH_ARTIFACT,
      description:
        '给一个还开着的制品下行一条指令，让它当场改变——切换关卡、注入一个 bug、改参数、显示提示。制品用 window.SocraticStudio.onCommand((name, payload) => …) 订阅。学习者关掉页面后指令作废，那时就退回对话讲，不要装作他已经收到。',
      parameters: Type.Object({
        artifact_id: Type.Optional(Type.String({ description: '制品 id；省略则发给当前所有开着的制品' })),
        name: Type.String({ description: '指令名，与制品里 onCommand 收到的一致' }),
        payload: Type.Optional(
          Type.Object({}, { additionalProperties: true }),
          { description: '指令携带的数据，形状由这一份制品自己定义' },
        ),
      }),
    },
    {
      name: TOOL_NAMES.GET_GRAPH,
      description:
        '读取当前 Learning Graph 与学习状态快照。续学、写讲解或制品、判断下一步之前调用，确认概念范围、误解与当前 state。',
      parameters: Type.Object({
        include: Type.Optional(
          Type.String({ description: 'graph | progress | patch_log | all，默认 all' }),
        ),
      }),
    },
    {
      name: TOOL_NAMES.PROPOSE_PATCH,
      description:
        '把教学里发现的 Graph 反馈记下来（GRAPH FEEDBACK），触发条件见 runtime.md §2.10。应用会先对当前 Graph 空跑一遍，合不上的直接退回给你错误、不留待确认卡。confidence=high 当场合并；medium/low 落成右栏「待你确认的结构改动」，学习者点「接受」才写入。',
      parameters: Type.Object({ patch: PATCH_OP }),
    },
    {
      name: TOOL_NAMES.RECORD_EVENT,
      description:
        '记一条本轮的学习事件，供审计与解释。kind=observed 记真实发生的事（作答/操作/产物），kind=inferred 记你的推测（如「这种讲法对这位学习者无效」）。inferred 永不用于推进状态。',
      parameters: Type.Object({
        concept_id: Type.String(),
        kind: Type.String({ description: 'observed | inferred' }),
        summary: Type.String({ description: '一句话' }),
      }),
    },
    {
      name: TOOL_NAMES.PRESENT_PLAN,
      description:
        '把本回合打算做的事讲给学习者听，并等他批准或提意见。**你会阻塞到他回应为止。** 用在动手之前：DECOMPOSE 之后、要连续做多步讲解或练习之前、要改变既定路线之前。他批准你再继续，他提意见就把意见并进下一步。plan 是写给学习者看的自然语言（Markdown），不要写内部字段名。',
      parameters: Type.Object({
        plan: Type.String({ description: '本回合打算做什么，写给学习者看的 Markdown' }),
      }),
    },
    {
      name: TOOL_NAMES.UPDATE_TODO,
      description:
        '更新本回合的待办清单（右侧「讲解顺序」那一节顶部会实时显示这条进度条）。一个回合通常不止一步——建 Graph、出探针、讲解、练习、复盘——用它让学习者看见你现在到哪儿了。status: pending | in_progress | completed。每次调用整体替换，不是局部追加。',
      parameters: Type.Object({
        todos: Type.Array(
          Type.Object({
            id: Type.String({ description: '稳定 id，同一项保持不变' }),
            content: Type.String({ description: '一句话说清这一步要做什么' }),
            status: Type.String({ description: 'pending | in_progress | completed' }),
          }),
        ),
      }),
    },
    {
      name: TOOL_NAMES.SPAWN_SUBAGENT,
      description:
        '派一个分身去单独做一件事，**你阻塞到它做完**，然后把它的结论交回给你。适合查证、起草、试算这类一次性的活。分身碰不到学习状态、也不会向学习者提问。',
      parameters: Type.Object({
        title: Type.Optional(Type.String({ description: '这件事叫什么，显示在任务面板上' })),
        instructions: Type.String({ description: '要分身做的事，写清楚要它交出什么' }),
      }),
    },
    {
      name: TOOL_NAMES.RUN_BACKGROUND,
      description:
        '把一件耗时的事挂到后台，**立刻返回不等待**，你可以继续本回合。之后用 read_background_task / list_background_tasks 收结果，用 stop_background_task 停掉。适合整理长篇素材、预生成题目这类学习者不必现场等的事。',
      parameters: Type.Object({
        title: Type.Optional(Type.String({ description: '这个任务叫什么，显示在任务面板上' })),
        instructions: Type.String({ description: '要后台做什么，写清楚要它交出什么' }),
      }),
    },
    {
      name: TOOL_NAMES.READ_BACKGROUND,
      description: '读一个后台任务的结果。还在跑就告诉你还在跑，不要反复刷。',
      parameters: Type.Object({
        task_id: Type.String({ description: 'run_background_task 返回的 id' }),
      }),
    },
    {
      name: TOOL_NAMES.LIST_BACKGROUND,
      description: '列出这个学习下的所有后台任务与分身，看各自状态。',
      parameters: Type.Object({}),
    },
    {
      name: TOOL_NAMES.STOP_BACKGROUND,
      description: '停掉一个还在跑的后台任务。',
      parameters: Type.Object({
        task_id: Type.String({ description: '要停掉的任务 id' }),
      }),
    },
    {
      name: TOOL_NAMES.PREPARE_ARTIFACT,
      description:
        '想要一个**大件**制品（实战项目、关卡游戏、可探索模拟器）但不想让这一轮被生成 HTML 卡住时，用它：**立刻返回**，分身去后台把它做出来，做好由宿主摆进学习者当前这一场的台上。**你不需要写 HTML，只需要把"要做什么"写清楚**（界面、交互、规则、要呈现的现象）。小件（示意图、简单交互）仍然用 share_artifact 当场交付。做好之后学生随时能打开它、动手玩，他的操作会照样回报给你。',
      parameters: Type.Object({
        title: Type.String({ description: '制品标题' }),
        kind: Type.Optional(
          Type.String({ description: 'illustration | interactive | diagram | page | game，默认 game' }),
        ),
        description: Type.Optional(Type.String({ description: '一句话说明这份制品用来呈现什么' })),
        spec: Type.String({
          description:
            '给分身的施工单：这个制品要有哪些元素、怎么交互、要让学生观察到什么现象。写具体，分身看不到你的思路。',
        }),
      }),
    },
    {
      name: TOOL_NAMES.COMPILE_NOTES,
      description:
        '把刚讲完的教学内容整理成一条结构化笔记。**当场同步落盘**：这一轮就存进学生的「笔记」页，不排队、不延后。笔记必须来自刚讲完它的你——你知道哪里是重点、哪里是类比、哪里埋了坑，事后重读 transcript 再提炼只会又慢又丢重点。时机不用自己拿捏：set_progress_state 把某个概念升到「已学懂」或「能用出来」时，返回值里会点名告诉你该收了。不要每条 text_delta 都调，一个知识点讲透了收一条；学生最后拿走的「笔记本」就是这些东西攒出来的。',
      parameters: Type.Object({
        title: Type.String({ description: '这条笔记的标题，一句话点题' }),
        concepts: Type.Optional(Type.Array(Type.String({ description: '本条笔记关联的概念 id' }))),
        summary: Type.String({ description: '两三句话讲清这个点是什么、为什么重要' }),
        key_points: Type.Array(Type.String({ description: '要记住的要点，每条一句话' })),
        example: Type.Optional(Type.String({ description: '一个具体的例子（可有代码）' })),
      }),
    },
    {
      name: TOOL_NAMES.RUN_SCENE,
      description:
        '导演台的手：把这一「场」开出来、换相位、把旧道具摆回台上。一场 = 一段连续的教学（一个概念的讲→做→验），不是每条消息一场——一个回合通常只开一场。action: open | phase | place | remove；phase 取 open/teach/practice/assess/close。**台子没有时钟**：你不点它，相位就停在那儿，学习者的沉默不是换场信号。open 要给一句学习者看得懂的场名（如「变量的盒子」），并把正在取景的概念 id 带上——中栏按场分段，正文、题卡、道具都落进这一场的格子里。share_artifact 交付的道具自动上台，不必 place；place 只用来把**以前那场**的道具再摆回来（跨场接着玩）。学习者扔掉的道具摆不回来，那是他的决定。',
      parameters: Type.Object({
        action: Type.String({ description: 'open | phase | place | remove' }),
        title: Type.Optional(Type.String({ description: 'action=open 必填：一句话场名，学习者看得懂' })),
        phase: Type.Optional(Type.String({ description: 'open/phase 必填：open | teach | practice | assess | close' })),
        concept_id: Type.Optional(Type.String({ description: '这一场在演哪个概念（Graph 里的 id），取景跟着走' })),
        artifact_id: Type.Optional(Type.String({ description: 'place/remove 必填：制品 id' })),
      }),
    },
    {
      name: TOOL_NAMES.JEV_JUDGE,
      description:
        '把「判定类」决策外包给专用决策模型（JEV）：判对/判错、证据是否支撑某个主张、在候选中选下一步。你负责**提供证据和标准**，它负责**只做判断**：给它目标（goal）、边界（permissions）、证据（observations / recent_steps，作答原文、制品内容、工具回执都算）、和逐题的判定标准（instructions + criteria），拿回 value + probability。**两个典型场合**：① 判对/判错——作答回到你手里、要判断它是否真的展示了概念 X 的理解时，把题面/作答原文/该概念的判据放进 observations，调 noul；② 证据支撑——要判断「制品证据是否支撑他会了」的主张时，先把 read_artifact_evidence 读回来的具体记录放进 observations，再调 noul。**别把每个步骤都外包**，其余判定照旧自己来。三条纪律：① probability 只是置信度、不是正确率也不是 confidence，它把题判成 needs_review 时不要硬拗、要补证据或问学习者；② 证据不足就如实 unknown/needs_review，低概率硬凑比不判更糟；③ 每次判定都会留痕（输入输出与模式进笔记本的 decision-journal）。**手续类决策绝不外包**：状态转移合法性、证据归一化、自报未验证打标、一次一级，这些还是你自己的活。没有配置 key 时工具会明说并跳过，你退回自行判断，不假装判过。',
      parameters: Type.Object({
        state: Type.Object({
          goal: Type.String({ description: '这次判定要支持的目标/主张' }),
          permissions: Type.Optional(Type.String({ description: '可用手段与边界' })),
          recent_steps: Type.Optional(Type.Array(Type.Any())),
          observations: Type.Optional(Type.String({ description: '证据：作答原文/制品内容/工具回执，给足、别给碎' })),
        }),
        questions: Type.Array(
          Type.Object({
            id: Type.String({ description: '英文小写+连字符的唯一 id' }),
            type: Type.Union([Type.Literal('choice'), Type.Literal('noul'), Type.Literal('score')]),
            instructions: Type.String({ description: '判定标准：给足条件、边界与"算不算"的判据，别写空话' }),
            criteria: Type.Optional(
              Type.Any({
                description: 'choice: {"标签": "含义", ...} 2–255 个；score: ["等级说明", ...] 2–10 个；noul: 不填',
              }),
            ),
          }),
        ),
      }),
    },
  ];
}

// ---------------------------------------------------------------- 状态推进规则

const STATE_ORDER = ['unknown', 'seen', 'understood', 'applied', 'mastered'];

/**
 * 状态转移守卫。规则见 rules/runtime.md §1.2。
 * 返回 { ok, from, to, reason } —— 不 ok 时只拒绝这次写入，并把规则原文回给模型。
 */
export function checkTransition(current, target, { unverified = false, evidence = null } = {}) {
  const from = String(current || 'unknown').toLowerCase();
  const to = String(target || '').toLowerCase();
  if (!STATE_ORDER.includes(to)) {
    return { ok: false, reason: `非法 state: ${target}` };
  }
  if (from === to) return { ok: true, from, to, reason: 'no-op' };

  const fi = STATE_ORDER.indexOf(from);
  const ti = STATE_ORDER.indexOf(to);

  if (ti > fi) {
    if (ti - fi > 1) {
      return { ok: false, reason: `一次只能升一级：${from} → ${to} 跨了 ${ti - fi} 级` };
    }
    // 首次接触即转换：探针作答本身就是那个 observed 事件，不需要额外证据（runtime.md §1.2）
    if (from === 'unknown' && to === 'seen') {
      return { ok: true, from, to, reason: 'probe_answered（首次接触，无论对错）' };
    }
    if (!evidence) {
      return {
        ok: false,
        reason: `升级到 ${to} 需要 observed 证据。请在 evidence 字段里写出学习者实际说了/做了什么`,
      };
    }
    return { ok: true, from, to, reason: 'upgrade' };
  }

  // 降级
  if (ti < fi) {
    if (unverified) {
      return { ok: true, from, to, reason: '未验证自报的降级特例（单次概念错误即降一级）' };
    }
    if (fi - ti > 1) {
      return { ok: false, reason: `降级一次只降一级：${from} → ${to}` };
    }
    return { ok: true, from, to, reason: 'conceptual_error_twice 降级' };
  }
  return { ok: false, reason: '无法判定的转移' };
}

// ---------------------------------------------------------------- agent 运行时

class PendingQuestion {
  constructor() {
    this.answered = false;
    this.answer = null;
    this.reject = null;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

export class TeachingSession {
  /**
   * @param {object} deps
   * @param {object} deps.registry   ProviderRegistry
   * @param {object} deps.notebook   store.getNotebook() 的结果
   * @param {(event: object) => void} deps.emit  向浏览器推事件
   * @param {AbortSignal} [deps.signal]
   * @param {object} deps.systemPrompt
   */
  constructor({ registry, notebook, emit, signal, systemPrompt, taskRunner = null, modelRef = null, deskWriter = true, decision = null }) {
    this.registry = registry;
    this.notebook = notebook;
    this.emit = emit;
    this.signal = signal;
    this.systemPrompt = systemPrompt;
    // 判定外包的注入口：测试/宿主传 { faux, fauxAnswers, provider, apiKey }；null 时全走环境变量
    this.decisionOpts = decision;
    // 任务运行器：派分身 / 挂后台。没给就退化成"无法派生"（单测与旧调用方不受影响）
    this.taskRunner = taskRunner;
    this.modelRef = modelRef;
    this.pending = new Map(); // questionId -> PendingQuestion
    this.pendingPlans = new Map(); // planId -> { resolve }
    this.progress = structuredClone(notebook.progress);
    this.graph = structuredClone(notebook.graph);
    this.graphDirty = false;
    this.progressDirty = false;
    this.pendingEvents = [];
    this.artifacts = [];
    // 本回合产出的制品（含内联），回合结束后挂到 assistant 消息上供刷新后回放
    this.roundArtifacts = [];
    // 本回合出过的题，同样随 assistant 消息落盘：刷新后题目卡片才能恢复
    this.roundQuestions = [];
    this.liveArtifacts = new Map(); // artifactId -> { evidence: [...] }
    this.askedQuestions = [];
    this.askSeq = 0;   // 模型没给 id 时补号用
    this.todos = normaliseTodos(notebook.todos);
    // 导演台：这一场摆成什么样。normaliseSceneState 认 null——旧笔记没这个文件就是「还没开过场」。
    this.scene = normaliseSceneState(notebook.scene);
    // 分身/后台任务不是台面的主人：它们拿的是派出那一刻的克隆，写盘就用旧台盖掉老师的每一手。
    // 所以 deskWriter=false 的会话只交付文件，上台由宿主现读最新的盘来摆（store.placeOnDesk）。
    this.deskWriter = deskWriter;
  }

  /** 浏览器作答回传入口。 */
  answer(questionId, payload) {
    const q = this.pending.get(questionId);
    if (!q) return false;
    this.pending.delete(questionId);
    q.answered = true;
    q.answer = payload;
    q.resolve(payload);
    return true;
  }

  /** 浏览器对某个计划的裁决回传入口。 */
  decidePlan(planId, payload) {
    const p = this.pendingPlans.get(planId);
    if (!p) return false;
    this.pendingPlans.delete(planId);
    p.resolve(payload);
    return true;
  }

  cancelAll(reason = '会话已中断') {
    for (const [id, q] of this.pending) {
      q.reject(new Error(reason));
      this.pending.delete(id);
    }
    for (const [id, p] of this.pendingPlans) {
      p.resolve({ approved: false, feedback: reason });
      this.pendingPlans.delete(id);
    }
  }

  // ---- 工具实现 -------------------------------------------------------

  async execAsk(args) {
    // id 只是"这张卡对应哪个等待中的提问"的传输把手，答完就没用了；教学坐标承重的是
    // concept_id。所以模型没填就自己补一个，而不是让参数校验把这一发问卡挡成红卡。
    const id = String(args.id || '').trim() || `q-${Date.now().toString(36)}-${(this.askSeq += 1)}`;
    const q = new PendingQuestion();
    this.pending.set(id, q);
    this.askedQuestions.push(id);
    // 落盘副本：题目以前只走 SSE，刷新页面就消失——题面是学习的核心内容，
    // 必须和制品一样随消息持久化。同一对象引用，作答后 answer 字段就位。
    const record = {
      questionId: id,
      header: args.header ?? null,
      question: args.question,
      // 存下来是为了下一轮回放历史时这道题还带着教学坐标（见 historyToModelMessages）
      conceptId: String(args.concept_id || '').trim() || null,
      options: normalizeAskOptions(args.options),
      multiSelect: Boolean(args.multi_select),
      allowText: args.allow_text !== false,
      askedAt: Date.now(),
      answer: null,
    };
    this.roundQuestions.push(record);
    this.emit({
      type: 'ask',
      questionId: record.questionId,
      header: record.header,
      question: record.question,
      conceptId: record.conceptId,
      options: record.options,
      multiSelect: record.multiSelect,
      allowText: record.allowText,
    });

    const onAbort = () => {
      this.pending.delete(id);
      q.reject(new Error('回合被中断'));
    };
    this.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const payload = await q.promise;
      record.answer = {
        selected: Array.isArray(payload?.selected) ? payload.selected : [],
        text: payload?.text ?? '',
        skipped: Boolean(payload?.skipped),
        answeredAt: Date.now(),
      };
      const rendered = answerText(payload);
      const auto = this.markFirstContact(args.concept_id, record, rendered);
      this.emit({
        type: 'answer',
        questionId: id,
        selected: payload?.selected ?? [],
        text: payload?.text ?? '',
        skipped: Boolean(payload?.skipped),
      });
      return auto ? `${rendered}\n\n${auto}` : rendered;
    } finally {
      this.signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * §1.2 的 Unknown→Seen 是无条件的（探针作答即首次接触，无论对错），所以由应用自己写。
   * 交给老师记得调 set_progress_state，它一整局不调，地图就永远全灰——实测 50 轮零次。
   * 往上还有 seen→understood→applied→mastered，那些要判断"证据够不够"，仍然只归它。
   */
  markFirstContact(conceptId, record, rendered) {
    const cid = String(conceptId || '').trim();
    if (!cid || cid === 'none') return null;
    const entry = this.progress.concepts[cid];
    if (!entry || entry.state !== 'unknown' || record.answer?.skipped) return null;
    const now = new Date().toISOString();
    const evidence = `探针「${record.question.slice(0, 40)}」已作答：${rendered}`;
    entry.state = 'seen';
    entry.last_evidence = evidence;
    entry.updated_at = now;
    this.progressDirty = true;
    this.pendingEvents.push({ concept_id: cid, kind: 'observed', summary: '探针已作答，首次接触记为 Seen', at: now });
    this.emit({
      type: 'progress',
      progress: this.progress,
      changes: [{ conceptId: cid, from: 'unknown', to: 'seen', word: stateWord('seen') }],
    });
    return `〔${cid} 已由应用记为 Seen（首次接触）。再往上升级要你来写 set_progress_state，带上这一条证据。〕`;
  }

  async execSaveGraph(args) {
    const graph = {
      meta: {
        topic: args.topic,
        goal: args.goal ?? null,
        pedagogy: args.pedagogy,
        learner_profile: {
          background: this.graph?.meta?.learner_profile?.background ?? null,
          known_concepts: this.graph?.meta?.learner_profile?.known_concepts ?? [],
          pace: this.graph?.meta?.learner_profile?.pace ?? 'normal',
        },
      },
      concepts: (args.concepts || []).map((c) => carryOverConcept(this.graph, c)),
    };
    try {
      validateGraph(graph);
    } catch (err) {
      if (err instanceof GraphValidationError) {
        return { ok: false, error: err.message };
      }
      throw err;
    }
    const ordered = topoSortConcepts(graph);
    this.graph = graph;
    this.graphDirty = true;

    // 新出现的 concept 一律从 unknown 起步（不猜历史语义归属）
    for (const c of graph.concepts) {
      if (!this.progress.concepts[c.id]) {
        this.progress.concepts[c.id] = {
          concept_id: c.id,
          state: 'unknown',
          next_action: '接地→探针',
          unverified_self_report: false,
          note: null,
          updated_at: new Date().toISOString(),
        };
      } else if (this.progress.concepts[c.id].state === 'mastered' && !args.force) {
        // 复用已有 state：这是"继续学习"的正常路径
      }
    }
    this.progress.session_open = true;
    this.progressDirty = true;
    this.emit({ type: 'graph', graph: this.graph, ordered: ordered.map((c) => c.id) });
    this.emit({ type: 'progress', progress: this.progress });
    return {
      ok: true,
      conceptCount: graph.concepts.length,
      teachingOrder: ordered.map((c) => `${c.id} (${c.name})`),
      note:
        '已保存。向学习者展示概念清单与顺序，然后调用 ask_user_question 收这次确认' +
        '（这是范围确认，不是在探某个概念，concept_id 填 none；选项给「就按这个顺序」「换个聚焦范围」「砍掉某一块」，' +
        'allow_text 保持开启）。' +
        '不要用正文里的「⛔ 等待你的确认」代替：正文不阻塞回合，学习者只能自己打字回答，' +
        '而下一轮回放历史时这条确认什么都不留下——你会把同一份清单再念一遍。',
    };
  }

  async execSetProgress(args) {
    const applied = [];
    const rejected = [];
    const now = new Date().toISOString();
    for (const u of args.updates || []) {
      const cid = u.concept_id;
      if (!this.progress.concepts[cid]) {
        rejected.push(`${cid}: concept 不在 Graph 中`);
        continue;
      }
      const entry = this.progress.concepts[cid];
      const check = checkTransition(entry.state, u.state, {
        unverified: Boolean(u.unverified_self_report ?? entry.unverified_self_report),
        evidence: u.evidence || null,
      });
      if (!check.ok) {
        rejected.push(`${cid}: ${check.reason}`);
        continue;
      }
      const before = entry.state;
      entry.state = check.to;
      entry.next_action = u.next_action ?? entry.next_action;
      entry.note = u.note ?? entry.note;
      entry.unverified_self_report = Boolean(u.unverified_self_report ?? entry.unverified_self_report);
      entry.last_evidence = u.evidence ?? entry.last_evidence ?? null;
      entry.updated_at = now;
      applied.push({ conceptId: cid, from: before, to: check.to, word: stateWord(check.to) });
    }
    for (const ev of args.events || []) {
      const kind = ev.kind === 'inferred' ? 'inferred' : 'observed';
      this.pendingEvents.push({
        concept_id: ev.concept_id,
        kind,
        summary: ev.summary,
        at: now,
      });
    }
    if (applied.length) this.progressDirty = true;
    if (applied.length || (args.events || []).length) {
      this.progress.notes = this.progress.notes || [];
      if (args.session_note) this.progress.notes.push({ at: now, text: args.session_note });
      this.emit({ type: 'progress', progress: this.progress, changes: applied });
    }
    // 笔记的"时机"不交给自觉：概念升到 understood/applied 的那一刻就是"这个点刚讲透"，
    // 而工具返回值是模型当场读到的最后一句话——比规则原文和工具描述都管用。
    // 已经收过的点不必躲：状态快照里列着盘上那份讲义，它看得见。
    const justTaught = applied.filter((a) => a.to === 'understood' || a.to === 'applied');
    const taughtNames = justTaught
      .map((a) => `「${this.graph?.concepts?.find((c) => c.id === a.conceptId)?.name || a.conceptId}」`)
      .join('、');
    return {
      ok: rejected.length === 0,
      applied,
      rejected: rejected.length ? rejected : undefined,
      note: rejected.length
        ? '被拒绝的转移不改变状态，请按 runtime.md §1.2 的规则重新给出。'
        : justTaught.length
          ? `状态已更新。${taughtNames} 这个点讲透了——趁现在你知道哪里是重点、哪里埋了坑，收一条 compile_notes（一条笔记只讲这一个点）。`
          : '状态已更新。',
    };
  }

  async execShareArtifact(args) {
    const kind = args.kind || 'illustration';
    let html = injectArtifactRuntime(args.html);
    // 续玩：把上轮状态作为初始快照注入，制品里 getState() 拿得到
    if (args.initial_state) html = injectInitialState(html, args.initial_state);
    // CSP 最后注入：三处注入都插在 <head> 之后，"最后一个插的最靠最前"——
    // meta 必须落在运行时那个内联 <script> 之前，否则脚本先执行、策略后生效。
    html = injectArtifactCsp(html);
    // 道具一律落盘。以前有两支：带 persist 才写文件，否则发一个 `inline-N` 的合成 id，
    // 整份 HTML 只嵌在 chat.json 里——实测那件 23,135 字符的「正则试错场」就是这样，
    // artifacts/ 目录空着。没有地址的道具寻不了址、续不了玩、撤不下来，
    // "跨段场景延续"在数据层就不成立。可丢弃是学习者那一侧的手势（扔掉），不是"不存"。
    const { saveArtifact } = await import('./store.mjs');
    const stored = saveArtifact(this.notebook.id, {
      title: args.title,
      html,
      kind,
    });
    this.artifacts.push(stored);
    const artifactId = stored.id;
    // 道具一交付就摆上当前这一场的台。没开过场时不替他开：「这场在演什么」是导演的判断，
    // 宿主给他默认开一场就是把判断权拿回来了——所以这里只在有台的时候上台。
    // deskWriter=false（分身/后台任务）连这一步都不做：它拿的是旧克隆，一写盘就把老师
    // 在这之后的每一手盖掉；上台交给宿主现读最新的盘（serve.mjs 的 task_artifact 分支）。
    if (this.deskWriter && this.scene.current) {
      this.scene = placeProp(this.scene, stored);
      saveSceneState(this.notebook.id, this.scene);
      this.emit({ type: 'scene', scene: this.scene.current, log: this.scene.log });
    }
    const questions = extractQuestionIds(html);
    this.liveArtifacts.set(artifactId, {
      id: artifactId,
      title: args.title,
      kind,
      questions,
      evidence: [],
      state: {},
      events: [],
      createdAt: new Date().toISOString(),
    });
    // 落一份"可回放"的记录。制品以前只走 SSE——页面一刷新，制品就永远消失了
    // （renderThread 只重放 chat.json，而 chat.json 里没有任何制品痕迹）。
    // 这是"canvas 并没有出现"那个现象的根因，所以每份都记。
    this.roundArtifacts.push({
      id: artifactId,
      title: args.title,
      description: args.description ?? null,
      kind,
      html,
    });
    this.emit({
      type: 'artifact',
      artifact: {
        id: artifactId,
        title: args.title,
        description: args.description ?? null,
        kind,
        html,
        rel: stored.rel,
        expectsEvidence: questions.length > 0 || Boolean(args.initial_state),
      },
    });
    return {
      ok: true,
      artifactId,
      rel: stored.rel,
      contract: ARTIFACT_CONTRACT_NOTE,
      desk: !this.deskWriter
        ? '你这一份是分身交的：不用你 run_scene，也别以为台面归你管——宿主会读最新的盘，把它摆进学习者当下这一场的台上。'
        : this.scene.current
          ? `已摆上第 ${this.scene.current.index} 场「${this.scene.current.title}」的台。这一台是摊开的那件：` +
            '老师随后讲到它的那些话，宿主会落在你留的 data-narration-slot 带里（怎么留见契约），所以这一屏自己就得是一整课。'
          : '台子还没开场，这件不在任何一场里：下一句之前先 run_scene（action=open）把这一场开出来。',
      note:
        '制品已落盘并内联渲染（交互运行时已自动注入），它有稳定地址：/api/notebooks/<笔记本>/artifacts/' +
        artifactId +
        '。学习者对它的操作会被宿主收集；下一轮用 read_artifact_evidence 读回来当证据。',
      honesty:
        '不要凭猜测说学习者"在制品里试过了"。只有 read_artifact_evidence 返回了内容才算真的观测到。',
    };
  }

  /**
   * 记录来自前端的制品证据。前端在 iframe 里 postMessage 出来，服务端转交到这里。
   * 只做去重与截断，不判对错（Invariant 4：判对错留在对话里）。
   */
  /**
   * 记录来自前端的制品回报。前端在 iframe 里 postMessage 出来，服务端转交到这里。
   * 三种 type：
   *   evidence —— 答卷型（data-interaction 块的作答）
   *   state    —— 项目/游戏/模拟器的状态快照（浅合并，持久化）
   *   event    —— 离散事件（level_cleared / bug_found …）
   * 只做去重与截断，不判对错（Invariant 4：判对错留在对话里）。
   */
  recordArtifactEvidence(payload) {
    const type = payload?.type || 'evidence';
    const ev = payload?.evidence || payload;
    if (!ev || typeof ev !== 'object') return false;
    const artifactId = String(payload?.artifactId ?? ev.artifactId ?? 'unknown');
    const bucket =
      this.liveArtifacts.get(artifactId) || {
        id: artifactId,
        title: null,
        kind: null,
        questions: [],
        evidence: [],
        state: {},
        events: [],
        createdAt: new Date().toISOString(),
      };
    this.liveArtifacts.set(artifactId, bucket);

    if (type === 'state') {
      const state = payload.state || ev.state || {};
      if (state && typeof state === 'object') bucket.state = { ...bucket.state, ...state };
      this.emit({ type: 'artifact_state', artifactId, state: bucket.state });
      return true;
    }

    if (type === 'event') {
      const name = String(payload.name || ev.name || 'event').slice(0, 80);
      const at = payload.at || new Date().toISOString();
      if (bucket.events.some((e) => e.name === name && e.at === at)) return false;
      bucket.events.push({ name, payload: payload.payload ?? null, at });
      this.emit({ type: 'artifact_event', artifactId, name, payload: payload.payload ?? null, at });
      return true;
    }

    const normalized = {
      concept_id: ev.concept_id ?? null,
      question_id: ev.question_id ?? null,
      interaction_type: ev.interaction_type ?? null,
      response: ev.response == null ? null : String(ev.response).slice(0, 1000),
      result: ['correct', 'incorrect', 'recorded'].includes(ev.result) ? ev.result : null,
      attempts: Number(ev.attempts) || 0,
      completed: Boolean(ev.completed),
      locked: Boolean(ev.locked),
    };
    // 去重键：题目 + 尝试次数 + 结果。同一题反复答错会留下多条，这是要的。
    const key = (e) => `${e.question_id}|${e.attempts}|${e.result}|${e.response}`;
    if (bucket.evidence.some((e) => key(e) === key(normalized))) return false;
    bucket.evidence.push(normalized);
    this.emit({ type: 'artifact_evidence', evidence: normalized, artifactId });
    return true;
  }

  /**
   * 给某个制品下行一条指令（Agent → 制品）。
   * 只对还开着的制品有效；学习者已关掉就收不到。
   */
  pushArtifactCommand(artifactId, name, payload) {
    this.emit({
      type: 'artifact_command',
      artifactId: artifactId || null,
      name: String(name || ''),
      payload: payload ?? null,
    });
    return {
      ok: true,
      note: '指令已推给制品。制品若已关闭则收不到——那就退回对话，别装作学习者已经看到。',
    };
  }

  /** 制品回报的读回视图：答卷证据 + 状态快照 + 离散事件。 */
  artifactEvidenceView(artifactId) {
    const items = artifactId
      ? [this.liveArtifacts.get(artifactId)].filter(Boolean)
      : [...this.liveArtifacts.values()];
    if (!items.length) {
      return {
        artifacts: [],
        note: '这一轮还没有任何制品交互记录。没有记录 ≠ 学习者没做；只是没观测到可读回的内容。',
      };
    }
    return {
      artifacts: items.map((a) => ({
        artifact_id: a.id,
        title: a.title,
        kind: a.kind,
        questions_declared: a.questions,
        evidence: a.evidence,
        state: a.state,
        events: a.events,
        observed_count: a.evidence.length + a.events.length,
      })),
      note: evidenceNote(items),
    };
  }

  async execGetGraph(args) {
    const include = args.include || 'all';
    const out = {};
    if (include === 'all' || include === 'graph') {
      out.graph = this.graph;
      out.teaching_order = this.graph.concepts?.length
        ? topoSortConcepts(this.graph).map((c) => ({
            id: c.id,
            name: c.name,
            summary: c.summary,
            misconceptions: c.misconceptions || [],
            observable_skills: c.observable_skills || [],
          }))
        : [];
      out.graph_confirmed = Boolean(this.graph.concepts?.length);
    }
    if (include === 'all' || include === 'progress') {
      out.progress = {
        session_open: this.progress.session_open,
        concepts: Object.values(this.progress.concepts || {}).map((c) => ({
          concept_id: c.concept_id,
          state: c.state,
          word: stateWord(c.state),
          next_action: c.next_action,
          unverified_self_report: c.unverified_self_report,
          note: c.note,
        })),
        notes: this.progress.notes || [],
      };
    }
    if (include === 'all' || include === 'patch_log') {
      out.patch_log = (this.notebook.patches?.patches || []).map((p) => ({
        operation: p.operation,
        target: p.target,
        reason: p.reason,
        confidence: p.confidence,
        applied: p.applied,
      }));
    }
    return out;
  }

  async execProposePatch(args) {
    const p = args.patch || {};
    const confidence = ['high', 'medium', 'low'].includes(p.confidence) ? p.confidence : 'medium';
    const parsedValue = (() => {
      const v = p.value;
      if (typeof v !== 'string') return v;
      const t = v.trim();
      if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'))) {
        try {
          return JSON.parse(t);
        } catch {
          return v;
        }
      }
      return v;
    })();
    const target = { ...p, value: parsedValue };
    // SPLIT 本来就不能就地应用（要走重新分解），其余操作先对 Graph 空跑一遍再决定记不记。
    // 不合用的提议一旦落成待确认卡，学习者点「接受」只会拿到红字，而这处改动压根写不进去——
    // 回路断在人工搬运上，比模型白烧一个来回更糟。
    if (p.operation !== 'SPLIT') {
      const err = patchError(structuredClone(this.graph), target);
      if (err) {
        return {
          ok: false,
          error: err,
          note: '这条提议没有落地，Graph 与改动记录都没动，学习者那边也不会出现卡片。换个字段或换整个概念重走 update_learning_graph，别原样重发。',
        };
      }
    }
    const record = appendPatch(this.notebook.id, {
      operation: p.operation,
      target: p.target,
      value: parsedValue,
      reason: p.reason,
      confidence,
    });
    this.emit({ type: 'patch', patch: record });

    // high confidence 直接合并；其余留给学习者确认
    if (confidence === 'high' && p.operation !== 'SPLIT') {
      try {
        applyPatchToGraph(this.graph, target);
        this.graphDirty = true;
        const { updatePatch } = await import('./store.mjs');
        updatePatch(this.notebook.id, record.id, {
          applied: true,
          applied_at: new Date().toISOString(),
        });
        this.emit({ type: 'graph', graph: this.graph });
        return { ok: true, applied: true, note: '高置信度改动已直接合并进 Learning Graph。' };
      } catch (err) {
        return { ok: false, applied: false, error: err.message, note: '改动已记录但未能合并。' };
      }
    }
    if (p.operation === 'SPLIT') {
      return {
        ok: true,
        applied: false,
        patchId: record.id,
        note:
          'SPLIT 只记录，不就地合并——拆开概念要重走分解。按 runtime.md §2.10 先把判断说给学习者，给他「现在重排」与「这块先学完、下次再拆」两个选择。',
      };
    }
    return {
      ok: true,
      applied: false,
      patchId: record.id,
      note:
        confidence === 'medium'
          ? '已记录，等待学习者确认。请把这条改动译写成自然语言展示给他。'
          : '置信度低，仅记录，需学习者明确同意后再合并。',
    };
  }

  async execRecordEvent(args) {
    const kind = args.kind === 'inferred' ? 'inferred' : 'observed';
    this.pendingEvents.push({
      concept_id: args.concept_id,
      kind,
      summary: args.summary,
      at: new Date().toISOString(),
    });
    return { ok: true, recorded: true };
  }

  /**
   * 判定外包：把「判定类」决策交给专用决策模型（JEV），模型这边只提供证据与标准。
   * 每次调用（含失败）都写进 notebook 的 decision-journal——判定全留痕是红线，
   * 但 key 绝不进账本。没有 key 且不在 faux 模式时明说并跳过，绝不假装判过。
   */
  async execJevJudge(args) {
    const { state, questions } = args;
    const entryBase = { at: new Date().toISOString(), state, questions };
    try {
      const result = await jevDecide({ state, questions }, this.decisionOpts || {});
      appendDecisionJournal(this.notebook.id, {
        ...entryBase,
        kind: 'decision',
        mode: result.mode,
        jev_called: result.jev_called,
        provider: result.provider,
        model: result.model,
        decisions: result.decisions,
      });
      return {
        ok: true,
        mode: result.mode,
        jev_called: result.jev_called,
        provider: result.provider,
        decisions: result.decisions,
        note: '概率只是置信度，不是正确率；判定已全部留痕。',
      };
    } catch (err) {
      const kind = err instanceof DecisionError ? err.kind : 'internal';
      appendDecisionJournal(this.notebook.id, {
        ...entryBase,
        kind: 'error',
        error: { kind, message: err.message },
      });
      return { ok: false, decision_error: kind, error: err.message };
    }
  }

  async execTool(name, args) {
    switch (name) {
      case TOOL_NAMES.ASK:
        return this.execAsk(args);
      case TOOL_NAMES.SAVE_GRAPH:
        return this.execSaveGraph(args);
      case TOOL_NAMES.SET_PROGRESS:
        return this.execSetProgress(args);
      case TOOL_NAMES.SHARE_ARTIFACT:
        return this.execShareArtifact(args);
      case TOOL_NAMES.READ_ARTIFACT:
        return this.artifactEvidenceView(args.artifact_id);
      case TOOL_NAMES.PUSH_ARTIFACT:
        return this.pushArtifactCommand(args.artifact_id, args.name, args.payload);
      case TOOL_NAMES.GET_GRAPH:
        return this.execGetGraph(args);
      case TOOL_NAMES.PROPOSE_PATCH:
        return this.execProposePatch(args);
      case TOOL_NAMES.RECORD_EVENT:
        return this.execRecordEvent(args);
      case TOOL_NAMES.PRESENT_PLAN:
        return this.execPresentPlan(args);
      case TOOL_NAMES.UPDATE_TODO:
        return this.execUpdateTodo(args);
      case TOOL_NAMES.SPAWN_SUBAGENT:
        return this.execSpawnSubagent(args);
      case TOOL_NAMES.RUN_BACKGROUND:
        return this.execRunBackground(args);
      case TOOL_NAMES.READ_BACKGROUND:
        return this.execReadBackground(args);
      case TOOL_NAMES.LIST_BACKGROUND:
        return this.execListBackground(args);
      case TOOL_NAMES.STOP_BACKGROUND:
        return this.execStopBackground(args);
      case TOOL_NAMES.PREPARE_ARTIFACT:
        return this.execPrepareArtifact(args);
      case TOOL_NAMES.COMPILE_NOTES:
        return this.execCompileNotes(args);
      case TOOL_NAMES.RUN_SCENE:
        return this.execRunScene(args);
      case TOOL_NAMES.JEV_JUDGE:
        return this.execJevJudge(args);
      default:
        return { ok: false, error: `未知工具: ${name}` };
    }
  }

  /**
   * 派一个分身去查一件事，当场拿结论。适合"去确认这个 API 的参数签名"
   * "把这道题改难一点"这类一次性的活。分身改不到学习状态。
   */
  async execSpawnSubagent(args) {
    const instructions = String(args.instructions || args.task || '').trim().slice(0, 8000);
    if (!instructions) return { ok: false, error: 'instructions 不能为空' };
    if (!this.taskRunner) {
      return { ok: false, error: '这个会话没有配置任务运行器，无法派分身' };
    }
    const record = await this.taskRunner.spawn({
      notebook: this.notebook,
      modelRef: this.modelRef,
      title: args.title,
      instructions,
    });
    if (record.status === 'done') {
      return {
        ok: true,
        subagent_id: record.id,
        status: 'done',
        conclusion: record.output,
        note: '分身已完成，上面的结论只供你参考；它没有碰学习状态。',
      };
    }
    return {
      ok: false,
      subagent_id: record.id,
      status: record.status,
      error: record.error || '分身没有跑完',
      note: '自己把这一件事做掉，不要说成分身做的。',
    };
  }

  /** 挂一个后台任务，立刻返回 id，不占本回合时间。 */
  execRunBackground(args) {
    const instructions = String(args.instructions || args.task || '').trim().slice(0, 8000);
    if (!instructions) return { ok: false, error: 'instructions 不能为空' };
    if (!this.taskRunner) {
      return { ok: false, error: '这个会话没有配置任务运行器，无法挂后台任务' };
    }
    const record = this.taskRunner.submit({
      notebook: this.notebook,
      modelRef: this.modelRef,
      title: args.title,
      instructions,
    });
    return {
      ok: true,
      task_id: record.id,
      status: 'running',
      note: `已挂到后台。之后用 read_background_task（task_id="${record.id}"）拿结果，`
        + '或在下一回合说"看一下后台任务"。',
    };
  }

  execReadBackground(args) {
    if (!this.taskRunner) return { ok: false, error: '这个会话没有配置任务运行器' };
    const id = String(args.task_id || '').trim();
    if (!id) return { ok: false, error: 'task_id 不能为空' };
    const t = this.taskRunner.get(id);
    if (!t) return { ok: false, error: `没有这个任务: ${id}` };
    // 后台任务离开本回合也能拿结果，所以连同历史记录一起找
    if (t.status === 'running') {
      return { ok: true, task_id: id, status: 'running', note: '还在跑，先继续手上的事。' };
    }
    return {
      ok: t.status === 'done',
      task_id: id,
      status: t.status,
      conclusion: t.output || undefined,
      error: t.error || undefined,
    };
  }

  execListBackground() {
    if (!this.taskRunner) return { ok: false, error: '这个会话没有配置任务运行器' };
    const list = this.taskRunner
      .list({ notebookId: this.notebook.id })
      .map((t) => ({ id: t.id, kind: t.kind, title: t.title, status: t.status }));
    return { ok: true, count: list.length, tasks: list };
  }

  execStopBackground(args) {
    if (!this.taskRunner) return { ok: false, error: '这个会话没有配置任务运行器' };
    return this.taskRunner.stop(String(args.task_id || '').trim());
  }

  /**
   * 异步做大件制品：分身去后台生成 HTML，本回合不卡。
   * 本体只写"要什么"，不写 HTML——HTML 由分身在 write_artifact 模式下产出。
   * 制品做好后由 serve.mjs 捕获 task_artifact 事件：推给前端，并由宿主摆进当前这一场的台面。
   */
  execPrepareArtifact(args) {
    if (!this.taskRunner) return { ok: false, error: '这个会话没有配置任务运行器' };
    const title = String(args.title || '').trim().slice(0, 120) || '未命名制品';
    const kind = String(args.kind || 'game').trim();
    const description = String(args.description || '').trim();
    const spec = String(args.spec || '').trim().slice(0, 6000);
    if (!spec) return { ok: false, error: 'spec 不能为空：要把"要做什么"写具体，分身看不到你的思路' };

    const instructions = [
      `你在为一个学习会话制作一份 HTML 制品，标题：「${title}」，类型：${kind}。`,
      description ? `用途：${description}` : '',
      '',
      '施工单（主教学会话写给你的需求）：',
      spec,
      '',
      `做完后用 share_artifact 交付，title 就用「${title}」、kind 用 ${kind}。`,
      '制品要求：单文件 HTML、不引 CDN、canvas/WebGL 可用、答完有明确的下一步入口；',
      '只给现象，不解释原因、不判对错、不藏答案键。',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const record = this.taskRunner.submit({
        notebook: this.notebook,
        modelRef: this.modelRef || undefined,
        title: `制作制品：${title}`,
        instructions,
        purpose: 'artifact',
      });
      // 让前端马上有个占位：台面上先亮一张"正在做"的卡
      this.emit({
        type: 'artifact_pending',
        artifact: { id: record.id, title, kind, description: description || null, jobId: record.id },
      });
      return {
        ok: true,
        status: 'preparing',
        job_id: record.id,
        note: '已派分身去后台制作。你可以继续讲/提问；制品做好后宿主会把它摆进学习者当前这一场的台上（你不用也不能替他 place），届时系统会告诉你。',
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /**
   * 整理一条结构化笔记。
   *
   * 为什么不让分身异步做：笔记的内容必须来自"刚讲完它的那个模型"——它知道哪里是重点、
   * 哪里是类比、哪里埋了坑。让另一个分身在事后重读 transcript 再提炼，既慢又丢重点，
   * 而且把已经讲清楚的事再做一遍。所以：**主模型当场写，落盘零延迟，答题回路一秒都不多等**。
   * 真正异步的是"做大件制品"（见 execPrepareArtifact）——那才是有几分钟生成延迟的活。
   */
  execCompileNotes(args) {
    const title = String(args.title || '').trim().slice(0, 120);
    const summary = String(args.summary || '').trim();
    if (!title || !summary) return { ok: false, error: 'title 和 summary 都要给' };
    const note = {
      title,
      summary: summary.slice(0, 800),
      key_points: (Array.isArray(args.key_points) ? args.key_points : [])
        .map((p) => String(p || '').trim())
        .filter(Boolean)
        .slice(0, 8),
      example: args.example ? String(args.example).slice(0, 2000) : '',
      concepts: (Array.isArray(args.concepts) ? args.concepts : []).map((c) => String(c)).slice(0, 12),
    };
    try {
      const saved = saveNote(this.notebook.id, note);
      this.emit({ type: 'note_saved', note: saved });
      return { ok: true, note_id: saved.id, note: '已存入学生笔记（会自动落盘，刷新不丢，可导出）。' };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /**
   * 计划模式：把打算做的事讲给学习者听，阻塞到他批准或提意见。
   * 对应 DSH 的 exit_plan_mode——先对齐，再动手。
   */
  async execPresentPlan(args) {
    const plan = String(args.plan || '').trim().slice(0, 6000);
    if (!plan) return { ok: false, error: 'plan 不能为空' };
    const planId = `plan-${(this.planSeq = (this.planSeq ?? 0) + 1)}-${Date.now().toString(36)}`;
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    this.pendingPlans.set(planId, { resolve, plan });
    this.emit({ type: 'plan', planId, plan });

    const onAbort = () => {
      this.pendingPlans.delete(planId);
      resolve({ approved: false, feedback: '回合被中断' });
    };
    this.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const verdict = await promise;
      this.emit({
        type: 'plan_decided',
        planId,
        approved: Boolean(verdict?.approved),
        feedback: verdict?.feedback ?? '',
      });
      if (verdict?.approved) {
        // 批准时学习者常常顺手补一句（"主要用 JS"）。以前这一支只读 approved，
        // 那句话到了服务端就被丢掉，模型只能重新问一遍——问了等于浪费一个来回。
        const extra = String(verdict?.feedback || '').trim();
        return {
          ok: true,
          decision: 'approved',
          ...(extra ? { feedback: extra } : {}),
          note: extra
            ? `学习者批准了这个计划，并补了一句：${extra}。把它并进计划再继续，一次只做一个教学动作。`
            : '学习者批准了。按这个计划继续，一次只做一个教学动作。',
        };
      }
      return {
        ok: true,
        decision: 'changes_requested',
        feedback: verdict?.feedback || '（学习者没有写具体意见）',
        note: '学习者要求修改。把他的意见并进去，必要时重新 present_plan。',
      };
    } finally {
      this.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 更新右侧「本轮待办」。整体替换，不是追加。 */
  execUpdateTodo(args) {
    this.todos = normaliseTodos(args.todos);
    this.todosDirty = true;
    this.emit({ type: 'todo', todos: this.todos });
    const done = this.todos.filter((t) => t.status === 'completed').length;
    return {
      ok: true,
      note: `待办已更新：${done}/${this.todos.length} 已完成。学习者能在右侧页签看到。`,
    };
  }

  /**
   * 导演台：开场 / 换相位 / 摆道具 / 撤道具。
   * 这是**唯一**能让台子动的地方——相位没有时钟，学习者的沉默不是换场信号。
   * 落盘走 scene.json（跟 todos 同类：台的记录，不进 progress.json）。
   */
  execRunScene(args) {
    const action = String(args.action || '').trim();
    try {
      if (action === 'open') {
        this.scene = openScene(this.scene, {
          title: args.title,
          conceptId: args.concept_id || null,
          phase: args.phase || 'open',
        });
      } else if (action === 'phase') {
        this.scene = setPhase(this.scene, args.phase);
      } else if (action === 'place' || action === 'remove') {
        const id = String(args.artifact_id || '').trim();
        if (!id) return { ok: false, error: `${action} 要给 artifact_id` };
        if (action === 'remove') {
          this.scene = removeProp(this.scene, id);
        } else {
          // 摆上台的必须是盘上真有的那一件：title / rel 从 manifest 取，
          // 不让模型转述一件它记错的道具。
          const row = [...(this.notebook.artifacts || []), ...this.artifacts].find((a) => a.id === id);
          if (!row) {
            return { ok: false, error: `没有这件道具：${id}（share_artifact 交付之后它才有身份）` };
          }
          // 学习者扔掉的那件摆不回来：放回是他那一侧的手势，替他摆就是把他的决定抹掉（1b 的纪律）。
          if (row.retiredAt) {
            return { ok: false, error: `「${row.title}」被学习者扔掉了，摆不回来——放回是他的手势，不是你的` };
          }
          this.scene = placeProp(this.scene, row);
        }
      } else {
        return { ok: false, error: `未知 action: ${action}（open / phase / place / remove）` };
      }
      saveSceneState(this.notebook.id, this.scene);
      this.emit({ type: 'scene', scene: this.scene.current, log: this.scene.log });
      const c = this.scene.current;
      const propsOnDesk = (c.props || []).length;
      // 空台面切进"动手/检验"：这一拍学习者只有字可读。规则里那句"需要动手看就摆一件"
      // 是最弱的通道（每一回合都在场，模型照样走过）；决策这一刻在工具返回值里点一次名。
      const emptyDesk =
        action === 'phase' && propsOnDesk === 0 && (c.phase === 'practice' || c.phase === 'assess')
          ? '｜这一拍台上没有道具，学习者只能读字。要他动手就交付一件（share_artifact 会自动上台），' +
            '这一拍确实不需要就往下讲，不用为摆而摆。'
          : '';
      return {
        ok: true,
        scene: { id: c.id, index: c.index, title: c.title, phase: c.phase, props: (c.props || []).map((p) => p.id) },
        note:
          (action === 'open' ? `第 ${c.index} 场已开场` : '台子已更新') +
          `：「${c.title}」· ${PHASE_LABELS[c.phase]}｜台上 ${propsOnDesk} 件${emptyDesk}`,
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }
}

// ---------------------------------------------------------------- 主循环

const MAX_STEPS = Number(process.env.SOCRATIC_MAX_STEPS || 24);

/** 流里多久没有任何事件就判定上游卡死。默认 120s。 */
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.SOCRATIC_STREAM_IDLE_TIMEOUT_MS || 120_000);

/**
 * 给模型事件流套一层空闲看门狗。
 *
 * 为什么必须有：上游 SSE 卡住时既不报错也不结束，`for await` 会永远等下去。
 * 那样学习者看到的是"一直在转圈"，而且服务端那个回合会永久占住这个 notebook
 * （后续消息全被 409 挡掉）。宁可超时报错，也不许无限等。
 */
async function* withIdleWatchdog(stream, { signal, idleMs, onSlow }) {
  const iterator = stream[Symbol.asyncIterator]();
  for (;;) {
    if (signal?.aborted) return;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'idle' }), idleMs);
    });
    const next = iterator.next().then((r) => ({ kind: 'next', r }));
    const race = await Promise.race([next, timeout]);
    clearTimeout(timer);

    if (race.kind === 'idle') {
      onSlow?.();
      // 丢弃这个悬空的 next，避免未处理的 rejection
      next.catch(() => {});
      iterator.return?.().catch(() => {});
      throw new Error(
        `模型流已经 ${Math.round(idleMs / 1000)} 秒没有任何输出。上游可能卡住了——可以在「模型配置」里换个模型，或检查该端点是否支持流式。`,
      );
    }
    if (race.r.done) return;
    yield race.r.value;
  }
}

/** 学习者作答的文本形态。工具结果和跨轮历史回放共用一份，别写两遍。 */
function answerText(payload) {
  const parts = [];
  if (Array.isArray(payload?.selected) && payload.selected.length) parts.push(`选择：${payload.selected.join('、')}`);
  if (payload?.text) parts.push(`补充说明：${payload.text}`);
  if (payload?.skipped) parts.push('学习者跳过了这个问题');
  return parts.length ? parts.join('\n') : '（学习者未作答）';
}

/**
 * 对话治理：长命笔记本的对话只保留"开头一句 + 最近一段"喂给模型。
 *
 * 为什么：对话是**最近发生的事**，不是模型的工作记忆——工作记忆是 Learning Graph +
 * Progress + 笔记（prompt.mjs 每回合注入）。全量历史一次喂给模型，长笔记本会越背越重，
 * 违背 runtime.md「抗上下文漂移靠缩短上下文，不靠加强记忆」；会话长度上限只约束单轮，
 * 跨会话的旧对话要靠这一刀收住。窗口只作用于模型输入，**落盘的对话一字不少**。
 *
 * 锚点：开头第一条用户消息（学习目标/起点）。别的旧消息都可以让位，它不能让——
 * 模型得知道自己这一本在学什么，哪怕翻了场。
 */
export function windowHistory(history, cap = MAX_DIALOGUE_MESSAGES) {
  if (!history || !history.length) return [];
  if (history.length <= cap) return history;
  const firstUser = history.find((m) => m.role === 'user');
  const rest = history.slice(-(cap - (firstUser ? 1 : 0)));
  const out = firstUser ? [firstUser] : [];
  for (const m of rest) {
    if (m !== firstUser) out.push(m); // 锚点已经在窗口里了就别重复
  }
  return out;
}

/**
 * 把落盘的对话还原成模型看得懂的样子。
 *
 * 题卡必须还原成 assistant 的 toolCall + toolResult：以前这里只回放正文，于是
 * 历史里每一条 assistant 都是 stopReason 'stop' 的纯文本——模型从自己的记录里
 * 学不到"我在这个应用里用工具提问"，讲十几轮就退回把问题写在正文里（题面以冒号
 * 结尾、卡片再也不出现），学习者的作答也彻底不在上下文里。实测一局 24 轮后发生。
 */
export function historyToModelMessages(history, model) {
  const out = [];
  for (const m of history || []) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content, timestamp: m.timestamp || Date.now() });
      continue;
    }
    if (m.role !== 'assistant') continue;
    const asked = (m.questions || []).filter((q) => q?.question);
    if (!m.content && !asked.length) continue;
    const content = [];
    if (m.content) content.push({ type: 'text', text: m.content });
    asked.forEach((q, i) => {
      const id = String(q.questionId || `q-${m.timestamp || Date.now()}-${i}`);
      const args = { id, question: q.question };
      if (q.header) args.header = q.header;
      if (q.conceptId) args.concept_id = q.conceptId;
      if (q.options?.length) args.options = q.options.map((o) => o.label);
      if (q.multiSelect) args.multi_select = true;
      content.push({ type: 'toolCall', id, name: TOOL_NAMES.ASK, arguments: args });
    });
    out.push({
      role: 'assistant',
      content,
      stopReason: asked.length ? 'toolUse' : 'stop',
      timestamp: m.timestamp || Date.now(),
      usage: m.usage,
      provider: model.provider,
      model: model.id,
    });
    // toolCall 后面必须紧跟对应的 toolResult，缺一条上游就会 400；没答的按"未作答"补全。
    asked.forEach((q, i) => {
      out.push({
        role: 'toolResult',
        toolCallId: String(q.questionId || `q-${m.timestamp || Date.now()}-${i}`),
        toolName: TOOL_NAMES.ASK,
        content: [{ type: 'text', text: answerText(q.answer) }],
        isError: false,
        timestamp: q.answer?.answeredAt || m.timestamp || Date.now(),
      });
    });
  }
  return out;
}

/**
 * 工具返回值裁剪：给前端明细卡看的版本。有些工具（get_learning_graph /
 * read_artifact_evidence）会返回整份 Graph 或上一个回合的产出，原样推给浏览器
 * 能把 SSE 撑爆。这里只做长度上限，不改变语义。
 */
function trimResult(result, limit = 20000) {
  let text;
  try {
    text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  } catch {
    text = String(result);
  }
  if (text.length <= limit) return result;
  return `${text.slice(0, limit)}\n…（工具返回过长，已截断；完整内容已交给模型）`;
}

/**
 * 跑一个教学回合。返回这一轮新增的消息（供落盘）。
 *
 * 不变量：只要有 observed 事件发生，就必须能在流里被看到——
 * 已经落盘的正文/状态不能因为流断掉而变成"发生过但没告诉前端"。
 *
 * @returns {Promise<{messages: object[], progress: object, graph: object}>}
 */
export async function runTurn({
  registry,
  notebook,
  history,
  modelRef,
  emit,
  signal,
  systemPrompt,
  onSession,
  onPersist,
  onPersistMessage,
  taskRunner = null,
  deskWriter = true,
  decision = null,
}) {
  const model = registry.resolveModel(modelRef);
  // taskRunner 必须一路传到 TeachingSession：spawn_subagent / run_background_task /
  // prepare_artifact 全靠它。以前 runTurn 收了却没往下传，六个工具在真实应用里
  // 一律回"这个会话没有配置任务运行器"，而单元测试是手工赋值绕过的，所以全绿。
  const session = new TeachingSession({
    registry,
    notebook,
    emit,
    signal,
    systemPrompt,
    taskRunner,
    // 分身/后台任务要用同一个模型跑，所以 modelRef 也得进 session（否则任务记录的 model 为空）
    modelRef,
    deskWriter,
    // 判定外包的注入口：宿主（serve/tasks）把面板配置好的 Decision 选项递进来；
    // null 时判定全走环境变量（没碰过配置面板的老行为）。
    decision,
  });
  // 把上一轮落盘的制品回报种子进来：跨轮续学 / 续玩时，read_artifact_evidence 才读得到之前发生了什么。
  // 这些是观测记录，不是状态——只喂给模型判断，不驱动任何转移。
  seedArtifacts(session, notebook.progress);
  onSession?.(session);
  const tools = buildTools();

  const messages = historyToModelMessages(windowHistory(history), model);

  const newMessages = [];
  const runOptions = {
    signal,
    // 让用户在配置里能选"思考强度"时透传
    ...(modelRef.reasoning ? { reasoning: modelRef.reasoning } : {}),
  };

  // step 提到循环外：循环结束后还要靠它判断"是自然收尾还是撞到步数上限"。
  let step = 0;
  for (; step < MAX_STEPS; step += 1) {
    if (signal?.aborted) break;

    const context = {
      systemPrompt,
      messages,
      tools,
    };

    emit({ type: 'status', phase: step === 0 ? 'thinking' : 'continuing', step });
    const stream = registry.models.stream(model, context, runOptions);

    for await (const event of withIdleWatchdog(stream, {
      signal,
      idleMs: STREAM_IDLE_TIMEOUT_MS,
      onSlow: () =>
        emit({
          type: 'status',
          phase: 'stalled',
          message: `上游 ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)} 秒没有输出，准备放弃这一轮`,
        }),
    })) {
      if (signal?.aborted) break;

      switch (event.type) {
        case 'text_delta':
          emit({ type: 'text_delta', delta: event.delta });
          break;
        case 'thinking_delta':
          emit({ type: 'thinking_delta', delta: event.delta });
          break;
        case 'toolcall_start': {
          const block = event.partial?.content?.[event.contentIndex];
          // 不外发 contentIndex：它只在这一侧有意义，ToolCall 块上没有同名字段。
          // 曾经把它抄进 tool_exec / tool_end，前端拿 undefined 配对，每次调用渲染出两张卡。
          emit({ type: 'tool_start', name: block?.type === 'toolCall' ? block.name : 'tool' });
          break;
        }
        case 'error':
          emit({
            type: 'error',
            message: event.error?.errorMessage || '模型请求失败',
            reason: event.reason,
          });
          break;
        default:
          break;
      }
    }

    // 中断时不再等 stream.result()：流已经被 signal 撕开，result() 可能永远不落地。
    // 这一轮就地收尾，终止事件由调用方的 finally 统一发（每条路径恰好一个）。
    if (signal?.aborted) break;

    const finalMessage = await stream.result();
    if (finalMessage.stopReason === 'error' || finalMessage.stopReason === 'aborted') {
      if (finalMessage.stopReason === 'error') {
        throw new Error(finalMessage.errorMessage || '模型请求失败');
      }
      break;
    }

    messages.push(finalMessage);
    const textBlocks = finalMessage.content.filter((b) => b.type === 'text');
    let stepMessage = null;
    if (textBlocks.length) {
      stepMessage = {
        role: 'assistant',
        content: textBlocks.map((b) => b.text).join(''),
        timestamp: Date.now(),
        usage: finalMessage.usage,
        thinking: finalMessage.content
          .filter((b) => b.type === 'thinking')
          .map((b) => b.thinking)
          .join(''),
      };
      stepMessage.msgId = `m-${step}-${Date.now()}`;
      newMessages.push(stepMessage);
    }

    const toolCalls = finalMessage.content.filter((b) => b.type === 'toolCall');

    for (const call of toolCalls) {
      let args = call.arguments ?? {};
      try {
        args = validateToolCall(tools, {
          ...call,
          arguments: unwrapStructuredArgs(call.name, call.arguments ?? {}),
        });
      } catch (err) {
        // 参数校验发生在我们的 exec 之前，所以模型只能拿到上游那句英文短语。
        // 补一行"下一步怎么做"：不给这句时它常常只补被点名的那一条、再撞第二次。
        const why = `参数校验失败：${err.message}${
          call.name === TOOL_NAMES.SAVE_GRAPH
            ? '\n（这次调用没有执行。把每一条都补齐后整份重发，不要只发改动的概念；同一 id 没写的字段会沿用上一版。若是把清单写成了字符串，改成数组本身再发。）'
            : '\n（这次调用没有执行。修正参数后重试。）'
        }`;
        messages.push({
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: 'text', text: why }],
          isError: true,
          timestamp: Date.now(),
        });
        // 也要在会话列里留一行：这次调用真的发生过、真的失败了，只是没跑到执行那一步
        emit({ type: 'tool_exec', name: call.name, args: call.arguments ?? {} });
        emit({ type: 'tool_end', name: call.name, ok: false, result: { ok: false, reason: why } });
        continue;
      }
      emit({ type: 'tool_exec', name: call.name, args });
      let result;
      let isError = false;
      try {
        result = await session.execTool(call.name, args);
        if (result && result.ok === false) isError = true;
      } catch (err) {
        if (signal?.aborted) {
          result = { ok: false, error: '回合已中断' };
        } else {
          result = { ok: false, error: err?.message || String(err) };
        }
        isError = true;
        emit({ type: 'error', message: result.error, recoverable: true });
      }
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text }],
        isError,
        timestamp: Date.now(),
      });
      emit({
        type: 'tool_end',
        name: call.name,
        ok: !isError,
        result: trimResult(result),
      });
      // 工具一执行完就落盘：中断/崩溃也不会丢掉刚建立的 Graph 或刚推进的状态
      onPersist?.(session);
    }

    // 这一步产出的制品挂到消息上，刷新页面后 renderThread 才能把它放回来。
    // 这一步没有文字时挂到上一条 assistant 消息——与 SSE 里的视觉顺序一致
    // （制品总是追加在当时已渲染出的正文之后）。一条都没有就造一条空壳：
    // 没有落脚点的话这件制品只剩 SSE 里那一次，刷新即永久消失。
    let host = stepMessage || newMessages[newMessages.length - 1];
    if (!host && (session.roundArtifacts.length || session.roundQuestions.length)) {
      host = {
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        msgId: `m-${step}-${Date.now()}`,
      };
      newMessages.push(host);
    }
    if (session.roundArtifacts.length) {
      if (host) host.artifacts = [...(host.artifacts || []), ...session.roundArtifacts];
      session.roundArtifacts.length = 0;
    }
    // 出过的题同理：题面 + 作答结果一起落盘，刷新后题目卡片才能原样恢复。
    // 时机在本步工具全部执行完之后——ask 是阻塞工具，走到这里 answer 必已就位
    //（除非回合被打断，那题就保持"未作答"状态回放）。
    if (session.roundQuestions.length) {
      if (host) host.questions = [...(host.questions || []), ...session.roundQuestions];
      session.roundQuestions.length = 0;
    }

    // 本步正文立刻落盘（artifacts / questions 挂完之后）。
    // 以前只在整轮 runTurn 返回时 appendChat 一次，于是刷新/中断/异常都会丢掉
    // 已经讲出来的内容——用户看到的就是"一刷新内容就没了"。
    // 带上 msgId，宿主侧做幂等 upsert：同一条消息重复落盘是更新而不是追加。
    // 放在这里而不是循环顶部的 break 之前：纯正文的收尾 step 也走这条路径，
    // 否则最后一段话（往往是最重要的总结）永远不落盘。
    // 场是中间列的分组单元：这一步的正文/道具/题属于哪一场，消息就带哪一场的 id。
    // 只打一次、打过不改——一条消息归它开始那场。跨场时若允许后一场把它重标，
    // 上一场的正文就会从上一场的格子里消失（同一 msgId 反复 upsert 时最容易犯的错）。
    if (host && host.sceneId == null && session.scene?.current) host.sceneId = session.scene.current.id;
    if (host) onPersistMessage?.(host);

    // 没有工具调用 = 模型这一轮说完了。正常收尾，不报错。
    if (toolCalls.length === 0) break;

    // 有工具调用 → 继续下一 step，把 toolResult 交回模型
  }

  // 撞到步数上限而停，是"这一轮被腰斩"而不是"老师讲完了"：必须让学习者看见，
  // 否则界面看起来像正常收尾，没人知道后面还有一串工具没跑。
  if (step >= MAX_STEPS && !signal?.aborted) {
    emit({
      type: 'status',
      phase: 'step_limit',
      message: `这一轮的工具调用到了上限（${MAX_STEPS} 步）被中止，后面可能还有没做完的事。可以直接说"继续"接着跑。`,
    });
  }

  emit({
    type: 'progress',
    progress: session.progress,
  });

  return {
    messages: newMessages,
    progress: session.progress,
    graph: session.graph,
    graphDirty: session.graphDirty,
    progressDirty: session.progressDirty,
    events: session.pendingEvents,
    artifacts: session.artifacts,
  };
}
