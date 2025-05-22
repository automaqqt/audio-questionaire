import { NextResponse, NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next'; // For App Router server-side session
import { authOptions } from '@/lib/auth'; // Your NextAuth config
import formidable from 'formidable'; // Still useful for parsing multipart/form-data
import fs from 'fs/promises';
import path from 'path';
import prisma from '@/lib/prisma';
import { UserRole, Questionnaire } from '@prisma/client';
import { processQuestionnaireViaFastAPI } from '@/lib/server/questionaireProcessor';


export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);

  /* if (!session || session.user?.role !== UserRole.RESEARCHER) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  } */
  const userId = session?.user.id;

  try {
    const questionnaires = await prisma.questionnaire.findMany({
      where: { creatorId: userId },
      orderBy: { createdAt: 'desc' },
      include: {
        creator: { select: { name: true } },
        _count: { select: { questions: true } },
      },
    });
    // Dates are automatically serialized correctly by NextResponse.json
    return NextResponse.json(questionnaires, { status: 200 });
  } catch (error) {
    console.error("Error fetching questionnaires:", error);
    return NextResponse.json({ message: "Failed to fetch questionnaires" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  } 
  const userId = session?.user.id;

  let tempSavedFilePath: string | undefined = undefined; // To ensure cleanup
  let questionnaireRecord: Questionnaire | null = null;

  try {
    const formData = await req.formData(); // Native FormData parsing
    console.log(formData)
    const title = formData.get('title') as string | null;
    const language = formData.get('language') as string | null;
    const file = formData.get('pdf_file') as File | null;

    if (!title || !language || !file) {
      return NextResponse.json({ message: 'Title, language, and PDF file are required.' }, { status: 400 });
    }
    if (!(file instanceof File) || !file.name || file.size === 0) {
        return NextResponse.json({ message: 'Uploaded file is invalid or empty.' }, { status: 400 });
    }

    const uploadsBaseDir = path.join(process.cwd(), 'data', 'temp_pdf_uploads_nextjs');
    await fs.mkdir(uploadsBaseDir, { recursive: true });

    const uniqueFilenameSuffix = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const fileExtension = path.extname(file.name);
    const tempSavedFilename = `${path.basename(file.name.replace(" ",""), fileExtension)}_${uniqueFilenameSuffix}${fileExtension}`;
    tempSavedFilePath = path.join(uploadsBaseDir, tempSavedFilename);

    // Convert File to Buffer and save
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(tempSavedFilePath, fileBuffer);
    console.log(`[Next.js API] Temporarily saved PDF for FastAPI to: ${tempSavedFilePath}`);

    
    questionnaireRecord = await prisma.questionnaire.create({
      //@ts-ignore
      data: {
        title,
        language,
        creatorId: userId,
        originalPdfFilename: file.name,
        isProcessed: false,
      },
    });

    // Respond 202 Accepted to the client immediately.
    // The actual processing via FastAPI will happen after this response.
    // We don't await processQuestionnaireViaFastAPI here to make the API response fast.
    processQuestionnaireViaFastAPI(
        questionnaireRecord.id,
        tempSavedFilePath, // Path where Next.js saved the PDF
        language,
        file.name,
        title
    )
    .then(() => {
        console.log(`[Next.js API Handler] Background processing call for ${questionnaireRecord?.id} completed its promise (doesn't mean success yet).`);
        // tempSavedFilePath should be cleaned up inside processQuestionnaireViaFastAPI
    })
    .catch((procError) => {
        console.error(`[Next.js API Handler] Background processing call for ${questionnaireRecord?.id} FAILED:`, procError);
        // tempSavedFilePath should ideally be cleaned up even on error by processQuestionnaireViaFastAPI
        // Log additional error or update DB if processQuestionnaireViaFastAPI doesn't handle its own error state update fully.
         if (questionnaireRecord?.id) {
            prisma.questionnaire.update({
                where: {id: questionnaireRecord.id },
                data: { processingError: `Failed to complete processing: ${procError.message || 'Unknown error from processor'}`},
            }).catch(e => console.error("Failed to update questionnaire with final error state after processor catch", e));
        }
    });

    return NextResponse.json({
        message: 'Questionnaire upload accepted. Processing has started. This may take several minutes. Please refresh the questionnaire list later.',
        questionnaireId: questionnaireRecord.id
    }, { status: 202 });

  } catch (error: any) {
    console.error('[Next.js API] Error during POST /api/researcher/questionnaires:', error);
    if (questionnaireRecord?.id) {
        await prisma.questionnaire.update({
            where: {id: questionnaireRecord.id },
            data: { processingError: `Initial setup error: ${error.message}`},
        }).catch(e => console.error("Failed to update questionnaire with setup error state", e));
    }
    /* if (tempSavedFilePath) { // Clean up temp file if created and error occurred before processor call
        await fs.unlink(tempSavedFilePath).catch(e => console.error("Failed to delete temp PDF on error in POST handler", e));
    } */
    return NextResponse.json({ message: error.message || 'Error processing request.' }, { status: 500 });
  }
  // Note: formidable's temporary file cleanup (`file.filepath` from `form.parse`) is not applicable here
  // as we are using `req.formData()` and saving the buffer manually.
}