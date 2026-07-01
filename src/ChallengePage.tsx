import { h } from 'preact';
import { renderToStringAsync } from 'preact-render-to-string';

export function ChallengePage({ challengeName, realUrl, sessionId, vnc }: {
  challengeName: string;
  realUrl: string;
  sessionId: string;
  vnc: string;
}) {
  const safeUrl = realUrl.replace(/</g, `&lt;`);
  const safeChallenge = challengeName.replace(/</g, `&lt;`);

  const body = <body>
    <div id="challenge-bar" key="bar">
      <h2 key="h2">{safeChallenge} challenge</h2>,
      <code key="code" title={safeUrl}>{safeUrl}</code>,
      <span className="hint" key="hint">Solve in the browser below, then click Done.</span>,
      <span id="poll-status" key="poll-status">Auto-checking in 20s…</span>,
      <button id="done-btn" onClick={`poll()` as Hack} key="done-btn">Done — Check Now</button>,
    </div>,
    <iframe src={vnc.replace(/"/g, `&quot;`)} key="iframe" />,
    <script key="script">{`
var SESSION_ID=${JSON.stringify(sessionId)},REAL_URL=${JSON.stringify(realUrl)},countdown=20,timer;
function tick(){
  countdown--;
  var s=document.getElementById('poll-status');
  if(countdown>0){s.textContent='Auto-checking in '+countdown+'s…';}
  else{clearInterval(timer);s.textContent='Checking…';poll();}
}
async function poll(){
  try{
    var r=await fetch('/__poll-challenge?sessionId='+encodeURIComponent(SESSION_ID)+'&url='+encodeURIComponent(REAL_URL));
    var d=await r.json();
    if(!d.pending){location.reload();return;}
  }catch(e){}
  countdown=20;
  document.getElementById('poll-status').textContent='Auto-checking in 20s…';
  timer=setInterval(tick,1000);
}
timer=setInterval(tick,1000);
`}</script>,
  </body>;

  const style = `
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0f0f14;color:#e0e0e0;display:flex;flex-direction:column;height:100vh;overflow:hidden}
    #challenge-bar{padding:10px 16px;background:#1a1a2e;border-bottom:2px solid #e94560;display:flex;align-items:center;gap:12px;flex-shrink:0}
    #challenge-bar h2{font-size:14px;color:#e94560;white-space:nowrap}
    #challenge-bar code{font-size:12px;color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40vw}
    #challenge-bar .hint{font-size:12px;color:#888;flex:1}
    #done-btn{padding:7px 14px;background:#e94560;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;white-space:nowrap}
    #done-btn:hover{background:#c73350}
    #poll-status{font-size:12px;color:#888;white-space:nowrap}
    iframe{flex:1;border:none;width:100%;display:block}
  `;

  return <html><head><title>Challenge pending — {safeChallenge}</title><style>{style}</style></head>{body}</html>;
}
