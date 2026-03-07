import type { Opaque } from '@common/util';
import { h, type TargetedEvent } from 'preact';
import { useState } from "preact/hooks";
import { realUrlToWrapped, type Session } from './server';

(globalThis as Hack).wrapAndNavigate = (realUrl: string, sessionId: string) => {
  location.assign(realUrlToWrapped(realUrl, sessionId, new URL(location.href).host.split(`__.`)[1]!));
};

export function Header({ session, history }: {
  session: Session&{ sessionId: string };
  history: Session[];
}) {
  // const [s, setS] = useState(1);
  return <div style={{ top: 0, right: 0, left: 0, background: `lightyellow`, zIndex: 10000, padding: `0.25rem`, position: `relative`, display: `flex`, flexDirection: `row`, gap: `1rem` }}>
    <span>Session: {session.sessionId}</span>

    {!!history[0] && session.timestamp < history[0].timestamp &&
      // <button type="button" onClick={() =>
      //   location.assign(realUrlToWrapped(history[0]!.url, session.sessionId, new URL(location.href).host.split(`__.`)[1]!))
      // }>
      <button type="button" onClick={`wrapAndNavigate('${history[0].url}', '${session.sessionId}')` as Hack}>
        Latest
      </button>
    }

    {/* {s} */}
    {/* <button type="button" onClick={() => setS(s+1)}>+</button> */}
    {/* <select //value={session.timestamp} name="history"
      onChange={`e => wrapAndNavigate(e.target.value, '${session.sessionId}')` as Hack}
    // onChange={
    //   (((e) => e.target && location.assign(realUrlToWrapped(
    //     history.find(s => s.timestamp === (e.target as HTMLSelectElement).value)!.url,
    //     session.sessionId,
    //     new URL(location.href).host.split(`__.`)[1]!,
    //   ).href)) satisfies h.JSX.GenericEventHandler<HTMLSelectElement>).toString() as Hack}
    >
      {history.map(s =>
        <option value={s.url} key={s.timestamp} selected={s.timestamp === session.timestamp? true : undefined}
          // onClick={`wrapAndNavigate('${s.url}', '${session.sessionId}')` as Hack}
        >
          {s.url.replaceAll(/(www\.|https?|:\/\/)/g, ``)} - {s.timestamp}
        </option>,
      )}
    </select> */}
    <button type="button" onClick={`toggleSessions()` as Hack}>
      {new URL(session.url).pathname}
    </button>
    <div id="sessions" style={{ position: `absolute`, zIndex: 1000, left: 0, right: 0, bottom: 0, top: `100%`, display: `none` }}>
      <div style={{ display: `flex`, flexDirection: `column`, gap: `1rem` }}>
        {history.map(s => <button type="button" onClick={`wrapAndNavigate('${s.url}', '${session.sessionId}')` as Hack}>{s.url.replaceAll(/(www\.|https?|:\/\/)/g, ``)} - {s.timestamp}</button>)}
      </div>
    </div>

    {` `}

    <form action="/" method="post">
      <div style={ { display: `flex`, flexDirection: `row`, gap: `1rem` }}>
        <input type="url" name="url" placeholder="New URL" style="width: 100%" />
        <button type="submit">Go</button>
      </div>
    </form>
  </div>;
};
