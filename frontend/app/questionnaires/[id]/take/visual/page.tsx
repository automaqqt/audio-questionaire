import VisualQuestionnaire from '@/components/participant/VisualQuestionnaire'; // Adjust path
import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';

interface VisualPageProps {
  params: Promise<{
    id: string; // Questionnaire ID from the URL
  }>;
}

export default async function TakeVisualQuestionnairePage(props: VisualPageProps) {
  const params = await props.params;
  const { id } = params;

  if (!id) {
    return (
      // Basic layout for error display if ParticipantLayout can't be used without title
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-red-500">Questionnaire ID not found.</p>
      </div>
    );
  }

  return (
    // Suspense can be used if VisualQuestionnaire itself fetches data client-side
    // or if there are other async operations.
    // For now, VisualQuestionnaire handles its own loading state.
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><Loader2 className="h-16 w-16 animate-spin text-primary"/></div>}>
      <VisualQuestionnaire questionnaireId={id} />
    </Suspense>
  );
}