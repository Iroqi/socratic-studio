#!/usr/bin/env python3
"""Learning Graph 校验器：严格校验 + 误解归一 + 按 depends_on 拓扑排序。

产物仍是 Learning Graph（可直接用 --json-input 回读再校验）——写讲解和制品时直接读
这份有序清单，不做任何表现层决定。
"""
from __future__ import annotations
import argparse, os, re, sys
SCRIPTS_DIR=os.path.dirname(os.path.abspath(__file__))
if SCRIPTS_DIR not in sys.path: sys.path.insert(0,SCRIPTS_DIR)
from _contracts import (ASSESSMENT_ITEM_FIELDS, KEBAB_ID_RE,
                        normalize_misconceptions, strict_json_loads,
                        validate_assessment_item_fields)
from _script_utils import (guard_not_in_skill_dir, setup_stdio, topo_sort,
                           write_json_atomic)

# 字段白名单单一来源：Markdown 入口与严格校验器共用同一份定义。手抄两份时
# 漏改一处就会出现"上游合法、下游判未知字段"或反之——与 _contracts 里
# ASSESSMENT_ITEM_FIELDS 收口的动机相同。
CONCEPT_FIELDS = {"id", "name", "summary", "explanation", "importance",
                  "depends_on", "misconceptions", "confused_with", "examples",
                  "counterexamples", "observable_skills", "assessment_items"}

def _parse_pipe_fields(line):
    fields={}
    # Quote-aware so canonical values such as prompt: "A | B" remain one field.
    parts = _split_top_level(line.strip(), delimiter='|')
    for part in parts:
        if ':' not in part:
            raise ValueError(f'非法 canonical field（缺少 ":"）：{part!r}')
        k,v=part.split(':',1)
        key=k.strip().lower().replace(' ','_')
        if not key:
            raise ValueError(f'非法 canonical field（字段名为空）：{part!r}')
        if key in fields:
            raise ValueError(f'重复 canonical 字段：{key}')
        fields[key]=_parse_value(v)
    return fields

def _split_top_level(text, delimiter=','):
    out=[]; buf=[]; depth=0; quote=None; escape=False
    for ch in text:
        if escape:
            buf.append(ch); escape=False; continue
        if quote:
            buf.append(ch)
            if ch == "\\": escape=True
            elif ch == quote: quote=None
            continue
        # 只有双引号开字符串；撇号（It's、don't）是正文的一部分。
        # 单引号字符串的拒绝在 _parse_scalar：整段值以 ' 开头/结尾才报错。
        if ch == '"': quote=ch; buf.append(ch); continue
        if ch in "[({":
            depth += 1
        elif ch in ")]}":
            if depth == 0:
                raise ValueError(f'canonical 表达式出现多余闭合分隔符：{ch!r}')
            depth -= 1
        if ch == delimiter and depth == 0:
            out.append(''.join(buf).strip()); buf=[]
        else: buf.append(ch)
    if quote is not None:
        raise ValueError('canonical 表达式存在未闭合字符串引号')
    if depth != 0:
        raise ValueError('canonical 表达式存在未闭合分隔符')
    if buf: out.append(''.join(buf).strip())
    return [x for x in out if x]

def _parse_scalar(value):
    # 标量分支。list/object 形态的分流只在 _parse_value 一处，不各写一份。
    value=value.strip()
    if not value:
        return ''
    low=value.lower()
    if low == 'true': return True
    if low == 'false': return False
    if low == 'null': return None
    if low == 'none': raise ValueError(f'canonical Markdown 不允许 Python 风格的 None 字面量：{value!r}')
    if re.fullmatch(r'-?\d+', value):
        return int(value)
    if re.fullmatch(r'-?(?:\d+\.\d*|\.\d+)', value):
        return float(value)
    if value.startswith('"') or value.endswith('"'):
        if not (value.startswith('"') and value.endswith('"')):
            raise ValueError(f'非法 canonical scalar：{value!r}')
        try:
            return strict_json_loads(value)
        except Exception as exc:
            raise ValueError(f'非法 JSON 字符串：{value!r}') from exc
    if value.startswith("'") or value.endswith("'"):
        raise ValueError(f'canonical Markdown 不允许单引号字符串：{value!r}')
    return value

def _parse_value(value):
    value=value.strip()
    if value.startswith('[') or value.endswith(']'):
        if not (value.startswith('[') and value.endswith(']')):
            raise ValueError(f'非法 canonical list：{value!r}')
        return _parse_list(value)
    if value.startswith('{') or value.endswith('}'):
        if not (value.startswith('{') and value.endswith('}')):
            raise ValueError(f'非法 canonical object：{value!r}')
        return _parse_loose_object(value)
    return _parse_scalar(value)

def _parse_loose_object(text):
    text=text.strip()
    if not (text.startswith('{') and text.endswith('}')):
        raise ValueError(f'非法对象语法：{text!r}')
    inner=text[1:-1].strip()
    if not inner:
        return {}
    if inner.endswith(','):
        raise ValueError(f'canonical object 不允许尾逗号：{text!r}')
    obj={}
    for part in _split_top_level(inner):
        if not part or ':' not in part:
            raise ValueError(f'非法对象字段（缺少 ":"）：{part!r}')
        key,val=part.split(':',1)
        key=key.strip()
        if not key or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_ -]*', key):
            raise ValueError(f'非法对象字段名：{key!r}')
        key=key.strip().replace(' ','_').lower()
        if key in obj:
            raise ValueError(f'重复对象字段：{key}')
        obj[key]=_parse_value(val)
    return obj

def _parse_list(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('canonical list 不能为空')
    raw=value.strip()
    if not (raw.startswith('[') and raw.endswith(']')):
        raise ValueError(f'非法 canonical list：{value!r}')
    inner=raw[1:-1].strip()
    if not inner:
        return []
    if inner.endswith(','):
        raise ValueError(f'canonical list 不允许尾逗号：{value!r}')

    # Strict JSON is accepted for machine-authored nested structures.
    try:
        parsed=strict_json_loads(raw)
        if isinstance(parsed,list):
            return parsed
    except Exception:
        pass

    items=_split_top_level(inner)
    # Canonical compact object syntax: [type: apply, prompt: "..."] is one object.
    # 字段白名单与校验器共用同一份定义（_contracts.ASSESSMENT_ITEM_FIELDS）。
    # 每一段都带 ":" 却认不出字段名时，几乎总是条目里写了不存在的键——直接点名，
    # 不要退回"把它当字符串列表"再报一句和字段无关的 scalar 错误。
    if len(items) >= 2 and all(':' in item for item in items):
        keys=[item.split(':',1)[0].strip().strip('"').lower() for item in items]
        if all(k in ASSESSMENT_ITEM_FIELDS for k in keys):
            return [_parse_loose_object('{' + inner + '}')]
        if any(k in ASSESSMENT_ITEM_FIELDS for k in keys):
            unknown=[k for k in keys if k not in ASSESSMENT_ITEM_FIELDS]
            raise ValueError(f'assessment_items 条目含未知字段：{", ".join(unknown)}'
                             f'（题面用 prompt，离散选项用 options）')

    parsed=[]
    for item in items:
        if not item:
            raise ValueError(f'非法 canonical list item：{value!r}')
        parsed.append(_parse_value(item))
    return parsed

def _concept_from_fields(fields):
    allowed=CONCEPT_FIELDS
    unknown=sorted(set(fields)-allowed)
    if unknown:
        raise ValueError(f'Concept 含未知字段: {", ".join(unknown)}')
    list_fields=("depends_on","misconceptions","confused_with","examples","counterexamples","observable_skills","assessment_items")
    concept={}
    for key in allowed - set(list_fields):
        if key in fields and fields.get(key)!="": concept[key]=fields[key]
    for key in list_fields:
        if key in fields:
            concept[key]=fields[key] if isinstance(fields[key], list) else _parse_list(fields[key])
    return concept

def parse_markdown_graph(path):
    """Strict parser for the canonical Learning Graph Markdown format."""
    text=open(path,encoding='utf-8').read()
    lines=text.splitlines()
    if not lines:
        raise ValueError('Learning Graph Markdown 不能为空')
    m_topic=re.match(r'^\[LEARNING GRAPH\s*[—-]\s*(.+?)\]\s*$', lines[0].strip())
    if not m_topic:
        raise ValueError('Learning Graph Markdown 缺少合法的 [LEARNING GRAPH — <topic>] 标题')

    meta={'topic':m_topic.group(1).strip()}; learner={}; concepts=[]
    allowed_header={'goal','pedagogy','graph_version','learner_profile'}
    allowed_learner={'background','known_concepts','pace'}
    seen_meta=set(); seen_sections=set(); section='meta'; i=1

    def set_meta(key,value):
        if key in seen_meta: raise ValueError(f'重复 canonical 字段：{key}')
        seen_meta.add(key); meta[key]=value

    while i < len(lines):
        raw=lines[i]; stripped=raw.strip(); lineno=i+1
        if not stripped:
            i+=1; continue

        if stripped=='=== Concepts ===':
            if 'concepts' in seen_sections: raise ValueError('重复 Concepts section')
            seen_sections.add('concepts'); section='concepts'; i+=1; continue
        if stripped.startswith('==='):
            raise ValueError(f'第 {lineno} 行存在未知 section: {stripped}')
        # Meta fields before Concepts, or after a learner_profile block.
        if section in {'meta','post_concepts'} and not raw[:1].isspace():
            m=re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\s*:(.*)$',stripped)
            if not m: raise ValueError(f'第 {lineno} 行非法 Learning Graph Markdown 顶层语法: {stripped}')
            key=m.group(1).lower(); value=m.group(2).strip()
            if key not in allowed_header: raise ValueError(f'Learning Graph Markdown 含未知顶层字段: {key}')
            if key=='learner_profile':
                if key in seen_meta: raise ValueError('重复 canonical 字段：learner_profile')
                seen_meta.add(key); section='learner_profile'; i+=1; continue
            if not value: raise ValueError(f'{key} 不能为空，第 {lineno} 行')
            if key=='graph_version':
                if not re.fullmatch(r'\d+',value): raise ValueError(f'graph_version 必须是整数，第 {lineno} 行')
                value=int(value)
            set_meta(key,value); i+=1; continue

        if section=='learner_profile':
            if not raw[:1].isspace():
                # Any top-level field closes learner_profile and must be parsed as a normal meta line.
                section='post_concepts'
                continue
            m=re.match(r'^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:(.*)$',raw)
            if not m: raise ValueError(f'第 {lineno} 行 learner_profile 字段非法: {stripped}')
            key=m.group(1).lower(); value=m.group(2).strip()
            if key not in allowed_learner: raise ValueError(f'Learning Graph Markdown learner_profile 含未知字段: {key}')
            if key in learner: raise ValueError(f'重复 learner_profile 字段：{key}')
            learner[key]=_parse_list(value) if key=='known_concepts' else value
            i+=1; continue

        if section=='concepts':
            cm=re.match(r'^\s*\d+\.\s+id\s*:',stripped,re.I)
            if not cm: raise ValueError(f'第 {lineno} 行 Concepts section 中存在非法语法: {stripped}')
            c_fields=_parse_pipe_fields(re.sub(r'^\s*\d+\.\s+','',stripped)); concept_index=len(concepts); i+=1
            while i < len(lines):
                nxt=lines[i]; ns=nxt.strip()
                if not ns: i+=1; continue
                if not nxt[:1].isspace(): break
                # Indented lines belong to the current concept only.
                if re.match(r'^\s*\d+\.\s+id\s*:',ns,re.I):
                    break
                cont=_parse_pipe_fields(ns)
                dup=sorted(set(c_fields).intersection(cont))
                if dup: raise ValueError(f'concepts[{concept_index}] 含重复 canonical 字段：{", ".join(dup)}')
                c_fields.update(cont); i+=1
            c=_concept_from_fields(c_fields)
            if not c.get('id'): raise ValueError(f'concepts[{concept_index}] 缺少 id')
            concepts.append(c); continue

        if section=='post_concepts':
            raise ValueError(f'第 {lineno} 行无法匹配 canonical Learning Graph 语法: {stripped}')

        raise ValueError(f'第 {lineno} 行无法匹配 canonical Learning Graph 语法: {stripped}')

    if learner: meta['learner_profile']=learner
    if not concepts: raise ValueError('未找到 canonical Learning Graph 的 === Concepts === 条目')
    return {'meta':meta,'concepts':concepts}

def parse_json_graph(path):
    data=strict_json_loads(open(path,encoding='utf-8').read())
    if not isinstance(data,dict) or not isinstance(data.get('concepts'),list): raise ValueError('Learning Graph JSON 必须包含 concepts[]')
    return data


def _require_type(value, expected, path):
    if not isinstance(value, expected):
        names = ", ".join(t.__name__ for t in expected) if isinstance(expected, tuple) else expected.__name__
        raise ValueError(f"Learning Graph 字段 {path} 类型错误：期望 {names}，实际 {type(value).__name__}")


def _validate_string_list(value, path):
    _require_type(value, list, path)
    for i, item in enumerate(value):
        if not isinstance(item, str) or not item.strip():
            raise ValueError(f"Learning Graph 字段 {path}[{i}] 必须是非空字符串")


def _reject_unknown(obj, allowed, path):
    if not isinstance(obj, dict):
        raise ValueError(f"Learning Graph 字段 {path} 必须是对象")
    unknown = sorted(set(obj) - set(allowed))
    if unknown:
        raise ValueError(f"{path} 含未知字段: {', '.join(unknown)}")

def _validate_assessment_item(a, path):
    _require_type(a, dict, path)
    # 字段集与校验规则（枚举、题干 prompt 非空、options ≥2）的唯一定义处在
    # _contracts：Markdown 与 --json-input 两个入口各写一份
    # 时，必然出现一个入口拦得住、另一个拦不住的坏数据。
    _reject_unknown(a, ASSESSMENT_ITEM_FIELDS, path)
    validate_assessment_item_fields(a, path)

def validate_learning_graph(graph):
    """Strict executable validation for the Learning Graph contract; fail fast, never silently drop fields."""
    _require_type(graph, dict, "root")
    allowed_root = {"meta", "concepts"}
    unknown_root = sorted(set(graph) - allowed_root)
    if unknown_root:
        raise ValueError(f"Learning Graph root 含未知字段: {', '.join(unknown_root)}")
    meta = graph.get("meta", {})
    _require_type(meta, dict, "meta")
    allowed_meta = {"topic", "goal", "pedagogy", "graph_version", "learner_profile"}
    unknown_meta = sorted(set(meta) - allowed_meta)
    if unknown_meta:
        raise ValueError(f"Learning Graph meta 含未知字段: {', '.join(unknown_meta)}")
    for req in ("topic", "pedagogy"):
        if not isinstance(meta.get(req), str) or not meta[req].strip():
            raise ValueError(f"Learning Graph meta.{req} 必填且必须是非空字符串")
    if "goal" in meta: _require_type(meta["goal"], str, "meta.goal")
    if "graph_version" in meta and (not isinstance(meta["graph_version"], int) or isinstance(meta["graph_version"], bool) or meta["graph_version"] < 1):
        raise ValueError("Learning Graph meta.graph_version 必须是 >=1 的整数")
    if "learner_profile" in meta:
        lp=meta["learner_profile"]; _require_type(lp, dict, "meta.learner_profile")
        _reject_unknown(lp, {"background","pace","known_concepts"}, "meta.learner_profile")
        if "background" in lp: _require_type(lp["background"], str, "meta.learner_profile.background")
        if "pace" in lp and lp["pace"] not in {"fast","normal","slow"}: raise ValueError("meta.learner_profile.pace 必须为 fast|normal|slow")
        if "known_concepts" in lp: _validate_string_list(lp["known_concepts"], "meta.learner_profile.known_concepts")
    concepts=graph.get("concepts")
    _require_type(concepts, list, "concepts")
    if not concepts: raise ValueError("Learning Graph concepts[] 不能为空")
    ids=[]
    valid_importance={"core","supporting","optional"}
    for i,c in enumerate(concepts):
        path=f"concepts[{i}]"; _require_type(c, dict, path)
        unknown_concept = sorted(set(c) - CONCEPT_FIELDS)
        if unknown_concept:
            raise ValueError(f"{path} 含未知字段: {', '.join(unknown_concept)}")
        for req in ("id","name","summary"):
            if not isinstance(c.get(req), str) or not c.get(req).strip(): raise ValueError(f"{path}.{req} 必填且必须是非空字符串")
        cid=c["id"]
        if cid in ids: raise ValueError(f"重复 concept id: {cid}")
        if not KEBAB_ID_RE.fullmatch(cid): raise ValueError(f"{path}.id 必须符合 lowercase-kebab-case: {cid!r}")
        ids.append(cid)
        if "depends_on" in c: _validate_string_list(c["depends_on"], f"{path}.depends_on")
        if "confused_with" in c: _validate_string_list(c["confused_with"], f"{path}.confused_with")
        for key in ("examples","counterexamples","observable_skills"):
            if key in c: _validate_string_list(c[key], f"{path}.{key}")
        if "importance" in c and c["importance"] not in valid_importance: raise ValueError(f"{path}.importance 非法")
        if "explanation" in c and not isinstance(c["explanation"], str):
            raise ValueError(f"{path}.explanation 必须是字符串")
        if "misconceptions" in c:
            _require_type(c["misconceptions"], list, f"{path}.misconceptions")
            for j,m in enumerate(c["misconceptions"]):
                if isinstance(m,str): continue
                _require_type(m, dict, f"{path}.misconceptions[{j}]")
                _reject_unknown(m, {"misconception","frequency"}, f"{path}.misconceptions[{j}]")
                if not isinstance(m.get("misconception"), str) or not m.get("misconception").strip(): raise ValueError(f"{path}.misconceptions[{j}].misconception 必填")
                if "frequency" in m and m["frequency"] not in {"high","medium","low"}: raise ValueError(f"{path}.misconceptions[{j}].frequency 非法")
        if "assessment_items" in c:
            _require_type(c["assessment_items"], list, f"{path}.assessment_items")
            for j,a in enumerate(c["assessment_items"]):
                _validate_assessment_item(a, f"{path}.assessment_items[{j}]")
    idset=set(ids)
    for i,c in enumerate(concepts):
        for dep in c.get("depends_on") or []:
            if dep not in idset: raise ValueError(f"concepts[{i}].depends_on 引用不存在的 concept: {dep}")
        for other in c.get("confused_with") or []:
            if other not in idset: raise ValueError(f"concepts[{i}].confused_with 引用不存在的 concept: {other}")
    if "learner_profile" in meta and "known_concepts" in meta["learner_profile"]:
        for cid in meta["learner_profile"]["known_concepts"]:
            if cid not in idset:
                raise ValueError(f"meta.learner_profile.known_concepts 引用不存在的 concept: {cid}")
    return graph


def downstream_subtree(ordered, focus):
    """focus 语义：目标 concept 加所有直接或间接依赖它的后继，保持原有拓扑顺序。

    不自动带上目标的上游前置——课程需要前置知识时，把前置 concept 显式写进 Graph。
    """
    ids={c.get('id') for c in ordered}
    if focus not in ids: raise ValueError(f'找不到概念 {focus!r}')
    keep={focus}; changed=True
    while changed:
        changed=False
        for c in ordered:
            if c.get('id') not in keep and any(dep in keep for dep in (c.get('depends_on') or [])):
                keep.add(c['id']); changed=True
    return [c for c in ordered if c.get('id') in keep]

def validate_and_order(path, json_input=False, focus=None):
    graph=parse_json_graph(path) if json_input else parse_markdown_graph(path)
    normalize_misconceptions(graph.get('concepts') or [])
    validate_learning_graph(graph)
    ordered=order_concepts(graph)
    graph['concepts']=downstream_subtree(ordered, focus) if focus else ordered
    return graph

def order_concepts(graph):
    # id 非空且不重复由 validate_learning_graph 保证，这里直接按 id 建索引。
    concepts=graph['concepts']; by_id={c['id']:c for c in concepts}
    deps={}
    for c in concepts:
        cdeps=c.get('depends_on') or []
        for dep in cdeps:
            if dep not in by_id: raise ValueError(f"概念 {c['id']!r} 依赖不存在的 concept {dep!r}")
        deps[c['id']]=cdeps
    # 拓扑排序全仓一份实现（_script_utils.topo_sort），不再逐处拷贝 Kahn 算法。
    order=topo_sort(list(by_id), deps, 'Learning Graph 存在循环依赖')
    return [by_id[cid] for cid in order]

def main():
    setup_stdio()
    ap=argparse.ArgumentParser(description='校验 Learning Graph 并输出按依赖排序的规范化 Graph')
    ap.add_argument('graph'); ap.add_argument('-o','--output',required=True); ap.add_argument('--json-input',action='store_true'); ap.add_argument('--focus',default=None)
    a=ap.parse_args()
    # 与 narration.py 同一个守卫：产物不得落进技能目录（文档示例命令用的是相对路径）。
    guard_not_in_skill_dir(("-o/--output", os.path.abspath(a.output)))
    try:
        graph=validate_and_order(a.graph,a.json_input,a.focus)
    except UnicodeDecodeError:
        # UnicodeDecodeError 是 ValueError 子类：必须抢在前面单独报，
        # 否则非 UTF-8 文件会被误报成「Learning Graph 无效」。
        print(f'[error] 文件编码不是 UTF-8: {a.graph}',file=sys.stderr)
        sys.exit(1)
    except FileNotFoundError:
        print(f'[error] 找不到输入文件: {a.graph}',file=sys.stderr)
        sys.exit(1)
    except OSError as e:
        # 其余 IO 问题（权限、目录当文件读……）同样只报单行，不甩 traceback。
        print(f'[error] 读取输入文件失败: {a.graph}（{e}）',file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        # 与 narration.py 一致：单行错误 + exit 1，而不是把整段 traceback 甩给调用方。
        print(f'[error] Learning Graph 无效：{e}',file=sys.stderr)
        sys.exit(1)
    # 上面的异常出口只覆盖"读输入"；`-o` 给了目录时 os.replace 会在这里裸抛
    # PermissionError，与"不甩 traceback"的承诺不符——写路径同样收口。
    if os.path.isdir(a.output):
        print(f'[error] -o/--output 必须是文件路径，不是目录: {a.output}',file=sys.stderr)
        sys.exit(1)
    try:
        write_json_atomic(a.output,graph,indent=2)
    except OSError as e:
        print(f'[error] 写入输出失败: {a.output}（{e}）',file=sys.stderr)
        sys.exit(1)
    print(f'[graph] 校验通过，有序 Graph -> {a.output}')
if __name__=='__main__': main()
