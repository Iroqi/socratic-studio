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
import { DATA_DIR, SETTINGS_FILE, CREDENTIALS_FILE, readJsonSafe } from './config.mjs';
import { notebookExists } from './store.mjs';
import { runTurn } from './agent.mjs';
import { panelDecisionOpts } from './decision.mjs';

/*
 * store.mjs 不 import tasks/agent（第十九轮注释里那条"反向依赖会成环"说的是 store→tasks），
 * tasks→store 是顺着已有依赖图走的（agent→store 早就在），这一口不会成环。
 */

/*
 * 这里原来有一份**局部的** readJsonSafe（同名遮蔽了 config.mjs 导出的那一份）：
 * try/parse/catch 回去就完事。全仓其他读 JSON 的地方（store/notes/providers）用的都是
 * config.mjs 那一份——解析失败会留 `.corrupt-` 副本并喊话。settings.json / credentials.json
 * 走分身这条路读坏时，旧的局部版本静默兜成默认值：没证据、没喊话，坏了查无实据（第十八轮）。
 * 删掉局部版本，用唯一的那个读取口。
 */
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

/** 盘上写着 running、可这台进程里没有它的句柄时，如实说一句话。 */
const INTERRUPTED_NOTE = '服务重启时这个任务还挂着，它跟着上一进程一起没了——这里读回来时如实标成已中断。';

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

  /**
   * 把 jobs/*.json 从盘上读回来。落盘只是承诺的一半，回读才是兑现的那一半（第十九轮）：
   * 原来这里只写不读，注释却写着「刷新/重启后还能翻出来」——重启后 list/get 只看内存 Map，
   * 盘上那些记录一条都翻不出来（探针 19-A 实测：重启后 GET /tasks 0 条，盘上还有 1 条）。
   *
   * 每条记录过一道 statusFor：内存里正拿着句柄的活任务照原样，句柄不在这台进程里的
   * running 记录如实读成 interrupted——服务被杀时任务其实跟着死了，盘上那条永远停在
   * running（探针 19-C），把它读成「进行中」就是撒谎。
   *
   * 顺带把僵尸就地治好：读回来时状态与盘上不一致（running → interrupted）就补写回文件一次，
   * 只改 status/finishedAt/note 三个字段。不补写的话，同一份谎每刷新一次页面就要重圆一次。
   * 补写只可能发生在重启之后（活任务在 statusFor 那一步就是 running），不动写盘热路径。
   */
  _hydrate(notebookId) {
    if (!notebookId) return;
    const dir = this.jobsDir(notebookId);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return; // 还没有 jobs 目录 = 这个学习没派过任务，正常状态
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const record = readJsonSafe(path.join(dir, name), null);
      if (!record || typeof record !== 'object' || typeof record.id !== 'string') continue;
      // 内存优先：活任务的句柄、增量输出都在这里，盘上那份可能落后好几秒
      if (this.tasks.has(record.id)) continue;
      // 不属于这一本的记录不认领（防串台，也防手改文件把任务塞进别人家）
      if (record.notebookId && record.notebookId !== notebookId) continue;
      const view = this.statusFor(record);
      if (view.status === 'interrupted' && record.status === 'running') {
        // 补写只在服务重启之后发生（此时这条记录必是僵尸），所以不碰活任务的写盘热路径
        record.status = 'interrupted';
        record.finishedAt = record.finishedAt || new Date().toISOString();
        record.note = INTERRUPTED_NOTE;
        try {
          fs.writeFileSync(path.join(dir, name), `${JSON.stringify(record, null, 2)}\n`);
        } catch {
          /* 补写失败不影响读回来的这份视图 */
        }
      }
      this.tasks.set(record.id, record);
    }
  }

  /**
   * 一条记录**现在**是什么状态——所有对外视图都过这一道（list / get / 导出 / stop 的拒绝话术）。
   * 判据是「这台进程还拿着它的句柄吗」，不是盘上那个字段写了什么：服务被杀时任务跟着死了，
   * 盘上却永远停在 running（探针 19-C）。也不看 createdAt 猜时间窗——`_create` 落盘与
   * `run()` 装上 abort 是紧挨着的两步，任何"刚写完盘就该算死"的猜测都会把活任务判成死的。
   */
  statusFor(record) {
    const live = this.tasks.get(record.id);
    if (live?.abort && live.status === 'running') return { ...record, status: 'running' };
    if (record.status === 'running') {
      return { ...record, status: 'interrupted', note: record.note || INTERRUPTED_NOTE };
    }
    return { ...record };
  }

  /**
   * 往 jobs/ 落一份记录。学习已经不在（没有 notebook.json）就一枪不发——
   * `mkdirSync(dir, { recursive: true })` 会把整个笔记本目录（连带 jobs/）从无到有 mkdir 回来，
   * 于是"删掉的学习"被一个还在收尾的分身复活成鬼目录（探针 20-A：只有 jobs/*.json、
   * GET 整本 404、GET /tasks 却 200、体检还把它数成一本书）。落盘纪律的第一条是
   * **别往不该存在的目录里写**。
   */
  _writeJob(notebookId, record) {
    if (!notebookExists(notebookId)) return false;
    const dir = this.jobsDir(notebookId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    return true;
  }

  /** 建一条任务记录并落一个文件，重启后还能翻出来（_hydrate 负责翻）。 */
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
      status: 'running', // running | done | failed | stopped；盘上是 running 但本机没句柄时读成 interrupted
      model: modelRef ? { provider: modelRef.provider, model: modelRef.model } : null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      output: '',
      error: null,
    };
    this.tasks.set(id, record);
    try {
      this._writeJob(notebookId, record);
    } catch {
      /* 落盘失败不影响主流程 */
    }
    this.onEvent({ type: 'task_start', task: publicView(record) });
    return record;
  }

  _finish(record, { status, output, error }) {
    record.status = status;
    record.finishedAt = new Date().toISOString();
    if (output !== undefined) record.output = String(output).slice(0, 20000);
    if (error !== undefined) record.error = String(error).slice(0, 4000);
    try {
      this._writeJob(record.notebookId, record);
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
    this._hydrate(notebookId);
    const out = [];
    for (const r of this.tasks.values()) {
      if (notebookId && r.notebookId !== notebookId) continue;
      if (kind && r.kind !== kind) continue;
      out.push(publicView(this.statusFor(r)));
    }
    out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return out;
  }

  /**
   * 按 id 取一条。不知道它属于哪本时给 notebookId 没用，所以按文件名直接查盘：
   * 重启后 read_background_task 问的正是这种来路不明的 id。
   */
  get(id) {
    const r = this.tasks.get(id);
    if (r) return publicView(this.statusFor(r));
    const recovered = this._findById(id);
    return recovered ? publicView(this.statusFor(recovered)) : null;
  }

  /** id 长这样：`job-<base36 时间>-<base36 序号>` 或 subagent 的 `sub-…`；文件名就是 id.json。 */
  _findById(id) {
    const safe = typeof id === 'string' ? id : '';
    if (!/^(job|sub)-[0-9a-z]+-[0-9a-z]+$/.test(safe)) return null;
    // id 前缀与 kind 是一对（subagent 才有 sub- 前缀），对不上就是被人动过的文件
    const expectKind = safe.startsWith('sub-') ? 'subagent' : 'background';
    let notebooks;
    try {
      notebooks = fs.readdirSync(path.join(DATA_DIR, 'notebooks'));
    } catch {
      return null;
    }
    for (const nbId of notebooks) {
      const file = path.join(this.jobsDir(nbId), `${safe}.json`);
      if (!fs.existsSync(file)) continue;
      const record = readJsonSafe(file, null);
      if (!record || typeof record !== 'object' || record.id !== safe || record.kind !== expectKind) continue;
      record.notebookId = record.notebookId || nbId;
      this.tasks.set(safe, record);
      return record;
    }
    return null;
  }

  /**
   * 停一个任务。传 notebookId 时必须真是这一本的任务（第十九轮：路由取了 URL 里的
   * :id 却根本没用，A 本 200 停掉了 B 本的任务——守卫要长在动手的那一侧）。
   */
  stop(id, notebookId = null) {
    let r = this.tasks.get(id);
    if (!r) {
      const disk = this._findById(id);
      if (!disk) return { ok: false, error: `没有这个任务: ${id}` };
      r = disk;
    }
    if (notebookId && r.notebookId !== notebookId) {
      // 标上 crossNotebook 让路由层如实翻译成 404：这一本下面没有这个任务
      return { ok: false, crossNotebook: true, error: `这个任务不属于当前学习（notebook=${r.notebookId || '?'}）` };
    }
    const view = this.statusFor(r);
    if (view.status === 'interrupted') {
      return { ok: false, error: '这个任务已经中断了（服务重启时它就跟着没了），没有还在跑的东西可停' };
    }
    if (view.status !== 'running') return { ok: false, error: `任务已经是 ${view.status}` };
    this._abort(r);
    return { ok: true, note: `已请求停止 ${r.title}` };
  }
}

/** 给外部的视图：不带 abort 句柄这类内部字段。 */
function publicView(record) {
  const { abort, ...rest } = record;
  return rest;
}
