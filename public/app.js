const socket = io();

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

// Récepteur
const nbEmetteurs = document.getElementById('nb-emetteurs');
const etatPartie = document.getElementById('etat-partie');
const nbVotes = document.getElementById('nb-votes');
const btnCloseDoors = document.getElementById('btn-close-doors');
const btnOpenVote = document.getElementById('btn-open-vote');
const btnCloseVote = document.getElementById('btn-close-vote');
const btnEndParty = document.getElementById('btn-end-party');
const resultatRecepteur = document.getElementById('resultat-recepteur');
const moyenneRecepteur = document.getElementById('moyenne-recepteur');

// Émetteur
const emetteurWaiting = document.getElementById('emetteur-waiting');
const emetteurVote = document.getElementById('emetteur-vote');
const emetteurResultat = document.getElementById('emetteur-resultat');
const voteButtons = document.querySelectorAll('.vote-btn');
const voteStatus = document.getElementById('vote-status');
const moyenneEmetteur = document.getElementById('moyenne-emetteur');

// Ended
const btnBackHome = document.getElementById('btn-back-home');

// Toast
const toast = document.getElementById('toast');

// État local
let currentRole = null;
let selectedVote = null;

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

// Événements Socket.io

// Réception de l'état de la partie
socket.on('party-state', (state) => {
  if (state === null) {
    // Pas de partie
    btnStart.disabled = false;
    btnJoin.disabled = true;
    return;
  }

  // Mise à jour boutons accueil
  btnStart.disabled = true;
  btnJoin.disabled = state.etat !== 'OUVERTE';

  // Mise à jour écran récepteur
  if (currentRole === 'recepteur') {
    nbEmetteurs.textContent = state.nbEmetteurs;
    etatPartie.textContent = state.etat;

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

// Compteur de votes (pour le récepteur)
socket.on('vote-count', (count) => {
  if (currentRole === 'recepteur') {
    nbVotes.textContent = count;
  }
});

// Partie terminée
socket.on('party-ended', () => {
  if (currentRole !== null) {
    showScreen('ended');
    currentRole = null;
  }
});

// Erreur
socket.on('error', (message) => {
  showToast(message);
});

// Événements UI

// Accueil
btnStart.addEventListener('click', () => {
  socket.emit('start-party');
});

btnJoin.addEventListener('click', () => {
  socket.emit('join-party');
});

// Récepteur
btnCloseDoors.addEventListener('click', () => {
  socket.emit('close-doors');
});

btnOpenVote.addEventListener('click', () => {
  nbVotes.textContent = '0';
  socket.emit('open-vote');
});

btnCloseVote.addEventListener('click', () => {
  socket.emit('close-vote');
});

btnEndParty.addEventListener('click', () => {
  if (confirm('Êtes-vous sûr de vouloir terminer la partie ?')) {
    socket.emit('end-party');
    showScreen('home');
    currentRole = null;
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
  socket.emit('check-party');
});

// Vérifier l'état au chargement
socket.emit('check-party');
