# 可选引导式运行时库

> `scripts/interactive_runtime.js` 是一个**可选**库。想要「时间轴推进 + 旁白高亮 + 阻塞式交互门禁」时
> 把它拷进制品目录引入即可；不用它，页面照样是完整制品。

## 1. 定位：库，不是宿主

HTML 由 Agent 自由编写，运行时只提供**行为**，不提供页面结构：

```text
你写的 HTML（结构 / 样式 / 内容 —— 全部由你决定）
      ↓  可选引入
interactive_runtime.js（只做：时钟推进 / 聚焦 / 门禁）
```

页面本体必须**先作为普通可阅读、可滚动、可操作的 HTML 成立**（底线见
`writing.md`「Learning-first 写作原则」）。引导式推进是增强层。

## 2. 契约：timeline JSON + data-* 约定

运行时读取页面里的一个 JSON script 标签（默认 id `lesson-timeline`，可用
`window.SOCRATIC_STUDIO_TIMELINE_ID` 改）：

```json
{
  "missing_gate_policy": "open",
  "scenes": [
    {
      "step_id": "s1",
      "runtime": {
        "start": 0, "duration": 8, "end": 8,
        "narration": [{"start": 0, "duration": 3, "text": "…", "target": "t1"}]
      },
      "runtime_actions": [
        {"type": "focus", "target": "t1"}
      ]
    },
    {
      "step_id": "s2-gate",
      "runtime": {"start": 8, "duration": 0, "end": 8},
      "runtime_actions": [
        {"type": "wait", "for": "interaction", "gate": "blocking"}
      ]
    }
  ]
}
```

顶层字段只有两个有语义：`scenes`（场景数组，缺失或不是数组时运行时不启动时序）与
`missing_gate_policy`（见 §4）。标签内 JSON 语法解析失败时，运行时在控制台 `error` 指明并
**整体停用时间轴引导**——页面内容保持可正常阅读操作，不白屏、不炸脚本。

`runtime_actions` 由你按内容填（聚焦 / 揭示 / 门禁 / 动画），脚本只知道时间不知道页面上有什么。

### narration_timing.json 字段形状

`narration.py` 产出的 `narration_timing.json` 是本契约的**超集**：配了 TTS 就不必手写 timeline JSON，
把这份 manifest **原样**内联进 script 标签即可——运行时只读它认识的字段，
其余字段是给人（和画面演进逻辑）用的，无害共存。完整形状：

```json
{
  "schema_version": 1,
  "status": "ok",
  "title": "主题",
  "total_duration": 123.456,
  "gap": 0.35,
  "voice_id": "冰糖",
  "audio": "combined.wav",
  "degraded": {"tts_silence_fallback_count": 0},
  "scenes": [
    {
      "step_id": "seg-1",
      "scene_id": "seg-1",
      "title": "小节名",
      "start": 0.0, "duration": 12.5, "end": 12.5,
      "sentences": [
        {"start": 0.0, "duration": 3.2, "text": "…",
         "speaker": "阿明", "synth_failed": true}
      ],
      "runtime": {
        "start": 0.0, "duration": 12.5, "end": 12.5,
        "narration": [{"start": 0.0, "duration": 3.2, "text": "…"}]
      },
      "runtime_actions": []
    }
  ]
}
```

逐字段说明：

| 字段 | 含义 | 谁用 |
|---|---|---|
| 顶层 `schema_version` | 当前恒为 `1` | 人读 |
| 顶层 `status` | 有任何一句以静音占位（`--on-fail silence` 降级）时为 `"degraded"`，否则 `"ok"` | 人读 / 宿主自查 |
| 顶层 `title` | 旁白脚本的标题，可为空串 | 人读 |
| 顶层 `total_duration` | 整条音轨实测总时长（秒） | 宿主页（进度条等） |
| 顶层 `gap` | 合成时使用的句间静音秒数 | 人读 |
| 顶层 `voice_id` | CLI 默认音色；逐段/逐说话人覆盖不体现在此处 | 人读 |
| 顶层 `audio` | **音轨的文件名**（只有 basename，即 `combined.wav`）——页面里 `<audio id="main-audio">` 的 `src` 一律以这个字段为准 | 宿主 |
| 顶层 `degraded` | `{tts_silence_fallback_count: n}`：n 句为静音占位 | 人读 / 宿主自查 |
| `scenes[].step_id` / `scene_id` | 场景键（两者同值；运行时只读 `step_id`，缺失时回退 `id`） | 运行时 |
| `scenes[].title` | 段落标题，供宿主页呈现 | 宿主 |
| `scenes[].start/duration/end` + `sentences[]` | **全局秒**时钟：从整条音轨 0 点起算。`sentences[]` 每条含 `start/duration/text`，多说话人时带 `speaker`（说话人标签），静音占位句带 `"synth_failed": true`（估算时长） | 宿主页按**全局句索引**驱动画面演进/字幕用它 |
| `scenes[].runtime.*` | **场景内相对秒**时钟：`runtime.narration[].start` 已减去本场景起点。这是运行时唯一读取的时序 | 运行时 |
| `scenes[].runtime_actions` | 产出时恒为空数组，由你按内容填 | 运行时 |

**两套时钟不许混写**：scene 顶层 `start/duration/end`、`sentences[].start` 是全局秒；
`runtime.narration[].start` 是场景内相对秒。手写或改写时间轴时不得把全局秒填进
`runtime.*`，也不得拿 `runtime.narration[].start` 当全局时间用。

- `runtime.narration[]` **不带 `target`**（TTS 脚本不知道 DOM 绑定）。缺 `target` 时运行时按句序
  回退匹配 `[data-narration-index="<场景内句索引>"]`——**给要聚焦的元素标上这个属性**即可，
  不必自己算时间。
- **场景容器整段没有句子时会被从时间轴剔除**并 `warn`：这是一条防御分支——`--on-fail abort`
  下任何句子失败都会在写 manifest 前终止整条管线，`--on-fail silence` 下失败句会拿静音占位，
  两者都到不了"整段无音频"。
  宿主页按 `step_id` 找场景时要容忍"少场景"，画面与门禁以实际输出的 scenes 为准。

### data-* 约定

页面结构只需满足这些 `data-*` 约定（怎么组织 HTML 随你）。「谁写谁读」列指属性的写入方与
消费者。

| 选择器 / 属性 | 含义 | 谁写 → 谁读 |
|---|---|---|
| `[data-step-id]` | 每个场景的容器 | 宿主写 → 运行时读 |
| `[data-begin]` | 可选的极简开始触点（有音频时需用户手势起播；命名避开播放器语义）；启动成功后运行时给它加 `hidden` 属性 | 宿主写 → 运行时读 |
| `[data-interaction='<json>'][data-interaction-type]` | 交互块（JSON 值与属性名同为一处，勿再写空 `data-interaction`——HTML 重复属性只认第一个，配置会静默丢失） | 宿主写 → 运行时读 |
| `[data-concept-id]` / `[data-question-id]` | 供 Agent/宿主把 DOM 快照映射回当前概念与题目（运行时不读） | 宿主写 → 宿主/Agent 读 |
| `[data-gate="blocking"]` | 阻塞门禁：未完成则冻结时钟（写在交互块上） | 宿主写 → 运行时读 |
| `#main-audio` | 可选；有则用音频时钟，无则用虚拟时钟 | 宿主写 → 运行时读 |
| `data-wired='1'` | 接线幂等标记，见「接线幂等」 | 运行时写 → 运行时读 |
| `data-toggled='0'/'1'` | toggle 交互当前开合状态 | 运行时写 → 宿主样式可读 |
| `data-selected='0'/'1'` | 当前选中的选项（每次点击先清全部再置选中） | 运行时写 → 宿主样式可读 |
| `data-attempts` / `data-result` / `data-response` / `data-completed` / `data-locked` | 作答证据，见 §4「门禁完成信号」 | 运行时写 → 宿主页读 |
| `[data-narration-focused]` | 运行时写入：当前旁白句绑定的 DOM 目标（只读，别自己设） | 运行时写 → 宿主样式读 |
| `[data-narration-index="<n>"]` | 旁白第 n 句（**场景内** 0-based）的聚焦目标；`narration` 条目没有 `target` 时按此回退匹配 | 宿主写 → 运行时读 |
| `[data-narration-target="<id>"]` | 具名旁白绑定；`narration` 条目写了 `target` 且页面上按名字定位时用它 | 宿主写 → 运行时读 |
| `data-element-id` / `data-target` | `runtime_actions.target` 的兜底解析名，见「target 解析顺序」 | 宿主写 → 运行时读 |

运行时写在容器上、供宿主页做样式或状态展示的 DOM 状态标记（宿主页**读**，不要自己写，
运行时每帧按场景覆盖）：

| 属性 | 挂在哪个元素 | 语义 |
|---|---|---|
| `data-active='1'/'0'` | 每个 `[data-step-id]` 容器 | 是否当前场景；每个时钟 tick 全量覆盖 |
| `data-blocked='1'/'0'` | 每个 `[data-step-id]` 容器 | 当前场景是否正被阻塞门禁冻结（冻结瞬间即写入）；非当前容器恒为 `'0'` |
| `data-interaction-satisfied='1'` | `[data-step-id]` 容器 | 容器内任一交互块完成（`finish`）时置位。**只会置 `'1'`，从不回落**，答错也不撤销——只表示"这个场景参与过" |
| `data-revealed='1'` | reveal 动作的目标元素 | 元素已被揭示；同时运行时移除其 `hidden` 属性 |
| `data-focused='0'/'1'` | focus 动作的目标元素 / 场景容器（target 为空时） | 运行时焦点标记；焦点转移时旧目标置 `'0'` |

### runtime_actions

支持的 `type`：`focus`（标焦点并滚动）、`reveal`（去 `hidden` + 标焦点）、`animate`（内置
`pulse` / `lift` 两种位移，`motion` 字段选择）、`wait`（`for: "interaction"`、可选
`gate: "blocking"`，门禁的唯一声明方式）。

- **`runtime_actions.target` 的解析顺序**：空 target 或等于本场景 `step_id`/`id` → 场景容器本身；
  否则依次尝试 `getElementById`（须在容器内）→ `[data-element-id]` → `[data-target]`。
  聚焦目标命中不了时 action 静默不生效——给目标元素至少配一种名字。
- **`phase` 值域**：省略或 `"once"` → 该动作每个场景会话只执行一次（去重键是「场景 + 动作在
  数组中的索引」，**时间轴内联后不要中途重排 actions 数组**）。其他任何值（含 `"continuous"`
  和拼写错误值）运行时行为相同：不去重——时钟停留在该场景期间**每个时钟 tick 都执行一次**
  （虚拟时钟约每帧一次，音频时钟随 `timeupdate` 触发）。要声明持续动作请显式写
  `"continuous"`，并且**自己保证动作高频重复执行下仍然成立**（幂等或可反复播放，如 `animate`）。

### 交互块内部元素契约

运行时**只认下面这些宿主必须写出的内部选择器**——交互块（`[data-interaction]`）的 DOM 里
没有它们，对应行为就不发生。这是运行时源码的契约，不是可选建议：

| 交互类型 / 通用 | 宿主必须提供 | 运行时对它做什么 |
|---|---|---|
| 通用 | `.interaction-feedback` | 写入反馈文案，切换 `hidden` 与 `is-correct` / `is-wrong` 类 |
| 通用 | `.interaction-badge` | 答对解锁时去掉 `hidden`（完成徽章） |
| 通用 | `[data-hint-action]` + `.interaction-hint` | 点 hint 按钮切换 hint 的 `hidden` |
| 通用 | `data-gate="blocking"`（写在交互块上） | 参与门禁判定；明确答错一律写 `data-completed='0'`（不分是否阻塞，见「门禁完成信号（MutationObserver）」） |
| `toggle` | `[data-toggle-action]` | 点击切换 `data-toggled`，即算完成 |
| `choice` / `self_check` / `predict` / `compare` | 每个选项按钮 `[data-choice-id="<id>"]`，id 与 `data-interaction` JSON 里 `options[].id` 对应 | 挂点击判定；写 `data-selected`；答对后所有按钮 `disabled` |
| `explore` | `[data-explore-input]`，可选 `[data-explore-output]`，input 上 `data-explore-initial`（基线值，缺省用 `defaultValue`） | 同步 output 值；`change` 且值偏离基线才算完成 |
| `reflection` | `[data-reflection-input]` + `[data-reflection-submit]` | 提交时校验文本 ≥2 字符，通过才算完成 |
| `sequence` | `.sequence-list` 容器、每个条目 `.sequence-item[data-sequence-id]`、`[data-sequence-submit]` | 拖拽排序（insertBefore）；提交时按 DOM 顺序比对 `correct_order` |

块上 `data-interaction` 的 JSON 解析失败时：运行时在控制台 `error` 指明是哪个块，并把该块
按"无配置"处理（选项题会因没有 `options[].correct` 声明而变成"任意选择即完成"）——
写完交互块别漏验这一块 JSON。

### 接线幂等

- 每个 `[data-interaction]` 首次接线后运行时写 `data-wired='1'`；重复接线调用不会重复挂监听。
  没有这层标记，每接一次就多挂一层 click 监听——点一下记成多次作答。
- 暴露入口 `window.__socraticStudioWire()`：语义是**幂等**的——刷新 `[data-step-id]` 宿主映射，
  并为所有尚未接线的 `[data-interaction]` 补挂监听；已接过的原样跳过。
- 交互块（尤其门禁）或场景容器**动态生成**时，建好任一部分 DOM 后必须调一次
  `window.__socraticStudioWire()`，否则新块上的按钮永远没有监听——点了没反应，关卡永远不解除；
  场景容器不在映射里则门禁不参与判定（fail-open 策略下还会静默放行，见 §4）。

## 3. Clock Model

运行时自己拥有时钟抽象，可用的 clock source：

- narration audio（页面有 `#main-audio` 时）
- virtual/manual time（无音频时）

音频不定义整个制品的时序模型——没有音频，虚拟时钟一样推进。

启动行为（如实）：页面加载时，有 `#main-audio` 且有 `[data-begin]` → 绑定音频等用户手势起播；
有音频但无触点 → 立即尝试 `play()`，**被浏览器拦下时画面停在 0 等手势**（控制台一次 warn；点了
音频控件或再给一次手势都会恢复，推进权交给音频时间，不会出现"无声地自己走"）；无音频有触点 →
等点击；无音频无触点 → 直接启动虚拟时钟。**只有"用户已经点过、音频仍然起不来"才按无 TTS 降级
走虚拟时钟**——那是媒体真坏了。

虚拟时钟的暂停/门禁转换会**先提交已流逝时间**再进入暂停态，并从提交的偏移恢复。
这样跨「音频暂停 / 阻塞门禁 / 无 TTS 降级推进」时场景位置不会丢。

## 4. 阻塞式门禁语义

引导遇到交互时**默认不强制暂停**；只有交互被标记为 blocking，或后续步骤依赖其结果时才停下等待。
交互完成后自动恢复原来的引导时钟。**「Agent 与学习者交接控制权」在当前实现里就是这一层**：
门禁未完成时钟不前进，完成瞬间自动恢复；没有更细粒度的交接形态。

**冻结发生在场景入口。** 时钟一进入声明了阻塞门禁的场景，门禁未完成就立即冻结——本场景的
旁白推进、逐句聚焦、动作执行都**不会播放**。唯一例外：冻结发生的那一瞬间，运行时会尝试按
本场景第 0 句旁白解析一次聚焦目标——前提是场景里保留了 `runtime.narration[0]` 且其
`duration` 非零（时钟停在 0，非零窗口才命中）。命中 `[data-narration-target]` /
`[data-narration-index="0"]` 则打上 `data-narration-focused`，场景容器标上 `data-blocked='1'`；
仅当目标落在视口 18%–84% 舒适带之外时才平滑滚动居中，在带内则不动。
这是门禁题出现瞬间仅有的**视觉指向**，不是播放——时间戳此后冻结不动，不会再推进到后面的句子。
因此：问题陈述与引导话术放在**前一个场景**；门禁放
**独立场景**（`duration: 0` 即可），场景容器里只放交互块；门禁元素的 DOM 必须在冻结发生前
就已存在（动态生成的要先进 DOM 再调 `window.__socraticStudioWire()`，见 §2「接线幂等」）。

**参与 ≠ 正确。** 门禁区分这两者：

- `choice` / `self_check` / `predict` / `compare`：只有当选项声明了 `correct: true` 时才要求答对；
  没有任何选项带 `correct` 字段时，选出即算完成。
- `sequence`：作为阻塞门禁时必须提供 `correct_order`，并按同一套归一化选项 id 判定。
  缺失时运行时**拒绝提交并在控制台告警**——阻塞门禁不会因"没有正确答案可比"而解除；
  非阻塞的 `sequence` 缺少它时按"已记录排序"完成。
- `reflection`：要求学习者输入文本（去空白后至少 2 个字符）。
- `explore`：要求发生一次真实的值变更，而不是任意 input 事件。

Runtime action 默认只执行一次；需要连续执行的 action 必须显式声明 `phase: "continuous"`
（值域与运行时行为见 §2「runtime_actions」）。

**门禁配置坏掉时默认放行（fail-open）并告警。** 可把时间轴顶层 `missing_gate_policy` 设为
`"closed"`，让缺失门禁按未完成处理；这适合需要严格证据的评估页。场景声明了阻塞门禁、但运行时找不到任何
`[data-gate="blocking"][data-interaction]` 元素（含连 `[data-step-id]` 容器都缺失的情况）时，
运行时会按该策略处理，并在控制台按场景一次性 `warn`。典型病因是交互块或整个场景容器随时间轴
**动态生成**——建好任一部分 DOM 后必须调 `window.__socraticStudioWire()`（语义与义务见 §2
「接线幂等」），否则门禁元素既接不上监听也不参与判定。

> 默认偏向可用是立场，不是疏漏：门禁是**教学时序的优化**，不是安全边界——配置坏掉时，
> "页面仍可读 + 控制台告警"比"整页冻死、学习者卡死在坏配置上"更容易被修复。真正需要
> 强制证据的页面应当显式选 `"closed"`，而不是靠默认值兜住一个本就该报错的配置。

### 门禁完成信号（MutationObserver）

**页面要知道“这道门禁答对没有”**（典型用途：答对后才启用“继续”按钮），**不要轮询**——
`finish` 在判定后写入 `el.dataset.completed`（判定正确或参与/记录型完成为 `'1'`，凡明确答错——
无论是否阻塞门禁——为 `'0'`）、
`el.dataset.result`（`correct` / `incorrect` / `recorded`）、`el.dataset.response`（若提供，截断至
1000 字符）与累计的 `el.dataset.attempts`（每次作答 +1）。**只有答案被锁定的完成才写
`el.dataset.locked='1'`**——无 `correct` 声明的 choice / toggle / explore / reflection 完成时只有
`data-completed='1'`，用户还可以改答。**观察门禁是否解除请以 `data-completed` 为准，不要等
`data-locked`。**

注意一个属性变化盲区：`data-completed` 从缺省（`undefined`）到 `'1'`（参与即完成的门禁，
如 toggle / explore / 无 correct 声明的 choice）在**首次作答**时触发一次 `mutation`；但在此之前
该属性**没有任何属性变化**——只想观察「第一次完成」的观察者要用 `{ attributes: true }` 观察
整个元素，或初始化时先读一次 `dataset.completed`，别只监听 `'0' → '1'` 的值变化。

页面用 `MutationObserver` 观察这些属性即可，这是运行时主动通知的唯一时点：
运行时只做**机械比对**——按题目自带的声明（选项 `correct`、`correct_order`）判完成与正误，
不发明判定标准、不计算掌握度，也不暴露作答汇总。

**音频模式下的解除**：门禁冻结期间宿主页调 `audio.play()`（例如空格键直通）会被运行时的
`play` 监听强制暂停；宿主页应**无条件调用 `play()`**（不检查 `paused`），正确接线见 §5「播放器接线」。

## 5. 答后交互与播放控制（宿主页规范）

学习者答完一题之后，页面必须回答“我现在该做什么”。本节是用了
`interactive_runtime.js` 时的实现规范；不用运行时、自己写播放器时同样遵循这些行为要求。

### 继续路径（硬要求）

**学习者答对一题之后，页面必须回答"我现在该做什么"。** 交互做对了但答完停在原地，
学习者不知道是自己没点对还是本来就该停。三种可接受的做法，任选其一，但**必须选一个**：

1. **自动继续**（最简单）：给一个短到能看清反馈的延迟（约 1.5s）自动续播。
2. **显式继续入口**（推荐）：出一个"继续 →"按钮，并**说明还有多远**——
   例如"继续（后面还有一题）→"，配一句"下一题约在 01:20 处"。让学习者对剩余量有预期。
3. **两者都给**：按钮 + 键盘快捷键提示（如"也可以按空格"）。

- **未作答时就要说清怎么继续**，不要等答对了才出现提示。画面停在题上、
  又没有"选对即可继续"这类说明，看起来就是卡住了。按钮可以先禁用，
  但要显示出来并写明条件。
- **答对后不要立刻跳走**，也**不要无限期停着**。反馈要留在屏上可读，但继续的入口要显眼。
- **冻结期间要把播放控制说清楚**：进度被冻在题目处是**预期行为**，
  界面上要让人知道"播放在这里暂停"，而不是让人以为播放器坏了。

### 键盘与空格语义

运行时源码里**没有任何键盘逻辑**——空格键行为 100% 是宿主页职责。规则：

- 空格在无门禁段落 = 播放/暂停切换（宿主页自己实现）。
- 空格在有门禁段落**不能失灵**：语义应为“继续”（聚焦到门禁/交互元素），不是
  “播放/暂停”——否则按了没反应，和坏了没区别。
- **音频模式下不要用空格直通 `audio.play()` 来“继续”**：门禁期间运行时会把每次 `play`
  事件强制暂停，空格看起来就是坏了。宿主页的 toggle 逻辑写成“暂停中→永远调 `play()`、
  播放中→调 `pause()`”，播放推进与否交还给运行时判定；更稳的做法是空格在有门禁时
  干脆不碰音频，只把焦点送到题目。

### 按钮启用条件

“继续”按钮的启用条件直接接 §4「门禁完成信号（MutationObserver）」：观察对应交互块的
`data-completed`（不是 `data-locked`），`'1'` 时启用、`'0'`/缺省时禁用。答错后按钮退回禁用，
不锁死。

### 播放器接线

宿主页的播放/暂停按钮与运行时的暂停语义要各管一层：

- 宿主自己的 `userPaused`（用户点暂停按钮）**不与**运行时的 `gatePaused` 混存——
  两者同时存在时，“解除暂停”按钮必须在 `gatePaused` 尚未清除时就直接对音频发起 `play()`：
  运行时 `play` 监听到 `gatePaused` 仍会暂停（保持冻结，预期行为），门禁解除时学习者
  已点过的那一下不会丢。反之，若按钮逻辑是“只在暂停时才调 `play()`”，
  就会出现“点了没反应”的假死。
- 宿主**不要改写** `window.socraticStudioRuntimeState` 的字段（见下「状态导出」）。
- 音轨跨「音频暂停 / 阻塞门禁 / 无 TTS 降级」不会丢位置：运行时恢复时从冻结点继续，
  宿主页无需实现任何记忆逻辑。
- 门禁答对后何时推进由宿主页决定：运行时在 `finish` 里**立即**尝试解除冻结（音频模式下连
  `play()` 也自动恢复，见下「时序如何继续」），反馈文字因此只有裸恢复的一瞬可读。要实现
  「延迟约 1.5s 再续播」（上文做法 1），宿主页在收到 `data-completed='1'` 的 mutation 后
  **抢先调用 `pause()`**，延迟窗口结束后再调用 `play()`。

### 时序如何继续（运行时侧事实）

- **虚拟时钟**：`finish` 判定完成的瞬间解除冻结，下一帧起从冻结点继续推进——无额外延迟，
  需要"让反馈可读"的停顿由宿主页实现（见上）。
- **音频时钟**：音频模式下只要宿主没有手动暂停（`userPaused` 为假），`finish` 解除冻结时运行时会
  **立即**对 `#main-audio` 执行 `play()`（`resumeAfterGate` 就是这么做），不等宿主动作；`userPaused`
  为真时只清门禁标记，续播权交还宿主。要「延迟续播让反馈可读」，用上方「播放器接线」末条的
  先 `pause()` 后 `play()` 法。
- **`ended` 的暂停副作用**：音轨自然播完时运行时把内部 `userPaused` 置真——此后一切
  `timeupdate` 推进被跳过，**直到下一次音频 `play` 事件**才恢复（`play` 监听会清掉该标记并
  重新应用当前时刻）。任何 seek / 复用播放器路径都必须伴随一次真实 `play()`，否则页面
  停在原地不动。
- **重放 / seek**：把 `#main-audio` 的 `currentTime` 设回任意时刻并触发真实 `play()`，
  运行时按新位置重进场景——动作去重键是「场景 + 动作索引」，不随 seek 重置，重放时
  `once` 动作不会重跑（这正是"重放不重复揭示"的语义；要重放即重的动作用 `continuous`）。

### 状态导出

见下「运行时状态导出」；本节只强调：宿主页做继续路径判断时读 `data-completed`
（DOM 契约），不读运行时内部状态。

## 6. Scene timeline fallback

当 scene 没有 measured `runtime.start/duration/end` 时，运行时按 `estimated_duration` 累积计算
start/end，保持多步骤内容按声明顺序连续推进。

## 7. 边界

这个库是可选件，不负责制品审计或离线打包——页面是否保存、如何组织资源由 Agent 决定。

### 运行时状态导出

`window.socraticStudioRuntimeState` 是运行时内部状态对象的引用（live 视图）：
`{ started, userPaused, gatePaused, clockMode, virtualOffset, currentSceneId, blocked, … }`。
宿主页可以**只读**它做展示或调试判断；**不要写入这些字段**——时钟推进、门禁解除都依赖
内部一致性，对外契约一律走 §4「门禁完成信号（MutationObserver）」的 `data-*` 属性。

### 测试挂点

页面若设置 `window.__SOCRATIC_STUDIO_TEST__`（任意真值），运行时会把内部时钟函数（`clockNow` /
`commitVirtualClock` / `freezeForGate` / `resumeAfterGate` / `startVirtualClock` / `applyAt`）挂到
`window.__SOCRATIC_STUDIO_TEST__.api` 上，供宿主自行验证门禁与时钟行为。默认不开，本 skill 不自带测试脚本。
