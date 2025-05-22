import SignInClientPage from './client-page'; // Importiere die umbenannte Client-Komponente
import { Suspense } from 'react';

// Optional: Eine Ladekomponente für den Fallback
function SignInPageLoading() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-100 dark:bg-slate-900 p-4">
      {/* Du könntest hier eine vereinfachte Version deiner Karten-UI als Skeleton anzeigen */}
      <div>Loading sign-in options...</div>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={<SignInPageLoading />}>
      <SignInClientPage />
    </Suspense>
  );
}