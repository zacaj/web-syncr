import type { Opaque } from '@zacaj/util';
import { h, type TargetedEvent } from 'preact';
import { useState } from "preact/hooks";
import type { LoadMode, Session } from './config';
import { realUrlToWrapped } from './urls';

(globalThis as Hack).wrapAndNavigate = (realUrl: string, sessionId: string) => {
  location.assign(realUrlToWrapped(realUrl, sessionId, new URL(location.href).host.split(`__.`)[1]!));
};

export function Header({ session, history, mode }: {
  session: Session&{ sessionId: string };
  history: Session[];
  mode: LoadMode;
}) {
  // const [s, setS] = useState(1);
  return <div style={{ top: 0, right: 0, left: 0, background: `lightyellow`, color: `black`, zIndex: 2147483647, padding: `0.25rem`, position: `fixed`, display: `flex`, flexDirection: `row`, gap: `1rem`, pointerEvents: `all` }}>
    {/* <span>Session: {session.sessionId}</span> */}

    {!!history[0] && session.timestamp < history[0].timestamp &&
      <button type="button"
        data-url={history[0].url}
        data-sid={session.sessionId}
        onClick={`wrapAndNavigate(this.dataset.url, this.dataset.sid)` as Hack}>
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
    <div id="sessions" style={{ position: `absolute`, zIndex: 1000, left: 0, right: 0, top: `100%`, display: `none` }}>
      <div style={{ display: `flex`, flexDirection: `column`, gap: `1rem`, background: `white` }}>
        {history.map(s => <button type="button"
          data-url={s.url}
          data-sid={session.sessionId}
          onClick={`wrapAndNavigate(this.dataset.url, this.dataset.sid)` as Hack}>{s.url.replaceAll(/(www\.|https?|:\/\/)/g, ``)} - {s.timestamp}</button>)}
      </div>
    </div>

    <select
      value={mode}
      data-sid={session.sessionId}
      onChange={`setSessionMode(this.dataset.sid, this.value)` as Hack}
    >
      <option value="proxy">proxy</option>
      <option value="magicurl">magicurl</option>
    </select>

    <form action="/" method="post">
      <div style={ { display: `flex`, flexDirection: `row`, gap: `1rem` }}>
        <input type="url" name="url" placeholder="New URL" style="width: 100%" />
        <button type="submit">Go</button>
      </div>
    </form>
  </div>;
};
