#!/usr/bin/env python3
"""跨脚本共享的契约原语：数值/语速校验、默认值、严格 JSON。

各脚本通过文件（旁白脚本 / narration_timing.json / Learning Graph 等）通信，
字段缺失或类型错误会变成难以定位的报错或静默降级。把领域规则收口成少量共享
函数，避免漂移。

运行时共享规则；不承担制品审计或 self-test。
"""
import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def require_finite_number(value, label, *, positive=False, nonnegative=False):
    """校验「有限数值」的唯一实现。

    label 形如 "Learning Graph concepts[0].estimated_time"，直接进错误消息。
    """
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)):
        raise ValueError(f"{label} 必须是有限数字")
    if positive and value <= 0:
        raise ValueError(f"{label} 必须是正数")
    if nonnegative and value < 0:
        raise ValueError(f"{label} 必须是非负数字")
    return value


def validate_speed(speed):
    """校验语速倍率必须是 >0 的有限数值，非法时抛 ValueError。

    CLI 的 --speed 入口与 _audio.build_atempo_filter 的入口守卫共用这一份判断，
    避免多处各写一份而漂移（速度 <=0 会让 atempo 链不收敛）。
    """
    require_finite_number(speed, "speed", positive=True)
    return speed


# ── 跨脚本默认值（单一来源）────────────────────────────────────────
# 默认**原速**。变速是逐段可选的调味（`segments[].speed`），不是全局基调：
# 默认值一旦不是 1.0，"这段就是原速"这个最朴素的预期就没了，改回来还得重烧一遍 TTS 额度。
DEFAULT_SPEED = 1.0
# opening/closing 段没有独立常量：它们的默认语速就是**跟随正文**（--speed），
# 想单独调速，在稿件里显式给 opening_speed / closing_speed（narration.py 侧落地）。

# 静音兜底时长估算用的启发式语速（字/秒）。
DEFAULT_CHARS_PER_SEC = 4.3
# 与 narration.py 的 --gap 默认值保持一致（不一致会让估算相对实测系统性偏移）。
DEFAULT_GAP = 0.4


def strict_json_loads(text: str):
    """Canonical JSON loader: reject non-standard constants and duplicate keys."""
    def _reject(value):
        raise ValueError(f"JSON 不允许非标准数值常量: {value}")
    def _reject_duplicates(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"JSON 不允许重复字段: {key}")
            result[key] = value
        return result
    return json.loads(text, object_pairs_hook=_reject_duplicates, parse_constant=_reject)


def estimate_sentence_seconds(sentence, chars_per_sec, speed):
    """单句预计时长（秒）：字数 / 语速 / 倍速（TTS 失败时估静音占位时长用）。"""
    return len(sentence) / chars_per_sec / max(speed, 0.01)


# ── assessment_items 字段集（跨模块唯一定义处）─────────────────────
# Learning Graph 与 Lesson IR 都校验 assessment_items，两份 allowed 集合各写一份
# 时必然漂移：上游认为合法的字段被下游判"未知字段"，编译链在末端炸掉，报错还
# 指向下游模块。这里收口成唯一来源，两边同引用一份。
ASSESSMENT_ITEM_FIELDS = frozenset({
    # 题干与类型
    "type", "question", "prompt",
    # 选项
    "options", "choices",
    # 答案与判定
    "answer", "expected_answer", "correct_order", "evaluation_mode",
    # 反馈与提示
    "explanation", "rationale", "feedback", "hint",
    # 流程控制（运行时门禁依赖 gate / blocks_next）
    "purpose", "required", "gate", "blocks_next",
})

# option 对象允许的子字段；元素可以是非空字符串、有限数字，也可以是这个形状的对象。
OPTION_OBJECT_FIELDS = frozenset({"id", "label", "text", "correct", "feedback", "value"})


def validate_option_object(opt, path):
    """校验 assessment 的 option 对象形状，非法时抛 ValueError。

    `graph-schema.md` 承诺 options/choices 的元素可以是「非空字符串、数字或受支持的
    option 对象」——这条承诺要在整条链路上都成立，所以 Graph 与 Lesson IR 共用
    这一份实现，不各写一份。
    """
    if not isinstance(opt, dict):
        raise ValueError(f"{path} 必须是对象")
    unknown = sorted(set(opt) - OPTION_OBJECT_FIELDS)
    if unknown:
        raise ValueError(f"{path} 含未知字段: {', '.join(unknown)}")
    for key in ("id", "label", "text", "feedback", "value"):
        if key in opt and not isinstance(opt[key], str):
            raise ValueError(f"{path}.{key} 必须是字符串")
    if "correct" in opt and not isinstance(opt["correct"], bool):
        raise ValueError(f"{path}.correct 必须是 boolean")
    if "label" not in opt and "text" not in opt:
        raise ValueError(f"{path} 必须包含 label 或 text")


def validate_assessment_options(options, path):
    """校验 options/choices 列表：元素为非空字符串、数字或 option 对象。

    数字与布尔的区分要用 isinstance 显式挡 bool：Python 里 True 是 int 子类，
    只查 (int, float) 会让 `options: [true, 3]` 的 True 冒充数字选项混进时间轴。
    数字元素就是 graph-schema.md「解析约定」承诺的裸数字选项文本
    （`options: [3, 0, 7]`），下游按字符串消费。
    """
    if not isinstance(options, list):
        raise ValueError(f"{path} 必须是列表")
    if len(options) < 2:
        raise ValueError(f"{path} 至少需要两个选项")
    for k, opt in enumerate(options):
        op = f"{path}[{k}]"
        if isinstance(opt, str):
            if not opt.strip():
                raise ValueError(f"{op} 不能是空字符串")
        elif isinstance(opt, bool):
            raise ValueError(f"{op} 必须是字符串、数字或对象（boolean 不是合法选项）")
        elif isinstance(opt, (int, float)):
            if isinstance(opt, float) and not math.isfinite(opt):
                raise ValueError(f"{op} 数字选项必须是有限数值")
        elif isinstance(opt, dict):
            validate_option_object(opt, op)
        else:
            raise ValueError(f"{op} 必须是字符串、数字或对象")


# assessment item 的枚举值集合（单一定义处；Graph 与 IR 两侧校验共用）。
ASSESSMENT_TYPES = frozenset({"recall", "apply", "transfer"})
ASSESSMENT_PURPOSES = frozenset({"assessment", "practice", "transfer", "reasoning"})
ASSESSMENT_GATES = frozenset({"blocking", "nonblocking", "auto"})
ASSESSMENT_EVALUATION_MODES = frozenset({"correctness", "participation", "self_report"})

# concept / milestone id 统一的 kebab-case 形状（graph-schema.md「英文小写+连字符」；Graph 与 IR 两侧共用）。
KEBAB_ID_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")

DELIVERABLE_TYPES = frozenset({"real-project", "simulation"})
DELIVERABLE_OWNERS = frozenset({"assistant", "user"})


def validate_milestone_fields(m, path):
    """单个 milestone 的共享校验规则（Learning Graph 与 Lesson IR 同一份）。

    与 assessment 侧同一教训：`graph-schema.md` 承诺 deliverable_type/deliverable_owner
    「必填、无默认值」，此前只有 Graph 校验器执行，validate_lesson_ir 作为"读回文件
    再校验"的独立入口时缺字段的 IR 能通过。假定 m 已是 dict（类型与未知字段由调用
    侧入口先拦）。
    """
    # introduces_concepts 同为 schema「是（必填）」字段（列表内容类型由两侧各自的
    # string-list 校验兜住，这里只拦缺席）：曾在 Graph 侧强制而 IR 侧缺失即通过，
    # 同一份 Graph 编译后再手写回来的 IR 就能绕过 schema 承诺。
    if "introduces_concepts" not in m:
        raise ValueError(f"{path}.introduces_concepts 必填")
    for req in ("deliverable_type", "deliverable_owner"):
        if not isinstance(m.get(req), str) or not m[req].strip():
            raise ValueError(f"{path}.{req} 必填且必须是非空字符串")
    if m["deliverable_type"] not in DELIVERABLE_TYPES:
        raise ValueError(f"{path}.deliverable_type 非法（须为 real-project/simulation）")
    if m["deliverable_owner"] not in DELIVERABLE_OWNERS:
        raise ValueError(f"{path}.deliverable_owner 非法（须为 assistant/user）")


def validate_assessment_item_fields(item, path):
    """单个 assessment item 的共享校验规则（Learning Graph 与 Lesson IR 同一份）。

    规则曾各写一份：Graph 侧强制题干非空并校验 purpose/gate/evaluation_mode
    枚举，Lesson IR 侧却全都不查——validate_lesson_ir 作为"读回文件再校验"的
    独立入口时，坏 IR 能通过。枚举集合、题干非空（prompt 与其别名 question
    至少其一）、options/choices 互斥且 ≥2 个选项，全部收口在这里，两侧只保留
    各自前缀的 dict/未知字段检查。
    假定 item 已是 dict（类型与未知字段由调用侧入口先拦）。
    """
    if item.get("type") not in ASSESSMENT_TYPES:
        raise ValueError(f"{path}.type 必须为 recall/apply/transfer")
    # graph-schema.md 承诺 question 是 prompt 的同义别名，校验必须两边都认：
    # 只认 prompt 会把"用了合法别名"的稿件判成缺题干。
    stem = item.get("prompt")
    if not (isinstance(stem, str) and stem.strip()):
        alt = item.get("question")
        if not (isinstance(alt, str) and alt.strip()):
            raise ValueError(f"{path} 缺少题干：prompt（或其别名 question）必须是非空字符串")
    if "options" in item and "choices" in item:
        raise ValueError(f"{path} 不得同时提供 options 和 choices")
    options_key = "options" if "options" in item else "choices" if "choices" in item else None
    if options_key:
        # 元素可以是非空字符串、数字或 option 对象，且至少两个——`graph-schema.md`
        # 的承诺在整条链路上成立。
        validate_assessment_options(item[options_key], f"{path}.{options_key}")
    if "purpose" in item and item["purpose"] not in ASSESSMENT_PURPOSES:
        raise ValueError(f"{path}.purpose 非法")
    if "gate" in item and item["gate"] not in ASSESSMENT_GATES:
        raise ValueError(f"{path}.gate 非法")
    if "evaluation_mode" in item and item["evaluation_mode"] not in ASSESSMENT_EVALUATION_MODES:
        raise ValueError(f"{path}.evaluation_mode 非法")
    if "blocks_next" in item and not isinstance(item["blocks_next"], bool):
        raise ValueError(f"{path}.blocks_next 必须是 boolean")
    if "required" in item and not isinstance(item["required"], bool):
        raise ValueError(f"{path}.required 必须是 boolean")
    for key in ("question", "answer", "expected_answer", "explanation",
                "rationale", "feedback", "hint"):
        if key in item and not isinstance(item[key], str):
            raise ValueError(f"{path}.{key} 必须是字符串")
    # 题干走的是"prompt 或 question 至少其一"逻辑，另一个若提供了但非字符串
    # 不会被上面的循环拦住，需单独补类型检查。
    if "prompt" in item and not isinstance(item["prompt"], str):
        raise ValueError(f"{path}.prompt 必须是字符串")
    if "correct_order" in item:
        correct_order = item["correct_order"]
        if not isinstance(correct_order, list):
            raise ValueError(f"{path}.correct_order 必须是列表")
        for i, v in enumerate(correct_order):
            if not isinstance(v, str) or not v.strip():
                raise ValueError(f"{path}.correct_order[{i}] 必须是非空字符串")


# 未提供值时填入的 concept 默认值（单一定义处）。
# 文档（`graph-schema.md`「字段说明」）承诺的默认值必须在这里逐条落地，否则
# 字段被省略时下游拿不到承诺的值；所有默认值集中在这里。
CONCEPT_DEFAULTS = {
    "difficulty": "medium",
    "importance": "core",
    "estimated_time": 15,
}


def apply_concept_defaults(concepts):
    """就地补全 concept 的默认值（Markdown 与 JSON 两条入口共用）。"""
    for concept in concepts:
        for key, value in CONCEPT_DEFAULTS.items():
            concept.setdefault(key, value)
    return concepts


# canonical Markdown 里 misconceptions 的紧凑写法：`文本(frequency: high)`。
# 中英文括号都收，频率值限于 schema 允许的三个，避免把正文里普通括号误吃。
_MISCONCEPTION_FREQ_RE = re.compile(
    r"\s*[（(]\s*frequency\s*[:：]\s*(high|medium|low)\s*[)）]\s*$", re.I)


def normalize_misconception(value):
    """把 `文本(frequency: high)` 归一成 `{misconception, frequency}` 对象。

    `graph-schema.md` 定义 misconceptions 的元素是带 `frequency` 子字段的对象，但
    同文件的 canonical Markdown 示例用的是紧凑括号写法。不归一的话，解析出来是一个
    含字面量 "(frequency: high)" 的字符串——形状与 schema 承诺的不一样，而校验器
    两种都放行，下游只能靠猜。归一后两条入口产出同一种形状。
    """
    if not isinstance(value, str):
        return value
    m = _MISCONCEPTION_FREQ_RE.search(value)
    if not m:
        return value
    return {"misconception": value[:m.start()].strip(),
            "frequency": m.group(1).lower()}


def normalize_misconceptions(concepts):
    """就地归一所有 concept 的 misconceptions（两条入口共用）。"""
    for concept in concepts:
        items = concept.get("misconceptions")
        if isinstance(items, list):
            concept["misconceptions"] = [normalize_misconception(m) for m in items]
    return concepts


# ── Voice registry ───────────────────────────────────────────────
VOICE_IDS = ["冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"]


def list_voice_ids():
    return list(VOICE_IDS)
