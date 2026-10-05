/**
 * 导演台的活模型探针：模型到底会不会自己调 run_scene，「扔掉 → 接着演」的手感对不对。
 *
 * 这套断言在测试里证不了（faux 桩按脚本站着走，不会"自己决定"摆不摆道具），
 * 只有接真模型跑一次才算验证——所以这是探针，不是测试：它不判红绿，只把看到的摊开。
 *
 * 跑法：
 *   node test/preview/live-desk-probe.mjs --dry     只看环境（起服务 + 有没有配好的订阅），一个模型请求都不发
 *   node test/preview/live-desk-probe.mjs           真跑两个回合（要花钱，先想清楚）
 *   node test/preview/live-desk-probe.mjs --topic 微服务幂等 --rounds 1
 *
 * 为什么不会碰你的 data/：数据目录是 TEMP 下的一份新建副本。从仓库只读过来两个文件——
 * credentials.json（只有 key，探针不打印它）和 settings.json（活动模型 + 自建端点的 baseUrl，
 * 里面没有 key）。自建端点的凭证光有 credentials.json 解不出来：baseUrl / modelId 在 settings 那一侧，
 * 少了它 availableModels 就是 0。探针建的会话随目录一起删。
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const DRY = flag('dry');
const TOPIC = opt('topic', 'JavaScript 闭包');
const ROUNDS = DRY ? 0 : Number(opt('rounds', 2));
const PORT = Number(opt('port', 8899));
const BASE = `http://127.0.0.1:${PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-probe-'));
// 报告必须当场落盘：上一回我用 `| tail -30` 跑它，命令超时转后台后管道被拆，
// 两个真回合（花了额度）的报告一个字都没留下。写文件 + 每条即时 append，进程怎么死都不丢。
const REPORT = opt('out', path.join(os.tmpdir(), `socratic-probe-report-${PORT}.txt`));
const log = [];
const say = (line) => {
  log.push(line);
  console.log(line);
  try { fs.appendFileSync(REPORT, line + '\n'); } catch { /* 报告写不进去不许挡住探针 */ }
};
fs.writeFileSync(REPORT, `# 导演台活模型探针 ${new Date().toISOString()}（topic=${TOPIC} rounds=${ROUNDS} dry=${DRY}）\n`);
say(`报告实时写到这里：${REPORT}`);

/**
 * 端口必须真空着。上一回没查：第二次探针 spawn 的服务端 bind 失败悄悄退了，
 * 而 waitForServer 探到的是**第一次探针留下的那个孤儿服务**——于是这一轮的会话
 * 建在别人的临时目录里，两个探针共用一条 SSE，谁报的账都不可信。
 */
function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function bootServer() {
  if (!(await portIsFree(PORT))) {
    say(`⚠ 端口 ${PORT} 上已经有服务在听——那多半是上一次探针没收干净的孤儿。`);
    say('   探针拒绝在它的数据目录里跑（会串台）。换端口：--port 8901，或先把那个 node 进程结束掉。');
    return null;
  }
  for (const f of ['credentials.json', 'settings.json']) {
    const src = path.join(ROOT, 'data', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
    else say(`⚠ data/${f} 不存在——临时目录里少这一份，订阅可能列不出来`);
  }
  const child = spawn(process.execPath, ['server/serve.mjs'], {
    cwd: ROOT,
    env: { ...process.env, SOCRATIC_PORT: String(PORT), SOCRATIC_DATA_DIR: tmp, SOCRATIC_DEBUG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.on('data', (b) => stderr.push(String(b)));
  child.stdout.on('data', () => {});
  return { child, stderr };
}

async function waitForServer(ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${BASE}/api/bootstrap`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const jget = async (p) => (await fetch(`${BASE}${p}`)).json();
const jpost = async (p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => ({})), res: r };
};

/**
 * 发一个回合并把 SSE 读到底。返回事件序列（探针要看的都在里面）。
 * 读法照 test/http-smoke.ps1：心跳是 `:` 开头的注释行，不是事件。
 */
async function runTurn(id, message, model, onAsk) {
  const events = [];
  const r = await fetch(`${BASE}/api/notebooks/${id}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, model }),
  });
  if (!r.ok || !r.body) {
    events.push({ type: '_http_error', status: r.status, body: await r.text().catch(() => '') });
    return events;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      events.push(evt);
      if (evt.type === 'ask' && onAsk) await onAsk(evt);
      if (evt.type === 'closed') { reader.cancel().catch(() => {}); return events; }
    }
  }
  return events;
}

const deskOf = (nb) => nb.scene?.current
  ? {
      场: `${nb.scene.current.index}. ${nb.scene.current.title}`,
      相位: nb.scene.current.phase,
      台上: (nb.scene.current.props || []).map((p) => `${p.title}(${p.id})`),
      记过场数: (nb.scene.log || []).length,
    }
  : { 场: '（没开过场）' };

function reportTurn(n, events) {
  const tools = events.filter((e) => e.type === 'tool_exec').map((e) => e.name);
  const scenes = events.filter((e) => e.type === 'scene');
  const arts = events.filter((e) => e.type === 'artifact');
  const asks = events.filter((e) => e.type === 'ask');
  const prose = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
  say(`  回合 ${n}：工具 ${tools.length ? tools.join(' → ') : '（一次没调）'}`);
  say(`    scene 事件 ${scenes.length} 次｜制品 ${arts.length} 件｜题卡 ${asks.length} 道｜正文 ${prose.length} 字`);
  if (tools.length === 0) say('    ⚠ 一个工具都没调——这一回合台子不可能动过，"导演"没上班');
  if (!tools.includes('run_scene')) say('    ⚠ 没调 run_scene：模型没自己开场/换相位（提示词那条路没走通）');
  return { tools, scenes, arts, asks, prose };
}

let server = null;
try {
  server = await bootServer();
  if (!server) {
    say('探针收工：一个模型请求都没发，也没往别人的数据目录里写一个字。');
    process.exitCode = 1;
  } else if (!(await waitForServer())) {
    say('服务端 12 秒没起来，探针收工。stderr：\n' + server.stderr.join('').slice(0, 2000));
    process.exitCode = 1;
  } else {
    const boot = await jget('/api/bootstrap');
    const providers = await jget('/api/providers');
    const available = providers.availableModels || boot.availableModels || [];
    const active = boot.settings?.activeModel || {};
    const configured = (providers.subscriptions || []).filter((s) => s.configured || s.hasKey || s.ready);
    say(`服务起来了（临时数据目录 = ${tmp}）`);
    say(`活动模型：${active.provider || '（没设）'}/${active.model || '（没设）'}`);
    say(`已配好 key 的订阅 ${configured.length} 个：${configured.map((c) => c.provider || c.id).join(', ') || '（无——自建端点的 key 走 credentials.json，不在这份列表里）'}`);
    say(`可用模型 ${available.length} 个：${available.slice(0, 5).map((m) => `${m.provider}/${m.model}`).join(', ')}${available.length > 5 ? ' …' : ''}`);
    if (DRY) {
      say('');
      say(available.length
        ? `--dry：环境齐了，一个模型请求都没发。去掉 --dry 就跑 ${opt('rounds', 2)} 个真回合（花订阅额度）。`
        : '--dry：没有任何已配置订阅能列出模型——真跑得先配 key（或把 credentials.json 放进 data/）。');
    } else if (!available.length) {
      say('');
      say('没有可用模型，探针不发请求。先配订阅再跑。');
      process.exitCode = 1;
    } else {
      const model = available[0];
      const modelRef = { provider: model.provider, model: model.model };
      const nb = (await jpost('/api/notebooks', { topic: TOPIC })).data.notebook;
      say(`会话建在临时目录里：${nb.id}（你的 data/ 一个字节都没动）`);
      say('');

      const t1 = reportTurn(1, await runTurn(nb.id, `教我「${TOPIC}」。开一场把台面摆出来，讲到的东西需要动手看就摆一件道具上来。`, modelRef));
      const nb1 = (await jget(`/api/notebooks/${nb.id}`)).notebook;
      say(`    盘上的台面：${JSON.stringify(deskOf(nb1))}`);
      const placedProps = nb1.scene?.current?.props || [];
      if (placedProps.length === 0 && t1.arts.length > 0) {
        say('    ⚠ 交付了制品却没落到台面上（share_artifact 的自动摆台没生效？）');
      }

      if (ROUNDS >= 2 && placedProps.length > 0) {
        const target = placedProps[0];
        const drop = await jpost(`/api/notebooks/${nb.id}/artifacts/${target.id}/lifetime`, { retired: true });
        say('');
        say(`  学习者这一手：扔掉「${target.title}」→ HTTP ${drop.status}，返回值里的台面 ${JSON.stringify(deskOf({ scene: drop.data.scene }))}`);
        const t2 = reportTurn(2, await runTurn(nb.id, '接着往下讲这一场，别开新场。', modelRef));
        const nb2 = (await jget(`/api/notebooks/${nb.id}`)).notebook;
        say(`    盘上的台面：${JSON.stringify(deskOf(nb2))}`);
        const back = (nb2.scene?.current?.props || []).filter((p) => p.id === target.id);
        say(back.length
          ? `    ⚠ 被扔掉的那件又回台上了（${target.id}）——替学习者做了决定，1b 那条纪律被模型绕过`
          : '    ✓ 被扔掉的那件没被摆回来（放回是学习者那一侧的手势）');
        if (t2.tools.includes('run_scene') && !t2.tools.includes('open') && nb2.scene?.current?.index !== nb1.scene?.current?.index) {
          say('    （它另开了一场——"别开新场"这句没听进去）');
        }
        const offLedger = ['placed', 'removed'].filter((k) => k in (nb2.scene?.current || {}));
        if (offLedger.length) say(`    ⚠ 台面记录里又长出废账：${offLedger.join(', ')}`);
      } else if (ROUNDS >= 2) {
        say('');
        say('  第二回合跳过了：台面上没有道具可扔（第一回合没摆上台）。');
      }
      say('');
      say(`整条流水里出现过的工具：${[...new Set([...t1.tools])].join(', ') || '（无）'}`);
    }
  }
} finally {
  if (server?.child && !server.child.killed) server.child.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  say('临时目录已删（探针不留东西）');
}
