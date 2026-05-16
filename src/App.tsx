import { Amplify } from 'aws-amplify';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useEffect, useState } from 'react';
import { ChatView } from './components/ChatView';
import { CONFIG } from './config';

// CDK Cognito に接続
Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: CONFIG.userPoolId,
      userPoolClientId: CONFIG.userPoolClientId,
    },
  },
});

function AppInner() {
  const [role, setRole] = useState<string>('general');

  useEffect(() => {
    (async () => {
      try {
        const session = await fetchAuthSession();
        // cognito:groups は access token の payload に含まれる
        const payload = session.tokens?.accessToken?.payload;
        const groups = (payload?.['cognito:groups'] as string[]) ?? [];
        setRole(groups.includes('manager') ? 'manager' : 'general');
      } catch {
        setRole('general');
      }
    })();
  }, []);

  return <ChatView userRole={role} />;
}

export default function App() {
  return (
    <Authenticator loginMechanisms={['email']}>
      {() => <AppInner />}
    </Authenticator>
  );
}
