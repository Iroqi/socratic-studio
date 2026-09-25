# Mastery Model

> **何时读取:** 每轮判定状态转移时读取。
>
> 定性状态替代数值阈值做主路由。`knowledge` / `application` 只做诊断提示，
> 不参与加权、不计算总分，也不触发自动排程。

**接口契约:**
- **Input:** runtime.md 主循环产生的事件（诊断结果、练习作答、迁移表现、误解检测）
- **Output:** state 转换（Unknown→Seen→Understood→Applied→Mastered）+ 两个诊断维度
- **Invariant:** 遵守 `protocols.md` §0（Progress State 不写入 Graph；更新基于真实证据）
- **职责边界:** 只定义 state 转换与诊断维度，不定义教学动作、Graph 字段或持久化介质

---

## 状态机

状态是 mastery 的主路由键。排程边界（不自动排复习、用户主动回顾如何处理）见
`runtime.md`「排程边界」。

```
升级：Unknown → Seen → Understood → Applied → Mastered（每次一级）
降级：Mastered → Applied（mastery_challenge_failed）
      Applied / Understood / Seen → 各降一级（conceptual_error_twice）
```

| 状态 | 含义 | 对应难度 | 出题方式 |
|------|------|---------|---------|
| Unknown | 尚未接触 | Recall | 直接提问定义/最小识别任务 |
| Seen | 已接触，能部分复述 | Recall→Apply | 先复述，再做最小应用 |
| Understood | 能解释概念 | Apply | 给新场景要求套用 |
| Applied | 能在新场景中使用 | Debug | 给有 bug 的例子揪错 |
| Mastered | 已通过迁移与反思 | Transfer | 只在用户主动回顾或组合任务需要时验证 |

**Transfer 严格度:** 换变量名或数字的表层变体不算迁移。真正的 Transfer 要求概念应用到
结构不同的语境（换语言、换问题类型，或从解释代码变成解决新问题）。

**Mastered 不等于任意下游复合技能已具备:** 单个概念通过迁移不代表能完成所有依赖它的技能。
下游技能要作为自己的 Graph concept 走自己的状态机。

### 状态转换（事件驱动）

以下 YAML 是状态机唯一形式化定义，Runtime 不得另造一套阈值或排程：

```yaml
# mastery_state_machine — canonical definition
states: [Unknown, Seen, Understood, Applied, Mastered]
initial_state: Unknown
self_report_initial_state: Understood   # 用户自报已掌握的初始状态，规则见「初始化」

transitions:
  - { from: Unknown,    to: Seen,        event: probe_answered,                       note: "首次接触，无论对错" }
  - { from: Seen,       to: Understood,  event: predict_correct_after_teach,           note: "TEACH 后 PREDICT 正确" }
  - { from: Understood, to: Applied,     event: practice_correct_with_reason,          note: "练习正确且能说出原因" }
  - { from: Applied,    to: Mastered,    event: applied_correct_twice_plus_reflection, note: "两次 Applied 练习全对且反思通过" }
  - { from: Mastered,   to: Applied,     event: mastery_challenge_failed,               note: "主动回顾或新任务暴露已确认的概念/应用错误" }
  - { from: Applied,    to: Understood,  event: conceptual_error_twice,                 note: "当前级别同类概念错误连续两次" }
  - { from: Understood, to: Seen,        event: conceptual_error_twice,                 note: "同上" }
  - { from: Seen,       to: Unknown,     event: conceptual_error_twice,                 note: "首次接触后连续两次概念错误——视为从未真正建立" }
  # —— 未验证自报的降级特例：只适用于 state 来自 self_report_initial_state 的 concept ——
  - { from: Understood, to: Seen,        event: conceptual_error_unverified_self_report, note: "PRACTICE 出现单次 conceptual error 即降一级，不受两次窗口保护" }
  - { from: Understood, to: Unknown,     event: recall_wrong_unverified_self_report,   note: "Recall 级别题都答错 → 重置 Unknown，从冷启动重新开始" }
  - { from: Seen,       to: Unknown,     event: recall_wrong_unverified_self_report,   note: "同上（自报 Understood 已降级到 Seen 后再答错）" }

counting_window:
  object: "同一 concept、同一错误类型的连续累计"
  reset_on: [state_transition, correct_response_non_guess, concept_switch]
  correct_response_excludes_guess: true
  degradation: single_step
```

**计数窗口:** 状态转换、非猜测的正确回答、切换 concept 时清零；一次事件最多降一级。
带 `*_unverified_self_report` 的转移是该窗口的显式豁免，不要求连续两次。
`mastery_challenge_failed` 是保护性回退，不是周期任务，也不产生下一次排程。

---

## 诊断维度（不参与路由）

| 维度 | 级别 | 含义 | 更新事件 |
|------|------|------|---------|
| knowledge | none/weak/medium/strong | 能正确解释概念 | TEACH/PREDICT 正确上调；conceptual error 下调 |
| application | none/weak/medium/strong | 能在新场景中使用 | PRACTICE/迁移正确上调；execution error 下调 |

只在状态变化、明显错误信号或用户主动请求进度时刷新。不要增加分数、百分比、加权平均、
置信度概率或第三个维度。

---

## State Block 格式

Progress State 是当前快照；它的持久化形态（列顺序、分隔符、示例数据）canonical 在
`persistence.md`「[STATE] 的写法」，跨模块字段来源契约在 `protocols.md`「Runtime State Schema
Protocol」——本文件不复制模板。跨 session 恢复规则同样见 `persistence.md`。

这七列里 Mastery Model 只负责三列的**语义**：`state`（本文件「状态机」）与 `knowledge` /
`application`（本文件「诊断维度」）。`concept_id` 用 Graph 的 `concepts[].id` 而非显示名；
`misconception` 来自 MISCONCEPTION CHECK，`next_action` / `last_seen` 由 Runtime 维护。

状态只能由 `kind=observed` 的真实事件推进，`kind=inferred` 只能给下一轮教学定方向。

### Learner View（对外简化视角）

用户问进度或 Session 结束时使用自然语言，不展示内部状态机术语、“到期复习”或“复习次数”。
五个内部状态到对外词的完整映射：

| 内部状态 | 对外词 |
|---|---|
| Unknown（未开始/在队列） | 待学 |
| Seen | 正在学习 |
| Understood | 正在学习 |
| Applied | 正在练习 |
| Mastered | 已掌握 |

用户主动说“回顾一下”等复习请求的处理方式，见 `runtime.md`「排程边界」。

---

## 初始化

每个 concept 首次出现：`state: Unknown` / `knowledge: none` / `application: none` / `next_action: 探针`。

**用户自报已掌握:** 初始 `state` 取 YAML 的 `self_report_initial_state`（Understood），两个诊断维度设为 medium，`next_action` 标注
“用户自报，未验证”。

**未验证自报的降级特例（canonical，`runtime.md` 只写指针）:** 形式化定义就是「状态转换」YAML 里三条带
`unverified_self_report` 后缀的转移——自报初始状态没有 observed 事件背书，不受「连续两次」计数窗口保护，
后续真实表现不符时立即下调（单次 conceptual error 降一级；Recall 级别题都答错重置 Unknown，从冷启动重新开始）。
**该特例只适用于自报未验证的 concept**；已由 observed 事件正常进入某状态的 concept，降级仍走
canonical 的 `conceptual_error_twice`。
