require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 15000,
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e6,
});

// Connexion Redis Upstash
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Servir les fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));

// Route keep-alive pour éviter que Render s'endorme
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// Préfixe pour les clés Redis
const PARTY_PREFIX = 'party:';
const OD_PREFIX = 'od:'; // odId → code de partie

// TTL des parties (2 heures)
const PARTY_TTL = 7200;

// Structure d'une partie (stockée en JSON dans Redis) :
// {
//   code: string,
//   recepteurOdId: string,           // odId persistant du créateur
//   etat: 'OUVERTE' | 'FERMEE' | 'VOTE_OUVERT' | 'VOTE_FERME',
//   emetteurs: { [odId]: { id: string, nom: string, connecte: boolean } },
//   votes: { [odId]: number },
//   moyenne: number | null,
//   historique: Array<{ numero: number, moyenne: number, nbVotants: number, votes: Object }>,
//   timerEndTime: number | null (timestamp)
// }

// --- Maps en mémoire ---
// odId → socketId courant (pour retrouver le socket lors du broadcast)
const odToSocket = new Map();
// socketId → odId (pour retrouver l'identité lors de la déconnexion)
const socketToOd = new Map();
// Mutex par partie (sérialiser les écritures concurrentes)
const partyLocks = new Map();
// Cache local pour les timers
const timerIntervals = new Map();

// --- Mutex simple par code de partie ---
async function withPartyLock(code, fn) {
  if (!partyLocks.has(code)) {
    partyLocks.set(code, Promise.resolve());
  }
  const prev = partyLocks.get(code);
  let resolve;
  const next = new Promise(r => { resolve = r; });
  partyLocks.set(code, next);
  await prev;
  try {
    return await fn();
  } finally {
    resolve();
  }
}

// Génère un code à 4 chiffres unique
async function generateCode() {
  let code;
  let exists = true;
  while (exists) {
    code = Math.floor(1000 + Math.random() * 9000).toString();
    exists = await redis.exists(PARTY_PREFIX + code);
  }
  return code;
}

// Récupérer une partie depuis Redis
async function getParty(code) {
  if (!code) return null;
  const data = await redis.get(PARTY_PREFIX + code);
  return data;
}

// Sauvegarder une partie dans Redis
async function saveParty(party) {
  await redis.set(PARTY_PREFIX + party.code, party, { ex: PARTY_TTL });
}

// Supprimer une partie
async function deleteParty(code) {
  stopTimer(code);
  await redis.del(PARTY_PREFIX + code);
  partyLocks.delete(code);
}

// Récupérer le code de partie d'un utilisateur (par odId)
async function getUserParty(odId) {
  return await redis.get(OD_PREFIX + odId);
}

// Associer un utilisateur à une partie (par odId)
async function setUserParty(odId, code) {
  await redis.set(OD_PREFIX + odId, code, { ex: PARTY_TTL });
}

// Supprimer l'association utilisateur -> partie
async function deleteUserParty(odId) {
  await redis.del(OD_PREFIX + odId);
}

function getPartyState(party) {
  if (!party) return null;

  // Liste des émetteurs avec leur statut de vote et connexion
  const emetteursList = [];
  for (const [odId, data] of Object.entries(party.emetteurs || {})) {
    emetteursList.push({
      id: odId,
      nom: data.nom,
      aVote: party.votes && party.votes[odId] !== undefined,
      connecte: data.connecte !== false,
    });
  }

  // Calculer le timer restant si timerEndTime est défini
  let timer = null;
  if (party.timerEndTime) {
    timer = Math.max(0, Math.round((party.timerEndTime - Date.now()) / 1000));
    if (timer <= 0) timer = null;
  }

  return {
    code: party.code,
    etat: party.etat,
    nbEmetteurs: Object.keys(party.emetteurs || {}).length,
    moyenne: party.moyenne,
    emetteurs: emetteursList,
    nbVotes: Object.keys(party.votes || {}).length,
    historique: party.historique || [],
    timer: timer,
    timerEndTime: party.timerEndTime || null,
    tourNumero: (party.historique || []).length,
  };
}

async function broadcastToParty(party) {
  const state = getPartyState(party);
  // Utiliser la room Socket.IO pour un broadcast performant
  io.to('party:' + party.code).emit('party-state', state);
}

function stopTimer(code) {
  if (timerIntervals.has(code)) {
    clearInterval(timerIntervals.get(code));
    timerIntervals.delete(code);
  }
}

function startTimer(party, seconds) {
  stopTimer(party.code);
  party.timerEndTime = Date.now() + seconds * 1000;

  // Le timer côté serveur vérifie uniquement l'expiration.
  // Le décompte visuel est géré côté client via timerEndTime.
  const interval = setInterval(async () => {
    try {
      await withPartyLock(party.code, async () => {
        const currentParty = await getParty(party.code);
        if (!currentParty) {
          stopTimer(party.code);
          return;
        }

        const remaining = Math.round((currentParty.timerEndTime - Date.now()) / 1000);

        if (remaining <= 0) {
          stopTimer(party.code);
          await closeVote(currentParty);
        }
        // Plus de broadcast chaque seconde — le client fait le décompte
      });
    } catch (err) {
      console.error('Erreur timer:', err);
      stopTimer(party.code);
    }
  }, 1000);

  timerIntervals.set(party.code, interval);
}

async function closeVote(party) {
  party.etat = 'VOTE_FERME';
  party.timerEndTime = null;
  stopTimer(party.code);

  // Calculer la moyenne
  const votes = Object.values(party.votes || {});
  if (votes.length > 0) {
    const somme = votes.reduce((acc, v) => acc + v, 0);
    party.moyenne = Math.round((somme / votes.length) * 10) / 10;

    // Ajouter à l'historique
    const votesDetail = {};
    for (const [odId, valeur] of Object.entries(party.votes || {})) {
      const emetteur = party.emetteurs[odId];
      if (emetteur) {
        votesDetail[emetteur.nom] = valeur;
      }
    }

    party.historique = party.historique || [];
    party.historique.push({
      numero: party.historique.length + 1,
      moyenne: party.moyenne,
      nbVotants: votes.length,
      votes: votesDetail
    });
  } else {
    party.moyenne = null;
  }

  await saveParty(party);
  await broadcastToParty(party);
  console.log('Vote fermé, moyenne:', party.moyenne);
}

// Helper : faire rejoindre un socket dans une room et mettre à jour les maps
function registerSocket(socket, odId, code) {
  odToSocket.set(odId, socket.id);
  socketToOd.set(socket.id, odId);
  socket.join('party:' + code);
}

// Helper : retirer un socket des maps
function unregisterSocket(socket) {
  const odId = socketToOd.get(socket.id);
  if (odId) {
    // Ne retirer odToSocket que si c'est bien ce socket qui est actif
    if (odToSocket.get(odId) === socket.id) {
      odToSocket.delete(odId);
    }
    socketToOd.delete(socket.id);
  }
  return odId;
}

io.on('connection', (socket) => {
  console.log('Utilisateur connecté:', socket.id);

  // Démarrer une partie (devenir Récepteur)
  socket.on('start-party', async (clientOdId) => {
    try {
      const odId = clientOdId || crypto.randomUUID();

      // Vérifier que l'utilisateur n'est pas déjà dans une partie
      const existingCode = await getUserParty(odId);
      if (existingCode) {
        const existingParty = await getParty(existingCode);
        if (existingParty) {
          socket.emit('error', 'Vous êtes déjà dans une partie');
          return;
        }
        // La partie n'existe plus, nettoyer
        await deleteUserParty(odId);
      }

      const code = await generateCode();
      const party = {
        code: code,
        recepteurOdId: odId,
        etat: 'OUVERTE',
        emetteurs: {},
        votes: {},
        moyenne: null,
        historique: [],
        timerEndTime: null
      };

      await saveParty(party);
      await setUserParty(odId, code);
      registerSocket(socket, odId, code);

      socket.emit('role', 'recepteur');
      socket.emit('party-code', code);
      socket.emit('assigned-od-id', odId);
      await broadcastToParty(party);
      console.log('Partie créée:', code, 'par odId:', odId);
    } catch (err) {
      console.error('Erreur start-party:', err);
      socket.emit('error', 'Erreur serveur');
    }
  });

  // Rejoindre une partie avec un code (devenir Émetteur)
  // Accepte les rejoins à tout moment (pas seulement état OUVERTE)
  socket.on('join-party', async ({ code, nom, odId: clientOdId }) => {
    try {
      const odId = clientOdId || crypto.randomUUID();

      // Vérifier si l'utilisateur est déjà dans une autre partie
      const existingCode = await getUserParty(odId);
      if (existingCode && existingCode !== code) {
        const otherParty = await getParty(existingCode);
        if (otherParty) {
          socket.emit('error', 'Vous êtes déjà dans une autre partie');
          return;
        }
        await deleteUserParty(odId);
      }

      // Protéger la lecture-modification-écriture par le mutex
      await withPartyLock(code, async () => {
        const party = await getParty(code);
        if (!party) {
          socket.emit('error', 'Code invalide');
          return;
        }

        // Vérifier si c'est une reconnexion d'un émetteur existant
        if (party.emetteurs && party.emetteurs[odId]) {
          party.emetteurs[odId].connecte = true;
          await saveParty(party);
          await setUserParty(odId, code);
          registerSocket(socket, odId, code);

          socket.emit('role', 'emetteur');
          socket.emit('assigned-od-id', odId);

          // Restaurer le vote si existant
          if (party.votes && party.votes[odId] !== undefined) {
            socket.emit('vote-confirmed', party.votes[odId]);
          }

          await broadcastToParty(party);
          console.log('Émetteur reconnecté:', odId, 'partie:', code);
          return;
        }

        // Nouveau participant — vérifier les limites
        if (Object.keys(party.emetteurs || {}).length >= 25) {
          socket.emit('error', 'Nombre maximum de participants atteint');
          return;
        }

        // Nettoyer le nom
        const nomClean = (nom || 'Anonyme').trim().substring(0, 20) || 'Anonyme';

        party.emetteurs = party.emetteurs || {};
        party.emetteurs[odId] = { id: odId, nom: nomClean, connecte: true };

        await saveParty(party);
        await setUserParty(odId, code);
        registerSocket(socket, odId, code);

        socket.emit('role', 'emetteur');
        socket.emit('assigned-od-id', odId);
        await broadcastToParty(party);
        console.log('Émetteur rejoint:', odId, 'nom:', nomClean, 'partie:', code);
      });
    } catch (err) {
      console.error('Erreur join-party:', err);
      socket.emit('error', 'Erreur serveur');
    }
  });

  // Reconnexion automatique (client envoie son odId et le code)
  socket.on('reconnect-party', async ({ odId, code }) => {
    try {
      if (!odId || !code) {
        socket.emit('error', 'Informations de reconnexion manquantes');
        return;
      }

      // Protéger la lecture-modification-écriture par le mutex
      await withPartyLock(code, async () => {
        const party = await getParty(code);
        if (!party) {
          socket.emit('reconnect-failed');
          return;
        }

        // Reconnexion du récepteur
        if (party.recepteurOdId === odId) {
          registerSocket(socket, odId, code);
          await setUserParty(odId, code);
          socket.emit('role', 'recepteur');
          socket.emit('party-code', code);
          socket.emit('assigned-od-id', odId);
          await broadcastToParty(party);
          console.log('Récepteur reconnecté:', odId, 'partie:', code);
          return;
        }

        // Reconnexion d'un émetteur
        if (party.emetteurs && party.emetteurs[odId]) {
          party.emetteurs[odId].connecte = true;
          await saveParty(party);
          await setUserParty(odId, code);
          registerSocket(socket, odId, code);

          socket.emit('role', 'emetteur');
          socket.emit('assigned-od-id', odId);

          // Restaurer le vote si existant
          if (party.votes && party.votes[odId] !== undefined) {
            socket.emit('vote-confirmed', party.votes[odId]);
          }

          await broadcastToParty(party);
          console.log('Émetteur reconnecté via reconnect-party:', odId, 'partie:', code);
          return;
        }

        // L'odId n'est pas dans cette partie
        socket.emit('reconnect-failed');
      });
    } catch (err) {
      console.error('Erreur reconnect-party:', err);
      socket.emit('reconnect-failed');
    }
  });

  // Fermer les portes (Récepteur uniquement)
  socket.on('close-doors', async () => {
    try {
      const odId = socketToOd.get(socket.id);
      if (!odId) { socket.emit('error', 'Action non autorisée'); return; }

      const code = await getUserParty(odId);
      await withPartyLock(code, async () => {
        const party = await getParty(code);
        if (!party || odId !== party.recepteurOdId) {
          socket.emit('error', 'Action non autorisée');
          return;
        }

        party.etat = 'FERMEE';
        await saveParty(party);
        await broadcastToParty(party);
        console.log('Portes fermées, partie:', code);
      });
    } catch (err) {
      console.error('Erreur close-doors:', err);
      socket.emit('error', 'Erreur serveur');
    }
  });

  // Ouvrir le vote (Récepteur uniquement)
  socket.on('open-vote', async (timerSeconds) => {
    try {
      const odId = socketToOd.get(socket.id);
      if (!odId) { socket.emit('error', 'Action non autorisée'); return; }

      const code = await getUserParty(odId);
      await withPartyLock(code, async () => {
        const party = await getParty(code);
        if (!party || odId !== party.recepteurOdId) {
          socket.emit('error', 'Action non autorisée');
          return;
        }

        party.votes = {};
        party.moyenne = null;
        party.etat = 'VOTE_OUVERT';

        // Démarrer le timer si spécifié
        if (timerSeconds && timerSeconds > 0) {
          startTimer(party, timerSeconds);
        } else {
          party.timerEndTime = null;
        }

        await saveParty(party);
        await broadcastToParty(party);
        console.log('Vote ouvert, partie:', code, 'timer:', timerSeconds || 'aucun');
      });
    } catch (err) {
      console.error('Erreur open-vote:', err);
      socket.emit('error', 'Erreur serveur');
    }
  });

  // Fermer le vote (Récepteur uniquement)
  socket.on('close-vote', async () => {
    try {
      const odId = socketToOd.get(socket.id);
      if (!odId) { socket.emit('error', 'Action non autorisée'); return; }

      const code = await getUserParty(odId);
      await withPartyLock(code, async () => {
        const party = await getParty(code);
        if (!party || odId !== party.recepteurOdId) {
          socket.emit('error', 'Action non autorisée');
          return;
        }

        await closeVote(party);
      });
    } catch (err) {
      console.error('Erreur close-vote:', err);
      socket.emit('error', 'Erreur serveur');
    }
  });

  // Voter (Émetteur uniquement) — protégé par le mutex de la partie
  socket.on('vote', async (valeur) => {
    try {
      const odId = socketToOd.get(socket.id);
      if (!odId) { socket.emit('error', 'Aucune partie en cours'); return; }

      const code = await getUserParty(odId);

      await withPartyLock(code, async () => {
        const party = await getParty(code);

        if (!party) {
          socket.emit('error', 'Aucune partie en cours');
          return;
        }

        if (party.etat !== 'VOTE_OUVERT') {
          socket.emit('error', 'Le vote n\'est pas ouvert');
          return;
        }

        if (!party.emetteurs || !party.emetteurs[odId]) {
          socket.emit('error', 'Vous n\'êtes pas un émetteur');
          return;
        }

        const v = parseInt(valeur, 10);
        if (isNaN(v) || v < 0 || v > 6) {
          socket.emit('error', 'Valeur invalide (0-6)');
          return;
        }

        party.votes = party.votes || {};
        party.votes[odId] = v;

        await saveParty(party);

        socket.emit('vote-confirmed', v);
        await broadcastToParty(party);
        console.log('Vote reçu de', odId, ':', v);
      });
    } catch (err) {
      console.error('Erreur vote:', err);
      socket.emit('error', 'Erreur serveur');
    }
  });

  // Terminer la partie (Récepteur uniquement)
  socket.on('end-party', async () => {
    try {
      const odId = socketToOd.get(socket.id);
      if (!odId) { socket.emit('error', 'Action non autorisée'); return; }

      const code = await getUserParty(odId);
      const party = await getParty(code);

      if (!party || odId !== party.recepteurOdId) {
        socket.emit('error', 'Action non autorisée');
        return;
      }

      // Notifier tout le monde via la room
      io.to('party:' + code).emit('party-ended');

      // Nettoyer les associations user
      for (const emOdId of Object.keys(party.emetteurs || {})) {
        await deleteUserParty(emOdId);
        const emSocketId = odToSocket.get(emOdId);
        if (emSocketId) {
          socketToOd.delete(emSocketId);
          odToSocket.delete(emOdId);
        }
      }

      await deleteUserParty(odId);
      await deleteParty(code);

      // Nettoyer les maps du récepteur
      socketToOd.delete(socket.id);
      odToSocket.delete(odId);

      console.log('Partie terminée:', code);
    } catch (err) {
      console.error('Erreur end-party:', err);
      socket.emit('error', 'Erreur serveur');
    }
  });

  // Déconnexion — ne retire plus les participants, les marque juste comme déconnectés
  socket.on('disconnect', async () => {
    console.log('Utilisateur déconnecté:', socket.id);

    try {
      const odId = unregisterSocket(socket);
      if (!odId) return;

      const code = await getUserParty(odId);
      if (!code) return;

      const party = await getParty(code);
      if (!party) {
        await deleteUserParty(odId);
        return;
      }

      // Si le récepteur se déconnecte, la partie est préservée (il peut se reconnecter)
      if (odId === party.recepteurOdId) {
        console.log('Récepteur déconnecté (partie préservée):', odId, 'partie:', code);
        return;
      }

      // Si un émetteur se déconnecte, le marquer comme déconnecté (ne pas supprimer)
      // Protégé par le mutex pour éviter d'écraser des votes concurrents
      if (party.emetteurs && party.emetteurs[odId]) {
        await withPartyLock(code, async () => {
          const freshParty = await getParty(code);
          if (freshParty && freshParty.emetteurs && freshParty.emetteurs[odId]) {
            freshParty.emetteurs[odId].connecte = false;
            await saveParty(freshParty);
            await broadcastToParty(freshParty);
            console.log('Émetteur déconnecté (préservé):', odId, 'partie:', code);
          }
        });
      }
    } catch (err) {
      console.error('Erreur disconnect:', err);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
