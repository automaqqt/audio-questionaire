import os
import uuid
import json # Though faster-whisper returns objects, not direct JSON strings
from typing import Optional, Tuple, Dict, Any
from models.pymods import Question # Your Pydantic Question model

try:
    from faster_whisper import WhisperModel
    FASTER_WHISPER_AVAILABLE = True
except ImportError:
    print("faster-whisper library not found. Please run: pip install faster-whisper")
    FASTER_WHISPER_AVAILABLE = False
    WhisperModel = None # Placeholder

_whisper_model_instance: Optional[WhisperModel] = None

# --- Configuration for faster-whisper ---
# Model size: "tiny", "tiny.en", "base", "base.en", "small", "small.en", 
# "medium", "medium.en", "large-v1", "large-v2", "large-v3", "distil-large-v2", etc.
# Smaller models are faster but less accurate. "base" or "small" are good starting points.
# "large-v3" is very accurate but resource-intensive.
# For German, a multilingual model like "base", "small", "medium", or "large-vX" is needed.
WHISPER_MODEL_SIZE = os.getenv("WHISPER_MODEL_SIZE", "medium") # "base" is a good balance

# Device: "cuda" (for NVIDIA GPU), "cpu"
# Other devices like "mps" (Apple Silicon) might be supported by underlying CTranslate2
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")

# Compute type for speed/accuracy trade-off:
# On GPU: "float16" (good balance), "int8_float16" (faster, slight acc. loss), "int8" (fastest, more acc. loss)
# On CPU: "int8" (recommended for speed), "float32" (more accurate but slower)
if WHISPER_DEVICE == "cuda":
    WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "float16")
else: # CPU
    WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")


# Directory for saving temporary audio files for Whisper to process
_TEMP_AUDIO_PROCESSING_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "temp_stt_audio")
os.makedirs(_TEMP_AUDIO_PROCESSING_DIR, exist_ok=True)
print(f"STT Service: Temporary audio for Whisper will be saved in: {_TEMP_AUDIO_PROCESSING_DIR}")


def initialize_stt():
    global _whisper_model_instance
    if not FASTER_WHISPER_AVAILABLE:
        print("STT Service (faster-whisper) cannot initialize because library is not installed.")
        return

    if _whisper_model_instance is None:
        try:
            print(f"Initializing faster-whisper model: {WHISPER_MODEL_SIZE}, Device: {WHISPER_DEVICE}, Compute: {WHISPER_COMPUTE_TYPE}")
            # The first time, this will download the model, which can take a while.
            # Models are cached in ~/.cache/huggingface/hub/ or similar by default.
            _whisper_model_instance = WhisperModel(
                WHISPER_MODEL_SIZE,
                device=WHISPER_DEVICE,
                compute_type=WHISPER_COMPUTE_TYPE,
                # download_root="path/to/your/custom/model_cache" # Optional: if you want to specify model cache
            )
            print("faster-whisper model initialized successfully.")
        except Exception as e:
            print(f"Failed to initialize faster-whisper model: {e}")
            import traceback
            traceback.print_exc()
            _whisper_model_instance = None

def is_stt_ready() -> bool:
    return _whisper_model_instance is not None

def _parse_value_from_transcription(text: str, question: Question) -> Tuple[Optional[Any], bool, Optional[str]]:
    # This parsing logic remains the same as before (words2num, regex for scale, boolean map)
    processed_text = text.lower()
    #try:
    #    from words2num import words2num
    #    processed_text = str(words2num(processed_text))
    #except ImportError:
     #   pass # words2num not available

    processed_text = processed_text.replace("zwei","2").replace("eins","1").replace("drei","3").replace("vier","4").replace("fünf","5")
    processed_text = processed_text.replace("two","2").replace("one","1").replace("three","3").replace("four","4").replace("five","5")

    if question.type == "scale":
        import re
        numbers = re.findall(r'\d+', processed_text)
        if numbers:
            for num_str in reversed(numbers): # Prioritize last mentioned number
                val = int(num_str)
                if question.min_value is not None and question.max_value is not None:
                     if question.min_value <= val <= question.max_value:
                        return val, True, None
                else: # If no range specified, accept any number found
                    return val, True, None # Or perhaps an error if range is expected for 'scale'
            return None, False, f"Number found, but not in range [{question.min_value}-{question.max_value}]." if question.min_value is not None else "Number found, but question scale range is not defined."
        return None, False, "No number found in response."
    elif question.type == "boolean_custom_map":
        if question.true_value_spoken:
            for true_word in question.true_value_spoken:
                if true_word.lower() in processed_text:
                    return question.true_value_numeric, True, None
        if question.false_value_spoken:
            for false_word in question.false_value_spoken:
                if false_word.lower() in processed_text:
                    return question.false_value_numeric, True, None
        return None, False, "Could not understand 'yes' or 'no' equivalent."
    return None, False, "Unsupported question type for parsing."


def transcribe_and_parse(audio_content: bytes, question_details: Question, original_filename: Optional[str] = "unknown_audio.bin", language: str ="de") -> Tuple[str, Dict[str, Any]]:
    if not is_stt_ready():
        return "STT service (faster-whisper) not ready.", {"value_found": False, "error_message": "STT not available"}

    # --- 1. Save the incoming audio_content to a temporary file ---
    file_extension = ".webm" # Default assumption, or derive from original_filename
    if original_filename:
        name, ext = os.path.splitext(original_filename)
        if ext:
            file_extension = ext
    
    temp_audio_filename = f"whisper_input_{uuid.uuid4().hex[:8]}{file_extension}"
    temp_audio_filepath = os.path.join(_TEMP_AUDIO_PROCESSING_DIR, temp_audio_filename)

    try:
        with open(temp_audio_filepath, "wb") as f_out:
            f_out.write(audio_content)
        print(f"STT Service: Saved temporary audio for Whisper to: {temp_audio_filepath} ({len(audio_content)} bytes)")
    except Exception as e:
        print(f"STT Service: Error saving temporary audio file {temp_audio_filepath}: {e}")
        return "Error saving audio for STT.", {"value_found": False, "error_message": "Could not save audio for processing."}

    # --- 2. Transcribe using faster-whisper ---
    full_transcription = ""
    detected_language = None
    detected_language_prob = 0.0

    try:
        print(f"STT Service: Transcribing '{temp_audio_filepath}' with faster-whisper...")
        # You can specify `language="de"` if you know it's German, for better accuracy
        # or let Whisper detect it.
        # For KIDSCREEN, we know it's German.
        segments, info = _whisper_model_instance.transcribe(
            temp_audio_filepath,
            beam_size=6, # Default is 5, can adjust
            language=language, # Specify German for better results with KIDSCREEN
            vad_filter=True, # Optional: use VAD to filter out silence
            #vad_parameters=dict(min_silence_duration_ms=300) # Optional VAD params
        )
        
        detected_language = info.language
        detected_language_prob = info.language_probability
        print(f"STT Service: Detected language '{detected_language}' with probability {detected_language_prob:.2f}")
        print(f"STT Service: Transcription duration: {info.duration:.2f}s")

        # Concatenate segments to get the full transcription
        # `segments` is a generator, so iterate through it
        transcribed_texts = []
        for segment in segments:
            transcribed_texts.append(segment.text.strip())
            # print(f"[%.2fs -> %.2fs] %s" % (segment.start, segment.end, segment.text)) # For debugging segments
        full_transcription = " ".join(transcribed_texts).strip()
        
        print(f"STT Service: Full transcription: '{full_transcription}'")

    except Exception as e:
        print(f"STT Service: Error during faster-whisper transcription: {e}")
        import traceback
        traceback.print_exc()
        # Clean up temp file even on error
        if os.path.exists(temp_audio_filepath):
            try:
                os.remove(temp_audio_filepath)
            except Exception as rm_e:
                print(f"STT Service: Error removing temp file {temp_audio_filepath} after transcription error: {rm_e}")
        return "Transcription failed.", {"value_found": False, "error_message": f"STT error: {e}"}
    finally:
        # --- 3. Clean up the temporary file ---
        if os.path.exists(temp_audio_filepath):
            try:
                os.remove(temp_audio_filepath)
                # print(f"STT Service: Removed temporary audio file: {temp_audio_filepath}")
            except Exception as e:
                print(f"STT Service: Error removing temporary audio file {temp_audio_filepath}: {e}")

    # --- 4. Parse the transcription ---
    if not full_transcription.strip():
        return "", {"parsed_value": None, "value_found": False, "error_message": "Empty transcription after Whisper processing."}

    parsed_value, value_found, error_msg = _parse_value_from_transcription(full_transcription, question_details)
    
    return full_transcription, {
        "parsed_value": parsed_value,
        "value_found": value_found,
        "error_message": error_msg,
        "detected_language": detected_language, # Optional: return this info
        "language_probability": detected_language_prob # Optional
    }

def shutdown_stt():
    global _whisper_model_instance
    if _whisper_model_instance:
        print("Shutting down STT service (faster-whisper)...")
        # For faster-whisper, model unloading is usually handled when the object is garbage collected.
        # If CTranslate2 offers explicit unloading/destructor calls, they could be invoked here,
        # but typically it's not required for Python objects.
        del _whisper_model_instance # Hint for garbage collection
        _whisper_model_instance = None
        # If using CUDA, some explicit CUDA cache clearing might be beneficial in long-running apps
        # import torch
        # if torch.cuda.is_available():
        # torch.cuda.empty_cache()
    print("STT service (faster-whisper) shut down.")