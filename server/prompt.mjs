// 把教学规则编译成运行时 system prompt。
//
// rules/*.md 是这个应用的运行时输入：每个回合原样读出来注入，改教学行为就改那几份 markdown，
// 不用动任何 .mjs。后面接一段「你现在运行成一个 Web 应用」的适配说明，把规则里依赖宿主能力的
// 动作映射到应用实际提供的工具上。

import fs from 'node:fs';
import path from 'node:path';
import { RULES_DIR, MAX_DIALOGUE_MESSAGES } from './config.mjs';
import { topoSortConcepts } from './graph.mjs';
import { stateWord } from './store.mjs';
import { renderSceneSnapshot } from './scene.mjs';

const RULE_FILES = [
  ['main.md', '总则：主流程 / 关键门禁 / 表现能力'],
  ['protocols.md', '协议 / 不变量 / Learning Graph 结构 / PATCH 契约 / 制品协议'],
  ['runtime.md', 'Runtime：mastery 状态机、主循环、Loop Control、输出风格、持久化契约'],
  ['pedagogy.md', '学科变体、学习深度档、教学动作路由'],
  ['artifact.md', '制品：认知路径、素材、视觉判据、题型与证据、交互事件流水线'],
];

let cachedRulesText = null;

export function loadRulesText({ force = false } = {}) {
  if (cachedRulesText && !force) return cachedRulesText;
  const parts = [];
  for (const [rel, label] of RULE_FILES) {
    try {
      const text = fs.readFileSync(path.join(RULES_DIR, rel), 'utf8');
      parts.push(`\n\n===== ${rel} — ${label} =====\n\n${text}`);
    } catch {
      parts.push(`\n\n===== ${rel} — 读取失败（文件缺失） =====\n`);
    }
  }
  cachedRulesText = parts.join('');
  return cachedRulesText;
}

const APP_ADAPTER = `
===== 你现在运行的环境：Socratic Studio Web 应用 =====

上面那份规则是你在 Socratic Studio 里的完整工作方式。下面只说明"宿主能力映射"——规则里提到的
宿主能力在这里分别对应什么，其余规则一条不改。

## 一次回合 = 一次 agentic 循环

学习者发一条消息，你开始一个回合。你在这个回合里可以连续调用工具，每次工具结果都会交回给你，
直到你不再调用工具为止。**一条消息 = 一个教学动作** 这条硬规则照旧：不要在一条 assistant 消息里
叠「讲解 + 题目 + 反馈」。

## 工具映射

| 规则里说的 | 在这个应用里用 |
|---|---|
| **"演"的单位：一场戏** | \`run_scene\`。中间列按「场」分段——一场 = 一段连续的教学（一个概念的讲→做→验），场名与相位（open/teach/practice/assess/close）就是这一段的抬头，正文、题卡、道具都落进这一场的格子里。**台子没有时钟**：你不点它，它就停在当前相位，学习者的沉默不是换场信号；一个回合通常只开一场，别把场开碎。道具跨场不清台（上一场摆的还在台上，能接着玩），\`place\` 用来把以前那场的旧道具再点名摆回当前场。学习者扔掉的道具摆不回来——放回是他的手势。 |
| 平台原生问题控件（收答，只收答不判分） | \`ask_user_question\`。答案可枚举的探针/预测/练习/门禁确认必须用它收答，不要在正文里写 A/B/C。开放式提问（要学习者说出推理过程）给 question、不给 options。排序/分桶/拖拽这类表达不了的结构不要硬塞成选项——退回让他用自己的话产出。**调用它会阻塞本回合直到学习者作答**，他的作答会作为工具结果回到你手里。**每次都要填 \`concept_id\`**（这道题在探哪个概念；事务性提问填 \`none\`）——学习者一答，应用就凭它把那一格从 Unknown 记成 Seen，不用你调工具。 |
| 生成 Learning Graph（DECOMPOSE 后） | \`update_learning_graph\`。保存前会走 protocols.md 的严格校验，校验不过会把具体问题回给你，请修正后重试。 |
| Progress State 持久化 | 应用自动落盘（progress.json）。\`set_progress_state\` 是**你**推进状态的唯一入口（应用自己只写 §1.2 那条无条件的 Unknown→Seen，其余每一级都归你）。转换规则（runtime.md §1.2）由应用强制执行：一次只升一级；升级必须带 observed 证据；自报未验证的 concept 单次概念错误即降一级。被拒绝的转移会告诉你原因，按规则重来。 |
| 内联可视化 / 交互物件 / 实战项目 / 游戏 | \`share_artifact\`。HTML 由你依据内容本身从零撰写，内联渲染在当前这一轮；**每一件都落盘，有稳定地址、能续玩、也能被学习者扔掉**（道具是有寿命的东西，不是一段贴完就没的正文）。**制品只给现象，不解释原因、不判对错、不藏答案键**（Invariant 4 第 ③ 条）。交互运行时由应用自动注入，**不要自己写 script 标签引用它**。两条回报通道：① 答卷型用 \`data-interaction\` / \`data-choice-id\` / \`data-concept-id\` / \`data-question-id\` 标注；② 项目/游戏/模拟器在脚本里调 \`window.SocraticStudio.report(state)\` 与 \`.emit(name, payload)\`。跨轮续玩带 \`initial_state\`。canvas / WebGL / 任意 JS 都能跑（沙箱里不引 CDN、不 fetch 外部文件；他真去取外部文件时宿主会回一条 \`csp_blocked\` 事件，读回来就能说清那条路走不通）。 |
| **读回学习者在制品里做了什么** | \`read_artifact_evidence\`。**这是页面型制品唯一的证据通道。** 它返回三类内容：① 答卷型交互的 evidence（作答次数/结果/作答内容）；② 项目或游戏的 state 快照（关卡、尝试次数、当前参数这类客观事实）；③ 离散 events（level_cleared / bug_found 等）。没有它就不能说学习者"在制品里试过了"——那属于凭感觉，违反 Invariant 4。**没有记录也不等于他没做**，别拿缺记录当判定依据。 |
| **反过来：让制品当场改变** | \`push_artifact_command\`。给还开着的制品下发指令——切换关卡、注入一个 bug、改参数。制品用 \`window.SocraticStudio.onCommand((name, payload) => …)\` 订阅。学习者关掉页面后指令作废，那时退回对话讲。 |
| 读回当前 Graph 与学习状态 | \`get_learning_graph\`。续学、写讲解或制品、判断下一步之前先读。 |
| PATCH 写入 feedback | \`propose_graph_patch\`。high 置信度由应用直接合并；medium/low 落成待确认记录，你需要把它译写成自然语言问学习者。 |
| 事件审计 | \`record_learning_event\`（kind: observed | inferred）。inferred 只供审计，永不用于推进 state。 |
| **动手前先对齐计划** | \`present_plan\`。DECOMPOSE 之后、要连续做多步讲解或练习之前、要改变既定路线之前，把打算做的事讲给学习者听，**阻塞到他批准或提意见**。他批准你再继续；他提意见就把意见并进去。一条消息 = 一个教学动作这条规则照旧——计划不是把多个动作塞进一条消息的许可证。 |
| **让学习者看见进度** | \`update_todo_list\`。一个回合通常不止一步（建 Graph / 出探针 / 讲解 / 练习 / 复盘），用它让学习者知道你现在到哪儿了。整体替换，不是追加。它是 UI 便签，**不是学习状态**——别用它推进 state，也别往里写分数。 |
| **耗时的活不要陪着干等** | \`run_background_task\` 立刻返回、不占本回合；\`read_background_task\` / \`list_background_tasks\` / \`stop_background_task\` 收结果。适合整理长篇素材、预生成题目这类学习者不必现场等的事。别用它逃避需要即时判断的教学动作。 |
| **派个分身去查一件事** | \`spawn_subagent\`（**阻塞**，当场拿到结论）。适合查证、起草、试算。分身碰不到学习状态、不会向学习者提问——它的结论只是素材，判断仍归你。**不许把分身做过的事说成学习者做过。** |
| **收一条结构化笔记** | \`compile_notes\`。**讲完一个知识点之后调一次**（title + summary + key_points[≤8] + example + concepts），立刻落进学生的「笔记」页，刷新不丢、可导出。这是学生最后能带走的那份东西——不要每条 text_delta 都调，一个点讲透了再收。不需要分身，你刚讲过，你最清楚要点。 |
| **大件制品异步做** | \`prepare_artifact\`（**立刻返回**，不卡本回合）。实战项目、关卡游戏、可探索模拟器这类要写几千行 HTML 的，把"要做什么"写进 spec 交给分身后台做，做好由宿主摆进学习者当前这一场的台上（你不用替他 place）。你不必自己写 HTML。**小件（示意图、简单交互）仍用 \`share_artifact\` 当场交付**——当场的演示不该让位给后台。 |
| 学习者上传的素材 | 消息里会带「素材」区块。文本类内容直接给你；图片会以图像块给你（需要当前模型支持视觉）。PDF 若只给了说明，按 main.md 的降级路径办：请学习者粘贴关键段落，不要凭空编造。学习者也可以用输入框里的 \`@\` 精确引用某一份素材。 |
| **判定类决策外包** | \`jev_judge\`。判对/判错、证据是否支撑主张、在候选中选下一步——这类**判定**交给专用决策模型（JEV），你负责提供证据（作答原文/制品内容/工具回执）与标准。三条纪律：① probability 只是置信度不是正确率，它判 needs_review 时别硬拗，补证据或问学习者；② 证据不足就如实 unknown/needs_review，低概率硬凑比不判更糟；③ 每次判定都会留痕。**手续类绝不外包**：状态转移合法性、证据归一化、自报未验证打标、一次一级，还是你自己的活。没配 key 时工具会明说并跳过，退回自行判断，不假装判过。 |

## 会话边界

应用会在你每次回合前把当前 Graph、Progress State 与本轮待办快照注入到本提示末尾的
「当前学习状态」区块。跨回合的续学靠它，不靠记忆。
session 长度上限按 meta.learner_profile.pace 执行（runtime.md 的 pace 表）。

## 输出风格

用 Markdown 写正文。正文面向学习者——**永远不要出现内部字段名或状态机英文标签**（不写
\`state: Seen\`、不写 \`next_action\`、不写 concept_id）。要提进度就用 runtime.md §1.5 的对外词
（待学 / 正在学习 / 已学懂 / 正在练习 / 已掌握），要提概念就用它的 name。

**绝不产出数值化的学习量**：没有百分比、分数、星星、进度条、等级认证、横向比较。进步由
"之前能做什么 → 现在能做什么"的文字描述体现。

**要停下来等学习者回答，就用 \`ask_user_question\`——门禁确认也算。** 写在正文里的提问不会阻塞
回合：他只能看到一句话挂着问号，得自己打字；而且下一轮回放历史时，这次确认在记录里什么都不留下，
你会把同一段话再讲一遍。只有组件真的不可用时才降级为正文提问，那时确认标记单独成行、不要放进
引用块（\`> ⛔ 等待你的确认\` 会被渲染成引用，看起来像还在继续说话而不是停下来等人）。

**公式**用 LaTeX 写法：行内 \`$...$\`，独立成行 \`$$...$$\`。界面会把它渲染成等宽公式块。
`;

/**
 * 回马枪候选：按 question_id 分组，只留"最后一次仍判错、之后没有判对"的那些。
 *
 * 证据记录里没有时间戳（`agent.mjs` 归一化时就没这个字段），所以间隔只能按回合算：
 * 这一轮读到候选、下一轮重测，本身就隔着至少一次完整回合。别把它当成"隔了几天"的间隔重复。
 */
function retestCandidates(evidence, cap = 3) {
  const byQuestion = new Map();
  for (const e of evidence) {
    if (!e.question_id) continue;
    const list = byQuestion.get(e.question_id) || [];
    list.push(e);
    byQuestion.set(e.question_id, list);
  }
  const out = [];
  for (const [qid, list] of byQuestion) {
    const last = list[list.length - 1];
    if (last.result !== 'incorrect') continue;
    out.push({
      qid,
      concept: list.find((e) => e.concept_id)?.concept_id || null,
      attempts: Number(last.attempts) || 0,
      response: String(last.response ?? '').slice(0, 80),
      at: evidence.indexOf(last),
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, cap);
}

/** 每次回合注入的动态状态快照。 */
export function renderStateSnapshot(notebook) {
  const graph = notebook.graph;
  const progress = notebook.progress;
  const lines = ['\n===== 当前学习状态（每回合自动注入，续学靠它） =====\n'];

  lines.push(`主题：${graph?.meta?.topic || notebook.topic || '（尚未分解）'}`);
  if (graph?.meta?.goal) lines.push(`学习者来时的目标：${graph.meta.goal}`);
  if (graph?.meta?.pedagogy) lines.push(`教学策略标签：${graph.meta.pedagogy}`);
  const profile = graph?.meta?.learner_profile;
  if (profile?.background) lines.push(`学习者背景：${profile.background}`);
  if (profile?.pace) lines.push(`节奏档：${profile.pace}`);

  // 台子现在怎么摆：第几场、演到哪个相位、台上留着哪几件道具。
  // 只在真开过场之后才出话——没开场的兜底句只会让模型以为机器坏了去补一刀。
  const desk = renderSceneSnapshot(notebook.scene);
  if (desk) lines.push(desk);

  const concepts = graph?.concepts || [];
  if (!concepts.length) {
    lines.push('\nLearning Graph：尚未建立。走 PARSE → CLARIFY（必要时）→ DECOMPOSE，然后调 update_learning_graph 并请学习者确认。');
  } else {
    let ordered;
    try {
      ordered = topoSortConcepts(graph);
    } catch {
      ordered = concepts;
    }
    lines.push(`\nLearning Graph（${concepts.length} 个概念，按依赖排序）：`);
    for (const c of ordered) {
      const p = progress?.concepts?.[c.id];
      const word = p ? stateWord(p.state) : '待学';
      const flag = p?.unverified_self_report ? '（自报，未验证）' : '';
      lines.push(
        `- ${c.name} [${c.id}] — ${word}${flag}｜${c.summary}` +
          (c.depends_on?.length ? `｜前置：${c.depends_on.join(', ')}` : '') +
          (c.misconceptions?.length ? `｜易错：${c.misconceptions.join('；')}` : ''),
      );
      if (p?.next_action) lines.push(`    下一步计划：${p.next_action}`);
      if (p?.note) lines.push(`    观察：${p.note}`);
    }
  }

  // 讲义笔记学生可以在「笔记」页直接改，所以盘上的版本可能已经不是老师写的那一版了。
  // 不告诉模型这一点，它会按自己记忆里的旧版再收一条——两条并存，学生改的那条反而被淹没。
  const handout = notebook.notes || [];
  if (handout.length) {
    lines.push('\n学生「笔记」页上已有的讲义（标了〔学生改过〕的以学生的版本为准：别改写它、别为同一个点再收一条）：');
    for (const n of handout.slice(-10)) {
      lines.push(`- ${n.title}${n.edited_by === 'user' ? '〔学生改过〕' : ''}：${n.summary}`);
    }
  }

  const notes = progress?.notes || [];
  if (notes.length) {
    lines.push('\n本轮 session 的备注（含"某种讲法对这位学习者无效"这类记仇项）：');
    for (const n of notes.slice(-12)) lines.push(`- ${n.text}`);
  }

  const patches = notebook.patches?.patches || [];
  const pending = patches.filter((p) => !p.applied);
  if (pending.length) {
    lines.push('\n待确认的 Graph 改动（译写成自然语言问学习者，不要原样打印字段）：');
    for (const p of pending) {
      lines.push(`- [${p.confidence}] ${p.operation} ${p.target} — ${p.reason}`);
    }
  }

  // 本轮待办只是 UI 便签，供你知道"学习者眼前正显示着哪几步"。
  const todos = notebook.todos || [];
  if (todos.length) {
    const done = todos.filter((t) => t.status === 'completed').length;
    lines.push(`\n本轮待办（学习者右侧可见，${done}/${todos.length} 已完成）：`);
    for (const t of todos) {
      const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]';
      lines.push(`- ${mark} ${t.content}`);
    }
  }

  const evidence = progress?.artifact_evidence || [];
  if (evidence.length) {
    lines.push('\n学习者在制品（页面型交互物件）里做过的操作（DOM 快照，不是结论）：');
    const byQuestion = new Map();
    for (const e of evidence.slice(-40)) {
      const key = e.question_id || e.artifact_id || '(未标注题号)';
      if (!byQuestion.has(key)) byQuestion.set(key, []);
      byQuestion.get(key).push(e);
    }
    for (const [key, list] of byQuestion) {
      const concept = list.find((e) => e.concept_id)?.concept_id;
      const last = list[list.length - 1];
      lines.push(
        `- ${key}${concept ? `（concept: ${concept}）` : ''}：记录到 ${list.length} 次操作，` +
          `最后一次结果 ${last.result || '未判定'}，作答内容「${String(last.response ?? '').slice(0, 120)}」` +
          (last.completed ? '，已完成' : '，尚未完成'),
      );
    }
  }

  const retests = retestCandidates(evidence);
  if (retests.length) {
    lines.push('\n回马枪候选（最后一次判错、之后没有判对的题）：');
    for (const r of retests) {
      lines.push(
        `- ${r.qid}${r.concept ? `（concept: ${r.concept}）` : ''}：错过 ${r.attempts} 次，` +
          `最后一次答「${r.response || '（空）'}」`,
      );
    }
    lines.push(
      '  开场先重测其中一条：换一种说法、30 秒内能答完，不要照抄原题；' +
        '学习者推着要推进新内容就顺延到本回合收束前。判对就说清上次错在哪一步，判错才考虑讲法又没接住。',
    );
  }

  const artState = progress?.artifact_state || {};
  const stateIds = Object.keys(artState);
  if (stateIds.length) {
    lines.push('\n制品 / 项目 / 游戏的状态快照（客观事实，不是结论）：');
    for (const id of stateIds) {
      const s = artState[id];
      const brief = Object.entries(s)
        .filter(([k]) => k !== 'note' && k !== 'hint')
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join('，');
      lines.push(`- [${id}] ${brief.slice(0, 300)}`);
    }
  }

  const artEvents = progress?.artifact_events || [];
  if (artEvents.length) {
    lines.push('\n制品里发生过的离散事件（只追加的事实流水）：');
    for (const e of artEvents.slice(-25)) {
      const payload = e.payload ? ` ${JSON.stringify(e.payload).slice(0, 160)}` : '';
      lines.push(`- ${e.name}${payload}`);
    }
    // 道具寿命由学习者管，这一手很容易被误读成"他不干了"。只在真出现过时才说这一句。
    if (artEvents.some((e) => e.name === 'artifact_retired' || e.name === 'artifact_restored')) {
      lines.push(
        '  artifact_retired / artifact_restored 是学习者对道具本身做的动作（从台上撤下 / 放回去），' +
          '文件和他在里面做过的记录都还在：它只说明工作集变了，不说明他对这个概念的去留，别拿去劝。',
      );
    }
  }

  if (!evidence.length && !stateIds.length && !artEvents.length) {
    lines.push(
      '\n制品回报：本轮没有记录。没有记录不等于学习者没做，只是没读到可记录的内容——' +
        '需要证据时让他在制品里操作，再调 read_artifact_evidence 读回。',
    );
  } else {
    lines.push(
      '  以上都是机械记录，不是结论。题目是否属于当前 concept、有没有过期重复、算不算概念错误，都由你判断。',
      '  反过来也一样：没有读到的部分不要补全成"他一定做了什么"，没有记录也不等于他没做。',
      '  也不要因为状态里写着 level=3 就宣布"已经掌握"——那需要可观测事件与至少两次 Applied 级练习。',
    );
  }

  return lines.join('\n');
}

export function buildSystemPrompt(notebook) {
  const parts = [loadRulesText(), APP_ADAPTER, renderStateSnapshot(notebook)];
  // 对话治理必须明说：窗口只作用于模型输入，落盘的对话一字不少，但**模型读不到窗口外的旧轮**。
  // 不说明白，模型可能凭印象编造学习者早先说过的话；要回想，先读「笔记」页与图谱。
  if ((notebook.chat?.messages?.length || 0) > MAX_DIALOGUE_MESSAGES) {
    parts.push(
      '\n===== 对话窗口说明 =====\n\n' +
        '本会话的对话在模型输入侧做了窗口化：只保留开头一句（学习起点）与最近一段，' +
        '更早的旧轮不在你的上下文里。那些内容**一字未删**，都在「笔记」页与概念图谱里。' +
        '需要回想早先说过的话时，先读笔记/图谱，不要凭印象编造。',
    );
  }
  return parts.join('\n\n');
}
