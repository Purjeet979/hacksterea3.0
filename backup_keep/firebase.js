import { initializeApp } from "firebase/app";
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyDvu7vArO7S8hUrr4V9VUxJ1n692U3HfX4",
  authDomain: "snehsaathi-hackathon.firebaseapp.com",
  projectId: "snehsaathi-hackathon",
  storageBucket: "snehsaathi-hackathon.firebasestorage.app",
  messagingSenderId: "22059620360",
  appId: "1:22059620360:web:8375621b9b4a0fc1cc19bd"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

const provider = new GoogleAuthProvider();

export const login = () => signInWithPopup(auth, provider);
export const logout = () => signOut(auth);
