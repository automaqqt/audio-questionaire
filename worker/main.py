import shutil
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import StreamingResponse
import uvicorn
import os
import tempfile
import io
import uuid
import traceback
import wave # For writing WAV files with Orpheus TTS

# --- Orpheus TTS Configuration & Multi-Model Initialization ---
ORPHEUS_TTS_AVAILABLE = False
_orpheus_models = {}  # Dictionary to store language-specific OrpheusModel instances
_orpheus_configs = {} # Dictionary to store language-specific voice configurations

# Define your language-specific Orpheus TTS configurations.
# Key: language code (e.g., "en", "de")
# Value: dict with "model_name", "voice", and optional "max_model_len"
# Use environment variables for actual model names and voices.
ORPHEUS_LANGUAGE_MODEL_SETUP = {
    "en": { # Example for English
        "model_name": os.getenv("ORPHEUS_MODEL_EN", "canopylabs/orpheus-3b-0.1-pretrained"),
        "voice": os.getenv("ORPHEUS_VOICE_EN", "tara"), # Default/specific voice for English model
        "max_model_len": int(os.getenv("ORPHEUS_MAX_LEN_EN", 2048))
    },
    "de": { # Example for German - REPLACE WITH ACTUAL MODEL AND VOICE
        "model_name": os.getenv("ORPHEUS_MODEL_DE", "canopylabs/3b-de-pretrain-research_release"),
        "voice": os.getenv("ORPHEUS_VOICE_DE", "max"),
        "max_model_len": int(os.getenv("ORPHEUS_MAX_LEN_DE", 2048))
    },
    # Add more languages here as needed:
    # "es": {
    #     "model_name": os.getenv("ORPHEUS_MODEL_ES", "path/to/spanish_orpheus_model"),
    #     "voice": os.getenv("ORPHEUS_VOICE_ES", "spanish_voice_name_for_model"),
    #     "max_model_len": int(os.getenv("ORPHEUS_MAX_LEN_ES", 2048))
    # },
}

try:
    from orpheus_tts import OrpheusModel
    # import torch # Uncomment if you want to manage device explicitly for OrpheusModel

    print("Initializing Orpheus TTS models based on ORPHEUS_LANGUAGE_MODEL_SETUP...")
    models_loaded_count = 0
    for lang_code, config in ORPHEUS_LANGUAGE_MODEL_SETUP.items():
        model_name = config.get("model_name")
        voice_name = config.get("voice")
        max_len = config.get("max_model_len", 2048) # Default max_model_len if not specified

        if not model_name or not voice_name:
            print(f"[OrpheusTTS] Incomplete configuration for language '{lang_code}'. Skipping.")
            continue
        
        # Check for placeholder values to avoid attempting to load them
        if "TODO_REPLACE" in model_name.upper() or "TODO_REPLACE" in voice_name.upper():
            print(f"[OrpheusTTS] Placeholder configuration for language '{lang_code}' ({model_name}). Please update model/voice details. Skipping.")
            continue

        try:
            print(f"[OrpheusTTS] Loading model for language '{lang_code}': {model_name} (voice: {voice_name}, max_len: {max_len})")
            # Example device management (optional, if OrpheusModel supports 'device' arg):
            # device = "cuda" if torch.cuda.is_available() else "cpu"
            # model_instance = OrpheusModel(model_name=model_name, max_model_len=max_len, device=device)
            model_instance = OrpheusModel(model_name=model_name, max_model_len=max_len)
            
            _orpheus_models[lang_code] = model_instance
            _orpheus_configs[lang_code] = {"voice": voice_name} # Store voice for easy lookup during synthesis
            print(f"[OrpheusTTS] Model for language '{lang_code}' loaded successfully.")
            models_loaded_count += 1
        except Exception as e_load:
            print(f"[OrpheusTTS] Failed to load model for language '{lang_code}' (model: {model_name}): {e_load}")
            traceback.print_exc()

    if models_loaded_count > 0:
        ORPHEUS_TTS_AVAILABLE = True
        print(f"Orpheus TTS: {models_loaded_count} language model(s) initialized. TTS service is active for: {list(_orpheus_models.keys())}")
    else:
        print("Orpheus TTS: No models were successfully loaded. TTS service will be unavailable.")

except ImportError:
    print("Orpheus TTS library (orpheus_tts) not found. TTS functionality will be unavailable.")
except Exception as e_init: # Catch other potential errors during the setup block
    print(f"General error during Orpheus TTS initialization phase: {e_init}")
    traceback.print_exc()


def synthesize_with_orpheus_actual(text: str, language_code: str, output_file_path: str) -> bool:
    """
    Synthesizes speech using the Orpheus model configured for the given language_code.
    """
    if not ORPHEUS_TTS_AVAILABLE: # Global check
        print("[OrpheusTTS] Synthesis called but service is globally unavailable.")
        return False

    model_instance = _orpheus_models.get(language_code)
    model_config = _orpheus_configs.get(language_code)

    if not model_instance or not model_config:
        print(f"[OrpheusTTS] No model or configuration found for language code: '{language_code}'. Ensure it's in ORPHEUS_LANGUAGE_MODEL_SETUP and loaded correctly.")
        return False

    voice_name = model_config["voice"]
    
    try:
        print(f"[OrpheusTTS] Synthesizing for lang '{language_code}' with voice '{voice_name}': '{text[:30]}...' to '{output_file_path}'")
        
        # Generate audio stream
        syn_tokens = model_instance.generate_speech(
            prompt=text,
            voice=voice_name, # Use the pre-configured voice for this language/model
        )

        # Orpheus TTS typically outputs 24kHz, 16-bit mono PCM audio
        samplerate = 24000
        channels = 1
        sampwidth = 2  # 2 bytes for 16-bit audio

        with wave.open(output_file_path, "wb") as wf:
            wf.setnchannels(channels)
            wf.setsampwidth(sampwidth)
            wf.setframerate(samplerate)
            for audio_chunk in syn_tokens: # Stream chunks to WAV file
                wf.writeframes(audio_chunk)
        
        file_size = os.path.getsize(output_file_path)
        if file_size > 0: # Basic check that file is not empty
            # A more robust check might involve checking WAV header or minimum duration
            duration_approx = file_size / (samplerate * channels * sampwidth)
            print(f"[OrpheusTTS] Synthesis successful for '{language_code}'. Output: {output_file_path}, size: {file_size} bytes, approx duration: {duration_approx:.2f}s")
            return True
        else:
            print(f"[OrpheusTTS] Synthesis for '{language_code}' produced an empty file: {output_file_path}")
            if os.path.exists(output_file_path):
                try: os.remove(output_file_path)
                except Exception as e_rem_empty: print(f"[OrpheusTTS] Could not remove empty file {output_file_path}: {e_rem_empty}")
            return False
    except Exception as e:
        print(f"[OrpheusTTS] Error during synthesis for language '{language_code}', voice '{voice_name}': {e}")
        traceback.print_exc()
        # Clean up potentially partially written or corrupted file
        if os.path.exists(output_file_path):
             try: os.remove(output_file_path)
             except Exception as e_rem_fail: print(f"[OrpheusTTS] Could not remove failed output file {output_file_path}: {e_rem_fail}")
        return False

# --- Faster Whisper Configuration & Initialization ---
# (This part remains unchanged)
FASTER_WHISPER_AVAILABLE = False
_whisper_model_instance = None
try:
    from faster_whisper import WhisperModel
    WHISPER_MODEL_SIZE = os.getenv("WORKER_WHISPER_MODEL_SIZE", "base")
    WHISPER_DEVICE = os.getenv("WORKER_WHISPER_DEVICE", "cpu")
    WHISPER_COMPUTE_TYPE = "int8" if WHISPER_DEVICE == "cpu" else "float16"
    
    print(f"Worker: Initializing faster-whisper model: {WHISPER_MODEL_SIZE} ({WHISPER_DEVICE}, {WHISPER_COMPUTE_TYPE})")
    _whisper_model_instance = WhisperModel(WHISPER_MODEL_SIZE, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE_TYPE)
    print("Worker: faster-whisper model initialized successfully.")
    FASTER_WHISPER_AVAILABLE = True
except ImportError:
    print("faster-whisper library not found. STT endpoint will not work.")
except Exception as e:
    print(f"Error initializing faster-whisper: {e}")
    traceback.print_exc()


app = FastAPI(title="STT/TTS Worker Microservice")

@app.post("/synthesize-speech")
async def synthesize_speech_endpoint(
    text: str = Form(...),
    language: str = Form(...), # This 'language' field is the language_code (e.g., "en", "de")
):
    if not ORPHEUS_TTS_AVAILABLE: # Global check
        raise HTTPException(status_code=503, detail="TTS service (Orpheus) not globally available or failed to initialize any models.")

    # Check if a model for the requested language is specifically available and loaded
    if language not in _orpheus_models:
        raise HTTPException(
            status_code=400, # Bad request, as language is not supported
            detail=f"TTS model for language '{language}' is not configured, not loaded, or not supported. Available: {list(_orpheus_models.keys())}"
        )

    temp_file_path = None
    try:
        # Use language in prefix for easier identification of temp files if needed
        fd, temp_file_path = tempfile.mkstemp(suffix=".wav", prefix=f"orpheus_tts_{language}_")
        os.close(fd) # Orpheus will open/write to path

        # The 'language' parameter from the form is used as the language_code
        # to select the correct model and its pre-configured voice.
        success = synthesize_with_orpheus_actual(text, language, temp_file_path)
        
        if not success:
            # synthesize_with_orpheus_actual should handle its own file cleanup on failure.
            # This HTTPException informs the client of the failure.
            raise HTTPException(status_code=500, detail=f"Orpheus TTS synthesis failed for language '{language}'. Check server logs for details.")
        
        # Defensive check: ensure file exists and has content after a successful call
        if not os.path.exists(temp_file_path) or os.path.getsize(temp_file_path) == 0:
            print(f"Worker: Orpheus TTS reported success for '{language}', but file is missing or empty: {temp_file_path}")
            raise HTTPException(status_code=500, detail="Orpheus TTS synthesis resulted in a missing or empty file despite reported success.")

        print(f"Worker: Orpheus TTS synthesized for language '{language}' to {temp_file_path}")

        with open(temp_file_path, "rb") as f_audio:
            audio_bytes = f_audio.read()
        
        return StreamingResponse(io.BytesIO(audio_bytes), media_type="audio/wav", headers={
            "Content-Disposition": f"attachment; filename=tts_output_{language}_{uuid.uuid4().hex[:8]}.wav"
        })

    except HTTPException: # Re-raise HTTPExceptions from this block or called functions
        raise
    except Exception as e:
        print(f"Worker TTS Endpoint Error for language '{language}': {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"TTS synthesis internal error: {str(e)}")
    finally:
        if temp_file_path and os.path.exists(temp_file_path):
            try:
                os.remove(temp_file_path)
                print(f"Worker: Temp TTS file {temp_file_path} removed.")
            except Exception as e_rem:
                print(f"Worker: Error removing temp TTS file {temp_file_path}: {e_rem}")


@app.post("/transcribe-audio")
async def transcribe_audio_endpoint(audio_file: UploadFile = File(...), language: str = Form(...)):
    if not FASTER_WHISPER_AVAILABLE or _whisper_model_instance is None:
        raise HTTPException(status_code=503, detail="STT service (faster-whisper) not available.")

    temp_file_path = None
    try:
        suffix = os.path.splitext(audio_file.filename or ".webm")[1]
        if not suffix: suffix = ".tmp" # Default suffix if extraction fails
        if not suffix.startswith('.'): suffix = "." + suffix


        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix, prefix="stt_input_") as tmp_audio:
            shutil.copyfileobj(audio_file.file, tmp_audio)
            temp_file_path = tmp_audio.name
        
        print(f"Worker: STT input saved to {temp_file_path}")
        
        lang_param = language if language and language.lower() != "auto" else None
        segments, info = _whisper_model_instance.transcribe(
            temp_file_path,
            beam_size=5,
            language=lang_param
        )
        
        transcribed_texts = [segment.text.strip() for segment in segments]
        full_transcription = " ".join(transcribed_texts).strip()
        
        detected_lang = info.language
        detected_lang_prob = info.language_probability
        
        print(f"Worker: Transcription complete. Detected Language: {detected_lang} (Prob: {detected_lang_prob:.2f}) (Input lang hint: {language})")
        print(f"Worker: Transcription: '{full_transcription[:100]}...'")

        return {
            "transcription": full_transcription,
            "language": detected_lang,
            "language_probability": detected_lang_prob
        }

    except Exception as e:
        print(f"Worker STT Error: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"STT internal error: {str(e)}")
    finally:
        if temp_file_path and os.path.exists(temp_file_path):
            try:
                os.remove(temp_file_path)
                print(f"Worker: Temp STT file {temp_file_path} removed.")
            except Exception as e_rem:
                print(f"Worker: Error removing temp STT file {temp_file_path}: {e_rem}")
        if hasattr(audio_file, 'close'): # Ensure UploadFile is closed
            await audio_file.close()


if __name__ == "__main__":
    port = int(os.getenv("WORKER_PORT", 8088))
    print(f"Starting STT/TTS Worker Microservice on port {port}")
    if ORPHEUS_TTS_AVAILABLE:
        print(f"Orpheus TTS configured and active for languages: {list(_orpheus_models.keys())}")
    else:
        print("Orpheus TTS is not available or no models were loaded.")
    if FASTER_WHISPER_AVAILABLE:
        print(f"Faster Whisper STT service is active with model: {WHISPER_MODEL_SIZE}")
    else:
        print("Faster Whisper STT service is not available.")
        
    uvicorn.run(app, host="0.0.0.0", port=port)