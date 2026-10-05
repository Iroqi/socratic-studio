/**
 * 导演台：一场（Scene）的状态机。
 *
 * 没有内部时钟——相位只能被显式推进（模型调 run_scene，或学习者那一侧的手势）。
 * 任何东西都不许 setTimeout / setInterval / 「超过 N 分钟就换相位」。
 * 理由：一台自己会走的机器不是导演台，是放映机；学习者停下来想五分钟，台子不许替他往下演。
 *
 * 道具跨场不自动清台：这一场摆上去的道具留在台上，下一场还能接着玩（1a 给了稳定地址、
 * 1b 给了「扔掉」，这里给的是「还在台上」）。清台只有两个来源——学习者扔掉，或显式撤下。
 */

export const PHASES = ['open', 'teach', 'practice', 'assess', 'close'];

// 相位是教学动作的名字，前端要能直接说出来；这套词表跟规则里的教学循环对齐，不自造第二套。
export const PHASE_LABELS = {
  open: '开场',
  teach: '讲授',
  practice: '动手',
  assess: '检验',
  close: '收束',
};

export function emptySceneState() {
  return { version: 1, index: 0, current: null, log: [] };
}

function assertPhase(phase) {
  if (!PHASES.includes(phase)) {
    throw new Error(`未知相位: ${phase}（可用：${PHASES.join(' / ')}）`);
  }
  return phase;
}

/**
 * 开场。上一场不是「结束」是被盖过去：它连同当时台上的道具进 log，
 * 这样回看才知道第 2 场是从第 1 场的哪几件道具接着演的。
 */
export function openScene(state, { title, conceptId = null, phase = 'open' } = {}) {
  const clean = String(title || '').trim().slice(0, 60);
  if (!clean) throw new Error('开场要给一句话的场名');
  assertPhase(phase);
  const next = {
    id: `scene-${String((state.index || 0) + 1).padStart(2, '0')}`,
    index: (state.index || 0) + 1,
    title: clean,
    phase,
    conceptId: conceptId || null,
    // 承台：上一场留在台上的道具，本场一开始就有
    inheritedFrom: state.current ? state.current.id : null,
    props: state.current ? structuredClone(state.current.props || []) : [],
    openedAt: new Date().toISOString(),
  };
  const log = state.current ? [...(state.log || []), closeCurrent(state.current)] : [...(state.log || [])];
  return { version: 1, index: next.index, current: next, log };
}

function closeCurrent(current) {
  return { ...structuredClone(current), endedAt: new Date().toISOString() };
}

/** 换相位。不许顺带改别的：相位是这一场走到哪一拍，不是新的一拍。 */
export function setPhase(state, phase) {
  if (!state.current) throw new Error('还没开场，先把场开出来');
  assertPhase(phase);
  const current = { ...state.current, phase };
  return { ...state, current };
}

/** 摆道具上台。已经在了就只更新它被再次点名的记录——重复摆不是错误。 */
export function placeProp(state, prop) {
  if (!state.current) throw new Error('还没开场，先把场开出来');
  const id = String(prop?.id || '').trim();
  if (!id) throw new Error('摆道具要给制品 id');
  const current = { ...state.current };
  const props = [...(current.props || [])];
  const at = props.findIndex((p) => p.id === id);
  const row = { id, title: String(prop.title || id).slice(0, 60), rel: prop.rel || null };
  if (at >= 0) props[at] = row;
  else props.push(row);
  current.props = props;
  return { ...state, current };
}

/** 从台上撤下道具：只离开工作集，文件与证据一律留着（跟 1b 同一条纪律）。 */
export function removeProp(state, artifactId) {
  if (!state.current) return state;
  const id = String(artifactId || '').trim();
  const current = { ...state.current };
  const before = (current.props || []).length;
  current.props = (current.props || []).filter((p) => p.id !== id);
  if ((current.props || []).length === before) return state;
  return { ...state, current };
}

/**
 * 进 system prompt 的那一句。只在真开过场之后才出话——
 * 没开场时不许写「当前无场景」这种空转，那只会让模型以为机器坏了去补一刀。
 */
export function renderSceneSnapshot(state) {
  const c = state?.current;
  if (!c) return '';
  const props = (c.props || []).map((p) => `「${p.title}」(${p.id})`).join('、');
  // 承台那几件是 openScene 从上一场克隆进来的，**画面不在这一场上**：那张卡仍停在它被交付的那一拍里，
  // 台面上只有一行转场条指点。这句不说清，模型就照着「台上道具」讲"它就摊在你眼前"——
  // 而学习者看到的是一张收起来的场头。
  const from = (state.log || []).find((s) => s?.id === c.inheritedFrom) || null;
  const carried = from ? (c.props || []).filter((p) => (from.props || []).some((q) => q?.id === p?.id)) : [];
  const carry = carried.length
    ? `承台：${carried.map((p) => `「${p.title}」(${p.id})`).join('、')}是从第 ${from.index} 场接过来的。` +
      '它们的画面仍停在各自被交付的那一拍上，本场台面上只有一行转场条——要点开那一场才看得见，' +
      '别说成"已经摊在你眼前"；要让它回到眼前就重新摆一次（说清和上一场那是同一件）。'
    : '';
  const lines = [
    '',
    `## 导演台（第 ${c.index} 场）`,
    `场名：${c.title}｜相位：${PHASE_LABELS[c.phase] || c.phase}`,
    c.conceptId ? `正在取景的概念：${c.conceptId}` : '',
    // 道具只列名字与 id，不写"几件"这种数——可见面上不许多出一个数（Invariant 4 的黑名单，
    // 快照这段文本是要直接贴进 prompt 的，第 8 节那条正则会连它一起扫）。
    props ? `台上道具：${props}` : '台上道具：（还没有——讲到的东西需要动手看就摆一件上来）',
    carry,
    // 无内部时钟这条要说给模型：台子不会自己走，它不动就是它不动。
    '相位没有时钟：你不调用 run_scene，台子就停在当前相位，学习者的沉默不是换场的信号。',
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * 校验读回来的盘（文件可能被手改过），坏字段一律清掉而不是抛。
 * 台面只认 `props` 这一本账：`placed` / `removed` 是 2a 早期留下的两本废账，
 * 没有任何读者，还会跟 props 打脸（扔掉后 placed 仍说它在台上、放回后 removed 仍说它被撤下）。
 * 扔 / 放的历史在 progress.artifact_events 里（1b 那两条轨），一份事实只留一份账——
 * 所以旧盘上这两个键读进来就洗掉，不许跟着内存继续漂。
 */
const dropDeadDeskLedgers = (rec) => {
  if (rec && typeof rec === 'object') {
    delete rec.placed;
    delete rec.removed;
  }
  return rec;
};

export function normaliseSceneState(raw) {
  if (!raw || typeof raw !== 'object') return emptySceneState();
  const current = raw.current && typeof raw.current === 'object' ? dropDeadDeskLedgers({ ...raw.current }) : null;
  if (current) {
    if (!PHASES.includes(current.phase)) current.phase = 'open';
    current.props = Array.isArray(current.props)
      ? current.props.filter((p) => p && typeof p.id === 'string').map((p) => ({
          id: p.id,
          title: String(p.title || p.id).slice(0, 60),
          rel: p.rel || null,
        }))
      : [];
  }
  const log = Array.isArray(raw.log) ? raw.log.map(dropDeadDeskLedgers) : [];
  return {
    version: 1,
    index: Number.isFinite(raw.index) ? raw.index : log.length + (current ? 1 : 0),
    current,
    log,
  };
}
