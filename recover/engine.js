// recover/engine.js — the recovery engine core.
//
// Trails are DATA: a case is a JSON manifest of "stations", each with a hashed
// gate. This file is the pure, browser-side logic every case shares:
//   - normalize + salted SHA-256 gate checks (answers never sit in page source)
//   - a keyring in localStorage (what this browser has read)
//   - linear progression (each instrument opens the next)
// A station's answer may come from ANY surface — a real public archive, the
// website, a real place, or the maze (the game emits the same word) — the
// engine only ever sees the hash, so parity across surfaces is free.
(function () {
  var SALT = 'cornerspore:';

  function normalize(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  async function sha256hex(str) {
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  // the gate hash of a candidate answer — salted so the hash can't be googled
  async function gateHash(answer) { return sha256hex(SALT + normalize(answer)); }

  async function checkGate(input, gate) {
    if (!gate || !normalize(input)) return false;
    if (gate.type === 'sha256') return (await gateHash(input)) === String(gate.hash || '').toLowerCase();
    return false;
  }

  // ── keyring ──
  function kkey(caseId, stationId) { return 'cs.case.' + caseId + '.' + stationId; }
  function isSolved(caseId, stationId) { try { return localStorage.getItem(kkey(caseId, stationId)) === '1'; } catch (e) { return false; } }
  function markSolved(caseId, stationId) { try { localStorage.setItem(kkey(caseId, stationId), '1'); } catch (e) {} }

  // ── progression: linear — a station is open once the one before it is read ──
  function progress(manifest) {
    var st = (manifest && manifest.stations) || [];
    var out = [], prevSolved = true;
    for (var i = 0; i < st.length; i++) {
      var solved = isSolved(manifest.id, st[i].id);
      out.push({ station: st[i], state: solved ? 'solved' : (prevSolved ? 'open' : 'locked') });
      prevSolved = solved;
    }
    var solvedCount = out.filter(function (o) { return o.state === 'solved'; }).length;
    return { stations: out, solvedCount: solvedCount, complete: st.length > 0 && solvedCount === st.length };
  }

  // ── geo parity: a station may name a PUBLIC landmark where its key can be read on site.
  // Proximity is computed HERE, in the browser. The position never leaves the page, is
  // never stored, and only ever answers one question: is this device within the radius?
  function haversineM(lat1, lng1, lat2, lng2) {
    var R = 6371000, toR = function (d) { return d * Math.PI / 180; };
    var dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function withinM(pos, geo) {
    if (!pos || !geo || typeof geo.lat !== 'number' || typeof geo.lng !== 'number') return false;
    return haversineM(pos.lat, pos.lng, geo.lat, geo.lng) <= (geo.radiusM || 150);
  }

  window.Recover = { SALT: SALT, normalize: normalize, sha256hex: sha256hex, gateHash: gateHash,
                     checkGate: checkGate, isSolved: isSolved, markSolved: markSolved, progress: progress,
                     haversineM: haversineM, withinM: withinM };
})();
