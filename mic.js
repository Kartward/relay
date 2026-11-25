/* mic.js — voice input mode, driven by four distinct media keys (no counting, no gesture window).
 *
 * Loaded by index.html BEFORE its inline script: it wraps
 * navigator.mediaSession.setActionHandler so setupMediaSession()'s relay handlers
 * are kept, and so ?cal=1 binds its calibration handlers directly.
 *
 * Bindings (Button Mapper) — every action fires on the event
 *   seekforward   volume-up single    RELAY: enter voice mode + record
 *                                     CONFIRM: discard transcript, record again
 *                                     IDLE / SPEAKING: record (interrupts a reply)
 *                                     RECORDING: ignored   TRANSCRIBING / THINKING: busy tick
 *   nexttrack     volume-up double    CONFIRM: send to handle()        elsewhere in voice mode: busy tick
 *   previoustrack volume-down single  CONFIRM: read the transcript again   elsewhere in voice mode: busy tick
 *   stop          volume-down double  voice mode, any state: leave
 *   In RELAY, nexttrack / previoustrack / stop keep today's handlers (skip / replay / stop).
 * A recording ends only on silence (silenceEndMs) or at the 60 s cap.
 *
 * Globals from index.html, looked up at call time only:
 *   handle, Player (q, busy, paused, current, last, enqueue, flush), AudioEngine (ctx, out),
 *   setStatus, speakNow, speakUtter, cfg (key), CAL, RelayHooks (ready, stop, start)
 *
 * Exposes: window.ModeController, window.Mic
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ tuning */
  const CFG = {
    dedupe: 80,         // ms: the same action delivered twice (MediaSession + keydown) within this is one event

    confirmMs: 20000,   // CONFIRM: unsent transcript is discarded this long after the read-back ends
    confirmHint: 'Double-press volume up to send.',
    pulseMs: 1000,      // busy pulse interval while transcribing
    enterLeadMs: 340,   // relay -> voice: let the "voice on" tone finish before the start tone

    noSpeechMs: 5000,   // no speech onset within this => cancel, nothing uploaded
    silenceEndMs: 800,  // trailing silence after speech => stop and transcribe
    maxMs: 60000,       // hard cap; still transcribes
    warnMs: 50000,      // vibration warning
    minSpeechMs: 300,   // less detected speech than this => not uploaded
    calibMs: 250,       // noise-floor calibration at recording start
    vadFrameMs: 20,
    vadOnsetMs: 60,
    vadMin: 0.012,      // absolute RMS floor for speech
    vadFactor: 3,       // threshold = max(vadMin, factor * noise floor)...
    vadMaxThr: 0.06,    // ...capped, so speech during calibration cannot push it above speech level
    tailMs: 120,        // gap after the start tone (+ outputLatency) before the mic is live

    sttUrl: 'https://api.openai.com/v1/audio/transcriptions',
    sttModel: 'gpt-4o-mini-transcribe',
    sttTimeout: 15000,
    sttBackoff: [1000, 3000], // 2 retries, network / 429 / 5xx only
    language: 'en'            // ISO-639-1 for transcription; 'en' only, never auto-detect
  };

  /* ---------------------------------------------------------------- helpers */
  const isCal = () => { try { return typeof CAL !== 'undefined' && !!CAL; } catch (e) { return false; } };
  const now = () => performance.now();
  const safe = (fn) => { try { return fn(); } catch (e) { return undefined; } };
  const buzz = (p) => safe(() => navigator.vibrate && navigator.vibrate(p));
  const say = (text) => safe(() => speakNow(text));
  const show = (text) => safe(() => setStatus(text, 'self'));   // status line only, no earcon
  const sleep = (ms, sig) => new Promise((res) => {
    const t = setTimeout(res, ms);
    if (sig) sig.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
  });

  // Reloaded while in voice mode? The page always boots in RELAY; index.html keeps the
  // relay cursor instead of starting a fresh session (see Mic.keepCursor).
  const LS_MODE = 'mic.mode';
  const resumedFromVoice = safe(() => localStorage.getItem(LS_MODE)) === 'MIC';
  safe(() => localStorage.setItem(LS_MODE, 'RELAY'));
  let cursorKept = false;

  /* ------------------------------------------------------------------ tones
   * Through AudioEngine.out (the master gain), so they are silent while recording. */
  const TONES = {
    start:        [[880, 0, 0.06]],                                       // recording starts
    transcribing: [[440, 0, 0.05], [554, 0.08, 0.05], [659, 0.16, 0.08]], // recording ended, wait
    busy:         [[200, 0, 0.05]],                                       // busy pulse / ignored press
    confirm:      [[659, 0, 0.05], [988, 0.07, 0.09]],                    // transcript ready, read-back follows
    sent:         [[520, 0, 0.05], [780, 0.07, 0.08]],                    // accepted, sent to handle()
    expired:      [[494, 0, 0.06], [349, 0.09, 0.10]],                    // CONFIRM timed out, discarded
    repeat:       [[660, 0, 0.04], [660, 0.09, 0.04]],                    // repeat / read again
    voiceon:      [[440, 0, 0.12], [660, 0.12, 0.20]],                    // entering voice mode: rising
    voiceoff:     [[660, 0, 0.12], [440, 0.12, 0.20]],                    // leaving voice mode: falling
    soft:         [[300, 0, 0.05], [300, 0.10, 0.05]],                    // nothing heard / nothing to send
    error:        [[160, 0, 0.28]]                                        // any failure (followed by speech)
  };
  function tone(name) {
    const seq = TONES[name] || [];
    let end = 0;
    try {
      const ctx = AudioEngine.ctx, out = AudioEngine.out;
      if (ctx.state === 'suspended') ctx.resume();
      const t0 = ctx.currentTime + 0.01;
      for (const [f, at, dur] of seq) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0, t0 + at);
        g.gain.linearRampToValueAtTime(0.35, t0 + at + 0.008);
        g.gain.setValueAtTime(0.35, t0 + at + dur - 0.015);
        g.gain.linearRampToValueAtTime(0, t0 + at + dur);
        o.connect(g); g.connect(out);
        o.start(t0 + at); o.stop(t0 + at + dur + 0.02);
        end = Math.max(end, at + dur);
      }
    } catch (e) { /* no audio yet: vibration + speech still fire */ }
    return Math.round(end * 1000) + 10;
  }
  function fail(text) { tone('error'); buzz([80, 60, 80]); show(text); say(text); }
  function soft(text) { tone('soft'); buzz(15); show(text); say(text); }

  /* ------------------------------------------------------- master gain mute */
  let savedGain = null;
  function mute() {
    safe(() => {
      const g = AudioEngine.out.gain, t = AudioEngine.ctx.currentTime;
      if (savedGain === null) savedGain = g.value;
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + 0.02);
    });
  }
  function unmute() {
    if (savedGain === null) return;
    const v = savedGain; savedGain = null;
    safe(() => {
      const g = AudioEngine.out.gain, t = AudioEngine.ctx.currentTime;
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(v, t + 0.02);
    });
  }

  /* ---------------------------------------------------------------- playback */
  function flushPlayback() {
    safe(() => Player.flush());                       // silent: no Stop/Skip earcons
    safe(() => speechSynthesis.cancel());             // device voice is not behind the master gain
  }
  function waitIdle(max) {
    return new Promise((res) => {
      const t0 = now();
      (function poll() { if (!safe(() => Player.current) || now() - t0 > max) return res(); setTimeout(poll, 30); })();
    });
  }

  /* ========================================================= ModeController */
  const ModeController = {
    mode: 'RELAY',
    epoch: 0,
    allows(source) { return source === 'mic' ? this.mode === 'MIC' : this.mode === 'RELAY'; },
    token(source) { return { epoch: this.epoch, source: source }; },
    valid(tok) { return !!tok && tok.epoch === this.epoch && this.allows(tok.source); },
    invalidate() { this.epoch++; },

    // quiet: tone + vibration + status only (used when a recording starts straight away)
    set(target, quiet) {
      if (isCal() || (target !== 'MIC' && target !== 'RELAY')) return;
      if (target === this.mode) { announce(target, quiet); return; }   // idempotent: re-announce only
      if (target === 'MIC') {
        if (safe(() => RelayHooks.ready()) === false) { fail('Not ready yet.'); return; }
        safe(() => RelayHooks.stop());          // 1. close stream + timers, rewind unplayed messages
        this.invalidate();                      // 2. in-flight relay work is dropped
        flushPlayback();                        // 3. cancel speech, clear relay queue
        this.mode = 'MIC'; safe(() => localStorage.setItem(LS_MODE, 'MIC'));
        announce('MIC', quiet);
      } else {
        Voice.teardown();                       // recording, transcription, CONFIRM
        this.invalidate();                      // pending mic replies are dropped
        flushPlayback();
        this.mode = 'RELAY'; safe(() => localStorage.setItem(LS_MODE, 'RELAY'));
        announce('RELAY', quiet);
        safe(() => RelayHooks.start());         // reconnect from the kept ?since= cursor
      }
    }
  };
  function announce(m, quiet) {
    if (m === 'MIC') {
      tone('voiceon'); buzz(40); show('Voice mode');
      if (!quiet) say('Voice mode. Press volume up to talk.');
    } else {
      tone('voiceoff'); buzz([40, 60, 40]); show('Voice off, relay on');
      if (!quiet) say('Voice off.');
    }
  }

  /* =========================================================== Voice (takes) */
  let take = null;               // the take that is opening or recording
  const inflight = new Set();    // takes stopping / being transcribed
  let pending = null;            // CONFIRM: { text, id, timer, stop, quiet }
  let turn = null;               // last accepted mic turn: { epoch }

  function state() {
    if (ModeController.mode !== 'MIC') return 'RELAY';
    if (take && (take.phase === 'opening' || take.phase === 'recording')) return 'RECORDING';
    if (inflight.size > 0) return 'TRANSCRIBING';
    if (pending) return 'CONFIRM';
    if (safe(() => Player.current)) return 'SPEAKING';
    const thinking = turn && turn.epoch === ModeController.epoch &&
      safe(() => !Player.paused && (Player.busy || Player.q.length > 0));
    return thinking ? 'THINKING' : 'IDLE';
  }

  function newTake() {
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      phase: 'opening', cancelled: false,
      stream: null, rec: null, chunks: [], mime: '', ext: '', stopped: null,
      speechMs: 0, heard: false, noVad: false, vad: null, timers: [], pulse: 0,
      ac: new AbortController()
    };
  }

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    const list = [['audio/webm;codecs=opus', 'webm'], ['audio/webm', 'webm'],
                  ['audio/mp4;codecs=mp4a.40.2', 'm4a'], ['audio/mp4', 'm4a']];
    for (const [mime, ext] of list) if (safe(() => MediaRecorder.isTypeSupported(mime))) return { mime, ext };
    return null;
  }

  function micErrorText(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Microphone permission needed.';
    if (n === 'NotFoundError') return 'No microphone found.';
    if (n === 'NotReadableError') return 'Microphone is busy in another app.';
    return 'Microphone failed.';
  }
  function sttErrorText(e) {
    const s = e && e.status;
    if (s === 401 || s === 403) return 'Transcription key rejected.';
    if (s === 413) return 'Recording too large. Say it again, shorter.';
    if (s === 400) return 'Transcription refused the recording. Say it again.';
    return "Didn't go through. Say it again.";
  }

  // Runs synchronously up to its first await: `take` is set before this returns.
  async function startTake(leadMs) {
    flushPlayback();               // also stops a CONFIRM read-back
    ModeController.invalidate();   // nothing older may start playing into the mic
    const t = take = newTake();
    show('Recording');
    if (leadMs) { await sleep(leadMs); if (t.cancelled) return; }
    const toneMs = tone('start'); buzz(30);
    let gum;
    try {
      gum = navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      });
    } catch (e) { gum = Promise.reject(e); }
    gum.catch(() => {});
    const lat = (safe(() => AudioEngine.ctx.outputLatency || AudioEngine.ctx.baseLatency) || 0) * 1000;
    await Promise.all([sleep(toneMs + lat + CFG.tailMs), waitIdle(800)]);

    let stream;
    try { stream = await gum; }
    catch (e) { if (take === t) take = null; if (!t.cancelled) { t.cancelled = true; fail(micErrorText(e)); } return; }
    t.stream = stream;
    if (t.cancelled) { stopTracks(t); return; }

    const pick = pickMime();
    if (!pick) { cleanupTake(t); fail('Recording is not supported here.'); return; }
    let rec;
    try { rec = new MediaRecorder(stream, { mimeType: pick.mime, audioBitsPerSecond: 32000 }); }
    catch (e) { cleanupTake(t); fail('Recording failed to start.'); return; }

    mute();                                     // master gain 0 for the whole recording
    t.rec = rec; t.mime = pick.mime; t.ext = pick.ext;
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) t.chunks.push(ev.data); };
    t.stopped = new Promise((res) => { rec.onstop = res; });
    try { rec.start(250); }
    catch (e) { cleanupTake(t); fail('Recording failed to start.'); return; }
    t.phase = 'recording';
    startVad(t);
    t.timers.push(setTimeout(() => buzz([60, 80, 60]), CFG.warnMs));   // vibration only: speaker is muted
    t.timers.push(setTimeout(() => finishTake(t, 'cap'), CFG.maxMs));
  }

  function startVad(t) {
    try {
      const ctx = AudioEngine.ctx;
      if (ctx.state !== 'running') { t.noVad = true; t.heard = true; return; }
      const src = ctx.createMediaStreamSource(t.stream);
      const an = ctx.createAnalyser(); an.fftSize = 1024;
      const sink = ctx.createGain(); sink.gain.value = 0;   // keeps the analyser pulled; never reaches AudioEngine.out
      src.connect(an); an.connect(sink); sink.connect(ctx.destination);
      const buf = new Float32Array(an.fftSize);
      const t0 = now();
      let floorSum = 0, floorN = 0, thr = CFG.vadMin, above = 0, lastVoice = 0;
      const iv = setInterval(() => {
        if (t.phase !== 'recording') return;
        an.getFloatTimeDomainData(buf);
        let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        const rms = Math.sqrt(s / buf.length), tn = now(), el = tn - t0;
        if (el < CFG.calibMs) { floorSum += rms; floorN++; return; }
        if (floorN) { thr = Math.max(CFG.vadMin, Math.min(CFG.vadMaxThr, CFG.vadFactor * floorSum / floorN)); floorN = 0; }
        if (rms > thr) {
          above += CFG.vadFrameMs;
          if (above >= CFG.vadOnsetMs) { t.speechMs += (t.heard ? CFG.vadFrameMs : above); t.heard = true; lastVoice = tn; }
        } else above = 0;
        if (!t.heard && el > CFG.noSpeechMs) finishTake(t, 'nospeech');
        else if (t.heard && tn - lastVoice > CFG.silenceEndMs) finishTake(t, 'silence');
      }, CFG.vadFrameMs);
      t.vad = { src, an, sink, iv };
    } catch (e) { t.vad = null; t.noVad = true; t.heard = true; }
  }
  function stopVad(t) {
    if (!t.vad) return;
    clearInterval(t.vad.iv);
    safe(() => t.vad.src.disconnect()); safe(() => t.vad.an.disconnect()); safe(() => t.vad.sink.disconnect());
    t.vad = null;
  }
  function stopTracks(t) { safe(() => t.stream && t.stream.getTracks().forEach((x) => x.stop())); }
  function clearTimers(t) { t.timers.forEach(clearTimeout); t.timers = []; clearInterval(t.pulse); t.pulse = 0; }
  function cleanupTake(t) {
    clearTimers(t); stopVad(t); stopTracks(t); unmute();
    t.cancelled = true; if (take === t) take = null;
    inflight.delete(t);
  }

  // reason: 'silence' | 'cap' | 'nospeech' — there is no manual stop. Every path ends audibly in
  // TRANSCRIBING, CONFIRM, or voice idle with a spoken reason.
  async function finishTake(t, reason) {
    if (!t || t.cancelled || t.phase !== 'recording') return;
    t.phase = 'stopping';
    if (take === t) take = null;
    inflight.add(t);                            // TRANSCRIBING from this moment: keys get the busy tick
    clearTimers(t); stopVad(t);
    safe(() => { if (t.rec.state !== 'inactive') t.rec.stop(); });
    await Promise.race([t.stopped, sleep(2000)]);
    stopTracks(t); unmute();
    if (t.cancelled) { inflight.delete(t); return; }

    if (reason === 'nospeech') { inflight.delete(t); soft("Didn't hear anything."); return; }
    if (!t.noVad && t.speechMs < CFG.minSpeechMs) { inflight.delete(t); soft("Didn't catch that."); return; }

    const type = ((t.rec && t.rec.mimeType) || t.mime).split(';')[0];
    const blob = new Blob(t.chunks, { type: type });
    t.phase = 'transcribing';
    show('Transcribing');
    tone('transcribing'); buzz(20);
    t.pulse = setInterval(() => tone('busy'), CFG.pulseMs);   // busy pulse until the transcript is spoken
    let text, err = null;
    try { text = await transcribe(blob, t.ext, t.ac.signal); }
    catch (e) { err = e; }
    clearInterval(t.pulse); t.pulse = 0;
    inflight.delete(t);
    if (t.cancelled || ModeController.mode !== 'MIC') return;
    t.phase = 'done';
    if (err) { fail(sttErrorText(err)); return; }            // stays in voice idle
    const clean_ = clean(text);
    if (!clean_) { soft("Didn't catch that."); return; }     // stays in voice idle, never CONFIRM
    enterConfirm(clean_, t.id);
  }

  function cancelTake(t) {
    if (!t || t.cancelled) return;
    t.cancelled = true;
    clearTimers(t); stopVad(t);
    safe(() => t.ac.abort());
    safe(() => { if (t.rec && t.rec.state !== 'inactive') t.rec.stop(); });
    stopTracks(t); unmute();
    if (take === t) take = null;
    inflight.delete(t);
  }

  const PHANTOMS = new Set([
    'you', 'thanks for watching', 'thank you for watching', 'thank you so much for watching',
    'please subscribe', 'like and subscribe', 'subtitles by the amaraorg community',
    'subtitles by the amara org community', 'music', 'silence'
  ]);
  function clean(raw) {
    const s = String(raw || '').trim();
    const norm = s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
    if (!norm || PHANTOMS.has(norm)) return '';
    return s;
  }

  async function transcribe(blob, ext, outer) {
    let lastErr = null;
    for (let attempt = 0; attempt <= CFG.sttBackoff.length; attempt++) {
      if (attempt) await sleep(CFG.sttBackoff[attempt - 1], outer);
      if (outer.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      outer.addEventListener('abort', onAbort, { once: true });
      let timedOut = false;
      const to = setTimeout(() => { timedOut = true; ac.abort(); }, CFG.sttTimeout);
      try {
        const fd = new FormData();
        fd.append('file', blob, 'speech.' + ext);
        fd.append('model', CFG.sttModel);
        fd.append('response_format', 'json');
        if (CFG.language) fd.append('language', CFG.language);
        const r = await fetch(CFG.sttUrl, {
          method: 'POST', headers: { Authorization: 'Bearer ' + cfg.key }, body: fd, signal: ac.signal,
          cache: 'no-store', referrerPolicy: 'no-referrer'
        });
        if (r.ok) {
          const j = await r.json();
          return (j && typeof j.text === 'string') ? j.text : '';
        }
        const e = Object.assign(new Error('HTTP ' + r.status), { status: r.status });
        if (r.status === 429 || r.status >= 500) { lastErr = e; continue; }   // retryable
        throw e;                                                             // 4xx: no retry
      } catch (e) {
        if (outer.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (e && e.status) throw e;
        lastErr = Object.assign(new Error(timedOut ? 'timeout' : 'network'), { kind: timedOut ? 'timeout' : 'network' });
      } finally {
        clearTimeout(to);
        outer.removeEventListener('abort', onAbort);
      }
    }
    throw lastErr || new Error('transcription failed');
  }

  /* ================================================================ CONFIRM */
  function enterConfirm(text, id) {
    if (ModeController.mode !== 'MIC' || take) return;      // a new recording already started
    if (pending) dropPending();
    pending = { text, id, timer: 0, stop: null, quiet: false };
    tone('confirm'); buzz(20); show('Heard: ' + text);
    readBack();
  }

  // Device voice reads the transcript; the 20 s timeout starts when it finishes.
  function readBack() {
    const p = pending;
    if (!p) return;
    clearTimeout(p.timer);
    stopReadBack(p);
    const done = () => {
      if (pending !== p || p.quiet) return;
      p.stop = null;
      clearTimeout(p.timer);
      p.timer = setTimeout(() => expire(p), CFG.confirmMs);
    };
    p.stop = safe(() => speakUtter(p.text + '. ' + CFG.confirmHint, done)) || null;
    if (!p.stop) done();
  }
  function stopReadBack(p) {
    const s = p.stop; p.stop = null;
    if (!s) return;
    p.quiet = true; safe(s); p.quiet = false;
  }
  function dropPending() {
    const p = pending; if (!p) return;
    pending = null;
    clearTimeout(p.timer);
    stopReadBack(p);
  }
  function expire(p) {
    if (pending !== p) return;
    dropPending();
    tone('expired'); buzz([30, 50, 30]); show('Not sent, discarded');
  }
  function accept(p) {
    if (pending !== p || ModeController.mode !== 'MIC') return;
    dropPending();
    tone('sent'); buzz(20); show('Sent');
    turn = { epoch: ModeController.epoch };
    safe(() => handle(p.text, 'mic-' + p.id, 'mic'));   // the ONLY call into handle(); produce() owns retries and spoken errors
  }

  function repeatTranscript() {
    const ms = tone('repeat'); buzz([20, 60, 20]);
    show('Heard: ' + (pending ? pending.text : ''));
    setTimeout(() => { if (pending && !take) readBack(); }, ms + 40);
  }

  const Voice = {
    teardown() {
      if (take) cancelTake(take);
      Array.from(inflight).forEach(cancelTake);
      inflight.clear();
      dropPending();
      turn = null;
      unmute();
    }
  };

  /* =========================================================== key bindings */
  const lastKeyT = {};
  function busyTick(text) { tone('busy'); buzz(15); if (text) show(text); }

  // One distinct key per command; every action fires on the event, decided by the current state.
  function onKey(action) {
    const tn = now();
    if (tn - (lastKeyT[action] || -1e9) < CFG.dedupe) return;     // one press delivered twice
    lastKeyT[action] = tn;
    const s = state();

    switch (action) {
      case 'seekforward':                                          // volume-up single
        if (s === 'RELAY') { enterAndRecord(); return; }
        if (s === 'RECORDING') return;                             // ignored: silence or the 60 s cap ends it
        if (s === 'CONFIRM') { dropPending(); startTake().catch(() => {}); return; }   // discard, record again
        if (s === 'IDLE' || s === 'SPEAKING') { startTake().catch(() => {}); return; } // next question / interrupt reply
        busyTick(s === 'TRANSCRIBING' ? 'Transcribing, wait' : 'Busy');                // TRANSCRIBING, THINKING
        return;

      case 'nexttrack':                                            // volume-up double
        if (s === 'CONFIRM') { accept(pending); return; }          // the only way into handle()
        busyTick();
        return;

      case 'previoustrack':                                        // volume-down single
        if (s === 'CONFIRM') { repeatTranscript(); return; }
        busyTick();
        return;

      case 'stop':                                                 // volume-down double
        leaveVoice();
        return;
    }
  }

  function enterAndRecord() {
    ModeController.set('MIC', true);
    if (ModeController.mode !== 'MIC') return;
    startTake(CFG.enterLeadMs).catch(() => {});
  }
  function leaveVoice() { if (ModeController.mode === 'MIC') ModeController.set('RELAY'); }
  function enterVoice() { ModeController.set('MIC'); }

  /* ================================================== MediaSession wrapper */
  const INTERCEPT = ['play', 'pause', 'stop', 'nexttrack', 'previoustrack', 'seekforward'];
  const relayH = {};
  let native = null;

  // One entry point for MediaSession actions and media keydown events.
  // Returns true when this file consumed the action.
  function route(action) {
    const mic = ModeController.mode === 'MIC';
    if (action === 'play' || action === 'pause') {
      return mic && state() === 'RECORDING';       // never let playback start into the mic
    }
    if (mic) { onKey(action); return true; }       // stop / nexttrack / previoustrack / seekforward
    if (action === 'seekforward' && !relayH.seekforward) { onKey(action); return true; }   // relay entry
    return false;                                  // RELAY: skip / replay / stop exactly as today
  }

  function dispatch(action) {
    return function (details) {
      if (isCal()) { const f = relayH[action]; return f ? f(details) : undefined; }
      if (route(action)) return;
      const f = relayH[action];
      if (f) return f(details);
    };
  }

  const ms = ('mediaSession' in navigator) ? navigator.mediaSession : null;
  if (ms && typeof ms.setActionHandler === 'function') {
    native = ms.setActionHandler.bind(ms);
    ms.setActionHandler = function (action, fn) {
      if (INTERCEPT.indexOf(action) < 0 || isCal()) return native(action, fn);
      relayH[action] = fn || null;
      try { native(action, dispatch(action)); } catch (e) { /* unsupported action on this browser */ }
    };
  }

  const KEYMAP = {
    MediaTrackPrevious: 'previoustrack', MediaTrackNext: 'nexttrack', MediaStop: 'stop',
    MediaFastForward: 'seekforward', MediaPlay: 'play', MediaPause: 'pause', MediaPlayPause: 'play'
  };
  // For index.html's keydown handler: true = consumed here, skip the existing switch.
  function mediaKey(key) {
    if (isCal() || !inited) return false;
    const a = KEYMAP[key];
    return a ? route(a) : false;
  }

  /* ==================================================================== init */
  let inited = false;
  function init() {                              // called from setupMediaSession(), never in ?cal=1
    if (inited || isCal()) return;
    inited = true;
    if (native) for (const a of INTERCEPT) {
      if (!(a in relayH)) { try { native(a, dispatch(a)); } catch (e) {} }
    }
    if (resumedFromVoice) say('Voice mode ended by reload. Relay on.');
  }

  // NetworkSource.start() asks this once: after a reload in voice mode, keep the stored
  // relay cursor so messages held during voice mode are fetched instead of skipped.
  function keepCursor() {
    if (!resumedFromVoice || cursorKept) return false;
    cursorKept = true;
    return true;
  }

  window.ModeController = ModeController;
  window.Mic = {
    CFG, init, state, mediaKey, keepCursor,
    enter: enterVoice,
    leave: leaveVoice,
    _dispatch: dispatch      // test hook: Mic._dispatch('nexttrack')() simulates a media key
  };
})();
