"""Text-to-speech — British female voice via edge-tts."""

from __future__ import annotations

import asyncio
import subprocess
import sys
import tempfile
from pathlib import Path


class TextToSpeechError(RuntimeError):
    pass


def format_completion_message(summary: str, *, style: str = "intimate") -> str:
    """Short spoken summary — voice tone carries warmth, no repeated pet names."""
    del style
    summary = (summary or "").strip()
    if not summary:
        return "All done."
    for sep in (". ", ".\n", "\n"):
        if sep in summary:
            first = summary.split(sep, 1)[0].strip()
            if first:
                summary = first if first.endswith(".") else first + "."
            break
    if len(summary) > 180:
        summary = summary[:177].rstrip() + "..."
    return summary


def speak(
    text: str,
    *,
    voice: str = "en-GB-SoniaNeural",
    rate: str = "-20%",
    pitch: str = "-4Hz",
) -> None:
    """Synthesize and play speech. Blocks until playback finishes."""
    text = (text or "").strip()
    if not text:
        return

    try:
        import edge_tts  # noqa: F401
    except ImportError as exc:
        raise TextToSpeechError(
            "TTS requires edge-tts. Install with: pip install edge-tts"
        ) from exc

    import edge_tts

    async def _synthesize() -> Path:
        communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
        tmp = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
        tmp.close()
        path = Path(tmp.name)
        await communicate.save(str(path))
        return path

    path = asyncio.run(_synthesize())
    try:
        _play_audio(path)
    finally:
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass


def _play_audio(path: Path) -> None:
    if sys.platform == "win32":
        if _play_mp3_winmm(path):
            return
    if _play_with_ffplay(path):
        return
    raise TextToSpeechError(
        "Could not play audio. On Windows, MCI should work; otherwise install ffmpeg (ffplay)."
    )


def _play_mp3_winmm(path: Path) -> bool:
    try:
        import ctypes

        winmm = ctypes.windll.winmm
        alias = "sj_tts"
        open_cmd = f'open "{path}" type mpegvideo alias {alias}'
        if winmm.mciSendStringW(open_cmd, None, 0, 0) != 0:
            return False
        try:
            winmm.mciSendStringW(f"play {alias} wait", None, 0, 0)
        finally:
            winmm.mciSendStringW(f"close {alias}", None, 0, 0)
        return True
    except Exception:
        return False


def _play_with_ffplay(path: Path) -> bool:
    import shutil

    ffplay = shutil.which("ffplay")
    if not ffplay:
        return False
    try:
        subprocess.run(
            [ffplay, "-nodisp", "-autoexit", "-loglevel", "quiet", str(path)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True
    except Exception:
        return False
