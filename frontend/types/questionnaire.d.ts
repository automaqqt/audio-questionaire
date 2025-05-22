// types/questionnaire.d.ts (or types/index.ts and export from there)

// Base Question type for client-side usage
// Excludes fields like questionnaireId, preGeneratedAudios if not always needed directly by display component
export interface QuestionClientBase {
    id: string;
    text: string;
    type: string; // e.g., "scale", "boolean_custom_map", "text_input", "textarea"
    order: number;
    minValue?: number | null;
    maxValue?: number | null;
    optionsText?: string | null; // For audio prompt or visual display of scale context
    visualOptions?: any | null; // Prisma Json type, could be { value: string; label: string }[] for custom radio/checkbox
  }

  export interface VisualOptionItem {
    label: string;
    value: string;
  }
  
  // Question type specifically for the audio page, including pre-generated audio info
  export interface QuestionWithAudioClientType extends QuestionClientBase {
    preGeneratedAudios: { // Array because a question might have audio in multiple languages
      audioPath: string;
      languageCode: string; // e.g., "en-US", "de-DE"
    }[];
  }
  
  // Question type for visual mode (might be the same as base or have specific visual fields later)
  export interface QuestionForVisualClientType extends QuestionClientBase {
    // Potentially add fields specific to visual rendering if different from base
    // e.g., specific layout hints, image URLs associated with the question, etc.
  }
  
  // Full Questionnaire structure for client-side use
  // This is what your /api/questionnaires/[id]/public endpoint would return
  export interface FullQuestionnaireClientType {
    id: string;
    title: string;
    description?: string | null;
    language: string; // Primary language of the questionnaire
    isProcessed: boolean; // Good to have on client to ensure it's ready
    // Use a union type if questions for audio/visual differ significantly in structure,
    // or keep them compatible and use the more general one.
    // For now, let's assume QuestionWithAudioClientType is comprehensive enough for initial data load,
    // and visual mode will just ignore preGeneratedAudios if not needed.
    questions: QuestionWithAudioClientType[]; // Or QuestionForVisualClientType[] if distinct
  }