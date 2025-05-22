import base64
import os
import json
from dotenv import load_dotenv
import requests
import sys # For stderr
from typing import Dict, Optional, Any

# Import OCR specific libraries (ensure they are in your FastAPI backend's environment)
import pytesseract
from pdf2image import convert_from_path
from PIL import Image
import cv2
import numpy as np

load_dotenv()

# --- Configuration ---
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "google/gemini-2.5-flash-preview")

# Tesseract Configuration
# pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe' # If needed on Windows

# Poppler Configuration
POPPLER_PATH = os.getenv("POPPLER_PATH") # e.g., r"C:\poppler-23.11.0\Library\bin"

def initialize_processor():
    """Initialize any resources for the processor, e.g., check Tesseract/Poppler."""
    print("PDF Processor Service: Initializing...")
    if not OPENROUTER_API_KEY:
        print("WARNING: OPENROUTER_API_KEY is not set. LLM processing will fail.", file=sys.stderr)
    # Add checks for Tesseract/Poppler if desired
    print("PDF Processor Service: Initialized.")


def _preprocess_image_for_ocr(pil_image: Image.Image) -> Image.Image:
    """Preprocesses a PIL image for better OCR results using OpenCV."""
    try:
        open_cv_image = np.array(pil_image)
        # Ensure it's BGR for OpenCV
        if len(open_cv_image.shape) == 3 and open_cv_image.shape[2] == 4: # RGBA
            open_cv_image = cv2.cvtColor(open_cv_image, cv2.COLOR_RGBA2BGR)
        elif len(open_cv_image.shape) == 3 and open_cv_image.shape[2] == 3 and pil_image.mode == 'RGB': # RGB
             open_cv_image = cv2.cvtColor(open_cv_image, cv2.COLOR_RGB2BGR)


        if len(open_cv_image.shape) == 2: # Is grayscale
            gray = open_cv_image
        elif len(open_cv_image.shape) == 3 : # Is color
            gray = cv2.cvtColor(open_cv_image, cv2.COLOR_BGR2GRAY)
        else:
            print("Unsupported image format for grayscale conversion, returning original.", file=sys.stderr)
            return pil_image

        thresh = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                       cv2.THRESH_BINARY, 11, 2) # Block size 11, C=2
        return Image.fromarray(thresh)
    except Exception as e:
        print(f"Error during image preprocessing: {e}", file=sys.stderr)
        return pil_image


async def _perform_ocr_on_pdf_internal(pdf_path: str, language_tesseract: str = 'deu', tesseract_psm: str = '11') -> str:
    """Internal OCR logic, adapted from extract.py."""
    full_text = ""
    # print(f"PDF Processor: Converting PDF '{pdf_path}' (lang: {language_tesseract}, psm: {tesseract_psm})", file=sys.stderr)
    try:
        if POPPLER_PATH:
            images = convert_from_path(pdf_path, poppler_path=POPPLER_PATH, dpi=300)
        else:
            images = convert_from_path(pdf_path, dpi=300)

        if not images:
            print("PDF Processor: No images extracted from PDF.", file=sys.stderr)
            return ""

        for i, image in enumerate(images):
            # print(f"PDF Processor: OCR Page {i+1}/{len(images)}", file=sys.stderr)
            preprocessed_image = _preprocess_image_for_ocr(image)
            custom_config = f'--oem 3 --psm {tesseract_psm}' # LSTM engine, specified PSM
            page_text = pytesseract.image_to_string(preprocessed_image, lang=language_tesseract, config=custom_config)
            full_text += page_text + "\n\n--- Page Break ---\n\n" # Keep page break for LLM
        # print("PDF Processor: OCR completed.", file=sys.stderr)
        return full_text
    except pytesseract.TesseractNotFoundError:
        print("PDF Processor Error: Tesseract not installed or not in PATH.", file=sys.stderr)
        raise RuntimeError("Tesseract OCR is not available on the server.")
    except Exception as e:
        print(f"PDF Processor: Error during OCR: {e}", file=sys.stderr)
        raise RuntimeError(f"OCR processing failed: {str(e)}")

def encode_pdf_to_base64(pdf_path):
    with open(pdf_path, "rb") as pdf_file:
        return base64.b64encode(pdf_file.read()).decode('utf-8')
    
async def _llm_extract_questionnaire_structure(pdf_path: str, language_hint: str) -> Optional[Dict[str, Any]]:
    """Internal LLM logic, adapted from extract.py."""
    if not OPENROUTER_API_KEY:
        print("PDF Processor Error: OPENROUTER_API_KEY not set.", file=sys.stderr)
        raise RuntimeError("LLM service API key is not configured.")
    

    json_format_description = """
    {
      "title": "String - The main title of the questionnaire.",
      "description": "String - A brief description or introductory text.",
      "questions": [
        {
          "id": "String - A unique identifier FOR THIS QUESTION (e.g., Q1, Q_Energy). If no clear ID, generate one like item_1, item_2.",
          "text": "String - The exact text of the question.",
          "type": "String - Typically 'scale'. Other types could be 'boolean_custom_map', 'multiple_choice', 'text_input'. Infer from context.",
          "minValue": "Integer - The minimum numerical value for a 'scale' (e.g., 1). If not a number scale, null.",
          "maxValue": "Integer - The maximum numerical value for a 'scale' (e.g., 5). If not a number scale, null.",
          "optionsText": "String - User-friendly text explaining scale options for AUDIO. E.g., 'Antworte mit 1 für Nie, bis 5 für Immer.' Should list all options if not too many, or describe the range clearly. Example for a 1-5 scale: 'Bitte antworte mit einer Zahl zwischen 1 und 5, wobei 1 [Bedeutung von 1], 2 [Bedeutung von 2], 3 [Bedeutung von 3], 4 [Bedeutung von 4] und 5 [Bedeutung von 5] bedeutet.'",
          "visualOptions": [ {"value": "1", "label": "Nie"}, {"value": "2", "label": "Selten"} ]
        }
      ]
    }
    """
    prompt = f"""
    You are an expert AI assistant. Convert the following OCR text from a psychological questionnaire in {language_hint} into a structured JSON object.
    Adhere strictly to this target JSON structure:
    {json_format_description}

    Key Instructions:
    1.  **Question `id`**: Generate a short, unique string ID for each question (e.g., "Q1", "energy_level").
    2.  **`text`**: Extract the precise question wording.
    3.  **`type`**: Infer the question type (e.g., "scale", "multiple_choice"). Default to "scale" if unsure but options are present.
    4.  **`minValue`, `maxValue`**: For "scale" types with numerical answers, determine the range (e.g., 1 to 5).
    5.  **`optionsText` (Crucial for Audio)**: Create a concise, spoken instruction for the audio app. It MUST map the text labels of the scale (e.g., "Nie", "Selten", "Immer" or "Überhaupt nicht", "Sehr") to numbers. For a 1-5 scale where 1 is 'Nie' and 5 is 'Immer', an example is: "Antworte mit einer Zahl von 1 bis 5. 1 bedeutet Nie, 2 Selten, 3 Manchmal, 4 Oft, und 5 Immer." If there are more than 5-6 options, describe the range endpoints clearly, e.g., "1 bedeutet 'stimme überhaupt nicht zu' und 7 bedeutet 'stimme voll und ganz zu'."
    6.  **`visualOptions`**: If the questionnaire has explicit text labels for each choice (like radio buttons or checkboxes), list them as an array of `{{value: "numeric_value_as_string", label: "Text Label"}}`. Example: `[{{"value": "1", "label": "Nie"}}, {{"value": "5", "label": "Immer"}}]`. The `value` should correspond to what would be stored.
    7.  **Language**: All extracted text in `title`, `description`, `questions.text`, `questions.optionsText`, and `questions.visualOptions.label` MUST be in the original questionnaire language ({language_hint}).
    8.  **Structure**: Identify the main questionnaire `title` and `description` (often introductory text).
    9.  **Scales**: Carefully identify scale labels. They might appear once above a group of questions. Apply the correct scale to all relevant questions.
    10. **Clean OCR**: Ignore OCR artifacts, page numbers, or irrelevant headers/footers.

    OCR Text to process "document.pdf"!

    Provide ONLY the JSON object as your response. Ensure it's well-formed.
    """

    base64_pdf = encode_pdf_to_base64(pdf_path)
    data_url = f"data:application/pdf;base64,{base64_pdf}"

    try:
        # print(f"PDF Processor: Sending text to LLM (model: {OPENROUTER_MODEL})...", file=sys.stderr)
        response = requests.post(
            url="https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "Content-Type": "application/json"
            },
            data=json.dumps({
                "model": OPENROUTER_MODEL,
                "messages": [
                    {"role": "system", "content": f"You are an expert AI assistant for parsing questionnaires in {language_hint} into JSON."},
                    {"role": "user", "content": [
                    {
                        "type": "text",
                        "text": prompt
                    },
                    {
                        "type": "file",
                        "file": {
                            "filename": "document.pdf",
                            "file_data": data_url
                        }
                    }]}
                ],
                "plugins":[
                    {
                        "id": "file-parser",
                        "pdf": {
                            "engine": "native"  # defaults to "mistral-ocr". See Pricing below
                        }
                    }
                ],
                "response_format": {"type": "json_object"} # Request JSON output
            })
        )
        response.raise_for_status()
        completion = response.json()
        json_output_str = completion['choices'][0]['message']['content']

        # Cleanup potential markdown ```json ... ```
        if json_output_str.strip().startswith("```json"):
            json_output_str = json_output_str.strip()[7:-3].strip()
        elif json_output_str.strip().startswith("```"):
            json_output_str = json_output_str.strip()[3:-3].strip()
        
        # print("PDF Processor: LLM response received.", file=sys.stderr)
        return json.loads(json_output_str) # Return Python dict
    except requests.exceptions.RequestException as e:
        err_content = e.response.text if hasattr(e, 'response') and e.response else "No response content"
        print(f"PDF Processor: LLM API Request failed: {e}. Response: {err_content}", file=sys.stderr)
        raise RuntimeError(f"LLM API request failed: {str(e)}")
    except json.JSONDecodeError as e:
        print(f"PDF Processor: Failed to decode JSON from LLM: {e}. Response was: {json_output_str}", file=sys.stderr)
        raise RuntimeError("LLM returned invalid JSON.")
    except Exception as e:
        print(f"PDF Processor: Unexpected error during LLM call: {e}", file=sys.stderr)
        raise RuntimeError(f"LLM processing error: {str(e)}")


async def extract_questionnaire_from_pdf(pdf_path: str, language_code: str) -> Dict[str, Any]:
    """
    Orchestrates PDF to structured questionnaire JSON conversion.
    language_code: base language like 'de', 'en'. Tesseract might need 'deu', 'eng'.
    """
    tesseract_lang = language_code # Tesseract often uses 3-letter codes, but 'deu'/'eng' from 'de'/'en' is common
    if language_code == 'de': tesseract_lang = 'deu'
    if language_code == 'en': tesseract_lang = 'eng'
    # Add more mappings if needed

    print(f"PDF Processor: Starting extraction for PDF '{pdf_path}', language '{language_code}' (Tesseract lang: '{tesseract_lang}')")
    
    #ocr_text = await _perform_ocr_on_pdf_internal(pdf_path, language_tesseract=tesseract_lang)
    #if not ocr_text or not ocr_text.strip():
     #   raise ValueError("OCR process yielded no usable text from the PDF.")

    structured_data = await _llm_extract_questionnaire_structure(pdf_path, language_hint=language_code)
    if not structured_data:
        raise ValueError("LLM failed to extract structured data from OCR text.")
    
    print(f"PDF Processor: Successfully extracted structure for '{structured_data.get('title', 'Untitled')}'")
    return structured_data