// WebRTC Interceptor for Google Meet
// This script MUST be injected BEFORE Meet initializes (document_start)
// Purpose: Intercept RTCPeerConnection to capture all remote audio tracks

(function () {
	// Prevent double-initialization
	if (window.__webrtcInterceptorInitialized) {
		console.log('[webrtc-interceptor] Already initialized, skipping');
		return;
	}
	window.__webrtcInterceptorInitialized = true;
	
	console.log('[webrtc-interceptor] Initializing RTCPeerConnection wrapper');

	// Store original RTCPeerConnection
	const OriginalRTCPeerConnection = window.RTCPeerConnection;
	if (!OriginalRTCPeerConnection) {
		console.error('[webrtc-interceptor] RTCPeerConnection not available!');
		return;
	}
	
	// Check if already wrapped
	if (OriginalRTCPeerConnection.__webrtcInterceptorWrapped) {
		console.log('[webrtc-interceptor] RTCPeerConnection already wrapped');
		return;
	}

	// Track registry: trackId -> track metadata
	const tracksRegistry = new Map();
	let peerConnectionCounter = 0;

	// Wrapped RTCPeerConnection
	window.RTCPeerConnection = function (...args) {
		const pcId = ++peerConnectionCounter;
		console.log(`[webrtc-interceptor] Creating RTCPeerConnection #${pcId}`, args[0]);

		// Create original peer connection
		const pc = new OriginalRTCPeerConnection(...args);

		// Store original methods
		const originalAddEventListener = pc.addEventListener.bind(pc);
		const originalRemoveEventListener = pc.removeEventListener.bind(pc);

		// Track event listeners
		const trackListeners = new Set();

		// Wrap addEventListener to intercept 'track' events
		pc.addEventListener = function (type, listener, ...rest) {
			if (type === 'track') {
				console.log(`[webrtc-interceptor] PC#${pcId} addEventListener('track')`);
				trackListeners.add(listener);

				// Create wrapper that captures track before calling original
				const wrappedListener = function (event) {
					console.log(`[webrtc-interceptor] PC#${pcId} track event fired`, {
						trackId: event.track?.id,
						trackKind: event.track?.kind,
						trackLabel: event.track?.label,
						streamId: event.streams?.[0]?.id,
						streamsCount: event.streams?.length,
					});

					// Capture audio tracks
					if (event.track && event.track.kind === 'audio') {
						handleRemoteAudioTrack(event, pcId);
					}

					// Call original listener
					try {
						listener.call(this, event);
					} catch (e) {
						console.error('[webrtc-interceptor] Error in original track listener:', e);
					}
				};

				// Add wrapped listener
				originalAddEventListener('track', wrappedListener, ...rest);
				return;
			}

			// For non-track events, use original
			return originalAddEventListener(type, listener, ...rest);
		};

		// Wrap removeEventListener
		pc.removeEventListener = function (type, listener, ...rest) {
			if (type === 'track') {
				trackListeners.delete(listener);
			}
			return originalRemoveEventListener(type, listener, ...rest);
		};

		// Intercept ontrack setter
		let userOnTrack = null;
		Object.defineProperty(pc, 'ontrack', {
			get() {
				return userOnTrack;
			},
			set(handler) {
				console.log(`[webrtc-interceptor] PC#${pcId} ontrack setter called`);
				userOnTrack = handler;

				// Set our own handler that wraps the user's
				OriginalRTCPeerConnection.prototype.__lookupSetter__('ontrack').call(pc, function (event) {
					console.log(`[webrtc-interceptor] PC#${pcId} ontrack fired`, {
						trackId: event.track?.id,
						trackKind: event.track?.kind,
						trackLabel: event.track?.label,
					});

					// Capture audio tracks
					if (event.track && event.track.kind === 'audio') {
						handleRemoteAudioTrack(event, pcId);
					}

					// Call user's handler
					if (userOnTrack) {
						try {
							userOnTrack.call(this, event);
						} catch (e) {
							console.error('[webrtc-interceptor] Error in user ontrack:', e);
						}
					}
				});
			},
			configurable: true,
			enumerable: true,
		});

		// Monitor connection state
		pc.addEventListener('connectionstatechange', () => {
			console.log(`[webrtc-interceptor] PC#${pcId} connection state: ${pc.connectionState}`);
		});

		// Monitor ICE connection state
		pc.addEventListener('iceconnectionstatechange', () => {
			console.log(`[webrtc-interceptor] PC#${pcId} ICE connection state: ${pc.iceConnectionState}`);
		});

		return pc;
	};

	// Copy static properties
	window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
	Object.setPrototypeOf(window.RTCPeerConnection, OriginalRTCPeerConnection);
	
	// Mark as wrapped
	window.RTCPeerConnection.__webrtcInterceptorWrapped = true;

	// Handle remote audio track
	function handleRemoteAudioTrack(event, pcId) {
		const track = event.track;
		const stream = event.streams?.[0];
		const trackId = track.id;

		console.log(`[webrtc-interceptor] 🎤 Remote audio track captured:`, {
			pcId,
			trackId,
			trackLabel: track.label,
			streamId: stream?.id,
			trackEnabled: track.enabled,
			trackMuted: track.muted,
			trackReadyState: track.readyState,
		});

		// Store in registry
		const trackInfo = {
			trackId,
			track,
			stream,
			pcId,
			capturedAt: Date.now(),
			enabled: track.enabled,
			muted: track.muted,
		};
		tracksRegistry.set(trackId, trackInfo);

		// Listen for track ended
		track.addEventListener('ended', () => {
			console.log(`[webrtc-interceptor] Track ${trackId} ended`);
			tracksRegistry.delete(trackId);

			// Notify audio-capture that track ended
			window.postMessage(
				{
					type: 'WEBRTC_TRACK_REMOVED',
					trackId,
					timestamp: Date.now(),
				},
				'*',
			);
		});

		// Listen for track mute/unmute
		track.addEventListener('mute', () => {
			console.log(`[webrtc-interceptor] Track ${trackId} muted`);
			if (tracksRegistry.has(trackId)) {
				tracksRegistry.get(trackId).muted = true;
			}
			window.postMessage(
				{
					type: 'WEBRTC_TRACK_MUTED',
					trackId,
					timestamp: Date.now(),
				},
				'*',
			);
		});

		track.addEventListener('unmute', () => {
			console.log(`[webrtc-interceptor] Track ${trackId} unmuted`);
			if (tracksRegistry.has(trackId)) {
				tracksRegistry.get(trackId).muted = false;
			}
			window.postMessage(
				{
					type: 'WEBRTC_TRACK_UNMUTED',
					trackId,
					timestamp: Date.now(),
				},
				'*',
			);
		});

		// Notify audio-capture.js that a new track is available
		window.postMessage(
			{
				type: 'WEBRTC_TRACK_ADDED',
				trackId,
				trackLabel: track.label,
				streamId: stream?.id,
				pcId,
				timestamp: Date.now(),
			},
			'*',
		);
	}

	// Expose registry for debugging
	window.__webrtcInterceptor = {
		tracksRegistry,
		getActiveTracksCount: () => tracksRegistry.size,
		getActiveTracks: () => Array.from(tracksRegistry.values()),
		OriginalRTCPeerConnection,
	};

	console.log('[webrtc-interceptor] ✅ RTCPeerConnection wrapper installed');
})();

