import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma'; // Assuming this path is correct
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth'; // Import your authOptions
import { AttemptMode, AttemptStatus } from '@prisma/client';

// Define an interface for the expected request body for better type safety
interface StartAttemptRequestBody {
  questionnaireId: string;
  mode: AttemptMode | string; // Allow string initially for validation
}

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions); // Get session on the server

    let body: StartAttemptRequestBody;
    try {
      body = await request.json();
    } catch (error) {
      return NextResponse.json({ message:`Invalid JSON body.:${error}`  }, { status: 400 });
    }

    const { questionnaireId, mode } = body;

    if (!questionnaireId || !mode) {
      return NextResponse.json(
        { message: 'Questionnaire ID and mode are required.' },
        { status: 400 }
      );
    }

    // Validate mode against the enum values
    if (!Object.values(AttemptMode).includes(mode as AttemptMode)) {
      return NextResponse.json(
        { message: 'Invalid attempt mode. Valid modes are: ' + Object.values(AttemptMode).join(', ') },
        { status: 400 }
      );
    }

    const attempt = await prisma.questionnaireAttempt.create({
      data: {
        questionnaireId: questionnaireId as string, // Already validated to exist
        userId: session?.user?.id || undefined, // Link to user if session exists
        mode: mode as AttemptMode, // Cast after validation
        status: AttemptStatus.IN_PROGRESS,
      },
    });

    return NextResponse.json({ attemptId: attempt.id }, { status: 201 });

  } catch (error) {
    console.error('Error creating questionnaire attempt:', error);
    // Differentiate between known errors and unexpected ones
    if (error instanceof Error && error.message.includes('foreign key constraint fails')) { // Example for Prisma
        return NextResponse.json({ message: 'Invalid questionnaireId or userId.' }, { status: 400 });
    }
    return NextResponse.json(
      { message: 'Failed to start questionnaire attempt. Please try again later.' },
      { status: 500 }
    );
  }
}

// Optional: If you want to explicitly disallow other methods
export async function GET() {
  return NextResponse.json({ message: 'Method not allowed' }, { status: 405 });
}
export async function PUT() {
  return NextResponse.json({ message: 'Method not allowed' }, { status: 405 });
}
export async function DELETE() {
  return NextResponse.json({ message: 'Method not allowed' }, { status: 405 });
}