const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir les fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));

// État de la partie (une seule partie active)
let party = null;

// Structure d'une partie :
// {
//   recepteurId: string,
//   etat: 'OUVERTE' | 'FERMEE' | 'VOTE_OUVERT' | 'VOTE_FERME',
//   emetteurs: Map<socketId, { id: string }>,
//   votes: Map<socketId, number>,
//   moyenne: number | null
// }

function getPartyState() {
  if (!party) return null;
  return {
    etat: party.etat,
    nbEmetteurs: party.emetteurs.size,
    moyenne: party.moyenne,
    votes: Object.fromEntries(party.votes)
  };
}

function broadcastState() {
  const state = getPartyState();
  io.emit('party-state', state);
}

io.on('connection', (socket) => {
  console.log('Utilisateur connecté:', socket.id);

  // Envoyer l'état actuel au nouvel arrivant
  socket.emit('party-state', getPartyState());
  socket.emit('role', null);

  // Vérifier si une partie existe
  socket.on('check-party', () => {
    socket.emit('party-exists', party !== null);
  });

  // Démarrer une partie (devenir Récepteur)
  socket.on('start-party', () => {
    if (party !== null) {
      socket.emit('error', 'Une partie existe déjà');
      return;
    }

    party = {
      recepteurId: socket.id,
      etat: 'OUVERTE',
      emetteurs: new Map(),
      votes: new Map(),
      moyenne: null
    };

    socket.emit('role', 'recepteur');
    broadcastState();
    console.log('Partie créée par:', socket.id);
  });

  // Rejoindre une partie (devenir Émetteur)
  socket.on('join-party', () => {
    if (!party) {
      socket.emit('error', 'Aucune partie en cours');
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

    if (socket.id === party.recepteurId) {
      socket.emit('error', 'Vous êtes le récepteur');
      return;
    }

    party.emetteurs.set(socket.id, { id: socket.id });
    socket.emit('role', 'emetteur');
    broadcastState();
    console.log('Émetteur rejoint:', socket.id);
  });

  // Fermer les portes (Récepteur uniquement)
  socket.on('close-doors', () => {
    if (!party || socket.id !== party.recepteurId) {
      socket.emit('error', 'Action non autorisée');
      return;
    }

    party.etat = 'FERMEE';
    broadcastState();
    console.log('Portes fermées');
  });

  // Ouvrir le vote (Récepteur uniquement)
  socket.on('open-vote', () => {
    if (!party || socket.id !== party.recepteurId) {
      socket.emit('error', 'Action non autorisée');
      return;
    }

    party.votes.clear();
    party.moyenne = null;
    party.etat = 'VOTE_OUVERT';
    broadcastState();
    console.log('Vote ouvert');
  });

  // Fermer le vote et calculer la moyenne (Récepteur uniquement)
  socket.on('close-vote', () => {
    if (!party || socket.id !== party.recepteurId) {
      socket.emit('error', 'Action non autorisée');
      return;
    }

    party.etat = 'VOTE_FERME';

    // Calculer la moyenne
    const votes = Array.from(party.votes.values());
    if (votes.length > 0) {
      const somme = votes.reduce((acc, v) => acc + v, 0);
      party.moyenne = Math.round((somme / votes.length) * 10) / 10;
    } else {
      party.moyenne = null;
    }

    broadcastState();
    console.log('Vote fermé, moyenne:', party.moyenne);
  });

  // Voter (Émetteur uniquement)
  socket.on('vote', (valeur) => {
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

    // Notifier le récepteur du nombre de votes
    io.emit('vote-count', party.votes.size);
    console.log('Vote reçu de', socket.id, ':', v);
  });

  // Terminer la partie (Récepteur uniquement)
  socket.on('end-party', () => {
    if (!party || socket.id !== party.recepteurId) {
      socket.emit('error', 'Action non autorisée');
      return;
    }

    party = null;
    io.emit('party-ended');
    io.emit('party-state', null);
    io.emit('role', null);
    console.log('Partie terminée');
  });

  // Déconnexion
  socket.on('disconnect', () => {
    console.log('Utilisateur déconnecté:', socket.id);

    if (!party) return;

    // Si le récepteur se déconnecte, terminer la partie
    if (socket.id === party.recepteurId) {
      party = null;
      io.emit('party-ended');
      io.emit('party-state', null);
      io.emit('role', null);
      console.log('Récepteur déconnecté, partie terminée');
      return;
    }

    // Si un émetteur se déconnecte, le retirer
    if (party.emetteurs.has(socket.id)) {
      party.emetteurs.delete(socket.id);
      party.votes.delete(socket.id);
      broadcastState();
      console.log('Émetteur retiré:', socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
