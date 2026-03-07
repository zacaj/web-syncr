import type { JsonDate } from '@common/util';
import { h } from 'preact';
import type { SessionHead } from './server';

export function Home({ currentUrl, sessions }: { currentUrl: string; sessions?: SessionHead[] }) {
  return <div>
    <div>
      <p>No base URL or session id found in {currentUrl}.</p>
      <p>Would you like to start a new session?</p>
      <form action="/" method="post">
        <input type="url" name="url" placeholder="URL to sync" style="width: 100%" />
        <button type="submit">Go</button>
      </form>
    </div>
    {!sessions? <div>
      <h3>Login</h3>
      <form action="/login" method="post" style={{ display: `flex` }}>
        <input type="text" name="username" placeholder="email@domain.com" />
        <input type="password" name="password" />
        <button type="submit">Login</button>
      </form>
    </div>
      :
      <div>
        <h3>Previous Sessions</h3>
        {sessions.map(s => <button type="button" onClick={`navigateToSessionId('${s.sessionId}')` as Hack}>{s.name} - {s.sessionId}</button>)}
      </div>
    }
  </div>;
};
