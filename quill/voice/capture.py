"""Microphone capture — 16 kHz mono WAV, matching VoiceType / Whisper expectations."""

from __future__ import annotations

import tempfile
import uuid
import wave
from pathlib import Path

SAMPLE_RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2  # 16-bit PCM


class VoiceCaptureError(RuntimeError):
    pass


class AudioRecorder:
    """Records microphone audio to a temporary WAV file."""

    def __init__(self, device: int = -1):
        self.device = device if device >= 0 else None
        self._stream = None
        self._frames: list = []

    def start(self) -> None:
        if self._stream is not None:
            return
        try:
            import numpy as np  # noqa: F401
            import sounddevice as sd
        except ImportError as exc:
            raise VoiceCaptureError(
                "Microphone capture requires sounddevice and numpy. "
                "Install with: pip install sounddevice numpy"
            ) from exc

        import sounddevice as sd

        self._frames = []

        def callback(indata, _frames, _time, status):  # noqa: ANN001
            if status:
                pass
            self._frames.append(indata.copy())

        try:
            self._stream = sd.InputStream(
                samplerate=SAMPLE_RATE,
                channels=CHANNELS,
                dtype="int16",
                device=self.device,
                callback=callback,
            )
            self._stream.start()
        except Exception as exc:
            self._stream = None
            raise VoiceCaptureError(f"Could not open microphone: {exc}") from exc

    @property
    def is_recording(self) -> bool:
        return self._stream is not None

    def stop(self) -> Path | None:
        if self._stream is None:
            return None
        try:
            self._stream.stop()
            self._stream.close()
        finally:
            self._stream = None

        if not self._frames:
            return None

        import numpy as np

        audio = np.concatenate(self._frames, axis=0)
        path = Path(tempfile.gettempdir()) / f"QUILL_{uuid.uuid4().hex}.wav"
        with wave.open(str(path), "wb") as wf:
            wf.setnchannels(CHANNELS)
            wf.setsampwidth(SAMPLE_WIDTH)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(audio.tobytes())

        try:
            if path.stat().st_size <= 44:
                path.unlink(missing_ok=True)
                return None
        except Exception:
            return None
        return path
