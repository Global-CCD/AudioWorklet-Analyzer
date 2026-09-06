// ========== WAIT FOR DOM TO BE READY ==========
document.addEventListener('DOMContentLoaded', () => {
  // Now we can safely access DOM elements
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const statusEl = document.getElementById('status');
  const outputEl = document.getElementById('output');

  if (!startBtn || !stopBtn || !statusEl || !outputEl) {
    console.error('ERROR: Required DOM elements not found!');
    return;
  }

  let audioContext;
  let audioWorkletNode;
  let isRunning = false;

  // ========== INIT AUDIO CONTEXT ==========
  async function initAudio() {
    if (!window.AudioWorklet) {
      updateStatus('ERROR: AudioWorklet not supported in this browser.', true);
      return false;
    }

    try {
      audioContext = new AudioContext();
      updateStatus('Loading AudioWorklet module...');

      await audioContext.audioWorklet.addModule('processor.js');
      updateStatus('AudioWorklet ready! Click "Start".', false, true);
      return true;
    } catch (err) {
      updateStatus(`ERROR: ${err.message}`, true);
      return false;
    }
  }

  // ========== HELPER: SAFE STATUS UPDATES ==========
  function updateStatus(message, isError = false, isSuccess = false) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.className = isError ? 'error' : isSuccess ? 'success' : '';
  }

  // ========== START/STOP AUDIO ==========
  async function startAudio() {
    if (isRunning || !audioContext) return;

    isRunning = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    updateOutput('Starting audio...');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const source = audioContext.createMediaStreamSource(stream);

      audioWorkletNode = new AudioWorkletNode(audioContext, 'audio-analyzer-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });

      source.connect(audioWorkletNode);
      audioWorkletNode.connect(audioContext.destination);

      audioWorkletNode.port.onmessage = (e) => {
        updateOutput(JSON.stringify(e.data, null, 2));
      };

      audioWorkletNode.port.postMessage({ type: 'init', sampleRate: audioContext.sampleRate });

    } catch (err) {
      updateOutput(`ERROR: ${err.message}`);
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

  // ========== HELPER: SAFE OUTPUT UPDATES ==========
  function updateOutput(message) {
    if (!outputEl) return;
    outputEl.textContent = message;
  }

  // ========== EVENT LISTENERS ==========
  startBtn.addEventListener('click', startAudio);
  stopBtn.addEventListener('click', stopAudio);

  // ========== INIT ON DOM READY ==========
  initAudio();
});
