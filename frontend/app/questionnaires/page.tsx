"use client"
import ParticipantLayout from '@/components/layouts/ParticipantLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowRight, Mic } from 'lucide-react';
import Link from 'next/link';
import prisma from '@/lib/prisma';
import type { Questionnaire as PrismaQuestionnaire, User as PrismaUser } from '@prisma/client';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

type QuestionnaireWithCreator = PrismaQuestionnaire & {
  creator: { name: string | null };
  _count?: { questions: number }; // If you want to show question count
};
export default function PublicQuestionnaireListPage() {
  const [questionnaires, setQuestionnaires] = useState<QuestionnaireWithCreator[]>();
  useEffect(() => {
      refreshQuestionnaires();
      }, []);
  const refreshQuestionnaires = async () => {
    try {
      const res = await fetch('/api/researcher/questionnaires'); // Assuming this API route exists
      if (!res.ok) throw new Error('Failed to fetch');
      const data: QuestionnaireWithCreator[] = await res.json();
      // Convert date strings back to Date objects if necessary, though for display it might not be needed
      setQuestionnaires(data.map(q => ({
        ...q,
        createdAt: new Date(q.createdAt), 
        updatedAt: new Date(q.updatedAt)
      })));
      //toast.success("Questionnaire list refreshed.");
    } catch (error) {
        toast.error("Failed to refresh questionnaires.");
        console.error(error);
    }
  };
  return (
    <ParticipantLayout questionnaireTitle="Available Questionnaires">
      {questionnaires?.length === 0 ? (
        <Card className="text-center">
            <CardHeader><CardTitle>No Questionnaires Available</CardTitle></CardHeader>
            <CardContent><p>Please check back later or contact an administrator.</p></CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {questionnaires?.map((q) => (
            <Card key={q.id} className="shadow-lg hover:shadow-xl transition-shadow">
              <CardHeader>
                <CardTitle className="text-xl text-slate-800 dark:text-slate-100">{q.title}</CardTitle>
                {q.description && <CardDescription className="text-sm text-slate-600 dark:text-slate-300">{q.description.slice(0,150)}...</CardDescription>}
              </CardHeader>
              <CardContent>
                <p className="text-xs text-slate-500 dark:text-slate-400">Language: {q.language.toUpperCase()}</p>
              </CardContent>
              <CardFooter className="flex flex-col sm:flex-row justify-end gap-3 pt-4">
                {/* <Link href={`/questionnaires/${q.id}/take/visual`} passHref legacyBehavior>
                  <Button variant="outline" className="w-full sm:w-auto">
                    Take Visually <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </Link> */}
                <Link href={`/questionnaires/${q.id}/take`} passHref>
                  <Button className="w-full sm:w-auto bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600">
                   Show Questionnaire<ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </Link>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </ParticipantLayout>
  );
}
