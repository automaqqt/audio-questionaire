import os
import uuid
from typing import Optional

try:
    from TTS.api import TTS as CoquiTTSAPI
    COQUI_MODEL_NAME = os.getenv("COQUI_TTS_MODEL", "tts_models/de/thorsten/vits") # Use env var or default
    _tts_instance: Optional[CoquiTTSAPI] = None
except ImportError:
    print("Coqui TTS library (TTS) not found. Please run: pip install TTS torch")
    CoquiTTSAPI = None
    _tts_instance = None
except Exception as e:
    print(f"Error during Coqui TTS initial import or setup: {e}")
    CoquiTTSAPI = None
    _tts_instance = None

_TEMP_AUDIO_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "temp_audio")
os.makedirs(_TEMP_AUDIO_DIR, exist_ok=True)

def initialize_tts():
    global _tts_instance
    if CoquiTTSAPI and _tts_instance is None:
        try:
            print(f"Initializing Coqui TTS with model: {COQUI_MODEL_NAME} on CPU...")
            _tts_instance = CoquiTTSAPI(model_name=COQUI_MODEL_NAME, progress_bar=False).to("cpu")
            # Test synthesis to ensure model loaded correctly
            _tts_instance.tts("Test initialization.", speaker=_tts_instance.speakers[0] if _tts_instance.is_multi_speaker else None)
            print("Coqui TTS initialized successfully.")
        except Exception as e:
            print(f"Failed to initialize Coqui TTS model '{COQUI_MODEL_NAME}': {e}")
            _tts_instance = None

def is_tts_ready() -> bool:
    return _tts_instance is not None

def synthesize_speech(text: str) -> Optional[str]:
    if not is_tts_ready():
        print("Coqui TTS service not initialized.")
        return None
    try:
        output_filename = f"tts_coqui_output_{uuid.uuid4()}.wav"
        output_path = os.path.join(_TEMP_AUDIO_DIR, output_filename)
        print(f"Synthesizing speech for: '{text[:50]}...' to {output_path}")
        _tts_instance.tts_to_file(
            text=text, 
            file_path=output_path,
            speaker=_tts_instance.speakers[0] if _tts_instance.is_multi_speaker else None,
            language=_tts_instance.languages[0] if _tts_instance.is_multi_lingual else None
        ) # Add speaker/language if model requires
        return output_path if os.path.exists(output_path) else None
    except Exception as e:
        print(f"Error during Coqui TTS synthesis: {e}")
        return None

def cleanup_temp_audio_files():
    print(f"Cleaning up temporary audio files in {_TEMP_AUDIO_DIR}...")
    for f_name in os.listdir(_TEMP_AUDIO_DIR):
        if f_name.startswith("tts_coqui_output_") and f_name.endswith(".wav"):
            try:
                os.remove(os.path.join(_TEMP_AUDIO_DIR, f_name))
            except Exception as e:
                print(f"Could not remove temp file {f_name}: {e}")

def shutdown_tts():
    global _tts_instance
    if _tts_instance:
        print("Shutting down TTS service (releasing resources if applicable)...")
        # For Coqui TTS, Python's garbage collection usually handles model release.
        # If specific cleanup methods become available, call them here.
        _tts_instance = None
    print("TTS service shut down.")