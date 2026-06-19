"""Voice / speech settings for SexyJarvis.

Loads from config.toml [voice], environment variables, and optionally merges
defaults from the VoiceType (SpeechToText) app settings at
%APPDATA%\\VoiceType\\settings.json for hotkey + STT engine parity.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

try:
    import tomllib  # type: ignore
except Exception:  # pragma: no cover
    tomllib = None  # type: ignore

# Win32 modifier bitmask (matches VoiceType HotkeyModifiers).
MOD_ALT = 0x0001
MOD_CTRL = 0x0002
MOD_SHIFT = 0x0004
MOD_WIN = 0x0008
VK_SPACE = 0x20

DEFAULT_TTS_VOICE = "en-GB-SoniaNeural"  # British female neural voice
DEFAULT_TTS_STYLE = "intimate"
DEFAULT_HOTKEY_MODIFIERS = MOD_CTRL | MOD_ALT
DEFAULT_HOTKEY_VKEY = VK_SPACE
DEFAULT_HOTKEY_NAME = "Space"
DEFAULT_TTS_RATE = "-20%"
DEFAULT_TTS_PITCH = "-4Hz"


@dataclass
class HotkeySettings:
    modifiers: int = DEFAULT_HOTKEY_MODIFIERS
    virtual_key: int = DEFAULT_HOTKEY_VKEY
    key_name: str = DEFAULT_HOTKEY_NAME

    def display(self) -> str:
        parts: list[str] = []
        if self.modifiers & MOD_CTRL:
            parts.append("Ctrl")
        if self.modifiers & MOD_SHIFT:
            parts.append("Shift")
        if self.modifiers & MOD_ALT:
            parts.append("Alt")
        if self.modifiers & MOD_WIN:
            parts.append("Win")
        parts.append(self.key_name or "?")
        return " + ".join(parts)

    def keyboard_mods(self) -> list[str]:
        mods: list[str] = []
        if self.modifiers & MOD_CTRL:
            mods.append("ctrl")
        if self.modifiers & MOD_SHIFT:
            mods.append("shift")
        if self.modifiers & MOD_ALT:
            mods.append("alt")
        if self.modifiers & MOD_WIN:
            mods.append("windows")
        return mods


@dataclass
class VoiceSettings:
    """Runtime voice configuration."""

    tts_enabled: bool = True
    stt_enabled: bool = True
    tts_style: str = DEFAULT_TTS_STYLE
    tts_voice: str = DEFAULT_TTS_VOICE
    tts_rate: str = DEFAULT_TTS_RATE
    tts_pitch: str = DEFAULT_TTS_PITCH
    stt_engine: str = "cloud"  # "cloud" | "offline"
    stt_api_key: str | None = None
    hotkey: HotkeySettings = field(default_factory=HotkeySettings)
    microphone_device: int = -1
    play_beep: bool = True
    voicetype_settings_path: Path | None = None

    @property
    def hotkey_display(self) -> str:
        return self.hotkey.display()


def _load_toml_voice(workspace: Path) -> dict:
    if tomllib is None:
        return {}
    path = workspace / "config.toml"
    if not path.exists():
        return {}
    try:
        with path.open("rb") as fh:
            data = tomllib.load(fh)
        voice = data.get("voice", {})
        return voice if isinstance(voice, dict) else {}
    except Exception:
        return {}


def _load_dotenv(workspace: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    path = workspace / ".env"
    if not path.exists():
        return out
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            out[key.strip()] = val.strip().strip('"').strip("'")
    except Exception:
        pass
    return out


def _voicetype_settings_path() -> Path:
    appdata = os.environ.get("APPDATA", "")
    if appdata:
        return Path(appdata) / "VoiceType" / "settings.json"
    return Path.home() / "AppData" / "Roaming" / "VoiceType" / "settings.json"


def _load_voicetype_settings(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _as_bool(val, default: bool) -> bool:
    if val is None:
        return default
    if isinstance(val, bool):
        return val
    return str(val).strip().lower() in ("1", "true", "yes", "on")


def load_voice_settings(
    workspace: Path | None = None,
    overrides: dict | None = None,
) -> VoiceSettings:
    """Build voice settings from config files, env, VoiceType, and CLI overrides."""
    ws = Path(workspace or Path.cwd()).resolve()
    overrides = overrides or {}
    toml_voice = _load_toml_voice(ws)
    dotenv = _load_dotenv(ws)
    vt_path = _voicetype_settings_path()
    vt = _load_voicetype_settings(vt_path)

    def pick(env_keys: list[str], toml_key: str, default, vt_key: str | None = None):
        if toml_key in overrides and overrides[toml_key] is not None:
            return overrides[toml_key]
        for k in env_keys:
            if os.environ.get(k):
                return os.environ[k]
            if k in dotenv:
                return dotenv[k]
        if toml_key in toml_voice:
            return toml_voice[toml_key]
        if vt_key and vt_key in vt:
            return vt[vt_key]
        return default

    hotkey_toml = toml_voice.get("hotkey", {}) if isinstance(toml_voice.get("hotkey"), dict) else {}
    hotkey_vt = vt.get("Hotkey", {}) if isinstance(vt.get("Hotkey"), dict) else {}

    def hotkey_pick(key: str, default, vt_key: str | None = None):
        if key in overrides and overrides[key] is not None:
            return overrides[key]
        if key in hotkey_toml:
            return hotkey_toml[key]
        if vt_key and vt_key in hotkey_vt:
            return hotkey_vt[vt_key]
        return default

    try:
        hk_mods = int(hotkey_pick("modifiers", DEFAULT_HOTKEY_MODIFIERS, "Modifiers"))
    except Exception:
        hk_mods = DEFAULT_HOTKEY_MODIFIERS
    try:
        hk_vkey = int(hotkey_pick("virtual_key", DEFAULT_HOTKEY_VKEY, "VirtualKey"))
    except Exception:
        hk_vkey = DEFAULT_HOTKEY_VKEY
    hk_name = str(hotkey_pick("key_name", DEFAULT_HOTKEY_NAME, "KeyName"))

    engine_raw = str(pick(["SEXYJARVIS_STT_ENGINE"], "stt_engine", "cloud", "Engine")).lower()
    if engine_raw == "cloud":
        stt_engine = "cloud"
    else:
        stt_engine = "offline"

    stt_key = pick(
        ["OPENAI_API_KEY", "SEXYJARVIS_STT_API_KEY"],
        "stt_api_key",
        None,
        "CloudApiKey",
    )
    if stt_key is not None:
        stt_key = str(stt_key).strip() or None

    try:
        mic = int(pick(["SEXYJARVIS_MIC_DEVICE"], "microphone_device", -1, "MicrophoneDeviceNumber"))
    except Exception:
        mic = -1

    style_key = str(pick(["SEXYJARVIS_TTS_STYLE"], "voice_style", DEFAULT_TTS_STYLE, None)).strip().lower()
    from .styles import resolve_voice_style

    style_preset = resolve_voice_style(style_key) or resolve_voice_style(DEFAULT_TTS_STYLE)
    assert style_preset is not None

    voice_override = pick(["SEXYJARVIS_TTS_VOICE"], "tts_voice", None, None)
    rate_override = pick(["SEXYJARVIS_TTS_RATE"], "tts_rate", None, None)
    pitch_override = pick(["SEXYJARVIS_TTS_PITCH"], "tts_pitch", None, None)

    settings = VoiceSettings(
        tts_enabled=_as_bool(pick(["SEXYJARVIS_TTS"], "tts_enabled", True, None), True),
        stt_enabled=_as_bool(pick(["SEXYJARVIS_STT"], "stt_enabled", True, None), True),
        tts_style=style_preset.id,
        tts_voice=str(voice_override or style_preset.voice),
        tts_rate=str(rate_override or style_preset.rate),
        tts_pitch=str(pitch_override or style_preset.pitch),
        stt_engine=stt_engine,
        stt_api_key=stt_key,
        hotkey=HotkeySettings(modifiers=hk_mods, virtual_key=hk_vkey, key_name=hk_name),
        microphone_device=mic,
        play_beep=_as_bool(pick(["SEXYJARVIS_SPEECH_BEEP"], "play_beep", True, "PlayBeep"), True),
        voicetype_settings_path=vt_path if vt else None,
    )

    if "tts_enabled" in overrides and overrides["tts_enabled"] is not None:
        settings.tts_enabled = bool(overrides["tts_enabled"])
    if "stt_enabled" in overrides and overrides["stt_enabled"] is not None:
        settings.stt_enabled = bool(overrides["stt_enabled"])

    return settings
