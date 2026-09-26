#!/usr/bin/env python3
"""ffmpeg 音频操作（从 narration.py 拆出）。

包含：时长测量、静音生成、atempo 变速、拼接。
所有函数都只依赖"ffmpeg 路径 + 参数"，不碰 TTS/网络，可脱离 pipeline 单独测试。
"""
import os
import subprocess
import re
import shutil
import sys
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _contracts import validate_speed  # noqa: E402  领域规则单一来源


def _wav_duration(audio_path):
    """WAV 样本精确时长（秒）：帧数 / 帧率。零子进程、无量化误差。

    ffmpeg 打印的 `Duration:` 固定两位小数（10ms 量化），pipeline 把每句
    量化值累加进 manifest 的 start_time 时误差随机游走，长稿（200 句）可
    漂移数十 ms 到近秒级——字幕/动效同步精度直接受损。所有中间产物都是
    WAV，标准库 wave 读帧数即可精确到样本。非 WAV 或解析失败返回 None
    （调用方回退 ffmpeg -i 路径）。
    """
    try:
        with wave.open(audio_path, "rb") as w:
            frames = w.getnframes()
            rate = w.getframerate()
            if frames > 0 and rate > 0:
                return frames / float(rate)
    except (wave.Error, OSError):
        pass
    return None


def measure_duration(ffmpeg_path, audio_path):
    """Measure audio duration (ffprobe not available in imageio-ffmpeg).

    WAV 优先走样本精确路径（_wav_duration，帧数/帧率）；非 WAV 或 wave
    解析失败才回退 `ffmpeg -i` 的 stderr 正则解析（`Duration: HH:MM:SS.xx`
    行比字符串切分对 locale/格式变化更稳健）。
    Returns 0.0 if parsing fails (callers should treat 0.0 as invalid).

    显式捕获 subprocess.TimeoutExpired —— 原裸 `except Exception` 虽也能接住，
    但 30s 超时通常意味着 ffmpeg 卡死（罕见但可能），单独记日志便于诊断。
    """
    wav_dur = _wav_duration(audio_path)
    if wav_dur is not None:
        return wav_dur
    if not ffmpeg_path:
        return 0.0
    try:
        result = subprocess.run(
            [ffmpeg_path, "-i", audio_path],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=30
        )
        stderr = result.stderr or ""
        dur = parse_duration(stderr)
        if dur is not None:
            return dur
    except subprocess.TimeoutExpired:
        print(f"  [duration] ffmpeg -i timed out on {audio_path}",
              file=sys.stderr)
    except Exception as e:
        print(f"  [duration] error measuring {audio_path}: {e}",
              file=sys.stderr)
    return 0.0


def generate_silence(ffmpeg_path, duration, out_path):
    """Generate a silent WAV file of given duration.

    Primary path: ffmpeg lavfi (anullsrc). Fallback: Python wave module —
    used when the resolved ffmpeg is a minimal build (e.g. system PATH
    ffmpeg with `--disable-everything`) that does not support the lavfi
    demuxer, which would otherwise crash concat_audio and abort the whole
    pipeline. The Python fallback produces a standards-compliant 16-bit
    PCM mono WAV at 24kHz, matching the format ffmpeg -ar/-ac would emit.

    两条路都失败时抛 RuntimeError 而不是落一个 0 字节空文件——空文件混进
    concat 要么整链失败要么被静默丢弃，而调用方（pipeline 的静音兜底分支）
    已经按"异常=兜底失败"处理，能正确走 skip 路径，不会带着坏文件错位时间轴。
    """
    # encoding/errors 显式指定：中文 Windows 下 text=True 默认按 cp936 解码
    # ffmpeg stderr（UTF-8），输出路径含中文时会先抛 UnicodeDecodeError 而
    # 不是走兜底。TimeoutExpired 同样落入 wave 兜底（lavfi 卡死 30s 的
    # ffmpeg 写不出比 Python wave 更好的静音）。
    try:
        result = subprocess.run([
            ffmpeg_path, "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
            "-t", str(duration), "-ar", "24000", "-ac", "1", out_path
        ], capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=30)
    except (subprocess.TimeoutExpired, OSError):
        # OSError 覆盖 FileNotFoundError：ffmpeg 路径失效时 spawn 直接抛它，
        # 必须落入 wave 兜底而不是裸栈穿透 concat。
        result = None
    if (result is not None and result.returncode == 0
            and os.path.exists(out_path) and os.path.getsize(out_path) > 0):
        return
    # Fallback: write silent WAV via Python wave module (no ffmpeg lavfi needed)
    try:
        import wave as _wave
        sr = 24000
        n_frames = int(duration * sr)
        with _wave.open(out_path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)  # 16-bit
            w.setframerate(sr)
            # Silent frames = all zeros（bytes 直乘，比 struct.pack 巨型参数列表便宜得多）
            w.writeframes(b"\x00" * (2 * n_frames))
        return
    except Exception as e:
        raise RuntimeError(
            f"生成静音文件失败（ffmpeg lavfi 与 Python wave 兜底都不可用）: "
            f"{out_path}: {e}") from e


def build_atempo_filter(speed):
    """Build an ffmpeg atempo filter chain.

    A single atempo instance only supports 0.5x–2.0x, so decompose a
    wider range into chained instances (e.g. 3.0x -> atempo=2.0,atempo=1.5).

    入口先做一次 validate_speed：speed<=0（或非有限值）时，下面第二个
    `while remaining < 0.5` 会因 `remaining /= 0.5` 对非正数永远不收敛而死循环，
    这里改为立即抛 ValueError，而不是挂死。
    """
    validate_speed(speed)
    factors = []
    remaining = speed
    while remaining > 2.0:
        factors.append(2.0)
        remaining /= 2.0
    while remaining < 0.5:
        factors.append(0.5)
        remaining /= 0.5
    factors.append(round(remaining, 4))
    return ",".join(f"atempo={f}" for f in factors)


def apply_speed(ffmpeg_path, wav_path, speed):
    """对刚合成的 WAV 就地施加确定性语速（ffmpeg atempo）。成功返回 True。

    只在**新合成的音频**上调用：调用方的 resume 策略是"输入变了就删掉旧文件重新
    合成"，因此这里不需要原速备份、不需要补偿变速、也不需要"从备份还原"分支
    ——那套机制是为"反复在同一文件上换速"设计的，而那种情况在本流程里不会出现。
    """
    filt = build_atempo_filter(speed)
    tmp = wav_path + ".spd.tmp.wav"
    try:
        result = subprocess.run([
            ffmpeg_path, "-y", "-i", wav_path,
            "-filter:a", filt,
            "-ar", "24000", "-ac", "1", tmp
        ], capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=60)
    except (subprocess.TimeoutExpired, OSError):
        _remove_quiet(tmp)
        print("  [speed-skip] atempo timeout/ffmpeg-missing", file=sys.stderr)
        return False
    if result.returncode == 0 and os.path.exists(tmp):
        os.replace(tmp, wav_path)
        return True
    # 失败时及时清掉半写的 tmp（多次失败堆积会留磁盘残渣）
    _remove_quiet(tmp)
    print(f"  [speed-skip] atempo failed: {result.stderr[-200:]}", file=sys.stderr)
    return False


def _remove_quiet(path):
    """尽力删文件（失败清理用，删不掉也不吭声）。"""
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


def concat_audio(ffmpeg_path, file_list, gap_sec, out_path):
    """Concatenate audio files with silence gaps. Uses absolute paths (Windows safe)."""
    out_dir = os.path.dirname(os.path.abspath(out_path))
    # PID 后缀：两条管线同写一个输出目录时（并行制作两个制品），固定名临时文件
    # 会互相覆盖 list/静音内容——A 的 concat 读到 B 的文件清单。
    list_file = os.path.join(out_dir, f"_concat_list.{os.getpid()}.txt")
    silence_file = os.path.join(out_dir, f"_silence.{os.getpid()}.wav")

    if gap_sec > 0:
        try:
            generate_silence(ffmpeg_path, gap_sec, silence_file)
        except RuntimeError as e:
            # generate_silence 现在失败时抛错（不再落 0 字节空文件）；
            # concat 的错误契约是返回 bool，这里转成 False 而不是裸栈。
            print(f"  [concat] gap 静音生成失败: {e}", file=sys.stderr)
            return False

    try:
        with open(list_file, 'w', encoding='utf-8') as f:
            for i, fp in enumerate(file_list):
                # Always use absolute paths — relative paths fail silently on Windows
                abs_fp = os.path.abspath(fp).replace("\\", "/")
                # 路径含单引号时按 ffmpeg concat demuxer 规则转义（'\'' =
                # 关引号-转义引号-重开引号），英文用户名 O'Brien 这类会炸
                _esc = abs_fp.replace("'", "'\\''")
                f.write(f"file '{_esc}'\n")
                if i < len(file_list) - 1 and gap_sec > 0:
                    abs_silence = os.path.abspath(silence_file).replace("\\", "/")
                    f.write(f"file '{abs_silence}'\n")
    except OSError as e:
        # 磁盘满/权限：与本函数错误契约一致（返回 bool），不裸栈到 main
        print(f"  [concat] 写临时清单失败: {e}", file=sys.stderr)
        _remove_quiet(list_file)
        _remove_quiet(silence_file)
        return False

    # encoding/errors 显式指定（理由同 generate_silence）；TimeoutExpired
    # 单独接住——原路径直接穿透，跳过下方临时文件清理且裸栈到 main。
    result = None
    try:
        result = subprocess.run([
            ffmpeg_path, "-y", "-f", "concat", "-safe", "0",
            "-i", list_file, "-c", "copy", out_path
        ], capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=120)
    except (subprocess.TimeoutExpired, OSError):
        print("  [concat] ffmpeg concat 失败/超时（copy 路径），尝试重编码",
              file=sys.stderr)

    if result is None or result.returncode != 0:
        # Fallback: re-encode (handles codec mismatch)
        try:
            result = subprocess.run([
                ffmpeg_path, "-y", "-f", "concat", "-safe", "0",
                "-i", list_file, "-ar", "24000", "-ac", "1", out_path
            ], capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=120)
        except (subprocess.TimeoutExpired, OSError):
            print("  [concat] ffmpeg concat 失败/超时（重编码路径）", file=sys.stderr)
            result = None
        if result is not None and result.returncode != 0:
            print(f"  [concat stderr] {result.stderr[-500:]}", file=sys.stderr)

    # Cleanup temp files
    for tmp in [list_file, silence_file]:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass

    return result is not None and result.returncode == 0


# ── FFmpeg runtime helpers ─────────────────────────────────────────
def _system_ffmpeg():
    """检测系统 PATH 上是否有能正常运行的 ffmpeg，返回路径或 None。"""
    path = shutil.which("ffmpeg")
    if not path:
        return None
    try:
        r = subprocess.run([path, "-version"], capture_output=True, timeout=10)
        if r.returncode == 0 and r.stdout:
            return path
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


def get_ffmpeg():
    """Get ffmpeg executable path.

    优先用系统自带且能运行的 ffmpeg（多数 Windows 机器已通过 winget/官网安装），
    没有才回退到 imageio-ffmpeg 打包的完整版二进制。
    两者都没有时返回 None——调用方（narration.py main）在任何 TTS 调用前预检并
    给出明确安装指引；不要返回一个跑不起来的 "ffmpeg" 字符串让管线中途裸崩。
    """
    sys_ff = _system_ffmpeg()
    if sys_ff:
        return sys_ff
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
        return get_ffmpeg_exe()
    except Exception:
        # 不止 ImportError：imageio-ffmpeg 的 get_ffmpeg_exe() 在下载/校验失败时
        # 也抛别的异常；对"探测 ffmpeg 是否可用"这个意图来说都等于不可用。
        return None


def parse_duration(stderr_text):
    """从 `ffmpeg -i` 的 stderr 解析 `Duration: HH:MM:SS.xx`，返回秒数。

    本包内只有 `_audio.measure_duration` 一个调用方；WAV 走样本精确路径，
    这里是**非 WAV 或 wave 解析失败**时的兜底。收口成单一来源是为了避免
    以后再有人为另一种格式复制一份正则。解析失败返回 None。
    """
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", stderr_text or "")
    if not m:
        return None
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))

