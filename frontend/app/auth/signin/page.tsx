"use client";

import { signIn, useSession, ClientSafeProvider, LiteralUnion, getProviders } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, FormEvent } from "react";
import Link from "next/link";
import { BuiltInProviderType } from "next-auth/providers/index";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Mail, KeyRound, LogIn, AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface SignInFormProps {
  providers: Record<LiteralUnion<BuiltInProviderType, string>, ClientSafeProvider> | null;
  // csrfToken?: string; // NextAuth v4 often handles CSRF automatically for credentials form
}

export default function SignInForm() {
  const { data: session, status } = useSession();
  const [providers, setProviders] = useState<Record<LiteralUnion<BuiltInProviderType, string>, ClientSafeProvider> | null>(null);
  
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  useEffect(() => {
    const fetchAuthData = async () => {
      const prov = await getProviders();
      setProviders(prov);
    };
    fetchAuthData();
  }, []);
  // Pre-fill error from NextAuth callback (e.g., if ?error=CredentialsSignin is in URL)
  useEffect(() => {
    const callbackError = searchParams.get("error");
    if (callbackError) {
      let friendlyError = "Sign in failed. Please check your credentials or try another method.";
      if (callbackError === "CredentialsSignin") {
        friendlyError = "Invalid email or password provided.";
      } else if (callbackError === "OAuthAccountNotLinked") {
        friendlyError = "This email is already linked with another provider. Try signing in with that provider.";
      }
      // Add more specific error messages as needed
      setError(friendlyError);
      // Optionally clear the error from URL to prevent re-showing on refresh
      // router.replace('/signin', { scroll: false }); // Or current path
    }
  }, [searchParams, router]);


  useEffect(() => {
    if (status === "authenticated") {
      const callbackUrl = searchParams.get("callbackUrl") || "/";
      router.push(callbackUrl);
    }
  }, [status, router, searchParams]);

  const handleCredentialsSignIn = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    const toastId = toast.loading("Signing in...");

    const callbackUrl = searchParams.get("callbackUrl") || "/";
    const result = await signIn('credentials', {
      redirect: false,
      email,
      password,
      // callbackUrl, // Not needed here if redirect:false, as we handle it
    });

    setIsSubmitting(false);
    toast.dismiss(toastId);

    if (result?.error) {
      let friendlyError = "Sign in failed. Please check your credentials.";
      if (result.error === "CredentialsSignin") {
        friendlyError = "Invalid email or password. Please try again.";
      }
      setError(friendlyError);
      toast.error(friendlyError);
    } else if (result?.ok) { // result.ok indicates success when redirect:false
      toast.success("Signed in successfully! Redirecting...");
      router.push(callbackUrl); // Manually redirect
    } else {
      setError("An unexpected error occurred during sign in.");
      toast.error("An unexpected error occurred during sign in.");
    }
  };

  if (status === "loading" && !error) { // Show loader only if no error displayed from callback
    return (
      <div className="flex flex-col items-center justify-center min-h-[300px]">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <p className="mt-4 text-muted-foreground">Loading session...</p>
      </div>
    );
  }
  // If authenticated, useEffect will redirect. Showing a message here is fine.
  if (status === "authenticated") {
     return (
      <div className="flex flex-col items-center justify-center min-h-[300px]">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <p className="mt-4 text-muted-foreground">Redirecting...</p>
      </div>
    );
  }
  console.log(providers)

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-100 dark:bg-slate-900 p-4">
    <Card className="w-full max-w-md shadow-xl dark:bg-slate-800">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">Sign In</CardTitle>
        <CardDescription className="text-slate-600 dark:text-slate-400">
          Welcome back! Please enter your credentials.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Authentication Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {//@ts-ignore
        providers?.credentials && (
          <form onSubmit={handleCredentialsSignIn} className="space-y-4">
            {/* CSRF token is usually handled automatically by NextAuth for POSTs to its endpoints */}
            {/* <input name="csrfToken" type="hidden" defaultValue={csrfToken} /> */}
            <div className="space-y-1">
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input id="email" name="email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required className="pl-10"/>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="password">Password</Label>
               <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input id="password" name="password" type="password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} required className="pl-10"/>
              </div>
            </div>
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isSubmitting ? "Signing In..." : "Sign In with Email"}
            </Button>
          </form>
        )}

        {Object.values(providers || {}).filter(p => p.id !== 'credentials').length > 0 && (
           <>
              <div className="relative my-6">
                  <div className="absolute inset-0 flex items-center"><Separator /></div>
                  <div className="relative flex justify-center text-xs uppercase">
                      <span className="bg-background px-2 text-muted-foreground">Or continue with</span>
                  </div>
              </div>
              {Object.values(providers || {}).map((provider) => {
                  if (provider.id === "credentials") return null;
                  const callbackUrl = searchParams.get("callbackUrl") || "/";
                  return (
                  <div key={provider.name} className="mt-4">
                      <Button variant="outline" className="w-full" onClick={() => signIn(provider.id, { callbackUrl })} disabled={isSubmitting}>
                      {/* Add provider specific icons here if desired */}
                      {/* e.g. provider.id === 'google' && <GoogleIcon className="mr-2 h-5 w-5" /> */}
                      Sign in with {provider.name}
                      </Button>
                  </div>
                  );
              })}
           </>
        )}
      </CardContent>
      <CardFooter className="flex flex-col items-center space-y-2 pt-6">
        <Separator className="mb-4"/>
        <p className="text-sm text-center text-slate-600 dark:text-slate-400">
          Don't have an account?{" "}
          <Link href="/auth/signup" className="font-medium text-primary hover:underline dark:text-blue-400">
            Sign Up
          </Link>
        </p>
      </CardFooter>
    </Card>
    </div>
  );
}