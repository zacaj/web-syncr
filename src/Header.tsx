import type { Opaque } from '@zacaj/util';
import { h, type TargetedEvent } from 'preact';
import { useState } from "preact/hooks";
import type { LoadMode, Session, SyncMode } from './config';
import { realUrlToWrapped } from './urls';

(globalThis as Hack).wrapAndNavigate = (realUrl: string, sessionId: string) => {
  location.assign(realUrlToWrapped(realUrl, sessionId, new URL(location.href).host.split(`__.`)[1]!));
};

export function Header({ session, history, mode, syncMode = `off` }: {
  session: Session&{ sessionId: string };
  history: Session[];
  mode: LoadMode;
  syncMode?: SyncMode;
}) {
  // const [s, setS] = useState(1);
  return <div id="web-syncr-header" style={{ top: 0, right: 0, left: 0, background: `lightyellow`, color: `black`, zIndex: 2147483647, padding: `0.25rem`, position: `fixed`, display: `flex`, flexDirection: `row`, flexWrap: `wrap`, alignItems: `center`, gap: `1rem`, pointerEvents: `all` }}>
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
      id="web-syncr-mode"
      value={mode}
      data-sid={session.sessionId}
      onChange={`setSessionMode(this.dataset.sid, this.value)` as Hack}
    >
      <option value="proxy" selected={mode === `proxy` ? true : undefined}>proxy</option>
      <option value="magicurl" selected={mode === `magicurl` ? true : undefined}>magicurl</option>
      {/* For sites whose own JS breaks the proxy — see LoadMode in config.ts.
          Non-default: only worth reaching for when a page actually misbehaves,
          since it also disables any site feature that genuinely needs scripts. */}
      <option value="magicurl-noscript" selected={mode === `magicurl-noscript` ? true : undefined}>magicurl (no scripts)</option>
    </select>

    {/* Reading-position sync. The pill is the sole indicator+action for "the
        other device is somewhere else" — filled in and shown/hidden by
        injected.js, which polls periodically so a tab left open still notices
        a move on another device without needing a reload. */}
    <select
      id="web-syncr-sync"
      value={syncMode}
      data-sid={session.sessionId}
      onChange={`setSyncMode(this.dataset.sid, this.value)` as Hack}
    >
      <option value="off" selected={syncMode === `off` ? true : undefined}>sync: off</option>
      <option value="manual" selected={syncMode === `manual` ? true : undefined}>sync: manual</option>
      <option value="live" selected={syncMode === `live` ? true : undefined}>sync: live</option>
    </select>
    <span id="web-syncr-pill" style={{ display: `none`, alignItems: `center`, gap: `0.5rem`, background: `#fff8`, border: `1px solid #0003`, borderRadius: `999px`, padding: `0.15rem 0.75rem 0.15rem 0.9rem` }}></span>

    <form action="/" method="post">
      <div style={ { display: `flex`, flexDirection: `row`, gap: `1rem` }}>
        <input type="url" name="url" placeholder="New URL" style="width: 100%" />
        <button type="submit">Go</button>
      </div>
    </form>
  </div>;
};
