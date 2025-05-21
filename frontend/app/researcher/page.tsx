import ResearcherLayout from '@/components/layouts/ResearcherLayout';
import { GetServerSideProps } from 'next';
import { requireResearcherAuth } from '@/lib/authUtils'; // Your auth helper
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function DashboardPage() {
  
  return (
    <ResearcherLayout pageTitle="Dashboard">
      <Card>
        <CardHeader>
          <CardTitle>Welcome!</CardTitle>
        </CardHeader>
        <CardContent>
          <p>This is your researcher dashboard. Manage your questionnaires and view results here.</p>
          {/* Add more dashboard widgets later */}
        </CardContent>
      </Card>
    </ResearcherLayout>
  );
}

