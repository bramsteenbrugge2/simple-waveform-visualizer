// Headless helper: enumerate audio inputs and report them to the main process,
// which prints them to the terminal. Launched via `npm run devices`.
(async () => {
  const out = [];
  try {
    // Requesting a stream first unlocks device labels.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    stream.getTracks().forEach((t) => t.stop());
    devices
      .filter((d) => d.kind === 'audioinput')
      .forEach((d, i) =>
        out.push({
          index: i,
          label: d.label || '(unknown — grant microphone permission to see names)',
          deviceId: d.deviceId
        })
      );
  } catch (e) {
    out.length = 0;
    out.push({ error: String((e && e.message) || e) });
  }
  window.api.reportDevices(out);
})();
