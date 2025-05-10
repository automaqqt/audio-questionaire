from fastapi import FastAPI, HTTPException, File, UploadFile, Body
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import json
import os
import uuid
import csv
import io
from typing import List, Dict, Any, Optional
from contextlib import asynccontextmanager # For lifespan management

# --- Import your services and models ---
# Assuming models.py contains Pydantic models like Question, Questionnaire, Answer, TranscribedResponse
from models.pymods import Question, Questionnaire, Answer, TranscribedResponse 
# Assuming services are structured
from services import tts_service, stt_service, questionnaire_service # Create these modules

# --- Global State (POC - consider better state/session management for non-POC) ---
# This state would ideally be managed within questionnaire_service
# For simplicity in this example, keeping them here but they should be encapsulated.
# current_questionnaire_data: Optional[Questionnaire] = None
# current_answers: List[Answer] = []
# current_question_index: int = -1


# --- Lifespan Context Manager for Startup/Shutdown ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    # --- Code to execute on startup ---
    print("Application startup...")
    
    # Initialize TTS Service (e.g., Coqui TTS)
    print("Initializing TTS Service...")
    tts_service.initialize_tts() # This function should load the model
    if not tts_service.is_tts_ready(): # Add a check in your tts_service
        print("WARNING: TTS Service did not initialize correctly.")
        # You might choose to raise an exception here if TTS is critical
        # raise RuntimeError("TTS Service failed to initialize")

    # Initialize STT Service (e.g., Vosk)
    print("Initializing STT Service...")
    stt_service.initialize_stt() # This function should load the Vosk model
    if not stt_service.is_stt_ready(): # Add a check in your stt_service
        print("WARNING: STT Service did not initialize correctly.")
        # raise RuntimeError("STT Service failed to initialize")

    # Initialize Questionnaire Service (if it needs any setup)
    questionnaire_service.initialize_service() # e.g., clear any residual state

    print("Application startup complete.")
    yield
    # --- Code to execute on shutdown ---
    print("Application shutdown...")
    # Clean up resources if needed (e.g., explicitly releasing models, though Python's GC usually handles it)
    if tts_service.is_tts_ready():
        tts_service.shutdown_tts() # Implement this if Coqui TTS needs explicit cleanup
    if stt_service.is_stt_ready():
        stt_service.shutdown_stt() # Implement this if Vosk needs explicit cleanup
    print("Application shutdown complete.")

# --- FastAPI App Instance with Lifespan ---
app = FastAPI(lifespan=lifespan)

# CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3002"], # Adjust for your React app
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Temp Audio Directory (Managed by tts_service ideally) ---
# This should be defined within tts_service or a config module
TEMP_AUDIO_DIR = os.path.join(os.path.dirname(__file__), "temp_audio") 
os.makedirs(TEMP_AUDIO_DIR, exist_ok=True) # Ensure it exists


# --- API Routes ---

@app.post("/api/questionnaire/load", response_model=questionnaire_service.QuestionnaireInfoResponse)
async def load_questionnaire():
    """
    Loads a questionnaire from a JSON file.
    The `embed=True` for Body means it expects {"file_name": "your_file.json"}
    """
    try:
        # The actual questionnaire data is now managed by questionnaire_service
        info = questionnaire_service.load_questionnaire_from_file('example_questionnaire.json')
        return info
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e: # For bad JSON structure or validation errors
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # Log the full error for debugging
        print(f"Unexpected error loading questionnaire: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Internal server error loading questionnaire.")


@app.get("/api/questionnaire/next_question", response_model=questionnaire_service.NextQuestionResponse)
async def get_next_question():
    if not questionnaire_service.is_questionnaire_loaded():
        raise HTTPException(status_code=400, detail="No questionnaire loaded.")

    next_q_data = questionnaire_service.get_next_question_details()

    if next_q_data.get("completed"):
        return questionnaire_service.NextQuestionResponse(**next_q_data)

    question_text_to_speak = next_q_data["text"]
    if next_q_data.get("options_text"):
        question_text_to_speak += " " + next_q_data["options_text"]
    
    if not tts_service.is_tts_ready():
        raise HTTPException(status_code=503, detail="TTS service not available.")
        
    audio_file_path = tts_service.synthesize_speech(question_text_to_speak) # Renamed for generality
    if not audio_file_path:
        raise HTTPException(status_code=500, detail="TTS synthesis failed.")
    
    audio_file_name = os.path.basename(audio_file_path)
    
    # Construct the full response object matching NextQuestionResponse Pydantic model
    response_data = {
        "question_id": next_q_data["id"],
        "question_text": next_q_data["text"],
        "question_number": questionnaire_service.get_current_question_number(),
        "total_questions": questionnaire_service.get_total_questions(),
        "audio_url": f"/api/audio/{audio_file_name}",
        "options_text": next_q_data.get("options_text"),
        "question_type": next_q_data["type"],
        "min_value": next_q_data.get("min_value"),
        "max_value": next_q_data.get("max_value"),
        "completed": False
    }
    return questionnaire_service.NextQuestionResponse(**response_data)


@app.get("/api/audio/{file_name}")
async def serve_audio_file(file_name: str):
    # TEMP_AUDIO_DIR should be accessible by tts_service or globally configured
    file_path = os.path.join(TEMP_AUDIO_DIR, file_name) 
    if os.path.exists(file_path):
        return FileResponse(file_path, media_type="audio/wav")
    raise HTTPException(status_code=404, detail="Audio file not found.")


@app.post("/api/answer/submit", response_model=TranscribedResponse) # Assuming TranscribedResponse is in models.py
async def submit_answer(audio_file: UploadFile = File(...)):
    if not stt_service.is_stt_ready():
        raise HTTPException(status_code=503, detail="STT service not available.")
    if not questionnaire_service.is_questionnaire_loaded() or not questionnaire_service.get_current_question_details_for_answer():
        raise HTTPException(status_code=400, detail="No active question to answer.")

    current_q_details = questionnaire_service.get_current_question_details_for_answer()

    try:
        audio_content = await audio_file.read()

        #print(audio_content)
        
        transcription, parse_result = stt_service.transcribe_and_parse(audio_content, current_q_details)
        
        return TranscribedResponse(
            transcription=transcription,
            parsed_value=parse_result.get("parsed_value"),
            value_found=parse_result.get("value_found", False),
            error_message=parse_result.get("error_message")
        )

    except Exception as e:
        print(f"Error processing answer: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error processing answer: {str(e)}")


@app.post("/api/answer/confirm", response_model=questionnaire_service.ConfirmAnswerResponse) # Define this Pydantic model
async def confirm_answer(confirmed_answer_payload: Answer): # Assuming Answer is the Pydantic model from frontend
    if not questionnaire_service.is_questionnaire_loaded():
        raise HTTPException(status_code=400, detail="No questionnaire loaded to confirm answer for.")
    
    try:
        # The service handles storing the confirmed answer
        saved_answer = questionnaire_service.store_confirmed_answer(confirmed_answer_payload)
        return questionnaire_service.ConfirmAnswerResponse(
            message="Answer confirmed and saved.", 
            answer=saved_answer
        )
    except ValueError as e: # e.g. if answer doesn't match current question
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        print(f"Error confirming answer: {e}")
        raise HTTPException(status_code=500, detail="Failed to confirm answer.")


@app.get("/api/results/download_csv")
async def download_results_csv():
    if not questionnaire_service.has_answers():
        raise HTTPException(status_code=400, detail="No answers to download.")

    csv_content = questionnaire_service.get_results_as_csv_string()
    
    return FileResponse(
        io.BytesIO(csv_content.encode()),
        media_type='text/csv',
        filename='questionnaire_results.csv'
    )

@app.get("/api/state/reset", response_model=Dict[str, str])
async def reset_state_endpoint(): # Renamed to avoid conflict with built-in 'reset_state'
    questionnaire_service.reset_questionnaire_state()
    # Optionally, tell tts_service to clean up temp audio files
    tts_service.cleanup_temp_audio_files() 
    return {"message": "Application state reset."}


# --- Main execution for development (if running this file directly) ---
if __name__ == "__main__":
    print("Starting FastAPI server directly for development...")
    # Configuration for TTS/STT models should be handled within their respective services
    # or loaded from a config file.
    uvicorn.run("main:app", port=8000, reload=True)