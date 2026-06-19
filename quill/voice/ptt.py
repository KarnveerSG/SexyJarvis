"""Push-to-talk input — hold hotkey to record, release to transcribe."""

from __future__ import annotations

import queue
import threading
import time
from pathlib import Path
from typing import Callable

from .capture import AudioRecorder, VoiceCaptureError
from .settings import VoiceSettings
from .stt import SpeechToTextError, transcribe_wav


class PushToTalkInput:
    """Background push-to-talk listener compatible with VoiceType hotkey settings."""

    def __init__(
        self,
        settings: VoiceSettings,
        on_status: Callable[[str], None] | None = None,
        on_error: Callable[[str], None] | None = None,
    ):
        self.settings = settings
        self._on_status = on_status or (lambda _msg: None)
        self._on_error = on_error or (lambda _msg: None)
        self._result_queue: queue.Queue[str] = queue.Queue()
        self._armed = False
        self._recording = False
        self._recorder: AudioRecorder | None = None
        self._watch_thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._keyboard = None

    def available(self) -> bool:
        try:
            import keyboard  # noqa: F401
            import sounddevice  # noqa: F401
            import numpy  # noqa: F401
            return True
        except ImportError:
            return False

    def arm(self) -> None:
        if not self.settings.stt_enabled or self._armed:
            return
        if not self.available():
            self._on_error(
                "Speech input unavailable. Install voice extras: "
                "pip install Quill[voice]"
            )
            return
        import keyboard

        self._keyboard = keyboard
        self._stop_event.clear()
        self._watch_thread = threading.Thread(target=self._watch_loop, daemon=True)
        self._watch_thread.start()
        self._armed = True

    def disarm(self) -> None:
        self._armed = False
        self._stop_event.set()
        if self._watch_thread and self._watch_thread.is_alive():
            self._watch_thread.join(timeout=1.0)
        self._watch_thread = None
        if self._recording:
            self._stop_recording(cancel=True)

    def poll_result(self) -> str | None:
        try:
            return self._result_queue.get_nowait()
        except queue.Empty:
            return None

    def _watch_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                if self._is_hotkey_down():
                    if not self._recording:
                        self._start_recording()
                elif self._recording:
                    self._stop_recording(cancel=False)
            except Exception as exc:  # noqa: BLE001
                self._on_error(f"Speech input error: {exc}")
            time.sleep(0.04)

    def _is_hotkey_down(self) -> bool:
        kb = self._keyboard
        if kb is None:
            return False
        hk = self.settings.hotkey
        key = hk.key_name.lower()
        if not kb.is_pressed(key):
            return False
        if hk.modifiers & 0x0002 and not kb.is_pressed("ctrl"):
            return False
        if hk.modifiers & 0x0001 and not kb.is_pressed("alt"):
            return False
        if hk.modifiers & 0x0004 and not kb.is_pressed("shift"):
            return False
        if hk.modifiers & 0x0008 and not kb.is_pressed("windows"):
            return False
        return True

    def _start_recording(self) -> None:
        try:
            self._recorder = AudioRecorder(device=self.settings.microphone_device)
            self._recorder.start()
            self._recording = True
            if self.settings.play_beep:
                self._play_beep(800)
            self._on_status(f"Recording… (release {self.settings.hotkey_display})")
        except VoiceCaptureError as exc:
            self._on_error(str(exc))
            self._recording = False
            self._recorder = None

    def _stop_recording(self, *, cancel: bool) -> None:
        self._recording = False
        recorder = self._recorder
        self._recorder = None
        if recorder is None:
            return

        wav_path: Path | None = None
        try:
            if not cancel:
                wav_path = recorder.stop()
            else:
                recorder.stop()
        except Exception as exc:  # noqa: BLE001
            self._on_error(f"Recording failed: {exc}")
            return

        if self.settings.play_beep:
            self._play_beep(1200 if wav_path else 220)

        if cancel or wav_path is None:
            self._on_status("Recording cancelled.")
            return

        self._on_status("Transcribing…")
        try:
            text = transcribe_wav(
                wav_path,
                engine=self.settings.stt_engine,
                api_key=self.settings.stt_api_key,
            )
        except SpeechToTextError as exc:
            self._on_error(str(exc))
            return
        finally:
            try:
                wav_path.unlink(missing_ok=True)
            except Exception:
                pass

        text = text.strip()
        if text:
            self._result_queue.put(text)
            self._on_status(f"Heard: {text}")
        else:
            self._on_status("No speech detected.")

    def _play_beep(self, frequency: int) -> None:
        try:
            import numpy as np
            import sounddevice as sd

            duration = 0.08
            t = np.linspace(0, duration, int(16000 * duration), False)
            tone = (0.2 * np.sin(2 * np.pi * frequency * t)).astype(np.float32)
            sd.play(tone, 16000)
            sd.wait()
        except Exception:
            pass
