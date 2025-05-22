import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
// TODO: Replace with the actual path to your authOptions or use NextAuth.js v5 `auth()` helper
// import { authOptions } from '@/app/api/auth/[...nextauth]/route'; // Example path
import prisma from '@/lib/prisma';
import { UserRole } from '@prisma/client';
import { processQuestionnaireViaFastAPI } from '@/lib/server/questionaireProcessor';
import path from 'path';
import fs from 'fs/promises'; // Added for fs.stat to check PDF existence

// Placeholder for authOptions. Replace with your actual NextAuth configuration.
// If using NextAuth.js v4, this object is passed to getServerSession.
// If using NextAuth.js v5+, you'd typically use `import { auth } from '@/auth'; const session = await auth();`
const authOptions: any = {}; // Replace with your actual authOptions export

// NOTE: For typed session.user properties like `id` and `role`,
// ensure your NextAuth types are augmented (e.g., in a next-auth.d.ts file).
// This would remove the need for `(session.user as any)`.

export async function POST(
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

    try {
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

        if (!questionnaire.originalPdfFilename) {
            console.error(`Questionnaire ${questionnaireId} is missing originalPdfFilename, required for reprocessing.`);
            return NextResponse.json({ message: 'Cannot reprocess: Original PDF filename is missing.' }, { status: 400 });
        }
        
        const uploadsBaseDir = path.join(process.cwd(), 'data', 'pdf_uploads');
        // @ts-ignore // If session type is not augmented for `user.id`
        const userUploadsDir = path.join(uploadsBaseDir, session.user?.id as string); // Ensure user.id is a string
        const pdfPath = path.join(userUploadsDir, questionnaire.originalPdfFilename);

        try {
            await fs.stat(pdfPath); // Check if PDF file exists
        } catch (fileError) {
            console.error(`PDF file not found for reprocessing at path: ${pdfPath} for questionnaire ${questionnaireId}. Error: ${fileError}`);
            return NextResponse.json({ message: 'Cannot reprocess: PDF file not found.' }, { status: 404 });
        }

        // Respond immediately with 202 Accepted
        const response = NextResponse.json({ message: 'Re-processing initiated. This may take several minutes.' }, { status: 202 });
        
        // Trigger background processing. 
        // Note: Ensure your deployment environment supports background tasks running after a response is sent.
        // For long-running tasks, consider a dedicated job queue system.
        processQuestionnaireViaFastAPI(
            questionnaire.id,
            pdfPath,
            questionnaire.language,
            pdfPath, // This argument is repeated from original code, verify if intentional.
            "123"    // This "123" seems like a placeholder, verify if it needs dynamic data.
        )
            .then(() => console.log(`Background re-processing successfully completed for questionnaire ${questionnaireId}`))
            .catch((procError: any) => console.error(`Background re-processing failed for questionnaire ${questionnaireId}:`, procError));
            
        return response;

    } catch (error: any) {
        console.error(`Error initiating re-processing for questionnaire ${questionnaireId}:`, error);
        return NextResponse.json({ message: error.message || 'Failed to initiate re-processing.' }, { status: 500 });
    }
}