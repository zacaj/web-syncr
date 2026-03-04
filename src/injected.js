function realUrlToWrapped(realUrl, sessionId, publicHost) {
  const newURL = new URL(realUrl);
  const baseUrl = new URL(realUrl).host;
  newURL.host = `${sessionId.toLowerCase()}__${baseUrl.replaceAll(/([^.])\.([^.])/g, `$1_$2`)}__.${publicHost}`;
  return newURL;
}

function wrapAndNavigate(realUrl, sessionId) {
  location.assign(realUrlToWrapped(realUrl, sessionId, new URL(location.href).host.split(`__.`)[1]));
};

function toggleSessions() {
  const e = document.getElementById(`sessions`);
  e.style.display = e.style.display != `none` ? `none` : `block`;
}
