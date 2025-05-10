import os
import json
import requests
import pytesseract # For OCR
from pdf2image import convert_from_path 
from PIL import Image # To handle images
import cv2 # For OpenCV image processing
import numpy as np # For OpenCV array manipulation

# --- Configuration ---
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "") # Load from environment
OPENROUTER_MODEL = "google/gemini-2.5-flash-preview"

# --- Tesseract Configuration (Optional - usually needed on Windows if not in PATH) ---
# If Tesseract is not in your PATH, uncomment and set the path:
# For Windows:
# pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
# For Linux/macOS, usually Tesseract is found if installed correctly.

# --- Poppler Configuration (Optional - needed by pdf2image on Windows if not in PATH) ---
# For Windows, if Poppler is not in PATH:
# POPPLER_PATH = r"C:\path\to\poppler-xx.xx.x\bin" # Replace with your actual Poppler bin path
POPPLER_PATH = None # Set to your Poppler path if needed, e.g., r"C:\poppler-23.11.0\Library\bin"


def preprocess_image_for_ocr(pil_image: Image.Image) -> Image.Image:
    """
    Preprocesses a PIL image for better OCR results using OpenCV.
    """
    try:
        # Convert PIL Image to OpenCV format
        open_cv_image = np.array(pil_image)
        # Convert RGB to BGR if it's a color image (OpenCV default color order)
        if len(open_cv_image.shape) == 3 and open_cv_image.shape[2] == 3: # Check if it's RGB
            open_cv_image = cv2.cvtColor(open_cv_image, cv2.COLOR_RGB2BGR)
        elif len(open_cv_image.shape) == 3 and open_cv_image.shape[2] == 4: # Check if it's RGBA
            open_cv_image = cv2.cvtColor(open_cv_image, cv2.COLOR_RGBA2BGR)


        # 1. Grayscale
        gray = cv2.cvtColor(open_cv_image, cv2.COLOR_BGR2GRAY)

        # 2. Binarization (Thresholding)
        # Otsu's binarization is good for automatically finding an optimal global threshold.
        # For some documents, adaptive thresholding might be better if illumination varies.
        # _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        # Let's use adaptive thresholding, often good for scanned docs with varying lighting.
        thresh = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                       cv2.THRESH_BINARY, 11, 2) # Block size 11, C=2. Tune these.

        # Optional: Denoising (can be useful, but also might blur small text)
        # thresh = cv2.medianBlur(thresh, 3) # Kernel size 3

        # Optional: Deskewing (more complex, not implemented here but can be important)

        # Convert back to PIL Image from the OpenCV processed image (which is 'thresh')
        return Image.fromarray(thresh)
    except Exception as e:
        print(f"Error during image preprocessing: {e}")
        return pil_image # Return original image if preprocessing fails


def perform_ocr_on_pdf(pdf_path: str, language: str = 'deu', tesseract_psm: str = '3') -> str:
    """
    Performs OCR on a PDF file and returns the extracted text,
    with image preprocessing and selectable Tesseract PSM.
    """
    full_text = ""
    try:
        print(f"Converting PDF '{pdf_path}' to images (DPI 300)...")
        if POPPLER_PATH:
            images = convert_from_path(pdf_path, poppler_path=POPPLER_PATH, dpi=300)
        else:
            images = convert_from_path(pdf_path, dpi=300) # Using 300 DPI

        if not images:
            print("No images extracted from PDF.")
            return ""

        print(f"Found {len(images)} pages. Performing OCR with PSM {tesseract_psm}...")
        for i, image in enumerate(images):
            print(f"Processing page {i+1}/{len(images)}...")

            print("  Preprocessing image...")
            preprocessed_image = preprocess_image_for_ocr(image)

            # Optional: Save preprocessed image for inspection
            # preprocessed_image.save(f"temp_preprocessed_page_{i+1}.png")
            # print(f"  Saved temp_preprocessed_page_{i+1}.png for inspection.")

            print(f"  Running Tesseract (lang: {language}, psm: {tesseract_psm})...")
            # OEM 3 is the default LSTM engine, which is generally good.
            custom_config = f'--oem 3 --psm {tesseract_psm}'
            page_text = pytesseract.image_to_string(preprocessed_image, lang=language, config=custom_config)
            full_text += page_text + "\n\n--- Page Break ---\n\n"
        print("OCR completed.")
        return full_text
    except pytesseract.TesseractNotFoundError:
        print("Tesseract Error: Tesseract is not installed or not found in your PATH.")
        print("Please ensure Tesseract OCR is installed and pytesseract.tesseract_cmd is configured if needed (especially on Windows).")
        return ""
    except Exception as e:
        print(f"An unexpected error occurred during OCR processing: {e}")
        # Print more details if it's a Tesseract error
        if "Tesseract" in str(e):
             print("This might be due to missing language data for Tesseract (e.g., 'deu') or an issue with the Tesseract installation.")
        return ""


def ocr_text_to_questionnaire_json(ocr_text: str) -> str:
    global OPENROUTER_API_KEY

    if not ocr_text or ocr_text.strip() == "" or "--- Page Break ---" in ocr_text and len(ocr_text.replace("--- Page Break ---", "").strip()) == 0 :
        print("OCR text is empty or contains only page breaks. Cannot proceed with LLM.")
        return None

    if not OPENROUTER_API_KEY:
        OPENROUTER_API_KEY = input("Please input your OpenRouter API key: ")
        if not OPENROUTER_API_KEY:
            print("OpenRouter API key is required.")
            return None

    json_format_description = """
    {
      "title": "String - The main title of the questionnaire",
      "description": "String - A brief description or introductory text for the questionnaire.",
      "questions": [
        {
          "id": "String - A unique identifier, e.g., Q1, Q2, Q_Gesundheit",
          "text": "String - The exact text of the question",
          "type": "String - Typically 'scale' for these types of questions. Could also be 'boolean_custom_map' if applicable.",
          "min_value": "Integer - The minimum numerical value for the scale (e.g., 1)",
          "max_value": "Integer - The maximum numerical value for the scale (e.g., 5)",
          "options_text": "String - A user-friendly text explaining the scale for audio presentation. Example: 'Bitte antworte mit einer Zahl zwischen 1 und 5, wobei 1 [Bedeutung von 1] und 5 [Bedeutung von 5] bedeutet.' Ensure this text clearly maps the verbal anchors to the numbers."
          // For boolean_custom_map, you might include:
          // "true_value_spoken": ["yes", "ja"],
          // "true_value_numeric": 1,
          // "false_value_spoken": ["no", "nein"],
          // "false_value_numeric": 0
        }
      ]
    }
    """

    prompt = f"""
    You are an expert assistant tasked with converting OCR text from a psychological questionnaire into a structured JSON format.
    The target JSON structure is:
    {json_format_description}

    The OCR process might introduce errors or misinterpret table structures from the PDF. Please do your best to identify distinct questions and their associated scales, even if the text is not perfectly formatted or contains OCR artifacts.
    Pay close attention to repeated scale labels (e.g., "nie", "selten", "manchmal", "oft", "immer" OR "überhaupt nicht", "ein wenig", "mittelmäßig", "ziemlich", "sehr") which often indicate the options for a group of questions. Sometimes the scale labels are at the top of a column of checkboxes or options.

    Please analyze the following OCR text from a questionnaire.
    Identify the overall title, a suitable description (often the introductory text), and each individual question with its scale.
    For each question:
    1. Create a unique `id`.
    2. Extract the question `text`. Try to reconstruct it cleanly if OCR split it or added noise.
    3. Set `type` to "scale".
    4. Determine the `min_value` (usually 1) and `max_value` (e.g., 5 if there are 5 options) for the scale. Infer this from the number of distinct scale labels provided for a set of questions.
    5. For the `options_text`, create a clear instruction for an audio-based response. It should map the scale labels to the numerical range. For example: "Bitte antworte mit einer Zahl zwischen 1 und 5. 1 bedeutet [erste Option], 2 bedeutet [zweite Option], ..., und 5 bedeutet [letzte Option]." Ensure the wording matches the scale labels found in the OCR text.
    6. Ensure all text, especially `question_text` and `options_text`, is in the original language of the questionnaire (German in this case).
    7. Pay close attention to the different scales used for different sets of questions. Each question object must reflect its specific scale in `min_value`, `max_value`, and `options_text`.
    8. If the OCR text contains page breaks (e.g., "--- Page Break ---") or irrelevant headers/footers from the OCR process, please ignore them when parsing the questionnaire content. Focus on the questionnaire items themselves.
    9. Handle cases where questions might be numbered (e.g., "1. Question text", "2. Another question").
    10. The title might be at the very beginning of the text. The description might be an introductory paragraph before the first question.

    Here is the OCR text:
    --- OCR START ---
    {ocr_text}
    --- OCR END ---

    Provide ONLY the JSON object as your response, without any surrounding text or explanations.
    The JSON should be well-formed and adhere strictly to the structure provided.
    """

    try:
        response = requests.post(
            url="https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            },
            data=json.dumps({
                "model": OPENROUTER_MODEL,
                "messages": [
                    {"role": "system", "content": "You are an expert assistant specialized in converting OCR text from questionnaires into structured JSON."},
                    {"role": "user", "content": prompt}
                ],
                "response_format": {"type": "json_object"}
            })
        )
        response.raise_for_status()

        completion = response.json()
        json_output_str = completion['choices'][0]['message']['content']

        if json_output_str.strip().startswith("```json"):
            json_output_str = json_output_str.strip()[7:-3].strip()
        elif json_output_str.strip().startswith("```"):
             json_output_str = json_output_str.strip()[3:-3].strip()

        parsed_json = json.loads(json_output_str)
        return json.dumps(parsed_json, indent=2, ensure_ascii=False)

    except requests.exceptions.RequestException as e:
        print(f"API Request failed: {e}")
        if hasattr(e, 'response') and e.response is not None:
            print(f"Response status: {e.response.status_code}")
            print(f"Response content: {e.response.text}")
        return None
    except json.JSONDecodeError as e:
        print(f"Failed to decode JSON from LLM response: {e}")
        print(f"LLM raw response was: {json_output_str}")
        return None
    except Exception as e:
        print(f"An unexpected error occurred: {e}")
        return None


if __name__ == "__main__":
    # --- Configuration for PDF processing ---
    # Replace this with the actual path to your PDF file
    pdf_file_path = "pdf_input/kidscreen10_example.pdf" # <<<< IMPORTANT: Create or specify your PDF here
    # Tesseract Page Segmentation Modes (PSM):
    # 0: Orientation and script detection (OSD) only.
    # 1: Automatic page segmentation with OSD.
    # 2: Automatic page segmentation, but no OSD, or OCR.
    # 3: Fully automatic page segmentation, but no OSD. (Default)
    # 4: Assume a single column of text of variable sizes.
    # 5: Assume a single uniform block of vertically aligned text.
    # 6: Assume a single uniform block of text. (Often good for blocks like questionnaires)
    # 7: Treat the image as a single text line.
    # 8: Treat the image as a single word.
    # 9: Treat the image as a single word in a circle.
    # 10: Treat the image as a single character.
    # 11: Sparse text. Find as much text as possible in no particular order.
    # 12: Sparse text with OSD.
    # 13: Raw line. Treat the image as a single text line, bypassing Tesseract-specific processing.
    tesseract_page_segmentation_mode = '11' # Experiment with '3', '4', '6', '11'

    # Language for OCR (e.g., 'deu' for German, 'eng' for English)
    ocr_language = 'deu'

    # --- End of Configuration ---


    # Check if the example PDF exists
    if not os.path.exists(pdf_file_path):
        print(f"PDF file '{pdf_file_path}' not found at the specified path.")
        print("Please ensure the PDF file exists or update the 'pdf_file_path' variable.")
        print("Exiting script as PDF is required for this workflow.")
        full_ocr_text = None # No fallback to hardcoded text to enforce PDF workflow
    else:
        print(f"Attempting OCR on PDF: '{pdf_file_path}'")
        print(f"Using Language: '{ocr_language}', Tesseract PSM: '{tesseract_page_segmentation_mode}'")

        full_ocr_text = perform_ocr_on_pdf(
            pdf_file_path,
            language=ocr_language,
            tesseract_psm=tesseract_page_segmentation_mode
        )

        if full_ocr_text and full_ocr_text.strip():
            print("\n--- Preview of Extracted OCR Text (first 1000 chars) ---")
            # Clean up excessive newlines for preview
            preview_text = '\n'.join(line for line in full_ocr_text.splitlines() if line.strip())
            print(preview_text[:1000] + "..." if len(preview_text) > 1000 else preview_text)
            print("--- End of OCR Text Preview ---")
        elif full_ocr_text is None: # perform_ocr_on_pdf returned None due to an error
             print("OCR process failed due to an error. Check messages above.")
        else: # OCR process returned empty string
            print("OCR process completed but yielded no text. This might be due to:")
            print("  - A blank or image-only PDF page (with no actual text).")
            print("  - Very poor scan quality making text unreadable.")
            print("  - Incorrect Tesseract language data or configuration.")
            print("  - Issues with image preprocessing for this specific document.")
            print("Consider inspecting the 'temp_preprocessed_page_X.png' files (if enabled) to see what Tesseract processed.")


    if full_ocr_text and full_ocr_text.strip():
        print("\nAttempting to convert OCR text to JSON using LLM...")
        questionnaire_json_str = ocr_text_to_questionnaire_json(full_ocr_text)

        if questionnaire_json_str:
            print("\nSuccessfully generated Questionnaire JSON:")
            print(questionnaire_json_str)

            output_filename = f"extracted_questionnaire_psm{tesseract_page_segmentation_mode}.json"
            with open(output_filename, "w", encoding="utf-8") as f:
                f.write(questionnaire_json_str)
            print(f"\nSaved to {output_filename}")
        else:
            print("\nFailed to generate questionnaire JSON from LLM.")
    elif full_ocr_text is None:
        print("\nSkipping LLM call as OCR process failed.")
    else:
        print("\nSkipping LLM call as OCR text was empty.")