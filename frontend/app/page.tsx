"use client"
import Head from 'next/head';
import Link from 'next/link';
import { Button } from "@/components/ui/button"; // Shadcn Button
import { Mic, Users, Edit3, ArrowRight, BarChart3, ShieldCheck } from 'lucide-react'; // Icons
import { signOut, useSession } from 'next-auth/react'; // To show different CTAs if logged in

export default function LandingPage() {
  const { data: session, status } = useSession();

  return (
    <>
      <Head>
        <title>VoiceQ - Accessible Voice Questionnaires</title>
        <meta name="description" content="Easily create and administer questionnaires using voice for enhanced accessibility." />
        <link rel="icon" href="/favicon.ico" /> {/* Make sure you have a favicon */}
      </Head>

      <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-50 to-blue-100 dark:from-slate-900 dark:to-blue-900 text-slate-800 dark:text-slate-200">
        {/* Navigation Bar (Simple for Landing) */}
        <nav className="w-full p-4 sm:p-6 bg-white/80 dark:bg-slate-950/80 backdrop-blur-md shadow-sm sticky top-0 z-50">
          <div className="container mx-auto flex justify-between items-center">
            <Link href="/" className="text-2xl sm:text-3xl font-bold text-blue-600 dark:text-blue-400">
              Voice<span className="text-slate-700 dark:text-slate-300">Q</span>
            </Link>
            <div className="space-x-2 sm:space-x-4">
              {status === "loading" ? (
                <Button variant="ghost" disabled>Loading...</Button>
              ) : session ? (
                <>
                    <Link href="/researcher" passHref >
                      <Button variant="outline">Researcher Dashboard</Button>
                    </Link>
                
                  <Button variant="ghost" onClick={() => signOut()}>Sign Out</Button>
                </>
              ) : (
                <>
                  <Link href="/auth/signin" passHref>
                    <Button variant="ghost">Researcher Login</Button>
                  </Link>
                  {/* We might not have a public sign-up for researchers directly on landing page
                      It could be an invite system or a separate registration flow if needed.
                      For now, login is the primary researcher CTA.
                  */}
                </>
              )}
            </div>
          </div>
        </nav>

        {/* Hero Section */}
        <main className="flex-grow flex flex-col items-center justify-center text-center px-4 sm:px-6 py-12 sm:py-20">
          <Mic className="w-20 h-20 sm:w-28 sm:h-28 text-blue-500 dark:text-blue-400 mb-6 animate-pulse-slow" />
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-extrabold mb-6 text-slate-900 dark:text-slate-100">
            Accessible Questionnaires, <span className="text-blue-600 dark:text-blue-400">Voiced.</span>
          </h1>
          <p className="max-w-xl sm:max-w-2xl text-lg sm:text-xl text-slate-600 dark:text-slate-300 mb-10">
            VoiceQ makes psychological tests and surveys accessible to everyone by enabling voice-based interaction.
            Perfect for individuals with reading difficulties or visual impairments.
          </p>
          <div className="flex flex-col sm:flex-row space-y-4 sm:space-y-0 sm:space-x-6">
            <Link href="/questionnaires" passHref >
              <Button size="lg" className="bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 text-white text-lg px-8 py-6">
                Take a Questionnaire <ArrowRight className="ml-2 h-5 w-5" />
              </Button>
            </Link>
            {/* Conditional CTA for researchers if not logged in */}
            {!session && status !== "loading" && (
                <Link href="/auth/signin?callbackUrl=/researcher/dashboard" passHref >
                    <Button size="lg" variant="outline" className="text-lg px-8 py-6 border-blue-500 text-blue-500 hover:bg-blue-50 dark:border-blue-400 dark:text-blue-400 dark:hover:bg-blue-900/30">
                        For Researchers <Users className="ml-2 h-5 w-5" />
                    </Button>
                </Link>
            )}
          </div>
        </main>

        {/* Features Section (Optional, can be expanded) */}
        <section className="w-full py-12 sm:py-20 bg-white dark:bg-slate-800">
          <div className="container mx-auto px-4 sm:px-6 space-y-12">
            <h2 className="text-3xl sm:text-4xl font-bold text-center text-slate-800 dark:text-slate-100 mb-12">
              Why VoiceQ?
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 sm:gap-12">
              <FeatureCard
                icon={<Mic className="w-10 h-10 text-blue-500" />}
                title="Voice-First Interaction"
                description="Participants respond using their voice, making it intuitive and accessible."
              />
              <FeatureCard
                icon={<Edit3 className="w-10 h-10 text-green-500" />}
                title="Easy for Researchers"
                description="Upload existing PDF questionnaires, and we'll convert them for voice and visual use."
              />
              <FeatureCard
                icon={<ShieldCheck className="w-10 h-10 text-purple-500" />}
                title="Secure & Private"
                description="All audio processing (TTS/STT) is done locally on your chosen backend. Data privacy is key."
              />
            </div>
          </div>
        </section>
        
        {/* Footer */}
        <footer className="w-full text-center p-6 sm:p-8 text-sm text-slate-500 dark:text-slate-400">
          <p>© {new Date().getFullYear()} VoiceQ. Making research more inclusive.</p>
        </footer>
      </div>
    </>
  );
}

// Simple Feature Card component for the landing page
interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
}
function FeatureCard({ icon, title, description }: FeatureCardProps) {
  return (
    <div className="flex flex-col items-center text-center p-6 bg-slate-50 dark:bg-slate-700/50 rounded-xl shadow-lg hover:shadow-xl transition-shadow">
      <div className="p-4 bg-blue-100 dark:bg-blue-900/50 rounded-full mb-4">
        {icon}
      </div>
      <h3 className="text-xl font-semibold mb-2 text-slate-700 dark:text-slate-200">{title}</h3>
      <p className="text-slate-600 dark:text-slate-300 text-sm">{description}</p>
    </div>
  );
}