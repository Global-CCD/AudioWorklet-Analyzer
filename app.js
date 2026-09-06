// ========== MAIN THREAD ==========
let audioContext;
let audioWorkletNode;
let analyser;
let mediaStreamSource;
let isRunning = false;
let sampleRate = 48000;
let bufferSize = 2048; // 2048, 4096, 8192, 16384

// DOM Elements
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const audioSourceSelect = document.getElementById('audioSource');
const fileInput = document.getElementById('fileInput');
const waveformCanvas = document.getElementById('waveformCanvas');
const spectrumCanvas = document.getElementById('spectrumCanvas');
const spectrogramCanvas = document.getElementById('spectrogramCanvas');
const jsonOutput = document.getElementById('jsonOutput');

// Measurement Display Elements
const peakLevelEl = document.getElementById('peakLevel');
const rmsLevelEl = document.getElementById('rmsLevel');
const crestFactorEl = document.getElementById('crestFactor');
const spectralCentroidEl = document.getElementById('spectralCentroid');
const pitchEl = document.getElementById('pitch');
const loudnessEl = document.getElementById('loudness');
const onsetDetectedEl = document.getElementById('onsetDetected');
const clippingEl = document.getElementById('clipping');

// Visualization State
let waveformCtx = waveformCanvas.getContext('2d');
let spectrumCtx = spectrumCanvas.getContext('2d');
let spectrogramCtx = spectrogramCanvas.getContext('2d');
let spectrogramData = [];
let lastOnsetTime = 0;

// ========== AUDIOWORKLET PROCESSOR ==========
class AudioAnalyzerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = (e) => {
      if (e.data === 'init') {
        this.sampleRate = sampleRate;
        this.bufferSize = bufferSize;
        this.initBuffers();
      }
    };
    this.initBuffers();
  }

  initBuffers() {
    this.fftSize = 2048;
    this.hopSize = bufferSize / 2;
    this.analysisWindow = this.createHanningWindow(this.fftSize);
    this.fftBuffer = new Float32Array(this.fftSize);
    this.fftBufferIndex = 0;
    this.prevBuffer = new Float32Array(bufferSize);
    this.prevRms = 0;
    this.prevSpectralCentroid = 0;
    this.onsetHistory = new Array(10).fill(0);
    this.clipCount = 0;
  }

  createHanningWindow(size) {
    const window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
    }
    return window;
  }

  // Simple FFT (for demonstration; use WASM for production)
  fft(real, imag) {
    const N = real.length;
    for (let k = 0; k < N; k++) {
      let sumReal = 0;
      let sumImag = 0;
      for (let n = 0; n < N; n++) {
        const angle = -2 * Math.PI * k * n / N;
        sumReal += real[n] * Math.cos(angle) - imag[n] * Math.sin(angle);
        sumImag += real[n] * Math.sin(angle) + imag[n] * Math.cos(angle);
      }
      real[k] = sumReal / N;
      imag[k] = sumImag / N;
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const inputBuffer = input[0];
    const bufferLength = inputBuffer.length;

    // ===== TIME DOMAIN MEASUREMENTS =====
    let peak = 0;
    let sumSq = 0;
    let zeroCrossings = 0;
    let clipCount = 0;
    let maxSlew = 0;
    let prevSample = inputBuffer[0];

    for (let i = 0; i < bufferLength; i++) {
      const sample = inputBuffer[i];
      const absSample = Math.abs(sample);

      // Peak
      if (absSample > peak) peak = absSample;

      // RMS
      sumSq += sample * sample;

      // Zero crossings
      if (i > 0 && ((prevSample < 0 && sample >= 0) || (prevSample > 0 && sample <= 0))) {
        zeroCrossings++;
      }

      // Clipping
      if (absSample >= 1.0) clipCount++;

      // Slew rate (dB/ms)
      if (i > 0) {
        const dB = 20 * Math.log10(absSample + 1e-10);
        const prevDB = 20 * Math.log10(Math.abs(prevSample) + 1e-10);
        const slew = Math.abs(dB - prevDB) / (1000 / sampleRate);
        if (slew > maxSlew) maxSlew = slew;
      }

      prevSample = sample;
    }

    const rms = Math.sqrt(sumSq / bufferLength);
    const crestFactor = peak > 0 ? (20 * Math.log10(peak + 1e-10)) - (20 * Math.log10(rms + 1e-10)) : 0;

    // ===== FREQUENCY DOMAIN MEASUREMENTS =====
    // Fill FFT buffer
    for (let i = 0; i < bufferLength; i++) {
      this.fftBuffer[this.fftBufferIndex] = inputBuffer[i] * this.analysisWindow[this.fftBufferIndex % this.fftSize];
      this.fftBufferIndex = (this.fftBufferIndex + 1) % this.fftSize;
    }

    // Only process FFT when buffer is full
    let spectralCentroid = 0;
    let spectralFlatness = 0;
    let dominantFreq = 0;
    let pitch = null;

    if (this.fftBufferIndex === 0) {
      const real = new Float32Array(this.fftSize);
      const imag = new Float32Array(this.fftSize);
      for (let i = 0; i < this.fftSize; i++) {
        real[i] = this.fftBuffer[i];
        imag[i] = 0;
      }

      this.fft(real, imag);

      // Calculate magnitude spectrum
      const magnitude = new Float32Array(this.fftSize / 2);
      let sumMag = 0;
      let sumLogMag = 0;
      let maxMag = 0;
      let weightedSum = 0;

      for (let i = 0; i < this.fftSize / 2; i++) {
        magnitude[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
        if (magnitude[i] > maxMag) {
          maxMag = magnitude[i];
          dominantFreq = i * sampleRate / this.fftSize;
        }
        sumMag += magnitude[i];
        sumLogMag += Math.log(magnitude[i] + 1e-10);
        weightedSum += i * magnitude[i];
      }

      spectralCentroid = weightedSum / sumMag * (sampleRate / this.fftSize);
      spectralFlatness = Math.exp(sumLogMag / (this.fftSize / 2)) / (sumMag / (this.fftSize / 2) + 1e-10);

      // Simple pitch detection (autocorrelation)
      pitch = this.detectPitch(inputBuffer);
    }

    // ===== TEMPORAL ENVELOPE =====
    const shortTermEnergy = rms;
    const longTermEnergy = this.prevRms;
    this.prevRms = shortTermEnergy;

    // Onset detection (spectral flux + energy rise)
    const energyRatio = longTermEnergy > 0 ? shortTermEnergy / longTermEnergy : 1;
    const spectralFlux = Math.abs(spectralCentroid - this.prevSpectralCentroid);
    this.prevSpectralCentroid = spectralCentroid;

    const isOnset = energyRatio > 1.5 && spectralFlux > 500 && (Date.now() - lastOnsetTime) > 100;
    if (isOnset) {
      this.onsetHistory.shift();
      this.onsetHistory.push(1);
      lastOnsetTime = Date.now();
    } else {
      this.onsetHistory.shift();
      this.onsetHistory.push(0);
    }

    const onsetStrength = this.onsetHistory.reduce((a, b) => a + b, 0) / this.onsetHistory.length;

    // ===== PSYCHOACOUSTIC (Simplified) =====
    // A-weighting approximation
    const aWeightedRms = rms * this.aWeightingFactor(dominantFreq);
    const loudnessPhon = this.rmsToPhon(aWeightedRms);

    // ===== LEVEL CHANGE DETECTION =====
    const levelChange = Math.abs(20 * Math.log10(rms + 1e-10) - 20 * Math.log10(this.prevRms + 1e-10));
    const isLevelIncrease = rms > this.prevRms * 1.1;
    const isLevelDecrease = rms < this.prevRms * 0.9;

    // ===== SEND TO MAIN THREAD =====
    const measurements = {
      timestamp: Date.now(),
      // Time domain
      peak: 20 * Math.log10(peak + 1e-10),
      rms: 20 * Math.log10(rms + 1e-10),
      crestFactor: peak / (rms + 1e-10),
      zeroCrossings: zeroCrossings / bufferLength * sampleRate,
      slewRate: maxSlew,
      // Frequency domain
      spectralCentroid,
      spectralFlatness,
      dominantFreq,
      pitch,
      // Psychoacoustic
      loudness: loudnessPhon,
      // Events
      isOnset,
      onsetStrength,
      isClipping: clipCount > 0,
      clipCount,
      // Level changes
      levelChange,
      isLevelIncrease,
      isLevelDecrease,
      // Raw
      sampleRate,
      bufferSize
    };

    this.port.postMessage(measurements);

    return true;
  }

  detectPitch(buffer) {
    const acf = new Float32Array(buffer.length / 2);
    const lagMax = Math.min(buffer.length / 2, 1000);
    let maxAcf = 0;
    let maxLag = 0;

    for (let lag = 1; lag < lagMax; lag++) {
      let sum = 0;
      for (let i = 0; i < buffer.length - lag; i++) {
        sum += buffer[i] * buffer[i + lag];
      }
      acf[lag] = sum;
      if (sum > maxAcf && lag > 20) { // Skip very short lags
        maxAcf = sum;
        maxLag = lag;
      }
    }

    if (maxAcf > 0.1) {
      return sampleRate / maxLag;
    }
    return null;
  }

  aWeightingFactor(freq) {
    // Simplified A-weighting curve
    const f = freq / 1000;
    return 1.2589 * Math.pow(f, 4) /
           (Math.pow(f, 2) + 14.693) /
           (Math.pow(f, 2) + 9.636) /
           (Math.pow(f, 2) + 0.1589);
  }

  rmsToPhon(rms) {
    // Simplified: 0 dBFS = ~100 phon at 1 kHz
    const dBSPL = 20 * Math.log10(rms * 100 + 1e-10); // Approximate
    return dBSPL + 10; // Rough phon estimate
  }
}

// ========== REGISTER AUDIOWORKLET ==========
if (window.AudioWorklet) {
  audioContext = new AudioContext();
  audioContext.audioWorklet.addModule('audio-worklet-processor.js')
    .then(() => {
      console.log('AudioWorklet loaded');
    })
    .catch(err => {
      console.error('AudioWorklet failed to load:', err);
    });
}

// ========== VISUALIZATION & UI ==========
function initVisualizers() {
  // Waveform
  waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
  waveformCtx.fillStyle = '#16213e';
  waveformCtx.fillRect(0, 0, waveformCanvas.width, waveformCanvas.height);

  // Spectrum
  spectrumCtx.clearRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);
  spectrumCtx.fillStyle = '#16213e';
  spectrumCtx.fillRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);

  // Spectrogram
  spectrogramCtx.clearRect(0, 0, spectrogramCanvas.width, spectrogramCanvas.height);
  spectrogramCtx.fillStyle = '#16213e';
  spectrogramCtx.fillRect(0, 0, spectrogramCanvas.width, spectrogramCanvas.height);
}

function updateVisualizers(measurements) {
  // Update measurement displays
  peakLevelEl.textContent = `${measurements.peak.toFixed(1)} dBFS`;
  rmsLevelEl.textContent = `${measurements.rms.toFixed(1)} dBFS`;
  crestFactorEl.textContent = `${measurements.crestFactor.toFixed(1)}`;
  spectralCentroidEl.textContent = `${measurements.spectralCentroid.toFixed(0)} Hz`;
  pitchEl.textContent = measurements.pitch ? `${measurements.pitch.toFixed(0)} Hz` : '-';
  loudnessEl.textContent = `${measurements.loudness.toFixed(0)} phon`;
  onsetDetectedEl.textContent = measurements.isOnset ? 'YES' : 'No';
  onsetDetectedEl.className = measurements.isOnset ? 'success' : '';
  clippingEl.textContent = measurements.isClipping ? 'YES' : 'No';
  clippingEl.className = measurements.isClipping ? 'danger' : '';

  // Update JSON output
  jsonOutput.textContent = JSON.stringify(measurements, null, 2);

  // Draw waveform (simplified)
  drawWaveform(measurements);
}

function drawWaveform(measurements) {
  const canvas = waveformCanvas;
  const ctx = waveformCtx;
  const width = canvas.width;
  const height = canvas.height;

  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = '#6c5ce7';
  ctx.lineWidth = 2;

  // Simulate waveform (in real app, use actual audio buffer)
  ctx.beginPath();
  for (let i = 0; i < width; i++) {
    const x = i;
    const y = height / 2 + Math.sin(i * 0.05 + measurements.timestamp * 0.001) * height / 3;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ========== AUDIO SOURCE HANDLING ==========
async function startAudio() {
  if (isRunning) return;
  isRunning = true;

  startBtn.disabled = true;
  stopBtn.disabled = false;

  try {
    if (audioSourceSelect.value === 'mic') {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamSource = audioContext.createMediaStreamSource(stream);
    } else {
      fileInput.click();
      return; // Will be handled by file input
    }

    // Create analyzer node
    audioWorkletNode = new AudioWorkletNode(audioContext, 'audio-analyzer-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    });

    // Connect nodes
    if (mediaStreamSource) {
      mediaStreamSource.connect(audioWorkletNode);
    }

    audioWorkletNode.connect(audioContext.destination);

    // Handle messages from AudioWorklet
    audioWorkletNode.port.onmessage = (e) => {
      updateVisualizers(e.data);
    };

    // Initialize AudioWorklet
    audioWorkletNode.port.postMessage('init');

    initVisualizers();

  } catch (err) {
    console.error('Error starting audio:', err);
    stopAudio();
  }
}

function stopAudio() {
  if (!isRunning) return;
  isRunning = false;

  startBtn.disabled = false;
  stopBtn.disabled = true;

  if (mediaStreamSource) {
    mediaStreamSource.mediaStream.getTracks().forEach(track => track.stop());
    mediaStreamSource = null;
  }

  if (audioWorkletNode) {
    audioWorkletNode.disconnect();
    audioWorkletNode = null;
  }
}

// File input handler
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const audioBuffer = await audioContext.decodeAudioData(await file.arrayBuffer());
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioWorkletNode);
  source.start();
});

// ========== EVENT LISTENERS ==========
startBtn.addEventListener('click', startAudio);
stopBtn.addEventListener('click', stopAudio);

// ========== INIT ==========
window.addEventListener('load', () => {
  // Check for AudioWorklet support
  if (!window.AudioWorklet) {
    alert('AudioWorklet not supported in your browser. Use Chrome, Edge, or Firefox 60+');
  }
});
