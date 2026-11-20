// impact-rating.js
// "Rate the impact" feature for worksite popups, stored in Firebase Firestore.
// Load with: <script type="module" src="impact-rating.js"></script>
//
// Each visitor is signed in anonymously (no account needed), so every browser
// gets one vote per permit. Voting again updates that vote instead of adding one.

// Use the version number shown in your Firebase console's setup snippet.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
import {
  getFirestore, collection, query, where, getDocs,
  doc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

  const firebaseConfig = {
    apiKey: "AIzaSyB-GOLavGl6L8_-T5k4VBzqbbz_Us_5VCM",
    authDomain: "montreal-construction-21e6b.firebaseapp.com",
    projectId: "montreal-construction-21e6b",
    storageBucket: "montreal-construction-21e6b.firebasestorage.app",
    messagingSenderId: "668627964313",
    appId: "1:668627964313:web:206d54541d87ca90130308",
    measurementId: "G-DH5CYM7P6T"
  };

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Sign in once when the page loads; every vote waits on this.
const userReady = signInAnonymously(auth)
  .then(cred => cred.user)
  .catch(err => { console.error("Anonymous sign-in failed:", err); return null; });

const CATEGORIES = [
  { key: "noise",    label: "Bruit / Noise" },
  { key: "sidewalk", label: "Trottoir / Sidewalk" },
  { key: "traffic",  label: "Circulation / Traffic" }
];

// Read every vote for one permit and average them.
async function loadRatings(permitId, uid) {
  const snap = await getDocs(query(collection(db, "ratings"), where("permitId", "==", permitId)));
  const sums = { noise: 0, sidewalk: 0, traffic: 0 };
  let count = 0;
  let mine = null;
  snap.forEach(d => {
    const r = d.data();
    count++;
    CATEGORIES.forEach(c => { sums[c.key] += r[c.key]; });
    if (uid && d.id === `${permitId}_${uid}`) mine = r;
  });
  const avg = {};
  CATEGORIES.forEach(c => { avg[c.key] = count ? sums[c.key] / count : null; });
  return { count, avg, mine };
}

async function saveRating(permitId, uid, scores) {
  // Document id = permit + user, so one browser = one vote per permit.
  await setDoc(doc(db, "ratings", `${permitId}_${uid}`), {
    permitId,
    uid,
    noise: scores.noise,
    sidewalk: scores.sidewalk,
    traffic: scores.traffic,
    updatedAt: serverTimestamp()
  });
}

// Build the rating panel for one permit. Returns a DOM element to put in a popup.
function createRatingPanel(permitId) {
  const panel = document.createElement("div");
  panel.className = "impact-panel";
  panel.innerHTML = `<div class="impact-title">Impact ressenti / Perceived impact</div>
                     <div class="impact-summary">Chargement… / Loading…</div>`;

  const summaryEl = panel.querySelector(".impact-summary");
  const selected = { noise: null, sidewalk: null, traffic: null };

  const form = document.createElement("div");
  form.className = "impact-form";
  CATEGORIES.forEach(c => {
    const row = document.createElement("div");
    row.className = "impact-row";
    row.innerHTML = `<span class="impact-label">${c.label}</span>`;
    const btns = document.createElement("span");
    btns.className = "impact-buttons";
    for (let v = 1; v <= 5; v++) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = v;
      b.dataset.cat = c.key;
      b.dataset.value = v;
      b.addEventListener("click", () => {
        selected[c.key] = v;
        btns.querySelectorAll("button").forEach(x =>
          x.classList.toggle("active", Number(x.dataset.value) === v));
        updateSubmit();
      });
      btns.appendChild(b);
    }
    row.appendChild(btns);
    form.appendChild(row);
  });

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "impact-submit";
  submit.textContent = "Envoyer / Submit";
  submit.disabled = true;
  const status = document.createElement("div");
  status.className = "impact-status";
  form.appendChild(submit);
  form.appendChild(status);
  panel.appendChild(form);

  function updateSubmit() {
    submit.disabled = CATEGORIES.some(c => selected[c.key] === null);
  }

  function showSummary({ count, avg }) {
    if (!count) {
      summaryEl.textContent = "Aucune évaluation encore / No ratings yet";
      return;
    }
    summaryEl.innerHTML = CATEGORIES.map(c =>
      `${c.label}: <b>${avg[c.key].toFixed(1)}</b>/5`).join("<br>") +
      `<br><small>${count} évaluation${count > 1 ? "s" : ""} / rating${count > 1 ? "s" : ""}</small>`;
  }

  function preselect(mine) {
    if (!mine) return;
    CATEGORIES.forEach(c => {
      selected[c.key] = mine[c.key];
      form.querySelectorAll(`button[data-cat="${c.key}"]`).forEach(x =>
        x.classList.toggle("active", Number(x.dataset.value) === mine[c.key]));
    });
    submit.textContent = "Mettre à jour / Update";
    updateSubmit();
  }

  async function refresh() {
    try {
      const user = await userReady;
      const result = await loadRatings(permitId, user && user.uid);
      showSummary(result);
      preselect(result.mine);
    } catch (err) {
      console.error(err);
      summaryEl.textContent = "Impossible de charger les évaluations / Could not load ratings";
    }
  }

  submit.addEventListener("click", async () => {
    const user = await userReady;
    if (!user) { status.textContent = "Connexion impossible / Sign-in failed"; return; }
    submit.disabled = true;
    status.textContent = "Envoi… / Sending…";
    try {
      await saveRating(permitId, user.uid, selected);
      status.textContent = "Merci! / Thanks!";
      await refresh();
    } catch (err) {
      console.error(err);
      status.textContent = "Erreur, réessayez / Error, try again";
      updateSubmit();
    }
  });

  refresh();
  return panel;
}

// Make it available to your regular (non-module) map script.
window.createRatingPanel = createRatingPanel;
