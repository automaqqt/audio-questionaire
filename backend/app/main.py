from fastapi import FastAPI, HTTPException, File, UploadFile, Form, APIRouter
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import os
import shutil # For file operations
import tempfile # For temporary files
import httpx
import uuid # For unique identifiers

# Your existing services
# New service/module for PDF processing logic
from services import pdf_processor_service # We will create this

WORKER_TTS_URL = os.getenv("WORKER_TTS_URL", "http://localhost:8088/synthesize-speech") 

# Path to the Next.js public directory, writable by this FastAPI PDF Processor
# This MUST be configured correctly based on your deployment.
NEXTJS_PUBLIC_DIR_ABS_PATH = os.getenv("NEXTJS_PUBLIC_DIR_PATH_FOR_AUDIO_SAVE")
if not NEXTJS_PUBLIC_DIR_ABS_PATH:
    # Example fallback for local dev where this FastAPI is in `backend` and Next.js is in `frontend`
    NEXTJS_PUBLIC_DIR_ABS_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "public"))
    print(f"WARNING: PDF Processor: NEXTJS_PUBLIC_DIR_PATH_FOR_AUDIO_SAVE env var not set. Falling back to: {NEXTJS_PUBLIC_DIR_ABS_PATH}")

AUDIO_CACHE_BASE_REL_PATH_IN_NEXTJS_PUBLIC = "audio/questionnaires"

app = FastAPI( title="Voice Questionnaire Backend Processor")

# CORS Middleware - Allow Next.js frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_URL", "http://localhost:3000")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Router for PDF Processing ---
# This will contain the new endpoint that Next.js calls.
processing_api_router = APIRouter(
    prefix="/api/v1/processing",
    tags=["Questionnaire Processing"],
)

@processing_api_router.post("/process-pdf-questionnaire")
async def process_pdf_extract_and_generate_audio(
    pdf_file: UploadFile = File(...),
    title: str = Form(..., description="Title for the questionnaire (provided by researcher)"),
    language: str = Form(..., description="Primary language of the PDF (e.g., 'de', 'en')"),
    nextjs_questionnaire_id: str = Form(..., description="A temporary ID from Next.js for path structuring") # Optional
):
    """
    Receives a PDF, processes it (OCR, LLM), generates TTS audio for questions,
    and returns structured questionnaire data with audio paths.
    Audio files are saved to a location accessible by the Next.js public folder.
    """
    print("✅ received pdf_file:", pdf_file.filename)
    print("✅ received title:", title)
    print("✅ received language:", language)
    temp_pdf_path = None
    # Generate a unique ID for this processing batch for folder naming
    processing_batch_id = nextjs_questionnaire_id

    # Define where Next.js will serve audio from (relative to Next.js public dir)
    # This path needs to be writable by the FastAPI process.
    # And readable/servable by Next.js.
    # Example: FastAPI in 'backend/', Next.js in 'frontend/'
    # NEXTJS_PUBLIC_DIR should be an absolute path or correctly relative.
    # For local dev, if backend is sibling to frontend: ../frontend/public
    nextjs_project_public_dir = os.path.abspath(NEXTJS_PUBLIC_DIR_ABS_PATH)
    if not os.path.isdir(nextjs_project_public_dir):
        # Fallback if structure is different, or use an environment variable
        nextjs_project_public_dir = os.getenv("NEXTJS_PUBLIC_DIR_PATH", "../frontend/public") # Mock if not found
        print(f"Warning: Defaulting Next.js public dir to: {nextjs_project_public_dir}. Ensure this is correct.")
    
    audio_cache_base_rel_path = "questionnaires" # Relative to Next.js public
    questionnaire_audio_output_dir_abs = os.path.join(nextjs_project_public_dir, audio_cache_base_rel_path, processing_batch_id)
    
    try:
        os.makedirs(questionnaire_audio_output_dir_abs, exist_ok=True)
        print(f"FastAPI: Audio for this batch will be saved to: {questionnaire_audio_output_dir_abs}")

        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp_pdf:
            shutil.copyfileobj(pdf_file.file, tmp_pdf)
            temp_pdf_path = tmp_pdf.name
        
        print(f"FastAPI: PDF saved temporarily to {temp_pdf_path}")

        structured_data_from_llm = await pdf_processor_service.extract_questionnaire_from_pdf(
            pdf_path=temp_pdf_path,
            language_code=language # e.g., 'deu' for Tesseract, 'de' for LLM hint
        )

        if not structured_data_from_llm or not structured_data_from_llm.get("questions"):
            raise HTTPException(status_code=422, detail="LLM processing failed to return valid questionnaire structure.")

        # Override/set title and language from form data, as it's user-provided
        structured_data_from_llm["title"] = title
        structured_data_from_llm["language"] = language # Store the base language code 'de', 'en'
        structured_data_from_llm["originalPdfFilename"] = pdf_file.filename # Pass back for Next.js Prisma
        
        # Generate TTS for questions and add audio paths
        processed_questions_with_audio = []
        async with httpx.AsyncClient(timeout=600.0) as client: # Timeout for worker calls
            for idx, q_data_from_llm in enumerate(structured_data_from_llm["questions"]):
                text_to_speak = q_data_from_llm["text"]
                if q_data_from_llm.get("optionsText"):
                    text_to_speak += " " + q_data_from_llm["optionsText"]
                
                audio_web_path = None
                if text_to_speak and text_to_speak.strip():
                    try:
                        worker_payload = {
                            "text": text_to_speak,
                            "language": language,
                        }
                        # print(f"PDF Processor: Calling Worker TTS for: {text_to_speak[:30]}...")
                        
                        # Use files parameter for multipart/form-data if worker expects that,
                        # or data parameter if worker expects x-www-form-urlencoded
                        # Worker endpoint currently uses Form(), so send as data.
                        worker_response = await client.post(WORKER_TTS_URL, data=worker_payload)
                        worker_response.raise_for_status()
                        
                        audio_binary_content = await worker_response.aread() # Read binary content

                        if audio_binary_content:
                            # Save the binary content received from worker to Next.js public dir
                            # Use a unique ID from the LLM question or an index if not available
                            q_identifier = q_data_from_llm.get("id", f"q_idx_{idx}")
                            audio_filename = f"{q_identifier}_{language}_{uuid.uuid4().hex[:4]}.wav"
                            full_audio_fs_path_to_save = os.path.join(questionnaire_audio_output_dir_abs, audio_filename)
                            
                            with open(full_audio_fs_path_to_save, "wb") as f_audio_out:
                                f_audio_out.write(audio_binary_content)
                            
                            audio_web_path = f"/{AUDIO_CACHE_BASE_REL_PATH_IN_NEXTJS_PUBLIC}/{processing_batch_id}/{audio_filename}"
                            print(f"  PDF Processor: Saved audio from Worker to {full_audio_fs_path_to_save} (Web: {audio_web_path})")
                        else:
                            print(f"  PDF Processor: Worker returned empty audio content for Q {idx + 1}")

                    except Exception as e_tts:
                        print(f"PDF Processor: Error calling Worker TTS or saving audio for Q '{q_data_from_llm['text'][:20]}': {e_tts}")
                else:
                    print(f"PDF Processor: Skipping TTS for Q {idx+1} due to empty text.")


                q_data_from_llm["audioPath"] = audio_web_path # This is the web-accessible path Next.js will use
                processed_questions_with_audio.append(q_data_from_llm)

        structured_data_from_llm["questions"] = processed_questions_with_audio
        # This ID is for Next.js to know which subfolder in audio_cache contains these audios
        structured_data_from_llm["audioCacheId"] = processing_batch_id 

        return structured_data_from_llm

    except HTTPException as http_exc:
        raise http_exc # Re-raise FastAPI's own exceptions
    except Exception as e:
        print(f"FastAPI: General error during PDF processing: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")
    finally:
        if temp_pdf_path and os.path.exists(temp_pdf_path):
            os.remove(temp_pdf_path)
        if hasattr(pdf_file, 'file') and hasattr(pdf_file.file, 'close'):
             pdf_file.file.close()


app.include_router(processing_api_router)

# --- Main execution for development ---
if __name__ == "__main__":
    print("Starting FastAPI server (Backend Processor)...")
    # Ensure environment variables like OPENROUTER_API_KEY, NEXTJS_PUBLIC_DIR_PATH are set
    # For Poppler/Tesseract, ensure they are in PATH or configured in pdf_processor_service.py
    uvicorn.run("main:app", host="0.0.0.0", port=8000)