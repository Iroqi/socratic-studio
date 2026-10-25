// 探针（手跑，不进 test:all）：第四十六轮——窗口外学习者原话的证据保全，两种会话密度下各看一次
import { windowHistory } from '../../server/agent.mjs';
import { MAX_DIALOGUE_MESSAGES, MAX_KEPT_LEARNER_MESSAGES } from '../../server/config.mjs';

const mk = (role, content, i) => ({ role, content, timestamp: Date.now() + i });
const show = (label, history, probes) => {
  const w = windowHistory(history);
  console.log(`\n[${label}] 总 ${history.length} 条 → 窗口 ${w.length} 条`);
  for (const p of probes) {
    const kept = w.some((m) => m.content.startsWith(p));
    console.log(`  ${kept ? '保留' : '被丢'}  "${p.slice(0, 18)}..."`);
  }
  console.log(`  预算常量 MAX_KEPT_LEARNER_MESSAGES = ${MAX_KEPT_LEARNER_MESSAGES}，窗口上限 ${MAX_DIALOGUE_MESSAGES}`);
};

// 真实场景：教学节奏是老师主讲、学习者隔段发言（稀疏且每句有实质）
const realistic = [mk('user', '我想学 JavaScript 闭包', 0)];
for (let i = 1; i <= 55; i += 1) {
  if (i === 8) realistic.push(mk('user', '我之前在别的教程里学过回调，但总把闭包和回调搞混', 8));
  else if (i === 21) realistic.push(mk('user', '我觉得我能说清闭包是什么了，我试试看', 21));
  else if (i === 34) realistic.push(mk('user', '我其实是会计背景，举例最好用记账的例子', 34));
  else if (i % 7 === 0) realistic.push(mk('user', `学习者的实质发言 ${i}`, i));
  else realistic.push(mk('assistant', `讲解作用域相关 ${i}`, i));
}
show('真实密度（学习者发言稀疏有实质）', realistic, [
  '我之前在别的教程里学过回调',
  '我觉得我能说清闭包是什么了',
  '我其实是会计背景',
]);

// 极端密度：每条用户消息都是填充话——预算封顶，最早的自述让位（记录在案，不假装全能保）
const dense = [mk('user', '目标', 0)];
for (let i = 1; i <= 55; i += 1) {
  dense.push(mk(i % 2 === 0 ? 'user' : 'assistant', i % 2 === 0 ? `填充 ${i}` : `答 ${i}`, i));
}
dense[8] = mk('user', '第 8 回合自述（填充很密时）', 8);
show('极端密度（学习者回合全是填充）', dense, ['第 8 回合自述']);
