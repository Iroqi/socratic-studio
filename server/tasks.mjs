// 后台任务与子 agent。
//
// 为什么需要：教学回合里有好几分钟是在"想"或"查"（step-5-preview 生成 13 个概念的
// Graph 时思考了 14170 token、约 87 秒）。让这些活阻塞在回合里，学习者就只能干等；
// 让 agent 派个分身去查资料，主回合也不用陪跑。
//
// 两种形态，同一套机器：
//   subagent         阻塞式，调用方当场拿到结论（"去查 X 然后告诉我"）
//   background       非阻塞，立刻返回 jobId，之后用 read/list/stop 收结果
//
// 隔离：每个任务跑在自己的 TeachingSession 上，操作的是 notebook 的结构化克隆，
// 且不挂 onPersist —— 所以它怎么也改不到学习者的 Progress State。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, SETTINGS_FILE, CREDENTIALS_FILE } from './config.mjs';
import { runTurn } from './agent.mjs';
import { panelDecisionOpts } from './decision.mjs';

/** 分身任务也用面板配置的 Decision 选项（没有就走环境变量，跟主回合一致）。 */
function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function decisionOptsForTasks() {
  return panelDecisionOpts({
    settings: readJsonSafe(SETTINGS_FILE, {}),
    credentials: readJsonSafe(CREDENTIALS_FILE, {})['jev'] || undefined,
  });
}

const HELPER_RULES = `
你现在是一个**分身**，被主教学会话派出来单独做一件事。你不是主讲老师。

硬规则：
- 只完成交代给你的这一件事，做完就用一段话给出结论。
- 不要向学习者提问、不要更新学习状态、不要改概念结构、不要交付制品——你不在对话里。
- 不要声称学习者做过什么。你手上只有交给你的事实。
- 结论要具体、可直接被主会话引用；拿不准就说拿不准，不要编。
`.trim();

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(counter += 1).toString(36)}`;

/** 制品分身的专用规则：它的活就是把 HTML 做出来交出去。 */
const ARTIFACT_HELPER = `
你现在是一个**制品分身**，被主教学会话派出来单独制作一份 HTML 制品。

硬规则：
- 只做这一份制品。做完用 share_artifact 交付，然后停。
- 不要向学习者提问、不要更新学习状态、不要改概念结构——你不在对话里。
- 制品只给现象，不解释原因、不判对错、不藏 correct 答案键。
- 单文件 HTML，不引 CDN，canvas/WebGL 可用；答完必须有明确的「下一步」入口。
- 交互运行时由宿主自动注入，不要自己写 script 引用它；要用 SocraticStudio.report/emit
  上报状态与事件（项目/游戏/模拟器），或用 data-interaction 系列属性标注答卷型交互。
`.trim();

export class TaskRunner {
  /**
   * @param {object} deps
   * @param {object} deps.registry  ProviderRegistry（可延后赋值）
   * @param {string|(() => string)} deps.rulesText 注入用的教学规则全文（子任务也吃同一套规则）
   * @param {(event: object) => void} [deps.onEvent] 任务事件转发给前端
   */
  constructor({ registry, rulesText, onEvent }) {
    this.registry = registry;
    this.rulesText = typeof rulesText === 'function' ? rulesText : () => rulesText;
    this.onEvent = onEvent || (() => {});
    this.tasks = new Map(); // id -> task record
  }

  /** registry 是启动后再补的（createRegistry 是异步的），子任务每跑一次读一次。 */
  get runner() {
    if (!this.registry) throw new Error('TaskRunner 还没有 registry');
    return { models: this.registry.models, resolveModel: (ref) => this.registry.resolveModel(ref) };
  }

  jobsDir(notebookId) {
    return path.join(DATA_DIR, 'notebooks', notebookId, 'jobs');
  }

  /** 建一条任务记录并落一个空文件，刷新/重启后还能翻出来。 */
  _create({ notebookId, kind, title, instructions, parentId = null, modelRef, helper = null }) {
    const id = nextId(kind === 'subagent' ? 'sub' : 'job');
    const record = {
      id,
      kind,
      notebookId,
      parentId,
      title: String(title || instructions || '未命名任务').slice(0, 120),
      instructions: String(instructions || ''),
      helper,
      status: 'running', // running | done | failed | stopped
      model: modelRef ? { provider: modelRef.provider, model: modelRef.model } : null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      output: '',
      error: null,
    };
    this.tasks.set(id, record);
    const dir = this.jobsDir(notebookId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    this.onEvent({ type: 'task_start', task: publicView(record) });
    return record;
  }

  _finish(record, { status, output, error }) {
    record.status = status;
    record.finishedAt = new Date().toISOString();
    if (output !== undefined) record.output = String(output).slice(0, 20000);
    if (error !== undefined) record.error = String(error).slice(0, 4000);
    try {
      const dir = this.jobsDir(record.notebookId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    } catch {
      /* 落盘失败不影响主流程 */
    }
    this.onEvent({ type: 'task_end', task: publicView(record) });
  }

  _abort(record) {
    record.abort?.abort();
  }

  /**
   * 跑一个任务。返回 Promise<record>；background 形态由调用方自行不管它。
   */
  async run(record, { notebook }) {
    const controller = new AbortController();
    record.abort = controller;
    const helper =
      record.helper ||
      HELPER_RULES;
    const systemPrompt = [
      typeof this.rulesText === 'function' ? this.rulesText() : this.rulesText,
      `\n\n===== 你是一个分身任务 =====\n${helper}`,
    ].join('');

    const childHistory = [
      { role: 'user', content: record.instructions, timestamp: Date.now() },
    ];

    try {
      const result = await runTurn({
        registry: this.runner,
        notebook: structuredClone(notebook),
        history: childHistory,
        modelRef: record.model ?? undefined,
        emit: (e) => {
          // 制品类分身做出的 HTML 交给宿主：原样往上抛，由宿主摆进学习者当前这一场的台
          if (e.type === 'artifact') {
            this.onEvent({ type: 'task_artifact', taskId: record.id, artifact: e.artifact });
          }
        },
        signal: controller.signal,
        systemPrompt,
        decision: decisionOptsForTasks(),
        // 分身拿的是派出那一刻的 notebook 克隆：它一写 scene.json 就用旧台面盖掉老师
        // 在这之后的每一手（实测：第二场连台上的道具一起退回第一场）。上台归宿主。
        deskWriter: false,
      });
      const text = (result.messages || [])
        .map((m) => m.content)
        .filter(Boolean)
        .join('\n\n')
        .trim();
      this._finish(record, { status: controller.signal.aborted ? 'stopped' : 'done', output: text });
    } catch (err) {
      const stopped = controller.signal.aborted;
      this._finish(record, {
        status: stopped ? 'stopped' : 'failed',
        error: err?.message || String(err),
      });
    }
    return record;
  }

  /** 阻塞式子 agent：派出去，等它做完，把结论交回调用方。 */
  async spawn({ notebook, modelRef, title, instructions }) {
    const record = this._create({ notebookId: notebook.id, kind: 'subagent', title, instructions, modelRef });
    await this.run(record, { notebook });
    return record;
  }

  /** 非阻塞后台任务：立刻返回记录。 */
  submit({ notebook, modelRef, title, instructions, parentId = null, helper = null, purpose = null }) {
    const record = this._create({
      notebookId: notebook.id,
      kind: 'background',
      title,
      instructions,
      parentId,
      modelRef,
      helper: helper ?? (purpose === 'artifact' ? ARTIFACT_HELPER : null),
    });
    // 不 await：调用方拿到 id 就走
    this.run(record, { notebook }).catch(() => {});
    return record;
  }

  list({ notebookId, kind } = {}) {
    const out = [];
    for (const r of this.tasks.values()) {
      if (notebookId && r.notebookId !== notebookId) continue;
      if (kind && r.kind !== kind) continue;
      out.push(publicView(r));
    }
    out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return out;
  }

  get(id) {
    const r = this.tasks.get(id);
    return r ? publicView(r) : null;
  }

  stop(id) {
    const r = this.tasks.get(id);
    if (!r) return { ok: false, error: `没有这个任务: ${id}` };
    if (r.status !== 'running') return { ok: false, error: `任务已经是 ${r.status}` };
    this._abort(r);
    return { ok: true, note: `已请求停止 ${r.title}` };
  }
}

/** 给外部的视图：不带 abort 句柄这类内部字段。 */
function publicView(record) {
  const { abort, ...rest } = record;
  return rest;
}
