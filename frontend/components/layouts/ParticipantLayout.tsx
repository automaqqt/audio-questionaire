import { ReactNode } from 'react';
import { Toaster } from "@/components/ui/sonner";

interface ParticipantLayoutProps {
  children: ReactNode;
  questionnaireTitle?: string;
}

export default function ParticipantLayout({ children, questionnaireTitle }: ParticipantLayoutProps) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-100 dark:bg-slate-900 p-4 sm:p-6">
      <header className="w-full  max-w-3xl mb-6 text-center">
       {/*  {questionnaireTitle ? (
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-700 dark:text-slate-200">
            {questionnaireTitle}
          </h1>
        ) : (
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-700 dark:text-slate-200">
            Voice Questionnaire
          </h1>
        )} */}
      </header>
      <main className="w-full max-w-3xl">
        {children}
      </main>
      <footer className="w-full max-w-3xl mt-8 text-center text-xs text-slate-500 dark:text-slate-400">
        <p>© {new Date().getFullYear()} Voice App Solutions. Powered by a desire for accessibility.</p>
      </footer>
      <Toaster richColors position="top-center" />
    </div>
  );
}