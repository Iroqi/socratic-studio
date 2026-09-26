(() => {
  // ── socratic-studio 可选引导运行时 ───────────────────────────────────
  // 这是**可选**的引导式运行时，不是 HTML 制品的必选宿主。Agent 自由编写
  // HTML 时，若需要「时间轴推进 + 旁白聚焦 + 阻塞式交互门禁」的引导体验，
  // 把这个文件放进制品目录并引入即可；不需要就不引入。
  //
  // 时间轴 JSON 形状与页面 data-* 选择器契约的唯一之家是
  // `references/interactive-runtime.md` §1–§2（含 lesson-timeline 标签、
  // SOCRATIC_STUDIO_TIMELINE_ID、missing_gate_policy）——这里刻意不复制一份，
  // 抄本必然与原文漂移。
  //
  // 本运行时**只负责引导时序**：场景切换、旁白聚焦、阻塞式门禁。
  // 不计算掌握度、不采集作答、不写文件——这些交由 Agent（脚本 / 对话窗口）完成。
  // 宿主若需读取运行时状态，可访问 window.socraticStudioRuntimeState。
  const timelineId =
    (typeof window !== 'undefined' && window.SOCRATIC_STUDIO_TIMELINE_ID) || 'lesson-timeline';
  const timelineEl = document.getElementById(timelineId);
  let data = {};
  try {
    data = JSON.parse(timelineEl?.textContent || '{}');
  } catch (e) {
    // 时间轴 JSON 语法错误不该让整页脚本崩掉（场景不切换、交互全部失联）——
    // 页面保持可读，只在控制台指明是哪一个块坏了。
    console.error(`[socratic-studio] #${timelineId} 内的 JSON 解析失败，` +
                  '时间轴引导已停用（页面内容仍可正常阅读）。', e);
    data = {};
  }
  const scenes = Array.isArray(data.scenes) ? data.scenes : [];
  let hosts = new Map();
  function refreshHosts(){
    hosts = new Map([...document.querySelectorAll('[data-step-id]')]
      .map(el => [String(el.dataset.stepId), el]));
  }
  refreshHosts();
  const state = {
    started: false, userPaused: false, gatePaused: false,
    clockMode: 'virtual', virtualStartedAt: performance.now(), virtualOffset: 0,
    currentSceneId: null, currentSentenceKey: null, blocked: new Set(),
    executedActions: new Set(),
    audioBound: false, virtualLoopStarted: false,
  };
  function sceneKey(scene){ return String(scene?.step_id || scene?.id || ''); }
  function sceneTiming(scene,index=0){ const r=scene?.runtime||{}; const duration=Math.max(0,Number(r.duration??scene?.estimated_duration??0)); let start=Number.isFinite(Number(r.start))?Number(r.start):null; if(start==null){ start=0; for(let i=0;i<index;i++){ const prev=scenes[i]; const pr=prev?.runtime||{}; const prevStart=Number.isFinite(Number(pr.start))?Number(pr.start):null; const prevDuration=Math.max(0,Number(pr.duration??prev?.estimated_duration??0)); const prevEnd=Number.isFinite(Number(pr.end))?Number(pr.end):((prevStart==null?start:prevStart)+prevDuration); start=Math.max(start,prevEnd); } } const end=Math.max(start,Number(r.end??start+duration)); return {start,duration,end}; }
  function clockNow(){ if(state.clockMode==='audio') return Number(document.getElementById('main-audio')?.currentTime||0); return state.virtualOffset + ((state.gatePaused || state.userPaused) ? 0 : (performance.now()-state.virtualStartedAt)/1000); }
  function commitVirtualClock(){ if(state.clockMode!=='virtual') return Number(state.virtualOffset||0); const elapsed=Math.max(0,(performance.now()-state.virtualStartedAt)/1000); state.virtualOffset += elapsed; state.virtualStartedAt=performance.now(); return state.virtualOffset; }
  function sceneHasBlockingGate(scene){ return (scene?.runtime_actions||[]).some(a=>a.type==='wait'&&a.for==='interaction'&&a.gate==='blocking'); }
  // 声明了阻塞门禁却找不到门禁元素时默认放行（fail-open）并每个场景告警一次；
  // assessment 页可把 timeline.missing_gate_policy 设为 "closed"。
  const gateWarned = new Set();
  const missingGatePolicy = data.missing_gate_policy === 'closed' ? 'closed' : 'open';
  function warnMissingGate(scene, why){
    const key = sceneKey(scene);
    if(gateWarned.has(key)) return;
    gateWarned.add(key);
    console.warn(`[socratic-studio] 场景 ${key || '(无 step_id)'} 声明了阻塞门禁但${why}，` +
                 `当前策略是 ${missingGatePolicy}。请检查门禁元素是否在首屏 DOM 里（动态生成的需调用 ` +
                 `window.__socraticStudioWire() 重新接线）。`);
  }
  function gateSatisfied(scene){ if(!sceneHasBlockingGate(scene)) return true; const host=hosts.get(sceneKey(scene)); if(!host){ warnMissingGate(scene, '找不到对应的 [data-step-id] 容器'); return missingGatePolicy==='open'; } const gates=[...host.querySelectorAll('[data-gate="blocking"][data-interaction]')]; if(!gates.length){ warnMissingGate(scene, '容器内没有 [data-gate="blocking"][data-interaction] 元素'); return missingGatePolicy==='open'; } return gates.every(el=>el.dataset.completed==='1'); }
  function candidateAt(t){ let current=scenes[0]||null; for(let i=0;i<scenes.length;i++){ const s=scenes[i]; const r=sceneTiming(s,i); if(t>=r.start) current=s; if(t<r.end) break; } return current; }
  // 阻塞门禁的语义是"时钟不得越过未满足的门禁"。若只按 candidateAt 的时间区间取场景，
  // 文档推荐的「门禁独立成场景（duration:0）」在中途会被紧邻的下一场景（start 相同）
  // 直接越过、时钟永不冻结。因此在 t 之前（含 t）扫到的第一个未满足门禁场景都持续持有，
  // 直到 gateSatisfied 放行（缺容器/缺门禁元素时 gateSatisfied 已按 missing_gate_policy 处理）。
  function sceneAt(t){ const candidate=candidateAt(t);
    for(let i=0;i<scenes.length;i++){ const g=scenes[i]; if(!sceneHasBlockingGate(g)) continue;
      const r=sceneTiming(g,i); if(r.start<=t&&!gateSatisfied(g)) return g; }
    return candidate; }
  function resolveTarget(scene,target){ const host=hosts.get(sceneKey(scene)); if(!host) return null; const raw=String(target||''); if(!raw||raw===sceneKey(scene)||raw===String(scene?.id||'')) return host; const byId=document.getElementById(raw); if(byId&&host.contains(byId)) return byId; const esc=(window.CSS&&CSS.escape)?CSS.escape(raw):raw.replace(/[^a-zA-Z0-9_-]/g,'\\$&'); return host.querySelector(`[data-element-id="${esc}"]`)||host.querySelector(`[data-target="${esc}"]`); }
  function scrollIntoComfort(el){ if(!el) return; const rect=el.getBoundingClientRect(); const vh=window.innerHeight||800; if(rect.top<vh*.18||rect.bottom>vh*.84) el.scrollIntoView({behavior:'smooth',block:'center'}); }
  function clearFocus(){ document.querySelectorAll('[data-focused="1"],[data-narration-focused="1"]').forEach(el=>{el.dataset.focused='0';el.dataset.narrationFocused='0';}); state.currentSentenceKey=null; }
  function applyNarrationFocus(scene,localTime){ const host=hosts.get(sceneKey(scene)); const sentences=scene?.runtime?.narration||[]; if(!host||!sentences.length) return; let active=null; for(let i=0;i<sentences.length;i++){const s=sentences[i]; const st=Number(s.start||0), en=st+Number(s.duration||0); if(localTime>=st&&localTime<en){active=i;break;}} if(active==null) return; const targetKey=`${sceneKey(scene)}:${active}`; if(state.currentSentenceKey===targetKey)return; document.querySelectorAll('[data-narration-focused="1"]').forEach(el=>el.dataset.narrationFocused='0'); const binding=sentences[active].target; const target=(binding&&host.querySelector(`[data-narration-target="${(window.CSS&&CSS.escape)?CSS.escape(binding):binding}"]`))||host.querySelector(`[data-narration-index="${active}"]`); if(target){target.dataset.narrationFocused='1';scrollIntoComfort(target);} state.currentSentenceKey=targetKey; }
  function applyAction(scene,action,index){ const host=hosts.get(sceneKey(scene)); if(!host)return; const key=`${sceneKey(scene)}:${index}`; const phase=action.phase||'once'; if(phase==='once'&&state.executedActions.has(key))return; const target=resolveTarget(scene,action.target); if(action.type==='focus'){if(target){target.dataset.focused='1';scrollIntoComfort(target);}} else if(action.type==='reveal'){if(target){target.hidden=false;target.dataset.revealed='1';scrollIntoComfort(target);}} else if(action.type==='animate'&&target&&typeof target.animate==='function'){const motion=action.motion||'pulse';const frames=motion==='lift'?[{transform:'translateY(0)'},{transform:'translateY(-8px)'},{transform:'translateY(0)'}]:[{transform:'scale(1)'},{transform:'scale(1.03)'},{transform:'scale(1)'}];target.animate(frames,{duration:520,easing:'ease-out'});} if(phase==='once')state.executedActions.add(key); }
  function freezeForGate(){ if(state.gatePaused)return; if(state.clockMode==='virtual') commitVirtualClock(); state.gatePaused=true; if(state.clockMode==='audio') document.getElementById('main-audio')?.pause(); }
  function resumeAfterGate(){ if(!state.gatePaused)return; state.gatePaused=false; if(state.userPaused)return; if(state.clockMode==='virtual') state.virtualStartedAt=performance.now(); else document.getElementById('main-audio')?.play().catch(()=>{}); }
  function applyScene(scene,localTime){ if(!scene)return; const sid=sceneKey(scene); if(state.currentSceneId!==sid){state.currentSceneId=sid;clearFocus();} hosts.forEach((el,key)=>{el.dataset.active=key===sid?'1':'0';el.dataset.blocked=key===sid&&state.blocked.has(sid)?'1':'0';}); if(sceneHasBlockingGate(scene)){ if(!gateSatisfied(scene)){state.blocked.add(sid);freezeForGate();} else {state.blocked.delete(sid);resumeAfterGate();} } if(hosts.get(sid)) hosts.get(sid).dataset.blocked=state.blocked.has(sid)?'1':'0'; if(!state.blocked.has(sid)) (scene.runtime_actions||[]).forEach((a,i)=>applyAction(scene,a,i)); applyNarrationFocus(scene,localTime); }
  function applyAt(t){const scene=sceneAt(t); const idx=scene?scenes.indexOf(scene):-1; const local=scene?t-sceneTiming(scene,idx).start:0; applyScene(scene,Math.max(0,local));}
  function parseConfig(el){
    const raw = el.getAttribute('data-interaction') || '{}';
    try { return JSON.parse(raw); }
    catch(e){
      // 与时间轴 JSON 同一策略：坏块不炸页面，但不能静默降级——
      // 选项解析失败会被当成"没有正确答案声明"，错误答案也能过关。
      console.error('[socratic-studio] 交互块的 data-interaction JSON 解析失败，' +
                    '该块按"无配置"处理：', el, e);
      return {};
    }
  }
  function recordEvidence(el, opts){
    opts=opts||{};
    el.dataset.attempts=String((Number(el.dataset.attempts)||0)+1);
    if(opts.detail!==undefined) el.dataset.response=String(opts.detail).slice(0,1000);
    el.dataset.result=opts.correct===true?'correct':(opts.correct===false?'incorrect':'recorded');
  }
  function finish(el,msg,opts){
    opts=opts||{};
    recordEvidence(el, opts);
    const fb=el.querySelector('.interaction-feedback');
    if(fb){ fb.textContent=msg||''; fb.hidden=!msg; fb.classList.remove('is-correct','is-wrong');
      if(opts.correct===true)fb.classList.add('is-correct');
      else if(opts.correct===false)fb.classList.add('is-wrong'); }
    if(opts.correct===true){
      el.classList.add('is-completed'); el.dataset.locked='1';
      el.querySelectorAll('[data-choice-id]').forEach(b=>{b.disabled=true;});
      const badge=el.querySelector('.interaction-badge'); if(badge)badge.hidden=false;
    }
    // 与文档契约一致：只有"明确答错"才留在未完成（'0'）；记录型/参与型作答
    // 一律视为完成（'1'）。阻塞门禁的放行仍安全——gateSatisfied 只认 completed==='1'。
    const completed=(opts.correct!==false)?'1':'0';
    el.dataset.completed=completed;
    const host=el.closest('[data-step-id]');
    if(host){host.dataset.interactionSatisfied='1'; if(state.currentSceneId===String(host.dataset.stepId)){
      state.blocked.delete(state.currentSceneId);resumeAfterGate();applyAt(clockNow());}}
  }
  function wireInteractions(){
    document.querySelectorAll('[data-interaction]').forEach(el=>{
      // 幂等：同一元素不重复挂监听。
      // 动态生成的交互块（如按时间轴浮出的门禁）需要重新接线，
      // 靠 __socraticStudioWire 反复调用；没有这个标记，每调用一次就会
      // 多挂一层 click 监听 —— 点一下记成多次作答。
      if(el.dataset.wired==='1') return;
      el.dataset.wired='1';
      const config=parseConfig(el), kind=el.dataset.interactionType;
      const complete=(msg='')=>finish(el,msg);
      if(kind==='toggle') el.querySelector('[data-toggle-action]')?.addEventListener('click',()=>{el.dataset.toggled=el.dataset.toggled==='1'?'0':'1';complete(el.dataset.toggled==='1'?'已展开':'已收起');});
      if(['choice','self_check','predict','compare'].includes(kind)){
        const opts=config.options||[];
        // 契约（interactive-runtime.md）：只有声明了 correct:true 的选项集才要求答对；
        // 只标了 correct:false（无 true）的集合视为"无标准答案"，选出即完成——
        // 若按"声明过任意布尔"判定，阻塞门禁会因不存在正确答案而永不放行。
        const correctnessRequired=opts.some(o=>o&&o.correct===true);
        const fb=el.querySelector('.interaction-feedback');
        el.querySelectorAll('[data-choice-id]').forEach(btn=>btn.addEventListener('click',()=>{
          if(el.dataset.locked==='1')return;
          el.querySelectorAll('[data-choice-id]').forEach(b=>b.dataset.selected='0');
          btn.dataset.selected='1';
          const opt=opts.find(o=>String(o.id)===String(btn.dataset.choiceId));
          const correct=opt?.correct===true;
          const msg=opt?.feedback||(correct?'正确，继续。':correctnessRequired?'再想一步，再试一次。':'已记录。');
          if(fb){fb.textContent=msg;fb.hidden=false;fb.classList.remove('is-correct','is-wrong');fb.classList.add(correct?'is-correct':'is-wrong');}
          if(correct){ finish(el,msg,{correct:true,detail:String(btn.dataset.choiceId)}); }
          else if(correctnessRequired&&el.dataset.gate==='blocking'){
            recordEvidence(el,{correct:false,detail:String(btn.dataset.choiceId)});
            el.dataset.completed='0';
          }
          else if(correctnessRequired){ finish(el,msg,{correct:false,detail:String(btn.dataset.choiceId)}); }
          else { finish(el,msg,{detail:String(btn.dataset.choiceId)}); }
        }));
      }
      if(kind==='explore'){const input=el.querySelector('[data-explore-input]'); input?.addEventListener('input',e=>{const out=el.querySelector('[data-explore-output]');if(out)out.value=e.target.value;}); input?.addEventListener('change',e=>{if(String(e.target.value)!==String(input.dataset.exploreInitial??input.defaultValue)){complete('已完成一次有意义的探索。');}});}
      if(kind==='reflection') el.querySelector('[data-reflection-submit]')?.addEventListener('click',()=>{const input=el.querySelector('[data-reflection-input]');const value=String(input?.value||'').trim();if(value.length<2){const fb=el.querySelector('.interaction-feedback');if(fb)fb.textContent='先写下一点你的理解，再继续。';return;}finish(el,'已记录反思。',{detail:value.slice(0,500)});});
      if(kind==='sequence'){
        const list=el.querySelector('.sequence-list');
        let dragId=null;
        list?.querySelectorAll('.sequence-item').forEach(item=>{
          item.addEventListener('dragstart',()=>{dragId=item.dataset.sequenceId;});
          item.addEventListener('dragover',e=>e.preventDefault());
          item.addEventListener('drop',e=>{
            e.preventDefault();
            const target=e.currentTarget;
            if(!dragId||target.dataset.sequenceId===dragId)return;
            const source=[...list.children].find(x=>x.dataset.sequenceId===dragId);
            if(source)list.insertBefore(source,target);
          });
        });
        el.querySelector('[data-sequence-submit]')?.addEventListener('click',()=>{
          if(el.dataset.locked==='1')return;
          const order=[...el.querySelectorAll('.sequence-item')].map(x=>String(x.dataset.sequenceId));
          const expected=(config.correct_order||[]).map(String);
          const detail=order.join(',');
          const fb=el.querySelector('.interaction-feedback');
          if(!expected.length){
            if(el.dataset.gate==='blocking'){
              console.warn('[socratic-studio] 阻塞排序题缺少 correct_order，无法判定正误，提交已拒绝。');
              if(fb){fb.textContent='该排序题缺少 correct_order，无法判定。';fb.hidden=false;}
              return;
            }
            finish(el,'已记录排序。',{detail});
            return;
          }
          const correct=order.length===expected.length&&order.every((v,i)=>v===expected[i]);
          if(!correct){
            recordEvidence(el,{correct:false,detail});
            // 契约（interactive-runtime.md「门禁完成信号」/writing.md「DOM 观测映射」）：
            // 明确答错一律回到 '0'，不分是否阻塞门禁——与 choice 的 finish 路径同一语义。
            el.dataset.completed='0';
            if(fb){fb.textContent='顺序还不对，再调整一次。';fb.hidden=false;fb.classList.remove('is-correct');fb.classList.add('is-wrong');}
            return;
          }
          finish(el,'顺序正确。',{correct:true,detail});
        });
      }
      el.querySelector('[data-hint-action]')?.addEventListener('click',()=>{const h=el.querySelector('.interaction-hint'); if(h)h.hidden=!h.hidden;});
    });
  }
  function startVirtualClock(){state.clockMode='virtual';state.virtualStartedAt=performance.now();state.started=true;document.querySelector('[data-begin]')?.setAttribute('hidden','hidden');if(state.virtualLoopStarted)return;state.virtualLoopStarted=true;let last=-1;const tick=()=>{if(!state.userPaused){const t=clockNow();if(Math.abs(t-last)>=.05){applyAt(t);last=t;}}requestAnimationFrame(tick)};requestAnimationFrame(tick);}
  function bindAudio(audio){if(state.audioBound)return;state.audioBound=true;const useAudioClock=()=>{state.clockMode='audio';if(state.started&&!state.gatePaused)applyAt(audio.currentTime);};audio.addEventListener('loadedmetadata',useAudioClock,{once:true});audio.addEventListener('durationchange',useAudioClock);audio.addEventListener('timeupdate',()=>{if(!state.userPaused&&state.started&&!state.gatePaused)applyAt(audio.currentTime);});audio.addEventListener('seeked',()=>{if(state.started)applyAt(audio.currentTime);});audio.addEventListener('play',()=>{if(state.gatePaused){audio.pause();return;}state.userPaused=false;/* ended 后不点复位，timeupdate 会永久跳过场景推进 */state.clockMode='audio';state.started=true;applyAt(audio.currentTime);document.querySelector('[data-begin]')?.setAttribute('hidden','hidden');});audio.addEventListener('ended',()=>{state.userPaused=true;});audio.addEventListener('error',()=>startVirtualClock());}
  async function startGuidance(fromGesture){if(state.started)return;const audio=document.getElementById('main-audio');if(!audio){startVirtualClock();return;}try{await audio.play();state.clockMode='audio';state.started=true;applyAt(audio.currentTime);}catch(_){
    // 已有手势仍起不来 = 媒体真的坏了 → 按无 TTS 降级走虚拟时钟。
    if(fromGesture){startVirtualClock();return;}
    // 没有手势被拦下时不伪装成"声音在放"：画面停在 0 等手势，不偷偷切虚拟时钟——
    // 否则学习者看着场景无声推进，等他点播放时又被音频时间拽回去。
    console.warn('[socratic-studio] 音频起播被浏览器拦下：画面停在 0 等待用户手势（加 [data-begin] 触点，或直接点音频控件都会恢复推进）。');
    state.userPaused=true;applyAt(0);}}
  document.querySelector('[data-begin]')?.addEventListener('click',()=>startGuidance(true));
  wireInteractions();
  // 宿主页面若按时间轴**动态生成**交互块（例如到点浮出的门禁），
  // 建好 DOM 后要主动调这个入口重新接线。语义是幂等的：已经接过的不会重复挂。
  // 没有它，动态块上的按钮永远没有监听 —— 点了没反应，关卡永远不解除。
  window.__socraticStudioWire=function(){refreshHosts();wireInteractions();};
  const audio=document.getElementById('main-audio');
  if(audio){bindAudio(audio);document.querySelector('[data-begin]')?applyAt(0):startGuidance();}
  else if(document.querySelector('[data-begin]')) applyAt(0);
  else startVirtualClock();
  window.socraticStudioRuntimeState=state;
  if(window.__SOCRATIC_STUDIO_TEST__){ window.__SOCRATIC_STUDIO_TEST__.api={clockNow,commitVirtualClock,freezeForGate,resumeAfterGate,startVirtualClock,applyAt}; }
})();
