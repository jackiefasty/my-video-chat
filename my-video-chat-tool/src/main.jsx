import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

import firebase from 'firebase/compat/app'
import 'firebase/compat/firestore'
import 'firebase/compat/auth'

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDr5EZazNEHeMtOYj3TgnWplFLYmh86rlg",
  authDomain: "webrtc-test-1ce3d.firebaseapp.com",
  projectId: "webrtc-test-1ce3d",
  storageBucket: "webrtc-test-1ce3d.firebasestorage.app",
  messagingSenderId: "624944601332",
  appId: "1:624944601332:web:5d3728d84360b46c9466a1",
  measurementId: "G-ELVY44GL09"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const firestore = firebase.firestore()

// Initialize Firebase Auth and sign in anonymously for development so Firestore requests are authenticated
const auth = firebase.auth();
auth.signInAnonymously()
  .then(() => console.debug('[auth] signed in anonymously', auth.currentUser && auth.currentUser.uid))
  .catch((err) => console.error('[auth] anonymous sign-in failed', err));

// expose auth for debugging
window.auth = auth;

// Enable Firestore debug logs (guarded) and print config for interactive debugging
if (firebase && firebase.firestore && typeof firebase.firestore.setLogLevel === 'function') {
  try {
    firebase.firestore.setLogLevel('debug');
    console.debug('[debug] firebase.firestore.setLogLevel enabled');
  } catch (e) {
    console.warn('[debug] setLogLevel call failed', e);
  }
} else {
  console.warn('[debug] firebase.firestore.setLogLevel not available');
}
console.debug('[debug] firebase config', firebase.app().options);

//---------------------------

// Generate the ICE candidates
const servers = {
  iceServers: [
    // Use a well-known Google STUN server. Replace or add TURN servers for production.
    { urls: ['stun:stun.l.google.com:19302'] }
    // Add TURN server if you have one, for example:
    // { urls: 'turn:YOUR_TURN_SERVER:3478', username: 'user', credential: 'pass' }
  ],
  iceCandidatePoolSize: 10,
}

// Global State: values toc share between multiple components
let pc = new RTCPeerConnection(servers);
console.debug('[pc] created with servers', servers);
// Snapshot unsubscribe handles so we can detach listeners when hangup
let callDocUnsub = null;
let offerCandidatesUnsub = null;
let answerCandidatesUnsub = null;

// Ensure stable transceivers (audio + video) so subsequent offers keep the same m-line order.
function ensureTransceivers() {
  try {
    if (!window._localTransceivers) window._localTransceivers = {};
    if (!window._localTransceivers.audio) {
      window._localTransceivers.audio = pc.addTransceiver('audio', { direction: 'sendrecv' });
      console.debug('[pc] added audio transceiver');
    }
    if (!window._localTransceivers.video) {
      window._localTransceivers.video = pc.addTransceiver('video', { direction: 'sendrecv' });
      console.debug('[pc] added video transceiver');
    }
  } catch (e) {
    // Some environments/browsers may not support addTransceiver; fall back to addTrack later
    console.debug('[pc] addTransceiver not available or failed', e);
  }
}

ensureTransceivers();

// Ensure local media is started and tracks are attached to the PeerConnection
async function ensureLocalStream() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    // attach tracks to existing transceivers or addTrack
    try {
      const audioTrack = localStream.getAudioTracks()[0];
      const videoTrack = localStream.getVideoTracks()[0];
      if (window._localTransceivers && window._localTransceivers.audio && audioTrack) {
        window._localTransceivers.audio.sender.replaceTrack(audioTrack);
        console.debug('[pc] replaced audio track on transceiver (ensureLocalStream)');
      } else if (audioTrack) {
        pc.addTrack(audioTrack, localStream);
      }
      if (window._localTransceivers && window._localTransceivers.video && videoTrack) {
        window._localTransceivers.video.sender.replaceTrack(videoTrack);
        console.debug('[pc] replaced video track on transceiver (ensureLocalStream)');
      } else if (videoTrack) {
        pc.addTrack(videoTrack, localStream);
      }
    } catch (e) {
      console.warn('[pc] ensureLocalStream add/replaceTrack failed', e);
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    }
    if (webcamVideoStream) webcamVideoStream.srcObject = localStream;
    return localStream;
  } catch (e) {
    console.error('[ui] getUserMedia failed in ensureLocalStream', e);
    throw e;
  }
}

// Pending candidate buffer & remote description flag
let pendingCandidates = [];
let remoteDescriptionSet = false;
// Signaling state for current call and renegotiation
let currentCallDoc = null;
let currentRole = null; // 'caller' | 'answerer'
let lastLocalOfferSdp = null; // used to avoid responding to our own offer

function bufferCandidate(candidate) {
  pendingCandidates.push(candidate);
}

async function flushPendingCandidates() {
  if (!pendingCandidates.length) return;
  console.debug('[signaling] flushing', pendingCandidates.length, 'pending candidates');
  const toFlush = pendingCandidates.slice();
  pendingCandidates = [];
  for (const c of toFlush) {
    try {
  await pc.addIceCandidate(c);
  console.debug('[signaling] flushed candidate', c.sdpMid, c.sdpMLineIndex);
    } catch (e) {
  console.error('[signaling] failed to flush candidate', e, c);
    }
  }
}

// Basic diagnostics
pc.onicecandidate = (event) => {
  console.debug('[pc] onicecandidate', event.candidate);
};

pc.onnegotiationneeded = async () => {
  console.debug('[pc] negotiationneeded');
  if (!currentCallDoc) {
    console.debug('[pc] no currentCallDoc, skipping renegotiation');
    return;
  }
  try {
    const offerDescription = await pc.createOffer();
    await pc.setLocalDescription(offerDescription);
    const offer = { sdp: offerDescription.sdp, type: offerDescription.type };
    // Avoid writing the same SDP twice
    if (offer.sdp !== lastLocalOfferSdp) {
      await currentCallDoc.update({ offer });
      lastLocalOfferSdp = offer.sdp;
      console.debug('[pc] published renegotiation offer');
    }
  } catch (e) {
    console.error('[pc] renegotiation failed', e);
  }
};

pc.ontrack = (event) => {
  console.debug('[pc] ontrack', event);
  // Prefer assigning the remote stream delivered by the ontrack event when available.
  if (event.streams && event.streams[0]) {
    console.debug('[pc] ontrack: using event.streams[0]');
    remoteStream = event.streams[0];
  const statusEl = document.getElementById('status'); if (statusEl) statusEl.textContent = 'Remote stream received';
    if (remoteVideoStream) {
      remoteVideoStream.srcObject = remoteStream;
      // Try to play; browsers may block autoplay with sound
      remoteVideoStream.play().catch((err) => {
        console.warn('[ui] remoteVideo.play blocked', err);
        const s = document.getElementById('status'); if (s) s.textContent = 'Remote stream received — click video to play (autoplay blocked)';
        try { remoteVideoStream.addEventListener('click', () => remoteVideoStream.play().catch(()=>{}), { once: true }); } catch (e) {}
      });
    }
    return;
  }

  // Fallback: accumulate tracks into a MediaStream
  if (!remoteStream) remoteStream = new MediaStream();
  if (event.track) {
    console.debug('[pc] ontrack: adding single track', event.track.kind);
    remoteStream.addTrack(event.track);
  }
  if (remoteVideoStream) remoteVideoStream.srcObject = remoteStream;
  try { if (remoteVideoStream) remoteVideoStream.play().catch(()=>{}); } catch (e) {}
};

pc.onconnectionstatechange = () => console.debug('[pc] connectionState:', pc.connectionState);
pc.oniceconnectionstatechange = () => console.debug('[pc] iceConnectionState:', pc.iceConnectionState);
let localStream = null; // The webcan
let remoteStream = null; // The remote webcam

// We use imperative DOM APIs — attach handlers after DOM is ready to ensure elements exist
let webcamButton, webcamVideoStream, callButton, callInput, answerButton, remoteVideoStream, hangupButton;

// In-page debug panel element
let debugPanel = null;

window.firebase = firebase;
window.firestore = firestore;
window.pc = pc;
window.pendingCandidates = pendingCandidates;

window.addEventListener('DOMContentLoaded', () => {
  webcamButton = document.getElementById('webcamButton');
  webcamVideoStream = document.getElementById('webcamVideoStream');
  callButton = document.getElementById('callButton');
  callInput = document.getElementById('callInput');
  answerButton = document.getElementById('answerButton');
  remoteVideoStream = document.getElementById('remoteVideoStream');
  hangupButton = document.getElementById('hangupButton');

  // If streams already exist (e.g., on reconnection), attach them to the elements
  if (webcamVideoStream && localStream) webcamVideoStream.srcObject = localStream;
  if (remoteVideoStream && remoteStream) remoteVideoStream.srcObject = remoteStream;

  // Create a lightweight debug panel for quick visibility
  debugPanel = document.getElementById('debug-panel');
  if (!debugPanel) {
    debugPanel = document.createElement('div');
    debugPanel.id = 'debug-panel';
    debugPanel.style = 'position:fixed; right:12px; bottom:12px; background:#fff; color:#111; padding:8px; border-radius:6px; box-shadow:0 1px 4px rgba(0,0,0,0.12); font-size:12px; max-width:320px; z-index:9999;';
    document.body.appendChild(debugPanel);
  }

  // Update debug panel periodically
  setInterval(() => {
    const lines = [];
    lines.push('callId: ' + (currentCallDoc ? (currentCallDoc.id || '[doc]') : 'none'));
    lines.push('role: ' + (currentRole || 'none'));
    lines.push('pc.connectionState: ' + (pc && pc.connectionState));
    lines.push('pc.iceConnectionState: ' + (pc && pc.iceConnectionState));
    lines.push('remoteDescriptionSet: ' + !!remoteDescriptionSet);
    lines.push('pendingCandidates: ' + (pendingCandidates && pendingCandidates.length));
    lines.push('offerCandidatesUnsub: ' + (offerCandidatesUnsub ? 'yes' : 'no'));
    lines.push('answerCandidatesUnsub: ' + (answerCandidatesUnsub ? 'yes' : 'no'));
    lines.push('localTracks: ' + (localStream ? localStream.getTracks().length : 0));
    lines.push('remoteTracks: ' + (remoteStream ? remoteStream.getTracks().length : 0));
    lines.push('lastLocalOfferSdp: ' + (lastLocalOfferSdp ? lastLocalOfferSdp.slice(0,60).replace(/\n/g,'') + '...' : 'none'));
    debugPanel.innerText = lines.join('\n');
  }, 500);

  // 1. Set up the media source for the local webcam
  if (webcamButton) {
    webcamButton.onclick = async () => {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

      // Push tracks from local stream user to peer connection. If transceivers exist, replaceTrack
      try {
        const audioTrack = localStream.getAudioTracks()[0];
        const videoTrack = localStream.getVideoTracks()[0];

        // Use transceiver sender.replaceTrack when available to keep m-line order stable
        if (window._localTransceivers && window._localTransceivers.audio && audioTrack) {
          window._localTransceivers.audio.sender.replaceTrack(audioTrack);
          console.debug('[pc] replaced audio track on transceiver');
        } else if (audioTrack) {
          pc.addTrack(audioTrack, localStream);
        }

        if (window._localTransceivers && window._localTransceivers.video && videoTrack) {
          window._localTransceivers.video.sender.replaceTrack(videoTrack);
          console.debug('[pc] replaced video track on transceiver');
        } else if (videoTrack) {
          pc.addTrack(videoTrack, localStream);
        }
      } catch (e) {
        console.warn('[pc] unable to replaceTrack or addTrack failed', e);
        // fallback: add all tracks
        localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
      }

      // remote tracks are handled by the global pc.ontrack handler

      if (webcamVideoStream) webcamVideoStream.srcObject = localStream;
      if (remoteVideoStream) remoteVideoStream.srcObject = remoteStream;
    };
  }

  // 2. Create an offer
  if (callButton) {
    callButton.onclick = async () => {
      const callDoc = firestore.collection('calls').doc();
      const offerCandidates = callDoc.collection('offerCandidates');
      const answerCandidates = callDoc.collection('answerCandidates');

      if (callInput) callInput.value = callDoc.id;

      // Batch candidate writes to Firestore to reduce write rate (helps avoid quota/exhaustion)
      let offerCandidateQueue = [];
      let offerFlushTimer = null;
      function scheduleOfferFlush() {
        if (offerFlushTimer) return;
        offerFlushTimer = setTimeout(async () => {
          const items = offerCandidateQueue.splice(0);
          offerFlushTimer = null;
          for (const c of items) {
            try {
              await offerCandidates.add(c);
            } catch (err) {
              console.error('[signaling] offerCandidates.add failed', err);
              const statusEl = document.getElementById('status'); if (statusEl) statusEl.textContent = 'Firestore write error: ' + (err.message || err);
            }
          }
        }, 300);
      }

      pc.onicecandidate = event => {
        if (event.candidate) {
          try {
            offerCandidateQueue.push(event.candidate.toJSON());
            scheduleOfferFlush();
          } catch (e) {
            console.error('[signaling] failed enqueue offer candidate', e);
          }
        }
      };

  // Ensure local media is active and attached before creating the offer
  try { await ensureLocalStream(); } catch (e) { alert('Unable to access webcam: ' + (e.message || e)); return; }
  // Create offer
  const offerDescription = await pc.createOffer();
      await pc.setLocalDescription(offerDescription);

      const offer = {
        sdp: offerDescription.sdp,
        type: offerDescription.type,
      };

      // Save it to the database under the `offer` key
      await callDoc.set({ offer });
  { const s = document.getElementById('status'); if (s) s.textContent = 'Offer published'; }
      // mark signaling state
      currentCallDoc = callDoc;
      currentRole = 'caller';
      lastLocalOfferSdp = offer.sdp;
      console.debug('[signaling] offer saved, id=', callDoc.id);
  // Listen to changes as remote answer/offer for renegotiation
  callDocUnsub = callDoc.onSnapshot(async (snapshot) => {
        const data = snapshot.data();
        if (!data) return;

        // If an answer appears and we haven't applied it yet, set remote description
        if (!remoteDescriptionSet && data?.answer) {
          try {
            const answerDescription = new RTCSessionDescription(data.answer);
            await pc.setRemoteDescription(answerDescription);
            console.debug('[signaling] setRemoteDescription(answer) success');
            remoteDescriptionSet = true;
            await flushPendingCandidates();
            console.debug('[pc] receivers after setRemoteDescription (caller):', pc.getReceivers().map(r => r.track && r.track.kind));
            console.debug('[pc] transceivers after setRemoteDescription (caller):', pc.getTransceivers().map(t => ({ mid: t.mid, direction: t.direction })));
            { const s = document.getElementById('status'); if (s) s.textContent = 'Answer applied (caller)'; }
          } catch (err) {
            console.error('[signaling] setRemoteDescription(answer) failed', err);
          }
        }

        // If an offer appears that is not our last local offer, treat it as a re-offer and answer it
        if (data?.offer && data.offer.sdp && data.offer.sdp !== lastLocalOfferSdp) {
          // Avoid reacting to our own offer
          try {
            console.debug('[signaling] remote offer detected (renegotiation)');
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            remoteDescriptionSet = true;
            await flushPendingCandidates();

            const answerDescription = await pc.createAnswer();
            await pc.setLocalDescription(answerDescription);
            const answer = { sdp: answerDescription.sdp, type: answerDescription.type };
            await callDoc.update({ answer });
            console.debug('[signaling] answered remote re-offer');
          } catch (err) {
            console.error('[signaling] handling remote offer failed', err);
          }
        }
      });

  // Listen for ICE candidates from the answering user
  answerCandidatesUnsub = answerCandidates.onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === "added") {
            const data = change.doc.data();
            console.debug('[signaling] answerCandidates snapshot added', data.sdpMid, data.sdpMLineIndex);
            const candidate = new RTCIceCandidate(data);
            if (remoteDescriptionSet) {
              pc.addIceCandidate(candidate).catch(e => console.error('addIceCandidate failed', e));
            } else {
              console.debug('[signaling] buffering candidate until remote description is set', data);
              bufferCandidate(candidate);
            }
          }
        });
      });
  // ensure we clear any timers when hangup happens by storing them on callDoc
  callDoc._offerFlushTimer = () => { if (offerFlushTimer) { clearTimeout(offerFlushTimer); offerFlushTimer = null; } };
    };
  }

  // Hang up: stop tracks, close and recreate RTCPeerConnection, reset state
  if (hangupButton) {
    hangupButton.onclick = () => {
      console.debug('[ui] Hangup clicked — cleaning up');

      // Stop local tracks
      if (localStream) {
        localStream.getTracks().forEach(t => {
          try { t.stop(); } catch (e) {}
        });
      }

      // Stop remote tracks
      if (remoteStream) {
        remoteStream.getTracks().forEach(t => {
          try { t.stop(); } catch (e) {}
        });
      }

      // Close existing PeerConnection
      try { pc && pc.close(); } catch (e) { console.warn('pc.close failed', e); }

      // Reset UI
      if (webcamVideoStream) webcamVideoStream.srcObject = null;
      if (remoteVideoStream) remoteVideoStream.srcObject = null;
      if (callInput) callInput.value = '';

      // Reset state
      localStream = null;
      remoteStream = null;
      pendingCandidates = [];
      remoteDescriptionSet = false;

      // Recreate PeerConnection and reattach diagnostics and handlers
  pc = new RTCPeerConnection(servers);
  console.debug('[pc] recreated after hangup');

  // Recreate stable transceivers so future offers keep m-line order
  ensureTransceivers();

      pc.onicecandidate = (event) => {
        console.debug('[pc] onicecandidate', event.candidate);
      };

      pc.ontrack = (event) => {
        console.debug('[pc] ontrack (recreated)', event);
        if (event.streams && event.streams[0]) {
          console.debug('[pc] ontrack (recreated): using event.streams[0]');
          remoteStream = event.streams[0];
          if (remoteVideoStream) remoteVideoStream.srcObject = remoteStream;
          return;
        }
        if (!remoteStream) remoteStream = new MediaStream();
        if (event.track) remoteStream.addTrack(event.track);
        if (remoteVideoStream) remoteVideoStream.srcObject = remoteStream;
      };

      pc.onconnectionstatechange = () => console.debug('[pc] connectionState:', pc.connectionState);
      pc.oniceconnectionstatechange = () => console.debug('[pc] iceConnectionState:', pc.iceConnectionState);
  // Unsubscribe any Firestore listeners from previous session
  try { if (callDocUnsub) { callDocUnsub(); callDocUnsub = null; } } catch (e) { console.warn('callDocUnsub failed', e); }
  try { if (offerCandidatesUnsub) { offerCandidatesUnsub(); offerCandidatesUnsub = null; } } catch (e) { console.warn('offerCandidatesUnsub failed', e); }
  try { if (answerCandidatesUnsub) { answerCandidatesUnsub(); answerCandidatesUnsub = null; } } catch (e) { console.warn('answerCandidatesUnsub failed', e); }
  // If the active callDoc stored flush timer cleanup hooks, call them
  try { if (currentCallDoc && typeof currentCallDoc._offerFlushTimer === 'function') { currentCallDoc._offerFlushTimer(); } } catch (e) { console.warn('callDoc._offerFlushTimer failed', e); }
  try { if (currentCallDoc && typeof currentCallDoc._answerFlushTimer === 'function') { currentCallDoc._answerFlushTimer(); } } catch (e) { console.warn('callDoc._answerFlushTimer failed', e); }
  currentCallDoc = null;
    };
  }

  // 3. Create an answer
  if (answerButton) {
    answerButton.onclick = async () => {
      // Validate callId early and trim
      const rawCallId = callInput.value && callInput.value.trim();
      if (!rawCallId) {
        alert('Please enter a Call ID to answer.');
        return;
      }
      const callId = rawCallId;
      const callDoc = firestore.collection('calls').doc(callId);
      const offerCandidates = callDoc.collection('offerCandidates');
      const answerCandidates = callDoc.collection('answerCandidates');

      // Listen to ICE candidate on the peer connection to update the answer candidates collection
      // Batch candidate writes on the answer side as well
      let answerCandidateQueue = [];
      let answerFlushTimer = null;
      function scheduleAnswerFlush() {
        if (answerFlushTimer) return;
        answerFlushTimer = setTimeout(async () => {
          const items = answerCandidateQueue.splice(0);
          answerFlushTimer = null;
          for (const c of items) {
            try {
              await answerCandidates.add(c);
            } catch (err) {
              console.error('[signaling] answerCandidates.add failed', err);
              const statusEl = document.getElementById('status'); if (statusEl) statusEl.textContent = 'Firestore write error: ' + (err.message || err);
            }
          }
        }, 300);
      }

      pc.onicecandidate = event => {
        if (event.candidate) {
          try {
            answerCandidateQueue.push(event.candidate.toJSON());
            scheduleAnswerFlush();
          } catch (e) {
            console.error('[signaling] failed enqueue answer candidate', e);
          }
        }
      };
      // expose a cleanup hook for the hangup logic
      callDoc._answerFlushTimer = () => { if (answerFlushTimer) { clearTimeout(answerFlushTimer); answerFlushTimer = null; } };

      // IMPORTANT: attach offerCandidates listener immediately so we don't miss caller ICE candidates
      // Buffer them until we set the remote description.
      offerCandidatesUnsub = offerCandidates.onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const data = change.doc.data();
            const candidate = new RTCIceCandidate(data);
            if (remoteDescriptionSet) {
              pc.addIceCandidate(candidate).catch(e => console.error('addIceCandidate failed', e));
            } else {
              console.debug('[signaling] buffering offer candidate until remote description is set', data);
              bufferCandidate(candidate);
            }
          }
        });
      });

      // Fetch call document from the database, and grab its data
      console.debug('[signaling] answer flow: navigator.onLine=', navigator.onLine);
      const statusEl = document.getElementById('status');
      function setStatus(msg) { console.debug('[ui] status', msg); if (statusEl) statusEl.textContent = msg; }

  // Ensure auth is ready (anonymous sign-in finished) before reading Firestore
      if (!auth.currentUser) {
        setStatus('Waiting for auth...');
        await new Promise((resolve) => {
          const unsubAuth = auth.onAuthStateChanged((u) => {
            try { unsubAuth(); } catch (e) {}
            resolve();
          });
        });
        console.debug('[auth] auth ready', auth.currentUser && auth.currentUser.uid);
      }

      let callData;
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          setStatus(`Fetching call document (attempt ${attempt}/${maxAttempts})...`);
          const snap = await callDoc.get();
          console.debug('[signaling] callDoc.get snap.exists=', snap.exists, 'id=', callDoc.id, 'keys=', snap.exists ? Object.keys(snap.data()) : []);
          if (snap.exists) {
            callData = snap.data();
            setStatus('Fetched call document');
            break;
          } else {
            // Document not found yet — wait and retry
            setStatus(`Call document not found (attempt ${attempt}). Retrying...`);
            await new Promise(res => setTimeout(res, 500 * Math.pow(2, attempt - 1)));
            continue;
          }
        } catch (err) {
          console.error('[signaling] callDoc.get failed', err);
          setStatus(`callDoc.get failed (attempt ${attempt}) - ${err?.message || err}`);
          // Try to re-enable Firestore network on first failure
          if (attempt === 1) {
            try {
              await firestore.enableNetwork();
              console.debug('[signaling] firestore.enableNetwork() called');
            } catch (enErr) {
              console.error('[signaling] enableNetwork failed', enErr);
            }
          }
          // exponential backoff before retrying
          await new Promise(res => setTimeout(res, 500 * Math.pow(2, attempt - 1)));
        }
      }

      if (!callData) {
        setStatus('Failed to fetch call document after multiple attempts. Check network / Firebase / Call ID.');
        alert('Failed to fetch call document: offline or network error or call not found. Check your internet connection, Firebase configuration and that the Call ID is correct.');
        return;
      }
      if (!callData.offer) {
        console.error('Call document missing offer field');
        setStatus('Call document exists but missing offer.');
        return;
      }

  // mark signaling state
  currentCallDoc = callDoc;
  currentRole = 'answerer';
  // reset lastLocalOfferSdp so we can respond to existing offers
  lastLocalOfferSdp = null;

      const offerDescription = callData.offer;
      await pc.setRemoteDescription(new RTCSessionDescription(offerDescription)); // Set remote description on the peer connection
  console.debug('[signaling] answer flow: setRemoteDescription(offer) complete');
  console.debug('[pc] transceivers after setRemoteDescription:', pc.getTransceivers().map(t => ({ mid: t.mid, direction: t.direction, senderTracks: t.sender && t.sender.track && t.sender.track.kind })));
  console.debug('[pc] receivers after setRemoteDescription:', pc.getReceivers().map(r => r.track && r.track.kind));
      remoteDescriptionSet = true;
      await flushPendingCandidates();

  // Ensure local media is active and attached before creating the answer
  try { await ensureLocalStream(); } catch (e) { alert('Unable to access webcam: ' + (e.message || e)); return; }
  // Create an answer from the peer connection and set the current local description
  const answerDescription = await pc.createAnswer();
      await pc.setLocalDescription(answerDescription);
  console.debug('[signaling] answer flow: setLocalDescription(answer) complete');
  console.debug('[pc] senders after setLocalDescription (answerer):', pc.getSenders().map(s => ({ id: s.track && s.track.id, kind: s.track && s.track.kind })));

      // Convert the Session Description Protocol (SDP) data info to a plain JS object
      const answer = {
        sdp: answerDescription.sdp,
        type: answerDescription.type,
      };

      // Update on the call document so that the other user can listen to the answer
      await callDoc.update({ answer });
  { const s = document.getElementById('status'); if (s) s.textContent = 'Answer published (answerer)'; }

      // Listen to changes on the call doc so we can respond to re-offers (answerer side)
      callDocUnsub = callDoc.onSnapshot(async (snapshot) => {
        const data = snapshot.data();
        if (!data) return;

        // If a new offer appears that's not our last local offer, it's a re-offer
        if (data?.offer && data.offer.sdp && data.offer.sdp !== lastLocalOfferSdp) {
          try {
            console.debug('[signaling] answerer detected remote offer (renegotiation) via callDoc snapshot');
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            remoteDescriptionSet = true;
            await flushPendingCandidates();

            const answerDescription2 = await pc.createAnswer();
            await pc.setLocalDescription(answerDescription2);
            const answer2 = { sdp: answerDescription2.sdp, type: answerDescription2.type };
            await callDoc.update({ answer: answer2 });
            console.debug('[signaling] answerer replied to re-offer (callDoc snapshot)');
          } catch (err) {
            console.error('[signaling] answerer failed handling remote offer (callDoc snapshot)', err);
          }
        }
      });

      // Ensure we only attach the offerCandidates listener once; if not attached yet, save the unsub handle
      if (!offerCandidatesUnsub) {
        offerCandidatesUnsub = offerCandidates.onSnapshot((snapshot) => {
          snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
              const data = change.doc.data();
              const candidate = new RTCIceCandidate(data);
              if (remoteDescriptionSet) {
                pc.addIceCandidate(candidate).catch(e => console.error('addIceCandidate failed', e));
              } else {
                console.debug('[signaling] buffering offer candidate until remote description is set', data);
                bufferCandidate(candidate);
              }
            }
          });
        });
      } else {
        console.debug('[signaling] offerCandidates listener already attached');
      }
    };
  }
});