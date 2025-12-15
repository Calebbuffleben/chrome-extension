class MonoCaptureProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this._processCount = 0;
	}
	process(inputs) {
		this._processCount++;
		if (this._processCount <= 3) {
			console.log('[worklet-processor] process called', { count: this._processCount, inputsLen: inputs?.length });
		}
		const input = inputs && inputs[0];
		if (!input || input.length === 0) {
			if (this._processCount <= 3) console.log('[worklet-processor] no input');
			return true;
		}
		const channels = input.length;
		const length = input[0]?.length || 0;
		if (length === 0) {
			if (this._processCount <= 3) console.log('[worklet-processor] empty input');
			return true;
		}
		if (this._processCount <= 3) {
			console.log('[worklet-processor] processing', { channels, len: length });
		}
		const mono = new Float32Array(length);
		for (let ch = 0; ch < channels; ch++) {
			const chData = input[ch];
			for (let i = 0; i < length; i++) {
				mono[i] += chData[i];
			}
		}
		if (channels > 1) {
			for (let i = 0; i < length; i++) mono[i] /= channels;
		}
		// Transfer binary to main thread
		this.port.postMessage(mono.buffer, [mono.buffer]);
		return true;
	}
}

registerProcessor('mono-capture', MonoCaptureProcessor);


