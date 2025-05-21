// app/api/attempts/[attemptId]/answers/route.ts

import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma'; // Assuming this path is correct
import { AttemptStatus } from '@prisma/client';

// Interface for the request body for better type safety
interface SaveAnswerRequestBody {
  questionId: string;
  transcribedResponse: string; // Assuming it's always a string or empty string
  parsedValue: any; // Can be string, number, boolean, etc., before being stringified
  isConfirmed: boolean;
}

// Interface for the context parameters (dynamic route segments)
interface RouteContext {
  params: Promise<{
    attemptId: string;
  }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { params } = context;
  const { attemptId } = await params;

  if (!attemptId) {
    // This case should ideally be caught by Next.js routing if the segment is missing,
    // but an explicit check can be useful for type narrowing or defensive programming.
    return NextResponse.json({ message: 'Attempt ID is missing in the URL path.' }, { status: 400 });
  }

  let body: SaveAnswerRequestBody;
  try {
    body = await request.json();
  } catch (error) {
    return NextResponse.json({ message: `Invalid JSON body.:${error}` }, { status: 400 });
  }

  const { questionId, transcribedResponse, parsedValue, isConfirmed } = body;

  // Validate required fields
  if (
    !questionId ||
    typeof transcribedResponse === 'undefined' || // Check for undefined, as empty string might be valid
    typeof parsedValue === 'undefined' ||
    typeof isConfirmed !== 'boolean'
  ) {
    return NextResponse.json(
      { message: 'Missing required answer fields: questionId, transcribedResponse, parsedValue, isConfirmed.' },
      { status: 400 }
    );
  }

  try {
    // 1. Check if the attempt exists and is IN_PROGRESS
    const attempt = await prisma.questionnaireAttempt.findUnique({
      where: { id: attemptId },
    });

    if (!attempt) {
      return NextResponse.json({ message: `Attempt with ID '${attemptId}' not found.` }, { status: 404 });
    }

    if (attempt.status !== AttemptStatus.IN_PROGRESS) {
      return NextResponse.json(
        { message: `Attempt with ID '${attemptId}' is not in progress. Current status: ${attempt.status}` },
        { status: 400 } // 400 Bad Request or 409 Conflict could also be considered
      );
    }

    // 2. Create the answer
    const answer = await prisma.answer.create({
      data: {
        attemptId: attemptId, // From path parameter
        questionId: questionId,
        transcribedResponse: transcribedResponse,
        parsedValue: String(parsedValue), // Ensure parsedValue is stored as a string
        isConfirmed: isConfirmed,
      },
    });

    return NextResponse.json(answer, { status: 201 });

  } catch (error: any) {
    console.error(`Error saving answer for attempt ${attemptId}:`, error);
    // Check for specific Prisma errors, e.g., foreign key constraint if questionId is invalid
    if (error.code === 'P2003' && error.meta?.field_name?.includes('questionId')) {
        return NextResponse.json({ message: `Invalid questionId: '${questionId}'. It does not exist.` }, { status: 400 });
    }
    // Add other specific error checks if needed

    return NextResponse.json(
      { message: 'Failed to save answer. Please try again later.' },
      { status: 500 }
    );
  }
}
