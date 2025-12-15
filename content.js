// Content script
// - Faz a ponte das mensagens do background -> página via window.postMessage (MAIN world)
// - Scripts (audio-capture.js, feedback-overlay.js, socket.io) são injetados pelo background via executeScript (MAIN world)

(function () {
	let currentTabId = null;
	
	let wsPort = null;
	let portConnectionAttempts = 0;
	let portCreationPending = false;
	let messageQueue = []; // Queue messages while port is being created
	
	function ensurePort() {
		try {
			// Check if extension context is still valid
			if (!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id)) {
				console.error('[content] chrome.runtime not available - extension context invalidated', {
					hasChrome: typeof chrome !== 'undefined',
					hasRuntime: !!(chrome && chrome.runtime),
					runtimeId: chrome?.runtime?.id
				});
				// Extension was reloaded or context invalidated - notify the page
				try {
					window.postMessage({ 
						type: 'EXTENSION_CONTEXT_INVALIDATED',
						message: 'Extension was reloaded. Please refresh the page.'
					}, '*');
				} catch (_e) {}
				return null;
			}
			
			// If port exists and seems healthy, return it
			if (wsPort) {
				try {
					// Test if port is still alive
					wsPort.postMessage({ type: 'PING' });
					return wsPort;
				} catch (testErr) {
					// Port is dead, clear it
					console.warn('[content] Existing port is dead, will recreate', testErr);
					wsPort = null;
				}
			}
			
			if (portCreationPending) {
				console.log('[content] Port creation already pending');
				return null;
			}
			
			portCreationPending = true;
			portConnectionAttempts++;
			console.log('[content] Creating new port connection', { attempt: portConnectionAttempts });
			
			// Wake up service worker SYNCHRONOUSLY before creating port
			let wakeupSuccess = false;
			try {
				chrome.runtime.sendMessage({ type: 'KEEPALIVE' }, (response) => {
					wakeupSuccess = true;
					void chrome.runtime.lastError;
				});
			} catch (pingErr) {
				console.warn('[content] Wakeup message failed:', pingErr);
			}
			
			// Small delay to allow service worker to wake up
			setTimeout(() => {
				try {
					if (wsPort) {
						console.log('[content] Port already exists from previous attempt');
						portCreationPending = false;
						return;
					}
					
					wsPort = chrome.runtime.connect({ name: 'audio-ws' });
					
					wsPort.onDisconnect.addListener(() => {
						const err = chrome.runtime.lastError;
						console.warn('[content] Port disconnected', { 
							error: err?.message,
							attempt: portConnectionAttempts
						});
						wsPort = null;
						portCreationPending = false;
						
						// Try to reconnect after a delay if we're still streaming
						setTimeout(() => {
							if (!wsPort && portConnectionAttempts < 10) {
								console.log('[content] Attempting to reconnect port...');
								ensurePort();
							}
						}, 1000);
					});
					
					wsPort.onMessage.addListener((msg) => {
						console.log('[content] Received message from background:', msg?.type);
					});
					
					// Test the port connection
					try {
						wsPort.postMessage({ type: 'PING' });
						console.log('[content] Port connected and tested successfully');
					} catch (testErr) {
						console.error('[content] Port test failed:', testErr);
						wsPort = null;
					}
					
					portCreationPending = false;
					
					// Flush queued messages now that port is ready
					if (messageQueue.length > 0) {
						console.log('[content] Flushing message queue', { count: messageQueue.length });
						const queue = messageQueue.slice();
						messageQueue = [];
						for (const msg of queue) {
							try {
								wsPort.postMessage(msg);
							} catch (err) {
								console.error('[content] Failed to send queued message:', err, msg);
							}
						}
					}
				} catch (e) {
					console.error('[content] Failed to create port in delayed callback:', e);
					wsPort = null;
					portCreationPending = false;
				}
			}, 100);
			
			return null; // Will be available after the timeout
		} catch (e) {
			console.error('[content] Failed to create port:', e);
			wsPort = null;
			portCreationPending = false;
			return null;
		}
	}

	function registerRuntimeListener() {
		try {
			if (!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id)) {
				return;
			}
			const handler = (message, _sender, sendResponse) => {
					if (message?.type === 'INJECT_AND_START_MULTITRACK') {
					// NEW: Multi-track mode
					const payload = message.payload || {};
					if (typeof payload.tabId === 'number') {
						currentTabId = payload.tabId;
					}
					
					// Initialize multi-track audio capture
					window.postMessage({ type: 'AUDIO_CAPTURE_START_MULTITRACK', payload }, '*');
					
					// Initialize overlay
					const overlayPayload = {
						meetingId: payload.meetingId,
						feedbackHttpBase: payload.feedbackHttpBase
					};
					window.postMessage({ type: 'FEEDBACK_OVERLAY_START', payload: overlayPayload }, '*');
					
					sendResponse?.({ ok: true });
					return true;
				}
				
				if (message?.type === 'INJECT_AND_START') {
					// LEGACY: Single-stream mode
					const payload = message.payload || {};
					if (typeof payload.tabId === 'number') {
						currentTabId = payload.tabId;
					}
					
					// Iniciar captura de áudio
					if (payload.streamId) {
						window.postMessage({ type: 'AUDIO_CAPTURE_START', payload }, '*');
					}
					
					// Iniciar overlay
					const overlayPayload = {
						meetingId: payload.meetingId,
						feedbackHttpBase: payload.feedbackHttpBase
					};
					window.postMessage({ type: 'FEEDBACK_OVERLAY_START', payload: overlayPayload }, '*');
					
					sendResponse?.({ ok: true });
					return true;
				}

				if (message?.type === 'STOP_CAPTURE') {
					window.postMessage({ type: 'AUDIO_CAPTURE_STOP' }, '*');
					sendResponse?.({ ok: true });
					return true;
				}

				if (message?.type === 'CAPTURE_FAILED') {
					console.warn('[content] Falha ao capturar áudio da aba:', message.error);
					sendResponse?.({ ok: true });
					return true;
				}
				return undefined;
			};
			chrome.runtime.onMessage.addListener(handler);
			try {
				if (chrome.runtime && typeof chrome.runtime.getManifest === 'function') {
					const manifest = chrome.runtime.getManifest();
					if (manifest && manifest.manifest_version === 3 && chrome.runtime.onSuspend) {
						chrome.runtime.onSuspend.addListener(() => {
							try {
								chrome.runtime.onMessage.removeListener(handler);
							} catch (_e) {}
						});
					}
				}
			} catch (_e) {}
		} catch (_e) {}
	}

	registerRuntimeListener();

	// Verify extension is loaded
	console.log('[content] Content script loaded');

	// Bridge page->background for audio WS
	window.addEventListener('message', (event) => {
		if (event.source !== window) return;
		const data = event.data || {};
		
		if (data.type === 'AUDIO_WS_OPEN') {
			const url = data.url;
			const tabId = data.tabId ?? currentTabId;
			const participantId = data.participantId; // NEW: participant ID for multi-track
			if (!url) return;
			const port = ensurePort();
			const message = { type: 'AUDIO_WS_OPEN', tabId, url, participantId };
			if (!port) {
				// Port is being created, queue the message
				console.log('[content] Queueing AUDIO_WS_OPEN (port not ready yet)', { participantId });
				messageQueue.push(message);
				return;
			}
			try {
				port.postMessage(message);
			} catch (e) {
				console.error('[content] Failed to send AUDIO_WS_OPEN:', e);
			}
			return;
		}
		if (data.type === 'AUDIO_WS_SEND') {
			const buf = data.buffer;
			const tabId = data.tabId ?? currentTabId;
			const participantId = data.participantId; // NEW: participant ID for multi-track
			if (!buf) return;
			const port = ensurePort();
			
			try {
				let arrayBuffer = null;
				let byteLength = 0;
				if (buf instanceof ArrayBuffer) {
					arrayBuffer = buf.slice(0);
					byteLength = arrayBuffer.byteLength;
				} else if (ArrayBuffer.isView(buf)) {
					const view = buf;
					arrayBuffer = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
					byteLength = view.byteLength;
				} else {
					return;
				}
				
				// Convert to Uint8Array for better serialization support in port.postMessage
				const uint8Array = new Uint8Array(arrayBuffer);
				const message = { type: 'AUDIO_WS_SEND', tabId, buffer: uint8Array, byteLength, participantId };
				
				if (!port) {
					// Port is being created, queue the message (but limit queue size to prevent memory issues)
					if (messageQueue.length < 50) { // Max 50 queued audio chunks
						messageQueue.push(message);
					}
					return;
				}
				
				try {
					port.postMessage(message);
				} catch (postErr) {
					console.error('[content] postMessage failed:', postErr);
					wsPort = null; // Force reconnect on next send
				}
			} catch (e) {
				console.error('[content] Error sending to background:', e);
			}
			return;
		}
		if (data.type === 'AUDIO_WS_CLOSE') {
			const tabId = data.tabId ?? currentTabId;
			const participantId = data.participantId; // NEW: participant ID for multi-track
			const port = ensurePort();
			const message = { type: 'AUDIO_WS_CLOSE', tabId, participantId };
			if (!port) {
				// Port is being created, queue the message
				messageQueue.push(message);
				return;
			}
			try {
				port.postMessage(message);
			} catch (_e) {}
			return;
		}
	}, false);
})();
