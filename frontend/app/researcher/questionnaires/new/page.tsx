"use client"
import ResearcherLayout from "@/components/layouts/ResearcherLayout";
import { QuestionnaireForm, QuestionnaireFormValues } from "@/components/researcher/QuestionaireForm";
import { useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation"; 

export default function NewQuestionnairePage() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const router = useRouter();

  const handleSubmit = async (values: QuestionnaireFormValues, formData: FormData) => {
    setIsSubmitting(true);
    toast.loading("Uploading and initiating processing...", {id: "upload-process"});

    try {
      console.log(values)
      const formDatas = new FormData();
      formDatas.append("pdf_file", values.pdfFile[0]); // File object
      formDatas.append("title", values.title);           // String
      formDatas.append("language", values.language);
      console.log(formDatas.values().toArray())
      const response = await fetch("/api/researcher/questionnaires", {
        method: "POST",
          body: formDatas
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || "Failed to upload questionnaire.");
      }
      router.push("/researcher/questionnaires");
      toast.success(result.message || "Questionnaire submitted! Processing may take a few minutes.", {id: "upload-process", duration: 5000});
      // Redirect to the questionnaire list page after a delay or immediately
      

    } catch (error: any) {
      console.error("Submission error:", error);
      toast.error(`Error: ${error.message || "An unknown error occurred."}`, {id: "upload-process"});
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ResearcherLayout pageTitle="Add New Questionnaire">
      <div className="flex justify-center">
        <QuestionnaireForm onSubmit={handleSubmit} isSubmitting={isSubmitting} />
      </div>
    </ResearcherLayout>
  );
}
