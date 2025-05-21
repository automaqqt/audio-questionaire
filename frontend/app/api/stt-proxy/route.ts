import { NextRequest, NextResponse } from 'next/server';
import { wordsToNumbers } from 'words-to-numbers';
import type { Question as PrismaQuestion, PreGeneratedAudio, Questionnaire as PrismaQuestionnaire } from '@prisma/client';
interface Question {
    type: string;
    min_value?: number;
    max_value?: number;
    true_value_spoken?: string[];
    false_value_spoken?: string[];
    true_value_numeric?: any;
    false_value_numeric?: any;
}

const WORKER_MICROSERVICE_URL = process.env.WORKER_MICROSERVICE_URL || 'http://localhost:8088'; // e.g., http://localhost:8001

function parseValueFromTranscription(
    text: string,
    question: Question
): { parsed_value: any | null; value_found: boolean; error_message: string | null } {
    if (!text.trim()) {
        return { parsed_value: null, value_found: false, error_message: "Empty transcription." };
    }

    let processedText = text.toLowerCase();

    // Optional: words-to-numbers
    // try {
    //    const numText = wordsToNumbers(processedText);
    //    if (typeof numText === 'string' || typeof numText === 'number') {
    //        processedText = String(numText);
    //    }
    // } catch (e) {
    //    console.warn("words-to-numbers failed:", e);
    // }
    
    // Hardcoded replacements
    const replacements: Record<string, string> = {
        "eins": "1", "zwei": "2", "drei": "3", "vier": "4", "fünf": "5",
        "sechs": "6", "sieben": "7", "acht": "8", "neun": "9", "null": "0",
        "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
        "six": "6", "seven": "7", "eight": "8", "nine": "9", "zero": "0",
    };
    for (const [word, digit] of Object.entries(replacements)) {
        processedText = processedText.replace(new RegExp(`\\b${word}\\b`, 'gi'), digit);
    }

    if (question.type === "scale") {
        const numbers = processedText.match(/-?\d+/g); // Find all numbers
        if (numbers && numbers.length > 0) {
            for (let i = numbers.length - 1; i >= 0; i--) { // Prioritize last
                const val = parseInt(numbers[i]);
                if (question.min_value !== undefined && question.max_value !== undefined) {
                    if (val >= question.min_value && val <= question.max_value) {
                        return { parsed_value: val, value_found: true, error_message: null };
                    }
                } else {
                    return { parsed_value: val, value_found: true, error_message: null };
                }
            }
            const rangeMsg = (question.min_value !== undefined && question.max_value !== undefined)
                ? `Number found, but not in range [${question.min_value}-${question.max_value}].`
                : "Number found, but question scale range is not defined.";
            return { parsed_value: null, value_found: false, error_message: rangeMsg };
        }
        return { parsed_value: null, value_found: false, error_message: "No number found in response." };
    } else if (question.type === "boolean_custom_map") {
        if (question.true_value_spoken) {
            for (const trueWord of question.true_value_spoken) {
                if (new RegExp(`\\b${trueWord.toLowerCase()}\\b`).test(processedText)) {
                    return { parsed_value: question.true_value_numeric, value_found: true, error_message: null };
                }
            }
        }
        if (question.false_value_spoken) {
            for (const falseWord of question.false_value_spoken) {
                if (new RegExp(`\\b${falseWord.toLowerCase()}\\b`).test(processedText)) {
                    return { parsed_value: question.false_value_numeric, value_found: true, error_message: null };
                }
            }
        }
        return { parsed_value: null, value_found: false, error_message: "Could not understand 'yes' or 'no' equivalent." };
    }
    return { parsed_value: null, value_found: false, error_message: "Unsupported question type for parsing." };
}

export async function POST(req: NextRequest) {
  try {
    const clientFormData = await req.formData(); // Audio blob from client (Next.js Frontend)
    const audioFile = clientFormData.get('audio_file') as File | null;
    const question = JSON.parse(clientFormData.get('question'));
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
    const {parsed_value, value_found, error_message} = parseValueFromTranscription(transcriptionData.transcription,question);
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