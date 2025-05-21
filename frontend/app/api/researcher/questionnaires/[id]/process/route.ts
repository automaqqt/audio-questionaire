import { NextApiRequest, NextApiResponse } from 'next';
import { getSession } from 'next-auth/react';
import prisma from '@/lib/prisma';
import { UserRole } from '@prisma/client';
import { processQuestionnaireViaFastAPI } from '@/lib/server/questionaireProcessor';
import path from 'path'; // For constructing PDF path if needed

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    const session = await getSession({ req });
    const { id: questionnaireId } = req.query;

    if (!session || session.user?.role !== UserRole.RESEARCHER) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    if (typeof questionnaireId !== 'string') {
        return res.status(400).json({ message: 'Invalid questionnaire ID.' });
    }

    if (req.method === 'POST') {
        try {
            const questionnaire = await prisma.questionnaire.findUnique({
                where: { id: questionnaireId },
            });

            if (!questionnaire) {
                return res.status(404).json({ message: 'Questionnaire not found.' });
            }
            if (questionnaire.creatorId !== session.user.id) {
                return res.status(403).json({ message: 'Forbidden: You do not own this questionnaire.' });
            }

            // Construct the path to the saved PDF. This assumes a consistent storage pattern.
            // You might need to store the full PDF path in the Questionnaire model if it's complex.
            const uploadsBaseDir = path.join(process.cwd(), 'data', 'pdf_uploads');
            const userUploadsDir = path.join(uploadsBaseDir, session.user.id);
            // Reconstruct path based on originalPdfFilename (might need more robust way if names change)
            // It's better if the PDF path was stored in DB or if `originalPdfFilename` is unique enough
            // For now, let's assume `originalPdfFilename` is the name in `userUploadsDir`
            // This is a simplification: ideally, Questionnaire model would store the relative `filePath`
            const pdfPath = path.join(userUploadsDir, questionnaire.originalPdfFilename || ""); 
            
            


            res.status(202).json({ message: 'Re-processing initiated. This may take several minutes.'});
            
            // Trigger processing (long-running synchronous call for now)
            processQuestionnaireViaFastAPI(
                questionnaire.id,
                pdfPath, // Path where Next.js saved the PDF
                questionnaire.language,
                pdfPath,
                "123"
            )
                .then(() => console.log(`Re-processing finished for ${questionnaireId}`))
                .catch((procError: any) => console.error(`Background re-processing error for ${questionnaireId}:`, procError));

        } catch (error: any) {
            console.error(`Error initiating processing for ${questionnaireId}:`, error);
            if (!res.headersSent) {
                res.status(500).json({ message: error.message || 'Failed to initiate processing.' });
            }
        }
    } else {
        res.setHeader('Allow', ['POST']);
        res.status(405).end(`Method ${req.method} Not Allowed`);
    }
}