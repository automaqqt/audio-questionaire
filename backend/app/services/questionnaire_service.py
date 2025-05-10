import os
import json
import csv
import io
from typing import List, Dict, Any, Optional

from pydantic import BaseModel
from models.pymods import Questionnaire, Question, Answer # Your Pydantic models

# --- Pydantic models for service responses (can also be in models.py) ---
class QuestionnaireInfoResponse(BaseModel): # From pydantic
    message: str
    title: str
    description: str
    total_questions: int

class NextQuestionResponse(BaseModel):
    question_id: Optional[str] = None
    question_text: Optional[str] = None
    question_number: Optional[int] = None
    total_questions: Optional[int] = None
    audio_url: Optional[str] = None
    options_text: Optional[str] = None
    question_type: Optional[str] = None
    min_value: Optional[int] = None
    max_value: Optional[int] = None
    completed: bool = False
    message: Optional[str] = None # For completion message

class ConfirmAnswerResponse(BaseModel):
    message: str
    answer: Answer

# --- Service State ---
_current_questionnaire: Optional[Questionnaire] = None
_current_answers: List[Answer] = []
_current_question_index: int = -1
_QUESTIONNAIRES_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "questionnaires")
os.makedirs(_QUESTIONNAIRES_DIR, exist_ok=True)

def initialize_service():
    global _current_questionnaire, _current_answers, _current_question_index
    _current_questionnaire = None
    _current_answers = []
    _current_question_index = -1
    print("Questionnaire service initialized/reset.")

def load_questionnaire_from_file(file_name: str) -> QuestionnaireInfoResponse:
    global _current_questionnaire, _current_answers, _current_question_index
    questionnaire_path = os.path.join(_QUESTIONNAIRES_DIR, file_name)
    if not os.path.exists(questionnaire_path):
        raise FileNotFoundError(f"Questionnaire file '{file_name}' not found in '{_QUESTIONNAIRES_DIR}'.")
    try:
        with open(questionnaire_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            _current_questionnaire = Questionnaire(**data)
        _current_answers = []
        _current_question_index = -1 # Reset index
        return QuestionnaireInfoResponse(
            message="Questionnaire loaded successfully.",
            title=_current_questionnaire.title,
            description=_current_questionnaire.description,
            total_questions=len(_current_questionnaire.questions)
        )
    except json.JSONDecodeError:
        raise ValueError("Invalid JSON format in questionnaire file.")
    except Exception as e: # Catches Pydantic validation errors too
        raise ValueError(f"Error parsing questionnaire data: {e}")

def is_questionnaire_loaded() -> bool:
    return _current_questionnaire is not None

def get_next_question_details() -> Dict[str, Any]:
    global _current_question_index
    if not _current_questionnaire:
        return {"completed": True, "message": "No questionnaire loaded."} # Should be caught earlier

    _current_question_index += 1
    if _current_question_index < len(_current_questionnaire.questions):
        question_model = _current_questionnaire.questions[_current_question_index]
        return question_model.dict() # Return as dict
    else:
        return {"completed": True, "message": "Questionnaire complete."}

def get_current_question_details_for_answer() -> Optional[Question]: # Returns Pydantic model
     if _current_questionnaire and 0 <= _current_question_index < len(_current_questionnaire.questions):
         return _current_questionnaire.questions[_current_question_index]
     return None

def get_current_question_number() -> int:
    return _current_question_index + 1 if _current_questionnaire else 0
    
def get_total_questions() -> int:
    return len(_current_questionnaire.questions) if _current_questionnaire else 0

def store_confirmed_answer(answer_payload: Answer) -> Answer:
    # Basic validation: does the answer correspond to the current question?
    current_q_details = get_current_question_details_for_answer()
    if not current_q_details or current_q_details.id != answer_payload.question_id:
        # This might be too strict if we allow retrying previous questions,
        # but for simple linear flow, it's a good check.
        raise ValueError("Confirmed answer does not match the current active question.")
    
    answer_payload.is_confirmed = True # Ensure it's marked confirmed
    
    # Check if an answer for this question_id already exists and replace it, or append.
    # This handles cases where a user might "try again" and re-confirm.
    found_existing = False
    for i, ans in enumerate(_current_answers):
        if ans.question_id == answer_payload.question_id:
            _current_answers[i] = answer_payload
            found_existing = True
            break
    if not found_existing:
        _current_answers.append(answer_payload)
    return answer_payload

def has_answers() -> bool:
    return bool(_current_answers)

def get_results_as_csv_string() -> str:
    if not _current_answers:
        return ""
    output = io.StringIO()
    # Ensure fieldnames match the Answer Pydantic model attributes you want in CSV
    fieldnames = ["question_id", "question_text", "transcribed_response", "parsed_value", "is_confirmed"]
    writer = csv.DictWriter(output, fieldnames=fieldnames, extrasaction='ignore')
    writer.writeheader()
    for ans in _current_answers:
        if ans.is_confirmed: # Only export confirmed answers
            writer.writerow(ans.dict(include=set(fieldnames)))
    return output.getvalue()

def reset_questionnaire_state():
    initialize_service()