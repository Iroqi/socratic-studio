#!/usr/bin/env python3
"""Socratic Studio — TTS 能力适配器：旁白脚本 → 音频 + 时间轴。

职责只有三件：**把文本念出来、拼成一条音轨、给出每句的起止时间。**
页面结构、配色、布局、是否播放、怎么播放都由 Agent 在自己的 HTML 里决定——
本脚本不规定页面长什么样，也不持有任何"页面应该长这样"的假设。

输入（旁白脚本，独立于 Lesson IR，不经任何上游编译）：

    普通段落：
    {
      "title": "主题",
      "opening": "开场白。",
      "segments": [
        {"id": "seg-1", "title": "小节名", "text": "这一节要念的话。",
         "voice_id": "冰糖", "speed": 1.5}
      ]
    }

    多人对话：顶层提供 speakers，段落上用 dialogue（每一轮单独分句，各自用各自音色）。

输出（写到 -o 目录）：

    combined.wav            整段音轨
    narration_timing.json   逐句起止时间（内联进 HTML 用；file:// 下不能 fetch）
"""
import argparse
import base64
import concurrent.futures
import hashlib
import json
import math
import ntpath
import os
import random
import sys
import time
from dataclasses import dataclass, field
from typing import Dict, List

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _audio import (apply_loudnorm, apply_speed, concat_audio,  # noqa: E402
                    generate_silence, get_ffmpeg, measure_duration, mix_bgm,
                    _remove_quiet)
from _contracts import (DEFAULT_CHARS_PER_SEC, DEFAULT_GAP, DEFAULT_SPEED,  # noqa: E402
                        estimate_sentence_seconds, list_voice_ids, validate_speed)
from _env import get_key, resolve_model_config  # noqa: E402
from _script_utils import (guard_not_in_skill_dir, setup_stdio,  # noqa: E402
                           split_sentences, write_json_atomic)

# 超长句提醒阈值：写稿时一句一口气念得完最好；超过只 warn 不拦截。
LONG_SENTENCE_CHARS = 45

# 分句预览最多打印多少句（长稿件逐句打印会刷屏，淹没真正的错误信息）。
_PREVIEW_LIMIT = 10

# TTS 模型默认值（唯一定义处：synth_sentence 的形参默认与 main 的
# resolve_model_config 兜底共用，不再各写一份字面量）。
DEFAULT_TTS_MODEL = "mimo-v2.5-tts"


# ===================================================================
# 一、旁白脚本 → 句子列表 + 段落分组
# ===================================================================
@dataclass
class Block:
    """一个待合成段落：sentences 是它分好的句子；turns 非空表示多人对话段落。"""
    id: str
    title: str
    tagline: str
    sentences: List[str]
    body: str = ""
    extra: Dict = field(default_factory=dict)
    turns: List[Dict] = field(default_factory=list)


def _collect_dialogue_sentences(dialogue, speakers, seg_index, seg_title):
    """把段落的 dialogue（多轮对话）拆成扁平句子 + 段内局部 turns。

    每一轮独立分句（避免"短句被并入下一轮"这类跨轮错位）；turns 记录每轮在本段内
    的句子区间 + 说话人信息（voice_id/voice_style 就近解析，下游不必再查 speakers）。
    """
    sents, turns = [], []
    for j, turn in enumerate(dialogue, 1):
        spk = turn.get("speaker")
        t_text = (turn.get("text") or "").strip()
        if not t_text:
            raise ValueError(f"第 {seg_index} 段（title={seg_title!r}）"
                             f"dialogue[{j}]（speaker={spk!r}）的 'text' 为空")
        t_sents = split_sentences(t_text)
        if not t_sents:
            raise ValueError(f"第 {seg_index} 段（title={seg_title!r}）"
                             f"dialogue[{j}]（speaker={spk!r}）分句后为空，"
                             "请检查文本是否以终止标点（。！？）结尾")
        spk_cfg = (speakers or {}).get(spk, {})
        start = len(sents)
        sents.extend(t_sents)
        turns.append({
            "start": start, "end": len(sents), "speaker": spk,
            "label": spk_cfg.get("label") or spk,
            "voice_id": spk_cfg.get("voice_id"),
            "voice_style": spk_cfg.get("voice_style"),
        })
    return sents, turns


def _collect_blocks(source, default_speed=None):
    """把结构化 source 组装成 Block 列表（opening / segments / closing）。"""
    blocks: List[Block] = []

    def _extra(seg, fallback_speed):
        extra = {}
        speed = seg.get("speed", fallback_speed)
        if speed is not None:
            extra["speed"] = speed
        for key in ("voice_id", "voice_style"):
            if seg.get(key) is not None:
                extra[key] = seg[key]
        return extra

    opening_text = (source.get("opening") or "").strip()
    if opening_text:
        blocks.append(Block(
            id="opening",
            title=source.get("opening_title") or source.get("title") or "本期内容",
            tagline=(source.get("opening_tagline") or "").strip(),
            sentences=split_sentences(opening_text),
            body=(source.get("opening_body") or "").strip(),
            # 默认与正文同速（跟随 --speed）；稿件显式给 opening_speed 时优先。
            # default_speed 为 None 时留空，由 main 的 args.speed 兜底。
            extra={"speed": source.get("opening_speed", default_speed)},
        ))

    raw_segments = source.get("segments", [])
    if not raw_segments:
        raise ValueError("source 中 'segments' 为空，至少需要一条内容段落")

    speakers = source.get("speakers") or {}
    for i, seg in enumerate(raw_segments, 1):
        title = seg.get("title", "")
        dialogue = seg.get("dialogue")
        turns = []
        if dialogue:
            sents, turns = _collect_dialogue_sentences(dialogue, speakers, i, title)
        else:
            text = (seg.get("text") or "").strip()
            if not text:
                raise ValueError(f"第 {i} 段（title={title!r}）的 'text' 字段为空")
            sents = split_sentences(text)
            if not sents:
                raise ValueError(f"第 {i} 段（title={title!r}）分句后为空，"
                                 "请检查文本是否以终止标点（。！？）结尾")
        blocks.append(Block(
            id=str(seg.get("id") or f"seg-{i}"),
            title=title,
            tagline=seg.get("tagline", ""),
            sentences=sents,
            body=(seg.get("body") or "").strip(),
            extra=_extra(seg, default_speed),
            turns=turns,
        ))

    closing_text = (source.get("closing") or "").strip()
    if closing_text:
        blocks.append(Block(
            id="closing",
            title=source.get("closing_title") or "小结",
            tagline=(source.get("closing_tagline") or "").strip(),
            sentences=split_sentences(closing_text),
            body=(source.get("closing_body") or "").strip(),
            # 同 opening：默认跟随 --speed，closing_speed 显式给出时优先。
            extra={"speed": source.get("closing_speed", default_speed)},
        ))
    return blocks


def build_parts(source, default_speed=None):
    """把结构化 source 转成 (sentences, segments)，供 main 使用。

    每段**独立**分句（不拼接成整篇再重分句）——结构化输入下每段是独立字符串，
    跨段短句合并结构上不可能发生。

    Returns:
        sentences: list[str]，按段落顺序排列的全部句子
        segments: 段落分组（id/title/tagline/body/start/end + 可选 speed/voice_*/turns）
    """
    blocks = _collect_blocks(source, default_speed)
    sentences = [s for blk in blocks for s in blk.sentences]

    segments, cursor = [], 0
    for blk in blocks:
        start, end = cursor, cursor + len(blk.sentences)
        cursor = end
        seg = {"id": blk.id, "title": blk.title, "tagline": blk.tagline,
               "body": blk.body, "start": start, "end": end}
        seg.update(blk.extra)
        if blk.turns:
            # 段内局部区间 → 全局区间，供按句覆盖音色 + 记录说话人标签。
            seg["turns"] = [
                {"start": start + t["start"], "end": start + t["end"],
                 "speaker": t["speaker"], "label": t["label"],
                 **({"voice_id": t["voice_id"]} if t["voice_id"] else {}),
                 **({"voice_style": t["voice_style"]} if t["voice_style"] else {})}
                for t in blk.turns
            ]
        segments.append(seg)

    for idx, s in enumerate(sentences, 1):
        if len(s) > LONG_SENTENCE_CHARS:
            print(f"[warn] 第 {idx} 句长达 {len(s)} 字（>{LONG_SENTENCE_CHARS}），"
                  f"念出来偏喘不过气：{s[:24]}…建议写稿时在逗号处拆成两句",
                  file=sys.stderr)
    return sentences, segments


# ===================================================================
# 二、MiMo TTS 单句合成
# ===================================================================
class BadAudioResponseError(Exception):
    """TTS 响应里没有音频（chat.completions 返回了纯文本）。

    几乎总是 --base-url/--model 指向了不支持 audio 参数的网关或模型，重试 N 次
    结果完全一样。必须整句放弃并让调用方尽早终止。
    """


def _is_non_retryable(exc):
    """重试也不会好的确定性失败：400/401/403/404/422 与"响应不含音频"。"""
    if isinstance(exc, BadAudioResponseError):
        return True
    status = getattr(exc, "status_code", None)
    return isinstance(status, int) and status in (400, 401, 403, 404, 422)


def synth_sentence(client, text, voice_id, voice_style, out_path,
                   ffmpeg_path=None, speed=1.0, max_retries=3,
                   sentence_label="", model=DEFAULT_TTS_MODEL, api_timeout=30):
    """合成一句话到 out_path，并按 speed 做确定性变速。返回 (ok, speed_applied)。

    ok：音频是否成功落盘；speed_applied：atempo 是否落上（ok=True 而
    speed_applied=False 时音频有效但仍是原速）。

    MiMo TTS 走 chat completions 格式：user 角色放音色风格描述（可选），
    assistant 角色放要念的文本，audio 参数指定格式与音色，音频以 base64 WAV
    形式返回在 choices[0].message.audio.data。
    """
    messages = []
    if voice_style:
        messages.append({"role": "user", "content": voice_style})
    messages.append({"role": "assistant", "content": text})

    audio_params = {"format": "wav"}
    if voice_id:
        audio_params["voice"] = voice_id

    for attempt in range(max_retries):
        try:
            completion = client.chat.completions.create(
                model=model, messages=messages, audio=audio_params,
                timeout=api_timeout,
            )
            # 显式检查响应结构而不是直接下钻 .data：端点/模型配错时 choices
            # 可能整个是空的，AttributeError 不带 status_code 会被归为可重试，白烧额度。
            choices = getattr(completion, "choices", None) or []
            audio_obj = getattr(choices[0].message, "audio", None) if choices else None
            audio_data = getattr(audio_obj, "data", None) if audio_obj else None
            if not audio_data:
                raise BadAudioResponseError(
                    "TTS 响应不含音频（chat.completions 返回了纯文本）——"
                    "检查 --model/--base-url 是否指向支持 audio 参数的 TTS 模型"
                    "（默认 mimo-v2.5-tts），不要指向普通对话模型")
            with open(out_path, "wb") as f:
                f.write(base64.b64decode(audio_data))
            break
        except Exception as e:  # noqa: BLE001 — 下面按异常类型分流
            label = sentence_label or (text[:30] + "...")
            if _is_non_retryable(e):
                print(f"    [{label}][fatal] {e}（确定性失败，不重试）", flush=True)
                return False, False
            print(f"    [{label}][retry {attempt+1}/{max_retries}] {e}", flush=True)
            if attempt < max_retries - 1:
                # 线性退避 + 抖动：多 worker 同步休眠同步唤醒会一起撞限流窗口。
                time.sleep(2 * (attempt + 1) + random.uniform(0.0, 1.0))
    else:
        return False, False

    if not ffmpeg_path:
        print(f"    [{sentence_label or text[:30] + '...'}][speed-skip] "
              f"ffmpeg 不可用，跳过变速（音频保持原速）", file=sys.stderr, flush=True)
        return True, False
    if abs(speed - 1.0) <= 0.01:
        return True, True
    # 变速失败保留原速音频即可（时长由实测决定，时间轴仍然准确）；重调 TTS 只会白烧额度。
    try:
        return True, apply_speed(ffmpeg_path, out_path, speed)
    except Exception as e:  # noqa: BLE001
        print(f"    [{sentence_label or text[:30] + '...'}][speed-skip] "
              f"atempo 变速失败，保留原始语速: {e}", flush=True)
        return True, False


def _sentence_hash(text, voice_id, voice_style, model, speed):
    """一句话 TTS 输入的指纹（文本 + 音色 + 风格 + 模型 + 语速），resume 用。

    缓存文件名只有句序号（s005.wav），不含内容——改了第 5 句文案后带 --resume
    重跑会复用旧音频，配音与字幕从此错位。指纹不匹配即视为缓存失效、重新合成。
    """
    payload = "\x1f".join([text, voice_id or "", voice_style or "",
                           model or "", f"{float(speed):.4f}"])
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def _write_sidecar(path, content):
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
    except OSError as e:
        print(f"  [sidecar][warn] 无法写入 {os.path.basename(path)}（{e}），"
              f"下次 --resume 会重新合成该句", file=sys.stderr)


def _drop_sentence_cache(out_path):
    """清掉某句的音频与 sidecar（重新合成前调用）。"""
    for suffix in ("", ".sha", ".failed"):
        _remove_quiet(out_path + suffix)


def _resume_decision(out_path, ffmpeg_path, text, voice_id, voice_style, model, speed):
    """--resume 时判断某句能不能跳过。返回 (action, duration)。

        "skip"        缓存可用（输入指纹一致且时长有效）
        "skip_failed" 上次已判定 TTS 失败并降级为静音——输入未变则不再重试
        "regen"       没缓存 / 指纹不符 / 时长无效 → 重新合成
    """
    def _fingerprint_matches():
        # .failed 与 skip 路径共用同一指纹语义：改稿后旧标记必须失效，
        # 否则文案已变的句子被永久跳过（repro: 改文本后仍返回 skip_failed）。
        try:
            with open(out_path + ".sha", encoding="utf-8") as f:
                cached = f.read().strip()
        except (OSError, UnicodeDecodeError):
            return False
        return cached == _sentence_hash(text, voice_id, voice_style, model, speed)

    if os.path.exists(out_path + ".failed"):
        if not _fingerprint_matches():
            return "regen", 0.0
        dur = measure_duration(ffmpeg_path, out_path) if ffmpeg_path else 0.0
        return ("skip_failed", dur) if dur and dur > 0 else ("regen", 0.0)

    if not os.path.exists(out_path):
        return "regen", 0.0
    if not _fingerprint_matches():
        return "regen", 0.0  # 无指纹（或读不了/不符）→ 无法确认内容是否已变，重合成
    dur = measure_duration(ffmpeg_path, out_path) if ffmpeg_path else 0.0
    return ("skip", dur) if dur and dur > 0 else ("regen", 0.0)


# ===================================================================
# 三、CLI
# ===================================================================
def _build_parser():
    parser = argparse.ArgumentParser(description="socratic-studio TTS 能力（旁白 → 音频 + 时间轴）")
    parser.add_argument("--source", default=None,
                        help="旁白脚本 JSON（{title, segments:[{id,title,text}]}）。"
                             "逐段独立分句，直接产出带段落分组的时间轴。"
                             "Agent 手写这一份脚本即可，无需任何上游编译。")
    parser.add_argument("-o", "--output", default=None, help="输出目录")
    parser.add_argument("--api-key", default=None,
                        help="MiMo TTS API key（默认读 .env 的 MIMO_API_KEY）")
    parser.add_argument("--voice-id", default="冰糖", choices=list_voice_ids(),
                        help="音色（默认 冰糖）")
    parser.add_argument("--voice-style",
                        default="专业新闻播报，语速适中，语气沉稳自信，中英文表达流畅自然",
                        help="音色风格描述")
    parser.add_argument("--gap", type=float, default=DEFAULT_GAP,
                        help="句间静音秒数（默认取 _contracts.DEFAULT_GAP）")
    parser.add_argument("--speed", type=float, default=DEFAULT_SPEED,
                        help="语速倍率（ffmpeg atempo，1.0=原速，1.5=快一半）")
    parser.add_argument("--loudness", type=float, default=None,
                        help="响度归一化目标（LUFS，如 -16）。默认不做归一化")
    parser.add_argument("--resume", action="store_true",
                        help="复用输入未变的句子音频（省时间的开关，不是需要维护的状态）")
    parser.add_argument("--bgm", default=None, help="背景音乐文件（mp3/wav/ogg）")
    parser.add_argument("--bgm-volume", type=float, default=0.15,
                        help="BGM 相对人声音量（0.0-1.0，默认 0.15）")
    parser.add_argument("--model", default=None,
                        help="TTS 模型（默认 MIMO_TTS_MODEL 或 'mimo-v2.5-tts'）")
    parser.add_argument("--base-url", default=None,
                        help="MiMo API base URL（默认 MIMO_BASE_URL 或官方地址）")
    parser.add_argument("--api-timeout", type=float, default=30.0,
                        help="单次 TTS 调用超时（默认 30s）")
    parser.add_argument("--dry-run", action="store_true",
                        help="只分句 + 预览，不调 TTS、不写音频")
    parser.add_argument("--workers", type=int, default=4, help="并行 TTS 调用数（默认 4）")
    parser.add_argument("--on-fail", choices=["abort", "silence"], default="abort",
                        help="单句反复失败后：abort（默认）阻断管线；silence 该句降级为"
                             "静音占位（时长按字数/语速估算），保留在时间轴与字幕位置，"
                             "时间轴对应句子带 \"synth_failed\": true")
    return parser


def _validate_args(parser, args):
    try:
        validate_speed(args.speed)
    except ValueError as e:
        parser.error(str(e))
    if not math.isfinite(args.gap) or args.gap < 0:
        parser.error(f"--gap 必须是非负有限数（收到 {args.gap}）；要无间隙拼接请显式传 0")
    if args.loudness is not None and not math.isfinite(args.loudness):
        parser.error(f"--loudness 必须是有限数值（LUFS，收到 {args.loudness}）")
    if not math.isfinite(args.bgm_volume):
        parser.error(f"--bgm-volume 必须是有限数值（0.0-1.0，收到 {args.bgm_volume}）")
    if args.workers < 1:
        parser.error(f"--workers 至少为 1（收到 {args.workers}）")
    if not math.isfinite(args.api_timeout) or args.api_timeout <= 0:
        parser.error(f"--api-timeout 必须是正有限数（秒，收到 {args.api_timeout}）")
    # --bgm 指向不存在的文件时提前警告并忽略，而不是静默跳过混音
    if args.bgm and not os.path.exists(args.bgm):
        print(f"[warn] --bgm 文件不存在，已忽略 BGM 混音：{args.bgm}", file=sys.stderr)
        args.bgm = None


def _load_script_source(path):
    """读取旁白脚本 JSON，规整成内部结构。

    唯一格式：`{title, segments:[{id,title,text,...}]}`，可选顶层 opening/closing/
    opening_title/closing_title/opening_body/closing_body/opening_tagline/
    closing_tagline/speakers。不做隐式兼容——格式不对就报错，不猜。
    """
    try:
        data = json.loads(open(path, encoding="utf-8").read())
    except (OSError, ValueError) as e:
        raise ValueError(f"无法读取旁白脚本: {e}")
    if not isinstance(data, dict) or not isinstance(data.get("segments"), list):
        raise ValueError("旁白脚本必须是 {title, segments:[...]}")

    # 承诺了"格式不对就报错，不猜"：拼错的键（opeing）若被静默忽略，
    # 对应内容就从音频里无声消失，而调用方看到的仍是"成功"。
    allowed_top = {"title", "opening", "closing", "opening_title", "closing_title",
                   "opening_body", "closing_body", "opening_tagline", "closing_tagline",
                   "opening_speed", "closing_speed", "segments", "speakers"}
    unknown_top = sorted(set(data) - allowed_top)
    if unknown_top:
        raise ValueError(f"旁白脚本含未知顶层字段：{', '.join(unknown_top)}"
                         f"（可用字段：{', '.join(sorted(allowed_top))}）")
    speakers = data.get("speakers")
    if speakers is not None and not isinstance(speakers, dict):
        raise ValueError(f"speakers 必须是对象（收到 {type(speakers).__name__}）")

    segs = []
    known_voices = set(list_voice_ids())

    def _check_voice(v, where):
        # CLI --voice-id 有 choices 白名单，逐段/逐说话人的 voice_id 也提前拦：
        # 非法音色要等到调 API 才炸，前面的句子已经烧了额度。
        if v is not None and v not in known_voices:
            raise ValueError(f"{where} 的 voice_id {v!r} 不在可用音色列表 "
                             f"{sorted(known_voices)} 中")

    def _check_speed(v, where):
        # 字符串/NaN 之类的坏 speed 若等到 atempo 阶段才炸，前面的句子已经
        # 烧了 TTS 额度——与 voice_id 同理，在这里一次拦下。
        if v is None:
            return
        try:
            validate_speed(v)
        except (ValueError, TypeError) as e:
            raise ValueError(f"{where} 的 speed 非法：{e}") from None

    def _check_str(v, where):
        if v is not None and not isinstance(v, str):
            raise ValueError(f"{where} 必须是字符串（收到 {type(v).__name__}）")

    for name, cfg in (speakers or {}).items():
        if cfg is not None and not isinstance(cfg, dict):
            raise ValueError(f"speakers.{name} 必须是对象"
                             f"（收到 {type(cfg).__name__}）")
        _check_voice((cfg or {}).get("voice_id"), f"speakers.{name}")
    for i, seg in enumerate(data["segments"], 1):
        # 承诺了"不做隐式兼容——格式不对就报错，不猜"，就不能静默跳过坏段落：
        # 跳过等于让一段内容从音频里消失，而调用方看到的仍是"成功"。
        if not isinstance(seg, dict):
            raise ValueError(f"segments[{i}] 必须是对象（收到 {type(seg).__name__}）")
        allowed_seg = {"id", "title", "text", "dialogue", "voice_id", "voice_style",
                       "speed", "body", "tagline"}
        unknown_seg = sorted(set(seg) - allowed_seg)
        if unknown_seg:
            raise ValueError(f"segments[{i}] 含未知字段：{', '.join(unknown_seg)}")
        for k in ("title", "text", "body", "tagline", "voice_style"):
            _check_str(seg.get(k), f"segments[{i}].{k}")
        _check_speed(seg.get("speed"), f"segments[{i}]")
        text = (seg.get("text") or "").strip()
        dialogue = seg.get("dialogue")
        if dialogue is not None:
            if not isinstance(dialogue, list) or not dialogue:
                raise ValueError(f"segments[{i}]（id={seg.get('id')!r}）的 'dialogue' "
                                 "必须是非空数组（多说话人按轮给出 {speaker, text}）")
            for j, turn in enumerate(dialogue, 1):
                if not isinstance(turn, dict):
                    raise ValueError(f"segments[{i}] dialogue[{j}] 必须是对象")
                unknown_turn = sorted(set(turn) - {"speaker", "text"})
                if unknown_turn:
                    raise ValueError(f"segments[{i}] dialogue[{j}] 含未知字段："
                                     f"{', '.join(unknown_turn)}")
                _check_str(turn.get("speaker"), f"segments[{i}] dialogue[{j}].speaker")
                _check_str(turn.get("text"), f"segments[{i}] dialogue[{j}].text")
                if not (turn.get("text") or "").strip():
                    raise ValueError(f"segments[{i}] dialogue[{j}] 的 'text' 为空")
        elif not text:
            raise ValueError(f"segments[{i}]（id={seg.get('id')!r}）的 'text' 为空"
                             "（多说话人段落请改用 dialogue）")
        _check_voice(seg.get("voice_id"), f"segments[{i}]")
        out = {"id": str(seg.get("id") or f"seg-{len(segs) + 1}"),
               "title": seg.get("title") or str(seg.get("id") or ""),
               "text": text}
        if dialogue is not None:
            out["dialogue"] = dialogue
        for k in ("voice_id", "voice_style", "speed", "body", "tagline"):
            if seg.get(k) is not None:
                out[k] = seg[k]
        segs.append(out)
    if not segs:
        raise ValueError("旁白脚本没有可朗读的段落内容（segments[] 既无 text 也无 dialogue）")

    result = {"title": data.get("title") or data.get("opening_title") or "",
              "segments": segs}
    for k in ("opening", "closing", "title", "opening_title", "closing_title",
              "opening_body", "closing_body", "opening_tagline", "closing_tagline"):
        _check_str(data.get(k), k)
    for k in ("opening_speed", "closing_speed"):
        _check_speed(data.get(k), k)
    for k in ("opening", "closing", "opening_title", "closing_title",
              "opening_body", "closing_body", "opening_tagline", "closing_tagline",
              "opening_speed", "closing_speed",
              "speakers"):
        if data.get(k) is not None:
            result[k] = data[k]
    return result


# ===================================================================
# 四、主管线
# ===================================================================
def _audio_ref(path):
    """把音轨路径压成制品可携带的相对引用（basename）。"""
    return ntpath.basename(str(path).replace("/", "\\")) if path else None


def _finalize_audio(args, ffmpeg_path, sentence_data, source_data, seg_config,
                    silence_fallback_count, total_sentences, cached_count):
    """拼接 → 可选 BGM/响度 → 写 narration_timing.json。"""
    print(f"\n[concat] {len(sentence_data)} clips (gap {args.gap}s)...", flush=True)
    combined_path = os.path.join(args.output, "combined.wav")
    if not concat_audio(ffmpeg_path, [s["file"] for s in sentence_data], args.gap,
                        combined_path):
        print("[error] 音频拼接失败", file=sys.stderr)
        sys.exit(1)

    total_dur = measure_duration(ffmpeg_path, combined_path)
    if not total_dur or total_dur <= 0:
        # 0 时长会产出"合法但废掉"的时间轴（渲染出无声空片），在这里拦下。
        print("[error] combined.wav 时长测量失败（0.0s）——检查磁盘空间与 ffmpeg 可用性",
              file=sys.stderr)
        sys.exit(1)
    print(f"[done] 总时长 {total_dur:.2f}s", flush=True)

    # 每句起始时间：拼接实测时长 + 句间 gap 累加（时间轴的唯一来源）。
    cumulative = 0.0
    for i, sd in enumerate(sentence_data):
        sd["start_time"] = round(cumulative, 3)
        cumulative += sd["duration"]
        if i < len(sentence_data) - 1:
            cumulative += args.gap

    if args.bgm and os.path.exists(args.bgm):
        # bgm_volume 直接拼进 ffmpeg 滤镜串：clamp 越界值，防注入与削波（NaN/Inf
        # 已在 argparse 阶段拦下，早于 TTS，不烧额度）。
        if args.bgm_volume < 0 or args.bgm_volume > 1:
            clamped = max(0.0, min(1.0, args.bgm_volume))
            print(f"[warn] --bgm-volume {args.bgm_volume} 超出 [0,1]，已钳制到 {clamped}",
                  file=sys.stderr)
            args.bgm_volume = clamped
        print(f"[bgm] 混入 {args.bgm}（音量 {args.bgm_volume}）...", flush=True)
        mixed_path = os.path.join(args.output, "combined_bgm.wav")
        if mix_bgm(ffmpeg_path, combined_path, args.bgm, args.bgm_volume, mixed_path):
            combined_path = mixed_path
        else:
            print("  [warn] BGM 混音失败，使用纯人声", flush=True)

    if args.loudness is not None:
        loud_path = os.path.join(args.output, "combined_loud.wav")
        if apply_loudnorm(ffmpeg_path, combined_path, loud_path, args.loudness):
            combined_path = loud_path
            total_dur = measure_duration(ffmpeg_path, combined_path)
            print(f"  [loudness] 已归一化到 {args.loudness} LUFS", flush=True)
        else:
            print("  [warn] 响度归一化失败，使用未归一化音频", flush=True)

    # 时间轴：一句 = 一条 {start, duration, text}；一段 = 一个 scene。
    sentences_out = []
    for s in sentence_data:
        entry = {"start": float(s["start_time"]), "duration": float(s["duration"]),
                 "text": s["text"]}
        if s.get("speaker"):
            entry["speaker"] = s["speaker"]
        if s.get("synth_failed"):
            entry["synth_failed"] = True
        sentences_out.append(entry)

    scenes = []
    for seg in seg_config or []:
        start_idx, end_idx = seg["start"], seg["end"]   # 0-based / exclusive
        seg_sentences = [e for i, e in enumerate(sentences_out)
                         if start_idx <= i < end_idx]
        if not seg_sentences:
            # 该段所有句子都没产出音频（TTS 连续失败 + --on-fail abort，或段落本身
            # 被上游丢空）。报出来，而不是写一份下游读不懂的空场景。
            print(f"\n[warn] 段落 {seg.get('id')} 没有任何可用音频，已从时间轴剔除"
                  f"（常见原因：这几段 TTS 连续失败且 --on-fail abort）",
                  file=sys.stderr, flush=True)
            continue
        start = seg_sentences[0]["start"]
        end = max(e["start"] + e["duration"] for e in seg_sentences)
        sid = str(seg.get("id"))
        dur = round(max(0.0, end - start), 3)
        scene = {
            "step_id": sid,          # interactive_runtime.js 的场景键
            "scene_id": sid,
            "title": seg.get("title", ""),
            "start": round(start, 3),
            "duration": dur,
            "end": round(end, 3),
            "sentences": seg_sentences,
        }
        # 同一份时间轴的运行时视图：把本文件内联进 `<script id="lesson-timeline">`
        # 时，`interactive_runtime.js` 直接读 scene.runtime.*，扁平字段它不认——
        # 缺了这块，每个场景会被解析成 duration 0，时钟永远停在最后一个场景，
        # 而且不报错。顶层扁平字段保留（writing.md 的画面演进用法按句索引取它）。
        scene["runtime"] = {
            "start": scene["start"],
            "duration": dur,
            "end": scene["end"],
            # 场景内相对秒数：运行时的 applyNarrationFocus 用 localTime = t - scene.start，
            # 直接塞全局 start 会让句句都落在窗口外，旁白聚焦整体静默失效。
            "narration": [{"start": round(e["start"] - start, 3),
                           "duration": e["duration"],
                           "text": e["text"]} for e in seg_sentences],
        }
        # 门禁/动画动作由 Agent 按内容填，脚本不知道页面上该聚焦什么——给空槽位，
        # 不编造动作。
        scene["runtime_actions"] = []
        scenes.append(scene)

    timing = {
        "schema_version": 1,
        "status": "degraded" if silence_fallback_count else "ok",
        "title": source_data.get("title") or "",
        "total_duration": round(total_dur, 3),
        "gap": args.gap,
        "voice_id": args.voice_id,
        # 只保留文件名：消费方按约定在同一目录下查找。
        "audio": _audio_ref(combined_path),
        "scenes": scenes,
        "degraded": {"tts_silence_fallback_count": silence_fallback_count},
    }
    # 原子写：narration_timing.json 是页面内联时间轴的唯一数据源，写到一半被
    # Ctrl-C 打断会留下截断 JSON——要么完整要么不存在。
    manifest_path = os.path.join(args.output, "narration_timing.json")
    # 音频已全部合成，此处 OSError（磁盘满/权限）若甩裸 traceback 会让调用方
    # 误以为整条管线崩溃——收口成单行错误，与读输入路径同一标准。
    try:
        write_json_atomic(manifest_path, timing, indent=2)
    except OSError as e:
        print(f"[error] 写入 {manifest_path} 失败：{e}", file=sys.stderr)
        sys.exit(1)

    print(f"\n[manifest] {manifest_path}", flush=True)
    print(f"[stats] {len(sentence_data)}/{total_sentences} 句成功（{cached_count} 句复用缓存）",
          flush=True)
    print(f"[duration] {total_dur:.2f}s", flush=True)


def _spread_segment_overrides(seg_config, args, sentences,
                              sentence_speeds, sentence_voices, speaker_labels):
    """按段落与 turns 展开每句的语速 / 音色 / 说话人标签。"""
    for seg in seg_config:
        start_idx = seg.get("start", 0)
        end_idx = seg.get("end", len(sentences))
        seg_speed = seg.get("speed")
        if seg_speed is not None:
            for si in range(start_idx, min(end_idx, len(sentences))):
                sentence_speeds[si] = seg_speed
        seg_voice_id, seg_voice_style = seg.get("voice_id"), seg.get("voice_style")
        if seg_voice_id or seg_voice_style:
            for si in range(start_idx, min(end_idx, len(sentences))):
                sentence_voices[si] = (
                    seg_voice_id or args.voice_id,
                    seg_voice_style if seg_voice_style is not None else args.voice_style,
                )
        # turns 是比段落更细的子区间：同一段里 A/B 交替发言，各自用各自音色。
        for turn in seg.get("turns", []):
            t_start = turn.get("start", start_idx)
            t_end = turn.get("end", end_idx)
            t_voice_id, t_voice_style = turn.get("voice_id"), turn.get("voice_style")
            t_label = turn.get("label") or turn.get("speaker")
            for si in range(t_start, min(t_end, len(sentences))):
                if t_voice_id or t_voice_style:
                    base_id, base_style = sentence_voices.get(
                        si, (args.voice_id, args.voice_style))
                    sentence_voices[si] = (
                        t_voice_id or base_id,
                        t_voice_style if t_voice_style is not None else base_style,
                    )
                if t_label:
                    speaker_labels[si] = t_label


def _make_sentence_entry(task, duration, speaker_labels, synth_failed=False):
    sd = {"index": task["index"], "text": task["text_tts"], "file": task["out_path"],
          "duration": round(duration, 3)}
    if task["index"] in speaker_labels:
        sd["speaker"] = speaker_labels[task["index"]]
    if synth_failed:
        sd["synth_failed"] = True
    return sd


def _synthesize_pending(args, client, ffmpeg_path, model, pending_tasks,
                        sentence_speaker_labels):
    """并行合成待处理句子。返回 (new_results, failed_indices)。"""
    new_results, failed = [], []
    total = len(pending_tasks)
    if not total:
        return new_results, failed

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        future_to_task = {
            executor.submit(synth_sentence, client, t["text_tts"], t["voice_id"],
                            t["voice_style"], t["out_path"], ffmpeg_path,
                            t["speed"], 3, t["label"], model, args.api_timeout): t
            for t in pending_tasks
        }
        done = 0
        for future in concurrent.futures.as_completed(future_to_task):
            task = future_to_task[future]
            ok, speed_applied = future.result()
            done += 1
            label, out_path = task["label"], task["out_path"]
            preview = task["text_tts"][:30]

            if ok and os.path.exists(out_path):
                dur = measure_duration(ffmpeg_path, out_path)
                if dur > 0:
                    # 指纹 sidecar：resume 时用它判断这句是不是同一份输入。
                    _write_sidecar(out_path + ".sha", _sentence_hash(
                        task["text_tts"], task["voice_id"], task["voice_style"],
                        model, task["speed"]))
                    if not speed_applied:
                        # 不要承诺"下次 --resume 会重试"：这句的指纹 sidecar 已经
                        # 写好，_resume_decision 会判定缓存可用而直接 skip，重试
                        # 永远不会发生。如实说明，并给出真正可行的动作。
                        print(f"    [{label}][warn] 该句仍为原速（atempo 未落上）。"
                              f"--resume 不会重跑它（指纹已写入即视为缓存可用），"
                              f"要重新变速请删掉 {os.path.basename(out_path)} 及其 "
                              f".sha 后重跑", file=sys.stderr)
                    new_results.append(_make_sentence_entry(
                        task, dur, sentence_speaker_labels))
                    # 这句这次真成功了：清掉上一轮留下的失败标记（否则下轮会被误判
                    # 为"已失败的静音占位"而跳过）。
                    _remove_quiet(out_path + ".failed")
                    print(f"[TTS {done}/{total}] {label} {preview} -> {dur:.2f}s", flush=True)
                    continue

            if args.on_fail == "silence":
                # 降级：该句反复失败（如触发内容审核）时不丢弃，改为静音占位；
                # 时长只能按字数/语速估算（没有真实语速可测），估算已除过 speed。
                fallback_dur = max(estimate_sentence_seconds(
                    task["text_tts"], DEFAULT_CHARS_PER_SEC, task["speed"]), 0.3)
                try:
                    generate_silence(ffmpeg_path, fallback_dur, out_path)
                    # .failed 标记 + 指纹：下次 --resume 认得出这句是"已失败的静音
                    # 占位"，既不重试也不丢标记。
                    _write_sidecar(out_path + ".sha", _sentence_hash(
                        task["text_tts"], task["voice_id"], task["voice_style"],
                        model, task["speed"]))
                    _write_sidecar(out_path + ".failed", "")
                    new_results.append(_make_sentence_entry(
                        task, fallback_dur, sentence_speaker_labels, synth_failed=True))
                    print(f"[TTS {done}/{total}] {label} {preview} "
                          f"[失败 → 静音兜底 ~{fallback_dur:.2f}s，建议事后补录]", flush=True)
                    continue
                except Exception as e:  # noqa: BLE001
                    print(f"[TTS {done}/{total}] {label} {preview} "
                          f"[失败，且静音兜底也失败: {e}]", flush=True)

            failed.append(task["index"])
            print(f"[TTS {done}/{total}] {label} {preview} [失败]", flush=True)
    return new_results, failed


def main():
    setup_stdio()
    parser = _build_parser()
    args = parser.parse_args()
    _validate_args(parser, args)

    if not args.output and not args.dry_run:
        parser.error("缺少 -o/--output（--dry-run 不需要）")
    if not args.source:
        parser.error("缺少 --source")
    # 产物路径守卫：--dry-run 承诺不写文件，不需要拦
    if not args.dry_run:
        guard_not_in_skill_dir(("-o/--output", os.path.abspath(args.output)))

    api_key = get_key("MIMO_API_KEY", args.api_key, source_path=args.source)
    if not api_key and not args.dry_run:
        print("[error] 没有 API key。用 --api-key 或设置 .env 的 MIMO_API_KEY",
              file=sys.stderr)
        sys.exit(1)
    model, base_url = resolve_model_config(
        args.model, args.base_url, "MIMO_TTS_MODEL", DEFAULT_TTS_MODEL,
        source_path=args.source)

    try:
        source_data = _load_script_source(args.source)
        sentences, seg_config = build_parts(source_data, default_speed=args.speed)
    except ValueError as e:
        print(f"[error] 旁白脚本无效：{e}", file=sys.stderr)
        sys.exit(1)
    if not sentences:
        print("[error] 旁白脚本分句为空", file=sys.stderr)
        sys.exit(1)

    print(f"[script] {sum(len(s) for s in sentences)} chars", flush=True)
    print(f"[split] {len(sentences)} sentences", flush=True)
    for i, s in enumerate(sentences[:_PREVIEW_LIMIT]):
        print(f"  {i+1}. {s[:35] + '...' if len(s) > 35 else s}", flush=True)
    if len(sentences) > _PREVIEW_LIMIT:
        print(f"  ...（其余 {len(sentences) - _PREVIEW_LIMIT} 句已省略）", flush=True)

    if args.dry_run:
        print("\n[dry-run] 分句与段落识别完成：未调 TTS、未写音频。", flush=True)
        return

    # -o 指到已存在的同名文件（手滑把文件路径当目录传）时提前拦下
    if os.path.isfile(args.output):
        print(f"[error] 输出路径 {args.output} 是一个已存在的文件，--output 需要目录路径",
              file=sys.stderr)
        sys.exit(1)
    try:
        os.makedirs(args.output, exist_ok=True)
        sentences_dir = os.path.join(args.output, "sentences")
        os.makedirs(sentences_dir, exist_ok=True)
    except OSError as e:
        print(f"[error] 无法创建输出目录 {args.output}：{e}", file=sys.stderr)
        sys.exit(1)

    # ffmpeg 预检必须在调用任何 TTS 之前：拼接音轨离不开它，而句子是逐句烧额度的——
    # 缺 ffmpeg 却跑完整段合成，等于付全款买一堆散落的句子文件，最后死在 concat。
    ffmpeg_path = get_ffmpeg()
    if not ffmpeg_path:
        print("[error] 未找到可用的 ffmpeg：系统 PATH 上没有，imageio-ffmpeg 也未安装。\n"
              "        安装任一项后重跑：winget install Gyan.FFmpeg 或 pip install imageio-ffmpeg。\n"
              "        页面没有音频也必须成立——不需要配音时可直接跳过本脚本。",
              file=sys.stderr)
        sys.exit(1)

    try:
        from openai import OpenAI
    except ImportError:
        # 与 ffmpeg 预检同一标准：单行指引，不把裸 traceback 甩给调用方。
        print("[error] 未安装 openai SDK：pip install openai 后重跑。\n"
              "        页面没有音频也必须成立——不需要配音时可直接跳过本脚本。",
              file=sys.stderr)
        sys.exit(1)
    # max_retries=0：SDK 内部默认还会静默重试 2 次，叠加本模块自己的 3 次应用层
    # 重试 = 单句最多 6 次请求。重试策略统一收口到 synth_sentence。
    client = OpenAI(api_key=api_key, base_url=base_url, max_retries=0)
    print(f"[api] model={model} base_url={base_url}", flush=True)

    sentence_speeds, sentence_voices, sentence_speaker_labels = {}, {}, {}
    _spread_segment_overrides(seg_config, args, sentences, sentence_speeds,
                              sentence_voices, sentence_speaker_labels)

    sentence_data, pending_tasks, cached_count = [], [], 0
    for i, sent_text in enumerate(sentences):
        out_path = os.path.join(sentences_dir, f"s{i+1:03d}.wav")
        task = {"index": i, "text_tts": sent_text, "out_path": out_path,
                "label": f"s{i+1:03d}/{len(sentences):03d}",
                "speed": sentence_speeds.get(i, args.speed),
                "voice_id": sentence_voices.get(i, (args.voice_id, args.voice_style))[0],
                "voice_style": sentence_voices.get(i, (args.voice_id, args.voice_style))[1]}

        if args.resume and os.path.exists(out_path):
            action, dur = _resume_decision(out_path, ffmpeg_path, sent_text,
                                           task["voice_id"], task["voice_style"],
                                           model, task["speed"])
            if action != "regen":
                sentence_data.append(_make_sentence_entry(
                    task, dur, sentence_speaker_labels,
                    synth_failed=(action == "skip_failed")))
                cached_count += 1
                print(f"  [{task['label']}][skip] {dur:.2f}s (cached)", flush=True)
                continue
            print(f"  [{task['label']}] 稿件/音色/语速已变或缓存不完整，重新合成", flush=True)
            _drop_sentence_cache(out_path)

        pending_tasks.append(task)

    pending_count = len(pending_tasks)
    if pending_count:
        mean_chars = sum(len(t["text_tts"]) for t in pending_tasks) / pending_count
        est = mean_chars / DEFAULT_CHARS_PER_SEC * pending_count * 1.2 / max(args.workers, 1)
        print(f"[est] 待合成 {pending_count} 句，约 {est:.0f}s"
              f"（≤{args.workers} 并发，句均 {mean_chars:.1f} 字）", flush=True)

    new_results, failed = _synthesize_pending(
        args, client, ffmpeg_path, model, pending_tasks, sentence_speaker_labels)

    sentence_data.extend(new_results)
    sentence_data.sort(key=lambda s: s["index"])

    if not sentence_data:
        print("[error] 所有句子都失败了", file=sys.stderr)
        sys.exit(1)
    if failed and args.on_fail == "abort":
        print(f"\n[error] {len(failed)} 句 TTS 失败：{[f + 1 for f in failed]}。"
              "默认 --on-fail abort 阻断管线，避免静默丢失内容；"
              "如需保留时间轴并显式进入 degraded 状态，请改用 --on-fail silence。",
              file=sys.stderr, flush=True)
        sys.exit(1)
    if failed:
        # 静音兜底也失败时不能继续拼接：缺失句子会让音频、字幕和 scene 索引错位。
        print(f"\n[error] {len(failed)} 句 TTS 失败且静音兜底也未成功：{[f + 1 for f in failed]}。"
              "已停止，避免生成与字幕错位的时间轴。", file=sys.stderr, flush=True)
        sys.exit(1)

    silence_fallback_count = sum(1 for s in sentence_data if s.get("synth_failed"))
    if silence_fallback_count:
        print(f"\n[warn] {silence_fallback_count} 句无有效配音（静音占位，含历史缓存复用），"
              f"成片对应位置为静音；可核对 narration_timing.json 中 "
              f"\"synth_failed\": true 的句子并考虑补录", flush=True)

    _finalize_audio(args, ffmpeg_path, sentence_data, source_data, seg_config,
                    silence_fallback_count, len(sentences), cached_count)


if __name__ == "__main__":
    main()
