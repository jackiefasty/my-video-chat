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

// Pending candidate buffer & remote description flag
let pendingCandidates = [];
let remoteDescriptionSet = false;

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
      console.debug('[signaling] flushed candidate', c);
    } catch (e) {
      console.error('[signaling] failed to flush candidate', e, c);
    }
  }
}

// Basic diagnostics
pc.onicecandidate = (event) => {
  console.debug('[pc] onicecandidate', event.candidate);
};

pc.ontrack = (event) => {
  console.debug('[pc] ontrack', event);
  if (!remoteStream) {
    remoteStream = new MediaStream();
  }
  if (event.streams && event.streams[0]) {
    event.streams[0].getTracks().forEach((t) => remoteStream.addTrack(t));
  } else if (event.track) {
    remoteStream.addTrack(event.track);
  }
  if (remoteVideoStream) remoteVideoStream.srcObject = remoteStream;
};

pc.onconnectionstatechange = () => console.debug('[pc] connectionState:', pc.connectionState);
pc.oniceconnectionstatechange = () => console.debug('[pc] iceConnectionState:', pc.iceConnectionState);
let localStream = null; // The webcan
let remoteStream = null; // The remote webcam

// We use imperative DOM APIs — attach handlers after DOM is ready to ensure elements exist
let webcamButton, webcamVideoStream, callButton, callInput, answerButton, remoteVideoStream, hangupButton;

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

  // 1. Set up the media source for the local webcam
  if (webcamButton) {
    webcamButton.onclick = async () => {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      remoteStream = new MediaStream();

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

      // Get candidates for caller, save to db
      pc.onicecandidate = event => {
        if (event.candidate) {
          offerCandidates.add(event.candidate.toJSON()).catch(e => console.error('offerCandidates.add failed', e));
        }
      };

      // Create offer
      const offerDescription = await pc.createOffer();
      await pc.setLocalDescription(offerDescription);

      const offer = {
        sdp: offerDescription.sdp,
        type: offerDescription.type,
      };

      // Save it to the database under the `offer` key
      await callDoc.set({ offer });
      console.debug('[signaling] offer saved, id=', callDoc.id);

      // Listen to changes as remote answer
      callDoc.onSnapshot((snapshot) => {
        const data = snapshot.data();
        if (!remoteDescriptionSet && data?.answer) {
          const answerDescription = new RTCSessionDescription(data.answer);
          pc.setRemoteDescription(answerDescription)
            .then(() => {
              console.debug('[signaling] setRemoteDescription(answer) success');
              remoteDescriptionSet = true;
              flushPendingCandidates();
            })
            .catch(err => console.error('[signaling] setRemoteDescription(answer) failed', err));
        }
      });

      // Listen for ICE candidates from the answering user
      answerCandidates.onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === "added") {
            const data = change.doc.data();
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
        console.debug('[pc] ontrack', event);
        if (!remoteStream) remoteStream = new MediaStream();
        if (event.streams && event.streams[0]) {
          event.streams[0].getTracks().forEach((t) => remoteStream.addTrack(t));
        } else if (event.track) {
          remoteStream.addTrack(event.track);
        }
        if (remoteVideoStream) remoteVideoStream.srcObject = remoteStream;
      };

      pc.onconnectionstatechange = () => console.debug('[pc] connectionState:', pc.connectionState);
      pc.oniceconnectionstatechange = () => console.debug('[pc] iceConnectionState:', pc.iceConnectionState);
    };
  }

  // 3. Create an answer
  if (answerButton) {
    answerButton.onclick = async () => {
      const callId = callInput.value;
      const callDoc = firestore.collection('calls').doc(callId);
      const offerCandidates = callDoc.collection('offerCandidates');
      const answerCandidates = callDoc.collection('answerCandidates');

      // Listen to ICE candidate on the peer connection to update the answer candidates collection
      pc.onicecandidate = event => {
        if (event.candidate) {
          answerCandidates.add(event.candidate.toJSON()).catch(e => console.error('answerCandidates.add failed', e));
        }
      };

      // Fetch call document from the database, and grab its data
      console.debug('[signaling] answer flow: navigator.onLine=', navigator.onLine);
      const statusEl = document.getElementById('status');
      function setStatus(msg) { console.debug('[ui] status', msg); if (statusEl) statusEl.textContent = msg; }

      let callData;
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          setStatus(`Fetching call document (attempt ${attempt}/${maxAttempts})...`);
          const snap = await callDoc.get();
          callData = snap.data();
          break;
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
        setStatus('Failed to fetch call document after multiple attempts. Check network / Firebase.');
        alert('Failed to fetch call document: offline or network error. Check your internet connection and Firebase configuration.');
        return;
      }
      if (!callData || !callData.offer) {
        console.error('Call document missing or no offer found');
        return;
      }

      const offerDescription = callData.offer;
      await pc.setRemoteDescription(new RTCSessionDescription(offerDescription)); // Set remote description on the peer connection
      remoteDescriptionSet = true;
      await flushPendingCandidates();

      // Create an answer from the peer connection and set the current local description
      const answerDescription = await pc.createAnswer();
      await pc.setLocalDescription(answerDescription);

      // Convert the Session Description Protocol (SDP) data info to a plain JS object
      const answer = {
        sdp: answerDescription.sdp,
        type: answerDescription.type,
      };

      // Update on the call document so that the other user can listen to the answer
      await callDoc.update({ answer });

      // Set up a listener on the offer candidates collection and add them safely
      offerCandidates.onSnapshot((snapshot) => {
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
    };
  }
});