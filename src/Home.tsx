import { h } from 'preact';

export function Home({ currentUrl }: { currentUrl: string }) {
  return <div>
    <p>No base URL or session id found in {currentUrl}.</p>
    <p>Would you like to start a new session?</p>
    <form action="/" method="post">
      <input type="url" name="url" placeholder="URL to sync" style="width: 100%" />
      <button type="submit">Go</button>
    </form>
  </div>;
};
