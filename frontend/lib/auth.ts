// pages/api/auth/[...nextauth].ts
import NextAuth, { NextAuthOptions } from 'next-auth'; // Import Provider type
import { PrismaAdapter } from '@next-auth/prisma-adapter';
import prisma from './prisma';

import CredentialsProvider from 'next-auth/providers/credentials';
import GoogleProvider from 'next-auth/providers/google';

import bcrypt from 'bcryptjs';

// Log environment variables for debugging
console.log("--- NextAuth Env Vars ---");
console.log("GOOGLE_CLIENT_ID:", process.env.GOOGLE_CLIENT_ID ? "SET" : "NOT SET");
console.log("GOOGLE_CLIENT_SECRET:", process.env.GOOGLE_CLIENT_SECRET ? "SET" : "NOT SET");
console.log("NEXTAUTH_SECRET:", process.env.NEXTAUTH_SECRET ? "SET" : "NOT SET");
console.log("NEXTAUTH_URL:", process.env.NEXTAUTH_URL ? "SET" : "NOT SET");
console.log("DATABASE_URL:", process.env.DATABASE_URL ? "SET" : "NOT SET");
console.log("--- End NextAuth Env Vars ---");


const providers: any[] = [ // Explicitly type as Provider[]
  CredentialsProvider({
    name: "Credentials",
    credentials: {
      email: { label: "Email", type: "text" },
      password: { label: "Password", type: "password" },
    },
    async authorize(credentials) {
      if (!credentials?.email || !credentials?.password) {
        throw new Error("Missing email or password");
      }
      // Example using Prisma (ensure user model has passwordHash)
      const user = await prisma.user.findUnique({ where: { email: credentials.email } });
      if (user && user.passwordHash && await bcrypt.compare(credentials.password, user.passwordHash)) {
        return { id: user.id, name: user.name, email: user.email, role: user.role, image: user.image };
      }
      // Fallback to your test user if DB user not found or password mismatch
      // if (credentials?.email === "test@example.com" && credentials.password === "123") {
      //   return { id: "1", name: "Test User", email: "test@example.com", role: "USER" }; // Assuming role
      // }
      console.error("Credentials authorization failed for:", credentials.email);
      return null;
    },
  }),
];

// Conditionally add GoogleProvider only if its credentials are set
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    })
  );
  console.log("GoogleProvider configured.");
} else {
  console.warn("GoogleProvider NOT configured because GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing.");
}

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma), // Assuming you want Prisma adapter
  providers: providers, // Use the dynamically built providers array
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        // @ts-ignore
        token.role = user.role;
      }
      return token;
    },
    async session({ session, token }) {
      if (token?.id && session.user) {
        session.user.id = token.id as string;
      }
      if (token?.role && session.user) {
        // @ts-ignore
        session.user.role = token.role;
      }
      return session;
    },
  },
  // secret: process.env.NEXTAUTH_SECRET, // Automatically picked up from env
  // debug: process.env.NODE_ENV === 'development',
  // pages: {
  //   signIn: '/auth/signin',
  // },
};

export default authOptions;