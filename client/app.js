// Where2Eat - Main Logic
// Where2Eat - Main Logic
const SERVER_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3000'
  : 'https://bitematch.onrender.com';
let socket;

// State
let state = {
  user: {
    name: '',
    emoji: '😋',
    lat: null,
    lon: null
  },
  lobby: {
    code: null,
    isHost: false,
    players: []
  },
  game: {
    restaurants: [],
    currentIndex: 0,
    totalSwipesNeeded: 0,
    currentTotalSwipes: 0
  }
};

// DOM Elements
const screens = {
  home: document.getElementById('screen-home'),
  lobby: document.getElementById('screen-lobby'),
  swipe: document.getElementById('screen-swipe'),
  results: document.getElementById('screen-results')
};

// Nav
function showScreen(screenId) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[screenId].classList.add('active');

  // Hide theme toggle during gameplay to avoid overlap
  const themeToggle = document.getElementById('theme-toggle');
  if (screenId === 'swipe') {
    themeToggle.classList.add('hidden');
  } else {
    themeToggle.classList.remove('hidden');
  }
}

// --- Init & Home Screen ---
document.addEventListener('DOMContentLoaded', () => {
  // Theme Toggle
  const themeToggle = document.getElementById('theme-toggle');
  const currentTheme = localStorage.getItem('w2e_theme') || 'light';
  const logoImg = document.querySelector('.logo-img');

  if (currentTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    themeToggle.textContent = '☀️';
  }

  themeToggle.addEventListener('click', () => {
    let theme = document.documentElement.getAttribute('data-theme');
    if (theme === 'dark') {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('w2e_theme', 'light');
      themeToggle.textContent = '🌙';
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('w2e_theme', 'dark');
      themeToggle.textContent = '☀️';
    }
  });

  // Odstranění Service Workeru (dělal problémy s Vite CSS)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function (registrations) {
      for (let registration of registrations) {
        registration.unregister();
      }
    });
  }

  // Emoji picker
  document.querySelectorAll('.emoji-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.emoji-btn').forEach(b => b.classList.remove('selected'));
      const targetBtn = e.target.closest('.emoji-btn');
      targetBtn.classList.add('selected');
      state.user.emoji = targetBtn.dataset.avatar;
    });
  });

  // Pre-fill name from localStorage
  const savedName = localStorage.getItem('w2e_name');
  if (savedName) document.getElementById('username').value = savedName;

  // Radius slider
  const radiusSlider = document.getElementById('radius-slider');
  const radiusValue = document.getElementById('radius-value');
  if (radiusSlider && radiusValue) {
    radiusSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      if (val < 1000) {
        radiusValue.textContent = `${val} m`;
      } else {
        radiusValue.textContent = `${(val / 1000).toFixed(1)} km`;
      }
    });
  }

  // Parse code from URL for easy joining via QR
  const urlParams = new URLSearchParams(window.location.search);
  const codeFromUrl = urlParams.get('code');
  if (codeFromUrl) {
    const code = codeFromUrl.toUpperCase();
    document.getElementById('lobby-code-input').value = code;
    
    // Clear name to prevent duplicate errors if testing on same machine
    document.getElementById('username').value = '';
    
    // UI adjustment for joining via link
    document.getElementById('btn-create-lobby').classList.add('hidden');
    document.getElementById('radius-container').classList.add('hidden');
    
    const joinBtn = document.getElementById('btn-join-lobby');
    joinBtn.innerHTML = `<i data-lucide="user-plus"></i> Připojit se`;
    joinBtn.classList.replace('btn-secondary', 'btn-primary');
    
    // Move join section to top for better focus
    const joinSection = document.querySelector('.join-section');
    joinSection.style.border = 'none';
    joinSection.style.marginTop = '0';
    joinSection.querySelector('p').textContent = 'Právě ses připojil k odkazu! Zvol si jméno a emoji:';
    
    // Add special event for this big join button
    joinBtn.addEventListener('click', () => {
       // Just trigger the join logic
    });
    
    lucide.createIcons();
  }

  // Create Lobby
  document.getElementById('btn-create-lobby').addEventListener('click', async () => {
    const name = document.getElementById('username').value.trim();
    if (!name) return alert('Zadej své jméno!');

    state.user.name = name;
    localStorage.setItem('w2e_name', name);

    // Get location
    try {
      showLoading('Získávám tvoji polohu...');
      try {
        // Pokusíme se získat reálnou polohu uživatele
        const pos = await getCurrentPosition();
        state.user.lat = pos.coords.latitude;
        state.user.lon = pos.coords.longitude;
      } catch (geoError) {
        hideLoading();
        if (geoError.code === 1) { // PERMISSION_DENIED
          return alert('Přístup k poloze byl zamítnut. ❌\n\nKlikni na ikonu zámku v adresním řádku a povol polohu.');
        }
        return alert('Geolokace selhala. Zkontroluj si nastavení polohy a zkus to znovu.');
      }

      showLoading(`Hledám restaurace v okolí (${radiusValue.textContent})... 🍕`);

      const radius = parseInt(radiusSlider.value) || 3000;
      // Create lobby via REST
      const res = await fetch(`${SERVER_URL}/api/lobby`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: state.user.lat, lon: state.user.lon, radius })
      });

      const data = await res.json();
      hideLoading();

      if (!res.ok) throw new Error(data.error);

      connectToLobby(data.code);
    } catch (err) {
      hideLoading();
      alert(err.message);
    }
  });

  // Join Lobby
  document.getElementById('btn-join-lobby').addEventListener('click', async () => {
    const name = document.getElementById('username').value.trim();
    const code = document.getElementById('lobby-code-input').value.trim().toUpperCase();

    if (!name) return alert('Zadej své jméno!');
    if (!code || code.length !== 6) return alert('Zadej platný 6místný kód!');

    state.user.name = name;
    localStorage.setItem('w2e_name', name);

    showLoading('Připojuji k lobby...');
    try {
      const res = await fetch(`${SERVER_URL}/api/lobby/${code}`);
      const data = await res.json();
      hideLoading();

      if (!res.ok) throw new Error(data.error);
      if (data.status !== 'waiting') throw new Error('Hra už začala!');

      connectToLobby(code);
    } catch (err) {
      hideLoading();
      alert(err.message);
    }
  });
});

// Helpers
function showLoading(text) {
  document.getElementById('loading-text').textContent = text;
  document.getElementById('loading-overlay').classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolokace není podporována.'));
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0
    });
  });
}

function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return null;
  const R = 6371; // Radius of the earth in km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in km
}

function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

// --- Socket.IO & Lobby Logic ---
function connectToLobby(code) {
  if (socket) socket.disconnect();

  socket = io(SERVER_URL);

  socket.on('connect', () => {
    const name = document.getElementById('username').value.trim() || 'Anonym';
    const selectedBtn = document.querySelector('.emoji-btn.selected');
    const emoji = selectedBtn ? selectedBtn.dataset.avatar : 'noto:pizza';

    socket.emit('join-lobby', { code, name, emoji });
  });

  socket.on('joined', (data) => {
    state.lobby.code = code;
    state.lobby.isHost = data.isHost;

    // Update UI
    document.getElementById('lobby-code-display').textContent = code;

    // Clean up URL so refresh goes to home screen, not back to join screen
    window.history.replaceState({}, document.title, window.location.pathname);

    // Generate QR code pointing to this app
    const joinUrl = `${window.location.origin}/?code=${code}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(joinUrl)}`;
    
    const qrImg = document.getElementById('qr-code-img');
    qrImg.src = qrUrl;
    qrImg.onload = () => qrImg.style.backgroundColor = 'transparent';
    qrImg.onerror = () => {
      qrImg.src = `https://chart.googleapis.com/chart?cht=qr&chs=150x150&chl=${encodeURIComponent(joinUrl)}`;
    };

    if (data.isHost) {
      document.getElementById('btn-start-game').classList.remove('hidden');
      document.getElementById('waiting-for-host').classList.add('hidden');
    }

    updatePlayersList(data.players);
    showScreen('lobby');

    // Setup copy link button
    document.getElementById('btn-copy-link').onclick = () => {
      navigator.clipboard.writeText(joinUrl).then(() => {
        const btn = document.getElementById('btn-copy-link');
        const originalHtml = btn.innerHTML;
        btn.innerHTML = '<i data-lucide="check" style="width: 14px; height: 14px; vertical-align: middle; margin-right: 4px;"></i> Zkopírováno!';
        btn.classList.replace('btn-secondary', 'btn-success');
        lucide.createIcons();
        setTimeout(() => {
          btn.innerHTML = originalHtml;
          btn.classList.replace('btn-success', 'btn-secondary');
          lucide.createIcons();
        }, 2000);
      });
    };
  });

  socket.on('player-joined', (players) => {
    updatePlayersList(players);
  });

  socket.on('you-are-host', () => {
    state.lobby.isHost = true;
    document.getElementById('btn-start-game').classList.remove('hidden');
    document.getElementById('waiting-for-host').classList.add('hidden');
  });

  socket.on('game-started', (restaurants) => {
    state.game.restaurants = restaurants;
    state.game.currentIndex = restaurants.length - 1; // Start from end for z-index stacking
    state.game.totalSwipesNeeded = restaurants.length * state.lobby.players.length;

    initCards();
    updateProgress(0, state.game.totalSwipesNeeded);
    showScreen('swipe');
  });

  socket.on('bingo-match', (restaurant) => {
    showMatchOverlay(restaurant);
    triggerConfetti();
  });

  socket.on('progress', ({ current, total }) => {
    updateProgress(current, total);
  });

  socket.on('game-finished', ({ results, matches }) => {
    renderResults(results, matches);
    showScreen('results');
  });

  socket.on('error', (msg) => {
    alert(msg);
    showScreen('home');
    socket.disconnect();
  });
}

function updatePlayersList(players) {
  state.lobby.players = players;
  document.getElementById('player-count').textContent = players.length;

  const list = document.getElementById('players-list');
  list.innerHTML = '';

  players.forEach(p => {
    const li = document.createElement('li');
    li.className = 'player-item';
    li.innerHTML = `
      <span class="player-emoji"><img src="https://api.iconify.design/${p.emoji}.svg" style="width: 36px; height: 36px; border-radius: 50%; display: block;" /></span>
      <span class="player-name">${p.name} ${p.name === state.user.name ? '(Ty)' : ''}</span>
    `;
    list.appendChild(li);
  });
}

document.getElementById('btn-start-game').addEventListener('click', () => {
  socket.emit('start-game', state.lobby.code);
});

// --- Swipe Engine ---
let isDragging = false;
let startX, startY;
let currentX, currentY;
let dragRafId = null;
const container = document.getElementById('cards-container');

function initCards() {
  container.innerHTML = `<div class="no-more-cards hidden" id="no-more-cards">
    <h3>Máš hotovo! 🎉</h3>
    <p>Čekáme na ostatní...</p>
    <div class="spinner small"></div>
  </div>`;

  // Render cards (first is at the bottom of DOM = top visually due to absolute pos)
  state.game.restaurants.forEach((r, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = r.id;
    card.dataset.index = i;
    card.style.zIndex = i;

    // Slight scale/translate for background cards
    const isTop = i === state.game.restaurants.length - 1;
    if (!isTop) {
      card.style.transform = `scale(0.95) translateY(10px)`;
    }

    let images = [];
    if (r.imgUrls && r.imgUrls.length > 0) {
      images = r.imgUrls;
      // Shuffle the images array so the first photo is random
      if (images.length > 1) {
        images = images.sort(() => 0.5 - Math.random());
      }
    } else if (r.imgUrl) {
      images = [r.imgUrl];
    }

    if (images.length === 0) {
      // Záložní spolehlivé fotky z Unsplash pro místa bez fotky na Googlu
      const foodImages = {
        burger: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?q=80&w=400&auto=format&fit=crop',
        pizza: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?q=80&w=400&auto=format&fit=crop',
        sushi: 'https://images.unsplash.com/photo-1579871494447-9811cf80d66c?q=80&w=400&auto=format&fit=crop',
        asian: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?q=80&w=400&auto=format&fit=crop',
        cafe: 'https://images.unsplash.com/photo-1497935586351-b67a49e012bf?q=80&w=400&auto=format&fit=crop',
        meat: 'https://images.unsplash.com/photo-1600891964092-4316c288032e?q=80&w=400&auto=format&fit=crop',
        pasta: 'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?q=80&w=400&auto=format&fit=crop',
        generic: [
          'https://images.unsplash.com/photo-1504674900247-0877df9cc836?q=80&w=400&auto=format&fit=crop', // flatlay
          'https://images.unsplash.com/photo-1493770348161-369560ae357d?q=80&w=400&auto=format&fit=crop', // breakfast
          'https://images.unsplash.com/photo-1476224203421-9ac39bcb3327?q=80&w=400&auto=format&fit=crop', // plates
          'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?q=80&w=400&auto=format&fit=crop', // food
          'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?q=80&w=400&auto=format&fit=crop'  // plated
        ]
      };

      let fallbackImgUrl = foodImages.generic[Math.floor(Math.random() * foodImages.generic.length)];
      const cuisineLower = r.cuisine ? r.cuisine.toLowerCase() : '';

      if (r.amenity === 'fast_food' || cuisineLower.includes('burger')) fallbackImgUrl = foodImages.burger;
      else if (r.amenity === 'cafe' || cuisineLower.includes('cafe')) fallbackImgUrl = foodImages.cafe;
      else if (cuisineLower.includes('pizza') || cuisineLower.includes('ital')) fallbackImgUrl = foodImages.pizza;
      else if (cuisineLower.includes('sushi')) fallbackImgUrl = foodImages.sushi;
      else if (cuisineLower.includes('asian') || cuisineLower.includes('vietnam') || cuisineLower.includes('china')) fallbackImgUrl = foodImages.asian;
      else if (cuisineLower.includes('czech') || cuisineLower.includes('steak')) fallbackImgUrl = foodImages.meat;

      images = [fallbackImgUrl];
    }

    // Calculate distance
    let distanceStr = '';
    const distKm = getDistanceFromLatLonInKm(state.user.lat, state.user.lon, r.lat, r.lon);
    if (distKm !== null) {
      if (distKm < 1) {
        distanceStr = `${Math.round(distKm * 1000)} m`;
      } else {
        distanceStr = `${distKm.toFixed(1)} km`;
      }
    }

    let dashesHtml = '';
    if (images.length > 1) {
      dashesHtml = '<div class="stories-progress">';
      for (let j = 0; j < images.length; j++) {
        dashesHtml += `<div class="story-dash ${j === 0 ? 'active' : ''}"></div>`;
      }
      dashesHtml += '</div>';
    }

    const encodedImages = encodeURIComponent(JSON.stringify(images));

    // Hodnocení a cena
    const ratingStr = r.rating ? `<i data-lucide="star" style="width:16px; height:16px; fill:var(--secondary-color); color:var(--secondary-color); display:inline-block; vertical-align:middle; margin-right:4px; margin-top:-2px;"></i>${r.rating} <span style="color:var(--text-secondary); font-size: 12px; font-weight: normal;">(${r.user_ratings_total}x)</span>` : '<i data-lucide="star" style="width:16px; height:16px; display:inline-block; vertical-align:middle; margin-right:4px; margin-top:-2px;"></i> Nové';
    let priceStr = '';
    if (r.price_level !== null && r.price_level !== undefined) {
      priceStr = '$'.repeat(Math.max(1, r.price_level));
    }

    card.innerHTML = `
      <div class="card-image-placeholder" style="background-image: url('${images[0]}'); background-size: cover; background-position: center;" data-images="${encodedImages}" data-idx="0">
        ${dashesHtml}
      </div>
      <div class="card-content">
        <div class="card-cuisine">${r.cuisine}</div>
        <h2 class="card-title">${r.name}</h2>
        <div class="card-address">
          <i data-lucide="map-pin" style="width:16px; height:16px; flex-shrink:0; margin-top:2px;"></i>
          <span>${r.address} ${distanceStr ? `• <b style="color:var(--primary-color)">${distanceStr}</b>` : ''}</span>
        </div>
        <div class="card-meta">
          <div class="card-rating">${ratingStr}</div>
          <div class="card-price">${priceStr}</div>
        </div>
      </div>
      <div class="card-stamp stamp-like">LIKE</div>
      <div class="card-stamp stamp-nope">NOPE</div>
    `;

    // Only attach events to top card initially (handled in setupCardEvents)
    container.appendChild(card);
  });

  setupCardEvents();
  lucide.createIcons();
}

function getTopCard() {
  const cards = document.querySelectorAll('.card:not(.swiping)');
  return cards[cards.length - 1];
}

function setupCardEvents() {
  const card = getTopCard();
  if (!card) {
    document.getElementById('no-more-cards').classList.remove('hidden');
    return;
  }

  card.addEventListener('pointerdown', startDrag);
}

function startDrag(e) {
  isDragging = true;
  startX = e.clientX;
  startY = e.clientY;
  currentX = startX;
  currentY = startY;

  document.addEventListener('pointermove', drag);
  document.addEventListener('pointerup', endDrag);

  const card = getTopCard();
  if (card) {
    card.style.transition = 'none'; // remove transition during drag
    card.setPointerCapture(e.pointerId);
  }
}

function drag(e) {
  if (!isDragging) return;
  if (e.cancelable) e.preventDefault();

  currentX = e.clientX;
  currentY = e.clientY;

  if (!dragRafId) {
    dragRafId = requestAnimationFrame(updateCardTransform);
  }
}

function updateCardTransform() {
  if (!isDragging) {
    dragRafId = null;
    return;
  }

  const deltaX = currentX - startX;
  const deltaY = currentY - startY;
  const rotate = deltaX * 0.05;

  const card = getTopCard();
  if (card) {
    card.style.transform = `translate(${deltaX}px, ${deltaY}px) rotate(${rotate}deg)`;

    const likeOpacity = Math.max(0, Math.min(1, deltaX / 100));
    const nopeOpacity = Math.max(0, Math.min(1, -deltaX / 100));

    card.querySelector('.stamp-like').style.opacity = likeOpacity;
    card.querySelector('.stamp-nope').style.opacity = nopeOpacity;
  }

  dragRafId = requestAnimationFrame(updateCardTransform);
}

function endDrag(e) {
  isDragging = false;
  if (dragRafId) {
    cancelAnimationFrame(dragRafId);
    dragRafId = null;
  }
  
  document.removeEventListener('pointermove', drag);
  document.removeEventListener('pointerup', endDrag);

  const card = getTopCard();
  const deltaX = currentX - startX;
  const deltaY = currentY - startY;

  if (Math.abs(deltaX) < 10 && Math.abs(deltaY) < 10) {
    // IT'S A TAP!
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const tapY = e.clientY;

    // Only switch if tapped on the top half (image area)
    if (tapY < rect.top + rect.height * 0.5) {
      const tapX = e.clientX;
      const isRight = tapX > rect.left + rect.width / 2;
      switchPhoto(card, isRight ? 1 : -1);
    }

    // Reset transform
    card.style.transition = 'transform 0.3s ease-out';
    card.style.transform = 'translate(0px, 0px) rotate(0deg)';
    return;
  }

  // Threshold to swipe
  const threshold = window.innerWidth * 0.25;

  if (Math.abs(deltaX) > threshold) {
    // Swipe away
    const liked = deltaX > 0;
    swipeCard(liked);
  } else {
    // Snap back
    card.style.transition = 'transform 0.3s ease-out';
    card.style.transform = 'translate(0px, 0px) rotate(0deg)';
    card.querySelector('.stamp-like').style.opacity = 0;
    card.querySelector('.stamp-nope').style.opacity = 0;
  }
}

function switchPhoto(card, dir) {
  const imgDiv = card.querySelector('.card-image-placeholder');
  if (!imgDiv) return;

  const imagesStr = imgDiv.getAttribute('data-images');
  if (!imagesStr) return;

  const images = JSON.parse(decodeURIComponent(imagesStr));
  if (images.length <= 1) return;

  let idx = parseInt(imgDiv.getAttribute('data-idx'));
  idx += dir;

  if (idx < 0) idx = 0;
  if (idx >= images.length) idx = images.length - 1;

  imgDiv.setAttribute('data-idx', idx);
  imgDiv.style.backgroundImage = `url('${images[idx]}')`;

  const dashes = card.querySelectorAll('.story-dash');
  dashes.forEach((d, i) => {
    if (i === idx) d.classList.add('active');
    else d.classList.remove('active');
  });
}

function swipeCard(liked) {
  const card = getTopCard();
  if (!card || card.classList.contains('swiping')) return;

  card.classList.add('swiping');
  const id = card.dataset.id;
  const direction = liked ? 1 : -1;
  const windowWidth = window.innerWidth;

  // Haptic feedback
  if ('vibrate' in navigator) {
    if (liked) {
      navigator.vibrate([30, 50, 30]); // Happy double pop
    } else {
      navigator.vibrate(40); // Single pop
    }
  }

  card.style.transition = 'transform 0.5s ease-out, opacity 0.5s';
  card.style.transform = `translate(${direction * windowWidth * 1.5}px, 50px) rotate(${direction * 30}deg)`;
  card.style.opacity = 0;

  if (liked) {
    card.querySelector('.stamp-like').style.opacity = 1;
  } else {
    card.querySelector('.stamp-nope').style.opacity = 1;
  }

  // Send to server
  socket.emit('swipe', { code: state.lobby.code, restaurantId: id, liked });

  // Update progress immediately
  state.game.currentIndex--;
  updateProgress(null, state.game.totalSwipesNeeded);

  // Move to next card
  setTimeout(() => {
    card.remove();

    // Scale up next card
    const nextCard = getTopCard();
    if (nextCard) {
      nextCard.style.transition = 'transform 0.3s ease';
      nextCard.style.transform = 'scale(1) translateY(0)';
      setupCardEvents();
    } else {
      document.getElementById('no-more-cards').classList.remove('hidden');
    }
  }, 300); // Wait for animation
}

// Button controls
document.getElementById('btn-nope').addEventListener('click', () => swipeCard(false));
document.getElementById('btn-like').addEventListener('click', () => swipeCard(true));

function updateProgress(current, total) {
  const myTotal = state.game.restaurants.length;
  const myDone = myTotal - (state.game.currentIndex + 1);
  document.getElementById('swipe-counter').textContent = `${myDone} / ${myTotal}`;

  // Overall progress bar across all players
  const percent = total > 0 ? (current / total) * 100 : 0;
  document.getElementById('progress-bar').style.width = `${percent}%`;
}

// --- Match & Results ---
function showMatchOverlay(restaurant) {
  if ('vibrate' in navigator) {
    navigator.vibrate([100, 50, 100, 50, 300]); // Celebration
  }
  
  const nameEl = document.getElementById('match-restaurant-name');
  const cuisineEl = document.getElementById('match-restaurant-cuisine');
  const imgEl = document.getElementById('match-image');
  
  nameEl.textContent = restaurant.name;
  cuisineEl.textContent = `${restaurant.cuisine} • ${restaurant.address}`;
  
  if (restaurant.imgUrls && restaurant.imgUrls.length > 0) {
    imgEl.style.backgroundImage = `url('${restaurant.imgUrls[0]}')`;
    imgEl.classList.remove('hidden');
  } else if (restaurant.imgUrl) {
    imgEl.style.backgroundImage = `url('${restaurant.imgUrl}')`;
    imgEl.classList.remove('hidden');
  } else {
    imgEl.classList.add('hidden');
  }
  
  document.getElementById('match-overlay').classList.remove('hidden');
  triggerConfetti();
}


document.getElementById('btn-go-to-results').addEventListener('click', () => {
  document.getElementById('match-overlay').classList.add('hidden');
  socket.emit('force-finish', state.lobby.code);
});

// Tlačítko pokračovat zrušeno, BINGO se ukončí automaticky přes timeout na serveru

function triggerConfetti() {
  var duration = 3 * 1000;
  var animationEnd = Date.now() + duration;
  var defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 1000 };

  function randomInRange(min, max) {
    return Math.random() * (max - min) + min;
  }

  var interval = setInterval(function () {
    var timeLeft = animationEnd - Date.now();

    if (timeLeft <= 0) {
      return clearInterval(interval);
    }

    var particleCount = 50 * (timeLeft / duration);
    confetti({
      ...defaults, particleCount,
      origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 }
    });
    confetti({
      ...defaults, particleCount,
      origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 }
    });
  }, 250);
}

function renderResults(results, matches) {
  if ('vibrate' in navigator) {
    navigator.vibrate([200, 100, 200]);
  }

  // Show reroll button only for host
  const rerollBtn = document.getElementById('btn-reroll');
  if (state.lobby.isHost) {
    rerollBtn.classList.remove('hidden');
  } else {
    rerollBtn.classList.add('hidden');
  }

  const list = document.getElementById('results-list');
  list.innerHTML = '';

  if (results.length === 0) {
    list.innerHTML = '<p style="text-align:center">Neshodli jste se ani na jedné restauraci! 😢 Zkuste to znovu.</p>';
    lucide.createIcons();
    return;
  }

  results.forEach((r, index) => {
    const isWinner = matches.includes(r.id) || index === 0; // Highlight matches or top 1
    const el = document.createElement('div');
    el.className = `result-item ${isWinner ? 'winner' : ''}`;

    el.innerHTML = `
      <div class="result-info">
        <h3>${index + 1}. ${r.name} ${isWinner ? '<i data-lucide="crown" style="color:#ffc107; display:inline-block; vertical-align:middle;"></i>' : ''}</h3>
        <p>${r.cuisine} • ${r.address}</p>
        <div class="result-actions-buttons" style="margin-top: 10px; display: flex; gap: 10px;">
          ${r.mapsUrl ? `<a href="${r.mapsUrl}" target="_blank" class="btn btn-primary" style="font-size: 12px; padding: 5px 10px; flex: 1; text-align: center; text-decoration: none;"><i data-lucide="map-pin" style="width:14px;height:14px;"></i> Navigovat</a>` : ''}
          ${r.websiteUrl ? `<a href="${r.websiteUrl}" target="_blank" class="btn btn-secondary" style="font-size: 12px; padding: 5px 10px; flex: 1; text-align: center; text-decoration: none;"><i data-lucide="globe" style="width:14px;height:14px;"></i> Web</a>` : ''}
        </div>
      </div>
      <div class="result-likes">
        <i data-lucide="heart" style="color:var(--danger-color); fill:var(--danger-color); width:20px; height:20px; margin-right:5px;"></i> ${r.likes}
      </div>
    `;
    list.appendChild(el);
  });

  lucide.createIcons();
}

document.getElementById('btn-go-home').addEventListener('click', () => {
  if (socket) socket.disconnect();
  hideLoading();
  resetHomeUI();
  state.lobby = { code: null, isHost: false, players: [] };
  state.game = { restaurants: [], currentIndex: 0, totalSwipesNeeded: 0, currentTotalSwipes: 0 };
  showScreen('home');
});

function resetHomeUI() {
  // Restore all elements to default state
  document.getElementById('btn-create-lobby').classList.remove('hidden');
  document.getElementById('radius-container').classList.remove('hidden');
  
  const joinBtn = document.getElementById('btn-join-lobby');
  joinBtn.innerHTML = 'Připojit';
  joinBtn.classList.replace('btn-primary', 'btn-secondary');
  
  const joinSection = document.querySelector('.join-section');
  joinSection.style.borderTop = '1px solid var(--surface-light)';
  joinSection.style.marginTop = '20px';
  joinSection.querySelector('p').textContent = 'Nebo se připoj do existující:';
  
  document.getElementById('lobby-code-input').value = '';
  document.getElementById('username').value = localStorage.getItem('w2e_name') || '';
  
  lucide.createIcons();
}

document.getElementById('btn-reroll').addEventListener('click', () => {
  if (state.lobby.isHost && state.lobby.code) {
    showLoading('Generuji novou sadu restaurací...');
    socket.emit('reroll-restaurants', state.lobby.code);
  }
});
