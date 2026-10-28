// Landing step for a visitor who arrives from another site (src/judge.js explains why). The browser does not send the session cookie on a navigation that
// starts on another site, so the demo cannot recognise this visitor on that request. This moves on to the same page from the demo's own address, where
// the cookie is sent. The target is one fixed path plus the part after # (which never leaves the browser): nothing else is read, kept or sent.
location.replace('/?entry=1' + location.hash);
