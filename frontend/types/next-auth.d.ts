import NextAuth, { DefaultSession, DefaultUser } from "next-auth";
import { JWT, DefaultJWT } from "next-auth/jwt";
import { UserRole } from "@prisma/client"; // Import UserRole from generated Prisma types

declare module "next-auth" {
  /**
   * Returned by `useSession`, `getSession` and received as a prop on the `SessionProvider` React Context
   */
  interface Session {
    user: {
      id: string; // Add id
      role: UserRole; // Add role
    } & DefaultSession["user"]; // Keep existing properties like name, email, image
  }

  /** The OAuth profile returned from an OAuth provider */
  interface User extends DefaultUser { // Extend DefaultUser
    role: UserRole; // Add role here if needed for initial user object from authorize
  }
}

declare module "next-auth/jwt" {
  /** Returned by the `jwt` callback and `getToken`, when using JWT sessions */
  interface JWT extends DefaultJWT {
    id: string;
    role: UserRole;
  }
}