"use client"
import Link from 'next/link';
import { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { signOut, useSession } from 'next-auth/react';
import { Home, ListChecks, FileText, BarChart2, UserCircle, LogOut, Settings } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { Toaster } from "@/components/ui/sonner" // For notifications

interface ResearcherLayoutProps {
  children: ReactNode;
  pageTitle?: string; // Optional page title to display in the header
}

export default function ResearcherLayout({ children, pageTitle }: ResearcherLayoutProps) {
  const { data: session } = useSession();

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-900">
      <header className="sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between">
          <Link href="/researcher" className="text-xl font-bold text-primary sm:text-2xl">
            VoiceQ Researcher
          </Link>
          <div className="flex items-center space-x-4">
            {session && (
              <>
                <span className="text-sm text-muted-foreground hidden sm:inline">
                  {session.user?.name || session.user?.email}
                </span>
                <Button variant="ghost" size="sm" onClick={() => signOut({ callbackUrl: '/' })}>
                  <LogOut className="mr-2 h-4 w-4" /> Logout
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="container flex flex-1 mt-4 mb-8"> {/* Added margin top/bottom */}
        {/* Sidebar Navigation */}
        <aside className="hidden w-64 flex-col space-y-2 border-r bg-background p-4 pr-6 md:flex">
          <nav className="flex flex-col space-y-1">
            <NavItem href="/researcher" icon={<Home />}>Dashboard</NavItem>
            <NavItem href="/researcher/questionnaires" icon={<ListChecks />}>Questionnaires</NavItem>
            {/* <NavItem href="/researcher/results" icon={<BarChart2 />}>Results</NavItem> */}
            {/* <Separator className="my-2" />
            <NavItem href="/researcher/settings" icon={<Settings />}>Settings</NavItem> */}
          </nav>
        </aside>

        {/* Main Content */}
        <main className="flex-1 p-1 md:p-6 md:pl-10 overflow-y-auto"> {/* Adjusted padding */}
          {pageTitle && (
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-6">
              {pageTitle}
            </h1>
          )}
          {children}
        </main>
      </div>
      <Toaster richColors closeButton /> {/* For Shadcn Sonner notifications */}
    </div>
  );
}

function NavItem({ href, icon, children }: { href: string; icon: ReactNode, children: ReactNode }) {
  // TODO: Add active state highlighting later using useRouter().pathname
  return (
    <Link
      href={href}
      className="group flex items-center space-x-3 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors duration-150"
    >
      <span className="h-5 w-5 transition-colors group-hover:text-primary">{icon}</span>
      <span>{children}</span>
    </Link>
  );
}