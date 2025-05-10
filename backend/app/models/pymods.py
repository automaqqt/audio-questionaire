from pydantic import BaseModel, Field
from typing import List, Optional, Any, Dict

class Question(BaseModel):
    id: str = Field(..., description="Unique identifier for the question, e.g., Q1, Q2.")
    text: str = Field(..., description="The exact text of the question.")
    type: str = Field(..., description="Type of question, e.g., 'scale', 'boolean_custom_map'.")
    min_value: Optional[int] = Field(None, description="Minimum numerical value for a 'scale' type question.")
    max_value: Optional[int] = Field(None, description="Maximum numerical value for a 'scale' type question.")
    options_text: Optional[str] = Field(None, description="User-friendly text explaining response options, especially for audio presentation.")
    
    # For 'boolean_custom_map' or similar types needing specific spoken word mappings
    true_value_spoken: Optional[List[str]] = Field(None, description="List of spoken words that map to the true/positive numeric value.")
    true_value_numeric: Optional[Any] = Field(None, description="The numeric value to store if a true_value_spoken is detected.")
    false_value_spoken: Optional[List[str]] = Field(None, description="List of spoken words that map to the false/negative numeric value.")
    false_value_numeric: Optional[Any] = Field(None, description="The numeric value to store if a false_value_spoken is detected.")

    # You could add other fields here if needed, e.g.:
    # scale_labels: Optional[Dict[int, str]] = Field(None, description="Mapping of numeric scale values to their text labels, e.g., {1: 'Nie', 5: 'Immer'}")


class Questionnaire(BaseModel):
    title: str = Field(..., description="The main title of the questionnaire.")
    description: str = Field(..., description="A brief description or introductory text for the questionnaire.")
    questions: List[Question] = Field(..., description="A list of questions in the questionnaire.")

    # Optional: metadata for the questionnaire itself
    # version: Optional[str] = None
    # language: Optional[str] = Field("en", description="Default language code, e.g., 'en', 'de'")


class Answer(BaseModel):
    question_id: str = Field(..., description="ID of the question being answered.")
    question_text: str = Field(..., description="The text of the question (for context in results).")
    transcribed_response: str = Field(..., description="The full text transcribed from the user's spoken response.")
    parsed_value: Optional[Any] = Field(None, description="The extracted and parsed value (e.g., integer for scale, specific value for boolean).")
    is_confirmed: bool = Field(False, description="Flag indicating if the user has confirmed this parsed value.")
    # Optional: timestamp of when the answer was recorded/confirmed
    # timestamp: Optional[datetime] = Field(default_factory=datetime.utcnow)


# --- API Specific Models (used for request/response typing in main.py) ---

class TranscribedResponse(BaseModel):
    """Response model after STT and initial parsing, before user confirmation."""
    transcription: str
    parsed_value: Optional[Any] = None
    value_found: bool = False
    error_message: Optional[str] = None


# --- Service Specific Response Models (as defined in questionnaire_service.py) ---
# You can keep them in questionnaire_service.py or centralize them here.
# For clarity, I'll mirror what was in questionnaire_service.py, assuming they are used by API routes directly.

class QuestionnaireInfoResponse(BaseModel):
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
    answer: Answer # The confirmed Answer object

# Body model for loading questionnaire (if you prefer a structured body over just string)
class LoadQuestionnairePayload(BaseModel):
    file_name: str = Field("example_questionnaire.json", description="Name of the questionnaire JSON file to load.")