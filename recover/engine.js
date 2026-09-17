// recover/engine.js — the recovery engine core.
//
// Trails are DATA: a case is a JSON manifest of "stations", each with a hashed
// gate. This file is the pure, browser-side logic every case shares:
//   - normalize + salted SHA-256 gate checks (answers never sit in page source)
//   - a keyring in localStorage (what this browser has read)
//   - linear progression (each instrument opens the next)
//   - the note seal: each instrument's note and the closing file ship encrypted,
//     and open only with keys derived from the answers this browser filed
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

  // ── keyring ── (a read mark set in this page also holds in memory, for browsers whose storage throws)
  var memSolved = {};
  function kkey(caseId, stationId) { return 'cs.case.' + caseId + '.' + stationId; }
  function isSolved(caseId, stationId) {
    try { if (localStorage.getItem(kkey(caseId, stationId)) === '1') return true; } catch (e) {}
    return memSolved[kkey(caseId, stationId)] === true;
  }
  function markSolved(caseId, stationId) { memSolved[kkey(caseId, stationId)] = true; try { localStorage.setItem(kkey(caseId, stationId), '1'); } catch (e) {} }

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
  // These helpers compute proximity in the browser for the fallback read (no live door on the atlas, or the
  // relay unreachable): the position is compared here and dropped. When the landmark IS a live unsealed door,
  // index.html instead posts the position once to the relay's existing check-in, which verifies proximity and
  // stores no coordinates. Nothing here is ever stored.
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

  // ── the field-read seal: an honour flag set when a place-read instrument was read AT the
  // place (the relay's door check-in answered 201). It never gates anything; it changes the
  // reward's closing text when every place-read instrument of a case was walked.
  function fieldKey(caseId, stationId) { return kkey(caseId, stationId) + '.field'; }
  function isFieldRead(caseId, stationId) { try { return localStorage.getItem(fieldKey(caseId, stationId)) === '1'; } catch (e) { return false; } }
  function markFieldRead(caseId, stationId) { try { localStorage.setItem(fieldKey(caseId, stationId), '1'); } catch (e) {} }
  function fieldComplete(manifest) {
    var geo = ((manifest && manifest.stations) || []).filter(function (s) { return s.geo; });
    return geo.length > 0 && geo.every(function (s) { return isFieldRead(manifest.id, s.id); });
  }

  window.Recover = { SALT: SALT, normalize: normalize, sha256hex: sha256hex, gateHash: gateHash,
                     checkGate: checkGate, isSolved: isSolved, markSolved: markSolved, progress: progress,
                     haversineM: haversineM, withinM: withinM,
                     isFieldRead: isFieldRead, markFieldRead: markFieldRead, fieldComplete: fieldComplete };

  // ── the note seal (v1). A case built sealed ships each instrument's note as onSolveSealed and the closing file as
  // rewardSealed (AES-256-GCM). A correct filing derives this instrument's key from (case, instrument, normalized
  // answer) with HKDF; the key — never the answer — is kept beside the read mark:
  //   cs.case.<case>.<station>.key = '1:' + base64url(key)
  // Not '1' and not a bare instrument id, so no counter of read marks (the picker, the home page, the atlas) counts it.
  // The closing file opens only with the keys of every instrument. This stops READING the file, not SEARCHING: short
  // answers can still be found offline against the public gate. src/renderer/recover-seal.js in the game repo is the
  // same code; a shared vector file proves they agree.
  // Wrapped so that a browser missing anything below still gets every export above.
  try {
    (function () {
      var R = window.Recover;
      var SEAL = 1, SEAL_SALT = 'cornerspore:seal:1';
      function utf8(s) { return new TextEncoder().encode(String(s)); }
      function b64u(u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
      function unb64u(str) {
        str = String(str == null ? '' : str);
        if (!/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) throw new Error('bad base64url');
        var s = str.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
        var bin = atob(s), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        if (b64u(out) !== str) throw new Error('non-canonical base64url');
        return out;
      }
      function concatBytes(list) { var n = 0, i; for (i = 0; i < list.length; i++) n += list[i].length; var out = new Uint8Array(n), o = 0; for (i = 0; i < list.length; i++) { out.set(list[i], o); o += list[i].length; } return out; }
      async function hkdf(ikm, info) {
        var k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
        return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: utf8(SEAL_SALT), info: utf8(info) }, k, 256));
      }
      function stationSecret(caseId, stationId, answer) { var n = normalize(answer); if (!n) return Promise.reject(new Error('empty answer')); return hkdf(utf8(n), 'station|' + caseId + '|' + stationId); }
      function textKey(caseId, stationId, secret) { return hkdf(secret, 'onSolve|' + caseId + '|' + stationId); }
      async function rewardKey(caseId, stationIds, secrets) {
        if (!secrets.length || secrets.some(function (x) { return !x || !ArrayBuffer.isView(x) || x.length !== 32; })) throw new Error('need one 32-byte secret per instrument');
        return hkdf(concatBytes(secrets), 'reward|' + caseId + '|' + stationIds.join(','));
      }
      // the plaintext string, or null on ANY failure — never throws
      async function openBlob(keyBytes, blob) {
        try {
          if (!keyBytes || !blob || typeof blob.iv !== 'string' || typeof blob.ct !== 'string') return null;
          var iv = unb64u(blob.iv), ct = unb64u(blob.ct);
          if (iv.length !== 12 || ct.length < 17) return null;
          var k = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
          return new TextDecoder('utf-8', { fatal: true }).decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv, tagLength: 128 }, k, ct));
        } catch (e) { return null; }
      }
      // can this browser open a seal at all? (once per page)
      var supportP = null;
      function sealSupported() {
        if (!supportP) supportP = (async function () {
          try {
            var k = await hkdf(utf8('probe'), 'probe');
            var ak = await crypto.subtle.importKey('raw', k, { name: 'AES-GCM' }, false, ['encrypt']);
            var iv = new Uint8Array(12), ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, tagLength: 128 }, ak, utf8('ok')));
            return (await openBlob(k, { iv: b64u(iv), ct: b64u(ct) })) === 'ok';
          } catch (e) { return false; }
        })();
        return supportP;
      }

      function sealKnown(m) { return !!m && (m.seal == null || m.seal === SEAL); }
      function isSealed(m) { return !!m && m.seal === SEAL; }

      function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
      function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
      var memKeys = {};
      function secretName(c, s) { return kkey(c, s) + '.key'; }
      function keepSecret(c, s, secret) { var v = SEAL + ':' + b64u(secret); memKeys[secretName(c, s)] = v; return lsSet(secretName(c, s), v); }
      function secretOf(c, s) {
        function pick(v) {
          if (typeof v !== 'string' || v.indexOf(SEAL + ':') !== 0) return null;
          try { var b = unb64u(v.slice(String(SEAL).length + 1)); return b.length === 32 ? b : null; } catch (e) { return null; }
        }
        return pick(lsGet(secretName(c, s))) || pick(memKeys[secretName(c, s)]);
      }

      // this browser's copy — while a case still ships unsealed, what this browser already SHOWS is kept, so a player
      // who read before the seal is not locked out of it later: cs.case.<case>.<station>.note and
      // cs.case.<case>.reward.seen (dotted names, never '1', so no read-mark counter counts them)
      var REWARD_FIELDS = ['title', 'text', 'fieldText', 'key', 'href', 'linkLabel'];
      function rewardJson(r) { var o = {}; REWARD_FIELDS.forEach(function (k) { if (r && r[k] !== undefined) o[k] = r[k]; }); return JSON.stringify(o); }
      function noteCopyName(c, s) { return kkey(c, s) + '.note'; }
      function rewardCopyName(c) { return 'cs.case.' + c + '.reward.seen'; }
      function keepNoteCopy(c, s, text) { if (typeof text === 'string' && text && lsGet(noteCopyName(c, s)) !== text) lsSet(noteCopyName(c, s), text); }
      function noteCopy(c, s) { var v = lsGet(noteCopyName(c, s)); return typeof v === 'string' && v ? v : null; }
      function keepRewardCopy(c, r) { if (r && typeof r.title === 'string') { var v = rewardJson(r); if (lsGet(rewardCopyName(c)) !== v) lsSet(rewardCopyName(c), v); } }
      function rewardCopy(c) { try { var r = JSON.parse(lsGet(rewardCopyName(c))); return r && typeof r === 'object' && typeof r.title === 'string' && typeof r.text === 'string' ? r : null; } catch (e) { return null; } }

      // file an answer: the gate decides; on a pass the key is derived and kept BEFORE the read mark is set.
      // -> { ok: false } | { ok: true, kept: bool }. kept is false only when this browser cannot derive keys; the read
      // mark is set anyway (a filing never costs progress).
      async function fileAnswer(manifest, station, input) {
        if (!(await checkGate(input, station.gate))) return { ok: false, kept: false };
        var kept = false;
        try { keepSecret(manifest.id, station.id, await stationSecret(manifest.id, station.id, input)); kept = true; } catch (e) {}
        markSolved(manifest.id, station.id);
        return { ok: true, kept: kept };
      }

      // the note this instrument's kept key opens, or null (memoised per key and blob)
      var opened = {};
      async function openByKey(manifest, station) {
        var sec = secretOf(manifest.id, station.id), blob = station.onSolveSealed || {};
        if (!sec) return null;
        var memo = manifest.id + '|' + station.id + '|' + b64u(sec) + '|' + blob.iv + '|' + blob.ct;
        if (!(memo in opened)) { try { opened[memo] = await openBlob(await textKey(manifest.id, station.id, sec), blob); } catch (e) { return null; } }
        return opened[memo];
      }
      // does this instrument's kept key open its own note? (the definition of a usable key)
      async function hasKey(manifest, station) { return (await openByKey(manifest, station)) != null; }

      // a read instrument's note -> { text, from: 'plain' | 'key' | 'copy' } | null (nothing this browser can open)
      async function openStation(manifest, station) {
        try {
          if (!sealKnown(manifest)) return null;
          if (!isSealed(manifest)) {
            var t = String(station.onSolve || '');
            if (isSolved(manifest.id, station.id)) keepNoteCopy(manifest.id, station.id, t);
            return { text: t, from: 'plain' };
          }
          var k = await openByKey(manifest, station);
          if (k != null) return { text: k, from: 'key' };
          var c = noteCopy(manifest.id, station.id);
          return c != null ? { text: c, from: 'copy' } : null;
        } catch (e) { return null; }
      }

      // the closing file -> { none } no reward · { reward, from } opened (from: 'plain' | 'key' | 'copy') ·
      // { missing: [stations] } keys this browser lacks · { error, newer? } · { unsupported } no crypto here
      async function openReward(manifest) {
        try {
          if (!sealKnown(manifest)) return { error: true, newer: true };
          if (!isSealed(manifest)) {
            if (!manifest.reward) return { none: true };
            if (progress(manifest).complete) keepRewardCopy(manifest.id, manifest.reward);
            return { reward: manifest.reward, from: 'plain' };
          }
          if (!manifest.rewardSealed) return { none: true };
          var st = manifest.stations || [], missing = [], secrets = [];
          for (var i = 0; i < st.length; i++) {
            if (await hasKey(manifest, st[i])) secrets.push(secretOf(manifest.id, st[i].id)); else missing.push(st[i]);
          }
          if (missing.length) {
            var copy = rewardCopy(manifest.id);
            if (copy) return { reward: copy, from: 'copy' };
            if (!(await sealSupported())) return { unsupported: true };
            return { missing: missing };
          }
          var txt = await openBlob(await rewardKey(manifest.id, st.map(function (s) { return s.id; }), secrets), manifest.rewardSealed);
          var rw = JSON.parse(txt);
          if (rw && typeof rw === 'object' && typeof rw.title === 'string' && typeof rw.text === 'string') return { reward: rw, from: 'key' };
        } catch (e) {}
        return { error: true };
      }

      var ex = { SEAL: SEAL, sealKnown: sealKnown, isSealed: isSealed, sealSupported: sealSupported, b64u: b64u, unb64u: unb64u,
                 stationSecret: stationSecret, textKey: textKey, rewardKey: rewardKey, openBlob: openBlob,
                 keepSecret: keepSecret, secretOf: secretOf, hasKey: hasKey, noteCopy: noteCopy, rewardCopy: rewardCopy,
                 fileAnswer: fileAnswer, openStation: openStation, openReward: openReward };
      for (var k in ex) R[k] = ex[k];
    })();
  } catch (e) {}
})();
