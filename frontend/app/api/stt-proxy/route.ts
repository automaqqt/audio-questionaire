import { NextRequest, NextResponse } from 'next/server';
interface Question {
    type: string;
    min_value?: number;
    max_value?: number;
    true_value_spoken?: string[];
    false_value_spoken?: string[];
    true_value_numeric?: any;
    false_value_numeric?: any;
}

const WORKER_MICROSERVICE_URL = process.env.WORKER_MICROSERVICE_URL || 'http://localhost:8087'; // e.g., http://localhost:8001

// Define a minimal Question interface for context, based on its usage in the function.
interface Question {
    type: "scale" | "boolean_custom_map" | string; // Add other potential question types
    min_value?: number;
    max_value?: number;
    true_value_spoken?: string[];
    true_value_numeric?: any;
    false_value_spoken?: string[];
    false_value_numeric?: any;
}

// Helper function to escape special characters for use in a regular expression
function escapeRegExp(string: string): string {
    // $& means the whole matched string
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseValueFromTranscription(
    text: string,
    question: Question,
    optionsIn: string   // MODIFIED: Changed from [] to string[] for clarity and usability
): { parsed_value: any | null; value_found: boolean; error_message: string | null } {
    if (!text.trim()) {
        return { parsed_value: null, value_found: false, error_message: "Empty transcription." };
    }

    let processedText = text.toLowerCase();

    // Optional: words-to-numbers (remains commented out as in original)
    // try {
    //    const numText = wordsToNumbers(processedText);
    //    if (typeof numText === 'string' || typeof numText === 'number') {
    //        processedText = String(numText);
    //    }
    // } catch (e) {
    //    console.warn("words-to-numbers failed:", e);
    // }
    
    // ADDED: Logic to check for presence of words from options list.
    // This block is placed where the user had an empty `if (options) {}`.
    // It checks if `options` is not null/undefined and has items.
    //console.log(JSON.parse(optionsIn))
    const options = JSON.parse(optionsIn).map((option: { label: any; }) => {return option.label})
    //console.log(options)
    if (options && options.length > 0) {
        for (const option of options) {
            // Ensure option is a string (primarily for type safety if options array could be `any[]`)
            if (typeof option === 'string') {
                const lowerOption = option.toLowerCase(); // Convert option to lowercase for case-insensitive matching
                const escapedOption = escapeRegExp(lowerOption); // Escape regex special characters in the option

                // Create a RegExp to find the option as a whole word.
                // `\b` ensures word boundaries.
                // `processedText` is already lowercase.
                if (new RegExp(`\\b${escapedOption}\\b`).test(processedText)) {
                    // If a match is found, return the original option string (preserving its case)
                    // as `parsed_value`.
                    return { parsed_value: option, value_found: true, error_message: null };
                }
            }
        }
        // If options were provided, but none of them were found in `processedText`,
        // this function will continue to the next parsing steps (replacements, type-specific parsing).
        // An alternative behavior could be to return an error here if options are provided but none match:
        // return { parsed_value: null, value_found: false, error_message: "Response did not match any of the provided options." };
        // However, the request "simple return statement that checks for presence" implies an early exit if found, otherwise continue.
    }

    // Hardcoded replacements (German/English number words to digits)
    const replacements: Record<string, string> = {
        "eins": "1", "zwei": "2", "drei": "3", "vier": "4", "fünf": "5",
        "sechs": "6", "sieben": "7", "acht": "8", "neun": "9", "null": "0",
        "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
        "six": "6", "seven": "7", "eight": "8", "nine": "9", "zero": "0",
    };

    for (const [word, digit] of Object.entries(replacements)) {
        // MODIFIED: 'i' flag in RegExp is removed as `processedText` and `word` (keys) are already lowercase.
        // 'g' flag ensures all occurrences are replaced.
        processedText = processedText.replace(new RegExp(`\\b${word}\\b`, 'g'), digit);
    }

    if (question.type === "scale") {
        const numbers = processedText.match(/-?\d+/g); // Find all numbers (positive or negative)
        if (numbers && numbers.length > 0) {
            // Iterate from the end to prioritize the last mentioned number
            for (let i = numbers.length - 1; i >= 0; i--) {
                const val = parseInt(numbers[i]);
                if (question.min_value !== undefined && question.max_value !== undefined) {
                    if (val >= question.min_value && val <= question.max_value) {
                        return { parsed_value: val, value_found: true, error_message: null };
                    }
                } else {
                    // If min_value/max_value are not defined for the question, accept any number.
                    return { parsed_value: val, value_found: true, error_message: null };
                }
            }
            // If numbers were found, but none were in the valid range (if range is defined).
            const rangeMsg = (question.min_value !== undefined && question.max_value !== undefined)
                ? `Number found, but not in range [${question.min_value}-${question.max_value}].`
                // This part of the ternary below is likely unreachable if numbers are found,
                // due to the `else` clause in the loop above which would have returned.
                : "Number found, but question scale range is not defined."; 
            return { parsed_value: null, value_found: false, error_message: rangeMsg };
        }
        return { parsed_value: null, value_found: false, error_message: "No number found in response." };
    } else if (question.type === "boolean_custom_map") {
        if (question.true_value_spoken) {
            for (const trueWord of question.true_value_spoken) {
                // ADDED: type check, lowercase conversion, and regex escaping for robustness
                if (typeof trueWord === 'string') { 
                    const escapedTrueWord = escapeRegExp(trueWord.toLowerCase());
                    if (new RegExp(`\\b${escapedTrueWord}\\b`).test(processedText)) {
                        return { parsed_value: question.true_value_numeric, value_found: true, error_message: null };
                    }
                }
            }
        }
        if (question.false_value_spoken) {
            for (const falseWord of question.false_value_spoken) {
                // ADDED: type check, lowercase conversion, and regex escaping for robustness
                if (typeof falseWord === 'string') { 
                    const escapedFalseWord = escapeRegExp(falseWord.toLowerCase());
                    if (new RegExp(`\\b${escapedFalseWord}\\b`).test(processedText)) {
                        return { parsed_value: question.false_value_numeric, value_found: true, error_message: null };
                    }
                }
            }
        }
        return { parsed_value: null, value_found: false, error_message: "Could not understand 'yes' or 'no' equivalent." };
    }

    // Fallback if no parsing rule matched or question type is unsupported
    return { parsed_value: null, value_found: false, error_message: "Unsupported question type for parsing." };
}

export async function POST(req: NextRequest) {
  try {
    const clientFormData = await req.formData(); // Audio blob from client (Next.js Frontend)
    const audioFile = clientFormData.get('audio_file') as File | null;
    const question = JSON.parse(clientFormData.get('question') as string);
    const options = JSON.parse(clientFormData.get('options') as string);
    //console.log(question.json())

    if (!audioFile) {
      return NextResponse.json({ message: 'No audio file provided.' }, { status: 400 });
    }

    // Prepare FormData to send to the Worker Microservice STT endpoint
    const workerFormData = new FormData();
    const audioBuffer = Buffer.from(await audioFile.arrayBuffer());
    workerFormData.append('audio_file', audioFile, 'response.webm');
    workerFormData.append('language', clientFormData.get("language") as string);
    // You could also pass 'language' if known, to help faster-whisper

    console.log(`[STT Proxy] Forwarding audio (${audioFile.name}, ${audioFile.size} bytes) to Worker...`);
    const workerResponse = await fetch(`${WORKER_MICROSERVICE_URL}/transcribe-audio`, {
      method: 'POST',
      body: workerFormData,
    });

    if (!workerResponse.ok) {
      const errorText = await workerResponse.text();
      console.error(`[STT Proxy] Worker STT failed: ${workerResponse.status} - ${errorText}`);
      return NextResponse.json({ message: `Worker STT service failed: ${errorText}` }, { status: workerResponse.status });
    }

    const transcriptionData = await workerResponse.json();
    console.log(transcriptionData)
    console.log(`[STT Proxy] Received transcription from Worker: "${transcriptionData.transcription?.substring(0,50)}..."`);
    console.log(question.type)
    // Return transcription data to the Next.js Frontend
    const {parsed_value, value_found, error_message} = parseValueFromTranscription(transcriptionData.transcription,question,options);
    const finalResponse = {
        ...transcriptionData,
        parsed_value: parsed_value,
        value_found: value_found,
        parser_error_message: error_message,
    };
    console.log(finalResponse)
    return NextResponse.json(finalResponse, { status: 200 });

  } catch (error: any) {
    console.error('[STT Proxy] Error:', error);
    return NextResponse.json({ message: `STT Proxy Error: ${error.message}` }, { status: 500 });
  }
}