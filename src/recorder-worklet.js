// AudioWorklet processor: forwards raw PCM frames from the input to the main
// thread. Runs on the audio render thread, so it captures every sample
// accurately regardless of UI frame rate.
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const chans = [];
      let hasData = false;
      for (let c = 0; c < input.length; c++) {
        const ch = input[c];
        if (ch && ch.length) {
          hasData = true;
          chans.push(new Float32Array(ch)); // copy: the source buffer is reused
        }
      }
      if (hasData) {
        // transfer the copied buffers to avoid an extra clone
        this.port.postMessage(chans, chans.map((c) => c.buffer));
      }
    }
    return true; // keep the processor alive
  }
}

registerProcessor('capture-processor', CaptureProcessor);
