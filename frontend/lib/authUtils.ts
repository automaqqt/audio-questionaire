import { getSession } from 'next-auth/react';
import { GetServerSidePropsContext, GetServerSidePropsResult } from 'next';
import { UserRole } from '@prisma/client';

export async function requireResearcherAuth(
  context: GetServerSidePropsContext,
  callback?: (session: any) => Promise<GetServerSidePropsResult<any> | { props: any }>
): Promise<GetServerSidePropsResult<any>> {
  const session = await getSession(context);

  if (!session || session.user?.role !== UserRole.RESEARCHER) {
    return {
      redirect: {
        destination: `/auth/signin?callbackUrl=${encodeURIComponent(context.resolvedUrl)}`,
        permanent: false,
      },
    };
  }
  if (callback) {
    return callback(session);
  }
  return { props: { session } }; // Pass session by default
}