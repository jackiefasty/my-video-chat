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

var admin = require("firebase-admin");

var serviceAccount = require("path/to/serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);