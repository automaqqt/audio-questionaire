import shutil
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import StreamingResponse
import uvicorn
import os
import tempfile
import io
import uuid
import traceback
import wave # For writing WAV files
import requests # For API calls to the inference server
import json
import asyncio
import threading
import queue
import numpy as np # Used by your stream_audio, likely by decoder too

# --- Orpheus TTS via API Configuration ---
ORPHEUS_TTS_AVAILABLE = False
_orpheus_api_configs = {} # Stores API model_id, voice, and other params for each lang

# API Connection Settings (can be overridden by environment variables)
ORPHEUS_API_BASE_URL = os.getenv("ORPHEUS_API_BASE_URL", "http://localhost:1234/v1") # For LM Studio, etc.
ORPHEUS_API_ENDPOINT_PATH = os.getenv("ORPHEUS_API_ENDPOINT_PATH", "/completions") # Or /completions
ORPHEUS_API_FULL_URL = f"{ORPHEUS_API_BASE_URL.rstrip('/')}{ORPHEUS_API_ENDPOINT_PATH}"
ORPHEUS_API_HEADERS = {"Content-Type": "application/json"}

# Default generation parameters (can be overridden per language or by env vars)
DEFAULT_VOICE = "tara" # This will be overridden by language-specific config
DEFAULT_TEMPERATURE = float(os.getenv("ORPHEUS_API_TEMPERATURE", 0.7))
DEFAULT_TOP_P = float(os.getenv("ORPHEUS_API_TOP_P", 0.9))
DEFAULT_MAX_TOKENS = int(os.getenv("ORPHEUS_API_MAX_TOKENS", 2048)) # Max text tokens from LLM
DEFAULT_REPETITION_PENALTY = float(os.getenv("ORPHEUS_API_REPETITION_PENALTY", 1.1))
DEFAULT_SAMPLE_RATE = 24000 # Orpheus default sample rate

# Special token constants from your provided code
START_TOKEN_ID = 128259 # Not directly used in API call logic, but may be relevant for decoder
END_TOKEN_IDS = [128009, 128260, 128261, 128257] # Same as above
CUSTOM_TOKEN_PREFIX = "<custom_token_"

# --- BEGIN: User-provided Orpheus API Client Logic ---
# (Adapted to fit into the FastAPI service structure)

# Attempt to import the crucial decoder function
try:
    from decoder import convert_to_audio as orpheus_decoder_convert_to_audio
    DECODER_AVAILABLE = True
    print("Successfully imported 'convert_to_audio' from 'decoder' module.")
except ImportError:
    DECODER_AVAILABLE = False
    print("ERROR: Could not import 'convert_to_audio' from 'decoder' module.")
    print("Ensure 'decoder.py' is in your Python path and contains this function.")
    print("Orpheus TTS via API will NOT be available without it.")
    def orpheus_decoder_convert_to_audio(multiframe, count): # Placeholder
        print("CRITICAL: 'orpheus_decoder_convert_to_audio' is a placeholder. Real decoder needed!")
        return None 
except Exception as e_decoder_import:
    DECODER_AVAILABLE = False
    print(f"ERROR: An unexpected error occurred while trying to import from 'decoder': {e_decoder_import}")
    traceback.print_exc()
    def orpheus_decoder_convert_to_audio(multiframe, count): # Placeholder
        print("CRITICAL: 'orpheus_decoder_convert_to_audio' (placeholder due to import error). Real decoder needed!")
        return None

def format_prompt_for_api(prompt, voice):
    formatted_prompt = f"{voice}: {prompt}"
    special_start = "<|audio|>"
    special_end = "<|eot_id|>"
    return f"{special_start}{formatted_prompt}{special_end}"

def generate_tokens_from_api(api_url, headers, model_identifier, prompt, voice, temperature, top_p, max_tokens, repetition_penalty):
    formatted_prompt = format_prompt_for_api(prompt, voice)
    print(f"[OrpheusAPIClient] Generating speech tokens for model '{model_identifier}' with prompt: {formatted_prompt[:100]}...")

    payload = {
        "model": model_identifier, # Model name for the inference server
        "prompt": formatted_prompt, # For older /completions endpoint
        "max_tokens": max_tokens,
        "temperature": temperature,
        "top_p": top_p,
        "repetition_penalty": repetition_penalty, # Note: some servers use "repeat_penalty"
        "stream": True
    }
    # Clean up payload based on endpoint type (simple heuristic)
    


    try:
        response = requests.post(api_url, headers=headers, json=payload, stream=True, timeout=120) # 120s timeout
        response.raise_for_status() # Raise an exception for HTTP errors
    except requests.exceptions.RequestException as e:
        print(f"[OrpheusAPIClient] Error: API request failed: {e}")
        print(f"[OrpheusAPIClient] URL: {api_url}, Payload: {json.dumps(payload, indent=2)}")
        if hasattr(e, 'response') and e.response is not None:
             print(f"[OrpheusAPIClient] Response Text: {e.response.text}")
        return # Yield nothing

    for line in response.iter_lines():
        if line:
            line_decoded = line.decode('utf-8')
            if line_decoded.startswith('data: '):
                data_str = line_decoded[6:]
                if data_str.strip() == '[DONE]':
                    break
                try:
                    data = json.loads(data_str)
                    # Structure for /chat/completions
                    if 'choices' in data and len(data['choices']) > 0 and 'delta' in data['choices'][0] and 'content' in data['choices'][0]['delta']:
                        token_text = data['choices'][0]['delta'].get('content', '')
                        if token_text: yield token_text
                    # Structure for /completions
                    elif 'choices' in data and len(data['choices']) > 0 and 'text' in data['choices'][0]:
                        token_text = data['choices'][0].get('text', '')
                        if token_text: yield token_text
                except json.JSONDecodeError:
                    print(f"[OrpheusAPIClient] Error decoding JSON: {data_str}")
                    continue
    print("[OrpheusAPIClient] Token generation stream complete.")


def turn_token_into_id(token_string, index):
    token_string = token_string.strip()
    last_token_start = token_string.rfind(CUSTOM_TOKEN_PREFIX)
    if last_token_start == -1: return None
    last_token = token_string[last_token_start:]
    if last_token.startswith(CUSTOM_TOKEN_PREFIX) and last_token.endswith(">"):
        try:
            number_str = last_token[len(CUSTOM_TOKEN_PREFIX):-1]
            token_id = int(number_str) - 10 - ((index % 7) * 4096) # Magic numbers from your code
            return token_id
        except ValueError: return None
    return None

async def tokens_decoder_async_generator(token_text_stream):
    """ Asynchronously processes token text stream and yields audio samples. """
    if not DECODER_AVAILABLE:
        print("[OrpheusAPIClient] Decoder not available, cannot process tokens into audio.")
        yield b'' # Yield empty bytes if decoder is missing
        return

    buffer = []
    count = 0
    async for token_text_chunk in token_text_stream: # Assuming token_text_stream is async
        # If the LLM sends multiple custom tokens in one chunk, split them
        # This is a simple heuristic, might need refinement based on actual API output
        tokens_in_chunk = token_text_chunk.split(CUSTOM_TOKEN_PREFIX)
        
        first_part = tokens_in_chunk[0] # Text before the first custom_token (if any)
        # Potentially handle 'first_part' if it contains non-custom-token text
        # that should not be processed by turn_token_into_id.
        # For now, assuming custom tokens are the primary content.

        for i, part in enumerate(tokens_in_chunk):
            if i == 0 and not token_text_chunk.startswith(CUSTOM_TOKEN_PREFIX): # Skip the part before the first token
                continue
            
            full_token_text = CUSTOM_TOKEN_PREFIX + part if not part.startswith(CUSTOM_TOKEN_PREFIX) else part

            token_id = turn_token_into_id(full_token_text, count)
            if token_id is not None and token_id > 0: # Assuming 0 or negative is invalid
                buffer.append(token_id)
                count += 1
                if count % 7 == 0 and count > 27: # Magic numbers from your code
                    buffer_to_proc = buffer[-28:]
                    # Call the imported decoder function
                    audio_samples = orpheus_decoder_convert_to_audio(buffer_to_proc, count)
                    if audio_samples is not None:
                        yield audio_samples # Expecting bytes


def generate_speech_via_api_and_decode(
    api_url, headers, model_identifier, text_prompt, voice,
    temperature, top_p, max_tokens, repetition_penalty,
    output_file_path, sample_rate
):
    if not DECODER_AVAILABLE:
        print("[OrpheusAPIClient] Cannot generate speech: Decoder is not available.")
        return False

    # generate_tokens_from_api is a synchronous generator using requests
    # We need to adapt it for an async context or run it in a thread.
    # For simplicity with FastAPI's async nature and requests being sync,
    # we'll run the token generation and decoding in a separate thread.

    audio_written = False
    
    def task_in_thread():
        nonlocal audio_written
        token_text_generator = generate_tokens_from_api(
            api_url, headers, model_identifier, text_prompt, voice,
            temperature, top_p, max_tokens, repetition_penalty
        )

        # The token_text_generator is sync. We need an async version for tokens_decoder_async_generator
        async def async_token_text_gen_wrapper(sync_gen):
            for item in sync_gen:
                yield item
                await asyncio.sleep(0) # Yield control to event loop

        async def process_audio_stream():
            nonlocal audio_written
            written_anything_to_wav = False
            try:
                with wave.open(output_file_path, "wb") as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2) # 16-bit
                    wf.setframerate(sample_rate)

                    async for audio_chunk in tokens_decoder_async_generator(async_token_text_gen_wrapper(token_text_generator)):
                        if audio_chunk and isinstance(audio_chunk, bytes):
                            wf.writeframes(audio_chunk)
                            written_anything_to_wav = True
                        elif audio_chunk: # If not bytes, log warning
                            print(f"[OrpheusAPIClient] Warning: Decoder yielded non-bytes data: {type(audio_chunk)}")
                
                if written_anything_to_wav and os.path.exists(output_file_path) and os.path.getsize(output_file_path) > 0:
                    audio_written = True
                    print(f"[OrpheusAPIClient] Audio successfully written to {output_file_path}")
                elif written_anything_to_wav: # Wrote to wf but file is empty/missing
                    print(f"[OrpheusAPIClient] Warning: Audio frames were processed, but output file {output_file_path} is empty or missing.")
                else: # No audio frames processed
                    print(f"[OrpheusAPIClient] No audio frames were generated or written to {output_file_path}.")

            except Exception as e_process:
                print(f"[OrpheusAPIClient] Error during audio stream processing or WAV writing: {e_process}")
                traceback.print_exc()
        
        asyncio.run(process_audio_stream())

    # Run the synchronous API calls and subsequent async processing in a separate thread
    # to avoid blocking FastAPI's main event loop.
    thread = threading.Thread(target=task_in_thread)
    thread.start()
    thread.join() # Wait for the thread to complete

    return audio_written

# --- END: User-provided Orpheus API Client Logic ---


# Language-specific configurations for API interaction
# Key: language code (e.g., "en", "de")
# Value: dict with "api_model_identifier", "voice", and generation parameters
ORPHEUS_LANGUAGE_API_SETUP = {
    "en": {
        "api_model_identifier": os.getenv("ORPHEUS_API_MODEL_EN", "orpheus-3b-0.1-ft"), # Model name inference server expects
        "voice": os.getenv("ORPHEUS_VOICE_EN", DEFAULT_VOICE),
        "temperature": float(os.getenv("ORPHEUS_API_TEMP_EN", DEFAULT_TEMPERATURE)),
        "top_p": float(os.getenv("ORPHEUS_API_TOP_P_EN", DEFAULT_TOP_P)),
        "max_tokens": int(os.getenv("ORPHEUS_API_MAX_TOKENS_EN", DEFAULT_MAX_TOKENS)),
        "repetition_penalty": float(os.getenv("ORPHEUS_API_REPPEN_EN", DEFAULT_REPETITION_PENALTY)),
        "sample_rate": int(os.getenv("ORPHEUS_API_SR_EN", DEFAULT_SAMPLE_RATE)),
    },
    "de": {
        "api_model_identifier": os.getenv("ORPHEUS_API_MODEL_EN", "3b-de-ft-research_release"), # Model name inference server expects
        "voice":"jana",
        "temperature": float(os.getenv("ORPHEUS_API_TEMP_EN", DEFAULT_TEMPERATURE)),
        "top_p": float(os.getenv("ORPHEUS_API_TOP_P_EN", DEFAULT_TOP_P)),
        "max_tokens": int(os.getenv("ORPHEUS_API_MAX_TOKENS_EN", DEFAULT_MAX_TOKENS)),
        "repetition_penalty": float(os.getenv("ORPHEUS_API_REPPEN_EN", DEFAULT_REPETITION_PENALTY)),
        "sample_rate": int(os.getenv("ORPHEUS_API_SR_EN", DEFAULT_SAMPLE_RATE)),
    },
    # Add more languages here, e.g., "de"
    # "de": {
    #     "api_model_identifier": os.getenv("ORPHEUS_API_MODEL_DE", "german-orpheus-gguf-model"),
    #     "voice": os.getenv("ORPHEUS_VOICE_DE", "german_voice_name"),
    #     # ... other parameters ...
    # },
}

# Initialize API configurations
if DECODER_AVAILABLE: # Only proceed if decoder is found
    for lang_code, config in ORPHEUS_LANGUAGE_API_SETUP.items():
        if "api_model_identifier" in config and "voice" in config:
            _orpheus_api_configs[lang_code] = {
                "api_model_identifier": config["api_model_identifier"],
                "voice": config["voice"],
                "temperature": config.get("temperature", DEFAULT_TEMPERATURE),
                "top_p": config.get("top_p", DEFAULT_TOP_P),
                "max_tokens": config.get("max_tokens", DEFAULT_MAX_TOKENS),
                "repetition_penalty": config.get("repetition_penalty", DEFAULT_REPETITION_PENALTY),
                "sample_rate": config.get("sample_rate", DEFAULT_SAMPLE_RATE),
            }
            print(f"[OrpheusAPIConfig] Configured TTS for language '{lang_code}' using API model '{config['api_model_identifier']}' and voice '{config['voice']}'.")
        else:
            print(f"[OrpheusAPIConfig] Incomplete configuration for language '{lang_code}'. Skipping.")

    if _orpheus_api_configs:
        ORPHEUS_TTS_AVAILABLE = True
        print(f"[OrpheusAPIConfig] Orpheus TTS via API is active for languages: {list(_orpheus_api_configs.keys())}")
    else:
        print("[OrpheusAPIConfig] Orpheus TTS via API is NOT active. No valid language configurations found.")
else:
    print("[OrpheusAPIConfig] Orpheus TTS via API is NOT active due to missing 'decoder' module.")


# --- Faster Whisper Configuration & Initialization (Unchanged) ---
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
    if not ORPHEUS_TTS_AVAILABLE:
        raise HTTPException(status_code=503, detail="TTS service (Orpheus API) not available. Check server logs for decoder or configuration issues.")

    lang_config = _orpheus_api_configs.get(language)
    if not lang_config:
        raise HTTPException(
            status_code=400,
            detail=f"TTS via API for language '{language}' is not configured or supported. Available: {list(_orpheus_api_configs.keys())}"
        )

    temp_file_path = None
    try:
        fd, temp_file_path = tempfile.mkstemp(suffix=".wav", prefix=f"orpheus_api_tts_{language}_")
        os.close(fd)

        print(f"[FastAPI Endpoint] Requesting synthesis for lang '{language}', text: '{text[:50]}...'")
        success = await asyncio.to_thread( # Run the blocking (due to requests and threading.join) function in a thread
            generate_speech_via_api_and_decode,
            ORPHEUS_API_FULL_URL,
            ORPHEUS_API_HEADERS,
            lang_config["api_model_identifier"],
            text,
            lang_config["voice"],
            lang_config["temperature"],
            lang_config["top_p"],
            lang_config["max_tokens"],
            lang_config["repetition_penalty"],
            temp_file_path,
            lang_config["sample_rate"]
        )
        
        if not success or not os.path.exists(temp_file_path) or os.path.getsize(temp_file_path) == 0:
            detail_msg = f"Orpheus API TTS synthesis failed for language '{language}' or produced an empty file."
            if os.path.exists(temp_file_path) and os.path.getsize(temp_file_path) == 0:
                detail_msg += " Output file was created but is empty."
            elif not os.path.exists(temp_file_path):
                 detail_msg += " Output file was not created."
            print(f"[FastAPI Endpoint] {detail_msg}")
            raise HTTPException(status_code=500, detail=detail_msg)

        print(f"[FastAPI Endpoint] Orpheus API TTS synthesized for '{language}' to {temp_file_path}, size: {os.path.getsize(temp_file_path)}")

        with open(temp_file_path, "rb") as f_audio:
            audio_bytes = f_audio.read()
        
        return StreamingResponse(io.BytesIO(audio_bytes), media_type="audio/wav", headers={
            "Content-Disposition": f"attachment; filename=tts_output_{language}_{uuid.uuid4().hex[:8]}.wav"
        })

    except HTTPException:
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


# --- /transcribe-audio endpoint (Unchanged from your previous version) ---
@app.post("/transcribe-audio")
async def transcribe_audio_endpoint(audio_file: UploadFile = File(...), language: str = Form(...)):
    if not FASTER_WHISPER_AVAILABLE or _whisper_model_instance is None:
        raise HTTPException(status_code=503, detail="STT service (faster-whisper) not available.")

    temp_file_path = None
    try:
        suffix = os.path.splitext(audio_file.filename or ".webm")[1]
        if not suffix: suffix = ".tmp"
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
        if hasattr(audio_file, 'close'):
            await audio_file.close()


if __name__ == "__main__":
    port = int(os.getenv("WORKER_PORT", 8087))
    print(f"Starting STT/TTS Worker Microservice on port {port}")
    print(f"Orpheus TTS API URL: {ORPHEUS_API_FULL_URL}")
    if ORPHEUS_TTS_AVAILABLE:
        print(f"Orpheus TTS via API is configured and active for languages: {list(_orpheus_api_configs.keys())}")
    else:
        print("Orpheus TTS via API is NOT available. Check 'decoder' module import and configurations.")
    if FASTER_WHISPER_AVAILABLE:
        print(f"Faster Whisper STT service is active with model: {WHISPER_MODEL_SIZE}")
    else:
        print("Faster Whisper STT service is not available.")
        
    uvicorn.run(app, host="0.0.0.0", port=port)