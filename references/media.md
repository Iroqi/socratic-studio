# 素材能力（Media Capabilities）

> **何时读取:** 写制品需要图/视频/公式/概念图或其他外部素材时读取。素材的**来源是能力，不是制品类型**。

## 1. 总原则

素材是 Agent 在写制品时可以调用的能力。选择哪种实现只取决于**内容需要什么**，与制品能否成立无关——制品在没有素材时也必须是完整的。

**来源是实现细节，不构成 Artifact 类型。** 素材可以来自内生 HTML/SVG/MathML，也可以来自其他 Skill、图像/视频生成、
视觉理解、文件处理或用户提供的媒体。得到素材后，Agent 再决定直接展示、嵌入制品、跨 Skill 继续加工、持久化或丢弃。

**能力有两个方向，别只用一半。** **输出向**是生成素材（图像 / 视频 / SVG / 音频）；**输入向**是理解
学习者交来的东西（手写推导的照片、概念草图、口头讲解的录音）——输入向拿到的不是素材而是**证据**，
直接喂给 EVALUATE。它补的是**作答形式的带宽**：只收打字与点选，等于把"画出来 / 写出来 / 说出来"
的理解全部丢掉（见 SKILL.md「平台原生能力」）。

**素材细节不足时的分寸：** 不影响理解（配色、布局、要不要加个标签）→ **合理假设，直接做完**，
不要问；明显影响理解（画哪条关系、用哪份数据）→ **只问那必要的一句**。**不要为了把形式问完整而
连续追问**——素材是教学的副产品，不该反过来打断教学节奏。

## 2. 按语义选实现

**先过下面这张判据表，再查下面的语义表。** 语义表回答"这个语义用什么实现"；
判据表回答"要不要上重素材"。顺序不能反——先决定**该不该生成**，再决定**怎么生成**。

**素材能力选择判据（canonical）** 唯一判据：这个素材是否让这段教学更有效，代价是否值——
素材只按教学收益与实现代价选择。

| | 内生表现能力 | 外部 / 多模态能力 |
|---|---|---|
| 典型能力 | SVG、MathML、CSS/Web Animations、HTML、JS | 图像生成、视频生成、视觉理解、文件转换、其他 Skill |
| 为什么选它 | **结构可控、即时可改、适合结构/流程/数据与可交互内容** | **真实感、复杂画面、现成素材、跨领域处理或本 skill 不应自己实现的能力** |
| 代价 | 需要 Agent 自己编写或组织 | **调用成本、生成延迟、能力不可用/不可控、跨工具协调成本** |
| 默认性 | 对结构化可控内容通常优先 | 当外部能力能显著提高教学效果或降低实现成本时主动调用 |

> **常见误判：** 因为某种素材实现更“重”就默认不用。真正该权衡的是教学收益、生成代价、可控性和是否真的需要写实表现。

> 内联可视化不可用或生成失败时的退法，统一见 §5「能力不可用时的降级」。

| 语义角色 | 首选实现 | 说明 |
|---|---|---|
| 结构 / 流程 / 因果 | 内联 SVG | 手写，体积小、可动、即时渲染 |
| 比较 / 并排对照 | 内联 SVG | 同一画布内组织 |
| 数据 / 坐标图 | 内联 SVG 或 Canvas | 由真实数据算出坐标，不画示意图充数 |
| 公式 / 推导 | 原生 MathML | `<math display="block">`，**不要**引 KaTeX/MathJax CDN |
| 概念依赖图 | 内联 SVG | 节点 + 有向边，数据来自 Graph 的 `depends_on` |
| 真实参考照片 / 写实场景 | 图像生成或其他图像 Skill | 先确认当前环境可用能力；不把固定工具名写死 |
| 动态过程 / 演示 | CSS / Web Animations，或视频生成能力 | 能内生表达就优先内生；复杂写实或连续镜头需要时调用视频能力。**认知动作随时间变化的段落必须动态呈现**，见 `writing.md`「什么时候必须有动态呈现（正向要求）」 |
| 需要编辑、提取、转码或理解已有媒体 | 其他 Skill / 多模态能力 | 让外部能力承担其擅长的处理，不在 Socratic Studio 内重复实现 |
| 层级 / 分类 / 包含关系 | 内联 SVG 树状图 | 与「结构」的区别：结构讲**组成**，层级讲**上下位** |
| 编年 / 事件先后（内容本身是时间线） | 内联 SVG 时间线 | 别和 §2.1 的「旁白时间轴」混：那个是**播放时钟**，这个是**内容** |
| 真实地理 / 位置关系 | 地图（须用可靠地理数据） | 不编造地点、边界、路线（见「不许编造」）。宁可用文字描述位置，也不要画错 |

**不要机械照表选。** 上面的判据表先过，这张语义表只是**候选清单**——一种形式不能自然表达这份
信息，就换一种，别硬套。反过来，表里有合适的形式但这段内容并不需要视觉时，也别为了用表而用。

## 2.1 时间轴驱动与画面演进（配了旁白时）

旁白脚本产出 `narration_timing.json`，里面是**逐句起止时间**。这份数据的用途不只是高亮
段落——它是**驱动画面演进的时钟**。时间轴 JSON 的完整字段形状以
`interactive-runtime.md`「契约：timeline JSON + data-* 约定」为准（canonical），本节只讲用法。

**设计顺序（推荐）：** 先按认知路径把这段讲解拆成若干"视觉状态"（每一步画面上是什么样），
再回填每步从哪句旁白开始。这样动画是内容驱动，不是为了动而动。

**不要**把时间轴只用来做 `scrollIntoView` / 高亮——那是把时钟当成进度条用。

**时间轴数据必须内联进 HTML**（`file://` 下 `fetch` 外部 JSON 会被拦）——写成
`<script type="application/json" id="lesson-timeline">` 或 JS 常量，不运行时读外部文件。此条
规则的 canonical 在本节，其余位置只写指针。

### 2.1.1 骨架：预置舞台 + 渲染器 = f(句索引)

把"画面上有什么"写成一组**纯函数**：每个场景一个渲染器，输入是**当前句在场景内的序号**，
输出是这一格该长什么样。主循环只做一件事——算出序号，**序号变了才重画**。

```js
// ① 舞台分组预置在 HTML 里（不要用 JS 创建舞台本身）：
//    <g id="stA" class="el">…静态标题…<g id="a-body"></g></g>
//    渲染器只往内层容器 a-body 里填内容；整组的显隐靠切 .on。
// ② 场景 → 渲染器映射
const RENDER = { 'seg-1': renderA, 'seg-2': renderB /* … */ };
// ③ 主循环：只在换句时重画一次（不是每帧重画）
let lastKey = '';
audio.addEventListener('timeupdate', () => {
  const hit = sentAt(audio.currentTime);        // 当前句 {scene, index}
  if (!hit.scene) return;
  const key = `${hit.scene.step_id}#${hit.index}`;
  if (key === lastKey) return;                  // ← 逐帧重画会把 DOM 打烂
  lastKey = key;
  (RENDER[hit.scene.step_id] || (() => {}))(hit.index);
});
```

**四条纪律：**

1. **渲染器是纯函数，不自己计时。** 它只回答"第 N 句时画面是什么样"，不读 `audio.currentTime`、
   不 `setTimeout`。时钟只有音频一个，渲染器不持有自己的时间。
2. **每句对应一个视觉步，数量要对齐。** 渲染器的步数上限和场景句数不一致时，多出来的句子
   画面不再更新——症状是"前半段在动，后半段不动了"。写渲染器时把阈值显式写成常量
   （`step >= 2`），不要用推导表达式，否则自己都数不清有几步。
3. **舞台预置，渲染器只清内层容器。** 每个场景在 HTML 里留好分组 `<g id="stX">` 和它内部的
   空容器；渲染器 `clear` 内层后重填。**别 clear 分组本身**——那会连带清掉分组的静态标题。
4. **重画就重建 DOM，位移交给 CSS transition。** 重建简单、不会累积；要"滑过去"的观感，
   给元素挂 `transition:transform .6s`，靠改 `transform` 属性触发（见下条）。

### 2.1.2 两个会静默毁掉画面的坑

- **`style="transform:…"` 会覆盖 SVG 的 `transform` 属性，把元素打回画布原点。** CSS 的
  `transform` 优先级高于 SVG `transform` 属性——给一个已经用属性定位的 `<g>` 写上 CSS
  transform，属性里的 `translate` 被完全覆盖，元素塌到左上角，看起来像"内容跑到画布外了"。
  **SVG 的位移一律走 `setAttribute('transform', …)`**，动画让 CSS `transition` 作用在属性上。
- **"从原位滑到新位"必须分两拍。** 先设起点，**两帧之后**再设终点，中间那一跳才会被 transition
  吃进去：

  ```js
  g.setAttribute('transform', `translate(${from},${CY})`);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    g.setAttribute('transform', `translate(${to},${CY})`);
  }));
  ```

  同一次同步执行里连设两次，浏览器只看到最终值——**没有动画，是瞬移**。

**若用了 `interactive_runtime.js` 且交互块是动态生成的**（例如到点浮出的门禁），
建好 DOM 之后必须调一次 `window.__socraticStudioWire()` 让运行时挂上监听。
它是幂等的（按元素用 `data-wired` 标记，已接过的不会重复挂）。

**漏掉这一步的后果很隐蔽**：按钮存在、样式正常、看起来能点，但**没有 click 监听** ——
点了没反应。若这个交互同时承担"解除冻结"，时间轴就永远停在原处，
该段画面再也不推进；从外面看像是"画面画歪了 / 内容没更新"，
实际是交互从未接线。**"点了没反应"和"画面不动"是同一个 bug 的两种表现。**

**画布尺寸：** 舞台 SVG 不要写 `height:100%`——那会让客户区等于容器高度，
与 viewBox 比例不一致时 `preserveAspectRatio` 会把内容缩成中间一条带。
用 `width:100%; height:auto; aspect-ratio:<viewBox 宽/高>`。

**关键节点（门禁）不要用 `position:absolute` 叠在舞台上**，会遮住舞台下半部分。
让它占文档流里自己的一行（grid 行），舞台与门禁都完整可见。

### 2.1.3 完整实例：时间轴驱动的逐步揭示（CSS 盒模型）

把 §2.1.1 那套骨架跑成一个可运行例子：一段旁白分 4 句，每句揭示盒模型的一层。
教的是「画面做出来了但不对」症状表里的那条处方——**一次只推一个认知动作**：
4 句话对应 4 步视觉，绝不 4 层一起蹦出来。

时间轴**内联**进页面（规则在 §2.1）。下面的 JSON 是本例用到的
字段的**用法示例**，完整字段形状见 `interactive-runtime.md`「契约：timeline JSON + data-* 约定」。
若配 `interactive_runtime.js`，把同一份 JSON 放进 `id="lesson-timeline"` 的 script 标签即可
直接驱动；本例自带播放器是为了独立可跑。**这不是模板**——看它怎么把"随时间揭示"变成画面，
盒模型的层数与命名由你的内容决定，不要抄这四个。

```html
<svg viewBox="0 0 640 320" style="width:100%;height:auto;aspect-ratio:2/1">
  <g id="L-box"></g>
  <g id="L-labels" font-size="12" fill="currentColor"></g>
</svg>
<!-- src 取 narration_timing.json 的 audio 字段（本例无 BGM/响度处理，即 combined.wav） -->
<audio id="audio" src="combined.wav" controls></audio>
<script type="application/json" id="box-timeline">
{ "scenes": [ { "step_id": "s1", "runtime": { "start": 0, "duration": 9.6, "end": 9.6, "narration": [
  {"start":0.0, "duration":2.4, "text":"最里层是内容区 content，真正装字的地方。"},
  {"start":2.4, "duration":2.4, "text":"往外一圈是 padding 内边距，内容与边框之间的留白。"},
  {"start":4.8, "duration":2.4, "text":"再往外是 border 边框，把盒子圈起来。"},
  {"start":7.2, "duration":2.4, "text":"最外圈是 margin 外边距，盒子与其他元素之间的空隙。"}
]}}]}
</script>
<script>
const rings = [
  {name:'content', half:40,  op:0.55},
  {name:'padding', half:68,  op:0.38},
  {name:'border',  half:96,  op:0.22},
  {name:'margin',  half:124, op:0.10},
];
const STEP_MAX = rings.length - 1;     // 阈值写成常量，别用推导式（否则自己都数不清几步）
const cx = 320, cy = 160;
const TL = JSON.parse(document.getElementById('box-timeline').textContent)
            .scenes[0].runtime.narration;
const B = document.getElementById('L-box');
const T = document.getElementById('L-labels');
const svgEl = (t) => document.createElementNS('http://www.w3.org/2000/svg', t);

// 渲染器是纯函数：只回答"第 step 句时画面长什么样"，不读 audio.currentTime / 不 setInterval
function render(step) {
  B.replaceChildren(); T.replaceChildren();
  for (let k = 0; k <= Math.min(step, STEP_MAX) && k < rings.length; k++) {
    const r = rings[k];
    const rect = svgEl('rect');          // 位移一律走 setAttribute（见 §2.1.2，绝不用 CSS transform）
    rect.setAttribute('x', cx - r.half); rect.setAttribute('y', cy - r.half);
    rect.setAttribute('width', r.half*2); rect.setAttribute('height', r.half*2);
    rect.setAttribute('fill', 'currentColor'); rect.setAttribute('opacity', r.op);
    rect.setAttribute('rx', 4);
    B.appendChild(rect);
    const t = svgEl('text');
    t.setAttribute('x', cx + r.half + 8); t.setAttribute('y', cy - r.half + 16);
    t.textContent = r.name;
    T.appendChild(t);
  }
}
// 当前句序号：取最后一个 start <= t 的句子
function sentAt(t) {
  let idx = 0;
  for (let i = 0; i < TL.length; i++) if (t >= TL[i].start) idx = i;
  return idx;
}
// 主循环就是 §2.1.1 那三行：算序号 → 序号变了才重画 → 调 render。不再复述。
const audio = document.getElementById('audio');
let lastKey = -1;
if (audio) audio.addEventListener('timeupdate', () => {  // 没 audio 时静默跳过，render(0) 照样画
  const key = sentAt(audio.currentTime);
  if (key !== lastKey) { lastKey = key; render(key); }
});
render(0);                                       // 没有音频时也先画出第一格
</script>
```

四条纪律在本例的落点：渲染器纯函数（不持有自己的时钟）、4 句 = 4 步（`STEP_MAX` 是常量，
不会出现"前半段动、后半段不动"）、位移走 `setAttribute`（不踩 §2.1.2 的塌原点坑）、
`replaceChildren` 只清内层容器（不连静态标题一起删）。要让某一环"滑入"而非"直接出现"，
用 §2.1.2 的**两帧 rAF** 写法。

## 2.2 不许编造（数据 / 关系 / 地理）

**本节是"视觉诚实性"的 canonical home。** 前面几条讲"该不该画、画什么形式"，这里讲**画出来的东西
必须真**——教学制品里的假信息会被当成知识记进去，代价比不画高得多。

**数据：**

- 不得编造数据，不得改变数据含义。
- **不得使用误导性的比例**：坐标轴不从 0 开始时必须写明；面积/长度视觉不能与数值不成比例。
- **不得隐藏重要单位**。
- **不得把估算当事实**：估算出来的数字要标明是估算，或干脆不落到图上。

**关系：**

- 不得凭空创造关系（没有 `depends_on` / `confused_with` 数据就不画依赖图或混淆图）。
- 不得把推测表现成事实（"可能是 A 导致 B" 不能画成一条实线箭头）。
- **不得删除会改变含义的重要关系**——为了让图更好看而省掉一条边，等于改了知识结构。

**地理：**

涉及真实地理时，用可靠地理数据，**不编造地点、边界、路线**。拿不准就退回文字描述位置，
不要"大致画一个"。

> **与「视觉与数据」判据的分工：**「数据不存在就别画，数据存在就必须用起来」的 canonical 在
> `writing.md`「视觉与数据」；本节管另一端——**画出来的必须真**（不编造、不误导读数）。两节各管一端，
> 互相引用，不重复。

## 2.3 让人看懂：动手前先做六个动作

判据（§2 开头的判据表、`writing.md`「视觉与数据」）管"**该不该画**"，语义表管"**画成什么形式**"。这一节管第三件事：
**怎么让人一眼看懂**。六条都是可执行动作，不是审美偏好。

1. **先用一句话写出"这张图让人看到什么"。** 写不出来，说明该画什么还没想清——回 §2 开头的判据表重新判断。
   这句话之后也是你自查的标尺（§6）。
2. **一次只突出一件事。** 想同时讲清三处关系，就画三张小图或分步揭示，不要全塞进一张。
   元素越多，"值得看"的那个越被稀释。
3. **对比只用一个通道。** 要让人看出"A 和 B 不同"，就只改**一个**通道：颜色、大小、位置、形状，
   四选一。同时改三个，读者分不清到底是哪个在表示差异。
4. **重要层级要占"三处不同"。** 主元素在**大小**、**位置**（是否压在视觉重量上）、**颜色深浅**上
   同时不一样。只改一处通常不够——这正是"看着都对，但抓不住重点"的常见原因。
5. **标注就近，不要图例兜底。** 标签贴在被标的东西旁边。靠"图例 + 颜色"对照会强迫读者来回扫视，
   认知负担翻倍；图例只在元素样式完全一致、且数量多时才划算。
6. **删到删不动。** 每条线、每个装饰都问一句"删掉会损失什么信息"，答不出来就删。
   **留白不是浪费**——挤在一起时，结构会被噪声淹没。
   （数值图的零基线、刻度、单位属于另一件事，见「不许编造」。）

## 2.4 静态视觉的实现骨架

§2.1 那套骨架是给"**画面随旁白演进**"用的。**不随任何时钟演进的图**（结构图、概念图、坐标图、
对照图）走这一套：**分层预置 + 数据 → 布局的纯函数**。

```js
// ① 分层预置（写在 HTML 里，不用 JS 造层）：后画的层盖住前面的
//    <g id="L-axes">  <g id="L-edges">  <g id="L-nodes">  <g id="L-labels">
// ② 布局是纯函数：数据 → 坐标。
//    不要手写坐标常量——改一个数据点就要重排全部，手写常量必然漏改。
const W = 640, H = 320, R = 26;
const PAD = R + 18;         // ← 安全边距**由半径推出**，不要拍脑袋写个 24：
                            //   PAD < R 时首尾节点会被 viewBox 裁掉一截
const xAt = (i, n) => PAD + i * ((W - 2 * PAD) / Math.max(1, n - 1));
// ③ 值 → y：先定域再定值。域不从 0 起就必须在图上写明（「不许编造」）
const yAt = (v, lo, hi) => H - PAD - (v - lo) / ((hi - lo) || 1) * (H - 2 * PAD);
```

**完整实例一：概念依赖图。** 数据源就是 Graph 的 `depends_on`（不是编的）。
**这不是模板——看它怎么把数据变成画面，不要抄它的配色和样式。**

```html
<svg viewBox="0 0 640 320" style="width:100%;height:auto;aspect-ratio:2/1">
  <g id="L-edges" stroke="currentColor" fill="none" opacity=".45"></g>
  <g id="L-nodes"></g>
  <g id="L-labels" font-size="13"></g>
</svg>
<script>
const edges = [['变量作用域','闭包'], ['闭包','柯里化']];   // ← 来自 Graph 的 depends_on
const nodes = [...new Set(edges.flat())];
const W = 640, H = 320, R = 26, PAD = R + 18;   // PAD 必须 ≥ 半径，否则首尾节点被裁
const px = {};
nodes.forEach((n, i) => px[n] = { x: PAD + i * ((W - 2*PAD) / Math.max(1, nodes.length-1)), y: H/2 });

const E = document.getElementById('L-edges'),
      N = document.getElementById('L-nodes'),
      T = document.getElementById('L-labels');
const svgEl = (tag) => document.createElementNS('http://www.w3.org/2000/svg', tag);

for (const [a, b] of edges) {                       // 边先画，压在节点下面
  const p = px[a], q = px[b];
  const el = svgEl('path');
  el.setAttribute('d', `M${p.x},${p.y} Q${(p.x+q.x)/2},${p.y-46} ${q.x},${q.y}`);  // 拱起避开节点
  E.appendChild(el);
}
nodes.forEach((n) => {                              // 节点 + 就近标签
  const c = svgEl('circle');
  c.setAttribute('cx', px[n].x); c.setAttribute('cy', px[n].y); c.setAttribute('r', R);
  c.setAttribute('fill', 'currentColor'); c.setAttribute('opacity', '.12');
  N.appendChild(c);
  const t = svgEl('text');
  t.setAttribute('x', px[n].x); t.setAttribute('y', px[n].y + 40);
  t.setAttribute('text-anchor', 'middle'); t.setAttribute('fill', 'currentColor');
  t.textContent = n;
  T.appendChild(t);
});
</script>
```

对照 §2.3 看这个例子里做对了什么：**分层**就是视觉层级（边/节点/标签各归一层）；
**绕开节点的曲线**是删噪声（不让连线穿过节点造成误读）；**标签贴在节点下方**是就近标注；
**全程 `currentColor`** 让图自动继承主题配色——**没有一处颜色是写死的**。

下面三个实例换三种语义，**都用上面同一套骨架**（分层预置 + 数据→坐标的纯函数），
不再贴完整代码，只列坐标函数和边语义的 delta——学会骨架，就能套到任何语义形式。

### 2.4.1 实例二：坐标图（数据 → 比例长度）

与实例一同骨架（分层预置 + `xAt`/`yAt` 纯函数），差异只有三点：

- **定域**：y 域必须包含 0——长度 ∝ 数值才不骗人（§2.2）。真实数据都 > 0 且差异很小时，
  宁可不动 y 域：把 0 画出来，差异自然显现；**绝不为"显眼"截断基线**。
- **多一层轴 / 网格**：零基线永远画出来，刻度就近标在 y 轴上（不靠图例）。
- **数据形状**：`{x:'第1周', v:0.32}` 这样的数组，来自真实数值（Graph 或可信来源），不编造。

### 2.4.2 实例三：对照图（一个通道讲清差异）

差异在**怎么表示"谁更好"**（§2.3 ③④）：

- 两个对象先靠**位置**分"谁是谁"，"谁更好"就只再走**一个通道**——这里用"填充实/虚"：
  被选项 `fill: currentColor`，未选项 `fill: none` 加一档低透明度，只改这一处。
- 被突出的项占**三处不同**：数据更高 + 实填充 + ✓ 徽标。两边都加 ✓、都加粗等于没突出。
- 布局从"均分一行"换成定宽柱居中：柱高 = `(v / maxV) * plotH`，`maxV` 取整域上限；
  标签就近放柱顶上方。

### 2.4.3 实例四：状态机流转图（带转移标签的有向边）

差异在**边语义**：概念依赖图的边是无标签曲线，这里每条边要说清"什么条件触发流转"。

- 数据是 `[from, to, 触发条件]` 三元组；转移标签就近放在边的中点，不靠图例。
- 边的起止从圆心缩到圆边缘（`±R`），相邻状态直接连线即可；**回退边**（从右向左）画成
  下方弧线避免与正向边重叠；箭头用 `<defs><marker>` 定义（`fill="currentColor"`），
  所有边挂 `marker-end`。
- 起点单独标"起点"徽标 + 更深填充——是"重要层级占三处不同"的一种做法。

**上面三个实例都不是模板**——看它们怎么把各自这一类信息变成画面，具体数据、节点、
触发词由你的内容决定。

## 2.5 画面做出来了但不对：症状 → 修法

以上都是"还没开始画"。这一节管**画完了，看着不对**——按症状查。**能力不可用 / 没做成**是另一回事，
见 §5。

| 症状 | 常见原因 | 修法 |
|---|---|---|
| 元素全塌到左上角，像"内容跑到画布外" | CSS `transform` 覆盖了 SVG 的 `transform` 属性 | SVG 位移一律走 `setAttribute('transform', …)`（§2.1.2） |
| 位置没写错，但内容缩成中间一条带 | SVG 写了 `height:100%`，客户区高度与 viewBox 比例不一致 | `width:100%; height:auto; aspect-ratio:<viewBox 宽/高>`（§2.1.2） |
| 文字被裁掉 / 溢出容器 | 容器固定宽高，而文本长度随内容变；SVG `<text>` 不会自动换行 | 文本层改用 HTML；或按**最长**标签预留宽度，别按平均值 |
| 看着挤或散，结构抓不住 | 每个元素的坐标各写各的，没有统一栅格 | 定一个 `PAD` 常量，所有坐标从它算（§2.4 ②） |
| 两个东西看不出差别 | 只差一点点颜色 / 大小，或同时改了多个通道 | 换一个**通道**（位置或形状），或把差值拉开到一眼可辨（§2.3 ③） |
| 动画看不清在发生什么 | 一步动了太多元素，或速度太快 | 一次只推一个认知动作；关键中间态要停够时间 |
| 浅色主题下糊了 / 换主题就看不见 | 颜色写死成深色 | 用 `currentColor` + 透明度，让图继承主题（§2.4 实例） |
| 图和图例对不上 | 颜色/形状映射在 JS 和 CSS 里各写了一份 | 映射表只定义一处，画和标注都从它取 |

## 3. 资源契约

资源没有统一的“必须落盘”要求。素材可以是：

- 当前消息里的内联/富媒体结果；
- 外部能力返回的图片、视频、音频或文件引用；
- 当前 Artifact 可直接访问的本地资源；
- Agent 为后续跨轮复用而显式写入 Workspace 的资源。

只有在 HTML 需要引用本地资源时，才使用当前宿主可解析的相对引用；不要依赖绝对路径或 `file://`，也不要把“打包”
变成必经步骤。是否保存、复制、转换或复用，由 Agent 根据当前教学目标和宿主能力决定。保持素材自然尺寸/比例；
不要为了统一槽位而裁切成固定比例。

## 4. 音频（TTS）

TTS 是本 skill 自带的素材能力，**不是**平台工具——平台本身没有可用的 TTS 工具，需要配音时
一律走 `scripts/narration.py`，不要去找平台工具。

**它的职责只有一个：把这批文本念成音频，并给出每句的起止时间。** 页面结构、配色、布局、
是否播放、怎么播放都由你（Agent）在 HTML 里决定——脚本不规定页面长什么样。

**输入是旁白脚本，不是 Lesson IR。** 脚本就是一份段落清单：

```json
{"title": "欧拉恒等式", "opening": "开场白。",
 "segments": [{"id": "seg-1", "title": "小节名", "text": "这一节要念的话。",
               "voice_id": "冰糖", "speed": 1.2}]}
```

`segments[].text` 才是朗读内容；`id` / `title` / `voice_id` / `voice_style` / `speed` 可选。
顶层可带 `opening` / `closing` / `speakers`（多说话人时用 `segments[].dialogue` 按轮分句）。

```bash
python scripts/narration.py --source narration-source.json -o audio
```

- 产出：整段音频 + `narration_timing.json`（逐句起止时间）。音频文件名默认 `combined.wav`，
  但带 `--bgm` / `--loudness` 时以 manifest 的 `audio` 字段为准——页面里的 `<audio src>` 一律读这个字段。
- **时间轴必须内联进 HTML**：规则与写法见 §2.1（canonical 在那节）。
- **这份 manifest 可以原样放进 `id="lesson-timeline"` 的 script 标签驱动运行时**：两套时钟
  （全局秒 / 场景内相对秒）不许混写、`runtime.narration[]` 缺 `target` 时按
  `[data-narration-index]` 句索引回退聚焦、`runtime_actions` 产出时为空数组由你按内容填
  （参考 `interactive-runtime.md` §2 的动作列表）——这些规则的 canonical 都在
  `interactive-runtime.md`「narration_timing.json 字段形状（canonical）」，本节不复述。
- key 解析优先级：`--api-key` > 系统环境变量 `MIMO_API_KEY` > 项目 `.env` >
  `~/.config/socratic-studio/.env`；`--on-fail silence` 让单句失败
  降级为静音而不阻断。**语速默认 1.0（原速）**——逐段变速用 `segments[].speed`，
  整体变速才用 `--speed`（opening / closing 跟随 `--speed`；改完记得重合成：
  时长变了，时间轴会整体偏移）。
- `--resume` 只做一件简单的事：句子指纹（文本/音色/风格/模型/语速）没变就复用已有音频，
  变了就重新合成。它是省时间的开关，不是需要你维护的状态——**不要为它设计额外的缓存文件**。

没有配音需求就跳过——音频是可选的，页面在没有音频时也必须成立。

## 5. 能力不可用时的降级

两个触发场景：**选定的能力不可用**（如环境没有图像/视频生成），和**生成失败**。
沿阶梯逐级下退，前一级够用就退到那一级为止；**不跳级，也不在不必要时停在最低级**
——停在最低级通常是忘了判断。

1. **换最接近的现有能力**（两场景通用）——找能表达同一语义的另一能力：
   图像生成不可用但内联 SVG 能表达，就手写 SVG；动态/交互视觉做不了，就退成静态图解
   （SVG 或生成图）。
2. **降低复杂度**（换能力也覆盖不住时）——把动态降成静态图示，把多步动画降成一张结构图；
   静态图解也表达不了，才退纯文字。
3. **保留核心信息**（两场景通用）——降级的是表现形式，不是内容；这一步要讲的东西一句不少。
4. **如实说明实际限制**（两场景通用）——告诉学习者"这一步改用文字讲"，
   **但不要报工具名、错误码或编排细节**。

**生成失败时不重试、不阻塞主流程。** 第 4 步的"说明限制"和"不暴露工具细节"不矛盾：
前者是**教学上的诚实**（别让学习者以为本来就该这样），后者是**不把内部机制倒给用户**。

禁止用 generic placeholder 冒充完成度。

## 6. 生成后的快速自查

**这是 Agent 生成完视觉后自查一遍的清单，不是 Validator、不是 SelfTest、不落盘**（见
`SKILL.md`「Canonical scripts」：本 skill 不建立那类脚本）。每条只问一句，判据在权威节里，
不在这里复述：

- 核心内容表达了吗？（§2.3 动作 1）
- 结构 / 关系正确、关键关系没漏吗？（§2.2「关系」）
- 数据准确吗？（§2.2「不许编造」）
- 是不是过度复杂、有没有更简单的表达？（§2.3 动作 6）
- 动效/交互是承载认知动作还是只为好看？只为好看就删。（`writing.md`「什么时候必须有动态呈现」判据）
- 没有音频、没有自动播放时还能读懂吗？（`writing.md`「Learning-first 写作原则」）

**发现复杂度超过必要程度就优先简化**——删元素比加说明更有效。
