#!/usr/bin/env python3
"""Renderer-neutral Lesson IR.

Lesson IR 只承载知识结构到教学顺序之间的稳定数据：概念、解释、示例、误解、
可观测技能与评估素材。它不描述 HTML/CSS/JS、视觉布局、交互组件或 TTS。
从 Lesson IR 到最终表现由 Agent 直接完成，没有中间编译链。

IR 只保留**有消费方**的字段：`steps[]` 供 Agent 写讲解用，`source_concept_ids`
用于闭合校验（step 的 concept_id 必须来自它）。不携带内容哈希这类无人消费的
工程元数据——没有下游缓存/失效机制时它只是装饰。
"""
from __future__ import annotations

import os
import sys
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _contracts import (ASSESSMENT_ITEM_FIELDS,  # noqa: E402
                        KEBAB_ID_RE, validate_assessment_item_fields,
                        validate_milestone_fields)
from _script_utils import topo_sort  # noqa: E402

IR_VERSION = 4


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _misconceptions(concept: Dict[str, Any]) -> List[Any]:
    # 带 frequency 的条目保留对象形状——graph-schema.md 承诺「两种写法产出同一种
    # 数据」，这里静默丢 frequency 就是第三份形状（校验器也已接受对象形状）。
    out: List[Any] = []
    for item in concept.get("misconceptions") or []:
        if isinstance(item, str) and item.strip():
            out.append(item.strip())
        elif isinstance(item, dict):
            text = _text(item.get("misconception"))
            if not text:
                continue
            frequency = item.get("frequency")
            out.append({"misconception": text, "frequency": frequency}
                       if frequency else text)
    return out


def _assessment_items(concept: Dict[str, Any]) -> List[Dict[str, Any]]:
    out=[]
    for item in concept.get("assessment_items") or []:
        if isinstance(item, dict):
            out.append(dict(item))
    return out


def build_lesson_ir(
    graph: Dict[str, Any], ordered_concepts: List[Dict[str, Any]], focus: Optional[str] = None
) -> Dict[str, Any]:
    """Compile a validated Learning Graph into a deliberately small Lesson IR."""
    if not graph or not ordered_concepts:
        raise ValueError("图谱为空，无法生成 Lesson IR")

    selected = ordered_concepts
    if focus:
        ids = {c.get("id") for c in ordered_concepts}
        if focus not in ids:
            raise ValueError(f"找不到概念 {focus!r}")
        descendants = {focus}
        changed = True
        while changed:
            changed = False
            for concept in ordered_concepts:
                if concept.get("id") not in descendants and any(
                    dep in descendants for dep in (concept.get("depends_on") or [])
                ):
                    descendants.add(concept.get("id"))
                    changed = True
        selected = [c for c in ordered_concepts if c.get("id") in descendants]

    steps=[]
    for i, concept in enumerate(selected, 1):
        cid = concept.get("id") or f"concept-{i}"
        explanation = _text(concept.get("explanation")) or _text(concept.get("insight")) or _text(concept.get("summary"))
        steps.append({
            "id": f"step-{i}",
            "concept_id": cid,
            "title": _text(concept.get("name")) or cid,
            "summary": _text(concept.get("summary")),
            "explanation": explanation,
            "examples": [x for x in (concept.get("examples") or []) if isinstance(x, str) and x.strip()],
            "misconceptions": _misconceptions(concept),
            "assessment_items": _assessment_items(concept),
            "observable_skills": [x.strip() for x in (concept.get("observable_skills") or []) if isinstance(x, str) and x.strip()],
        })

    meta = graph.get("meta") or {}
    return {
        "ir_version": IR_VERSION,
        "type": "lesson",
        "title": _text(meta.get("topic")) or "未命名课程",
        "goal": _text(meta.get("goal")) or _text(meta.get("topic")) or "未命名课程",
        "pedagogy": _text(meta.get("pedagogy")),
        "source_graph_version": int(meta.get("graph_version") or 1),
        # 注意：这里是**源 Graph 的全部** concept（不是 selected —— 即本课范围）。
        # 它和 source_graph_version 一起属于「溯源」，作用是给 steps 提供闭合校验的超集；
        # 用了 focus 时 selected 只是其中一支子树，两者不相等是正常的。
        # 想要"本课覆盖了哪些 concept"，看 steps[].concept_id。
        "source_concept_ids": [str(c.get("id")) for c in ordered_concepts if c.get("id")],
        "milestones": graph.get("milestones") or [],
        "steps": steps,
    }


def _reject_unknown(obj: dict, allowed: set[str], path: str) -> None:
    unknown = sorted(set(obj) - allowed)
    if unknown:
        raise ValueError(f"Lesson IR {path} 含未知字段: {', '.join(unknown)}")


def _require_str(value: Any, path: str, nonempty: bool = True) -> None:
    if not isinstance(value, str) or (nonempty and not value.strip()):
        raise ValueError(f"Lesson IR {path} 必须是{'非空' if nonempty else ''}字符串")


def _string_list(value: Any, path: str) -> None:
    if not isinstance(value, list):
        raise ValueError(f"Lesson IR {path} 必须是列表")
    for i, item in enumerate(value):
        _require_str(item, f"{path}[{i}]")


def _validate_assessment(item: Any, path: str) -> None:
    if not isinstance(item, dict):
        raise ValueError(f"Lesson IR {path} 必须是对象")
    # 字段集与校验规则（枚举、题干 prompt/question 至少其一非空、options/choices
    # 互斥≥2）与 Learning
    # Graph 校验器共用同一份定义（_contracts）：validate_lesson_ir 也能独立用于
    # 「读回文件再校验」，规则漂移会让手写的坏 IR 从这里漏过去。
    _reject_unknown(item, ASSESSMENT_ITEM_FIELDS, path)
    validate_assessment_item_fields(item, path)


def _validate_milestones(milestones: Any, concept_ids: set[str]) -> None:
    if not isinstance(milestones, list):
        raise ValueError("Lesson IR milestones 必须是列表")
    ids=[]
    for i, milestone in enumerate(milestones):
        path=f"milestones[{i}]"
        if not isinstance(milestone, dict):
            raise ValueError(f"Lesson IR {path} 必须是对象")
        _reject_unknown(milestone, {"id", "name", "introduces_concepts", "depends_on", "deliverable_type", "deliverable_owner", "acceptance_criteria"}, path)
        _require_str(milestone.get("id"), f"{path}.id")
        if not KEBAB_ID_RE.fullmatch(milestone["id"]):
            raise ValueError(f"Lesson IR {path}.id 必须符合 lowercase-kebab-case: {milestone['id']!r}")
        _require_str(milestone.get("name"), f"{path}.name")
        # deliverable_* 必填与枚举、introduces_concepts 必填：与 Graph 校验器同一份
        # 规则（_contracts），否则手写/旧 IR 经 validate_lesson_ir 读回校验时会漏掉
        # 缺字段的 milestone。
        validate_milestone_fields(milestone, path)
        if milestone["id"] in ids:
            raise ValueError(f"Lesson IR milestone id 重复: {milestone['id']}")
        ids.append(milestone["id"])
        _string_list(milestone["introduces_concepts"], f"{path}.introduces_concepts")
        _string_list(milestone.get("depends_on", []), f"{path}.depends_on")
        _string_list(milestone.get("acceptance_criteria", []), f"{path}.acceptance_criteria")
        for cid in milestone["introduces_concepts"]:
            if cid not in concept_ids:
                raise ValueError(f"{path}.introduces_concepts 引用不存在的 concept: {cid}")

    known=set(ids)
    deps_by_id={}
    for milestone in milestones:
        mid=milestone["id"]
        deps=milestone.get("depends_on", [])
        for dep in deps:
            if dep not in known:
                raise ValueError(f"milestones[{mid}].depends_on 引用不存在: {dep}")
        deps_by_id[mid]=deps
    # 拓扑排序全仓一份实现（_script_utils.topo_sort），不再逐处拷贝 Kahn 算法。
    topo_sort(ids, deps_by_id, "Lesson IR milestones.depends_on 存在循环依赖")


def validate_lesson_ir(ir: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(ir, dict):
        raise ValueError("Lesson IR 必须是对象")
    _reject_unknown(
        ir,
        {"ir_version", "type", "title", "goal", "pedagogy", "source_graph_version", "source_concept_ids", "milestones", "steps"},
        "root",
    )
    if ir.get("ir_version") != IR_VERSION:
        raise ValueError(f"Lesson IR ir_version 必须是 {IR_VERSION}")
    if ir.get("type") != "lesson":
        raise ValueError("Lesson IR type 必须是 lesson")
    for key in ("title", "goal"):
        _require_str(ir.get(key), f"root.{key}")

    source_concepts=ir.get("source_concept_ids")
    if not isinstance(source_concepts, list) or not source_concepts or len(source_concepts)!=len(set(source_concepts)):
        raise ValueError("Lesson IR source_concept_ids 必须是非空且唯一的列表")
    _string_list(source_concepts, "root.source_concept_ids")
    if not isinstance(ir.get("source_graph_version"), int) or isinstance(ir.get("source_graph_version"), bool):
        raise ValueError("Lesson IR 必须提供整数 source_graph_version")

    _validate_milestones(ir.get("milestones", []), set(source_concepts))
    steps=ir.get("steps")
    if not isinstance(steps, list) or not steps:
        raise ValueError("Lesson IR 必须包含非空 steps")

    allowed_step={"id", "concept_id", "title", "summary", "explanation", "examples", "misconceptions", "assessment_items", "observable_skills"}
    step_ids=set()
    for i, step in enumerate(steps):
        path=f"steps[{i}]"
        if not isinstance(step, dict):
            raise ValueError(f"Lesson IR {path} 必须是对象")
        _reject_unknown(step, allowed_step, path)
        _require_str(step.get("id"), f"{path}.id")
        _require_str(step.get("concept_id"), f"{path}.concept_id")
        if step["id"] in step_ids:
            raise ValueError(f"Lesson IR step id 重复: {step['id']}")
        step_ids.add(step["id"])
        if step["concept_id"] not in set(source_concepts):
            raise ValueError(f"{path}.concept_id 引用不存在的 source concept: {step['concept_id']}")
        for key in ("title", "summary", "explanation"):
            if key in step:
                _require_str(step[key], f"{path}.{key}", nonempty=(key!="summary" and key!="explanation"))
        for key in ("examples", "misconceptions", "assessment_items", "observable_skills"):
            if key in step and not isinstance(step[key], list):
                raise ValueError(f"Lesson IR {path}.{key} 必须是列表")
        for j, value in enumerate(step.get("examples", [])):
            _require_str(value, f"{path}.examples[{j}]")
        for j, value in enumerate(step.get("misconceptions", [])):
            if isinstance(value, str):
                _require_str(value, f"{path}.misconceptions[{j}]")
            elif isinstance(value, dict):
                _reject_unknown(value, {"misconception", "frequency"}, f"{path}.misconceptions[{j}]")
                _require_str(value.get("misconception"), f"{path}.misconceptions[{j}].misconception")
                if "frequency" in value and value["frequency"] not in {"high", "medium", "low"}:
                    raise ValueError(f"{path}.misconceptions[{j}].frequency 非法")
            else:
                raise ValueError(f"{path}.misconceptions[{j}] 必须是字符串或对象")
        for j, value in enumerate(step.get("observable_skills", [])):
            _require_str(value, f"{path}.observable_skills[{j}]")
        for j, value in enumerate(step.get("assessment_items", [])):
            _validate_assessment(value, f"{path}.assessment_items[{j}]")
    return ir


__all__=["IR_VERSION", "build_lesson_ir", "validate_lesson_ir"]
