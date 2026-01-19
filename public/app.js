const socket = io();

// Keep-alive : ping le serveur toutes les 5 minutes pour éviter que Render s'endorme
setInterval(() => {
  fetch('/ping').catch(() => {});
}, 5 * 60 * 1000);

// Éléments DOM
const screens = {
  home: document.getElementById('screen-home'),
  recepteur: document.getElementById('screen-recepteur'),
  emetteur: document.getElementById('screen-emetteur'),
  ended: document.getElementById('screen-ended')
};

// Home
const btnStart = document.getElementById('btn-start');
const btnJoin = document.getElementById('btn-join');
const inputCode = document.getElementById('input-code');
const inputNom = document.getElementById('input-nom');

// Récepteur
const partyCode = document.getElementById('party-code');
const nbEmetteurs = document.getElementById('nb-emetteurs');
const etatPartie = document.getElementById('etat-partie');
const participantsList = document.getElementById('participants-list');
const btnCloseDoors = document.getElementById('btn-close-doors');
const btnOpenVote = document.getElementById('btn-open-vote');
const btnCloseVote = document.getElementById('btn-close-vote');
const btnEndParty = document.getElementById('btn-end-party');
const resultatRecepteur = document.getElementById('resultat-recepteur');
const moyenneRecepteur = document.getElementById('moyenne-recepteur');
const timerDisplay = document.getElementById('timer-display');
const timerValue = document.getElementById('timer-value');
const useTimer = document.getElementById('use-timer');
const timerDuration = document.getElementById('timer-duration');
const historiqueSection = document.getElementById('historique-section');
const historiqueList = document.getElementById('historique-list');

// Émetteur
const emetteurCode = document.getElementById('emetteur-code');
const emetteurWaiting = document.getElementById('emetteur-waiting');
const emetteurVote = document.getElementById('emetteur-vote');
const emetteurResultat = document.getElementById('emetteur-resultat');
const voteButtons = document.querySelectorAll('.vote-btn');
const voteStatus = document.getElementById('vote-status');
const moyenneEmetteur = document.getElementById('moyenne-emetteur');
const timerEmetteur = document.getElementById('timer-emetteur');
const timerEmetteurValue = document.getElementById('timer-emetteur-value');
const historiqueEmetteurSection = document.getElementById('historique-emetteur-section');
const historiqueEmetteurList = document.getElementById('historique-emetteur-list');

// Ended
const btnBackHome = document.getElementById('btn-back-home');

// Toast
const toast = document.getElementById('toast');

// État local
let currentRole = null;
let selectedVote = null;
let currentPartyCode = null;

// Fonctions utilitaires
function showScreen(screenName) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[screenName].classList.add('active');
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

function renderParticipants(emetteurs, etat) {
  participantsList.innerHTML = '';

  if (!emetteurs || emetteurs.length === 0) {
    participantsList.innerHTML = '<span style="color: #718096; font-size: 0.9rem;">Aucun participant</span>';
    return;
  }

  emetteurs.forEach(e => {
    const div = document.createElement('div');
    div.className = 'participant' + (e.aVote ? ' voted' : '');
    div.innerHTML = `
      <span class="status"></span>
      <span>${e.nom}</span>
    `;
    participantsList.appendChild(div);
  });
}

function renderHistorique(historique, targetList) {
  targetList.innerHTML = '';

  if (!historique || historique.length === 0) {
    return;
  }

  // Afficher dans l'ordre inverse (plus récent en premier)
  [...historique].reverse().forEach(h => {
    const div = document.createElement('div');
    div.className = 'historique-item';
    div.innerHTML = `
      <div>
        <span class="tour">Tour ${h.numero}</span>
        <span class="details">${h.nbVotants} votant${h.nbVotants > 1 ? 's' : ''}</span>
      </div>
      <span class="moyenne-small">${h.moyenne}</span>
    `;
    targetList.appendChild(div);
  });
}

// Événements Socket.io

// Réception du code de partie (pour le récepteur)
socket.on('party-code', (code) => {
  currentPartyCode = code;
  partyCode.textContent = code;
});

// Réception de l'état de la partie
socket.on('party-state', (state) => {
  if (state === null) {
    return;
  }

  // Stocker le code
  if (state.code) {
    currentPartyCode = state.code;
  }

  // Mise à jour écran récepteur
  if (currentRole === 'recepteur') {
    nbEmetteurs.textContent = state.nbEmetteurs;
    etatPartie.textContent = state.etat;

    // Liste des participants
    renderParticipants(state.emetteurs, state.etat);

    // Timer
    if (state.timer !== null && state.timer > 0) {
      timerDisplay.classList.remove('hidden');
      timerValue.textContent = state.timer;
      if (state.timer <= 5) {
        timerDisplay.classList.add('warning');
      } else {
        timerDisplay.classList.remove('warning');
      }
    } else {
      timerDisplay.classList.add('hidden');
    }

    // Historique
    if (state.historique && state.historique.length > 0) {
      historiqueSection.classList.remove('hidden');
      renderHistorique(state.historique, historiqueList);
    } else {
      historiqueSection.classList.add('hidden');
    }

    // Gestion des boutons selon l'état
    switch (state.etat) {
      case 'OUVERTE':
        btnCloseDoors.disabled = false;
        btnOpenVote.disabled = true;
        btnCloseVote.classList.add('hidden');
        resultatRecepteur.classList.add('hidden');
        break;
      case 'FERMEE':
        btnCloseDoors.disabled = true;
        btnOpenVote.disabled = false;
        btnOpenVote.classList.remove('hidden');
        btnCloseVote.classList.add('hidden');
        resultatRecepteur.classList.add('hidden');
        break;
      case 'VOTE_OUVERT':
        btnCloseDoors.disabled = true;
        btnOpenVote.classList.add('hidden');
        btnCloseVote.classList.remove('hidden');
        resultatRecepteur.classList.add('hidden');
        break;
      case 'VOTE_FERME':
        btnCloseDoors.disabled = true;
        btnOpenVote.classList.remove('hidden');
        btnOpenVote.disabled = false;
        btnCloseVote.classList.add('hidden');
        if (state.moyenne !== null) {
          resultatRecepteur.classList.remove('hidden');
          moyenneRecepteur.textContent = state.moyenne;
        }
        break;
    }
  }

  // Mise à jour écran émetteur
  if (currentRole === 'emetteur') {
    emetteurCode.textContent = state.code || currentPartyCode;

    // Timer émetteur
    if (state.timer !== null && state.timer > 0 && state.etat === 'VOTE_OUVERT') {
      timerEmetteur.classList.remove('hidden');
      timerEmetteurValue.textContent = state.timer;
      if (state.timer <= 5) {
        timerEmetteur.classList.add('warning');
      } else {
        timerEmetteur.classList.remove('warning');
      }
    } else {
      timerEmetteur.classList.add('hidden');
    }

    // Historique émetteur
    if (state.historique && state.historique.length > 0) {
      historiqueEmetteurSection.classList.remove('hidden');
      renderHistorique(state.historique, historiqueEmetteurList);
    } else {
      historiqueEmetteurSection.classList.add('hidden');
    }

    switch (state.etat) {
      case 'OUVERTE':
      case 'FERMEE':
        emetteurWaiting.classList.remove('hidden');
        emetteurVote.classList.add('hidden');
        emetteurResultat.classList.add('hidden');
        break;
      case 'VOTE_OUVERT':
        emetteurWaiting.classList.add('hidden');
        emetteurVote.classList.remove('hidden');
        emetteurResultat.classList.add('hidden');
        // Reset vote selection for new vote
        selectedVote = null;
        voteButtons.forEach(btn => btn.classList.remove('selected'));
        voteStatus.textContent = '';
        break;
      case 'VOTE_FERME':
        emetteurWaiting.classList.add('hidden');
        emetteurVote.classList.add('hidden');
        emetteurResultat.classList.remove('hidden');
        if (state.moyenne !== null) {
          moyenneEmetteur.textContent = state.moyenne;
        }
        break;
    }
  }
});

// Réception du rôle
socket.on('role', (role) => {
  currentRole = role;
  if (role === 'recepteur') {
    showScreen('recepteur');
  } else if (role === 'emetteur') {
    showScreen('emetteur');
  }
});

// Confirmation de vote
socket.on('vote-confirmed', (valeur) => {
  voteStatus.textContent = `Vote enregistré : ${valeur}`;
});

// Partie terminée
socket.on('party-ended', () => {
  if (currentRole !== null) {
    showScreen('ended');
    currentRole = null;
    currentPartyCode = null;
  }
});

// Erreur
socket.on('error', (message) => {
  showToast(message);
});

// Événements UI

// Accueil - Démarrer
btnStart.addEventListener('click', () => {
  socket.emit('start-party');
});

// Accueil - Rejoindre
btnJoin.addEventListener('click', () => {
  const code = inputCode.value.trim();
  const nom = inputNom.value.trim();

  if (code.length !== 4) {
    showToast('Entrez un code à 4 chiffres');
    return;
  }

  socket.emit('join-party', { code, nom });
});

// Permettre de rejoindre avec Enter
inputCode.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    inputNom.focus();
  }
});

inputNom.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    btnJoin.click();
  }
});

// Timer checkbox
useTimer.addEventListener('change', () => {
  timerDuration.disabled = !useTimer.checked;
});

// Récepteur - Fermer les portes
btnCloseDoors.addEventListener('click', () => {
  socket.emit('close-doors');
});

// Récepteur - Ouvrir le vote
btnOpenVote.addEventListener('click', () => {
  let timerSeconds = null;
  if (useTimer.checked) {
    timerSeconds = parseInt(timerDuration.value, 10);
  }
  socket.emit('open-vote', timerSeconds);
});

// Récepteur - Fermer le vote
btnCloseVote.addEventListener('click', () => {
  socket.emit('close-vote');
});

// Récepteur - Terminer la partie
btnEndParty.addEventListener('click', () => {
  if (confirm('Êtes-vous sûr de vouloir terminer la partie ?')) {
    socket.emit('end-party');
    showScreen('home');
    currentRole = null;
    currentPartyCode = null;
  }
});

// Émetteur - Vote
voteButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const valeur = parseInt(btn.dataset.value, 10);
    selectedVote = valeur;

    // Mise à jour visuelle
    voteButtons.forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');

    // Envoyer le vote
    socket.emit('vote', valeur);
  });
});

// Retour accueil
btnBackHome.addEventListener('click', () => {
  showScreen('home');
  inputCode.value = '';
  inputNom.value = '';
});
