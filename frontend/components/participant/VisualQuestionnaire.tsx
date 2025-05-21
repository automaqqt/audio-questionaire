// components/participant/VisualQuestionnaire.tsx
"use client";

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation'; // Use from next/navigation
import { FullQuestionnaireClientType, QuestionWithAudioClientType } from '@/types/questionnaire'; // Define these types
import QuestionDisplay from './QuestionDisplay';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ArrowLeft, ArrowRight, CheckCircle, Send, Loader2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import ParticipantLayout from '../layouts/ParticipantLayout';


interface VisualQuestionnaireProps {
  questionnaireId: string;
}

type AnswersState = Record<string, string>; // { questionId: answerValue }

export default function VisualQuestionnaire({ questionnaireId }: VisualQuestionnaireProps) {
  const router = useRouter();
  const [pageState, setPageState] = useState<'loading' | 'taking' | 'submitting' | 'complete' | 'error'>('loading');
  const [questionnaire, setQuestionnaire] = useState<FullQuestionnaireClientType | null>(null);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState<number>(0);
  const [answers, setAnswers] = useState<AnswersState>({});
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');

  // Fetch questionnaire and start attempt
  useEffect(() => {
    async function initialize() {
      if (!questionnaireId) {
        setErrorMessage("Questionnaire ID is missing.");
        setPageState('error');
        return;
      }
      try {
        setPageState('loading');
        toast.loading("Loading questionnaire...", {id: "load-q"});
        // Fetch questionnaire data
        const qRes = await fetch(`/api/questionnaires/${questionnaireId}/public`);
        if (!qRes.ok) throw new Error(`Failed to load questionnaire (status ${qRes.status})`);
        const qData: FullQuestionnaireClientType = await qRes.json();
        setQuestionnaire(qData);

        // Create attempt record
        const attemptRes = await fetch('/api/attempts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ questionnaireId: qData.id, mode: 'VISUAL' }),
        });
        if (!attemptRes.ok) throw new Error('Failed to start questionnaire session.');
        const attemptData = await attemptRes.json();
        setAttemptId(attemptData.attemptId);

        setPageState('taking');
        toast.success("Questionnaire loaded. Let's begin!", {id: "load-q"});
      } catch (error: any) {
        console.error("Initialization error:", error);
        setErrorMessage(error.message || "Failed to initialize questionnaire.");
        toast.error(error.message || "Failed to initialize.", {id: "load-q"});
        setPageState('error');
      }
    }
    initialize();
  }, [questionnaireId]);

  const handleAnswerChange = useCallback((questionId: string, answer: string) => {
    setAnswers(prev => ({ ...prev, [questionId]: answer }));
  }, []);

  const saveCurrentAnswer = async () => {
    if (!attemptId || !questionnaire || !questionnaire.questions[currentQuestionIndex]) return false;
    const currentQuestion = questionnaire.questions[currentQuestionIndex];
    const answerValue = answers[currentQuestion.id];

    if (answerValue === undefined || answerValue === null || answerValue === '') {
        // Allow skipping if not explicitly required, or show validation
        // For now, let's assume answers are optional unless validated by form controls
        console.log(`No answer provided for Q${currentQuestion.order}, skipping save for this one.`);
        return true; // Allow navigation even if no answer, but don't save empty
    }

    try {
      const payload = {
        questionId: currentQuestion.id,
        visualResponse: answerValue, // Storing the selected value
        // transcribedResponse: null, // Not applicable for visual
        // parsedValue: null, // Not applicable for visual
        isConfirmed: true, // Visual selection is implicitly confirmed
      };
      const res = await fetch(`/api/attempts/${attemptId}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        toast.error(`Failed to save answer: ${errData.message || res.statusText}`);
        return false; // Prevent navigation if save fails
      }
      console.log(`Answer saved for Q${currentQuestion.order}`);
      return true;
    } catch (error: any) {
      toast.error(`Error saving answer: ${error.message}`);
      return false;
    }
  };

  const handleNext = async () => {
    if (!questionnaire) return;
    const saved = await saveCurrentAnswer();
    if (saved && currentQuestionIndex < questionnaire.questions.length - 1) {
      setCurrentQuestionIndex(prev => prev + 1);
    }
  };

  const handlePrevious = () => {
    // Saving on previous might be optional or not done, depending on UX preference
    // For simplicity, let's not save on previous for now, user must hit Next to save.
    if (currentQuestionIndex > 0) {
      setCurrentQuestionIndex(prev => prev - 1);
    }
  };

  const handleSubmitAll = async () => {
    if (!attemptId || !questionnaire) return;
    
    // Save the current question's answer before final submit
    const lastAnswerSaved = await saveCurrentAnswer();
    if (!lastAnswerSaved) {
        toast.error("Could not save the answer for the current question. Please try again or contact support.");
        return; // Prevent submission if last answer save fails
    }

    setPageState('submitting');
    toast.loading("Submitting your responses...", {id: "submit-all"});
    try {
      // Mark attempt as complete
      const completeRes = await fetch(`/api/attempts/${attemptId}/complete`, { method: 'PUT' });
      if (!completeRes.ok) throw new Error('Failed to finalize questionnaire.');

      setPageState('complete');
      toast.success("Questionnaire submitted successfully! Thank you.", {id: "submit-all"});
    } catch (error: any) {
      setPageState('taking'); // Revert state on error
      toast.error(`Submission error: ${error.message}`, {id: "submit-all"});
      setErrorMessage(error.message || "Failed to submit.");
    }
  };

  if (pageState === 'loading' || !questionnaire) {
    return <ParticipantLayout questionnaireTitle="Loading..."><div className="flex justify-center items-center min-h-[300px]"><Loader2 className="h-12 w-12 animate-spin text-primary" /></div></ParticipantLayout>;
  }
  if (pageState === 'error') {
    return <ParticipantLayout questionnaireTitle="Error"><div className="text-center p-8 bg-red-50 dark:bg-red-900/30 rounded-lg shadow"><AlertTriangle className="mx-auto h-12 w-12 text-red-500 dark:text-red-400" /><p className="mt-4 text-lg text-red-700 dark:text-red-300">{errorMessage}</p><Button onClick={() => router.push('/questionnaires')} className="mt-6">Back to List</Button></div></ParticipantLayout>;
  }
  if (pageState === 'complete') {
    return <ParticipantLayout questionnaireTitle={questionnaire.title}><div className="text-center p-8 bg-green-50 dark:bg-green-900/30 rounded-lg shadow"><CheckCircle className="mx-auto h-16 w-16 text-green-500 dark:text-green-400" /><h2 className="mt-4 text-2xl font-semibold text-green-700 dark:text-green-300">Thank You!</h2><p className="mt-2 text-muted-foreground">Your responses have been submitted.</p><Button onClick={() => router.push('/questionnaires')} className="mt-6">Back to Questionnaires</Button></div></ParticipantLayout>;
  }

  const currentQ = questionnaire.questions[currentQuestionIndex];
  const progressValue = ((currentQuestionIndex + 1) / questionnaire.questions.length) * 100;

  return (
    <ParticipantLayout questionnaireTitle={questionnaire.title}>
      <div className="space-y-8">
        <div className="text-center">
            <p className="text-sm font-medium text-muted-foreground">
                Question {currentQuestionIndex + 1} of {questionnaire.questions.length}
            </p>
            <Progress value={progressValue} className="w-full h-2 mt-1" />
        </div>

        {currentQ && (
          <QuestionDisplay
            key={currentQ.id} // Ensure re-render when question changes
            question={currentQ}
            currentAnswer={answers[currentQ.id]}
            onAnswerChange={handleAnswerChange}
            onNext={handleNext}
            isSubmitted={pageState === 'submitting'}
          />
        )}

        <div className="flex justify-between items-center pt-6 border-t dark:border-slate-700">
          <Button variant="outline" onClick={handlePrevious} disabled={currentQuestionIndex === 0 || pageState === 'submitting'}>
            <ArrowLeft className="mr-2 h-4 w-4" /> Previous
          </Button>
          {currentQuestionIndex < questionnaire.questions.length - 1 ? (
            <Button onClick={handleNext} disabled={pageState === 'submitting'} className="bg-primary hover:bg-primary/90">
              Next <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button disabled={pageState === 'submitting'} className="bg-green-600 hover:bg-green-700 dark:bg-green-500 dark:hover:bg-green-600">
                  {pageState === 'submitting' && <Loader2 className="mr-2 h-4 w-4 animate-spin"/>}
                  Submit All <Send className="ml-2 h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Ready to Submit?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Please confirm you want to submit all your answers. You won't be able to change them after this.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={pageState === 'submitting'}>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleSubmitAll} disabled={pageState === 'submitting'} className="bg-green-600 hover:bg-green-700">
                    Confirm & Submit
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>
    </ParticipantLayout>
  );
}