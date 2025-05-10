// frontend/lib/apiClient.ts
const API_BASE_URL = 'http://localhost:8000/api'; // Your FastAPI backend URL

export interface QuestionResponse {
    question_id: string;
    question_text: string;
    question_number: number;
    total_questions: number;
    audio_url: string; // Relative URL like /api/audio/filename.wav
    options_text?: string;
    question_type: string;
    min_value?: number;
    max_value?: number;
    completed?: boolean; // If questionnaire is complete
    message?: string;    // e.g., "Questionnaire complete."
}

export interface TranscribedApiResponse {
    transcription: string;
    parsed_value: any | null;
    value_found: boolean;
    error_message: string | null;
}

export interface AnswerPayload {
    question_id: string;
    question_text: string;
    transcribed_response: string;
    parsed_value: any | null;
    is_confirmed: boolean;
}


export const apiClient = {
    loadQuestionnaire: async (fileName: string = "example_questionnaire.json") => {
        const response = await fetch(`${API_BASE_URL}/questionnaire/load`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fileName), // FastAPI expects a raw string for this Body param
        });
        if (!response.ok) throw new Error(`Failed to load questionnaire: ${response.statusText}`);
        return response.json();
    },

    getNextQuestion: async (): Promise<QuestionResponse> => {
        const response = await fetch(`${API_BASE_URL}/questionnaire/next_question`);
        if (!response.ok) throw new Error(`Failed to get next question: ${response.statusText}`);
        return response.json();
    },

    submitAudioAnswer: async (audioBlob: Blob): Promise<TranscribedApiResponse> => {
        const formData = new FormData();
        formData.append('audio_file', audioBlob, 'response.wav'); // FastAPI expects 'audio_file'

        const response = await fetch(`${API_BASE_URL}/answer/submit`, {
            method: 'POST',
            body: formData,
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ detail: response.statusText }));
            throw new Error(`Failed to submit answer: ${errorData.detail || response.statusText}`);
        }
        return response.json();
    },

    confirmAnswer: async (answer: AnswerPayload) => {
        const response = await fetch(`${API_BASE_URL}/answer/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(answer),
        });
        if (!response.ok) throw new Error(`Failed to confirm answer: ${response.statusText}`);
        return response.json();
    },

    downloadResults: async () => {
        const response = await fetch(`${API_BASE_URL}/results/download_csv`);
        if (!response.ok) throw new Error(`Failed to download results: ${response.statusText}`);
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'questionnaire_results.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
    },

    resetState: async () => {
        const response = await fetch(`${API_BASE_URL}/state/reset`);
        if (!response.ok) throw new Error(`Failed to reset state: ${response.statusText}`);
        return response.json();
    }
};