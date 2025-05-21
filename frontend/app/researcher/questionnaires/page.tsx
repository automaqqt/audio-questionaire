"use client"
import ResearcherLayout from '@/components/layouts/ResearcherLayout';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PlusCircle, MoreHorizontal, Edit3, Trash2, Eye, RefreshCw, AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Questionnaire as PrismaQuestionnaire, User as PrismaUser } from '@prisma/client'; // Prisma types
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { GetServerSideProps } from 'next';
import { requireResearcherAuth } from '@/lib/authUtils';
import prisma from '@/lib/prisma';
import { toast } from 'sonner';
import { useRouter } from 'next/router';
import { Card } from '@/components/ui/card';
import { useSession } from 'next-auth/react';

// Define a more specific type for the props
type QuestionnaireWithCreator = PrismaQuestionnaire & {
  creator: { name: string | null };
  _count?: { questions: number }; // If you want to show question count
};

interface QuestionnairesPageProps {
  initialQuestionnaires: QuestionnaireWithCreator[];
}

export default function QuestionnairesPage() {
  const [questionnaires, setQuestionnaires] = useState<QuestionnaireWithCreator[]>();
  const { data: session, status } = useSession();

  useEffect(() => {
    refreshQuestionnaires();
    }, []);

  // Function to re-fetch questionnaires - useful after delete/process
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
      toast.success("Questionnaire list refreshed.");
    } catch (error) {
        toast.error("Failed to refresh questionnaires.");
        console.error(error);
    }
  };
  
  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this questionnaire? This action cannot be undone.")) return;
    toast.loading("Deleting questionnaire...", { id: `delete-${id}` });
    try {
      const res = await fetch(`/api/researcher/questionnaires/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ message: 'Failed to delete' }));
        throw new Error(errorData.message || 'Failed to delete questionnaire');
      }
      toast.success("Questionnaire deleted successfully.", { id: `delete-${id}` });
      setQuestionnaires(prev => prev?.filter(q => q.id !== id));
    } catch (error: any) {
      toast.error(`Deletion failed: ${error.message}`, { id: `delete-${id}` });
      console.error(error);
    }
  };

  const handleProcess = async (id: string) => {
    toast.loading("Initiating processing...", { id: `process-${id}` });
    try {
        // This API route will trigger the synchronous Python script call
        const res = await fetch(`/api/researcher/questionnaires/${id}/process`, { method: 'POST' });
        if (!res.ok) {
            const errorData = await res.json().catch(() => ({ message: 'Processing request failed'}));
            throw new Error(errorData.message || 'Failed to start processing');
        }
        const result = await res.json();
        toast.success(result.message || "Processing completed. Refreshing list...", { id: `process-${id}` });
        refreshQuestionnaires(); // Re-fetch to show updated status
    } catch (error: any) {
        toast.error(`Processing failed: ${error.message}`, { id: `process-${id}` });
        console.error(error);
        refreshQuestionnaires(); // Still refresh to show potential error status on questionnaire
    }
  };

  return (
    <ResearcherLayout pageTitle="My Questionnaires">
      <div className="flex justify-between items-center mb-6">
        <p className="text-muted-foreground">Manage and create your voice-based questionnaires.</p>
        <div className="flex items-center space-x-2">
            <Button variant="outline" size="sm" onClick={refreshQuestionnaires}>
                <RefreshCw className="mr-2 h-4 w-4"/> Refresh
            </Button>
            <Link href="/researcher/questionnaires/new">
              <Button>
                <PlusCircle className="mr-2 h-5 w-5" /> Add New
              </Button>
            </Link>
        </div>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[250px]">Title</TableHead>
              <TableHead>Language</TableHead>
              <TableHead>Status</TableHead>
              {/* <TableHead>Questions</TableHead> */}
              <TableHead>Created At</TableHead>
              <TableHead className="text-right w-[100px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {questionnaires?.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  No questionnaires found.
                </TableCell>
              </TableRow>
            )}
            {questionnaires?.map((q) => (
              <TableRow key={q.id}>
                <TableCell className="font-medium">{q.title}</TableCell>
                <TableCell>{q.language?.toUpperCase() || 'N/A'}</TableCell>
                <TableCell>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    q.isProcessed ? 'bg-green-100 text-green-700 dark:bg-green-700/30 dark:text-green-300' : 
                    q.processingError ? 'bg-red-100 text-red-700 dark:bg-red-700/30 dark:text-red-300' : 
                                        'bg-yellow-100 text-yellow-700 dark:bg-yellow-700/30 dark:text-yellow-300'
                  }`}>
                    {q.isProcessed ? 'Processed' : q.processingError ? 'Error' : 'Draft / Pending'}
                  </span>
                  {q.processingError && (
                    <p className="text-xs text-red-500 mt-1 truncate max-w-[200px]" title={q.processingError}>
                        <AlertTriangle className="inline-block h-3 w-3 mr-1"/> {q.processingError}
                    </p>
                  )}
                </TableCell>
                {/* <TableCell>{q._count?.questions ?? 'N/A'}</TableCell> */}
                <TableCell>{new Date(q.createdAt).toLocaleDateString()}</TableCell>
                <TableCell className="text-right">
                   <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>Actions</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem asChild>
                        <Link href={`/questionnaires/${q.id}/take/audio`} className="flex items-center w-full cursor-pointer">
                            <Eye className="mr-2 h-4 w-4" /> View / Take
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleProcess(q.id)} disabled={q.isProcessed && !q.processingError}>
                        <RefreshCw className="mr-2 h-4 w-4" /> {q.isProcessed && !q.processingError ? 'Re-Process' : 'Process'}
                      </DropdownMenuItem>
                      {/* Add Edit link later */}
                      {/* <DropdownMenuItem asChild><Link href={`/researcher/questionnaires/edit/${q.id}`}>...</Link></DropdownMenuItem> */}
                       <DropdownMenuSeparator />
                       <DropdownMenuItem onClick={() => handleDelete(q.id)} className="text-red-500 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-700/20">
                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </ResearcherLayout>
  );
}
