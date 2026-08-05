// Marker-precise doc patching (sync). Byte-surgical: only the targeted region's
// body and marker attrs (or the targeted anchor's bind string) change; every
// other byte of the file is preserved. Patching a file the tool doesn't fully
// understand is how you destroy human work - so anything ambiguous throws.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function findRegion(text, regionId) {
  const openRe = new RegExp(`<!--\\s*keeldocs:gen\\s+([^>]*?\\bid=${esc(regionId)}(?:\\s[^>]*?)?)\\s*-->`, "g");
  const m = openRe.exec(text);
  if (!m) throw new Error(`gen region ${regionId} not found`);
  if (openRe.exec(text)) throw new Error(`gen region ${regionId} appears more than once`);
  const openStart = m.index, openEnd = m.index + m[0].length;
  const close = text.indexOf("<!-- /keeldocs:gen -->", openEnd);
  if (close === -1) throw new Error(`gen region ${regionId} has no close marker`);
  return { openStart, openEnd, openMarker: m[0], bodyStart: openEnd, bodyEnd: close };
}

// Replace a gen region's body and refresh its hash=/content= attrs in place.
export function patchRegion(text, regionId, newBody, newHash, newContent) {
  const r = findRegion(text, regionId);
  let marker = r.openMarker;
  // Each attribute handled ONCE, independently. The previous shape appended
  // `content=` when it was absent and then, in a separate "no hash attr at all"
  // branch, appended `hash=` AND `content=` again - so a marker carrying neither
  // came back with content= twice and quarantined as `duplicate-key:content`,
  // taking its close marker down with it as `unbalanced-close`. That branch was
  // unreachable until a hashless region became reportable, and it turned a silent
  // false negative into a repair that corrupts the document it was repairing.
  const sub = (re, attr) => {
    marker = re.test(marker) ? marker.replace(re, attr) : marker.replace(/\s*-->$/, ` ${attr} -->`);
  };
  sub(/\bhash=h[0-9]+:[0-9a-f]+/, `hash=${newHash}`);
  sub(/\bcontent=h[0-9]+:[0-9a-f]+/, `content=${newContent}`);
  return text.slice(0, r.openStart) + marker + "\n" + newBody + "\n" + text.slice(r.bodyEnd);
}

// Replace a slot region's body and record the fact state it was written against.
export function patchSlot(text, slotId, newBody, newHash) {
  const openRe = new RegExp(`<!--\\s*keeldocs:slot\\s+([^>]*?\\bid=${esc(slotId)}(?:\\s[^>]*?)?)\\s*-->`, "g");
  const m = openRe.exec(text);
  if (!m) throw new Error(`slot ${slotId} not found`);
  if (openRe.exec(text)) throw new Error(`slot ${slotId} appears more than once`);
  const close = text.indexOf("<!-- /keeldocs:slot -->", m.index + m[0].length);
  if (close === -1) throw new Error(`slot ${slotId} has no close marker`);
  let marker = m[0];
  if (/\bhash=h[0-9]+:[0-9a-f]+/.test(marker)) marker = marker.replace(/\bhash=h[0-9]+:[0-9a-f]+/, `hash=${newHash}`);
  else marker = marker.replace(/\s*-->$/, ` hash=${newHash} -->`);
  return text.slice(0, m.index) + marker + "\n" + newBody + "\n" + text.slice(close);
}

// Rewrite one bind inside one anchor/gen marker identified by id.
export function patchBind(text, markerId, oldBind, newBind) {
  const re = new RegExp(`<!--\\s*keeldocs(?::gen)?:?\\s+[^>]*?\\bid=${esc(markerId)}(?:\\s[^>]*?)?\\s*-->`, "g");
  const m = re.exec(text);
  if (!m) throw new Error(`marker ${markerId} not found`);
  if (re.exec(text)) throw new Error(`marker ${markerId} appears more than once`);
  const marker = m[0];
  if (!marker.includes(oldBind)) throw new Error(`bind "${oldBind}" not present in marker ${markerId}`);
  const updated = marker.replace(oldBind, newBind);
  return text.slice(0, m.index) + updated + text.slice(m.index + marker.length);
}
