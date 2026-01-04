import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './style.css'
import App from './App.jsx'

import firebase from 'firebase/compat/app'
import 'firebase/compat/firestore'

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

//---------------------------

/* var admin = require("firebase-admin");

var serviceAccount = require("path/to/serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
); */

// Generate the ICE candidates
const servers = {
  iceServers: [
    {
      urls: ['stun:stun1.1.google.com:19302', 'stun:stun2.1.google.com:19302']
    },
  ],
  iceCandidatePoolSize: 10,
}

// Global State: values toc share between multiple components
let pc = new RTCPeerConnection(servers);
let localStream = null; // The webcan
let remoteStream = null; // The remote webcam

// We use imperative DOM APIs
const webcamButton = document.getElementById('webcamButton');
const webcamVideoStream= document.getElementById('webcamVideoStream');
const callButton = document.getElementById('callButton');
const callInput = document.getElementById('callInput');
const answerButton = document.getElementById('answerButton');
const remoteVideoStream = document.getElementById('remoteVideoStream');
const hangupButton = document.getElementById('hangupButton');

// 1. Set up the media source for the local webcam (event handler for the click event on the webcam button)
webcamButton.onclick = async () => {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true , audio: true});
  remoteStream = new MediaStream()

  // Push tracks from local stream user to peer connection
  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });

  // Pull tracks from the remote stream (at first this stream is empty), and add to the video stream
  pc.ontrack = event => {
    event.streams[0].getTracks().forEach(track => {
      remoteStream.addTrack(track); // Listen to audio and video from the peer connection
    });
  }

  webcamVideoStream.srcObject = localStream;
  remoteVideoStream.srcObject - remoteStream;
};

// 2. Create an offer (The user who starts the call is the one who makes an offer)
callButton.onclick = async () => {
  const callDoc = firestore.collection('calls').doc();
  const offerCandidates = callDoc.collection('offerCandidates');
  const answerCandidates =callDoc.collection('answerCandidates');

  callInput.value = callDoc.id;

  // Get candidates for caller, save to db
  pc.onicecandiate = event => {
    event.candidate && offerCandidates.add(event.candidate.toJSON());
  };

  // Create offer
  const offerDescription = await pc.createOffer();
  await pc.setLocalDescription(offerDescription);

  // Convert the Session Description Protocol (SDP) to a plain JS object 
  const offer = {
    sdp: offerDescription.sdp,
    type: offerDescription.type,
  };

  // Save it to the database
  await callDoc.set(offer)

  // Listen to changes as remote answer
  callDoc.onSnapshot((snapshot) => {
    const data = snapshot.data();
    if (!pc.currentRemoteDescription && data?.answer) {
      const answerDescription = new RTCSessionDescription(data.answer);
      pc.setRemoteDescription(answerDescription); // Fires when the remote friends answers the call
    }
  });

  // We need to listen to ICE candidates from the answering user
  // So when answered, add the candidate to the peer connection
  answerCandidates.onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === "added") {
        const candidate = new RTCIceCandidate(change.doc.data());
        pc.addIceCandidate(candidate);
      }
    });
  });

  // 3. Create an answer, i.e. anser the call, with a unique ID
  answerButton.onclick = async () => {
    const callId = callInput.value;
    const callDoc = firestore.collection('calls').doc(callId);
    const answerCandidates = callDoc.collection('answerCandidates');

    // Listen to ICE candidate on the peer connection to udpate the anser candidates collection
    // when a new candidate is generated
    pc.onicecandidate = event => {
      event.candidate && answerCandidates.add(event.candidate.toJSON());
    };

    // Fetch call document from the database, and grab its data
    const callData = (await callDoc.get()).data();

    const offerDescription = callData.offer;
    await pc.setRemoteDescription(new RTCSessionDescription(offerDescription)); // Set remote description on the peer connection

    // Create an answer from the peer connection and set the current local description
    const answerDescription = await pc.createAnswer();
    await pc.setLocalDescription(answerDescription);

    // Convert the Session Description Protocol (SDP) data info to a plain JS object
    const answer = {
      sdp: answerDescription.sdp,
      type: answerDescription.type,
    };

    // Update on the call document so that the other user can listen to the answer
    await callDoc.update({answer});

    // Set up a listener on the offer candidates collection
    offerCandidates.onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          let data = change.doc.data();
          pc.addIceCandidate(new RTCIceCandidate(data));
        }
      });
    });
};