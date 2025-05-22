import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
// TODO: Replace with the actual path to your authOptions or use NextAuth.js v5 `auth()` helper
// import { authOptions } from '@/app/api/auth/[...nextauth]/route'; // Example path
import prisma from '@/lib/prisma';
import { UserRole } from '@prisma/client';
import fs from 'fs/promises';
import path from 'path';

// Placeholder for authOptions. Replace with your actual NextAuth configuration.
// If using NextAuth.js v4, this object is passed to getServerSession.
// If using NextAuth.js v5+, you'd typically use `import { auth } from '@/auth'; const session = await auth();`
const authOptions: any = {}; // Replace with your actual authOptions export

// NOTE: For typed session.user properties like `id` and `role`,
// ensure your NextAuth types are augmented (e.g., in a next-auth.d.ts file).
// This would remove the need for `(session.user as any)`.

export async function GET(
    request: NextRequest,
    props: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const params = await props.params;
    const questionnaireId = params.id;

    // @ts-ignore // If session type is not augmented for `user.role`
    if (!session || session.user?.role !== UserRole.RESEARCHER) {
        return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }
    
    if (!questionnaireId) { // Parameter presence is guaranteed by routing, but good for explicit validation
        return NextResponse.json({ message: 'Invalid questionnaire ID.' }, { status: 400 });
    }

    const detailedQuestionnaire = await prisma.questionnaire.findUnique({
        where: { id: questionnaireId },
        include: {
            questions: {
                orderBy: { order: 'asc' },
                include: {
                    preGeneratedAudios: true,
                }
            },
            creator: { select: { name: true } }
        }
    });

    if (!detailedQuestionnaire) {
        return NextResponse.json({ message: 'Questionnaire not found.' }, { status: 404 });
    }
    
    // @ts-ignore // If session type is not augmented for `user.id`
    if (detailedQuestionnaire.creatorId !== session.user?.id) {
        return NextResponse.json({ message: 'Forbidden: You do not own this questionnaire.' }, { status: 403 });
    }

    return NextResponse.json({
        ...detailedQuestionnaire,
        createdAt: detailedQuestionnaire.createdAt.toISOString(),
        updatedAt: detailedQuestionnaire.updatedAt.toISOString(),
        questions: detailedQuestionnaire.questions.map(q => ({
            ...q,
            // Ensure any date fields in question or preGeneratedAudios are also serialized if needed
        }))
    }, { status: 200 });
}

export async function DELETE(
    request: NextRequest,
    props: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const params = await props.params;
    const questionnaireId = params.id;

    // @ts-ignore // If session type is not augmented for `user.role`
    if (!session || session.user?.role !== UserRole.RESEARCHER) {
        return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }
    if (!questionnaireId) {
        return NextResponse.json({ message: 'Invalid questionnaire ID.' }, { status: 400 });
    }

    const questionnaire = await prisma.questionnaire.findUnique({
        where: { id: questionnaireId },
    });

    if (!questionnaire) {
        return NextResponse.json({ message: 'Questionnaire not found.' }, { status: 404 });
    }
    // @ts-ignore // If session type is not augmented for `user.id`
    if (questionnaire.creatorId !== session.user?.id) {
        return NextResponse.json({ message: 'Forbidden: You do not own this questionnaire.' }, { status: 403 });
    }

    try {
        // 1. Delete associated files
        if (questionnaire.originalPdfFilename) {
            const uploadsBaseDir = path.join(process.cwd(), 'data', 'pdf_uploads');
            // @ts-ignore // If session type is not augmented for `user.id`
            const userUploadsDir = path.join(uploadsBaseDir, session.user?.id as string); // Ensure user.id is a string
            const pdfPath = path.join(userUploadsDir, questionnaire.originalPdfFilename);
            try {
                if (await fs.stat(pdfPath).catch(() => false)) {
                    await fs.unlink(pdfPath);
                    console.log(`Deleted PDF: ${pdfPath}`);
                }
            } catch (fileError) {
                console.warn(`Could not delete PDF ${pdfPath}. Continuing with DB deletion. Error:`, fileError);
            }
        }

        const audioCacheDir = path.join(process.cwd(), 'public', 'audio_cache', 'questionnaires', questionnaireId);
        try {
            if (await fs.stat(audioCacheDir).catch(() => false)) {
                await fs.rm(audioCacheDir, { recursive: true, force: true });
                console.log(`Deleted audio cache directory: ${audioCacheDir}`);
            }
        } catch (fileError) {
            console.warn(`Could not delete audio cache ${audioCacheDir}. Continuing with DB deletion. Error:`, fileError);
        }
        
        // 2. Delete from DB
        await prisma.questionnaire.delete({
            where: { id: questionnaireId },
        });
        return NextResponse.json({ message: 'Questionnaire deleted successfully.' }, { status: 200 });
    } catch (error: any) {
        console.error(`Error deleting questionnaire ${questionnaireId}:`, error);
        return NextResponse.json({ message: error.message || 'Failed to delete questionnaire.' }, { status: 500 });
    }
}