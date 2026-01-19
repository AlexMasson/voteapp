const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir les fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));

// Stockage des parties (plusieurs parties possibles)
const parties = new Map();

// Génère un code à 4 chiffres unique
function generateCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (parties.has(code));
  return code;
}

// Structure d'une partie :
// {
//   code: string,
//   recepteurId: string,
//   etat: 'OUVERTE' | 'FERMEE' | 'VOTE_OUVERT' | 'VOTE_FERME',
//   emetteurs: Map<socketId, { id: string, nom: string }>,
//   votes: Map<socketId, number>,
//   moyenne: number | null,
//   historique: Array<{ numero: number, moyenne: number, nbVotants: number, votes: Object }>,
//   timer: number | null (secondes restantes),
//   timerInterval: NodeJS.Timeout | null
// }

function getPartyState(party) {
  if (!party) return null;

  // Liste des émetteurs avec leur statut de vote
  const emetteursList = [];
  party.emetteurs.forEach((data, id) => {
    emetteursList.push({
      id: id,
      nom: data.nom,
      aVote: party.votes.has(id)
    });
  });

  return {
    code: party.code,
    etat: party.etat,
    nbEmetteurs: party.emetteurs.size,
    moyenne: party.moyenne,
    emetteurs: emetteursList,
    nbVotes: party.votes.size,
    historique: party.historique,
    timer: party.timer
  };
}

function broadcastToParty(party) {
  const state = getPartyState(party);
  // Envoyer au récepteur
  io.to(party.recepteurId).emit('party-state', state);
  // Envoyer à tous les émetteurs
  party.emetteurs.forEach((_, socketId) => {
    io.to(socketId).emit('party-state', state);
  });
}

function stopTimer(party) {
  if (party.timerInterval) {
    clearInterval(party.timerInterval);
    party.timerInterval = null;
  }
  party.timer = null;
}

function startTimer(party, seconds) {
  stopTimer(party);
  party.timer = seconds;

  party.timerInterval = setInterval(() => {
    party.timer--;
    broadcastToParty(party);

    if (party.timer <= 0) {
      stopTimer(party);
      // Auto-fermer le vote
      closeVote(party);
    }
  }, 1000);
}

function closeVote(party) {
  party.etat = 'VOTE_FERME';
  stopTimer(party);

  // Calculer la moyenne
  const votes = Array.from(party.votes.values());
  if (votes.length > 0) {
    const somme = votes.reduce((acc, v) => acc + v, 0);
    party.moyenne = Math.round((somme / votes.length) * 10) / 10;

    // Ajouter à l'historique
    const votesDetail = {};
    party.votes.forEach((valeur, odId) => {
      const emetteur = party.emetteurs.get(odId);
      if (emetteur) {
        votesDetail[emetteur.nom] = valeur;
      }
    });

    party.historique.push({
      numero: party.historique.length + 1,
      moyenne: party.moyenne,
      nbVotants: votes.length,
      votes: votesDetail
    });
  } else {
    party.moyenne = null;
  }

  broadcastToParty(party);
  console.log('Vote fermé, moyenne:', party.moyenne);
}

// Mapping socketId -> code de partie (pour retrouver la partie d'un utilisateur)
const userParties = new Map();

io.on('connection', (socket) => {
  console.log('Utilisateur connecté:', socket.id);

  // Envoyer l'état initial
  socket.emit('party-state', null);
  socket.emit('role', null);

  // Démarrer une partie (devenir Récepteur)
  socket.on('start-party', () => {
    // Vérifier que l'utilisateur n'est pas déjà dans une partie
    if (userParties.has(socket.id)) {
      socket.emit('error', 'Vous êtes déjà dans une partie');
      return;
    }

    const code = generateCode();
    const party = {
      code: code,
      recepteurId: socket.id,
      etat: 'OUVERTE',
      emetteurs: new Map(),
      votes: new Map(),
      moyenne: null,
      historique: [],
      timer: null,
      timerInterval: null
    };

    parties.set(code, party);
    userParties.set(socket.id, code);

    socket.emit('role', 'recepteur');
    socket.emit('party-code', code);
    broadcastToParty(party);
    console.log('Partie créée:', code, 'par:', socket.id);
  });

  // Rejoindre une partie avec un code (devenir Émetteur)
  socket.on('join-party', ({ code, nom }) => {
    // Vérifier que l'utilisateur n'est pas déjà dans une partie
    if (userParties.has(socket.id)) {
      socket.emit('error', 'Vous êtes déjà dans une partie');
      return;
    }

    const party = parties.get(code);
    if (!party) {
      socket.emit('error', 'Code invalide');
      return;
    }

    if (party.etat !== 'OUVERTE') {
      socket.emit('error', 'Les portes sont fermées');
      return;
    }

    if (party.emetteurs.size >= 25) {
      socket.emit('error', 'Nombre maximum de participants atteint');
      return;
    }

    // Nettoyer le nom
    const nomClean = (nom || 'Anonyme').trim().substring(0, 20) || 'Anonyme';

    party.emetteurs.set(socket.id, { id: socket.id, nom: nomClean });
    userParties.set(socket.id, code);

    socket.emit('role', 'emetteur');
    broadcastToParty(party);
    console.log('Émetteur rejoint:', socket.id, 'nom:', nomClean, 'partie:', code);
  });

  // Fermer les portes (Récepteur uniquement)
  socket.on('close-doors', () => {
    const code = userParties.get(socket.id);
    const party = parties.get(code);

    if (!party || socket.id !== party.recepteurId) {
      socket.emit('error', 'Action non autorisée');
      return;
    }

    party.etat = 'FERMEE';
    broadcastToParty(party);
    console.log('Portes fermées, partie:', code);
  });

  // Ouvrir le vote (Récepteur uniquement)
  socket.on('open-vote', (timerSeconds) => {
    const code = userParties.get(socket.id);
    const party = parties.get(code);

    if (!party || socket.id !== party.recepteurId) {
      socket.emit('error', 'Action non autorisée');
      return;
    }

    party.votes.clear();
    party.moyenne = null;
    party.etat = 'VOTE_OUVERT';

    // Démarrer le timer si spécifié
    if (timerSeconds && timerSeconds > 0) {
      startTimer(party, timerSeconds);
    }

    broadcastToParty(party);
    console.log('Vote ouvert, partie:', code, 'timer:', timerSeconds || 'aucun');
  });

  // Fermer le vote (Récepteur uniquement)
  socket.on('close-vote', () => {
    const code = userParties.get(socket.id);
    const party = parties.get(code);

    if (!party || socket.id !== party.recepteurId) {
      socket.emit('error', 'Action non autorisée');
      return;
    }

    closeVote(party);
  });

  // Voter (Émetteur uniquement)
  socket.on('vote', (valeur) => {
    const code = userParties.get(socket.id);
    const party = parties.get(code);

    if (!party) {
      socket.emit('error', 'Aucune partie en cours');
      return;
    }

    if (party.etat !== 'VOTE_OUVERT') {
      socket.emit('error', 'Le vote n\'est pas ouvert');
      return;
    }

    if (!party.emetteurs.has(socket.id)) {
      socket.emit('error', 'Vous n\'êtes pas un émetteur');
      return;
    }

    const v = parseInt(valeur, 10);
    if (isNaN(v) || v < 0 || v > 6) {
      socket.emit('error', 'Valeur invalide (0-6)');
      return;
    }

    party.votes.set(socket.id, v);
    socket.emit('vote-confirmed', v);
    broadcastToParty(party);
    console.log('Vote reçu de', socket.id, ':', v);
  });

  // Terminer la partie (Récepteur uniquement)
  socket.on('end-party', () => {
    const code = userParties.get(socket.id);
    const party = parties.get(code);

    if (!party || socket.id !== party.recepteurId) {
      socket.emit('error', 'Action non autorisée');
      return;
    }

    stopTimer(party);

    // Notifier tout le monde
    io.to(party.recepteurId).emit('party-ended');
    party.emetteurs.forEach((_, odId) => {
      io.to(odId).emit('party-ended');
      userParties.delete(odId);
    });

    userParties.delete(socket.id);
    parties.delete(code);

    io.to(socket.id).emit('party-state', null);
    io.to(socket.id).emit('role', null);

    console.log('Partie terminée:', code);
  });

  // Déconnexion
  socket.on('disconnect', () => {
    console.log('Utilisateur déconnecté:', socket.id);

    const code = userParties.get(socket.id);
    if (!code) return;

    const party = parties.get(code);
    if (!party) {
      userParties.delete(socket.id);
      return;
    }

    // Si le récepteur se déconnecte, terminer la partie
    if (socket.id === party.recepteurId) {
      stopTimer(party);

      party.emetteurs.forEach((_, odId) => {
        io.to(odId).emit('party-ended');
        userParties.delete(odId);
      });

      parties.delete(code);
      userParties.delete(socket.id);
      console.log('Récepteur déconnecté, partie terminée:', code);
      return;
    }

    // Si un émetteur se déconnecte, le retirer
    if (party.emetteurs.has(socket.id)) {
      party.emetteurs.delete(socket.id);
      party.votes.delete(socket.id);
      userParties.delete(socket.id);
      broadcastToParty(party);
      console.log('Émetteur retiré:', socket.id, 'partie:', code);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
