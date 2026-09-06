// ========== MAIN THREAD (NO AudioWorkletProcessor HERE!) ==========
let audioContext;
let audioWorkletNode;
let isRunning = false;

// DOM Elements
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');

// ========== INIT AUDIO CONTEXT ==========
async function initAudio() {
  if (!window.AudioWorklet) {
    statusEl.textContent = "ERROR: AudioWorklet not supported in this browser.";
    return false;
  }

  audioContext = new AudioContext();
  statusEl.textContent = "Loading AudioWorklet module...";

  try {
    // Load the AudioWorklet processor module
    await audioContext.audioWorklet.addModule('processor.js');
    statusEl.textContent = "AudioWorklet ready! Click 'Start'.";
    statusEl.className = 'success';
    return true;
  } catch (err) {
    statusEl.textContent = `ERROR: Failed to load AudioWorklet: ${err.message}`;
    return false;
  }
}

// ========== START/STOP AUDIO ==========
async function startAudio() {
  if (isRunning) return;
  isRunning = true;

  startBtn.disabled = true;
  stopBtn.disabled = false;
  outputEl.textContent = "Starting audio...";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const source = audioContext.createMediaStreamSource(stream);

    // Create the AudioWorklet node
    audioWorkletNode = new AudioWorkletNode(audioContext, 'audio-analyzer-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    });

    // Connect: Mic → AudioWorklet → Speakers (optional)
    source.connect(audioWorkletNode);
    audioWorkletNode.connect(audioContext.destination);

    // Handle messages from AudioWorklet
    audioWorkletNode.port.onmessage = (e) => {
      outputEl.textContent = JSON.stringify(e.data, null, 2);
    };

    // Initialize the processor
    audioWorkletNode.port.postMessage({ type: 'init', sampleRate: audioContext.sampleRate });

  } catch (err) {
    outputEl.textContent = `ERROR: ${err.message}`;
    stopAudio();
  }
}

function stopAudio() {
  if (!isRunning) return;
  isRunning = false;

  startBtn.disabled = false;
  stopBtn.disabled = true;

  if (audioWorkletNode) {
    audioWorkletNode.disconnect();
    audioWorkletNode = null;
  }

  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close().catch(console.error);
    audioContext = null;
  }
}

// ========== EVENT LISTENERS ==========
startBtn.addEventListener('click', startAudio);
stopBtn.addEventListener('click', stopAudio);

// ========== INIT ON LOAD ==========
window.addEventListener('load', initAudio);
