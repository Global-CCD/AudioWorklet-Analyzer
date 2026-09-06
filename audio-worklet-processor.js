// This file is loaded by AudioWorklet
class AudioAnalyzerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = (e) => {
      if (e.data === 'init') {
        this.sampleRate = 48000; // Default
        this.bufferSize = 2048; // Default
        this.initBuffers();
      }
    };
    this.initBuffers();
  }

  initBuffers() {
    this.fftSize = 2048;
    this.hopSize = this.bufferSize / 2;
    this.analysisWindow = this.createHanningWindow(this.fftSize);
    this.fftBuffer = new Float32Array(this.fftSize);
    this.fftBufferIndex = 0;
    this.prevBuffer = new Float32Array(this.bufferSize);
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

  // FFT implementation (for demo; use WASM for production)
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

    // Time domain measurements
    let peak = 0;
    let sumSq = 0;
    let zeroCrossings = 0;
    let clipCount = 0;
    let maxSlew = 0;
    let prevSample = inputBuffer[0];

    for (let i = 0; i < bufferLength; i++) {
      const sample = inputBuffer[i];
      const absSample = Math.abs(sample);

      if (absSample > peak) peak = absSample;
      sumSq += sample * sample;

      if (i > 0 && ((prevSample < 0 && sample >= 0) || (prevSample > 0 && sample <= 0))) {
        zeroCrossings++;
      }

      if (absSample >= 1.0) clipCount++;

      if (i > 0) {
        const dB = 20 * Math.log10(absSample + 1e-10);
        const prevDB = 20 * Math.log10(Math.abs(prevSample) + 1e-10);
        const slew = Math.abs(dB - prevDB) / (1000 / this.sampleRate);
        if (slew > maxSlew) maxSlew = slew;
      }

      prevSample = sample;
    }

    const rms = Math.sqrt(sumSq / bufferLength);
    const crestFactor = peak > 0 ? peak / rms : 0;

    // Frequency domain (when FFT buffer is full)
    let spectralCentroid = 0;
    let spectralFlatness = 0;
    let dominantFreq = 0;
    let pitch = null;

    if (this.fftBufferIndex === 0) {
      const real = new Float32Array(this.fftSize);
      const imag = new Float32Array(this.fftSize);
      for (let i = 0; i < this.fftSize; i++) {
        real[i] = this.fftBuffer[i] * this.analysisWindow[i];
        imag[i] = 0;
      }

      this.fft(real, imag);

      const magnitude = new Float32Array(this.fftSize / 2);
      let sumMag = 0;
      let sumLogMag = 0;
      let maxMag = 0;
      let weightedSum = 0;

      for (let i = 0; i < this.fftSize / 2; i++) {
        magnitude[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
        if (magnitude[i] > maxMag) {
          maxMag = magnitude[i];
          dominantFreq = i * this.sampleRate / this.fftSize;
        }
        sumMag += magnitude[i];
        sumLogMag += Math.log(magnitude[i] + 1e-10);
        weightedSum += i * magnitude[i];
      }

      spectralCentroid = weightedSum / sumMag * (this.sampleRate / this.fftSize);
      spectralFlatness = Math.exp(sumLogMag / (this.fftSize / 2)) / (sumMag / (this.fftSize / 2) + 1e-10);
      pitch = this.detectPitch(inputBuffer);
    }

    // Fill FFT buffer
    for (let i = 0; i < bufferLength; i++) {
      this.fftBuffer[this.fftBufferIndex] = inputBuffer[i];
      this.fftBufferIndex = (this.fftBufferIndex + 1) % this.fftSize;
    }

    // Temporal envelope
    const shortTermEnergy = rms;
    const longTermEnergy = this.prevRms;
    this.prevRms = shortTermEnergy;

    // Onset detection
    const energyRatio = longTermEnergy > 0 ? shortTermEnergy / longTermEnergy : 1;
    const spectralFlux = Math.abs(spectralCentroid - this.prevSpectralCentroid);
    this.prevSpectralCentroid = spectralCentroid;

    const isOnset = energyRatio > 1.5 && spectralFlux > 500;
    if (isOnset) {
      this.onsetHistory.shift();
      this.onsetHistory.push(1);
    } else {
      this.onsetHistory.shift();
      this.onsetHistory.push(0);
    }
    const onsetStrength = this.onsetHistory.reduce((a, b) => a + b, 0) / this.onsetHistory.length;

    // Psychoacoustic (simplified)
    const aWeightedRms = rms * this.aWeightingFactor(dominantFreq);
    const loudnessPhon = this.rmsToPhon(aWeightedRms);

    // Level changes
    const levelChange = Math.abs(20 * Math.log10(rms + 1e-10) - 20 * Math.log10(this.prevRms + 1e-10));
    const isLevelIncrease = rms > this.prevRms * 1.1;
    const isLevelDecrease = rms < this.prevRms * 0.9;

    // Send to main thread
    const measurements = {
      timestamp: Date.now(),
      peak: 20 * Math.log10(peak + 1e-10),
      rms: 20 * Math.log10(rms + 1e-10),
      crestFactor,
      zeroCrossings: zeroCrossings / bufferLength * this.sampleRate,
      slewRate: maxSlew,
      spectralCentroid,
      spectralFlatness,
      dominantFreq,
      pitch,
      loudness: loudnessPhon,
      isOnset,
      onsetStrength,
      isClipping: clipCount > 0,
      clipCount,
      levelChange,
      isLevelIncrease,
      isLevelDecrease,
      sampleRate: this.sampleRate,
      bufferSize: this.bufferSize
    };

    this.port.postMessage(measurements);

    // Pass through audio (optional)
    for (let i = 0; i < input.length; i++) {
      for (let j = 0; j < input[i].length; j++) {
        outputs[0][i][j] = input[i][j];
      }
    }

    return true;
  }

  detectPitch(buffer) {
    const acf = new Float32Array(buffer.length / 2);
    const lagMax = Math.min(buffer.length / 2, 1000);
    let maxAcf = 0;
    let maxLag = 0;

    for (let lag = 20; lag < lagMax; lag++) {
      let sum = 0;
      for (let i = 0; i < buffer.length - lag; i++) {
        sum += buffer[i] * buffer[i + lag];
      }
      if (sum > maxAcf) {
        maxAcf = sum;
        maxLag = lag;
      }
    }

    if (maxAcf > 0.1) {
      return this.sampleRate / maxLag;
    }
    return null;
  }

  aWeightingFactor(freq) {
    const f = freq / 1000;
    return 1.2589 * Math.pow(f, 4) /
           (Math.pow(f, 2) + 14.693) /
           (Math.pow(f, 2) + 9.636) /
           (Math.pow(f, 2) + 0.1589);
  }

  rmsToPhon(rms) {
    const dBSPL = 20 * Math.log10(rms * 100 + 1e-10);
    return dBSPL + 10;
  }
}

registerProcessor('audio-analyzer-processor', AudioAnalyzerProcessor);
