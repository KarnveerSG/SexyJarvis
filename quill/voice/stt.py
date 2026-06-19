"""Speech-to-text — mirrors VoiceType CloudSpeechToTextService (Whisper API)."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

WHISPER_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions"


class SpeechToTextError(RuntimeError):
    pass


def transcribe_wav(wav_path: Path, *, engine: str, api_key: str | None) -> str:
    """Transcribe a WAV file using the configured engine."""
    engine = (engine or "cloud").lower()
    if engine == "cloud":
        if not api_key:
            raise SpeechToTextError(
                "Cloud STT requires an OpenAI API key. Set OPENAI_API_KEY or "
                "QUILL_STT_API_KEY in .env, or copy your VoiceType CloudApiKey."
            )
        return _transcribe_cloud(wav_path, api_key)
    return _transcribe_offline(wav_path)


def _transcribe_cloud(wav_path: Path, api_key: str) -> str:
    boundary = f"----Quill{uuid.uuid4().hex}"
    audio_bytes = wav_path.read_bytes()
    filename = wav_path.name

    body = b"".join(
        [
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode(),
            b"Content-Type: audio/wav\r\n\r\n",
            audio_bytes,
            b"\r\n",
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="model"\r\n\r\n',
            b"whisper-1\r\n",
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="response_format"\r\n\r\n',
            b"text\r\n",
            f"--{boundary}--\r\n".encode(),
        ]
    )

    request = Request(
        WHISPER_ENDPOINT,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=60) as response:
            text = response.read().decode("utf-8", errors="replace").strip()
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise SpeechToTextError(f"Whisper API error ({exc.code}): {_extract_error(detail)}") from exc
    except URLError as exc:
        raise SpeechToTextError(f"Whisper API connection failed: {exc}") from exc

    if not text:
        raise SpeechToTextError("Whisper returned an empty transcript.")
    return text


def _extract_error(body: str) -> str:
    try:
        data = json.loads(body)
        err = data.get("error", {})
        if isinstance(err, dict) and err.get("message"):
            return str(err["message"])
    except Exception:
        pass
    return body.strip() or "Unknown error"


def _transcribe_offline(wav_path: Path) -> str:
    """Best-effort offline transcription (local Whisper if installed)."""
    try:
        import speech_recognition as sr
    except ImportError as exc:
        raise SpeechToTextError(
            "Offline STT requires the SpeechRecognition package. "
            "Install with: pip install SpeechRecognition"
        ) from exc

    recognizer = sr.Recognizer()
    with sr.AudioFile(str(wav_path)) as source:
        audio = recognizer.record(source)

    try:
        return recognizer.recognize_whisper(audio, model="tiny").strip()
    except Exception as exc:
        raise SpeechToTextError(
            "Offline STT failed. Install openai-whisper for local recognition, "
            "or set stt_engine = \"cloud\" in config.toml."
        ) from exc
