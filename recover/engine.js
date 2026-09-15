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

  window.Recover = { SALT: SALT, normalize: normalize, sha256hex: sha256hex, gateHash: gateHash,
                     checkGate: checkGate, isSolved: isSolved, markSolved: markSolved, progress: progress };
})();
