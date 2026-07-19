# Outside-World Mechanic — Patentability & Prior-Art Memo

**Date:** 2026-07-18
**Status:** research memo — **NOT legal advice.**
**Method:** web-search prior-art landscape + an adversarial refutation pass (two independent agents). This is **not** a formal patent-classification/claim search. Unpublished applications and foreign art were almost certainly missed. Every patent number and the one cited paper must be pulled and read in full by a **registered patent practitioner** before anyone relies on this.

---

## Bottom line up front

**You probably cannot get a broad, commercially blocking patent here. Realistic odds of even a narrow, enforceable claim are LOW.** The idea decomposes into three pillars, and each is individually anticipated or obvious:

1. **World generated from a deterministic real-location seed** → **anticipated outright** by **Activision US12296271B2** ("GPS seed for game play," active, priority 2019, expires ~2039). It even names maze layouts. *Your existing `anchorSeed` already reads on this today.* Do not try to claim this pillar standalone.
2. **A local/ultrasonic beacon proving presence in a bounded area → reward** → **heavily encumbered**: **Shopkick** (encrypted ultrasonic store-ID → presence → reward), **IBM US10833869B2** (a landmark device emitting a *time-varying cryptographic* HOTP pattern captured as presence proof → voucher; now lapsed, so it's free prior art), and **LISNR's ~131-patent** data-over-audio thicket (also a *freedom-to-operate* landmine).
3. **Scale reward by verification confidence ("the ladder")** → the distinguishing limitation we hoped for is **factually false as stated**: **Zynga (US8282491B2 / US10881954B2 family)** already "correlate[s] the rarity of an incentive reward with a difficulty level of the location-based action," and enumerates verification methods of differing robustness — i.e. reward *value* already gated by *proof strength*. Step-up/risk-based authentication (US20060282660A1) makes "scale anything by a confidence score" an obvious §103 move, with a live §101 abstractness problem for any claim phrased as a business rule about reward magnitude.

The adversarial pass also killed the two angles we thought were strongest:
- **The two-way "interchangeable routes" system** → anticipated by **US20090227374A1** ("seamless mobility of location-based gaming across virtual and physical worlds" — physical caches map 1:1 to virtual caches; a remote user reaches the *same* objective in-game instead of traveling) and **Niantic US20230173389** ("Travel of Virtual Characters"). Geocaching-awards-a-video-game-prize (US8485878B2) covers the physical→game bridge.
- **The proof-strength-score → tiered reward pipeline** → pre-published by an April-2026 paper on graduated trust gating for location verification (multi-signal integrity score → graduated tiers → escalate to a zero-knowledge proximity proof → differentiate reward by confidence). *(This citation is future-dated relative to some priorities and was surfaced by web search — verify it exists and its date before relying on it.)*

---

## The one sliver that might survive

A **hyper-narrow apparatus claim** — not the *idea* "better proof = better loot," but a specific, disclosed **mechanism**:

> A beacon confined to a bounded physical area that derives a **continuous spoof-resistance scalar** from a *named, concrete fusion* of measurements (e.g. a specified round-trip-time distribution **combined with** hardware device-attestation), and injects that exact scalar as a specified parameter into the **loot RNG's value/rarity probability distribution** via a disclosed transfer function, with the loot **co-seeded from the same location**.

Claimed at the level of the *measurement-to-RNG-parameter mathematics* (concrete equations), never as the concept. Even this faces: an obvious-combination rejection stacking IBM + Shopkick + graduated-trust + Zynga + Activision; live §101 abstractness; and FTO exposure to LISNR/Shopkick. Enforceability: low.

---

## Prior-art landscape (verify each before relying)

| Reference | Holder | Covers | Why it matters |
|---|---|---|---|
| **US12296271B2** GPS seed for game play | Activision | GPS → seed → procedural world; same place = same world | Anticipates pillar 1; reads on `anchorSeed` today |
| **US8282491B2 / US10881954B2** location incentives | Zynga | physical action → in-game reward; **rarity scaled by action difficulty**; ladder of verification methods | Kills the "we scale value by proof strength" distinction |
| **US9604131B1** verify player proximity | Google/Niantic | server issues indicator; proximity confirmed before expiry; rewards proximate players | Binary-unlock building block for §103 |
| **US10833869B2** securing geo-physical presence | IBM (lapsed) | landmark device emits time-varying crypto (HOTP) pattern; capture = presence proof → voucher | Closest to the "novel beacon"; free prior art |
| **Shopkick** US9264151B1 / US9886696B2 / US10795018B2 | Shopkick | encrypted **ultrasonic** store-ID → mic decode → server presence → reward | Anticipates ultrasonic-beacon-for-loot; FTO risk |
| **LISNR Radius** (~131 patents) | LISNR | data-over-audio proximity + auth + gamified loyalty | FTO thicket for any ultrasonic build |
| **US20090227374A1** cross virtual/physical mobility | — | physical caches ↔ virtual caches; reach same objective either way | Kills the "interchangeable routes" angle |
| **US20230173389** Travel of Virtual Characters | Niantic | reach a remote real-location objective by in-game travel | Kills the game→reality direction |
| **US8485878B2** geocaching → video-game prize | — | travel to real GPS cache → virtual prize in a game | Kills the physical→game bridge |
| **US9861889B2** location strategy game | QONQR (age/lapse risk) | real cities = shared battle zones; hyper-local proximity benefits | "real place = shared game world" is old |
| **US20060282660A1** tiered/risk-based auth | — | confidence-scored step-up authentication | Makes "scale by confidence" obvious (§103/§101) |
| **US9355518B2** gaming with location confidence | — | confidence threshold gates play eligibility | Confidence-gating is known |

---

## Recommendation

1. **Ship the game; don't gate it on IP.** The mechanic is great gameplay regardless of whether it's patentable.
2. **If you still want to try:** engage a **registered patent practitioner** for a real patentability + freedom-to-operate search *before* any public disclosure or filing (note: the public GitHub repo and the marketing site may already start a disclosure clock in some jurisdictions — ask counsel).
3. **File narrow if at all** — the concrete beacon-measurement-to-loot-RNG transfer function (with real math in the spec), not the concept.
4. **Mind FTO more than patenting:** LISNR/Shopkick could be a problem for *you shipping* an ultrasonic beacon, independent of whether you patent anything. Counsel should assess this before T2/T3 is built.
5. **The honest framing:** this is a genuinely novel-feeling *game*, standing on a *well-trodden* patent landscape. The value is the execution and the lore, not a monopoly.

*All citations here were gathered by automated web search and an adversarial review; treat them as leads for a professional, not as verified legal conclusions.*
