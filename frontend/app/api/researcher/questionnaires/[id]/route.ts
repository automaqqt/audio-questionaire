import { NextApiRequest, NextApiResponse } from 'next';
import { getSession } from 'next-auth/react';
import prisma from '@/lib/prisma';
import { UserRole } from '@prisma/client';
import fs from 'fs/promises';
import path from 'path';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    const session = await getSession({ req });
    const { id: questionnaireId } = req.query;

    if (!session || session.user?.role !== UserRole.RESEARCHER) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    if (typeof questionnaireId !== 'string') {
        return res.status(400).json({ message: 'Invalid questionnaire ID.' });
    }

    const questionnaire = await prisma.questionnaire.findUnique({
        where: { id: questionnaireId },
    });

    if (!questionnaire) {
        return res.status(404).json({ message: 'Questionnaire not found.' });
    }
    if (questionnaire.creatorId !== session.user.id) {
        return res.status(403).json({ message: 'Forbidden: You do not own this questionnaire.' });
    }

    if (req.method === 'DELETE') {
        try {
            // 1. Delete associated files (PDF, audio cache) - IMPORTANT
            // PDF
            if (questionnaire.originalPdfFilename) {
                const uploadsBaseDir = path.join(process.cwd(), 'data', 'pdf_uploads');
                const userUploadsDir = path.join(uploadsBaseDir, session.user.id);
                const pdfPath = path.join(userUploadsDir, questionnaire.originalPdfFilename);
                if (await fs.stat(pdfPath).catch(() => false)) {
                    await fs.unlink(pdfPath);
                    console.log(`Deleted PDF: ${pdfPath}`);
                }
            }
            // Audio cache - this requires knowing the structure. Let's assume public/audio_cache/questionnaires/<qId>/
            const audioCacheDir = path.join(process.cwd(), 'public', 'audio_cache', 'questionnaires', questionnaireId);
            if (await fs.stat(audioCacheDir).catch(() => false)) {
                await fs.rm(audioCacheDir, { recursive: true, force: true });
                console.log(`Deleted audio cache directory: ${audioCacheDir}`);
            }

            // 2. Delete from DB (cascades should handle related questions, audios, attempts)
            await prisma.questionnaire.delete({
                where: { id: questionnaireId },
            });
            return res.status(200).json({ message: 'Questionnaire deleted successfully.' });
        } catch (error: any) {
            console.error(`Error deleting questionnaire ${questionnaireId}:`, error);
            return res.status(500).json({ message: error.message || 'Failed to delete questionnaire.' });
        }
    } else if (req.method === 'GET') {
        // Fetch specific questionnaire with questions and pre-generated audio
        const detailedQuestionnaire = await prisma.questionnaire.findUnique({
            where: { id: questionnaireId },
            include: {
                questions: {
                    orderBy: { order: 'asc' },
                    include: {
                        preGeneratedAudios: true,
                    }
                },
                creator: {select: {name: true}}
            }
        });
         if (!detailedQuestionnaire) return res.status(404).json({ message: 'Questionnaire not found.' });

        return res.status(200).json({
            ...detailedQuestionnaire,
            createdAt: detailedQuestionnaire.createdAt.toISOString(),
            updatedAt: detailedQuestionnaire.updatedAt.toISOString(),
            questions: detailedQuestionnaire.questions.map(q => ({
                ...q,
                // ensure any date fields in question or preGeneratedAudios are also serialized if needed by client
            }))
        });
    }
    // Add PUT later for editing metadata
    else {
        res.setHeader('Allow', ['GET', 'DELETE']);
        res.status(405).end(`Method ${req.method} Not Allowed`);
    }
}