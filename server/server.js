const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // allow all in dev
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Health check for hosting services
app.get('/', (req, res) => {
  res.send('BiteMatch API is running 🍕');
});

// --- Rate Limiter ---
const rateLimitMap = new Map(); // IP -> { count, resetAt }
const RATE_LIMIT_MAX = 5;       // max requests
const RATE_LIMIT_WINDOW = 60 * 1000; // per 1 minute

function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return next();
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    const waitSec = Math.ceil((entry.resetAt - now) / 1000);
    return res.status(429).json({ error: `Příliš mnoho požadavků. Zkus to znovu za ${waitSec}s.` });
  }

  entry.count++;
  return next();
}

// Cleanup stale rate limit entries every 10 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 10 * 60 * 1000);

// In-memory store for lobbies
const lobbies = new Map();

// Helper to generate a 6-character room code
function generateLobbyCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// --- Lobby Expiration Cleanup ---
const LOBBY_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [code, lobby] of lobbies.entries()) {
    if (now - lobby.createdAt > LOBBY_MAX_AGE_MS) {
      // Disconnect all remaining sockets
      for (const socketId of lobby.players.keys()) {
        const s = io.sockets.sockets.get(socketId);
        if (s) {
          s.emit('error', 'Lobby vypršelo (neaktivní déle než 1 hodinu).');
          s.disconnect(true);
        }
      }
      lobbies.delete(code);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`Cleanup: removed ${cleaned} expired ${cleaned === 1 ? 'lobby' : 'lobbies'}. Active: ${lobbies.size}`);
  }
}, CLEANUP_INTERVAL_MS);

console.log('Lobby cleanup scheduled: every 5 min, max age 1 hour.');

// Fetch restaurants from Google Places API
async function fetchRestaurants(lat, lon, radius = 1500) {
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'AIzaSyAndDn46ioSltBCezx2KUtpFZ1AlAh1Pu0';
  const googleUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lon}&radius=${radius}&type=restaurant&keyword=restaurace|bistro&language=cs&key=${GOOGLE_API_KEY}`;
  
  try {
    const response = await fetch(googleUrl);
    if (!response.ok) {
      throw new Error(`Google API returned status ${response.status}`);
    }

    const data = await response.json();
    
    // Process and filter results
    let restaurants = data.results
      .filter(el => {
        // Filtrování zavřených podniků
        if (el.business_status && el.business_status !== 'OPERATIONAL') return false;
        if (el.opening_hours && el.opening_hours.open_now === false) return false;

        // Filtrování nechtěných typů (hotely, nákupní centra)
        if (el.types) {
          const strictBadTypes = ['lodging', 'hotel', 'shopping_mall', 'department_store'];
          const softBadTypes = ['home_goods_store', 'store', 'clothing_store'];
          
          // Hotely a nákupáky vyhazujeme vždy
          if (el.types.some(t => strictBadTypes.includes(t))) return false;
          
          // Obchody vyhazujeme jen pokud u nich Google neuvádí, že je to zároveň restaurace
          if (el.types.some(t => softBadTypes.includes(t)) && !el.types.includes('restaurant')) return false;
        }
        
        // Filtrování podle názvu
        const nameLower = el.name ? el.name.toLowerCase() : '';
        const badNames = ['hotel', 'penzion', 'pension', 'ubytování', 'hostel', 'obchodní centrum', 'aupark', 'futurum', 'tesco', 'kaufland', 'albert', 'kfc', 'mcdonald'];
        const foodKeywords = ['restaurace', 'hospoda', 'hostinec', 'bistro', 'jídelna', 'pivnice'];
        
        let hasBadName = badNames.some(bn => nameLower.includes(bn) || nameLower.startsWith('oc '));
        
        // Pokud má "špatné" jméno (např. Penzion), ale zároveň obsahuje "Restaurace", tak ho necháme
        if (hasBadName && foodKeywords.some(fk => nameLower.includes(fk))) {
          hasBadName = false;
        }

        if (hasBadName) return false;
        
        return true;
      })
      .map(el => {
      // Překlady Google typů do češtiny
      const translations = {
        'cafe': 'Kavárna',
        'bakery': 'Pekařství',
        'bar': 'Bar',
        'night_club': 'Noční klub',
        'meal_takeaway': 'S sebou',
        'meal_delivery': 'Rozvoz',
        'liquor_store': 'Alkohol',
        'gas_station': 'Benzínka',
        'convenience_store': 'Večerka',
        'tourist_attraction': 'Turistický cíl'
      };

      // Beautify cuisine types from Google
      const excludedTypes = ['restaurant', 'food', 'point_of_interest', 'establishment', 'store', 'clothing_store', 'home_goods_store'];
      let mappedCuisine = el.types 
        ? el.types
            .filter(t => !excludedTypes.includes(t))
            .map(t => translations[t] || t.replace(/_/g, ' '))
            .join(', ')
        : 'Restaurace';
      
      if (mappedCuisine === '' || mappedCuisine.toLowerCase().includes('restaurace')) mappedCuisine = 'Restaurace';

      return {
        id: el.place_id,
        name: el.name,
        cuisine: mappedCuisine,
        address: el.vicinity || 'Adresa neznámá',
        lat: el.geometry.location.lat,
        lon: el.geometry.location.lng,
        amenity: 'restaurant',
        rating: el.rating || null,
        user_ratings_total: el.user_ratings_total || 0,
        price_level: el.price_level !== undefined ? el.price_level : null,
        imgUrls: [] // Naplníme pomocí Place Details
      };
    });
      
    // Shuffle the array and limit to 30 for performance
    restaurants = restaurants.sort(() => 0.5 - Math.random()).slice(0, 30); 

    // Fetch additional photos and links for these 20 restaurants using Place Details
    const detailedRestaurants = await Promise.all(restaurants.map(async r => {
      const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${r.id}&fields=photos,url,website&key=${GOOGLE_API_KEY}`;
      try {
        const detRes = await fetch(detailsUrl);
        const detData = await detRes.json();
        
        if (detData.result) {
          if (detData.result.photos) {
            // Take up to 4 photos
            r.imgUrls = detData.result.photos.slice(0, 4).map(p => 
              `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photo_reference=${p.photo_reference}&key=${GOOGLE_API_KEY}`
            );
          }
          r.mapsUrl = detData.result.url || null;
          r.websiteUrl = detData.result.website || null;
        }
      } catch (err) {
        console.error('Failed to fetch details for place', r.id, err);
      }
      return r;
    }));

    return detailedRestaurants;
  } catch (error) {
    console.error('Error fetching restaurants:', error);
    return [];
  }
}

// REST endpoints
app.post('/api/lobby', rateLimit, async (req, res) => {
  const { lat, lon, radius = 1500 } = req.body;
  
  if (!lat || !lon) {
    return res.status(400).json({ error: 'Lat and lon are required' });
  }

  let code = generateLobbyCode();
  while (lobbies.has(code)) {
    code = generateLobbyCode();
  }

  // Pre-fetch restaurants for this lobby
  const restaurants = await fetchRestaurants(lat, lon, radius);

  if (restaurants.length === 0) {
     return res.status(404).json({ error: 'Žádné restaurace nebyly nalezeny v tomto okolí.' });
  }

  const lobby = {
    code,
    host: null, // Will be set when first user connects
    players: new Map(), // socketId -> { name, emoji, swipes: [], status: 'waiting' }
    restaurants,
    location: { lat, lon, radius }, // Ukládáme pro pozdější reroll
    status: 'waiting', // waiting, playing, finished
    matches: [], // Array of restaurant IDs that everyone liked
    createdAt: Date.now()
  };

  lobbies.set(code, lobby);
  res.json({ code, count: restaurants.length });
});

app.get('/api/lobby/:code', (req, res) => {
  const lobby = lobbies.get(req.params.code.toUpperCase());
  if (!lobby) {
    return res.status(404).json({ error: 'Lobby neexistuje' });
  }
  
  res.json({
    code: lobby.code,
    status: lobby.status,
    playerCount: lobby.players.size,
    restaurantCount: lobby.restaurants.length
  });
});

// Socket.IO logic
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('join-lobby', ({ code, name, emoji, rejoin }) => {
    code = code.toUpperCase();
    const lobby = lobbies.get(code);
    
    if (!lobby) {
      socket.emit('error', 'Lobby neexistuje');
      return;
    }

    if (lobby.status !== 'waiting' && !rejoin) {
      socket.emit('error', 'Hra už začala');
      return;
    }

    // Protection against duplicate nicknames
    const trimmedName = (name || 'Anonym').trim();
    
    // On rejoin, remove old entry with same name first
    if (rejoin) {
      for (const [sid, p] of lobby.players.entries()) {
        if (p.name.toLowerCase() === trimmedName.toLowerCase()) {
          lobby.players.delete(sid);
          break;
        }
      }
    } else {
      const isDuplicate = Array.from(lobby.players.values()).some(p => p.name.toLowerCase() === trimmedName.toLowerCase());
      if (isDuplicate) {
        socket.emit('error', 'Toto jméno už je v místnosti obsazené! Zvol si jiné.');
        return;
      }
    }

    // Assign host if first
    let isHost = false;
    if (lobby.players.size === 0) {
      lobby.host = socket.id;
      isHost = true;
    }

    lobby.players.set(socket.id, {
      name: name || 'Anonym',
      emoji: emoji || '😋',
      swipes: {}, // restaurantId -> boolean (true=like, false=nope)
      status: 'waiting'
    });

    socket.join(code);
    
    // Tell the user they joined successfully
    socket.emit('joined', {
      isHost,
      restaurantsCount: lobby.restaurants.length,
      players: Array.from(lobby.players.values()).map(p => ({ name: p.name, emoji: p.emoji }))
    });

    // Notify others in the room
    io.to(code).emit('player-joined', Array.from(lobby.players.values()).map(p => ({ name: p.name, emoji: p.emoji })));
  });

  socket.on('start-game', (code) => {
    code = code.toUpperCase();
    const lobby = lobbies.get(code);
    
    if (!lobby) return;
    if (lobby.host !== socket.id) return; // Only host can start
    
    lobby.status = 'playing';
    
    // Set all players to playing
    for (let player of lobby.players.values()) {
      player.status = 'playing';
    }

    // Send restaurants to everyone
    io.to(code).emit('game-started', lobby.restaurants);
  });

  socket.on('force-finish', (code) => {
    code = code.toUpperCase();
    const lobby = lobbies.get(code);
    if (!lobby || lobby.status !== 'playing') return;
    
    lobby.status = 'finished';
    const results = lobby.restaurants.map(r => {
      let likes = 0;
      for (let p of lobby.players.values()) {
        if (p.swipes[r.id] === true) likes++;
      }
      return { ...r, likes };
    }).filter(r => r.likes > 0).sort((a, b) => b.likes - a.likes);

    io.to(code).emit('game-finished', { results, matches: lobby.matches });
  });

  socket.on('reroll-restaurants', async (code) => {
    code = code.toUpperCase();
    const lobby = lobbies.get(code);
    
    if (!lobby) return;
    if (lobby.host !== socket.id) return; // Only host can reroll
    
    console.log(`Rerolling restaurants for lobby: ${code}`);
    
    // Reset players swipes
    for (let player of lobby.players.values()) {
      player.swipes = {};
      player.status = 'playing';
    }
    
    lobby.status = 'playing';
    
    // Fetch fresh restaurants
    const restaurants = await fetchRestaurants(lobby.location.lat, lobby.location.lon, lobby.location.radius);
    lobby.restaurants = restaurants;
    
    // Notify everyone
    io.to(code).emit('game-started', restaurants);
  });

  socket.on('swipe', ({ code, restaurantId, liked }) => {
    code = code.toUpperCase();
    const lobby = lobbies.get(code);
    if (!lobby || lobby.status !== 'playing') return;

    const player = lobby.players.get(socket.id);
    if (!player) return;

    player.swipes[restaurantId] = liked;

    // Check if EVERYONE liked this restaurant
    if (liked) {
      let allLiked = true;
      for (let p of lobby.players.values()) {
        if (p.swipes[restaurantId] !== true) {
          allLiked = false;
          break;
        }
      }

      if (allLiked && lobby.players.size > 0) {
        if (!lobby.matches.includes(restaurantId)) {
          lobby.matches.push(restaurantId);
          const restaurant = lobby.restaurants.find(r => r.id === restaurantId);
          
          // BINGO! Jen upozorníme na match, ale hru necháváme běžet dál
          io.to(code).emit('bingo-match', restaurant);
        }
      }
    }

    // Broadcast progress
    const totalSwipesNeeded = lobby.restaurants.length * lobby.players.size;
    let currentSwipes = 0;
    for (let p of lobby.players.values()) {
      currentSwipes += Object.keys(p.swipes).length;
    }
    
    io.to(code).emit('progress', {
      current: currentSwipes,
      total: totalSwipesNeeded
    });

    // Check if everyone is done
    let everyoneDone = true;
    for (let p of lobby.players.values()) {
      if (Object.keys(p.swipes).length < lobby.restaurants.length) {
        everyoneDone = false;
        break;
      }
    }

    if (everyoneDone) {
      lobby.status = 'finished';
      
      const results = lobby.restaurants.map(r => {
        let likes = 0;
        for (let p of lobby.players.values()) {
          if (p.swipes[r.id] === true) likes++;
        }
        return { ...r, likes };
      }).filter(r => r.likes > 0).sort((a, b) => b.likes - a.likes);

      // Malá prodleva před koncem, aby se stihl zobrazit případný poslední match
      setTimeout(() => {
        io.to(code).emit('game-finished', { results, matches: lobby.matches });
      }, 2000);
    }
  });

  socket.on('disconnect', () => {
    // Cleanup lobbies if needed
    for (let [code, lobby] of lobbies.entries()) {
      if (lobby.players.has(socket.id)) {
        const leavingPlayer = lobby.players.get(socket.id);
        const leavingName = leavingPlayer ? leavingPlayer.name : 'Někdo';
        lobby.players.delete(socket.id);
        
        // If lobby is empty, delete it after a delay or immediately
        if (lobby.players.size === 0) {
          lobbies.delete(code);
        } else {
          // Notify others with player name
          const playersList = Array.from(lobby.players.values()).map(p => ({ name: p.name, emoji: p.emoji }));
          io.to(code).emit('player-left', { name: leavingName, players: playersList });
          io.to(code).emit('player-joined', playersList);
          
          // Reassign host if needed
          if (lobby.host === socket.id) {
            lobby.host = Array.from(lobby.players.keys())[0]; // Give to first remaining
            io.to(lobby.host).emit('you-are-host');
          }
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Where2Eat Server running on port ${PORT}`);
});
