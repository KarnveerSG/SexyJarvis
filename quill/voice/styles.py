"""Preset TTS voice styles — affectionate British delivery, interchangeable at runtime."""

from __future__ import annotations

from dataclasses import dataclass

from .settings import VoiceSettings


@dataclass(frozen=True)
class VoiceStyle:
    id: str
    label: str
    vibe: str
    voice: str
    rate: str
    pitch: str
    preview: str


DEFAULT_VOICE_STYLE = "intimate"

VOICE_STYLES: dict[str, VoiceStyle] = {
    "intimate": VoiceStyle(
        id="intimate",
        label="Intimate & Hypnotic",
        vibe="slow, warm, close",
        voice="en-GB-SoniaNeural",
        rate="-20%",
        pitch="-4Hz",
        preview="Intimate voice selected.",
    ),
    "playful": VoiceStyle(
        id="playful",
        label="Playful & Enigmatic",
        vibe="teasing, light, alluring",
        voice="en-GB-LibbyNeural",
        rate="-8%",
        pitch="+2Hz",
        preview="Playful voice selected.",
    ),
    "bright": VoiceStyle(
        id="bright",
        label="Bright & Magnetic",
        vibe="confident, sparkling, warm",
        voice="en-GB-MiaNeural",
        rate="-12%",
        pitch="-2Hz",
        preview="Bright voice selected.",
    ),
}

_ALIASES: dict[str, str] = {
    "intimate": "intimate",
    "hypnotic": "intimate",
    "sonia": "intimate",
    "1": "intimate",
    "playful": "playful",
    "enigmatic": "playful",
    "libby": "playful",
    "2": "playful",
    "bright": "bright",
    "magnetic": "bright",
    "mia": "bright",
    "3": "bright",
}


def resolve_voice_style(name: str) -> VoiceStyle | None:
    key = (name or "").strip().lower().replace(" ", "_").replace("-", "_")
    if not key:
        return None
    style_id = _ALIASES.get(key, key)
    return VOICE_STYLES.get(style_id)


def list_voice_styles() -> list[VoiceStyle]:
    return [VOICE_STYLES[k] for k in ("intimate", "playful", "bright")]


def apply_voice_style(settings: VoiceSettings, name: str) -> VoiceStyle:
    style = resolve_voice_style(name)
    if style is None:
        known = ", ".join(s.id for s in list_voice_styles())
        raise ValueError(f"Unknown voice style {name!r}. Choose: {known}")
    settings.tts_style = style.id
    settings.tts_voice = style.voice
    settings.tts_rate = style.rate
    settings.tts_pitch = style.pitch
    return style


def current_voice_style(settings: VoiceSettings) -> VoiceStyle:
    return VOICE_STYLES.get(settings.tts_style, VOICE_STYLES[DEFAULT_VOICE_STYLE])
