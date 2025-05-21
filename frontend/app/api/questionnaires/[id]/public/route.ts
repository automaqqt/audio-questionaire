
import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import type { FullQuestionnaireClientType} from '@/types/questionnaire'; // Import your types
interface RouteContext {
  params: Promise<{
    id: string;
  }>;
}

export async function GET(
  req: Request,
  context: RouteContext
) {
  const { params } = context;
  const { id } = await params;
  const questionnaireId = id;

  if (!questionnaireId || typeof questionnaireId !== 'string') {
    return NextResponse.json({ message: 'Invalid questionnaire ID' }, { status: 400 });
  }

  try {
    const questionnaireFromDb = await prisma.questionnaire.findUnique({
      where: { id: questionnaireId, isProcessed: true },
      include: {
        questions: {
          orderBy: { order: 'asc' },
          include: {
            preGeneratedAudios: {
              select: { audioPath: true, languageCode: true }, // Select only necessary fields
            },
          },
        },
      },
    });

    if (!questionnaireFromDb) {
      return NextResponse.json({ message: 'Questionnaire not found or not yet processed.' }, { status: 404 });
    }

    // Map to client-side types
    const responseData: FullQuestionnaireClientType = {
      id: questionnaireFromDb.id,
      title: questionnaireFromDb.title,
      description: questionnaireFromDb.description,
      language: questionnaireFromDb.language,
      isProcessed: questionnaireFromDb.isProcessed,
      questions: questionnaireFromDb.questions.map(q => ({
        id: q.id,
        text: q.text,
        type: q.type,
        order: q.order,
        minValue: q.minValue,
        maxValue: q.maxValue,
        optionsText: q.optionsText,
        visualOptions: q.visualOptions, // Prisma returns JsonValue, which 'any' can handle
        preGeneratedAudios: q.preGeneratedAudios.map((audio: { audioPath: any; languageCode: any; }) => ({
            audioPath: audio.audioPath,
            languageCode: audio.languageCode,
        })),
      })),
    };

    return NextResponse.json(responseData, { status: 200 });
  } catch (error) {
    console.error(`Error fetching public questionnaire ${questionnaireId}:`, error);
    return NextResponse.json({ message: 'Failed to load questionnaire data.' }, { status: 500 });
  }
}