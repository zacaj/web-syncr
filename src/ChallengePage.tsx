import { h } from 'preact';
import { renderToStringAsync } from 'preact-render-to-string';

/** JSON literal that is safe inside an inline <script> (can't close the tag or open a comment). */
function jsLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, `\\u003c`);
}

export function ChallengePage({ challengeName, realUrl, sessionId, vnc }: {
  challengeName: string;
  realUrl: string;
  sessionId: string;
  vnc: string;
}) {
  const safeUrl = realUrl.replace(/</g, `&lt;`);
  const safeChallenge = challengeName.replace(/</g, `&lt;`);

  // noVNC options: connect without the extra "Connect" click, and scale the
  // remote screen to the frame (a phone can't usefully show 1280px of desktop).
  // Deliberately no `reconnect`: x11vnc isn't `-shared`, so each new viewer
  // kicks the previous one, and two auto-reconnecting viewers (this iframe plus
  // the new-tab link, or two devices) kick each other off forever.
  const vncSrc = `${vnc}${vnc.includes(`?`) ? `&` : `?`}autoconnect=true&resize=scale`;

  const body = <body>
    <div id="challenge-bar" key="bar">
      <h2 key="h2">{safeChallenge} challenge</h2>,
      <code key="code" title={safeUrl}>{safeUrl}</code>,
      <span className="hint" key="hint">Solve in the browser below, then click Check Now.</span>,
      <span id="poll-status" key="poll-status">Waiting for the challenge to be solved…</span>,
      <a id="vnc-link" href={vncSrc.replace(/"/g, `&quot;`)} target="_blank" rel="noopener" onClick={`vncOpenedInTab=true;setVnc(false)` as Hack} key="vnc-link">Open browser in new tab</a>,
      <button id="done-btn" onClick={`checkNow()` as Hack} key="done-btn">Done — Check Now</button>,
    </div>,
    <iframe id="vnc" data-src={vncSrc.replace(/"/g, `&quot;`)} src="about:blank" key="iframe" />,
    <script key="script" dangerouslySetInnerHTML={{ __html: `
var SESSION_ID=${jsLiteral(sessionId)},REAL_URL=${jsLiteral(realUrl)},checking=false,reloading=false,vncOpenedInTab=false;
// Only the device actually showing this page holds a VNC connection: a phone
// with the page in a background tab shouldn't be streaming the remote screen
// (or, without x11vnc -shared, kicking the desktop's viewer off).
function setVnc(on){
  var f=document.getElementById('vnc');
  var want=on?f.getAttribute('data-src'):'about:blank';
  if(f.src!==want)f.src=want;
}
function syncVnc(){setVnc(!document.hidden&&!vncOpenedInTab);}
document.addEventListener('visibilitychange',syncVnc);
syncVnc();
function pollUrl(force){
  return '/__poll-challenge?sessionId='+encodeURIComponent(SESSION_ID)+'&url='+encodeURIComponent(REAL_URL)+(force?'&force=1':'');
}
function setStatus(text,isError){
  var s=document.getElementById('poll-status');
  s.textContent=text;
  s.className=isError?'error':'';
}
// One reload, ever: the poll and Check Now can both learn of success at once,
// and a second reload would abort the first navigation and start it over.
function solved(){
  if(reloading)return;
  reloading=true;
  setStatus('Solved — loading page…');
  location.reload();
}
// Cheap: only reads the last render, never starts one (a render of a still-
// unsolved page would replace the page being solved in VNC). Picks up Check Now
// from this or another device. Runs while hidden too — the VNC is often in
// another tab — though browsers may slow it there.
setInterval(function(){
  if(checking||reloading)return;
  fetch(pollUrl(false)).then(function(r){return r.json();}).then(function(d){
    if(!d)return;
    if(d.pending===false)solved();
    else if(d.checking)setStatus('Checking whether that solved it…');
    else if(document.getElementById('poll-status').className!=='error')setStatus('Waiting for the challenge to be solved…');
  }).catch(function(){});
},2000);
// Explicit: re-renders the page in magicurl, which is the only real test of
// whether the solve worked. Can take as long as a full render (~30s+).
async function checkNow(){
  if(checking||reloading)return;
  checking=true;
  var btn=document.getElementById('done-btn');
  btn.disabled=true;
  setStatus('Checking… (re-rendering the page, this can take ~30s)');
  var msg;
  try{
    var r=await fetch(pollUrl(true));
    var d=await r.json().catch(function(){return {error:'HTTP '+r.status+' '+r.statusText};});
    if(d.pending===false){solved();return;}
    msg=d.error?'Check failed: '+d.error:'Still blocked by '+(d.challenge||'the challenge')+' — finish it in the browser below, then check again.';
  }catch(e){
    msg='Check failed: '+(e&&e.message||e);
  }
  checking=false;
  btn.disabled=false;
  setStatus(msg,true);
  alert(msg);
}
` }} />,
  </body>;

  const style = `
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0f0f14;color:#e0e0e0;display:flex;flex-direction:column;height:100vh;overflow:hidden}
    #challenge-bar{padding:10px 16px;background:#1a1a2e;border-bottom:2px solid #e94560;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;flex-shrink:0}
    #challenge-bar h2{font-size:14px;color:#e94560;white-space:nowrap}
    #challenge-bar code{font-size:12px;color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40vw}
    #challenge-bar .hint{font-size:12px;color:#888;flex:1}
    #done-btn{padding:7px 14px;background:#e94560;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;white-space:nowrap}
    #done-btn:hover{background:#c73350}
    #done-btn:disabled{opacity:.6;cursor:wait}
    #vnc-link{font-size:12px;color:#8ab4f8;white-space:nowrap}
    #poll-status{font-size:12px;color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
    #poll-status.error{color:#ff8a80;white-space:normal}
    iframe{flex:1;border:none;width:100%;display:block}
  `;

  return <html><head><title>Challenge pending — {safeChallenge}</title><style>{style}</style></head>{body}</html>;
}
