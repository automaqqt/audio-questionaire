import ParticipantLayout from '@/components/layouts/ParticipantLayout'; // Your existing layout
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle }  from '@/components/ui/card';
import { Mic, Eye, AlertTriangle, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { FullQuestionnaireClientType } from '@/types/questionnaire'; // Import your types
import { Suspense } from 'react';

interface TakeQuestionnairePageProps {
  params: Promise<{
    id: string; // Questionnaire ID from the URL
  }>;
}

// Server component to fetch initial questionnaire data for display
async function getQuestionnaireDetails(id: string): Promise<FullQuestionnaireClientType | null> {
  try {
    // Construct the full URL for fetch within server components
    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/questionnaires/${id}/public`, { cache: 'no-store' }); // Fetch fresh data
    if (!res.ok) {
      console.error(`Failed to fetch questionnaire ${id} for selection page: ${res.status}`);
      return null;
    }
    return await res.json() as FullQuestionnaireClientType;
  } catch (error) {
    console.error(`Error in getQuestionnaireDetails for ${id}:`, error);
    return null;
  }
}

export default async function TakeQuestionnaireSelectionPage(props: TakeQuestionnairePageProps) {
  const params = await props.params;
  const { id } = params;
  const questionnaire = await getQuestionnaireDetails(id);

  if (!questionnaire) {
    return (
      <ParticipantLayout questionnaireTitle="Questionnaire Not Found">
        <Card className="text-center">
          <CardHeader>
            <AlertTriangle className="mx-auto h-12 w-12 text-destructive" />
            <CardTitle className="mt-4 text-destructive">Error Loading Questionnaire</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              The questionnaire could not be loaded. It might not exist, is not yet processed, or there was an issue fetching its details.
            </p>
            <Button asChild className="mt-6">
              <Link href="/questionnaires">Back to List</Link>
            </Button>
          </CardContent>
        </Card>
      </ParticipantLayout>
    );
  }

  return (
    <ParticipantLayout questionnaireTitle={""}>
      <Card className="w-full max-w-lg shadow-xl dark:bg-slate-800">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl sm:text-3xl font-bold text-slate-800 dark:text-slate-100">
            {questionnaire.title}
          </CardTitle>
          {questionnaire.description && (
            <CardDescription className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              {questionnaire.description}
            </CardDescription>
          )}
          <p className="mt-3 text-xs text-muted-foreground">Language: {questionnaire.language.toUpperCase()}</p>
        </CardHeader>
        <CardContent className="pt-6 pb-8">
          <p className="mb-6 text-center text-lg font-medium text-slate-700 dark:text-slate-200">
            How would you like to take this questionnaire?
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Button
              asChild
              size="lg"
              className="h-auto py-4 text-base bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
            >
              <Link href={`/questionnaires/${id}/take/audio`}>
                <Mic className="mr-3 h-5 w-5" />
                Take with Audio
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-auto py-4 text-base border-slate-300 hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-700"
            >
              <Link href={`/questionnaires/${id}/take/visual`}>
                <Eye className="mr-3 h-5 w-5" />
                Take Visually
              </Link>
            </Button>
          </div>
        </CardContent>
        <CardFooter className="text-center justify-center">
            <Link href="/questionnaires" className="text-sm text-muted-foreground hover:text-primary hover:underline">
                Or choose a different questionnaire
            </Link>
        </CardFooter>
      </Card>
    </ParticipantLayout>
  );
}