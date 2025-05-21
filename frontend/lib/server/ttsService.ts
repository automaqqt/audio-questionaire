import prisma from '@/lib/prisma';
import { Question } from '@prisma/client';
import fs from 'fs/promises';
import path from 'path';

// This is a placeholder. Replace with actual TTS generation logic.
// You might call a Python microservice for Coqui/Piper, or use a Node.js TTS library.
async function generateAudioFile(text: string, outputPath: string, language: string): Promise<boolean> {
    console.log(`[TTS Service Mock] Generating audio for "${text.substring(0,30)}..." to ${outputPath} (lang: ${language})`);
    // Simulate TTS generation by creating a dummy file
    try {
        await fs.writeFile(outputPath, `Mock audio for: ${text}`);
        return true;
    } catch (error) {
        console.error(`[TTS Service Mock] Error creating dummy audio file ${outputPath}:`, error);
        return false;
    }
}

export async function generateAndSaveAudioForAllQuestions(
    questionnaireId: string,
    questions: Question[], // Pass full Question objects
    language: string, // Primary language for TTS
    userId: string // For path structuring
) {
    const audioBaseDir = path.join(process.cwd(), 'public', 'audio_cache', 'questionnaires', questionnaireId);
    await fs.mkdir(audioBaseDir, { recursive: true });

    for (const question of questions) {
        const textsToSynthesize: { type: string, content: string | null }[] = [
            { type: 'question_text', content: question.text },
            { type: 'options_text', content: question.optionsText }
        ];

        for (const item of textsToSynthesize) {
            if (item.content) {
                // Example filename: q_cuid_question_text_de.wav
                const filename = `q_${question.id}_${item.type}_${language}.wav`;
                const audioFilePath = path.join(audioBaseDir, filename);
                const publicAudioPath = `/audio_cache/questionnaires/${questionnaireId}/${filename}`; // Path client will use

                // Check if audio already exists for this question, type, and language
                const existingAudio = await prisma.preGeneratedAudio.findUnique({
                    where: { questionId_languageCode_audioType: { // Add audioType to PreGeneratedAudio model if differentiating
                                questionId: question.id, 
                                languageCode: language, 
                                // audioType: item.type // You'd need to add 'audioType' to PreGeneratedAudio schema
                                // For now, assuming one main audio per question per language
                                // Or, if handling optionsText separately and it uses the same lang, need better way to diff.
                                // Let's simplify: assume 'audioPath' uniqueness is enough for now if item.type is in filename.
                            }
                        }
                });
                // This unique check needs refinement based on how you structure PreGeneratedAudio
                // The current schema has @@unique([questionId, languageCode])
                // So if you generate for question.text and question.optionsText separately with same lang,
                // you need a way to distinguish them in PreGeneratedAudio or store only one combined audio.
                // For now, let's assume we generate one primary audio for the question.
                // If optionsText exists, it should ideally be part of the main question text passed to TTS.
                // OR, the LLM should provide a combined options_text ready for TTS.

                // Let's assume the `question.text` already contains the main query AND options if needed for a single audio.
                // Or, if `question.optionsText` is substantial and needs separate audio:
                // The `PreGeneratedAudio` model needs an `audioType` field (e.g., "main", "options")
                // and the unique constraint becomes `@@unique([questionId, languageCode, audioType])`

                // Simplified: Generate audio for question.text + question.optionsText combined
                let combinedText = question.text;
                if (question.optionsText) {
                    combinedText += ` ${question.optionsText}`; // Combine for a single TTS call per question
                }

                // Check if audio for this combined text already exists
                 const existingCombinedAudio = await prisma.preGeneratedAudio.findFirst({
                    where: { questionId: question.id, languageCode: language }
                });


                if (!existingCombinedAudio) {
                    const success = await generateAudioFile(combinedText, audioFilePath, language);
                    if (success) {
                        await prisma.preGeneratedAudio.create({
                            data: {
                                questionId: question.id,
                                languageCode: language,
                                audioPath: publicAudioPath, // Store the web-accessible path
                                // audioType: "combined" // If you add this field
                            }
                        });
                        console.log(`[TTS] Saved audio for Q:${question.id} to ${publicAudioPath}`);
                    } else {
                        console.error(`[TTS] Failed to generate audio for Q:${question.id}`);
                    }
                } else {
                    console.log(`[TTS] Audio already exists for Q:${question.id}, lang:${language}. Path: ${existingCombinedAudio.audioPath}`);
                }
            }
        }
    }
}