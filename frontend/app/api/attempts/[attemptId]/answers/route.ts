// app/api/attempts/[attemptId]/answers/route.ts
import { NextResponse, NextRequest } from 'next/server';
import prisma from '@/lib/prisma';
import { AttemptStatus } from '@prisma/client'; // Assuming your Prisma client exports this
// import { getServerSession } from 'next-auth/next'; // Optional: if you need to verify user for non-anonymous attempts
// import { authOptions } from '@/lib/authOptions';

interface AnswerPayload {
  questionId: string;
  visualResponse?: string | null;        // For visual mode
  transcribedResponse?: string | null; // For audio mode
  parsedValue?: string | null;           // For audio mode (parsed value)
  isConfirmed?: boolean;                 // Primarily for audio mode
}

export async function POST(req: NextRequest, props: { params: Promise<{ attemptId: string }> }) {
  const params = await props.params;
  const attemptId = params.attemptId;

  // Optional: If attempts are strictly tied to logged-in users, verify session.
  // For public/anonymous attempts, you might skip this or have a different check.
  // const session = await getServerSession(authOptions);
  // if (!session) { // Basic check, adjust if anonymous attempts are allowed based on attempt record
  //   return NextResponse.json({ message: 'Unauthorized to submit answer for this attempt' }, { status: 401 });
  // }

  if (!attemptId || typeof attemptId !== 'string') {
    return NextResponse.json({ message: 'Invalid attempt ID.' }, { status: 400 });
  }

  try {
    const body: AnswerPayload = await req.json();
    const { 
        questionId, 
        visualResponse, 
        transcribedResponse, 
        parsedValue, 
        isConfirmed = false // Default to false if not provided (more relevant for audio)
    } = body;

    if (!questionId) {
      return NextResponse.json({ message: 'Missing required answer field: questionId.' }, { status: 400 });
    }
    // Depending on the mode (visual/audio), one set of response fields will be relevant.
    // Add more validation here if needed (e.g., ensure either visualResponse or transcribedResponse exists)

    // 1. Verify the attempt exists and is in progress
    const attempt = await prisma.questionnaireAttempt.findUnique({
      where: { id: attemptId },
    });

    if (!attempt) {
      return NextResponse.json({ message: 'Questionnaire attempt not found.' }, { status: 404 });
    }

    if (attempt.status !== AttemptStatus.IN_PROGRESS) {
      return NextResponse.json({ message: 'This questionnaire attempt is already completed or abandoned.' }, { status: 400 });
    }

    // Optional: If attempts are tied to users and not anonymous:
    // if (session && attempt.userId && attempt.userId !== session.user.id) {
    //   return NextResponse.json({ message: 'You are not authorized to submit answers for this attempt.' }, { status: 403 });
    // }

    // 2. Check if an answer for this question in this attempt already exists.
    //    If so, update it (upsert behavior). This allows changing answers.
    const existingAnswer = await prisma.answer.findFirst({
        where: {
            attemptId: attemptId,
            questionId: questionId,
        }
    });

    let savedAnswer;
    if (existingAnswer) {
        // Update existing answer
        savedAnswer = await prisma.answer.update({
            where: { id: existingAnswer.id },
            data: {
                visualResponse: visualResponse, // Will be null if not provided
                transcribedResponse: transcribedResponse, // Will be null if not provided
                parsedValue: parsedValue, // Will be null if not provided
                isConfirmed: isConfirmed,
                answeredAt: new Date(), // Update timestamp
            },
        });
        console.log(`Updated answer for QID: ${questionId} in Attempt: ${attemptId}`);
    } else {
        // Create new answer
        savedAnswer = await prisma.answer.create({
          data: {
            attemptId: attemptId,
            questionId: questionId,
            visualResponse: visualResponse,
            transcribedResponse: transcribedResponse,
            parsedValue: parsedValue,
            isConfirmed: isConfirmed,
            answeredAt: new Date(),
          },
        });
        console.log(`Created new answer for QID: ${questionId} in Attempt: ${attemptId}`);
    }

    return NextResponse.json(savedAnswer, { status: 201 }); // 201 for created, 200 for updated

  } catch (error: any) {
    console.error(`Error saving answer for attempt ${attemptId}:`, error);
    if (error.name === 'PrismaClientKnownRequestError' && error.code === 'P2003') { // Foreign key constraint failed
        return NextResponse.json({ message: 'Invalid question ID or attempt ID provided.' }, { status: 400 });
    }
    return NextResponse.json({ message: error.message || 'Failed to save answer.' }, { status: 500 });
  }
}