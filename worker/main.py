import shutil
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import StreamingResponse
import uvicorn
import os
import tempfile
import io
import uuid
import traceback
import wave 
import requests 
import json
import asyncio
import threading
import numpy as np 

# --- Kokoro TTS Configuration ---
KOKORO_TTS_AVAILABLE = False
_kokoro_pipelines = {} 
KOKORO_LANGUAGE_CONFIG = {
    "en": {"kokoro_lang_code": "a", "voice": os.getenv("KOKORO_VOICE_EN", "af_heart")},
    "en-gb": {"kokoro_lang_code": "b", "voice": os.getenv("KOKORO_VOICE_EN_GB", "bf_heart")},
    "es": {"kokoro_lang_code": "e", "voice": os.getenv("KOKORO_VOICE_ES", "ef_heart")},
    "fr": {"kokoro_lang_code": "f", "voice": os.getenv("KOKORO_VOICE_FR", "ff_heart")},
    "hi": {"kokoro_lang_code": "h", "voice": os.getenv("KOKORO_VOICE_HI", "hf_heart")},
    "it": {"kokoro_lang_code": "i", "voice": os.getenv("KOKORO_VOICE_IT", "if_heart")},
    "ja": {"kokoro_lang_code": "j", "voice": os.getenv("KOKORO_VOICE_JA", "jf_heart")},
    "pt-br": {"kokoro_lang_code": "p", "voice": os.getenv("KOKORO_VOICE_PT_BR", "pf_heart")},
    "zh": {"kokoro_lang_code": "z", "voice": os.getenv("KOKORO_VOICE_ZH", "zf_heart")},
}
KOKORO_DEFAULT_SAMPLE_RATE = 24000
KOKORO_DEFAULT_SPEED = float(os.getenv("KOKORO_SPEED", 1.0))
KOKORO_SPLIT_PATTERN = os.getenv("KOKORO_SPLIT_PATTERN", r'\n+')

try:
    from kokoro import KPipeline
    import torch 
    import soundfile as sf

    _kokoro_pipelines_initialized_count = 0
    for api_lang, config in KOKORO_LANGUAGE_CONFIG.items():
        kokoro_lang_code = config.get("kokoro_lang_code")
        if kokoro_lang_code and kokoro_lang_code not in _kokoro_pipelines:
            try:
                print(f"[KokoroInit] Initializing Kokoro pipeline for lang_code '{kokoro_lang_code}' (API lang '{api_lang}')...")
                _kokoro_pipelines[kokoro_lang_code] = KPipeline(lang_code=kokoro_lang_code)
                print(f"[KokoroInit] Kokoro pipeline for '{kokoro_lang_code}' initialized.")
                _kokoro_pipelines_initialized_count += 1
            except Exception as e_kokoro_init:
                print(f"[KokoroInit] ERROR: Failed to initialize Kokoro pipeline for lang_code '{kokoro_lang_code}' (API lang '{api_lang}'): {e_kokoro_init}")
                # traceback.print_exc() # Can be verbose
    
    if _kokoro_pipelines_initialized_count > 0:
        KOKORO_TTS_AVAILABLE = True
        print(f"[KokoroInit] Kokoro TTS is available. Successfully initialized {_kokoro_pipelines_initialized_count} language pipelines.")
    else:
        print("[KokoroInit] Kokoro TTS was imported, but no language pipelines initialized successfully or none were configured for it.")

except ImportError:
    print("[KokoroInit] Kokoro library, torch, or soundfile not found. Kokoro TTS will not be available.")
    KOKORO_TTS_AVAILABLE = False
    class sf_placeholder:
        def write(*args, **kwargs): pass
    sf = sf_placeholder
except Exception as e_kokoro_import:
    print(f"[KokoroInit] ERROR: An unexpected error occurred while trying to import or initialize Kokoro: {e_kokoro_import}")
    # traceback.print_exc()
    KOKORO_TTS_AVAILABLE = False
    class sf_placeholder:
        def write(*args, **kwargs): pass
    sf = sf_placeholder

# --- Orpheus TTS via API Configuration ---
ORPHEUS_TTS_AVAILABLE = False
_orpheus_api_configs = {} 
ORPHEUS_API_BASE_URL = os.getenv("ORPHEUS_API_BASE_URL", "http://localhost:1234/v1") 
ORPHEUS_API_ENDPOINT_PATH = os.getenv("ORPHEUS_API_ENDPOINT_PATH", "/completions") 
ORPHEUS_API_FULL_URL = f"{ORPHEUS_API_BASE_URL.rstrip('/')}{ORPHEUS_API_ENDPOINT_PATH}"
ORPHEUS_API_HEADERS = {"Content-Type": "application/json"}
DEFAULT_VOICE = "tara" 
DEFAULT_TEMPERATURE = float(os.getenv("ORPHEUS_API_TEMPERATURE", 0.7))
DEFAULT_TOP_P = float(os.getenv("ORPHEUS_API_TOP_P", 0.9))
DEFAULT_MAX_TOKENS = int(os.getenv("ORPHEUS_API_MAX_TOKENS", 2048)) 
DEFAULT_REPETITION_PENALTY = float(os.getenv("ORPHEUS_API_REPETITION_PENALTY", 1.1))
DEFAULT_SAMPLE_RATE = 24000 
CUSTOM_TOKEN_PREFIX = "<custom_token_"

try:
    from decoder import convert_to_audio as orpheus_decoder_convert_to_audio
    DECODER_AVAILABLE = True
    print("Successfully imported 'convert_to_audio' from 'decoder' module.")
except ImportError:
    DECODER_AVAILABLE = False
    print("ERROR: Could not import 'convert_to_audio' from 'decoder' module. Orpheus TTS via API will NOT be available.")
    def orpheus_decoder_convert_to_audio(multiframe, count): return None 
except Exception as e_decoder_import:
    DECODER_AVAILABLE = False
    print(f"ERROR: An unexpected error occurred while trying to import from 'decoder': {e_decoder_import}")
    def orpheus_decoder_convert_to_audio(multiframe, count): return None

def format_prompt_for_api(prompt, voice):
    formatted_prompt = f"{voice}: {prompt}"
    special_start = "<|audio|>"
    special_end = "<|eot_id|>"
    return f"{special_start}{formatted_prompt}{special_end}"

def generate_tokens_from_api(api_url, headers, model_identifier, prompt, voice, temperature, top_p, max_tokens, repetition_penalty):
    formatted_prompt = format_prompt_for_api(prompt, voice)
    print(f"[OrpheusAPIClient] Generating speech tokens for model '{model_identifier}' with prompt: {formatted_prompt[:100]}...")
    payload = {
        "model": model_identifier, "prompt": formatted_prompt, "max_tokens": max_tokens,
        "temperature": temperature, "top_p": top_p, "repetition_penalty": repetition_penalty, "stream": True
    }
    try:
        response = requests.post(api_url, headers=headers, json=payload, stream=True, timeout=120)
        response.raise_for_status()
    except requests.exceptions.RequestException as e:
        print(f"[OrpheusAPIClient] Error: API request failed: {e}")
        if hasattr(e, 'response') and e.response is not None: print(f"[OrpheusAPIClient] Response Text: {e.response.text}")
        return
    for line in response.iter_lines():
        if line:
            line_decoded = line.decode('utf-8')
            if line_decoded.startswith('data: '):
                data_str = line_decoded[6:]
                if data_str.strip() == '[DONE]': break
                try:
                    data = json.loads(data_str)
                    if 'choices' in data and data['choices'] and 'delta' in data['choices'][0] and 'content' in data['choices'][0]['delta']:
                        token_text = data['choices'][0]['delta'].get('content', '')
                        if token_text: yield token_text
                    elif 'choices' in data and data['choices'] and 'text' in data['choices'][0]:
                        token_text = data['choices'][0].get('text', '')
                        if token_text: yield token_text
                except json.JSONDecodeError: print(f"[OrpheusAPIClient] Error decoding JSON: {data_str}")
    print("[OrpheusAPIClient] Token generation stream complete.")

def turn_token_into_id(token_string, index):
    token_string = token_string.strip()
    last_token_start = token_string.rfind(CUSTOM_TOKEN_PREFIX)
    if last_token_start == -1: return None
    last_token = token_string[last_token_start:]
    if last_token.startswith(CUSTOM_TOKEN_PREFIX) and last_token.endswith(">"):
        try:
            number_str = last_token[len(CUSTOM_TOKEN_PREFIX):-1]
            return int(number_str) - 10 - ((index % 7) * 4096)
        except ValueError: return None
    return None

async def tokens_decoder_async_generator(token_text_stream):
    if not DECODER_AVAILABLE: yield b''; return
    buffer, count = [], 0
    async for token_text_chunk in token_text_stream:
        tokens_in_chunk = token_text_chunk.split(CUSTOM_TOKEN_PREFIX)
        for i, part in enumerate(tokens_in_chunk):
            if i == 0 and not token_text_chunk.startswith(CUSTOM_TOKEN_PREFIX): continue
            full_token_text = CUSTOM_TOKEN_PREFIX + part if not part.startswith(CUSTOM_TOKEN_PREFIX) else part
            token_id = turn_token_into_id(full_token_text, count)
            if token_id is not None and token_id > 0:
                buffer.append(token_id); count += 1
                if count % 7 == 0 and count > 27:
                    audio_samples = orpheus_decoder_convert_to_audio(buffer[-28:], count)
                    if audio_samples is not None: yield audio_samples

def generate_speech_via_api_and_decode(api_url, headers, model_identifier, text_prompt, voice, temperature, top_p, max_tokens, repetition_penalty, output_file_path, sample_rate):
    if not DECODER_AVAILABLE: return False
    audio_written = False
    def task_in_thread():
        nonlocal audio_written
        token_text_generator = generate_tokens_from_api(api_url, headers, model_identifier, text_prompt, voice, temperature, top_p, max_tokens, repetition_penalty)
        async def async_token_text_gen_wrapper(sync_gen):
            for item in sync_gen: yield item; await asyncio.sleep(0)
        async def process_audio_stream():
            nonlocal audio_written
            written_anything_to_wav = False
            try:
                with wave.open(output_file_path, "wb") as wf:
                    wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(sample_rate)
                    async for audio_chunk in tokens_decoder_async_generator(async_token_text_gen_wrapper(token_text_generator)):
                        if audio_chunk and isinstance(audio_chunk, bytes): wf.writeframes(audio_chunk); written_anything_to_wav = True
                        elif audio_chunk: print(f"[OrpheusAPIClient] Warning: Decoder yielded non-bytes data: {type(audio_chunk)}")
                if written_anything_to_wav and os.path.exists(output_file_path) and os.path.getsize(output_file_path) > 0: audio_written = True; print(f"[OrpheusAPIClient] Audio successfully written to {output_file_path}")
                elif written_anything_to_wav: print(f"[OrpheusAPIClient] Warning: Audio frames processed, but output file {output_file_path} is empty or missing.")
                else: print(f"[OrpheusAPIClient] No audio frames were generated or written to {output_file_path}.")
            except Exception as e_process: print(f"[OrpheusAPIClient] Error during audio stream processing or WAV writing: {e_process}"); traceback.print_exc()
        asyncio.run(process_audio_stream())
    thread = threading.Thread(target=task_in_thread); thread.start(); thread.join()
    return audio_written

async def generate_speech_with_kokoro(text_prompt: str, kokoro_lang_code: str, voice: str, output_file_path: str, sample_rate: int = KOKORO_DEFAULT_SAMPLE_RATE, speed: float = KOKORO_DEFAULT_SPEED, split_pattern: str = KOKORO_SPLIT_PATTERN) -> bool:
    if not KOKORO_TTS_AVAILABLE or kokoro_lang_code not in _kokoro_pipelines: return False
    pipeline = _kokoro_pipelines[kokoro_lang_code]
    try:
        print(f"[KokoroTTS] Generating speech with Kokoro for lang '{kokoro_lang_code}', voice '{voice}'")
        def sync_kokoro_generation():
            audio_segments = []
            generator = pipeline(text_prompt, voice=voice, speed=speed, split_pattern=split_pattern)
            for i, (gs, ps, audio_data_chunk) in enumerate(generator):
                processed_audio_np = None
                if isinstance(audio_data_chunk, torch.Tensor):
                    if audio_data_chunk.is_cuda: audio_data_chunk = audio_data_chunk.cpu()
                    processed_audio_np = audio_data_chunk.numpy()
                elif isinstance(audio_data_chunk, np.ndarray): processed_audio_np = audio_data_chunk
                elif audio_data_chunk is None: print(f"[KokoroTTS] Segment {i} from Kokoro was None. Skipping."); continue
                else: print(f"[KokoroTTS] Segment {i} from Kokoro was of unexpected type: {type(audio_data_chunk)}. Skipping."); continue
                if processed_audio_np is not None and processed_audio_np.size > 0: audio_segments.append(processed_audio_np)
                elif processed_audio_np is not None: print(f"[KokoroTTS] Segment {i} from Kokoro was empty (size 0). Skipping.")
            if not audio_segments: print("[KokoroTTS] Kokoro generated no valid audio segments."); return None
            return np.concatenate(audio_segments)
        full_audio_np = await asyncio.to_thread(sync_kokoro_generation)
        if full_audio_np is None or full_audio_np.size == 0: print("[KokoroTTS] Kokoro synthesis resulted in no audio data."); return False
        await asyncio.to_thread(sf.write, output_file_path, full_audio_np, sample_rate)
        if os.path.exists(output_file_path) and os.path.getsize(output_file_path) > 0: print(f"[KokoroTTS] Audio successfully written to {output_file_path}"); return True
        else: print(f"[KokoroTTS] Failed to write audio to {output_file_path} or file is empty."); return False
    except Exception as e: print(f"[KokoroTTS] Error during Kokoro speech generation for lang '{kokoro_lang_code}': {e}"); traceback.print_exc(); return False

ORPHEUS_LANGUAGE_API_SETUP = {
    "en": {"api_model_identifier": os.getenv("ORPHEUS_API_MODEL_EN", "orpheus-3b-0.1-ft"), "voice": os.getenv("ORPHEUS_VOICE_EN", DEFAULT_VOICE), "temperature": float(os.getenv("ORPHEUS_API_TEMP_EN", DEFAULT_TEMPERATURE)), "top_p": float(os.getenv("ORPHEUS_API_TOP_P_EN", DEFAULT_TOP_P)), "max_tokens": int(os.getenv("ORPHEUS_API_MAX_TOKENS_EN", DEFAULT_MAX_TOKENS)), "repetition_penalty": float(os.getenv("ORPHEUS_API_REPPEN_EN", DEFAULT_REPETITION_PENALTY)), "sample_rate": int(os.getenv("ORPHEUS_API_SR_EN", DEFAULT_SAMPLE_RATE))},
    "de": {"api_model_identifier": os.getenv("ORPHEUS_API_MODEL_DE", "3b-de-ft-research_release"), "voice": os.getenv("ORPHEUS_VOICE_DE", "jana"), "temperature": float(os.getenv("ORPHEUS_API_TEMP_DE", DEFAULT_TEMPERATURE)), "top_p": float(os.getenv("ORPHEUS_API_TOP_P_DE", DEFAULT_TOP_P)), "max_tokens": int(os.getenv("ORPHEUS_API_MAX_TOKENS_DE", DEFAULT_MAX_TOKENS)), "repetition_penalty": float(os.getenv("ORPHEUS_API_REPPEN_DE", DEFAULT_REPETITION_PENALTY)), "sample_rate": int(os.getenv("ORPHEUS_API_SR_DE", DEFAULT_SAMPLE_RATE))},
}
if DECODER_AVAILABLE:
    for lang_code, config in ORPHEUS_LANGUAGE_API_SETUP.items():
        if "api_model_identifier" in config and "voice" in config:
            _orpheus_api_configs[lang_code] = {k: v for k, v in config.items()} # Simplified copy
            print(f"[OrpheusAPIConfig] Configured Orpheus TTS for language '{lang_code}'.")
    if _orpheus_api_configs: ORPHEUS_TTS_AVAILABLE = True; print(f"[OrpheusAPIConfig] Orpheus TTS via API is active for languages: {list(_orpheus_api_configs.keys())}")
    else: print("[OrpheusAPIConfig] Orpheus TTS via API is NOT active. No valid language configurations found.")
else: print("[OrpheusAPIConfig] Orpheus TTS via API is NOT active due to missing 'decoder' module.")

# --- Faster Whisper Configuration & Initialization ---
FASTER_WHISPER_AVAILABLE = False
_whisper_model_instance = None
try:
    from faster_whisper import WhisperModel
    WHISPER_MODEL_SIZE = os.getenv("WORKER_WHISPER_MODEL_SIZE", "small")
    WHISPER_DEVICE = os.getenv("WORKER_WHISPER_DEVICE", "cpu")
    WHISPER_COMPUTE_TYPE = "int8" if WHISPER_DEVICE == "cpu" else "float16"
    print(f"Worker: Initializing faster-whisper model: {WHISPER_MODEL_SIZE} ({WHISPER_DEVICE}, {WHISPER_COMPUTE_TYPE})")
    _whisper_model_instance = WhisperModel(WHISPER_MODEL_SIZE, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE_TYPE)
    print("Worker: faster-whisper model initialized successfully.")
    FASTER_WHISPER_AVAILABLE = True
except ImportError: print("Worker: faster-whisper library not found. STT endpoint will not work.")
except Exception as e: print(f"Worker: Error initializing faster-whisper: {e}"); traceback.print_exc()

# --- Parakeet STT Configuration & Initialization ---
PARAKEET_STT_AVAILABLE = False
_parakeet_model_instance = None
PARAKEET_MODEL_NAME = os.getenv("WORKER_PARAKEET_MODEL_NAME", "nvidia/parakeet-tdt-0.6b-v2")

if os.getenv("ENABLE_PARAKEET_STT", "true").lower() == "true":
    print("Worker: Parakeet STT is enabled. Attempting initialization.")
    try:
        import nemo.collections.asr as nemo_asr # NeMo import
        print(f"Worker: Initializing Parakeet STT model: {PARAKEET_MODEL_NAME} (this may take time to download)...")
        _parakeet_model_instance = nemo_asr.models.ASRModel.from_pretrained(model_name=PARAKEET_MODEL_NAME)
        print("Worker: Parakeet STT model initialized successfully.")
        PARAKEET_STT_AVAILABLE = True
    except ImportError:
        print("Worker: NVIDIA NeMo toolkit (nemo.collections.asr) not found. Parakeet STT will not be available.")
        print("Worker: To enable Parakeet, ensure NeMo is installed (e.g., pip install nemo_toolkit['asr']) and set ENABLE_PARAKEET_STT=true.")
    except Exception as e:
        print(f"Worker: Error initializing Parakeet STT model ({PARAKEET_MODEL_NAME}): {e}")
        traceback.print_exc()
        print("Worker: Parakeet STT will not be available.")
else:
    print("Worker: Parakeet STT is not enabled (ENABLE_PARAKEET_STT is not 'true'). Skipping initialization.")


app = FastAPI(title="STT/TTS Worker Microservice")

@app.post("/synthesize-speech")
async def synthesize_speech_endpoint(text: str = Form(...), language: str = Form(...)):
    temp_file_path, synthesis_method_used, generated_successfully = None, "none", False
    try:
        kokoro_config_for_lang = KOKORO_LANGUAGE_CONFIG.get(language)
        if KOKORO_TTS_AVAILABLE and kokoro_config_for_lang:
            kokoro_lang_code, kokoro_voice = kokoro_config_for_lang["kokoro_lang_code"], kokoro_config_for_lang["voice"]
            if kokoro_lang_code in _kokoro_pipelines:
                synthesis_method_used = "kokoro"
                print(f"[FastAPI Endpoint] Attempting Kokoro TTS for lang '{language}' (Kokoro code: '{kokoro_lang_code}')")
                fd, temp_file_path = tempfile.mkstemp(suffix=".wav", prefix=f"kokoro_tts_{language}_"); os.close(fd)
                success = await generate_speech_with_kokoro(text, kokoro_lang_code, kokoro_voice, temp_file_path)
                if success and os.path.exists(temp_file_path) and os.path.getsize(temp_file_path) > 0: generated_successfully = True
                else:
                    if temp_file_path and os.path.exists(temp_file_path): os.remove(temp_file_path); temp_file_path = None
                    raise HTTPException(status_code=500, detail=f"Kokoro TTS synthesis failed for language '{language}'.")
            else: print(f"[FastAPI Endpoint] Kokoro configured for API lang '{language}' but pipeline '{kokoro_lang_code}' not available. Checking Orpheus.")
        
        if not generated_successfully:
            lang_config_orpheus = _orpheus_api_configs.get(language)
            if ORPHEUS_TTS_AVAILABLE and lang_config_orpheus:
                synthesis_method_used = "orpheus"
                print(f"[FastAPI Endpoint] Attempting Orpheus API TTS for lang '{language}'")
                if temp_file_path is None: fd, temp_file_path = tempfile.mkstemp(suffix=".wav", prefix=f"orpheus_api_tts_{language}_"); os.close(fd)
                success = await asyncio.to_thread(generate_speech_via_api_and_decode, ORPHEUS_API_FULL_URL, ORPHEUS_API_HEADERS, lang_config_orpheus["api_model_identifier"], text, lang_config_orpheus["voice"], lang_config_orpheus["temperature"], lang_config_orpheus["top_p"], lang_config_orpheus["max_tokens"], lang_config_orpheus["repetition_penalty"], temp_file_path, lang_config_orpheus["sample_rate"])
                if success and os.path.exists(temp_file_path) and os.path.getsize(temp_file_path) > 0: generated_successfully = True
                else:
                    if temp_file_path and os.path.exists(temp_file_path): os.remove(temp_file_path); temp_file_path = None
                    raise HTTPException(status_code=500, detail=f"Orpheus API TTS synthesis failed for language '{language}'.")
            elif synthesis_method_used == "none":
                available_langs = sorted(list(set([lk for lk,lcfg in KOKORO_LANGUAGE_CONFIG.items() if lcfg.get("kokoro_lang_code") in _kokoro_pipelines]) | set(list(_orpheus_api_configs.keys()))))
                raise HTTPException(status_code=400, detail=f"TTS for language '{language}' not configured. Available: {available_langs if available_langs else 'None'}")
            elif not ORPHEUS_TTS_AVAILABLE and synthesis_method_used == "none" and not (KOKORO_TTS_AVAILABLE and kokoro_config_for_lang):
                raise HTTPException(status_code=503, detail="TTS service (Orpheus API) not available, and Kokoro not applicable for this language.")

        if generated_successfully and temp_file_path and os.path.exists(temp_file_path) and os.path.getsize(temp_file_path) > 0:
            with open(temp_file_path, "rb") as f_audio: audio_bytes = f_audio.read()
            return StreamingResponse(io.BytesIO(audio_bytes), media_type="audio/wav", headers={"Content-Disposition": f"attachment; filename=tts_output_{language}_{synthesis_method_used}_{uuid.uuid4().hex[:8]}.wav"})
        else:
            error_detail = "TTS synthesis failed: No valid audio produced or unexpected state."
            if not KOKORO_TTS_AVAILABLE and not ORPHEUS_TTS_AVAILABLE: error_detail = "All TTS services are unavailable."
            elif synthesis_method_used != "none": error_detail = f"TTS using {synthesis_method_used} for '{language}' failed."
            else: error_detail = f"No suitable TTS engine for '{language}'."
            raise HTTPException(status_code=500, detail=error_detail)
    except HTTPException: raise
    except Exception as e: print(f"Worker TTS Endpoint Error for '{language}', method '{synthesis_method_used}': {e}"); traceback.print_exc(); raise HTTPException(status_code=500, detail=f"TTS internal error: {str(e)}")
    finally:
        if temp_file_path and os.path.exists(temp_file_path):
            try: os.remove(temp_file_path); print(f"Worker: Temp TTS file {temp_file_path} removed.")
            except Exception as e_rem: print(f"Worker: Error removing temp TTS file {temp_file_path}: {e_rem}")

@app.post("/transcribe-audio")
async def transcribe_audio_endpoint(audio_file: UploadFile = File(...), language: str = Form(...)):
    temp_file_path = None
    transcription_result = None
    stt_engine_used = "none"

    try:
        suffix = os.path.splitext(audio_file.filename or ".webm")[1] or ".tmp"
        if not suffix.startswith('.'): suffix = "." + suffix
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix, prefix="stt_input_") as tmp_audio:
            shutil.copyfileobj(audio_file.file, tmp_audio)
            temp_file_path = tmp_audio.name
        print(f"Worker: STT input saved to {temp_file_path}")

        is_english_request = language.lower().startswith("en")

        if is_english_request and PARAKEET_STT_AVAILABLE and _parakeet_model_instance:
            stt_engine_used = "parakeet"
            print(f"Worker: Attempting STT with Parakeet for English input: {temp_file_path}")
            try:
                parakeet_output_list = await asyncio.to_thread(
                    _parakeet_model_instance.transcribe,
                    [temp_file_path]
                )
                
                full_transcription_text = None
                if parakeet_output_list and isinstance(parakeet_output_list, list) and len(parakeet_output_list) > 0:
                    first_result = parakeet_output_list[0]
                    if isinstance(first_result, str):
                        full_transcription_text = first_result.strip()
                    elif hasattr(first_result, 'text') and isinstance(first_result.text, str):
                        full_transcription_text = first_result.text.strip()
                    elif hasattr(first_result, 'hypotheses') and isinstance(first_result.hypotheses, list) and \
                         len(first_result.hypotheses) > 0 and hasattr(first_result.hypotheses[0], 'text') and \
                         isinstance(first_result.hypotheses[0].text, str):
                        full_transcription_text = first_result.hypotheses[0].text.strip()
                    
                    if full_transcription_text is not None: # Check if text was extracted
                        transcription_result = {
                            "transcription": full_transcription_text,
                            "language": "en",
                            "language_probability": 1.0
                        }
                        print(f"Worker: Parakeet STT complete. Transcription: '{full_transcription_text[:100]}...'")
                    else:
                        print(f"Worker: Parakeet output structure unexpected or text not found: {type(first_result)}. Falling back.")
                else:
                    print(f"Worker: Parakeet STT produced no output or unexpected list format. Falling back.")
            except Exception as e_parakeet:
                print(f"Worker: Parakeet STT error: {e_parakeet}. Falling back to Faster Whisper.")
                traceback.print_exc()
        
        if transcription_result is None: # Fallback or primary for non-English
            if FASTER_WHISPER_AVAILABLE and _whisper_model_instance:
                stt_engine_used = "faster_whisper"
                print(f"Worker: Attempting STT with Faster Whisper. Language hint: {language}, File: {temp_file_path}")
                try:
                    lang_param = language if language and language.lower() != "auto" else None
                    segments, info = await asyncio.to_thread(
                        _whisper_model_instance.transcribe,
                        temp_file_path, beam_size=5, language=lang_param
                    )
                    transcribed_texts = [segment.text.strip() for segment in segments]
                    full_transcription = " ".join(transcribed_texts).strip()
                    transcription_result = {
                        "transcription": full_transcription,
                        "language": info.language,
                        "language_probability": info.language_probability
                    }
                    print(f"Worker: Faster Whisper STT complete. Detected Lang: {info.language} (Prob: {info.language_probability:.2f}). Tx: '{full_transcription[:100]}...'")
                except Exception as e_whisper:
                    print(f"Worker: Faster Whisper STT error: {e_whisper}")
                    traceback.print_exc()
                    # If Parakeet was attempted and failed, and Whisper also fails, then raise error
                    if is_english_request and stt_engine_used == "parakeet": # Parakeet was the first choice
                        raise HTTPException(status_code=500, detail=f"STT failed. Parakeet error, then Faster Whisper error: {str(e_whisper)}")
                    raise HTTPException(status_code=500, detail=f"STT (Faster Whisper) internal error: {str(e_whisper)}")
            elif is_english_request and not PARAKEET_STT_AVAILABLE and os.getenv("ENABLE_PARAKEET_STT", "false").lower() == "true":
                # English requested, Parakeet was enabled but failed to load, and Whisper is also not available (or this path wouldn't be hit)
                raise HTTPException(status_code=503, detail="English STT (Parakeet) enabled but not available, and no fallback STT.")

        if transcription_result:
            return transcription_result
        else:
            detail_msg = "STT service not available or all attempts failed for the request."
            if not PARAKEET_STT_AVAILABLE and not FASTER_WHISPER_AVAILABLE:
                detail_msg = "All STT services (Parakeet, Faster Whisper) are unavailable."
            elif is_english_request and not PARAKEET_STT_AVAILABLE and os.getenv("ENABLE_PARAKEET_STT", "false").lower() == "true":
                 detail_msg = "Parakeet STT for English is enabled but not available, and Faster Whisper also failed or is unavailable."
            elif not FASTER_WHISPER_AVAILABLE:
                 detail_msg = "Faster Whisper STT is not available (and Parakeet not applicable/available for this request)."
            raise HTTPException(status_code=503, detail=detail_msg)

    except HTTPException: raise
    except Exception as e:
        print(f"Worker STT Endpoint Error (engine: {stt_engine_used}): {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"STT internal error: {str(e)}")
    finally:
        if temp_file_path and os.path.exists(temp_file_path):
            try: os.remove(temp_file_path); print(f"Worker: Temp STT file {temp_file_path} removed.")
            except Exception as e_rem: print(f"Worker: Error removing temp STT file {temp_file_path}: {e_rem}")
        if hasattr(audio_file, 'close'):
            try: await audio_file.close()
            except Exception: pass

if __name__ == "__main__":
    port = int(os.getenv("WORKER_PORT", 8087))
    print(f"Starting STT/TTS Worker Microservice on port {port}")
    
    print(f"Orpheus TTS API URL: {ORPHEUS_API_FULL_URL}")
    if ORPHEUS_TTS_AVAILABLE: print(f"Orpheus TTS via API is active for languages: {list(_orpheus_api_configs.keys())}")
    else: print("Orpheus TTS via API is NOT available.")

    if KOKORO_TTS_AVAILABLE:
        kokoro_active_langs = [lang for lang, cfg in KOKORO_LANGUAGE_CONFIG.items() if cfg.get("kokoro_lang_code") in _kokoro_pipelines]
        if kokoro_active_langs: print(f"Kokoro TTS is active for languages: {kokoro_active_langs}")
        else: print("Kokoro TTS imported, but no language pipelines initialized/configured.")
    else: print("Kokoro TTS is NOT available.")

    if FASTER_WHISPER_AVAILABLE: print(f"Faster Whisper STT service is active with model: {WHISPER_MODEL_SIZE}")
    else: print("Faster Whisper STT service is NOT available.")

    if PARAKEET_STT_AVAILABLE: print(f"Parakeet STT service is active with model: {PARAKEET_MODEL_NAME} (for English)")
    elif os.getenv("ENABLE_PARAKEET_STT", "false").lower() == "true": print("Parakeet STT was enabled but FAILED to initialize.")
    else: print("Parakeet STT service is NOT enabled.")
        
    uvicorn.run(app, host="0.0.0.0", port=port)