"use client";

import { useState, FormEvent } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react"; // For auto-signin after signup

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserRole } from "@prisma/client"; // Assuming Prisma client types are available
import { toast } from "sonner";
import { Separator } from "@/components/ui/separator";
import { Loader2 } from "lucide-react";


const validRoles = [UserRole.USER, UserRole.RESEARCHER] as const;
const signupFormSchema = z.object({
    name: z.string().min(2, { message: "Name must be at least 2 characters." }).max(50),
    email: z.string().email({ message: "Please enter a valid email address." }),
    password: z.string().min(8, { message: "Password must be at least 8 characters." }),
    confirmPassword: z.string(),
    role: z.nativeEnum(UserRole), // .default(UserRole.USER) entfernt
  }).refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match.",
    path: ["confirmPassword"],
  });
  

type SignupFormValues = z.infer<typeof signupFormSchema>;

export function SignUpForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isSubmitting, setIsSubmitting] = useState(false);
  

  const form = useForm<SignupFormValues>({
    resolver: zodResolver(signupFormSchema)
  });

  async function onSubmit(values: SignupFormValues) {
    setIsSubmitting(true);
    const toastId = toast.loading("Creating your account...");

    try {
      const response = await fetch('/api/auth/register', { // Ensure this API route exists
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          email: values.email,
          password: values.password,
          role: UserRole.USER,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Something went wrong during sign up.");
      }

      toast.success("Account created! Signing you in...", { id: toastId });

      const callbackUrl = searchParams.get("callbackUrl") || "/";
      const signInResponse = await signIn('credentials', {
        redirect: false,
        email: values.email,
        password: values.password,
        // callbackUrl, // Not needed here if redirect:false
      });

      if (signInResponse?.error) {
        toast.error(`Sign in after registration failed: ${signInResponse.error}. Please sign in manually.`);
        router.push(`/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`);
      } else if (signInResponse?.ok) {
        router.push(callbackUrl);
      } else {
         toast.error("Account created, but auto sign-in failed. Please sign in manually.");
         router.push(`/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`);
      }

    } catch (error: any) {
      console.error("Sign up error:", error);
      toast.error(error.message || "An unexpected error occurred.", { id: toastId });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Card className="w-full max-w-md shadow-xl dark:bg-slate-800">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">Create an Account</CardTitle>
        <CardDescription className="text-slate-600 dark:text-slate-400">
          Enter your details to get started.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
       {/* //@ts-ignore */} {/* This is a JSX comment, not a TS directive, so it has no effect */}
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormField control={form.control} name="name" render={({ field }) => ( <FormItem><FormLabel>Full Name</FormLabel><FormControl><Input placeholder="John Doe" {...field} /></FormControl><FormMessage /></FormItem>)} />
            <FormField control={form.control} name="email" render={({ field }) => ( <FormItem><FormLabel>Email Address</FormLabel><FormControl><Input type="email" placeholder="you@example.com" {...field} /></FormControl><FormMessage /></FormItem>)} />
            <FormField control={form.control} name="password" render={({ field }) => ( <FormItem><FormLabel>Password</FormLabel><FormControl><Input type="password" placeholder="••••••••" {...field} /></FormControl><FormMessage /></FormItem>)} />
            <FormField control={form.control} name="confirmPassword" render={({ field }) => ( <FormItem><FormLabel>Confirm Password</FormLabel><FormControl><Input type="password" placeholder="••••••••" {...field} /></FormControl><FormMessage /></FormItem>)} />
            <FormField control={form.control} name="role" render={({ field }) => (
              <FormItem>
                <FormLabel>I am a...</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl><SelectTrigger><SelectValue placeholder="Select your role" /></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value={UserRole.USER}>Participant / Test Taker</SelectItem>
                    <SelectItem value={UserRole.RESEARCHER}>Researcher</SelectItem>
                  </SelectContent>
                </Select>
                <FormDescription>Researchers can create and manage questionnaires.</FormDescription>
                <FormMessage />
              </FormItem>
            )} />
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isSubmitting ? "Creating Account..." : "Sign Up"}
            </Button>
          </form>
        </Form>
      </CardContent>
      <CardFooter className="flex flex-col items-center space-y-2 pt-6">
        <Separator className="mb-4"/>
        <p className="text-sm text-center text-slate-600 dark:text-slate-400">
          Already have an account?{" "}
          <Link href="/auth/signin" className="font-medium text-primary hover:underline dark:text-blue-400">
            Sign In
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}