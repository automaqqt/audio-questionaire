"use client"
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation"; // Use next/navigation for app router like behavior

const MAX_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
export const formSchema = z.object({
  title: z.string().min(1, "Title is required"),
  language: z.string().min(1, "Language is required"),
  pdfFile: z.any()
});

export type QuestionnaireFormValues = z.infer<typeof formSchema>;

interface QuestionnaireFormProps {
  onSubmit: (values: QuestionnaireFormValues, formData: FormData) => Promise<void>;
  isSubmitting: boolean;
  initialData?: Partial<QuestionnaireFormValues>; // For edit mode later
}

export function QuestionnaireForm({ onSubmit, isSubmitting, initialData }: QuestionnaireFormProps) {
  const form = useForm<QuestionnaireFormValues>({
    resolver: zodResolver(formSchema), // formSchema von Versuch 1
    defaultValues: {
      title: initialData?.title || "",
      language: initialData?.language || "en", // Stelle sicher, dass ein Default existiert
      pdfFile: initialData?.pdfFile || (undefined as any), // RHF behandelt 'undefined' für File-Inputs oft korrekt
                                                          // Casting zu 'any' kann TS-Gemecker unterdrücken, wenn es 'FileList' erwartet
    },
  });

  const fileRef = form.register("pdfFile"); // To handle file input with react-hook-form

  async function handleFormSubmit(values: QuestionnaireFormValues) {
    const formData = new FormData();
    formData.append("title", values.title);
    formData.append("language", values.language);
    if (values.pdfFile && values.pdfFile.length > 0) {
      formData.append("pdfFile", values.pdfFile[0]);
    }
    await onSubmit(values, formData);
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>{initialData ? "Edit Questionnaire" : "Create New Questionnaire"}</CardTitle>
        <CardDescription>
          Upload a PDF document. It will be processed to extract questions.
        </CardDescription>
      </CardHeader>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(handleFormSubmit)}>
          <CardContent className="space-y-6">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Questionnaire Title</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., Wellbeing Survey for Students" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="language"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Primary Language of PDF</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select language" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="de">German (de)</SelectItem>
                      <SelectItem value="en">English (en)</SelectItem>
                      {/* Add more languages as needed */}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control} // Not using render prop here, just register
              name="pdfFile"
              render={({ field: { onChange, onBlur, name, ref } }) => ( // Destructure to pass ref
                <FormItem>
                  <FormLabel>PDF File</FormLabel>
                  <FormControl>
                    {/* Use Shadcn input with type="file" and Tailwind for styling */}
                    <Input 
                      type="file" 
                      accept="application/pdf" 
                      {...fileRef} // Spread the register result
                      className="dark:file:text-foreground" // Example Tailwind styling for file input
                    />
                  </FormControl>
                  <FormDescription>Max file size: 5MB.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={isSubmitting} className="w-full sm:w-auto">
              {isSubmitting ? "Uploading & Processing..." : (initialData ? "Save Changes" : "Upload & Process")}
            </Button>
          </CardFooter>
        </form>
      </Form>
    </Card>
  );
}