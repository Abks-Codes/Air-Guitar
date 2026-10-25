// Air Guitar — Real Acoustic Guitar Chords & Fast Up/Down Strumming
// Powered by MediaPipe HandLandmarker & Meta Open Sound Steel Guitar Samples

(() => {
  const MEDIAPIPE_VERSION = "0.10.14";
  const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
  const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
  const SAMPLE_BASE = "meta-open-sound-meta-steel-guitar-wav/";

  // 9 Chord Voicings (Steel Guitar)
  const CHORDS = {
    E:  ["LowE:E2", "A:B2", "D:E3", "G:G#3", "B:B3", "HighE:E4"],
    A:  ["A:A2", "D:E3", "G:A3", "B:C#4", "HighE:E4"],
    D:  ["D:D3", "G:A3", "B:D4", "HighE:F#4"],
    G:  ["LowE:G2", "A:B2", "D:D3", "G:G3", "B:B3", "HighE:G4"],
    C:  ["A:C3", "D:E3", "G:G3", "B:C4", "HighE:E4"],
    Am: ["A:A2", "D:E3", "G:A3", "B:C4", "HighE:E4"],
    Dm: ["D:D3", "G:A3", "B:D4", "HighE:F4"],
    Em: ["LowE:E2", "A:B2", "D:E3", "G:G3", "B:B3", "HighE:E4"],
    Gm: ["LowE:G2", "A:D3", "D:G3", "G:A#3", "B:D4", "HighE:G4"],
  };
  const CHORD_NAMES = Object.keys(CHORDS);

  const CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15],
    [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
  ];

  const $ = (id) => document.getElementById(id);
  const ui = {
    canvas: $("view"),
    empty: $("videoEmpty"),
    cameraButton: $("cameraButton"),
    chordName: $("chordName"),
    handCount: $("handCount"),
    status: $("status"),
    statePill: $("statePill"),
    dynamicNotes: $("dynamicNotesLayer"),
  };

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.style.display = "none";
  document.body.appendChild(video);

  const state = {
    running: false,
    stream: null,
    landmarker: null,
    fileset: null,
    audio: null,
    masterGain: null,
    chordBuffers: new Map(),
    stringBuffers: new Map(),
    activeVoices: new Set(),
    selectedChord: "A",
    candidateChord: null,
    candidateCount: 0,
    lastChordChangeTime: 0,
    lastVideoTime: -1,
    lastTimestamp: 0,
    frameRequestId: null,
    lastStrumDirection: null,
    lastStrumTime: 0,
  };

  const setStatus = (txt) => { if (ui.status) ui.status.textContent = txt; };

  // Audio Engine — only call AFTER a user gesture to avoid autoplay suspension
  function ensureAudio() {
    if (!state.audio) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      state.audio = new AudioCtx({ latencyHint: "interactive" });

      state.masterGain = state.audio.createGain();
      state.masterGain.gain.value = 0.85;

      const compressor = state.audio.createDynamicsCompressor();
      compressor.threshold.value = -12;
      compressor.knee.value = 10;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.12;

      state.masterGain.connect(compressor);
      compressor.connect(state.audio.destination);
    }
    return state.audio;
  }

  // Preload audio — must run AFTER AudioContext is resumed by user gesture
  async function preloadAllSamples() {
    const audio = ensureAudio();
    // Ensure context is running before decoding
    if (audio.state === "suspended") await audio.resume();

    setStatus("Loading audio…");
    let loaded = 0;

    await Promise.all([
      ...CHORD_NAMES.flatMap((chord) => ["down", "up"].map(async (dir) => {
        try {
          const resp = await fetch(`chords/${chord}_${dir}.wav`);
          if (!resp.ok) return;
          const buf = await audio.decodeAudioData(await resp.arrayBuffer());
          state.chordBuffers.set(`${chord}_${dir}`, buf);
          loaded++;
        } catch (e) { console.warn(`Failed to load chords/${chord}_${dir}.wav`, e); }
      })),
      ...[...new Set(Object.values(CHORDS).flat())].map(async (sn) => {
        try {
          const [str, note] = sn.split(":");
          const pitch = note.replace("#", "s");
          const resp = await fetch(`${SAMPLE_BASE}INSGuitarSteel_String${str}_Vel02_${pitch}_01.wav`);
          if (!resp.ok) return;
          const buf = await audio.decodeAudioData(await resp.arrayBuffer());
          state.stringBuffers.set(sn, buf);
          loaded++;
        } catch (e) { console.warn(`Failed to load string sample ${sn}`, e); }
      }),
    ]);

    console.log(`[Air Guitar] Loaded ${state.chordBuffers.size} chord WAVs, ${state.stringBuffers.size} string samples.`);
    setStatus("Ready");
  }

  // Audio Playback
  function playChord(direction = "down", speed = 7.0) {
    const chord = state.selectedChord || "A";
    if (!CHORDS[chord]) return;
    if (!state.audio || !state.masterGain) return; // Audio not yet initialized

    if (state.audio.state === "suspended") {
      state.audio.resume();
      return; // Don't play mid-resume to avoid glitch; next strum will play
    }

    const now = state.audio.currentTime;

    // Gently damp older playing voices to prevent clipping
    for (const voice of state.activeVoices) {
      try {
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
        voice.gain.gain.setTargetAtTime(0, now, 0.04);
        voice.source.stop(now + 0.15);
      } catch (_) {}
    }
    while (state.activeVoices.size >= 8) {
      state.activeVoices.delete(state.activeVoices.values().next().value);
    }

    const hitStrength = Math.min(1.2, Math.max(0.75, 0.70 + (speed / 15) * 0.4));
    const chordKey = `${chord}_${direction}`;
    const chordBuf = state.chordBuffers.get(chordKey) || state.chordBuffers.get(`${chord}_${direction === "down" ? "up" : "down"}`);

    if (chordBuf) {
      const source = state.audio.createBufferSource();
      const gain = state.audio.createGain();

      source.buffer = chordBuf;
      gain.gain.setValueAtTime(hitStrength, now);

      source.connect(gain);
      gain.connect(state.masterGain);

      registerVoice(source, gain);
      source.start(now);
    } else {
      const notes = [...CHORDS[chord]];
      if (direction === "up") notes.reverse();
      const stagger = direction === "up" ? 0.013 : 0.017;
      notes.forEach((sn, idx) => {
        const buffer = state.stringBuffers.get(sn);
        if (!buffer) return;
        const src = state.audio.createBufferSource();
        const g = state.audio.createGain();
        src.buffer = buffer;
        g.gain.setValueAtTime(0.85 * hitStrength, now + idx * stagger);
        src.connect(g);
        g.connect(state.masterGain);
        registerVoice(src, g);
        src.start(now + idx * stagger);
      });
    }

    triggerStrumFeedback(direction);
  }

  function registerVoice(source, gain) {
    const voice = { source, gain };
    state.activeVoices.add(voice);
    source.onended = () => {
      state.activeVoices.delete(voice);
      try { source.disconnect(); gain.disconnect(); } catch (_) {}
    };
  }

  // Chord Selection (Silent: Fretting hand selects, strum hand plays)
  function changeChord(chord, autoPlay = false) {
    if (!CHORDS[chord]) return;
    const now = performance.now() / 1000;
    if (chord === state.selectedChord && !autoPlay) return;
    if (chord !== state.selectedChord && now - state.lastChordChangeTime < 0.12) return;

    state.selectedChord = chord;
    state.lastChordChangeTime = now;
    updateChordUI(chord);

    if (autoPlay) playChord("down", 7.5);
  }

  function updateChordUI(chord) {
    if (ui.chordName) ui.chordName.textContent = chord;
  }

  function triggerStrumFeedback(direction) {
    const isDown = direction === "down";
    if (ui.statePill) {
      ui.statePill.classList.remove("flash-down", "flash-up");
      void ui.statePill.offsetWidth;
      ui.statePill.classList.add(isDown ? "flash-down" : "flash-up");
      setTimeout(() => ui.statePill?.classList.remove("flash-down", "flash-up"), 300);
    }
    setStatus(isDown ? "⬇️ Down Strum" : "⬆️ Up Strum");
    burstFloatingNotes();
  }

  function burstFloatingNotes() {
    if (!ui.dynamicNotes) return;
    for (let i = 0; i < 3; i++) {
      const img = document.createElement("img");
      img.className = "burst-note";
      img.src = "note.png";
      const isRight = Math.random() > 0.35;
      const xPercent = isRight ? (76 + Math.random() * 20) : (4 + Math.random() * 18);
      const dx = (Math.random() * 80 - 40) + (isRight ? 20 : -20);
      const rot = Math.round(Math.random() * 60 - 30);
      const dur = 1.4 + Math.random() * 0.8;

      img.style.left = `${xPercent}%`;
      img.style.setProperty("--dx", `${dx}px`);
      img.style.setProperty("--rot", `${rot}deg`);
      img.style.setProperty("--dur", `${dur}s`);
      img.style.animationDelay = `${i * 0.06}s`;

      ui.dynamicNotes.append(img);
      img.addEventListener("animationend", () => img.remove(), { once: true });
    }
  }

  // 3D Geometry & Finger Curls
  const dist3d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));

  function angle3d(a, b, c) {
    const ba = [a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0)];
    const bc = [c.x - b.x, c.y - b.y, (c.z ?? 0) - (b.z ?? 0)];
    const dot = ba[0] * bc[0] + ba[1] * bc[1] + ba[2] * bc[2];
    const lenBa = Math.hypot(...ba), lenBc = Math.hypot(...bc);
    if (!lenBa || !lenBc) return 180;
    return Math.acos(Math.max(-1, Math.min(1, dot / (lenBa * lenBc)))) * 180 / Math.PI;
  }

  function computeHandCurls(pts) {
    const wrist = pts[0];
    const scale = Math.max(0.01, dist3d(wrist, pts[9]));
    const fingers = [
      { name: "index", mcp: 5, pip: 6, dip: 7, tip: 8 },
      { name: "middle", mcp: 9, pip: 10, dip: 11, tip: 12 },
      { name: "ring", mcp: 13, pip: 14, dip: 15, tip: 16 },
      { name: "pinky", mcp: 17, pip: 18, dip: 19, tip: 20 },
    ];

    const curls = {};
    for (const { name, mcp, pip, dip, tip } of fingers) {
      const tipWrist = dist3d(pts[tip], wrist) / scale;
      const tipMcp = dist3d(pts[tip], pts[mcp]) / scale;
      const pipAng = angle3d(pts[mcp], pts[pip], pts[dip]);

      let score = 0;
      if (tipWrist < 1.1) score += 0.45; else if (tipWrist < 1.35) score += 0.2;
      if (tipMcp < 0.6) score += 0.35; else if (tipMcp < 0.8) score += 0.15;
      if (pipAng < 125) score += 0.35; else if (pipAng < 145) score += 0.15;
      curls[name] = Math.min(1.0, score);
    }

    const tTip = pts[4], tMcp = pts[2], tIp = pts[3], tBase = pts[1];
    let tScore = 0;
    if (dist3d(tTip, pts[13]) / scale < 0.62) tScore += 0.5;
    if (dist3d(tTip, pts[5]) / scale < 0.42) tScore += 0.35;
    if (angle3d(tBase, tMcp, tIp) < 140) tScore += 0.3;
    curls.thumb = Math.min(1.0, tScore);

    return curls;
  }

  function classifyChordFromCurls(curls) {
    const sorted = Object.entries(curls).sort((a, b) => b[1] - a[1]);
    const [f1, s1] = sorted[0];
    const [f2, s2] = sorted[1];
    const [, s3] = sorted[2];

    // Single bent finger
    if (s1 >= 0.52 && (s1 - s2 >= 0.20)) {
      const singleMap = { thumb: "E", index: "A", middle: "D", ring: "G", pinky: "C" };
      return singleMap[f1] || null;
    }

    // Two bent fingers
    if (s1 >= 0.48 && s2 >= 0.42 && (s2 - s3 >= 0.14)) {
      const pair = new Set([f1, f2]);
      if (pair.has("thumb") && pair.has("index")) return "Am";
      if (pair.has("middle") && pair.has("ring")) return "Dm";
      if (pair.has("ring") && pair.has("pinky")) return "Em";
      if (pair.has("thumb") && pair.has("middle")) return "Gm";
      if (pair.has("index") && pair.has("middle")) return "Gm";
    }

    // Finger counting / extension fallback
    const ext = Object.entries(curls).filter(([_, c]) => c < 0.38).map(([f]) => f);
    if (ext.length === 1 && ext[0] === "index") return "A";
    if (ext.length === 2 && ext.includes("index") && ext.includes("middle")) return "D";
    if (ext.length === 3 && ext.includes("index") && ext.includes("middle") && ext.includes("ring")) return "G";
    if (ext.length === 4 && !ext.includes("thumb")) return "C";
    if (ext.length === 5) return "E";
    if (ext.length === 0) return "Em";

    return null;
  }

  // Precise Strum Tracking with Directional Arming
  // Guarantees EXACTLY ONE sound per stroke (eliminates double/triple triggering)
  let lastPy = null;
  let lastTime = null;
  let smoothedVy = 0;
  let armedDown = true;
  let armedUp = true;

  function handleStrumTracking(pts, now, width, height) {
    let py = 0;
    const trackedIndices = [0, 5, 8, 9, 12, 13, 17];
    for (const id of trackedIndices) {
      py += pts[id].y * height;
    }
    py /= trackedIndices.length;

    if (lastPy === null || lastTime === null) {
      lastPy = py;
      lastTime = now;
      return;
    }

    const dt = Math.max(0.008, now - lastTime);
    lastTime = now;

    // Instantaneous velocity in pixels / second
    const rawVy = (py - lastPy) / dt;
    lastPy = py;

    // Smooth velocity with exponential moving average
    smoothedVy = smoothedVy * 0.35 + rawVy * 0.65;

    const SPEED_THRESHOLD = 110; // px/s to trigger a strum
    const cooldown = now - state.lastStrumTime;

    // Re-arm opposite stroke when direction changes, or both when hand rests
    if (smoothedVy < -35) {
      armedDown = true; // moving up re-arms down-strum
    } else if (smoothedVy > 35) {
      armedUp = true;   // moving down re-arms up-strum
    } else if (Math.abs(smoothedVy) < 25) {
      armedDown = true;
      armedUp = true;
    }

    if (smoothedVy > SPEED_THRESHOLD && armedDown && cooldown >= 0.08) {
      // Down strum: fires once per downward stroke
      playChord("down", Math.abs(smoothedVy) / 40);
      armedDown = false; // Disarmed until hand reverses or rests
      state.lastStrumDirection = "down";
      state.lastStrumTime = now;
    } else if (smoothedVy < -SPEED_THRESHOLD && armedUp && cooldown >= 0.08) {
      // Up strum: fires once per upward stroke
      playChord("up", Math.abs(smoothedVy) / 40);
      armedUp = false; // Disarmed until hand reverses or rests
      state.lastStrumDirection = "up";
      state.lastStrumTime = now;
    }
  }

  // Hand Roles:
  // In mirrored camera: Player's RIGHT hand is on screen right (raw x < 0.5)
  // Player's LEFT hand is on screen left (raw x >= 0.5)
  function isHandStrumming(hands, pts) {
    if (hands.length >= 2) {
      // With 2 hands: the hand on the player's right (smaller raw x) is STRUMMING
      const sorted = [...hands].sort((a, b) => a[0].x - b[0].x);
      return pts === sorted[0];
    }
    // With 1 hand: can always strum when moved vertically
    return true;
  }

  // Drawing Hands on Mirrored Canvas
  function drawHands(ctx, canvas, result) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    const hands = result.landmarks || [];
    for (let i = 0; i < hands.length; i++) {
      const pts = hands[i];
      const strum = isHandStrumming(hands, pts);
      const color = strum ? "#34d399" : "#f59e0b";
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = Math.max(2.5, canvas.width / 340);

      for (const [from, to] of CONNECTIONS) {
        ctx.beginPath();
        ctx.moveTo((1 - pts[from].x) * canvas.width, pts[from].y * canvas.height);
        ctx.lineTo((1 - pts[to].x) * canvas.width, pts[to].y * canvas.height);
        ctx.stroke();
      }
      for (const pt of pts) {
        ctx.beginPath();
        ctx.arc((1 - pt.x) * canvas.width, pt.y * canvas.height, Math.max(3, canvas.width / 160), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function processHands(result, now, width, height) {
    const hands = result.landmarks || [];
    if (ui.handCount) ui.handCount.textContent = String(hands.length);
    if (hands.length === 0) {
      lastPy = null;
      lastTime = null;
      smoothedVy = 0;
      strumPhase = "neutral";
      return;
    }

    let fretting = null;
    let strumming = null;

    if (hands.length >= 2) {
      const sorted = [...hands].sort((a, b) => a[0].x - b[0].x);
      strumming = sorted[0]; // Player's Right Hand (camera left, x is smaller)
      fretting = sorted[1];  // Player's Left Hand (camera right, x is larger)
    } else {
      const hand = hands[0];
      strumming = hand;
      fretting = hand;
    }

    if (fretting) {
      const detected = classifyChordFromCurls(computeHandCurls(fretting));
      if (detected) {
        if (detected === state.candidateChord) {
          state.candidateCount++;
        } else {
          state.candidateChord = detected;
          state.candidateCount = 1;
        }
        if (state.candidateCount >= 2 && state.candidateChord !== state.selectedChord) {
          changeChord(state.candidateChord, false);
        }
      }
    }

    if (strumming) {
      handleStrumTracking(strumming, now / 1000, width, height);
    } else {
      lastPy = null;
      lastTime = null;
      smoothedVy = 0;
      strumPhase = "neutral";
    }
  }

  // Vision Pipeline & Loop
  async function makeLandmarker(delegate) {
    const { FilesetResolver, HandLandmarker } = await import(
      `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`
    );
    if (!state.fileset) state.fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    return HandLandmarker.createFromOptions(state.fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.40,
      minHandPresenceConfidence: 0.40,
      minTrackingConfidence: 0.40,
    });
  }

  async function ensureLandmarker() {
    try {
      state.landmarker = await makeLandmarker("GPU");
    } catch (e) {
      console.warn("GPU tracking unavailable, trying CPU.", e);
      state.landmarker = await makeLandmarker("CPU");
    }
  }

  function scheduleFrame() {
    if (!state.running) return;
    const cb = (now) => { processFrame(now); scheduleFrame(); };
    state.frameRequestId = video.requestVideoFrameCallback
      ? video.requestVideoFrameCallback(cb)
      : requestAnimationFrame(cb);
  }

  function processFrame(frameTime) {
    if (!state.running || !state.landmarker || video.readyState < 2) return;
    if (video.currentTime === state.lastVideoTime) return;
    state.lastVideoTime = video.currentTime;

    const canvas = ui.canvas;
    const ctx = canvas.getContext("2d");
    const width = video.videoWidth, height = video.videoHeight;
    if (!width || !height) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const timestamp = Math.max(Math.round(frameTime), state.lastTimestamp + 1);
    state.lastTimestamp = timestamp;

    let result;
    try {
      result = state.landmarker.detectForVideo(video, timestamp);
    } catch (_) {
      return;
    }

    drawHands(ctx, canvas, result);
    processHands(result, frameTime || performance.now(), width, height);
  }

  // Camera Start / Stop
  async function startCamera() {
    if (state.running) return;
    try {
      // 1. Initialize & resume AudioContext (requires user gesture — this IS the gesture)
      const audio = ensureAudio();
      await audio.resume();

      // 2. Load all audio samples now that context is running
      if (state.chordBuffers.size === 0) {
        await preloadAllSamples();
      }

      setStatus("Starting camera…");

      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } },
      });
      video.srcObject = state.stream;
      await video.play();
      await ensureLandmarker();

      state.running = true;
      state.lastVideoTime = -1;
      state.lastTimestamp = 0;
      if (ui.cameraButton) {
        ui.cameraButton.textContent = "Stop camera";
        ui.cameraButton.classList.replace("btn-start", "btn-stop");
      }
      if (ui.empty) ui.empty.hidden = true;
      setStatus("Ready");
      scheduleFrame();
    } catch (err) {
      console.error(err);
      await stopCamera();
      setStatus("Error");
    }
  }

  async function stopCamera() {
    state.running = false;
    if (state.frameRequestId !== null) {
      if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(state.frameRequestId);
      else cancelAnimationFrame(state.frameRequestId);
    }
    state.frameRequestId = null;

    if (state.stream) {
      for (const track of state.stream.getTracks()) track.stop();
      state.stream = null;
    }
    video.srcObject = null;
    try { state.landmarker?.close(); } catch (_) {}
    state.landmarker = null;
    lastPy = null;
    lastTime = null;
    smoothedVy = 0;
    strumPhase = "neutral";

    if (ui.cameraButton) {
      ui.cameraButton.textContent = "Start camera";
      ui.cameraButton.classList.replace("btn-stop", "btn-start");
    }
    if (ui.empty) ui.empty.hidden = false;
    if (ui.handCount) ui.handCount.textContent = "0";
    setStatus("Ready");
  }

  ui.cameraButton?.addEventListener("click", () => {
    if (state.running) void stopCamera();
    else void startCamera();
  });

  // Keyboard controls for easy testing
  let keyDir = "down";
  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.code === "ArrowDown") {
      e.preventDefault();
      playChord("down", 8.0);
    } else if (e.code === "ArrowUp") {
      e.preventDefault();
      playChord("up", 8.0);
    } else if (e.code === "Space") {
      e.preventDefault();
      playChord(keyDir, 7.5);
      keyDir = keyDir === "down" ? "up" : "down";
    } else if (e.key >= "1" && e.key <= "9") {
      const chord = CHORD_NAMES[Number(e.key) - 1];
      if (chord) changeChord(chord, true);
    }
  });

  // Autoplay unlock
  const unlockAudio = () => {
    ensureAudio();
    if (state.audio?.state === "suspended") state.audio.resume();
    window.removeEventListener("pointerdown", unlockAudio);
    window.removeEventListener("keydown", unlockAudio);
  };
  window.addEventListener("pointerdown", unlockAudio, { passive: true });
  window.addEventListener("keydown", unlockAudio, { passive: true });

  // Init — do NOT preload audio here; browser autoplay policy requires a user gesture first
  updateChordUI("A");
  window.addEventListener("beforeunload", () => { void stopCamera(); });
})();
