// ========== THIS FILE RUNS IN THE AUDIOWORKLET GLOBAL SCOPE ==========
// NO 'window' HERE! Use 'globalThis' or just omit it.

class AudioAnalyzerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = (e) => {
      if (e.data.type === 'init') {
        this.sampleRate = e.data.sampleRate || 48000;
        this.bufferSize = 2048;
        this.initBuffers();
      }
    };
    this.initBuffers();
  }

  initBuffers() {
    this.fftBuffer = new Float32Array(2048);
    this.fftBufferIndex = 0;
    this.prevRms = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const inputBuffer = input[0];
    const bufferLength = inputBuffer.length;

    // Calculate RMS
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < bufferLength; i++) {
      const sample = inputBuffer[i];
      sumSq += sample * sample;
      if (Math.abs(sample) > peak) peak = Math.abs(sample);
    }
    const rms = Math.sqrt(sumSq / bufferLength);

    // Detect clipping
    const isClipping = peak >= 1.0;

    // Detect onset (simple energy rise)
    const isOnset = rms > this.prevRms * 1.5 && this.prevRms > 0.01;
    this.prevRms = rms;

    // Send measurements to main thread
    this.port.postMessage({
      timestamp: Date.now(),
      peak: 20 * Math.log10(peak + 1e-10),
      rms: 20 * Math.log10(rms + 1e-10),
      isClipping,
      isOnset
    });

    // Pass through audio (optional)
    for (let i = 0; i < input.length; i++) {
      for (let j = 0; j < input[i].length; j++) {
        outputs[0][i][j] = input[i][j];
      }
    }

    return true;
  }
}

// Register the processor
registerProcessor('audio-analyzer-processor', AudioAnalyzerProcessor);
