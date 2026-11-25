/* mic.js — voice input mode + weighted press counter (pen button / volume keys).
 *
 * Loaded by index.html BEFORE its inline script: it wraps
 * navigator.mediaSession.setActionHandler so setupMediaSession()'s relay handlers
 * are kept and called unchanged in RELAY mode, and so ?cal=1 binds them directly.
 *
 * Globals from index.html, looked up at call time only:
 *   handle, Player (q, busy, paused, current, last, enqueue, flush), AudioEngine (ctx, out),
 *   setStatus, speakNow, cfg (key), CAL, RelayHooks (ready, stop, start)
 *
 * Exposes: window.ModeController, window.Mic
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ tuning */
  const CFG = {
    T_merge: 450,       // ms: previoustrack this close before a nexttrack => nexttrack adds 1
    unclearBand: 75,    // ms: gap in [T_merge, T_merge+band) is unclear => also merged (resolves to 2)
    nextNextMin: 300,   // ms: nexttrack->nexttrack faster than this is unclear => adds 0
    G: 700,             // ms: gesture window
    cap: 1500,          // ms: hard cap from the first event
    sliding: true,      // true: closes G after the LAST event, never later than cap after the first.
                        // false: closes exactly G after the first event.
    dedupe: 80,         // ms: same keycode repeated within this is ignored

    noSpeechMs: 5000,   // no speech onset within this => cancel, nothing uploaded
    silenceEndMs: 1500, // trailing silence after speech => stop and send
    maxMs: 60000,       // hard cap; still sends
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
    language: ''              // e.g. 'en'; empty = auto-detect
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
    start:    [[880, 0, 0.06]],                         // count 1: recording starts
    repeat:   [[660, 0, 0.04], [660, 0.09, 0.04]],      // count 2: two ticks
    voiceoff: [[660, 0, 0.12], [440, 0.12, 0.20]],      // count 3 / stop: falling
    voiceon:  [[440, 0, 0.12], [660, 0.12, 0.20]],      // entering voice mode: rising
    stopped:  [[330, 0, 0.06]],                         // recorder stopped
    sent:     [[520, 0, 0.05], [780, 0.07, 0.08]],      // transcript committed to handle()
    soft:     [[300, 0, 0.05], [300, 0.10, 0.05]],      // nothing heard / empty
    busy:     [[200, 0, 0.05]],                         // press ignored while busy
    error:    [[160, 0, 0.28]]                          // any failure (followed by speech)
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

    set(target) {
      if (isCal() || (target !== 'MIC' && target !== 'RELAY')) return;
      if (target === this.mode) { announce(target); return; }      // idempotent: re-announce only
      if (target === 'MIC') {
        if (safe(() => RelayHooks.ready()) === false) { fail('Not ready yet.'); return; }
        safe(() => RelayHooks.stop());          // 1. close stream + timers, rewind unplayed messages
        this.invalidate();                      // 2. in-flight relay work is dropped
        flushPlayback();                        // 3. cancel speech, clear relay queue
        this.mode = 'MIC'; safe(() => localStorage.setItem(LS_MODE, 'MIC'));
        announce('MIC');
      } else {
        Voice.teardown();                       // gesture, recording, uploads
        this.invalidate();                      // pending mic replies are dropped
        flushPlayback();
        this.mode = 'RELAY'; safe(() => localStorage.setItem(LS_MODE, 'RELAY'));
        announce('RELAY');
        safe(() => RelayHooks.start());         // reconnect from the kept ?since= cursor
      }
    }
  };
  function announce(m) {
    if (m === 'MIC') { tone('voiceon'); buzz(40); show('Voice mode'); say('Voice mode. Press once to talk.'); }
    else { tone('voiceoff'); buzz([40, 60, 40]); show('Voice off, relay on'); say('Voice off.'); }
  }

  /* =========================================================== Voice (takes) */
  let take = null;               // the take that is opening or recording
  const inflight = new Set();    // takes being transcribed / awaiting commit
  let turn = null;               // last committed mic turn: { epoch }

  function state() {
    if (take && (take.phase === 'opening' || take.phase === 'recording')) return 'RECORDING';
    if (inflight.size > 0) return 'BUSY';
    if (safe(() => Player.current)) return 'SPEAKING';
    const thinking = turn && turn.epoch === ModeController.epoch &&
      safe(() => !Player.paused && (Player.busy || Player.q.length > 0));
    return thinking ? 'BUSY' : 'IDLE';
  }

  function newTake() {
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      phase: 'opening', cancelled: false, done: false,
      stream: null, rec: null, chunks: [], mime: '', ext: '', stopped: null,
      speechMs: 0, heard: false, noVad: false, vad: null, timers: [],
      ac: new AbortController(), commitReady: false, text: undefined, err: null
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
  async function startTake() {
    flushPlayback();
    ModeController.invalidate();   // nothing older may start playing into the mic
    const t = take = newTake();
    show('Recording');
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
  function clearTimers(t) { t.timers.forEach(clearTimeout); t.timers = []; }
  function cleanupTake(t) {
    clearTimers(t); stopVad(t); stopTracks(t); unmute();
    t.cancelled = true; if (take === t) take = null;
  }

  // reason: 'accept' (press; commit waits for gesture close) | 'silence' | 'cap' | 'nospeech'
  async function finishTake(t, reason) {
    if (!t || t.cancelled) return;
    if (t.phase === 'opening') {                // pressed before the mic was even live
      cleanupTake(t); tone('soft'); show("Didn't catch that"); say("Didn't catch that."); return;
    }
    if (t.phase !== 'recording') return;
    t.phase = 'stopping';
    if (take === t) take = null;
    clearTimers(t); stopVad(t);
    safe(() => { if (t.rec.state !== 'inactive') t.rec.stop(); });
    await Promise.race([t.stopped, sleep(2000)]);
    stopTracks(t); unmute();
    if (t.cancelled) return;
    tone('stopped');

    if (reason === 'nospeech') { t.done = true; tone('soft'); show("Didn't hear anything"); say("Didn't hear anything."); return; }
    if (!t.noVad && t.speechMs < CFG.minSpeechMs) { t.done = true; tone('soft'); show("Didn't catch that"); say("Didn't catch that."); return; }

    const type = ((t.rec && t.rec.mimeType) || t.mime).split(';')[0];
    const blob = new Blob(t.chunks, { type: type });
    t.phase = 'transcribing';
    inflight.add(t);
    show('Transcribing');
    if (reason !== 'accept') t.commitReady = true;   // auto-ends commit as soon as text exists
    try { t.text = await transcribe(blob, t.ext, t.ac.signal); }
    catch (e) { t.err = e; }
    tryCommit(t);
  }

  function cancelTake(t) {
    if (!t || t.cancelled) return;
    t.cancelled = true;
    clearTimers(t); stopVad(t);
    safe(() => t.ac.abort());
    safe(() => { if (t.rec && t.rec.state !== 'inactive') t.rec.stop(); });
    stopTracks(t); unmute();
    if (take === t) take = null;
    tryCommit(t);                               // releases inflight bookkeeping
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

  function tryCommit(t) {
    if (t.done) { inflight.delete(t); return; }
    if (t.cancelled) { t.done = true; inflight.delete(t); return; }
    if (!t.commitReady || (t.text === undefined && !t.err)) return;
    if (G.open && G.take === t) return;         // a gesture may still turn this accept into 2 or 3
    t.done = true; inflight.delete(t);
    if (t.err) { fail(sttErrorText(t.err)); return; }
    const text = clean(t.text);
    if (!text) { tone('soft'); show("Didn't catch that"); say("Didn't catch that."); return; }   // never reaches handle()
    if (ModeController.mode !== 'MIC') return;
    tone('sent'); buzz(20);
    turn = { epoch: ModeController.epoch };
    safe(() => handle(text, 'mic-' + t.id, 'mic'));   // handle()/produce() own chat+speech retries and spoken errors
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

  function repeatLast() {
    const ms = tone('repeat'); buzz([20, 60, 20]);
    show('Repeat');
    setTimeout(() => {
      if (ModeController.mode !== 'MIC' || take) return;   // left, or a new take started meanwhile
      const last = safe(() => Player.last);
      if (!last) { show('Nothing to repeat'); say('Nothing to repeat yet.'); return; }
      try {
        if (Player.current) flushPlayback();              // restart from the beginning
        Player.enqueue([last], true);                      // same path as Player.playPressed()
      } catch (e) { fail('Repeat failed.'); }
    }, ms + 40);
  }

  const Voice = {
    teardown() {
      clearTimeout(G.timer); G.open = false; G.take = null; G.spec = null;
      if (take) cancelTake(take);
      Array.from(inflight).forEach(cancelTake);
      inflight.clear();
      turn = null;
      unmute();
    }
  };

  /* ======================================================== gesture counter */
  const G = {
    open: false, firstT: 0, lastT: 0, closeAt: 0, timer: 0,
    count: 0, startState: 'IDLE',
    take: null,          // take that was recording/opening when the gesture began
    spec: null,          // speculative take this gesture started on count 1
    lastPrevT: -1e9, lastNextT: -1e9,
    swallowUntil: 0      // events before this time are ignored (after a mode switch)
  };
  const lastKeyT = {};

  function scheduleClose() {
    clearTimeout(G.timer);
    G.closeAt = CFG.sliding ? Math.min(G.lastT + CFG.G, G.firstT + CFG.cap) : G.firstT + CFG.G;
    G.timer = setTimeout(closeGesture, Math.max(0, G.closeAt - now()));
  }

  function closeGesture() {
    if (!G.open) return;
    clearTimeout(G.timer);
    G.open = false;
    const t = G.take, s = G.startState, n = G.count;
    G.take = null; G.spec = null;
    if (n === 1 && s === 'RECORDING' && t) { t.commitReady = true; tryCommit(t); }  // the only deferred action
  }

  function onKey(action) {
    const tn = now();
    if (tn - (lastKeyT[action] || -1e9) < CFG.dedupe) return;     // same keycode within 80 ms
    lastKeyT[action] = tn;

    if (action === 'stop') { leaveVoice(); return; }
    if (action !== 'previoustrack' && action !== 'nexttrack' && action !== 'seekforward') return;

    if (G.open && tn >= G.closeAt) closeGesture();                // late timer: this event starts a new gesture
    if (!G.open) {
      G.open = true; G.firstT = tn; G.count = 0;
      G.startState = state();                                     // rule 4: decide from state at gesture start
      G.take = (G.startState === 'RECORDING') ? take : null;
      G.spec = null; G.lastPrevT = -1e9; G.lastNextT = -1e9;
    }

    let w;
    if (action === 'nexttrack') {
      if (tn - G.lastNextT < CFG.nextNextMin) w = 0;                           // unclear: hold at current count
      else if (tn - G.lastPrevT < CFG.T_merge + CFG.unclearBand) w = 1;         // merged double (unclear band => 2)
      else w = 2;
      G.lastNextT = tn;
    } else {
      w = 1;
      if (action === 'previoustrack') G.lastPrevT = tn;
    }

    G.lastT = tn;
    const before = G.count;
    G.count = Math.min(3, G.count + w);
    scheduleClose();
    if (G.count > before) act(G.count);
  }

  function act(n) {
    const s = G.startState;
    if (n === 1) {
      if (s === 'IDLE' || s === 'SPEAKING') { startTake().catch(() => {}); G.spec = take; }       // speculative, zero latency
      else if (s === 'RECORDING') { if (G.take) finishTake(G.take, 'accept').catch(() => {}); } // stop now, commit on close
      else { tone('busy'); buzz(15); show('Busy'); }                                            // BUSY
      return;
    }
    // n >= 2: undo whatever count 1 did in this gesture
    if (G.spec) { cancelTake(G.spec); G.spec = null; }
    if (s === 'RECORDING' && G.take) cancelTake(G.take);
    if (n === 2) { repeatLast(); return; }        // BUSY: the pending request keeps running
    leaveVoice();                                 // n === 3
  }

  function leaveVoice() {
    G.swallowUntil = now() + CFG.G;               // trailing presses must not leak into relay handlers
    ModeController.set('RELAY');
  }
  function enterVoice() {
    G.swallowUntil = now() + CFG.G;               // a repeating long-press must not start a recording
    ModeController.set('MIC');
  }

  /* ================================================== MediaSession wrapper */
  const INTERCEPT = ['play', 'pause', 'stop', 'nexttrack', 'previoustrack', 'seekforward'];
  const relayH = {};
  let native = null;

  // One entry point for MediaSession actions and media keydown events.
  // Returns true when voice mode consumed the action.
  function route(action, details) {
    if (now() < G.swallowUntil) return true;
    if (ModeController.mode === 'MIC') {
      if (action === 'play' || action === 'pause') {
        if (state() === 'RECORDING') return true;  // never let playback start into the mic
        return false;                              // otherwise today's play / pause behaviour
      }
      onKey(action);
      return true;
    }
    if (action === 'seekforward' && !relayH.seekforward) { enterVoice(); return true; }  // unbound in relay today
    return false;                                  // RELAY: counter inert
  }

  function dispatch(action) {
    return function (details) {
      if (isCal()) { const f = relayH[action]; return f ? f(details) : undefined; }
      if (route(action, details)) return;
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
    _gesture: G,
    _dispatch: dispatch      // test hook: Mic._dispatch('nexttrack')() simulates a media key
  };
})();
