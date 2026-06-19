"""Voice integration for SexyJarvis — TTS completion + push-to-talk input."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable

from .ptt import PushToTalkInput
from .settings import VoiceSettings, load_voice_settings
from .styles import apply_voice_style
from .tts import TextToSpeechError, format_completion_message, speak


class VoiceStack:
    """Coordinates TTS on task completion and push-to-talk speech input."""

    def __init__(
        self,
        settings: VoiceSettings,
        on_info: Callable[[str], None] | None = None,
        on_error: Callable[[str], None] | None = None,
    ):
        self.settings = settings
        self._on_info = on_info or (lambda _msg: None)
        self._on_error = on_error or (lambda _msg: None)
        self.ptt = PushToTalkInput(settings, on_status=self._on_info, on_error=self._on_error)

    @classmethod
    def try_create(
        cls,
        workspace: Path | None = None,
        overrides: dict | None = None,
        on_info: Callable[[str], None] | None = None,
        on_error: Callable[[str], None] | None = None,
    ) -> VoiceStack | None:
        settings = load_voice_settings(workspace, overrides=overrides)
        if not settings.tts_enabled and not settings.stt_enabled:
            return None
        return cls(settings, on_info=on_info, on_error=on_error)

    def start(self) -> None:
        if self.settings.stt_enabled:
            self.ptt.arm()

    def stop(self) -> None:
        self.ptt.disarm()

    def poll_speech(self) -> str | None:
        if not self.settings.stt_enabled:
            return None
        return self.ptt.poll_result()

    def announce_task_complete(self, summary: str) -> None:
        if not self.settings.tts_enabled:
            return
        message = format_completion_message(summary, style=self.settings.tts_style)
        self._speak_async(message)

    def apply_voice_style(self, name: str, *, preview: bool = True) -> str:
        style = apply_voice_style(self.settings, name)
        if preview and self.settings.tts_enabled:
            self._speak_async(style.preview)
        return style.label

    def _speak_async(self, message: str) -> None:
        def _run() -> None:
            try:
                speak(
                    message,
                    voice=self.settings.tts_voice,
                    rate=self.settings.tts_rate,
                    pitch=self.settings.tts_pitch,
                )
            except TextToSpeechError as exc:
                self._on_error(str(exc))
            except Exception as exc:  # noqa: BLE001
                self._on_error(f"TTS failed: {exc}")

        threading.Thread(target=_run, daemon=True).start()
