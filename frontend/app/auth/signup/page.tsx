import { SignUpForm } from "@/components/auth/SignUpForm"; // Adjust path
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

export default async function SignUpRoutePage() {
  const session = await getServerSession(authOptions);
  if (session) {
    redirect("/"); // Redirect if already logged in
  }

  return (
     <div className="min-h-screen flex flex-col items-center justify-center bg-slate-100 dark:bg-slate-900 p-4">
      <SignUpForm />
    </div>
  );
}