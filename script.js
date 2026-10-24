const MEDIAPIPE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const BASE = 'meta-open-sound-meta-steel-guitar-wav/';
const LAYER = 'Vel02';

function sample(stringName, pitch) {
  return BASE + 'INSGuitarSteel_' + stringName + '_' + LAYER + '_' + pitch + '_01.wav';
}

const chords = {
  A: ['guitar-chord-a-major_140bpm_A_major-[AudioTrimmer.com].wav'],
  D: [
    sample('StringD', 'D3'),
    sample('StringG', 'A3'),
    sample('StringB', 'D4'),
    sample('StringHighE', 'Fs4')
  ],
  E: [
    sample('StringLowE', 'E2'),
    sample('StringA', 'B2'),
    sample('StringD', 'E3'),
    sample('StringG', 'Gs3'),
    sample('StringB', 'B3'),
    sample('StringHighE', 'E4')
  ],
  G: [
    sample('StringLowE', 'G2'),
    sample('StringA', 'B2'),
    sample('StringD', 'D3'),
    sample('StringG', 'G3'),
    sample('StringB', 'D4'),
    sample('StringHighE', 'G4')
  ],
  C: [
    sample('StringA', 'C3'),
    sample('StringD', 'E3'),
    sample('StringG', 'G3'),
    sample('StringB', 'C4'),
    sample('StringHighE', 'E4')
  ],
  Am: [
    sample('StringA', 'A2'),
    sample('StringD', 'E3'),
    sample('StringG', 'A3'),
    sample('StringB', 'C4'),
    sample('StringHighE', 'E4')
  ],
  Dm: ['guitar-chord-d-minor_140bpm_D_minorguitar-chord-d-minor_140bpm_D_minor.wav'],
  Em: [
    "guitar-chord-e-minor_140bpm_E_minor-[AudioTrimmer.com].wav"
  ]
};

const ALL_PATHS = [...new Set(Object.values(chords).flat())];
const MAX_SECONDS = 1.6;
const VOLUME = 1.0;
const CHOKE_PREVIOUS = true;
const CHOKE_SECONDS = 0.04;

function $(id) {
  return document.getElementById(id);
}

function baseName(path) {
  return path.split('/').pop();
}

let audioContext = null;
let buffers = new Map();
let activeNotes = [];

function setStatus(text) {
  $('status').textContent = text;
}

async function decodeAll(getBytes) {
  if (audioContext === null) {
    audioContext = new AudioContext();
  }

  buffers.clear();

  for (const path of ALL_PATHS) {
    const bytes = await getBytes(path);
    if (bytes === null) {
      continue;
    }
    buffers.set(path, await audioContext.decodeAudioData(bytes));
    $('sampleBadge').textContent = 'Loading ' + buffers.size + '/' + ALL_PATHS.length;
  }

  $('sampleBadge').textContent = buffers.size + '/' + ALL_PATHS.length + ' samples';

  if (buffers.size === ALL_PATHS.length) {
    setStatus('Samples ready. Start the camera.');
  } else if (buffers.size === 0) {
    setStatus('No matching WAV files found. Pick the project folder.');
  } else {
    setStatus('Some samples are missing. Pick the whole project folder.');
  }
}

async function tryHostedSamples() {
  try {
    await decodeAll(async function (path) {
      const response = await fetch(path);
      return response.ok ? response.arrayBuffer() : null;
    });
  } catch (error) {
    console.warn('Hosted samples not available', error);
    buffers.clear();
    $('sampleBadge').textContent = 'Load samples';
    setStatus('Click Load samples and pick the project folder.');
  }
}

$('sampleFiles').addEventListener('change', async function (event) {
  const files = new Map();
  for (const file of event.target.files) {
    files.set(file.name, file);
  }

  try {
    await decodeAll(async function (path) {
      const file = files.get(baseName(path));
      return file ? file.arrayBuffer() : null;
    });
  } catch (error) {
    console.error(error);
    setStatus('Could not decode those WAV files.');
  }
});

function chordIsReady(chordName) {
  return chords[chordName].every(function (path) {
    return buffers.has(path);
  });
}

function chokeActiveNotes(now) {
  for (const note of activeNotes) {
    try {
      note.gain.gain.cancelScheduledValues(now);
      note.gain.gain.setValueAtTime(note.gain.gain.value, now);
      note.gain.gain.linearRampToValueAtTime(0, now + CHOKE_SECONDS);
      note.source.stop(now + CHOKE_SECONDS + 0.01);
    } catch (error) {
      // The note already ended.
    }
  }

  activeNotes = [];
}

function playChord(chordName) {
  if (!chordIsReady(chordName)) {
    setStatus('Missing sample files for ' + chordName);
    return;
  }

  const now = audioContext.currentTime;

  if (CHOKE_PREVIOUS) {
    chokeActiveNotes(now);
  }

  for (const path of chords[chordName]) {
    const source = audioContext.createBufferSource();
    const gain = audioContext.createGain();

    source.buffer = buffers.get(path);
    gain.gain.value = VOLUME;
    source.connect(gain);
    gain.connect(audioContext.destination);
    source.start(now);
    source.stop(now + MAX_SECONDS);

    const note = { source: source, gain: gain };
    activeNotes.push(note);
    source.addEventListener('ended', function () {
      activeNotes = activeNotes.filter(function (n) {
        return n !== note;
      });
    });
  }

  setStatus('Strum: ' + chordName);
  showRisingNotes(Math.max(3, chords[chordName].length));
}

function showRisingNotes(count) {
  const layer = $('noteLayer');

  for (let i = 0; i < count; i++) {
    const note = document.createElement('img');
    note.className = 'rising-note';
    note.src = 'note.png';
    note.alt = '';
    note.style.setProperty('--x', (8 + Math.random() * 82) + '%');
    note.style.setProperty('--drift', Math.round(Math.random() * 130 - 65) + 'px');
    note.style.setProperty('--duration', (2.1 + Math.random() * 1.1) + 's');
    note.style.animationDelay = (i * 0.075) + 's';
    layer.append(note);
    note.addEventListener('animationend', function () {
      note.remove();
    }, { once: true });
  }
}

for (const name of Object.keys(chords)) {
  const button = document.createElement('button');
  button.textContent = name;
  button.addEventListener('click', async function () {
    if (audioContext === null || buffers.size === 0) {
      setStatus('Load samples first.');
      return;
    }
    await audioContext.resume();
    playChord(name);
  });
  $('chordButtons').append(button);
}

$('fretHand').addEventListener('change', function () {
  $('strumHand').value = $('fretHand').value === 'Right' ? 'Left' : 'Right';
});

$('strumHand').addEventListener('change', function () {
  $('fretHand').value = $('strumHand').value === 'Right' ? 'Left' : 'Right';
});

// ----- Finger bend detection -----

const fingers = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20]
};

function distance2d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angle3d(a, b, c) {
  const ba = [a.x - b.x, a.y - b.y, a.z - b.z];
  const bc = [c.x - b.x, c.y - b.y, c.z - b.z];

  let dot = 0;
  for (let i = 0; i < 3; i++) {
    dot += ba[i] * bc[i];
  }

  const lengthBa = Math.sqrt(ba[0] * ba[0] + ba[1] * ba[1] + ba[2] * ba[2]);
  const lengthBc = Math.sqrt(bc[0] * bc[0] + bc[1] * bc[1] + bc[2] * bc[2]);

  if (lengthBa === 0 || lengthBc === 0) {
    return 180;
  }

  let cosine = dot / (lengthBa * lengthBc);
  cosine = Math.max(-1, Math.min(1, cosine));
  return Math.acos(cosine) * 180 / Math.PI;
}

function detectBentFingers(landmarks) {
  const bent = {};

  for (const [fingerName, ids] of Object.entries(fingers)) {
    const base = landmarks[ids[0]];
    const joint1 = landmarks[ids[1]];
    const joint2 = landmarks[ids[2]];
    const tip = landmarks[ids[3]];

    if (fingerName === 'thumb') {
      const angle1 = angle3d(base, joint1, joint2);
      const angle2 = angle3d(joint1, joint2, tip);
      bent.thumb = angle1 < 145 || angle2 < 145;
    } else {
      const tipToBase = distance2d(tip, base);
      const totalLength =
        distance2d(base, joint1) +
        distance2d(joint1, joint2) +
        distance2d(joint2, tip);

      bent[fingerName] = tipToBase / (totalLength + 1e-6) < 0.6;
    }
  }

  return bent;
}

function chooseChord(bent) {
  if (bent.thumb && bent.index) return 'Am';
  if (bent.middle && bent.ring) return 'Dm';
  if (bent.ring && bent.pinky) return 'Em';
  if (bent.thumb) return 'E';
  if (bent.index) return 'A';
  if (bent.middle) return 'D';
  if (bent.ring) return 'G';
  if (bent.pinky) return 'C';
  return null;
}

// ----- MediaPipe setup -----

let mediapipe = null;
let landmarker = null;

async function loadTracker() {
  if (landmarker !== null) {
    return;
  }

  mediapipe = await import(MEDIAPIPE_URL);
  const vision = await mediapipe.FilesetResolver.forVisionTasks(MEDIAPIPE_URL + '/wasm');

  async function create(delegate) {
    return mediapipe.HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: delegate },
      runningMode: 'VIDEO',
      numHands: 2
    });
  }

  try {
    landmarker = await create('GPU');
  } catch (error) {
    console.warn('GPU unavailable, using CPU', error);
    landmarker = await create('CPU');
  }
}

// ----- Strum detection -----
// Speeds are measured in hand-sizes per second, so they do not depend on
// how far you are from the camera.

const WINDOW_SECONDS = 0.12;
const MIN_WINDOW_SECONDS = 0.05;
const HISTORY_SECONDS = 0.25;
const MAX_SPEED = 30;
const SLOW_HOLD_SECONDS = 0.08;
const STRUM_COOLDOWN = 0.25;
const HAND_LOST_RESET_SECONDS = 0.3;
const CHORD_STABLE_FRAMES = 3;

let cameraStream = null;
let running = false;
let lastVideoTime = -1;

let selectedChord = null;
let chordCandidate = null;
let chordCount = 0;

let strumHistory = [];
let handSize = null;
let strumArmed = true;
let strumDirection = null;
let slowSince = null;
let lastStrumTime = 0;
let lastStrumSeen = 0;

const video = document.createElement('video');
video.muted = true;
video.playsInline = true;

const canvas = $('view');
const ctx = canvas.getContext('2d');

function resetStrum() {
  strumHistory = [];
  handSize = null;
  strumArmed = true;
  strumDirection = null;
  slowSince = null;
}

function resetChord() {
  selectedChord = null;
  chordCandidate = null;
  chordCount = 0;
}

function updateChord(newChord) {
  if (newChord === null) {
    chordCandidate = null;
    chordCount = 0;
    return;
  }

  if (newChord === chordCandidate) {
    chordCount++;
  } else {
    chordCandidate = newChord;
    chordCount = 1;
  }

  if (chordCount >= CHORD_STABLE_FRAMES) {
    selectedChord = chordCandidate;
  }
}

function handleStrum(landmarks, now, width, height) {
  lastStrumSeen = now;

  // Palm center is steadier than a single wrist point.
  let x = 0;
  let y = 0;
  for (const id of [0, 5, 9, 13, 17]) {
    x += landmarks[id].x * width;
    y += landmarks[id].y * height;
  }
  x /= 5;
  y /= 5;

  const rawSize = Math.hypot(
    (landmarks[0].x - landmarks[9].x) * width,
    (landmarks[0].y - landmarks[9].y) * height
  );
  handSize = handSize === null ? rawSize : handSize * 0.8 + rawSize * 0.2;

  if (handSize < 8) {
    return;
  }

  strumHistory.push({ t: now, x: x, y: y });
  while (strumHistory.length > 0 && now - strumHistory[0].t > HISTORY_SECONDS) {
    strumHistory.shift();
  }

  let reference = null;
  for (const entry of strumHistory) {
    if (now - entry.t <= WINDOW_SECONDS) {
      reference = entry;
      break;
    }
  }

  if (reference === null || now - reference.t < MIN_WINDOW_SECONDS) {
    return;
  }

  const elapsed = now - reference.t;
  const vx = (x - reference.x) / elapsed / handSize;
  const vy = (y - reference.y) / elapsed / handSize;
  const speed = Math.hypot(vx, vy);

  // A jump this fast is a tracking glitch, not a real movement.
  if (speed > MAX_SPEED) {
    resetStrum();
    return;
  }

  const sensitivity = Number($('sensitivity').value);
  const startSpeed = 4.2 - 0.4 * sensitivity;
  const resetSpeed = startSpeed * 0.4;

  if (!strumArmed) {
    if (speed < resetSpeed) {
      if (slowSince === null) {
        slowSince = now;
      } else if (now - slowSince >= SLOW_HOLD_SECONDS) {
        strumArmed = true;
      }
    } else {
      slowSince = null;
    }

    const reversed =
      strumDirection !== null &&
      speed > resetSpeed &&
      (vx * strumDirection[0] + vy * strumDirection[1]) / speed < -0.3;

    if (reversed) {
      strumArmed = true;
    }
  }

  if (
    strumArmed &&
    selectedChord !== null &&
    speed > startSpeed &&
    now - lastStrumTime > STRUM_COOLDOWN
  ) {
    playChord(selectedChord);
    lastStrumTime = now;
    strumArmed = false;
    strumDirection = [vx / speed, vy / speed];
    slowSince = null;
  }
}

// ----- Main webcam loop -----

const video_ = video;

function loop() {
  if (!running) {
    return;
  }

  // Only analyze when the camera has produced a new frame.
  if (
    video_.readyState >= 2 &&
    video_.videoWidth > 0 &&
    video_.currentTime !== lastVideoTime
  ) {
    lastVideoTime = video_.currentTime;

    const width = video_.videoWidth;
    const height = video_.videoHeight;

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.save();
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video_, 0, 0, width, height);
    ctx.restore();

    try {
      const now = performance.now() / 1000;
      const result = landmarker.detectForVideo(canvas, performance.now());
      const hands = {};
      const scores = {};

      result.landmarks.forEach(function (landmarks, handIndex) {
        const category = result.handedness[handIndex][0];
        const label = category.categoryName;

        // If both hands get the same label, keep the more confident one.
        if (hands[label] === undefined || category.score > scores[label]) {
          hands[label] = landmarks;
          scores[label] = category.score;
        }

        const points = landmarks.map(function (p) {
          return [p.x * width, p.y * height];
        });

        ctx.lineWidth = 2;
        ctx.strokeStyle = '#00ff00';
        for (const connection of mediapipe.HandLandmarker.HAND_CONNECTIONS) {
          ctx.beginPath();
          ctx.moveTo(points[connection.start][0], points[connection.start][1]);
          ctx.lineTo(points[connection.end][0], points[connection.end][1]);
          ctx.stroke();
        }

        ctx.fillStyle = '#ff0000';
        for (const point of points) {
          ctx.beginPath();
          ctx.arc(point[0], point[1], 5, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.fillStyle = '#4da3ff';
        ctx.font = 'bold 20px system-ui, sans-serif';
        ctx.fillText(label, points[0][0], points[0][1] - 15);
      });

      $('handCount').textContent = result.landmarks.length;

      const fretLabel = $('fretHand').value;
      const strumLabel = $('strumHand').value;

      if (hands[fretLabel] && fretLabel !== strumLabel) {
        updateChord(chooseChord(detectBentFingers(hands[fretLabel])));
      } else if (!hands[fretLabel]) {
        updateChord(null);
      }

      $('chordName').textContent = selectedChord !== null ? selectedChord : 'none';

      if (hands[strumLabel]) {
        handleStrum(hands[strumLabel], now, width, height);
      } else if (now - lastStrumSeen > HAND_LOST_RESET_SECONDS) {
        resetStrum();
      }
    } catch (error) {
      console.error(error);
    }
  }

  requestAnimationFrame(loop);
}

function stopCamera() {
  running = false;

  if (cameraStream !== null) {
    cameraStream.getTracks().forEach(function (track) {
      track.stop();
    });
  }

  cameraStream = null;
  video.srcObject = null;
  lastVideoTime = -1;
  resetChord();
  resetStrum();

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  $('videoEmpty').hidden = false;
  $('cameraButton').textContent = 'Start camera';
  $('handCount').textContent = '0';
  $('chordName').textContent = 'none';
}

function cameraError(message) {
  stopCamera();
  $('emptyText').textContent = message;
}

$('cameraButton').addEventListener('click', async function () {
  if (cameraStream !== null) {
    stopCamera();
    return;
  }

  if (audioContext === null || buffers.size === 0) {
    $('emptyText').textContent = 'Load the guitar samples first.';
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $('emptyText').textContent = 'The camera needs localhost or https. Do not open the file directly.';
    return;
  }

  $('emptyText').textContent = 'Requesting camera…';

  try {
    await audioContext.resume();

    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: false
    });

    video.srcObject = cameraStream;
    await video.play();
  } catch (error) {
    console.error(error);

    if (error.name === 'NotAllowedError') {
      cameraError('Camera blocked. Allow it from the address bar and try again.');
    } else if (error.name === 'NotFoundError') {
      cameraError('No camera found.');
    } else if (error.name === 'NotReadableError') {
      cameraError('Another app is using the camera.');
    } else {
      cameraError('Camera error: ' + error.name);
    }
    return;
  }

  try {
    $('emptyText').textContent = 'Loading hand tracking…';
    await loadTracker();

    if (cameraStream === null) {
      return;
    }

    $('videoEmpty').hidden = true;
    $('cameraButton').textContent = 'Stop camera';
    lastVideoTime = -1;
    resetChord();
    resetStrum();
    running = true;
    loop();
  } catch (error) {
    console.error(error);
    cameraError('Hand tracker failed to load. Check your connection.');
  }
});

tryHostedSamples();