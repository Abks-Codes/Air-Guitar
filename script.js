const MEDIAPIPE_VERSION = "0.10.14";
const WASM_URL   = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_URL  = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// Files on disk: chords/A_down.wav, chords/A_up.wav, etc.
const CHORDS = ["E", "A", "D", "G", "C", "Am", "Dm", "Em", "Gm"];

// ── MediaPipe landmark pairs to draw the hand skeleton ──────
const BONES = [
  [0,1],[1,2],[2,3],[3,4],         // thumb
  [0,5],[5,6],[6,7],[7,8],         // index
  [5,9],[9,10],[10,11],[11,12],    // middle
  [9,13],[13,14],[14,15],[15,16],  // ring
  [13,17],[17,18],[18,19],[19,20], // pinky
  [0,17],                          // palm edge
];


const ui = {
  canvas:      document.getElementById("view"),
  emptyBox:    document.getElementById("videoEmpty"),
  btn:         document.getElementById("cameraButton"),
  chordName:   document.getElementById("chordName"),
  handCount:   document.getElementById("handCount"),
  status:      document.getElementById("status"),
  statePill:   document.getElementById("statePill"),
  noteLayer:   document.getElementById("dynamicNotesLayer"),
};

// Hidden <video> element that receives the webcam stream
const video = document.createElement("video");
video.autoplay = true; video.playsInline = true; video.muted = true;
video.style.display = "none";
document.body.appendChild(video);


let audioCtx    = null;   // Web Audio context
let masterGain  = null;   // master volume node
let sounds      = {};     // { "A_down": AudioBuffer, "A_up": AudioBuffer, … }
let landmarker  = null;   // MediaPipe HandLandmarker
let fileset     = null;   // MediaPipe file resolver (reused)
let camStream   = null;   // webcam MediaStream
let running     = false;  // is the camera loop active?
let frameId     = null;   // rAF / rVFC handle
let lastTime    = -1;     // last processed video.currentTime (dedup frames)
let lastTs      = 0;      // last MediaPipe timestamp

let chord       = "A";    // currently selected chord
let candidate   = null;   // gesture the fretting hand is holding
let candCount   = 0;      // how many frames the candidate has been stable
let lastChange  = 0;      // when the chord last changed (seconds)

// Strum tracking variables
let prevY       = null;   // hand Y position from previous frame
let prevT       = null;   // time of previous frame
let velocity    = 0;      // smoothed vertical velocity (px/s)
let armedDown   = true;   // can a down-strum fire right now?
let armedUp     = true;   // can an up-strum fire right now?
let lastStrum   = 0;      // when last strum fired

// ── Helper: update the status pill text ─────────────────────
function setStatus(txt) { if (ui.status) ui.status.textContent = txt; }

//------------------------------------
// AUDIO SETUP
// Must be called only after the user clicks (browser rule).
//------------------------------------
function setupAudio() {
  if (audioCtx) return; // already set up

  audioCtx   = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.85;

  // Compressor prevents clipping when multiple notes overlap
  const comp = audioCtx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.ratio.value     = 4;

  // Signal chain: gain → compressor → speakers
  masterGain.connect(comp);
  comp.connect(audioCtx.destination);
}

// Load all 18 chord WAV files (9 chords × up + down).
// Decodes them into AudioBuffers and stores in `sounds`.
async function loadAudio() {
  setStatus("Loading audio…");

  const jobs = CHORDS.flatMap(name =>
    ["down", "up"].map(async dir => {
      try {
        const res = await fetch(`chords/${name}_${dir}.wav`);
        if (!res.ok) return;
        sounds[`${name}_${dir}`] = await audioCtx.decodeAudioData(await res.arrayBuffer());
      } catch (e) {
        console.warn(`Could not load chords/${name}_${dir}.wav`, e);
      }
    })
  );

  await Promise.all(jobs);
  console.log(`Loaded ${Object.keys(sounds).length} audio files.`);
  setStatus("Ready");
}

//------------------------------------
// PLAY A CHORD
// direction = "down" or "up"
//------------------------------------
function playChord(direction) {
  if (!audioCtx || !masterGain) return; // audio not ready
  if (audioCtx.state === "suspended") { audioCtx.resume(); return; }

  const key    = `${chord}_${direction}`;
  const buffer = sounds[key] || sounds[`${chord}_down`]; // fallback to down
  if (!buffer) return;

  const src  = audioCtx.createBufferSource();
  const gain = audioCtx.createGain();
  src.buffer       = buffer;
  gain.gain.value  = 0.9;

  src.connect(gain);
  gain.connect(masterGain);
  src.start();

  // Visual feedback: flash the status pill and show the strum direction
  const isDown = direction === "down";
  setStatus(isDown ? "⬇️ Down" : "⬆️ Up");
  if (ui.statePill) {
    ui.statePill.classList.remove("flash-down", "flash-up");
    void ui.statePill.offsetWidth; // force reflow so animation restarts
    ui.statePill.classList.add(isDown ? "flash-down" : "flash-up");
    setTimeout(() => ui.statePill.classList.remove("flash-down", "flash-up"), 300);
  }

  // Burst floating music notes on screen
  burstNotes();
}

// Spawn 3 animated note images that float upward
function burstNotes() {
  if (!ui.noteLayer) return;
  for (let i = 0; i < 3; i++) {
    const img = document.createElement("img");
    img.className = "burst-note";
    img.src       = "note.png";

    const onRight  = Math.random() > 0.4;
    const x        = onRight ? 76 + Math.random() * 20 : 4 + Math.random() * 18;
    img.style.left = `${x}%`;
    img.style.setProperty("--dx",  `${(Math.random() * 80 - 40)}px`);
    img.style.setProperty("--rot", `${Math.round(Math.random() * 60 - 30)}deg`);
    img.style.setProperty("--dur", `${(1.4 + Math.random() * 0.8).toFixed(2)}s`);
    img.style.animationDelay = `${i * 0.06}s`;

    ui.noteLayer.appendChild(img);
    img.addEventListener("animationend", () => img.remove(), { once: true });
  }
}

//------------------------------------
// CHORD DETECTION  (fretting / left hand)
// Uses how bent each finger is to identify the chord gesture.
//------------------------------------

// Distance between two 3D landmarks
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

// Angle at point B formed by the line A-B-C (in degrees)
function angleDeg(a, b, c) {
  const ba = [a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0)];
  const bc = [c.x - b.x, c.y - b.y, (c.z || 0) - (b.z || 0)];
  const dot   = ba[0]*bc[0] + ba[1]*bc[1] + ba[2]*bc[2];
  const magBa = Math.hypot(...ba);
  const magBc = Math.hypot(...bc);
  if (!magBa || !magBc) return 180;
  return Math.acos(Math.max(-1, Math.min(1, dot / (magBa * magBc)))) * (180 / Math.PI);
}

// Returns a curl score 0–1 for each finger (0 = open, 1 = fully bent)
function getCurls(pts) {
  const wrist    = pts[0];
  const palmSize = Math.max(0.01, dist(wrist, pts[9])); // wrist to middle knuckle

  // For each of the 4 fingers, measure how curled it is using 3 indicators
  const fingerDefs = [
    { name: "index",  mcp: 5,  pip: 6,  dip: 7,  tip: 8  },
    { name: "middle", mcp: 9,  pip: 10, dip: 11, tip: 12 },
    { name: "ring",   mcp: 13, pip: 14, dip: 15, tip: 16 },
    { name: "pinky",  mcp: 17, pip: 18, dip: 19, tip: 20 },
  ];

  const curls = {};
  for (const f of fingerDefs) {
    const tipToWrist  = dist(pts[f.tip], wrist)    / palmSize;
    const tipToKnucle = dist(pts[f.tip], pts[f.mcp]) / palmSize;
    const jointAngle  = angleDeg(pts[f.mcp], pts[f.pip], pts[f.dip]);

    let score = 0;
    if (tipToWrist  < 1.1)  score += 0.45; else if (tipToWrist  < 1.35) score += 0.2;
    if (tipToKnucle < 0.6)  score += 0.35; else if (tipToKnucle < 0.8)  score += 0.15;
    if (jointAngle  < 125)  score += 0.35; else if (jointAngle  < 145)  score += 0.15;
    curls[f.name] = Math.min(1.0, score);
  }

  // Thumb uses different landmarks — check if it crosses toward the palm
  let thumbScore = 0;
  if (dist(pts[4], pts[13]) / palmSize < 0.62) thumbScore += 0.5;
  if (dist(pts[4], pts[5])  / palmSize < 0.42) thumbScore += 0.35;
  if (angleDeg(pts[1], pts[2], pts[3]) < 140)  thumbScore += 0.3;
  curls.thumb = Math.min(1.0, thumbScore);

  return curls;
}

// Given curl scores, decide which chord the hand is forming
function detectChord(curls) {
  // Sort fingers from most bent to least bent
  const ranked = Object.entries(curls).sort((a, b) => b[1] - a[1]);
  const [top, topScore]    = ranked[0];
  const [sec, secScore]    = ranked[1];
  const [,    thirdScore]  = ranked[2];

  // One finger clearly bent more than the rest → single-finger chord
  if (topScore >= 0.52 && topScore - secScore >= 0.20) {
    return { thumb:"E", index:"A", middle:"D", ring:"G", pinky:"C" }[top] || null;
  }

  // Two fingers bent together → two-finger chord
  if (topScore >= 0.48 && secScore >= 0.42 && secScore - thirdScore >= 0.14) {
    const pair = new Set([top, sec]);
    if (pair.has("thumb")  && pair.has("index"))  return "Am";
    if (pair.has("middle") && pair.has("ring"))   return "Dm";
    if (pair.has("ring")   && pair.has("pinky"))  return "Em";
    if (pair.has("thumb")  && pair.has("middle")) return "Gm";
  }

  return null;
}

//------------------------------------
// STRUM DETECTION  (strumming / right hand)
// Measures vertical hand speed. One strum sound per stroke.
//------------------------------------
function detectStrum(pts, now, canvasHeight) {
  // Use the average Y of several hand landmarks (wrist + knuckles + fingertips)
  const ids = [0, 5, 8, 9, 12, 13, 17];
  const y   = ids.reduce((sum, i) => sum + pts[i].y * canvasHeight, 0) / ids.length;

  // First frame — just store position and return
  if (prevY === null) { prevY = y; prevT = now; return; }

  const dt  = Math.max(0.008, now - prevT);
  const raw = (y - prevY) / dt;  // raw vertical speed in pixels/second
  prevY = y;
  prevT = now;

  // Smooth the raw speed to reduce jitter (exponential moving average)
  velocity = velocity * 0.35 + raw * 0.65;

  const THRESHOLD = 110; // px/s needed to trigger a strum
  const cooldown  = now - lastStrum;

  // Re-arm the opposite direction when hand reverses, or both when it rests
  if (velocity < -35)            armedDown = true;   // moving up  → can do down next
  else if (velocity > 35)        armedUp   = true;   // moving down → can do up next
  else if (Math.abs(velocity) < 25) { armedDown = true; armedUp = true; } // at rest

  // Fire down-strum (hand moving downward)
  if (velocity > THRESHOLD && armedDown && cooldown >= 0.08) {
    playChord("down");
    armedDown = false;  // won't fire again until hand reverses
    lastStrum = now;
  }

  // Fire up-strum (hand moving upward)
  if (velocity < -THRESHOLD && armedUp && cooldown >= 0.08) {
    playChord("up");
    armedUp   = false;
    lastStrum = now;
  }
}

//------------------------------------
// DRAWING  — mirror the webcam, overlay hand skeletons
//------------------------------------
function drawFrame(ctx, W, H, result) {
  // Draw mirrored webcam video
  ctx.save();
  ctx.translate(W, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, W, H);
  ctx.restore();

  const hands = result.landmarks || [];
  for (let i = 0; i < hands.length; i++) {
    const pts   = hands[i];
    // Strumming hand (right, smaller raw x) = green. Fretting = orange.
    const isStrumming = hands.length < 2 || pts[0].x < [...hands].sort((a,b)=>a[0].x-b[0].x)[1][0].x;
    const color = isStrumming ? "#34d399" : "#f59e0b";

    ctx.strokeStyle = color;
    ctx.fillStyle   = color;
    ctx.lineWidth   = 2.5;

    // Draw bones
    for (const [a, b] of BONES) {
      ctx.beginPath();
      ctx.moveTo((1 - pts[a].x) * W, pts[a].y * H);
      ctx.lineTo((1 - pts[b].x) * W, pts[b].y * H);
      ctx.stroke();
    }
    // Draw landmark dots
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc((1 - p.x) * W, p.y * H, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

//------------------------------------
// PROCESS HANDS each frame
// Separates fretting vs strumming and calls the right logic
//------------------------------------
function processHands(result, now, W, H) {
  const hands = result.landmarks || [];
  if (ui.handCount) ui.handCount.textContent = String(hands.length);

  if (hands.length === 0) {
    // Reset strum state when no hands are visible
    prevY = null; prevT = null; velocity = 0;
    armedDown = true; armedUp = true;
    return;
  }

  // Sort hands by raw X — left in raw image = player's right hand = strumming
  const sorted  = [...hands].sort((a, b) => a[0].x - b[0].x);
  const strumHand = sorted[0];              // player's right hand
  const fretHand  = sorted[sorted.length - 1]; // player's left hand (or same if 1 hand)

  // Fretting hand: detect which chord is being held
  const detected = detectChord(getCurls(fretHand));
  if (detected) {
    if (detected === candidate) {
      candCount++;
    } else {
      candidate  = detected;
      candCount  = 1;
    }
    // Need 2 stable frames before locking in the chord (prevents flicker)
    const nowSec = performance.now() / 1000;
    if (candCount >= 2 && candidate !== chord && nowSec - lastChange >= 0.12) {
      chord      = candidate;
      lastChange = nowSec;
      if (ui.chordName) ui.chordName.textContent = chord;
    }
  }

  // Strumming hand: detect swipe up/down
  detectStrum(strumHand, now, H);
}

//------------------------------------
// MAIN LOOP — runs every video frame
//------------------------------------
function loop(frameTime) {
  if (!running) return;

  // Schedule the next frame
  if (video.requestVideoFrameCallback) {
    frameId = video.requestVideoFrameCallback(loop);
  } else {
    frameId = requestAnimationFrame(loop);
  }

  // Skip if video hasn't advanced
  if (video.readyState < 2 || video.currentTime === lastTime) return;
  lastTime = video.currentTime;

  const canvas = ui.canvas;
  const ctx    = canvas.getContext("2d");
  const W      = video.videoWidth;
  const H      = video.videoHeight;
  if (!W || !H) return;

  // Resize canvas to match video if needed
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W; canvas.height = H;
  }

  // MediaPipe requires a strictly increasing timestamp
  const ts = Math.max(Math.round(frameTime), lastTs + 1);
  lastTs   = ts;

  let result;
  try { result = landmarker.detectForVideo(video, ts); }
  catch (_) { return; }

  drawFrame(ctx, W, H, result);
  processHands(result, frameTime / 1000, W, H);
}

//------------------------------------
// CAMERA  —  start and stop
//------------------------------------
async function startCamera() {
  if (running) return;

  try {
    // Set up audio (must happen on a user click)
    setupAudio();
    await audioCtx.resume();
    if (Object.keys(sounds).length === 0) await loadAudio();

    setStatus("Starting camera…");

    // Open webcam
    camStream       = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    video.srcObject = camStream;
    await video.play();

    // Load MediaPipe hand tracker
    const { FilesetResolver, HandLandmarker } = await import(
      `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`
    );
    if (!fileset) fileset = await FilesetResolver.forVisionTasks(WASM_URL);

    try {
      landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO", numHands: 2,
        minHandDetectionConfidence: 0.4,
        minHandPresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });
    } catch (_) {
      // GPU not available — fall back to CPU
      landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
        runningMode: "VIDEO", numHands: 2,
        minHandDetectionConfidence: 0.4,
        minHandPresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });
    }

    running  = true;
    lastTime = -1;
    lastTs   = 0;

    ui.btn.textContent = "Stop camera";
    ui.btn.classList.replace("btn-start", "btn-stop");
    if (ui.emptyBox) ui.emptyBox.hidden = true;
    setStatus("Ready");

    // Kick off the frame loop
    if (video.requestVideoFrameCallback) {
      frameId = video.requestVideoFrameCallback(loop);
    } else {
      frameId = requestAnimationFrame(loop);
    }

  } catch (err) {
    console.error(err);
    stopCamera();
    setStatus("Error — check camera permissions");
  }
}

function stopCamera() {
  running = false;

  if (frameId !== null) {
    if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameId);
    else cancelAnimationFrame(frameId);
    frameId = null;
  }

  if (camStream) {
    camStream.getTracks().forEach(t => t.stop());
    camStream = null;
  }
  video.srcObject = null;

  try { landmarker?.close(); } catch (_) {}
  landmarker = null;

  // Reset strum state
  prevY = null; prevT = null; velocity = 0;
  armedDown = true; armedUp = true;

  ui.btn.textContent = "Start camera";
  ui.btn.classList.replace("btn-stop", "btn-start");
  if (ui.emptyBox) ui.emptyBox.hidden = false;
  if (ui.handCount) ui.handCount.textContent = "0";
  setStatus("Ready");
}

//------------------------------------
// Button click 
//------------------------------------
ui.btn.addEventListener("click", () => {
  if (running) stopCamera();
  else startCamera();
});


window.addEventListener("beforeunload", stopCamera);
