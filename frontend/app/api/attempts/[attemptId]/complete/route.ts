import { NextResponse, NextRequest } from 'next/server';
import prisma from '@/lib/prisma';
import { AttemptStatus } from '@prisma/client';

export async function PUT(req: NextRequest, props: { params: Promise<{ attemptId: string }> }) {
  const params = await props.params;
  const attemptId = params.attemptId;
  // Optional: If attempts are tied to users, verify session
  // const session = await getServerSession(authOptions);
  // if (!session && !(await prisma.questionnaireAttempt.findFirst({where: {id: attemptId, userId: null}}))) { // Allow anonymous if userId is null
  //   return NextResponse.json({ message: 'Unauthorized or attempt not found' }, { status: 401 });
  // }

  try {
    const attempt = await prisma.questionnaireAttempt.findUnique({
      where: { id: attemptId },
    });

    if (!attempt) {
      return NextResponse.json({ message: 'Attempt not found' }, { status: 404 });
    }

    // Optional: Check if current user owns the attempt if not anonymous
    // if (session && attempt.userId && attempt.userId !== session.user.id) {
    //   return NextResponse.json({ message: 'Forbidden' }, { status: 403 });
    // }

    const updatedAttempt = await prisma.questionnaireAttempt.update({
      where: { id: attemptId },
      data: {
        status: AttemptStatus.COMPLETED,
        completedAt: new Date(),
      },
    });
    return NextResponse.json(updatedAttempt, { status: 200 });
  } catch (error) {
    console.error(`Error completing attempt ${attemptId}:`, error);
    return NextResponse.json({ message: 'Failed to complete attempt' }, { status: 500 });
  }
}